const { getConfig, getCustomCommand, getCommandChannels } = require('../database/db');
const { handleXP } = require('../systems/leveling');
const { handleAutomod } = require('../systems/automod');

async function safeReply(message, options) {
  try {
    return await message.reply({ ...options, failIfNotExist: false });
  } catch (err) {
    return message.channel.send(options).catch(() => {});
  }
}

module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    if (message.author.bot || !message.guild) return;

    handleAutomod(message, client).catch(err => console.error("Automod Error:", err));
    handleXP(message, client).catch(err => console.error("XP Error:", err));

    const prefix = await getConfig(message.guild.id, 'prefix') || process.env.DEFAULT_PREFIX || '!';
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    const command = client.commands.get(commandName);

    if (command) {
      const [allowedChannels, modRoleId] = await Promise.all([
        getCommandChannels(message.guild.id),
        getConfig(message.guild.id, 'mod_role')
      ]);

      if (allowedChannels.length > 0 && !allowedChannels.includes(message.channel.id)) {
        const isMod = message.member.roles.cache.has(modRoleId) || message.member.permissions.has(8n);
        if (!isMod) {
          const msg = await safeReply(message, { content: `⚠️ Commands can only be used in: ${allowedChannels.map(id => `<#${id}>`).join(', ')}`, allowedMentions: { repliedUser: false } });
          setTimeout(() => { message.delete().catch(() => {}); msg?.delete().catch(() => {}); }, 5000);
          return;
        }
      }

      if (command.modOnly) {
        const isMod = message.member.roles.cache.has(modRoleId) || message.member.permissions.has(8n);
        if (!isMod) return safeReply(message, { content: '❌ You need the **Moderator** role to use this command.', allowedMentions: { repliedUser: false } });
      }

      if (!client.cooldowns.has(commandName)) client.cooldowns.set(commandName, new Map());
      const timestamps = client.cooldowns.get(commandName);
      const cooldown = (command.cooldown || 3) * 1000;
      if (timestamps.has(message.author.id)) {
        const expiry = timestamps.get(message.author.id) + cooldown;
        if (Date.now() < expiry) return;
      }
      timestamps.set(message.author.id, Date.now());
      setTimeout(() => timestamps.delete(message.author.id), cooldown);

      try {
        await command.execute(message, args, client, prefix);
      } catch (err) {
        console.error(err);
        safeReply(message, { content: '❌ An error occurred.', allowedMentions: { repliedUser: false } });
      }
      return;
    }


    const custom = await getCustomCommand(message.guild.id, commandName);
    if (custom) {


      if (custom.cooldown && custom.cooldown > 0) {
        if (!client.customCmdCooldowns) client.customCmdCooldowns = new Map();

        const cooldownKey = `${message.guild.id}-${message.author.id}-${commandName}`;
        const now = Date.now();
        const cooldownEnd = client.customCmdCooldowns.get(cooldownKey) || 0;

        if (now < cooldownEnd) {
          const timeLeft = Math.ceil((cooldownEnd - now) / 1000);
          const msg = await safeReply(message, {
            content: `⏳ Take a breath! You can use \`${prefix}${commandName}\` again in **${timeLeft}s**.`,
            allowedMentions: { repliedUser: false }
          });

          setTimeout(() => { message.delete().catch(() => {}); msg?.delete().catch(() => {}); }, 5000);
          return;
        }


        client.customCmdCooldowns.set(cooldownKey, now + (custom.cooldown * 1000));
      }


      if (custom.allowed_roles !== undefined && custom.allowed_roles !== null && custom.allowed_roles !== '') {
        let allowedRoles = [];

        if (Array.isArray(custom.allowed_roles)) {
          allowedRoles = custom.allowed_roles.map(id => String(id).trim());
        } else if (typeof custom.allowed_roles === 'string') {
          try {
            const parsed = JSON.parse(custom.allowed_roles);
            allowedRoles = Array.isArray(parsed) ? parsed.map(id => String(id).trim()) : [String(parsed).trim()];
          } catch {
            allowedRoles = custom.allowed_roles.split(',').map(id => id.trim());
          }
        } else {
          allowedRoles = [String(custom.allowed_roles).trim()];
        }

        allowedRoles = allowedRoles.filter(id => id.length > 0);

        if (allowedRoles.length > 0) {
          const hasRole = message.member.roles.cache.some(role => allowedRoles.includes(String(role.id)));
          const isAdmin = message.member.permissions.has(8n);

          if (!hasRole && !isAdmin) {
            const noPermMsg = await safeReply(message, {
              content: '❌ You do not have the required role to use this custom command.',
              allowedMentions: { repliedUser: false }
            });
            setTimeout(() => { message.delete().catch(() => {}); noPermMsg?.delete().catch(() => {}); }, 5000);
            return;
          }
        }
      }

      let savedResponse = custom.response;


      const target = message.mentions.users.first();
      if (savedResponse.includes('{target}') && !target) {
        return safeReply(message, {
          content: `⚠️ This command requires you to tag a user! Example: \`${prefix}${commandName} @user\``,
          allowedMentions: { repliedUser: false }
        });
      }


      let chosenResponse = savedResponse;
      if (savedResponse.includes('|')) {
        const rawOptions = savedResponse.split('|').map(opt => opt.trim()).filter(Boolean);

        const parsedOptions = rawOptions.map(opt => {
          const match = opt.match(/^\[(\d+)%?\]\s*(.*)$/);
          if (match) {
            return { weight: parseInt(match[1], 10), text: match[2] };
          }
          return { weight: null, text: opt };
        });

        const hasWeights = parsedOptions.some(o => o.weight !== null);

        if (hasWeights) {
          let totalWeight = 0;
          const normalizedOptions = parsedOptions.map(o => {
            const w = o.weight !== null ? o.weight : 10;
            totalWeight += w;
            return { weight: w, text: o.text };
          });

          let randomRoll = Math.random() * totalWeight;
          for (const option of normalizedOptions) {
            if (randomRoll < option.weight) {
              chosenResponse = option.text;
              break;
            }
            randomRoll -= option.weight;
          }
        } else {
          chosenResponse = parsedOptions[Math.floor(Math.random() * parsedOptions.length)].text;
        }
      }


      chosenResponse = chosenResponse.replace(/{random:(\d+)-(\d+)}/g, (match, min, max) => {
        const low = parseInt(min, 10);
        const high = parseInt(max, 10);
        return Math.floor(Math.random() * (high - low + 1)) + low;
      });


      let finalResponse = chosenResponse
          .replace(/{author}/g, message.author.toString())
          .replace(/{user}/g, message.author.toString())
          .replace(/{target}/g, target ? target.toString() : '');


      const allowedMentions = { parse: ['users', 'roles'] };

      if (finalResponse.includes('{ping:everyone}')) {
        finalResponse = finalResponse.replace(/{ping:everyone}/g, '@everyone');
        allowedMentions.parse.push('everyone');
      }

      if (finalResponse.includes('{ping:here}')) {
        finalResponse = finalResponse.replace(/{ping:here}/g, '@here');
        allowedMentions.parse.push('everyone');
      }

      let reactionsToAdd = [];
      finalResponse = finalResponse.replace(/{react:(.*?)}/g, (match, emojis) => {
        reactionsToAdd = emojis.split(',').map(e => e.trim()).filter(Boolean);
        return '';
      });


      if (finalResponse.trim().length > 0) {
        const sentMsg = await message.channel.send({
          content: finalResponse,
          allowedMentions: allowedMentions
        }).catch(() => {});

        if (sentMsg && reactionsToAdd.length > 0) {
          for (const emoji of reactionsToAdd) {
            await sentMsg.react(emoji).catch(() => {});
          }
        }
      }
    }
  }
};