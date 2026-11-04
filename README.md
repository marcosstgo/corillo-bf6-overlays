# corillo-bf6-overlays

Overlays de stats en vivo para OBS: **Battlefield 6** y **WARDOGS**. Gratis, sin registro.

> **4-nov-2026:** las portadas (`/overlay/`, `/overlay/bf6/`, `/overlay/wardogs/`) ahora son páginas del sitio, en `src/pages/overlay/` del repo `corillo`. `publicar_corillo.sh` descarta `hub/index.html`, `public/index.html` y `public/wardogs/index.html` de este repo, así que esos tres ya no se publican. Los overlays para OBS siguen saliendo de aquí.

**Live:** [corillo.live/overlay/](https://corillo.live/overlay/) — portada con los dos juegos
- [corillo.live/overlay/bf6/](https://corillo.live/overlay/bf6/) — generador de BF6 + servidores en vivo
- [corillo.live/overlay/wardogs/](https://corillo.live/overlay/wardogs/) — generador de WARDOGS + datos del juego

---

## Overlays disponibles

### Battlefield 6 (datos vía [gametools.network](https://gametools.network), con fallback a EA)

| Overlay | Archivo | Dimensiones | Descripción |
|---|---|---|---|
| Stats | `overlay.html` | 380 × 240 | K/D, kills, win rate, KPM y DPM |
| Armas | `weapons.html` | 380 × 300 | Tus 5 mejores armas con barras y % de headshots |
| Clases | `classes.html` | 380 × 260 | Kills, K/D y KPM por clase |
| Precisión | `accuracy.html` | 380 × 280 | Precisión, headshots, ADS y hipfire |
| Objetivo | `objective.html` | 380 × 280 | Capturas, tiempo en objetivo, revives y asistencias |
| Sesión | `session.html` | 380 × 275 | Kills y K/D desde que abriste OBS |
| Temporada | `season.html` | 380 × 225 | K/D, win% y clase favorita (datos oficiales de EA) |
| Forma reciente | `recent.html` | 380 × 275 | K/D de tus últimas 5 partidas |
| Barra inferior | `lowerthird.html` | 1920 × 80 | Barra con 5 bloques que rotan |
| Panel completo | `dashboard.html` | 1920 × 1080 | Combate, precisión, objetivo, armas y sesión |
| Multijugador | `multi.html` | variable | Stats lado a lado de 2 a 4 jugadores (`?names=a,b,c&platforms=ea,steam,ea`) |

```
https://corillo.live/overlay/bf6/<archivo>.html?name=<jugador>&platform=<plataforma>
```

**Plataformas:** `ea` `steam` `psn` `xbox` `ps5` `epic` — el `name` es el EA ID exacto (no el nombre de Steam/PSN/Xbox). Perfiles privados por defecto en BF6 dan "Player not found"; hay que activar *Gameplay Data Sharing* + perfil público en el juego.

**Servidores en vivo:** `corillo.live/overlay/bf6/` también lista los servidores de BF6 con más jugadores ahora mismo, con filtro por región y búsqueda (`GET /bf6/servers?region=&q=`).

### WARDOGS (datos vía Steam Web API)

| Overlay | Archivo | Dimensiones | Necesita `?steamid=` |
|---|---|---|---|
| Jugadores en vivo | `pulse.html` | 380 × 210 | No |
| Comunidad | `community.html` | 380 × 225 | No (`?lang=es` para reseñas en español) |
| Logros del juego | `achievements.html` | 380 × 395 | No |
| Tu perfil | `profile.html` | 380 × 260 | Sí |
| Tus logros | `achievements.html?steamid=` | 380 × 400 | Sí |
| Tarjeta de Steam | `steam.html` | 380 × 262 | Sí |
| Alerta de logro | `alert.html` | 480 × 130 | Sí (`?test=1` para una vista de ejemplo) |
| Barra inferior | `lowerthird.html` | 1920 × 80 | Sí |

```
https://corillo.live/overlay/wardogs/<archivo>.html?steamid=<usuario o URL de Steam>
```

Steam solo expone horas jugadas, logros (con % de jugadores que los tiene), si el jugador está en partida y datos públicos del juego — **no hay kills, K/D ni partidas** (Bulkhead no ofrece una API pública de perfiles). Requiere que el perfil de Steam y sus "detalles del juego" estén en público.

---

## Uso en OBS

1. Entra a [corillo.live/overlay/](https://corillo.live/overlay/), elige el juego y el overlay, escribe tu usuario.
2. Copia el enlace generado.
3. En OBS: Fuentes → **Fuente de navegador**, pega el enlace, usa el tamaño exacto de la tabla.
4. El fondo ya es transparente — no hace falta activar nada más.

---

## Arquitectura

```
OBS Browser Source
      │
      ▼
nginx (corillo.live)
  /overlay/           →  hub/                      (portada)
  /overlay/bf6/        →  public/                   (generador BF6 + overlays + servidores)
  /overlay/wardogs/    →  public/wardogs/           (generador WARDOGS + overlays)
  /api/bf6/            →  proxy_pass 127.0.0.1:3011

      │
      ▼
server.js (Express, puerto 3011, solo 127.0.0.1)
  - Cache in-memory por endpoint (TTL varía: 60s players, 5-10min stats/game, 25s achievements)
  - BF6: gametools.network (primario) con fallback a EA si gametools falla/timeout
  - WARDOGS: Steam Web API (requiere STEAM_API_KEY en el entorno del servicio)
  - Historia de jugadores simultáneos persistida en disco (StateDirectory de systemd)
```

### Endpoints del proxy

```
GET /bf6/stats?name=&platform=       stats de un jugador de BF6 (gametools + fallback EA)
GET /bf6/eastats?name=               datos oficiales de temporada (solo EA)
GET /bf6/players                     jugadores de BF6 en Steam ahora, con historia
GET /bf6/servers?region=&q=          servidores de BF6 en vivo (gametools)
GET /bf6/wardogs/players             jugadores de WARDOGS en Steam ahora, con historia
GET /bf6/wardogs/game                reseñas, precio, logros con rareza, noticias oficiales
GET /bf6/wardogs/achievements?steamid=   logros desbloqueados de un jugador (para la alerta)
GET /bf6/wardogs/profile?steamid=    perfil completo de un jugador de WARDOGS
```

### Stack

- **Frontend:** HTML + CSS + JS vanilla, sin frameworks ni build step.
- **Fuentes:** Google Fonts — Barlow Condensed (overlays) + Bricolage Grotesque/DM Sans (páginas del hub).
- **Backend:** Node.js + Express (proxy + cache), dependencia única.
- **Deploy:** systemd (`corillo-bf6-proxy.service`, corre como `www-data`) + nginx sirviendo `public/` y `hub/` como estáticos.

---

## Desarrollo local

```bash
git clone https://github.com/marcosstgo/corillo-bf6-overlays.git
cd corillo-bf6-overlays
npm install
STEAM_API_KEY=tu_llave node server.js   # la llave es opcional; sin ella, los overlays de WARDOGS que no piden usuario siguen funcionando
```

El proxy queda en `http://localhost:3011`. Para ver los overlays, sirve `public/`, `public/wardogs/` y `hub/` como estáticos (por ejemplo `npx serve .`) y cambia la constante `API` de cada HTML (o `window.BF6_CONFIG` en `public/config.js`) a tu proxy local.

---

## Deploy en producción

**Servicio systemd** (`/etc/systemd/system/corillo-bf6-proxy.service`, con un drop-in `steam.conf` que carga `STEAM_API_KEY` desde `/etc/corillo-bf6-proxy.env` y declara `StateDirectory=corillo-bf6-proxy`):

```bash
sudo systemctl restart corillo-bf6-proxy   # después de cambios en server.js
```

Después de cambios en `public/` o `hub/`: nginx sirve directo del filesystem, no requiere restart.

---

## Créditos

- Datos de BF6: [gametools.network](https://gametools.network) y EA.
- Datos de WARDOGS: Steam Web API.
- Parte de [CORILLO.LIVE](https://corillo.live) — plataforma de streaming independiente de Puerto Rico.
