# corillo-bf6-overlays

Stats overlays en vivo para Battlefield 6, diseñados para OBS. Gratis, sin registro, datos de [gametools.network](https://gametools.network).

**Live:** [corillo.live/overlay/bf6/](https://corillo.live/overlay/bf6/)

---

## Overlays disponibles

| Overlay | Archivo | Dimensiones | Descripción |
|---|---|---|---|
| Stats | `overlay.html` | 380 × 175 | Kills, K/D, DPM, KPM, Win Rate, Matches |
| Armas | `weapons.html` | 380 × 255 | Top 5 armas con barras, HS% y accuracy |
| Accuracy | `accuracy.html` | 380 × 195 | Accuracy global, headshots, ADS/hipfire/larga dist. |
| Objective | `objective.html` | 380 × 225 | Obj capturados, tiempo, revives, heals, resupplies |
| Lower Third | `lowerthird.html` | 1920 × 80 | Barra inferior con 4 bloques rotativos (8s c/u) |

### URL format

```
https://corillo.live/overlay/bf6/<archivo>.html?name=<jugador>&platform=<plat>
```

**Plataformas:** `ea` `steam` `psn` `xbox` `ps5` `epic`

**Ejemplo:**
```
https://corillo.live/overlay/bf6/overlay.html?name=katat0nia&platform=ea
```

### Parámetros opcionales

- `weapons.html` acepta `?top=3` para mostrar solo las 3 armas principales (default: 5)

---

## Uso en OBS

1. Agregar fuente → **Browser Source**
2. Pegar la URL generada en [corillo.live/overlay/bf6/](https://corillo.live/overlay/bf6/)
3. Configurar las dimensiones exactas de la tabla de arriba
4. Activar **Allow Transparency**

---

## Arquitectura

```
OBS Browser Source
      │
      ▼
nginx (corillo.live)
  /overlay/bf6/  →  archivos estáticos en /opt/corillo/bf6-proxy/public/
  /api/bf6/      →  proxy_pass 127.0.0.1:3011

      │ fetch cada 60s
      ▼
server.js (Express, puerto 3011)
  - Cache in-memory: 5 minutos por jugador
  - Timeout upstream: 12 segundos
  - Reenvía errores de gametools tal cual

      │
      ▼
api.gametools.network/bf6/stats/
```

### Stack

- **Frontend:** HTML + CSS + JS vanilla, sin frameworks ni build step
- **Fuentes:** Google Fonts — Barlow Condensed + Share Tech Mono
- **Backend:** Node.js + Express (proxy + cache)
- **Datos:** gametools.network (API pública, sin key)
- **Deploy:** systemd service (`corillo-bf6-proxy.service`) + nginx static serving

---

## Desarrollo local

```bash
git clone https://github.com/marcosstgo/corillo-bf6-overlays.git
cd corillo-bf6-overlays
npm install
node server.js
```

El proxy queda en `http://localhost:3011`. Para ver los overlays, abre los HTML directamente en el browser o usa un servidor estático:

```bash
npx serve public/
```

Los overlays apuntan a `https://corillo.live/api/bf6/stats` hardcodeado. Para desarrollo local, cambia temporalmente la constante `API` en cada HTML a `http://localhost:3011/bf6/stats`.

---

## Deploy en producción

**Servicio systemd** (`/etc/systemd/system/corillo-bf6-proxy.service`):
```ini
[Unit]
Description=CORILLO BF6 Stats Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/corillo/bf6-proxy
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**nginx** (`/etc/nginx/nginx.conf`):
```nginx
# API proxy
location ^~ /api/bf6/ {
    rewrite ^/api/(.*) /$1 break;
    proxy_pass http://127.0.0.1:3011;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 15s;
}

# Archivos estáticos
location ^~ /overlay/bf6/ {
    alias /opt/corillo/bf6-proxy/public/;
    add_header Access-Control-Allow-Origin *;
    expires 60s;
}
```

**Después de cambios en server.js:**
```bash
sudo systemctl restart corillo-bf6-proxy
```

**Después de cambios en public/:**  
Nginx sirve directo del filesystem — no requiere restart.

---

## Ideas / roadmap

- [ ] Parámetro `?refresh=<segundos>` por overlay para controlar intervalo de actualización
- [ ] Overlay de sesión (stats de la partida actual vía polling agresivo)
- [ ] Tema alternativo (modo claro, colores custom)
- [ ] Soporte para múltiples jugadores en Lower Third (toggle entre jugadores)
- [ ] Stats de partida anterior (inRound data)
- [ ] Overlay `kills-feed` para mostrar kills recientes

---

## Créditos

- Datos: [gametools.network](https://gametools.network)
- Parte de [CORILLO.LIVE](https://corillo.live) — plataforma de streaming para la comunidad
