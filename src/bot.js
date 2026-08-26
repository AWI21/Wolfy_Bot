const { Client, GatewayIntentBits, Partials, Collection, Events } = require('discord.js');
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

client.on('error', (err) => {
  console.error(chalk.red('❌ Discord client error:'), err);
});

client.on('shardError', (err, shardId) => {
  console.error(chalk.red(`❌ Shard ${shardId} error:`), err);
});

client.on('shardDisconnect', (event, shardId) => {
  console.warn(chalk.yellow(`⚠️ Shard ${shardId} disconnected (code ${event?.code}).`));
});

client.on('shardReconnecting', (shardId) => {
  console.warn(chalk.yellow(`⏳ Shard ${shardId} reconnecting...`));
});

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function startBot() {
  const botName = process.env.BOT_NAME || 'Wolfy Bot';
  console.log(chalk.cyan(`\nStarting ${botName}...\n`));

  await initDatabase();
  await loadCommands(client);
  loadEvents(client);

  let becameReady = false;
  const onReady = () => {
    if (becameReady) return;
    becameReady = true;
    console.log(chalk.green(`✅ Logged in as ${client.user.tag} — serving ${client.guilds.cache.size} guild(s)`));
    startBirthdayChecker(client);
    startNotificationPoller(client);
    startXPFlusher();
  };

  // Listen for both names: discord.js v14 still fires the deprecated 'ready'
  // alongside 'clientReady', and v15 will only fire 'clientReady'. Either one
  // triggers startup exactly once thanks to the becameReady guard above.
  client.once(Events.ClientReady, onReady);
  client.once('ready', onReady);

  console.log(chalk.blue('🔌 Connecting to Discord gateway...'));

  try {
    await withTimeout(client.login(process.env.DISCORD_TOKEN), 20_000, 'client.login()');
  } catch (err) {
    console.error(chalk.red('❌ client.login() did not complete:'), err.message);
    console.error(chalk.red('   This usually means an invalid/regenerated token, missing Privileged Gateway Intents in the Developer Portal, or the same token already being used by another running instance.'));
    throw err;
  }

  console.log(chalk.blue('🔌 login() resolved — waiting for the ready event...'));

  setTimeout(() => {
    if (!becameReady) {
      console.error(chalk.red('❌ login() succeeded but no ready/clientReady event arrived within 30s.'));
      console.error(chalk.red('   The gateway handshake likely stalled after auth — check Privileged Gateway Intents for this specific application, and confirm no other process is using this token.'));
    }
  }, 30_000);

  return client;
}

module.exports = { startBot, client };