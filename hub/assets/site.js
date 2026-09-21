/* Ayudas compartidas de las páginas /overlay (portada, BF6 y WARDOGS). */
(function () {
  const OV = window.OV = {};
  OV.API = '/api/bf6/';
  OV.ORIGIN = location.origin;
  OV.fmt = n => n == null ? '—' : Number(n).toLocaleString('en-US');
  OV.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  OV.$ = (s, r) => (r || document).querySelector(s);
  OV.json = async path => {
    const r = await fetch(OV.API + path); const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || r.status); e.data = d; e.status = r.status; throw e; }
    return d;
  };

  // Overlay real incrustado: un <iframe> a tamaño nativo, escalado para caber en su contenedor.
  OV.frame = (el, url, w, h) => {
    el.classList.add('ovf'); el.dataset.w = w; el.dataset.h = h;
    let f = el.querySelector('iframe');
    if (!f) { f = document.createElement('iframe'); f.setAttribute('scrolling', 'no'); f.setAttribute('title', 'Vista previa en vivo del overlay'); f.loading = 'lazy'; el.appendChild(f); }
    if (f.dataset.url !== url) { f.src = url; f.dataset.url = url; }
    OV.fit(el);
  };
  OV.fit = el => {
    const w = +el.dataset.w, h = +el.dataset.h, f = el.querySelector('iframe'); if (!f) return;
    el.style.maxWidth = w + 'px';
    const k = Math.min(1, el.clientWidth / w);
    f.style.width = w + 'px'; f.style.height = h + 'px'; f.style.transform = `scale(${k})`;
    el.style.height = Math.round(h * k) + 'px';
  };
  const ro = 'ResizeObserver' in window ? new ResizeObserver(es => es.forEach(e => e.target.classList.contains('ovf') && OV.fit(e.target))) : null;
  OV.watch = el => ro && ro.observe(el);
  addEventListener('resize', () => document.querySelectorAll('.ovf').forEach(OV.fit));

  OV.copy = (btn, text) => navigator.clipboard.writeText(text).then(() => {
    const t = btn.dataset.label || btn.textContent; btn.dataset.label = t;
    btn.textContent = '¡Copiado!'; btn.classList.add('ok'); setTimeout(() => { btn.textContent = t; btn.classList.remove('ok'); }, 1800);
  }).catch(() => { prompt('Copia este enlace:', text); });

  // Gráfica de línea con relleno (valores → SVG). Sin ejes: la escala va en los rótulos de la página.
  OV.spark = (vals, color) => {
    if (!vals || vals.length < 2) return '<div class="cap" style="padding:38px 0;text-align:center">Reuniendo datos… la gráfica aparece en unos minutos.</div>';
    const W = 600, H = 150, pad = 8, lo = Math.min(...vals), hi = Math.max(...vals);
    const r = Math.max(hi - lo, hi * 0.04) || 1, mn = lo - (r - (hi - lo)) / 2;   // rango mínimo: una variación de 0.1 % no debe verse como un desplome
    const pts = vals.map((n, i) => [i / (vals.length - 1) * W, H - pad - (n - mn) / r * (H - pad * 2)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const id = 'g' + Math.random().toString(36).slice(2, 7), last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Jugadores en las últimas horas">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".38"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <path d="${line} L${W} ${H} L0 ${H} Z" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="5" fill="${color}" vector-effect="non-scaling-stroke"/></svg>`;
  };
})();
