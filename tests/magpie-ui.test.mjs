import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { magpiePaths } from '../scripts/magpie-dependency.mjs';
import { disableMagpieAutoUpdate, runMagpieUi } from '../scripts/magpie-ui.mjs';
import { acquireManagedProfileLock, buildManagedEnvironment,
  ensureManagedDirectories } from '../plugins/rein-router/managed-gateway.mjs';

function fixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rein-magpie-ui-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = magpiePaths(root), signalSource = new EventEmitter(), events = new EventEmitter();
  const calls = { spawn: [], ports: [], stop: [], verify: [], configure: [] }, order = [];
  const child = new ChildProcess(); child.pid = process.pid + 1_000_000;
  child.exitCode = null; child.signalCode = null;
  const close = (code = 0, signal = null) => {
    child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal);
  };
  const options = { root, signalSource, environment: { PATH: '/synthetic/bin', LANG: 'en_US.UTF-8',
    HOME: '/global-home', XDG_CONFIG_HOME: '/global-config', CODEX_HOME: '/global-codex',
    CLAUDE_CONFIG_DIR: '/global-claude', GEMINI_CLI_HOME: '/global-gemini',
    MAGPIE_ADDR: '0.0.0.0:9999', MAGPIE_NO_ACCOUNTS: '1', MAGPIE_TRUST_PROXY: '1',
    OPENAI_API_KEY: 'must-not-leak', ANTHROPIC_API_KEY: 'must-not-leak', REIN_MAGPIE_GATEWAY_KEY: 'must-not-leak' },
    verifier: async input => { order.push('verify'); calls.verify.push(input); return { binaryPath: paths.binary }; },
    portCheck: async url => {
      assert.equal(existsSync(join(dirname(paths.homeDir), '.rein-magpie.lock')), true);
      order.push('port'); calls.ports.push(url.href); return false;
    },
    configureNative: async (...args) => {
      assert.equal(existsSync(join(dirname(paths.homeDir), '.rein-magpie.lock')), true);
      order.push('configure'); calls.configure.push(args);
    },
    spawnImpl: (...args) => { order.push('spawn'); calls.spawn.push(args); events.emit('spawn'); return child; },
    stopImpl: async input => { calls.stop.push(input); close(null, 'SIGTERM'); return { complete: true }; },
    ...overrides,
  };
  return { root, paths, signalSource, child, calls, order, options, close,
    lockPath: join(dirname(paths.homeDir), '.rein-magpie.lock'),
    run: async (args = []) => {
      const spawned = once(events, 'spawn');
      const result = runMagpieUi(args, options); await spawned;
      return { result };
    } };
}

test('launches only the verified native web UI with isolated project profile and fixed loopback addresses', async t => {
  const f = fixture(t), { result } = await f.run(['--no-open']);
  assert.deepEqual(f.calls.verify, [{ root: f.paths.root }]);
  const [binary, args, options] = f.calls.spawn[0];
  assert.equal(binary, f.paths.binary); assert.deepEqual(args, ['web', '--addr', '127.0.0.1:0', '--no-open']);
  assert.equal(options.cwd, f.paths.homeDir); assert.equal(options.shell, false); assert.equal(options.stdio, 'inherit');
  assert.equal(options.detached, process.platform !== 'win32');
  assert.equal(options.env.PATH, '/synthetic/bin'); assert.equal(options.env.LANG, 'en_US.UTF-8');
  assert.equal(options.env.HOME, f.paths.homeDir); assert.equal(options.env.XDG_CONFIG_HOME, join(f.root, 'runtime/magpie/config'));
  assert.equal(options.env.CODEX_HOME, join(f.paths.homeDir, '.codex'));
  assert.equal(options.env.CLAUDE_CONFIG_DIR, join(f.paths.homeDir, '.claude'));
  assert.equal(options.env.GEMINI_CLI_HOME, join(f.paths.homeDir, '.gemini'));
  assert.equal(options.env.MAGPIE_ADDR, '127.0.0.1:3425'); assert.equal(options.env.MAGPIE_TRUST_PROXY, '0');
  assert.equal(options.env.MAGPIE_NO_ACCOUNTS, undefined);
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'REIN_MAGPIE_GATEWAY_KEY']) assert.equal(options.env[name], undefined);
  assert.deepEqual(f.order, ['verify', 'port', 'configure', 'spawn']);
  assert.equal(f.calls.configure[0][0], binary);
  assert.equal(f.calls.configure[0][1].cwd, options.cwd); assert.equal(f.calls.configure[0][1].env, options.env);
  f.close(); assert.equal(await result, 0);
  assert.deepEqual(f.calls.ports, ['http://127.0.0.1:3425/v1', 'http://127.0.0.1:3425/v1']);
  assert.equal(f.calls.stop.length, 0, 'native Quit must not signal a reaped PID');
  assert.equal(existsSync(f.lockPath), false);
  assert.equal(f.signalSource.listenerCount('SIGINT'), 0); assert.equal(f.signalSource.listenerCount('SIGTERM'), 0);
});

test('default UI opens through upstream without exposing arbitrary native or LAN flags', async t => {
  const f = fixture(t), { result } = await f.run();
  assert.deepEqual(f.calls.spawn[0][1], ['web', '--addr', '127.0.0.1:0']); f.close(); await result;
  for (const args of [['--addr', '0.0.0.0:3425'], ['--addr=127.0.0.1:1234'], ['serve'], ['daemon', 'install'],
    ['--no-open', '--no-open'], ['--allow-subscription-accounts'], ['--key=private']])
    await assert.rejects(runMagpieUi(args, f.options), { message: 'magpie_ui_arguments_invalid' });
  assert.equal(f.calls.spawn.length, 1);
});

test('a busy private profile rejects before a gateway check or spawn', async t => {
  const f = fixture(t);
  await ensureManagedDirectories(buildManagedEnvironment({ homeDir: f.paths.homeDir, baseUrl: 'http://127.0.0.1:3425/v1' }));
  const release = await acquireManagedProfileLock(f.paths.homeDir);
  try {
    await assert.rejects(runMagpieUi([], f.options), { message: 'rein_magpie_profile_busy' });
    assert.equal(f.calls.ports.length, 0); assert.equal(f.calls.configure.length, 0);
    assert.equal(f.calls.spawn.length, 0); assert.equal(existsSync(f.lockPath), true);
  } finally { await release(); }
});

test('an occupied or inconclusive fixed gateway rejects without adopting or stopping any process', async t => {
  const f = fixture(t);
  for (const occupied of [true, undefined]) {
    await assert.rejects(runMagpieUi([], { ...f.options, portCheck: async () => {
      assert.equal(existsSync(f.lockPath), true); return occupied;
    } }), { message: 'magpie_ui_gateway_occupied' });
    assert.equal(existsSync(f.lockPath), false);
  }
  assert.equal(f.calls.configure.length, 0); assert.equal(f.calls.spawn.length, 0); assert.equal(f.calls.stop.length, 0);
});

test('SIGINT and SIGTERM clean the owned live process tree once and release the profile lock', async t => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const f = fixture(t), { result } = await f.run();
    f.signalSource.emit(signal); f.signalSource.emit(signal);
    assert.equal(await result, code); assert.deepEqual(f.calls.stop, [f.child]);
    assert.equal(existsSync(f.lockPath), false);
    assert.equal(f.signalSource.listenerCount('SIGINT'), 0); assert.equal(f.signalSource.listenerCount('SIGTERM'), 0);
  }
});

test('a signal and normal native close in either same-turn order release the lock without stopping a reaped child', async t => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    for (const signalFirst of [true, false]) {
      let stopCalls = 0;
      const f = fixture(t, { stopImpl: async () => { stopCalls++; throw new Error('must not stop an already closed child'); } });
      const { result } = await f.run();
      if (signalFirst) { f.signalSource.emit(signal); f.close(); }
      else { f.close(); f.signalSource.emit(signal); }
      assert.equal(await result, code); assert.equal(stopCalls, 0);
      assert.equal(f.calls.ports.length, 2, 'normal close must still verify the gateway closed');
      assert.equal(existsSync(f.lockPath), false);
      assert.equal(f.signalSource.listenerCount('SIGINT'), 0); assert.equal(f.signalSource.listenerCount('SIGTERM'), 0);
    }
  }
});

test('an observed tree cleanup failure retains the lock and reports a fixed diagnostic', async t => {
  const f = fixture(t, { stopImpl: async () => { throw new Error('private child failure'); } });
  const { result } = await f.run(); f.signalSource.emit('SIGTERM');
  await assert.rejects(result, { message: 'magpie_ui_cleanup_required' });
  assert.equal(existsSync(f.lockPath), true); assert.equal(f.signalSource.listenerCount('SIGTERM'), 0);
  await assert.rejects(acquireManagedProfileLock(f.paths.homeDir), { message: 'rein_magpie_profile_busy' });
});

test('native Quit retains the lock if its gateway remains open and never signals a reused process', async t => {
  const f = fixture(t); let checks = 0;
  f.options.portCheck = async () => ++checks > 1;
  const { result } = await f.run(); f.close();
  await assert.rejects(result, { message: 'magpie_ui_cleanup_required' });
  assert.equal(f.calls.stop.length, 0); assert.equal(existsSync(f.lockPath), true);
});

test('spawn throws and no-PID startup errors release the lock without leaking private errors', async t => {
  const f = fixture(t);
  await assert.rejects(runMagpieUi([], { ...f.options, spawnImpl: () => { throw new Error('private spawn error'); } }),
    { message: 'magpie_ui_failed_to_start' });
  assert.equal(existsSync(f.lockPath), false);
  delete f.child.pid;
  const { result } = await f.run(); f.child.emit('error', new Error('private binary error'));
  await assert.rejects(result, { message: 'magpie_ui_failed_to_start' });
  assert.equal(f.calls.stop.length, 0); assert.equal(existsSync(f.lockPath), false);
});

test('verification and port check errors stop before spawn and use fixed diagnostics', async t => {
  const f = fixture(t);
  await assert.rejects(runMagpieUi([], { ...f.options, verifier: async () => { throw new Error('private receipt error'); } }),
    { message: 'magpie_ui_dependency_verification_failed' });
  await assert.rejects(runMagpieUi([], { ...f.options, portCheck: async () => { throw new Error('private socket error'); } }),
    { message: 'magpie_ui_gateway_check_failed' });
  assert.equal(existsSync(f.lockPath), false); assert.equal(f.calls.configure.length, 0); assert.equal(f.calls.spawn.length, 0);
});

test('native updater setup uses only the verified fixed command with private output and bounded execution', async () => {
  const environment = { HOME: '/project/private/home' };
  await disableMagpieAutoUpdate('/project/pinned/magpie', { cwd: environment.HOME, env: environment }, (binary, args, options, callback) => {
    assert.equal(binary, '/project/pinned/magpie'); assert.deepEqual(args, ['update', 'auto', 'off']);
    assert.equal(options.cwd, environment.HOME); assert.equal(options.env, environment); assert.equal(options.shell, false);
    assert.equal(options.timeout, 3000); assert.equal(options.maxBuffer, 64 * 1024); assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.stdio, undefined, 'execFile must capture rather than inherit setup output');
    callback(null, 'private native output', 'private native diagnostics');
  });
  await assert.rejects(disableMagpieAutoUpdate('/project/pinned/magpie', { cwd: environment.HOME, env: environment },
    (_binary, _args, _options, callback) => callback(new Error('private native configuration failure'))),
  { message: 'magpie_ui_configuration_failed' });
});

test('native configuration failure releases the lock and prevents web spawn with a fixed diagnostic', async t => {
  const f = fixture(t, { configureNative: async () => { throw new Error('private settings error'); } });
  await assert.rejects(runMagpieUi([], f.options), { message: 'magpie_ui_configuration_failed' });
  assert.equal(f.calls.spawn.length, 0); assert.equal(f.calls.stop.length, 0); assert.equal(existsSync(f.lockPath), false);
  assert.equal(f.signalSource.listenerCount('SIGINT'), 0); assert.equal(f.signalSource.listenerCount('SIGTERM'), 0);
});
