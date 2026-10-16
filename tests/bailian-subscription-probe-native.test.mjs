import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from '../scripts/runtime-env.mjs';
import { verifyMagpieInstallation } from '../scripts/magpie-dependency.mjs';
import { runNativeBailianOwnerProbe } from '../scripts/verify-bailian-subscription.mjs';
import { profileDigest } from './fixtures/bailian-owner-runtime.mjs';

test('native production router, actual managed Magpie and local integration echo complete two synthetic model calls',
  { skip: process.env.REIN_RUN_NATIVE_BAILIAN_SYNTHETIC !== '1', timeout: 180000 }, async () => {
    const prepared = await verifyMagpieInstallation({ root });
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'rein-bailian-native-test-')));
    const requests = [];
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
      let text = ''; for await (const chunk of req) text += chunk;
      const request = JSON.parse(text); requests.push(request);
      const toolResult = request.messages.some(message => message.role === 'tool');
      const delta = toolResult ? { role: 'assistant', content: 'OK' } : { role: 'assistant', tool_calls: [
        { index: 0, id: 'call_bailian_owner', type: 'function', function: { name: 'tool_call',
          arguments: JSON.stringify({ id: 'rein_probe_echo', args: { marker: 'REIN_BAILIAN_OWNER_CHECK' } }) } },
      ] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = { id: 'synthetic-bailian-owner', object: 'chat.completion.chunk', created: 1,
        model: 'qwen3.8-flash', choices: [{ index: 0, delta, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.write(`data: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: toolResult ? 'stop' : 'tool_calls' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...event, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const upstream = `http://127.0.0.1:${server.address().port}/v1`;
      const reservation = createSocketServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
      const homeDir = join(temp, 'magpie/home'), dir = join(temp, 'magpie/config/magpie');
      mkdirSync(homeDir, { recursive: true, mode: 0o700 }); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const gatewayKey = `sk-magpie-key-${'b'.repeat(48)}`;
      const providerPath = join(dir, 'providers.json'), keyPath = join(dir, 'caller-keys.json');
      writeFileSync(providerPath, JSON.stringify({ providers: [{ id: 'bailian-token-plan', preset: 'bailian-token-plan',
        name: 'Synthetic Bailian integration', key: 'synthetic-upstream-key', chat: upstream, models: ['qwen3.8-flash'] }],
        noAutoGroups: true }), { mode: 0o600 });
      writeFileSync(keyPath, JSON.stringify([{ id: 'synthetic-owner', name: 'Synthetic integration', secret: gatewayKey,
        models: ['bailian-token-plan/qwen3.8-flash'] }]), { mode: 0o600 });
      const profilePaths = [providerPath, keyPath];
      const result = await runNativeBailianOwnerProbe({ root, paths: { binary: prepared.binaryPath, homeDir },
        router: { gateway: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnvVar: 'REIN_BAILIAN_SYNTHETIC_KEY',
          subscriptionOnly: true, managed: { binaryPath: prepared.binaryPath, homeDir, allowSubscriptionAccounts: false } } },
        gatewayKey, profilePaths, digest: profileDigest(profilePaths) }, 'absent', { synthetic: true });
      assert.equal(result.mode, 'synthetic'); assert.equal(result.modelCalls, 2);
      assert.equal(result.tool.executions, 1); assert.equal(result.tool.nativeContinuation, true);
      assert.equal(requests.length, 2);
      assert.ok(requests.every(request => request.model === 'qwen3.8-flash' && request.reasoning_effort === 'none' &&
        Number.isSafeInteger(request.max_tokens ?? request.max_completion_tokens) && (request.max_tokens ?? request.max_completion_tokens) <= 256),
      JSON.stringify(requests.map(request => ({ model: request.model, effort: request.reasoning_effort,
        maxTokens: request.max_tokens, maxCompletionTokens: request.max_completion_tokens }))));
      assert.ok(requests[1].messages.some(message => message.role === 'tool'));
      assert.deepEqual(result.vendorServedModels, ['qwen3.8-flash']);
      assert.equal(result.prepaidAddons, 'absent');
      assert.ok(!['entitlement', 'entitlementEvidence', 'publicDeploymentEligibility', 'monthlyEntitlementVerified']
        .some(field => Object.hasOwn(result, field)));
      assert.equal(result.usage.input, 40); assert.equal(result.usage.output, 10);
      assert.equal(existsSync(join(temp, 'magpie/.rein-magpie.lock')), false);
    } finally {
      console.log(JSON.stringify({ syntheticModelRequests: requests.length }));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      // The harness retains its private artifacts if owned cleanup is uncertain.
      if (!existsSync(join(temp, 'magpie/.rein-magpie.lock'))) rmSync(temp, { recursive: true, force: true });
    }
  });
