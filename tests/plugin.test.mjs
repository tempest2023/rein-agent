import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import plugin from '../plugins/rein-operations/index.ts';

test('real SDK entry registers only its declared read-only tool and reports no active operations', async () => {
  const registered = [];
  const manifest = JSON.parse(readFileSync(new URL('../plugins/rein-operations/openclaw.plugin.json', import.meta.url)));
  plugin.register({ registerTool(tool) { registered.push(tool); } });
  assert.equal(plugin.id, manifest.id);
  assert.deepEqual(registered.map(t => t.name), manifest.contracts.tools);
  assert.equal(registered.length, 1);
  const result = await registered[0].execute('test', {});
  assert.equal(result.details.automationEnabled, false);
  assert.deepEqual(result.details.implemented, ['rein_status']);
  assert.ok(Object.values(result.details.integrations).every(value => value === 'not-connected'));
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});
