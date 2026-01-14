/* control.js — CamStudio Room CONTROL (v1.2.0 | HUD/FS remoto + PLAY_URL + Autodetect URL + Scroll Fix)
   ✅ UI más ajustada + scroll global (grid overflow)
   ✅ Controles: HUD on/off, Fullscreen on/off, Mute
   ✅ PLAY_URL al slot activo (sin tocar catálogo)
   ✅ Autodetect URL → kind/src en editor
   ✅ Editor cams: add/edit/delete + override localStorage
   ✅ Export/Copy/Import JSON
   ✅ Geocode vía Open-Meteo geocoding (sin API key)
   ✅ Compat bus/STATE/ACK
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
    return { key };
  }
  const P = parseParams();

  // Storage / bus
  const BUS_NAME = "camstudio_bus";
  const LS_CMD = `camstudio_cmd:${P.key}`;
  const LS_STATE = `camstudio_state:${P.key}`;
  const LS_ACK = `camstudio_ack:${P.key}`;
  const LS_PREFS = `camstudio_prefs:${P.key}`;
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

  const UI = {
    subline: $("subline"),
    txtKey: $("txtKey"),

    dotPlayer: $("dotPlayer"),
    txtPlayer: $("txtPlayer"),

    dotMode: $("dotMode"),
    txtMode: $("txtMode"),

    btnPing: $("btnPing"),
    btnReloadCams: $("btnReloadCams"),

    btnPrev: $("btnPrev"),
    btnNext: $("btnNext"),
    btnStopSlot: $("btnStopSlot"),
    btnStop: $("btnStop"),

    btnHud: $("btnHud"),
    btnFs: $("btnFs"),
    btnMute: $("btnMute"),
    btnRotateNow: $("btnRotateNow"),

    q: $("q"),
    kind: $("kind"),
    tag: $("tag"),
    btnFavOnly: $("btnFavOnly"),
    btnClear: $("btnClear"),

    btnTake: $("btnTake"),

    btnLayout1: $("btnLayout1"),
    btnLayout2: $("btnLayout2"),
    btnLayout4: $("btnLayout4"),
    btnLayout6: $("btnLayout6"),
    btnLayout9: $("btnLayout9"),
    layoutN: $("layoutN"),
    btnLayoutApply: $("btnLayoutApply"),
    slotBar: $("slotBar"),

    quickUrl: $("quickUrl"),
    btnPlayUrl: $("btnPlayUrl"),
    btnFillFromUrl: $("btnFillFromUrl"),

    list: $("list"),
    txtCount: $("txtCount"),

    selTitle: $("selTitle"),
    selMeta: $("selMeta"),
    selId: $("selId"),
    selKind: $("selKind"),
    selSrc: $("selSrc"),
    selTags: $("selTags"),
    selRegion: $("selRegion"),
    selCity: $("selCity"),
    selCountry: $("selCountry"),
    selContinent: $("selContinent"),
    selTz: $("selTz"),
    selLatLon: $("selLatLon"),

    btnPlaySel: $("btnPlaySel"),
    btnFav: $("btnFav"),
    btnCopyId: $("btnCopyId"),
    btnEditFromSel: $("btnEditFromSel"),

    // editor
    btnNewCam: $("btnNewCam"),
    btnSaveCam: $("btnSaveCam"),
    btnDeleteCam: $("btnDeleteCam"),

    edId: $("edId"),
    edTitle: $("edTitle"),
    edUrl: $("edUrl"),
    edKind: $("edKind"),
    edSrc: $("edSrc"),
    edRegion: $("edRegion"),
    edTags: $("edTags"),
    edCity: $("edCity"),
    edCountry: $("edCountry"),
    edContinent: $("edContinent"),
    edTz: $("edTz"),
    edLat: $("edLat"),
    edLon: $("edLon"),
    edPriority: $("edPriority"),
    edWeight: $("edWeight"),

    btnParseUrl: $("btnParseUrl"),
    btnGeocode: $("btnGeocode"),
    btnClearOverride: $("btnClearOverride"),

    btnExportJson: $("btnExportJson"),
    btnCopyJson: $("btnCopyJson"),
    fileImport: $("fileImport"),
    txtJson: $("txtJson"),
    btnImportJson: $("btnImportJson"),
  };

  UI.txtKey.textContent = P.key;

  function setPlayerStatus(ok, label) {
    UI.dotPlayer.className = "dot " + (ok ? "good" : "warn");
    UI.txtPlayer.textContent = label || (ok ? "Player: conectado" : "Player: esperando");
  }
  function setModeLabel(mode) {
    const isRotate = mode === "rotate";
    UI.dotMode.className = "dot " + (isRotate ? "good" : "");
    UI.txtMode.textContent = "Modo: " + (isRotate ? "rotación" : "manual");
  }

  // CMD sender
  function sendCMD(cmd, data = {}) {
    const payload = {
      v: APP.protocol,
      key: P.key,
      ts: nowMs(),
      nonce: randId(12),
      from: "control",
      type: "CMD",
      cmd: String(cmd || "").toUpperCase(),
      data: data || {}
    };
    try { bc?.postMessage(payload); } catch {}
    try { localStorage.setItem(LS_CMD, JSON.stringify(payload)); } catch {}
    return payload.nonce;
  }

  // State + ACK
  let LAST_STATE = null;

  function onState(payload) {
    try {
      if (!payload || payload.v !== APP.protocol) return;
      if (payload.key !== P.key) return;
      if (payload.type !== "STATE") return;
      if (payload.from !== "player") return;

      const ts = Number(payload.ts || 0);
      const nonce = String(payload.nonce || "");
      if (!nonce || !ts) return;
      if (seenRecently(nonce, ts)) return;

      LAST_STATE = payload.state || null;
      renderFromState(LAST_STATE);
    } catch {}
  }

  function onAck(payload) {
    try {
      if (!payload || payload.v !== APP.protocol) return;
      if (payload.key !== P.key) return;
      if (payload.type !== "ACK") return;
      if (payload.from !== "player") return;

      const ts = Number(payload.ts || 0);
      const nonce = String(payload.nonce || "");
      if (!nonce || !ts) return;
      if (seenRecently(nonce, ts)) return;
      // no hace falta más, pero puedes usar payload.ack si quieres UI extra
    } catch {}
  }

  if (bc) bc.onmessage = (e) => {
    if (e?.data?.type === "STATE") onState(e.data);
    if (e?.data?.type === "ACK") onAck(e.data);
  };

  window.addEventListener("storage", (e) => {
    if (e.key === LS_STATE) {
      try { onState(JSON.parse(e.newValue || "null")); } catch {}
    }
    if (e.key === LS_ACK) {
      try { onAck(JSON.parse(e.newValue || "null")); } catch {}
    }
  });

  // Catalog
  const CATALOG = { list: [], byId: new Map(), tags: new Set(), meta: {} };

  const STATE = {
    prefs: {
      favOnly: false,
      q: "",
      kind: "any",
      tag: "",
      selectedId: "",
      favs: {},
      activeSlot: 0,
      layoutN: 4
    }
  };

  function savePrefs() {
    try { localStorage.setItem(LS_PREFS, JSON.stringify(STATE.prefs)); } catch {}
  }
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(LS_PREFS);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        STATE.prefs = {
          ...STATE.prefs,
          ...p,
          favs: (p.favs && typeof p.favs === "object") ? p.favs : STATE.prefs.favs,
        };
      }
    } catch {}
  }

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

  function normalizeCamObj(c) {
    if (!c || typeof c !== "object") return null;
    if (c.disabled) return null;

    const id = String(c.id || "").trim();
    const kind = String(c.kind || "").trim();
    const src = String(c.src || "").trim();
    if (!id || !kind || !src) return null;

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
      disabled: !!c.disabled,
      fallback: Array.isArray(c.fallback) ? c.fallback.map(String).filter(Boolean) : [],

      city: String(c.city || ""),
      country: String(c.country || ""),
      continent: String(c.continent || ""),
      tz: String(c.tz || ""),
      lat: num(c.lat, null),
      lon: num(c.lon, null),
    };
  }

  function buildTagsSet(list) {
    const s = new Set();
    for (const c of list) (c.tags || []).forEach(t => s.add(String(t)));
    return s;
  }

  async function loadCams() {
    UI.subline.textContent = "Cargando cams…";
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
      CATALOG.meta = json?.meta || {};

      const clean = [];
      for (const c of cams) {
        const item = normalizeCamObj(c);
        if (!item) continue;
        clean.push(item);
      }

      clean.sort((a, b) => (b.priority - a.priority) || a.title.localeCompare(b.title));
      CATALOG.list = clean;
      CATALOG.byId = new Map(clean.map(x => [x.id, x]));
      CATALOG.tags = buildTagsSet(clean);

      UI.subline.textContent = `Catálogo listo • ${clean.length} cams${override ? " (override)" : ""}`;
      UI.txtCount.textContent = `(${clean.length})`;

      fillTagSelects();
      renderList();
      restoreSelection();
      return true;
    } catch (err) {
      UI.subline.textContent = "Error cargando catálogo";
      console.warn("[control] loadCams failed:", err);
      return false;
    }
  }

  function fillTagSelects() {
    const tags = [...CATALOG.tags].sort((a, b) => a.localeCompare(b));
    const cur = UI.tag.value;
    UI.tag.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Tag: cualquiera";
    UI.tag.appendChild(opt0);

    for (const t of tags) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      UI.tag.appendChild(opt);
    }
    UI.tag.value = cur || "";
  }

  function setSelected(id) {
    const cam = id ? CATALOG.byId.get(id) : null;
    STATE.prefs.selectedId = cam?.id || "";
    savePrefs();
    renderSelection(cam);
    highlightActiveCard();
  }

  function renderSelection(cam) {
    if (!cam) {
      UI.selTitle.textContent = "Selecciona una cámara";
      UI.selMeta.textContent = "Haz click en una tarjeta del catálogo para ver detalles.";
      UI.selId.textContent = "—";
      UI.selKind.textContent = "—";
      UI.selSrc.textContent = "—";
      UI.selTags.textContent = "—";
      UI.selRegion.textContent = "—";
      UI.selCity.textContent = "—";
      UI.selCountry.textContent = "—";
      UI.selContinent.textContent = "—";
      UI.selTz.textContent = "—";
      UI.selLatLon.textContent = "—";
      return;
    }

    UI.selTitle.textContent = cam.title || cam.id;
    UI.selMeta.textContent = "Lista para asignar al slot activo o editar.";
    UI.selId.textContent = cam.id;
    UI.selKind.textContent = cam.kind;
    UI.selSrc.textContent = cam.src;
    UI.selTags.textContent = (cam.tags || []).join(", ");
    UI.selRegion.textContent = cam.region || "—";
    UI.selCity.textContent = cam.city || "—";
    UI.selCountry.textContent = cam.country || "—";
    UI.selContinent.textContent = cam.continent || "—";
    UI.selTz.textContent = cam.tz || "—";
    UI.selLatLon.textContent =
      (Number.isFinite(cam.lat) && Number.isFinite(cam.lon)) ? `${cam.lat}, ${cam.lon}` : "—";
  }

  function highlightActiveCard() {
    const id = STATE.prefs.selectedId;
    const cards = UI.list.querySelectorAll(".card[data-id]");
    cards.forEach(el => el.classList.toggle("active", el.getAttribute("data-id") === id));
  }

  function matchesFilters(cam) {
    if (!cam) return false;
    const q = String(STATE.prefs.q || "").trim().toLowerCase();
    const kind = String(STATE.prefs.kind || "any");
    const tag = String(STATE.prefs.tag || "");

    if (kind !== "any" && cam.kind !== kind) return false;
    if (tag && !(cam.tags || []).includes(tag)) return false;

    if (STATE.prefs.favOnly && !STATE.prefs.favs[cam.id]) return false;

    if (q) {
      const hay = `${cam.id} ${cam.title} ${(cam.tags || []).join(" ")} ${cam.region} ${cam.city} ${cam.country} ${cam.continent}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderList() {
    UI.list.innerHTML = "";
    const frag = document.createDocumentFragment();

    const list = CATALOG.list.filter(matchesFilters);
    for (const cam of list) {
      const el = document.createElement("div");
      el.className = "card";
      el.setAttribute("data-id", cam.id);

      const top = document.createElement("div");
      top.className = "cardTop";

      const title = document.createElement("div");
      title.className = "camTitle";
      title.textContent = cam.title || cam.id;

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = cam.kind;

      top.appendChild(title);
      top.appendChild(badge);

      const meta = document.createElement("div");
      meta.className = "cardMeta";
      const a = [];
      if (cam.region) a.push(cam.region);
      if (cam.city) a.push(cam.city);
      if (!cam.city && cam.title) a.push(cam.title.split("•")[0]?.trim() || "");
      meta.textContent = a.filter(Boolean).join(" · ") || "—";

      const tags = document.createElement("div");
      tags.className = "tags";
      tags.textContent = (cam.tags || []).length ? "#" + cam.tags.join(" #") : "";

      el.appendChild(top);
      el.appendChild(meta);
      el.appendChild(tags);

      el.addEventListener("click", () => setSelected(cam.id), { passive: true });
      frag.appendChild(el);
    }

    UI.list.appendChild(frag);
    highlightActiveCard();
  }

  function restoreSelection() {
    const id = STATE.prefs.selectedId;
    if (id && CATALOG.byId.has(id)) setSelected(id);
    else renderSelection(null);
  }

  // Slots UI
  function renderSlots(n, active) {
    UI.slotBar.innerHTML = "";
    const cnt = clamp(Number(n) || 1, 1, 12);
    for (let i = 0; i < cnt; i++) {
      const b = document.createElement("button");
      b.className = "slotbtn" + (i === active ? " active" : "");
      b.textContent = String(i + 1);
      b.addEventListener("click", () => {
        STATE.prefs.activeSlot = i;
        savePrefs();
        renderSlots(cnt, i);
        sendCMD("SLOT_SET", { slot: i });
      });
      UI.slotBar.appendChild(b);
    }
  }

  // URL helpers
  function extractYouTubeId(input) {
    const s = String(input || "").trim();
    if (!s) return "";
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
      const v = u.searchParams.get("v");
      if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(embed|shorts|live)\/([a-zA-Z0-9_-]{11})/);
      if (m && m[2]) return m[2];
    }
    return "";
  }

  function parseUrlToKindSrc(url) {
    const s = String(url || "").trim();
    if (!s) return { ok: false, kind: "", src: "" };

    const yid = extractYouTubeId(s);
    if (yid) return { ok: true, kind: "youtube", src: yid };

    if (/\.m3u8(\?|#|$)/i.test(s)) return { ok: true, kind: "hls", src: s };
    if (/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(s)) return { ok: true, kind: "image", src: s };

    if (/^https?:\/\//i.test(s)) return { ok: true, kind: "hls", src: s }; // fallback
    return { ok: false, kind: "", src: "" };
  }

  // Geocode (Open-Meteo geocoding)
  async function geocodeCity(city, country) {
    const name = [city, country].filter(Boolean).join(" ").trim();
    if (!name) return null;
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=es&format=json`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const r = j?.results?.[0];
    if (!r) return null;
    return {
      name: r.name || "",
      country: r.country || "",
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: r.timezone || ""
    };
  }

  // Override save/load
  function exportCurrentJson() {
    const meta = {
      schema: "camstudio.v1",
      version: "1.0",
      updatedAt: new Date().toISOString().slice(0, 10),
      notes: "Exportado desde Control Room (override local).",
    };
    return { meta, cams: CATALOG.list.map(c => ({ ...c })) };
  }

  function saveOverrideFromCatalog(list) {
    const meta = {
      schema: "camstudio.v1",
      version: "1.0",
      updatedAt: new Date().toISOString().slice(0, 10),
      notes: "Override local (Control Room).",
    };
    const json = { meta, cams: list.map(c => ({ ...c })) };
    try { localStorage.setItem(LS_CAMS_OVERRIDE, JSON.stringify(json)); } catch {}
  }

  // UI events
  function applyFiltersFromUI() {
    STATE.prefs.q = UI.q.value || "";
    STATE.prefs.kind = UI.kind.value || "any";
    STATE.prefs.tag = UI.tag.value || "";
    savePrefs();
    renderList();
  }

  UI.q.addEventListener("input", () => applyFiltersFromUI());
  UI.kind.addEventListener("change", () => applyFiltersFromUI());
  UI.tag.addEventListener("change", () => applyFiltersFromUI());

  UI.btnFavOnly.addEventListener("click", () => {
    STATE.prefs.favOnly = !STATE.prefs.favOnly;
    UI.btnFavOnly.textContent = STATE.prefs.favOnly ? "★ Fav: ON" : "★ Fav: OFF";
    savePrefs();
    renderList();
  });

  UI.btnClear.addEventListener("click", () => {
    UI.q.value = "";
    UI.kind.value = "any";
    UI.tag.value = "";
    STATE.prefs.q = "";
    STATE.prefs.kind = "any";
    STATE.prefs.tag = "";
    savePrefs();
    renderList();
  });

  UI.btnPing.addEventListener("click", () => sendCMD("PING", {}));
  UI.btnReloadCams.addEventListener("click", async () => { await loadCams(); });

  UI.btnPrev.addEventListener("click", () => sendCMD("PREV", { slot: STATE.prefs.activeSlot }));
  UI.btnNext.addEventListener("click", () => sendCMD("NEXT", { slot: STATE.prefs.activeSlot }));
  UI.btnStopSlot.addEventListener("click", () => sendCMD("STOP_SLOT", { slot: STATE.prefs.activeSlot }));
  UI.btnStop.addEventListener("click", () => sendCMD("STOP_ALL", {}));

  UI.btnMute.addEventListener("click", () => sendCMD("MUTE_TOGGLE", {}));
  UI.btnRotateNow.addEventListener("click", () => sendCMD("ROTATE_NOW", { slot: STATE.prefs.activeSlot }));

  UI.btnTake.addEventListener("click", () => {
    const id = STATE.prefs.selectedId;
    if (!id) return;
    sendCMD("PLAY_ID", { id, slot: STATE.prefs.activeSlot });
  });

  UI.btnHud.addEventListener("click", () => {
    const cur = !!LAST_STATE?.hudVisible;
    sendCMD("HUD_SET", { enabled: !cur });
  });

  UI.btnFs.addEventListener("click", () => {
    const cur = !!LAST_STATE?.fullscreen;
    sendCMD("FULLSCREEN_SET", { enabled: !cur });
  });

  UI.btnPlaySel.addEventListener("click", () => UI.btnTake.click());

  UI.btnFav.addEventListener("click", () => {
    const id = STATE.prefs.selectedId;
    if (!id) return;
    STATE.prefs.favs[id] = !STATE.prefs.favs[id];
    savePrefs();
    renderList();
    renderSelection(CATALOG.byId.get(id));
  });

  UI.btnCopyId.addEventListener("click", async () => {
    const id = STATE.prefs.selectedId;
    if (!id) return;
    try { await navigator.clipboard.writeText(id); } catch {}
  });

  UI.btnEditFromSel.addEventListener("click", () => {
    const id = STATE.prefs.selectedId;
    if (!id) return;
    const cam = CATALOG.byId.get(id);
    if (!cam) return;
    fillEditor(cam);
  });

  // Layout quick
  const setLayout = (n) => {
    const nn = clamp(Number(n) || 1, 1, 12);
    STATE.prefs.layoutN = nn;
    savePrefs();
    sendCMD("LAYOUT_SET", { n: nn });
    renderSlots(nn, clamp(STATE.prefs.activeSlot, 0, nn - 1));
  };

  UI.btnLayout1.addEventListener("click", () => setLayout(1));
  UI.btnLayout2.addEventListener("click", () => setLayout(2));
  UI.btnLayout4.addEventListener("click", () => setLayout(4));
  UI.btnLayout6.addEventListener("click", () => setLayout(6));
  UI.btnLayout9.addEventListener("click", () => setLayout(9));
  UI.btnLayoutApply.addEventListener("click", () => setLayout(UI.layoutN.value));

  // PLAY URL
  UI.btnPlayUrl.addEventListener("click", () => {
    const u = String(UI.quickUrl.value || "").trim();
    const p = parseUrlToKindSrc(u);
    if (!p.ok) return;
    sendCMD("PLAY_URL", { url: u, kind: p.kind, src: p.src, slot: STATE.prefs.activeSlot, title: "URL Cam" });
  });

  UI.btnFillFromUrl.addEventListener("click", () => {
    const u = String(UI.quickUrl.value || "").trim();
    if (!u) return;
    UI.edUrl.value = u;
    const p = parseUrlToKindSrc(u);
    if (!p.ok) return;
    UI.edKind.value = p.kind;
    UI.edSrc.value = p.src;
  });

  // Editor
  function fillEditor(cam) {
    UI.edId.value = cam.id || "";
    UI.edTitle.value = cam.title || "";
    UI.edKind.value = cam.kind || "youtube";
    UI.edSrc.value = cam.src || "";
    UI.edRegion.value = cam.region || "";
    UI.edTags.value = (cam.tags || []).join(", ");
    UI.edCity.value = cam.city || "";
    UI.edCountry.value = cam.country || "";
    UI.edContinent.value = cam.continent || "";
    UI.edTz.value = cam.tz || "";
    UI.edLat.value = (Number.isFinite(cam.lat) ? String(cam.lat) : "");
    UI.edLon.value = (Number.isFinite(cam.lon) ? String(cam.lon) : "");
    UI.edPriority.value = String(cam.priority ?? 0);
    UI.edWeight.value = String(cam.weight ?? 1);
  }

  function readEditorCam() {
    const id = String(UI.edId.value || "").trim();
    const title = String(UI.edTitle.value || "").trim() || id;
    const kind = String(UI.edKind.value || "").trim();
    const src = String(UI.edSrc.value || "").trim();
    if (!id || !kind || !src) return null;

    const tags = String(UI.edTags.value || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const num = (v, def = null) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : def;
    };

    return {
      id,
      title,
      kind,
      src,
      region: String(UI.edRegion.value || "").trim(),
      tags,
      city: String(UI.edCity.value || "").trim(),
      country: String(UI.edCountry.value || "").trim(),
      continent: String(UI.edContinent.value || "").trim(),
      tz: String(UI.edTz.value || "").trim(),
      lat: num(UI.edLat.value, null),
      lon: num(UI.edLon.value, null),
      priority: num(UI.edPriority.value, 0) ?? 0,
      weight: num(UI.edWeight.value, 1) ?? 1,
      thumb: "",
      disabled: false,
      fallback: [],
    };
  }

  UI.btnNewCam.addEventListener("click", () => fillEditor({
    id: "c" + randId(10),
    title: "",
    kind: "youtube",
    src: "",
    region: "",
    tags: [],
    city: "",
    country: "",
    continent: "",
    tz: "",
    lat: null,
    lon: null,
    priority: 50,
    weight: 1
  }));

  UI.btnParseUrl.addEventListener("click", () => {
    const u = String(UI.edUrl.value || "").trim() || String(UI.edSrc.value || "").trim();
    const p = parseUrlToKindSrc(u);
    if (!p.ok) return;
    UI.edKind.value = p.kind;
    UI.edSrc.value = p.src;
  });

  UI.btnGeocode.addEventListener("click", async () => {
    try {
      const city = String(UI.edCity.value || "").trim();
      const country = String(UI.edCountry.value || "").trim();
      const r = await geocodeCity(city, country);
      if (!r) return;
      UI.edLat.value = String(r.latitude ?? "");
      UI.edLon.value = String(r.longitude ?? "");
      if (r.country && !UI.edCountry.value) UI.edCountry.value = r.country;
      if (r.timezone) UI.edTz.value = r.timezone;
    } catch (e) {
      console.warn("[geocode] fail", e);
    }
  });

  UI.btnSaveCam.addEventListener("click", () => {
    const cam = readEditorCam();
    if (!cam) return;

    // upsert
    const idx = CATALOG.list.findIndex(x => x.id === cam.id);
    if (idx >= 0) CATALOG.list[idx] = { ...CATALOG.list[idx], ...cam };
    else CATALOG.list.push(cam);

    // re-sort
    CATALOG.list.sort((a, b) => (b.priority - a.priority) || a.title.localeCompare(b.title));
    CATALOG.byId = new Map(CATALOG.list.map(x => [x.id, x]));
    CATALOG.tags = buildTagsSet(CATALOG.list);
    fillTagSelects();
    renderList();

    saveOverrideFromCatalog(CATALOG.list);
    UI.subline.textContent = "Guardado en override local ✅";
  });

  UI.btnDeleteCam.addEventListener("click", () => {
    const id = String(UI.edId.value || "").trim();
    if (!id) return;
    CATALOG.list = CATALOG.list.filter(x => x.id !== id);
    CATALOG.byId = new Map(CATALOG.list.map(x => [x.id, x]));
    CATALOG.tags = buildTagsSet(CATALOG.list);
    fillTagSelects();
    renderList();
    saveOverrideFromCatalog(CATALOG.list);
    UI.subline.textContent = "Borrado en override local ✅";
  });

  UI.btnClearOverride.addEventListener("click", () => {
    try { localStorage.removeItem(LS_CAMS_OVERRIDE); } catch {}
    UI.subline.textContent = "Override borrado. Recarga catálogo.";
  });

  // Export/Import
  UI.btnExportJson.addEventListener("click", () => {
    const j = exportCurrentJson();
    UI.txtJson.value = JSON.stringify(j, null, 2);
  });

  UI.btnCopyJson.addEventListener("click", async () => {
    const t = String(UI.txtJson.value || "").trim();
    if (!t) return;
    try { await navigator.clipboard.writeText(t); } catch {}
  });

  UI.btnImportJson.addEventListener("click", () => {
    const t = String(UI.txtJson.value || "").trim();
    if (!t) return;
    try {
      const j = JSON.parse(t);
      const cams = Array.isArray(j?.cams) ? j.cams : (Array.isArray(j) ? j : null);
      if (!cams) return;

      const clean = [];
      for (const c of cams) {
        const it = normalizeCamObj(c);
        if (it) clean.push(it);
      }
      clean.sort((a, b) => (b.priority - a.priority) || a.title.localeCompare(b.title));

      CATALOG.list = clean;
      CATALOG.byId = new Map(clean.map(x => [x.id, x]));
      CATALOG.tags = buildTagsSet(clean);
      fillTagSelects();
      renderList();

      saveOverrideFromCatalog(CATALOG.list);
      UI.subline.textContent = "Import OK (override local) ✅";
    } catch (e) {
      console.warn("[import] fail", e);
    }
  });

  UI.fileImport.addEventListener("change", async () => {
    const f = UI.fileImport.files?.[0];
    if (!f) return;
    try {
      const txt = await f.text();
      UI.txtJson.value = txt;
    } catch {}
  });

  // Render from player state
  function renderFromState(st) {
    const ok = st && typeof st === "object";
    const ago = Number(st?.seenControlAgoMs);
    const playerOk = ok && (ago === null || !Number.isFinite(ago) || ago < 5000);

    setPlayerStatus(!!playerOk, playerOk ? "Player: conectado" : "Player: esperando");
    setModeLabel(String(st?.mode || "manual"));

    // HUD/FS labels
    const hv = (st?.hudVisible === false) ? false : true;
    UI.btnHud.textContent = hv ? "👁 HUD: ON" : "🙈 HUD: OFF";

    const fs = !!st?.fullscreen;
    UI.btnFs.textContent = fs ? "⛶ Fullscreen: ON" : "⛶ Fullscreen: OFF";

    // layout + slots
    const ln = clamp(Number(st?.layoutN) || STATE.prefs.layoutN, 1, 12);
    const active = clamp(Number(st?.activeSlot) || STATE.prefs.activeSlot, 0, ln - 1);

    STATE.prefs.layoutN = ln;
    STATE.prefs.activeSlot = active;
    savePrefs();
    renderSlots(ln, active);
  }

  // Boot
  (async function boot() {
    loadPrefs();

    UI.q.value = STATE.prefs.q || "";
    UI.kind.value = STATE.prefs.kind || "any";
    UI.tag.value = STATE.prefs.tag || "";
    UI.btnFavOnly.textContent = STATE.prefs.favOnly ? "★ Fav: ON" : "★ Fav: OFF";

    renderSlots(STATE.prefs.layoutN, STATE.prefs.activeSlot);

    setPlayerStatus(false, "Player: esperando");
    setModeLabel("manual");
    UI.subline.textContent = `Online • ${APP.name} v${APP.ver}`;

    await loadCams();
    applyFiltersFromUI();

    // ping periódico
    setInterval(() => sendCMD("PING", {}), 3000);
  })();
})();
