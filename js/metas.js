/**
 * Módulo Metas de Venta — N-10 Web Panel
 * El GERENTE / SUPER_ADMIN define metas por ingeniero y período.
 * El progreso se calcula en tiempo real desde Firestore (pedidos + visitas).
 */

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import {
  collection, doc, addDoc, setDoc, deleteDoc,
  onSnapshot, query, where, getDocs, limit,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── ESC helper ───────────────────────────────────────────────────────────────
let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

// ── Estado ─────────────────────────────────────────────────────────────────────
let _unsubMetas    = null;
let _unsubUsuarios = null;
let _metas         = {};   // id → meta doc
let _ingenieros    = [];   // alias[]

// ── Render ─────────────────────────────────────────────────────────────────────
export const MetasModule = {

  mount(container) { this.render(container); },

  render(container) {
    container.innerHTML = `
      <div class="met-shell">
        <div class="met-header">
          <h2 class="met-title">🎯 Metas de Venta</h2>
          <div class="met-header-actions">
            <select id="mFiltroMes" class="met-select"></select>
            <button class="btn-primary" id="mBtnNueva">+ Nueva meta</button>
          </div>
        </div>
        <div class="met-kpis" id="mKpis"></div>
        <div id="mCards" class="met-cards"></div>
        <div id="mFormWrap" class="met-form-overlay" style="display:none">
          <div class="met-form-modal" id="mFormModal"></div>
        </div>
      </div>

      <style>
        .met-shell { display:flex; flex-direction:column; height:100%; gap:0; }
        .met-header{ display:flex; align-items:center; justify-content:space-between;
                     padding:12px 16px; border-bottom:1px solid var(--border,#e2e8f0); flex-wrap:wrap; gap:8px; }
        .met-title { margin:0; font-size:1.1rem; font-weight:700; }
        .met-header-actions { display:flex; gap:8px; align-items:center; }
        .met-select{ padding:6px 10px; padding-right:30px; border:1.5px solid var(--border,#e2e8f0); border-radius:6px; font-size:.88rem;
          background:var(--surface-2,var(--surface)); color:var(--text-primary); outline:none; }
        .met-kpis  { display:flex; gap:12px; padding:12px 16px; flex-wrap:wrap; }
        .kpi-box   { background:var(--surface); border:1px solid var(--border,#e2e8f0);
                     border-radius:8px; padding:12px 18px; min-width:130px; }
        .kpi-label { font-size:.75rem; color:var(--text-sec); }
        .kpi-value { font-size:1.4rem; font-weight:700; margin-top:2px; }
        .met-cards { flex:1; overflow-y:auto; padding:0 16px 16px; display:grid;
                     grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; align-content:start; }
        .met-card  { background:var(--surface); border:1px solid var(--border,#e2e8f0);
                     border-radius:10px; padding:14px; }
        .met-card-top { display:flex; justify-content:space-between; align-items:flex-start; }
        .met-alias { font-weight:700; font-size:.95rem; }
        .met-periodo{ font-size:.76rem; color:var(--text-sec); }
        .met-tipo  { font-size:.73rem; background:#EFF6FF;
                     color:#1565C0; padding:2px 7px; border-radius:20px; font-weight:600; }
        .met-progress-wrap { margin-top:10px; }
        .met-progress-label{ display:flex; justify-content:space-between; font-size:.8rem; margin-bottom:4px; }
        .met-bar-bg { height:8px; background:var(--border,#e2e8f0); border-radius:4px; overflow:hidden; }
        .met-bar-fill{ height:100%; border-radius:4px; transition:width .4s;
                       background:#1565C0; }
        .met-bar-fill.cumplida { background:#22c55e; }
        .met-bar-fill.alerta   { background:#f59e0b; }
        .met-sub-row{ display:flex; gap:10px; margin-top:8px; flex-wrap:wrap; }
        .met-sub   { font-size:.78rem; color:var(--text-sec); }
        .met-sub span { font-weight:600; color:var(--text-primary); }
        .met-actions{ display:flex; gap:6px; margin-top:10px; }
        .met-form-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4);
                            display:flex; align-items:center; justify-content:center; z-index:200; }
        .met-form-modal { background:var(--surface); border-radius:12px; padding:20px;
                          width:min(420px,95vw); max-height:90vh; overflow-y:auto; }
        .mf-title  { font-size:1rem; font-weight:700; margin:0 0 14px; }
        .mf-field  { margin-bottom:12px; }
        .mf-field label { display:block; font-size:.8rem; font-weight:600;
                          margin-bottom:3px; color:var(--text-sec); }
        .mf-field input,.mf-field select { width:100%; padding:7px 9px;
          border:1px solid var(--border,#e2e8f0); border-radius:6px; font-size:.88rem; box-sizing:border-box; }
        .mf-row    { display:flex; gap:8px; }
        .mf-row .mf-field { flex:1; }
        .mf-actions{ display:flex; gap:8px; margin-top:14px; }
        .btn-primary   { background:#1565C0; color:#fff; border:none;
                         padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .btn-secondary { background:transparent; border:1px solid var(--border,#30363d);
                         color:var(--text-primary,#E6EDF3);
                         padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .btn-danger    { background:#ef4444; color:#fff; border:none;
                         padding:5px 10px; border-radius:6px; cursor:pointer; font-size:.8rem; }
        .btn-sm        { padding:4px 10px; font-size:.78rem; }
        .empty-state   { text-align:center; padding:40px 16px;
                         color:var(--text-sec); font-size:.9rem; }
      </style>
    `;

    _poblarFiltroMes();

    document.getElementById("mBtnNueva").addEventListener("click", () => _abrirForm(null));
    document.getElementById("mFiltroMes").addEventListener("change", () => _renderCards());

    // Suscribirse a usuarios para lista de ingenieros
    _unsubUsuarios = onSnapshot(collection(db, "usuarios"), snap => {
      _ingenieros = snap.docs
        .filter(d => d.data().activo !== false && d.data().rol === "INGENIERO")
        .map(d => d.data().alias || d.id)
        .filter(Boolean)
        .sort();
    });

    // Suscribirse a metas — limit para no cargar toda la colección histórica
    _unsubMetas = onSnapshot(query(collection(db, "metas"), limit(300)), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === "removed") delete _metas[ch.doc.id];
        else _metas[ch.doc.id] = { id: ch.doc.id, ...ch.doc.data() };
      });
      _renderKpis();
      _renderCards();
    });
  },

  destroy() {
    _unsubMetas?.();
    _unsubUsuarios?.();
    _unsubMetas = _unsubUsuarios = null;
    _metas = {}; _ingenieros = [];
  }
};

// ── Filtro de mes ──────────────────────────────────────────────────────────────
function _poblarFiltroMes() {
  const sel = document.getElementById("mFiltroMes");
  const ahora = new Date();
  let html = `<option value="todos">Todos los períodos</option>`;
  for (let i = 0; i < 6; i++) {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("es-MX", { month: "long", year: "numeric" });
    html += `<option value="${val}" ${i === 0 ? "selected" : ""}>${label}</option>`;
  }
  sel.innerHTML = html;
}

function _filtroActual() {
  return document.getElementById("mFiltroMes")?.value ?? "todos";
}

// ── KPIs globales ──────────────────────────────────────────────────────────────
function _renderKpis() {
  const kpis = document.getElementById("mKpis");
  if (!kpis) return;
  const filtro = _filtroActual();
  const lista = _metasFiltradas(filtro);
  const totalMeta = lista.reduce((s, m) => s + (m.metaMonto || 0), 0);
  const activas = lista.filter(m => m.activa !== false).length;
  kpis.innerHTML = `
    <div class="kpi-box">
      <div class="kpi-label">Metas activas</div>
      <div class="kpi-value">${activas}</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Total objetivo (MXN)</div>
      <div class="kpi-value">${_fmtMXN(totalMeta)}</div>
    </div>
    <div class="kpi-box">
      <div class="kpi-label">Ingenieros con meta</div>
      <div class="kpi-value">${new Set(lista.map(m => m.alias)).size}</div>
    </div>
  `;
}

// ── Cards ──────────────────────────────────────────────────────────────────────
function _metasFiltradas(filtro) {
  const todas = Object.values(_metas);
  if (filtro === "todos") return todas;
  const [year, mes] = filtro.split("-").map(Number);
  return todas.filter(m => {
    const fi = _tsToDate(m.fechaInicio);
    return fi && fi.getFullYear() === year && fi.getMonth() + 1 === mes;
  });
}

function _renderCards() {
  const wrap = document.getElementById("mCards");
  if (!wrap) return;
  _renderKpis();
  const filtro = _filtroActual();
  const lista = _metasFiltradas(filtro).sort((a, b) =>
    (a.alias || "").localeCompare(b.alias || ""));

  if (lista.length === 0) {
    wrap.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      Sin metas para el período seleccionado.<br>Crea una con el botón "+ Nueva meta".</div>`;
    return;
  }
  wrap.innerHTML = lista.map(m => _cardHtml(m)).join("");
  // Cargar progreso asíncrono para cada card
  lista.forEach(m => _cargarProgreso(m));
}

function _cardHtml(m) {
  const fi = _tsToDate(m.fechaInicio);
  const ff = _tsToDate(m.fechaFin);
  const periodoStr = fi && ff
    ? `${fi.toLocaleDateString("es-MX", { day: "numeric", month: "short" })} – ${ff.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}`
    : "–";
  return `
    <div class="met-card" id="mcard-${esc(m.id)}">
      <div class="met-card-top">
        <div>
          <div class="met-alias">${esc(m.alias)}</div>
          <div class="met-periodo">${periodoStr}</div>
        </div>
        <span class="met-tipo">${esc(m.tipo || "MENSUAL")}</span>
      </div>
      <div class="met-progress-wrap">
        <div class="met-progress-label">
          <span>Venta</span>
          <span id="prog-label-${esc(m.id)}">cargando…</span>
        </div>
        <div class="met-bar-bg">
          <div class="met-bar-fill" id="prog-bar-${esc(m.id)}" style="width:0%"></div>
        </div>
      </div>
      <div class="met-sub-row">
        <div class="met-sub">💰 <span>${_fmtMXN(m.metaMonto || 0)}</span></div>
        ${m.metaLitros     ? `<div class="met-sub">💧 <span>${m.metaLitros} L</span></div>` : ""}
        ${m.metaVisitas    ? `<div class="met-sub">📍 <span>${m.metaVisitas} vis.</span></div>` : ""}
        ${m.metaProspectos ? `<div class="met-sub">🧲 <span>${m.metaProspectos} prosp.</span></div>` : ""}
        ${m.semana         ? `<div class="met-sub" style="color:#7C3AED">S${m.semana}</div>` : ""}
      </div>
      <div class="met-sub-row" id="prog-extras-${esc(m.id)}"></div>
      <div class="met-actions">
        <button class="btn-primary btn-sm" onclick="_mEditar('${esc(m.id)}')">Editar</button>
        <button class="btn-danger btn-sm" onclick="_mEliminar('${esc(m.id)}')">Eliminar</button>
      </div>
    </div>
  `;
}

async function _cargarProgreso(m) {
  const fi = _tsToDate(m.fechaInicio);
  const ff = _tsToDate(m.fechaFin);
  if (!fi || !ff) return;
  const tsInicio = Timestamp.fromDate(fi);
  const tsFin    = Timestamp.fromDate(ff);

  try {
    // Dual query para cubrir fechaPedido como Timestamp (APK) y como ms (panel web)
    const [snapPedTs, snapPedNum] = await Promise.all([
      getDocs(query(collection(db, "pedidos"),
        where("ingenieroAlias", "==", m.alias),
        where("fechaPedido", ">=", Timestamp.fromDate(fi)),
        where("fechaPedido", "<=", Timestamp.fromDate(ff)))),
      getDocs(query(collection(db, "pedidos"),
        where("ingenieroAlias", "==", m.alias),
        where("fechaPedido", ">=", fi.getTime()),
        where("fechaPedido", "<=", ff.getTime()))).catch(() => ({ docs: [] }))
    ]);
    const pedSeen = new Set();
    const pedDocs = [...snapPedTs.docs, ...(snapPedNum.docs || [])].filter(d => {
      if (pedSeen.has(d.id)) return false;
      pedSeen.add(d.id);
      return true;
    });

    let totalVendido = 0;
    let numPedidos = 0;
    pedDocs.forEach(d => {
      const p = d.data();
      if (p.status !== "CANCELADO" && p.status !== "RECHAZADO") {
        totalVendido += p.total || p.monto || 0;
        numPedidos++;
      }
    });

    // Dual query para visitas (timestamp puede ser ms o Firestore Timestamp)
    const [snapVisTs, snapVisNum] = await Promise.all([
      getDocs(query(collection(db, "visitas"),
        where("aliasVendedor", "==", m.alias),
        where("timestamp", ">=", Timestamp.fromDate(fi)),
        where("timestamp", "<=", Timestamp.fromDate(ff)))),
      getDocs(query(collection(db, "visitas"),
        where("aliasVendedor", "==", m.alias),
        where("timestamp", ">=", fi.getTime()),
        where("timestamp", "<=", ff.getTime()))).catch(() => ({ docs: [] }))
    ]);
    const visSeen = new Set();
    const numVisitas = [...snapVisTs.docs, ...(snapVisNum.docs || [])]
      .filter(d => { if (visSeen.has(d.id)) return false; visSeen.add(d.id); return true; }).length;

    const meta = m.metaMonto || 0;
    const pct = meta > 0 ? Math.min((totalVendido / meta) * 100, 100) : 0;

    const barEl    = document.getElementById(`prog-bar-${m.id}`);
    const labelEl  = document.getElementById(`prog-label-${m.id}`);
    const extrasEl = document.getElementById(`prog-extras-${m.id}`);
    if (!barEl) return;

    barEl.style.width = `${pct.toFixed(1)}%`;
    barEl.className = "met-bar-fill" +
      (pct >= 100 ? " cumplida" : pct >= 70 ? "" : " alerta");
    labelEl.textContent = `${_fmtMXN(totalVendido)} / ${_fmtMXN(meta)} (${pct.toFixed(0)}%)`;
    if (extrasEl) extrasEl.innerHTML = `
      <div class="met-sub">📍 Visitas: <span>${numVisitas}${m.metaVisitas ? " / " + m.metaVisitas : ""}</span></div>
      <div class="met-sub">🛒 Pedidos: <span>${numPedidos}</span></div>
    `;
  } catch (_) { /* sin datos = sin barra */ }
}

// ── Helpers del formulario ─────────────────────────────────────────────────────
window._mfTipoCambio = () => {
  const tipo = document.getElementById("mfTipo")?.value;
  const wrap = document.getElementById("mfSemanaWrap");
  if (wrap) wrap.style.display = tipo === "SEMANAL" ? "" : "none";
};

window._mfSemanaAutoFecha = async () => {
  const semNum  = parseInt(document.getElementById("mfSemana")?.value);
  const alias   = document.getElementById("mfAlias")?.value;
  if (!semNum || !alias) return;

  // Obtener diaLiquidacion del usuario
  let diaLiq = 1; // default lunes
  try {
    const { getDoc, doc: fd } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db: fdb } = await import("./firebase-config.js");
    const snap = await getDoc(fd(fdb, "usuarios", alias));
    if (snap.exists()) diaLiq = snap.data().diaLiquidacion ?? 1;
  } catch (_) {}

  // Calcular la fecha de inicio de S(n) del mes actual basada en diaLiquidacion
  const hoy   = new Date();
  const year  = hoy.getFullYear();
  const month = hoy.getMonth();

  // Encontrar el primer día del mes que coincide con diaLiq
  const primerDia = new Date(year, month, 1);
  let offset = (diaLiq - primerDia.getDay() + 7) % 7;
  // Si el 1ro es el diaLiq, esa es S1; si no, el primer diaLiq después del 1ro es S1
  const inicioS1 = offset === 0 ? new Date(year, month, 1) : new Date(year, month, 1 + offset);

  const fi = new Date(inicioS1.getTime() + (semNum - 1) * 7 * 86400000);
  const ff = new Date(fi.getTime() + 6 * 86400000);

  const toInput = d => d.toISOString().slice(0, 10);
  const fiEl = document.getElementById("mfFi");
  const ffEl = document.getElementById("mfFf");
  if (fiEl) fiEl.value = toInput(fi);
  if (ffEl) ffEl.value = toInput(ff);
};

window._mEditar   = id => _abrirForm(id);
window._mEliminar = async id => {
  if (!await window.modal({ title: "Eliminar meta", message: "¿Eliminar esta meta?", danger: true, confirmLabel: "Eliminar" })) return;
  try {
    await deleteDoc(doc(db, "metas", id));
  } catch (e) {
    console.error("[metas] Error al eliminar:", e);
    window.toast?.("Error al eliminar la meta. Intenta de nuevo.", "error");
  }
};

// ── Formulario ─────────────────────────────────────────────────────────────────
function _abrirForm(id) {
  const m = id ? _metas[id] : null;
  const ahora = new Date();
  const defaultFi = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const defaultFf = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0);

  const ingenierosOpts = _ingenieros.map(a =>
    `<option value="${esc(a)}" ${m?.alias === a ? "selected" : ""}>${esc(a)}</option>`
  ).join("");

  document.getElementById("mFormModal").innerHTML = `
    <div class="mf-title">${id ? "Editar meta" : "Nueva meta"}</div>
    <div class="mf-field">
      <label>Ingeniero</label>
      <select id="mfAlias">
        <option value="">Seleccionar…</option>
        ${ingenierosOpts}
      </select>
    </div>
    <div class="mf-row">
      <div class="mf-field">
        <label>Tipo de período</label>
        <select id="mfTipo" onchange="_mfTipoCambio()">
          <option value="SEMANAL" ${m?.tipo !== "MENSUAL" ? "selected" : ""}>Semanal</option>
          <option value="MENSUAL" ${m?.tipo === "MENSUAL" ? "selected" : ""}>Mensual</option>
        </select>
      </div>
      <div class="mf-field" id="mfSemanaWrap">
        <label>Semana del mes</label>
        <select id="mfSemana" onchange="_mfSemanaAutoFecha()">
          <option value="">Personalizada</option>
          <option value="1">S1 — 1ª semana</option>
          <option value="2">S2 — 2ª semana</option>
          <option value="3">S3 — 3ª semana</option>
          <option value="4">S4 — 4ª semana</option>
        </select>
      </div>
      <div class="mf-field">
        <label>Estado</label>
        <select id="mfActiva">
          <option value="1" ${m?.activa !== false ? "selected" : ""}>Activa</option>
          <option value="0" ${m?.activa === false ? "selected" : ""}>Inactiva</option>
        </select>
      </div>
    </div>
    <div class="mf-row">
      <div class="mf-field">
        <label>Fecha inicio</label>
        <input id="mfFi" type="date" value="${_dateToInput(_tsToDate(m?.fechaInicio) || defaultFi)}" />
      </div>
      <div class="mf-field">
        <label>Fecha fin</label>
        <input id="mfFf" type="date" value="${_dateToInput(_tsToDate(m?.fechaFin) || defaultFf)}" />
      </div>
    </div>
    <div style="font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 6px">
      Metas por dimensión
    </div>
    <div class="mf-row">
      <div class="mf-field">
        <label>💰 Venta (MXN)</label>
        <input id="mfMonto" type="number" min="0" step="100" value="${m?.metaMonto ?? ""}" placeholder="0.00" />
      </div>
      <div class="mf-field">
        <label>💧 Litros N10</label>
        <input id="mfLitros" type="number" min="0" step="1" value="${m?.metaLitros ?? ""}" placeholder="0" />
      </div>
    </div>
    <div class="mf-row">
      <div class="mf-field">
        <label>📍 Visitas a clientes</label>
        <input id="mfVisitas" type="number" min="0" value="${m?.metaVisitas ?? ""}" placeholder="0" />
      </div>
      <div class="mf-field">
        <label>🧲 Prospectos nuevos</label>
        <input id="mfProspectos" type="number" min="0" value="${m?.metaProspectos ?? ""}" placeholder="0" />
      </div>
    </div>
    <div class="mf-actions">
      <button class="btn-primary" id="mfBtnGuardar">Guardar</button>
      <button class="btn-secondary" id="mfBtnCancelar">Cancelar</button>
    </div>
  `;

  document.getElementById("mFormWrap").style.display = "flex";
  _regEsc(_cerrarForm);
  document.getElementById("mfBtnGuardar").addEventListener("click", () => _guardarForm(id));
  document.getElementById("mfBtnCancelar").addEventListener("click", _cerrarForm);
  document.getElementById("mFormWrap").addEventListener("click", e => {
    if (e.target === document.getElementById("mFormWrap")) _cerrarForm();
  });
}

function _cerrarForm() {
  _unregEsc();
  document.getElementById("mFormWrap").style.display = "none";
}

async function _guardarForm(id) {
  const alias  = document.getElementById("mfAlias").value.trim();
  const tipo   = document.getElementById("mfTipo").value;
  const activa = document.getElementById("mfActiva").value === "1";
  const fi     = document.getElementById("mfFi").value;
  const ff     = document.getElementById("mfFf").value;
  const monto     = parseFloat(document.getElementById("mfMonto").value) || 0;
  const litros    = parseFloat(document.getElementById("mfLitros")?.value) || 0;
  const vis       = parseInt(document.getElementById("mfVisitas").value) || 0;
  const prosp     = parseInt(document.getElementById("mfProspectos")?.value) || 0;
  const semana    = parseInt(document.getElementById("mfSemana")?.value) || 0;

  if (!alias) { window.toast?.("Selecciona un ingeniero.", "warn"); return; }
  if (!fi || !ff) { window.toast?.("Las fechas son obligatorias.", "warn"); return; }

  const datos = {
    alias, tipo, activa,
    fechaInicio:    new Date(fi + "T00:00:00").getTime(),
    fechaFin:       new Date(ff + "T23:59:59").getTime(),
    metaMonto:      monto,
    metaLitros:     litros,
    metaVisitas:    vis,
    metaProspectos: prosp,
    ...(semana ? { semana } : {}),
    actualizadoPor: Sesion.alias,
    updatedAt: serverTimestamp()
  };

  if (id) {
    await setDoc(doc(db, "metas", id), datos, { merge: true });
  } else {
    datos.creadoPor = Sesion.alias;
    datos.createdAt = serverTimestamp();
    await addDoc(collection(db, "metas"), datos);
  }
  _cerrarForm();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _fmtMXN(n) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN",
    minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n || 0);
}

function _tsToDate(val) {
  if (!val) return null;
  if (val?.toDate) return val.toDate();
  if (typeof val === "number") return new Date(val);
  return null;
}

function _dateToInput(d) {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}
