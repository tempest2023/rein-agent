import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { environment } from './runtime-env.mjs';
const config = JSON.parse(readFileSync(environment().OPENCLAW_CONFIG_PATH, 'utf8'));
assert.equal(config.gateway.bind, 'loopback', 'Smoke test is limited to the local development gateway');
assert.equal(config.gateway.auth.mode, 'token');
assert.equal(typeof config.gateway.auth.token, 'string');
const response = await fetch(`http://127.0.0.1:${config.gateway.port}/tools/invoke`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.gateway.auth.token}` },
  body: JSON.stringify({ tool: 'rein_status', args: {} }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(response.status, 200, 'Start the local gateway and confirm rein_status is allowed');
const body = await response.json();
assert.equal(body.ok, true);
assert.equal(body.result.details.automationEnabled, false);
assert.deepEqual(body.result.details.implemented, ['rein_status']);
console.log('Live gateway verified: authenticated rein_status invocation succeeded; no business automation enabled.');
