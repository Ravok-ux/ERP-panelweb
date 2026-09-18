// ══════════════════════════════════════════════════════════════
// clientes.js — Directorio de clientes con KPIs, búsqueda y ficha detalle
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { esc, norm } from "./app.js";
import { Sesion } from "./auth.js";
import {
  collection, query, orderBy, onSnapshot,
  doc, updateDoc, getDoc, addDoc, serverTimestamp,
  getDocs, where, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { exportarExcel } from "./excel-utils.js";
import { cargarCacheBlacklist, clienteEnBlacklist } from "./blacklist.js";

// ── Focus trap utility ────────────────────────────────────────
// Atrapa el foco dentro de `el` y cierra con Escape via `closeFn`.
// Devuelve cleanup: llama al regresar el foco al exterior.
function _trapFocus(el, closeFn) {
  const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const getFocusable = () => [...el.querySelectorAll(sel)].filter(n => !n.closest('[style*="display:none"]'));
  const onKey = e => {
    if (e.key === "Escape") { closeFn(); return; }
    if (e.key !== "Tab") return;
    const nodes = getFocusable();
    if (!nodes.length) { e.preventDefault(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };
  document.addEventListener("keydown", onKey);
  const firstFocusable = getFocusable()[0];
  if (firstFocusable) firstFocusable.focus();
  return () => document.removeEventListener("keydown", onKey);
}

// Mapa de cleanups por modal id
const _focusCleanups = {};
function _openTrap(modalId, closeFn) {
  _closeTrap(modalId);
  const el = document.getElementById(modalId);
  if (el) _focusCleanups[modalId] = _trapFocus(el, closeFn);
}
function _closeTrap(modalId) {
  _focusCleanups[modalId]?.();
  delete _focusCleanups[modalId];
}

// ── Columnas Excel ────────────────────────────────────────────
const _COLS = [
  { key: "nombre",       header: "Nombre",           width: 30, required: true },
  { key: "telefono",     header: "Teléfono",         width: 16 },
  { key: "direccion",    header: "Dirección",        width: 36 },
  { key: "colonia",      header: "Colonia",          width: 20 },
  { key: "ciudad",       header: "Ciudad",           width: 18 },
  { key: "segmento",     header: "Segmento",         width: 16 },
  { key: "saldo",        header: "Saldo ($)",        width: 14, tipo: "numero" },
  { key: "ingeniero",    header: "Ingeniero asig.",  width: 18 },
  { key: "zona",         header: "Zona",             width: 14 },
  { key: "ultimaVisita", header: "Última visita",    width: 18, fmt: "fecha" },
  { key: "activo",       header: "Activo",           width: 10 },
];

const fmt   = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fmtDt = d => {
  if (!d) return "—";
  try {
    const date = typeof d === "number" ? new Date(d) : new Date(d?.toDate?.() ?? d);
    if (isNaN(date) || d === 0) return "—";
    return date.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
  } catch { return "—"; }
};
const _saldoCliente = c => Number(c.saldoCapitalTotal ?? c.totalAPagarTotal ?? c.saldo) || 0;

let _unsub      = null;
let _clientes   = [];
let _filtrados  = [];
let _abcMap     = {};  // clienteDocId → 'A'|'B'|'C'
let _abcCargado = false;

// ── Filtros activos ───────────────────────────────────────────
let _fBusqueda  = "";
let _fSegmento  = "TODOS";
let _fIngeniero = "TODOS";
let _fEstado    = "TODOS";   // TODOS | activos | inactivos
let _fSaldo     = "TODOS";   // TODOS | con_saldo | sin_saldo

let _detalleId  = null;
let _sortCol    = null;   // key de columna activa
let _sortDir    = 1;      // 1=asc, -1=desc

// ── Módulo exportado ──────────────────────────────────────────
export const ClientesModule = {
  mount(container) {
    container.innerHTML = _html();
    document.getElementById("cli-tbody").innerHTML = window.skeleton?.(5, 7) ?? "";
    _bindUI();
    _escuchar();
    return () => this.destroy();
  },
  destroy() {
    _unsub?.();
    _unsub = null;
    _clientes = [];
    _filtrados = [];
    _abcMap = {}; _abcCargado = false;
    _fBusqueda = ""; _fSegmento = "TODOS"; _fIngeniero = "TODOS";
    _fEstado = "TODOS"; _fSaldo = "TODOS"; _detalleId = null;
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <div style="padding:0 0 24px">

    <!-- KPIs -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:14px">
      ${_kpi("cli-k-total",  "CLIENTES",       "var(--text-primary)")}
      ${_kpi("cli-k-activos","ACTIVOS",        "#16A34A")}
      ${_kpi("cli-k-saldo",  "SALDO TOTAL",    "#2563EB")}
      ${_kpi("cli-k-visita", "VISITA HOY",     "#7C3AED")}
      ${_kpi("cli-k-segs",   "SEGMENTOS",      "#D97706")}
      ${_kpi("cli-k-abc-a",  "CATEGORÍA A",    "#B45309")}
    </div>

    <!-- Barra de controles -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
      padding:12px 16px;margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      box-shadow:0 1px 3px rgba(0,0,0,.06)">

      <!-- Búsqueda -->
      <div style="position:relative;flex:1;min-width:180px">
        <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);
          font-size:13px;color:#9CA3AF;pointer-events:none">🔍</span>
        <input id="cli-search" type="text" placeholder="Buscar nombre, teléfono, dirección…"
          oninput="ClientesUI.buscar(this.value)"
          class="form-input" style="padding-left:30px">
      </div>

      <!-- Segmento -->
      <select id="cli-sel-seg" onchange="ClientesUI.setSegmento(this.value)"
        class="form-input" style="width:auto">
        <option value="TODOS">Todos los segmentos</option>
      </select>

      <!-- Ingeniero -->
      <select id="cli-sel-ing" onchange="ClientesUI.setIngeniero(this.value)"
        class="form-input" style="width:auto">
        <option value="TODOS">Todos los ingenieros</option>
      </select>

      <!-- Estado -->
      <select id="cli-sel-estado" onchange="ClientesUI.setEstado(this.value)"
        class="form-input" style="width:auto">
        <option value="TODOS">Activos e inactivos</option>
        <option value="activos">Solo activos</option>
        <option value="inactivos">Solo inactivos</option>
      </select>

      <!-- Saldo -->
      <select id="cli-sel-saldo" onchange="ClientesUI.setSaldo(this.value)"
        class="form-input" style="width:auto">
        <option value="TODOS">Con y sin saldo</option>
        <option value="con_saldo">Con saldo pendiente</option>
        <option value="sin_saldo">Sin saldo</option>
      </select>

      <!-- Columnas -->
      <button onclick="ClientesUI.abrirConfigCols()"
        title="Configurar columnas visibles"
        style="padding:7px 11px;background:transparent;color:var(--text-sec);
          border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">
        ⚙ Columnas
      </button>

      <!-- ABC -->
      <button onclick="ClientesUI.recalcularABC()"
        title="Clasificar clientes A/B/C por volumen de compra (A=top, C=bajo)"
        style="padding:7px 11px;background:transparent;color:var(--text-sec);
          border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">
        🏅 Clasificar A/B/C
      </button>

      <!-- Exportar -->
      <button onclick="ClientesUI.exportar()"
        title="Exportar lista a Excel"
        style="padding:7px 11px;background:transparent;color:var(--text-sec);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">⬇️ Excel</button>

      <!-- Importar -->
      <button onclick="ClientesUI.importarExcel()"
        title="Importar clientes desde Excel"
        style="padding:7px 11px;background:transparent;color:var(--text-sec);border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap">⬆️ Importar</button>
      <input id="cli-file-input" type="file" accept=".xlsx" style="display:none"
        onchange="ClientesUI._onFileSelected(this)">

      <!-- Contador -->
      <span id="cli-count-txt"
        style="font-size:11px;color:#6B7280;white-space:nowrap;margin-left:auto"></span>

      <!-- Nuevo cliente (acción primaria) -->
      <button onclick="ClientesUI.nuevoCliente()" class="btn-primary" style="white-space:nowrap;flex-shrink:0">
        + Cliente
      </button>
    </div>

    <!-- Tabla con doble scroll (arriba y abajo) + header fijo -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
      overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <!-- Scrollbar fantasma superior -->
      <div id="cli-scroll-top" style="overflow-x:auto;overflow-y:hidden;height:10px;border-bottom:1px solid var(--border)">
        <div id="cli-scroll-phantom" style="height:1px"></div>
      </div>
      <div id="cli-scroll-outer" style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 330px)">
        <table class="erp-table" id="cli-table">
          <thead>
            <tr style="background:var(--surface-2);border-bottom:2px solid var(--border)">
              <th id="cli-th-clienteId" style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec);white-space:nowrap;position:sticky;top:0;background:var(--surface-2);z-index:2">ID</th>
              <th id="cli-th-nombre"    onclick="ClientesUI.sortBy('nombre')" style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec);white-space:nowrap;position:sticky;top:0;background:var(--surface-2);z-index:2;cursor:pointer;user-select:none" title="Ordenar por nombre">CLIENTE <span id="cli-sort-nombre" style="font-size:10px;opacity:.5"></span></th>
              <th id="cli-th-segmento"  onclick="ClientesUI.sortBy('segmento')" style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec);white-space:nowrap;position:sticky;top:0;background:var(--surface-2);z-index:2;cursor:pointer;user-select:none" title="Ordenar por segmento">SEGMENTO <span id="cli-sort-segmento" style="font-size:10px;opacity:.5"></span></th>
              <th id="cli-th-ingeniero" onclick="ClientesUI.sortBy('ingeniero')" style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec);white-space:nowrap;position:sticky;top:0;background:var(--surface-2);z-index:2;cursor:pointer;user-select:none" title="Ordenar por ingeniero">INGENIERO <span id="cli-sort-ingeniero" style="font-size:10px;opacity:.5"></span></th>
              <th id="cli-th-zona"      onclick="ClientesUI.sortBy('zona')" style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec);white-space:nowrap;position:sticky;top:0;background:var(--surface-2);z-index:2;cursor:pointer;user-select:none" title="Ordenar por zona">ZONA <span id="cli-sort-zona" style="font-size:10px;opacity:.5"></span></th>
              <th id="cli-th-saldo"     onclick="ClientesUI.sortBy('saldo')" style="padding:10px 14px;text-align:right;font-weight:700;color:var(--text-sec);white-space:nowrap;position:sticky;top:0;background:var(--surface-2);z-index:2;cursor:pointer;user-select:none" title="Ordenar por saldo">SALDO <span id="cli-sort-saldo" style="font-size:10px;opacity:.5"></span></th>
              <th id="cli-th-visita"    onclick="ClientesUI.sortBy('ultimaVisita')" style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-sec);white-space:nowrap;position:sticky;top:0;background:var(--surface-2);z-index:2;cursor:pointer;user-select:none" title="Ordenar por última visita">ÚLTIMA VISITA <span id="cli-sort-ultimaVisita" style="font-size:10px;opacity:.5"></span></th>
              <th id="cli-th-estado"    style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-sec);white-space:nowrap;position:sticky;top:0;background:var(--surface-2);z-index:2">ESTADO</th>
              <th id="cli-th-acciones"  style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-sec);position:sticky;top:0;background:var(--surface-2);z-index:2"></th>
            </tr>
          </thead>
          <tbody id="cli-tbody">
            <tr><td colspan="9" style="padding:32px;text-align:center;color:#9CA3AF">Cargando clientes…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ── Modal configuración de columnas ── -->
  <div id="cli-modal-cols" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);
    z-index:1002;align-items:center;justify-content:center;padding:20px">
    <div style="background:var(--surface);border-radius:14px;width:360px;max-width:100%;
      border:1px solid var(--border);padding:24px;max-height:90vh;overflow-y:auto">
      <div style="font-size:14px;font-weight:800;color:var(--text-primary);margin-bottom:4px">Configurar columnas</div>
      <div style="font-size:11px;color:#9CA3AF;margin-bottom:16px">Arrastra para reordenar · desmarca para ocultar</div>
      <ul id="cli-cols-list" style="list-style:none;padding:0;margin:0 0 18px;display:flex;flex-direction:column;gap:6px"></ul>
      <div style="display:flex;gap:8px;justify-content:space-between">
        <button onclick="ClientesUI.resetCols()" class="btn-secondary">Restablecer</button>
        <div style="display:flex;gap:8px">
          <button onclick="ClientesUI.cerrarConfigCols()" class="btn-secondary">Cancelar</button>
          <button onclick="ClientesUI.guardarCols()" class="btn-primary">Guardar</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Modal ubicación con Google Maps ── -->
  <div id="cli-ubic-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);
    z-index:1004;align-items:center;justify-content:center;padding:16px">
    <div style="background:var(--surface);border-radius:14px;width:680px;max-width:100%;
      max-height:92vh;overflow-y:auto;border:1px solid var(--border);padding:24px">

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
        <span id="cli-ubic-titulo" style="font-size:15px;font-weight:800;color:var(--text-primary)">Nueva ubicación</span>
        <button onclick="ClientesUI.cerrarUbicacion()"
          aria-label="Cerrar"
          style="border:none;background:transparent;font-size:20px;cursor:pointer;color:#9CA3AF">✕</button>
      </div>

      <!-- Mapa -->
      <div id="cli-ubic-map" style="width:100%;height:320px;border-radius:10px;
        border:1px solid var(--border);overflow:hidden;margin-bottom:14px;
        background:#1a1a2e;display:flex;align-items:center;justify-content:center;color:#6B7280">
        Cargando mapa…
      </div>
      <p style="font-size:11px;color:#6B7280;margin:0 0 14px">
        Haz clic en el mapa o arrastra el marcador para fijar la posición exacta.
      </p>

      <!-- Campos -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Tipo *</label>
          <select id="cli-ubic-tipo"
            class="form-input">
            <option value="parcela">🌾 Parcela / Campo</option>
            <option value="domicilio">🏠 Domicilio</option>
            <option value="invernadero">🏗 Invernadero</option>
            <option value="otro">📌 Otro</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Etiqueta</label>
          <input id="cli-ubic-etiqueta" type="text" placeholder="Ej. Campo norte, Domicilio principal…"
            class="form-input">
        </div>
      </div>
      <div style="margin-bottom:10px">
        <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Ingeniero responsable de esta ubicación</label>
        <select id="cli-ubic-zona" class="form-input">
          <option value="">— Sin asignar —</option>
        </select>
      </div>

      <!-- Flag cliente compartido -->
      <div id="cli-ubic-compartido-wrap" style="border:1px solid var(--border);border-radius:8px;
        padding:10px 12px;background:var(--surface-2);margin-bottom:10px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:0">
          <input type="checkbox" id="cli-ubic-compartido" style="width:15px;height:15px;cursor:pointer"
            onchange="document.getElementById('cli-ubic-ings-extra-wrap').style.display=this.checked?'':'none'">
          <span style="font-size:11px;font-weight:600;color:var(--text-primary)">
            Este cliente opera en zonas de más de un ingeniero
          </span>
        </label>
        <div id="cli-ubic-ings-extra-wrap" style="display:none;margin-top:8px">
          <div style="font-size:10px;font-weight:600;color:#6B7280;margin-bottom:5px">
            Ingenieros adicionales con acceso a este cliente:
          </div>
          <div id="cli-ubic-ings-extra-list" style="display:flex;flex-wrap:wrap;gap:5px"></div>
        </div>
      </div>

      <div style="margin-bottom:10px">
        <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Dirección (se completa automáticamente)</label>
        <input id="cli-ubic-dir" type="text" readonly class="form-input" style="opacity:.8">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div>
          <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Latitud</label>
          <input id="cli-ubic-lat" type="text" readonly class="form-input" style="font-family:monospace;opacity:.8">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Longitud</label>
          <input id="cli-ubic-lng" type="text" readonly class="form-input" style="font-family:monospace;opacity:.8">
        </div>
      </div>

      <div id="cli-ubic-err" style="display:none;background:#FEE2E2;border-radius:6px;
        padding:8px 12px;font-size:11.5px;color:#DC2626;margin-bottom:12px"></div>

      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button onclick="ClientesUI.cerrarUbicacion()" class="btn-secondary">Cancelar</button>
        <button id="cli-ubic-btn-guardar" onclick="ClientesUI.guardarUbicacion()" class="btn-primary">
          Guardar ubicación
        </button>
      </div>
    </div>
  </div>

  <!-- ── Modal fotos del cliente (APK) ── -->
  <div id="cli-fotos-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);
    z-index:1003;align-items:center;justify-content:center;padding:20px">
    <div style="background:var(--surface);border-radius:14px;width:700px;max-width:100%;
      border:1px solid var(--border);box-shadow:0 8px 32px rgba(0,0,0,.3);padding:24px;max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div>
          <div id="cli-fotos-title" style="font-size:15px;font-weight:800;color:var(--text-primary)">📷 Fotos del cliente</div>
          <div id="cli-fotos-sub" style="font-size:11px;color:var(--text-sec);margin-top:2px"></div>
        </div>
        <button onclick="ClientesUI.cerrarFotos()"
          aria-label="Cerrar"
          style="border:none;background:transparent;font-size:20px;cursor:pointer;color:#9CA3AF">✕</button>
      </div>
      <div id="cli-fotos-body"></div>
    </div>
  </div>

  <!-- ── Modal Nuevo/Editar Cliente ── -->
  <div id="cli-form-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);
    z-index:1001;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto">
    <div style="background:var(--surface);border-radius:16px;width:620px;max-width:100%;
      border:1px solid var(--border);box-shadow:0 8px 32px rgba(0,0,0,.22);margin:auto">
      <div id="cli-form-body" style="padding:24px"></div>
    </div>
  </div>

  <!-- ── Modal detalle ── -->
  <div id="cli-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);
    z-index:1000;align-items:center;justify-content:center;padding:16px">
    <div style="background:var(--surface);border-radius:16px;width:520px;max-width:100%;
      max-height:90vh;overflow-y:auto;border:1px solid var(--border);
      box-shadow:0 8px 32px rgba(0,0,0,.18)">
      <div id="cli-modal-body" style="padding:24px"></div>
    </div>
  </div>`;
}

function _kpi(id, label, color = "var(--text-primary)") {
  return `<div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
    padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.06)">
    <div style="font-size:20px;font-weight:800;color:${color};font-variant-numeric:tabular-nums" id="${id}">–</div>
    <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-top:2px">${label}</div>
  </div>`;
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI() {
  window.ClientesUI = {
    buscar(v)      { _fBusqueda = norm(v); _applyFilters(); },
    setSegmento(v) { _fSegmento = v; _applyFilters(); },
    setIngeniero(v){ _fIngeniero = v; _applyFilters(); },
    setEstado(v)   { _fEstado = v; _applyFilters(); },
    setSaldo(v)    { _fSaldo = v; _applyFilters(); },
    sortBy(col) {
      if (_sortCol === col) _sortDir *= -1;
      else { _sortCol = col; _sortDir = 1; }
      // Actualizar indicadores
      ["nombre","segmento","ingeniero","zona","saldo","ultimaVisita"].forEach(k => {
        const el = document.getElementById("cli-sort-" + k);
        if (el) el.textContent = _sortCol === k ? (_sortDir === 1 ? "▲" : "▼") : "";
      });
      _applyFilters();
    },

    exportar() {
      if (!_filtrados.length) { window.toast?.("No hay clientes para exportar.", "info"); return; }
      exportarExcel(_filtrados, _COLS, "Clientes", "Clientes");
    },

    abrirDetalle(id) { _abrirDetalle(id); },
    abrirEdicion(id) { _abrirFormCliente(id); },

    async _selGeoResult(placeId, desc) {
      document.getElementById("clf-geobus").value = desc;
      document.getElementById("clf-geobus-results").style.display = "none";
      try {
        if (!window.google?.maps?.places) await _loadGMaps();
        const svc = new google.maps.places.PlacesService(document.createElement("div"));
        svc.getDetails({ placeId, fields: ["geometry","formatted_address","address_components"] }, (place, st) => {
          if (st !== "OK" || !place?.geometry?.location) return;
          const lat = place.geometry.location.lat();
          const lng = place.geometry.location.lng();
          const elLat = document.getElementById("clf-lat");
          const elLng = document.getElementById("clf-lng");
          if (elLat) elLat.value = lat.toFixed(7);
          if (elLng) elLng.value = lng.toFixed(7);
          // Rellenar campos de dirección si están vacíos
          const comps = place.address_components || [];
          const get = t => comps.find(c => c.types.includes(t))?.long_name || "";
          const elCalle = document.getElementById("clf-calle");
          const elCol   = document.getElementById("clf-colonia");
          const elCiud  = document.getElementById("clf-ciudad");
          const elEdo   = document.getElementById("clf-estado");
          const elCp    = document.getElementById("clf-cp");
          if (elCalle && !elCalle.value) elCalle.value = [get("route"), get("street_number")].filter(Boolean).join(" ");
          if (elCol && !elCol.value)   elCol.value   = get("sublocality_level_1") || get("locality");
          if (elCiud && !elCiud.value) elCiud.value  = get("locality") || get("administrative_area_level_2");
          if (elEdo && !elEdo.value)   elEdo.value   = get("administrative_area_level_1");
          if (elCp && !elCp.value)     elCp.value    = get("postal_code");
          window.toast?.("Ubicación encontrada y coordenadas aplicadas.", "success");
        });
      } catch(e) { window.toast?.("Error buscando ubicación.", "error"); }
    },

    geolocalizarCliente() {
      if (!navigator.geolocation) { window.toast?.("GPS no disponible.", "error"); return; }
      navigator.geolocation.getCurrentPosition(pos => {
        const lat = pos.coords.latitude, lng = pos.coords.longitude;
        const elLat = document.getElementById("clf-lat");
        const elLng = document.getElementById("clf-lng");
        if (elLat) elLat.value = lat.toFixed(7);
        if (elLng) elLng.value = lng.toFixed(7);
        window.toast?.("Coordenadas de tu ubicación actual aplicadas.", "success");
      }, () => window.toast?.("No se pudo obtener la ubicación GPS.", "error"));
    },

    cerrarDetalle() {
      document.getElementById("cli-modal").style.display = "none";
      document.body.style.overflow = "";
      _closeTrap("cli-modal");
      _detalleId = null;
    },

    async guardarNota() {
      const nota = document.getElementById("cli-det-nota")?.value?.trim() ?? "";
      if (!_detalleId) return;
      const btn = document.getElementById("cli-det-guardar");
      if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }
      try {
        await updateDoc(doc(db, "clientes", _detalleId), {
          notaWeb: nota,
          notaWebActualizado: serverTimestamp(),
          notaWebPor: window.Sesion?.alias ?? "web"
        });
        window.toast?.("Nota guardada.", "success");
        document.getElementById("cli-modal").style.display = "none";
        _detalleId = null;
      } catch(e) {
        window.toast?.("Error al guardar nota: " + e.message, "error");
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Guardar nota"; }
      }
    },
    abrirConfigCols() {
      const list = document.getElementById("cli-cols-list");
      if (!list) return;
      const ordered = [
        ..._colsVisibles,
        ...CLI_ALL_COLS.map(c => c.key).filter(k => !_colsVisibles.includes(k))
      ];
      list.innerHTML = ordered.map(key => {
        const meta = CLI_ALL_COLS.find(c => c.key === key);
        if (!meta) return "";
        const visible = _colsVisibles.includes(key);
        return `<li data-col="${key}" draggable="${!meta.locked}"
          style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;
            border:1px solid var(--border);background:var(--surface);cursor:${meta.locked?"default":"grab"};
            user-select:none;transition:opacity .15s;${!visible?"opacity:.45":""}">
          <span style="font-size:14px;color:#9CA3AF">${meta.locked ? "⊝" : "⠿"}</span>
          <span style="flex:1;font-size:12px;font-weight:600;color:var(--text-primary)">${meta.label||"—"}</span>
          <input type="checkbox" ${visible?"checked":""} ${meta.locked?"disabled":""} style="cursor:pointer;width:16px;height:16px">
        </li>`;
      }).join("");
      // Drag & drop — pointer events (funciona en táctil y mouse)
      let _dragSrc = null;
      const _liOpacity = li => li.querySelector("input")?.checked !== false ? "1" : ".45";
      list.addEventListener("pointerdown", e => {
        const li = e.target.closest("li[draggable='true']");
        if (!li || e.target.tagName === "INPUT") return;
        e.preventDefault();
        _dragSrc = li;
        list.setPointerCapture(e.pointerId);
        li.style.opacity = ".35";
        li.style.boxShadow = "0 4px 14px rgba(0,0,0,.18)";
      }, { passive: false });
      list.addEventListener("pointermove", e => {
        if (!_dragSrc) return;
        e.preventDefault();
        const all = [...list.querySelectorAll("li")];
        const over = all.find(li => {
          if (li === _dragSrc) return false;
          const r = li.getBoundingClientRect();
          return e.clientY >= r.top && e.clientY <= r.bottom;
        });
        if (over) {
          const fi = all.indexOf(_dragSrc), ti = all.indexOf(over);
          if (fi < ti) list.insertBefore(_dragSrc, over.nextSibling);
          else         list.insertBefore(_dragSrc, over);
        }
      }, { passive: false });
      const _endDrag = () => {
        if (!_dragSrc) return;
        _dragSrc.style.opacity = _liOpacity(_dragSrc);
        _dragSrc.style.boxShadow = "";
        _dragSrc = null;
      };
      list.addEventListener("pointerup",     _endDrag);
      list.addEventListener("pointercancel", _endDrag);
      list.querySelectorAll("li").forEach(li => {
        li.querySelector("input")?.addEventListener("change", function() {
          li.style.opacity = this.checked ? "1" : ".45";
        });
      });
      document.getElementById("cli-modal-cols").style.display = "flex";
      document.body.style.overflow = "hidden";
      _openTrap("cli-modal-cols", () => window.ClientesUI.cerrarConfigCols());
    },
    cerrarConfigCols() {
      document.getElementById("cli-modal-cols").style.display = "none";
      document.body.style.overflow = "";
      _closeTrap("cli-modal-cols");
    },
    guardarCols() {
      const list = document.getElementById("cli-cols-list");
      if (!list) return;
      _colsVisibles = [...list.querySelectorAll("li")].filter(li => {
        const meta = CLI_ALL_COLS.find(c => c.key === li.dataset.col);
        return meta?.locked || li.querySelector("input")?.checked;
      }).map(li => li.dataset.col);
      _saveColPrefs(_colsVisibles);
      _aplicarColPrefs();
      document.getElementById("cli-modal-cols").style.display = "none";
    },
    resetCols() {
      _colsVisibles = CLI_ALL_COLS.map(c => c.key);
      _saveColPrefs(_colsVisibles);
      _aplicarColPrefs();
      document.getElementById("cli-modal-cols").style.display = "none";
    },
    verFotos(clienteId, nombre) { _verFotosCliente(clienteId, nombre); },
    cerrarFotos() { document.getElementById("cli-fotos-modal").style.display = "none"; document.body.style.overflow = ""; _closeTrap("cli-fotos-modal"); },
    abrirUbicacion(clienteDocId, ubicId) { _abrirModalUbicacion(clienteDocId, ubicId || null); },
    cerrarUbicacion() { document.getElementById("cli-ubic-modal").style.display = "none"; document.body.style.overflow = ""; _closeTrap("cli-ubic-modal"); },
    guardarUbicacion() { _guardarUbicacion(); },
    navegarUbicacion(lat, lng) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, "_blank");
    },
    async eliminarUbicacion(clienteDocId, ubicId) {
      if (!await window.modal?.({ title:"Eliminar ubicación", message:"¿Confirmas eliminar esta ubicación? Esta acción no puede deshacerse." })) return;
      try {
        const { doc: d2, deleteDoc } =
          await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        await deleteDoc(d2(db, "clientes", clienteDocId, "ubicaciones", ubicId));
        window.toast?.("Ubicación eliminada.", "success");
        _cargarUbicaciones(clienteDocId);
      } catch(e) { window.toast?.("Error: " + e.message, "error"); }
    },
    importarExcel() {
      document.getElementById("cli-file-input")?.click();
    },
    _onFileSelected(input) {
      const file = input.files?.[0];
      if (file) { _importarExcel(file); input.value = ""; }
    },
    nuevoCliente() { _abrirFormCliente(null); },
    recalcularABC() { _abcCargado = false; _calcularABC(); },
    nuevaVisita(clienteId) { _abrirFormVisita(clienteId); },
    cerrarFormCliente() {
      const m = document.getElementById("cli-form-modal");
      if (m) m.style.display = "none";
      document.body.style.overflow = "";
      _closeTrap("cli-form-modal");
      _geoBuscadorAbort?.abort();
      _geoBuscadorAbort = null;
    },
    _guardarFormCliente(clienteId) { return _guardarFormCliente(clienteId); }
  };

  // Sincronización de doble scroll (top ↔ bottom)
  const scrollTop   = document.getElementById("cli-scroll-top");
  const scrollOuter = document.getElementById("cli-scroll-outer");
  const phantom     = document.getElementById("cli-scroll-phantom");
  if (scrollTop && scrollOuter && phantom) {
    // Ajustar ancho del phantom al renderizar la tabla
    const syncPhantom = () => {
      const table = document.getElementById("cli-table");
      if (table) phantom.style.width = table.offsetWidth + "px";
    };
    scrollOuter.addEventListener("scroll", () => { scrollTop.scrollLeft = scrollOuter.scrollLeft; syncPhantom(); });
    scrollTop.addEventListener("scroll",   () => { scrollOuter.scrollLeft = scrollTop.scrollLeft; });
    setTimeout(syncPhantom, 300);
  }

  // Aplicar preferencias guardadas
  _colsVisibles = _loadColPrefs();
  _aplicarColPrefs();

  // Cerrar modal cols al hacer clic en fondo
  document.getElementById("cli-modal-cols")?.addEventListener("click", e => {
    if (e.target.id === "cli-modal-cols") window.ClientesUI.cerrarConfigCols();
  });
  document.getElementById("cli-fotos-modal")?.addEventListener("click", e => {
    if (e.target.id === "cli-fotos-modal") window.ClientesUI.cerrarFotos();
  });
  document.getElementById("cli-ubic-modal")?.addEventListener("click", e => {
    if (e.target.id === "cli-ubic-modal") window.ClientesUI.cerrarUbicacion();
  });

  // Cerrar modal al hacer clic en fondo
  document.getElementById("cli-modal")?.addEventListener("click", e => {
    if (e.target.id === "cli-modal") window.ClientesUI.cerrarDetalle();
  });
  document.getElementById("cli-form-modal")?.addEventListener("click", e => {
    if (e.target.id === "cli-form-modal") window.ClientesUI.cerrarFormCliente();
  });
}

// ── Firestore listener ────────────────────────────────────────
function _escuchar() {
  // Cargar cache blacklist primero; cuando termine re-renderiza si ya hay datos
  cargarCacheBlacklist().then(() => { if (_clientes.length) _applyFilters(); });
  _unsub = onSnapshot(
    query(collection(db, "clientes"), orderBy("nombre")),
    snap => {
      _clientes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _poblarFiltros();
      _applyFilters();
    },
    err => {
      console.error("[Clientes]", err);
      window.toast?.("Error al cargar clientes: " + err.message, "error");
    }
  );
}

// ── Poblar selects de segmento e ingeniero ────────────────────
function _poblarFiltros() {
  const segmentos  = [...new Set(_clientes.map(c => c.segmento).filter(Boolean))].sort();
  const ingenieros = [...new Set(_clientes.map(c => c.ingeniero).filter(Boolean))].sort();

  const selSeg = document.getElementById("cli-sel-seg");
  if (selSeg) {
    const val = selSeg.value;
    selSeg.innerHTML = `<option value="TODOS">Todos los segmentos</option>` +
      segmentos.map(s => `<option value="${esc(s)}" ${val===s?"selected":""}>${esc(s)}</option>`).join("");
  }

  const selIng = document.getElementById("cli-sel-ing");
  if (selIng) {
    const val = selIng.value;
    selIng.innerHTML = `<option value="TODOS">Todos los ingenieros</option>` +
      ingenieros.map(i => `<option value="${esc(i)}" ${val===i?"selected":""}>${esc(i)}</option>`).join("");
  }
}

// ── Aplicar filtros y renderizar ──────────────────────────────
function _applyFilters() {
  let lista = [..._clientes];

  if (_fEstado === "activos")   lista = lista.filter(c => c.activo !== false);
  if (_fEstado === "inactivos") lista = lista.filter(c => c.activo === false);

  if (_fSegmento  !== "TODOS") lista = lista.filter(c => c.segmento  === _fSegmento);
  if (_fIngeniero !== "TODOS") lista = lista.filter(c => c.ingeniero === _fIngeniero);

  if (_fSaldo === "con_saldo") lista = lista.filter(c => _saldoCliente(c) > 0);
  if (_fSaldo === "sin_saldo") lista = lista.filter(c => _saldoCliente(c) === 0);

  if (_fBusqueda) {
    lista = lista.filter(c =>
      norm(c.nombre).includes(_fBusqueda) ||
      norm(c.clienteId).includes(_fBusqueda) ||
      norm(c.telefono).includes(_fBusqueda) ||
      norm(c.direccion).includes(_fBusqueda) ||
      norm(c.colonia).includes(_fBusqueda) ||
      norm(c.ciudad).includes(_fBusqueda) ||
      norm(c.ingeniero).includes(_fBusqueda)
    );
  }

  if (_sortCol) {
    lista.sort((a, b) => {
      let va, vb;
      if (_sortCol === "saldo") { va = _saldoCliente(a); vb = _saldoCliente(b); }
      else if (_sortCol === "ultimaVisita") { va = a.fechaUltimaVisita || 0; vb = b.fechaUltimaVisita || 0; }
      else { va = norm(a[_sortCol] ?? ""); vb = norm(b[_sortCol] ?? ""); }
      return va < vb ? -_sortDir : va > vb ? _sortDir : 0;
    });
  }

  _filtrados = lista;
  _renderKPIs();
  _renderTabla();
}

// ── KPIs ──────────────────────────────────────────────────────
function _renderKPIs() {
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const set = el => v => { const e = document.getElementById(el); if (e) e.textContent = v; };

  set("cli-k-total")(_clientes.length.toLocaleString("es-MX"));
  set("cli-k-activos")(_clientes.filter(c => c.activo !== false).length.toLocaleString("es-MX"));

  const saldoTotal = _filtrados.reduce((s, c) => s + _saldoCliente(c), 0);
  set("cli-k-saldo")(saldoTotal > 0 ? fmt.format(saldoTotal) : "$0.00");

  const visitasHoy = _filtrados.filter(c => {
    const v = c.fechaUltimaVisita || c.ultimaVisita;
    if (!v) return false;
    try {
      const d = typeof v === "number" ? new Date(v) : new Date(v?.toDate?.() ?? v);
      d.setHours(0,0,0,0);
      return d.getTime() === hoy.getTime();
    } catch { return false; }
  }).length;
  set("cli-k-visita")(visitasHoy.toLocaleString("es-MX"));

  const segs = new Set(_clientes.map(c => c.segmento).filter(Boolean)).size;
  set("cli-k-segs")(segs.toLocaleString("es-MX"));

  const abcA = Object.values(_abcMap).filter(v => v === "A").length;
  set("cli-k-abc-a")(abcA > 0 ? abcA.toLocaleString("es-MX") : "–");
  if (!_abcCargado) _calcularABC();

  const cnt = document.getElementById("cli-count-txt");
  if (cnt) cnt.textContent = `${_filtrados.length} de ${_clientes.length} clientes`;
}

// ── Tabla ─────────────────────────────────────────────────────
function _renderTabla() {
  const tbody = document.getElementById("cli-tbody");
  if (!tbody) return;

  if (!_filtrados.length) {
    tbody.innerHTML = `<tr><td colspan="9"
      style="padding:32px;text-align:center;color:#9CA3AF;font-size:13px">
      Sin clientes para los filtros seleccionados.</td></tr>`;
    return;
  }

  tbody.innerHTML = _filtrados.map((c, i) => {
    const saldo   = _saldoCliente(c);
    const activo  = c.activo !== false;
    const limite  = Number(c.limiteCredito) || 0;
    const abcLetra = _abcMap[c.id] || "";

    const saldoColor = saldo > 0 ? "#DC2626" : "#16A34A";
    const saldoTxt   = saldo > 0 ? fmt.format(saldo) : "—";
    const creditoPct = limite > 0 ? Math.min(100, Math.round(saldo / limite * 100)) : 0;
    const creditoCol = creditoPct >= 90 ? "#DC2626" : creditoPct >= 70 ? "#D97706" : "#16A34A";
    const abcBadge  = abcLetra
      ? `<span style="font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;
          background:${abcLetra==="A"?"#FEF3C7":abcLetra==="B"?"#DBEAFE":"#F1F5F9"};
          color:${abcLetra==="A"?"#B45309":abcLetra==="B"?"#1D4ED8":"#64748B"};
          margin-left:4px;vertical-align:middle">${abcLetra}</span>` : "";

    const segBg = _segColor(c.segmento);

    return `<tr style="border-bottom:1px solid var(--border);
      ${i % 2 === 1 ? "background:var(--surface-2);" : ""}
      ${saldo > 0 ? "border-left:3px solid #DC2626;" : "border-left:3px solid transparent;"}
      cursor:pointer;transition:filter .1s" onclick="ClientesUI.abrirDetalle('${esc(c.id)}')">
      <td style="padding:10px 14px;font-size:11px;font-family:monospace;color:#6B7280;white-space:nowrap">
        ${esc(c.clienteId || "—")}
      </td>
      <td style="padding:10px 14px">
        <div style="font-weight:700;font-size:12px;color:var(--text-primary)">
          ${esc(c.nombre || "—")}${abcBadge}
          ${clienteEnBlacklist(c.id, c.nombre) ? `<span title="Cliente en lista negra" style="margin-left:4px;background:#FEE2E2;color:#DC2626;font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;border:1px solid #FECACA;vertical-align:middle">🚫 BLACKLIST</span>` : ""}
        </div>
        ${c.telefono ? `<div style="font-size:11px;color:#6B7280">${esc(c.telefono)}</div>` : ""}
        ${c.ciudad || c.colonia ? `<div style="font-size:10px;color:#9CA3AF">${esc([c.colonia,c.ciudad].filter(Boolean).join(", "))}</div>` : ""}
      </td>
      <td style="padding:10px 14px">
        ${c.segmento
          ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;
              background:${segBg}22;color:${segBg}">${esc(c.segmento)}</span>`
          : `<span style="color:#D1D5DB;font-size:11px">—</span>`}
      </td>
      <td style="padding:10px 14px;font-size:12px;color:var(--text-sec)">${esc(c.ingeniero || "—")}</td>
      <td style="padding:10px 14px;font-size:11px;color:#6B7280">${esc(c.zona || "—")}</td>
      <td style="padding:10px 14px;text-align:right;font-size:12px;font-weight:700;color:${saldoColor}">
        ${saldoTxt}
        ${limite > 0 ? `<div style="margin-top:3px;height:4px;border-radius:2px;background:var(--border);width:60px;margin-left:auto">
          <div style="height:4px;border-radius:2px;background:${creditoCol};width:${creditoPct}%;max-width:100%"></div>
        </div>
        <div style="font-size:9px;color:${creditoCol};margin-top:1px;font-weight:600">${creditoPct}% crédito</div>` : ""}
      </td>
      <td style="padding:10px 14px;text-align:center;font-size:11px;color:#6B7280">${fmtDt(c.fechaUltimaVisita || c.ultimaVisita)}</td>
      <td style="padding:10px 14px;text-align:center">
        <span style="font-size:10px;font-weight:700;padding:2px 9px;border-radius:9px;
          background:${activo?"#DCFCE7":"#F3F4F6"};color:${activo?"#16A34A":"#9CA3AF"}">
          ${activo ? "Activo" : "Inactivo"}
        </span>
      </td>
      <td style="padding:10px 14px;text-align:center">
        <span style="font-size:16px">›</span>
      </td>
    </tr>`;
  }).join("");
  // Reaplicar visibilidad de columnas tras renderizar
  _aplicarColPrefs();
}

// ── Colores de segmento ───────────────────────────────────────
const _SEG_COLORS = ["#1565C0","#15803D","#7E22CE","#B45309","#0E7490","#BE123C","#475569"];
const _segCache = {};
let _segIdx = 0;
function _segColor(seg) {
  if (!seg) return "#9CA3AF";
  if (!_segCache[seg]) _segCache[seg] = _SEG_COLORS[_segIdx++ % _SEG_COLORS.length];
  return _segCache[seg];
}

// ── Detalle de cliente ────────────────────────────────────────
async function _abrirDetalle(id) {
  _detalleId = id;
  const modal = document.getElementById("cli-modal");
  const body  = document.getElementById("cli-modal-body");
  if (!modal || !body) return;

  body.innerHTML = `<div style="padding:20px;text-align:center;color:#9CA3AF">Cargando…</div>`;
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
  _openTrap("cli-modal", () => window.ClientesUI.cerrarDetalle());

  // Buscar en caché local primero
  let c = _clientes.find(x => x.id === id);
  if (!c) {
    try {
      const snap = await getDoc(doc(db, "clientes", id));
      if (!snap.exists()) { body.innerHTML = `<p style="color:#DC2626">Cliente no encontrado.</p>`; return; }
      c = { id: snap.id, ...snap.data() };
    } catch(e) {
      body.innerHTML = `<p style="color:#DC2626">Error al cargar: ${esc(e.message)}</p>`;
      return;
    }
  }

  const saldo  = _saldoCliente(c);
  const activo = c.activo !== false;
  const segCol = _segColor(c.segmento);

  const _blEntry = clienteEnBlacklist(c.id, c.nombre);
  const _blNiveles = { ALTO:"#DC2626", MEDIO:"#D97706", BAJO:"#16A34A" };
  const _blColor = _blEntry ? (_blNiveles[_blEntry.nivelRiesgo] || "#DC2626") : null;

  body.innerHTML = `
    ${_blEntry ? `
    <div style="background:${_blColor}10;border:2px solid ${_blColor};border-radius:10px;padding:14px 18px;margin-bottom:18px;display:flex;align-items:flex-start;gap:12px">
      <span style="font-size:22px;flex-shrink:0">🚫</span>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:800;color:${_blColor};margin-bottom:3px">
          CLIENTE EN LISTA NEGRA — RIESGO ${esc(_blEntry.nivelRiesgo||"ALTO")} · ${esc(_blEntry.categoria||"")}
        </div>
        <div style="font-size:12px;color:var(--text-pri);line-height:1.5">
          ${esc((_blEntry.descripcion||"").slice(0, 200))}${(_blEntry.descripcion||"").length > 200 ? "…" : ""}
        </div>
        ${_blEntry.montoAdeudo > 0 ? `<div style="margin-top:4px;font-size:12px;font-weight:700;color:${_blColor}">
          Adeudo: ${Number(_blEntry.montoAdeudo).toLocaleString("es-MX",{style:"currency",currency:"MXN"})}
        </div>` : ""}
        <div style="margin-top:6px">
          <a onclick="navigate('blacklist')" href="#" style="font-size:11px;color:${_blColor};font-weight:700;text-decoration:underline">
            Ver expediente completo →
          </a>
        </div>
      </div>
    </div>` : ""}
    <!-- Header -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:14px">
        <div style="width:48px;height:48px;border-radius:50%;background:${segCol}22;
          display:flex;align-items:center;justify-content:center;
          font-size:20px;font-weight:800;color:${segCol}">
          ${esc((c.nombre || "?").charAt(0).toUpperCase())}
        </div>
        <div>
          <div style="font-size:16px;font-weight:800;color:var(--text-primary)">${esc(c.nombre || "—")}</div>
          <div style="font-size:12px;color:#6B7280;margin-top:2px">
            ${c.clienteId ? `<span style="font-family:monospace;font-weight:700;color:var(--text-sec)">${esc(c.clienteId)}</span> · ` : ""}
            ${c.segmento ? `<span style="font-weight:600;color:${segCol}">${esc(c.segmento)}</span> · ` : ""}
            <span style="font-weight:600;color:${activo?"#16A34A":"#9CA3AF"}">${activo?"Activo":"Inactivo"}</span>
          </div>
          ${c.compartido && c.ingenierosCompartidos?.length ? `
          <div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap">
            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;
              background:rgba(37,99,235,0.15);color:var(--blue,#2563EB);border:1px solid rgba(37,99,235,0.3)">🔗 COMPARTIDO</span>
            ${c.ingenierosCompartidos.map(a =>
              `<span style="font-size:10px;padding:2px 8px;border-radius:9px;
                background:var(--surface-2);border:1px solid var(--border);color:var(--text-sec)">${esc(a)}</span>`
            ).join("")}
          </div>` : ""}
        </div>
      </div>
      <button onclick="ClientesUI.cerrarDetalle()"
        aria-label="Cerrar"
        style="border:none;background:transparent;font-size:20px;cursor:pointer;
          color:#9CA3AF;padding:4px 8px;border-radius:6px">✕</button>
    </div>

    <!-- Grid de datos -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:18px">
      ${_campo("📞 Teléfono", c.telefono)}
      ${_campo("👷 Ingeniero", c.ingeniero)}
      ${_campo("📍 Zona", c.zona)}
      ${_campo("🏙 Ciudad", [c.colonia, c.ciudad].filter(Boolean).join(", ") || null)}
      ${_campo("🏠 Dirección", [c.calle, c.numExt ? `#${c.numExt}` : null].filter(Boolean).join(" ") || c.direccion || null)}
      ${_campo("📅 Última visita", fmtDt(c.fechaUltimaVisita || c.ultimaVisita))}
      ${c.tipo        ? _campo("🏗 Tipo de instalación", c.tipo)        : ""}
      ${c.tipoCultivo ? _campo("🌱 Tipo de cultivo",     c.tipoCultivo) : ""}
    </div>

    <!-- Saldo / Línea de crédito (Medio/56) -->
    ${(() => {
      const lim = Number(c.limiteCredito) || 0;
      const pct = lim > 0 ? Math.min(100, Math.round(saldo / lim * 100)) : 0;
      const col = pct >= 90 ? "#DC2626" : pct >= 70 ? "#D97706" : "#16A34A";
      const abcL = _abcMap[c.id] || "";
      return `
      <div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;
        margin-bottom:16px;background:var(--surface-2)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${lim>0?8:0}px">
          <div>
            <span style="font-size:12px;font-weight:600;color:${saldo>0?"#DC2626":"#16A34A"}">
              ${saldo > 0 ? "⚠️ Saldo pendiente" : "✅ Sin saldo"}
            </span>
            ${abcL ? `<span style="font-size:11px;font-weight:800;margin-left:8px;padding:2px 8px;border-radius:6px;
              background:${abcL==="A"?"#FEF3C7":abcL==="B"?"#DBEAFE":"#F1F5F9"};
              color:${abcL==="A"?"#B45309":abcL==="B"?"#1D4ED8":"#64748B"}">
              Cliente ${abcL}
            </span>` : ""}
          </div>
          <span style="font-size:18px;font-weight:800;color:${saldo>0?"#DC2626":"#16A34A"}">
            ${saldo > 0 ? fmt.format(saldo) : "$0.00"}
          </span>
        </div>
        ${lim > 0 ? `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:#64748B;margin-bottom:4px">
            <span>Línea de crédito: <strong style="color:var(--text-primary)">${fmt.format(lim)}</strong></span>
            <span style="color:${col};font-weight:700">${pct}% utilizado</span>
          </div>
          <div style="height:7px;border-radius:4px;background:var(--border)">
            <div style="height:7px;border-radius:4px;background:${col};width:${pct}%;max-width:100%;transition:width .3s"></div>
          </div>
          ${pct >= 90 ? `<div style="font-size:10px;color:#DC2626;font-weight:700;margin-top:4px">
            ⚠️ Límite de crédito casi agotado — revisar antes de nuevos pedidos</div>` : ""}
        </div>` : `
        <div style="font-size:10px;color:#94A3B8;margin-top:2px">Sin línea de crédito configurada</div>`}
      </div>`;
    })()}

    <!-- Pedidos recientes (Alto/74) -->
    <div style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:12px;font-weight:700;color:var(--text-primary)">🧾 Pedidos recientes</span>
      </div>
      <div id="cli-pedidos-recientes" style="font-size:12px;color:var(--text-sec);text-align:center;padding:12px">
        Cargando…
      </div>
    </div>

    <!-- Ubicaciones -->
    <div style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <span style="font-size:12px;font-weight:700;color:var(--text-primary)">📍 Ubicaciones</span>
        <button onclick="ClientesUI.abrirUbicacion('${esc(c.id)}', null)"
          style="padding:5px 12px;border:1px solid #1565C0;border-radius:6px;
            background:transparent;color:#1565C0;font-size:11px;font-weight:700;cursor:pointer">
          + Agregar
        </button>
      </div>
      <div id="cli-ubicaciones-list" style="display:flex;flex-direction:column;gap:8px">
        <div style="padding:16px;text-align:center;color:#9CA3AF;font-size:12px">Cargando…</div>
      </div>
    </div>

    <!-- Nota web -->
    <div style="margin-bottom:16px">
      <label style="font-size:11px;font-weight:700;color:#374151;display:block;margin-bottom:6px">
        📝 Nota interna (solo panel web)
      </label>
      <textarea id="cli-det-nota" rows="3" placeholder="Agrega una nota sobre este cliente…"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;
          font-size:12px;resize:vertical;background:var(--surface);
          color:var(--text-primary);box-sizing:border-box;font-family:inherit"
      >${esc(c.notaWeb || "")}</textarea>
      ${c.notaWebActualizado
        ? `<div style="font-size:10px;color:#9CA3AF;margin-top:3px">
            Última edición: ${fmtDt(c.notaWebActualizado)} por ${esc(c.notaWebPor || "—")}
          </div>`
        : ""}
    </div>

    <!-- Log de visitas (Bajo/44) -->
    <div style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:12px;font-weight:700;color:var(--text-primary)">📅 Seguimiento de visitas</span>
        <button onclick="ClientesUI.nuevaVisita('${esc(c.id)}')"
          style="padding:4px 12px;border:1px solid #7C3AED;border-radius:6px;
            background:transparent;color:#7C3AED;font-size:11px;font-weight:700;cursor:pointer">
          + Nueva
        </button>
      </div>
      <div id="cli-visitas-log" style="font-size:12px;color:var(--text-sec);text-align:center;padding:12px">
        Cargando…
      </div>
    </div>

    <!-- Acciones -->
    <div style="display:flex;gap:10px;justify-content:space-between;align-items:center">
      <button onclick="ClientesUI.verFotos('${esc(c.id)}','${esc(c.nombre||'')}')"
        class="btn-secondary">
        📷 Fotos APK
      </button>
      <div style="display:flex;gap:10px">
        <button onclick="ClientesUI.cerrarDetalle()" class="btn-secondary">Cerrar</button>
        <button onclick="ClientesUI.abrirEdicion('${esc(c.id)}')"
          style="padding:8px 18px;border:1px solid #1565C0;border-radius:6px;
            background:transparent;color:#1565C0;font-size:12px;font-weight:700;cursor:pointer">
          ✏️ Editar cliente
        </button>
        <button id="cli-det-guardar" onclick="ClientesUI.guardarNota()" class="btn-primary">
          Guardar nota
        </button>
      </div>
    </div>`;

  // Cargar secciones asíncronas tras renderizar el modal
  _cargarUbicaciones(id);
  _cargarPedidosRecientes(id, c);
  _cargarVisitasLog(id);
}

function _campo(label, valor) {
  return `<div style="background:var(--surface-2);border-radius:8px;padding:10px 12px;
    border:1px solid var(--border)">
    <div style="font-size:10px;font-weight:700;color:#9CA3AF;margin-bottom:3px">${label}</div>
    <div style="font-size:12px;font-weight:600;color:var(--text-primary)">${esc(valor) || `<span style="color:#D1D5DB">—</span>`}</div>
  </div>`;
}

// ── Definición de columnas (mismo patrón que productos-control) ──
const CLI_ALL_COLS = [
  { key:"clienteId", label:"ID",              locked:true  },
  { key:"nombre",    label:"CLIENTE",        locked:true  },
  { key:"segmento",  label:"SEGMENTO"                     },
  { key:"ingeniero", label:"INGENIERO"                    },
  { key:"zona",      label:"ZONA"                         },
  { key:"saldo",     label:"SALDO"                        },
  { key:"visita",    label:"ÚLTIMA VISITA"                },
  { key:"estado",    label:"ESTADO"                       },
  { key:"acciones",  label:"",               locked:true  },
];
const CLI_LS_KEY = "n10_cli_cols";

function _loadColPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(CLI_LS_KEY) || "null");
    if (Array.isArray(s) && s.length) return s;
  } catch {}
  return CLI_ALL_COLS.map(c => c.key);
}
function _saveColPrefs(cols) { localStorage.setItem(CLI_LS_KEY, JSON.stringify(cols)); }

let _colsVisibles = _loadColPrefs();

function _aplicarColPrefs() {
  CLI_ALL_COLS.forEach((col, i) => {
    const visible = _colsVisibles.includes(col.key);
    // <th> del header
    const th = document.getElementById(`cli-th-${col.key}`);
    if (th) th.style.display = visible ? "" : "none";
    // <td> de cada fila (columna i+1, base 1)
    document.querySelectorAll(`#cli-tbody tr td:nth-child(${i + 1})`).forEach(td => {
      td.style.display = visible ? "" : "none";
    });
  });
}

// ── Importar Excel (hoja 11 Coordenadas del APK) ──────────────
const _IMPORT_MAP = {
  "Nombre":        "nombre",
  "Número":        "numeroCliente",
  "Zona":          "zona",
  "Tipo":          "segmento",
  "Municipio":     "ciudad",
  "Localidad":     "colonia",
  "Estado":        "estado",
  "Teléfono":      "telefono",
  "Latitud":       "lat",
  "Longitud":      "lng",
  "Calle":         "calle",
  "Num. Ext.":     "numExt",
  "CP":            "cp",
  "Estado Legal":  "estadoLegal",
  "Deuda original":"deudaOriginal",
  "Notas":         "notas",
};

async function _importarExcel(file) {
  const XLSX = window.XLSX;
  if (!XLSX) { window.toast?.("SheetJS no disponible.", "error"); return; }
  if (!Sesion.esSuperAdmin?.() && !["GERENTE","ADMINISTRADOR","SUPER_ADMIN"].includes(Sesion.rol)) {
    window.toast?.("Sin permiso para importar clientes.", "error"); return;
  }

  window.toast?.("Leyendo archivo…", "info");
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: "array" });

  // Buscar hoja con columna Latitud (hoja 11 Coordenadas)
  let wsName = wb.SheetNames.find(n => {
    const ws = wb.Sheets[n];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    return rows[0]?.includes("Latitud");
  }) ?? wb.SheetNames[0];

  const ws   = wb.Sheets[wsName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (rows.length < 2) { window.toast?.("Hoja vacía.", "warn"); return; }

  const headers = rows[0].map(h => String(h).trim());
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const obj = {};
    headers.forEach((h, idx) => {
      const campo = _IMPORT_MAP[h];
      if (!campo) return;
      let val = row[idx];
      if (val === null || val === undefined || val === "—" || val === "") return;
      if (campo === "lat" || campo === "lng") val = parseFloat(String(val).replace(",", "."));
      else if (campo === "deudaOriginal") val = parseFloat(String(val).replace(/[^0-9.]/g, "")) || 0;
      else if (campo === "cp") val = String(val).trim();
      else val = String(val).trim();
      obj[campo] = val;
    });
    if (!obj.nombre) continue;
    records.push(obj);
  }

  if (!records.length) { window.toast?.("Sin registros válidos.", "warn"); return; }

  // Cargar solo usuarios con rol INGENIERO
  let ingenierosList = [];
  try {
    const ingSnap = await getDocs(query(collection(db, "usuarios"),
      where("rol", "==", "INGENIERO")));
    ingenierosList = ingSnap.docs
      .filter(d => d.data().activo !== false)
      .map(d => d.data().alias || d.data().email || d.id)
      .filter(Boolean).sort();
  } catch { /* si falla, continuar sin lista */ }

  // Modal personalizado para seleccionar ingeniero
  let ingenieroDefault = "";
  ingenieroDefault = await new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px";
    const selectOpts = ingenierosList.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
    overlay.innerHTML = `
      <div style="background:var(--surface);border-radius:14px;width:420px;max-width:100%;
        border:1px solid var(--border);box-shadow:0 8px 32px rgba(0,0,0,.25);padding:24px">
        <div style="font-size:16px;font-weight:800;color:var(--text-primary);margin-bottom:8px">Asignar ingeniero</div>
        <div style="font-size:12px;color:var(--text-sec);margin-bottom:16px">
          Se importarán <strong>${records.length}</strong> clientes de la hoja «${esc(wsName)}».<br>
          Selecciona el ingeniero al que se asignarán (solo roles Ingeniero).
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">Ingeniero asignado</div>
          <select id="_imp-ing-sel" style="width:100%;padding:8px 10px;border:1px solid var(--border);
            border-radius:6px;font-size:13px;background:var(--surface);color:var(--text-primary)">
            <option value="">— Importar sin asignar —</option>
            ${selectOpts}
          </select>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button id="_imp-cancel" style="padding:9px 20px;border:1px solid var(--border);border-radius:6px;
            background:transparent;color:var(--text-sec);font-size:13px;cursor:pointer">Cancelar</button>
          <button id="_imp-ok" style="padding:9px 24px;border:none;border-radius:6px;
            background:#1565C0;color:#fff;font-size:13px;font-weight:700;cursor:pointer">✅ Importar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#_imp-cancel").onclick = () => { document.body.removeChild(overlay); resolve(null); };
    overlay.querySelector("#_imp-ok").onclick = () => {
      const val = overlay.querySelector("#_imp-ing-sel").value;
      document.body.removeChild(overlay);
      resolve(val);
    };
  });

  if (ingenieroDefault === null) return; // usuario canceló

  // Obtener nombres existentes para upsert (clave: nombre+zona normalizados)
  const existSnap = await getDocs(collection(db, "clientes"));
  const existMap  = {};
  existSnap.forEach(d => {
    const data = d.data();
    const key  = norm(data.nombre) + "|" + norm(data.zona || "");
    existMap[key] = d.id;
  });

  let creados = 0, actualizados = 0, errores = 0;
  window.toast?.(`Importando ${records.length} registros…`, "info");

  for (const rec of records) {
    try {
      const key = norm(rec.nombre) + "|" + norm(rec.zona || "");
      const payload = {
        ...rec,
        activo: true,
        importadoEn: serverTimestamp(),
        importadoPor: Sesion.alias ?? "web",
      };
      if (ingenieroDefault) payload.ingeniero = ingenieroDefault;

      if (existMap[key]) {
        await updateDoc(doc(db, "clientes", existMap[key]), payload);
        actualizados++;
      } else {
        await addDoc(collection(db, "clientes"), payload);
        creados++;
      }
    } catch(eRec) { errores++; console.warn("[Clientes import] fila error:", eRec.message, rec); }
  }

  window.toast?.(
    `✅ Importación: ${creados} nuevos, ${actualizados} actualizados${errores ? ", " + errores + " errores" : ""}.`,
    errores ? "warn" : "success"
  );
}

// ── Nuevo / Editar Cliente ─────────────────────────────────────
let _ingenierosList = [];

async function _abrirFormCliente(clienteId = null) {
  const modal = document.getElementById("cli-form-modal");
  const body  = document.getElementById("cli-form-body");
  if (!modal || !body) return;

  // Cargar ingenieros y frecuencias de visita en paralelo
  let _frecuencias = [];
  try {
    const [snapU, snapCfg] = await Promise.all([
      getDocs(query(collection(db, "usuarios"), where("rol", "==", "INGENIERO"))),
      getDoc(doc(db, "configuracion", "cartera")),
    ]);
    _ingenierosList = snapU.docs
      .filter(d => d.data().activo !== false)
      .map(d => d.data().alias || d.id)
      .filter(Boolean).sort();
    _frecuencias = snapCfg.exists() ? (snapCfg.data().frecuencias || []) : [];
  } catch { _ingenierosList = []; }

  let c = clienteId ? _clientes.find(x => x.id === clienteId) ?? {} : {};

  const DIAS = [
    { bit: 1,  label: "Lun" }, { bit: 2,  label: "Mar" }, { bit: 4,  label: "Mié" },
    { bit: 8,  label: "Jue" }, { bit: 16, label: "Vie" }, { bit: 32, label: "Sáb" },
    { bit: 64, label: "Dom" },
  ];
  const diasChecks = DIAS.map(d =>
    `<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" value="${d.bit}" class="cli-dia-check"
        ${(c.diasVisita & d.bit) ? "checked" : ""}> ${d.label}
    </label>`).join("");

  const ingSelect = `<select id="clf-ingeniero" style="${_inputStyle()}">
    <option value="">— Sin asignar —</option>
    ${_ingenierosList.map(a => `<option value="${esc(a)}" ${c.ingeniero===a?"selected":""}>${esc(a)}</option>`).join("")}
  </select>`;

  const ESTADOS_LEGAL = ["Al corriente","En gestión","Incumplimiento","Demanda","Promesa de pago","Cancelado"];
  // Segmentos: los que ya existen en Firestore + opción para agregar nuevo
  const SEGMENTOS = [...new Set(_clientes.map(x => x.segmento).filter(Boolean))].sort();

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <div style="font-size:16px;font-weight:800;color:var(--text-primary)">
        ${clienteId ? "✏️ Editar cliente" : "➕ Nuevo cliente"}
      </div>
      <button onclick="ClientesUI.cerrarFormCliente()"
        aria-label="Cerrar"
        style="border:none;background:transparent;font-size:20px;cursor:pointer;color:#9CA3AF">✕</button>
    </div>

    <div style="display:grid;gap:16px">
      <!-- Identificación -->
      ${_seccion("📋 Identificación")}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${_field("Nombre completo *", `<input id="clf-nombre" required style="${_inputStyle()}" value="${esc(c.nombre||'')}">`)}
        ${_field("ID del cliente", `<input id="clf-clienteid" readonly style="${_inputStyle()}opacity:.6;font-family:monospace"
          value="${esc(c.clienteId || (clienteId ? '—' : '(se asignará al guardar)'))}"
          title="El ID se genera automáticamente y no puede modificarse">`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        ${_field("Número cliente (externo)", `<input id="clf-numero" style="${_inputStyle()}" value="${esc(c.numeroCliente||'')}">`)}
        ${_field("RFC", `<input id="clf-rfc" style="${_inputStyle()}" placeholder="XXXX000000XXX" value="${esc(c.rfc||'')}">`)}
        ${_field("Teléfono", `<input id="clf-tel" style="${_inputStyle()}" placeholder="10 dígitos" value="${esc(c.telefono||'')}">`)}
      </div>
      <!-- Dirección -->
      ${_seccion("📍 Dirección")}
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
        ${_field("Calle", `<input id="clf-calle" style="${_inputStyle()}" value="${esc(c.calle||'')}">` )}
        ${_field("Núm. Ext.", `<input id="clf-numext" style="${_inputStyle()}" value="${esc(c.numExt||'')}">`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        ${_field("Colonia / Localidad", `<input id="clf-colonia" style="${_inputStyle()}" value="${esc(c.colonia||'')}">`)}
        ${_field("Municipio / Ciudad", `<input id="clf-ciudad" style="${_inputStyle()}" value="${esc(c.ciudad||'')}">`)}
        ${_field("Estado", `<input id="clf-estado" style="${_inputStyle()}" value="${esc(c.estado||'')}">`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${_field("CP", `<input id="clf-cp" style="${_inputStyle()}" placeholder="00000" value="${esc(c.cp||'')}">`)}
        ${_field("Zona / Ruta", `<input id="clf-zona" style="${_inputStyle()}" value="${esc(c.zona||'')}">`)}
      </div>

      <!-- Geolocalización -->
      ${_seccion("🌐 Geolocalización")}
      <div style="display:flex;gap:8px;margin-bottom:2px">
        <input id="clf-geobus" type="text" placeholder="Busca una dirección para obtener coordenadas…"
          style="${_inputStyle()}flex:1;margin-bottom:0">
        <button type="button" onclick="ClientesUI.geolocalizarCliente()"
          title="Usar mi ubicación GPS"
          style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);
            color:var(--text-primary);font-size:14px;cursor:pointer;white-space:nowrap;flex-shrink:0">
          📍 Mi ubicación
        </button>
      </div>
      <div id="clf-geobus-results" style="display:none;border:1px solid var(--border);border-radius:6px;
        background:var(--surface);max-height:140px;overflow-y:auto;font-size:12px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px">
        ${_field("Latitud", `<input id="clf-lat" type="number" step="any" style="${_inputStyle()}" placeholder="18.9234" value="${esc(c.lat||'')}">`)}
        ${_field("Longitud", `<input id="clf-lng" type="number" step="any" style="${_inputStyle()}" placeholder="-99.2340" value="${esc(c.lng||'')}">`)}
      </div>

      <!-- Comercial -->
      ${_seccion("💼 Datos comerciales")}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${_field("Segmento / Tipo", `
          <select id="clf-segmento" style="${_inputStyle()}"
            onchange="const o=document.getElementById('clf-segmento-nuevo');o.style.display=this.value==='__nuevo'?'':'none'">
            <option value="">— Seleccionar —</option>
            ${SEGMENTOS.map(s => `<option value="${esc(s)}" ${c.segmento===s?"selected":""}>${esc(s)}</option>`).join("")}
            ${c.segmento && !SEGMENTOS.includes(c.segmento) ? `<option value="${esc(c.segmento)}" selected>${esc(c.segmento)}</option>` : ""}
            <option value="__nuevo">➕ Agregar nuevo…</option>
          </select>
          <input id="clf-segmento-nuevo" type="text" placeholder="Nombre del nuevo segmento"
            style="${_inputStyle()}margin-top:6px;display:none">
        `)}
        ${_field("Ingeniero asignado", ingSelect)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${_field("Tipo de cultivo", `
          <input id="clf-tipocultivo" list="clf-cultivos-list" style="${_inputStyle()}"
            placeholder="Jitomate, maíz, calabacita…"
            value="${esc(c.tipoCultivo||'')}">
          <datalist id="clf-cultivos-list">
            <option value="Jitomate"></option>
            <option value="Calabacita"></option>
            <option value="Maíz"></option>
            <option value="Chile"></option>
            <option value="Pepino"></option>
            <option value="Sandía"></option>
            <option value="Melón"></option>
            <option value="Aguacate"></option>
            <option value="Cebolla"></option>
            <option value="Ajo"></option>
            <option value="Papa"></option>
            <option value="Trigo"></option>
            <option value="Sorgo"></option>
            <option value="Fresa"></option>
            <option value="Brócoli"></option>
            <option value="Lechuga"></option>
            <option value="Espárrago"></option>
            <option value="Nuez"></option>
            <option value="Vid"></option>
            <option value="Ornamental"></option>
          </datalist>
        `)}
        ${_field("Tipo de instalación", `<input id="clf-tipo" style="${_inputStyle()}"
          placeholder="Invernadero, campo abierto…"
          value="${esc(c.tipo||'')}">`)}
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:6px">Días de visita</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;padding:10px;background:var(--surface-2);
          border:1px solid var(--border);border-radius:6px">${diasChecks}</div>
      </div>
      ${_frecuencias.length ? _field("Frecuencia de visita", `
        <select id="clf-frecuencia" style="${_inputStyle()}">
          <option value="">— Sin categoría —</option>
          ${_frecuencias.map((f, i) =>
            `<option value="${i}" data-label="${esc(f.label)}" data-dias="${f.dias}"
              ${(c.frecuenciaVisitaId === String(i) || c.frecuenciaVisitaLabel === f.label) ? "selected" : ""}>
              ${esc(f.label)} (cada ${f.dias} días)
            </option>`).join("")}
        </select>`) : ""}

      <!-- Cliente compartido -->
      ${_seccion("🔗 Cliente compartido entre ingenieros")}
      <div style="border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--surface-2)">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:10px">
          <input type="checkbox" id="clf-compartido" style="width:16px;height:16px;cursor:pointer"
            ${c.compartido ? "checked" : ""}
            onchange="document.getElementById('clf-ing-compartidos-wrap').style.display=this.checked?'':'none'">
          <span style="font-size:12px;font-weight:600;color:var(--text-primary)">
            Este cliente tiene parcelas o actividad en zonas de más de un ingeniero
          </span>
        </label>
        <div id="clf-ing-compartidos-wrap" style="display:${c.compartido ? '' : 'none'}">
          <div style="font-size:11px;font-weight:600;color:#6B7280;margin-bottom:6px">
            Ingenieros adicionales con acceso a este cliente:
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px" id="clf-ing-compartidos-list">
            ${_ingenierosList.map(alias => {
              const checked = (c.ingenierosCompartidos || []).includes(alias);
              return `<label style="display:flex;align-items:center;gap:5px;padding:4px 10px;
                border:1px solid var(--border);border-radius:20px;cursor:pointer;font-size:11px;
                background:${checked ? "#EFF6FF" : "var(--surface)"};
                color:${checked ? "#1565C0" : "var(--text-primary)"}">
                <input type="checkbox" class="clf-ing-comp-chk" value="${esc(alias)}"
                  style="cursor:pointer" ${checked ? "checked" : ""}>
                ${esc(alias)}
              </label>`;
            }).join("")}
            ${_ingenierosList.length === 0 ? `<span style="font-size:11px;color:#9CA3AF">No hay ingenieros registrados.</span>` : ""}
          </div>
        </div>
      </div>

      <!-- Cartera -->
      ${_seccion("💰 Cartera y crédito")}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${_field("Estado legal", `<select id="clf-estadolegal" style="${_inputStyle()}">
          <option value="">— Seleccionar —</option>
          ${ESTADOS_LEGAL.map(e => `<option value="${e}" ${c.estadoLegal===e?"selected":""}>${e}</option>`).join("")}
        </select>`)}
        ${_field("Deuda original ($)", `<input id="clf-deuda" type="number" min="0" step="0.01" style="${_inputStyle()}" value="${esc(c.deudaOriginal||'')}">`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${_field("Límite de crédito ($)", `<input id="clf-limite" type="number" min="0" step="0.01" style="${_inputStyle()}" value="${esc(c.limiteCredito||'')}">`)}
        ${_field("Condiciones de pago", `<input id="clf-condpago" style="${_inputStyle()}" placeholder="Crédito 30 días" value="${esc(c.condicionesPago||'')}">`)}
      </div>

      <!-- Observaciones -->
      ${_seccion("📝 Observaciones")}
      ${_field("Notas", `<textarea id="clf-notas" rows="3"
        style="${_inputStyle()}resize:vertical;">${esc(c.notas||'')}</textarea>`)}

      <!-- Acciones -->
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">
        <button onclick="ClientesUI.cerrarFormCliente()"
          style="padding:9px 20px;border:1px solid var(--border);border-radius:6px;
            background:transparent;color:var(--text-sec);font-size:13px;cursor:pointer">
          Cancelar
        </button>
        <button id="clf-btn-guardar" onclick="ClientesUI._guardarFormCliente('${clienteId||''}')"
          style="padding:9px 24px;border:none;border-radius:6px;
            background:#1B5E20;color:#fff;font-size:13px;font-weight:700;cursor:pointer">
          ${clienteId ? "💾 Guardar cambios" : "✅ Crear cliente"}
        </button>
      </div>
    </div>`;

  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
  _openTrap("cli-form-modal", () => window.ClientesUI.cerrarFormCliente());

  // Búsqueda de dirección con Places Autocomplete
  _initGeoBuscador();
}

let _geoBuscadorAbort = null;

function _initGeoBuscador() {
  const input = document.getElementById("clf-geobus");
  const results = document.getElementById("clf-geobus-results");
  if (!input || !results) return;

  // Cancelar listener previo si el formulario se reabre sin cerrar
  _geoBuscadorAbort?.abort();
  _geoBuscadorAbort = new AbortController();
  const { signal } = _geoBuscadorAbort;

  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { results.style.display = "none"; return; }
    timer = setTimeout(async () => {
      if (!window.google?.maps?.places) {
        try { await _loadGMaps(); } catch { return; }
      }
      const svc = new google.maps.places.AutocompleteService();
      svc.getPlacePredictions({ input: q, language: "es" }, (preds, status) => {
        if (status !== "OK" || !preds?.length) { results.style.display = "none"; return; }
        results.innerHTML = preds.map(p =>
          `<div data-pid="${esc(p.place_id)}" style="padding:8px 12px;cursor:pointer;
            border-bottom:1px solid var(--border);color:var(--text-primary)"
            onmouseenter="this.style.background='var(--surface-2)'"
            onmouseleave="this.style.background=''"
            onclick="ClientesUI._selGeoResult('${esc(p.place_id)}','${esc(p.description)}')">
            📍 ${esc(p.description)}
          </div>`
        ).join("");
        results.style.display = "block";
      });
    }, 350);
  }, { signal });
  document.addEventListener("click", e => {
    if (!results.contains(e.target) && e.target !== input)
      results.style.display = "none";
  }, { signal });
}

function _inputStyle() {
  return `width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
    font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;`;
}
function _seccion(label) {
  return `<div style="font-size:11px;font-weight:800;color:var(--text-sec);letter-spacing:.06em;
    text-transform:uppercase;border-bottom:1px solid var(--border);padding-bottom:6px;margin-top:4px">${label}</div>`;
}
function _field(label, inputHtml) {
  return `<div>
    <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">${label}</div>
    ${inputHtml}
  </div>`;
}

// _guardarFormCliente se expone desde _bindUI(); esta función
// es la implementación real invocada por window.ClientesUI._guardarFormCliente
async function _guardarFormCliente(clienteId) {
    const v = id => document.getElementById(id)?.value?.trim() ?? "";
    const nombre = v("clf-nombre");
    if (!nombre) { window.toast?.("El nombre es obligatorio.", "warn"); return; }

    // Validar duplicado por nombre exacto + zona (solo en alta, no en edición)
    if (!clienteId) {
      const zona = v("clf-zona");
      const dup = _clientes.find(c =>
        norm(c.nombre || "") === norm(nombre) &&
        (!zona || norm(c.zona || "") === norm(zona))
      );
      if (dup) {
        window.toast?.(`⚠ Ya existe un cliente con ese nombre${zona ? " y zona" : ""}: ${dup.clienteId || dup.nombre}`, "warn");
        return;
      }
    }

    const diasChecks = [...document.querySelectorAll(".cli-dia-check:checked")];
    const diasVisita = diasChecks.reduce((acc, cb) => acc | Number(cb.value), 0);

    const payload = {
      nombre,
      numeroCliente: v("clf-numero") || null,
      rfc:           v("clf-rfc")    || null,
      telefono:      v("clf-tel")    || null,
      calle:         v("clf-calle")  || null,
      numExt:        v("clf-numext") || null,
      colonia:       v("clf-colonia")|| null,
      ciudad:        v("clf-ciudad") || null,
      estado:        v("clf-estado") || null,
      cp:            v("clf-cp")     || null,
      zona:          v("clf-zona")   || null,
      lat:           parseFloat(v("clf-lat"))  || null,
      lng:           parseFloat(v("clf-lng"))  || null,
      segmento:      (v("clf-segmento")==="__nuevo" ? document.getElementById("clf-segmento-nuevo")?.value.trim() : v("clf-segmento")) || null,
      ingeniero:     v("clf-ingeniero") || null,
      diasVisita:    diasVisita || 0,
      compartido:    document.getElementById("clf-compartido")?.checked === true,
      ingenierosCompartidos: [...document.querySelectorAll(".clf-ing-comp-chk:checked")].map(cb => cb.value),
      estadoLegal:   v("clf-estadolegal") || null,
      deudaOriginal: parseFloat(v("clf-deuda").replace(/[^0-9.]/g,"")) || null,
      limiteCredito: parseFloat(v("clf-limite").replace(/[^0-9.]/g,"")) || null,
      condicionesPago: v("clf-condpago") || null,
      tipoCultivo:   v("clf-tipocultivo") || null,
      tipo:          v("clf-tipo") || null,
      notas:         document.getElementById("clf-notas")?.value?.trim() || null,
      activo: true,
    };

    // Frecuencia de visita (si existe el selector)
    const freqSel = document.getElementById("clf-frecuencia");
    if (freqSel) {
      const opt = freqSel.options[freqSel.selectedIndex];
      if (opt && opt.value !== "") {
        payload.frecuenciaVisitaId    = opt.value;
        payload.frecuenciaVisitaLabel = opt.dataset.label || opt.text.split(" (")[0].trim();
        payload.frecuenciaVisitaDias  = parseInt(opt.dataset.dias) || null;
      } else {
        payload.frecuenciaVisitaId    = null;
        payload.frecuenciaVisitaLabel = null;
        payload.frecuenciaVisitaDias  = null;
      }
    }
    // Limpiar nulos para no sobreescribir con null en update
    Object.keys(payload).forEach(k => { if (payload[k] === null) delete payload[k]; });

    const btn = document.getElementById("clf-btn-guardar");
    if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }
    try {
      if (clienteId) {
        payload.actualizadoEn  = serverTimestamp();
        payload.actualizadoPor = window.Sesion?.alias ?? "web";
        await updateDoc(doc(db, "clientes", clienteId), payload);
        window.toast?.("Cliente actualizado.", "success");
      } else {
        // Generar CLI-XXXXX: siguiente número al máximo existente
        const maxNum = Math.max(
          ..._clientes.map(x => parseInt(x.clienteId?.replace("CLI-","")) || 0),
          0
        );
        payload.clienteId = "CLI-" + String(maxNum + 1).padStart(5, "0");
        payload.creadoEn  = serverTimestamp();
        payload.creadoPor = window.Sesion?.alias ?? "web";
        await addDoc(collection(db, "clientes"), payload);
        window.toast?.("Cliente creado.", "success");
      }
      window.ClientesUI.cerrarFormCliente();
    } catch(e) {
      window.toast?.("Error: " + e.message, "error");
      if (btn) { btn.disabled = false; btn.textContent = clienteId ? "💾 Guardar cambios" : "✅ Crear cliente"; }
    }
  }

// ── Ubicaciones de cliente ────────────────────────────────────
const GMAPS_KEY = "AIzaSyCl9_ouMqIVy1RBwRqBzLU0cjGJUsLIUGE";
let _gmapsLoaded = false;
let _gmapsLoading = false;

async function _loadGMaps() {
  if (_gmapsLoaded) return;
  if (_gmapsLoading) {
    await new Promise(r => { const t = setInterval(() => { if (_gmapsLoaded) { clearInterval(t); r(); } }, 100); });
    return;
  }
  _gmapsLoading = true;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GMAPS_KEY}&libraries=places&language=es`;
    s.async = true; s.defer = true;
    s.onload  = () => { _gmapsLoaded = true; resolve(); };
    s.onerror = () => reject(new Error("Error cargando Google Maps"));
    document.head.appendChild(s);
  });
}

const _TIPO_ICON = { parcela:"🌾", domicilio:"🏠", invernadero:"🏗", otro:"📌" };
const _TIPO_COLOR = { parcela:"#15803D", domicilio:"#1565C0", invernadero:"#7E22CE", otro:"#B45309" };

async function _cargarUbicaciones(clienteDocId) {
  const list = document.getElementById("cli-ubicaciones-list");
  if (!list) return;
  try {
    const { getDocs: gd, collection: col, orderBy: ob, query: q } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const snap = await gd(q(col(db, "clientes", clienteDocId, "ubicaciones"), ob("creadoEn")));
    if (snap.empty) {
      list.innerHTML = `<div style="padding:14px;text-align:center;color:#9CA3AF;font-size:12px;
        border:1px dashed var(--border);border-radius:8px">
        Sin ubicaciones registradas. Agrega la parcela o domicilio del cliente.
      </div>`;
      return;
    }
    list.innerHTML = snap.docs.map(d => {
      const u = d.data(); const uid = d.id;
      const icon  = _TIPO_ICON[u.tipo]  || "📌";
      const color = _TIPO_COLOR[u.tipo] || "#6B7280";
      return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;
        background:var(--surface-2);display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:20px;flex-shrink:0;margin-top:2px">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
            <span style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase">${esc(u.tipo||"otro")}</span>
            ${u.etiqueta ? `<span style="font-size:12px;font-weight:600;color:var(--text-primary)">${esc(u.etiqueta)}</span>` : ""}
          </div>
          <div style="font-size:11px;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${esc(u.direccionFormateada || `${u.lat?.toFixed(6)}, ${u.lng?.toFixed(6)}`)}
          </div>
          ${u.zonaIngeniero ? `<div style="font-size:10px;color:#9CA3AF;margin-top:2px">Zona: ${esc(u.zonaIngeniero)}</div>` : ""}
          <div style="font-size:10px;color:#9CA3AF;margin-top:2px">
            ${u.modificadoPor ? `Editado por ${esc(u.modificadoPor)}` : `Por ${esc(u.creadoPor||"—")}`}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
          <button onclick="ClientesUI.navegarUbicacion(${u.lat},${u.lng})"
            title="Abrir en Google Maps"
            style="padding:4px 10px;border:1px solid #1565C0;border-radius:5px;background:transparent;
              color:#1565C0;font-size:11px;cursor:pointer;font-weight:600">🗺 Navegar</button>
          <button onclick="ClientesUI.abrirUbicacion('${esc(clienteDocId)}','${esc(uid)}')"
            style="padding:4px 10px;border:1px solid var(--border);border-radius:5px;background:transparent;
              color:var(--text-primary);font-size:11px;cursor:pointer">✏ Editar</button>
          <button onclick="ClientesUI.eliminarUbicacion('${esc(clienteDocId)}','${esc(uid)}')"
            style="padding:4px 10px;border:1px solid #FCA5A5;border-radius:5px;background:transparent;
              color:#DC2626;font-size:11px;cursor:pointer">🗑</button>
        </div>
      </div>`;
    }).join("");
  } catch(e) {
    if (list) list.innerHTML = `<div style="padding:12px;color:#DC2626;font-size:12px">
      Error al cargar ubicaciones: ${esc(e.message)}</div>`;
  }
}

// Estado del modal de ubicación
let _ubicEdit = { clienteDocId: null, ubicId: null, map: null, marker: null, lat: null, lng: null };

async function _abrirModalUbicacion(clienteDocId, ubicId) {
  const modal = document.getElementById("cli-ubic-modal");
  if (!modal) return;

  _ubicEdit.clienteDocId = clienteDocId;
  _ubicEdit.ubicId = ubicId;

  // Cargar datos existentes si es edición
  let u = {};
  if (ubicId) {
    try {
      const { getDoc: gd2, doc: d2 } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const snap = await gd2(d2(db, "clientes", clienteDocId, "ubicaciones", ubicId));
      if (snap.exists()) u = snap.data();
    } catch {}
  }

  document.getElementById("cli-ubic-titulo").textContent = ubicId ? "Editar ubicación" : "Nueva ubicación";
  document.getElementById("cli-ubic-tipo").value     = u.tipo    || "parcela";
  document.getElementById("cli-ubic-etiqueta").value = u.etiqueta || "";
  document.getElementById("cli-ubic-dir").value      = u.direccionFormateada || "";
  document.getElementById("cli-ubic-lat").value      = u.lat || "";
  document.getElementById("cli-ubic-lng").value      = u.lng || "";
  document.getElementById("cli-ubic-err").style.display = "none";

  // Poblar select de ingenieros
  const selZona = document.getElementById("cli-ubic-zona");
  const ings = _ingenierosList.length
    ? _ingenierosList
    : [...new Set(_clientes.map(c => c.ingeniero).filter(Boolean))].sort();
  selZona.innerHTML = `<option value="">— Sin asignar —</option>` +
    ings.map(a => `<option value="${esc(a)}" ${(u.zonaIngeniero||"")==a?"selected":""}>${esc(a)}</option>`).join("");

  // Poblar flag compartido + ingenieros extra
  const clienteData = _clientes.find(x => x.id === clienteDocId) || {};
  const chkComp = document.getElementById("cli-ubic-compartido");
  const extWrap = document.getElementById("cli-ubic-ings-extra-wrap");
  const extList = document.getElementById("cli-ubic-ings-extra-list");
  chkComp.checked = clienteData.compartido || false;
  extWrap.style.display = chkComp.checked ? "" : "none";
  const ingPrincipal = clienteData.ingeniero || "";
  extList.innerHTML = ings.filter(a => a !== ingPrincipal).map(alias => {
    const checked = (clienteData.ingenierosCompartidos || []).includes(alias);
    return `<label style="display:flex;align-items:center;gap:4px;padding:3px 9px;
      border:1px solid var(--border);border-radius:20px;cursor:pointer;font-size:11px;
      background:${checked?"#EFF6FF":"var(--surface)"};color:${checked?"#1565C0":"var(--text-primary)"}">
      <input type="checkbox" class="cli-ubic-comp-chk" value="${esc(alias)}"
        style="cursor:pointer" ${checked?"checked":""}> ${esc(alias)}
    </label>`;
  }).join("") || `<span style="font-size:11px;color:#9CA3AF">Sin ingenieros adicionales.</span>`;

  _ubicEdit.lat = u.lat || null;
  _ubicEdit.lng = u.lng || null;

  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
  _openTrap("cli-ubic-modal", () => window.ClientesUI.cerrarUbicacion());

  // Inicializar Google Maps
  try {
    await _loadGMaps();
    const defaultCenter = { lat: _ubicEdit.lat || 18.97, lng: _ubicEdit.lng || -99.22 };
    const mapDiv = document.getElementById("cli-ubic-map");
    if (!mapDiv) return;

    const map = new google.maps.Map(mapDiv, {
      center: defaultCenter, zoom: _ubicEdit.lat ? 15 : 8,
      mapTypeId: "hybrid",
      mapTypeControl: true, streetViewControl: false,
      fullscreenControl: true, zoomControl: true,
    });

    const marker = new google.maps.Marker({
      position: defaultCenter, map, draggable: true,
      title: "Arrastra para ajustar la posición",
      animation: google.maps.Animation.DROP,
    });

    if (!_ubicEdit.lat) marker.setVisible(false);

    // Click en mapa → mover marker
    map.addListener("click", e => {
      const pos = e.latLng;
      marker.setPosition(pos);
      marker.setVisible(true);
      _updateUbicCoords(pos.lat(), pos.lng());
    });

    // Drag del marker
    marker.addListener("dragend", e => {
      _updateUbicCoords(e.latLng.lat(), e.latLng.lng());
    });

    _ubicEdit.map = map;
    _ubicEdit.marker = marker;

    // Geocoder inverso al cargar si ya hay coords
    if (_ubicEdit.lat && _ubicEdit.lng) _reverseGeocode(_ubicEdit.lat, _ubicEdit.lng);

  } catch(e) {
    document.getElementById("cli-ubic-map").innerHTML =
      `<div style="padding:20px;color:#DC2626;font-size:12px">Error cargando mapa: ${esc(e.message)}</div>`;
  }
}

function _updateUbicCoords(lat, lng) {
  _ubicEdit.lat = lat; _ubicEdit.lng = lng;
  document.getElementById("cli-ubic-lat").value = lat.toFixed(7);
  document.getElementById("cli-ubic-lng").value = lng.toFixed(7);
  _reverseGeocode(lat, lng);
}

function _reverseGeocode(lat, lng) {
  if (!window.google?.maps?.Geocoder) return;
  const gc = new google.maps.Geocoder();
  gc.geocode({ location: { lat, lng } }, (results, status) => {
    if (status === "OK" && results[0]) {
      const dir = results[0].formatted_address;
      const el  = document.getElementById("cli-ubic-dir");
      if (el) el.value = dir;
    }
  });
}

async function _guardarUbicacion() {
  const clienteDocId = _ubicEdit.clienteDocId;
  const ubicId       = _ubicEdit.ubicId;
  const tipo     = document.getElementById("cli-ubic-tipo")?.value;
  const etiqueta = document.getElementById("cli-ubic-etiqueta")?.value.trim();
  const zona     = document.getElementById("cli-ubic-zona")?.value.trim();
  const dir      = document.getElementById("cli-ubic-dir")?.value.trim();
  const lat      = _ubicEdit.lat;
  const lng      = _ubicEdit.lng;
  const errEl    = document.getElementById("cli-ubic-err");

  if (!lat || !lng) {
    errEl.textContent = "Selecciona la ubicación en el mapa.";
    errEl.style.display = "block"; return;
  }
  if (!tipo) {
    errEl.textContent = "Selecciona el tipo de ubicación.";
    errEl.style.display = "block"; return;
  }

  const btn = document.getElementById("cli-ubic-btn-guardar");
  if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }
  errEl.style.display = "none";

  try {
    const { collection: col, doc: d2, addDoc: ad, updateDoc: ud, serverTimestamp: st }
      = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

    const alias = window.Sesion?.alias ?? "web";
    const rol   = window.Sesion?.rol   ?? "—";

    // Actualizar estado compartido en el cliente padre
    const compartido = document.getElementById("cli-ubic-compartido")?.checked || false;
    const ingsExtra  = [...document.querySelectorAll(".cli-ubic-comp-chk:checked")].map(x => x.value);
    await ud(d2(db, "clientes", clienteDocId), {
      compartido,
      ingenierosCompartidos: compartido ? ingsExtra : [],
    }).catch(() => {});
    // Actualizar en caché local
    const cacheIdx = _clientes.findIndex(x => x.id === clienteDocId);
    if (cacheIdx >= 0) {
      _clientes[cacheIdx].compartido = compartido;
      _clientes[cacheIdx].ingenierosCompartidos = compartido ? ingsExtra : [];
    }

    if (ubicId) {
      // Edición — guardar historial de cambios
      const oldData = {};
      try {
        const { getDoc: gd3 } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const snap = await gd3(d2(db, "clientes", clienteDocId, "ubicaciones", ubicId));
        Object.assign(oldData, snap.data() || {});
      } catch {}

      await ud(d2(db, "clientes", clienteDocId, "ubicaciones", ubicId), {
        tipo, etiqueta: etiqueta || "", zonaIngeniero: zona || "",
        lat, lng, direccionFormateada: dir || "",
        modificadoPor: alias, modificadoEn: st(),
      });

      // Registrar log de cambios (best-effort)
      const cambios = [];
      if (oldData.lat !== lat || oldData.lng !== lng) cambios.push({ campo:"coordenadas", antes:`${oldData.lat},${oldData.lng}`, despues:`${lat},${lng}` });
      if (oldData.tipo !== tipo) cambios.push({ campo:"tipo", antes:oldData.tipo, despues:tipo });
      if (oldData.etiqueta !== etiqueta) cambios.push({ campo:"etiqueta", antes:oldData.etiqueta, despues:etiqueta });
      if (cambios.length) {
        ad(col(db, "clientes", clienteDocId, "ubicaciones", ubicId, "historial"), {
          quien: alias, rol, cuándo: st(), cambios
        }).catch(() => {});
      }
    } else {
      await ad(col(db, "clientes", clienteDocId, "ubicaciones"), {
        tipo, etiqueta: etiqueta || "", zonaIngeniero: zona || "",
        lat, lng, direccionFormateada: dir || "",
        creadoPor: alias, creadoEn: st(),
        modificadoPor: alias, modificadoEn: st(),
      });
    }

    window.toast?.(ubicId ? "Ubicación actualizada." : "Ubicación agregada.", "success");
    document.getElementById("cli-ubic-modal").style.display = "none";
    _cargarUbicaciones(clienteDocId);
  } catch(e) {
    errEl.textContent = "Error: " + e.message;
    errEl.style.display = "block";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Guardar ubicación"; }
  }
}

// ══════════════════════════════════════════════════════════════
// ALTO/74 — Historial de pedidos del cliente en la ficha
// ══════════════════════════════════════════════════════════════
async function _cargarPedidosRecientes(clienteDocId, cliente) {
  const el = document.getElementById("cli-pedidos-recientes");
  if (!el) return;
  try {
    const cid = cliente?.clienteId;
    const nom = cliente?.nombre || "";
    let q2;
    if (cid) {
      q2 = query(collection(db, "pedidos"),
        where("clienteId","==", cid),
        orderBy("_ts","desc"), limit(8));
    } else {
      q2 = query(collection(db, "pedidos"),
        where("clienteNombre","==", nom),
        orderBy("_ts","desc"), limit(8));
    }
    const snap = await getDocs(q2);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!rows.length) {
      el.innerHTML = `<div style="text-align:center;padding:12px;color:#94A3B8;font-size:11px;
        border:1px dashed var(--border);border-radius:8px">Sin pedidos registrados</div>`;
      return;
    }
    const fmtTs = ts => ts
      ? new Date(typeof ts==="number"?ts:ts.toMillis?.()??ts)
          .toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"})
      : "—";
    const ESTADO = { CONFIRMADO:"🟡 Conf.",ENTREGADO:"🟢 Entregado",CANCELADO:"🔴 Cancel.",
      EN_PROCESO:"🔵 En proceso",PENDIENTE:"⚪ Pendiente" };
    el.innerHTML = `<div style="overflow-x:auto">
      <table class="data-table" style="font-size:11px">
        <thead><tr>
          <th>FECHA</th><th>FOLIO</th>
          <th style="text-align:right">TOTAL</th>
          <th>ESTADO</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td style="white-space:nowrap">${fmtTs(r._ts||r.fechaCreacion)}</td>
            <td style="font-family:monospace;font-size:10px">${esc(r.folio||r.id?.slice(-6)||"–")}</td>
            <td style="text-align:right;font-weight:700">${fmt.format(r.total||r.importe||0)}</td>
            <td>${ESTADO[r.estado]||esc(r.estado||"–")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  } catch(e) {
    const el2 = document.getElementById("cli-pedidos-recientes");
    if (el2) el2.innerHTML = `<div style="color:#DC2626;font-size:11px;padding:8px">
      Error al cargar pedidos: ${esc(e.message)}</div>`;
  }
}

// ══════════════════════════════════════════════════════════════
// BAJO/44 — Log de visitas estructurado
// Subcolección: clientes/{id}/visitas_log
// ══════════════════════════════════════════════════════════════
async function _cargarVisitasLog(clienteDocId) {
  const el = document.getElementById("cli-visitas-log");
  if (!el) return;
  try {
    const { getDocs: gd, collection: col, orderBy: ob, query: q2, limit: lmt } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const snap = await gd(q2(col(db, "clientes", clienteDocId, "visitas_log"), ob("_ts","desc"), lmt(5)));
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!rows.length) {
      el.innerHTML = `<div style="text-align:center;padding:12px;color:#94A3B8;font-size:11px;
        border:1px dashed var(--border);border-radius:8px">Sin visitas registradas</div>`;
      return;
    }
    const fmtTs = ts => ts
      ? new Date(typeof ts==="number"?ts:ts.toMillis?.()??ts)
          .toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"})
      : "—";
    const TIPO_ICON = { Visita:"🤝", Llamada:"📞", WhatsApp:"💬", Email:"📧", Virtual:"💻", Otro:"📋" };
    el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">
      ${rows.map(r => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--surface-2)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-size:16px">${TIPO_ICON[r.tipo]||"📋"}</span>
            <span style="font-size:11px;font-weight:700;color:var(--text-primary)">${esc(r.tipo||"Visita")}</span>
            <span style="font-size:10px;color:#94A3B8;margin-left:auto">${fmtTs(r._ts)}</span>
          </div>
          ${r.objetivo ? `<div style="font-size:11px;color:#64748B;margin-bottom:2px">
            <strong>Objetivo:</strong> ${esc(r.objetivo)}</div>` : ""}
          ${r.resultado ? `<div style="font-size:11px;color:var(--text-primary)">
            <strong>Resultado:</strong> ${esc(r.resultado)}</div>` : ""}
          ${r.proximaCita ? `<div style="font-size:10px;color:#7C3AED;margin-top:3px">
            📅 Próxima cita: ${esc(r.proximaCita)}</div>` : ""}
          <div style="font-size:10px;color:#94A3B8;margin-top:3px">Por ${esc(r.quienRegistro||"–")}</div>
        </div>`).join("")}
    </div>`;
  } catch(e) {
    const el2 = document.getElementById("cli-visitas-log");
    if (el2) el2.innerHTML = `<div style="color:#DC2626;font-size:11px;padding:8px">
      Error: ${esc(e.message)}</div>`;
  }
}

function _abrirFormVisita(clienteDocId) {
  // Mini-modal inline para registrar una visita
  const TIPOS = ["Visita","Llamada","WhatsApp","Email","Virtual","Otro"];
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2100;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.innerHTML = `
    <div style="background:var(--surface);border-radius:14px;width:460px;max-width:100%;
      border:1px solid var(--border);box-shadow:0 24px 64px rgba(0,0,0,.4);overflow:hidden">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
        <span style="font-size:18px">📅</span>
        <div style="flex:1;font-size:13px;font-weight:800">Nueva visita / actividad</div>
        <button id="_vis-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#64748B">✕</button>
      </div>
      <div style="padding:18px 20px;display:flex;flex-direction:column;gap:12px">
        <div>
          <div style="font-size:10px;font-weight:700;color:#64748B;text-transform:uppercase;margin-bottom:6px">Tipo de contacto</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${TIPOS.map((t,i) => `
              <button type="button" data-vis-tipo="${t}" onclick="window._visSelTipo('${t}')"
                style="padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;cursor:pointer;
                  border:1.5px solid ${i===0?"#7C3AED":"var(--border)"};
                  background:${i===0?"#F5F3FF":"transparent"};
                  color:${i===0?"#7C3AED":"var(--text-sec)"}">
                ${t}
              </button>`).join("")}
          </div>
          <input type="hidden" id="_vis-tipo" value="${TIPOS[0]}">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:4px">Objetivo de la visita</label>
          <input id="_vis-objetivo" type="text" placeholder="Presentar oferta, cobrar, seguimiento…"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:4px">Resultado</label>
          <textarea id="_vis-resultado" rows="2" placeholder="Qué pasó, compromisos, acuerdos…"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;resize:vertical"></textarea>
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:4px">Próxima cita / seguimiento</label>
          <input id="_vis-proxima" type="text" placeholder="ej. 2026-09-15 o 'en 2 semanas'"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border)">
        <button id="_vis-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);
          background:transparent;color:#94A3B8;font-size:12px;cursor:pointer">Cancelar</button>
        <button id="_vis-guardar" style="padding:8px 22px;border-radius:8px;border:none;
          background:#7C3AED;color:#fff;font-size:12px;font-weight:700;cursor:pointer">Registrar visita</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  window._visSelTipo = (val) => {
    document.getElementById("_vis-tipo").value = val;
    overlay.querySelectorAll("[data-vis-tipo]").forEach(btn => {
      const sel = btn.dataset.visTipo === val;
      btn.style.borderColor = sel ? "#7C3AED" : "var(--border)";
      btn.style.background  = sel ? "#F5F3FF" : "transparent";
      btn.style.color       = sel ? "#7C3AED" : "var(--text-sec)";
    });
  };

  const cerrar = () => { document.body.removeChild(overlay); delete window._visSelTipo; };
  overlay.querySelector("#_vis-close").onclick  = cerrar;
  overlay.querySelector("#_vis-cancel").onclick = cerrar;

  overlay.querySelector("#_vis-guardar").addEventListener("click", async () => {
    const tipo      = document.getElementById("_vis-tipo")?.value || "Visita";
    const objetivo  = document.getElementById("_vis-objetivo")?.value.trim() || "";
    const resultado = document.getElementById("_vis-resultado")?.value.trim() || "";
    const proxima   = document.getElementById("_vis-proxima")?.value.trim() || "";
    const btn = overlay.querySelector("#_vis-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const { addDoc: ad, collection: col } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      await ad(col(db, "clientes", clienteDocId, "visitas_log"), {
        tipo, objetivo, resultado, proximaCita: proxima,
        quienRegistro: window.Sesion?.alias ?? "web",
        _ts: Date.now()
      });
      // También actualizar ultimaVisita en el cliente padre
      await updateDoc(doc(db, "clientes", clienteDocId), { ultimaVisita: new Date() });
      window.toast?.("Visita registrada","success");
      cerrar();
      _cargarVisitasLog(clienteDocId);
    } catch(e) { window.toast?.("Error: " + e.message,"error"); }
    finally { btn.disabled = false; btn.textContent = "Registrar visita"; }
  });
}

// ══════════════════════════════════════════════════════════════
// MEDIO/58 — Clasificación ABC automática por volumen de compra
// ══════════════════════════════════════════════════════════════
async function _calcularABC() {
  if (_abcCargado) return;
  _abcCargado = true;
  try {
    const hace365 = Date.now() - 365 * 86400000;
    const q2 = query(
      collection(db, "pedidos"),
      where("estado","in",["CONFIRMADO","ENTREGADO"]),
      where("_ts",">=", hace365),
      limit(3000)
    );
    const snap = await getDocs(q2);
    const totales = {};  // clienteId → total
    snap.docs.forEach(d => {
      const data = d.data();
      const cid  = data.clienteId || data.clienteNombre || "";
      if (!cid) return;
      totales[cid] = (totales[cid] || 0) + (data.total || data.importe || 0);
    });

    // Ordenar por total desc y asignar A/B/C
    const sorted = Object.entries(totales).sort((a,b) => b[1] - a[1]);
    const n = sorted.length;
    const limA = Math.ceil(n * 0.20);  // top 20%
    const limB = Math.ceil(n * 0.50);  // siguiente 30% → hasta 50%

    const newMap = {};
    sorted.forEach(([cid, _], idx) => {
      newMap[cid] = idx < limA ? "A" : idx < limB ? "B" : "C";
    });

    // Mapear de clienteId → docId
    _abcMap = {};
    _clientes.forEach(c => {
      const cid = c.clienteId || c.nombre || "";
      if (newMap[cid]) _abcMap[c.id] = newMap[cid];
    });

    // Actualizar KPI y re-renderizar tabla
    const abcA = Object.values(_abcMap).filter(v => v === "A").length;
    const elA = document.getElementById("cli-k-abc-a");
    if (elA) elA.textContent = abcA.toLocaleString("es-MX");
    _renderTabla();
  } catch(e) { _abcCargado = false; console.warn("[ABC]", e.message); }
}

// ── Fotos del cliente (tomadas en APK, guardadas en Firebase Storage) ──
async function _verFotosCliente(clienteId, nombre) {
  const modal  = document.getElementById("cli-fotos-modal");
  const title  = document.getElementById("cli-fotos-title");
  const sub    = document.getElementById("cli-fotos-sub");
  const body   = document.getElementById("cli-fotos-body");
  if (!modal || !body) return;

  if (title) title.textContent = `📷 Fotos — ${nombre || clienteId}`;
  if (sub)   sub.textContent   = "Cargando fotos registradas desde el APK…";
  body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-sec)">Cargando…</div>`;
  modal.style.display = "flex";
  document.body.style.overflow = "hidden";
  _openTrap("cli-fotos-modal", () => window.ClientesUI.cerrarFotos());

  try {
    const { getStorage, ref, listAll, getDownloadURL } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js");
    const storage = getStorage();

    // Rutas donde el APK puede guardar fotos del cliente
    const paths = [
      `fotos/clientes/${clienteId}`,
      `clientes/${clienteId}/fotos`,
      `visitas/fotos/${clienteId}`,
    ];

    let items = [];
    for (const path of paths) {
      try {
        const result = await listAll(ref(storage, path));
        items = [...items, ...result.items];
        // También busca en subcarpetas (ej. fechas)
        for (const prefix of result.prefixes) {
          try {
            const sub2 = await listAll(prefix);
            items = [...items, ...sub2.items];
          } catch {}
        }
      } catch {}
    }

    if (!items.length) {
      body.innerHTML = `
        <div style="text-align:center;padding:32px;color:var(--text-sec)">
          <div style="font-size:40px;margin-bottom:12px">📷</div>
          <div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:6px">Sin fotos registradas</div>
          <div style="font-size:12px">Las fotos tomadas por el ingeniero en el APK aparecerán aquí automáticamente.</div>
          <div style="font-size:11px;color:#9CA3AF;margin-top:10px">
            Rutas buscadas: ${paths.map(p => `<code>${p}</code>`).join(", ")}
          </div>
        </div>`;
      if (sub) sub.textContent = "Sin fotos registradas";
      return;
    }

    if (sub) sub.textContent = `${items.length} foto${items.length !== 1 ? "s" : ""}`;

    // Obtener URLs de descarga en paralelo
    const urls = await Promise.all(items.map(async item => {
      try {
        const url  = await getDownloadURL(item);
        const name = item.name;
        const ts   = name.match(/(\d{8,})/)?.[1] ?? "";
        const date = ts.length >= 8
          ? new Date(+ts).toLocaleDateString("es-MX", { day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" })
          : name;
        return { url, name, date };
      } catch { return null; }
    }));

    const validas = urls.filter(Boolean);

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px">
        ${validas.map(({ url, name, date }) => `
          <a href="${url}" target="_blank" rel="noopener"
            style="display:block;border-radius:8px;overflow:hidden;border:1px solid var(--border);
              text-decoration:none;transition:transform .1s"
            onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform=''">
            <img src="${url}" alt="${esc(name)}" loading="lazy"
              style="width:100%;aspect-ratio:1;object-fit:cover;display:block;background:var(--surface-2)">
            <div style="padding:6px 8px;background:var(--surface)">
              <div style="font-size:10px;color:var(--text-sec);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                ${esc(date)}
              </div>
            </div>
          </a>`).join("")}
      </div>`;
  } catch(e) {
    body.innerHTML = `<div style="text-align:center;padding:24px;color:#DC2626;font-size:13px">
      Error: ${esc(e.message)}</div>`;
    if (sub) sub.textContent = "Error al cargar";
  }
}

