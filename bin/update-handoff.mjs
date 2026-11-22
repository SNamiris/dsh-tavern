import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import installationState from './installation-state.cjs'
import { assertDesktopStopped } from './import-user-home.mjs'
import { acquirePendingLock, relaunchApp, switchProfile } from '../tavern-plugin/packages/dsh-tavern/lib/helper.mjs'
import { captureProcessIdentity, waitForOwnedExit } from '../tavern-plugin/packages/dsh-tavern/lib/processes.mjs'
import { recordProfileContinuation } from '../tavern-plugin/packages/dsh-tavern/lib/startup-profile.mjs'

const HANDOFF_TTL = 10 * 60 * 1000
const markerPath = dshHome => path.join(dshHome, 'profile-data', 'tavern', 'data', 'update-handoff.json')

function readMarker(dshHome) {
  try {
    const file = markerPath(dshHome)
    if (!lstatSync(file).isFile()) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch { return null }
}

function putMarker(dshHome, marker) {
  const file = markerPath(dshHome)
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function activeEdgeHandoff(dshHome, owner = installationState.readInstallation(dshHome), now = Date.now()) {
  const marker = readMarker(dshHome)
  return owner?.edgeHandoff && marker?.attemptId === owner.attemptId && marker.generation === owner.generation
    && ['waiting', 'open', 'native'].includes(marker.phase) && Number.isFinite(marker.createdAt)
    && marker.createdAt <= now && now - marker.createdAt < HANDOFF_TTL ? marker : null
}

function preparedUpdate(owner, appDir) {
  const gate = owner?.edgeHandoff && installationState.desktopPublishGate(owner.lockDir)
  if (!gate || existsSync(gate) || !existsSync(gate + '.ready')) {
    throw new Error('酒馆还在准备更新，请等准备完成。')
  }
  const staging = path.resolve(appDir) + '.staging'
  if (!lstatSync(staging).isDirectory()) throw new Error('更新暂存目录无效，请重新准备。')
  const release = JSON.parse(readFileSync(path.join(staging, '.dsh-tavern-release.json'), 'utf8'))
  const { version } = JSON.parse(readFileSync(path.join(staging, 'package.json'), 'utf8'))
  if (!/^[a-f0-9]{40}$/i.test(release.commit) || typeof version !== 'string' || !version
    || !lstatSync(path.join(staging, 'bin', 'staged-app-install.mjs')).isFile()) {
    throw new Error('准备包缺少可核实的版本和安装文件，请重新准备。')
  }
  return { staging, version, commit: release.commit }
}

export async function requestEdgeHandoff({ dshHome, appDir, pid = process.pid, capture = captureProcessIdentity }) {
  const owner = installationState.readInstallation(dshHome)
  const prepared = preparedUpdate(owner, appDir)
  if (activeEdgeHandoff(dshHome, owner)) throw new Error('酒馆正在交接，请稍候。')
  const identity = await capture(pid)
  if (identity?.pid !== pid || !/^[1-9]\d*$/.test(identity.created)) throw new Error('酒馆后台的启动身份无效。')
  const current = installationState.readInstallation(dshHome)
  if (current?.generation !== owner.generation || installationState.cancellationRequested(dshHome, owner.attemptId)
    || activeEdgeHandoff(dshHome, current)) throw new Error('更新准备状态已改变，请重试。')
  const marker = {
    ...prepared, attemptId: owner.attemptId, generation: owner.generation,
    createdAt: Date.now(), phase: 'waiting', edge: identity,
  }
  putMarker(dshHome, marker)
  return marker
}

export function registerNativeHandoff({ dshHome, appDir, pids }) {
  const owner = installationState.readInstallation(dshHome)
  const marker = activeEdgeHandoff(dshHome, owner)
  if (!marker || !['open', 'native'].includes(marker.phase)) throw new Error('没有可接管的 Edge 更新。')
  const prepared = preparedUpdate(owner, appDir)
  if (prepared.staging !== marker.staging || prepared.commit !== marker.commit || prepared.version !== marker.version
      || installationState.cancellationRequested(dshHome, owner.attemptId)) throw new Error('准备包已改变，请重新准备。')
  if (!Array.isArray(pids) || pids.length !== 2 || pids[0] === pids[1]
      || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 1)) throw new Error('无法确认原生 DSH 的进程。')
  if (marker.phase === 'native' && !pids.every((pid, i) => pid === marker.pids?.[i])) {
    throw new Error('这次更新已经由另一个原生窗口接管。')
  }
  putMarker(dshHome, { ...marker, phase: 'native', pids })
}

export async function openHandoffDesktop({ dshHome, appDir, owner, marker, signal, executable = process.execPath,
  wait = waitForOwnedExit, checkStopped = assertDesktopStopped, changeProfile = switchProfile, open = relaunchApp }) {
  try {
    await wait({ roots: [marker.edge] }, { timeout: 30_000 })
  } catch (error) {
    throw new Error('无法在 30 秒内确认 Edge 酒馆后台已退出，未切换配置或安装新版。', { cause: error })
  }
  signal.throwIfAborted()
  if (activeEdgeHandoff(dshHome)?.phase !== 'waiting') throw new Error('交接已过期或已取消。')
  const prepared = preparedUpdate(installationState.readInstallation(dshHome), appDir)
  if (prepared.staging !== marker.staging || prepared.commit !== marker.commit || prepared.version !== marker.version) {
    throw new Error('准备包已改变，请重新准备。')
  }
  const stateDir = path.join(dshHome, 'profile-bridge')
  const profilesRoot = path.join(dshHome, 'profiles')
  const { lock } = acquirePendingLock(stateDir)
  try {
    writeFileSync(path.join(lock, 'worker.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' })
    checkStopped([dshHome], { requireGuiClosed: true, preparingForPid: owner.pid })
    const liveDir = path.join(profilesRoot, 'desktop')
    const targetDir = path.join(profilesRoot, 'tavern')
    if (lstatSync(liveDir).isSymbolicLink() && realpathSync(liveDir) !== realpathSync(targetDir)) {
      throw new Error('原生 DSH 正指向其他 Profile，请在启动器中先恢复原版。')
    }
    await changeProfile({
      mode: 'link', profilesRoot, liveDir, targetDir, stamp: new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid,
    })
  } finally {
    const worker = path.join(lock, 'worker.json')
    if (existsSync(worker)) unlinkSync(worker)
    rmdirSync(lock)
  }
  signal.throwIfAborted()
  if (activeEdgeHandoff(dshHome)?.phase !== 'waiting') throw new Error('交接已过期或已取消。')
  recordProfileContinuation(dshHome, 'tavern')
  putMarker(dshHome, { ...marker, phase: 'open' })
  await new Promise((resolve, reject) => {
    const child = open(executable, { continueProfile: true })
    child.once('spawn', resolve)
    child.once('error', reject)
  })
}

export function finishEdgeHandoff(dshHome, attemptId, error) {
  const marker = readMarker(dshHome)
  if (marker?.attemptId !== attemptId) return
  if (error && marker.phase === 'waiting') {
    putMarker(dshHome, { ...marker, phase: 'failed', error: error.message })
  } else {
    unlinkSync(markerPath(dshHome))
  }
}
