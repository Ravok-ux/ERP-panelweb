// ══════════════════════════════════════════════════════════════
// chat.js — Mensajería interna: canales, pins, reacciones,
//           separadores de fecha, indicador de typing
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc } from "./app.js";
import {
  collection, doc, addDoc, onSnapshot, query, setDoc,
  limit, where, orderBy, serverTimestamp, updateDoc,
  deleteField, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as sRef, uploadBytes, getDownloadURL }
  from "./firebase-storage.js";

const EMOJIS = ["👍","❤️","😂","😮","👏"];

const CANALES_FIJOS = [
  { id:"GENERAL",      label:"# General",        desc:"Canal abierto a todos" },
  { id:"MESA_CONTROL", label:"# Mesa de Control", desc:"Coordinación operativa" },
  { id:"ALERTAS",      label:"🔔 Alertas",        desc:"Notificaciones del sistema" },
];

let _unsubMensajes = null;
let _unsubCanales  = null;
let _unsubTyping   = null;
let _unsubCustom   = null;
let _canalActivo   = "GENERAL";
let _typingTimeout = null;

const _noLeido  = {};
const _bgUnsubs = [];

// ── Audio ──────────────────────────────────────────────────────
function _beep(f1, f2, dur, vol = 0.2) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(f1, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(f2, ctx.currentTime + dur);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur + 0.02);
    osc.start(); osc.stop(ctx.currentTime + dur + 0.02);
    setTimeout(() => ctx.close?.(), (dur + 0.1) * 1000);
  } catch (_) {}
}
const _sonidoRecibir = () => _beep(880, 440, 0.18, 0.25);
const _sonidoEnviar  = () => _beep(440, 660, 0.08, 0.12);

// ── Badge ──────────────────────────────────────────────────────
function _actualizarBadge() {
  const total = Object.values(_noLeido).reduce((s, n) => s + n, 0);
  const sb = document.getElementById("chat-badge");
  if (sb) { sb.textContent = total > 99 ? "99+" : String(total); sb.classList.toggle("hidden", total === 0); }
  const tb = document.getElementById("tb-chat-bell");
  const tc = document.getElementById("tb-chat-count");
  if (tb) tb.style.display = total > 0 ? "" : "none";
  if (tc) { tc.textContent = total > 99 ? "99+" : String(total); tc.style.display = total > 0 ? "" : "none"; }
}

function _marcarLeido(canalId) {
  _noLeido[canalId] = 0;
  sessionStorage.setItem("chat_visto_" + canalId, String(Date.now()));
  _actualizarBadge();
}

// ── BG listeners ───────────────────────────────────────────────
function _iniciarBgListeners() {
  CANALES_FIJOS.forEach(c => _bgListenerCanal(c.id));
}

function _bgListenerCanal(canalId) {
  let maxTs   = parseInt(sessionStorage.getItem("chat_visto_" + canalId) || "0");
  let isFirst = true;
  const unsub = onSnapshot(
    query(collection(db,"mensajes_internos"), where("canal","==",canalId), orderBy("_ts","asc"), limit(100)),
    snap => {
      if (!isFirst) {
        const nuevos = snap.docs.filter(d => (d.data()._ts||0) > maxTs && d.data().uid !== Sesion.uid);
        if (nuevos.length && _canalActivo !== canalId) {
          _noLeido[canalId] = (_noLeido[canalId]||0) + nuevos.length;
          _actualizarBadge(); _sonidoRecibir();
        }
      }
      const ts = snap.docs.map(d => d.data()._ts||0);
      maxTs     = ts.length ? Math.max(...ts) : maxTs;
      isFirst   = false;
    }, err => console.warn("[Chat bg]", canalId, err));
  _bgUnsubs.push(unsub);
}

// ── Helpers ────────────────────────────────────────────────────
const fmtHora = ts => {
  if (!ts) return "–";
  const d = new Date(ts), hoy = new Date();
  if (d.toDateString() === hoy.toDateString())
    return d.toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" });
  return d.toLocaleDateString("es-MX", { day:"2-digit", month:"short" }) + " " +
    d.toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" });
};

const fmtGrupoFecha = ts => {
  if (!ts) return "";
  const d = new Date(ts), hoy = new Date();
  const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1);
  if (d.toDateString() === hoy.toDateString())  return "Hoy";
  if (d.toDateString() === ayer.toDateString()) return "Ayer";
  return d.toLocaleDateString("es-MX", { weekday:"long", day:"numeric", month:"long" });
};

const _esAdmin = () =>
  ["SUPER_ADMIN","GERENTE","GERENTE_ZONA","ADMINISTRADOR"].includes(Sesion.rol);

// ── Module ─────────────────────────────────────────────────────
export const ChatModule = {
  mount(container) {
    container.innerHTML = _html();
    _bindUI();
    _escucharCanalesCustom();
    _escucharDirectos();
    _activarCanal("GENERAL");
    if (_bgUnsubs.length === 0) _iniciarBgListeners();
  },
  destroy() {
    _unsubMensajes?.(); _unsubMensajes = null;
    _unsubCanales?.();  _unsubCanales  = null;
    _unsubTyping?.();   _unsubTyping   = null;
    _unsubCustom?.();   _unsubCustom   = null;
    if (_typingTimeout) { clearTimeout(_typingTimeout); _typingTimeout = null; }
    _limpiarTyping();
  },
  destroyAll() { _bgUnsubs.forEach(fn => fn?.()); _bgUnsubs.length = 0; }
};

export function iniciarChatBg() { if (_bgUnsubs.length === 0) _iniciarBgListeners(); }
export function detenerChatBg()  { _bgUnsubs.forEach(fn => fn?.()); _bgUnsubs.length = 0; }

// ── HTML ────────────────────────────────────────────────────────
function _html() {
  return `
  <style>
    /* ── Pin banner ── */
    .chat-pin-banner{display:flex;align-items:center;gap:8px;padding:8px 16px;
      background:rgba(27,94,32,.07);border-bottom:1px solid rgba(27,94,32,.18);
      font-size:12px;cursor:pointer;transition:background .12s}
    .chat-pin-banner:hover{background:rgba(27,94,32,.12)}
    .chat-pin-icon{font-size:15px;flex-shrink:0}
    .chat-pin-label{font-size:10px;font-weight:700;text-transform:uppercase;
      letter-spacing:.06em;color:var(--md-primary,#1B5E20);flex-shrink:0}
    .chat-pin-texto{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      color:var(--text-main,#111)}
    .chat-pin-unpin{background:none;border:none;cursor:pointer;font-size:12px;
      padding:2px 6px;border-radius:4px;color:var(--text-sec);flex-shrink:0}
    .chat-pin-unpin:hover{background:rgba(0,0,0,.07)}

    /* ── Fecha separador ── */
    .chat-sep-fecha{display:flex;align-items:center;gap:8px;margin:14px 16px 6px;
      font-size:11px;font-weight:600;color:var(--text-sec);
      text-transform:uppercase;letter-spacing:.06em}
    .chat-sep-fecha::before,.chat-sep-fecha::after{
      content:"";flex:1;height:1px;background:var(--border-color,#e0e0e0)}

    /* ── Mensaje wrap + reacciones ── */
    .chat-msg-wrap{padding:0 16px}
    .chat-msg-wrap:hover .chat-react-bar{opacity:1;pointer-events:auto;
      transition:opacity .1s 0s}
    .chat-msg-wrap:hover .chat-pin-btn{opacity:.7}
    .chat-msg{position:relative}
    /* barra debajo de la burbuja — retardo al cerrar para poder alcanzarla */
    .chat-react-bar{
      position:absolute;top:calc(100% + 4px);left:0;
      display:flex;gap:4px;align-items:center;
      background:var(--surface,#fff);border:1px solid var(--border-color,#e0e0e0);
      border-radius:24px;padding:5px 10px;
      box-shadow:0 4px 14px rgba(0,0,0,.15);
      opacity:0;pointer-events:none;
      transition:opacity .18s .25s;  /* retardo de 250ms al desaparecer */
      z-index:20;white-space:nowrap}
    .chat-msg-mio .chat-react-bar{left:auto;right:0}
    /* puente invisible entre burbuja y barra para no perder hover */
    .chat-react-bar::before{
      content:'';position:absolute;bottom:100%;left:0;right:0;height:8px}
    .chat-react-btn{
      background:none;border:none;cursor:pointer;
      font-size:22px;line-height:1;
      width:38px;height:38px;border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      transition:background .1s, transform .12s}
    .chat-react-btn:hover{
      background:rgba(99,102,241,.12);transform:scale(1.25)}
    .chat-reacciones{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
    .chat-reac-chip{display:inline-flex;align-items:center;gap:3px;
      background:rgba(27,94,32,.07);border:1px solid rgba(27,94,32,.18);
      border-radius:12px;padding:2px 8px;font-size:12px;cursor:pointer;
      transition:background .12s;user-select:none}
    .chat-reac-chip.mia{background:rgba(27,94,32,.2);border-color:var(--md-primary,#1B5E20);font-weight:700}
    .chat-reac-chip:hover{background:rgba(27,94,32,.16)}
    .chat-pin-btn{background:none;border:none;cursor:pointer;font-size:11px;
      padding:2px 5px;border-radius:4px;opacity:0;transition:opacity .12s;
      color:var(--text-sec);vertical-align:middle}

    /* ── Typing ── */
    .chat-typing{padding:4px 16px 2px;font-size:12px;color:var(--text-sec);
      min-height:22px;font-style:italic;display:flex;align-items:center;gap:6px}
    .typing-dots span{display:inline-block;animation:tdot 1.2s infinite}
    .typing-dots span:nth-child(2){animation-delay:.2s}
    .typing-dots span:nth-child(3){animation-delay:.4s}
    @keyframes tdot{0%,60%,100%{opacity:.25}30%{opacity:1}}

    /* ── Adjunto ── */
    .chat-attach-btn{background:none;border:none;cursor:pointer;font-size:18px;
      padding:0 6px;line-height:1;border-radius:6px;transition:background .12s;
      color:var(--text-sec);flex-shrink:0}
    .chat-attach-btn:hover{background:var(--hover-bg,rgba(0,0,0,.07))}
    .chat-archivo-img{max-width:260px;max-height:200px;border-radius:10px;
      display:block;cursor:pointer;margin-top:4px;object-fit:cover}
    .chat-archivo-card{display:inline-flex;align-items:center;gap:8px;
      background:var(--card-bg,#f3f4f6);border:1px solid var(--border);
      border-radius:10px;padding:8px 12px;cursor:pointer;margin-top:4px;
      text-decoration:none;color:inherit;max-width:260px}
    .chat-archivo-card:hover{background:var(--hover-bg,rgba(0,0,0,.07))}
    .chat-archivo-card-nombre{font-size:12px;font-weight:600;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
    .chat-archivo-card-hint{font-size:10px;color:var(--text-sec);margin-top:1px}

    /* ── Crear canal ── */
    .chat-canal-add{background:none;border:none;cursor:pointer;font-size:19px;
      line-height:1;padding:0 2px;color:var(--text-sec);border-radius:4px;
      transition:color .12s}
    .chat-canal-add:hover{color:var(--md-primary,#1B5E20)}
    .chat-custom-section{font-size:10px;font-weight:700;text-transform:uppercase;
      letter-spacing:.07em;color:var(--text-sec);padding:10px 12px 2px}
  </style>

  <div class="chat-layout">
    <!-- Sidebar -->
    <div class="chat-sidebar">
      <div class="chat-sb-hdr">
        <span class="chat-sb-title">Canales</span>
        ${_esAdmin() ? `<button class="chat-canal-add" id="btn-nuevo-canal" title="Crear canal">+</button>` : ""}
      </div>
      <div class="chat-canal-list" id="chat-canal-list">
        ${CANALES_FIJOS.map(c => `
          <div class="chat-canal-item ${c.id==="GENERAL"?"active":""}"
               data-canal="${esc(c.id)}" title="${esc(c.desc)}">
            ${esc(c.label)}
            <span class="chat-badge hidden" id="badge-${esc(c.id)}">0</span>
          </div>`).join("")}
      </div>
      <div id="chat-custom-section" style="display:none">
        <div class="chat-custom-section">Otros canales</div>
        <div class="chat-canal-list" id="chat-custom-list"></div>
      </div>
      <div class="chat-sb-section">Hilos directos</div>
      <div class="chat-canal-list" id="chat-directos-list">
        <div style="padding:8px 12px;font-size:11px;color:var(--text-sec)">Cargando…</div>
      </div>
    </div>

    <!-- Área principal -->
    <div class="chat-main">
      <div class="chat-main-hdr">
        <span class="chat-canal-nombre" id="chat-canal-nombre"># General</span>
        <span class="chat-canal-desc"  id="chat-canal-desc">Canal abierto a todos</span>
      </div>
      <div id="chat-pin-banner" style="display:none"></div>
      <div class="chat-mensajes" id="chat-mensajes">
        <div style="padding:24px;text-align:center;color:var(--text-sec);font-size:13px">Cargando mensajes…</div>
      </div>
      <div class="chat-typing" id="chat-typing"></div>
      <div class="chat-input-bar">
        <input type="file" id="chat-file-input" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx"
               style="display:none">
        <button class="chat-attach-btn" id="chat-attach" title="Adjuntar imagen o archivo">📎</button>
        <textarea id="chat-input" class="chat-input" rows="1"
          placeholder="Escribe un mensaje… (Enter para enviar, Shift+Enter para nueva línea)"></textarea>
        <button class="chat-send-btn" id="chat-send">↑ Enviar</button>
      </div>
    </div>
  </div>`;
}

// ── Bind UI ─────────────────────────────────────────────────────
function _bindUI() {
  window._chatEditAlias    = _editarAlias;
  window._chatPinMsg       = _togglePin;
  window._chatReaccion     = _toggleReaccion;
  window._chatScrollToPin  = _scrollToPin;

  document.getElementById("chat-canal-list")?.addEventListener("click", e => {
    const item = e.target.closest("[data-canal]");
    if (item) _activarCanal(item.dataset.canal);
  });
  document.getElementById("chat-custom-list")?.addEventListener("click", e => {
    const item = e.target.closest("[data-canal]");
    if (item) _activarCanal(item.dataset.canal, item.dataset.label);
  });
  document.getElementById("chat-directos-list")?.addEventListener("click", e => {
    const item = e.target.closest("[data-canal]");
    if (item) _activarCanal(item.dataset.canal, item.dataset.label);
  });

  document.getElementById("btn-nuevo-canal")?.addEventListener("click", _modalNuevoCanal);

  const input = document.getElementById("chat-input");
  input?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _enviarMensaje(); }
  });
  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
    _notificarTyping();
  });
  document.getElementById("chat-send")?.addEventListener("click", _enviarMensaje);

  document.getElementById("chat-attach")?.addEventListener("click", () => {
    document.getElementById("chat-file-input")?.click();
  });
  document.getElementById("chat-file-input")?.addEventListener("change", e => {
    const file = e.target.files?.[0];
    if (file) { _enviarArchivo(file); e.target.value = ""; }
  });
}

// ── Canales custom (Firestore) ──────────────────────────────────
function _escucharCanalesCustom() {
  const q = query(collection(db,"canales_chat"), limit(50));
  _unsubCustom = onSnapshot(q, snap => {
    const section = document.getElementById("chat-custom-section");
    const list    = document.getElementById("chat-custom-list");
    if (!section || !list) return;
    if (snap.empty) { section.style.display = "none"; return; }
    section.style.display = "";
    list.innerHTML = snap.docs.map(d => {
      const c = d.data();
      return `
        <div class="chat-canal-item" data-canal="${esc(d.id)}" data-label="${esc(c.nombre)}"
             title="${esc(c.desc||"")}">
          # ${esc(c.nombre)}
          <span class="chat-badge hidden" id="badge-${esc(d.id)}">0</span>
        </div>`;
    }).join("");
  }, err => console.warn("[Chat] canales custom:", err));
}

// ── Directos (ingenieros) ───────────────────────────────────────
function _escucharDirectos() {
  const q = query(collection(db,"usuarios"), where("activo","==",true));
  _unsubCanales = onSnapshot(q, snap => {
    const el = document.getElementById("chat-directos-list");
    if (!el) return;
    const lista = snap.docs
      .map(d => ({ uid:d.id, ...d.data() }))
      .filter(u => u.uid !== Sesion.uid)
      .sort((a,b) => (a.alias||"").localeCompare(b.alias||""));

    if (!lista.length) {
      el.innerHTML = `<div style="padding:8px 12px;font-size:11px;color:var(--text-sec)">Sin usuarios</div>`;
      return;
    }
    const puedeEditarAlias = _esAdmin();
    el.innerHTML = lista.map(u => {
      const nombre = u.alias || u.nombre || (u.uid||"").replace(/@.*$/,"").replace(/[._]/g," ").trim() || "–";
      const initials = nombre.slice(0,2).toUpperCase();
      const sinAlias = !u.alias;
      return `
        <div class="chat-canal-item" data-canal="DM_${esc(u.uid)}"
             data-label="@${esc(nombre)}" data-uid="${esc(u.uid)}">
          <span class="chat-dm-ava" ${sinAlias?`style="background:#9CA3AF"`:""}">${initials}</span>
          <span class="chat-dm-nombre">${esc(nombre)}</span>
          ${sinAlias?`<span style="font-size:9px;color:#D97706;margin-left:2px" title="Sin alias">⚠</span>`:""}
          <span class="chat-badge hidden" id="badge-DM_${esc(u.uid)}">0</span>
          ${puedeEditarAlias
            ?`<button class="chat-alias-edit" data-uid="${esc(u.uid)}"
                 data-current="${esc(nombre)}"
                 title="Editar alias" onclick="event.stopPropagation();window._chatEditAlias(this)">✏️</button>`
            :""}
        </div>`;
    }).join("");
  }, err => console.error("[Chat] directos:", err));
}

// ── Activar canal ───────────────────────────────────────────────
function _activarCanal(canalId, label = null) {
  _canalActivo = canalId;
  _marcarLeido(canalId);

  document.querySelectorAll(".chat-canal-item").forEach(el => {
    el.classList.toggle("active", el.dataset.canal === canalId);
  });

  const fijo  = CANALES_FIJOS.find(c => c.id === canalId);
  const nombre = label || fijo?.label || canalId;
  const desc   = fijo?.desc || "Hilo directo";
  const $  = id => document.getElementById(id);
  if ($("chat-canal-nombre")) $("chat-canal-nombre").textContent = nombre;
  if ($("chat-canal-desc"))   $("chat-canal-desc").textContent   = desc;

  // Limpiar pin banner y typing
  if ($("chat-pin-banner")) $("chat-pin-banner").style.display = "none";
  if ($("chat-typing"))     $("chat-typing").innerHTML = "";

  _unsubTyping?.(); _unsubTyping = null;
  _escucharMensajes(canalId);
  _escucharTyping(canalId);
}

// ── Mensajes ────────────────────────────────────────────────────
function _escucharMensajes(canalId) {
  _unsubMensajes?.(); _unsubMensajes = null;

  const el = document.getElementById("chat-mensajes");
  if (el) el.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</div>`;

  const q = query(
    collection(db,"mensajes_internos"),
    where("canal","==",canalId),
    orderBy("_ts","asc"),
    limit(100)
  );

  let maxTs    = parseInt(sessionStorage.getItem("chat_visto_" + canalId) || "0");
  let isFirst  = true;

  _unsubMensajes = onSnapshot(q, snap => {
    if (!el) return;

    if (!isFirst) {
      const nuevos = snap.docs.filter(d => (d.data()._ts||0) > maxTs && d.data().uid !== Sesion.uid);
      if (nuevos.length) _sonidoRecibir();
    }
    const tsArr = snap.docs.map(d => d.data()._ts||0);
    if (tsArr.length) maxTs = Math.max(...tsArr);
    isFirst = false;

    if (snap.empty) {
      el.innerHTML = `<div class="chat-empty">Sé el primero en escribir en este canal.</div>`;
      _renderPinBanner(null);
      return;
    }

    const docs = [...snap.docs].sort((a,b) => (a.data()._ts||0) - (b.data()._ts||0));

    // Pin: buscar el más reciente
    const pinned = docs.filter(d => d.data().pinned).sort((a,b) => (b.data().pinnedAt||0) - (a.data().pinnedAt||0));
    _renderPinBanner(pinned[0] ? { id: pinned[0].id, ...pinned[0].data() } : null);

    // Renderizar mensajes con separadores de fecha
    let prevFecha = null, prevAlias = null;
    const rows = docs.map(d => {
      const m      = d.data();
      const esMio  = m.uid === Sesion.uid;
      const fechaG = fmtGrupoFecha(m._ts);
      const sepFecha = fechaG !== prevFecha
        ? `<div class="chat-sep-fecha">${esc(fechaG)}</div>` : "";
      prevFecha = fechaG;

      const cambiaNombre = m.alias !== prevAlias && !esMio;
      prevAlias = m.alias;

      // Reacciones
      const reac = m.reacciones || {};
      const reacHTML = Object.entries(reac).filter(([,uids]) => uids?.length)
        .map(([emoji, uids]) => {
          const mia  = uids.includes(Sesion.uid);
          const cnt  = uids.length;
          return `<span class="chat-reac-chip ${mia?"mia":""}"
            onclick="window._chatReaccion('${esc(d.id)}','${emoji}')"
            title="${mia?"Quitar reacción":"Reaccionar"}">${emoji} ${cnt}</span>`;
        }).join("");

      // Botón pin (admins)
      const pinBtn = _esAdmin()
        ? `<button class="chat-pin-btn"
             onclick="window._chatPinMsg('${esc(d.id)}',${!!m.pinned})"
             title="${m.pinned?"Quitar pin":"Fijar mensaje"}">
             ${m.pinned?"📌":"📍"}
           </button>` : "";

      return `
        ${sepFecha}
        <div class="chat-msg-wrap ${esMio?"chat-msg-mio":""}" data-id="${esc(d.id)}">
          <div class="chat-msg ${esMio?"chat-msg-mio":""}">
            <div class="chat-react-bar">
              ${EMOJIS.map(e => `<button class="chat-react-btn"
                onclick="window._chatReaccion('${esc(d.id)}','${e}')"
                title="${e}">${e}</button>`).join("")}
            </div>
            ${cambiaNombre?`<div class="chat-msg-alias">${esc(m.alias||"–")}</div>`:""}
            <div class="chat-bubble ${esMio?"chat-bubble-mio":""}">
              ${m.texto ? `<span class="chat-texto">${esc(m.texto).replace(/\n/g,"<br>")}</span>` : ""}
              ${m.tipo==="archivo" && m.archivoTipo?.startsWith("image/")
                ? `<img class="chat-archivo-img" src="${esc(m.archivoUrl)}"
                       alt="${esc(m.archivoNombre)}"
                       onclick="window.open('${esc(m.archivoUrl)}','_blank')"
                       loading="lazy">`
                : ""}
              ${m.tipo==="archivo" && !m.archivoTipo?.startsWith("image/")
                ? `<a class="chat-archivo-card" href="${esc(m.archivoUrl)}" target="_blank" rel="noopener">
                     <span style="font-size:20px">${
                       m.archivoTipo?.includes("pdf") ? "📄"
                       : m.archivoTipo?.includes("sheet") ? "📊"
                       : m.archivoTipo?.includes("word") ? "📝" : "📎"
                     }</span>
                     <div>
                       <div class="chat-archivo-card-nombre">${esc(m.archivoNombre||"Archivo")}</div>
                       <div class="chat-archivo-card-hint">Abrir archivo</div>
                     </div>
                   </a>`
                : ""}
              <span class="chat-hora">${fmtHora(m._ts)}</span>
              ${pinBtn}
            </div>
            ${reacHTML ? `<div class="chat-reacciones">${reacHTML}</div>` : ""}
          </div>
        </div>`;
    }).join("");

    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    el.innerHTML = rows;
    if (atBottom || isFirst) el.scrollTop = el.scrollHeight;

  }, err => {
    console.error("[Chat] mensajes:", err);
    if (el) el.innerHTML = `<div class="chat-empty" style="color:#DC2626">Error al cargar mensajes</div>`;
  });
}

// ── Pin banner ──────────────────────────────────────────────────
function _renderPinBanner(msg) {
  const el = document.getElementById("chat-pin-banner");
  if (!el) return;
  if (!msg) { el.style.display = "none"; el.innerHTML = ""; return; }
  el.style.display = "";
  el.innerHTML = `
    <span class="chat-pin-icon">📌</span>
    <span class="chat-pin-label">Fijado</span>
    <span class="chat-pin-texto"
      onclick="window._chatScrollToPin('${esc(msg.id)}')">${esc(msg.texto||"")}</span>
    <span style="font-size:11px;color:var(--text-sec)">${esc(msg.alias||"")}</span>
    ${_esAdmin()?`<button class="chat-pin-unpin"
      onclick="window._chatPinMsg('${esc(msg.id)}',true)" title="Quitar pin">✕</button>`:""}`;
}

function _scrollToPin(msgId) {
  const el = document.querySelector(`[data-id="${msgId}"]`);
  if (el) { el.scrollIntoView({ behavior:"smooth", block:"center" }); }
}

// ── Toggle pin ──────────────────────────────────────────────────
async function _togglePin(msgId, yaFijado) {
  try {
    const ref = doc(db,"mensajes_internos", msgId);
    if (yaFijado) {
      await updateDoc(ref, { pinned:false, pinnedBy:deleteField(), pinnedAt:deleteField() });
    } else {
      await updateDoc(ref, { pinned:true, pinnedBy:Sesion.alias, pinnedAt:Date.now() });
    }
  } catch(e) { console.error("[Chat] pin:", e); window.toast?.("Error: "+e.message,"error"); }
}

// ── Reacciones ──────────────────────────────────────────────────
async function _toggleReaccion(msgId, emoji) {
  const uid = Sesion.uid;
  if (!uid) return;
  try {
    const ref   = doc(db,"mensajes_internos", msgId);
    const field = `reacciones.${emoji}`;
    // Verificar si ya reaccionó
    const el = document.querySelector(`[data-id="${msgId}"]`);
    const chip = el?.querySelector(`.chat-reac-chip.mia[onclick*="${emoji}"]`);
    if (chip) {
      await updateDoc(ref, { [field]: arrayRemove(uid) });
    } else {
      await updateDoc(ref, { [field]: arrayUnion(uid) });
    }
  } catch(e) { console.error("[Chat] reacción:", e); }
}

// ── Typing ──────────────────────────────────────────────────────
function _notificarTyping() {
  if (!Sesion.uid) return;
  const typRef = doc(db,"typing_indicators", _canalActivo);
  setDoc(typRef, { [Sesion.uid]: { alias: Sesion.alias||"–", _ts: Date.now() } }, { merge:true })
    .catch(() => {});

  clearTimeout(_typingTimeout);
  _typingTimeout = setTimeout(() => _limpiarTyping(), 2500);
}

function _limpiarTyping() {
  if (!Sesion.uid || !_canalActivo) return;
  const typRef = doc(db,"typing_indicators", _canalActivo);
  updateDoc(typRef, { [Sesion.uid]: deleteField() }).catch(() => {});
}

function _escucharTyping(canalId) {
  _unsubTyping?.(); _unsubTyping = null;
  const typRef = doc(db,"typing_indicators", canalId);
  _unsubTyping = onSnapshot(typRef, snap => {
    const el = document.getElementById("chat-typing");
    if (!el) return;
    if (!snap.exists()) { el.innerHTML = ""; return; }
    const data    = snap.data() || {};
    const cutoff  = Date.now() - 3000;
    const nombres = Object.entries(data)
      .filter(([uid, v]) => uid !== Sesion.uid && (v._ts||0) > cutoff)
      .map(([, v]) => v.alias || "Alguien");
    if (!nombres.length) { el.innerHTML = ""; return; }
    const txt = nombres.length === 1
      ? `${esc(nombres[0])} está escribiendo`
      : `${esc(nombres.join(", "))} están escribiendo`;
    el.innerHTML = `${txt}<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span>`;
  }, () => {});
}

// ── Enviar ──────────────────────────────────────────────────────
async function _enviarMensaje() {
  const input = document.getElementById("chat-input");
  const texto = input?.value.trim();
  if (!texto) return;
  input.value = ""; input.style.height = "auto";
  clearTimeout(_typingTimeout); _limpiarTyping();
  try {
    await addDoc(collection(db,"mensajes_internos"), {
      canal:     _canalActivo,
      texto,
      uid:       Sesion.uid   || "–",
      alias:     Sesion.alias || "–",
      rol:       Sesion.rol   || "–",
      timestamp: serverTimestamp(),
      _ts:       Date.now(),
    });
    _sonidoEnviar();
  } catch(e) {
    console.error("[Chat] enviar:", e);
    window.toast?.("Error al enviar: "+e.message,"error");
    if (input) input.value = texto;
  }
}

// ── Enviar archivo ──────────────────────────────────────────────
async function _enviarArchivo(file) {
  const toast = window.toast;
  try {
    toast?.("⬆ Subiendo archivo…", "info");
    const storage = getStorage();
    const ruta    = `chat_adjuntos/${_canalActivo}/${Date.now()}_${Sesion.uid}_${file.name}`;
    const ref     = sRef(storage, ruta);
    await uploadBytes(ref, file, { contentType: file.type });
    const url = await getDownloadURL(ref);
    await addDoc(collection(db,"mensajes_internos"), {
      canal:         _canalActivo,
      texto:         "",
      tipo:          "archivo",
      archivoUrl:    url,
      archivoNombre: file.name,
      archivoTipo:   file.type,
      uid:           Sesion.uid   || "–",
      alias:         Sesion.alias || "–",
      rol:           Sesion.rol   || "–",
      timestamp:     serverTimestamp(),
      _ts:           Date.now(),
    });
    _sonidoEnviar();
  } catch(e) {
    console.error("[Chat] archivo:", e);
    window.toast?.("Error al subir archivo: "+e.message,"error");
  }
}

// ── Modal nuevo canal ───────────────────────────────────────────
function _modalNuevoCanal() {
  const ov = document.createElement("div");
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1200;display:flex;align-items:center;justify-content:center;padding:16px";
  ov.innerHTML = `
    <div style="background:var(--surface,#fff);border-radius:14px;max-width:400px;width:100%;
                padding:24px 22px 20px;position:relative">
      <button id="nc-cerrar"
        style="position:absolute;top:12px;right:14px;border:none;background:transparent;
               font-size:20px;cursor:pointer;color:#666">✕</button>
      <h3 style="margin:0 0 18px;font-size:17px;font-weight:800">+ Nuevo canal</h3>
      <label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">Nombre del canal</label>
      <input id="nc-nombre" maxlength="30" placeholder="soporte, proyectos, ventas…"
        style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;
               border:1.5px solid #ccc;font-size:14px;margin-bottom:12px">
      <label style="display:block;font-size:13px;font-weight:600;margin-bottom:4px">Descripción (opcional)</label>
      <input id="nc-desc" maxlength="80" placeholder="Para qué se usa este canal…"
        style="width:100%;box-sizing:border-box;padding:9px 12px;border-radius:8px;
               border:1.5px solid #ccc;font-size:14px;margin-bottom:20px">
      <div id="nc-err" style="color:red;font-size:13px;display:none;margin-bottom:8px"></div>
      <button id="nc-crear"
        style="width:100%;background:var(--md-primary,#1B5E20);color:#fff;border:none;
               border-radius:8px;padding:11px;font-size:14px;font-weight:700;cursor:pointer">
        Crear canal
      </button>
    </div>`;
  document.body.appendChild(ov);
  const cerrar = () => ov.remove();
  ov.querySelector("#nc-cerrar").addEventListener("click", cerrar);
  ov.addEventListener("click", e => { if (e.target === ov) cerrar(); });
  ov.querySelector("#nc-nombre").focus();

  ov.querySelector("#nc-crear").addEventListener("click", async () => {
    const nombre = ov.querySelector("#nc-nombre").value.trim();
    const desc   = ov.querySelector("#nc-desc").value.trim();
    const errEl  = ov.querySelector("#nc-err");
    const btn    = ov.querySelector("#nc-crear");
    if (!nombre) { errEl.textContent="El nombre es obligatorio."; errEl.style.display=""; return; }
    errEl.style.display = "none"; btn.disabled = true; btn.textContent = "Creando…";
    try {
      const id = nombre.toUpperCase().replace(/\s+/g,"_").replace(/[^A-Z0-9_]/g,"");
      await setDoc(doc(db,"canales_chat", id), {
        nombre, desc, creadoPor: Sesion.alias, _ts: Date.now()
      });
      window.toast?.(`Canal #${nombre} creado`, "success");
      cerrar();
    } catch(e) {
      errEl.textContent = e.message; errEl.style.display = "";
      btn.disabled = false; btn.textContent = "Crear canal";
    }
  });
}

// ── Editar alias ────────────────────────────────────────────────
async function _editarAlias(btn) {
  const uid     = btn.dataset.uid;
  const current = btn.dataset.current || "";
  const item    = btn.closest(".chat-canal-item");
  if (!item) return;
  const prevHTML = item.innerHTML;
  item.innerHTML = `
    <input id="chat-alias-inp" type="text" value="${esc(current)}"
      style="flex:1;padding:4px 7px;border:1.5px solid #1D5C33;border-radius:6px;
      font-size:12px;outline:none;min-width:0" placeholder="Alias…" maxlength="40">
    <button id="chat-alias-ok"
      style="padding:3px 9px;background:#1D5C33;color:#fff;border:none;
      border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">OK</button>
    <button id="chat-alias-cancel"
      style="padding:3px 7px;background:none;border:1px solid #D1D5DB;
      border-radius:6px;font-size:11px;cursor:pointer">✕</button>`;
  const inp = item.querySelector("#chat-alias-inp");
  inp?.focus(); inp?.select();
  const restore = () => { item.innerHTML = prevHTML; };
  item.querySelector("#chat-alias-cancel").onclick = restore;
  item.querySelector("#chat-alias-ok").onclick = async () => {
    const nuevoAlias = inp.value.trim();
    if (!nuevoAlias) { inp.focus(); return; }
    try {
      await updateDoc(doc(db,"usuarios", uid), { alias: nuevoAlias });
      window.toast?.(`Alias: ${nuevoAlias}`, "success");
    } catch(e) { console.error("[Chat] alias:", e); window.toast?.("Error: "+e.message,"error"); restore(); }
  };
  inp?.addEventListener("keydown", e => {
    if (e.key === "Enter")  item.querySelector("#chat-alias-ok").click();
    if (e.key === "Escape") restore();
  });
}
