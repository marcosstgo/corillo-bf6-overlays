# Notas técnicas — corillo-bf6-overlays

Conocimiento no obvio del proyecto, ganado depurando en producción. Complementa `CLAUDE.md`
(que cubre estructura y convenciones). Última actualización: 2026-06-12.

---

## 1. API de gametools (la fuente de datos)

Base: `https://api.gametools.network/bf6/stats/?name=<EA_ID>&platform=<plat>`

### Cómo resuelve un jugador (CRÍTICO)
- **Solo resuelve por `name`** = el **EA ID** (display name de la cuenta EA). Esto es lo único fiable.
- Params `playerid` y `nucleus_id` **existen en la spec pero están ROTOS** para BF6 (devuelven
  404/500/502 incluso con IDs válidos y conocidos — verificado con el nucleusId real de un jugador
  que sí resuelve por nombre). **No hay forma de resolver por ID numérico vía gametools** hoy.
- El `name` es **insensible a mayúsculas** (`katat0nia` == `KATAT0NIA`).
- El param `platform` importa poco: las stats viven en la partición **EA**. `platform=ea` es el default
  de los overlays y el que trae datos reales. Plataformas válidas: `ea, xbox, psn, steam, epic, pc,
  xboxone, ps4, xboxseries, ps5`.

### Endpoint de búsqueda
`GET /bf6/player/?name=<prefijo>` — devuelve `{results:[{displayName, username, platform, personaId,
nucleusId, platformId, visibility, ...}]}`.
- Es **por prefijo**, insensible a mayúsculas, **capado a ~10 resultados**.
- **Solo indexa el caché propio de gametools**, NO el directorio completo de EA. Un resultado vacío
  **NO** significa que el jugador no exista — solo que gametools nunca lo cacheó.

### Params completos de `/bf6/stats/`
`categories` (array), `raw` (bool), `format_values` (bool), `seperation` (bool), `name`, `playerid`,
`nucleus_id`, `platform`, `skip_battlelog` (bool), `lang`. Spec: https://api.gametools.network/openapi.json

### Fiabilidad
gametools es **intermitente**: se han visto latencias de ~19s, 502 y 404 transitorios que luego se
recuperan. Por eso el proxy tiene fallback EA + timeouts ajustados (ver §4).

---

## 2. Troubleshooting: "Player not found" aunque tracker.gg sí lo muestre

**Causa #1 — perfil privado (lo más común):**
Los perfiles de BF6 son **PRIVADOS por defecto**. Un perfil privado:
- ✅ Aparece en **tracker.gg** (usa su propia tubería por ID de persona, no necesita el flag de EA).
- ❌ **NO** aparece en el backend público de stats de EA → gametools y nuestros overlays devuelven
  "Player not found".

**Fix (lo hace el jugador in-game):** BF6 → menú → pestaña **Profile** → engrane **Settings** →
pestaña **System** → activar **"Gameplay Data Sharing"** y poner visibilidad del perfil en **Público**.
Jugar ≥1 partida y esperar propagación. Bug conocido de EA: a algunos el ajuste no aparece o la API
pública no se actualiza.

**Causa #2 — EA ID ≠ nombre de la plataforma:**
El EA ID NO es el nombre de Steam/PSN/Xbox. Hay que usar el **EA ID exacto** (display name del juego,
respetando mayúsculas y caracteres especiales). Jugadores que entran por Steam suelen tener un EA ID
distinto a su nombre de Steam.

**Sobre los IDs de tracker.gg:** la URL `tracker.gg/bf6/profile/<ID>/overview` usa el **personaId** de
EA (13 dígitos, formato `100...`). El `nucleusId` es el de 10 dígitos. Ninguno es usable vía gametools
ahora (ver §1). tracker.gg está detrás de Cloudflare → no se puede scrapear (403 en curl y WebFetch).

**Caso de referencia (2026-06-11):** jugador "PATAECABRA" (streamer Corillo, juega por Steam).
tracker.gg lo muestra por ID `1000868726556`, pero EA/gametools dan 404 por nombre. Diagnóstico:
perfil privado + EA ID ≠ "PATAECABRA". Sin su EA ID correcto y perfil público, no hay overlay posible.

---

## 3. Fallback de EA (`/bf6/eastats` y fallback en `/bf6/stats`)

`server.js` parsea el `__NEXT_DATA__` de `ea.com/.../player-stats/<name>`
(`props.pageProps.statsResponse.playerStatsSummary`). Se usa para:
1. Obtener el `displayName` correcto (gametools a veces devuelve nombre incorrecto).
2. Fallback cuando gametools falla.

**Limitación:** EA expone ~16 campos, no el set completo. El fallback en `/bf6/stats` mapea:
`kills, killDeath, matchesPlayed, winPercent, secondsPlayed, accuracy, headshots, killAssists,
revives, resupplies, objective.time.total` y marca `_source:'ea'`. **NO** tiene `weapons[]`, `classes[]`,
`shotsHit/shotsFired`, `sector`, `enemiesSpotted`, etc. → `weapons.html`/`classes.html` quedan vacíos
durante una caída de gametools; `accuracy`/`objective` quedan parciales pero útiles.

EA da números con coma (`"1,814"`) y porcentajes como string (`"18%"`). Usar `parseNum()` para los
números; los `%` se pasan tal cual (los overlays los manejan con `pct()`).

---

## 4. Diseño de resiliencia del proxy (`server.js`)

- `CACHE_TTL = 5min` para datos completos de gametools.
- `FALLBACK_TTL = 60s` para datos degradados de EA (no envenenan la key 5min; gametools se recupera rápido).
- `NEG_TTL = 60s` caché negativo de errores/timeouts (evita martillar upstream con "not found").
- Budget de timeout dentro del `proxy_read_timeout 15s` de nginx: gametools `9s` + EA `5s` = 14s peor caso.
- El **timeout de gametools también cae al fallback de EA** (antes devolvía 504 seco).
- `getCached`/`setCached` manejan TTL por-entrada y entradas negativas (con `status`).
- El abort de EA se marca con `err.code='EA_TIMEOUT'` para no confundirlo con el de gametools.

`sudo systemctl restart corillo-bf6-proxy` tras cambios en `server.js`. Los HTML en `public/` se sirven
en vivo (nginx `alias`, `expires 60s`) — sin restart.

---

## 5. Campos de gametools — uso

Payload completo = **70 campos**. Los overlays usan ~25. Sin aprovechar (~35), útiles para overlays
nuevos o para enriquecer:

- **Escalares exactos** (mejor que derivarlos): `deaths`, `wins`, `loses`, `assists`, `score`, `XP`,
  `damage`, `damagePerMatch`, `killsPerMatch`, `infantryKillDeath` (K/D a pie), `humanPrecentage`
  (precisión vs humanos, no bots), `vehiclesDestroyed`, `headShots` (conteo).
- **Arrays ricos** (mismo shape que `weapons[]`: nombre + imagen + kills): `classes` (5), `vehicles` (23),
  `gameModes` (16), `weaponGroups` (9), `gadgets` (52), `melee` (5).

**Nota `classes[]`:** incluye un agregado `className:'All'` (totales) que hay que **filtrar**. Trae
`deaths` y `kpm` (no `headshots`/`accuracy`). El SVG **blanco** está en `image` (no `altImage`) —
al revés que las armas. K/D por clase = `kills/deaths` (gametools no lo da por clase).

**`bf6-session.js`** usa `deaths`/`wins` reales de gametools cuando existen (`calcDeaths`/`calcWins`),
y solo deriva (`kills/KD`, `matches*win%`) si faltan (fallback EA). `lowerthird.html` tiene sus propias
copias de esas funciones — mantener ambas en sync.

---

## 6. Verificación visual (screenshot headless)

Hay `google-chrome-stable` instalado. Para capturar un overlay con datos en vivo:

```bash
google-chrome-stable --headless --no-sandbox --disable-gpu --force-device-scale-factor=2 \
  --hide-scrollbars --window-size=380,<alto> --default-background-color=00000000 \
  --screenshot=/tmp/out.png --virtual-time-budget=8000 \
  "https://corillo.live/overlay/bf6/<overlay>.html?name=JackFrags&platform=ea"
```

`JackFrags` (platform `ea`) es un jugador público fiable para pruebas. Ajustar `window-size` alto al
de la card real (medir subiéndolo hasta que el footer entre completo) y reflejarlo en el `data-h` del
botón en `index.html`.
