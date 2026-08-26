const { AttachmentBuilder, SlashCommandBuilder } = require('discord.js');
const { getUserRank } = require('../../database/db');
const { generateLevelCard } = require('../../utils/canvas');
const { getRankStats, getEffectiveUserData } = require('../../systems/leveling');

module.exports = {
  name: 'rank',
  aliases: ['level', 'xp'],
  cooldown: 10,
  slashData: new SlashCommandBuilder()
      .setName('rank').setDescription('View your rank card')
      .addUserOption(o => o.setName('user').setDescription('Member to check').setRequired(false)),

  async execute(message, args, client) {
    const target = message.mentions.users.first() || message.author;
    const loading = await message.channel.send('Searching for your stats...');
    const attachment = await _genCard(target, message.guild);
    await loading.delete().catch(() => {});
    if (attachment) {
      await message.reply({ files: [attachment], failIfNotExist: false }).catch(() => message.channel.send({ files: [attachment] }).catch(() => {}));
    } else {
      await message.reply({ content: `Could not load level data for **${target.username}**`, failIfNotExist: false }).catch(() => message.channel.send(`Could not load level data for **${target.username}**`).catch(() => {}));
    }
  },

  async executeSlash(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') || interaction.user;
    const attachment = await _genCard(target, interaction.guild);
    if (attachment) await interaction.editReply({ files: [attachment] });
    else await interaction.editReply({ content: `Could not load level data for **${target.username}**` });
  },
};

async function _genCard(target, guild) {
  const userData = await getEffectiveUserData(target.id, guild.id);
  const rank = await getUserRank(target.id, guild.id) || 0;

  const totalXp = userData?.xp || 0;
  const stats = getRankStats(totalXp);

  try {
    const buffer = await generateLevelCard({
      user: target,
      xp: stats.xpInCurrentLevel,
      nextLevelXp: stats.xpRequiredForLevelGap,
      level: stats.level,
      rank,
      totalXp: totalXp
    });
    return new AttachmentBuilder(buffer, { name: 'rank.png' });
  } catch (error) {
    console.error(error);
    return null;
  }
}