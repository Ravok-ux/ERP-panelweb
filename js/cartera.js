// ══════════════════════════════════════════════════════════════
// cartera.js — Aging de cuentas por cobrar, semáforo y desbloqueos
// ══════════════════════════════════════════════════════════════

import { db }    from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, norm } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, doc, query, onSnapshot,
  getDoc, updateDoc, setDoc, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { exportarExcel } from "./excel-utils.js";

const fmt   = new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" });

// ── Estado ────────────────────────────────────────────────────
let _unsub     = null;
let _clientes  = [];
let _config    = { semaforo:{ verde:15, amarillo:30, naranja:60 },
                   bloqueoAutoActivo:true, frecuencias:[], horasDesbloqueo:[4,8,24] };
let _fColor    = "TODOS";
let _fBusq     = "";
let _tabActiva = "aging";

const COLORES = {
  CRÍTICO:    { bg:"#FEE2E2", text:"#991B1B", dot:"#EF4444", label:"Crítico (+61 d)"  },
  GRAVE:      { bg:"#FFEDD5", text:"#9A3412", dot:"#F97316", label:"Grave (44–61 d)"  },
  MODERADO:   { bg:"#DBEAFE", text:"#1E40AF", dot:"#3B82F6", label:"Moderado (30–43 d)" },
  LEVE:       { bg:"#FEF9C3", text:"#854D0E", dot:"#EAB308", label:"Leve (16–29 d)"   },
  POR_VENCER: { bg:"#DCFCE7", text:"#166534", dot:"#22C55E", label:"Por vencer (≤15 d)"},
  PAGADO:     { bg:"#DCFCE7", text:"#166534", dot:"#22C55E", label:"Pagado"            },
  FUTURA:     { bg:"#F3F4F6", text:"#6B7280", dot:"#9CA3AF", label:"Futura"            },
};

const _puedeDesbloquear = () =>
  Sesion.esSuperAdmin?.() ||
  ["GERENTE","GERENTE_ZONA","MESA_CONTROL"].includes(Sesion.rol) ||
  Sesion.flags?.PUEDE_DESBLOQUEAR_CARTERA === true;

// ── Módulo ────────────────────────────────────────────────────
export const CarteraModule = {
  mount(container) {
    _fColor = "TODOS"; _fBusq = ""; _tabActiva = "aging";
    cargarNombres();
    _cargarConfig().then(() => {
      container.innerHTML = _html();
      _bindUI(container);
      _escuchar();
    });
  },
  destroy() {
    _unsub?.(); _unsub = null;
    _clientes = [];
    delete window.CarteraUI;
  }
};

// ── Config ────────────────────────────────────────────────────
async function _cargarConfig() {
  try {
    const snap = await getDoc(doc(db, "configuracion", "cartera"));
    if (snap.exists()) _config = { ..._config, ...snap.data() };
  } catch (_) {}
}

// ── Firestore ─────────────────────────────────────────────────
function _escuchar() {
  _unsub?.();
  // Sin orderBy: trae todos los clientes, filtra y ordena client-side
  _unsub = onSnapshot(
    query(collection(db, "clientes"), limit(500)),
    snap => {
      _clientes = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c => (c.saldoPendiente > 0 || c.totalAPagarTotal > 0 ||
                      c.diasMaxVencidos > 0 || c.semaforoColor))
        .sort((a, b) => (b.diasMaxVencidos || 0) - (a.diasMaxVencidos || 0));
      _renderKpis();
      _aplicarFiltros();
    },
    err => {
      console.error("[cartera]", err);
      const el = document.getElementById("cart-tbody");
      if (el) el.innerHTML = `<tr><td colspan="9" style="padding:40px;text-align:center;color:#DC2626">
        Error al cargar: ${err.message}</td></tr>`;
    }
  );
}

// ── Filtros ───────────────────────────────────────────────────
function _aplicarFiltros() {
  const q = norm(_fBusq);
  const filtrados = _clientes.filter(c => {
    if (_fColor !== "TODOS" && c.semaforoColor !== _fColor) return false;
    if (q && !norm(c.nombre).includes(q) && !norm(c.vendedor).includes(q)) return false;
    return true;
  });
  _renderTabla(filtrados);
}

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <style>
    .cart-tab { padding:9px 18px;border:none;background:none;cursor:pointer;
      font-size:13px;font-weight:600;color:#9CA3AF;
      border-bottom:2px solid transparent;margin-bottom:-2px;
      transition:color .15s,border-color .15s }
    .cart-tab.active { color:var(--accent,#3B82F6);border-bottom-color:var(--accent,#3B82F6);font-weight:700 }
    .cart-kpi { background:var(--surface);border:1px solid var(--border);
      border-radius:10px;padding:13px 16px }
    .cart-kpi-val { font-size:20px;font-weight:800;font-variant-numeric:tabular-nums }
    .cart-kpi-lbl { font-size:10px;font-weight:600;color:#9CA3AF;
      text-transform:uppercase;letter-spacing:.05em;margin-top:2px }
    .cart-pill { padding:5px 13px;border-radius:20px;border:1.5px solid;
      font-size:11.5px;font-weight:600;cursor:pointer;transition:all .15s;
      background:transparent }
    .cart-tabla-wrap { overflow-x:auto;border:1px solid var(--border);border-radius:10px }
    .cart-tabla { width:100%;border-collapse:collapse;font-size:13px }
    .cart-tabla th { background:var(--surface);padding:10px 12px;
      text-align:left;font-size:10px;font-weight:700;color:#9CA3AF;
      text-transform:uppercase;letter-spacing:.06em;
      border-bottom:1px solid var(--border);white-space:nowrap }
    .cart-tabla th.num { text-align:right }
    .cart-tabla th.ctr { text-align:center }
    .cart-tabla td { padding:10px 12px;border-bottom:1px solid var(--border);
      vertical-align:middle }
    .cart-tabla tbody tr:last-child td { border-bottom:none }
    .cart-tabla tbody tr:hover { background:var(--surface) }
    .cart-chip { display:inline-flex;align-items:center;gap:4px;padding:3px 9px;
      border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap }
    .cart-btn-sm { padding:4px 10px;border:none;border-radius:6px;
      cursor:pointer;font-size:11px;font-weight:600 }
    .cfg-card { background:var(--surface);border:1px solid var(--border);
      border-radius:10px;padding:20px }
    .cfg-input { width:100%;padding:7px 10px;border:1px solid var(--border);
      border-radius:7px;background:var(--surface-2,var(--surface));
      color:var(--text-primary);font-size:13px;box-sizing:border-box }
  </style>

  <div style="padding:0 0 24px">

    <!-- Tabs -->
    <div style="display:flex;border-bottom:2px solid var(--border);margin-bottom:16px">
      <button class="cart-tab active" data-tab="aging">📊 Aging / Cartera</button>
      <button class="cart-tab" data-tab="config">⚙️ Configuración</button>
    </div>

    <!-- Panel Aging -->
    <div id="cart-panel-aging">

      <!-- KPIs -->
      <div id="cart-kpis" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px">
        ${[1,2,3,4,5,6,7].map(() =>
          `<div style="height:68px;border-radius:10px;background:var(--surface);border:1px solid var(--border);
            animation:pulse 1.5s ease-in-out infinite alternate"></div>`).join("")}
      </div>

      <!-- Filtros de semáforo (pills) -->
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
        ${[
          ["TODOS",    "Todos",         "#6B7280"],
          ["CRÍTICO",  "🔴 Crítico",    "#DC2626"],
          ["GRAVE",    "🟠 Grave",      "#EA580C"],
          ["MODERADO", "🔵 Moderado",   "#2563EB"],
          ["LEVE",     "🟡 Leve",       "#CA8A04"],
          ["POR_VENCER","🟢 Por vencer","#16A34A"],
        ].map(([v,l,c]) => `
          <button class="cart-pill" data-filtro="${v}"
            style="color:${c};border-color:${c}30;
              ${v==="TODOS"?"font-weight:700;border-color:"+c+";background:var(--surface)":""}">
            ${l}
          </button>`).join("")}
      </div>

      <!-- Búsqueda + Exportar -->
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <div style="position:relative;flex:1;min-width:220px">
          <input id="cart-search" type="search" placeholder="🔍 Buscar cliente o ingeniero…"
            style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid var(--border);
              border-radius:7px;background:var(--surface);color:var(--text-primary);font-size:13px">
          <div id="cart-search-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
            background:var(--surface);border:1px solid var(--border);border-radius:7px;
            max-height:220px;overflow-y:auto;z-index:200;box-shadow:0 4px 16px #0002;margin-top:2px"></div>
        </div>
        <button id="cart-excel"
          style="padding:7px 14px;background:#16A34A;color:#fff;border:none;border-radius:7px;
            cursor:pointer;font-size:13px;font-weight:600">
          ⬇ Excel
        </button>
      </div>

      <!-- Tabla -->
      <div class="cart-tabla-wrap">
        <table class="cart-tabla">
          <thead><tr>
            <th>Cliente</th>
            <th>Ingeniero</th>
            <th class="num">Capital</th>
            <th class="num">Interés gen.</th>
            <th class="num" style="color:#F59E0B">Total a pagar</th>
            <th class="ctr">Días vencido</th>
            <th class="ctr">Semáforo</th>
            <th class="ctr">Estado</th>
            <th class="ctr">Acciones</th>
          </tr></thead>
          <tbody id="cart-tbody">
            <tr><td colspan="9" style="padding:40px;text-align:center;color:#9CA3AF">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Panel Config -->
    <div id="cart-panel-config" style="display:none;padding-top:4px">
      <div id="cart-config-inner">${_htmlConfig()}</div>
    </div>

  </div>`;
}

// ── Config HTML ───────────────────────────────────────────────
function _htmlConfig() {
  const s = _config.semaforo || {};
  const h = (_config.horasDesbloqueo || [4,8,24]).join(", ");
  const freqs = (_config.frecuencias || []).map((f, i) => `
    <tr>
      <td style="padding:5px 8px">
        <input class="cfg-input" data-fi="${i}" data-fk="label"
          value="${esc(f.label)}" style="padding:5px 8px">
      </td>
      <td style="padding:5px 8px">
        <input type="number" class="cfg-input" data-fi="${i}" data-fk="dias"
          value="${f.dias}" style="padding:5px 8px;width:80px">
      </td>
      <td style="padding:5px 8px">
        <button class="cfg-del-freq cart-btn-sm" data-i="${i}"
          style="background:#FEE2E2;color:#991B1B">✕</button>
      </td>
    </tr>`).join("");

  return `
  <div style="max-width:640px;display:flex;flex-direction:column;gap:16px">
    <div class="cfg-card">
      <div style="font-weight:700;margin-bottom:14px;font-size:14px">🚦 Umbrales del semáforo (días vencidos)</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px">
        <label style="font-size:12px;color:#9CA3AF;display:flex;flex-direction:column;gap:4px">
          🟢 Verde hasta <input id="cfg-verde" type="number" class="cfg-input" value="${s.verde??15}" min="1">
        </label>
        <label style="font-size:12px;color:#9CA3AF;display:flex;flex-direction:column;gap:4px">
          🟡 Amarillo hasta <input id="cfg-amarillo" type="number" class="cfg-input" value="${s.amarillo??30}" min="1">
        </label>
        <label style="font-size:12px;color:#9CA3AF;display:flex;flex-direction:column;gap:4px">
          🟠 Naranja hasta <input id="cfg-naranja" type="number" class="cfg-input" value="${s.naranja??60}" min="1">
        </label>
      </div>
      <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="cfg-bloqueo" ${_config.bloqueoAutoActivo!==false?"checked":""}>
        Bloqueo automático cuando semáforo es 🔴 Crítico
      </label>
    </div>

    <div class="cfg-card">
      <div style="font-weight:700;margin-bottom:12px;font-size:14px">🔓 Horas de desbloqueo temporal</div>
      <div style="font-size:12px;color:#9CA3AF;margin-bottom:8px">Opciones del menú (separadas por coma)</div>
      <input id="cfg-horas" class="cfg-input" value="${esc(h)}" style="width:200px">
    </div>

    <div class="cfg-card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-weight:700;font-size:14px">📅 Categorías de frecuencia</div>
        <button id="cfg-add-freq" class="cart-btn-sm"
          style="background:var(--accent,#3B82F6);color:#fff;padding:6px 14px;border-radius:7px">
          + Agregar
        </button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="font-size:11px;color:#9CA3AF;font-weight:700;text-transform:uppercase;letter-spacing:.05em">
          <th style="padding:4px 8px;text-align:left">Nombre</th>
          <th style="padding:4px 8px;text-align:left">Días</th>
          <th></th>
        </tr></thead>
        <tbody id="cfg-freqs-tbody">${freqs || "<tr><td colspan='3' style='padding:12px 8px;color:#9CA3AF;font-size:12px'>Sin categorías configuradas.</td></tr>"}</tbody>
      </table>
    </div>

    <button id="cfg-guardar"
      style="padding:10px 24px;background:var(--accent,#3B82F6);color:#fff;border:none;
        border-radius:8px;cursor:pointer;font-weight:700;font-size:14px;align-self:flex-start">
      💾 Guardar configuración
    </button>
  </div>`;
}

// ── Render tabla ──────────────────────────────────────────────
function _renderTabla(filtrados) {
  const tbody = document.getElementById("cart-tbody");
  if (!tbody) return;

  if (!filtrados.length) {
    const msg = _clientes.length === 0
      ? "Sin clientes con saldo pendiente"
      : "Sin resultados para el filtro seleccionado";
    tbody.innerHTML = `<tr><td colspan="9" style="padding:48px;text-align:center;color:#9CA3AF">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtrados.map(c => {
    const col      = COLORES[c.semaforoColor] || COLORES.POR_VENCER;
    const dias     = c.diasMaxVencidos || 0;
    const bloq     = c.bloqueado;
    const desbl    = c.desbloqueoHasta > Date.now();
    const puedeD   = _puedeDesbloquear();
    const capital  = c.saldoCapitalTotal ?? c.saldoPendiente ?? 0;
    const interes  = c.interesTotal ?? 0;
    const totalAP  = c.totalAPagarTotal ?? (capital + interes);

    const estadoChip = bloq
      ? (desbl
          ? `<span class="cart-chip" style="background:#FEF9C3;color:#854D0E">🔓 Desbloqueado</span>`
          : `<span class="cart-chip" style="background:#FEE2E2;color:#991B1B">🔒 Bloqueado</span>`)
      : `<span class="cart-chip" style="background:#DCFCE7;color:#166534">✓ Activo</span>`;

    const accionDesbl = (bloq && !desbl && puedeD)
      ? `<button class="cart-btn-sm cart-desbloquear" data-id="${esc(c.id)}" data-nom="${esc(c.nombre||c.id)}"
           style="background:#DBEAFE;color:#1E40AF">🔓 Desbloquear</button>`
      : "";
    const accionRebloq = (desbl && puedeD)
      ? `<button class="cart-btn-sm cart-rebloq" data-id="${esc(c.id)}"
           style="background:#FEE2E2;color:#991B1B">🔒 Revocar</button>`
      : "";

    // Día vencido: badge con fondo semáforo
    const diasCell = dias > 0
      ? `<span class="cart-chip" style="background:${col.bg};color:${col.text}">${dias}d</span>`
      : `<span style="color:#9CA3AF">—</span>`;

    return `<tr>
      <td style="font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${esc(c.nombre || c.id)}</td>
      <td style="color:#9CA3AF;font-size:12px">${esc(resolverNombre(c.vendedor) || "—")}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;color:#9CA3AF">${fmt.format(capital)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;color:${interes>0?"#D97706":"#9CA3AF"}">
        ${interes > 0 ? fmt.format(interes) : "—"}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:#F97316">
        ${fmt.format(totalAP)}</td>
      <td style="text-align:center">${diasCell}</td>
      <td style="text-align:center">
        <span class="cart-chip" style="background:${col.bg};color:${col.text}">
          <span style="width:7px;height:7px;border-radius:50%;background:${col.dot};flex-shrink:0"></span>
          ${col.label}
        </span>
      </td>
      <td style="text-align:center">${estadoChip}</td>
      <td style="text-align:center">
        <div style="display:flex;gap:4px;justify-content:center">
          ${accionDesbl}${accionRebloq}
        </div>
      </td>
    </tr>`;
  }).join("");
}

// ── KPIs ──────────────────────────────────────────────────────
function _renderKpis() {
  const el = document.getElementById("cart-kpis");
  if (!el) return;
  const capitalT = _clientes.reduce((s,c) => s + (c.saldoCapitalTotal ?? c.saldoPendiente ?? 0), 0);
  const interesT = _clientes.reduce((s,c) => s + (c.interesTotal ?? 0), 0);
  const totalAP  = _clientes.reduce((s,c) => s + (c.totalAPagarTotal ?? ((c.saldoCapitalTotal ?? c.saldoPendiente ?? 0) + (c.interesTotal ?? 0))), 0);
  const criticos = _clientes.filter(c => c.semaforoColor === "CRÍTICO").length;
  const graves   = _clientes.filter(c => c.semaforoColor === "GRAVE").length;
  const bloq     = _clientes.filter(c => c.bloqueado && c.desbloqueoHasta <= Date.now()).length;
  const desbloq  = _clientes.filter(c => c.desbloqueoHasta > Date.now()).length;

  const kpi = (val, lbl, color="var(--text-primary)") =>
    `<div class="cart-kpi">
      <div class="cart-kpi-val" style="color:${color}">${val}</div>
      <div class="cart-kpi-lbl">${lbl}</div>
    </div>`;

  el.innerHTML =
    kpi(_clientes.length,    "Clientes en cartera") +
    kpi(fmt.format(capitalT),"Capital pendiente",   "#3B82F6") +
    kpi(fmt.format(interesT),"Interés generado",    "#D97706") +
    kpi(fmt.format(totalAP), "Total a pagar",       "#F97316") +
    kpi(criticos + graves,   "⚠️ Crítico / Grave",  "#DC2626") +
    kpi(bloq,                "🔒 Bloqueados",       "#F59E0B") +
    kpi(desbloq,             "🔓 Desbloqueados tmp.","#8B5CF6");
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI(container) {
  // Tabs
  container.querySelectorAll(".cart-tab").forEach(btn =>
    btn.addEventListener("click", () => {
      _tabActiva = btn.dataset.tab;
      container.querySelectorAll(".cart-tab").forEach(b =>
        b.classList.toggle("active", b === btn));
      document.getElementById("cart-panel-aging").style.display  =
        _tabActiva === "aging"  ? "" : "none";
      document.getElementById("cart-panel-config").style.display =
        _tabActiva === "config" ? "" : "none";
      if (_tabActiva === "config") _bindConfigUI(container);
    }));

  // Búsqueda con autocomplete de clientes
  const cartSearch = container.querySelector("#cart-search");
  const cartSearchDd = container.querySelector("#cart-search-dd");
  cartSearch?.addEventListener("input", e => {
    _fBusq = e.target.value;
    _aplicarFiltros();
    const q = norm(_fBusq);
    if (q.length < 2 || !cartSearchDd) { if (cartSearchDd) cartSearchDd.style.display = "none"; return; }
    const matches = _clientes
      .filter(c => norm(c.nombre).includes(q) || norm(c.vendedor).includes(q))
      .slice(0, 12);
    if (!matches.length) { cartSearchDd.style.display = "none"; return; }
    cartSearchDd.innerHTML = matches.map(c =>
      `<div class="cart-dd-item" data-nombre="${esc(c.nombre)}"
        style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);color:var(--text-primary)">
        <span style="font-weight:600">${esc(c.nombre)}</span>
        ${c.vendedor ? `<span style="color:#9CA3AF;font-size:11px;margin-left:6px">${esc(resolverNombre(c.vendedor))}</span>` : ""}
      </div>`).join("");
    cartSearchDd.style.display = "block";
    cartSearchDd.querySelectorAll(".cart-dd-item").forEach(el =>
      el.addEventListener("mousedown", ev => {
        ev.preventDefault();
        cartSearch.value = el.dataset.nombre;
        _fBusq = el.dataset.nombre;
        cartSearchDd.style.display = "none";
        _aplicarFiltros();
      }));
  });
  cartSearch?.addEventListener("blur",   () => setTimeout(() => { if (cartSearchDd) cartSearchDd.style.display = "none"; }, 150));
  cartSearch?.addEventListener("keydown", e => { if (e.key === "Escape" && cartSearchDd) cartSearchDd.style.display = "none"; });

  // Filtros semáforo (pills)
  container.querySelectorAll(".cart-pill").forEach(btn =>
    btn.addEventListener("click", () => {
      _fColor = btn.dataset.filtro;
      container.querySelectorAll(".cart-pill").forEach(b => {
        const act = b === btn;
        b.style.fontWeight  = act ? "700" : "600";
        b.style.background  = act ? "var(--surface)" : "transparent";
        b.style.opacity     = act ? "1" : ".7";
      });
      _aplicarFiltros();
    }));

  // Excel
  container.querySelector("#cart-excel")?.addEventListener("click", _exportar);

  // Acciones de tabla (event delegation)
  container.addEventListener("click", e => {
    const des = e.target.closest(".cart-desbloquear");
    if (des) { _abrirDesbloqueo(des.dataset.id, des.dataset.nom); return; }
    const reb = e.target.closest(".cart-rebloq");
    if (reb) { _rebloqueaCliente(reb.dataset.id); }
  });
}

function _bindConfigUI(container) {
  const inner = document.getElementById("cart-config-inner");
  if (!inner) return;
  inner.querySelector("#cfg-guardar")?.addEventListener("click", () => _guardarConfig(inner));
  inner.querySelector("#cfg-add-freq")?.addEventListener("click", () => {
    _config.frecuencias = [...(_config.frecuencias || []), { label: "Nueva categoría", dias: 7 }];
    inner.innerHTML = _htmlConfig();
    _bindConfigUI(container);
  });
  inner.querySelectorAll(".cfg-del-freq").forEach(btn =>
    btn.addEventListener("click", () => {
      _config.frecuencias = (_config.frecuencias || []).filter((_, i) => i !== Number(btn.dataset.i));
      inner.innerHTML = _htmlConfig();
      _bindConfigUI(container);
    }));
}

// ── Desbloqueo ────────────────────────────────────────────────
function _abrirDesbloqueo(clienteId, clienteNombre) {
  const horas = _config.horasDesbloqueo || [4, 8, 24];
  const opts  = horas.map(h => `<option value="${h}">${h} horas</option>`).join("");
  const modal = document.createElement("div");
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center";
  modal.innerHTML = `
    <div style="background:var(--surface);border-radius:12px;padding:24px;width:360px;
      box-shadow:0 20px 40px rgba(0,0,0,.3);max-width:calc(100vw - 32px)">
      <h3 style="margin:0 0 4px;font-size:16px">🔓 Desbloqueo temporal</h3>
      <p style="margin:0 0 16px;font-size:13px;color:#9CA3AF">${esc(clienteNombre)}</p>
      <label style="font-size:13px;display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
        Duración
        <select id="dl-horas" style="padding:8px;border:1px solid var(--border);border-radius:7px;
          background:var(--surface);color:var(--text-primary)">${opts}</select>
      </label>
      <label style="font-size:13px;display:flex;flex-direction:column;gap:6px;margin-bottom:18px">
        Motivo (opcional)
        <textarea id="dl-motivo" rows="2"
          style="padding:8px;border:1px solid var(--border);border-radius:7px;
            background:var(--surface);color:var(--text-primary);resize:none;box-sizing:border-box;width:100%"
          placeholder="Ej. Autorizado por gerencia para pedido urgente"></textarea>
      </label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="dl-cancel" style="padding:8px 16px;border:1px solid var(--border);
          background:none;border-radius:7px;cursor:pointer;color:var(--text-primary)">Cancelar</button>
        <button id="dl-ok" style="padding:8px 16px;background:var(--accent,#3B82F6);
          color:#fff;border:none;border-radius:7px;cursor:pointer;font-weight:700">Desbloquear</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector("#dl-cancel").onclick = () => modal.remove();
  modal.querySelector("#dl-ok").onclick = async () => {
    const h      = Number(modal.querySelector("#dl-horas").value) || 4;
    const motivo = modal.querySelector("#dl-motivo").value.trim();
    const hasta  = Date.now() + h * 3600000;
    try {
      await updateDoc(doc(db, "clientes", clienteId), {
        bloqueado: false, desbloqueoHasta: hasta,
        desbloqueoMotivo: motivo || "", desbloqueadoPor: Sesion.alias,
        desbloqueoEn: serverTimestamp()
      });
      window.toast?.(`${esc(clienteNombre)} desbloqueado por ${h}h`, "success");
    } catch (e) { window.toast?.("Error: " + e.message, "error"); }
    modal.remove();
  };
}

async function _rebloqueaCliente(clienteId) {
  if (!await window.modal?.({ title:"Revocar desbloqueo",
    message:"¿Revocar el desbloqueo temporal y volver a bloquear este cliente?",
    danger:true })) return;
  try {
    await updateDoc(doc(db, "clientes", clienteId), { bloqueado:true, desbloqueoHasta:0 });
    window.toast?.("Cliente bloqueado nuevamente", "success");
  } catch (e) { window.toast?.("Error: " + e.message, "error"); }
}

// ── Config: guardar ───────────────────────────────────────────
async function _guardarConfig(scope) {
  const verde    = parseInt(scope.querySelector("#cfg-verde")?.value) || 15;
  const amarillo = parseInt(scope.querySelector("#cfg-amarillo")?.value) || 30;
  const naranja  = parseInt(scope.querySelector("#cfg-naranja")?.value) || 60;
  const bloqueo  = scope.querySelector("#cfg-bloqueo")?.checked !== false;
  const horasRaw = (scope.querySelector("#cfg-horas")?.value || "4,8,24")
    .split(",").map(h => parseInt(h.trim())).filter(h => h > 0);
  const filas = scope.querySelectorAll("#cfg-freqs-tbody tr");
  const frecuencias = Array.from(filas).map(tr => ({
    label: tr.querySelector("[data-fk='label']")?.value.trim() || "",
    dias:  parseInt(tr.querySelector("[data-fk='dias']")?.value) || 7
  })).filter(f => f.label);

  const nuevo = { semaforo:{ verde, amarillo, naranja }, bloqueoAutoActivo:bloqueo,
    horasDesbloqueo:horasRaw, frecuencias,
    actualizadoPor:Sesion.alias, actualizadoEn:serverTimestamp() };
  try {
    await setDoc(doc(db, "configuracion", "cartera"), nuevo, { merge:true });
    _config = { ..._config, ...nuevo };
    window.toast?.("Configuración guardada", "success");
  } catch (e) { window.toast?.("Error: " + e.message, "error"); }
}

// ── Exportar ──────────────────────────────────────────────────
function _exportar() {
  const rows = _clientes.map(c => ({
    cliente:      c.nombre || c.id,
    ingeniero:    c.vendedor || "—",
    capital:      c.saldoCapitalTotal ?? c.saldoPendiente ?? 0,
    interes:      c.interesTotal ?? 0,
    totalAPagar:  c.totalAPagarTotal ?? ((c.saldoCapitalTotal ?? c.saldoPendiente ?? 0) + (c.interesTotal ?? 0)),
    diasVencidos: c.diasMaxVencidos || 0,
    semaforo:     c.semaforoColor || "—",
    bloqueado:    c.bloqueado ? "Sí" : "No",
  }));
  exportarExcel(rows, [
    { key:"cliente",     header:"Cliente",          width:30 },
    { key:"ingeniero",   header:"Ingeniero",         width:20 },
    { key:"capital",     header:"Capital ($)",       width:16, tipo:"numero" },
    { key:"interes",     header:"Interés gen. ($)",  width:16, tipo:"numero" },
    { key:"totalAPagar", header:"Total a pagar ($)", width:18, tipo:"numero" },
    { key:"diasVencidos",header:"Días vencidos",     width:14, tipo:"numero" },
    { key:"semaforo",    header:"Semáforo",          width:12 },
    { key:"bloqueado",   header:"Bloqueado",         width:10 },
  ], "Cartera_" + new Date().toISOString().slice(0,10));
}
