/* player.js — CamStudio Room PLAYER (v1.1.0 | MULTIVIEW + GEO/TIME/WEATHER)
   ✅ Multiview: 1/2/4/6/9 + custom
   ✅ Slots independientes (PLAY por slot, no pisa los demás)
   ✅ Hora local (si hay tz) + clima (si hay lat/lon, Open-Meteo)
   ✅ Catálogo override (localStorage) + fallback a ./cams.json
   ✅ Compat: acepta comandos antiguos (PLAY_ID/NEXT/PREV/STOP)
*/
(() => {
  "use strict";

  const APP = {
    name: "CamStudioRoom",
    ver: "1.1.0",
    protocol: 1,
    camsUrl: "./cams.json",
  };

  // Helpers
  const $ = (id) => document.getElementById(id);
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const nowMs = () => Number(Date.now()); // no bitwise

  const randId = (len = 12) => {
    const a = new Uint8Array(len);
    try { crypto?.getRandomValues?.(a); } catch {}
    for (let i = 0; i < a.length; i++) if (a[i] === 0) a[i] = (Math.random() * 255) | 0;
    return [...a].map(x => (x % 36).toString(36)).join("");
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function parseParams() {
    const qp = new URLSearchParams(location.search);
    const key = (qp.get("key") || "main").trim() || "main";
    const autoplay = qp.get("autoplay") === "1";
    const startId = (qp.get("id") || "").trim(); // slot activo
    const mute = qp.get("mute") === "1";
    const mode = (qp.get("mode") || "").trim(); // manual | rotate
    const tag = (qp.get("tag") || "").trim();
    const layout = clamp(parseInt(qp.get("layout") || "1", 10) || 1, 1, 12);
    return { key, autoplay, startId, mute, mode, tag, layout };
  }

  const P = parseParams();

  // UI
  const UI = {
    subline: $("subline"),
    nowName: $("nowName"),
    nowMeta: $("nowMeta"),
    txtKey: $("txtKey"),
    toast: $("toast"),
    playerArea: $("playerArea"),
    stage: $("stage"),

    dotConn: $("dotConn"),
    txtConn: $("txtConn"),

    dotMode: $("dotMode"),
    txtMode: $("txtMode"),

    dotLive: $("dotLive"),
    txtLive: $("txtLive"),

    sigText: $("sigText"),
    sigBars: $("sigBars"),

    btnFs: $("btnFs"),
    btnMute: $("btnMute"),
    txtMute: $("txtMute"),
    btnStop: $("btnStop"),
  };

  UI.txtKey.textContent = P.key;

  const UI_MUTE_ICON = UI.btnMute?.querySelector("span") || null;

  function toast(msg, ms = 2200) {
    if (!UI.toast) return;
    UI.toast.textContent = String(msg || "");
    UI.toast.classList.add("show");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => UI.toast.classList.remove("show"), ms);
  }

  function setConn(ok, label) {
    UI.dotConn.className = "dot " + (ok ? "good" : "warn");
    UI.txtConn.textContent = label || (ok ? "Control: conectado" : "Control: esperando");
  }

  function setModeLabel(mode) {
    const isRotate = mode === "rotate";
    UI.dotMode.className = "dot " + (isRotate ? "good" : "");
    UI.txtMode.textContent = "Modo: " + (isRotate ? "rotación" : "manual");
  }

  function setLive(on) {
    UI.dotLive.className = "dot " + (on ? "good" : "");
    UI.txtLive.textContent = on ? "LIVE" : "OFF";
  }

  function setSignal(level, text) {
    UI.sigBars.className = "bars " + (level || "");
    UI.sigText.textContent = text || "idle";
  }

  // Message bus
  const BUS_NAME = "camstudio_bus";
  const LS_CMD = `camstudio_cmd:${P.key}`;
  const LS_STATE = `camstudio_state:${P.key}`;
  const LS_LAST = `camstudio_last:${P.key}`;
  const LS_CAMS_OVERRIDE = `camstudio_cams_override:${P.key}`;

  let bc = null;
  try { bc = new BroadcastChannel(BUS_NAME); } catch { bc = null; }

  const seen = new Map(); // nonce -> ts
  function seenRecently(nonce, ts) {
    const t = seen.get(nonce);
    if (t && Math.abs(ts - t) < 30_000) return true;
    seen.set(nonce, ts);
    if (seen.size > 300) {
      const cut = nowMs() - 60_000;
      for (const [k, v] of seen) if (v < cut) seen.delete(k);
    }
    return false;
  }

  // Catalog
  const CATALOG = { list: [], byId: new Map(), meta: {} };

  function readOverrideCatalog() {
    try {
      const raw = localStorage.getItem(LS_CAMS_OVERRIDE);
      if (!raw) return null;
      const json = JSON.parse(raw);
      const cams = Array.isArray(json?.cams) ? json.cams : null;
      if (!cams) return null;
      return json;
    } catch {
      return null;
    }
  }

  function normalizeCamObj(c) {
    if (!c || typeof c !== "object") return null;
    if (c.disabled) return null;

    const id = String(c.id || "").trim();
    const kind = String(c.kind || "").trim();
    const src = String(c.src || "").trim();
    if (!id || !kind || !src) return null;

    const tags = Array.isArray(c.tags) ? c.tags.map(String).filter(Boolean) : [];

    const num = (v, def = null) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };

    return {
      id,
      title: String(c.title || id),
      kind,
      src,
      tags,
      region: String(c.region || ""), // ISO country code, ej: ES
      priority: num(c.priority, 0) ?? 0,
      weight: num(c.weight, 1) ?? 1,
      thumb: String(c.thumb || ""),
      fallback: Array.isArray(c.fallback) ? c.fallback.map(String).filter(Boolean) : [],

      // NUEVO (opcional)
      city: String(c.city || ""),
      country: String(c.country || ""),
      continent: String(c.continent || ""),
      tz: String(c.tz || ""),
      lat: num(c.lat, null),
      lon: num(c.lon, null),
    };
  }

  async function loadCams({ soft = false } = {}) {
    UI.subline.textContent = "Cargando catálogo…";
    setSignal("warn", "loading catalog");

    try {
      const override = readOverrideCatalog();
      let json = null;

      if (override) {
        json = override;
      } else {
        const res = await fetch(APP.camsUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        json = await res.json();
      }

      const cams = Array.isArray(json?.cams) ? json.cams : (Array.isArray(json) ? json : []);
      const meta = json?.meta || {};
      const clean = [];

      for (const c of cams) {
        const cam = normalizeCamObj(c);
        if (!cam) continue;
        clean.push(cam);
      }

      clean.sort((a, b) => (b.priority - a.priority) || a.title.localeCompare(b.title));
      CATALOG.list = clean;
      CATALOG.byId = new Map(clean.map(c => [c.id, c]));
      CATALOG.meta = meta;

      UI.subline.textContent = `Catálogo listo • ${clean.length} cams${override ? " (override)" : ""}`;
      setSignal("good", "catalog OK");
      return true;
    } catch (err) {
      UI.subline.textContent = soft ? "Catálogo previo (fallback)" : "Error cargando catálogo";
      setSignal("bad", "catalog failed");
      console.warn("[player] loadCams failed:", err);
      return false;
    }
  }

  // Location helpers
  const dnCountry = (() => {
    try { return new Intl.DisplayNames(["es"], { type: "region" }); } catch { return null; }
  })();

  // mapping mínimo (puedes ampliarlo cuando quieras)
  const COUNTRY_TO_CONT = {
    ES: "Europa", PT: "Europa", FR: "Europa", IT: "Europa", DE: "Europa", UK: "Europa", IE: "Europa", NL: "Europa", BE: "Europa",
    US: "Norteamérica", CA: "Norteamérica", MX: "Norteamérica",
    BR: "Sudamérica", AR: "Sudamérica", CL: "Sudamérica", CO: "Sudamérica", PE: "Sudamérica", UY: "Sudamérica", VE: "Sudamérica",
    JP: "Asia", CN: "Asia", KR: "Asia", TW: "Asia", IN: "Asia", TH: "Asia", VN: "Asia", SG: "Asia",
    AU: "Oceanía", NZ: "Oceanía",
    ZA: "África", NG: "África", EG: "África", MA: "África", KE: "África",
  };

  function inferCityFromTitle(title) {
    const t = String(title || "");
    const parts = t.split("•").map(s => s.trim()).filter(Boolean);
    if (!parts.length) return "";
    // "Tokyo • Shibuya Crossing" => city "Tokyo"
    return parts[0] || "";
  }

  function countryNameFromRegion(region) {
    const r = String(region || "").toUpperCase().trim();
    if (!r) return "";
    if (dnCountry) {
      try { return dnCountry.of(r) || r; } catch { return r; }
    }
    return r;
  }

  function continentFromCam(cam) {
    if (cam.continent) return cam.continent;
    const r = String(cam.region || "").toUpperCase().trim();
    return COUNTRY_TO_CONT[r] || "";
  }

  function formatLocalTime(tz) {
    const z = String(tz || "").trim();
    if (!z) return "";
    try {
      const d = new Date();
      return new Intl.DateTimeFormat("es-ES", {
        timeZone: z,
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).format(d);
    } catch {
      return "";
    }
  }

  // Weather (Open-Meteo)
  const Weather = {
    cache: new Map(), // key -> { ts, data }
    async get(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      const hit = this.cache.get(key);
      if (hit && (nowMs() - hit.ts) < 10 * 60_000) return hit.data; // 10 min

      try {
        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true&timezone=auto`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();

        const cw = j?.current_weather;
        if (!cw) return null;

        const data = {
          temp: Number.isFinite(+cw.temperature) ? +cw.temperature : null,
          wind: Number.isFinite(+cw.windspeed) ? +cw.windspeed : null,
          code: Number.isFinite(+cw.weathercode) ? +cw.weathercode : null,
          tz: String(j?.timezone || ""),
        };

        this.cache.set(key, { ts: nowMs(), data });
        return data;
      } catch (e) {
        console.warn("[weather] fail", e);
        return null;
      }
    }
  };

  function weatherLabel(code) {
    const c = Number(code);
    if (!Number.isFinite(c)) return "";
    // mapping simple Open-Meteo codes
    if (c === 0) return "☀️ Despejado";
    if (c === 1 || c === 2) return "🌤️ Poco nuboso";
    if (c === 3) return "☁️ Nuboso";
    if (c === 45 || c === 48) return "🌫️ Niebla";
    if ([51,53,55,56,57].includes(c)) return "🌦️ Llovizna";
    if ([61,63,65,66,67].includes(c)) return "🌧️ Lluvia";
    if ([71,73,75,77].includes(c)) return "🌨️ Nieve";
    if ([80,81,82].includes(c)) return "🌧️ Chubascos";
    if ([95,96,99].includes(c)) return "⛈️ Tormenta";
    return "🌡️ Meteo";
  }

  // Multiview State
  const STATE = {
    mode: "manual", // manual|rotate (aplica al slot activo)
    rotate: { enabled: false, intervalSec: 40, kind: "any", tag: "" },

    layoutN: clamp(P.layout, 1, 12),
    activeSlot: 0,
    lastError: "",
    lastControlSeenAt: 0,

    publicState() {
      return {
        app: { name: APP.name, ver: APP.ver, protocol: APP.protocol },
        mode: this.mode,
        rotate: { ...this.rotate },
        layoutN: this.layoutN,
        activeSlot: this.activeSlot,
        muted: !!PLAY.muted,
        lastError: String(this.lastError || ""),
        slots: SLOTS.map(s => ({
          id: s.cam?.id || null,
          title: s.cam?.title || null,
          kind: s.cam?.kind || null,
          region: s.cam?.region || null,
          city: s.cam?.city || inferCityFromTitle(s.cam?.title || ""),
          tz: s.tz || s.cam?.tz || null,
          playing: !!s.alive,
          failCount: s.failCount || 0,
          lastGoodAt: s.lastGoodAt || 0,
        })),
        seenControlAgoMs: this.lastControlSeenAt ? (nowMs() - this.lastControlSeenAt) : null,
      };
    }
  };

  const PLAY = {
    muted: !!P.mute,
    rotateTimer: 0,
  };

  function setMuted(m) {
    PLAY.muted = !!m;
    UI.txtMute.textContent = PLAY.muted ? "Unmute" : "Mute";
    if (UI_MUTE_ICON) UI_MUTE_ICON.textContent = PLAY.muted ? "🔇" : "🔊";
    for (const s of SLOTS) s.player?.setMuted(PLAY.muted);
    emitState();
  }

  function setNowUIFromActive(extra = "") {
    const s = SLOTS[STATE.activeSlot];
    const cam = s?.cam || null;
    if (!cam) {
      UI.nowName.textContent = `Slot ${STATE.activeSlot + 1} • Sin señal`;
      UI.nowMeta.textContent = extra || "Selecciona una cámara desde el panel de control.";
      setLive(false);
      return;
    }
    const tags = cam.tags?.length ? `#${cam.tags.join(" #")}` : "";
    const region = cam.region ? ` · ${cam.region}` : "";
    UI.nowName.textContent = `Slot ${STATE.activeSlot + 1} • ${cam.title || cam.id}`;
    UI.nowMeta.textContent =
      `${cam.kind.toUpperCase()} · ID: ${cam.id}${region}${tags ? " · " + tags : ""}${extra ? " · " + extra : ""}`;
    setLive(!!s.alive);
  }

  // Emit state + ACK
  function emitState(extra = {}) {
    const payload = {
      v: APP.protocol,
      key: P.key,
      ts: nowMs(),
      nonce: randId(12),
      from: "player",
      type: "STATE",
      state: { ...STATE.publicState(), ...extra }
    };
    try { bc?.postMessage(payload); } catch {}
    try { localStorage.setItem(LS_STATE, JSON.stringify(payload)); } catch {}
  }

  function sendAck(cmdNonce, ok = true, note = "") {
    emitState({ ack: { cmdNonce, ok: !!ok, note: String(note || "") } });
  }

  // Layout builder
  let SLOTS = [];

  function setGridClass(n) {
    UI.playerArea.classList.remove("layout-1","layout-2","layout-4","layout-6","layout-9");
    if ([1,2,4,6,9].includes(n)) UI.playerArea.classList.add(`layout-${n}`);
    else UI.playerArea.classList.add("layout-1"); // fallback visual
  }

  function computeAutoGrid(n) {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    return { cols, rows };
  }

  function applyLayout(n) {
    n = clamp(Number(n) || 1, 1, 12);
    STATE.layoutN = n;
    STATE.activeSlot = clamp(STATE.activeSlot, 0, n - 1);

    UI.playerArea.innerHTML = "";

    // Para layouts custom, ponemos grid "auto"
    if (![1,2,4,6,9].includes(n)) {
      const { cols, rows } = computeAutoGrid(n);
      UI.playerArea.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      UI.playerArea.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      UI.playerArea.classList.remove("layout-1","layout-2","layout-4","layout-6","layout-9");
    } else {
      UI.playerArea.style.gridTemplateColumns = "";
      UI.playerArea.style.gridTemplateRows = "";
      setGridClass(n);
    }

    // Reutiliza slots previos si existen
    const old = SLOTS;
    SLOTS = [];

    for (let i = 0; i < n; i++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.dataset.slot = String(i);

      const media = document.createElement("div");
      media.className = "tileMedia";

      tile.appendChild(media);
      UI.playerArea.appendChild(tile);

      const player = new TilePlayer(i, tile, media);
      const slot = {
        idx: i,
        tile,
        player,
        cam: null,
        alive: false,
        lastGoodAt: 0,
        failCount: 0,
        tz: "",
      };

      // si el slot existía antes, reengancha cam
      const prev = old[i];
      if (prev?.cam) slot.cam = prev.cam;
      if (prev?.tz) slot.tz = prev.tz;

      SLOTS.push(slot);
    }

    // stop slots antiguos extra
    for (let i = n; i < old.length; i++) {
      try { old[i]?.player?.stop("layout change"); } catch {}
    }

    highlightActiveSlot();
    emitState();
    setNowUIFromActive();
  }

  function highlightActiveSlot() {
    for (const s of SLOTS) {
      if (!s?.tile) continue;
      s.tile.classList.toggle("active", s.idx === STATE.activeSlot);
    }
  }

  // Engine: YouTube/HLS/Image por tile
  let _ytPromise = null;
  async function ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) return true;
    if (_ytPromise) return _ytPromise;

    _ytPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);

      const t0 = nowMs();
      const tick = () => {
        if (window.YT && window.YT.Player) return resolve(true);
        if (nowMs() - t0 > 8000) return resolve(false);
        setTimeout(tick, 80);
      };
      tick();
    });

    return _ytPromise;
  }

  let _hlsPromise = null;
  async function ensureHlsJs() {
    if (window.Hls) return true;
    if (_hlsPromise) return _hlsPromise;

    _hlsPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js";
      s.async = true;
      s.onload = () => resolve(!!window.Hls);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });

    return _hlsPromise;
  }

  class TilePlayer {
    constructor(slotIndex, tileEl, mediaEl) {
      this.slot = slotIndex;
      this.tile = tileEl;
      this.media = mediaEl;

      this.token = 0;
      this.elem = null;
      this.yt = null;
      this.hls = null;

      // HUD
      this.hud = document.createElement("div");
      this.hud.className = "tileHud";

      this.card = document.createElement("div");
      this.card.className = "tileCard";

      this.titleEl = document.createElement("div");
      this.titleEl.className = "tileTitle";
      this.titleEl.textContent = `Slot ${slotIndex + 1}`;

      this.badgeRow = document.createElement("div");
      this.badgeRow.className = "tileMeta";

      this.card.appendChild(this.titleEl);
      this.card.appendChild(this.badgeRow);

      this.hud.appendChild(this.card);
      this.tile.appendChild(this.hud);
    }

    _setBadges(items) {
      this.badgeRow.innerHTML = "";
      for (const it of items.filter(Boolean)) {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = it;
        this.badgeRow.appendChild(b);
      }
    }

    setMuted(m) {
      const muted = !!m;
      if (this.elem && this.elem.tagName === "VIDEO") {
        this.elem.muted = muted;
        this.elem.volume = muted ? 0 : 1;
      }
      try {
        if (this.yt?.mute && this.yt?.unMute) muted ? this.yt.mute() : this.yt.unMute();
      } catch {}
    }

    clear() {
      try { this.yt?.destroy?.(); } catch {}
      this.yt = null;

      try { this.hls?.destroy?.(); } catch {}
      this.hls = null;

      this.media.innerHTML = "";
      this.elem = null;
    }

    stop(reason = "") {
      this.token++;
      this.clear();
      const s = SLOTS[this.slot];
      if (s) {
        s.alive = false;
        if (s.idx === STATE.activeSlot) setNowUIFromActive(reason ? `(${reason})` : "");
      }
    }

    async play(cam, reason = "manual") {
      cam = cam ? (CATALOG.byId.get(cam.id) || cam) : null;
      const s = SLOTS[this.slot];
      if (!cam || !s) return false;

      this.token++;
      const t = this.token;

      s.cam = cam;
      s.alive = false;

      this.titleEl.textContent = cam.title || cam.id;
      this._setBadges([`Slot ${this.slot + 1}`, cam.kind?.toUpperCase() || "—", cam.region || ""]);

      if (s.idx === STATE.activeSlot) setNowUIFromActive("cargando…");

      this.clear();

      // location inference
      const city = cam.city || inferCityFromTitle(cam.title);
      const country = cam.country || countryNameFromRegion(cam.region);
      const cont = continentFromCam(cam);
      const tz = cam.tz || s.tz || "";
      const locTxt = [city, country].filter(Boolean).join(", ") + (cont ? ` · ${cont}` : "");

      // preload weather/timezone from Open-Meteo if lat/lon exist
      if (Number.isFinite(cam.lat) && Number.isFinite(cam.lon)) {
        Weather.get(cam.lat, cam.lon).then((w) => {
          if (t !== this.token) return;
          if (w?.tz && !s.tz) s.tz = w.tz;
        }).catch(()=>{});
      }

      // YOUTUBE
      if (cam.kind === "youtube") {
        const okApi = await ensureYouTubeAPI();

        const wrap = document.createElement("div");
        wrap.style.position = "absolute";
        wrap.style.inset = "0";
        this.media.appendChild(wrap);

        if (!okApi || !(window.YT && window.YT.Player)) {
          const iframe = document.createElement("iframe");
          iframe.allow = "autoplay; encrypted-media; picture-in-picture";
          iframe.allowFullscreen = true;
          const mute = PLAY.muted ? 1 : 0;
          iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(cam.src)}?autoplay=1&mute=${mute}&controls=0&rel=0&modestbranding=1&playsinline=1`;
          wrap.appendChild(iframe);

          // best-effort: lo marcamos vivo tras un pequeño delay
          await sleep(900);
          if (t !== this.token) return false;
          s.alive = true;
          s.lastGoodAt = nowMs();
          this._refreshOverlay(locTxt);
          if (s.idx === STATE.activeSlot) setNowUIFromActive();
          emitState();
          return true;
        }

        const host = document.createElement("div");
        host.id = `yt_slot_${this.slot}_${randId(6)}`;
        host.style.width = "100%";
        host.style.height = "100%";
        wrap.appendChild(host);

        let aliveMarked = false;

        try {
          this.yt = new window.YT.Player(host.id, {
            videoId: cam.src,
            playerVars: {
              autoplay: 1,
              controls: 0,
              rel: 0,
              modestbranding: 1,
              playsinline: 1,
              mute: PLAY.muted ? 1 : 0,
            },
            events: {
              onReady: (ev) => {
                try {
                  if (PLAY.muted) ev.target.mute();
                  ev.target.playVideo();
                } catch {}
              },
              onStateChange: (ev) => {
                if (t !== this.token) return;
                // 1=PLAYING
                if (ev?.data === 1 && !aliveMarked) {
                  aliveMarked = true;
                  s.alive = true;
                  s.lastGoodAt = nowMs();
                  this._refreshOverlay(locTxt);
                  if (s.idx === STATE.activeSlot) setNowUIFromActive();
                  emitState();
                }
              },
              onError: () => {
                if (t !== this.token) return;
                s.failCount++;
                s.alive = false;
                this._refreshOverlay(locTxt, "sin señal");
                if (STATE.rotate.enabled && s.idx === STATE.activeSlot) {
                  rotateNext("yt error");
                }
                emitState();
              }
            }
          });

          // overlay initial
          this._refreshOverlay(locTxt, "cargando…");
          return true;
        } catch (e) {
          console.warn("[yt] fail", e);
          s.failCount++;
          s.alive = false;
          this._refreshOverlay(locTxt, "sin señal");
          emitState();
          return false;
        }
      }

      // HLS
      if (cam.kind === "hls") {
        const video = document.createElement("video");
        video.playsInline = true;
        video.autoplay = true;
        video.muted = PLAY.muted;
        video.controls = false;
        video.loop = false;

        this.media.appendChild(video);
        this.elem = video;

        const markAlive = () => {
          if (t !== this.token) return;
          s.alive = true;
          s.lastGoodAt = nowMs();
          this._refreshOverlay(locTxt);
          if (s.idx === STATE.activeSlot) setNowUIFromActive();
          emitState();
        };

        video.addEventListener("playing", markAlive, { once: true });
        video.addEventListener("error", () => {
          if (t !== this.token) return;
          s.failCount++;
          s.alive = false;
          this._refreshOverlay(locTxt, "sin señal");
          if (STATE.rotate.enabled && s.idx === STATE.activeSlot) rotateNext("hls error");
          emitState();
        });

        const canNative = video.canPlayType("application/vnd.apple.mpegurl");
        if (canNative) {
          video.src = cam.src;
          try { await video.play(); } catch {}
          this._refreshOverlay(locTxt, "cargando…");
          return true;
        }

        const okHls = await ensureHlsJs();
        if (!okHls || !window.Hls) {
          s.failCount++;
          s.alive = false;
          this._refreshOverlay(locTxt, "HLS.js no disponible");
          emitState();
          return false;
        }

        try {
          this.hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
          this.hls.loadSource(cam.src);
          this.hls.attachMedia(video);

          this.hls.on(window.Hls.Events.ERROR, (_ev, data) => {
            if (t !== this.token) return;
            if (data?.fatal) {
              s.failCount++;
              s.alive = false;
              this._refreshOverlay(locTxt, "sin señal");
              try { this.hls?.destroy?.(); } catch {}
              this.hls = null;

              if (STATE.rotate.enabled && s.idx === STATE.activeSlot) rotateNext("hls fatal");
              emitState();
            }
          });

          this._refreshOverlay(locTxt, "cargando…");
          return true;
        } catch (e) {
          console.warn("[hls] fail", e);
          s.failCount++;
          s.alive = false;
          this._refreshOverlay(locTxt, "sin señal");
          emitState();
          return false;
        }
      }

      // IMAGE
      if (cam.kind === "image") {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = cam.src;
        this.media.appendChild(img);
        this.elem = img;

        this._refreshOverlay(locTxt, "cargando…");

        await new Promise((resolve) => {
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
        });

        if (t !== this.token) return false;

        // ok
        s.alive = true;
        s.lastGoodAt = nowMs();
        this._refreshOverlay(locTxt);
        if (s.idx === STATE.activeSlot) setNowUIFromActive();
        emitState();
        return true;
      }

      // Unknown kind
      s.failCount++;
      s.alive = false;
      this._refreshOverlay(locTxt, "tipo no soportado");
      emitState();
      return false;
    }

    async _refreshOverlay(locTxt, extra = "") {
      const s = SLOTS[this.slot];
      if (!s?.cam) return;

      const cam = s.cam;
      const city = cam.city || inferCityFromTitle(cam.title);
      const country = cam.country || countryNameFromRegion(cam.region);
      const cont = continentFromCam(cam);
      const baseLoc = locTxt || [city, country].filter(Boolean).join(", ") + (cont ? ` · ${cont}` : "");

      const tz = s.tz || cam.tz || "";
      const timeStr = tz ? formatLocalTime(tz) : "";
      let weatherStr = "";

      if (Number.isFinite(cam.lat) && Number.isFinite(cam.lon)) {
        const w = await Weather.get(cam.lat, cam.lon);
        if (w) {
          if (w.tz && !s.tz) s.tz = w.tz;
          const tC = (w.temp != null) ? `${Math.round(w.temp)}°C` : "";
          const wL = weatherLabel(w.code);
          const wind = (w.wind != null) ? `${Math.round(w.wind)} km/h` : "";
          weatherStr = [tC, wL, wind].filter(Boolean).join(" · ");
        }
      } else {
        weatherStr = "Clima: sin coordenadas";
      }

      const badges = [];
      badges.push(`Slot ${this.slot + 1}`);
      badges.push(cam.kind?.toUpperCase() || "—");
      if (cam.region) badges.push(cam.region);

      const info = [];
      if (baseLoc) info.push(baseLoc);
      if (timeStr) info.push(`🕒 ${timeStr}`);
      if (weatherStr) info.push(`🌦️ ${weatherStr}`);
      if (extra) info.push(extra);

      this._setBadges(badges.concat(info));
    }
  }

  // Rotation bag (para el slot activo)
  const BAG = {
    ids: [],
    refill() {
      const list = filteredList(true);
      const ids = list.map(c => c.id);
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      this.ids = ids;
    },
    nextId() {
      if (!this.ids.length) this.refill();
      return this.ids.shift() || null;
    }
  };

  function filteredList(applyRotateFilter = true) {
    const list = CATALOG.list;

    let kind = "any";
    let tag = "";

    if (applyRotateFilter && STATE.rotate.enabled) {
      kind = STATE.rotate.kind || "any";
      tag = STATE.rotate.tag || "";
    } else if (P.tag) {
      tag = P.tag;
    }

    return list.filter(c => {
      if (kind !== "any" && c.kind !== kind) return false;
      if (tag && !c.tags.includes(tag)) return false;
      return true;
    });
  }

  function pickNextFromSlot(slotIdx, direction = 1) {
    const slot = SLOTS[slotIdx];
    const list = filteredList(false);
    if (!list.length) return null;

    if (!slot?.cam) return list[0];
    const idx = list.findIndex(x => x.id === slot.cam.id);
    return list[(idx + direction + list.length) % list.length] || list[0];
  }

  function disarmRotateTimer() {
    if (PLAY.rotateTimer) window.clearTimeout(PLAY.rotateTimer);
    PLAY.rotateTimer = 0;
  }

  function armRotateTimer() {
    disarmRotateTimer();
    if (!STATE.rotate.enabled) return;
    const sec = clamp(Number(STATE.rotate.intervalSec || 40), 8, 3600);
    PLAY.rotateTimer = window.setTimeout(() => rotateNext("timer"), sec * 1000);
  }

  async function rotateNext(trigger = "timer") {
    if (!STATE.rotate.enabled) return;

    const nextId = BAG.nextId();
    const next = nextId ? CATALOG.byId.get(nextId) : null;
    if (!next) return;

    STATE.mode = "rotate";
    setModeLabel("rotate");
    await playInSlot(STATE.activeSlot, next, { reason: "rotate" });
    armRotateTimer();
  }

  async function playInSlot(slotIdx, camOrId, { reason = "manual" } = {}) {
    const slot = SLOTS[slotIdx];
    if (!slot) return false;

    const cam = typeof camOrId === "string"
      ? CATALOG.byId.get(camOrId)
      : (camOrId ? (CATALOG.byId.get(camOrId.id) || camOrId) : null);

    if (!cam) {
      STATE.lastError = "Cam no encontrada";
      slot.failCount++;
      emitState();
      if (slotIdx === STATE.activeSlot) setNowUIFromActive("(cam no encontrada)");
      return false;
    }

    try { localStorage.setItem(LS_LAST, cam.id); } catch {}
    const ok = await slot.player.play(cam, reason);
    if (!ok) slot.failCount++;
    emitState();
    return ok;
  }

  function stopSlot(slotIdx, reason = "Stop") {
    const slot = SLOTS[slotIdx];
    if (!slot) return;
    slot.player.stop(reason);
    slot.alive = false;
    emitState({ stopped: true, reason, slot: slotIdx });
  }

  function stopAll(reason = "Stop") {
    disarmRotateTimer();
    STATE.rotate.enabled = false;
    STATE.mode = "manual";
    setModeLabel("manual");
    for (let i = 0; i < SLOTS.length; i++) stopSlot(i, reason);
    setSignal("warn", reason || "stopped");
    STATE.lastError = reason ? String(reason) : "";
    setNowUIFromActive(reason ? `(${reason})` : "");
    emitState({ stoppedAll: true, reason });
  }

  // Commands
  async function handleCommand(cmd, data, nonce) {
    const c = String(cmd || "").toUpperCase();
    const d = data || {};

    if (c === "PING") {
      sendAck(nonce, true, "pong");
      emitState({ pong: true });
      return;
    }

    if (c === "RELOAD_CAMS") {
      const ok = await loadCams();
      sendAck(nonce, ok, ok ? "catalog reloaded" : "catalog reload failed");
      emitState();
      return;
    }

    // NUEVO: layout
    if (c === "LAYOUT_SET" || c === "SET_LAYOUT") {
      const n = clamp(Number(d.n || d.layout || 1), 1, 12);
      applyLayout(n);
      sendAck(nonce, true, `layout ${n}`);
      return;
    }

    // NUEVO: slot activo
    if (c === "SLOT_SET") {
      const s = clamp(Number(d.slot || 0), 0, STATE.layoutN - 1);
      STATE.activeSlot = s;
      highlightActiveSlot();
      setNowUIFromActive();
      sendAck(nonce, true, `slot ${s + 1}`);
      emitState();
      return;
    }

    // STOP all (compat)
    if (c === "STOP") {
      stopAll("Stop");
      sendAck(nonce, true, "stopped all");
      return;
    }

    // NUEVO: stop slot
    if (c === "STOP_SLOT") {
      const s = clamp(Number(d.slot ?? STATE.activeSlot), 0, STATE.layoutN - 1);
      stopSlot(s, "Stop slot");
      sendAck(nonce, true, `stopped slot ${s + 1}`);
      return;
    }

    if (c === "MUTE_SET") {
      setMuted(!!d.muted);
      sendAck(nonce, true, "mute set");
      return;
    }

    // Rotación (aplica al slot activo)
    if (c === "MODE_SET") {
      const mode = (String(d.mode || "manual").toLowerCase() === "rotate") ? "rotate" : "manual";
      STATE.mode = mode;
      setModeLabel(mode);
      sendAck(nonce, true, "mode set");
      emitState();
      return;
    }

    if (c === "ROTATE_SET") {
      const enabled = !!d.enabled;
      const intervalSec = clamp(Number(d.intervalSec || 40), 8, 3600);
      const kind = String(d.kind || "any");
      const tag = String(d.tag || "");

      STATE.rotate = { enabled, intervalSec, kind, tag };
      STATE.mode = enabled ? "rotate" : "manual";
      setModeLabel(STATE.mode);

      if (enabled) {
        BAG.refill();
        armRotateTimer();
        if (d.rotateNow) rotateNext("rotateNow");
      } else {
        disarmRotateTimer();
      }

      sendAck(nonce, true, enabled ? "rotate enabled" : "rotate disabled");
      emitState();
      return;
    }

    // Compat: PLAY_ID (usa slot activo)
    if (c === "PLAY_ID") {
      disarmRotateTimer();
      STATE.rotate.enabled = false;
      STATE.mode = "manual";
      setModeLabel("manual");

      const id = String(d.id || "").trim();
      const ok = await playInSlot(STATE.activeSlot, id, { reason: "manual" });
      sendAck(nonce, ok, ok ? "playing" : "failed");
      return;
    }

    // NUEVO: PLAY_SLOT
    if (c === "PLAY_SLOT") {
      disarmRotateTimer();
      STATE.rotate.enabled = false;
      STATE.mode = "manual";
      setModeLabel("manual");

      const slot = clamp(Number(d.slot ?? STATE.activeSlot), 0, STATE.layoutN - 1);
      const id = String(d.id || "").trim();
      const ok = await playInSlot(slot, id, { reason: "manual" });
      sendAck(nonce, ok, ok ? `playing slot ${slot + 1}` : "failed");
      return;
    }

    // NEXT/PREV (slot activo o slot en data)
    if (c === "NEXT" || c === "PREV") {
      const slot = clamp(Number(d.slot ?? STATE.activeSlot), 0, STATE.layoutN - 1);
      const dir = (c === "NEXT") ? 1 : -1;
      const next = pickNextFromSlot(slot, dir);
      const ok = await playInSlot(slot, next, { reason: "manual" });
      sendAck(nonce, ok, ok ? (c === "NEXT" ? "next" : "prev") : "failed");
      return;
    }

    // desconocido
    sendAck(nonce, false, "unknown cmd");
  }

  function onMsg(payload) {
    try {
      if (!payload || payload.v !== APP.protocol) return;
      if (payload.key !== P.key) return;
      if (payload.type !== "CMD") return;
      if (payload.from !== "control") return;

      const ts = Number(payload.ts || 0);
      const nonce = String(payload.nonce || "");
      if (!nonce || !ts) return;
      if (seenRecently(nonce, ts)) return;

      setConn(true, "Control: conectado");
      STATE.lastControlSeenAt = nowMs();

      handleCommand(payload.cmd, payload.data || {}, nonce);
    } catch {}
  }

  if (bc) bc.onmessage = (e) => onMsg(e.data);
  window.addEventListener("storage", (e) => {
    if (e.key !== LS_CMD) return;
    try { onMsg(JSON.parse(e.newValue || "null")); } catch {}
  });

  // UI actions
  UI.btnMute?.addEventListener("click", () => setMuted(!PLAY.muted));
  UI.btnStop?.addEventListener("click", () => stopAll("Stop"));

  UI.btnFs?.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await UI.stage.requestFullscreen();
      else await document.exitFullscreen();
    } catch {}
  });

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;

    const k = e.key.toLowerCase();
    if (k === "m") UI.btnMute?.click();
    if (k === "s") UI.btnStop?.click();
    if (k === "f") UI.btnFs?.click();
    if (k === "n") {
      handleCommand("NEXT", { slot: STATE.activeSlot }, randId(8));
    }

    // 1..9 select slot
    if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < STATE.layoutN) {
        STATE.activeSlot = idx;
        highlightActiveSlot();
        setNowUIFromActive();
        emitState();
      }
    }
  });

  // Periodic overlay refresh (hora/clima)
  setInterval(() => {
    for (const s of SLOTS) {
      if (!s?.cam) continue;
      // refresca overlay en background
      try { s.player?._refreshOverlay?.(""); } catch {}
    }
    setNowUIFromActive();
  }, 5000);

  // Boot
  (async function boot() {
    setConn(false, "Control: esperando");
    setModeLabel("manual");
    setSignal("warn", "booting…");
    setMuted(PLAY.muted);

    await loadCams({ soft: true });

    applyLayout(STATE.layoutN);

    // Autoplay inicial en slot activo si hay id en URL o last
    let id = P.startId;
    if (!id) {
      try { id = localStorage.getItem(LS_LAST) || ""; } catch {}
    }
    if (id && CATALOG.byId.has(id)) {
      if (P.autoplay) {
        await playInSlot(STATE.activeSlot, id, { reason: "autoplay" });
      } else {
        // no autoplay: solo mostrar meta
        const cam = CATALOG.byId.get(id);
        SLOTS[STATE.activeSlot].cam = cam;
        SLOTS[STATE.activeSlot].player.titleEl.textContent = cam.title || cam.id;
        SLOTS[STATE.activeSlot].player._refreshOverlay("");
        setNowUIFromActive("(listo)");
        emitState();
      }
    } else {
      setNowUIFromActive();
      emitState();
    }

    setSignal("good", "ready");
  })();
})();
