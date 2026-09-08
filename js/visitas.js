// ══════════════════════════════════════════════════════════════
// visitas.js — Programación automática + solicitudes atemporales
// ══════════════════════════════════════════════════════════════
import { db }    from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, logAudit, norm } from "./app.js";
import {
  collection, query, orderBy, onSnapshot, where,
  doc, updateDoc, addDoc, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const toDate = ts => {
  if (!ts) return null;
  if (ts?.toDate) return ts.toDate();
  if (typeof ts === "number") return new Date(ts);
  return new Date(ts);
};
const fmtFecha = ts => {
  const d = toDate(ts);
  if (!d) return "—";
  return d.toLocaleDateString("es-MX", { day:"numeric", month:"short", year:"numeric" });
};
const fmtCorto = ts => {
  const d = toDate(ts);
  if (!d) return "Nunca";
  return d.toLocaleDateString("es-MX", { day:"numeric", month:"short" });
};
const diasHasta = ts => {
  const d = toDate(ts);
  if (!d) return null;
  return Math.ceil((d - new Date()) / 86400000);
};

let _unsubSol  = null;
let _unsubCli  = null;
let _unsubHist = null;
let _solicitudes = [];
let _clientes    = [];
let _historial   = [];
let _tabActiva   = "calendario";
let _busqueda    = "";
let _filtroFreq  = "TODOS";
let _histBusq    = "";

const _puedeAutorizar = () =>
  Sesion.esSuperAdmin?.() ||
  ["GERENTE","GERENTE_ZONA","MESA_CONTROL"].includes(Sesion.rol) ||
  Sesion.flags?.PUEDE_AUTORIZAR_VISITAS === true;

// ── Módulo ────────────────────────────────────────────────────
export const VisitasModule = {
  mount(container) {
    _busqueda = ""; _filtroFreq = "TODOS"; _tabActiva = "calendario"; _histBusq = "";
    container.innerHTML = _html();
    _bindUI(container);
    _escucharSolicitudes();
    _escucharClientes();
    _escucharHistorial();
  },
  destroy() {
    _unsubSol?.();  _unsubSol  = null;
    _unsubCli?.();  _unsubCli  = null;
    _unsubHist?.(); _unsubHist = null;
    _solicitudes = []; _clientes = []; _historial = [];
    delete window.VisitasUI;
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <style>
    .vis-wrap { padding:0 2px 24px }
    .vis-tabs { display:flex; gap:0; margin-bottom:0;
      border-bottom:2px solid var(--border) }
    .vis-tab { padding:9px 18px; border:none; background:none; cursor:pointer;
      font-size:13px; font-weight:600; color:#9CA3AF;
      border-bottom:2px solid transparent; margin-bottom:-2px;
      transition:color .15s, border-color .15s; display:flex; align-items:center; gap:6px }
    .vis-tab.active { color:var(--accent,#3B82F6); border-bottom-color:var(--accent,#3B82F6); font-weight:700 }
    .vis-kpis { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr));
      gap:10px; margin:16px 0 }
    .vis-kpi { background:var(--surface); border:1px solid var(--border); border-radius:10px;
      padding:12px 14px }
    .vis-kpi-val { font-size:22px; font-weight:800; font-variant-numeric:tabular-nums }
    .vis-kpi-lbl { font-size:10px; font-weight:600; color:#9CA3AF;
      text-transform:uppercase; letter-spacing:.05em; margin-top:2px }
    .vis-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px }
    .vis-tabla-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:10px }
    .vis-tabla { width:100%; border-collapse:collapse; font-size:13px }
    .vis-tabla th { background:var(--surface); padding:10px 14px;
      text-align:left; font-size:10px; font-weight:700; color:#9CA3AF;
      text-transform:uppercase; letter-spacing:.06em;
      border-bottom:1px solid var(--border); white-space:nowrap }
    .vis-tabla td { padding:10px 14px; border-bottom:1px solid var(--border);
      color:var(--text-primary); vertical-align:middle }
    .vis-tabla tbody tr:last-child td { border-bottom:none }
    .vis-tabla tbody tr:hover { background:var(--surface) }
    .vis-chip { display:inline-flex; align-items:center; gap:3px; padding:3px 9px;
      border-radius:20px; font-size:11px; font-weight:700; white-space:nowrap }
    .vis-sol-card { background:var(--surface); border:1px solid var(--border);
      border-radius:10px; padding:14px 16px; margin-bottom:8px;
      display:flex; align-items:flex-start; justify-content:space-between; gap:12px }
    .vis-sol-card:hover { border-color:var(--accent,#3B82F6) }
    .vis-badge { background:#EF4444; color:#fff; border-radius:10px;
      padding:1px 6px; font-size:10px; font-weight:700 }
  </style>

  <div class="vis-wrap">
    <!-- Tabs -->
    <div class="vis-tabs">
      <button class="vis-tab active" data-tab="calendario">📅 Calendario de visitas</button>
      <button class="vis-tab" data-tab="solicitudes">
        📋 Solicitudes atemporales
        <span id="vis-badge-sol" style="display:none" class="vis-badge">0</span>
      </button>
      <button class="vis-tab" data-tab="historial">📍 Historial de campo</button>
    </div>

    <!-- Panel Calendario -->
    <div id="vis-panel-calendario">
      <!-- KPIs -->
      <div class="vis-kpis">
        <div class="vis-kpi">
          <div class="vis-kpi-val" id="vis-k-total" style="color:var(--text-primary)">—</div>
          <div class="vis-kpi-lbl">Clientes</div>
        </div>
        <div class="vis-kpi">
          <div class="vis-kpi-val" id="vis-k-vencidas" style="color:#DC2626">—</div>
          <div class="vis-kpi-lbl">⚠️ Vencidas</div>
        </div>
        <div class="vis-kpi">
          <div class="vis-kpi-val" id="vis-k-hoy" style="color:#D97706">—</div>
          <div class="vis-kpi-lbl">🔔 Hoy</div>
        </div>
        <div class="vis-kpi">
          <div class="vis-kpi-val" id="vis-k-semana" style="color:#16A34A">—</div>
          <div class="vis-kpi-lbl">📅 Esta semana</div>
        </div>
        <div class="vis-kpi">
          <div class="vis-kpi-val" id="vis-k-sin" style="color:#9CA3AF">—</div>
          <div class="vis-kpi-lbl">Sin programar</div>
        </div>
      </div>

      <!-- Toolbar -->
      <div class="vis-toolbar">
        <div style="position:relative;flex:1;min-width:220px">
          <input id="vis-search" type="search" placeholder="🔍 Buscar cliente o ingeniero…"
            style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid var(--border);
              border-radius:7px;background:var(--surface);color:var(--text-primary);font-size:13px">
          <div id="vis-search-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
            background:var(--surface);border:1px solid var(--border);border-radius:7px;
            max-height:220px;overflow-y:auto;z-index:200;box-shadow:0 4px 16px #0002;margin-top:2px"></div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${[
            ["TODOS",       "Todos",          "#6B7280"],
            ["VENCIDAS",    "⚠️ Vencidas",    "#DC2626"],
            ["HOY",         "🔔 Hoy",         "#D97706"],
            ["ESTA_SEMANA", "📅 Esta semana", "#16A34A"],
            ["SIN_VISITA",  "Sin programar",  "#9CA3AF"],
          ].map(([v,l,c]) => `
            <button class="vis-filtro-btn" data-freq="${v}"
              style="padding:5px 12px;border-radius:20px;border:1.5px solid ${c}30;
                background:${v==="TODOS"?"var(--surface)":"transparent"};
                font-size:11.5px;font-weight:${v==="TODOS"?"700":"600"};
                color:${c};cursor:pointer;transition:all .15s">
              ${l}
            </button>`).join("")}
        </div>
      </div>

      <!-- Tabla -->
      <div class="vis-tabla-wrap">
        <table class="vis-tabla">
          <thead><tr>
            <th>Cliente</th>
            <th>Ingeniero</th>
            <th>Frecuencia</th>
            <th>Última visita</th>
            <th>Próxima visita</th>
            <th>Estado</th>
          </tr></thead>
          <tbody id="vis-tbody-cal">
            <tr><td colspan="6" style="padding:40px;text-align:center;color:#9CA3AF">
              Cargando clientes…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Panel Solicitudes -->
    <div id="vis-panel-solicitudes" style="display:none;padding-top:16px">
      <div id="vis-sol-content">
        <div style="padding:40px;text-align:center;color:#9CA3AF">Cargando solicitudes…</div>
      </div>
    </div>

    <!-- Panel Historial de campo (colección "visitas" del APK) -->
    <div id="vis-panel-historial" style="display:none;padding-top:16px">
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="vis-hist-search" type="search" placeholder="🔍 Buscar cliente o ingeniero…"
          style="flex:1;min-width:220px;padding:7px 10px;border:1px solid var(--border);
            border-radius:7px;background:var(--surface);color:var(--text-primary);font-size:13px">
      </div>
      <div class="vis-tabla-wrap">
        <table class="vis-tabla">
          <thead><tr>
            <th>Fecha</th>
            <th>Ingeniero</th>
            <th>Cliente</th>
            <th>Tipo</th>
            <th>Estado</th>
            <th>Geocerca</th>
          </tr></thead>
          <tbody id="vis-tbody-hist">
            <tr><td colspan="6" style="padding:40px;text-align:center;color:#9CA3AF">
              Cargando historial…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

// ── Firestore ─────────────────────────────────────────────────
function _escucharSolicitudes() {
  _unsubSol?.();
  // Sin orderBy compuesto — ordena client-side para evitar índice requerido
  _unsubSol = onSnapshot(
    query(collection(db, "solicitudes_visita"), limit(200)),
    snap => {
      _solicitudes = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (toDate(b.creadaEn) || 0) - (toDate(a.creadaEn) || 0));
      const pendientes = _solicitudes.filter(s => s.status === "PENDIENTE").length;
      const badge = document.getElementById("vis-badge-sol");
      if (badge) {
        badge.textContent = pendientes;
        badge.style.display = pendientes > 0 ? "" : "none";
      }
      if (_tabActiva === "solicitudes") _renderSolicitudes();
    }, err => console.error("[Visitas/sol]", err)
  );
}

function _escucharClientes() {
  _unsubCli?.();
  // Query sin orderBy para traer TODOS los clientes, independientemente de si tienen proximaVisita
  _unsubCli = onSnapshot(
    query(collection(db, "clientes"), limit(500)),
    snap => {
      _clientes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Ordenar: primero vencidos, luego por proximaVisita asc, luego sin fecha
      _clientes.sort((a, b) => {
        const pa = toDate(a.proximaVisita);
        const pb = toDate(b.proximaVisita);
        if (!pa && !pb) return (a.nombre||"").localeCompare(b.nombre||"");
        if (!pa) return 1;
        if (!pb) return -1;
        return pa - pb;
      });
      _actualizarKPIs();
      _renderCalendario();
    }, err => {
      console.error("[Visitas/cli]", err);
      const tbody = document.getElementById("vis-tbody-cal");
      if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:#DC2626">
        Error: ${err.message}</td></tr>`;
    }
  );
}

// ── KPIs ──────────────────────────────────────────────────────
function _actualizarKPIs() {
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const en7 = new Date(hoy); en7.setDate(en7.getDate() + 7);
  const vencidas = _clientes.filter(c => {
    const pv = toDate(c.proximaVisita);
    return pv && pv < hoy;
  }).length;
  const hoyN = _clientes.filter(c => {
    const pv = toDate(c.proximaVisita);
    return pv && pv >= hoy && pv < new Date(hoy.getTime() + 86400000);
  }).length;
  const semana = _clientes.filter(c => {
    const pv = toDate(c.proximaVisita);
    return pv && pv >= hoy && pv <= en7;
  }).length;
  const sinProg = _clientes.filter(c => !c.proximaVisita && !c.frecuenciaVisitaId).length;

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("vis-k-total",    _clientes.length);
  set("vis-k-vencidas", vencidas);
  set("vis-k-hoy",      hoyN);
  set("vis-k-semana",   semana);
  set("vis-k-sin",      sinProg);
}

// ── Render calendario ─────────────────────────────────────────
function _renderCalendario() {
  const tbody = document.getElementById("vis-tbody-cal");
  if (!tbody) return;
  const q   = norm(_busqueda);
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const en7 = new Date(hoy); en7.setDate(en7.getDate() + 7);

  let lista = _clientes.filter(c => {
    if (q && !norm(c.nombre).includes(q) && !norm(c.vendedor).includes(q)) return false;
    const pv = toDate(c.proximaVisita);
    switch (_filtroFreq) {
      case "VENCIDAS":    return pv && pv < hoy;
      case "HOY":         return pv && pv >= hoy && pv < new Date(hoy.getTime()+86400000);
      case "ESTA_SEMANA": return pv && pv >= hoy && pv <= en7;
      case "SIN_VISITA":  return !c.proximaVisita && !c.frecuenciaVisitaId;
      default: return true;
    }
  });

  if (!lista.length) {
    const msg = _clientes.length === 0
      ? "Sin clientes registrados en el sistema."
      : q || _filtroFreq !== "TODOS"
        ? "Sin resultados para el filtro seleccionado."
        : "Sin clientes con visitas programadas.";
    tbody.innerHTML = `<tr><td colspan="6" style="padding:40px;text-align:center;color:#9CA3AF">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.slice(0, 150).map(c => {
    const pv   = toDate(c.proximaVisita);
    const uv   = toDate(c.fechaUltimaVisita);
    const dias = diasHasta(pv);

    let chip = "";
    if (dias === null)    chip = `<span class="vis-chip" style="background:#F3F4F6;color:#6B7280">Sin programar</span>`;
    else if (dias < 0)    chip = `<span class="vis-chip" style="background:#FEE2E2;color:#991B1B">⚠️ Vencida hace ${-dias}d</span>`;
    else if (dias === 0)  chip = `<span class="vis-chip" style="background:#FEF9C3;color:#854D0E">🔔 Hoy</span>`;
    else if (dias <= 3)   chip = `<span class="vis-chip" style="background:#FFEDD5;color:#9A3412">📅 En ${dias}d</span>`;
    else                  chip = `<span class="vis-chip" style="background:#DCFCE7;color:#166534">✓ En ${dias}d</span>`;

    const freqLabel = c.frecuenciaVisitaLabel || c.frecuenciaVisita || "—";

    return `<tr>
      <td style="font-weight:600;max-width:200px;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap">${esc(c.nombre || c.id)}</td>
      <td style="color:#9CA3AF;font-size:12px">${esc(c.vendedor || "—")}</td>
      <td style="font-size:12px">${esc(freqLabel)}</td>
      <td style="font-size:12px;color:#9CA3AF">${uv ? fmtCorto(uv) : "Nunca"}</td>
      <td style="font-size:12px">${pv ? fmtFecha(pv) : "—"}</td>
      <td>${chip}</td>
    </tr>`;
  }).join("");
}

// ── Render solicitudes ────────────────────────────────────────
function _renderSolicitudes() {
  const el = document.getElementById("vis-sol-content");
  if (!el) return;
  const puedeAut = _puedeAutorizar();

  if (!_solicitudes.length) {
    el.innerHTML = `<div style="padding:60px;text-align:center;color:#9CA3AF">
      Sin solicitudes de visita atemporal registradas.</div>`;
    return;
  }

  const COLOR = {
    PENDIENTE:  { bg:"#FEF9C3", c:"#854D0E", icon:"⏳" },
    APROBADA:   { bg:"#DCFCE7", c:"#166534", icon:"✅" },
    RECHAZADA:  { bg:"#FEE2E2", c:"#991B1B", icon:"❌" },
  };

  el.innerHTML = _solicitudes.map(s => {
    const col = COLOR[s.status] || { bg:"#F3F4F6", c:"#374151", icon:"•" };
    return `<div class="vis-sol-card">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px;margin-bottom:3px">${esc(s.clienteNombre || "—")}</div>
        <div style="font-size:12px;color:#9CA3AF">
          Solicitado por <strong>${esc(s.solicitadoPor || "—")}</strong>
          · ${fmtFecha(s.creadaEn)}
        </div>
        ${s.motivo ? `<div style="font-size:12px;margin-top:5px;color:var(--text-primary);
          padding:6px 10px;background:var(--surface-2,var(--border));border-radius:6px">
          ${esc(s.motivo)}</div>` : ""}
        ${s.resueltaPor ? `<div style="font-size:11px;color:#9CA3AF;margin-top:4px">
          Resuelto por ${esc(s.resueltaPor)} · ${fmtFecha(s.resueltaEn)}</div>` : ""}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <span class="vis-chip" style="background:${col.bg};color:${col.c}">
          ${col.icon} ${s.status}
        </span>
        ${s.status === "PENDIENTE" && puedeAut ? `
          <button class="btn-sm vis-aprobar" data-id="${esc(s.id)}"
            style="background:#DCFCE7;color:#166534;border:1px solid #16A34A40;
              border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600">
            ✓ Aprobar
          </button>
          <button class="btn-sm vis-rechazar" data-id="${esc(s.id)}"
            style="background:#FEE2E2;color:#991B1B;border:1px solid #DC262640;
              border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600">
            ✕ Rechazar
          </button>` : ""}
      </div>
    </div>`;
  }).join("");

  el.querySelectorAll(".vis-aprobar").forEach(btn =>
    btn.addEventListener("click", () => _resolverSolicitud(btn.dataset.id, "APROBADA")));
  el.querySelectorAll(".vis-rechazar").forEach(btn =>
    btn.addEventListener("click", () => _resolverSolicitud(btn.dataset.id, "RECHAZADA")));
}

// ── Historial de campo (colección "visitas" del APK) ─────────
function _escucharHistorial() {
  _unsubHist?.();
  _unsubHist = onSnapshot(
    query(collection(db, "visitas"), orderBy("timestamp", "desc"), limit(300)),
    snap => {
      _historial = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_tabActiva === "historial") _renderHistorial();
    },
    err => console.error("[Visitas/hist]", err)
  );
}

function _renderHistorial() {
  const tbody = document.getElementById("vis-tbody-hist");
  if (!tbody) return;
  const q = norm(_histBusq);
  const lista = _historial.filter(v =>
    !q || norm(v.clienteNombre || "").includes(q) || norm(v.aliasVendedor || "").includes(q)
  );

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:40px;text-align:center;color:#9CA3AF">
      ${_historial.length ? "Sin resultados." : "Sin visitas de campo registradas aún."}</td></tr>`;
    return;
  }

  const TIPO_COLOR = {
    NORMAL:   { bg:"#DCFCE7", c:"#166534" },
    URGENTE:  { bg:"#FEE2E2", c:"#991B1B" },
    SEGUIMIENTO: { bg:"#DBEAFE", c:"#1D4ED8" },
  };
  const ESTADO_COLOR = {
    COMPLETADA: { bg:"#DCFCE7", c:"#166534" },
    PENDIENTE:  { bg:"#FEF9C3", c:"#854D0E" },
    CANCELADA:  { bg:"#F3F4F6", c:"#6B7280" },
  };

  tbody.innerHTML = lista.slice(0, 200).map(v => {
    const tc = TIPO_COLOR[v.tipo]   || { bg:"#F3F4F6", c:"#374151" };
    const ec = ESTADO_COLOR[v.estadoVisita] || { bg:"#F3F4F6", c:"#374151" };
    const fuera = v.fueraDeGeocerca
      ? `<span style="color:#DC2626;font-size:11px">⚠️ Fuera</span>`
      : `<span style="color:#16A34A;font-size:11px">✓ Dentro</span>`;
    return `<tr>
      <td style="font-size:12px;white-space:nowrap">${fmtFecha(v.timestamp || v.fecha)}</td>
      <td style="font-size:12px;color:#6B7280">${esc(v.aliasVendedor || v.ingeniero || "—")}</td>
      <td style="font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${esc(v.clienteNombre || v.clienteId || "—")}</td>
      <td><span class="vis-chip" style="background:${tc.bg};color:${tc.c}">${esc(v.tipo || "—")}</span></td>
      <td><span class="vis-chip" style="background:${ec.bg};color:${ec.c}">${esc(v.estadoVisita || "—")}</span></td>
      <td>${fuera}</td>
    </tr>`;
  }).join("");
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI(container) {
  // Tabs
  container.querySelectorAll(".vis-tab").forEach(btn =>
    btn.addEventListener("click", () => {
      _tabActiva = btn.dataset.tab;
      container.querySelectorAll(".vis-tab").forEach(b => {
        b.classList.toggle("active", b === btn);
      });
      document.getElementById("vis-panel-calendario").style.display =
        _tabActiva === "calendario" ? "" : "none";
      document.getElementById("vis-panel-solicitudes").style.display =
        _tabActiva === "solicitudes" ? "" : "none";
      document.getElementById("vis-panel-historial").style.display =
        _tabActiva === "historial" ? "" : "none";
      if (_tabActiva === "solicitudes") _renderSolicitudes();
      if (_tabActiva === "historial")   _renderHistorial();
    }));

  // Búsqueda en historial
  container.querySelector("#vis-hist-search")?.addEventListener("input", e => {
    _histBusq = e.target.value;
    _renderHistorial();
  });

  // Búsqueda con autocomplete de clientes
  const visSearch = container.querySelector("#vis-search");
  const visSearchDd = container.querySelector("#vis-search-dd");
  visSearch?.addEventListener("input", e => {
    _busqueda = e.target.value;
    _renderCalendario();
    const q = norm(_busqueda);
    if (q.length < 2 || !visSearchDd) { if (visSearchDd) visSearchDd.style.display = "none"; return; }
    const matches = _clientes
      .filter(c => norm(c.nombre).includes(q) || norm(c.vendedor).includes(q))
      .slice(0, 12);
    if (!matches.length) { visSearchDd.style.display = "none"; return; }
    visSearchDd.innerHTML = matches.map(c =>
      `<div class="vis-dd-item" data-nombre="${esc(c.nombre)}"
        style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);color:var(--text-primary)">
        <span style="font-weight:600">${esc(c.nombre)}</span>
        ${c.vendedor ? `<span style="color:#9CA3AF;font-size:11px;margin-left:6px">${esc(c.vendedor)}</span>` : ""}
      </div>`).join("");
    visSearchDd.style.display = "block";
    visSearchDd.querySelectorAll(".vis-dd-item").forEach(el =>
      el.addEventListener("mousedown", ev => {
        ev.preventDefault();
        visSearch.value = el.dataset.nombre;
        _busqueda = el.dataset.nombre;
        visSearchDd.style.display = "none";
        _renderCalendario();
      }));
  });
  visSearch?.addEventListener("blur",   () => setTimeout(() => { if (visSearchDd) visSearchDd.style.display = "none"; }, 150));
  visSearch?.addEventListener("keydown", e => { if (e.key === "Escape" && visSearchDd) visSearchDd.style.display = "none"; });

  // Filtros de frecuencia
  container.querySelectorAll(".vis-filtro-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      _filtroFreq = btn.dataset.freq;
      container.querySelectorAll(".vis-filtro-btn").forEach(b => {
        const activo = b === btn;
        b.style.background  = activo ? "var(--surface)" : "transparent";
        b.style.fontWeight  = activo ? "700" : "600";
        b.style.borderWidth = activo ? "1.5px" : "1.5px";
        b.style.opacity     = activo ? "1" : ".75";
      });
      _renderCalendario();
    }));
}

async function _resolverSolicitud(id, nuevoStatus) {
  const label = nuevoStatus === "APROBADA" ? "Aprobar" : "Rechazar";
  if (!await window.modal?.({ title: `${label} solicitud`,
    message: `¿${label} esta solicitud de visita atemporal?`,
    confirmLabel: label })) return;
  try {
    await updateDoc(doc(db, "solicitudes_visita", id), {
      status:      nuevoStatus,
      resueltaPor: Sesion.alias,
      resueltaEn:  serverTimestamp()
    });
    logAudit("VISITA_SOLICITUD_" + nuevoStatus, { id });
    window.toast?.(`Solicitud ${nuevoStatus.toLowerCase()}`, "success");
  } catch(e) { window.toast?.("Error: " + e.message, "error"); }
}
