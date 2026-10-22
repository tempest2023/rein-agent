export function parseLoginArgs(args) {
  const [alias, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--url', '--authenticated-selector', '--login-selector'].includes(rest[i]) || !rest[i + 1] || options[rest[i]]) {
      throw new Error('ensure-login <alias> --url <protected-url> --authenticated-selector <css> --login-selector <css>');
    }
    options[rest[i]] = rest[i + 1];
  }
  if (!alias || !options['--url'] || !options['--authenticated-selector'] || !options['--login-selector']) throw new Error('ensure-login requires an alias, protected URL and both selectors.');
  const url = new URL(options['--url']);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without embedded credentials.');
  return { alias, url: url.href, authenticatedSelector: options['--authenticated-selector'], loginSelector: options['--login-selector'] };
}

// Only navigation, inspection and one login submission. Never replay the business action.
export async function ensureLogin(run, { alias, url, authenticatedSelector, loginSelector }) {
  const { profile } = await run(['auth', 'show', alias]);
  const origin = new URL(profile.url).origin;
  if (new URL(url).origin !== origin) throw new Error('Recovery URL must have the saved credential origin. Use the official manual workflow for cross-origin SSO.');
  await run(['open', url]);
  async function visible(selector) {
    // Native `is visible` errors on a missing element; absence is a normal login indicator.
    const { count } = await run(['get', 'count', selector]);
    if (count === 0) return false;
    if (count !== 1) return null;
    const result = await run(['is', 'visible', selector]);
    if (!result.origin || new URL(result.origin).origin !== origin) return null;
    return result.visible;
  }
  async function inspect() {
    const current = await run(['get', 'url']);
    if (new URL(current.url).origin !== origin) return 'unknown';
    const loggedIn = await visible(authenticatedSelector);
    const login = await visible(loginSelector);
    if (loggedIn === true && login === false) return 'authenticated';
    if (login === true && loggedIn === false) return 'login';
    return 'unknown';
  }
  const before = await inspect();
  if (before === 'authenticated') return { status: 'authenticated', loginAttempts: 0, resumedUrl: url };
  if (before !== 'login') return { status: 'manual_intervention_required', loginAttempts: 0, reason: 'Neither a confirmed signed-in page nor an unambiguous login page.' };
  await run(['auth', 'login', alias]);
  // A successful submission is not proof that the account is signed in (MFA/CAPTCHA/bad password).
  try { await run(['wait', authenticatedSelector, '--timeout', '10000']); }
  catch { return { status: 'manual_intervention_required', loginAttempts: 1, reason: 'Login requires attention; no automatic retry.' }; }
  if (await inspect() !== 'authenticated') return { status: 'manual_intervention_required', loginAttempts: 1, reason: 'Login could not be verified.' };
  await run(['open', url]);
  if (await inspect() !== 'authenticated') return { status: 'manual_intervention_required', loginAttempts: 1, reason: 'Protected destination did not retain authentication.' };
  return { status: 'authenticated', loginAttempts: 1, resumedUrl: url };
}
