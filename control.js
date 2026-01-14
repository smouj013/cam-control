/* control.js — CamStudio Room CONTROL (v1.0.1)
   ✅ Compatible con control.html (IDs intactos)
   ✅ UI catálogo + filtros + favs + rotación
   ✅ CMD robusto (BroadcastChannel + localStorage fallback)
   ✅ Lee STATE + muestra ACKs del player (feedback instantáneo)
*/
(() => {
  "use strict";

  const APP = {
    name: "CamStudioRoom",
    ver: "1.0.1",
    protocol: 1,
    camsUrl: "./cams.json",
  };

  const $ = (id) => document.getElementById(id);
  const nowMs = () => Number(Date.now());
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  const randId = (len = 10) => {
    const a = new Uint8Array(len);
    try {
      crypto?.getRandomValues?.(a);
    } catch {}
    for (let i = 0; i < a.length; i++) {
      if (a[i] === 0) a[i] = Math.floor(Math.random() * 256);
    }
    return [...a].map(x => (x % 36).toString(36)).join("");
  };

  function parseParams() {
    const qp = new URLSearchParams(location.search);
    const key = (qp.get("key") || "main").trim() || "main";
    return { key };
  }

  const P = parseParams();

  // UI
  const UI = {
    subline: $("subline"),
    txtKey: $("txtKey"),

    dotPlayer: $("dotPlayer"),
    txtPlayer: $("txtPlayer"),

    btnPing: $("btnPing"),
    btnReloadCams: $("btnReloadCams"),
    btnStop: $("btnStop"),
    btnPrev: $("btnPrev"),
    btnNext: $("btnNext"),

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

    thumbBox: $("thumbBox"),
    thumb: $("thumb"),

    btnPlaySel: $("btnPlaySel"),
    btnFav: $("btnFav"),
    btnCopyId: $("btnCopyId"),
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Storage / bus
  // ─────────────────────────────────────────────────────────────────────────────
  const BUS_NAME = "camstudio_bus";
  const LS_CMD = `camstudio_cmd:${P.key}`;
  const LS_STATE = `camstudio_state:${P.key}`;
  const LS_PREFS = `camstudio_prefs:${P.key}`;

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

  const PENDING = new Map(); // cmdNonce -> { cmd, ts }
  function markPending(nonce, cmd) {
    PENDING.set(nonce, { cmd: String(cmd || ""), ts: nowMs() });
    // limpieza
    const cut = nowMs() - 30_000;
    for (const [k, v] of PENDING) if (v.ts < cut) PENDING.delete(k);
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

  let LAST_STATE = null;
  let lastStateTs = 0;

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

  // ─────────────────────────────────────────────────────────────────────────────
  // Catalog
  // ─────────────────────────────────────────────────────────────────────────────
  const CATALOG = { list: [], byId: new Map(), tags: new Set(), meta: {} };

  const STATE = {
    prefs: {
      favOnly: false,
      q: "",
      kind: "any",
      tag: "",
      selectedId: "",
      favs: {},
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

  async function loadCams() {
    UI.subline.textContent = "Cargando cams.json…";
    try {
      const res = await fetch(APP.camsUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const cams = Array.isArray(json?.cams) ? json.cams : (Array.isArray(json) ? json : []);
      CATALOG.meta = json?.meta || {};

      const clean = [];
      const tags = new Set();

      for (const c of cams) {
        if (!c || typeof c !== "object") continue;
        if (c.disabled) continue;

        const id = String(c.id || "").trim();
        const kind = String(c.kind || "").trim();
        const src = String(c.src || "").trim();
        if (!id || !kind || !src) continue;

        const item = {
          id,
          title: String(c.title || id),
          kind,
          src,
          tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
          region: String(c.region || ""),
          priority: Number.isFinite(+c.priority) ? +c.priority : 0,
          weight: Number.isFinite(+c.weight) ? +c.weight : 1,
          thumb: String(c.thumb || ""),
        };

        item.tags.forEach(t => tags.add(t));
        clean.push(item);
      }

      clean.sort((a, b) => (b.priority - a.priority) || a.title.localeCompare(b.title));
      CATALOG.list = clean;
      CATALOG.byId = new Map(clean.map(x => [x.id, x]));
      CATALOG.tags = tags;

      UI.subline.textContent = `Catálogo listo • ${clean.length} cams`;
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

      const hay = `${c.title} ${c.id} ${c.kind} ${c.region} ${c.tags.join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function cardHTML(cam, active) {
    const fav = !!STATE.prefs.favs[cam.id];
    const tags = cam.tags?.length ? cam.tags.join(" · ") : "—";
    const reg = cam.region ? ` · ${cam.region}` : "";
    return `
      <div class="card ${active ? "active" : ""}" data-id="${escapeHTML(cam.id)}" title="${escapeHTML(cam.title)}">
        <div class="cardTop">
          <div class="camTitle">${fav ? "★ " : ""}${escapeHTML(cam.title)}</div>
          <span class="badge">${escapeHTML(cam.kind.toUpperCase())}</span>
        </div>
        <div class="cardMeta">
          <span class="badge">id:${escapeHTML(cam.id)}</span>
          <span class="badge">prio:${String(cam.priority)}</span>
          ${reg ? `<span class="badge">${escapeHTML(cam.region)}</span>` : ""}
        </div>
        <div class="tags">tags: ${escapeHTML(tags)}</div>
      </div>
    `;
  }

  function renderList() {
    const list = filtered();
    UI.txtCount.textContent = `(${list.length}/${CATALOG.list.length})`;
    const activeId = STATE.prefs.selectedId;
    UI.list.innerHTML = list.map(c => cardHTML(c, c.id === activeId)).join("");
  }

  function restoreSelection() {
    const id = STATE.prefs.selectedId;
    if (!id) return;
    const cam = CATALOG.byId.get(id);
    if (cam) renderSelection(cam);
  }

  function renderSelection(cam) {
    STATE.prefs.selectedId = cam.id;
    savePrefs();

    UI.selTitle.textContent = cam.title;
    UI.selMeta.textContent = `${cam.kind.toUpperCase()} • prioridad ${cam.priority}`;
    UI.selId.textContent = cam.id;
    UI.selKind.textContent = cam.kind;
    UI.selSrc.textContent = cam.src;
    UI.selTags.textContent = cam.tags?.length ? cam.tags.join(", ") : "—";
    UI.selRegion.textContent = cam.region || "—";

    const thumb = cam.thumb || (cam.kind === "youtube"
      ? `https://i.ytimg.com/vi/${encodeURIComponent(cam.src)}/hqdefault.jpg`
      : ""
    );

    if (thumb) {
      UI.thumbBox.style.display = "";
      UI.thumb.src = thumb;
    } else {
      UI.thumbBox.style.display = "none";
      UI.thumb.removeAttribute("src");
    }

    const isFav = !!STATE.prefs.favs[cam.id];
    UI.btnFav.textContent = isFav ? "★ Quitar fav" : "★ Fav";

    renderList();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Program render (state desde player)
  // ─────────────────────────────────────────────────────────────────────────────
  function renderProgram(st, ts) {
    lastStateTs = ts || nowMs();
    const ok = (nowMs() - lastStateTs) < 4500;
    setPlayerStatus(ok, ok ? "Player: conectado" : "Player: desconectado");

    const mode = String(st?.mode || "manual");
    setModeLabel(mode);

    // ACK feedback
    if (st?.ack?.cmdNonce) {
      const a = st.ack;
      const pending = PENDING.get(a.cmdNonce);
      if (pending) {
        PENDING.delete(a.cmdNonce);
        UI.subline.textContent = `${a.ok ? "✅" : "⚠"} ACK ${pending.cmd}: ${String(a.note || "")}`.trim();
      }
    }

    const now = st?.now;
    if (now) {
      UI.progTitle.textContent = `Programa: ${now.title || now.id}`;
      UI.progSub.textContent = `${String(now.kind || "").toUpperCase()} • ID: ${now.id || "?"}`;
    } else {
      UI.progTitle.textContent = "Programa: —";
      UI.progSub.textContent = "Sin cámara en emisión";
    }

    UI.kpiState.textContent = st?.playing ? "ON-AIR" : "IDLE";
    UI.kpiMute.textContent = st?.muted ? "MUTED" : "AUDIO";
    UI.kpiFails.textContent = String(st?.failCount ?? "—");

    // sync rotación (best effort)
    if (st?.rotate && typeof st.rotate === "object") {
      const r = st.rotate;
      STATE.prefs.rot.enabled = !!r.enabled;
      STATE.prefs.rot.intervalSec = clamp(Number(r.intervalSec || STATE.prefs.rot.intervalSec), 8, 3600);
      STATE.prefs.rot.kind = String(r.kind || "any");
      STATE.prefs.rot.tag = String(r.tag || "");

      UI.rotKind.value = STATE.prefs.rot.kind;
      UI.rotSec.value = String(STATE.prefs.rot.intervalSec);
      UI.rotTag.value = STATE.prefs.rot.tag;

      UI.btnRotate.textContent = STATE.prefs.rot.enabled ? "⟲ Rotación ON" : "⟲ Rotación";
      savePrefs();
    }

    if (st?.lastError) UI.progSub.textContent += ` • ⚠ ${st.lastError}`;
  }

  // heartbeat visual
  setInterval(() => {
    const ok = (nowMs() - lastStateTs) < 4500;
    setPlayerStatus(ok, ok ? "Player: conectado" : "Player: desconectado");
  }, 900);

  // ─────────────────────────────────────────────────────────────────────────────
  // UI events
  // ─────────────────────────────────────────────────────────────────────────────
  UI.list.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    const id = card.getAttribute("data-id");
    const cam = CATALOG.byId.get(id);
    if (cam) renderSelection(cam);
  });

  UI.q.addEventListener("input", () => {
    STATE.prefs.q = UI.q.value;
    savePrefs();
    renderList();
  });

  UI.kind.addEventListener("change", () => {
    STATE.prefs.kind = UI.kind.value;
    savePrefs();
    renderList();
  });

  UI.tag.addEventListener("change", () => {
    STATE.prefs.tag = UI.tag.value;
    savePrefs();
    renderList();
  });

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

  UI.btnPlaySel.addEventListener("click", () => {
    const id = STATE.prefs.selectedId;
    if (!id) return;

    sendCMD("PLAY_ID", { id });
    // al hacer play manual -> rotación off
    const r = readRotateUI();
    sendCMD("ROTATE_SET", { ...r, enabled: false });
  });

  UI.btnTake.addEventListener("click", () => UI.btnPlaySel.click());

  UI.btnFav.addEventListener("click", () => {
    const id = STATE.prefs.selectedId;
    if (!id) return;
    STATE.prefs.favs[id] = !STATE.prefs.favs[id];
    savePrefs();
    renderSelection(CATALOG.byId.get(id));
  });

  UI.btnCopyId.addEventListener("click", async () => {
    const id = STATE.prefs.selectedId || "";
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      UI.subline.textContent = `Copiado: ${id}`;
    } catch {
      // fallback
      try {
        const ta = document.createElement("textarea");
        ta.value = id;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        UI.subline.textContent = `Copiado: ${id}`;
      } catch {}
    }
  });

  UI.btnPrev.addEventListener("click", () => sendCMD("PREV", {}));
  UI.btnNext.addEventListener("click", () => sendCMD("NEXT", {}));
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

  function readRotateUI() {
    const intervalSec = clamp(Number(UI.rotSec.value || 40), 8, 3600);
    const kind = UI.rotKind.value || "any";
    const tag = UI.rotTag.value || "";
    return { intervalSec, kind, tag };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────────────
  (function boot() {
    loadPrefs();

    UI.q.value = STATE.prefs.q || "";
    UI.kind.value = STATE.prefs.kind || "any";
    UI.tag.value = STATE.prefs.tag || "";
    UI.btnFavOnly.textContent = STATE.prefs.favOnly ? "★ Solo favs (ON)" : "★ Solo favs";

    UI.rotKind.value = STATE.prefs.rot.kind || "any";
    UI.rotSec.value = String(STATE.prefs.rot.intervalSec || 40);

    setPlayerStatus(false, "Player: desconectado");
    setModeLabel("manual");

    // intenta leer último state (control puede abrir después)
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) onState(JSON.parse(raw));
    } catch {}

    loadCams();

    // Enter en búsqueda -> TAKE
    UI.q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") UI.btnTake.click();
    });
  })();
})();
