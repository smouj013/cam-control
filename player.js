/* player.js — CamStudio Room PLAYER (v1.2.0 | MULTIVIEW + HUD REMOTO + PLAY_URL)
   ✅ Multiview: 1/2/4/6/9 + custom N (hasta 12)
   ✅ Slots independientes (PLAY por slot)
   ✅ HUD: ON/OFF remoto (CMD HUD_SET)
   ✅ Fullscreen remoto (CMD FULLSCREEN_SET) best-effort (por gesto del navegador)
   ✅ PLAY_URL: pegar URL (YouTube / HLS / imagen) y reproducir sin tocar catálogo
   ✅ Hora local (si hay tz) + clima (si hay lat/lon, Open-Meteo)
   ✅ Override de catálogo (localStorage) + fallback a ./cams.json
   ✅ Compat: comandos antiguos (PLAY_ID/NEXT/PREV/STOP/LAYOUT/SLOT/MUTE)
*/
(() => {
  "use strict";

  const APP = {
    name: "CamStudioRoom",
    ver: "1.2.0",
    protocol: 1,
    camsUrl: "./cams.json",
  };

  const $ = (id) => document.getElementById(id);
  const nowMs = () => Number(Date.now());
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  const randId = (len = 12) => {
    const a = new Uint8Array(len);
    try { crypto?.getRandomValues?.(a); } catch {}
    for (let i = 0; i < a.length; i++) if (a[i] === 0) a[i] = (Math.random() * 255) | 0;
    return [...a].map(x => (x % 36).toString(36)).join("");
  };

  function parseParams() {
    const qp = new URLSearchParams(location.search);
    const key = (qp.get("key") || "main").trim() || "main";
    const autoplay = qp.get("autoplay") === "1";
    const mute = qp.get("mute") === "1";
    const layout = clamp(parseInt(qp.get("layout") || "1", 10) || 1, 1, 12);
    const hud = qp.get("hud"); // "0" / "1"
    const hudVisible = (hud === null) ? true : (hud !== "0");
    return { key, autoplay, mute, layout, hudVisible };
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

  // Bus + storage
  const BUS_NAME = "camstudio_bus";
  const LS_CMD = `camstudio_cmd:${P.key}`;
  const LS_STATE = `camstudio_state:${P.key}`;
  const LS_ACK = `camstudio_ack:${P.key}`;
  const LS_LAST = `camstudio_last:${P.key}`;
  const LS_CAMS_OVERRIDE = `camstudio_cams_override:${P.key}`;

  let bc = null;
  try { bc = new BroadcastChannel(BUS_NAME); } catch { bc = null; }

  const seen = new Map(); // nonce -> ts
  function seenRecently(nonce, ts) {
    const t = seen.get(nonce);
    if (t && Math.abs(ts - t) < 30_000) return true;
    seen.set(nonce, ts);
    if (seen.size > 400) {
      const cut = nowMs() - 60_000;
      for (const [k, v] of seen) if (v < cut) seen.delete(k);
    }
    return false;
  }

  function emit(type, payload) {
    try { bc?.postMessage(payload); } catch {}
    try {
      const key = (type === "STATE") ? LS_STATE : (type === "ACK" ? LS_ACK : null);
      if (key) localStorage.setItem(key, JSON.stringify(payload));
    } catch {}
  }

  function sendACK(cmdNonce, cmd, ok = true, note = "") {
    const payload = {
      v: APP.protocol,
      key: P.key,
      ts: nowMs(),
      nonce: randId(12),
      from: "player",
      type: "ACK",
      ack: { cmdNonce: String(cmdNonce || ""), cmd: String(cmd || ""), ok: !!ok, note: String(note || "") }
    };
    emit("ACK", payload);
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
    } catch { return null; }
  }

  function extractYouTubeId(input) {
    const s = String(input || "").trim();
    if (!s) return "";
    // raw ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;

    let u = null;
    try { u = new URL(s); } catch { u = null; }
    if (!u) return "";

    const host = (u.hostname || "").replace(/^www\./, "");
    if (host === "youtu.be") {
      const p = u.pathname.replace(/\//g, "").trim();
      return (/^[a-zA-Z0-9_-]{11}$/.test(p)) ? p : "";
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      // watch?v=
      const v = u.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

      // /embed/ID  /shorts/ID /live/ID
      const m = u.pathname.match(/\/(embed|shorts|live)\/([a-zA-Z0-9_-]{11})/);
      if (m && m[2]) return m[2];
    }
    return "";
  }

  function guessKindFromUrl(url) {
    const s = String(url || "").trim();
    if (!s) return { kind: "", src: "" };

    const yt = extractYouTubeId(s);
    if (yt) return { kind: "youtube", src: yt };

    // hls
    if (/\.m3u8(\?|#|$)/i.test(s)) return { kind: "hls", src: s };

    // image
    if (/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(s)) return { kind: "image", src: s };

    // si es URL pero no sabemos, lo tratamos como HLS si parece stream
    if (/^https?:\/\//i.test(s)) return { kind: "hls", src: s };
    return { kind: "", src: "" };
  }

  function normalizeCamObj(c) {
    if (!c || typeof c !== "object") return null;
    if (c.disabled) return null;

    const id = String(c.id || "").trim();
    let kind = String(c.kind || "").trim();
    let src = String(c.src || "").trim();
    if (!id || !kind || !src) return null;

    if (kind === "youtube" && !/^[a-zA-Z0-9_-]{11}$/.test(src)) {
      const yid = extractYouTubeId(src);
      if (yid) src = yid;
    }
    if (!["youtube","hls","image"].includes(kind)) {
      // compat (si vienen cosas raras)
      const g = guessKindFromUrl(src);
      kind = g.kind || kind;
      src = g.src || src;
    }

    const num = (v, def = null) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };

    return {
      id,
      title: String(c.title || id),
      kind,
      src,
      tags: Array.isArray(c.tags) ? c.tags.map(String).filter(Boolean) : [],
      region: String(c.region || ""),
      priority: num(c.priority, 0) ?? 0,
      weight: num(c.weight, 1) ?? 1,
      thumb: String(c.thumb || ""),
      fallback: Array.isArray(c.fallback) ? c.fallback.map(String).filter(Boolean) : [],

      city: String(c.city || ""),
      country: String(c.country || ""),
      continent: String(c.continent || ""),
      tz: String(c.tz || ""),
      lat: num(c.lat, null),
      lon: num(c.lon, null),
    };
  }

  async function loadCams() {
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
      const clean = [];
      for (const c of cams) {
        const cam = normalizeCamObj(c);
        if (!cam) continue;
        clean.push(cam);
      }

      clean.sort((a, b) => (b.priority - a.priority) || a.title.localeCompare(b.title));
      CATALOG.list = clean;
      CATALOG.byId = new Map(clean.map(c => [c.id, c]));
      CATALOG.meta = json?.meta || {};

      UI.subline.textContent = `Catálogo listo • ${clean.length} cams${override ? " (override)" : ""}`;
      setSignal("good", "catalog OK");
      return true;
    } catch (e) {
      UI.subline.textContent = "Error cargando catálogo";
      setSignal("bad", "catalog failed");
      console.warn("[player] loadCams failed", e);
      return false;
    }
  }

  // Location helpers
  const dnCountry = (() => {
    try { return new Intl.DisplayNames(["es"], { type: "region" }); } catch { return null; }
  })();

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
        timeZone: z, hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).format(d);
    } catch { return ""; }
  }

  // Weather (Open-Meteo)
  const Weather = {
    cache: new Map(), // key -> { ts, data }
    async get(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      const hit = this.cache.get(key);
      if (hit && (nowMs() - hit.ts) < 10 * 60_000) return hit.data;

      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true&timezone=auto`;
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
    if (c === 0) return "☀️";
    if (c === 1 || c === 2) return "🌤️";
    if (c === 3) return "☁️";
    if (c === 45 || c === 48) return "🌫️";
    if ([51,53,55,56,57].includes(c)) return "🌦️";
    if ([61,63,65,66,67].includes(c)) return "🌧️";
    if ([71,73,75,77].includes(c)) return "🌨️";
    if ([80,81,82].includes(c)) return "🌧️";
    if ([95,96,99].includes(c)) return "⛈️";
    return "🌡️";
  }

  // Libraries
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
        if (nowMs() - t0 > 9000) return resolve(false);
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

  // State
  const STATE = {
    layoutN: clamp(P.layout, 1, 12),
    activeSlot: 0,
    lastControlSeenAt: 0,
    hudVisible: !!P.hudVisible,
    lastError: "",
  };

  const PLAY = {
    muted: !!P.mute,
  };

  function setHudVisible(on) {
    STATE.hudVisible = !!on;
    document.documentElement.classList.toggle("hud-hidden", !STATE.hudVisible);
    emitState();
  }

  function setMuted(m) {
    PLAY.muted = !!m;
    UI.txtMute.textContent = PLAY.muted ? "Unmute" : "Mute";
    if (UI_MUTE_ICON) UI_MUTE_ICON.textContent = PLAY.muted ? "🔇" : "🔊";

    for (const t of TILES) t.setMuted(PLAY.muted);
    emitState();
  }

  function setNowUIFromActive(extra = "") {
    const s = SLOTS[STATE.activeSlot];
    const cam = s?.cam || null;
    if (!cam) {
      UI.nowName.textContent = "Sin señal";
      UI.nowMeta.textContent = extra || "Selecciona una cámara desde el panel de control.";
      setLive(false);
      return;
    }

    const city = cam.city || inferCityFromTitle(cam.title);
    const country = cam.country || countryNameFromRegion(cam.region);
    const cont = continentFromCam(cam);
    const tz = s.tz || cam.tz || "";
    const t = tz ? formatLocalTime(tz) : "";
    const w = s.weather;
    const wtxt = (w && Number.isFinite(w.temp)) ? `${weatherLabel(w.code)} ${Math.round(w.temp)}°C` : "";

    UI.nowName.textContent = cam.title || cam.id;

    const bits = [];
    bits.push(`${cam.kind.toUpperCase()} · Slot ${STATE.activeSlot + 1}`);
    const loc = [city, country].filter(Boolean).join(", ");
    if (loc) bits.push(loc);
    if (cont) bits.push(cont);
    if (t) bits.push(`🕒 ${t}`);
    if (wtxt) bits.push(wtxt);
    if (extra) bits.push(extra);

    UI.nowMeta.textContent = bits.join(" · ");
    setLive(!!s.alive);
  }

  function applyHudScaleForLayout(n) {
    // Ajuste “un poco más escalado” y más limpio en 6/9
    const map = {
      1: { hud: 0.98, tile: 0.96 },
      2: { hud: 0.96, tile: 0.94 },
      3: { hud: 0.95, tile: 0.92 },
      4: { hud: 0.94, tile: 0.90 },
      5: { hud: 0.93, tile: 0.88 },
      6: { hud: 0.92, tile: 0.86 },
      7: { hud: 0.91, tile: 0.85 },
      8: { hud: 0.91, tile: 0.84 },
      9: { hud: 0.90, tile: 0.82 },
      10:{ hud: 0.89, tile: 0.81 },
      11:{ hud: 0.89, tile: 0.80 },
      12:{ hud: 0.88, tile: 0.79 },
    };
    const v = map[n] || { hud: 0.92, tile: 0.86 };
    document.documentElement.style.setProperty("--hudScale", String(v.hud));
    document.documentElement.style.setProperty("--tileHudScale", String(v.tile));
  }

  // Tiles
  const SLOTS = []; // { idx, cam, alive, failCount, lastGoodAt, tz, weather, rotate:{...}, mode }
  const TILES = []; // TilePlayer instances

  class TilePlayer {
    constructor(slotIndex, tileEl, mediaEl) {
      this.slot = slotIndex;
      this.tile = tileEl;
      this.media = mediaEl;

      this.token = 0;
      this.elem = null;
      this.yt = null;
      this.hls = null;

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

    setActive(isActive) {
      this.tile.classList.toggle("active", !!isActive);
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
      this._setBadges([`Slot ${this.slot + 1}`, (cam.kind || "—").toUpperCase(), cam.region || ""]);

      if (s.idx === STATE.activeSlot) setNowUIFromActive("cargando…");
      this.clear();

      // infer location
      const city = cam.city || inferCityFromTitle(cam.title);
      const country = cam.country || countryNameFromRegion(cam.region);
      const cont = continentFromCam(cam);

      // prefetch weather if possible
      if (Number.isFinite(cam.lat) && Number.isFinite(cam.lon)) {
        const w = await Weather.get(cam.lat, cam.lon);
        if (t !== this.token) return false;
        s.weather = w;
        if (w?.tz && !s.tz) s.tz = w.tz;
      } else {
        s.weather = null;
      }

      // tz
      s.tz = s.tz || cam.tz || "";

      const refreshHudBadges = () => {
        const localT = s.tz ? formatLocalTime(s.tz) : "";
        const w = s.weather;
        const wtxt = (w && Number.isFinite(w.temp)) ? `${weatherLabel(w.code)} ${Math.round(w.temp)}°C` : "";
        const loc = [city, country].filter(Boolean).join(", ");
        this._setBadges([
          `Slot ${this.slot + 1}`,
          (cam.kind || "—").toUpperCase(),
          loc || cont || cam.region || "",
          localT ? `🕒 ${localT}` : "",
          wtxt,
          reason === "url" ? "URL" : ""
        ]);
      };

      refreshHudBadges();

      // ── YOUTUBE ──────────────────────────────────────────────────────────────
      if (cam.kind === "youtube") {
        const okApi = await ensureYouTubeAPI();
        if (t !== this.token) return false;

        const wrap = document.createElement("div");
        wrap.style.position = "absolute";
        wrap.style.inset = "0";
        this.media.appendChild(wrap);

        if (!okApi) {
          const iframe = document.createElement("iframe");
          iframe.allow = "autoplay; encrypted-media; picture-in-picture";
          iframe.allowFullscreen = true;
          iframe.referrerPolicy = "strict-origin-when-cross-origin";
          iframe.src =
            `https://www.youtube-nocookie.com/embed/${encodeURIComponent(cam.src)}?autoplay=1&mute=${PLAY.muted ? 1 : 0}&controls=0&rel=0&modestbranding=1&playsinline=1`;
          wrap.appendChild(iframe);

          iframe.addEventListener("load", () => {
            if (t !== this.token) return;
            s.alive = true;
            s.lastGoodAt = nowMs();
            if (s.idx === STATE.activeSlot) setNowUIFromActive();
            emitState();
          }, { once: true });

          this.elem = iframe;
          return true;
        }

        // YT.Player
        const div = document.createElement("div");
        div.style.width = "100%";
        div.style.height = "100%";
        wrap.appendChild(div);

        const onReady = (ev) => {
          if (t !== this.token) return;
          try {
            if (PLAY.muted) ev.target.mute();
            else ev.target.unMute();
            ev.target.playVideo?.();
          } catch {}
        };

        const onState = (ev) => {
          if (t !== this.token) return;
          // 1 = playing, 3 = buffering
          if (ev?.data === 1 || ev?.data === 3) {
            if (!s.alive) {
              s.alive = true;
              s.lastGoodAt = nowMs();
              if (s.idx === STATE.activeSlot) setNowUIFromActive();
              emitState();
            }
          }
        };

        try {
          this.yt = new window.YT.Player(div, {
            videoId: cam.src,
            playerVars: {
              autoplay: 1,
              mute: PLAY.muted ? 1 : 0,
              controls: 0,
              rel: 0,
              modestbranding: 1,
              playsinline: 1
            },
            events: { onReady, onStateChange: onState }
          });
        } catch (e) {
          console.warn("[YT] fail", e);
          s.failCount++;
          s.alive = false;
          if (s.idx === STATE.activeSlot) setNowUIFromActive("(error YT)");
          emitState();
          return false;
        }

        return true;
      }

      // ── HLS ─────────────────────────────────────────────────────────────────
      if (cam.kind === "hls") {
        const v = document.createElement("video");
        v.playsInline = true;
        v.autoplay = true;
        v.muted = PLAY.muted;
        v.controls = false;
        v.preload = "auto";
        v.style.width = "100%";
        v.style.height = "100%";
        v.style.objectFit = "cover";

        this.media.appendChild(v);
        this.elem = v;

        const markAlive = () => {
          if (t !== this.token) return;
          s.alive = true;
          s.lastGoodAt = nowMs();
          if (s.idx === STATE.activeSlot) setNowUIFromActive();
          emitState();
        };

        v.addEventListener("playing", markAlive, { once: true });

        // Native HLS (Safari) o hls.js
        try {
          if (v.canPlayType("application/vnd.apple.mpegurl")) {
            v.src = cam.src;
            await v.play().catch(() => {});
          } else {
            const ok = await ensureHlsJs();
            if (!ok || !window.Hls) throw new Error("Hls.js no disponible");
            const hls = new window.Hls({ lowLatencyMode: true });
            this.hls = hls;
            hls.attachMedia(v);
            hls.on(window.Hls.Events.MEDIA_ATTACHED, () => {
              hls.loadSource(cam.src);
            });
            hls.on(window.Hls.Events.ERROR, (evt, data) => {
              if (!data?.fatal) return;
              try { hls.destroy(); } catch {}
            });
            await v.play().catch(() => {});
          }
        } catch (e) {
          console.warn("[HLS] fail", e);
          s.failCount++;
          s.alive = false;
          if (s.idx === STATE.activeSlot) setNowUIFromActive("(error HLS)");
          emitState();
          return false;
        }
        return true;
      }

      // ── IMAGE ───────────────────────────────────────────────────────────────
      if (cam.kind === "image") {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        img.src = cam.src;
        this.media.appendChild(img);
        this.elem = img;

        img.addEventListener("load", () => {
          if (t !== this.token) return;
          s.alive = true;
          s.lastGoodAt = nowMs();
          if (s.idx === STATE.activeSlot) setNowUIFromActive();
          emitState();
        }, { once: true });

        img.addEventListener("error", () => {
          if (t !== this.token) return;
          s.failCount++;
          s.alive = false;
          if (s.idx === STATE.activeSlot) setNowUIFromActive("(error IMG)");
          emitState();
        }, { once: true });

        return true;
      }

      return false;
    }
  }

  function computeGrid(n) {
    // cols ~ sqrt, rows = ceil(n/cols)
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    return { cols, rows };
  }

  function rebuildLayout(n) {
    STATE.layoutN = clamp(Number(n) || 1, 1, 12);
    applyHudScaleForLayout(STATE.layoutN);

    // clear
    UI.playerArea.innerHTML = "";
    SLOTS.length = 0;
    TILES.length = 0;

    const { cols, rows } = computeGrid(STATE.layoutN);
    UI.playerArea.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    UI.playerArea.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

    for (let i = 0; i < STATE.layoutN; i++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      const media = document.createElement("div");
      media.className = "tileMedia";
      tile.appendChild(media);

      UI.playerArea.appendChild(tile);

      const slot = {
        idx: i,
        cam: null,
        alive: false,
        failCount: 0,
        lastGoodAt: 0,
        tz: "",
        weather: null,
        rotate: { enabled: false, intervalSec: 40, kind: "any", tag: "" },
        mode: "manual",
        _rotTimer: 0,
      };
      SLOTS.push(slot);

      const tp = new TilePlayer(i, tile, media);
      TILES.push(tp);

      tile.addEventListener("click", () => setActiveSlot(i), { passive: true });
    }

    // keep activeSlot in range
    STATE.activeSlot = clamp(STATE.activeSlot, 0, STATE.layoutN - 1);
    refreshActiveVisual();
    setNowUIFromActive();
    emitState({ layoutChanged: true });
  }

  function refreshActiveVisual() {
    for (let i = 0; i < TILES.length; i++) TILES[i].setActive(i === STATE.activeSlot);
  }

  function setActiveSlot(i) {
    const idx = clamp(Number(i) || 0, 0, Math.max(0, STATE.layoutN - 1));
    STATE.activeSlot = idx;
    refreshActiveVisual();
    setNowUIFromActive();
    emitState({ activeSlotChanged: true });
  }

  async function playInSlot(slotIndex, cam, reason = "manual") {
    const idx = clamp(Number(slotIndex) || 0, 0, Math.max(0, STATE.layoutN - 1));
    setActiveSlot(idx);

    const ok = await TILES[idx].play(cam, reason);
    if (ok) {
      // persist last state (slots)
      persistLast();
    }
    return ok;
  }

  function stopSlot(slotIndex, reason = "Stop") {
    const idx = clamp(Number(slotIndex) || 0, 0, Math.max(0, STATE.layoutN - 1));
    TILES[idx].stop(reason);
    persistLast();
    emitState({ stopSlot: idx });
  }

  function stopAll(reason = "Stop") {
    for (let i = 0; i < TILES.length; i++) TILES[i].stop(reason);
    setModeLabel("manual");
    setSignal("warn", "stopped");
    setNowUIFromActive(reason ? `(${reason})` : "");
    emitState({ stopAll: true });
  }

  function persistLast() {
    try {
      const data = {
        layoutN: STATE.layoutN,
        activeSlot: STATE.activeSlot,
        muted: !!PLAY.muted,
        hudVisible: !!STATE.hudVisible,
        slots: SLOTS.map(s => s.cam?.id || null),
      };
      localStorage.setItem(LS_LAST, JSON.stringify(data));
    } catch {}
  }

  function restoreLast() {
    try {
      const raw = localStorage.getItem(LS_LAST);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object") return null;
      return j;
    } catch { return null; }
  }

  // Rotation (por slot)
  function disarmRotate(slot) {
    const s = SLOTS[slot];
    if (!s) return;
    if (s._rotTimer) window.clearTimeout(s._rotTimer);
    s._rotTimer = 0;
  }

  function armRotate(slot) {
    const s = SLOTS[slot];
    if (!s) return;
    disarmRotate(slot);
    if (!s.rotate.enabled) return;

    const ms = clamp(Number(s.rotate.intervalSec) || 40, 5, 3600) * 1000;
    s._rotTimer = window.setTimeout(() => rotateNext(slot, "timer"), ms);
  }

  function pickNextCamForSlot(slot) {
    const s = SLOTS[slot];
    if (!s) return null;

    const wantKind = String(s.rotate.kind || "any");
    const wantTag = String(s.rotate.tag || "");

    // pool simple, respeta filtros
    const pool = CATALOG.list.filter(c => {
      if (!c) return false;
      if (wantKind !== "any" && c.kind !== wantKind) return false;
      if (wantTag && !(c.tags || []).includes(wantTag)) return false;
      return true;
    });

    if (!pool.length) return null;

    // evita repetir el mismo
    const curId = s.cam?.id || "";
    if (pool.length === 1) return pool[0];

    // random con pocos intentos
    for (let i = 0; i < 8; i++) {
      const c = pool[(Math.random() * pool.length) | 0];
      if (c.id !== curId) return c;
    }
    return pool[(Math.random() * pool.length) | 0];
  }

  async function rotateNext(slot, why = "rotate") {
    const s = SLOTS[slot];
    if (!s || !s.rotate.enabled) return;

    const cam = pickNextCamForSlot(slot);
    if (!cam) {
      toast("Rotación: no hay cams que cumplan filtros");
      disarmRotate(slot);
      s.rotate.enabled = false;
      emitState();
      return;
    }
    await playInSlot(slot, cam, "rotate");
    armRotate(slot);
  }

  function setRotate(slot, cfg) {
    const s = SLOTS[slot];
    if (!s) return;

    const enabled = !!cfg.enabled;
    const intervalSec = clamp(Number(cfg.intervalSec) || 40, 5, 3600);
    const kind = String(cfg.kind || "any");
    const tag = String(cfg.tag || "");

    s.rotate = { enabled, intervalSec, kind, tag };
    s.mode = enabled ? "rotate" : "manual";

    if (slot === STATE.activeSlot) setModeLabel(s.mode);
    if (enabled) armRotate(slot);
    else disarmRotate(slot);

    emitState({ rotateChanged: true });
  }

  // Fullscreen best-effort
  async function setFullscreen(enabled) {
    const want = !!enabled;
    try {
      const isFs = !!document.fullscreenElement;
      if (want && !isFs) {
        await UI.stage.requestFullscreen();
      } else if (!want && isFs) {
        await document.exitFullscreen();
      }
      emitState();
      return true;
    } catch (e) {
      // Normal: browsers requieren gesto dentro de la página del player
      toast("Fullscreen requiere click en el Player (pulsa F).");
      emitState();
      return false;
    }
  }

  // Emit state
  function publicState() {
    const active = SLOTS[STATE.activeSlot];
    return {
      app: { name: APP.name, ver: APP.ver, protocol: APP.protocol },
      layoutN: STATE.layoutN,
      activeSlot: STATE.activeSlot,
      muted: !!PLAY.muted,
      hudVisible: !!STATE.hudVisible,
      fullscreen: !!document.fullscreenElement,
      mode: active?.mode || "manual",
      rotate: active ? { ...active.rotate } : { enabled: false, intervalSec: 40, kind: "any", tag: "" },
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
      seenControlAgoMs: STATE.lastControlSeenAt ? (nowMs() - STATE.lastControlSeenAt) : null,
      lastError: String(STATE.lastError || ""),
    };
  }

  function emitState(extra = {}) {
    const payload = {
      v: APP.protocol,
      key: P.key,
      ts: nowMs(),
      nonce: randId(12),
      from: "player",
      type: "STATE",
      state: { ...publicState(), ...extra }
    };
    emit("STATE", payload);
  }

  // Command handling
  function handleCommand(cmdRaw, data, cmdNonce) {
    const cmd = String(cmdRaw || "").toUpperCase().trim();
    const d = (data && typeof data === "object") ? data : {};

    // compat aliases
    const ALIASES = {
      LAYOUT: "LAYOUT_SET",
      SET_LAYOUT: "LAYOUT_SET",
      SLOT: "SLOT_SET",
      SET_SLOT: "SLOT_SET",
      PLAY: "PLAY_ID",
      TAKE: "PLAY_ID",
      STOP: "STOP_ALL",
      STOPALL: "STOP_ALL",
      STOP_SLOT: "STOP_SLOT",
      MUTE: "MUTE_TOGGLE",
      ROTATE: "ROTATE_SET",
    };
    const C = ALIASES[cmd] || cmd;

    const slot = (d.slot !== undefined) ? d.slot : STATE.activeSlot;

    try {
      if (C === "PING") {
        STATE.lastControlSeenAt = nowMs();
        emitState({ pong: true });
        sendACK(cmdNonce, C, true, "pong");
        return;
      }

      if (C === "HUD_SET") {
        setHudVisible(!!d.enabled);
        sendACK(cmdNonce, C, true, STATE.hudVisible ? "hud on" : "hud off");
        return;
      }
      if (C === "HUD_TOGGLE") {
        setHudVisible(!STATE.hudVisible);
        sendACK(cmdNonce, C, true, STATE.hudVisible ? "hud on" : "hud off");
        return;
      }

      if (C === "FULLSCREEN_SET") {
        setFullscreen(!!d.enabled).then(() => {});
        sendACK(cmdNonce, C, true, "fs request");
        return;
      }
      if (C === "FULLSCREEN_TOGGLE") {
        setFullscreen(!document.fullscreenElement).then(() => {});
        sendACK(cmdNonce, C, true, "fs toggle");
        return;
      }

      if (C === "MUTE_SET") {
        setMuted(!!d.enabled);
        sendACK(cmdNonce, C, true, PLAY.muted ? "muted" : "unmuted");
        return;
      }
      if (C === "MUTE_TOGGLE") {
        setMuted(!PLAY.muted);
        sendACK(cmdNonce, C, true, PLAY.muted ? "muted" : "unmuted");
        return;
      }

      if (C === "LAYOUT_SET") {
        const n = clamp(Number(d.n ?? d.layout ?? d.count) || STATE.layoutN, 1, 12);
        rebuildLayout(n);
        sendACK(cmdNonce, C, true, `layout ${n}`);
        persistLast();
        return;
      }

      if (C === "SLOT_SET") {
        setActiveSlot(slot);
        const mode = SLOTS[STATE.activeSlot]?.mode || "manual";
        setModeLabel(mode);
        sendACK(cmdNonce, C, true, `slot ${STATE.activeSlot + 1}`);
        persistLast();
        return;
      }

      if (C === "PLAY_ID") {
        const id = String(d.id || d.camId || d.cameraId || "").trim();
        const cam = CATALOG.byId.get(id);
        if (!cam) {
          toast("Cam no encontrada: " + id);
          STATE.lastError = "Cam no encontrada";
          emitState();
          sendACK(cmdNonce, C, false, "cam not found");
          return;
        }
        playInSlot(slot, cam, "manual").then(() => {});
        sendACK(cmdNonce, C, true, `play ${id}`);
        return;
      }

      if (C === "PLAY_URL") {
        const url = String(d.url || "").trim();
        const kind = String(d.kind || "").trim();
        const src = String(d.src || "").trim();
        let k = kind, s = src;

        if (url && (!k || !s)) {
          const g = guessKindFromUrl(url);
          k = g.kind; s = g.src;
        }

        if (!k || !s) {
          toast("URL no válida o no soportada");
          sendACK(cmdNonce, C, false, "bad url");
          return;
        }

        const temp = normalizeCamObj({
          id: d.id || `url_${randId(8)}`,
          title: String(d.title || "URL Cam"),
          kind: k,
          src: s,
          tags: Array.isArray(d.tags) ? d.tags : [],
          region: String(d.region || ""),
          city: String(d.city || ""),
          country: String(d.country || ""),
          continent: String(d.continent || ""),
          tz: String(d.tz || ""),
          lat: Number.isFinite(+d.lat) ? +d.lat : null,
          lon: Number.isFinite(+d.lon) ? +d.lon : null,
        }) || null;

        if (!temp) {
          toast("No pude crear cam desde URL");
          sendACK(cmdNonce, C, false, "temp cam fail");
          return;
        }

        playInSlot(slot, temp, "url").then(() => {});
        sendACK(cmdNonce, C, true, "play url");
        return;
      }

      if (C === "STOP_SLOT") {
        stopSlot(slot, "Stop");
        sendACK(cmdNonce, C, true, "stop slot");
        return;
      }

      if (C === "STOP_ALL") {
        stopAll("Stop");
        sendACK(cmdNonce, C, true, "stop all");
        return;
      }

      if (C === "NEXT" || C === "PREV") {
        // En manual: siguiente random del catálogo (simple). En rotación: rotateNext
        const s = SLOTS[slot];
        if (!s) return;

        if (s.rotate.enabled) {
          rotateNext(slot, C.toLowerCase()).then(() => {});
          sendACK(cmdNonce, C, true, "rotate next");
          return;
        }

        if (!CATALOG.list.length) {
          sendACK(cmdNonce, C, false, "empty catalog");
          return;
        }

        // simple next/prev relativo al id actual
        const curId = s.cam?.id || "";
        const idx = curId ? CATALOG.list.findIndex(x => x.id === curId) : -1;
        let ni = (idx < 0) ? 0 : idx + (C === "NEXT" ? 1 : -1);
        if (ni < 0) ni = CATALOG.list.length - 1;
        if (ni >= CATALOG.list.length) ni = 0;

        playInSlot(slot, CATALOG.list[ni], "manual").then(() => {});
        sendACK(cmdNonce, C, true, C.toLowerCase());
        return;
      }

      if (C === "ROTATE_SET") {
        const enabled = !!(d.enabled ?? d.on ?? d.rotate);
        const intervalSec = d.intervalSec ?? d.sec ?? d.interval ?? 40;
        const kind = d.kind ?? "any";
        const tag = d.tag ?? "";
        setRotate(clamp(Number(slot) || 0, 0, STATE.layoutN - 1), { enabled, intervalSec, kind, tag });
        if (slot === STATE.activeSlot) setModeLabel(enabled ? "rotate" : "manual");
        sendACK(cmdNonce, C, true, enabled ? "rotate on" : "rotate off");
        return;
      }

      if (C === "ROTATE_NOW") {
        rotateNext(clamp(Number(slot) || 0, 0, STATE.layoutN - 1), "manual").then(() => {});
        sendACK(cmdNonce, C, true, "rotate now");
        return;
      }

      // desconocido
      sendACK(cmdNonce, C, false, "unknown cmd");
    } catch (e) {
      console.warn("[cmd] error", cmd, e);
      sendACK(cmdNonce, C, false, "exception");
    }
  }

  function onCMD(payload) {
    try {
      if (!payload || payload.v !== APP.protocol) return;
      if (payload.key !== P.key) return;
      if (payload.type !== "CMD") return;
      if (payload.from !== "control") return;

      const ts = Number(payload.ts || 0);
      const nonce = String(payload.nonce || "");
      if (!nonce || !ts) return;
      if (seenRecently(nonce, ts)) return;

      STATE.lastControlSeenAt = nowMs();
      handleCommand(payload.cmd, payload.data, payload.nonce);
    } catch {}
  }

  if (bc) bc.onmessage = (e) => onCMD(e.data);
  window.addEventListener("storage", (e) => {
    if (e.key !== LS_CMD) return;
    try { onCMD(JSON.parse(e.newValue || "null")); } catch {}
  });

  // UI events
  UI.btnMute.addEventListener("click", () => setMuted(!PLAY.muted));
  UI.btnStop.addEventListener("click", () => stopAll("Stop"));

  UI.btnFs.addEventListener("click", () => {
    const want = !document.fullscreenElement;
    setFullscreen(want).then(() => {});
  });

  window.addEventListener("fullscreenchange", () => emitState({ fsChanged: true }));

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === "f") UI.btnFs.click();
    if (k === "m") UI.btnMute.click();
    if (k === "s") UI.btnStop.click();
    if (k === "h") setHudVisible(!STATE.hudVisible);
    if (k === "n") handleCommand("NEXT", {}, randId(10));
    if (/^[1-9]$/.test(k)) setActiveSlot(parseInt(k, 10) - 1);
  });

  // Tick: actualizar hora y refrescar badges / global HUD
  setInterval(() => {
    for (let i = 0; i < SLOTS.length; i++) {
      const s = SLOTS[i];
      const cam = s.cam;
      if (!cam) continue;
      // refresca weather cada ~10m por cache (solo si hay lat/lon)
      // badges re-render “barato” en global + tile si tiene tz
      if (s.tz || cam.tz) {
        if (i === STATE.activeSlot) setNowUIFromActive();
        // nota: badges de tile se refrescan solo indirectamente (al cambiar cam),
        // pero el usuario pidió “hora actual”, así que al menos global siempre al día.
      }
    }
  }, 1000);

  // Heartbeat
  setInterval(() => {
    const ago = STATE.lastControlSeenAt ? (nowMs() - STATE.lastControlSeenAt) : 999999;
    setConn(ago < 5000, ago < 5000 ? "Control: conectado" : "Control: esperando");
    emitState({ heartbeat: true });
  }, 1500);

  // Boot
  (async function boot() {
    setConn(false, "Control: esperando");
    setModeLabel("manual");
    setSignal("warn", "boot…");
    setMuted(PLAY.muted);
    setHudVisible(STATE.hudVisible);

    await loadCams();

    // restore last
    const last = restoreLast();
    if (last && typeof last === "object") {
      STATE.layoutN = clamp(Number(last.layoutN) || STATE.layoutN, 1, 12);
      STATE.activeSlot = clamp(Number(last.activeSlot) || 0, 0, STATE.layoutN - 1);
      if (typeof last.muted === "boolean") PLAY.muted = last.muted;
      if (typeof last.hudVisible === "boolean") STATE.hudVisible = last.hudVisible;
    }

    rebuildLayout(STATE.layoutN);
    setMuted(PLAY.muted);
    setHudVisible(STATE.hudVisible);

    if (P.autoplay) {
      // Si hay slots guardados, intenta reproducirlos
      if (last?.slots && Array.isArray(last.slots)) {
        for (let i = 0; i < Math.min(last.slots.length, STATE.layoutN); i++) {
          const id = String(last.slots[i] || "");
          const cam = id ? CATALOG.byId.get(id) : null;
          if (cam) playInSlot(i, cam, "boot").then(() => {});
        }
      } else if (CATALOG.list.length) {
        playInSlot(0, CATALOG.list[0], "boot").then(() => {});
      }
    }

    UI.subline.textContent = `Online • ${APP.name} v${APP.ver}`;
    setSignal("good", "ready");
    emitState({ boot: true });
  })();
})();
