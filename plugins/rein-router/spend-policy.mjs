import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const required = () => new Error('rein_magpie_codex_credit_configuration_required');
const MISSING = Symbol('missing-private-file');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  value === value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const accountKey = value => value.trim().toLowerCase();

async function privateJson(root, path, maxBytes, optional = false) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw required();
  let current = root;
  try {
    for (const part of ['', ...relative(root, dirname(path)).split(sep).filter(Boolean)]) {
      if (part) current = join(current, part);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw required();
    }
  } catch (error) { if (optional && error.code === 'ENOENT') return MISSING; throw required(); }
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw required();
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || (process.platform !== 'win32' && stat.mode & 0o077)) throw required();
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw required();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total)).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return MISSING;
    throw required();
  } finally { await handle?.close(); }
}

/** The pinned native Codex path accepts subscription tokens, never API-key mode. */
function codexIdentity(auth) {
  if (!object(auth) || (auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') ||
      (auth.OPENAI_API_KEY !== undefined && auth.OPENAI_API_KEY !== null && auth.OPENAI_API_KEY !== '') ||
      !object(auth.tokens) || typeof auth.tokens.access_token !== 'string' || !auth.tokens.access_token ||
      auth.tokens.access_token.length > 65536 || typeof auth.tokens.id_token !== 'string' || auth.tokens.id_token.length > 65536)
    throw required();
  const token = auth.tokens.id_token.split('.');
  if (token.length !== 3 || token.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw required();
  const bytes = Buffer.from(token[1], 'base64url');
  if (bytes.length > 16 * 1024) throw required();
  const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const metadata = claims?.['https://api.openai.com/auth'];
  if (!object(claims) || !object(metadata)) throw required();
  const email = name(claims.email);
  const workspace = name(auth.tokens.account_id) ?? name(metadata.chatgpt_account_id);
  if (!email || !workspace) throw required();
  const plan = metadata.chatgpt_plan_type;
  if (plan !== undefined && (typeof plan !== 'string' || plan.length > 128)) throw required();
  const base = ['team', 'business', 'enterprise', 'edu'].includes(plan)
    ? `${email} · ${plan[0].toUpperCase()}${plan.slice(1)}` : email;
  return { email: email.toLowerCase(), workspace, base };
}

const sameIdentity = (left, right) => left.email === right.email && left.workspace === right.workspace;

/**
 * Read-only startup protection against Magpie's default credit spending. This
 * is a local preference audit; cached quotas do not prove zero vendor overage.
 */
export async function assertManagedSpendPolicy({ gateway, routes, allowPaidUsage = false }) {
  try {
    if (!Array.isArray(routes)) throw required();
    if (!routes.some(route => typeof route.gatewayModel === 'string' && /^codex\//i.test(route.gatewayModel)))
      return { codexAccountsChecked: 0 };
    if (allowPaidUsage === true && gateway?.subscriptionOnly === false) return { codexAccountsChecked: 0 };
    const managed = gateway?.managed;
    if (!managed || managed.allowSubscriptionAccounts !== true || !isAbsolute(managed.homeDir) || dirname(managed.homeDir) === managed.homeDir)
      throw required();
    const root = dirname(managed.homeDir);
    const configDir = join(root, 'config/magpie');
    const settings = await privateJson(root, join(configDir, 'settings.json'), 256 * 1024);
    if (!object(settings) || settings.noAccountDiscovery === true || !Array.isArray(settings.codexNoCredits) ||
        settings.codexNoCredits.some(value => !name(value))) throw required();
    const off = new Set(settings.codexNoCredits.map(accountKey));
    const savedFile = await privateJson(root, join(configDir, 'logins.json'), 2 * 1024 * 1024, true);
    const saved = savedFile === MISSING ? [] : savedFile;
    if (!Array.isArray(saved) || saved.length > 512 || saved.some(value => !object(value))) throw required();
    const entries = [], names = new Set();
    for (const login of saved) {
      if (login.agent !== 'codex') continue;
      if (!name(login.user) || names.has(accountKey(login.user)) || !off.has(accountKey(login.user))) throw required();
      names.add(accountKey(login.user));
      entries.push({ user: login.user, identity: codexIdentity(login.auth) });
    }
    const liveFile = await privateJson(root, join(managed.homeDir, '.codex/auth.json'), 256 * 1024, true);
    if (liveFile === MISSING) {
      if (!entries.length) throw required();
      // Policy coverage alone does not establish that the pinned gateway can
      // serve stored-only accounts; the manager separately checks its catalog.
      return { codexAccountsChecked: names.size };
    }
    const live = codexIdentity(liveFile);
    // Mirrors the pinned codexName's existing-name branch. A new workspace
    // colliding with an existing base name would be renamed by Magpie; refuse
    // that unknown generated name instead of guessing its suffix or numbering.
    const taken = entries.some(entry => accountKey(entry.user) === accountKey(live.base) && !sameIdentity(entry.identity, live));
    const existing = entries.find(entry => sameIdentity(entry.identity, live) &&
      (taken || accountKey(entry.user).startsWith(`${accountKey(live.base)} · `)));
    if (taken && !existing) throw required();
    const liveName = existing?.user ?? live.base;
    if (!off.has(accountKey(liveName))) throw required();
    names.add(accountKey(liveName));
    return { codexAccountsChecked: names.size };
  } catch { throw required(); }
}
