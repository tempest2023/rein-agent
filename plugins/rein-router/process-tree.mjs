import { ChildProcess, execFile } from 'node:child_process';

const failure = code => new Error(`rein_magpie_${code}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validPid = value => Number.isSafeInteger(value) && value > 1;

/** Numeric ancestry only: never collect command lines, environment or arguments. */
export function parseProcessAncestry(text) {
  const records = new Map();
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw failure('process_snapshot_invalid');
    const pid = Number(match[1]), parent = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parent) || parent < 0 || records.has(pid))
      throw failure('process_snapshot_invalid');
    records.set(pid, parent);
  }
  return records;
}

export function descendantPids(records, rootPid) {
  if (!validPid(rootPid) || rootPid === process.pid) throw failure('process_root_invalid');
  const children = new Map();
  for (const [pid, parent] of records) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const result = [], seen = new Set([rootPid]);
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index++) {
    for (const pid of children.get(queue[index]) ?? []) {
      if (seen.has(pid) || pid === process.pid || !validPid(pid)) throw failure('process_snapshot_invalid');
      seen.add(pid); queue.push(pid); result.push(pid);
      if (result.length > 4096) throw failure('process_snapshot_too_large');
    }
  }
  return result;
}

async function ps(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('ps', args, { encoding: 'utf8', timeout: Math.max(1, timeoutMs), maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C' }, windowsHide: true }, (error, stdout) => {
      if (error) reject(failure('process_snapshot_failed')); else resolve(stdout);
    });
  });
}

async function readAncestry(timeoutMs) {
  return parseProcessAncestry(await ps(['-axo', 'pid=,ppid='], timeoutMs));
}

/** Only captured PIDs: start time fences reuse; state recognizes already-dead zombies. */
async function readIdentities(pids, timeoutMs) {
  let text;
  try { text = await ps(['-p', pids.join(','), '-o', 'pid=,stat=,lstart='], timeoutMs); }
  catch (error) {
    // ps exits 1 if every requested PID has already disappeared. Confirm that
    // case independently; permission failures or still-live processes fail closed.
    if (pids.every(pid => !exists(pid))) return new Map();
    throw error;
  }
  const identities = new Map();
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.{10,80}?)\s*$/.exec(line);
    if (!match || !pids.includes(Number(match[1])) || identities.has(Number(match[1])))
      throw failure('process_identity_invalid');
    identities.set(Number(match[1]), { state: match[2], started: match[3].replace(/\s+/g, ' ') });
  }
  return identities;
}

function exists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function signal(pid, name, sendSignal) {
  try { sendSignal(pid, name); }
  catch (error) { if (error.code !== 'ESRCH') throw failure('process_signal_failed'); }
}

const liveChild = child => child.exitCode === null && child.signalCode === null;
const sameProcess = (original, current) => original && current &&
  typeof original.started === 'string' && original.started === current.started &&
  typeof current.state === 'string' && !current.state.startsWith('Z');

function stopRoot(child, name, { original, current, sendSignal } = {}) {
  // Node still owns the live ChildProcess handle. An exited handle cannot
  // authorize its old PID/PGID; the operating system may have reused either.
  if (!liveChild(child)) return;
  if (original) {
    if (!sameProcess(original, current)) return;
    signal(-child.pid, name, sendSignal);
  }
  // Without a fresh matching identity, never infer ownership of a group.
  if (liveChild(child)) {
    try { child.kill(name); } catch { throw failure('process_signal_failed'); }
  }
}

/** Stop only this child and its captured descendants, including new sessions. */
export async function stopOwnedProcessTree(child, { graceMs = 500, timeoutMs = 1500,
  ancestryReader = readAncestry, identityReader = readIdentities,
  sendSignal = (pid, name) => process.kill(pid, name) } = {}) {
  if (!child) return { complete: true, captured: 0 };
  if (!(child instanceof ChildProcess) || !validPid(child.pid) || child.pid === process.pid)
    throw failure('process_root_invalid');
  const deadline = Date.now() + Math.min(1500, Math.max(300, Number.isFinite(timeoutMs) ? timeoutMs : 1500));
  const budget = () => Math.max(1, Math.min(180, deadline - Date.now()));
  if (child.exitCode !== null || child.signalCode !== null) {
    throw failure('process_ancestry_unavailable_after_exit');
  }
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: Math.max(1, deadline - Date.now()),
        windowsHide: true }, error => error ? reject(failure('process_tree_cleanup_failed')) : resolve({ complete: true }));
    });
  }
  if (!['darwin', 'linux'].includes(process.platform)) throw failure('process_cleanup_unsupported');
  let captured = [], identities;
  try {
    const first = await ancestryReader(budget());
    if (first.get(child.pid) !== process.pid) throw failure('process_root_not_owned');
    captured = descendantPids(first, child.pid);
    identities = await identityReader([child.pid, ...captured], budget());
    if (!identities.has(child.pid)) throw failure('process_ancestry_unavailable_after_exit');
    const current = await ancestryReader(budget());
    if (current.get(child.pid) !== process.pid || child.exitCode !== null || child.signalCode !== null)
      throw failure('process_ancestry_unavailable_after_exit');
    const currentDescendants = new Set(descendantPids(current, child.pid));
    const added = [...currentDescendants].filter(pid => !captured.includes(pid));
    if (added.length) {
      const addedIdentities = await identityReader(added, budget());
      for (const pid of added) if (addedIdentities.has(pid)) {
        captured.push(pid); identities.set(pid, addedIdentities.get(pid));
      }
    }
    const currentIdentities = await identityReader([child.pid, ...captured], budget());
    // Fresh matching identities fence captured positive PIDs, including children
    // in another session. Their PID alone never authorizes a separate group.
    for (const pid of [...captured].reverse()) if (currentDescendants.has(pid) &&
        sameProcess(identities.get(pid), currentIdentities.get(pid))) signal(pid, 'SIGTERM', sendSignal);
    stopRoot(child, 'SIGTERM', { original: identities.get(child.pid), current: currentIdentities.get(child.pid), sendSignal });
  } catch {
    stopRoot(child, 'SIGKILL');
    throw failure('process_snapshot_cleanup_incomplete');
  }
  const pids = [child.pid, ...captured];
  const graceUntil = Math.min(deadline - 200, Date.now() + Math.max(0, Math.min(750, graceMs)));
  while (Date.now() < graceUntil && pids.some(exists)) await pause(Math.min(25, graceUntil - Date.now()));
  let latest;
  try { latest = await identityReader(pids, budget()); }
  catch { stopRoot(child, 'SIGKILL'); throw failure('process_identity_cleanup_incomplete'); }
  for (const pid of [...captured].reverse()) {
    const original = identities.get(pid), current = latest.get(pid);
    if (sameProcess(original, current)) signal(pid, 'SIGKILL', sendSignal);
  }
  stopRoot(child, 'SIGKILL', { original: identities.get(child.pid), current: latest.get(child.pid), sendSignal });
  while (Date.now() < deadline) {
    try { latest = await identityReader(pids, budget()); }
    catch { throw failure('process_identity_cleanup_incomplete'); }
    const active = pids.some(pid => latest.has(pid) && latest.get(pid).started === identities.get(pid)?.started &&
      !latest.get(pid).state.startsWith('Z'));
    if (!active && (child.exitCode !== null || child.signalCode !== null)) return { complete: true, captured: captured.length };
    await pause(Math.min(20, Math.max(1, deadline - Date.now())));
  }
  throw failure('process_tree_cleanup_incomplete');
}
