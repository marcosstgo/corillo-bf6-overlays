const express = require('express');
const app = express();
const PORT = 3011;
const CACHE_TTL = 5 * 60 * 1000;
const TIMEOUT_MS = 12000;

const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET',
    'Content-Type': 'application/json',
  });
  next();
});

app.get('/bf6/stats', async (req, res) => {
  const { name, platform = 'pc' } = req.query;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const cacheKey = `${name}:${platform}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const url = `https://api.gametools.network/bf6/stats/?name=${encodeURIComponent(name)}&platform=${encodeURIComponent(platform)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const upstream = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    const data = await upstream.json();

    if (!upstream.ok) {
      // pass gametools error body through (e.g. "Player not found")
      return res.status(upstream.status).json({ error: true, ...data });
    }

    setCached(cacheKey, data);
    res.json(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'gametools timeout' });
    }
    res.status(502).json({ error: 'gametools unavailable', detail: err.message });
  }
});

app.get('/bf6/eastats', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const cacheKey = `ea:${name}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const url = `https://www.ea.com/games/battlefield/battlefield-6/player-stats/${encodeURIComponent(name)}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    clearTimeout(timer);

    const html = await upstream.text();
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return res.status(502).json({ error: 'Could not parse EA stats page' });

    const nextData = JSON.parse(match[1]);
    const summary = nextData?.props?.pageProps?.statsResponse?.playerStatsSummary;
    if (!summary) return res.status(404).json({ error: 'Player not found on EA' });

    // Flatten all stat sections into a single lookup
    const flat = {};
    for (const section of summary.basicStats || []) {
      for (const s of [...(section.stats || []), ...(section.highlightedStats || [])]) {
        flat[s.id] = s.value;
      }
    }
    for (const arr of [summary.extendedStats, summary.playerRoleStats, summary.featuredStats, summary.gameModeStats, summary.achievementStats]) {
      for (const s of arr || []) flat[s.id] = s.value;
    }

    const result = {
      playerTag: summary.playerTag,
      displayName: summary.playerDisplayName,
      favoriteMode: summary.gameMode?.name || null,
      favoriteModeId: summary.gameMode?.id || null,
      favoriteClass: summary.playerRole?.name || null,
      favoriteClassId: summary.playerRole?.id || null,
      season: {
        hoursPlayed:      flat['total_time_played']            || null,
        matchesPlayed:    flat['total_matches_played']         || null,
        matchesWon:       flat['total_matches_won']            || null,
        xp:               flat['total_xp']                     || null,
        winRate:          flat['matches_win_rate']             || null,
        killDeath:        flat['kill_death_ratio']             || null,
        kills:            flat['total_kills']                  || null,
        headshotKills:    flat['total_kills_headshots']        || null,
        assists:          flat['total_assists']                || null,
        revives:          flat['total_revives']                || null,
        damage:           flat['total_damage_dealt']           || null,
        shotAccuracy:     flat['shot_accuracy']                || null,
        headshotRate:     flat['headshot_rate']                || null,
        grenadeKills:     flat['total_grenade_kills']          || null,
        objectiveTimeMin: flat['total_objective_time']         || null,
        resupplies:       flat['total_teammates_resupplied']   || null,
      },
    };

    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'EA page timeout' });
    res.status(502).json({ error: 'EA stats unavailable', detail: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`BF6 proxy listening on 127.0.0.1:${PORT}`);
});
