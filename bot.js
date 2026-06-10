const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Register slash commands
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('catchup')
      .setDescription('Get an AI summary of recent messages in this channel')
      .addIntegerOption(option =>
        option
          .setName('messages')
          .setDescription('How many messages to summarize (default: 50, max: 200)')
          .setRequired(false)
          .setMinValue(10)
          .setMaxValue(200)
      ),
  ].map(cmd => cmd.toJSON());

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

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'catchup') return;

  // Defer ephemerally so only the user sees the response
  await interaction.deferReply({ ephemeral: true });

  const messageCount = interaction.options.getInteger('messages') || 50;

  try {
    // Fetch messages from the channel
    const messages = await interaction.channel.messages.fetch({ limit: messageCount });

    if (messages.size === 0) {
      return interaction.editReply('No messages found in this channel.');
    }

    // Format messages oldest-first, skip bot messages
    const formatted = messages
      .filter(m => !m.author.bot)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(m => `${m.author.displayName}: ${m.content}`)
      .filter(line => line.trim().length > 0)
      .join('\n');

    if (!formatted) {
      return interaction.editReply('No readable messages found to summarize.');
    }

    // Ask Claude for a summary
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Summarize the following Discord conversation concisely. Pull out the key topics, decisions, and anything actionable. Keep it punchy — bullet points are fine. Don't include fluff.\n\n${formatted}`,
        },
      ],
    });

    const summary = response.content[0].text;

    // Split if over Discord's 2000 char limit
    if (summary.length <= 1900) {
      await interaction.editReply(`**Catch-up summary (last ${messageCount} messages):**\n\n${summary}`);
    } else {
      const chunks = summary.match(/.{1,1900}/gs) || [];
      await interaction.editReply(`**Catch-up summary (last ${messageCount} messages):**\n\n${chunks[0]}`);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i], ephemeral: true });
      }
    }
  } catch (err) {
    console.error('Error handling /catchup:', err);
    await interaction.editReply('Something went wrong. Check the bot logs.');
  }
});

client.login(DISCORD_TOKEN);
