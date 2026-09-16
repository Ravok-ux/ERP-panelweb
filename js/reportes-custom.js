// reportes-custom.js — Reportes configurables por el usuario
import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { norm } from "./app.js";
import { enriquecerRemisiones } from "./intereses-engine.js";
import { resolverNombre, cargarNombres } from "./nombres-cache.js";
import { exportarExcel } from "./excel-utils.js";
import {
  collection, query, where, orderBy, getDocs,
  limit as fsLimit, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── Fuentes de datos ─────────────────────────────────────────────────────────
const FUENTES = {
  pedidos: {
    label: "Pedidos",
    icon:  "📦",
    collection: "pedidos",
    tsField:    "fechaPedido",
    campos: {
      folio:          { label: "Folio",       tipo: "texto"  },
      clienteNombre:  { label: "Cliente",     tipo: "texto"  },
      ingenieroAlias: { label: "Ingeniero",   tipo: "ingeniero" },
      status:         { label: "Status",      tipo: "status" },
      total:          { label: "Total",       tipo: "moneda" },
      tipoPedido:     { label: "Tipo pedido", tipo: "texto"  },
      tipoVenta:      { label: "Tipo venta",  tipo: "texto"  },
      moneda:         { label: "Moneda",      tipo: "texto"  },
      fechaPedido:    { label: "Fecha",       tipo: "fecha"  },
    },
    filtros: ["status", "ingenieroAlias", "clienteNombre", "moneda"],
    totalCols: ["total"],
  },
  clientes: {
    label: "Clientes",
    icon:  "👥",
    collection:  "clientes",
    noTimestamp: true,          // catálogo sin filtro por fecha
    campos: {
      nombre:         { label: "Nombre",   tipo: "texto"  },
      rfc:            { label: "RFC",      tipo: "texto"  },
      telefono:       { label: "Teléfono", tipo: "texto"  },
      ciudad:         { label: "Ciudad",   tipo: "texto"  },
      estado:         { label: "Estado",   tipo: "texto"  },
      saldoPendiente: { label: "Saldo",    tipo: "moneda" },
      activo:         { label: "Activo",   tipo: "bool"   },
    },
    filtros: ["activo", "estado", "ciudad"],
    totalCols: ["saldoPendiente"],
  },
  gastos_empleado: {
    label: "Gastos de Empleado",
    icon:  "💸",
    collection: "gastos_empleado",
    tsField:    "_ts",
    campos: {
      alias:       { label: "Empleado",    tipo: "texto"  },
      categoria:   { label: "Categoría",   tipo: "texto"  },
      monto:       { label: "Monto",       tipo: "moneda" },
      descripcion: { label: "Descripción", tipo: "texto"  },
      status:      { label: "Status",      tipo: "status" },
      _ts:         { label: "Fecha",       tipo: "fecha"  },
    },
    filtros: ["status", "alias", "categoria"],
    totalCols: ["monto"],
  },
  cortes_caja: {
    label: "Cortes de Caja",
    icon:  "🏦",
    collection: "cortes_caja",
    tsField:    "_ts",
    campos: {
      alias:          { label: "Vendedor",     tipo: "texto"  },
      turno:          { label: "Turno",        tipo: "texto"  },
      totalDeclarado: { label: "Declarado",    tipo: "moneda" },
      totalSistema:   { label: "Sistema",      tipo: "moneda" },
      efectivo:       { label: "Efectivo",     tipo: "moneda" },
      tarjeta:        { label: "Tarjeta",      tipo: "moneda" },
      transferencia:  { label: "Transferencia",tipo: "moneda" },
      status:         { label: "Status",       tipo: "status" },
      _ts:            { label: "Fecha",        tipo: "fecha"  },
    },
    filtros: ["status", "alias"],
    totalCols: ["totalDeclarado", "efectivo", "tarjeta", "transferencia"],
  },
  liquidacion_comision: {
    label: "Comisiones",
    icon:  "💰",
    collection:  "liquidacion_comision",
    noTimestamp: true,          // sin campo timestamp, filtrar por alias/periodo
    campos: {
      alias:         { label: "Ingeniero",     tipo: "texto"  },
      periodo:       { label: "Período",       tipo: "texto"  },
      totalVendido:  { label: "Total vendido", tipo: "moneda" },
      montoComision: { label: "Comisión",      tipo: "moneda" },
      totalPago:     { label: "Pago total",    tipo: "moneda" },
      status:        { label: "Status",        tipo: "status" },
    },
    filtros: ["status", "alias"],
    totalCols: ["totalVendido", "montoComision", "totalPago"],
  },
  remisiones_credito: {
    label: "Aging de cartera",
    icon:  "📋",
    collection: "remisiones_credito",
    campos: {
      folio:           { label: "Folio",            tipo: "texto"  },
      clienteNombre:   { label: "Cliente",          tipo: "texto"  },
      montoOriginal:   { label: "Capital original", tipo: "moneda" },
      totalAbonado:    { label: "Abonado",          tipo: "moneda" },
      interesGenerado: { label: "Interés generado", tipo: "moneda" },
      totalDeuda:      { label: "Total a pagar",    tipo: "moneda" },
      deudaRestante:   { label: "Deuda restante",   tipo: "moneda" },
      status:          { label: "Status",           tipo: "status" },
      diasAtraso:      { label: "Días atraso",      tipo: "numero" },
      ingenieroAlias:  { label: "Ingeniero",        tipo: "ingeniero" },
      fechaVencimiento:{ label: "Vencimiento",      tipo: "fecha"  },
    },
    filtros: ["status", "ingenieroAlias", "clienteNombre"],
    computed:   true,
    sinPeriodo: true,
    totalCols: ["montoOriginal", "totalAbonado", "interesGenerado", "deudaRestante"],
  },
};

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container    = null;
let _fuenteActual = "pedidos";
let _resultados   = [];

export function mount(container) {
  _container = container;
  _container.innerHTML = _html();
  cargarNombres();
  _bindEvents();
}
export function destroy() {}

// ─── Estilos comunes ──────────────────────────────────────────────────────────
const _sel = "padding:.45rem .65rem;border:1px solid var(--border);border-radius:7px;background:var(--surface);color:var(--text-primary);font-size:.88rem;line-height:1.4";
const _inp = _sel + ";width:150px";

// ─── HTML ─────────────────────────────────────────────────────────────────────
function _html() {
  const tabs = Object.entries(FUENTES).map(([k, f]) =>
    `<button class="rc-tab${k === _fuenteActual ? " rc-tab-active" : ""}" data-fuente="${k}">${f.icon} ${f.label}</button>`
  ).join("");

  return `
<div class="rc-wrap">
  <div class="rc-header">
    <h2 style="margin:0 0 .15rem;font-size:1.15rem;font-weight:800;color:var(--text-primary)">📊 Reportes Configurables</h2>
    <p style="margin:0;font-size:.8rem;color:var(--text-sec)">Reportes con campos configurables por fuente de datos</p>
  </div>

  <div class="rc-tabs">${tabs}</div>

  <div class="rc-config">
    <div class="rc-config-section" id="rc-periodo-wrap">
      <label class="rc-label">Período</label>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <select id="rc-periodo" style="${_sel}">
          <option value="hoy">Hoy</option>
          <option value="semana">Esta semana</option>
          <option value="mes" selected>Este mes</option>
          <option value="mes_ant">Mes anterior</option>
          <option value="anio">Este año</option>
          <option value="custom">Personalizado…</option>
        </select>
        <input id="rc-fecha-ini" type="date" style="${_sel};display:none" title="Fecha inicio" />
        <input id="rc-fecha-fin" type="date" style="${_sel};display:none" title="Fecha fin" />
      </div>
    </div>

    <div class="rc-config-section">
      <label class="rc-label">Filtro adicional</label>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
        <select id="rc-filtro-campo" style="${_sel}">
          <option value="">Sin filtro</option>
        </select>
        <input id="rc-filtro-valor" type="text" placeholder="Valor…"
          style="${_inp};display:none" />
      </div>
    </div>

    <div class="rc-config-section" style="flex:1;min-width:260px">
      <label class="rc-label">Columnas a mostrar</label>
      <div id="rc-campos-check" style="display:flex;gap:.4rem;flex-wrap:wrap"></div>
    </div>
  </div>

  <div style="margin-top:1rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
    <button id="rc-btn-generar" class="rc-btn rc-btn-primary">
      <span class="rc-btn-spinner" id="rc-spinner" style="display:none">⏳</span>
      Generar reporte
    </button>
    <button id="rc-btn-limpiar" class="rc-btn rc-btn-ghost" style="display:none">✕ Limpiar</button>
    <div style="flex:1"></div>
    <button id="rc-btn-csv"  class="rc-btn rc-btn-green"  style="display:none">⬇ CSV</button>
    <button id="rc-btn-xlsx" class="rc-btn rc-btn-darkgreen" style="display:none">⬇ Excel</button>
  </div>

  <div id="rc-error" style="display:none;margin-top:.75rem;padding:.6rem 1rem;background:#FEF2F2;
    border:1px solid #FECACA;border-radius:8px;color:#DC2626;font-size:.88rem;font-weight:600"></div>

  <div id="rc-resumen" style="display:none;margin-top:.75rem;padding:.6rem 1rem;
    background:var(--surface-2);border:1px solid var(--border);border-radius:8px;
    font-size:.85rem;color:var(--text-sec)"></div>

  <div style="overflow-x:auto;margin-top:.75rem;border:1px solid var(--border);
    border-radius:10px;max-height:calc(100vh - 380px);overflow-y:auto" id="rc-table-wrap">
    <table id="rc-table" class="rc-tabla" style="display:none">
      <thead id="rc-thead"></thead>
      <tbody id="rc-tbody"></tbody>
      <tfoot id="rc-tfoot"></tfoot>
    </table>
    <div id="rc-empty" style="color:var(--text-sec);text-align:center;padding:3rem;display:none">
      <div style="font-size:2rem;margin-bottom:.5rem">🔍</div>
      <div style="font-weight:600">Sin resultados para este período</div>
      <div style="font-size:.8rem;margin-top:.3rem">Prueba con otro rango de fechas o limpia el filtro adicional</div>
    </div>
    <div id="rc-instrucciones" style="color:var(--text-sec);text-align:center;padding:3rem">
      <div style="font-size:2rem;margin-bottom:.5rem">📋</div>
      <div style="font-weight:600">Configura el reporte y presiona <span style="color:#2563EB">Generar</span></div>
    </div>
  </div>
</div>

<style>
.rc-wrap { padding:1.25rem; display:flex; flex-direction:column; height:100%; box-sizing:border-box; }
.rc-header { margin-bottom:1rem; }
.rc-tabs { display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:.75rem; }
.rc-tab { background:none;border:1px solid var(--border);border-radius:7px;padding:.4rem .9rem;cursor:pointer;font-size:.84rem;color:var(--text-primary);transition:all .12s; }
.rc-tab:hover { background:var(--surface-2); }
.rc-tab-active { background:#2563EB;color:#fff;border-color:#2563EB;font-weight:700; }
.rc-config { background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:1rem;display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start; }
.rc-config-section { min-width:180px; }
.rc-label { display:block;font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-sec);margin-bottom:.4rem; }
.rc-campo-check { display:inline-flex;align-items:center;gap:.3rem;font-size:.82rem;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:.25rem .55rem;cursor:pointer;transition:border-color .12s; }
.rc-campo-check:hover { border-color:#2563EB; }
.rc-campo-check input { accent-color:#2563EB; }
.rc-tabla { width:100%;border-collapse:collapse;font-size:.86rem; }
.rc-tabla th { background:var(--surface-2);padding:.55rem .8rem;text-align:left;font-weight:700;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-sec);border-bottom:2px solid var(--border);white-space:nowrap;position:sticky;top:0;z-index:2; }
.rc-tabla td { padding:.5rem .8rem;border-bottom:1px solid var(--border);color:var(--text-primary); }
.rc-tabla tr:hover td { background:var(--surface-2); }
.rc-tabla tfoot td { font-weight:800;background:var(--surface-2);border-top:2px solid var(--border);border-bottom:none;color:var(--text-primary); }
.rc-badge { display:inline-block;padding:.15rem .55rem;border-radius:20px;font-size:.75rem;font-weight:700;white-space:nowrap; }
.rc-btn { border:none;border-radius:7px;padding:.5rem 1.2rem;font-weight:700;cursor:pointer;font-size:.88rem;display:inline-flex;align-items:center;gap:.4rem;transition:opacity .12s; }
.rc-btn:disabled { opacity:.5;cursor:not-allowed; }
.rc-btn:hover:not(:disabled) { opacity:.88; }
.rc-btn-primary   { background:#2563EB;color:#fff; }
.rc-btn-ghost     { background:none;color:var(--text-sec);border:1px solid var(--border); }
.rc-btn-green     { background:#16A34A;color:#fff; }
.rc-btn-darkgreen { background:#1D6F42;color:#fff; }
</style>`;
}

// ─── Eventos ──────────────────────────────────────────────────────────────────
function _bindEvents() {
  _container.querySelectorAll(".rc-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      _fuenteActual = btn.dataset.fuente;
      _container.querySelectorAll(".rc-tab").forEach(b => b.classList.toggle("rc-tab-active", b === btn));
      _limpiarResultados();
      _actualizarCampos();
      _actualizarFiltros();
      _actualizarPeriodo();
    });
  });

  _container.querySelector("#rc-periodo").addEventListener("change", e => {
    const custom = e.target.value === "custom";
    _container.querySelector("#rc-fecha-ini").style.display = custom ? "inline-block" : "none";
    _container.querySelector("#rc-fecha-fin").style.display = custom ? "inline-block" : "none";
  });

  _container.querySelector("#rc-filtro-campo").addEventListener("change", e => {
    const tieneValor = !!e.target.value;
    const inp = _container.querySelector("#rc-filtro-valor");
    inp.style.display = tieneValor ? "inline-block" : "none";
    if (!tieneValor) inp.value = "";
  });

  _container.querySelector("#rc-btn-generar").addEventListener("click", _generar);
  _container.querySelector("#rc-btn-limpiar").addEventListener("click", _limpiarResultados);
  _container.querySelector("#rc-btn-csv").addEventListener("click",  _exportarCSV);
  _container.querySelector("#rc-btn-xlsx").addEventListener("click", _exportarXLSX);

  _actualizarCampos();
  _actualizarFiltros();
  _actualizarPeriodo();
}

function _actualizarCampos() {
  const fuente = FUENTES[_fuenteActual];
  const wrap   = _container.querySelector("#rc-campos-check");
  wrap.innerHTML = Object.entries(fuente.campos).map(([k, c]) => `
    <label class="rc-campo-check">
      <input type="checkbox" data-campo="${k}" checked /> ${c.label}
    </label>`).join("");
}

function _actualizarPeriodo() {
  const fuente = FUENTES[_fuenteActual];
  const wrap   = _container.querySelector("#rc-periodo-wrap");
  const sel    = _container.querySelector("#rc-periodo");

  if (fuente.noTimestamp || fuente.sinPeriodo) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "";

  // Gestionar opción "todos" para Aging de cartera
  let optTodos = sel.querySelector('option[value="todos"]');
  if (fuente.sinPeriodo && !optTodos) {
    optTodos = document.createElement("option");
    optTodos.value = "todos"; optTodos.textContent = "📋 Todas las notas activas";
    sel.insertBefore(optTodos, sel.firstChild);
    sel.value = "todos";
  } else if (!fuente.sinPeriodo && optTodos) {
    optTodos.remove();
    if (sel.value === "todos") sel.value = "mes";
  }
}

function _actualizarFiltros() {
  const fuente = FUENTES[_fuenteActual];
  const sel    = _container.querySelector("#rc-filtro-campo");
  sel.innerHTML = '<option value="">Sin filtro</option>' +
    fuente.filtros.map(f => `<option value="${f}">${fuente.campos[f]?.label || f}</option>`).join("");
  _container.querySelector("#rc-filtro-valor").style.display = "none";
  _container.querySelector("#rc-filtro-valor").value = "";
}

function _limpiarResultados() {
  _resultados = [];
  _container.querySelector("#rc-table").style.display = "none";
  _container.querySelector("#rc-table-wrap").style.borderColor = "var(--border)";
  _container.querySelector("#rc-empty").style.display       = "none";
  _container.querySelector("#rc-instrucciones").style.display = "block";
  _container.querySelector("#rc-resumen").style.display     = "none";
  _container.querySelector("#rc-error").style.display       = "none";
  _container.querySelector("#rc-btn-csv").style.display     = "none";
  _container.querySelector("#rc-btn-xlsx").style.display    = "none";
  _container.querySelector("#rc-btn-limpiar").style.display = "none";
}

// ─── Generación ───────────────────────────────────────────────────────────────
async function _generar() {
  const btn = _container.querySelector("#rc-btn-generar");
  const sp  = _container.querySelector("#rc-spinner");
  btn.disabled = true; sp.style.display = "inline";
  btn.querySelector ? null : null;

  _container.querySelector("#rc-error").style.display = "none";
  _container.querySelector("#rc-instrucciones").style.display = "none";
  _container.querySelector("#rc-empty").style.display = "none";
  _container.querySelector("#rc-table").style.display = "none";

  try {
    const fuente      = FUENTES[_fuenteActual];
    const filtroCampo = _container.querySelector("#rc-filtro-campo").value;
    const filtroValor = _container.querySelector("#rc-filtro-valor").value.trim();

    // Validar rango custom
    if (!fuente.noTimestamp && !fuente.sinPeriodo) {
      const periodo = _container.querySelector("#rc-periodo").value;
      if (periodo === "custom") {
        const ini = _container.querySelector("#rc-fecha-ini").value;
        const fin = _container.querySelector("#rc-fecha-fin").value;
        if (!ini || !fin) { _showError("Selecciona fecha de inicio y fin para el período personalizado."); return; }
        if (new Date(ini) > new Date(fin)) { _showError("La fecha de inicio no puede ser posterior a la fecha fin."); return; }
      }
    }

    let docs;
    if (fuente.computed) {
      // Aging de cartera
      const periodo = _container.querySelector("#rc-periodo")?.value || "todos";
      let q;
      if (periodo === "todos") {
        q = query(collection(db, fuente.collection), orderBy("fechaVencimiento"), fsLimit(500));
      } else {
        const { ini, fin } = _rango();
        q = query(
          collection(db, fuente.collection),
          where("fechaVencimiento", ">=", Timestamp.fromMillis(ini)),
          where("fechaVencimiento", "<=", Timestamp.fromMillis(fin)),
          orderBy("fechaVencimiento"),
          fsLimit(500)
        );
      }
      const snap = await getDocs(q);
      const raw  = snap.docs.map(d => ({ _id: d.id, ...d.data() })).filter(r => r.status !== "PAGADO");
      docs = enriquecerRemisiones(raw);
    } else if (fuente.noTimestamp) {
      // Sin filtro temporal — fetch todo con límite
      const snap = await getDocs(query(collection(db, fuente.collection), fsLimit(500)));
      docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    } else {
      const { ini, fin } = _rango();
      const tsF  = fuente.tsField || "_ts";
      const snap = await getDocs(query(
        collection(db, fuente.collection),
        where(tsF, ">=", Timestamp.fromMillis(ini)),
        where(tsF, "<=", Timestamp.fromMillis(fin)),
        orderBy(tsF, "desc"),
        fsLimit(500)
      ));
      docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    }

    // Filtro adicional en cliente
    if (filtroCampo && filtroValor) {
      const v = norm(filtroValor);
      docs = docs.filter(d => norm(String(d[filtroCampo] ?? "")).includes(v));
    }

    // Advertencia de límite
    const limitAlcanzado = docs.length >= 500;

    _resultados = docs;
    _renderTabla(fuente, docs, limitAlcanzado);
  } catch (e) {
    _showError("Error al cargar datos: " + e.message);
    console.error("[ReportesCustom]", e);
  } finally {
    btn.disabled = false; sp.style.display = "none";
  }
}

function _showError(msg) {
  const el = _container.querySelector("#rc-error");
  el.textContent = "⚠️ " + msg;
  el.style.display = "block";
  _container.querySelector("#rc-instrucciones").style.display = "none";
}

function _rango() {
  const periodo = _container.querySelector("#rc-periodo").value;
  const ahora   = new Date();
  let ini, fin;

  switch (periodo) {
    case "hoy":
      ini = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).getTime();
      fin = ini + 86_400_000 - 1;
      break;
    case "semana": {
      const dow = ahora.getDay();
      ini = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - dow).getTime();
      fin = ini + 7 * 86_400_000 - 1;
      break;
    }
    case "mes_ant":
      ini = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1).getTime();
      fin = new Date(ahora.getFullYear(), ahora.getMonth(), 1).getTime() - 1;
      break;
    case "anio":
      ini = new Date(ahora.getFullYear(), 0, 1).getTime();
      fin = new Date(ahora.getFullYear() + 1, 0, 1).getTime() - 1;
      break;
    case "custom":
      ini = new Date(_container.querySelector("#rc-fecha-ini").value).getTime();
      fin = new Date(_container.querySelector("#rc-fecha-fin").value).getTime() + 86_400_000 - 1;
      break;
    default: // mes
      ini = new Date(ahora.getFullYear(), ahora.getMonth(), 1).getTime();
      fin = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1).getTime() - 1;
  }
  return { ini, fin };
}

function _camposSeleccionados() {
  return Array.from(_container.querySelectorAll("#rc-campos-check input:checked"))
    .map(el => el.dataset.campo);
}

// ─── Render tabla ─────────────────────────────────────────────────────────────
function _renderTabla(fuente, docs, limitAlcanzado = false) {
  const tabla   = _container.querySelector("#rc-table");
  const thead   = _container.querySelector("#rc-thead");
  const tbody   = _container.querySelector("#rc-tbody");
  const tfoot   = _container.querySelector("#rc-tfoot");
  const empty   = _container.querySelector("#rc-empty");
  const resumen = _container.querySelector("#rc-resumen");
  const btnCsv  = _container.querySelector("#rc-btn-csv");
  const btnXls  = _container.querySelector("#rc-btn-xlsx");
  const btnLimp = _container.querySelector("#rc-btn-limpiar");

  _container.querySelector("#rc-instrucciones").style.display = "none";

  if (docs.length === 0) {
    tabla.style.display  = "none";
    empty.style.display  = "block";
    resumen.style.display= "none";
    btnCsv.style.display = "none";
    btnXls.style.display = "none";
    btnLimp.style.display= "inline-flex";
    return;
  }

  empty.style.display = "none";
  const campos = _camposSeleccionados();

  // Resumen
  const totalCols = (fuente.totalCols || []).filter(c => campos.includes(c));
  let resumenHtml = `<strong style="color:var(--text-primary)">${docs.length} registros</strong>`;
  if (limitAlcanzado) resumenHtml += ` <span style="color:#D97706;font-weight:700">⚠️ Límite de 500 — puede haber más datos</span>`;
  if (totalCols.length) {
    resumenHtml += " &nbsp;·&nbsp; ";
    resumenHtml += totalCols.map(c => {
      const total = docs.reduce((s, d) => s + (Number(d[c]) || 0), 0);
      return `<strong style="color:var(--text-primary)">${fuente.campos[c].label}:</strong> ${_fmtMoneda(total)}`;
    }).join(" &nbsp;·&nbsp; ");
  }
  resumen.innerHTML   = resumenHtml;
  resumen.style.display = "block";

  // Encabezados
  thead.innerHTML = `<tr>${campos.map(c => `<th>${fuente.campos[c]?.label || c}</th>`).join("")}</tr>`;

  // Filas
  tbody.innerHTML = docs.map(d => `<tr>${campos.map(c => _renderCelda(d[c], fuente.campos[c]?.tipo)).join("")}</tr>`).join("");

  // Fila de totales si hay cols monetarias
  if (totalCols.length) {
    tfoot.innerHTML = `<tr>${campos.map(c => {
      if (totalCols.includes(c)) {
        const total = docs.reduce((s, d) => s + (Number(d[c]) || 0), 0);
        return `<td style="font-variant-numeric:tabular-nums">${_fmtMoneda(total)}</td>`;
      }
      return `<td style="color:var(--text-sec);font-size:.75rem">—</td>`;
    }).join("")}</tr>`;
    tfoot.style.display = "";
  } else {
    tfoot.innerHTML = "";
  }

  tabla.style.display = "table";
  btnCsv.style.display = "inline-flex";
  btnXls.style.display = "inline-flex";
  btnLimp.style.display= "inline-flex";
}

// ─── Celda ────────────────────────────────────────────────────────────────────
function _renderCelda(val, tipo) {
  switch (tipo) {
    case "moneda":
      return `<td style="font-variant-numeric:tabular-nums;text-align:right">${_fmtMoneda(Number(val) || 0)}</td>`;
    case "fecha": {
      const d = _toDate(val);
      return `<td style="white-space:nowrap;font-size:.8rem">${d ? d.toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"}) : "—"}</td>`;
    }
    case "bool":
      return `<td style="text-align:center">${val ? '<span class="rc-badge" style="background:#DCFCE7;color:#166534">Sí</span>' : '<span class="rc-badge" style="background:#FEE2E2;color:#DC2626">No</span>'}</td>`;
    case "numero":
      return `<td style="font-variant-numeric:tabular-nums;text-align:right">${val != null ? Number(val).toLocaleString("es-MX") : "—"}</td>`;
    case "status":
      return `<td>${_badgeStatus(String(val ?? ""))}</td>`;
    case "ingeniero":
      return `<td>${val != null && val !== "" ? resolverNombre(String(val)) || String(val) : "—"}</td>`;
    default:
      return `<td>${val != null && val !== "" ? String(val) : "—"}</td>`;
  }
}

function _toDate(val) {
  if (!val) return null;
  if (val?.toDate) return val.toDate();          // Firestore Timestamp
  if (typeof val === "number") return new Date(val);
  if (typeof val === "string") return new Date(val);
  return null;
}

function _fmtMoneda(n) {
  return "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const _STATUS_COLORS = {
  ACTIVA:       ["#DBEAFE","#1E40AF"],
  CONFIRMADO:   ["#DBEAFE","#1E40AF"],
  PENDIENTE:    ["#FEF3C7","#92400E"],
  EN_RUTA:      ["#EDE9FE","#5B21B6"],
  ENTREGADO:    ["#DCFCE7","#166534"],
  PAGADO:       ["#DCFCE7","#166534"],
  FACTURADO:    ["#CFFAFE","#155E75"],
  APROBADO:     ["#DCFCE7","#166534"],
  RECHAZADO:    ["#FEE2E2","#991B1B"],
  CANCELADO:    ["#F3F4F6","#6B7280"],
  BORRADOR:     ["#FEF3C7","#92400E"],
  "POR_VENCER": ["#DBEAFE","#1E40AF"],
  LEVE:         ["#FEF3C7","#92400E"],
  MODERADO:     ["#FED7AA","#C2410C"],
  GRAVE:        ["#FEE2E2","#991B1B"],
  "CRÍTICO":    ["#7F1D1D","#FCA5A5"],
  LIQUIDADO:    ["#DCFCE7","#166534"],
};

function _badgeStatus(val) {
  const colors = _STATUS_COLORS[val.toUpperCase?.()] || _STATUS_COLORS[val] || ["#F3F4F6","#6B7280"];
  return `<span class="rc-badge" style="background:${colors[0]};color:${colors[1]}">${val || "—"}</span>`;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function _exportarCSV() {
  const fuente = FUENTES[_fuenteActual];
  const campos = _camposSeleccionados();
  const header = campos.map(c => fuente.campos[c]?.label || c).join(",");
  const rows   = _resultados.map(d => campos.map(c => {
    const val  = d[c];
    const tipo = fuente.campos[c]?.tipo;
    if (tipo === "fecha") {
      const dt = _toDate(val);
      return dt ? dt.toLocaleDateString("es-MX") : "";
    }
    if (tipo === "bool") return val ? "Sí" : "No";
    const str = String(val ?? "").replace(/"/g, '""');
    return str.includes(",") || str.includes("\n") ? `"${str}"` : str;
  }).join(","));

  const csv  = [header, ...rows].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = `reporte_${_fuenteActual}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── XLSX ─────────────────────────────────────────────────────────────────────
function _exportarXLSX() {
  const fuente = FUENTES[_fuenteActual];
  const campos = _camposSeleccionados();

  const cols = campos.map(c => ({
    key:    c,
    header: fuente.campos[c]?.label || c,
    fmt:    fuente.campos[c]?.tipo === "moneda" ? "moneda"
          : fuente.campos[c]?.tipo === "fecha"  ? "fecha"
          : undefined,
    width:  fuente.campos[c]?.tipo === "moneda" ? 16
          : fuente.campos[c]?.tipo === "fecha"  ? 14
          : 20,
  }));

  const hoy      = new Date().toISOString().slice(0, 10);
  const filename = `reporte-${_fuenteActual}-${hoy}`;
  exportarExcel(_resultados, cols, filename, fuente.label);
}
