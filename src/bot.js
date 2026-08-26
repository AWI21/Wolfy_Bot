const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');
const { initDatabase } = require('./database/db');
const { startBirthdayChecker } = require('./systems/birthday');
const { startNotificationPoller } = require('./systems/notifications');
const { startXPFlusher } = require('./systems/leveling');
const chalk = require('chalk');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

client.commands = new Collection();
client.cooldowns = new Collection();
client.xpCooldowns = new Collection();

async function startBot() {
  const botName = process.env.BOT_NAME || 'Wolfy Bot';
  console.log(chalk.cyan(`\nStarting ${botName}...\n`));

  await initDatabase();
  await loadCommands(client);
  loadEvents(client);

  // Fixed: Event name is 'ready', not 'clientReady'
  client.once('ready', () => {
    startBirthdayChecker(client);
    startNotificationPoller(client);
    startXPFlusher();
  });

  // Fixed: Using DISCORD_TOKEN to match your .env variable
  await client.login(process.env.DISCORD_TOKEN);

  return client;
}

module.exports = { startBot, client };