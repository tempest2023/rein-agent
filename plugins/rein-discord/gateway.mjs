import { Client, GatewayIntentBits, Partials, Events, Options, ChannelType } from 'discord.js';
import { createIsolatedReceiver } from './inbound.mjs';
import { splitDiscordReply } from './reply-chunks.mjs';

export async function startIsolatedDiscord({ config, cfg, runtime, memory, turns, sessionStore, signal, status, log }) {
  const token = process.env[config.tokenEnv];
  if (!token) throw new Error('Configured Discord bot token environment variable is empty');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
    makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
    allowedMentions: { parse: [], repliedUser: false },
  });
  const send = async (channelId, text, messageId) => {
    for (const chunk of splitDiscordReply(text)) {
      if (signal.aborted) throw new Error('Receiver stopped');
      await client.rest.post(`/channels/${channelId}/messages`, { body: {
        content: chunk, allowed_mentions: { parse: [], replied_user: false },
        message_reference: { message_id: messageId, fail_if_not_exists: false },
      } });
    }
  };
  const receive = createIsolatedReceiver({ config, cfg, runtime, memory, turns, sessionStore, send, signal });
  client.on(Events.MessageCreate, message => {
    if (client.user?.id !== config.botUserId) return;
    // Discord's authenticated author/guild/channel, never embed author fields
    // or referenced-message bodies, define the privacy boundary.
    void receive({ id: message.id, senderId: message.author.id, channelId: message.channelId,
      guildId: message.guildId, kind: message.channel.type === ChannelType.DM ? 'direct' : 'channel',
      text: message.content.replace(new RegExp(`<@!?${client.user?.id}>`, 'g'), '').trim(),
      mentioned: message.mentions.users.has(client.user?.id),
      bot: message.author.bot, webhook: Boolean(message.webhookId), timestamp: message.createdTimestamp,
    }).catch(() => log?.warn?.('rein-discord turn failed; private input/error details omitted'));
  });
  client.on(Events.Error, () => log?.warn?.('rein-discord connection error; details omitted'));
  client.once(Events.ClientReady, () => {
    if (client.user?.id === config.botUserId) status({ accountId: 'default', running: true, connected: true, lastError: null });
  });
  const stop = () => { void client.destroy(); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) return;
    await client.login(token);
    if (client.user?.id !== config.botUserId) throw new Error('Bot identity does not match the isolated profile');
    await new Promise(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, { once: true });
    });
  } finally {
    signal.removeEventListener('abort', stop);
    await client.destroy();
    status({ accountId: 'default', running: false, connected: false });
  }
}
