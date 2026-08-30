const config = require('../../config.js');
const { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { addCustomCommand, removeCustomCommand, getAllCustomCommands } = require('../../database/db');
const { successEmbed, errorEmbed, requirePerms } = require('../../utils/helpers');

function parseCooldown(str) {
  if (!str) return 0;
  const match = str.match(/^(\d+)([smh])?$/i);
  if (!match) return 0;
  const val = parseInt(match[1], 10);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'm') return val * 60;
  if (unit === 'h') return val * 3600;
  return val;
}

module.exports = {
  name: 'customcmd',
  aliases: ['cc', 'addcmd'],

  slashData: new SlashCommandBuilder()
      .setName('customcmd').setDescription('Manage custom commands')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand(s => s.setName('add').setDescription('Add a custom command')
          .addStringOption(o => o.setName('trigger').setDescription('Trigger word').setRequired(true))
          .addStringOption(o => o.setName('response').setDescription('Response ({author}, {target}, {random:1-100}, {give_xp:50})').setRequired(true))
          .addIntegerOption(o => o.setName('cooldown').setDescription('Cooldown in seconds (e.g. 30)').setRequired(false))
          .addRoleOption(o => o.setName('role').setDescription('Optional: Role required to use this command')))
      .addSubcommand(s => s.setName('remove').setDescription('Remove a command')
          .addStringOption(o => o.setName('trigger').setDescription('Trigger to remove').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List all custom commands')),

  async execute(message, args, client, prefix) {
    if (!requirePerms(message, PermissionFlagsBits.ManageGuild)) return;
    const sub = args[0]?.toLowerCase();

    if (sub === 'add') {
      const trigger = args[1];
      let cooldown = 0;
      let responseStartIndex = 2;

      if (args[2] && /^(\d+)([smh])?$/i.test(args[2])) {
        cooldown = parseCooldown(args[2]);
        responseStartIndex = 3;
      }

      const allowedRoles = message.mentions.roles.map(r => r.id);

      let response = args.slice(responseStartIndex).join(' ').replace(/<@&\d+>/g, '').trim();

      if (!trigger || !response) {
        const guideText = [
          `⚠️ **Usage:** \`${prefix}customcmd add <trigger> [cooldown] <response> [@role]\``,
          `\n⏱️ **Cooldown Examples:** \`10s\` (10 sec), \`1m\` (1 min), \`5m\` (5 min)`,
          `\n✨ **Dynamic Placeholders:**`,
          `• \`{author}\` — Mentions the person running the command.`,
          `• \`{target}\` — Mentions the tagged user. *(Requires a ping when executed!)*`,
          `• \`{random:min-max}\` — Rolls a random number *(e.g. \`{random:1-100}\`)*.`,
          `• \`{give_xp:amount}\` — Awards XP *(e.g. \`{give_xp:50}\` or \`{give_xp:10-50}\`)*.`,
          `\n🔥 **Advanced Features & Tags:**`,
          `• \`opt1 | opt2\` — Randomly selects one response.`,
          `• \`[X%] response\` — Sets percentage odds *(e.g. \`[10%] Win | [90%] Loss\`)*.`,
          `• \`{ping:everyone}\` / \`{ping:here}\` — Safely pings @everyone or @here.`,
          `• \`{react:👍,👎}\` — Auto-adds emoji reactions to the bot message.`,
          `\n*Example: \`${prefix}customcmd add daily 24h {author} claimed daily bonus and got {give_xp:100}!\`*`
        ].join('\n');

        return message.reply({ embeds: [errorEmbed(guideText)] });
      }

      await addCustomCommand(message.guild.id, trigger, response, allowedRoles, cooldown);
      return message.reply({ embeds: [successEmbed(`Custom command \`${prefix}${trigger}\` created!${cooldown ? ` ⏱️ **${cooldown}s** cooldown.` : ''}${allowedRoles.length ? ` (Restricted to roles)` : ''}`)] });
    }

    if (sub === 'remove' || sub === 'delete') {
      const trigger = args[1];
      if (!trigger) return message.reply({ embeds: [errorEmbed(`Usage: \`${prefix}customcmd remove <trigger>\``)] });
      const result = await removeCustomCommand(message.guild.id, trigger);
      if (result.changes === 0) return message.reply({ embeds: [errorEmbed(`Command not found.`)] });
      return message.reply({ embeds: [successEmbed(`Command \`${prefix}${trigger}\` removed.`)] });
    }

    return message.reply({ embeds: [await buildListEmbed(message.guild, prefix)] });
  },

  async executeSlash(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const trigger = interaction.options.getString('trigger');
      const response = interaction.options.getString('response');
      const cooldown = interaction.options.getInteger('cooldown') || 0;
      const role = interaction.options.getRole('role');

      const roles = role ? [role.id] : [];

      await addCustomCommand(interaction.guild.id, trigger, response, roles, cooldown);
      return interaction.editReply({ embeds: [successEmbed(`Custom command \`!${trigger}\` created!${cooldown ? ` ⏱️ **${cooldown}s** cooldown.` : ''}${role ? ` (Role: ${role.name})` : ''}`)] });
    }

    if (sub === 'remove') {
      const trigger = interaction.options.getString('trigger');
      const result = await removeCustomCommand(interaction.guild.id, trigger);
      if (result.changes === 0) return interaction.editReply({ embeds: [errorEmbed(`Command not found.`)] });
      return interaction.editReply({ embeds: [successEmbed(`Command \`!${trigger}\` removed.`)] });
    }

    return interaction.editReply({ embeds: [await buildListEmbed(interaction.guild, '!')] });
  },
};

async function buildListEmbed(guild, prefix) {
  const cmds = await getAllCustomCommands(guild.id);
  return new EmbedBuilder().setColor(config.color).setTitle(`🔧 Custom Commands (${cmds.length})`)
      .setDescription(cmds.length ? cmds.map(c => `\`${prefix}${c.trigger}\` ${c.cooldown ? `⏱️${c.cooldown}s ` : ''}${c.allowed_roles ? '🔒' : ''} → ${c.response.substring(0, 45)}...`).join('\n') : 'No custom commands yet.');
}