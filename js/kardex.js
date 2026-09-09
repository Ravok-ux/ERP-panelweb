// ══════════════════════════════════════════════════════════════
// kardex.js — Historial de movimientos de inventario
// ══════════════════════════════════════════════════════════════

import { db }    from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, norm } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, query, orderBy, limit, where,
  onSnapshot, getDocs, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { exportarExcel } from "./excel-utils.js";

const fmtNum = v => new Intl.NumberFormat("es-MX").format(v ?? 0);
const fmtTs  = m => {
  // Intenta _ts primero (Firestore timestamp), luego timestamp (Date/número)
  const raw = m._ts || m.timestamp || m.creadoEn || m.fecha;
  if (!raw) return "—";
  const d = raw?.toDate ? raw.toDate() : new Date(raw);
  if (isNaN(d)) return "—";
  return d.toLocaleString("es-MX", {
    day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  });
};

// Tipos conocidos — light-theme safe (fondo claro, texto oscuro)
// Incluye tipos del APK (CARGA, DESCARGA, VENTA, TRANSFERENCIA) y del panel web
const TIPO_META = {
  ENTRADA:          { bg:"#DCFCE7", text:"#166534", icon:"↑", label:"Entrada"         },
  SALIDA:           { bg:"#FEE2E2", text:"#991B1B", icon:"↓", label:"Salida"          },
  AJUSTE:           { bg:"#DBEAFE", text:"#1E40AF", icon:"±", label:"Ajuste"          },
  AJUSTE_ENTRADA:   { bg:"#D1FAE5", text:"#065F46", icon:"↑±",label:"Ajuste Entrada"  },
  AJUSTE_SALIDA:    { bg:"#FEE2E2", text:"#7F1D1D", icon:"↓±",label:"Ajuste Salida"  },
  AJUSTE_INVENTARIO:{ bg:"#EDE9FE", text:"#4C1D95", icon:"≡", label:"Ajuste Inv."    },
  EDITAR_MINIMO:    { bg:"#FEF3C7", text:"#78350F", icon:"⚙", label:"Edit. Mínimo"  },
  REABASTO_SURTIDO: { bg:"#E0F2FE", text:"#0C4A6E", icon:"📦",label:"Reabasto"       },
  DEVOLUCION:       { bg:"#F5F3FF", text:"#5B21B6", icon:"↩", label:"Devolución"     },
  TRASLADO:         { bg:"#F3F4F6", text:"#374151", icon:"⇄", label:"Traslado"       },
  // APK types
  CARGA:            { bg:"#ECFDF5", text:"#047857", icon:"🚚", label:"Carga Vehículo" },
  DESCARGA:         { bg:"#FFF7ED", text:"#9A3412", icon:"↩🚚",label:"Descarga Vehículo"},
  VENTA:            { bg:"#FEF9C3", text:"#713F12", icon:"💰", label:"Venta"          },
  TRANSFERENCIA:    { bg:"#EFF6FF", text:"#1D4ED8", icon:"⇄",  label:"Transferencia"  },
};
const _meta = tipo => TIPO_META[tipo] || { bg:"#F3F4F6", text:"#374151", icon:"•", label: tipo || "—" };

const TIPOS_AJUSTE = ["AJUSTE","AJUSTE_ENTRADA","AJUSTE_SALIDA","AJUSTE_INVENTARIO","EDITAR_MINIMO"];

let _unsub        = null;
let _alertasUnsub = null;
let _movimientos  = [];
let _filtroTipo   = "";
let _filtroProd   = "";
let _productosCache = [];

// ── Módulo ────────────────────────────────────────────────────
export const KardexModule = {
  mount(container) {
    if (!Sesion.esSuperAdmin?.() &&
        !["GERENTE","ADMINISTRADOR","ALMACENISTA","MESA_CONTROL"].includes(Sesion.rol)) {
      container.innerHTML = `<div style="padding:60px;text-align:center;color:#9CA3AF">
        🔒 Acceso restringido</div>`;
      return;
    }
    cargarNombres();
    _filtroTipo = ""; _filtroProd = ""; _movimientos = [];
    container.innerHTML = _html();
    _bindUI(container);
    _escuchar();
    _escucharAlertas();
    _cargarProductos();
  },
  destroy() {
    _unsub?.();         _unsub = null;
    _alertasUnsub?.();  _alertasUnsub = null;
    _movimientos = [];
    delete window.KardexUI;
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  const tipoOpts = Object.entries(TIPO_META)
    .map(([v, m]) => `<option value="${v}">${m.icon} ${m.label}</option>`).join("");

  return `
  <style>
    .kx-kpi { padding:14px 16px;border-right:1px solid var(--border) }
    .kx-kpi-val { font-size:22px;font-weight:800;font-variant-numeric:tabular-nums }
    .kx-kpi-lbl { font-size:10px;font-weight:600;color:#9CA3AF;
      text-transform:uppercase;letter-spacing:.05em;margin-top:2px }
    .kx-tabla-wrap { overflow-x:auto }
    .kx-tabla { width:100%;border-collapse:collapse;font-size:12.5px }
    .kx-tabla th { background:var(--surface);padding:9px 13px;
      text-align:left;font-size:10px;font-weight:700;color:#9CA3AF;
      text-transform:uppercase;letter-spacing:.06em;
      border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0;z-index:1 }
    .kx-tabla th.r { text-align:right }
    .kx-tabla td { padding:9px 13px;border-bottom:1px solid var(--border);vertical-align:middle }
    .kx-tabla tbody tr:last-child td { border-bottom:none }
    .kx-tabla tbody tr:hover { background:var(--surface) }
    .kx-chip { display:inline-flex;align-items:center;gap:3px;padding:3px 8px;
      border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap }
    .kx-dd-item { padding:8px 12px;cursor:pointer;font-size:12px;
      border-bottom:1px solid var(--border) }
    .kx-dd-item:hover { background:var(--surface) }
    .kx-pill { padding:5px 12px;border-radius:20px;border:1.5px solid;
      font-size:11.5px;font-weight:600;cursor:pointer;transition:all .15s;background:transparent }
  </style>

  <div style="display:flex;flex-direction:column;gap:0">

    <!-- Encabezado -->
    <div style="display:flex;align-items:center;gap:10px;padding:14px 0 12px;flex-wrap:wrap">
      <div>
        <div style="font-size:14px;font-weight:800">📋 Kardex de inventario</div>
        <div style="font-size:11px;color:#9CA3AF" id="kx-subtitle">Cargando…</div>
      </div>
      <div style="flex:1"></div>

      <!-- Búsqueda -->
      <div style="position:relative;width:230px">
        <input id="kx-buscar" type="search" placeholder="Buscar producto…" autocomplete="off"
          style="width:100%;border:1px solid var(--border);border-radius:7px;padding:7px 10px;
            font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        <div id="kx-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
          background:var(--surface);border:1px solid var(--border);border-radius:8px;
          box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:200;max-height:220px;
          overflow-y:auto;margin-top:3px"></div>
      </div>

      <!-- Tipo -->
      <select id="kx-tipo"
        style="border:1px solid var(--border);border-radius:7px;padding:7px 10px;
          font-size:12px;background:var(--surface);color:var(--text-primary)">
        <option value="">Todos los tipos</option>
        ${tipoOpts}
      </select>

      <!-- Excel -->
      <button id="kx-excel"
        style="padding:7px 14px;background:#16A34A;color:#fff;border:none;
          border-radius:7px;cursor:pointer;font-size:13px;font-weight:600">
        ⬇ Excel
      </button>
    </div>

    <!-- KPIs -->
    <div style="display:grid;grid-template-columns:repeat(5,1fr);
      border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:14px">
      <div class="kx-kpi">
        <div class="kx-kpi-lbl">Total movimientos</div>
        <div class="kx-kpi-val" id="kx-k-total" style="color:var(--text-primary)">—</div>
      </div>
      <div class="kx-kpi">
        <div class="kx-kpi-lbl">↑ Entradas</div>
        <div class="kx-kpi-val" id="kx-k-entrada" style="color:#16A34A">—</div>
      </div>
      <div class="kx-kpi">
        <div class="kx-kpi-lbl">↓ Salidas</div>
        <div class="kx-kpi-val" id="kx-k-salida" style="color:#DC2626">—</div>
      </div>
      <div class="kx-kpi">
        <div class="kx-kpi-lbl">± Ajustes</div>
        <div class="kx-kpi-val" id="kx-k-ajuste" style="color:#2563EB">—</div>
      </div>
      <div class="kx-kpi" style="border-right:none">
        <div class="kx-kpi-lbl">⚠ Stock bajo</div>
        <div class="kx-kpi-val" id="kx-k-alertas" style="color:#D97706">—</div>
      </div>
    </div>

    <!-- Barra de alertas -->
    <div id="kx-alertas-bar" style="display:none;background:#FEF3C7;border:1px solid #FDE68A;
      border-radius:8px;padding:9px 14px;margin-bottom:10px;
      display:none;align-items:center;gap:8px;font-size:12px;color:#78350F">
      <span style="font-weight:700">⚠ Stock bajo:</span>
      <span id="kx-alertas-lista" style="flex:1"></span>
      <button id="kx-resolver"
        style="font-size:11px;font-weight:700;color:#78350F;background:#FDE68A;
          border:none;border-radius:5px;padding:3px 10px;cursor:pointer">
        Marcar revisadas
      </button>
    </div>

    <!-- Tabla -->
    <div class="kx-tabla-wrap" style="border:1px solid var(--border);border-radius:10px">
      <table class="kx-tabla">
        <thead><tr>
          <th style="width:130px">Tipo</th>
          <th>Producto</th>
          <th class="r" style="width:90px">Cantidad</th>
          <th class="r" style="width:80px">Antes</th>
          <th class="r" style="width:80px">Después</th>
          <th>Motivo / Ref</th>
          <th>Registrado por</th>
          <th style="width:160px">Fecha</th>
        </tr></thead>
        <tbody id="kx-tbody">
          <tr><td colspan="8" style="padding:48px;text-align:center;color:#9CA3AF">
            Cargando movimientos…</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;
}

// ── Firestore ─────────────────────────────────────────────────
function _escuchar() {
  _unsub?.();
  // Sin orderBy: trae todos y ordena client-side para no depender del campo _ts
  _unsub = onSnapshot(
    query(collection(db, "movimientos_stock"), limit(300)),
    snap => {
      _movimientos = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const ta = a._ts?.toDate?.() || new Date(a.timestamp || a.creadoEn || 0);
          const tb = b._ts?.toDate?.() || new Date(b.timestamp || b.creadoEn || 0);
          return tb - ta;
        });
      _renderKPIs();
      _renderTabla();
      const el = document.getElementById("kx-subtitle");
      if (el) el.textContent = `${_movimientos.length} movimientos recientes`;
    },
    err => {
      console.error("[Kardex]", err);
      const tbody = document.getElementById("kx-tbody");
      if (tbody) tbody.innerHTML = `<tr><td colspan="8"
        style="padding:40px;text-align:center;color:#DC2626">
        Error: ${err.message}</td></tr>`;
    }
  );
}

function _escucharAlertas() {
  _alertasUnsub?.();
  // Solo where, sin orderBy para evitar índice compuesto requerido
  _alertasUnsub = onSnapshot(
    query(collection(db, "alertas_stock"), where("resuelta", "==", false), limit(50)),
    snap => {
      const alertas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const bar   = document.getElementById("kx-alertas-bar");
      const lista = document.getElementById("kx-alertas-lista");
      const kxAl  = document.getElementById("kx-k-alertas");
      if (kxAl) kxAl.textContent = alertas.length;
      if (!bar) return;
      if (!alertas.length) { bar.style.display = "none"; return; }
      bar.style.display = "flex";
      if (lista) lista.textContent = alertas.slice(0, 6)
        .map(a => `${a.nombreProducto} (${a.stockActual}/${a.stockMinimo})`).join(" · ");
      _setBadgeSidebar(alertas.length);
    },
    err => console.error("[Kardex/alertas]", err)
  );
}

// ── Render ────────────────────────────────────────────────────
function _renderKPIs() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("kx-k-total",   _movimientos.length);
  set("kx-k-entrada", _movimientos.filter(m => m.tipo === "ENTRADA").length);
  set("kx-k-salida",  _movimientos.filter(m => m.tipo === "SALIDA").length);
  set("kx-k-ajuste",  _movimientos.filter(m => TIPOS_AJUSTE.includes(m.tipo)).length);
}

function _renderTabla() {
  const tbody = document.getElementById("kx-tbody");
  if (!tbody) return;

  const q = norm(_filtroProd);
  let lista = _movimientos;
  if (_filtroTipo) lista = lista.filter(m => m.tipo === _filtroTipo);
  if (q) lista = lista.filter(m => norm(m.nombreProducto).includes(q) ||
                                    norm(m.codigoN10||m.codigo).includes(q));

  if (!lista.length) {
    const msg = _movimientos.length === 0
      ? "Sin movimientos de inventario registrados aún."
      : "Sin movimientos para los filtros seleccionados.";
    tbody.innerHTML = `<tr><td colspan="8" style="padding:48px;text-align:center;color:#9CA3AF">${msg}</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.slice(0, 200).map(m => {
    const meta = _meta(m.tipo);
    const ref  = m.folioPedido ? `Pedido ${esc(m.folioPedido)}` : esc(m.motivo || m.referencia || "—");
    const cant = m.tipo === "SALIDA" || m.tipo === "AJUSTE_SALIDA"
      ? `<span style="color:#DC2626;font-weight:700">−${fmtNum(m.cantidad)}</span>`
      : `<span style="color:#16A34A;font-weight:700">+${fmtNum(m.cantidad)}</span>`;
    return `<tr>
      <td>
        <span class="kx-chip" style="background:${meta.bg};color:${meta.text}">
          ${meta.icon} ${meta.label}
        </span>
      </td>
      <td style="font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;
        white-space:nowrap" title="${esc(m.nombreProducto||"")}">
        ${esc(m.nombreProducto || "—")}
        ${m.codigoN10 ? `<span style="font-size:10px;color:#9CA3AF;margin-left:4px">${esc(m.codigoN10)}</span>` : ""}
      </td>
      <td style="text-align:right">${cant}</td>
      <td style="text-align:right;color:#9CA3AF;font-variant-numeric:tabular-nums">${fmtNum(m.stockAntes)}</td>
      <td style="text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${fmtNum(m.stockDespues)}</td>
      <td style="color:#9CA3AF;max-width:180px;overflow:hidden;text-overflow:ellipsis;
        white-space:nowrap" title="${ref}">${ref}</td>
      <td style="color:#9CA3AF;white-space:nowrap">${esc(resolverNombre(m.quienRegistro || m.ingenieroAlias || m.alias) || "—")}</td>
      <td style="color:#9CA3AF;white-space:nowrap;font-size:11.5px">${fmtTs(m)}</td>
    </tr>`;
  }).join("");
}

// ── Autocomplete productos ────────────────────────────────────
async function _cargarProductos() {
  try {
    const snap = await getDocs(query(collection(db, "productos"), limit(500)));
    _productosCache = snap.docs.map(d => ({
      id:       d.id,
      nombre:   d.data().nombre || "",
      codigo:   d.data().codigoN10 || d.data().codigo || ""
    }));
  } catch(e) { console.warn("[Kardex/productos]", e); }
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI(container) {
  // Búsqueda con autocomplete
  const input = container.querySelector("#kx-buscar");
  const dd    = container.querySelector("#kx-dd");
  if (input && dd) {
    input.addEventListener("input", () => {
      _filtroProd = input.value.trim();
      _renderTabla();
      const q = norm(_filtroProd);
      if (q.length < 2) { dd.style.display = "none"; return; }
      const matches = _productosCache
        .filter(p => norm(p.nombre).includes(q) || norm(p.codigo).includes(q))
        .slice(0, 12);
      if (!matches.length) { dd.style.display = "none"; return; }
      dd.innerHTML = matches.map(p =>
        `<div class="kx-dd-item" data-nombre="${esc(p.nombre)}">
          <span style="font-weight:600">${esc(p.nombre)}</span>
          ${p.codigo ? `<span style="font-size:10px;color:#9CA3AF;margin-left:6px">${esc(p.codigo)}</span>` : ""}
        </div>`).join("");
      dd.style.display = "block";
      dd.querySelectorAll(".kx-dd-item").forEach(el =>
        el.addEventListener("mousedown", e => {
          e.preventDefault();
          input.value = el.dataset.nombre;
          _filtroProd = el.dataset.nombre;
          dd.style.display = "none";
          _renderTabla();
        }));
    });
    input.addEventListener("blur", () => setTimeout(() => { dd.style.display = "none"; }, 150));
    input.addEventListener("keydown", e => {
      if (e.key === "Escape") { dd.style.display = "none"; input.value = ""; _filtroProd = ""; _renderTabla(); }
    });
  }

  // Filtro tipo
  container.querySelector("#kx-tipo")?.addEventListener("change", e => {
    _filtroTipo = e.target.value;
    _renderTabla();
  });

  // Excel
  container.querySelector("#kx-excel")?.addEventListener("click", _exportar);

  // Resolver alertas
  container.querySelector("#kx-resolver")?.addEventListener("click", _resolverAlertas);
}

// ── Alertas: resolver ─────────────────────────────────────────
async function _resolverAlertas() {
  if (!await window.modal?.({
    title:"Resolver alertas",
    message:"¿Marcar como revisadas todas las alertas de stock bajo?",
    confirmLabel:"Marcar todas"
  })) return;
  try {
    const snap = await getDocs(
      query(collection(db, "alertas_stock"), where("resuelta", "==", false))
    );
    await Promise.all(snap.docs.map(d =>
      updateDoc(d.ref, { resuelta:true, fechaResolucion: serverTimestamp() })
    ));
    window.toast?.("Alertas marcadas como revisadas", "success");
  } catch(e) { window.toast?.("Error: " + e.message, "error"); }
}

// ── Exportar ──────────────────────────────────────────────────
function _exportar() {
  const rows = _movimientos.map(m => ({
    tipo:           m.tipo || "",
    nombreProducto: m.nombreProducto || "",
    codigo:         m.codigoN10 || m.codigo || "",
    cantidad:       m.cantidad ?? 0,
    stockAntes:     m.stockAntes ?? 0,
    stockDespues:   m.stockDespues ?? 0,
    motivo:         m.folioPedido ? `Pedido ${m.folioPedido}` : (m.motivo || ""),
    quienRegistro:  m.quienRegistro || m.ingenieroAlias || m.alias || "",
    fecha:          fmtTs(m),
  }));
  exportarExcel(rows, [
    { key:"tipo",           header:"Tipo",           width:16 },
    { key:"nombreProducto", header:"Producto",        width:30 },
    { key:"codigo",         header:"Código",          width:14 },
    { key:"cantidad",       header:"Cantidad",        width:12, tipo:"numero" },
    { key:"stockAntes",     header:"Stock antes",     width:12, tipo:"numero" },
    { key:"stockDespues",   header:"Stock después",   width:14, tipo:"numero" },
    { key:"motivo",         header:"Motivo / Ref",    width:22 },
    { key:"quienRegistro",  header:"Registrado por",  width:18 },
    { key:"fecha",          header:"Fecha",           width:22 },
  ], "Kardex_" + new Date().toISOString().slice(0,10));
}

// ── Helpers ───────────────────────────────────────────────────
function _setBadgeSidebar(count) {
  const sbItem = document.querySelector('[data-view="kardex"]') ||
                 document.querySelector('[data-view="compras"]');
  if (!sbItem) return;
  let badge = sbItem.querySelector(".sb-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "sb-badge";
    badge.style.cssText = "background:#EF4444;color:#fff;font-size:9px;font-weight:800;" +
      "border-radius:999px;padding:1px 5px;margin-left:auto";
    sbItem.appendChild(badge);
  }
  badge.textContent = count > 0 ? count : "";
  badge.style.display = count > 0 ? "" : "none";
}
