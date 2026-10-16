// Synthetic ingress only; exercises the real host, router and isolated adapter.
import { writeFileSync } from 'node:fs';
import production, { registerReinDiscord } from '../../plugins/rein-discord/index.ts';
import { createIsolatedReceiver } from '../../plugins/rein-discord/inbound.mjs';

export default {
  ...production,
  register(api) {
    const testApi = new Proxy(api, { get(target, property) {
      if (property !== 'registerChannel') return Reflect.get(target, property);
      return channel => target.registerChannel({ ...channel, config: { ...channel.config, isConfigured: () => true } });
    } });
    registerReinDiscord(testApi, async ({ config, cfg, runtime, memory, turns, sessionStore, signal }) => {
      const sent = [];
      const receive = createIsolatedReceiver({ config, cfg, runtime, memory, turns, sessionStore, signal,
        send: async (...args) => { sent.push(args); } });
      const commands = [
        'CASE_AUTO What is a semaphore?',
        '/model claude', 'CASE_CLAUDE Summarize this resource.',
        '/model openai', 'CASE_OPENAI Explain a transaction.',
        '/model bailian', 'CASE_BAILIAN Implement this function.',
        '/model google', 'CASE_GOOGLE What is a queue?',
        '/model auto', 'CASE_CODE Implement a concurrent queue.',
        'CASE_AUTH_FALLBACK Summarize a resource after upstream sign-in expiry.',
        'CASE_FALLBACK What is a mutex?',
      ];
      if (!process.env.REIN_ROUTER_ACTUAL_MAGPIE) commands.push('CASE_GATEWAY_KEY What is a lock?');
      try {
        for (const [index, text] of commands.entries()) await receive({
          guildId: '100000000000000001', channelId: '100000000000000002', kind: 'channel',
          senderId: '100000000000000003', id: String(100000000000000010n + BigInt(index)), text,
        });
        writeFileSync(process.env.REIN_ROUTER_EVIDENCE_PATH, JSON.stringify({ sent }));
      } catch (error) {
        writeFileSync(process.env.REIN_ROUTER_EVIDENCE_PATH, JSON.stringify({ error: String(error), sent }));
      } finally { memory.close(); }
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    });
  },
};
