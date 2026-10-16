import { createHash } from 'node:crypto';

const REGISTRY = Symbol.for('rein-router.managed-services.v1');

/** Duplicate plugin module loads share infrastructure, never per-run policy state. */
export function managedServiceRegistry() {
  if (!Object.hasOwn(globalThis, REGISTRY)) Object.defineProperty(globalThis, REGISTRY, { value: new Map() });
  const registry = globalThis[REGISTRY];
  if (!(registry instanceof Map)) throw new Error('rein_magpie_service_registry_invalid');
  return registry;
}

/** Scope process-owned infrastructure separately from per-run plugin instances. */
export function managedServiceScope({ source, stateDir, config }) {
  if (typeof source !== 'string' || !source || typeof stateDir !== 'string' || !stateDir || !config?.gateway?.managed)
    throw new Error('rein_magpie_service_scope_invalid');
  return createHash('sha256').update(JSON.stringify({ source, stateDir, config })).digest('hex');
}

/** Only a started service publishes ownership; prepared hooks merely observe it. */
export function bindManagedService({ registry, scope, manager }) {
  let owner, stopping;
  const isReady = () => {
    const active = registry.get(scope);
    return Boolean(active && !active.stopping && active.manager.isReady());
  };
  const stop = async () => {
    if (!owner) return;
    return stopping ??= (async () => {
      const previous = owner;
      previous.stopping = true;
      // Retain an unavailable ownership record if cleanup cannot be proved.
      await manager.stop();
      if (registry.get(scope) === previous) registry.delete(scope);
      if (owner === previous) owner = undefined;
    })();
  };
  const start = async context => {
    if (owner || registry.has(scope)) throw new Error('rein_magpie_service_already_owned');
    stopping = undefined;
    owner = { manager, stopping: false };
    registry.set(scope, owner);
    const current = owner;
    try {
      await manager.start(context);
      if (registry.get(scope) !== current || current.stopping) throw new Error('rein_magpie_service_start_cancelled');
    }
    catch (error) { await stop(); throw error; }
  };
  return { isReady, start, stop };
}
