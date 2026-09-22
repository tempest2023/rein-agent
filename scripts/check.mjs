import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = p => readFileSync(resolve(root, p), 'utf8');
for (const p of ['README.md', 'AGENTS.md', 'workspace/AGENTS.md', 'workspace/SOUL.md', 'workspace/IDENTITY.md', 'docs/architecture.md', 'docs/roadmap.md', 'docs/setup.md', 'docs/decisions.md', 'assets/brand/README.md', 'templates/proposal.md', 'templates/board-brief.md', 'templates/outcome.md', 'templates/weekly-summary.md']) {
  assert.ok(existsSync(resolve(root, p)) && read(p).trim(), `Missing/empty: ${p}`);
}
const config = JSON.parse(read('config/operations.example.json'));
assert.equal(config.status, 'draft-unapproved');
assert.equal(config.automationEnabled, false);
function unconfigured(value, path = '') {
  for (const [key, item] of Object.entries(value)) {
    if (key === 'status' || key === 'automationEnabled') continue;
    if (item && typeof item === 'object') unconfigured(item, `${path}${key}.`);
    else assert.equal(item, null, `Example policy must stay unapproved: ${path}${key}`);
  }
}
unconfigured(config);
const hashes = JSON.parse(read('docs/source-hashes.json'));
for (const [source, expected] of Object.entries(hashes)) {
  const path = source === 'README.md' ? 'docs/foundation-implementation-snapshot.md' : source;
  const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  assert.equal(actual, expected, `Source snapshot changed: ${path}`);
}
for (const p of ['docs/PRD-agent-community-operations-zh.md', 'docs/PRD-agent-community-operations.md']) {
  for (let i = 1; i <= 20; i++) assert.ok(read(p).includes(`AC${String(i).padStart(2, '0')}`), `${p}: missing acceptance criterion ${i}`);
}
console.log('Scaffold OK: required files, unapproved example policy, source hashes, AC01–AC20. No production integration tested.');
