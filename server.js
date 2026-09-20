const express = require('express');
const app = express();
const PORT = process.env.PORT || 3011;
const CACHE_TTL    = 5 * 60 * 1000;   // datos completos de gametools
const FALLBACK_TTL = 60 * 1000;       // #1: datos degradados de EA — ventana corta para no envenenar la key
const NEG_TTL      = 60 * 1000;       // #4: caché negativo de errores/timeouts
// #2: budget de timeout cabe en el proxy_read_timeout 15s de nginx.
// Peor caso = gametools (9s) + fallback EA (5s) = 14s, con ~1s de margen para parseo.
const TIMEOUT_MS    = 9000;           // gametools
const EA_TIMEOUT_MS = 5000;           // EA fallback

const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
  return entry;
}

// status=null → entrada positiva (200). status=4xx/5xx → entrada negativa cacheada.
function setCached(key, data, ttl = CACHE_TTL, status = null) {
  cache.set(key, { data, ts: Date.now(), ttl, status });
}

function parseNum(s) { return s ? parseFloat(String(s).replace(/,/g, '')) || 0 : 0; }

async function fetchEAData(name) {
  const url = `https://www.ea.com/games/battlefield/battlefield-6/player-stats/${encodeURIComponent(name)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EA_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
  } catch (e) {
    // Marca el timeout de EA con un code propio para no confundirlo con el abort de gametools.
    if (e.name === 'AbortError') { const t = new Error('EA timeout'); t.code = 'EA_TIMEOUT'; throw t; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const html = await upstream.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not parse EA stats page');
  const nextData = JSON.parse(match[1]);
  const summary = nextData?.props?.pageProps?.statsResponse?.playerStatsSummary;
  if (!summary) throw new Error('Player not found on EA');

  const flat = {};
  for (const section of summary.basicStats || []) {
    for (const s of [...(section.stats || []), ...(section.highlightedStats || [])]) {
      flat[s.id] = s.value;
    }
  }
  for (const arr of [summary.extendedStats, summary.playerRoleStats, summary.featuredStats, summary.gameModeStats, summary.achievementStats]) {
    for (const s of arr || []) flat[s.id] = s.value;
  }
  return { summary, flat };
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
  if (cached) return res.status(cached.status || 200).json(cached.data);

  const url = `https://api.gametools.network/bf6/stats/?name=${encodeURIComponent(name)}&platform=${encodeURIComponent(platform)}`;

  // 1) gametools (primario). Tanto su error como su timeout caen al fallback de EA.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const upstream = await fetch(url, { signal: controller.signal });
      const data = await upstream.json();
      if (upstream.ok && !data.error) {
        setCached(cacheKey, data);
        return res.json(data);
      }
      console.log(`[bf6/stats] gametools error for ${name}, trying EA fallback`);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // #2: timeout/red de gametools — antes esto devolvía 504 sin probar EA.
    console.log(`[bf6/stats] gametools ${err.name} for ${name}, trying EA fallback`);
  }

  // 2) EA fallback
  try {
    const { summary, flat } = await fetchEAData(name);
    const hours = parseNum(flat['total_time_played']);
    const eaStats = {
      userName: summary.playerDisplayName || summary.playerTag,
      kills: parseNum(flat['total_kills']),
      killDeath: parseNum(flat['kill_death_ratio']),
      matchesPlayed: parseNum(flat['total_matches_played']),
      winPercent: flat['matches_win_rate'] || '0%',
      secondsPlayed: Math.round(hours * 3600),
      // Campos extra para accuracy.html / objective.html (mismo shape que gametools).
      // EA no expone shotsHit/shotsFired/weapons[]/sector → esos overlays quedan parciales.
      accuracy:      flat['shot_accuracy'] || null,   // "18%" string, lo maneja pct()
      headshots:     flat['headshot_rate'] || null,   // "14%" string
      killAssists:   parseNum(flat['total_assists']),
      revives:       parseNum(flat['total_revives']),
      resupplies:    parseNum(flat['total_teammates_resupplied']),
      objective:     { time: { total: parseNum(flat['total_objective_time']) * 60 } }, // min → seg
      _source: 'ea',
    };
    setCached(cacheKey, eaStats, FALLBACK_TTL);   // #1: datos degradados, solo 60s
    return res.json(eaStats);
  } catch (err) {
    // #4: gametools y EA fallaron — caché negativo para no martillar upstream.
    const status  = err.code === 'EA_TIMEOUT' ? 504 : 502;
    const payload = { error: 'stats unavailable', detail: err.message };
    setCached(cacheKey, payload, NEG_TTL, status);
    res.status(status).json(payload);
  }
});

app.get('/bf6/eastats', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const cacheKey = `ea:${name}`;
  const cached = getCached(cacheKey);
  if (cached) return res.status(cached.status || 200).json(cached.data);

  try {
    const { summary, flat } = await fetchEAData(name);
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
    if (err.code === 'EA_TIMEOUT' || err.name === 'AbortError') return res.status(504).json({ error: 'EA page timeout' });
    res.status(502).json({ error: 'EA stats unavailable', detail: err.message });
  }
});


// ── WARDOGS (Steam) ───────────────────────────────────────────────────────────
// Bulkhead NO ofrece API pública de perfiles. Lo que sí hay:
//   · jugadores simultáneos: endpoint público de Steam (sin llave)
//   · horas/logros/stats de un jugador: Steam Web API, requiere STEAM_API_KEY (gratis) y perfil con detalles públicos
const WD_APPID  = 1867240;
const STEAM_KEY = process.env.STEAM_API_KEY || '';
const WD_HISTORY = [];                       // { t, n } una muestra por minuto (se reinicia con el servicio)
const WD_KEEP = 24 * 60;

async function steamJson(url, ms = 8000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) { const e = new Error(`steam ${r.status}`); e.status = r.status; throw e; } return await r.json(); }
  finally { clearTimeout(t); }
}
async function wdSample() {
  try {
    const j = await steamJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${WD_APPID}`, 6000);
    const n = j?.response?.player_count;
    if (Number.isFinite(n)) { WD_HISTORY.push({ t: Date.now(), n }); if (WD_HISTORY.length > WD_KEEP) WD_HISTORY.shift(); }
  } catch (e) { /* Steam intermitente: se conserva el último dato */ }
}
wdSample(); setInterval(wdSample, 60 * 1000);

app.get('/bf6/wardogs/players', async (req, res) => {
  if (!WD_HISTORY.length) await wdSample();
  if (!WD_HISTORY.length) return res.status(502).json({ error: 'Steam unavailable' });
  const now = WD_HISTORY[WD_HISTORY.length - 1];
  const ago = WD_HISTORY.find(x => x.t >= now.t - 30 * 60 * 1000) || WD_HISTORY[0];
  const peak24h = Math.max(...WD_HISTORY.map(x => x.n));
  const step = Math.max(1, Math.floor(WD_HISTORY.length / 40));
  const spark = WD_HISTORY.filter((_, i) => i % step === 0 || i === WD_HISTORY.length - 1).map(x => x.n);
  res.json({ players: now.n, peak: peak24h, deltaPct: ago.n ? +(((now.n - ago.n) / ago.n) * 100).toFixed(1) : 0, spark, samples: WD_HISTORY.length, updatedAt: now.t });
});

function prettyAch(id) { return String(id).replace(/^ACH_/, '').split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' '); }

app.get('/bf6/wardogs/profile', async (req, res) => {
  const raw = String(req.query.steamid || '').trim();
  if (!raw) return res.status(400).json({ error: 'steamid is required' });
  if (!STEAM_KEY) return res.status(501).json({ error: 'steam_key_missing', message: 'El perfil de WARDOGS necesita una llave de Steam Web API en el servidor.' });
  const ck = `wd:${raw.toLowerCase()}`; const hit = getCached(ck);
  if (hit) return res.status(hit.status || 200).json(hit.data);
  try {
    let id = raw.match(/\d{17}/)?.[0];
    if (!id) {
      const vanity = (raw.match(/steamcommunity\.com\/id\/([^/?#]+)/i)?.[1]) || raw;
      const v = await steamJson(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(vanity)}`);
      id = v?.response?.steamid;
      if (!id) { const out = { error: 'not_found', message: 'No encontramos ese perfil de Steam.' }; setCached(ck, out, NEG_TTL, 404); return res.status(404).json(out); }
    }
    const [sum, games, ach] = await Promise.all([
      steamJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${id}`),
      steamJson(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${id}&include_played_free_games=1&appids_filter[0]=${WD_APPID}`).catch(() => null),
      steamJson(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${id}&appid=${WD_APPID}&l=spanish`).catch(() => null),
    ]);
    const p = sum?.response?.players?.[0];
    if (!p) { const out = { error: 'not_found', message: 'No encontramos ese perfil de Steam.' }; setCached(ck, out, NEG_TTL, 404); return res.status(404).json(out); }
    if (p.communityvisibilitystate !== 3) { const out = { error: 'private_profile', message: 'El perfil de Steam es privado.', name: p.personaname }; setCached(ck, out, NEG_TTL, 403); return res.status(403).json(out); }
    const g = games?.response?.games?.[0];
    const list = ach?.playerstats?.achievements || [];
    if (!g && !list.length) { const out = { error: 'game_details_private', message: 'Los detalles de juego de Steam no son públicos, o el jugador no tiene WARDOGS.', name: p.personaname, avatar: p.avatarfull }; setCached(ck, out, NEG_TTL, 403); return res.status(403).json(out); }
    const done = list.filter(a => a.achieved);
    const recent = [...done].sort((a, b) => b.unlocktime - a.unlocktime).slice(0, 3).map(a => ({ name: a.name || prettyAch(a.apiname), at: a.unlocktime }));
    const out = { name: p.personaname, avatar: p.avatarfull, hours: g ? +(g.playtime_forever / 60).toFixed(1) : null, hours2w: g ? +((g.playtime_2weeks || 0) / 60).toFixed(1) : null, achievements: { done: done.length, total: list.length, recent } };
    setCached(ck, out, CACHE_TTL); res.json(out);
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ error: 'steam_timeout' });
    res.status(502).json({ error: 'steam_unavailable', detail: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`BF6 proxy listening on 127.0.0.1:${PORT}`);
});
