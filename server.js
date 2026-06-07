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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`BF6 proxy listening on 127.0.0.1:${PORT}`);
});
