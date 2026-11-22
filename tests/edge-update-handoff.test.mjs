import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import installationState from '../bin/installation-state.cjs'
import { openTavernWindow } from '../bin/tavern-window.mjs'
import { activeEdgeHandoff, finishEdgeHandoff, openHandoffDesktop, registerNativeHandoff, requestEdgeHandoff } from '../bin/update-handoff.mjs'
import { isActiveTavern, launcherPaths } from '../tavern-plugin/packages/dsh-tavern/lib/state.mjs'

function setup(t) {
  const dshHome = mkdtempSync(path.join(os.tmpdir(), 'tavern-edge-handoff-'))
  t.after(() => rmSync(dshHome, { recursive: true, force: true }))
  const appDir = path.join(dshHome, 'apps', 'dsh-tavern')
  const dataRoot = path.join(dshHome, 'profile-data', 'tavern', 'data')
  const staging = appDir + '.staging'
  mkdirSync(path.join(staging, 'bin'), { recursive: true })
  mkdirSync(dataRoot, { recursive: true })
  for (const name of ['desktop', 'tavern']) {
    const dir = path.join(dshHome, 'profiles', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, dsh: { profile: { bundles: [] } } }))
  }
  writeFileSync(path.join(staging, '.dsh-tavern-release.json'), JSON.stringify({ commit: 'a'.repeat(40) }))
  writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ version: '3.4.0' }))
  writeFileSync(path.join(staging, 'bin', 'staged-app-install.mjs'), '')
  const lease = installationState.acquireInstallation({ dshHome, sourceRoot: appDir })
  lease.update({ edgeHandoff: true })
  writeFileSync(installationState.desktopPublishGate(lease.lockDir) + '.ready', '')
  const capture = async pid => ({ pid, created: '12345' })
  const request = () => requestEdgeHandoff({ dshHome, appDir, capture })
  return { dshHome, appDir, dataRoot, lease, request }
}

test('Edge uses the actual Tavern profile even when desktop is an independent directory', t => {
  const { dshHome } = setup(t)
  const profileDir = path.join(dshHome, 'profiles', 'tavern')
  const paths = launcherPaths({ profileContext: { home: dshHome, dir: profileDir, name: 'tavern' } },
    { DSH_HOME: dshHome, DSH_TAVERN_RUNTIME_HOST: 'desktop' })
  assert.equal(paths.activeDir, profileDir)
  assert.equal(isActiveTavern(paths, { available: true, profileDir }), true)
})

test('Edge exits before switching profiles and the existing update lease transfers to native', async t => {
  const { dshHome, appDir, lease, request } = setup(t)
  const marker = await request()
  const events = []
  const live = path.join(dshHome, 'profiles', 'desktop')
  const tavern = path.join(dshHome, 'profiles', 'tavern')
  const shortcut = { host: 'desktop', root: dshHome, start: () => assert.fail('must not start an Edge backend'),
    findDesktop: () => path.join(dshHome, 'DeepSeek Harness.exe'), open: () => events.push('shortcut') }
  assert.equal(marker.version, '3.4.0')
  await openTavernWindow(shortcut)
  assert.deepEqual(events, [])
  await assert.rejects(request(), /正在交接/)
  assert.throws(() => registerNativeHandoff({ dshHome, appDir, pids: [12, 13] }), /没有可接管/)
  await openHandoffDesktop({
    dshHome, appDir, marker, owner: lease.owner, signal: new AbortController().signal,
    wait: async (ownership, options) => {
      assert.deepEqual(ownership.roots, [marker.edge])
      assert.equal(options.timeout, 30_000)
      assert.notEqual(realpathSync(live), realpathSync(tavern))
      events.push('exit')
    },
    checkStopped: () => { events.push('check') },
    open: () => {
      assert.equal(realpathSync(live), realpathSync(tavern))
      assert.equal(activeEdgeHandoff(dshHome).phase, 'open')
      events.push('open')
      const child = new EventEmitter()
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
  })
  assert.deepEqual(events, ['exit', 'check', 'open'])
  await openTavernWindow(shortcut)
  assert.deepEqual(events, ['exit', 'check', 'open', 'shortcut'])
  assert.equal(activeEdgeHandoff(dshHome, lease.owner, marker.createdAt + 600_000), null)
  assert.throws(() => installationState.acquireInstallation({ dshHome }), /安装|更新/)
  registerNativeHandoff({ dshHome, appDir, pids: [12, 13] })
  assert.deepEqual(activeEdgeHandoff(dshHome).pids, [12, 13])
  assert.throws(() => registerNativeHandoff({ dshHome, appDir, pids: [14, 15] }), /另一个原生窗口/)
  finishEdgeHandoff(dshHome, lease.attemptId)
  assert.equal(activeEdgeHandoff(dshHome), null)
})

test('an Edge shutdown timeout leaves the original profile and records the failure', async t => {
  const { dshHome, appDir, dataRoot, lease, request } = setup(t)
  const marker = await request()
  let failure
  await assert.rejects(openHandoffDesktop({
    dshHome, appDir, marker, owner: lease.owner, signal: new AbortController().signal,
    wait: async () => { throw new Error('timed out') },
    checkStopped: () => assert.fail('must not publish or switch'),
    open: () => assert.fail('must not open the native desktop'),
  }), error => {
    failure = error
    return /30 秒内确认/.test(error.message)
  })
  finishEdgeHandoff(dshHome, lease.attemptId, failure)
  assert.equal(activeEdgeHandoff(dshHome), null)
  assert.match(readFileSync(path.join(dataRoot, 'update-handoff.json'), 'utf8'), /30 秒内确认/)
  assert.notEqual(realpathSync(path.join(dshHome, 'profiles', 'desktop')), realpathSync(path.join(dshHome, 'profiles', 'tavern')))
})
