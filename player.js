/* player.js — CamStudio Room PLAYER (v1.0)
   - Reproduce cams.json (youtube/hls/image)
   - Controlado por BroadcastChannel + fallback localStorage
   - Rotación y “health-check” para saltar señales muertas
*/
(() => {
  "use strict";

  const APP = {
    name: "CamStudioRoom",
    ver: "1.0.0",
    protocol: 1,
    camsUrl: "./cams.json",
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers “studio-grade”
  // ─────────────────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  const nowMs = () => Number(Date.now()); // 👈 no bitwise: timestamps reales
  const randId = (len = 10) => {
    const a = new Uint8Array(len);
    (crypto?.getRandomValues?.(a) || a.fill(Math.random() * 255));
    return [...a].map(x => (x % 36).toString(36)).join("");
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function parseParams() {
    const qp = new URLSearchParams(location.search);
    const key = (qp.get("key") || "main").trim() || "main";
    const autoplay = qp.get("autoplay") === "1";
    const startId = (qp.get("id") || "").trim();
    const mute = qp.get("mute") === "1";
    const mode = (qp.get("mode") || "").trim(); // manual | rotate
    const tag = (qp.get("tag") || "").trim();
    return { key, autoplay, startId, mute, mode, tag };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UI hooks
  // ─────────────────────────────────────────────────────────────────────────────
  const UI = {
    subline: $("subline"),
    nowName: $("nowName"),
    nowMeta: $("nowMeta"),
    txtKey: $("txtKey"),
    toast: $("toast"),
    playerArea: $("playerArea"),
    stage: $("stage"),
    pillConn: $("pillConn"),
    dotConn: $("dotConn"),
    txtConn: $("txtConn"),
    dotMode: $("dotMode"),
    txtMode: $("txtMode"),
    pillLive: $("pillLive"),
    dotLive: $("dotLive"),
    txtLive: $("txtLive"),
    sigText: $("sigText"),
    sigBars: $("sigBars"),
    btnFs: $("btnFs"),
    btnMute: $("btnMute"),
    txtMute: $("txtMute"),
    btnStop: $("btnStop"),
  };

  function toast(msg, ms = 2200) {
    if (!UI.toast) return;
    UI.toast.textContent = msg;
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
    // level: good|warn|bad
    UI.sigBars.className = "bars " + (level || "");
    UI.sigText.textContent = text || "idle";
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message bus (BroadcastChannel + localStorage fallback)
  // ─────────────────────────────────────────────────────────────────────────────
  const P = parseParams();
  UI.txtKey.textContent = P.key;

  const BUS_NAME = "camstudio_bus";
  const LS_CMD = `camstudio_cmd:${P.key}`;
  const LS_STATE = `camstudio_state:${P.key}`;
  const LS_LAST = `camstudio_last:${P.key}`;

  let bc = null;
  try { bc = new BroadcastChannel(BUS_NAME); } catch { bc = null; }

  const seen = new Map(); // nonce -> ts
  function seenRecently(nonce, ts) {
    const t = seen.get(nonce);
    if (t && Math.abs(ts - t) < 30_000) return true;
    seen.set(nonce, ts);
    // poda
    if (seen.size > 300) {
      const cut = nowMs() - 60_000;
      for (const [k,v] of seen) if (v < cut) seen.delete(k);
    }
    return false;
  }

  function emitState(extra = {}) {
    const payload = {
      v: APP.protocol,
      key: P.key,
      ts: nowMs(),
      nonce: randId(12),
      from: "player",
      type: "STATE",
      state: {
        ...STATE.publicState(),
        ...extra,
      }
    };
    try { if (bc) bc.postMessage(payload); } catch {}
    try { localStorage.setItem(LS_STATE, JSON.stringify(payload)); } catch {}
  }

  function sendAck(cmdNonce, ok = true, note = "") {
    emitState({ ack: { cmdNonce, ok: !!ok, note: String(note || "") } });
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Cams catalog
  // ─────────────────────────────────────────────────────────────────────────────
  const CATALOG = {
    list: [],
    byId: new Map(),
    meta: {},
  };

  async function loadCams({ soft = false } = {}) {
    UI.subline.textContent = "Cargando cams.json…";
    setSignal("warn", "loading catalog");

    try {
      const res = await fetch(APP.camsUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const cams = Array.isArray(json?.cams) ? json.cams : (Array.isArray(json) ? json : []);
      const meta = json?.meta || {};
      const clean = [];

      for (const c of cams) {
        if (!c || typeof c !== "object") continue;
        if (c.disabled) continue;
        const id = String(c.id || "").trim();
        const kind = String(c.kind || "").trim();
        const src = String(c.src || "").trim();
        if (!id || !kind || !src) continue;
        clean.push({
          id,
          title: String(c.title || id),
          kind,
          src,
          tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
          region: String(c.region || ""),
          priority: Number.isFinite(+c.priority) ? +c.priority : 0,
          weight: Number.isFinite(+c.weight) ? +c.weight : 1,
          thumb: String(c.thumb || ""),
          fallback: Array.isArray(c.fallback) ? c.fallback.map(String).filter(Boolean) : [],
        });
      }

      clean.sort((a,b) => (b.priority - a.priority) || a.title.localeCompare(b.title));
      CATALOG.list = clean;
      CATALOG.byId = new Map(clean.map(c => [c.id, c]));
      CATALOG.meta = meta;

      UI.subline.textContent = `Catálogo listo • ${clean.length} cams`;
      setSignal("good", "catalog OK");
      return true;
    } catch (err) {
      UI.subline.textContent = soft ? "Catálogo previo (fallback)" : "Error cargando catálogo";
      setSignal("bad", "catalog failed");
      console.warn("[player] loadCams failed:", err);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Playback engine (YouTube / HLS / Image)
  // ─────────────────────────────────────────────────────────────────────────────
  const PLAY = {
    current: null,        // cam object
    elem: null,           // iframe/video/img
    yt: null,             // YT.Player instance
    hls: null,            // Hls instance
    muted: !!P.mute,
    alive: false,
    startedAt: 0,
    lastGoodAt: 0,
    failCount: 0,
    rotateTimer: 0,
    playToken: 0,
  };

  const STATE = {
    mode: "manual", // manual|rotate
    rotate: { enabled: false, intervalSec: 40, kind: "any", tag: "" },
    lastError: "",
    lastControlSeenAt: 0,
    publicState() {
      return {
        app: { name: APP.name, ver: APP.ver, protocol: APP.protocol },
        mode: this.mode,
        rotate: { ...this.rotate },
        now: PLAY.current ? {
          id: PLAY.current.id,
          title: PLAY.current.title,
          kind: PLAY.current.kind,
          tags: PLAY.current.tags,
          region: PLAY.current.region,
        } : null,
        playing: !!PLAY.alive,
        muted: !!PLAY.muted,
        lastError: String(this.lastError || ""),
        lastGoodAt: PLAY.lastGoodAt || 0,
        failCount: PLAY.failCount || 0,
        seenControlAgoMs: this.lastControlSeenAt ? (nowMs() - this.lastControlSeenAt) : null,
      };
    }
  };

  function clearStage() {
    try {
      if (PLAY.yt && PLAY.yt.destroy) PLAY.yt.destroy();
    } catch {}
    PLAY.yt = null;

    try {
      if (PLAY.hls && PLAY.hls.destroy) PLAY.hls.destroy();
    } catch {}
    PLAY.hls = null;

    UI.playerArea.innerHTML = "";
    PLAY.elem = null;
    PLAY.alive = false;
    setLive(false);
  }

  function normalizeCam(cam) {
    if (!cam) return null;
    const c = CATALOG.byId.get(cam.id) || cam;
    return c || null;
  }

  function pickNext({ direction = 1, withinFilter = true } = {}) {
    const list = filteredList(withinFilter);
    if (!list.length) return null;
    if (!PLAY.current) return list[0];

    const idx = list.findIndex(x => x.id === PLAY.current.id);
    const next = list[(idx + direction + list.length) % list.length];
    return next || list[0];
  }

  function filteredList(applyRotateFilter = true) {
    const list = CATALOG.list.slice();
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

  // “random sin repetir” usando bolsa
  const BAG = {
    ids: [],
    refill() {
      const list = filteredList(true);
      const ids = list.map(c => c.id);
      // shuffle
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

  async function ensureYouTubeAPI() {
    if (window.YT && window.YT.Player) return true;
    // carga lazy de IFrame API
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);

      // si API llega por callback global
      const t0 = nowMs();
      const tick = () => {
        if (window.YT && window.YT.Player) return resolve(true);
        if (nowMs() - t0 > 8000) return resolve(false);
        setTimeout(tick, 80);
      };
      tick();
    });
  }

  async function ensureHlsJs() {
    if (window.Hls) return true;
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js";
      s.async = true;
      s.onload = () => resolve(!!window.Hls);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  function setNowUI(cam, extra = "") {
    if (!cam) {
      UI.nowName.textContent = "Sin señal";
      UI.nowMeta.textContent = extra || "Selecciona una cámara desde el panel de control.";
      return;
    }
    UI.nowName.textContent = cam.title || cam.id;
    const tags = cam.tags?.length ? `#${cam.tags.join(" #")}` : "";
    const region = cam.region ? ` · ${cam.region}` : "";
    UI.nowMeta.textContent = `${cam.kind.toUpperCase()} · ID: ${cam.id}${region}${tags ? " · " + tags : ""}${extra ? " · " + extra : ""}`;
  }

  function setMuted(m) {
    PLAY.muted = !!m;
    UI.txtMute.textContent = PLAY.muted ? "Mute" : "Unmute";
    UI.btnMute.firstChild.textContent = PLAY.muted ? "🔇" : "🔊";
    // aplica si hay video
    if (PLAY.elem && PLAY.elem.tagName === "VIDEO") {
      PLAY.elem.muted = PLAY.muted;
      PLAY.elem.volume = PLAY.muted ? 0 : 1;
    }
    // youtube: con IFrame API, el mute se aplica vía API si existe
    try {
      if (PLAY.yt && PLAY.yt.mute && PLAY.yt.unMute) {
        PLAY.muted ? PLAY.yt.mute() : PLAY.yt.unMute();
      }
    } catch {}
    emitState();
  }

  function stopPlayback(reason = "") {
    clearStage();
    setSignal("warn", reason || "stopped");
    STATE.lastError = reason ? String(reason) : "";
    setNowUI(null, reason ? `(${reason})` : "");
    emitState({ stopped: true, reason });
  }

  async function playCam(cam, { reason = "manual", noRotateReset = false } = {}) {
    cam = normalizeCam(cam);
    if (!cam) {
      STATE.lastError = "Cam no encontrada";
      setSignal("bad", "cam not found");
      setNowUI(null, "(cam no encontrada)");
      emitState();
      return false;
    }

    PLAY.playToken++;
    const token = PLAY.playToken;

    // si es manual, apaga “alive” hasta confirmar health-check
    PLAY.alive = false;
    setLive(false);
    PLAY.startedAt = nowMs();
    STATE.lastError = "";
    setSignal("warn", "loading…");
    setNowUI(cam, "cargando…");
    clearStage();

    // guardar último cam
    try { localStorage.setItem(LS_LAST, cam.id); } catch {}

    // reset de fallos si cambia cam
    PLAY.current = cam;

    // build element
    if (cam.kind === "youtube") {
      const okApi = await ensureYouTubeAPI();

      // contenedor
      const wrap = document.createElement("div");
      wrap.style.position = "absolute";
      wrap.style.inset = "0";
      UI.playerArea.appendChild(wrap);

      if (!okApi) {
        // fallback iframe “a pelo”
        const iframe = document.createElement("iframe");
        iframe.allow = "autoplay; encrypted-media; picture-in-picture";
        iframe.referrerPolicy = "strict-origin-when-cross-origin";
        iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(cam.src)}?autoplay=1&mute=${PLAY.muted ? 1 : 0}&controls=0&modestbranding=1&rel=0&playsinline=1`;
        wrap.appendChild(iframe);
        PLAY.elem = iframe;

        // health-check “suave” (solo load)
        const ok = await healthCheckIframe(iframe, token);
        return ok;
      }

      // YouTube Player API
      const ytDiv = document.createElement("div");
      ytDiv.id = "yt_" + randId(8);
      wrap.appendChild(ytDiv);

      const ytReady = await new Promise((resolve) => {
        let resolved = false;

        const player = new window.YT.Player(ytDiv.id, {
          videoId: cam.src,
          playerVars: {
            autoplay: 1,
            mute: PLAY.muted ? 1 : 0,
            controls: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3
          },
          events: {
            onReady: () => {
              try {
                if (PLAY.muted) player.mute();
                else player.unMute();
                player.playVideo?.();
              } catch {}
            },
            onStateChange: (e) => {
              // 1 = playing, 2 = paused, 3 = buffering
              if (token !== PLAY.playToken) return;
              if (e?.data === 1) {
                resolved = true;
                resolve(true);
              }
            },
            onError: () => {
              if (token !== PLAY.playToken) return;
              resolved = true;
              resolve(false);
            }
          }
        });

        PLAY.yt = player;
        PLAY.elem = wrap;

        // timeout
        const t0 = nowMs();
        const tick = () => {
          if (resolved) return;
          if (token !== PLAY.playToken) return;
          if (nowMs() - t0 > 12_000) return resolve(false);
          setTimeout(tick, 120);
        };
        tick();
      });

      if (!ytReady) {
        return handlePlayFail(cam, token, "YouTube no arrancó");
      }
      return handlePlayOk(cam, token, reason);
    }

    if (cam.kind === "hls") {
      const v = document.createElement("video");
      v.playsInline = true;
      v.autoplay = true;
      v.muted = PLAY.muted;
      v.controls = false;
      v.preload = "auto";

      UI.playerArea.appendChild(v);
      PLAY.elem = v;

      // HLS nativo (Safari / algunos)
      const canNative = v.canPlayType("application/vnd.apple.mpegurl");
      if (canNative) {
        v.src = cam.src;
        const ok = await healthCheckVideo(v, token);
        if (!ok) return handlePlayFail(cam, token, "HLS nativo falló");
        return handlePlayOk(cam, token, reason);
      }

      // hls.js
      const okHls = await ensureHlsJs();
      if (!okHls) {
        // fallback “sin hls.js”: intenta asignar igualmente
        v.src = cam.src;
        const ok = await healthCheckVideo(v, token);
        if (!ok) return handlePlayFail(cam, token, "HLS requiere hls.js");
        return handlePlayOk(cam, token, reason);
      }

      try {
        const hls = new window.Hls({
          enableWorker: true,
          lowLatencyMode: true,
          maxBufferLength: 18,
          maxMaxBufferLength: 30,
          backBufferLength: 10,
        });
        PLAY.hls = hls;
        hls.loadSource(cam.src);
        hls.attachMedia(v);
      } catch (e) {
        return handlePlayFail(cam, token, "hls.js attach falló");
      }

      const ok = await healthCheckVideo(v, token);
      if (!ok) return handlePlayFail(cam, token, "HLS no arrancó");
      return handlePlayOk(cam, token, reason);
    }

    if (cam.kind === "image") {
      const img = document.createElement("img");
      img.decoding = "async";
      img.loading = "eager";
      img.referrerPolicy = "strict-origin-when-cross-origin";
      // cache-bust suave para imágenes si quieren refresh
      const u = new URL(cam.src, location.href);
      u.searchParams.set("__t", String(nowMs()).slice(-7));
      img.src = u.toString();

      UI.playerArea.appendChild(img);
      PLAY.elem = img;

      const ok = await healthCheckImage(img, token);
      if (!ok) return handlePlayFail(cam, token, "Imagen no carga");
      return handlePlayOk(cam, token, reason);
    }

    return handlePlayFail(cam, token, "Tipo no soportado");
  }

  async function healthCheckIframe(iframe, token) {
    return new Promise((resolve) => {
      if (token !== PLAY.playToken) return resolve(false);

      let done = false;
      const ok = () => { if (done) return; done = true; resolve(true); };
      const bad = () => { if (done) return; done = true; resolve(false); };

      const t0 = nowMs();
      const tick = () => {
        if (done) return;
        if (token !== PLAY.playToken) return bad();
        // si carga y pasan unos segundos, damos ok “suave”
        if (nowMs() - t0 > 3500) return ok();
        setTimeout(tick, 80);
      };

      iframe.addEventListener("load", ok, { once:true });
      setTimeout(() => bad(), 12000);
      tick();
    });
  }

  async function healthCheckVideo(v, token) {
    return new Promise((resolve) => {
      if (token !== PLAY.playToken) return resolve(false);

      let done = false;
      const ok = () => { if (done) return; done = true; resolve(true); };
      const bad = () => { if (done) return; done = true; resolve(false); };

      const onPlaying = () => ok();
      const onError = () => bad();

      v.addEventListener("playing", onPlaying, { once:true });
      v.addEventListener("error", onError, { once:true });

      // try play
      try { v.play?.(); } catch {}

      setTimeout(() => bad(), 12000);
    });
  }

  async function healthCheckImage(img, token) {
    return new Promise((resolve) => {
      if (token !== PLAY.playToken) return resolve(false);

      let done = false;
      const ok = () => { if (done) return; done = true; resolve(true); };
      const bad = () => { if (done) return; done = true; resolve(false); };

      img.addEventListener("load", ok, { once:true });
      img.addEventListener("error", bad, { once:true });
      setTimeout(() => bad(), 9000);
    });
  }

  function handlePlayOk(cam, token, reason) {
    if (token !== PLAY.playToken) return false;
    PLAY.alive = true;
    PLAY.lastGoodAt = nowMs();
    PLAY.failCount = 0;

    setSignal("good", "on-air");
    setLive(true);
    setNowUI(cam, reason === "rotate" ? "rotación" : "en directo");
    emitState({ started: true, reason });

    // rotación: si está activa, programa siguiente tick
    if (STATE.rotate.enabled) armRotateTimer();

    return true;
  }

  async function handlePlayFail(cam, token, why) {
    if (token !== PLAY.playToken) return false;

    PLAY.alive = false;
    PLAY.failCount = (PLAY.failCount || 0) + 1;
    STATE.lastError = String(why || "Fallo al reproducir");
    setSignal("bad", "no signal");
    setLive(false);
    setNowUI(cam, "sin señal");
    emitState({ started: false, error: STATE.lastError });

    // si hay fallback, prueba 1 fallback rápido
    if (cam.fallback && cam.fallback.length) {
      const alt = cam.fallback[0];
      toast("Fallback…");
      const altCam = { ...cam, src: alt };
      await sleep(350);
      return playCam(altCam, { reason, noRotateReset: true });
    }

    // si estamos en rotación, auto-skip
    if (STATE.rotate.enabled) {
      toast("Señal caída • saltando…");
      await sleep(600);
      rotateNext("skip");
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rotation
  // ─────────────────────────────────────────────────────────────────────────────
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
    // elige next aleatorio sin repetir
    const nextId = BAG.nextId();
    const next = nextId ? CATALOG.byId.get(nextId) : null;
    if (!next) return;

    setModeLabel("rotate");
    await playCam(next, { reason: "rotate" });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Commands
  // ─────────────────────────────────────────────────────────────────────────────
  async function handleCommand(cmd, data, nonce) {
    const c = String(cmd || "").toUpperCase();

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

    if (c === "STOP") {
      disarmRotateTimer();
      STATE.rotate.enabled = false;
      STATE.mode = "manual";
      setModeLabel("manual");
      stopPlayback("Stop");
      sendAck(nonce, true, "stopped");
      return;
    }

    if (c === "MUTE_SET") {
      setMuted(!!data.muted);
      sendAck(nonce, true, "mute set");
      return;
    }

    if (c === "MODE_SET") {
      const mode = (String(data.mode || "manual").toLowerCase() === "rotate") ? "rotate" : "manual";
      STATE.mode = mode;
      setModeLabel(mode);
      sendAck(nonce, true, "mode set");
      emitState();
      return;
    }

    if (c === "ROTATE_SET") {
      const enabled = !!data.enabled;
      const intervalSec = clamp(Number(data.intervalSec || 40), 8, 3600);
      const kind = String(data.kind || "any");
      const tag = String(data.tag || "");

      STATE.rotate = { enabled, intervalSec, kind, tag };
      STATE.mode = enabled ? "rotate" : "manual";
      setModeLabel(STATE.mode);

      if (enabled) {
        BAG.refill();
        armRotateTimer();
        // opcional: rotar ya
        if (data.rotateNow) rotateNext("rotateNow");
      } else {
        disarmRotateTimer();
      }

      sendAck(nonce, true, enabled ? "rotate enabled" : "rotate disabled");
      emitState();
      return;
    }

    if (c === "PLAY_ID") {
      disarmRotateTimer();
      STATE.rotate.enabled = false;
      STATE.mode = "manual";
      setModeLabel("manual");

      const id = String(data.id || "").trim();
      const cam = CATALOG.byId.get(id);
      const ok = await playCam(cam, { reason: "manual" });
      sendAck(nonce, ok, ok ? "playing" : "failed");
      return;
    }

    if (c === "NEXT") {
      const next = pickNext({ direction: 1, withinFilter: false });
      const ok = await playCam(next, { reason: "manual" });
      sendAck(nonce, ok, ok ? "next" : "failed");
      return;
    }

    if (c === "PREV") {
      const prev = pickNext({ direction: -1, withinFilter: false });
      const ok = await playCam(prev, { reason: "manual" });
      sendAck(nonce, ok, ok ? "prev" : "failed");
      return;
    }

    sendAck(nonce, false, "unknown cmd");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Controls (local player overlay)
  // ─────────────────────────────────────────────────────────────────────────────
  UI.btnFs.addEventListener("click", () => {
    try {
      if (!document.fullscreenElement) UI.stage.requestFullscreen?.();
      else document.exitFullscreen?.();
    } catch {}
  });

  UI.btnMute.addEventListener("click", () => setMuted(!PLAY.muted));
  UI.btnStop.addEventListener("click", () => stopPlayback("Stop"));

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === "f") UI.btnFs.click();
    if (k === "m") UI.btnMute.click();
    if (k === "s") UI.btnStop.click();
    if (k === "n") {
      // emite un “NEXT” como si viniera del control (solo local)
      handleCommand("NEXT", {}, randId(10));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────────────
  (async function boot() {
    setConn(false, "Control: esperando");
    setModeLabel("manual");
    setMuted(PLAY.muted);
    setNowUI(null);

    await loadCams();

    // intenta restaurar último cam
    let lastId = "";
    try { lastId = String(localStorage.getItem(LS_LAST) || ""); } catch {}
    const startId = P.startId || lastId;

    // modo por URL
    if (P.mode === "rotate") {
      STATE.rotate.enabled = true;
      STATE.mode = "rotate";
      setModeLabel("rotate");
      BAG.refill();
      armRotateTimer();
      // si autoplay, rota ya
      if (P.autoplay) rotateNext("boot");
    } else if (P.autoplay && startId) {
      const cam = CATALOG.byId.get(startId);
      await playCam(cam, { reason: "boot" });
    } else if (P.autoplay && !startId && CATALOG.list.length) {
      await playCam(CATALOG.list[0], { reason: "boot" });
    }

    // heartbeat de estado
    setInterval(() => {
      const ago = STATE.lastControlSeenAt ? (nowMs() - STATE.lastControlSeenAt) : 999999;
      setConn(ago < 5000, ago < 5000 ? "Control: conectado" : "Control: esperando");
      emitState({ heartbeat: true });
    }, 1500);

    UI.subline.textContent = `Online • ${APP.name} v${APP.ver}`;
    emitState({ boot: true });
  })();
})();
