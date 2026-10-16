import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { bootstrapMagpie, magpieBuildCommand, magpiePaths, projectRoot, readMagpieLock,
  verifyMagpieInstallation } from '../scripts/magpie-dependency.mjs';
import { validateMagpieArguments } from '../scripts/magpie.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rein-magpie-dependency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = magpiePaths(root);
  mkdirSync(dirname(paths.lock), { recursive: true });
  copyFileSync(magpiePaths(projectRoot).lock, paths.lock);
  mkdirSync(paths.source, { recursive: true });
  const lock = readMagpieLock(root);
  writeFileSync(join(paths.source, 'go.mod'), `module github.com/yetone/magpie\n\ngo ${lock.goVersion}\n`);
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') return { code: 0, stderr: '', stdout:
      args[0] === 'remote' ? lock.repository : args[0] === 'rev-parse' ? lock.revision : '' };
    assert.equal(command, 'go');
    writeFileSync(args[args.indexOf('-o') + 1], 'synthetic compiled native binary', { mode: 0o755 });
    return { code: 0, stdout: '', stderr: '' };
  };
  return { root, paths, lock, calls, run };
}

test('builds only the pinned project-local nogui CLI, with no installation command', async t => {
  const f = fixture(t);
  const environment = Object.freeze({ PATH: '/usr/bin', CGO_ENABLED: '1', GOTOOLCHAIN: 'local',
    GOENV: '/inherited/go.env', GOWORK: '/inherited/go.work', GOEXPERIMENT: 'invalid-experiment',
    GOOS: 'invalid-target', GOARCH: 'invalid-arch', GOFLAGS: '-mod=mod' });
  const installed = await bootstrapMagpie({ root: f.root, run: f.run,
    environment });
  const build = f.calls.find(call => call.command === 'go');
  assert.deepEqual(build.args.slice(0, 7), ['build', '-mod=readonly', '-tags', 'nogui', '-trimpath', '-buildvcs=false', '-ldflags']);
  assert.equal(build.args[7], `-s -w -X main.version=${f.lock.version}`);
  assert.equal(build.options.env.CGO_ENABLED, '0');
  assert.equal(build.options.env.GOTOOLCHAIN, 'auto');
  assert.equal(build.options.env.GOENV, 'off');
  assert.equal(build.options.env.GOWORK, 'off');
  assert.equal(build.options.env.GOEXPERIMENT, '');
  assert.equal(build.options.env.GOFLAGS, '');
  assert.equal(build.options.env.GOOS, undefined);
  assert.equal(build.options.env.GOARCH, undefined);
  assert.equal(environment.CGO_ENABLED, '1', 'Build isolation must not mutate the caller environment');
  assert.equal(installed.binaryPath, f.paths.binary);
  assert.deepEqual(Object.keys(installed.receipt).sort(), ['revision', 'sha256', 'version']);
  assert.equal(installed.receipt.revision, f.lock.revision);
  assert.equal(f.calls.filter(call => call.command === 'go').length, 1);
});

test('refuses modified or untracked source before any build', async t => {
  const f = fixture(t);
  const run = (command, args, options) => args[0] === 'status'
    ? Promise.resolve({ code: 0, stdout: '?? injected.go\n', stderr: '' }) : f.run(command, args, options);
  await assert.rejects(bootstrapMagpie({ root: f.root, run }), /source_dirty/);
  assert.ok(f.calls.every(call => call.command !== 'go'));
});

test('updates a clean source checkout by exact revision rather than a moving branch', async t => {
  const f = fixture(t);
  let revision = 'a'.repeat(40);
  const run = async (command, args, options) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      f.calls.push({ command, args, options });
      return { code: 0, stdout: revision, stderr: '' };
    }
    if (command === 'git' && args[0] === 'checkout') revision = f.lock.revision;
    return f.run(command, args, options);
  };
  await bootstrapMagpie({ root: f.root, run });
  assert.deepEqual(f.calls.find(call => call.args[0] === 'fetch').args,
    ['fetch', '--depth=1', 'origin', f.lock.revision]);
  assert.deepEqual(f.calls.find(call => call.args[0] === 'checkout').args,
    ['checkout', '--detach', f.lock.revision]);
});

test('refuses a binary changed after its receipt was created', async t => {
  const f = fixture(t);
  await bootstrapMagpie({ root: f.root, run: f.run });
  writeFileSync(f.paths.binary, 'modified executable');
  await assert.rejects(verifyMagpieInstallation({ root: f.root }), /receipt_mismatch/);
});

test('verifies a custom absolute binary path and rejects portable state overrides', async t => {
  const f = fixture(t);
  await bootstrapMagpie({ root: f.root, run: f.run });
  const binaryPath = join(f.root, 'custom/magpie');
  mkdirSync(dirname(binaryPath));
  copyFileSync(f.paths.binary, binaryPath); copyFileSync(f.paths.receipt, `${binaryPath}.json`);
  assert.equal((await verifyMagpieInstallation({ root: f.root, binaryPath })).binaryPath, binaryPath);
  await assert.rejects(verifyMagpieInstallation({ root: f.root, binaryPath: 'relative/magpie' }), /must_be_absolute/);
  writeFileSync(join(dirname(binaryPath), '.portable'), '');
  await assert.rejects(verifyMagpieInstallation({ root: f.root, binaryPath }), /portable_mode_disallowed/);
});

test('pin changes require a new matching receipt and exact Go module version', async t => {
  const f = fixture(t);
  await bootstrapMagpie({ root: f.root, run: f.run });
  const next = { ...f.lock, revision: 'f'.repeat(40), version: `rein-${'f'.repeat(12)}` };
  writeFileSync(f.paths.lock, JSON.stringify(next));
  await assert.rejects(verifyMagpieInstallation({ root: f.root }), /receipt_mismatch/);
  writeFileSync(f.paths.lock, JSON.stringify(f.lock));
  writeFileSync(join(f.paths.source, 'go.mod'), 'module github.com/yetone/magpie\n\ngo 1.0.0\n');
  await assert.rejects(bootstrapMagpie({ root: f.root, run: f.run }), /go_version_mismatch/);
});

test('build command stamps the reviewed version without invoking a shell', () => {
  const lock = readMagpieLock();
  const command = magpieBuildCommand(lock, '/a path/magpie');
  assert.equal(command.command, 'go');
  assert.equal(command.args.at(-2), '/a path/magpie');
  assert.ok(!command.args.includes('install'));
});

test('project CLI admits explicit safe configuration and stdin gateway-key reuse', () => {
  for (const args of [[], ['version'], ['accounts', 'add', 'gemini'],
    ['provider', 'add', 'China Coding', 'url=https://coding.dashscope.aliyuncs.com/v1', 'models=qwen-coder'],
    ['provider', 'fallback', 'coding', 'none'], ['quota', 'credits', 'off'],
    ['gateway-key', 'add', 'Rein', '--key', '-']]) assert.ok(validateMagpieArguments(args));
});

test('project CLI rejects host lifecycle changes and credentials in argv', () => {
  for (const args of [['daemon', 'install'], ['autostart', 'on'], ['update'], ['serve'], ['serve', '--web'],
    ['provider', 'key', 'coding', 'sk-sp-private'], ['provider', 'add', 'deepseek', 'secret-value'],
    ['provider', 'add', 'coding', 'key=private'], ['provider', 'set', 'coding', 'header.X-Token=private'],
    ['provider', 'set', 'coding', 'url=https://user:private@example.com/v1'],
    ['gateway-key', 'add', 'Rein', '--key', 'secret-value'], ['quota', 'credits', 'on'], ['quota', 'credits', 'ON'],
    ['accounts', 'import', 'codex', '/real/account/auth.json']])
    assert.throws(() => validateMagpieArguments(args), /disallowed|no_web_or_tls_flags/);
});
