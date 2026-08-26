const { EmbedBuilder } = require('discord.js');
const { getUser, bulkUpsertUserStats, getConfig, getAchievements, grantAchievement, hasAchievement } = require('../database/db');
const config = require('../config');
const { formatTemplate, resolveChannel } = require('../utils/helpers');

const LEVEL_ROLES = [5, 10, 20, 30, 40, 50, 100];
const XP_PER_MESSAGE = 4;
const FLUSH_INTERVAL_MS = 45_000;

const xpState = new Map();
let flushTimer = null;

function key(userId, guildId) { return `${userId}-${guildId}`; }

async function hydrate(userId, guildId) {
  const k = key(userId, guildId);
  let entry = xpState.get(k);
  if (entry) return entry;

  const row = await getUser(userId, guildId);
  entry = {
    userId,
    guildId,
    xp: row?.xp || 0,
    messages: row?.messages || 0,
    level: row?.level || 0,
    dirty: false,
  };
  xpState.set(k, entry);
  return entry;
}

async function flushXP() {
  const dirtyEntries = [...xpState.values()].filter(e => e.dirty);
  if (dirtyEntries.length === 0) return;

  try {
    await bulkUpsertUserStats(dirtyEntries.map(e => ({
      userId: e.userId, guildId: e.guildId, xp: e.xp, messages: e.messages, level: e.level,
    })));
    for (const e of dirtyEntries) e.dirty = false;
  } catch (err) {
    console.error('[Leveling] Bulk XP flush failed, will retry next cycle:', err.message);
  }
}

function startXPFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(() => flushXP().catch(() => {}), FLUSH_INTERVAL_MS);
}

function calculateLevel(totalXp) {
  let level = 0;
  let xpNeededForNext = 120;
  let accumulatedXp = 0;

  while (totalXp >= accumulatedXp + xpNeededForNext) {
    accumulatedXp += xpNeededForNext;
    level++;
    xpNeededForNext += 60;
  }
  return level;
}

function totalXpForLevel(level) {
  let total = 0;
  let currentLevelRequirement = 120;
  for (let i = 0; i < level; i++) {
    total += currentLevelRequirement;
    currentLevelRequirement += 60;
  }
  return total;
}

function xpForNextLevel(level) {
  return totalXpForLevel(level + 1);
}

async function handleXP(message, client) {
  const cooldownKey = key(message.author.id, message.guild.id);
  if (client.xpCooldowns.has(cooldownKey)) return;
  client.xpCooldowns.set(cooldownKey, true);
  setTimeout(() => client.xpCooldowns.delete(cooldownKey), 15_000);

  const entry = await hydrate(message.author.id, message.guild.id);
  const oldLevel = entry.level;

  entry.xp += XP_PER_MESSAGE;
  entry.messages += 1;
  entry.dirty = true;

  const newLevel = calculateLevel(entry.xp);

  if (newLevel > oldLevel) {
    entry.level = newLevel;
    await handleLevelUp(message, client, newLevel, entry.xp);
  }

  await checkAchievements(message, client, entry);
}

async function getEffectiveUserData(userId, guildId) {
  const entry = await hydrate(userId, guildId);
  return { xp: entry.xp, messages: entry.messages, level: entry.level };
}

async function handleLevelUp(message, client, newLevel, totalXp) {
  const guild = message.guild;
  let unlockedRoleId = null;

  if (LEVEL_ROLES.includes(newLevel)) {
    const roleId = await getConfig(guild.id, `level_role_${newLevel}`);
    if (roleId) {
      unlockedRoleId = roleId;
      const role = guild.roles.cache.get(roleId);
      const member = guild.members.cache.get(message.author.id);
      if (role && member) {
        for (const lvl of LEVEL_ROLES) {
          if (lvl < newLevel) {
            const oldRoleId = await getConfig(guild.id, `level_role_${lvl}`);
            if (oldRoleId) {
              const oldRole = guild.roles.cache.get(oldRoleId);
              if (oldRole && member.roles.cache.has(oldRoleId)) await member.roles.remove(oldRole).catch(() => {});
            }
          }
        }
        await member.roles.add(role).catch(() => {});
      }
    }
  }

  const levelChannelId = await getConfig(guild.id, 'level_channel');
  const targetChannel = await resolveChannel(guild, levelChannelId, message.channel);

  const customMsg = await getConfig(guild.id, 'level_up_msg');
  const template = customMsg || config.levelUpMsg;

  const unlockedText = unlockedRoleId ? ` You unlocked <@&${unlockedRoleId}>! 🎖️` : '';

  const messageContent = formatTemplate(template, {
    user: message.author,
    level: newLevel,
    role: unlockedRoleId,
    unlockedText,
    guildName: guild.name,
  });

  await targetChannel.send({ content: messageContent }).catch(() => {});
}

async function checkAchievements(message, client, entry) {
  const achievements = await getAchievements(message.guild.id);
  for (const ach of achievements) {
    if (await hasAchievement(message.author.id, message.guild.id, ach.id)) continue;
    let earned = false;
    switch (ach.requirement_type) {
      case 'messages': earned = entry.messages >= ach.requirement_value; break;
      case 'level': earned = entry.level >= ach.requirement_value; break;
      case 'xp': earned = entry.xp >= ach.requirement_value; break;
    }
    if (earned) {
      const granted = await grantAchievement(message.author.id, message.guild.id, ach.id);
      if (granted) await notifyAchievement(message, client, ach, entry);
    }
  }
}

async function notifyAchievement(message, client, achievement, entry) {
  const customMsg = await getConfig(message.guild.id, 'achievement_notif_msg');
  const template = customMsg || config.achievementNotifMsg;

  const descriptionContent = formatTemplate(template, {
    user: message.author,
    name: achievement.name,
    description: achievement.description,
    guildName: message.guild.name,
  });

  const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('🏆 Achievement Unlocked!')
      .setDescription(descriptionContent)
      .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
      .setTimestamp();

  if (achievement.reward_role_id) {
    const role = message.guild.roles.cache.get(achievement.reward_role_id);
    const member = message.guild.members.cache.get(message.author.id);
    if (role && member) await member.roles.add(role).catch(() => {});
    embed.addFields({ name: '🎖️ Role Reward', value: `<@&${achievement.reward_role_id}>`, inline: true });
  }

  if (achievement.reward_xp > 0) {
    entry.xp += achievement.reward_xp;
    entry.dirty = true;
    embed.addFields({ name: '⭐ XP Reward', value: `+${achievement.reward_xp} XP`, inline: true });
  }

  const levelChannelId = await getConfig(message.guild.id, 'level_channel');
  const ch = await resolveChannel(message.guild, levelChannelId, message.channel);

  if (ch) await ch.send({ content: `🏆 ${message.author}`, embeds: [embed] }).catch(() => {});
}

function getRankStats(totalXp) {
  const level = calculateLevel(totalXp);
  const currentLevelStartXP = totalXpForLevel(level);
  const nextLevelStartXP = totalXpForLevel(level + 1);

  return {
    level: level,
    xpInCurrentLevel: totalXp - currentLevelStartXP,
    xpRequiredForLevelGap: nextLevelStartXP - currentLevelStartXP,
    totalNextLevelXP: nextLevelStartXP
  };
}

module.exports = {
  handleXP,
  calculateLevel,
  xpForNextLevel,
  totalXpForLevel,
  getRankStats,
  getEffectiveUserData,
  startXPFlusher,
  flushXP,
};