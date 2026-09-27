#!/usr/bin/env node
// Local Slack MVP test CLI.
//
// Commands:
//   whoami                     verify all five user tokens and print their identities
//   send --case <key> --text <text> [--account <id>] [--channel <id>] [--dry-run]
//                              post one message as a real user, with the required mention
//
// Credentials come from the environment or a gitignored local file; token values are never printed.
// Sending is limited to the two approved test channels. This harness never posts to production data.
import {
  HarnessError,
  SLACK_TEST_CHANNELS,
  SLACK_TEST_IDENTITIES,
  caseLabel,
  assertAllowedChannel,
  assertCaseKey,
  assertAllTokensFresh,
  assertTokenFresh,
  clientMsgIdDuplicateNotice,
  clientMsgIdForKey,
  describeTokenStore,
  formatIdentity,
  hasMention,
  idempotencyKey,
  ledgerEntryKey,
  loadUserTokens,
  lookupLedger,
  mentionText,
  permalinkFrom,
  readRunLedger,
  redactTokens,
  repoRoot,
  slackApi,
  verifyAllIdentities,
  verifyIdentity,
} from './slack-test-lib.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const DEFAULT_ACCOUNT = 'lead';
const EXIT_USAGE = 2;
const EXIT_FAILED = 1;

/** Gitignored local ledger of cases already sent, used to skip a repeated run. */
const DEFAULT_LEDGER_PATH = resolve(repoRoot, 'runtime/slack-test-runs.json');

/**
 * Record a completed send in the local ledger with an atomic replace, so a crash cannot leave a
 * half-written file. Only non-secret metadata (case key, ts, permalink, timestamps) is stored.
 */
function recordLedger(path, entries) {
  const current = readRunLedger(path);
  const next = { ...current, ...entries };
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    if (existsSync(temp)) rmSync(temp, { force: true });
    console.log(`Notice: could not update the local run ledger (${redactTokens(error?.message ?? error)}).`);
  }
}

const USAGE = `Rein Slack test harness (local, user tokens only)

Usage:
  node scripts/slack-test-cli.mjs whoami [--file <path>]
  node scripts/slack-test-cli.mjs tokens [--file <path>]
  node scripts/slack-test-cli.mjs send --case <key> --text <text> [--account <id>] [--channel <id>] [--dry-run] [--allow-default-text] [--file <path>]

Accounts:
${SLACK_TEST_IDENTITIES.map(i => `  ${i.id.padEnd(7)} expects ${i.expectedUserId}  (${i.env})`).join('\n')}

Channels:
${SLACK_TEST_CHANNELS.map(c => `  ${c.id}  ${c.label}`).join('\n')}

Tokens are read from the environment or from a gitignored local file:
  secrets/slack-test-tokens.json   (JSON keys such as REIN_SLACK_USER_TOKEN_LEAD)
  runtime/slack-test-tokens.json   (written by scripts/slack-test-oauth.mjs)
  .env.slack-test.local            (KEY=value lines)

Every token must be a user OAuth token (xoxp-); bot and app tokens are refused. Each token is
checked with auth.test and must resolve to the expected user in the test workspace. Sending uses
--account (default: ${DEFAULT_ACCOUNT}) and only the two channels above are permitted. A token that
is expired, expiring within 120s, or flagged as needing reauthorization is refused before sending.

send requires an explicit --text body; pass --allow-default-text only when a placeholder message is
intended. Repeat protection comes from the local run ledger at runtime/slack-test-runs.json, and the
derived UUID travels as the documented client_msg_id.`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, flags: new Map(), positional: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
  if (arg === '--dry-run' || arg === '-n') {
      options.flags.set('dry-run', true);
      continue;
    }
    if (arg === '--allow-default-text') {
      options.flags.set('allow-default-text', true);
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        options.flags.set(name, true);
        continue;
      }
      options.flags.set(name, value);
      index += 1;
      continue;
    }
    options.positional.push(arg);
  }
  return options;
}

const flag = (options, name) => {
  const value = options.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

function resolveAccountId(value) {
  const id = (value ?? DEFAULT_ACCOUNT).trim();
  const identity = SLACK_TEST_IDENTITIES.find(item => item.id === id);
  if (!identity) {
    throw new HarnessError(
      'unknown-account',
      `account ${id || '<none>'} is not one of: ${SLACK_TEST_IDENTITIES.map(i => i.id).join(', ')}`,
    );
  }
  return identity;
}

async function loadVerified(paths) {
  const { tokens, meta } = loadUserTokens(paths === undefined ? {} : { paths });
  const verified = await verifyAllIdentities(tokens, {});
  return { tokens, meta, verified };
}

const filePaths = options => (flag(options, 'file') ? [flag(options, 'file')] : undefined);

async function commandWhoami(options) {
  const { verified } = await loadVerified(filePaths(options));
  console.log('Identities verified (user OAuth tokens, no bot identities):');
  for (const identity of SLACK_TEST_IDENTITIES) {
    const account = verified.get(identity.id);
    console.log(`  ${formatIdentity(account)}  ${account.user}`);
  }
  const lead = verified.get(DEFAULT_ACCOUNT);
  console.log(`Sender: ${formatIdentity(lead)} (${DEFAULT_ACCOUNT})`);
  return 0;
}

async function commandTokens(options) {
  const { tokens, meta } = loadUserTokens(filePaths(options) === undefined ? {} : { paths: filePaths(options) });
  console.log('Token store (values are never printed):');
  for (const row of describeTokenStore(tokens, meta)) {
    const rotation = [
      row.expiresAt ? `expires=${row.expiresAt}` : 'expires=unknown',
      `refreshTokenRecorded=${row.refreshTokenRecorded}`,
      `refreshTokenRequired=${row.refreshTokenRequired}`,
    ].join(' ');
    console.log(`  ${row.id.padEnd(7)} present=${String(row.present).padEnd(5)} usable=${String(row.usable).padEnd(5)} ${row.reason} ${rotation}`);
  }
  return 0;
}

/**
 * Send one test message as a verified user. Injectable for tests: `tokens`, `meta` and `fetchImpl`
 * can be supplied directly, and in that case `tokens` is only used for the sending account.
 */
export async function runSend(
  {
    accountId = DEFAULT_ACCOUNT,
    channelId,
    caseKey,
    text: rawText,
    dryRun = false,
    /** The placeholder body is opt-in; a real send needs explicit text unless this is set. */
    allowDefaultText = false,
  } = {},
  { tokens, meta = {}, fetchImpl = globalThis.fetch, ledger, ledgerPath, skipIfSent = true } = {},
) {
  assertCaseKey(caseKey);
  const identity = resolveAccountId(accountId);
  const channel = assertAllowedChannel(channelId ?? SLACK_TEST_CHANNELS[0].id);

  const providedText = typeof rawText === 'string' ? rawText.trim() : '';
  if (!providedText && !allowDefaultText) {
    throw new HarnessError(
      'text-required',
      [
        'send requires an explicit --text body, or --allow-default-text for the placeholder message.',
        'Refusing to post a generic message to a test channel by default.',
      ].join('\n'),
    );
  }

  const baseText = providedText || `Rein Slack MVP test message for case ${caseKey}.`;
  const text = hasMention(baseText) ? baseText : mentionText(baseText);
  const dedupeKey = idempotencyKey(caseKey, identity.id, channel.id);
  const clientMsgId = await clientMsgIdForKey(dedupeKey);

  // Local ledger is the authority for repeat protection; Slack's client-side identity is only a hint.
  const localLedger = ledger ?? readRunLedger(ledgerPath ?? DEFAULT_LEDGER_PATH);
  const prior = skipIfSent ? lookupLedger(localLedger, caseKey, identity.id, channel.id) : null;
  if (prior && !dryRun) {
    console.log(`Case ${caseKey} already ran for ${identity.id} in ${channel.id} at ${prior.sentAt}; skipping.`);
    console.log(`ts: ${prior.ts ?? '<none>'}`);
    console.log(`permalink: ${prior.permalink ?? '<none>'}`);
    return 0;
  }

  let store = tokens;
  if (!store) store = loadUserTokens({}).tokens;

  // Fail closed before any Slack call when a token is stale or flagged for reauthorization, so an
  // expired token is never presented to the API even for a read-only auth.test.
  assertAllTokensFresh(meta);
  assertTokenFresh(meta, identity.id);

  const account = await verifyIdentity(identity, store.get(identity.id), { fetchImpl });

  console.log(`Verified ${formatIdentity(account)} (${account.user})`);
  console.log(`Channel: ${channel.id} (${channel.label})`);
  console.log(`Case: ${caseKey}`);
  console.log(`Case label: ${caseLabel(caseKey, identity.id)}`);
  console.log(`Idempotency key: ${dedupeKey}`);
  console.log(`client_msg_id: ${clientMsgId}`);
  console.log(`Mention: <@${text.match(/<@([A-Z0-9]+)>/)?.[1] ?? ''}>`);
  console.log(
    `Token expiry: ${describeTokenStore(store, meta).find(row => row.id === identity.id)?.expiresAt ?? 'unknown'}`,
  );

  if (dryRun) {
    console.log('Dry run: no message sent.');
    console.log(`Message body: ${redactTokens(text)}`);
    return 0;
  }

  const response = await slackApi(
    'chat.postMessage',
    store.get(identity.id),
    {
      channel: channel.id,
      text,
      client_msg_id: clientMsgId,
      unfurl_links: false,
      unfurl_media: false,
    },
    { fetchImpl },
  );

  if (response.payload?.ok !== true) {
    const reason = redactTokens(response.payload?.error ?? 'unknown_error');
    throw new HarnessError('post-failed', `chat.postMessage refused to send (${reason})`);
  }

  if (clientMsgIdDuplicateNotice(response)) {
    console.log('Notice: Slack matched this client_msg_id to an existing message.');
  }

  const permalink = permalinkFrom(response);
  recordLedger(ledgerPath ?? DEFAULT_LEDGER_PATH, {
    [ledgerEntryKey(caseKey, identity.id, channel.id)]: {
      ts: response.payload.ts ?? null,
      channel: response.payload.channel ?? channel.id,
      permalink,
      sentAt: new Date().toISOString(),
      account: identity.id,
      userId: account.userId,
      clientMsgId,
    },
  });
  console.log(`Sent as ${account.user} <@${account.userId}>`);
  console.log(`ts: ${response.payload.ts ?? '<none>'}`);
  console.log(`channel: ${response.payload.channel ?? channel.id}`);
  console.log(`permalink: ${permalink ?? '<none returned>'}`);
  return 0;
}

async function commandSend(options) {
  const caseKey = flag(options, 'case');
  if (!caseKey) throw new HarnessError('usage', 'send requires --case <key>');
  const { tokens, meta } = loadUserTokens(filePaths(options) === undefined ? {} : { paths: filePaths(options) });
  return runSend(
    {
      accountId: flag(options, 'account') ?? DEFAULT_ACCOUNT,
      channelId: flag(options, 'channel'),
      caseKey,
      text: flag(options, 'text'),
      dryRun: options.flags.get('dry-run') === true,
      allowDefaultText: options.flags.get('allow-default-text') === true,
    },
    { tokens, meta },
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command || options.command === 'help' || options.flags.get('help') === true) {
    console.log(USAGE);
    return options.command ? 0 : EXIT_USAGE;
  }
  if (options.command === 'whoami') return commandWhoami(options);
  if (options.command === 'tokens') return commandTokens(options);
  if (options.command === 'send') return commandSend(options);
  throw new HarnessError('usage', `unknown command ${options.command}`);
}

// Only run when invoked as a program; importing this file for tests must have no side effects.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main()
    .then(code => {
      process.exitCode = code ?? 0;
    })
    .catch(error => {
      if (error instanceof HarnessError) {
        console.error(redactTokens(error.message));
        if (error.code === 'usage') console.error(`\n${USAGE}`);
      } else {
        console.error(redactTokens(error?.stack ?? error));
      }
      process.exitCode = EXIT_FAILED;
    });
}
