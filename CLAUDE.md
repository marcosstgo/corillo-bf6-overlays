# CLAUDE.md — corillo-bf6-overlays

> 📋 **Notas técnicas profundas en [`docs/TECHNICAL.md`](docs/TECHNICAL.md):** API de gametools
> (resuelve solo por nombre/EA ID; `playerid` roto), troubleshooting de "Player not found"
> (perfil privado por defecto), fallback EA, resiliencia del proxy, campos sin usar, screenshots headless.

## Qué es esto

Overlays de stats de Battlefield 6 para OBS. Un proxy Express en Node.js cachea llamadas a gametools.network y sirve los datos a HTMLs estáticos que los streamers usan como Browser Source.

## Estructura

```
/
├── server.js          # Proxy API + cache (Express, puerto 3011)
├── package.json
├── public/
│   ├── index.html     # Generador de overlays (UI de configuración)
│   ├── overlay.html   # Stats card (380×175)
│   ├── weapons.html   # Top weapons (380×255)
│   ├── accuracy.html  # Accuracy (380×195)
│   ├── objective.html # Objective/support (380×225)
│   ├── lowerthird.html# Barra inferior 1920×80, 4 bloques rotativos
│   └── og-bf6.png     # OG image para redes sociales
```

## Convenciones de los overlays HTML

- Cada overlay es un HTML autónomo sin dependencias externas excepto Google Fonts.
- `body` siempre con `background:transparent` para que OBS pueda hacer chroma/transparencia.
- La constante `API` apunta a `https://corillo.live/api/bf6/stats`.
- Refresh cada `INTERVAL = 60000` ms con animación de flash en el borde izquierdo.
- Error silencioso en refresh (no rompe el overlay visible), solo en primera carga muestra "Stats unavailable".
- `PLAYER` default siempre `'katat0nia'` para demo/preview en el generador.

## server.js

- Puerto `3011`, escucha solo en `127.0.0.1`.
- Cache in-memory por `cacheKey = name:platform`, TTL 5 minutos.
- Timeout a gametools: `TIMEOUT_MS = 12000`.
- Ruta: `GET /bf6/stats?name=<jugador>&platform=<plat>`.
- Pasa errores de gametools tal cual (ej. `{"error":true,"errors":["Player not found"]}`).

## Cómo agrego un overlay nuevo

1. Copia `accuracy.html` como base (es el más simple).
2. Cambia el `<title>` y la constante de `section-label`.
3. Actualiza `renderXxx(data)` para mapear los campos de la API que necesites.
4. Agrega el botón en `public/index.html` dentro del `.type-grid` con `data-type`, `data-w`, `data-h`.
5. No hay build step — nginx sirve directamente desde `public/`.

## Campos relevantes de la API de gametools.network

```js
data.kills            // total kills
data.killDeath        // K/D ratio
data.killsPerMinute   // KPM
data.damagePerMinute  // DPM
data.winPercent       // "50.72%" (string con %)
data.accuracy         // "19.25%" (string con %)
data.headshots        // "12.01%" (string con %)
data.shotsHit / data.shotsFired
data.timePlayed       // "10 days, 3:49:25" (string)
data.matchesPlayed
data.revives / data.heals / data.resupplies / data.repairs
data.killAssists / data.enemiesSpotted / data.saviorKills
data.objective.captured / data.objective.time.total / .defended
data.dividedKills.ads / .hipfire / .longDistance / .multiKills
data.weapons[]        // array: { name, kills, image, altImage, headshots, accuracy }
data.sector.captured
```

## Deploy

- Archivos en `/opt/corillo/bf6-proxy/`
- Proxy corre como servicio: `sudo systemctl restart corillo-bf6-proxy`
- Nginx sirve `public/` estático, no necesita restart al cambiar HTMLs
- Verificar: `systemctl status corillo-bf6-proxy`
