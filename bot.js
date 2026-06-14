const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
} = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;

const MODEL = 'claude-sonnet-4-6';
const DISCORD_MAX_LEN = 2000;

// Channel types we'll scan for /catchup-all
const SCANNABLE_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  presence: {
    status: 'invisible',
  },
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ------------------------------------------------------------
// Slash command registration
// ------------------------------------------------------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('catchup')
      .setDescription('Get an AI summary of recent messages in this channel')
      .addIntegerOption((option) =>
        option
          .setName('messages')
          .setDescription('How many messages to summarize (default: 50, max: 200)')
          .setRequired(false)
          .setMinValue(10)
          .setMaxValue(200)
      ),
    new SlashCommandBuilder()
      .setName('catchup-all')
      .setDescription('Get a per-channel overview of recent activity across the server')
      .addIntegerOption((option) =>
        option
          .setName('messages')
          .setDescription('How many recent messages to check per channel (default: 25, max: 50)')
          .setRequired(false)
          .setMinValue(10)
          .setMaxValue(50)
      ),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------

/**
 * Fetches recent messages from a channel, filters out bots and
 * empty messages, and formats them as "Name: content" lines,
 * oldest first. Returns null if there's nothing usable.
 */
async function getFormattedMessages(channel, limit) {
  const messages = await channel.messages.fetch({ limit });

  const lines = messages
    .filter((m) => !m.author.bot)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((m) => {
      const name = m.member?.displayName || m.author.username;
      let content = m.content?.trim();
      if (!content && m.attachments.size > 0) {
        content = '[sent an attachment]';
      }
      return content ? `${name}: ${content}` : null;
    })
    .filter(Boolean);

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Splits text into Discord-safe chunks, breaking on blank lines
 * where possible so channel sections don't get cut mid-summary.
 */
function chunkText(text, maxLen = DISCORD_MAX_LEN) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ------------------------------------------------------------
// Interaction handling
// ------------------------------------------------------------
client.on('interactionCreate', (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'catchup') {
    handleCatchup(interaction);
  } else if (interaction.commandName === 'catchup-all') {
    handleCatchupAll(interaction);
  }
});

// ------------------------------------------------------------
// /catchup - single channel summary
// ------------------------------------------------------------
function handleCatchup(interaction) {
  interaction.deferReply({ ephemeral: true }).then(async () => {
    const messageCount = interaction.options.getInteger('messages') || 50;

    try {
      const formatted = await getFormattedMessages(interaction.channel, messageCount);

      if (!formatted) {
        return interaction.editReply('No readable messages found to summarize.');
      }

      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 600,
        messages: [
          {
            role: 'user',
            content:
              `Here are recent messages from a Discord channel, oldest first. ` +
              `Summarize what's been discussed in a few short paragraphs so someone catching up ` +
              `can quickly understand the conversation. Mention any open questions or things that ` +
              `seem to need a response.\n\n${formatted}`,
          },
        ],
      });

      const summary = response.content[0]?.text || 'Could not generate a summary.';

      const chunks = chunkText(summary);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i], ephemeral: true });
      }
    } catch (err) {
      console.error('Error in /catchup:', err);
      await interaction.editReply('Something went wrong generating the summary.');
    }
  });
}

// ------------------------------------------------------------
// /catchup-all - server-wide, per-channel overview
// ------------------------------------------------------------
function handleCatchupAll(interaction) {
  interaction.deferReply({ ephemeral: true }).then(async () => {
    const perChannelLimit = interaction.options.getInteger('messages') || 25;

    try {
      const guild = interaction.guild;
      if (!guild) {
        return interaction.editReply('This command only works in a server.');
      }

      const me = guild.members.me;
      const channels = guild.channels.cache.filter(
        (c) =>
          SCANNABLE_TYPES.includes(c.type) &&
          c.permissionsFor(me)?.has(['ViewChannel', 'ReadMessageHistory'])
      );

      const sections = [];
      const quietChannels = [];

      for (const channel of channels.values()) {
        try {
          const formatted = await getFormattedMessages(channel, perChannelLimit);
          if (formatted) {
            sections.push(`### #${channel.name}\n${formatted}`);
          } else {
            quietChannels.push(`#${channel.name}`);
          }
        } catch (err) {
          console.warn(`Skipping #${channel.name}: ${err.message}`);
        }
      }

      if (sections.length === 0) {
        return interaction.editReply('No recent activity found in any channel I can read.');
      }

      const prompt =
        `You're briefing a community admin on recent Discord activity so they can decide ` +
        `where to jump in. Below are recent messages from several channels, each under a ` +
        `"### #channel-name" heading.\n\n` +
        `For each channel, write a short briefing (1-3 sentences) covering what's being ` +
        `discussed. If there's a question, request, or open thread that seems to need a ` +
        `reply, say so explicitly \u2014 e.g. "Worth a reply: ...". If nothing needs a reply, ` +
        `don't force it.\n\n` +
        `Format your response with each channel as a bold heading, e.g. **#general**, ` +
        `followed by its briefing. Keep it tight \u2014 this is a scan, not a deep dive. ` +
        `Cover every channel listed below, in the order given.\n\n${sections.join('\n\n')}`;

      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      let summary = response.content[0]?.text || 'Could not generate a summary.';

      if (quietChannels.length > 0) {
        summary += `\n\n_Nothing new in: ${quietChannels.join(', ')}_`;
      }

      const chunks = chunkText(summary);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i], ephemeral: true });
      }
    } catch (err) {
      console.error('Error in /catchup-all:', err);
      await interaction.editReply('Something went wrong generating the server overview.');
    }
  });
}

client.login(DISCORD_TOKEN);
