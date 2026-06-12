// bf6-session.js — Shared data layer for BF6 overlays
// Events fired: 'data', 'match', 'streak', 'error', 'stale', 'unstale'
(function () {
  const PERF_LABEL    = { hot: '🔥 HOT', avg: '⚡ AVG', cold: '❄ COLD' };
  const STREAK_LABELS = { fire: '🔥 ON FIRE', streak: '⚡ STREAK', clutch: '💀 CLUTCH', tilt: '❄ TILT' };
  const PB = 'https://pb.corillo.live';

  class BF6Session extends EventTarget {
    constructor({ player, platform = 'ea', storageKey, historyKey, apiBase } = {}) {
      super();
      this.player   = player;
      this.platform = platform;
      this.storageKey = storageKey || `bf6_session_${player}_${platform}`;
      this.historyKey = historyKey || `bf6_history_${player}_${platform}`;
      const base = apiBase
        || (window.BF6_CONFIG?.api ? window.BF6_CONFIG.api.replace('/bf6/stats', '') : null)
        || 'https://corillo.live/api';
      this._statsUrl    = `${base}/bf6/stats?name=${encodeURIComponent(player)}&platform=${encodeURIComponent(platform)}`;
      this._eaUrl       = `${base}/bf6/eastats?name=${encodeURIComponent(player)}`;
      this._lastData    = null;
      this._displayName = null;
      this._pollId      = null;
      this._timeoutId   = null;
      this._saveId      = null;
      this._autoResetNewDay();
    }

    // ---- static helpers ----
    static calcDeaths(d) {
      // gametools trae 'deaths' exacto; solo derivamos si falta (ej. fallback EA).
      if (d.deaths != null && d.deaths !== '') return Number(d.deaths) || 0;
      const k = Number(d.kills) || 0, kd = Number(d.killDeath) || 0;
      return kd > 0 ? Math.round(k / kd) : 0;
    }
    static calcWins(d) {
      // gametools trae 'wins' exacto; solo derivamos desde winPercent si falta.
      if (d.wins != null && d.wins !== '') return Number(d.wins) || 0;
      const m  = Number(d.matchesPlayed) || 0;
      const wp = parseFloat(String(d.winPercent).replace('%', '')) || 0;
      return Math.round(m * wp / 100);
    }
    static fmt(n, dec = 0) {
      if (n == null || isNaN(Number(n))) return '—';
      return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }
    static fmtSecs(s) {
      if (!s) return '0m';
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      return h >= 100 ? `${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    static getPerfTier(sessionKD, lifetimeKD) {
      if (!lifetimeKD) return 'avg';
      const r = sessionKD / lifetimeKD;
      return r >= 1.25 ? 'hot' : r <= 0.75 ? 'cold' : 'avg';
    }
    static get PERF_LABEL()    { return PERF_LABEL; }
    static get STREAK_LABELS() { return STREAK_LABELS; }

    // ---- storage ----
    getBaseline() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || null; } catch { return null; } }
    saveBaseline(data) {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify({
          kills:      Number(data.kills) || 0,
          deaths:     BF6Session.calcDeaths(data),
          matches:    Number(data.matchesPlayed) || 0,
          wins:       BF6Session.calcWins(data),
          seconds:    Number(data.secondsPlayed) || 0,
          lifetimeKD: Number(data.killDeath) || 0,
          startedAt:  Date.now(),
        }));
      } catch {}
    }
    getHistory() { try { return JSON.parse(localStorage.getItem(this.historyKey)) || []; } catch { return []; } }
    addToHistory(entry) {
      try {
        const h = this.getHistory();
        h.push(entry);
        if (h.length > 5) h.shift();
        localStorage.setItem(this.historyKey, JSON.stringify(h));
      } catch {}
    }
    clearStorage() {
      try { localStorage.removeItem(this.storageKey); localStorage.removeItem(this.historyKey); } catch {}
    }

    // ---- session deltas ----
    getDeltas(data, bl) {
      bl = bl || this.getBaseline();
      if (!bl) return null;
      const kills   = Math.max(0, (Number(data.kills) || 0) - bl.kills);
      const deaths  = Math.max(0, BF6Session.calcDeaths(data) - bl.deaths);
      const matches = Math.max(0, (Number(data.matchesPlayed) || 0) - bl.matches);
      const wins    = Math.max(0, BF6Session.calcWins(data) - bl.wins);
      const losses  = Math.max(0, matches - wins);
      const seconds = Math.max(0, (Number(data.secondsPlayed) || 0) - bl.seconds);
      const kdNum   = deaths > 0 ? kills / deaths : kills > 0 ? 99 : 0;
      const lifetimeKD = Number(data.killDeath) || bl.lifetimeKD || 0;
      return { kills, deaths, matches, wins, losses, seconds, kdNum, lifetimeKD };
    }

    // ---- PocketBase persistence ----
    _buildPayload() {
      if (!this._lastData) return null;
      const bl = this.getBaseline();
      if (!bl) return null;
      const d = this.getDeltas(this._lastData, bl);
      if (d.matches === 0 && d.kills === 0) return null;
      return {
        player:        this._displayName || this._lastData.userName || this.player,
        platform:      this.platform,
        kills:         d.kills,
        deaths:        d.deaths,
        kd:            Math.round(d.kdNum * 100) / 100,
        wins:          d.wins,
        losses:        d.losses,
        matches:       d.matches,
        seconds:       d.seconds,
        lifetime_kd:   d.lifetimeKD,
        match_history: this.getHistory(),
        started_at:    new Date(bl.startedAt).toISOString(),
      };
    }
    async saveSession() {
      const payload = this._buildPayload();
      if (!payload) return;
      try {
        await fetch(`${PB}/api/collections/bf6_sessions/records`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      } catch (e) { console.warn('bf6 session save:', e.message); }
    }

    // ---- auto-reset new day ----
    _autoResetNewDay() {
      try {
        const bl = JSON.parse(localStorage.getItem(this.storageKey));
        if (bl?.startedAt && new Date(bl.startedAt).toDateString() !== new Date().toDateString()) {
          this.clearStorage();
        }
      } catch {}
    }

    // ---- streak detection ----
    _detectStreak(prev, cur) {
      const dk = Math.max(0, (Number(cur.kills) || 0) - (Number(prev.kills) || 0));
      const dd = Math.max(0, BF6Session.calcDeaths(cur) - BF6Session.calcDeaths(prev));
      let type = null;
      if      (dk >= 5 && dd === 0)               type = 'fire';
      else if (dk >= 3 && dd === 0)               type = 'streak';
      else if (dk >= 3 && dd > 0 && dk / dd >= 3) type = 'clutch';
      else if (dd >= 4 && dk <= 1)                type = 'tilt';
      if (type) this.dispatchEvent(new CustomEvent('streak', { detail: { type } }));
    }

    // ---- fetch ----
    async _fetch(isRefresh = false) {
      try {
        const [res, eaRes] = await Promise.all([
          fetch(this._statsUrl),
          fetch(this._eaUrl).catch(() => null),
        ]);
        if (eaRes?.ok) {
          const eaData = await eaRes.json().catch(() => null);
          if (eaData?.displayName) this._displayName = eaData.displayName;
        }
        const data = await res.json();
        if (!res.ok || data.error) {
          const msg  = (data?.errors?.[0]?.message || data?.message || '').toLowerCase();
          const type = (res.status === 404 || msg.includes('not found')) ? 'not_found'
            : (res.status >= 502) ? 'timeout' : 'generic';
          if (isRefresh && this._lastData) { this.dispatchEvent(new CustomEvent('stale')); return; }
          this.dispatchEvent(new CustomEvent('error', { detail: { type } }));
          return;
        }

        if (!this.getBaseline()) this.saveBaseline(data);
        const bl = this.getBaseline();

        if (this._lastData) {
          const prevM = Math.max(0, (Number(this._lastData.matchesPlayed) || 0) - bl.matches);
          const curM  = Math.max(0, (Number(data.matchesPlayed) || 0) - bl.matches);
          if (curM > prevM) {
            const prevKills  = Math.max(0, (Number(this._lastData.kills) || 0) - bl.kills);
            const curKills   = Math.max(0, (Number(data.kills) || 0) - bl.kills);
            const prevDeaths = Math.max(0, BF6Session.calcDeaths(this._lastData) - bl.deaths);
            const curDeaths  = Math.max(0, BF6Session.calcDeaths(data) - bl.deaths);
            const matchKills  = Math.max(0, curKills  - prevKills);
            const matchDeaths = Math.max(0, curDeaths - prevDeaths);
            const isWin = BF6Session.calcWins(data) - bl.wins > BF6Session.calcWins(this._lastData) - bl.wins;
            this.addToHistory({ win: isWin, kills: matchKills, deaths: matchDeaths });
            this.dispatchEvent(new CustomEvent('match', { detail: { win: isWin, matchKills, matchDeaths } }));
          } else {
            this._detectStreak(this._lastData, data);
          }
        }

        this._lastData = data;
        const deltas = this.getDeltas(data, bl);
        const tier   = BF6Session.getPerfTier(deltas.kdNum, deltas.lifetimeKD);
        if (isRefresh) this.dispatchEvent(new CustomEvent('unstale'));
        this.dispatchEvent(new CustomEvent('data', { detail: {
          data,
          baseline:    bl,
          deltas,
          tier,
          displayName: this._displayName || data.userName || this.player,
          history:     this.getHistory(),
          isRefresh,
        }}));
      } catch (e) {
        if (isRefresh && this._lastData) { this.dispatchEvent(new CustomEvent('stale')); return; }
        this.dispatchEvent(new CustomEvent('error', { detail: { type: 'timeout' } }));
        console.warn('BF6Session fetch:', e.message);
      }
    }

    // ---- lifecycle ----
    start({ interval = 60000, timeoutMs = 15000 } = {}) {
      if (new URLSearchParams(location.search).get('reset') === '1') this.clearStorage();
      this._fetch();
      this._pollId    = setInterval(() => this._fetch(true), interval);
      this._timeoutId = setTimeout(() => {
        if (!this._lastData) this.dispatchEvent(new CustomEvent('error', { detail: { type: 'timeout' } }));
      }, timeoutMs);
      this._saveId = setInterval(() => this.saveSession(), 30 * 60 * 1000);
      window.addEventListener('beforeunload', () => this.saveSession());
    }
    stop() {
      clearInterval(this._pollId);
      clearTimeout(this._timeoutId);
      clearInterval(this._saveId);
    }

    get lastData()    { return this._lastData; }
    get displayName() { return this._displayName; }
  }

  window.BF6Session = BF6Session;
})();
