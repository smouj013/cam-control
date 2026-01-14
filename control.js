/* control.js — CamStudio Room CONTROL (v1.1.0 | MULTIVIEW + CATALOG EDITOR)
   ✅ Layout 1/2/4/6/9 + custom
   ✅ Slot select + TAKE por slot (no pisa otras cams)
   ✅ Editor cams: add/edit/delete + override localStorage
   ✅ Export/Copy/Import JSON + Geocode (OSM Nominatim)
   ✅ Compat bus/ACK/STATE como tu v1.0.1
*/
(() => {
  "use strict";

  const APP = {
    name: "CamStudioRoom",
    ver: "1.1.0",
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
  const LS_PREFS = `camstudio_prefs:${P.key}`;
  const LS_CAMS_OVERRIDE = `camstudio_cams_override:${P.key}`;

  let bc = null;
  try { bc = new BroadcastChannel(BUS_NAME); } catch { bc = null; }

  // UI
  const UI = {
    subline: $("subline"),
    txtKey: $("txtKey"),

    dotPlayer: $("dotPlayer"),
    txtPlayer: $("txtPlayer"),

    btnPing: $("btnPing"),
    btnReloadCams: $("btnReloadCams"),

    btnPrev: $("btnPrev"),
    btnNext: $("btnNext"),
    btnStopSlot: $("btnStopSlot"),
    btnStop: $("btnStop"),

    q: $("q"),
    kind: $("kind"),
    tag: $("tag"),
    btnFavOnly: $("btnFavOnly"),
    btnClear: $("btnClear"),

    dotMode: $("dotMode"),
    txtMode: $("txtMode"),
    btnTake: $("btnTake"),

    rotKind: $("rotKind"),
    rotSec: $("rotSec"),
    rotTag: $("rotTag"),
    btnRotate: $("btnRotate"),

    // multiview
    btnLayout1: $("btnLayout1"),
    btnLayout2: $("btnLayout2"),
    btnLayout4: $("btnLayout4"),
    btnLayout6: $("btnLayout6"),
    btnLayout9: $("btnLayout9"),
    layoutN: $("layoutN"),
    btnLayoutApply: $("btnLayoutApply"),
    slotBar: $("slotBar"),

    list: $("list"),
    txtCount: $("txtCount"),

    progTitle: $("progTitle"),
    progSub: $("progSub"),
    kpiState: $("kpiState"),
    kpiMute: $("kpiMute"),
    kpiFails: $("kpiFails"),

    btnMute: $("btnMute"),
    btnRotateNow: $("btnRotateNow"),

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
    UI.txtPlayer.textContent = label || (ok ? "Player: conectado" : "Player: desconectado");
  }

  function setModeLabel(mode) {
    const isRotate = mode === "rotate";
    UI.dotMode.className = "dot " + (isRotate ? "good" : "");
    UI.txtMode.textContent = "Modo: " + (isRotate ? "rotación" : "manual");
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
  }

  // CMD sender
  const seen = new Map();
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
    markPending(payload.nonce, payload.cmd);
    return payload.nonce;
  }

  const PENDING = new Map();
  function markPending(nonce, cmd) {
    PENDING.set(nonce, { cmd: String(cmd || ""), ts: nowMs() });
    const cut = nowMs() - 30_000;
    for (const [k, v] of PENDING) if (v.ts < cut) PENDING.delete(k);
  }

  // STATE from player
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
      renderProgram(LAST_STATE, ts);
    } catch {}
  }

  if (bc) bc.onmessage = (e) => onState(e.data);
  window.addEventListener("storage", (e) => {
    if (e.key !== LS_STATE) return;
    try { onState(JSON.parse(e.newValue || "null")); } catch {}
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
      layoutN: 4,
      rot: { enabled: false, intervalSec: 40, kind: "any", tag: "" }
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
          rot: (p.rot && typeof p.rot === "object")
            ? { ...STATE.prefs.rot, ...p.rot }
            : STATE.prefs.rot,
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

      // NUEVO
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
    const fill = (sel, allLabel) => {
      const cur = sel.value;
      sel.innerHTML = "";
      if (allLabel) {
        const opt0 = document.createElement("option");
        opt0.value = "";
        opt0.textContent = allLabel;
        sel.appendChild(opt0);
      }
      for (const t of tags) {
        const opt = document.createElement("option");
        opt.value = t;
        opt.textContent = `#${t}`;
        sel.appendChild(opt);
      }
      sel.value = cur;
    };
    fill(UI.tag, "Tag: (todas)");
    fill(UI.rotTag, "Rotación tag: (sin filtro)");
  }

  function filtered() {
    const q = (STATE.prefs.q || "").trim().toLowerCase();
    const kind = STATE.prefs.kind || "any";
    const tag = STATE.prefs.tag || "";
    const favOnly = !!STATE.prefs.favOnly;

    return CATALOG.list.filter(c => {
      if (kind !== "any" && c.kind !== kind) return false;
      if (tag && !c.tags.includes(tag)) return false;
      if (favOnly && !STATE.prefs.favs[c.id]) return false;

      if (!q) return true;
      const hay = [
        c.id, c.title, c.kind, c.region,
        (c.tags || []).join(" "),
        c.city, c.country, c.continent, c.tz
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  function renderList() {
    const list = filtered();
    UI.list.innerHTML = "";

    for (const c of list) {
      const el = document.createElement("div");
      el.className = "card" + (STATE.prefs.selectedId === c.id ? " active" : "");
      el.dataset.id = c.id;

      const fav = !!STATE.prefs.favs[c.id];
      const loc = [c.city, c.country || c.region].filter(Boolean).join(", ");

      el.innerHTML = `
        <div class="cardTop">
          <div class="camTitle" title="${escapeHTML(c.title)}">${escapeHTML(c.title)}</div>
          <div class="badge">${escapeHTML(c.kind)}${fav ? " ★" : ""}</div>
        </div>
        <div class="cardMeta">
          <span class="badge">${escapeHTML(c.id)}</span>
          ${c.region ? `<span class="badge">${escapeHTML(c.region)}</span>` : ""}
          ${loc ? `<span class="badge">${escapeHTML(loc)}</span>` : ""}
          ${(c.lat != null && c.lon != null) ? `<span class="badge">📍 ${c.lat.toFixed(2)},${c.lon.toFixed(2)}</span>` : ""}
        </div>
        <div class="tags">${c.tags?.length ? escapeHTML("#" + c.tags.join(" #")) : ""}</div>
      `;

      el.addEventListener("click", () => selectCam(c.id));
      UI.list.appendChild(el);
    }
  }

  function selectCam(id) {
    STATE.prefs.selectedId = id;
    savePrefs();
    renderList();
    renderSelection();
  }

  function restoreSelection() {
    const id = STATE.prefs.selectedId;
    if (id && CATALOG.byId.has(id)) renderSelection();
  }

  function renderSelection() {
    const cam = CATALOG.byId.get(STATE.prefs.selectedId);
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

    UI.selTitle.textContent = cam.title;
    UI.selMeta.textContent = `${cam.kind.toUpperCase()} · prioridad ${cam.priority} · weight ${cam.weight}`;
    UI.selId.textContent = cam.id;
    UI.selKind.textContent = cam.kind;
    UI.selSrc.textContent = cam.src;
    UI.selTags.textContent = cam.tags?.length ? cam.tags.join(", ") : "";
    UI.selRegion.textContent = cam.region || "";
    UI.selCity.textContent = cam.city || "";
    UI.selCountry.textContent = cam.country || "";
    UI.selContinent.textContent = cam.continent || "";
    UI.selTz.textContent = cam.tz || "";
    UI.selLatLon.textContent = (cam.lat != null && cam.lon != null) ? `${cam.lat}, ${cam.lon}` : "";
  }

  // Program render + slots
  function renderProgram(st, ts) {
    const ok = !!st;
    setPlayerStatus(ok, ok ? "Player: conectado" : "Player: desconectado");

    if (!st) {
      UI.progTitle.textContent = "Programa: —";
      UI.progSub.textContent = "Esperando estado del player…";
      UI.kpiState.textContent = "—";
      UI.kpiMute.textContent = "—";
      UI.kpiFails.textContent = "—";
      return;
    }

    const layoutN = Number(st.layoutN || 1) || 1;
    const activeSlot = Number.isFinite(+st.activeSlot) ? +st.activeSlot : 0;

    // sync UI layout/slot
    if (layoutN !== STATE.prefs.layoutN) {
      STATE.prefs.layoutN = layoutN;
      UI.layoutN.value = String(layoutN);
      buildSlotBar(layoutN);
    }
    if (activeSlot !== STATE.prefs.activeSlot) {
      STATE.prefs.activeSlot = clamp(activeSlot, 0, layoutN - 1);
      highlightSlotBtn();
    }

    const s = st.slots?.[STATE.prefs.activeSlot];
    const title = s?.title ? `Slot ${STATE.prefs.activeSlot + 1}: ${s.title}` : `Slot ${STATE.prefs.activeSlot + 1}: —`;

    UI.progTitle.textContent = `Programa: ${title}`;
    UI.progSub.textContent = `Layout ${layoutN} · Activo slot ${STATE.prefs.activeSlot + 1} · ${new Date(ts).toLocaleTimeString("es-ES")}`;

    UI.kpiState.textContent = (s?.playing ? "ON AIR" : "OFF");
    UI.kpiMute.textContent = st.muted ? "Muted" : "Audio";
    UI.kpiFails.textContent = String(s?.failCount ?? 0);

    // ACK feedback
    const ack = st.ack;
    if (ack?.cmdNonce && PENDING.has(ack.cmdNonce)) {
      const p = PENDING.get(ack.cmdNonce);
      PENDING.delete(ack.cmdNonce);
      UI.subline.textContent = `${ack.ok ? "✅" : "⚠️"} ${p.cmd} — ${ack.note || ""}`;
    }
  }

  function buildSlotBar(n) {
    UI.slotBar.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const b = document.createElement("div");
      b.className = "slotBtn";
      b.textContent = String(i + 1);
      b.dataset.slot = String(i);
      b.addEventListener("click", () => setActiveSlot(i, true));
      UI.slotBar.appendChild(b);
    }
    highlightSlotBtn();
  }

  function highlightSlotBtn() {
    const kids = UI.slotBar.querySelectorAll(".slotBtn");
    kids.forEach(el => {
      const s = Number(el.dataset.slot || 0);
      el.classList.toggle("active", s === STATE.prefs.activeSlot);
    });
  }

  function setActiveSlot(i, notifyPlayer) {
    i = clamp(Number(i) || 0, 0, Math.max(0, (STATE.prefs.layoutN || 1) - 1));
    STATE.prefs.activeSlot = i;
    savePrefs();
    highlightSlotBtn();
    if (notifyPlayer) sendCMD("SLOT_SET", { slot: i });
  }

  // Multiview: layout set
  function setLayout(n) {
    n = clamp(Number(n) || 1, 1, 12);
    STATE.prefs.layoutN = n;
    savePrefs();
    buildSlotBar(n);
    sendCMD("LAYOUT_SET", { n });
    // fuerza slot válido
    setActiveSlot(clamp(STATE.prefs.activeSlot, 0, n - 1), true);
  }

  // Rotation UI
  function readRotateUI() {
    const intervalSec = clamp(Number(UI.rotSec.value || 40), 8, 3600);
    const kind = UI.rotKind.value || "any";
    const tag = UI.rotTag.value || "";
    return { intervalSec, kind, tag };
  }

  // Editor helpers
  function slugifyId(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || `cam_${randId(6)}`;
  }

  function editorClear() {
    UI.edId.value = "";
    UI.edTitle.value = "";
    UI.edKind.value = "youtube";
    UI.edSrc.value = "";
    UI.edRegion.value = "";
    UI.edTags.value = "";
    UI.edCity.value = "";
    UI.edCountry.value = "";
    UI.edContinent.value = "";
    UI.edTz.value = "";
    UI.edLat.value = "";
    UI.edLon.value = "";
    UI.edPriority.value = "0";
    UI.edWeight.value = "1";
  }

  function editorFill(cam) {
    UI.edId.value = cam.id || "";
    UI.edTitle.value = cam.title || "";
    UI.edKind.value = cam.kind || "youtube";
    UI.edSrc.value = cam.src || "";
    UI.edRegion.value = cam.region || "";
    UI.edTags.value = (cam.tags || []).join(",");
    UI.edCity.value = cam.city || "";
    UI.edCountry.value = cam.country || "";
    UI.edContinent.value = cam.continent || "";
    UI.edTz.value = cam.tz || "";
    UI.edLat.value = (cam.lat != null) ? String(cam.lat) : "";
    UI.edLon.value = (cam.lon != null) ? String(cam.lon) : "";
    UI.edPriority.value = String(cam.priority ?? 0);
    UI.edWeight.value = String(cam.weight ?? 1);
  }

  function editorRead() {
    const id = (UI.edId.value || "").trim() || slugifyId(UI.edTitle.value);
    const kind = String(UI.edKind.value || "youtube").trim();
    const src = (UI.edSrc.value || "").trim();
    const tags = (UI.edTags.value || "").split(",").map(s => s.trim()).filter(Boolean);

    const numOrNull = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    return normalizeCamObj({
      id,
      title: (UI.edTitle.value || "").trim() || id,
      kind,
      src,
      region: (UI.edRegion.value || "").trim().toUpperCase(),
      tags,
      city: (UI.edCity.value || "").trim(),
      country: (UI.edCountry.value || "").trim(),
      continent: (UI.edContinent.value || "").trim(),
      tz: (UI.edTz.value || "").trim(),
      lat: numOrNull(UI.edLat.value),
      lon: numOrNull(UI.edLon.value),
      priority: numOrNull(UI.edPriority.value) ?? 0,
      weight: numOrNull(UI.edWeight.value) ?? 1,
      disabled: false,
      fallback: [],
    });
  }

  function saveOverrideCatalog(list) {
    const json = {
      meta: {
        schema: "camstudio.v1",
        version: "1.1",
        updatedAt: new Date().toISOString().slice(0, 10),
        note: "Override generado desde Control (localStorage). Exporta para reemplazar cams.json en el repo.",
      },
      cams: list.map(c => ({
        id: c.id, title: c.title, kind: c.kind, src: c.src,
        tags: c.tags, region: c.region,
        priority: c.priority, weight: c.weight,
        thumb: c.thumb || "", disabled: !!c.disabled,
        fallback: c.fallback || [],
        city: c.city || "", country: c.country || "", continent: c.continent || "",
        tz: c.tz || "", lat: c.lat ?? null, lon: c.lon ?? null,
      }))
    };
    try { localStorage.setItem(LS_CAMS_OVERRIDE, JSON.stringify(json)); } catch {}
    return json;
  }

  function clearOverrideCatalog() {
    try { localStorage.removeItem(LS_CAMS_OVERRIDE); } catch {}
  }

  function exportJson(jsonObj) {
    const blob = new Blob([JSON.stringify(jsonObj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cams.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(String(text || ""));
      UI.subline.textContent = "Copiado al portapapeles ✅";
      return true;
    } catch {
      // fallback
      try {
        const ta = document.createElement("textarea");
        ta.value = String(text || "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        UI.subline.textContent = "Copiado al portapapeles ✅";
        return true;
      } catch {
        UI.subline.textContent = "No se pudo copiar ⚠️";
        return false;
      }
    }
  }

  // Geocode (Nominatim)
  async function geocodeOSM(query) {
    const q = String(query || "").trim();
    if (!q) return null;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j) || !j.length) return null;
    return j[0];
  }

  // Events
  UI.q.addEventListener("input", () => { STATE.prefs.q = UI.q.value; savePrefs(); renderList(); });
  UI.kind.addEventListener("change", () => { STATE.prefs.kind = UI.kind.value; savePrefs(); renderList(); });
  UI.tag.addEventListener("change", () => { STATE.prefs.tag = UI.tag.value; savePrefs(); renderList(); });

  UI.btnFavOnly.addEventListener("click", () => {
    STATE.prefs.favOnly = !STATE.prefs.favOnly;
    UI.btnFavOnly.textContent = STATE.prefs.favOnly ? "★ Solo favs (ON)" : "★ Solo favs";
    savePrefs();
    renderList();
  });

  UI.btnClear.addEventListener("click", () => {
    STATE.prefs.q = "";
    STATE.prefs.kind = "any";
    STATE.prefs.tag = "";
    UI.q.value = "";
    UI.kind.value = "any";
    UI.tag.value = "";
    savePrefs();
    renderList();
  });

  UI.btnCopyId.addEventListener("click", async () => {
    const id = String(STATE.prefs.selectedId || "");
    if (!id) return;
    await copyToClipboard(id);
  });

  UI.btnFav.addEventListener("click", () => {
    const id = STATE.prefs.selectedId;
    if (!id) return;
    STATE.prefs.favs[id] = !STATE.prefs.favs[id];
    savePrefs();
    renderList();
    renderSelection();
  });

  // TAKE -> play selection in active slot
  function takeSelected() {
    const id = String(STATE.prefs.selectedId || "").trim();
    if (!id) return;
    sendCMD("SLOT_SET", { slot: STATE.prefs.activeSlot });
    sendCMD("PLAY_SLOT", { slot: STATE.prefs.activeSlot, id });
  }

  UI.btnTake.addEventListener("click", takeSelected);
  UI.btnPlaySel.addEventListener("click", takeSelected);

  UI.btnPrev.addEventListener("click", () => sendCMD("PREV", { slot: STATE.prefs.activeSlot }));
  UI.btnNext.addEventListener("click", () => sendCMD("NEXT", { slot: STATE.prefs.activeSlot }));
  UI.btnStopSlot.addEventListener("click", () => sendCMD("STOP_SLOT", { slot: STATE.prefs.activeSlot }));
  UI.btnStop.addEventListener("click", () => sendCMD("STOP", {}));

  UI.btnReloadCams.addEventListener("click", async () => {
    await loadCams();
    sendCMD("RELOAD_CAMS", {});
  });

  UI.btnPing.addEventListener("click", () => sendCMD("PING", {}));

  UI.btnMute.addEventListener("click", () => {
    const muted = !(LAST_STATE?.muted);
    sendCMD("MUTE_SET", { muted });
  });

  UI.btnRotateNow.addEventListener("click", () => {
    const r = readRotateUI();
    sendCMD("ROTATE_SET", { ...r, enabled: true, rotateNow: true });
  });

  UI.btnRotate.addEventListener("click", () => {
    const r = readRotateUI();
    const enabled = !(LAST_STATE?.rotate?.enabled ?? STATE.prefs.rot.enabled);
    const next = { ...r, enabled };
    sendCMD("ROTATE_SET", next);
    STATE.prefs.rot = next;
    UI.btnRotate.textContent = enabled ? "⟲ Rotación ON" : "⟲ Rotación";
    savePrefs();
  });

  // Layout buttons
  UI.btnLayout1.addEventListener("click", () => setLayout(1));
  UI.btnLayout2.addEventListener("click", () => setLayout(2));
  UI.btnLayout4.addEventListener("click", () => setLayout(4));
  UI.btnLayout6.addEventListener("click", () => setLayout(6));
  UI.btnLayout9.addEventListener("click", () => setLayout(9));
  UI.btnLayoutApply.addEventListener("click", () => setLayout(UI.layoutN.value));

  // Editor events
  UI.btnNewCam.addEventListener("click", () => {
    editorClear();
    UI.edId.value = slugifyId(UI.edTitle.value || "");
    UI.subline.textContent = "Editor: nueva cam";
  });

  UI.btnEditFromSel.addEventListener("click", () => {
    const cam = CATALOG.byId.get(STATE.prefs.selectedId);
    if (!cam) return;
    editorFill(cam);
    UI.subline.textContent = "Editor: cargado desde selección";
  });

  UI.btnSaveCam.addEventListener("click", async () => {
    const cam = editorRead();
    if (!cam || !cam.id || !cam.src || !cam.kind) {
      UI.subline.textContent = "Editor: faltan campos (id/kind/src) ⚠️";
      return;
    }

    const list = [...CATALOG.list];
    const idx = list.findIndex(x => x.id === cam.id);
    if (idx >= 0) list[idx] = cam;
    else list.push(cam);

    list.sort((a, b) => (b.priority - a.priority) || a.title.localeCompare(b.title));

    const json = saveOverrideCatalog(list);
    UI.subline.textContent = `Editor: guardado (override) ✅ (${list.length} cams)`;

    await loadCams(); // recarga del override
    sendCMD("RELOAD_CAMS", {}); // avisa al player
    UI.txtJson.value = JSON.stringify(json, null, 2);
  });

  UI.btnDeleteCam.addEventListener("click", async () => {
    const id = (UI.edId.value || "").trim();
    if (!id) { UI.subline.textContent = "Editor: pon un id para borrar"; return; }

    const list = CATALOG.list.filter(x => x.id !== id);
    const json = saveOverrideCatalog(list);
    UI.subline.textContent = `Editor: borrado ${id} ✅`;

    // si estaba seleccionada
    if (STATE.prefs.selectedId === id) {
      STATE.prefs.selectedId = "";
      savePrefs();
    }

    await loadCams();
    sendCMD("RELOAD_CAMS", {});
    UI.txtJson.value = JSON.stringify(json, null, 2);
  });

  UI.btnClearOverride.addEventListener("click", async () => {
    clearOverrideCatalog();
    UI.subline.textContent = "Override eliminado (vuelve a ./cams.json) ✅";
    await loadCams();
    sendCMD("RELOAD_CAMS", {});
  });

  UI.btnExportJson.addEventListener("click", () => {
    const json = readOverrideCatalog() || saveOverrideCatalog(CATALOG.list);
    exportJson(json);
  });

  UI.btnCopyJson.addEventListener("click", async () => {
    const json = readOverrideCatalog() || saveOverrideCatalog(CATALOG.list);
    await copyToClipboard(JSON.stringify(json, null, 2));
  });

  UI.fileImport.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    UI.txtJson.value = txt;
    UI.subline.textContent = "Archivo cargado. Pulsa Importar.";
  });

  UI.btnImportJson.addEventListener("click", async () => {
    const txt = (UI.txtJson.value || "").trim();
    if (!txt) { UI.subline.textContent = "Pega JSON primero ⚠️"; return; }
    try {
      const json = JSON.parse(txt);
      if (!Array.isArray(json?.cams)) throw new Error("JSON inválido (falta cams[])");
      localStorage.setItem(LS_CAMS_OVERRIDE, JSON.stringify(json));
      UI.subline.textContent = "Importado ✅ (override activo)";
      await loadCams();
      sendCMD("RELOAD_CAMS", {});
    } catch (err) {
      UI.subline.textContent = "Import error ⚠️ (mira consola)";
      console.warn("Import error:", err);
    }
  });

  UI.btnGeocode.addEventListener("click", async () => {
    const city = (UI.edCity.value || "").trim();
    const country = (UI.edCountry.value || "").trim() || (UI.edRegion.value || "").trim();
    const q = [city, country].filter(Boolean).join(", ");
    if (!q) { UI.subline.textContent = "Geocode: pon city y country/region ⚠️"; return; }

    UI.subline.textContent = "Geocode…";
    try {
      const r = await geocodeOSM(q);
      if (!r) { UI.subline.textContent = "Geocode: sin resultados"; return; }
      UI.edLat.value = String(r.lat || "");
      UI.edLon.value = String(r.lon || "");
      UI.subline.textContent = `Geocode OK ✅ (${r.display_name || ""})`;
    } catch (e) {
      UI.subline.textContent = "Geocode falló ⚠️";
      console.warn(e);
    }
  });

  // Boot
  (function boot() {
    loadPrefs();

    UI.q.value = STATE.prefs.q || "";
    UI.kind.value = STATE.prefs.kind || "any";
    UI.tag.value = STATE.prefs.tag || "";
    UI.btnFavOnly.textContent = STATE.prefs.favOnly ? "★ Solo favs (ON)" : "★ Solo favs";

    UI.rotKind.value = STATE.prefs.rot.kind || "any";
    UI.rotSec.value = String(STATE.prefs.rot.intervalSec || 40);
    UI.layoutN.value = String(STATE.prefs.layoutN || 4);

    setPlayerStatus(false, "Player: desconectado");
    setModeLabel("manual");

    buildSlotBar(STATE.prefs.layoutN || 4);
    setActiveSlot(STATE.prefs.activeSlot || 0, false);

    // intenta leer último state
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) onState(JSON.parse(raw));
    } catch {}

    loadCams();

    // enter en búsqueda -> TAKE
    UI.q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") UI.btnTake.click();
    });
  })();
})();
