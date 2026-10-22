import { existsSync, readdirSync } from 'node:fs';
import { browserBinary, verifyBrowser } from './agent-browser-dependency.mjs';
import { browserContext, browserEnvironment, createBrowserRunner, nativeArgs, parseBrowserArgs, runNative, waitForBrowserClose } from './agent-browser-runtime.mjs';
import { ensureLogin, parseLoginArgs } from './agent-browser-login.mjs';

try {
  const options = parseBrowserArgs(process.argv.slice(2));
  const context = browserContext();
  verifyBrowser();
  if (options.args[0] === 'ensure-login') {
    const result = await ensureLogin(createBrowserRunner(context, options), parseLoginArgs(options.args.slice(1)));
    console.log(JSON.stringify(result));
    if (result.status !== 'authenticated') process.exitCode = 2;
  } else if (options.args[0] === 'auth' && options.args[1] === 'list') {
    // Enumerate only this instance's aliases; never decrypt other applications' profiles.
    const prefix = context.namespace + '-';
    const profiles = (existsSync(context.authDir) ? readdirSync(context.authDir) : [])
      .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
      .map(name => ({ name: name.slice(prefix.length, -5) }));
    console.log(JSON.stringify({ success: true, data: { profiles } }));
  } else {
    const offline = ['skills', '--version', '--help', 'install'].includes(options.args[0]);
    const env = offline ? Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_BROWSER_'))) : browserEnvironment(context);
    const result = await runNative(browserBinary, nativeArgs(context, options), env,
      { timeout: options.args[0] === 'install' ? 300_000 : 90_000 });
    if (result.code === 0 && ['close', 'quit', 'exit'].includes(options.args[0])) await waitForBrowserClose(context, options.session);
    process.exitCode = result.code;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
