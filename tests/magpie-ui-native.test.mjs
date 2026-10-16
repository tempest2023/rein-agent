import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection, createServer as createSocketServer } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { magpiePaths, projectRoot, verifyMagpieInstallation } from '../scripts/magpie-dependency.mjs';
import { stopOwnedProcessTree } from '../plugins/rein-router/process-tree.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const live = child => child && child.exitCode === null && child.signalCode === null;
const fail = phase => { throw new Error(`magpie_ui_native_${phase}_failed`); };

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server.address().port;
}

async function vacantPort() {
  const server = createSocketServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function listening(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = value => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', error => done(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(250, () => done(true));
  });
}

async function waitForClose(child, timeoutMs) {
  if (!live(child)) return true;
  return new Promise(resolve => {
    const done = value => { clearTimeout(timer); child.off('close', closed); resolve(value); };
    const closed = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once('close', closed);
  });
}

async function response(url, headers, maxBytes = 128 * 1024) {
  const result = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(3000) });
  let text = '';
  if (result.body) {
    const reader = result.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > maxBytes) fail('response_bound');
        text += decoder.decode(item.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  }
  return { status: result.status, headers: result.headers, text };
}

test('native Magpie UI launcher disables updates, bootstraps its private cookie and closes both listeners on SIGTERM',
  { skip: process.env.REIN_RUN_NATIVE_MAGPIE_UI !== '1', timeout: 90000 }, async () => {
    let phase = 'dependency';
    let temp, child, upstreamServer, denyProxy, gatewayPort, uiPort;
    let modelRequests = 0, stopped = false;
    try {
      const prepared = await verifyMagpieInstallation({ root: projectRoot });
      phase = 'fixture';
      temp = realpathSync(mkdtempSync(join(tmpdir(), 'rein-magpie-ui-native-')));
      const paths = magpiePaths(temp);
      for (const directory of [dirname(paths.binary), dirname(paths.lock), paths.homeDir,
        join(temp, 'runtime/magpie/config/magpie')]) mkdirSync(directory, { recursive: true, mode: 0o700 });
      copyFileSync(prepared.binaryPath, paths.binary); chmodSync(paths.binary, 0o700);
      copyFileSync(`${prepared.binaryPath}.json`, paths.receipt); chmodSync(paths.receipt, 0o600);
      copyFileSync(magpiePaths(projectRoot).lock, paths.lock); chmodSync(paths.lock, 0o600);
      const copied = await verifyMagpieInstallation({ root: temp });
      assert.equal(copied.lock.version, prepared.lock.version);

      upstreamServer = createServer((request, reply) => {
        if (request.method === 'POST') modelRequests++;
        request.resume();
        reply.writeHead(request.method === 'GET' ? 200 : 503, { 'content-type': 'application/json' });
        reply.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: 'capable' }] }
          : { error: { message: 'Synthetic UI fixture does not provide inference' } }));
      });
      const upstreamPort = await listen(upstreamServer);
      denyProxy = createServer((request, reply) => { request.resume(); reply.writeHead(403); reply.end(); });
      denyProxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
      const proxy = `http://127.0.0.1:${await listen(denyProxy)}`;
      gatewayPort = await vacantPort();
      const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}/v1`;
      const gatewayKey = `sk-magpie-key-${randomBytes(24).toString('hex')}`;
      const profile = join(temp, 'runtime/magpie/config/magpie');
      const privateJson = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      // Start with the upstream updater enabled so the native settings check
      // below verifies the launcher's configuration rather than this fixture.
      privateJson(join(profile, 'settings.json'), { noAutoUpdate: false, noAccountDiscovery: true,
        noStats: true, noUsageStats: true, quotaReads: 'asked' });
      privateJson(join(profile, 'providers.json'), { providers: [{ id: 'fixture', name: 'Synthetic UI fixture',
        key: 'synthetic-upstream-key', chat: `http://127.0.0.1:${upstreamPort}/v1`, models: ['capable'] }], noAutoGroups: true });
      privateJson(join(profile, 'caller-keys.json'), [{ id: 'synthetic-ui', name: 'Synthetic UI metadata caller',
        secret: gatewayKey, models: ['fixture/capable'] }]);
      const evidencePath = join(temp, 'private-bootstrap.json');
      const nativeOutput = join(temp, 'private-native-output.log');
      const wrapperOutput = join(temp, 'private-launcher-output.log');
      writeFileSync(nativeOutput, '', { mode: 0o600 }); writeFileSync(wrapperOutput, '', { mode: 0o600 });
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        /^(?:PATH|LANG|LC_[A-Z_]+|TZ|TERM|SYSTEMROOT|COMSPEC|PATHEXT)$/.test(name)));
      Object.assign(environment, { REIN_UI_TEST_ROOT: temp, REIN_UI_TEST_GATEWAY: gatewayBaseUrl,
        REIN_UI_TEST_EVIDENCE: evidencePath, REIN_UI_TEST_OUTPUT: nativeOutput,
        HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
        NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
      const launcher = new URL('../scripts/magpie-ui.mjs', import.meta.url).href;
      // Only the test's spawn hook captures the native key-bearing URL. The
      // production launcher remains responsible for profile/process ownership.
      const script = `
        import {spawn} from 'node:child_process';
        import {writeFileSync} from 'node:fs';
        import {runMagpieUi,disableMagpieAutoUpdate} from ${JSON.stringify(launcher)};
        let output = '', recorded = false;
        const isolatedTestEnv = env => ({...env,MAGPIE_NO_ACCOUNTS:'1'});
        const spawnImpl = (binary, args, options) => {
          const native = spawn(binary, args, {...options, env: isolatedTestEnv(options.env),
            stdio:['ignore','pipe','pipe']});
          const capture = chunk => {
            if (Buffer.byteLength(output) >= 1024*1024) return;
            output += chunk.toString();
            if (Buffer.byteLength(output) > 1024*1024) output = output.slice(0, 1024*1024);
            writeFileSync(process.env.REIN_UI_TEST_OUTPUT, output, {mode:0o600});
            const match = /http:\\/\\/127\\.0\\.0\\.1:\\d+\\/\\?k=[A-Za-z0-9._~-]+/.exec(output);
            if (!recorded && match) {
              recorded = true;
              writeFileSync(process.env.REIN_UI_TEST_EVIDENCE, JSON.stringify({url:match[0],nativePid:native.pid}),
                {mode:0o600,flag:'wx'});
            }
          };
          native.stdout.on('data',capture); native.stderr.on('data',capture);
          return native;
        };
        try { process.exitCode = await runMagpieUi(['--no-open'], {root:process.env.REIN_UI_TEST_ROOT,
          gatewayBaseUrl:process.env.REIN_UI_TEST_GATEWAY,environment:process.env,spawnImpl,
          configureNative:(binary,options)=>disableMagpieAutoUpdate(binary,
            {...options,env:isolatedTestEnv(options.env)})}); }
        catch { console.error('magpie_ui_native_launcher_failed'); process.exitCode = 1; }
      `;
      phase = 'startup';
      child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: temp, env: environment,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let spawnFailed = false, wrapperText = '';
      child.once('error', () => { spawnFailed = true; });
      const captureWrapper = chunk => {
        if (wrapperText.length >= 64 * 1024) return;
        wrapperText = (wrapperText + chunk.toString()).slice(0, 64 * 1024);
        writeFileSync(wrapperOutput, wrapperText, { mode: 0o600 });
      };
      child.stdout.on('data', captureWrapper); child.stderr.on('data', captureWrapper);
      const deadline = Date.now() + 30000;
      while (!existsSync(evidencePath) && Date.now() < deadline && !spawnFailed && live(child)) await pause(50);
      if (spawnFailed || !live(child) || !existsSync(evidencePath)) fail(phase);
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
      const ui = new URL(evidence.url);
      if (ui.protocol !== 'http:' || ui.hostname !== '127.0.0.1' || !Number(ui.port) ||
          ui.pathname !== '/' || !/^[a-f0-9]{32}$/.test(ui.searchParams.get('k') ?? '') ||
          !Number.isSafeInteger(evidence.nativePid) || evidence.nativePid <= 1) fail('bootstrap_shape');
      uiPort = Number(ui.port);
      const cleanUrl = new URL('/', ui).href;
      const profileLock = join(temp, 'runtime/magpie/.rein-magpie.lock');
      assert.equal(existsSync(profileLock), true, 'UI launcher must hold its private profile lock');
      assert.equal(JSON.parse(readFileSync(profileLock, 'utf8')).pid, child.pid);
      if (process.platform !== 'win32') {
        assert.equal(statSync(profileLock).mode & 0o777, 0o600);
        assert.equal(statSync(evidencePath).mode & 0o777, 0o600);
      }

      phase = 'bootstrap';
      assert.equal((await response(new URL('/api/settings', cleanUrl))).status, 401);
      assert.equal((await response(new URL('/?k=synthetic-wrong-key', cleanUrl))).status, 401);
      const bootstrap = await response(ui);
      assert.equal(bootstrap.status, 303);
      assert.equal(bootstrap.headers.get('location'), '/');
      const cookies = bootstrap.headers.getSetCookie();
      assert.equal(cookies.length, 1);
      assert.ok(cookies[0].startsWith(`magpie_web_${uiPort}=`));
      assert.ok(/;\s*HttpOnly(?:;|$)/i.test(cookies[0]));
      assert.ok(/;\s*SameSite=Lax(?:;|$)/i.test(cookies[0]));
      const headers = { Cookie: cookies[0].split(';', 1)[0] };
      const page = await response(cleanUrl, headers, 6 * 1024 * 1024);
      assert.equal(page.status, 200);
      assert.ok(page.headers.get('content-type')?.includes('text/html'));
      assert.ok(/<html/i.test(page.text) && /magpie/i.test(page.text));
      const settingsResponse = await response(new URL('/api/settings', cleanUrl), headers);
      assert.equal(settingsResponse.status, 200);
      const settings = JSON.parse(settingsResponse.text);
      assert.equal(settings.version, prepared.lock.version);
      assert.equal(settings.noAutoUpdate, true);
      assert.equal(settings.noAccountDiscovery, true);
      assert.equal(settings.quotaReads, 'asked');
      assert.equal(settings.addrEnv, `127.0.0.1:${gatewayPort}`);

      phase = 'gateway';
      const gatewayHeaders = { Authorization: `Bearer ${gatewayKey}`, Origin: 'null' };
      let info, catalog;
      while (Date.now() < deadline && live(child)) {
        try {
          const metadata = await response(`http://127.0.0.1:${gatewayPort}/`, gatewayHeaders);
          const models = await response(`${gatewayBaseUrl}/models`, gatewayHeaders);
          if (metadata.status === 200 && models.status === 200) {
            info = JSON.parse(metadata.text); catalog = JSON.parse(models.text);
            if (info.name === 'magpie' && info.version === prepared.lock.version &&
                catalog.data?.length === 1 && catalog.data[0].id === 'fixture/capable') break;
          }
        } catch { /* Only fixed phase diagnostics leave this private fixture. */ }
        await pause(50);
      }
      assert.equal(info?.name, 'magpie');
      assert.equal(info?.version, prepared.lock.version);
      assert.deepEqual(catalog?.data?.map(model => model.id), ['fixture/capable']);
      assert.equal(modelRequests, 0);

      phase = 'shutdown';
      const closed = waitForClose(child, 10000);
      child.kill('SIGTERM');
      assert.equal(await closed, true, 'UI launcher must settle after SIGTERM');
      assert.equal(child.exitCode, 143);
      const shutdownDeadline = Date.now() + 3000;
      while (Date.now() < shutdownDeadline &&
        (existsSync(profileLock) || await listening(uiPort) || await listening(gatewayPort))) await pause(50);
      assert.equal(await listening(uiPort), false);
      assert.equal(await listening(gatewayPort), false);
      assert.equal(existsSync(profileLock), false);
      assert.equal(modelRequests, 0);
      stopped = true;
    } catch {
      fail(phase);
    } finally {
      if (live(child)) {
        const closed = waitForClose(child, 5000);
        child.kill('SIGTERM');
        if (!await closed && live(child)) await stopOwnedProcessTree(child).catch(() => {});
      }
      for (const server of [upstreamServer, denyProxy]) if (server?.listening) {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }
      if (temp) {
        const lockExists = existsSync(join(temp, 'runtime/magpie/.rein-magpie.lock'));
        const portsClosed = (!uiPort || !await listening(uiPort)) && (!gatewayPort || !await listening(gatewayPort));
        // Retain the private profile and bounded output if ownership cleanup
        // could not be established; never remove a surviving owner's lock.
        if (!live(child) && !lockExists && portsClosed) rmSync(temp, { recursive: true, force: true });
        else if (stopped) fail('cleanup');
      }
    }
  });
