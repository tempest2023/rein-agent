import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('upstream update uses exact fetched ref, preserves dirty work and leaves HEAD on failed fetch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rein-upstream-'));
  const origin = join(dir, 'origin');
  const project = join(dir, 'rein');
  const source = join(project, 'vendor/openclaw');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(origin); git(origin, 'init', '-b', 'main');
    git(origin, 'config', 'user.name', 'Fixture'); git(origin, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(origin, 'package.json'), '{}\n');
    git(origin, 'add', '.'); git(origin, 'commit', '-m', 'initial');
    mkdirSync(join(project, 'vendor'), { recursive: true });
    git(project, 'clone', origin, source);
    mkdirSync(join(project, 'scripts'));
    for (const name of ['runtime-env.mjs', 'update-openclaw.mjs']) cpSync(new URL(`../scripts/${name}`, import.meta.url), join(project, 'scripts', name));
    writeFileSync(join(origin, 'new.txt'), 'upstream'); git(origin, 'add', '.'); git(origin, 'commit', '-m', 'new upstream');
    const expected = git(origin, 'rev-parse', 'HEAD');
    const update = (ref = 'main') => spawnSync(process.execPath, [join(project, 'scripts/update-openclaw.mjs'), ref], { encoding: 'utf8' });
    let result = update(); assert.equal(result.status, 0, result.stderr);
    assert.equal(git(source, 'rev-parse', 'HEAD'), expected);
    writeFileSync(join(source, 'package.json'), '{"local":true}\n');
    result = update(); assert.notEqual(result.status, 0); assert.match(result.stderr, /local changes/);
    assert.equal(git(source, 'rev-parse', 'HEAD'), expected);
    git(source, 'checkout', '--', 'package.json');
    result = update('missing-ref'); assert.notEqual(result.status, 0);
    assert.equal(git(source, 'rev-parse', 'HEAD'), expected);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
