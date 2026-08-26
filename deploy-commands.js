require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

async function deployCommands() {
  const commands = [];
  const commandsPath = path.join(__dirname, 'src', 'commands');

  console.log('🔍 Scanning for commands in:', commandsPath);

  if (!fs.existsSync(commandsPath)) {
    console.error('❌ Error: src/commands folder not found!');
    return;
  }

  for (const category of fs.readdirSync(commandsPath)) {
    const categoryPath = path.join(commandsPath, category);
    if (!fs.statSync(categoryPath).isDirectory()) continue;

    const commandFiles = fs.readdirSync(categoryPath).filter(f => f.endsWith('.js'));

    for (const file of commandFiles) {
      const filePath = path.join(categoryPath, file);
      const cmd = require(filePath);

      if (cmd.slashData) {
        console.log(`  -> Found Slash Command: ${cmd.name || file}`);
        commands.push(cmd.slashData.toJSON());
      } else {
        console.log(`  -> Skipping: ${file} (No slashData found)`);
      }
    }
  }

  const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!token || !clientId) {
    console.error('❌ Missing credentials! Ensure DISCORD_TOKEN/BOT_TOKEN and CLIENT_ID are set.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token);

  console.log(`\n🔄 Registering ${commands.length} slash commands...`);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(
          Routes.applicationGuildCommands(clientId, process.env.GUILD_ID),
          { body: commands, signal: AbortSignal.timeout(15_000) },
      );
      console.log(`✅ Successfully registered ${commands.length} GUILD slash commands.`);
    } else {
      await rest.put(
          Routes.applicationCommands(clientId),
          { body: commands, signal: AbortSignal.timeout(15_000) },
      );
      console.log(`✅ Successfully registered ${commands.length} GLOBAL slash commands.`);
    }
  } catch (err) {
    console.error('❌ Discord API Error during slash command deploy (or it timed out after 15s):');
    console.error(err);
  }
}

module.exports = { deployCommands };