const express = require('express');
const app = express();
const PORT = process.env.PORT || 3011;
const CACHE_TTL    = 5 * 60 * 1000;   // datos completos de gametools
const FALLBACK_TTL = 60 * 1000;       // #1: datos degradados de EA — ventana corta para no envenenar la key
const NEG_TTL      = 60 * 1000;       // #4: caché negativo de errores/timeouts
const NOTFOUND_TTL = 10 * 60 * 1000;  // jugador que no existe: no cambia de un minuto a otro
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
  if (!summary) { const nf = new Error('Player not found on EA'); nf.code = 'NOT_FOUND'; throw nf; }

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
      timePlayed:    Math.round(hours * 3600),     // overlay.html lee timePlayed (antes salía «0h» con datos de EA)
      damage:        parseNum(flat['total_damage_dealt']),
      killsPerMinute:  hours > 0 ? +(parseNum(flat['total_kills']) / (hours * 60)).toFixed(2) : null,
      damagePerMinute: hours > 0 ? Math.round(parseNum(flat['total_damage_dealt']) / (hours * 60)) : null,
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
    // Jugador inexistente → 404, para que el overlay diga «revisa nombre y plataforma»
    // en vez de «API not responding» (antes salía 502 y el streamer culpaba al servidor).
    if (err.code === 'NOT_FOUND') {
      const payload = { error: 'not found', detail: `Player not found: ${name} (${platform})` };
      setCached(cacheKey, payload, NOTFOUND_TTL, 404);
      return res.status(404).json(payload);
    }
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
    if (err.code === 'NOT_FOUND') {
      const payload = { error: 'not found', detail: `Player not found on EA: ${name}` };
      setCached(cacheKey, payload, NOTFOUND_TTL, 404);
      return res.status(404).json(payload);
    }
    res.status(502).json({ error: 'EA stats unavailable', detail: err.message });
  }
});


// ── WARDOGS (Steam) ───────────────────────────────────────────────────────────
// Bulkhead NO ofrece API pública de perfiles. Lo que sí hay:
//   · jugadores simultáneos: endpoint público de Steam (sin llave)
//   · horas/logros/stats de un jugador: Steam Web API, requiere STEAM_API_KEY (gratis) y perfil con detalles públicos
const WD_APPID  = 1867240;
const STEAM_KEY = process.env.STEAM_API_KEY || '';
const fs = require('fs'), path = require('path');
const WD_KEEP = 24 * 60;
const BF6_APPID = 2807960;
// Historia de jugadores simultáneos por juego, una muestra por minuto. Se guarda en disco
// (StateDirectory de systemd) para que un reinicio no falsee el récord de 24 h.
function makeTracker(appid, file) {
  const dir = process.env.STATE_DIRECTORY ? process.env.STATE_DIRECTORY.split(':')[0] : '';
  const fp = dir ? path.join(dir, file) : '';
  const hist = [];                           // { t, n }
  try {
    if (fp && fs.existsSync(fp)) {
      const cut = Date.now() - WD_KEEP * 60 * 1000;
      for (const x of JSON.parse(fs.readFileSync(fp, 'utf8'))) if (x && x.t >= cut && Number.isFinite(x.n)) hist.push(x);
    }
  } catch (e) { console.warn(`${file}: no se pudo leer la historia:`, e.message); }
  const save = () => {
    if (!fp) return;
    try { fs.writeFileSync(fp + '.tmp', JSON.stringify(hist)); fs.renameSync(fp + '.tmp', fp); }
    catch (e) { console.warn(`${file}: no se pudo guardar la historia:`, e.message); }
  };
  const sample = async () => {
    try {
      const j = await steamJson(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`, 6000);
      const n = j?.response?.player_count;
      if (Number.isFinite(n)) { hist.push({ t: Date.now(), n }); if (hist.length > WD_KEEP) hist.shift(); }
    } catch (e) { /* Steam intermitente: se conserva el último dato */ }
  };
  const summary = () => {
    const now = hist[hist.length - 1];
    const ago = hist.find(x => x.t >= now.t - 30 * 60 * 1000) || hist[0];
    const step = Math.max(1, Math.floor(hist.length / 60));
    return { players: now.n, peak: Math.max(...hist.map(x => x.n)), low: Math.min(...hist.map(x => x.n)),
      deltaPct: ago.n ? +(((now.n - ago.n) / ago.n) * 100).toFixed(1) : 0,
      spark: hist.filter((_, i) => i % step === 0 || i === hist.length - 1).map(x => x.n),
      samples: hist.length, sinceMin: Math.round((now.t - hist[0].t) / 60000), updatedAt: now.t };
  };
  sample(); setInterval(sample, 60 * 1000); setInterval(save, 5 * 60 * 1000);
  return { hist, sample, save, summary };
}
async function steamJson(url, ms = 8000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) { const e = new Error(`steam ${r.status}`); e.status = r.status; throw e; } return await r.json(); }
  finally { clearTimeout(t); }
}
const WD = makeTracker(WD_APPID, 'wardogs-history.json');
const BF = makeTracker(BF6_APPID, 'bf6-history.json');
process.on('SIGTERM', () => { WD.save(); BF.save(); process.exit(0); });

const playersRoute = tr => async (req, res) => {
  if (!tr.hist.length) await tr.sample();
  if (!tr.hist.length) return res.status(502).json({ error: 'Steam unavailable' });
  res.json(tr.summary());
};
app.get('/bf6/wardogs/players', playersRoute(WD));
app.get('/bf6/players', playersRoute(BF));       // Battlefield 6: jugadores en Steam (no incluye EA App ni consolas)

function prettyAch(id) { return String(id).replace(/^ACH_/, '').split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' '); }

// ── Datos del juego (públicos, sin usuario): logros con rareza global, reseñas, precio, noticias oficiales ──
const REVIEW_ES = { 9: 'Extremadamente positivas', 8: 'Muy positivas', 7: 'Positivas', 6: 'Mayormente positivas', 5: 'Variadas', 4: 'Mayormente negativas', 3: 'Negativas', 2: 'Muy negativas', 1: 'Extremadamente negativas' };
// El esquema trae la CDN vieja (steamcdn-a.akamaihd.net, ya devuelve 404): se reconstruye con la vigente.
const wdIcon = f => f ? `https://shared.fastly.steamstatic.com/community_assets/images/apps/${WD_APPID}/${String(f).split('/').pop()}` : '';
async function wdCatalog() {                 // lista de logros + % de jugadores que los tienen; cambia poco → 1 h
  const ck = 'wd:catalog'; const hit = getCached(ck); if (hit) return hit.data;
  const [schema, pct] = await Promise.all([
    steamJson(`https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${STEAM_KEY}&appid=${WD_APPID}&l=spanish`),
    steamJson(`https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${WD_APPID}`).catch(() => null),
  ]);
  const rar = new Map((pct?.achievementpercentages?.achievements || []).map(a => [a.name, +(+a.percent).toFixed(1)]));
  const list = (schema?.game?.availableGameStats?.achievements || []).map(a => ({
    id: a.name, name: a.displayName || prettyAch(a.name), desc: a.description || '', hidden: !!a.hidden,
    pct: rar.has(a.name) ? rar.get(a.name) : null, icon: wdIcon(a.icon), iconGray: wdIcon(a.icongray),
  }));
  if (list.length) setCached(ck, list, 60 * 60 * 1000);
  return list;
}

app.get('/bf6/wardogs/game', async (req, res) => {
  const ck = 'wd:game'; const hit = getCached(ck);
  if (hit) return res.status(hit.status || 200).json(hit.data);
  try {
    const [store, rev, news, cat, revEs] = await Promise.all([
      steamJson(`https://store.steampowered.com/api/appdetails?appids=${WD_APPID}&l=spanish`).catch(() => null),
      steamJson(`https://store.steampowered.com/appreviews/${WD_APPID}?json=1&language=all&num_per_page=0&purchase_type=all`).catch(() => null),
      steamJson(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${WD_APPID}&count=20&maxlength=0`).catch(() => null),
      STEAM_KEY ? wdCatalog().catch(() => []) : Promise.resolve([]),
      steamJson(`https://store.steampowered.com/appreviews/${WD_APPID}?json=1&language=spanish&num_per_page=0&purchase_type=all`).catch(() => null),
    ]);
    const s = store?.[WD_APPID]?.data || {}; const q = rev?.query_summary || {};
    const total = q.total_reviews || 0;
    const now = WD.hist[WD.hist.length - 1];
    const out = {
      name: s.name || 'WARDOGS', developer: (s.developers || [])[0] || null, publisher: (s.publishers || [])[0] || null,
      released: s.release_date?.date || null, price: s.price_overview?.final_formatted || (s.is_free ? 'Gratis' : null),
      reviews: total ? { total, positive: q.total_positive, pct: Math.round(q.total_positive / total * 100), label: REVIEW_ES[q.review_score] || q.review_score_desc || null } : null,
      reviewsEs: revEs?.query_summary?.total_reviews ? { total: revEs.query_summary.total_reviews, pct: Math.round(revEs.query_summary.total_positive / revEs.query_summary.total_reviews * 100), label: REVIEW_ES[revEs.query_summary.review_score] || null } : null,
      players: now ? now.n : null,
      achievements: cat,
      news: (news?.appnews?.newsitems || []).filter(n => n.feedname === 'steam_community_announcements').slice(0, 3).map(n => ({ title: n.title, at: n.date, url: n.url })),
    };
    if (!out.reviews && !cat.length && !s.name) return res.status(502).json({ error: 'steam_unavailable' });
    setCached(ck, out, 10 * 60 * 1000); res.json(out);
  } catch (e) { res.status(502).json({ error: 'steam_unavailable', detail: e.message }); }
});

// "Esta sesión": lo ganado desde que el overlay empezó a consultarse (se reinicia tras 6 h sin consultas)
const WD_SESSIONS = new Map();
function wdSession(id, done, hours) {
  const now = Date.now(); let s = WD_SESSIONS.get(id);
  if (!s || now - s.last > 6 * 60 * 60 * 1000) { s = { t0: now, done, hours }; WD_SESSIONS.set(id, s); }
  s.last = now;
  if (WD_SESSIONS.size > 500) for (const [k, v] of WD_SESSIONS) if (now - v.last > 6 * 60 * 60 * 1000) WD_SESSIONS.delete(k);
  return { achievements: Math.max(0, done - s.done), hours: hours == null ? null : +Math.max(0, hours - s.hours).toFixed(1), since: s.t0 };
}

// Usuario de Steam → SteamID64. Los nombres personalizados se cachean 1 h para no gastar cuota de la llave.
const VANITY = new Map();
async function resolveSteamId(raw) {
  const direct = raw.match(/\d{17}/)?.[0]; if (direct) return direct;
  const vanity = (raw.match(/steamcommunity\.com\/id\/([^/?#]+)/i)?.[1]) || raw;
  const k = vanity.toLowerCase(), h = VANITY.get(k);
  if (h && Date.now() - h.t < 60 * 60 * 1000) return h.id;
  const v = await steamJson(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_KEY}&vanityurl=${encodeURIComponent(vanity)}`);
  const id = v?.response?.steamid || null;
  if (id) { VANITY.set(k, { id, t: Date.now() }); if (VANITY.size > 2000) VANITY.delete(VANITY.keys().next().value); }
  return id;
}

// Logros desbloqueados con su hora exacta; caché corta (25 s) para que la alerta de logro reaccione rápido.
app.get('/bf6/wardogs/achievements', async (req, res) => {
  const raw = String(req.query.steamid || '').trim();
  if (!raw) return res.status(400).json({ error: 'steamid is required' });
  if (!STEAM_KEY) return res.status(501).json({ error: 'steam_key_missing' });
  const ck = `wda:${raw.toLowerCase()}`; const hit = getCached(ck);
  if (hit) return res.status(hit.status || 200).json(hit.data);
  try {
    const id = await resolveSteamId(raw);
    if (!id) { const out = { error: 'not_found' }; setCached(ck, out, NEG_TTL, 404); return res.status(404).json(out); }
    const [ach, cat] = await Promise.all([
      steamJson(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${id}&appid=${WD_APPID}&l=spanish`).catch(e => ({ __err: e.status || 0 })),
      wdCatalog().catch(() => []),
    ]);
    if (ach.__err !== undefined || !ach?.playerstats?.achievements) { const out = { error: 'private_or_missing' }; setCached(ck, out, NEG_TTL, 403); return res.status(403).json(out); }
    const byId = new Map(cat.map(c => [c.id, c]));
    const unlocked = ach.playerstats.achievements.filter(a => a.achieved).map(a => { const c = byId.get(a.apiname) || {}; return { id: a.apiname, name: c.name || a.name || prettyAch(a.apiname), desc: c.desc || a.description || '', pct: c.pct ?? null, icon: c.icon || '', at: a.unlocktime }; })
      .sort((x, y) => y.at - x.at);
    const out = { unlocked, total: cat.length || ach.playerstats.achievements.length, now: Math.floor(Date.now() / 1000) };
    setCached(ck, out, 25 * 1000); res.json(out);
  } catch (e) { res.status(502).json({ error: 'steam_unavailable' }); }
});

app.get('/bf6/wardogs/profile', async (req, res) => {
  const raw = String(req.query.steamid || '').trim();
  if (!raw) return res.status(400).json({ error: 'steamid is required' });
  if (!STEAM_KEY) return res.status(501).json({ error: 'steam_key_missing', message: 'El perfil de WARDOGS necesita una llave de Steam Web API en el servidor.' });
  const ck = `wd:${raw.toLowerCase()}`; const hit = getCached(ck);
  if (hit) return res.status(hit.status || 200).json(hit.data);
  try {
    const id = await resolveSteamId(raw);
    if (!id) { const out = { error: 'not_found', message: 'No encontramos ese perfil de Steam.' }; setCached(ck, out, NEG_TTL, 404); return res.status(404).json(out); }
    const [sum, games, ach, lvl, all] = await Promise.all([
      steamJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_KEY}&steamids=${id}`),
      steamJson(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${id}&include_played_free_games=1&appids_filter[0]=${WD_APPID}`).catch(() => null),
      steamJson(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${STEAM_KEY}&steamid=${id}&appid=${WD_APPID}&l=spanish`).catch(() => null),
      steamJson(`https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${STEAM_KEY}&steamid=${id}`).catch(() => null),       // nivel y XP
      steamJson(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_KEY}&steamid=${id}&include_played_free_games=1`).catch(() => null), // biblioteca
    ]);
    const p = sum?.response?.players?.[0];
    if (!p) { const out = { error: 'not_found', message: 'No encontramos ese perfil de Steam.' }; setCached(ck, out, NEG_TTL, 404); return res.status(404).json(out); }
    if (p.communityvisibilitystate !== 3) { const out = { error: 'private_profile', message: 'El perfil de Steam es privado.', name: p.personaname }; setCached(ck, out, NEG_TTL, 403); return res.status(403).json(out); }
    const g = games?.response?.games?.[0];
    const list = ach?.playerstats?.achievements || [];
    if (!g && !list.length) { const out = { error: 'game_details_private', message: 'Los detalles de juego de Steam no son públicos, o el jugador no tiene WARDOGS.', name: p.personaname, avatar: p.avatarfull }; setCached(ck, out, NEG_TTL, 403); return res.status(403).json(out); }
    const done = list.filter(a => a.achieved);
    const recent = [...done].sort((a, b) => b.unlocktime - a.unlocktime).slice(0, 3).map(a => ({ name: a.name || prettyAch(a.apiname), at: a.unlocktime }));
    // catálogo (rareza global, íconos): si falla, el perfil sigue funcionando sin ellos
    const cat = await wdCatalog().catch(() => []); const mine = new Map(list.map(a => [a.apiname, a]));
    const full = (cat.length ? cat : list.map(a => ({ id: a.apiname, name: a.name || prettyAch(a.apiname), desc: a.description || '', hidden: false, pct: null, icon: '', iconGray: '' })))
      .map(c => { const m = mine.get(c.id); return { ...c, unlocked: !!m?.achieved, at: m?.achieved ? m.unlocktime : null }; });
    const rarest = full.filter(a => a.unlocked && a.pct != null).sort((a, b) => a.pct - b.pct)[0] || null;
    const hours = g ? +(g.playtime_forever / 60).toFixed(1) : null;
    const out = { name: p.personaname, avatar: p.avatarfull, hours, hours2w: g ? +((g.playtime_2weeks || 0) / 60).toFixed(1) : null,
      playingNow: String(p.gameid || '') === String(WD_APPID),
      achievements: { done: done.length, total: full.length || list.length, recent, rarest: rarest && { name: rarest.name, pct: rarest.pct }, list: full },
      lastPlayed: g?.rtime_last_played || null,
      steam: { level: lvl?.response?.player_level ?? null, xp: lvl?.response?.player_xp ?? null, xpNext: lvl?.response?.player_xp_needed_to_level_up ?? null,
        memberSince: p.timecreated || null, games: all?.response?.game_count ?? null,
        totalHours: all?.response?.games ? Math.round(all.response.games.reduce((t, x) => t + (x.playtime_forever || 0), 0) / 60) : null },
      session: wdSession(id, done.length, hours) };
    setCached(ck, out, CACHE_TTL); res.json(out);
  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ error: 'steam_timeout' });
    res.status(502).json({ error: 'steam_unavailable', detail: e.message });
  }
});

// ── Servidores de Battlefield 6 (gametools) ──────────────────────────────────
// gametools devuelve como máximo 100 por consulta y sin orden garantizado: se ordena por jugadores aquí.
const BF_REGIONS = new Set(['all', 'Asia', 'Europe', 'North America', 'Oceania', 'South America']);
app.get('/bf6/servers', async (req, res) => {
  const region = BF_REGIONS.has(req.query.region) ? req.query.region : 'all';
  const q = String(req.query.q || '').trim().slice(0, 40);
  const ck = `bf6servers:${q.toLowerCase()}`;      // una consulta a gametools por búsqueda; la región se filtra aquí
  let hit = getCached(ck);
  if (hit && hit.status) return res.status(hit.status).json(hit.data);
  if (!hit) {
    try {
      const j = await steamJson(`https://api.gametools.network/bf6/servers/?name=${encodeURIComponent(q)}&limit=100&lang=en-us`, 12000);
      const list = (j.servers || []).map(x => ({
        id: x.serverId, name: x.prefix, map: x.currentMap, mode: x.mode, region: x.region,
        players: x.playerAmount || 0, max: x.maxPlayers || 0, platform: x.owner?.platform || null, img: x.url || null,
      })).sort((a, b) => b.players - a.players);
      hit = { data: { servers: list, updatedAt: Date.now() } };
      setCached(ck, hit.data, 45 * 1000);
    } catch (e) {
      const out = { error: 'servers_unavailable' }; setCached(ck, out, 15 * 1000, 502); return res.status(502).json(out);
    }
  }
  const all = hit.data.servers;
  const list = region === 'all' ? all : all.filter(x => x.region === region);
  const count = k => Object.fromEntries([...new Set(all.map(x => x[k]))].map(v => [v, all.filter(x => x[k] === v).length]));
  res.json({ servers: list, total: list.length, withPlayers: list.filter(x => x.players > 0).length,
    regions: count('region'), modes: count('mode'), updatedAt: hit.data.updatedAt });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`BF6 proxy listening on 127.0.0.1:${PORT}`);
});
