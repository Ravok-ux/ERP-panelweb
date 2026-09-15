// ══════════════════════════════════════════════════════════════
// historial-ventas.js — Log histórico de ventas por cliente
// Roles: GERENTE, ADMINISTRADOR, MESA_CONTROL, SUPER_ADMIN
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, norm } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, query, where, orderBy, limit,
  getDocs, onSnapshot, startAfter
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const ROLES_PERMITIDOS = ["GERENTE", "ADMINISTRADOR", "MESA_CONTROL", "SUPER_ADMIN"];
const PAGE_SIZE = 25;

const fmtMXN   = v => new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" }).format(v || 0);
const fmtFecha = ts => {
  if (!ts) return "–";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("es-MX", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" });
};

// ── Estado del módulo ─────────────────────────────────────────
let _unsub       = null;
let _unsubIng    = null;
let _container   = null;
let _clientes    = [];          // cache de búsqueda
let _clienteSel  = null;        // { id, nombre }
let _ventas      = [];          // docs cargados
let _lastDoc     = null;        // cursor paginación
let _hayMas      = false;
let _cargando    = false;
let _filtroIng   = "";
let _filtroCult  = "";
let _modoVista   = "cliente";   // "cliente" | "ingeniero"
let _ingenieroSel = "";         // alias seleccionado en modo ingeniero
let _ingenieros  = [];          // [{ alias, nombre }]

export const HistorialVentasModule = {
  mount(container) {
    if (!_puedeVer()) {
      container.innerHTML = `<div class="empty-state" style="flex:1;justify-content:center">
        <div class="empty-state-icon">🔒</div>
        <div class="empty-state-title">Acceso restringido</div>
        <div class="empty-state-sub">No tienes permisos para ver el historial de ventas.</div>
      </div>`;
      return;
    }
    _container   = container;
    _clienteSel  = null;
    _ventas      = [];
    _lastDoc     = null;
    _hayMas      = false;
    _cargando    = false;
    _filtroIng   = "";
    _filtroCult  = "";
    _modoVista   = "cliente";
    _ingenieroSel = "";

    cargarNombres();
    container.innerHTML = _html();
    _bindUI();
    _cargarClientes();
    _cargarIngenieros();
  },

  destroy() {
    _unsub?.(); _unsub = null;
    _unsubIng?.(); _unsubIng = null;
    _container  = null;
    _clientes   = [];
    _clienteSel = null;
    _ventas     = [];
    _lastDoc    = null;
  }
};

function _puedeVer() {
  return Sesion.esSuperAdmin() || ROLES_PERMITIDOS.includes(Sesion.rol);
}

// ── HTML base ─────────────────────────────────────────────────
function _html() {
  return `
<div style="display:flex;flex-direction:column;height:100%;overflow:hidden">

  <!-- Header -->
  <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;
    border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap">
    <div>
      <div style="font-size:13px;font-weight:800;color:var(--text-primary)">Historial de ventas</div>
      <div id="hv-subtitle" style="font-size:10.5px;color:#9CA3AF">Selecciona un cliente para ver su historial</div>
    </div>

    <!-- Toggle modo -->
    <div style="display:flex;background:var(--surface-2);border:1px solid var(--border);
      border-radius:8px;padding:3px;gap:2px;margin-left:8px">
      <button id="hv-tab-cliente" onclick=""
        style="padding:4px 14px;border:none;border-radius:6px;font-size:11px;font-weight:700;
          cursor:pointer;background:#059669;color:#fff;transition:.15s">
        Por cliente
      </button>
      <button id="hv-tab-ingeniero" onclick=""
        style="padding:4px 14px;border:none;border-radius:6px;font-size:11px;font-weight:700;
          cursor:pointer;background:transparent;color:var(--text-primary);transition:.15s">
        Por ingeniero
      </button>
    </div>

    <div style="flex:1"></div>

    <!-- Controles modo CLIENTE -->
    <div id="hv-ctrl-cliente" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <!-- Filtro cultivo -->
      <select id="hv-fcult" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;
        background:var(--surface);color:var(--text-primary);font-size:12px;display:none">
        <option value="">Todos los cultivos</option>
        ${["MAIZ","SORGO","FRIJOL","TRIGO","TOMATE","CHILE","PAPA","AGUACATE","CAÑA","OTRO"]
          .map(c => `<option value="${c}">${c}</option>`).join("")}
      </select>
      <!-- Filtro ingeniero dentro de cliente -->
      <select id="hv-fing" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;
        background:var(--surface);color:var(--text-primary);font-size:12px;display:none">
        <option value="">Todos los ingenieros</option>
      </select>
      <!-- Export cliente -->
      <button id="hv-export-btn" style="display:none;padding:6px 14px;background:#059669;color:#fff;
        border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700">⬇ Excel</button>
      <!-- Buscador de cliente -->
      <div style="position:relative">
        <input id="hv-buscar" type="text" placeholder="🔍 Buscar cliente…" autocomplete="off"
          style="padding:7px 12px;border:1px solid var(--border);border-radius:8px;
            background:var(--surface);color:var(--text-primary);font-size:12px;width:240px">
        <div id="hv-dd" style="display:none;position:absolute;top:100%;right:0;width:280px;
          background:var(--surface);border:1px solid var(--border);border-radius:8px;
          box-shadow:0 6px 20px rgba(0,0,0,.15);z-index:300;max-height:260px;overflow-y:auto;margin-top:3px">
        </div>
      </div>
    </div>

    <!-- Controles modo INGENIERO -->
    <div id="hv-ctrl-ingeniero" style="display:none;align-items:center;gap:10px;flex-wrap:wrap">
      <select id="hv-ing-sel" style="padding:6px 12px;border:1px solid var(--border);border-radius:8px;
        background:var(--surface);color:var(--text-primary);font-size:12px;min-width:200px">
        <option value="">— Selecciona ingeniero —</option>
      </select>
      <button id="hv-ing-export-btn" style="display:none;padding:6px 14px;background:#059669;color:#fff;
        border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700">⬇ Excel</button>
    </div>
  </div>

  <!-- KPIs (ocultos hasta que haya cliente) -->
  <div id="hv-kpis" style="display:none;flex-shrink:0;border-bottom:1px solid var(--border)">
    <div style="display:grid;grid-template-columns:repeat(5,1fr)">
      ${[
        ["hv-k-compras",    "hv-lbl-compras",  "Compras",          "#9CA3AF"],
        ["hv-k-total",      "hv-lbl-total",    "Total acumulado",  "#4ADE80"],
        ["hv-k-productos",  "hv-lbl-prods",    "Productos únicos", "#60A5FA"],
        ["hv-k-cultivo",    "hv-lbl-cultivo",  "Cultivo frecuente","#FBBF24"],
        ["hv-k-ultima",     "hv-lbl-ultima",   "Última compra",    "#C084FC"]
      ].map(([id, lblId, lbl, col]) => `
        <div style="padding:14px 16px;border-right:1px solid var(--border)">
          <div id="${lblId}" style="font-size:9.5px;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">${lbl}</div>
          <div id="${id}" style="font-size:17px;font-weight:800;color:${col}">–</div>
        </div>`).join("")}
    </div>
  </div>

  <!-- Empty state -->
  <div id="hv-empty-state" style="flex:1;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:12px;color:#6B7280">
    <div style="font-size:48px">📋</div>
    <div id="hv-empty-title" style="font-size:14px;font-weight:700;color:var(--text-primary)">Sin cliente seleccionado</div>
    <div id="hv-empty-sub" style="font-size:12px">Busca un cliente en el campo de arriba para ver su historial de ventas</div>
  </div>

  <!-- Timeline de ventas -->
  <div id="hv-lista" style="display:none;flex:1;overflow-y:auto;padding:16px 20px">
    <div id="hv-items"></div>
    <div id="hv-loading" style="display:none;text-align:center;padding:20px;color:#9CA3AF;font-size:12px">
      Cargando…
    </div>
    <div id="hv-no-data" style="display:none;text-align:center;padding:40px;color:#9CA3AF;font-size:13px">
      Sin ventas registradas para este cliente con los filtros actuales.
    </div>
    <div id="hv-mas-wrap" style="text-align:center;padding:16px;display:none">
      <button id="hv-mas-btn" style="padding:7px 20px;border:1px solid var(--border);
        border-radius:6px;background:var(--surface);color:var(--text-primary);
        font-size:12px;font-weight:600;cursor:pointer">Cargar más</button>
    </div>
  </div>

</div>`;
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI() {
  const buscar = _q("hv-buscar");
  const dd     = _q("hv-dd");

  buscar.addEventListener("input", () => {
    const q = norm(buscar.value.trim());
    if (q.length < 2) { dd.style.display = "none"; return; }
    const matches = _clientes
      .filter(c => norm(c.nombre).includes(q) || norm(c.codigoCliente || "").includes(q))
      .slice(0, 14);
    if (!matches.length) { dd.style.display = "none"; return; }
    dd.innerHTML = matches.map(c => `
      <div data-id="${esc(c.id)}" data-nombre="${esc(c.nombre)}"
        style="padding:9px 14px;cursor:pointer;font-size:12px;
          border-bottom:1px solid var(--border);color:var(--text-primary)"
        onmouseover="this.style.background='var(--surface-2)'"
        onmouseout="this.style.background=''">
        <div style="font-weight:700">${esc(c.nombre)}</div>
        ${c.codigoCliente ? `<div style="font-size:10px;color:#9CA3AF">${esc(c.codigoCliente)}</div>` : ""}
      </div>`).join("");
    dd.style.display = "block";
    dd.querySelectorAll("div[data-id]").forEach(el => {
      el.addEventListener("mousedown", e => {
        e.preventDefault();
        const cli = _clientes.find(c => c.id === el.dataset.id) || { id: el.dataset.id, nombre: el.dataset.nombre };
        _seleccionarCliente(cli);
        buscar.value = el.dataset.nombre;
        dd.style.display = "none";
      });
    });
  });

  buscar.addEventListener("blur", () => setTimeout(() => { dd.style.display = "none"; }, 160));

  _q("hv-fcult")?.addEventListener("change", e => {
    _filtroCult = e.target.value;
    _recargar();
  });

  _q("hv-fing")?.addEventListener("change", e => {
    _filtroIng = e.target.value;
    _renderVentas();
  });

  _q("hv-export-btn")?.addEventListener("click", _exportarExcel);
  _q("hv-ing-export-btn")?.addEventListener("click", _exportarExcelIngeniero);
  _q("hv-mas-btn")?.addEventListener("click", _cargarMas);

  _q("hv-tab-cliente")?.addEventListener("click", () => _cambiarModo("cliente"));
  _q("hv-tab-ingeniero")?.addEventListener("click", () => _cambiarModo("ingeniero"));

  _q("hv-ing-sel")?.addEventListener("change", e => {
    _ingenieroSel = e.target.value;
    if (_ingenieroSel) _cargarVentasIngeniero();
    else {
      _unsubIng?.(); _unsubIng = null;
      _ventas = [];
      const _items = _q("hv-items"); if (_items) _items.innerHTML = "";
      const _es = _q("hv-empty-state"); if (_es) _es.style.display = "";
      const _kp = _q("hv-kpis"); if (_kp) _kp.style.display = "none";
      const _li = _q("hv-lista"); if (_li) _li.style.display = "none";
      const _eb = _q("hv-ing-export-btn"); if (_eb) _eb.style.display = "none";
    }
  });
}

// ── Cambio de modo ────────────────────────────────────────────
function _cambiarModo(modo) {
  _modoVista = modo;
  const esIng = modo === "ingeniero";

  // Toggle estilos
  const tabCli = _q("hv-tab-cliente");
  const tabIng = _q("hv-tab-ingeniero");
  if (tabCli) { tabCli.style.background = esIng ? "transparent" : "#059669"; tabCli.style.color = esIng ? "var(--text-primary)" : "#fff"; }
  if (tabIng) { tabIng.style.background = esIng ? "#059669" : "transparent"; tabIng.style.color = esIng ? "#fff" : "var(--text-primary)"; }

  const ctrlCli = _q("hv-ctrl-cliente");
  const ctrlIng = _q("hv-ctrl-ingeniero");
  if (ctrlCli) ctrlCli.style.display = esIng ? "none" : "flex";
  if (ctrlIng) ctrlIng.style.display = esIng ? "flex" : "none";

  // Reset estado
  _unsub?.(); _unsub = null;
  _unsubIng?.(); _unsubIng = null;
  _ventas = []; _lastDoc = null; _hayMas = false;
  _clienteSel = null; _ingenieroSel = "";
  _filtroIng = ""; _filtroCult = "";

  const empty = _q("hv-empty-state");
  const lista  = _q("hv-lista");
  const kpis   = _q("hv-kpis");
  const items  = _q("hv-items");
  if (empty) empty.style.display = "";
  if (lista) lista.style.display = "none";
  if (kpis)  kpis.style.display  = "none";
  if (items) items.innerHTML = "";

  const emptyTitle = _q("hv-empty-title");
  const emptySub   = _q("hv-empty-sub");
  if (emptyTitle) emptyTitle.textContent = esIng ? "Sin ingeniero seleccionado" : "Sin cliente seleccionado";
  if (emptySub)   emptySub.textContent   = esIng ? "Selecciona un ingeniero en el dropdown de arriba" : "Busca un cliente en el campo de arriba para ver su historial de ventas";

  const subtitle = _q("hv-subtitle");
  if (subtitle) subtitle.textContent = esIng ? "Historial por ingeniero" : "Selecciona un cliente para ver su historial";

  // Reset selector de ingeniero
  const ingSel = _q("hv-ing-sel");
  if (ingSel) ingSel.value = "";
  _q("hv-ing-export-btn") && (_q("hv-ing-export-btn").style.display = "none");

  // Restaurar label del 4.° KPI según modo
  const lblCultivo = _q("hv-lbl-cultivo");
  if (lblCultivo) lblCultivo.textContent = esIng ? "Clientes atendidos" : "Cultivo frecuente";

  // Reset UI modo cliente
  const fcult = _q("hv-fcult");
  const fing  = _q("hv-fing");
  if (fcult) { fcult.value = ""; fcult.style.display = "none"; }
  if (fing)  { fing.innerHTML = '<option value="">Todos los ingenieros</option>'; fing.style.display = "none"; }
  _q("hv-export-btn") && (_q("hv-export-btn").style.display = "none");
  const buscar = _q("hv-buscar");
  if (buscar) buscar.value = "";
}

// ── Cargar ingenieros para el dropdown ────────────────────────
async function _cargarIngenieros() {
  try {
    await cargarNombres(); // asegura que el cache de nombres esté listo
    const snap = await getDocs(
      query(collection(db, "usuarios"), where("rol", "in", ["INGENIERO", "RECUPERADOR"]))
    );
    _ingenieros = snap.docs
      .filter(d => d.data().activo !== false)
      .map(d => ({
        alias:  d.data().alias || d.id,
        nombre: d.data().nombre || d.data().alias || d.id
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  } catch(e) {
    console.error("[HV] _cargarIngenieros:", e);
  }
  const sel = _q("hv-ing-sel");
  if (!sel) return;
  sel.innerHTML = '<option value="">— Selecciona ingeniero —</option>' +
    _ingenieros.map(i => `<option value="${esc(i.alias)}">${esc(i.nombre)}</option>`).join("");
}

// ── Cargar ventas de un ingeniero (todos sus clientes) ────────
function _cargarVentasIngeniero() {
  _unsubIng?.(); _unsubIng = null;
  _ventas = []; _lastDoc = null;
  _setLoading(true);
  _q("hv-empty-state").style.display = "none";
  _q("hv-kpis").style.display = "";
  _q("hv-lista").style.display = "";
  _q("hv-items").innerHTML = "";

  const nombre = resolverNombre(_ingenieroSel);
  const subtitle = _q("hv-subtitle");
  if (subtitle) subtitle.textContent = `Ventas de ${nombre}`;

  // Sin orderBy para evitar requerir índice compuesto; ordenamos client-side
  const q = query(
    collection(db, "historial_ventas"),
    where("ingenieroAlias", "==", _ingenieroSel),
    limit(200)
  );

  _unsubIng = onSnapshot(q, snap => {
    _ventas = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const ta = a._ts?.toMillis?.() ?? (a._ts || 0);
        const tb = b._ts?.toMillis?.() ?? (b._ts || 0);
        return tb - ta;
      });
    _lastDoc = null;
    _hayMas  = false;
    _setLoading(false);
    _actualizarKPIsIngeniero();
    _renderVentasIngeniero();
    const btn = _q("hv-ing-export-btn");
    if (btn) btn.style.display = _ventas.length ? "" : "none";
  }, err => {
    console.error("[HV] ingeniero snapshot:", err);
    _setLoading(false);
    window.toast?.("Error al cargar ventas del ingeniero", "error");
  });
}

// ── KPIs modo ingeniero ───────────────────────────────────────
function _actualizarKPIsIngeniero() {
  // Ajustar label del 4.° KPI a "Clientes atendidos"
  const lblCultivo = _q("hv-lbl-cultivo");
  if (lblCultivo) lblCultivo.textContent = "Clientes atendidos";

  if (!_ventas.length) {
    ["hv-k-compras","hv-k-total","hv-k-productos","hv-k-cultivo","hv-k-ultima"]
      .forEach(id => _setText(id, "–"));
    return;
  }
  const totalMXN = _ventas.reduce((s, v) => s + (v.totalMXN || 0), 0);
  const prods    = new Set(_ventas.flatMap(v => (v.productos || []).map(p => p.productoId).filter(Boolean)));
  const clientes = new Set(_ventas.map(v => v.clienteId).filter(Boolean));
  _setText("hv-k-compras",   _ventas.length);
  _setText("hv-k-total",     fmtMXN(totalMXN));
  _setText("hv-k-productos", prods.size);
  _setText("hv-k-cultivo",   clientes.size);
  _setText("hv-k-ultima",    fmtFecha(_ventas[0]?._ts));
}

// ── Render modo ingeniero ─────────────────────────────────────
function _renderVentasIngeniero() {
  const items = _q("hv-items");
  if (!items) return;
  _q("hv-no-data").style.display  = _ventas.length === 0 ? "" : "none";
  _q("hv-mas-wrap").style.display = _hayMas ? "" : "none";
  items.innerHTML = _ventas.map(v => _cardVenta(v, true)).join("");
}

// ── Export Excel modo ingeniero ───────────────────────────────
function _exportarExcelIngeniero() {
  if (!_ventas.length) { window.toast?.("Sin datos para exportar", "warning"); return; }
  if (!window.XLSX)    { window.toast?.("Librería Excel no disponible", "error"); return; }
  const rows = [["Fecha","Cliente","Ingeniero","Cultivo","Etapa","Enfermedad","Producto","Categoría","Cantidad","Unidad","Precio","Total Venta","Método Pago"]];
  _ventas.forEach(v => {
    const ctx = v.contexto || {};
    (v.productos || [{ nombre: "–", categoria: "–", cantidad: 1, unidad: "pieza", precio: v.totalMXN }]).forEach(p => {
      rows.push([
        fmtFecha(v._ts), v.clienteNombre || v.clienteId || "–",
        resolverNombre(v.ingenieroAlias),
        ctx.cultivo || "–", ctx.etapaFenologica || "–", ctx.enfermedad || "–",
        p.nombre || "–", p.categoria || "–",
        p.cantidad || 1, p.unidad || "pieza", p.precio || 0,
        v.totalMXN || 0, v.metodoPago || "–"
      ]);
    });
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Historial");
  XLSX.writeFile(wb, `historial_${norm(resolverNombre(_ingenieroSel)).replace(/\s+/g,"_")}.xlsx`);
}

// ── Cargar catálogo de clientes ───────────────────────────────
async function _cargarClientes() {
  try {
    const snap = await getDocs(query(collection(db, "clientes"), orderBy("nombre")));
    _clientes = snap.docs.map(d => ({
      id: d.id,
      nombre:       d.data().nombre        || "",
      codigoCliente:d.data().codigoCliente || "",
      tipo:         d.data().tipo          || "",
      tipoCultivo:  d.data().tipoCultivo   || ""
    }));
  } catch(e) { console.error("[HV] clientes:", e); }
}

// ── Seleccionar cliente ───────────────────────────────────────
function _seleccionarCliente(cli) {
  _clienteSel = cli;
  _ventas     = [];
  _lastDoc    = null;
  _hayMas     = false;
  _filtroIng  = "";
  _filtroCult = "";

  // Resetear filtros UI
  const fcult = _q("hv-fcult");
  const fing  = _q("hv-fing");
  if (fcult) { fcult.value = ""; fcult.style.display = ""; }
  if (fing)  { fing.innerHTML = '<option value="">Todos los ingenieros</option>'; fing.style.display = ""; }

  _q("hv-export-btn").style.display  = "";
  _q("hv-empty-state").style.display = "none";
  _q("hv-kpis").style.display        = "";
  _q("hv-lista").style.display       = "";
  _q("hv-items").innerHTML           = "";
  _q("hv-no-data").style.display     = "none";

  const chips = [cli.tipo, cli.tipoCultivo].filter(Boolean)
    .map(v => `<span style="font-size:10px;padding:2px 8px;border-radius:9px;
      background:var(--surface-2);border:1px solid var(--border);color:var(--text-sec)">${esc(v)}</span>`)
    .join(" ");
  const subtitle = _q("hv-subtitle");
  if (subtitle) subtitle.innerHTML = `Historial de ${esc(cli.nombre)}${chips ? " &nbsp;" + chips : ""}`;

  _detenerListener();
  _iniciarListener();
}

// ── Firestore listener con paginación ─────────────────────────
function _iniciarListener() {
  if (!_clienteSel) return;
  _setLoading(true);

  let q = query(
    collection(db, "historial_ventas"),
    where("clienteId", "==", _clienteSel.id),
    orderBy("_ts", "desc"),
    limit(PAGE_SIZE)
  );

  if (_filtroCult) {
    q = query(
      collection(db, "historial_ventas"),
      where("clienteId", "==", _clienteSel.id),
      where("contexto.cultivo", "==", _filtroCult),
      orderBy("_ts", "desc"),
      limit(PAGE_SIZE)
    );
  }

  _unsub = onSnapshot(q, snap => {
    _ventas  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _lastDoc = snap.docs[snap.docs.length - 1] || null;
    _hayMas  = snap.docs.length === PAGE_SIZE;
    _setLoading(false);
    _actualizarKPIs();
    _actualizarDropdownIngenieros();
    _renderVentas();
  }, err => {
    console.error("[HV] snapshot:", err);
    _setLoading(false);
    window.toast?.("Error al cargar historial", "error");
  });
}

function _detenerListener() {
  _unsub?.(); _unsub = null;
}

function _recargar() {
  _ventas  = [];
  _lastDoc = null;
  _hayMas  = false;
  _q("hv-items").innerHTML = "";
  _detenerListener();
  _iniciarListener();
}

async function _cargarMas() {
  if (!_lastDoc || !_hayMas || _cargando) return;
  _cargando = true;
  _q("hv-mas-btn").textContent = "Cargando…";
  try {
    let q = query(
      collection(db, "historial_ventas"),
      where("clienteId", "==", _clienteSel.id),
      orderBy("_ts", "desc"),
      startAfter(_lastDoc),
      limit(PAGE_SIZE)
    );
    const snap = await getDocs(q);
    const nuevos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _ventas  = [..._ventas, ...nuevos];
    _lastDoc = snap.docs[snap.docs.length - 1] || _lastDoc;
    _hayMas  = snap.docs.length === PAGE_SIZE;
    _actualizarKPIs();
    _renderVentas();
  } catch(e) { console.error("[HV] cargarMas:", e); }
  _cargando = false;
  _q("hv-mas-btn").textContent = "Cargar más";
}

// ── KPIs ──────────────────────────────────────────────────────
function _actualizarKPIs() {
  // Restaurar label del 4.° KPI a "Cultivo frecuente"
  const lblCultivo = _q("hv-lbl-cultivo");
  if (lblCultivo) lblCultivo.textContent = "Cultivo frecuente";

  const ventas = _ventas;
  if (!ventas.length) {
    ["hv-k-compras","hv-k-total","hv-k-productos","hv-k-cultivo","hv-k-ultima"]
      .forEach(id => _setText(id, "–"));
    return;
  }

  const totalMXN = ventas.reduce((s, v) => s + (v.totalMXN || 0), 0);
  const prods    = new Set(ventas.flatMap(v => (v.productos || []).map(p => p.productoId).filter(Boolean)));

  // Cultivo más frecuente
  const cultCount = {};
  ventas.forEach(v => { const c = v.contexto?.cultivo; if (c) cultCount[c] = (cultCount[c] || 0) + 1; });
  const cultFreq = Object.entries(cultCount).sort((a,b) => b[1]-a[1])[0]?.[0] || "–";

  _setText("hv-k-compras",   ventas.length);
  _setText("hv-k-total",     fmtMXN(totalMXN));
  _setText("hv-k-productos", prods.size);
  _setText("hv-k-cultivo",   cultFreq);
  _setText("hv-k-ultima",    fmtFecha(ventas[0]?._ts));
}

// ── Poblar dropdown de ingenieros ─────────────────────────────
function _actualizarDropdownIngenieros() {
  const sel = _q("hv-fing");
  if (!sel) return;
  const prevVal = sel.value;
  const aliases = [...new Set(_ventas.map(v => v.ingenieroAlias).filter(Boolean))];
  aliases.sort((a, b) => resolverNombre(a).localeCompare(resolverNombre(b), "es"));
  sel.innerHTML = '<option value="">Todos los ingenieros</option>' +
    aliases.map(a => `<option value="${esc(a)}">${esc(resolverNombre(a))}</option>`).join("");
  // Restaurar selección si aún existe
  if (prevVal && aliases.includes(prevVal)) sel.value = prevVal;
  else _filtroIng = "";
}

// ── Render timeline ───────────────────────────────────────────
function _renderVentas() {
  const items = _q("hv-items");
  if (!items) return;

  const filtrados = _filtroIng
    ? _ventas.filter(v => v.ingenieroAlias === _filtroIng)
    : _ventas;

  _q("hv-no-data").style.display  = filtrados.length === 0 ? "" : "none";
  _q("hv-mas-wrap").style.display = _hayMas ? "" : "none";

  items.innerHTML = filtrados.map(v => _cardVenta(v)).join("");
}

function _cardVenta(v, mostrarCliente = false) {
  const prods = v.productos || [];
  const ctx   = v.contexto  || {};

  const ctx_chips = [
    ctx.cultivo          && `<span style="${_chip("#FBBF24")}">${esc(ctx.cultivo)}</span>`,
    ctx.etapaFenologica  && `<span style="${_chip("#60A5FA")}">Etapa ${esc(ctx.etapaFenologica)}</span>`,
    ctx.enfermedad       && `<span style="${_chip("#F87171")}">🦠 ${esc(ctx.enfermedad)}</span>`,
    ctx.region           && `<span style="${_chip("#A78BFA")}">📍 ${esc(ctx.region)}</span>`,
    ctx.hectareas        && `<span style="${_chip("#9CA3AF")}">${ctx.hectareas} ha</span>`
  ].filter(Boolean).join("");

  const prods_html = prods.map(p => `
    <div style="display:flex;justify-content:space-between;align-items:center;
      padding:5px 0;border-bottom:1px solid var(--border)">
      <div>
        <span style="font-size:12px;font-weight:600;color:var(--text-primary)">${esc(p.nombre || "–")}</span>
        ${p.categoria ? `<span style="font-size:10px;color:#9CA3AF;margin-left:6px">${esc(p.categoria)}</span>` : ""}
      </div>
      <div style="text-align:right;flex-shrink:0;margin-left:12px">
        <span style="font-size:11px;color:#9CA3AF">${p.cantidad || 1} ${esc(p.unidad || "pieza")}</span>
        <span style="font-size:12px;font-weight:700;color:#4ADE80;margin-left:8px">${fmtMXN(p.precio)}</span>
      </div>
    </div>`).join("");

  return `
<div style="display:flex;gap:14px;margin-bottom:16px">
  <!-- Línea de tiempo -->
  <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
    <div style="width:12px;height:12px;border-radius:50%;background:#059669;border:2px solid var(--border);flex-shrink:0;margin-top:4px"></div>
    <div style="width:2px;flex:1;background:var(--border);margin-top:4px"></div>
  </div>
  <!-- Card -->
  <div style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:10px;
    padding:14px 16px;margin-bottom:4px">
    <!-- Cabecera -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <div>
        ${mostrarCliente && v.clienteNombre ? `<div style="font-size:13px;font-weight:800;color:var(--text-primary);margin-bottom:1px">${esc(v.clienteNombre)}</div>` : ""}
        <div style="font-size:12.5px;font-weight:${mostrarCliente ? "400" : "700"};color:var(--text-primary)">${fmtFecha(v._ts)}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:2px">
          👤 ${esc(resolverNombre(v.ingenieroAlias))}
          ${v.metodoPago ? `· <span style="color:#FBBF24">${esc(v.metodoPago)}</span>` : ""}
        </div>
      </div>
      <div style="font-size:18px;font-weight:800;color:#4ADE80">${fmtMXN(v.totalMXN)}</div>
    </div>
    <!-- Contexto agronómico -->
    ${ctx_chips ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">${ctx_chips}</div>` : ""}
    <!-- Productos -->
    <div style="border-top:1px solid var(--border);padding-top:10px">
      <div style="font-size:10px;font-weight:700;color:#6B7280;text-transform:uppercase;
        letter-spacing:.06em;margin-bottom:6px">Productos vendidos</div>
      ${prods_html || '<div style="font-size:11px;color:#9CA3AF">Sin detalle de productos</div>'}
    </div>
  </div>
</div>`;
}

// ── Export Excel ──────────────────────────────────────────────
function _exportarExcel() {
  if (!_ventas.length) { window.toast?.("Sin datos para exportar", "warning"); return; }
  if (!window.XLSX) { window.toast?.("Librería Excel no disponible", "error"); return; }

  const rows = [["Fecha","Cliente","Ingeniero","Cultivo","Etapa","Enfermedad","Producto","Categoría","Cantidad","Unidad","Precio","Total Venta","Método Pago"]];

  _ventas.forEach(v => {
    const ctx = v.contexto || {};
    (v.productos || [{ nombre: "–", categoria: "–", cantidad: 1, unidad: "pieza", precio: v.totalMXN }]).forEach(p => {
      rows.push([
        v._fecha || fmtFecha(v._ts),
        v.clienteNombre || _clienteSel?.nombre || "–",
        resolverNombre(v.ingenieroAlias),
        ctx.cultivo || "–",
        ctx.etapaFenologica || "–",
        ctx.enfermedad || "–",
        p.nombre || "–",
        p.categoria || "–",
        p.cantidad || 1,
        p.unidad || "pieza",
        p.precio || 0,
        v.totalMXN || 0,
        v.metodoPago || "–"
      ]);
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Historial");
  XLSX.writeFile(wb, `historial_${norm(_clienteSel?.nombre || "cliente").replace(/\s+/g, "_")}.xlsx`);
}

// ── Helpers ───────────────────────────────────────────────────
function _q(id) { return _container?.querySelector?.(`#${id}`) || document.getElementById(id); }
function _setText(id, val) { const el = _q(id); if (el) el.textContent = val; }
function _setLoading(v) {
  const l = _q("hv-loading");
  if (l) l.style.display = v ? "" : "none";
}
function _chip(color) {
  return `display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:99px;
    background:${color}22;color:${color};margin-right:2px`;
}
