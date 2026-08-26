const axios = require('axios');
const xml2js = require('xml2js');
const { getConfig, hasPosted, markPosted } = require('../database/db');
const config = require('../config');
const { formatTemplate, resolveChannel } = require('../utils/helpers');

const POLL_INTERVAL = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

let twitchTokenCache = { token: null, expiresAt: 0 };
let twitchTokenPromise = null;

async function getTwitchToken() {
  if (twitchTokenCache.token && Date.now() < twitchTokenCache.expiresAt) {
    return twitchTokenCache.token;
  }
  // Single-flight: concurrent guilds must never fire duplicate token requests.
  if (twitchTokenPromise) return twitchTokenPromise;

  twitchTokenPromise = (async () => {
    try {
      const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: {
          client_id: process.env.TWITCH_CLIENT_ID,
          client_secret: process.env.TWITCH_CLIENT_SECRET,
          grant_type: 'client_credentials',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      twitchTokenCache = {
        token: tokenRes.data.access_token,
        expiresAt: Date.now() + Math.max(tokenRes.data.expires_in - 300, 60) * 1000,
      };
      return twitchTokenCache.token;
    } finally {
      twitchTokenPromise = null;
    }
  })();

  return twitchTokenPromise;
}

function invalidateTwitchToken() {
  twitchTokenCache = { token: null, expiresAt: 0 };
}

function startNotificationPoller(client) {
  setTimeout(() => pollAll(client), 10_000);
  setInterval(() => pollAll(client), POLL_INTERVAL);
  console.log('📡 Notification poller started (immediate + 5min interval)');
}

async function pollAll(client) {
  console.log('🔍 [System Poller] Beginning scanning cycle for social media streams...');
  const guilds = [...client.guilds.cache.values()];

  const results = await Promise.allSettled(guilds.map(guild => pollGuild(guild)));

  const rejected = results.filter(r => r.status === 'rejected');
  if (rejected.length > 0) {
    console.error(`[Poller] ${rejected.length}/${guilds.length} guild(s) threw an unexpected error this cycle:`, rejected[0].reason?.message);
  }
}

async function pollGuild(guild) {
  const [yt, twitch, tiktok, ig] = await Promise.allSettled([
    pollYouTube(guild),
    pollTwitch(guild),
    pollTikTok(guild),
    pollInstagram(guild),
  ]);

  if (yt.status === 'rejected') console.error(`[YouTube poll error][${guild.name}]`, yt.reason?.message);
  if (twitch.status === 'rejected') console.error(`[Twitch poll error][${guild.name}]`, twitch.reason?.message);
}

async function pollYouTube(guild) {
  const channelIdsRaw = await getConfig(guild.id, 'yt_channel_id');
  const notifChannelId = await getConfig(guild.id, 'yt_notif_channel');

  if (!channelIdsRaw || !notifChannelId) return;

  const discordChannel = await resolveChannel(guild, notifChannelId);
  if (!discordChannel) return;

  const ytChannelIds = channelIdsRaw.split(',').map(s => s.trim()).filter(Boolean);

  await Promise.allSettled(ytChannelIds.map(ytChannelId => pollYouTubeChannel(guild, discordChannel, ytChannelId)));
}

async function pollYouTubeChannel(guild, discordChannel, ytChannelId) {
  try {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${ytChannelId}`;

    const res = await axios.get(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      validateStatus: () => true,
    });

    if (res.status !== 200) return;

    let parsed;
    try {
      parsed = await xml2js.parseStringPromise(res.data);
    } catch (parseErr) {
      return;
    }

    const entries = parsed?.feed?.entry || [];
    if (!entries.length) return;

    // Check the top 5 (not just entries[0]) — RSS delays and Shorts can push a
    // genuinely new upload down a slot or two. Oldest-of-the-batch first so any
    // catch-up posts land in upload order.
    const candidates = entries.slice(0, 5).reverse();

    for (const entry of candidates) {
      const videoId = entry['yt:videoId']?.[0];
      if (!videoId) continue;
      if (await hasPosted(videoId, 'youtube', guild.id)) continue;

      const title = entry.title?.[0] || 'New Video';
      const link = entry.link?.[0]?.$?.href || `https://www.youtube.com/watch?v=${videoId}`;
      const author = entry.author?.[0]?.name?.[0] || 'YouTube';

      const pingRole = await getConfig(guild.id, 'yt_ping_role');

      let actionText = 'uploaded a video';
      if (link.includes('/shorts/')) {
        actionText = 'posted a short';
      } else if (link.includes('live') || entry.isLive) {
        actionText = 'went live';
      }

      const customMsg = await getConfig(guild.id, 'yt_notif_msg');
      const template = customMsg || config.ytNotifMsg;

      const messageContent = formatTemplate(template, {
        role: pingRole,
        author,
        actionText,
        title,
        link,
        guildName: guild.name,
      });

      await discordChannel.send({ content: messageContent });
      await markPosted(videoId, 'youtube', guild.id);

      console.log(`[YouTube] ✅ Alert posted successfully: "${title}" (${videoId}) inside guild: ${guild.name}`);
    }
  } catch (err) {
    console.error(`[YouTube] Error processing channel ${ytChannelId} for guild ${guild.name}: ${err.message}`);
  }
}

async function pollTwitch(guild) {
  const twitchUsersRaw = await getConfig(guild.id, 'twitch_username');
  const notifChannelId = await getConfig(guild.id, 'twitch_notif_channel');
  if (!twitchUsersRaw || !notifChannelId) return;
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return;

  const discordChannel = await resolveChannel(guild, notifChannelId);
  if (!discordChannel) return;

  let token;
  try {
    token = await getTwitchToken();
  } catch (err) {
    console.error('[Twitch] Failed to acquire token:', err.message);
    return;
  }

  const twitchUsers = twitchUsersRaw.split(',').map(s => s.trim()).filter(Boolean);

  await Promise.allSettled(twitchUsers.map(twitchUser => pollTwitchUser(guild, discordChannel, twitchUser, token)));
}

async function pollTwitchUser(guild, discordChannel, twitchUser, token) {
  try {
    let streamRes;
    try {
      streamRes = await axios.get('https://api.twitch.tv/helix/streams', {
        params: { user_login: twitchUser },
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err.response?.status === 401) invalidateTwitchToken();
      throw err;
    }

    const stream = streamRes.data.data?.[0];
    if (!stream) return;

    const streamKey = `twitch_${stream.id}`;
    if (await hasPosted(streamKey, 'twitch', guild.id)) return;

    const pingRole = await getConfig(guild.id, 'twitch_ping_role');
    const link = `https://twitch.tv/${twitchUser}`;
    const author = stream.user_name || twitchUser;
    const title = stream.title || 'Live Stream';

    const customMsg = await getConfig(guild.id, 'twitch_notif_msg');
    const template = customMsg || config.twitchNotifMsg;

    const messageContent = formatTemplate(template, {
      role: pingRole,
      author,
      title,
      link,
      guildName: guild.name,
    });

    await discordChannel.send({ content: messageContent });
    await markPosted(streamKey, 'twitch', guild.id);

    console.log(`[Twitch] ✅ Alert posted successfully: ${twitchUser} (${stream.id}) inside guild: ${guild.name}`);
  } catch (err) {
    console.error(`[Twitch] Error for user ${twitchUser} in guild ${guild.name}: ${err.message}`);
  }
}

async function pollTikTok(guild) {
  const notifChannelId = await getConfig(guild.id, 'tiktok_notif_channel');
  if (!notifChannelId || !process.env.TIKTOK_ACCESS_TOKEN) return;
}

async function pollInstagram(guild) {
  const notifChannelId = await getConfig(guild.id, 'instagram_notif_channel');
  if (!notifChannelId || !process.env.INSTAGRAM_ACCESS_TOKEN) return;
}

module.exports = { startNotificationPoller };