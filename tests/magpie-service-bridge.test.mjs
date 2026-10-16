import test from 'node:test';
import assert from 'node:assert/strict';
import { bindManagedService, managedServiceRegistry, managedServiceScope } from '../plugins/rein-router/service-bridge.mjs';

const configuration = () => ({ enabled: true, gateway: { managed: { homeDir: '/synthetic/home' } }, routes: [{ id: 'one' }] });
const scope = overrides => managedServiceScope({ source: '/synthetic/index.ts', stateDir: '/synthetic/state', config: configuration(), ...overrides });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fakeManager(overrides = {}) {
  let ready = false;
  const calls = { start: 0, stop: 0 };
  return { calls, isReady: () => ready,
    async start() { calls.start++; await overrides.start?.(); ready = true; },
    async stop() { calls.stop++; ready = false; await overrides.stop?.(); },
  };
}

test('duplicate module loads resolve one process registry without sharing router run state', async () => {
  const other = await import('../plugins/rein-router/service-bridge.mjs?synthetic-duplicate');
  assert.equal(managedServiceRegistry(), other.managedServiceRegistry());
});

test('prepared registrations observe only the started service and cannot dispose its owner', async () => {
  const registry = new Map(), key = scope(), started = deferred();
  const ownerManager = fakeManager({ start: () => started.promise }), preparedManager = fakeManager();
  const owner = bindManagedService({ registry, scope: key, manager: ownerManager });
  const prepared = bindManagedService({ registry, scope: key, manager: preparedManager });
  assert.equal(prepared.isReady(), false);
  const boot = owner.start();
  assert.equal(prepared.isReady(), false);
  await prepared.stop();
  assert.equal(ownerManager.calls.stop, 0);
  started.resolve(); await boot;
  assert.equal(prepared.isReady(), true);
  assert.deepEqual(preparedManager.calls, { start: 0, stop: 0 });
  await assert.rejects(prepared.start(), /rein_magpie_service_already_owned/);
  await owner.stop();
  assert.equal(prepared.isReady(), false);
  assert.equal(registry.size, 0);
});

test('source, host state and complete policy changes cannot borrow service readiness', async () => {
  const registry = new Map();
  const owner = bindManagedService({ registry, scope: scope(), manager: fakeManager() });
  await owner.start();
  for (const override of [{ source: '/other/index.ts' }, { stateDir: '/other/state' },
    { config: { ...configuration(), allowPaidUsage: true } },
    { config: { ...configuration(), routes: [{ id: 'two' }] } }]) {
    assert.notEqual(scope(override), scope());
    assert.equal(bindManagedService({ registry, scope: scope(override), manager: fakeManager() }).isReady(), false);
  }
  assert.equal(scope().length, 64);
  await owner.stop();
});

test('shutdown fences readiness before waiting and old disposal cannot clear a replacement', async () => {
  const registry = new Map(), key = scope(), stopped = deferred();
  const owner = bindManagedService({ registry, scope: key, manager: fakeManager({ stop: () => stopped.promise }) });
  const observer = bindManagedService({ registry, scope: key, manager: fakeManager() });
  await owner.start();
  const stopping = owner.stop();
  assert.equal(observer.isReady(), false);
  await assert.rejects(observer.start(), /rein_magpie_service_already_owned/);
  const replacement = { manager: { isReady: () => true }, stopping: false };
  registry.set(key, replacement);
  stopped.resolve(); await stopping;
  await owner.stop();
  assert.equal(registry.get(key), replacement);
});

test('failed start releases only proven cleanup and failed cleanup keeps an unavailable owner', async () => {
  for (const cleanupFails of [false, true]) {
    const registry = new Map(), key = scope();
    const manager = fakeManager({ start: () => { throw new Error('synthetic-start-failure'); },
      stop: () => { if (cleanupFails) throw new Error('synthetic-cleanup-failure'); } });
    const owner = bindManagedService({ registry, scope: key, manager });
    await assert.rejects(owner.start(), /synthetic-/);
    assert.equal(owner.isReady(), false);
    assert.equal(registry.has(key), cleanupFails);
    assert.deepEqual(manager.calls, { start: 1, stop: 1 });
    if (cleanupFails) await assert.rejects(bindManagedService({ registry, scope: key, manager: fakeManager() }).start(), /already_owned/);
  }
});

test('a stopped startup cannot republish or announce readiness', async () => {
  const registry = new Map(), started = deferred();
  const owner = bindManagedService({ registry, scope: scope(), manager: fakeManager({ start: () => started.promise }) });
  const boot = owner.start();
  await owner.stop();
  started.resolve();
  await assert.rejects(boot, /rein_magpie_service_start_cancelled/);
  assert.equal(owner.isReady(), false);
  assert.equal(registry.size, 0);
});
