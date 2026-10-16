import assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import test from 'node:test';
import { descendantPids, parseProcessAncestry, stopOwnedProcessTree } from '../plugins/rein-router/process-tree.mjs';

const supported = ['darwin', 'linux'].includes(process.platform);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function listening(port) {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.setTimeout(200, () => done(false));
  });
}

async function detachedFixture(t) {
  const grandchild = `const {createServer}=require('node:net');
    process.on('SIGTERM',()=>{});
    createServer(s=>s.end()).listen(0,'127.0.0.1',function(){console.log(this.address().port)});`;
  const parent = `const {spawn}=require('node:child_process');const {createServer}=require('node:net');
    const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:['ignore','pipe','ignore']});
    process.on('SIGTERM',()=>{});
    const s=createServer(x=>x.end());s.listen(0,'127.0.0.1',()=>{
      c.stdout.once('data',b=>console.log(JSON.stringify({child:c.pid,port:Number(String(b).trim()),rootPort:s.address().port})))
    });`;
  const child = spawn(process.execPath, ['-e', parent], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let line = '';
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic process fixture timeout')), 5000);
    child.stdout.on('data', bytes => {
      line += bytes;
      if (line.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(line.trim())); }
    });
    child.once('error', reject);
  });
  t.after(async () => {
    if (await listening(ready.port)) {
      try { process.kill(ready.child, 'SIGKILL'); } catch { /* owned fixture already gone */ }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  assert.equal(await listening(ready.port), true); assert.equal(await listening(ready.rootPort), true);
  return { child, ready };
}

test('numeric process ancestry includes grandchildren and excludes unrelated processes', () => {
  const records = parseProcessAncestry(' 10 1\n 11 10\n 12 11\n 99 1\n');
  assert.deepEqual(descendantPids(records, 10), [11, 12]);
  assert.throws(() => parseProcessAncestry('10 secret command args'), /snapshot_invalid/);
  assert.throws(() => descendantPids(records, process.pid), /root_invalid/);
});

test('stops an owned child and a detached grandchild even when SIGTERM is ignored', { skip: !supported }, async t => {
  const { child, ready } = await detachedFixture(t);
  const started = Date.now();
  const result = await stopOwnedProcessTree(child, { graceMs: 100 });
  assert.equal(result.complete, true); assert.ok(result.captured >= 1);
  assert.ok(Date.now() - started < 2000, 'cleanup must fit the plugin stop budget');
  assert.equal(await listening(ready.port), false); assert.equal(await listening(ready.rootPort), false);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned root must be reaped');
});

test('snapshot failure stops the root and reports incomplete descendant cleanup', { skip: !supported }, async t => {
  const { child, ready } = await detachedFixture(t);
  await assert.rejects(stopOwnedProcessTree(child, { ancestryReader: async () => { throw new Error('private raw command output'); } }),
    error => error.message === 'rein_magpie_process_snapshot_cleanup_incomplete');
  for (let attempts = 0; attempts < 20 && await listening(ready.rootPort); attempts++) await sleep(10);
  assert.equal(await listening(ready.rootPort), false);
  assert.equal(await listening(ready.port), true, 'failure must not claim the uncaptured detached child was cleaned');
});

test('a changed start identity fences the final signal against PID reuse', { skip: !supported }, async t => {
  const { child, ready } = await detachedFixture(t);
  let reads = 0;
  const identityReader = async () => {
    reads++;
    const identities = new Map([[ready.child, { state: 'S', started: reads === 1 ? 'original child' : 'replacement process' }]]);
    if (child.exitCode === null && child.signalCode === null) identities.set(child.pid, { state: 'S', started: 'owned root' });
    return identities;
  };
  await stopOwnedProcessTree(child, { graceMs: 50, identityReader });
  assert.equal(await listening(ready.port), true, 'a replacement PID must not receive the final kill');
  assert.equal(await listening(ready.rootPort), false);
});

function mockChild() {
  // Every signal is intercepted. These synthetic identifiers never authorize
  // a real signal, even if a machine happened to allocate the same numbers.
  const calls = [];
  const child = new ChildProcess();
  child.pid = process.pid + 1_000_000;
  child.exitCode = null; child.signalCode = null;
  child.kill = name => { calls.push([child.pid, name]); return true; };
  return { child, calls, sendSignal: (pid, name) => { calls.push([pid, name]); } };
}

test('an already-exited root cannot authorize its old PID or process group', { skip: !supported }, async () => {
  const fixture = mockChild();
  fixture.child.exitCode = 0;
  await assert.rejects(stopOwnedProcessTree(fixture.child, { sendSignal: fixture.sendSignal,
    ancestryReader: async () => { throw new Error('must not inspect an exited root'); } }),
  { message: 'rein_magpie_process_ancestry_unavailable_after_exit' });
  assert.deepEqual(fixture.calls, []);
});

test('root exit during snapshot failure cannot authorize a fallback group signal', { skip: !supported }, async () => {
  const fixture = mockChild();
  await assert.rejects(stopOwnedProcessTree(fixture.child, { sendSignal: fixture.sendSignal,
    ancestryReader: async () => { fixture.child.signalCode = 'SIGTERM'; throw new Error('snapshot failed'); } }),
  { message: 'rein_magpie_process_snapshot_cleanup_incomplete' });
  assert.deepEqual(fixture.calls, []);
});

test('reaped root groups are never killed while captured live descendants are cleaned individually', { skip: !supported }, async () => {
  const fixture = mockChild();
  const rootPid = fixture.child.pid, descendant = rootPid + 1;
  let reads = 0, descendantAlive = true;
  const identityReader = async () => {
    reads++;
    const records = new Map();
    if (reads < 3) records.set(rootPid, { state: 'S', started: 'original root' });
    else {
      fixture.child.exitCode = 0;
      // A reused old PGID/PID is explicitly present in the later snapshot.
      records.set(rootPid, { state: 'S', started: 'unrelated replacement' });
    }
    if (descendantAlive) records.set(descendant, { state: 'S', started: 'captured descendant' });
    return records;
  };
  const sendSignal = (pid, name) => {
    fixture.sendSignal(pid, name);
    if (pid === descendant && name === 'SIGKILL') descendantAlive = false;
  };
  const result = await stopOwnedProcessTree(fixture.child, { graceMs: 0, identityReader, sendSignal,
    ancestryReader: async () => new Map([[rootPid, process.pid], [descendant, rootPid]]) });
  assert.deepEqual(result, { complete: true, captured: 1 });
  assert.deepEqual(fixture.calls, [[descendant, 'SIGTERM'], [-rootPid, 'SIGTERM'], [rootPid, 'SIGTERM'], [descendant, 'SIGKILL']]);
});

test('a changed fresh root identity prevents initial and final group signaling', { skip: !supported }, async () => {
  const fixture = mockChild();
  let reads = 0;
  const identityReader = async () => {
    reads++;
    if (reads >= 3) fixture.child.exitCode = 0;
    return new Map([[fixture.child.pid, { state: 'S', started: reads === 1 ? 'original root' : 'replacement root' }]]);
  };
  assert.deepEqual(await stopOwnedProcessTree(fixture.child, { graceMs: 0, identityReader, sendSignal: fixture.sendSignal,
    ancestryReader: async () => new Map([[fixture.child.pid, process.pid]]) }), { complete: true, captured: 0 });
  assert.deepEqual(fixture.calls, []);
});

test('no child is idempotent and foreign plain objects cannot authorize a process signal', async () => {
  assert.deepEqual(await stopOwnedProcessTree(undefined), { complete: true, captured: 0 });
  await assert.rejects(stopOwnedProcessTree({ pid: process.pid }), /process_root_invalid/);
});
