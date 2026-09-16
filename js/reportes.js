// ══════════════════════════════════════════════════════════════
// reportes.js — Generación de reportes por período
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import {
  collection, query, where, getDocs, orderBy, Timestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";

let _periodo      = "mes";
let _tipo         = "comisiones"; // cartera | visitas | comisiones | ventas | productos
let _fechaDesde   = null; // Date | null — rango personalizado
let _fechaHasta   = null;
let _filtroIng    = ""; // filtro de ingeniero en ventas ejecutivas

const META_KEY = "n10_meta_mensual";
function _getMeta() { return Number(localStorage.getItem(META_KEY)) || 150000; }
function _setMeta(v) { const n = Number(v); if (n > 0) localStorage.setItem(META_KEY, n); }

export const ReportesModule = {
  mount(container) {
    cargarNombres();
    _periodo    = "mes";
    _tipo       = "comisiones";
    _fechaDesde = null;
    _fechaHasta = null;
    _filtroIng  = "";
    _csvData    = [];
    container.innerHTML = _html();
    document.getElementById("rp-tbody").innerHTML = window.skeleton?.(5, 5) ?? "";
    _bindUI();
    _cargarDatos();
    return () => {};
  },

  destroy() {
    _periodo    = "mes";
    _tipo       = "comisiones";
    _fechaDesde = null;
    _fechaHasta = null;
    _filtroIng  = "";
    _csvData    = [];
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  const hoy = new Date();
  const fmtFecha = d => d.toLocaleDateString("es-MX", { day:"numeric", month:"short", year:"numeric" });

  return `
  <div class="report-body">

    <!-- Selector de tipo de reporte -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
      padding:10px 18px;margin-bottom:10px;display:flex;align-items:center;gap:8px;
      box-shadow:0 1px 3px rgba(0,0,0,.06);flex-wrap:wrap">
      <span style="font-size:11px;font-weight:700;color:var(--text-sec)">REPORTE:</span>
      ${[
        ["comisiones", "📊 Comisiones"],
        ["ventas",     "💰 Ventas ejecutivas"],
        ["productos",  "📦 Top productos"],
        ["cartera",    "📋 Cartera"],
        ["visitas",    "🗺️ Visitas"],
        ["tendencia",  "📈 Tendencia"]
      ].map(([t, lbl]) => `
        <button class="filter-pill ${t==="comisiones"?"active":""}" data-tipo="${t}"
          onclick="ReportUI.setTipo('${t}')">${lbl}</button>`).join("")}
      <div style="flex:1"></div>
      <button onclick="ReportUI.exportarPDF()" class="btn-export pdf">↓ PDF</button>
      <button onclick="ReportUI.exportarExcel()" style="padding:7px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">⬇️ Excel</button>
    </div>

    <!-- Selector de período (oculto para cartera) -->
    <div id="rp-periodo-bar" style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
      padding:10px 18px;margin-bottom:10px;display:flex;align-items:center;gap:10px;
      box-shadow:0 1px 3px rgba(0,0,0,.06);flex-wrap:wrap">
      <span style="font-size:12px;font-weight:700;color:var(--text-primary)">Período:</span>
      ${["hoy","semana","mes","trimestre"].map(p => `
        <button class="filter-pill ${p==="mes"?"active":""}" data-periodo="${p}"
          onclick="ReportUI.setPeriodo('${p}')">
          ${{hoy:"Hoy",semana:"Esta semana",mes:"Este mes",trimestre:"Trimestre"}[p]}
        </button>`).join("")}
      <!-- Rango personalizado -->
      <span style="font-size:11px;font-weight:700;color:var(--text-sec)">Desde</span>
      <input type="date" id="rp-desde" class="sel-sm" style="padding:4px 8px"
        onchange="ReportUI.setRango()">
      <span style="font-size:11px;color:var(--text-sec)">hasta</span>
      <input type="date" id="rp-hasta" class="sel-sm" style="padding:4px 8px"
        onchange="ReportUI.setRango()">
      <div style="flex:1"></div>
      <!-- Filtro ingeniero (solo visible en ventas) -->
      <select id="rp-filtro-ing" style="display:none;padding:4px 8px;border:1px solid var(--border);
        border-radius:6px;background:var(--surface);color:var(--text-primary);font-size:12px"
        onchange="ReportUI.setFiltroIng(this.value)">
        <option value="">Todos los ingenieros</option>
      </select>
      <label id="rp-meta-wrap" style="font-size:11px;font-weight:700;color:var(--text-sec);display:flex;align-items:center;gap:6px">
        META $
        <input id="rp-meta-input" type="number" min="1" step="1000" value="${_getMeta()}"
          style="width:90px;padding:3px 7px;border:1px solid var(--border);border-radius:6px;
                 font-size:12px;font-weight:700;color:var(--text-primary);background:var(--surface)"
          onchange="ReportUI.setMeta(this.value)">
      </label>
    </div>

    <!-- Papel del reporte -->
    <div class="report-paper" id="reporte-papel">
      <!-- Header -->
      <div class="report-header">
        <div>
          <div class="report-logo">N·10</div>
          <div class="report-logo-sub">NUTRICIÓN DE 10</div>
        </div>
        <div class="report-meta">
          <strong id="rp-titulo">Reporte de comisiones y rendimiento</strong>
          <span id="rp-periodo-label">Semana actual · ${fmtFecha(hoy)}</span>
        </div>
      </div>

      <!-- KPIs resumen -->
      <div class="report-kpis" id="rp-kpis"></div>

      <!-- Tabla principal -->
      <div class="report-table-wrap">
        <div class="report-section-title" id="rp-section-title">Rendimiento por ingeniero</div>
        <div style="overflow-x:auto">
          <table class="report-table" id="rp-tabla">
            <thead id="rp-thead"></thead>
            <tbody id="rp-tbody">
              <tr><td colspan="9" style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">
                Cargando datos…
              </td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Footer -->
      <div class="report-footer">
        <span>N-10 Analytics ERP · Generado por ${Sesion.alias}</span>
        <span id="rp-footer-ts">–</span>
      </div>
    </div>
  </div>`;
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI() {
  window.ReportUI = {
    setTipo(t) {
      _tipo = t;
      _filtroIng = "";
      document.querySelectorAll("[data-tipo]").forEach(b =>
        b.classList.toggle("active", b.dataset.tipo === t));
      const periodoBar  = document.getElementById("rp-periodo-bar");
      const metaWrap    = document.getElementById("rp-meta-wrap");
      const filtroIng   = document.getElementById("rp-filtro-ing");
      const tableWrap   = document.querySelector("#reporte-papel .report-table-wrap");
      const chartArea   = document.getElementById("rp-chart-area");
      if (periodoBar) periodoBar.style.display = (t === "cartera" || t === "tendencia") ? "none" : "";
      if (metaWrap)   metaWrap.style.display   = t !== "comisiones" ? "none" : "";
      if (filtroIng)  { filtroIng.style.display = t === "ventas" ? "" : "none"; filtroIng.value = ""; }
      // Mostrar tabla para todos excepto tendencia; la tendencia gestiona su propio layout
      if (tableWrap) tableWrap.style.display = t === "tendencia" ? "none" : "";
      if (chartArea && t !== "tendencia") chartArea.style.display = "none";
      _cargarDatos();
    },
    setPeriodo(p) {
      _periodo = p;
      document.querySelectorAll("[data-periodo]").forEach(b =>
        b.classList.toggle("active", b.dataset.periodo === p));
      _cargarDatos();
    },
    setMeta(v) { _setMeta(v); _cargarDatos(); },
    setRango() {
      const d = document.getElementById("rp-desde")?.value;
      const h = document.getElementById("rp-hasta")?.value;
      if (d && h) {
        _fechaDesde = new Date(d + "T00:00:00");
        _fechaHasta = new Date(h + "T23:59:59");
        // Desactivar pills de período
        document.querySelectorAll("[data-periodo]").forEach(b => b.classList.remove("active"));
        _cargarDatos();
      }
    },
    setFiltroIng(v) { _filtroIng = v; _cargarDatos(); },
    exportarPDF() { window.print(); },
    exportarExcel() { _exportarExcel(); }
  };
}

// ── Despacho de carga ─────────────────────────────────────────
function _cargarDatos() {
  _setText("rp-footer-ts", "Datos al " + new Date().toLocaleString("es-MX"));
  _setLoading();
  if (_tipo === "cartera")        _cargarCartera();
  else if (_tipo === "visitas")   _cargarVisitas();
  else if (_tipo === "ventas")    _cargarVentasEjecutivas();
  else if (_tipo === "productos") _cargarTopProductos();
  else if (_tipo === "tendencia") _cargarTendencia();
  else                            _cargarComisiones();
}

function _setLoading(cols = 6) {
  const tbody = document.getElementById("rp-tbody");
  if (tbody) tbody.innerHTML = window.skeletonRows?.(6, cols) ??
    `<tr><td colspan="${cols}" style="padding:20px;text-align:center;color:var(--text-muted)">
      <div class="spinner" style="margin:0 auto"></div>
    </td></tr>`;
}

// ── Helper: query pedidos en rango (Timestamp + número) ──────
// Firestore filtra por tipo: where(>=Timestamp) nunca devuelve docs
// con fechaPedido guardado como número (ms). Esta función hace ambas
// queries y elimina duplicados por docId.
async function _queryPedidosRango(desde, hasta) {
  const [tsSnap, numSnap] = await Promise.all([
    getDocs(query(collection(db,"pedidos"),
      where("fechaPedido",">=",Timestamp.fromDate(desde)),
      where("fechaPedido","<=",Timestamp.fromDate(hasta)))),
    getDocs(query(collection(db,"pedidos"),
      where("fechaPedido",">=",desde.getTime()),
      where("fechaPedido","<=",hasta.getTime()))).catch(()=>({docs:[]}))
  ]);
  const seen = new Set();
  const docs = [];
  for (const d of [...tsSnap.docs, ...(numSnap.docs||[])]) {
    if (!seen.has(d.id)) { seen.add(d.id); docs.push(d); }
  }
  return docs;
}

// ── REPORTE 1: Comisiones / Rendimiento ───────────────────────
async function _cargarComisiones() {
  _setText("rp-titulo", "Reporte de comisiones y rendimiento");
  _setText("rp-section-title", "Rendimiento por ingeniero");

  const { desde, hasta, label } = _rangoPeriodo();
  _setText("rp-periodo-label", label);

  const thead = document.getElementById("rp-thead");
  if (thead) thead.innerHTML = `<tr style="border-bottom:2px solid var(--border)">
    <th>#</th><th>INGENIERO</th><th>VENDIDO</th><th>META</th>
    <th>AVANCE</th><th>COBRADO</th><th>PEDIDOS</th><th>CARTERA</th><th>STATUS</th>
  </tr>`;

  try {
    // Abonos están embebidos en remisiones_credito (campo abonos[])
    // No existe colección abonos_remision independiente
    const [pedidosDocs, remSnap] = await Promise.all([
      _queryPedidosRango(desde, hasta),
      getDocs(query(collection(db,"remisiones_credito"), limit(2000)))
    ]);

    const desdeMs = desde.getTime(), hastaMs = hasta.getTime();
    const STATI_OK = new Set(["CONFIRMADO","ENTREGADO","confirmado","entregado","Confirmado","Entregado"]);
    const stats = {};
    pedidosDocs.forEach(d => {
      const p = d.data();
      if (!STATI_OK.has(p.status)) return;
      const alias = resolverNombre(p.ingenieroAlias || p.vendedor || p.alias || "–");
      if (!stats[alias]) stats[alias] = { vendido:0, cobrado:0, pedidos:0 };
      stats[alias].vendido  += p.monto || p.total || 0;
      stats[alias].pedidos  += 1;
    });
    remSnap.forEach(d => {
      const r = d.data();
      const abonos = r.abonos ?? [];
      abonos.forEach(a => {
        // fecha abono es ISO string: "2026-09-15"
        const abonoMs = new Date(a.fecha + (a.fecha?.includes("T") ? "" : "T12:00:00")).getTime();
        if (!abonoMs || abonoMs < desdeMs || abonoMs > hastaMs) return;
        const alias = resolverNombre(a.quienRegistro || r.ingenieroAlias || r.aliasVendedor || "–");
        if (!stats[alias]) stats[alias] = { vendido:0, cobrado:0, pedidos:0 };
        stats[alias].cobrado += a.monto || 0;
      });
    });

    const META = _getMeta();
    const ranking = Object.entries(stats).sort((a,b) => b[1].vendido - a[1].vendido);
    const totalVendido = ranking.reduce((s,[,v]) => s + v.vendido, 0);
    const totalCobrado = ranking.reduce((s,[,v]) => s + v.cobrado, 0);
    const totalPedidos = ranking.reduce((s,[,v]) => s + v.pedidos, 0);

    _renderKPIs([
      [_fmt(totalVendido),"TOTAL VENDIDO"],
      [_fmt(totalCobrado),"COBRADO"],
      [String(totalPedidos),"PEDIDOS"],
      [String(ranking.length),"INGENIEROS"]
    ]);

    _renderTabla(ranking.length === 0 ? null : ranking.map(([alias, s], i) => {
      const pct  = Math.min(Math.round((s.vendido / META) * 100), 100);
      const barC = pct >= 70 ? "#16A34A" : pct >= 40 ? "#D97706" : "#DC2626";
      const tag  = pct >= 70 ? ["tg","✓ Meta cercana"] : pct >= 40 ? ["ta","⚠ Atención"] : ["tr","✗ Bajo meta"];
      return `<tr>
        <td style="font-weight:800;color:${barC}">${i+1}</td>
        <td class="txt" style="font-weight:700">${esc(alias)}</td>
        <td style="font-weight:700;font-variant-numeric:tabular-nums">${_fmt(s.vendido)}</td>
        <td style="font-variant-numeric:tabular-nums">${_fmt(META)}</td>
        <td>
          <div style="font-size:10px;font-weight:700;color:${barC}">${pct}%</div>
          <div style="height:4px;background:#E5E7EB;border-radius:2px;margin-top:2px;width:70px;margin-inline:auto">
            <div style="height:100%;border-radius:2px;width:${pct}%;background:${barC}"></div>
          </div>
        </td>
        <td style="font-variant-numeric:tabular-nums">${_fmt(s.cobrado)}</td>
        <td>${s.pedidos}</td>
        <td>–</td>
        <td><span style="font-size:8.5px;font-weight:700;padding:2px 6px;border-radius:7px"
          class="rtag-${tag[0]}">${tag[1]}</span></td>
      </tr>`;
    }), 9);

    _csvData = [
      ["#","Ingeniero","Vendido","Meta","Avance %","Cobrado","Pedidos","Status"],
      ...ranking.map(([alias, s], i) => {
        const pct = Math.min(Math.round((s.vendido / META) * 100), 100);
        return [i+1, alias, s.vendido, META, pct+"%", s.cobrado, s.pedidos, pct>=70?"Bueno":pct>=40?"Atención":"Bajo"];
      })
    ];
  } catch (e) { _renderError(e, 9); }
}

// ── REPORTE EJECUTIVO: Ventas por zona / ingeniero ───────────
async function _cargarVentasEjecutivas() {
  _setText("rp-titulo", "Reporte ejecutivo de ventas");
  _setText("rp-section-title", "Ventas por ingeniero y zona");

  const { desde, hasta, label } = _rangoPeriodo();
  _setText("rp-periodo-label", label);

  const thead = document.getElementById("rp-thead");
  if (thead) thead.innerHTML = `<tr style="border-bottom:2px solid var(--border)">
    <th>#</th><th>INGENIERO</th><th>ZONA</th>
    <th>PEDIDOS</th><th>VENDIDO</th><th>TICKET PROM.</th>
    <th>COTIZACIONES</th><th>CONVERSIÓN</th>
  </tr>`;

  try {
    // cotizaciones: intentar con número y con Timestamp por si acaso
    const [pedidosDocs2, cotSnap] = await Promise.all([
      _queryPedidosRango(desde, hasta),
      getDocs(query(collection(db,"cotizaciones"),
        where("creadaEn",">=",Timestamp.fromDate(desde)),
        where("creadaEn","<=",Timestamp.fromDate(hasta)),
        limit(2000))).catch(() =>
          getDocs(query(collection(db,"cotizaciones"),
            where("creadaEn",">=",desde.getTime()),
            where("creadaEn","<=",hasta.getTime()),
            limit(2000))))
    ]);

    // Agrupar pedidos por ingeniero
    const STATI_OK_V = new Set(["CONFIRMADO","ENTREGADO","confirmado","entregado","Confirmado","Entregado"]);
    const stats = {};
    pedidosDocs2.forEach(d => {
      const p = d.data();
      if (!STATI_OK_V.has(p.status)) return;
      const alias = resolverNombre(p.ingenieroAlias || p.vendedor || p.alias || "–");
      if (!stats[alias]) stats[alias] = { pedidos:0, vendido:0, zona: p.zona || p.zonaAsignada || "–", cots:0, convertidas:0 };
      stats[alias].pedidos++;
      stats[alias].vendido += p.monto || p.total || 0;
    });

    // Cotizaciones
    cotSnap.forEach(d => {
      const c = d.data();
      const alias = resolverNombre(c.ingenieroAlias || c.vendedor || "–");
      if (!stats[alias]) stats[alias] = { pedidos:0, vendido:0, zona:"–", cots:0, convertidas:0 };
      stats[alias].cots++;
      if (c.status === "CONVERTIDA") stats[alias].convertidas++;
    });

    // Poblar selector de ingenieros
    const selIng = document.getElementById("rp-filtro-ing");
    if (selIng) {
      const ingenieros = Object.keys(stats).sort();
      const curVal = selIng.value;
      selIng.innerHTML = '<option value="">Todos los ingenieros</option>' +
        ingenieros.map(a => `<option value="${esc(a)}" ${curVal===a?"selected":""}>${esc(a)}</option>`).join("");
    }

    // Aplicar filtro de ingeniero si está activo
    const statsFiltered = _filtroIng
      ? Object.fromEntries(Object.entries(stats).filter(([a]) => a === _filtroIng))
      : stats;

    const ranking = Object.entries(statsFiltered).sort((a,b) => b[1].vendido - a[1].vendido);
    const totalVendido  = ranking.reduce((s,[,v]) => s + v.vendido, 0);
    const totalPedidos  = ranking.reduce((s,[,v]) => s + v.pedidos, 0);
    const totalCots     = ranking.reduce((s,[,v]) => s + v.cots, 0);
    const totalConv     = ranking.reduce((s,[,v]) => s + v.convertidas, 0);
    const convGlobal    = totalCots > 0 ? Math.round((totalConv / totalCots) * 100) : 0;

    _renderKPIs([
      [_fmt(totalVendido), "TOTAL VENDIDO"],
      [String(totalPedidos), "PEDIDOS"],
      [String(totalCots), "COTIZACIONES"],
      [convGlobal + "%", "CONVERSIÓN GLOBAL"],
    ]);

    _renderTabla(ranking.length === 0 ? null : ranking.map(([alias, s], i) => {
      const ticket = s.pedidos > 0 ? s.vendido / s.pedidos : 0;
      const conv   = s.cots > 0 ? Math.round((s.convertidas / s.cots) * 100) : 0;
      const convC  = conv >= 50 ? "#16A34A" : conv >= 25 ? "#D97706" : "#DC2626";
      return `<tr>
        <td style="font-weight:800;color:var(--text-sec)">${i+1}</td>
        <td class="txt" style="font-weight:700">${esc(alias)}</td>
        <td class="txt" style="font-size:11px;color:var(--text-sec)">${esc(s.zona)}</td>
        <td>${s.pedidos}</td>
        <td style="font-weight:700;font-variant-numeric:tabular-nums">${_fmt(s.vendido)}</td>
        <td style="font-variant-numeric:tabular-nums">${_fmt(ticket)}</td>
        <td>${s.cots}</td>
        <td style="font-weight:700;color:${convC}">${conv}%</td>
      </tr>`;
    }), 8);

    _csvData = [
      ["#","Ingeniero","Zona","Pedidos","Vendido","Ticket prom.","Cotizaciones","Conversión %"],
      ...ranking.map(([alias, s], i) => {
        const ticket = s.pedidos > 0 ? (s.vendido / s.pedidos).toFixed(2) : 0;
        const conv   = s.cots > 0 ? Math.round((s.convertidas / s.cots) * 100) : 0;
        return [i+1, alias, s.zona, s.pedidos, s.vendido.toFixed(2), ticket, s.cots, conv+"%"];
      })
    ];
  } catch (e) { _renderError(e, 8); }
}

// ── REPORTE EJECUTIVO: Top productos ─────────────────────────
async function _cargarTopProductos() {
  _setText("rp-titulo", "Top productos por volumen de venta");
  _setText("rp-section-title", "Productos más vendidos en el período");

  const { desde, hasta, label } = _rangoPeriodo();
  _setText("rp-periodo-label", label);

  const thead = document.getElementById("rp-thead");
  if (thead) thead.innerHTML = `<tr style="border-bottom:2px solid var(--border)">
    <th>#</th><th>PRODUCTO</th><th>UNIDAD</th>
    <th>CANT. VENDIDA</th><th>INGRESOS</th><th>PEDIDOS</th><th>PARTICIPACIÓN</th>
  </tr>`;

  try {
    // Dual query para cubrir timestamps Firestore (APK) y ms numéricos (panel web)
    const pedidosDocs4 = await _queryPedidosRango(desde, hasta);

    const productos = {};
    pedidosDocs4.forEach(d => {
      const p = d.data();
      const items = p.items || p.productos || [];
      items.forEach(it => {
        const nombre = it.nombreProducto || it.nombre || "–";
        if (!productos[nombre]) productos[nombre] = { cantidad:0, ingresos:0, pedidos:0, unidad: it.unidad || "pieza" };
        const cant = Number(it.cantidad) || 0;
        productos[nombre].cantidad  += cant;
        productos[nombre].ingresos  += Number(it.subtotal || it.importe || (it.precio * cant)) || 0;
        productos[nombre].pedidos++;
      });
    });

    const ranking     = Object.entries(productos).sort((a,b) => b[1].ingresos - a[1].ingresos);
    const totalIngr   = ranking.reduce((s,[,v]) => s + v.ingresos, 0);
    const totalCant   = ranking.reduce((s,[,v]) => s + v.cantidad, 0);

    _renderKPIs([
      [String(ranking.length),  "PRODUCTOS DISTINTOS"],
      [_fmt(totalIngr),         "INGRESOS TOTALES"],
      [totalCant.toLocaleString("es-MX"), "UNIDADES VENDIDAS"],
      [ranking[0]?.[0] || "–", "TOP 1"],
    ]);

    _renderTabla(ranking.length === 0 ? null : ranking.slice(0, 50).map(([nombre, s], i) => {
      const pct  = totalIngr > 0 ? ((s.ingresos / totalIngr) * 100).toFixed(1) : 0;
      const barW = Math.max(2, Math.round(Number(pct)));
      const barC = i === 0 ? "#16A34A" : i < 3 ? "#D97706" : "#6B7280";
      return `<tr>
        <td style="font-weight:800;color:${barC}">${i+1}</td>
        <td class="txt" style="font-weight:600">${esc(nombre)}</td>
        <td style="font-size:11px;color:var(--text-sec)">${esc(s.unidad)}</td>
        <td style="font-variant-numeric:tabular-nums">${s.cantidad.toLocaleString("es-MX")}</td>
        <td style="font-weight:700;font-variant-numeric:tabular-nums">${_fmt(s.ingresos)}</td>
        <td>${s.pedidos}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;justify-content:center">
            <div style="flex:1;height:6px;background:#E5E7EB;border-radius:3px;min-width:60px;max-width:120px">
              <div style="height:100%;border-radius:3px;width:${barW}%;background:${barC}"></div>
            </div>
            <span style="font-size:11px;font-weight:700;color:${barC};white-space:nowrap">${pct}%</span>
          </div>
        </td>
      </tr>`;
    }), 7);

    _csvData = [
      ["#","Producto","Unidad","Cantidad","Ingresos","Pedidos","Participación %"],
      ...ranking.slice(0,50).map(([nombre, s], i) => {
        const pct = totalIngr > 0 ? ((s.ingresos / totalIngr) * 100).toFixed(1) : 0;
        return [i+1, nombre, s.unidad, s.cantidad, s.ingresos.toFixed(2), s.pedidos, pct+"%"];
      })
    ];
  } catch (e) { _renderError(e, 7); }
}

// ── REPORTE 2: Cartera de clientes ───────────────────────────
async function _cargarCartera() {
  _setText("rp-titulo", "Cartera de clientes — saldo actual");
  _setText("rp-section-title", "Notas de crédito activas y vencidas");
  _setText("rp-periodo-label", "Estado actual al " + _fmtD(new Date()));
  _setLoading(7);

  const thead = document.getElementById("rp-thead");
  if (thead) thead.innerHTML = `<tr style="border-bottom:2px solid var(--border)">
    <th style="text-align:left">CLIENTE</th>
    <th style="text-align:left">NOTA</th>
    <th>TOTAL</th><th>ABONADO</th><th>SALDO</th>
    <th>STATUS</th>
    <th style="text-align:left">VENDEDOR</th>
  </tr>`;

  // Colores y labels de semáforo según status del APK
  const STATUS_COLOR = {
    CRITICO:   { bg:"#FEE2E2", fg:"#B22222" },
    GRAVE:     { bg:"#FFEDD5", fg:"#C2410C" },
    MODERADO:  { bg:"#DBEAFE", fg:"#1D4ED8" },
    LEVE:      { bg:"#FEF9C3", fg:"#92400E" },
    POR_VENCER:{ bg:"#DCFCE7", fg:"#166534" },
  };
  const SEVERITY = { CRITICO:0, GRAVE:1, MODERADO:2, LEVE:3, POR_VENCER:4 };

  try {
    // Fetch todas las remisiones — el status se calcula si no lo trae el APK
    const snap = await getDocs(query(
      collection(db,"remisiones_credito"),
      limit(500)
    ));

    const hoy = new Date();
    const rows = snap.docs.map(d => {
      const r = d.data();
      const saldo = r.xPagarVigente ?? ((r.montoOriginal||0) - (r.totalAbonado||0));
      // Calcular status si el APK no lo escribió aún
      let status = r.status;
      if (!status) {
        if (saldo <= 0) {
          status = "LIQUIDADO";
        } else {
          const fvRaw = r.fechaVencimiento;
          const fv = fvRaw?.toDate?.() ?? (fvRaw ? new Date(fvRaw) : null);
          if (!fv || fv > hoy) {
            status = "POR_VENCER";
          } else {
            const dias = Math.floor((hoy - fv) / 86400000);
            status = dias >= 61 ? "CRITICO" : dias >= 43 ? "GRAVE" : dias >= 29 ? "MODERADO" : dias >= 15 ? "LEVE" : "POR_VENCER";
          }
        }
      }
      return { ...r, _saldo: saldo, _status: status };
    }).filter(r => r._status !== "LIQUIDADO" && r._saldo > 0);

    rows.sort((a,b) => {
      const sa = SEVERITY[a._status] ?? 5, sb = SEVERITY[b._status] ?? 5;
      if (sa !== sb) return sa - sb;
      return String(a.clienteNombre||a.clienteId||"").localeCompare(String(b.clienteNombre||b.clienteId||""));
    });

    const totalSaldo   = rows.reduce((s,r) => s + r._saldo, 0);
    const totalAbonado = rows.reduce((s,r) => s + (r.totalAbonado||0), 0);
    const vencidas     = rows.filter(r => ["CRITICO","GRAVE","MODERADO","LEVE"].includes(r._status)).length;

    _renderKPIs([
      [String(rows.length), "NOTAS ACTIVAS"],
      [String(vencidas),    "VENCIDAS"],
      [_fmt(totalSaldo),    "SALDO TOTAL"],
      [_fmt(totalAbonado),  "ABONADO"]
    ]);

    _renderTabla(rows.length === 0 ? null : rows.map(r => {
      const colores = STATUS_COLOR[r._status] || { bg:"#F3F4F6", fg:"#6B7280" };
      const nombre  = esc(r.clienteNombre || (r.clienteId ? `Cliente #${r.clienteId}` : "–"));
      const nota    = esc(r.folio || r.remisionNumero || "–");
      const ing     = esc(resolverNombre(r.ingenieroAlias || r.ingeniero || r.aliasVendedor || "–"));
      return `<tr style="border-bottom:1px solid var(--border)">
        <td class="txt" style="font-weight:600">${nombre}</td>
        <td class="txt" style="color:var(--text-sec)">${nota}</td>
        <td style="font-variant-numeric:tabular-nums">${_fmt(r.montoOriginal||0)}</td>
        <td style="color:#16A34A;font-variant-numeric:tabular-nums">${_fmt(r.totalAbonado||0)}</td>
        <td style="font-weight:700;color:${colores.fg};font-variant-numeric:tabular-nums">${_fmt(r._saldo)}</td>
        <td>
          <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:7px;
            background:${colores.bg};color:${colores.fg}">
            ${r._status.replace("_"," ")}
          </span>
        </td>
        <td class="txt" style="color:var(--text-sec);font-size:11px">${ing}</td>
      </tr>`;
    }), 7);

    _csvData = [
      ["Cliente","Nota","Original","Abonado","Saldo","Status","Ingeniero"],
      ...rows.map(r => [
        r.clienteNombre || `Cliente #${r.clienteId}` || "–",
        r.folio || r.remisionNumero || "–",
        r.montoOriginal||0, r.totalAbonado||0, r._saldo,
        r._status, resolverNombre(r.ingenieroAlias||r.ingeniero||r.aliasVendedor||"–")
      ])
    ];
  } catch (e) { _renderError(e, 7); }
}

// ── REPORTE 3: Historial de visitas ───────────────────────────
async function _cargarVisitas() {
  _setText("rp-titulo", "Historial de visitas por ingeniero");
  _setText("rp-section-title", "Visitas registradas en el período");

  const { desde, hasta, label } = _rangoPeriodo();
  _setText("rp-periodo-label", label);
  _setLoading(6);

  const thead = document.getElementById("rp-thead");
  if (thead) thead.innerHTML = `<tr style="border-bottom:2px solid var(--border)">
    <th style="text-align:left">FECHA</th>
    <th style="text-align:left">INGENIERO</th>
    <th style="text-align:left">CLIENTE</th>
    <th>TIPO</th><th>GPS</th><th>STATUS</th>
  </tr>`;

  try {
    const snap = await getDocs(query(
      collection(db,"visitas"),
      where("timestamp",">=",Timestamp.fromMillis(desde.getTime())),
      where("timestamp","<=",Timestamp.fromMillis(hasta.getTime())),
      orderBy("timestamp","desc"),
      limit(1000)
    ));

    // Parsear timestamp: puede ser Firestore Timestamp u ms number
    const parseTs = (raw) => raw?.toDate?.() ?? (typeof raw === "number" ? new Date(raw) : null);

    const rows = snap.docs.map(d => {
      const v = d.data();
      return { ...v, _ts: parseTs(v.timestamp ?? v.fecha) };
    });

    // KPIs agrupados por ingeniero (usando nombre resuelto)
    const byIng = {};
    rows.forEach(v => {
      const k = resolverNombre(v.aliasVendedor || v.ingeniero || "–");
      if (!byIng[k]) byIng[k] = { total:0, sosp:0 };
      byIng[k].total++;
      if (v.flagSospechosa) byIng[k].sosp++;
    });
    const ingenieros  = Object.keys(byIng).length;
    const sospechosas = rows.filter(v => v.flagSospechosa).length;
    const primeraTs   = rows.length > 0 ? rows[rows.length-1]._ts : null;

    _renderKPIs([
      [String(rows.length),                       "TOTAL VISITAS"],
      [String(ingenieros),                         "INGENIEROS"],
      [String(sospechosas),                        "SOSPECHOSAS"],
      [primeraTs ? _fmtD(primeraTs) : "–",        "PRIMERA VISITA"]
    ]);

    _renderTabla(rows.length === 0 ? null : rows.map(v => {
      const ts      = v._ts;
      const sosp    = v.flagSospechosa;
      const gpsOk   = v.distanciaMetros >= 0 && v.distanciaMetros <= 200;
      const gpsTxt  = sosp ? `⚠ ${v.distanciaMetros?.toFixed(0)||"?"}m` : gpsOk ? "✓ OK" : "–";
      const ing     = esc(resolverNombre(v.aliasVendedor || v.ingeniero || "–"));
      return `<tr style="border-bottom:1px solid var(--border)${sosp?";background:rgba(220,38,38,.06)":""}">
        <td class="txt" style="white-space:nowrap;font-size:11px;color:var(--text-sec)">
          ${ts ? ts.toLocaleDateString("es-MX",{day:"2-digit",month:"short"})+" "+ts.toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"}) : "–"}
        </td>
        <td class="txt" style="font-weight:600">${ing}</td>
        <td class="txt">${esc(v.clienteNombre||"–")}</td>
        <td style="font-size:11px;color:var(--text-sec)">${esc(v.tipo||"–")}</td>
        <td style="font-size:11px;color:${sosp?"#DC2626":gpsOk?"#16A34A":"#9CA3AF"}">${gpsTxt}</td>
        <td>
          ${sosp ? `<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:7px;background:#FEE2E2;color:#DC2626">SOSPECHOSA</span>` : ""}
        </td>
      </tr>`;
    }), 6);

    _csvData = [
      ["Fecha","Ingeniero","Cliente","Tipo","Distancia (m)","Sospechosa"],
      ...rows.map(v => {
        const tsStr = v._ts ? v._ts.toLocaleString("es-MX") : "";
        return [tsStr, resolverNombre(v.aliasVendedor||v.ingeniero||"–"),
          v.clienteNombre||"–", v.tipo||"–", v.distanciaMetros??"-", v.flagSospechosa?"SÍ":"NO"];
      })
    ];
  } catch (e) { _renderError(e, 6); }
}

// ── REPORTE 5: Tendencia (gráficas Canvas 30 días) ───────────
async function _cargarTendencia() {
  _setText("rp-titulo", "Dashboard de tendencia — últimos 30 días");
  _setText("rp-section-title", "Ventas diarias y rendimiento");
  _setText("rp-periodo-label", "Últimos 30 días");

  // Ocultar tabla principal, mostrar contenedor canvas
  const paper = document.getElementById("reporte-papel");
  if (paper) {
    paper.querySelector(".report-table-wrap").style.display = "none";
  }

  // Insertar área de charts si no existe
  let chartArea = document.getElementById("rp-chart-area");
  if (!chartArea) {
    const wrap = paper?.querySelector(".report-table-wrap");
    if (wrap) {
      chartArea = document.createElement("div");
      chartArea.id = "rp-chart-area";
      wrap.parentNode.insertBefore(chartArea, wrap);
    }
  }
  if (!chartArea) return;

  chartArea.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0">
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:6px">
          VENTAS DIARIAS (MXN) — ÚLTIMOS 30 DÍAS</div>
        <canvas id="rp-cvs-ventas" style="width:100%;height:140px"></canvas>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:6px">
          TOP 8 INGENIEROS POR VENTA</div>
        <canvas id="rp-cvs-ing" style="width:100%;height:140px"></canvas>
      </div>
    </div>
    <div style="margin-top:12px">
      <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:8px">
        DESGLOSE DIARIO</div>
      <div style="overflow-x:auto">
        <table class="report-table">
          <thead><tr style="border-bottom:2px solid var(--border)">
            <th>DÍA</th><th>PEDIDOS</th><th>VENDIDO</th><th>TICKET PROM.</th><th>TREND</th>
          </tr></thead>
          <tbody id="rp-tbody-tend"></tbody>
        </table>
      </div>
    </div>`;

  try {
    const desde = new Date(); desde.setDate(desde.getDate() - 29); desde.setHours(0,0,0,0);
    const hasta = new Date(); hasta.setHours(23,59,59,999);
    const pedidosDocs3 = await _queryPedidosRango(desde, hasta);

    // Agrupar por día
    const diasMap = {};
    const ingMap  = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(desde); d.setDate(desde.getDate() + i);
      diasMap[d.toISOString().slice(0,10)] = { pedidos: 0, vendido: 0 };
    }
    const STATI_OK = new Set(["CONFIRMADO","ENTREGADO","confirmado","entregado","Confirmado","Entregado"]);
    pedidosDocs3.forEach(doc => {
      const p = doc.data();
      if (!STATI_OK.has(p.status)) return;
      const ts = p.fechaPedido?.toDate?.() ?? (typeof p.fechaPedido === "number" ? new Date(p.fechaPedido) : null)
               ?? p.createdAt?.toDate?.() ?? (typeof p.createdAt === "number" ? new Date(p.createdAt) : null);
      const key = ts.toISOString().slice(0,10);
      if (diasMap[key]) {
        diasMap[key].pedidos++;
        diasMap[key].vendido += p.monto || p.total || 0;
      }
      const alias = resolverNombre(p.vendedor || p.alias || p.ingenieroAlias || "–");
      ingMap[alias] = (ingMap[alias] || 0) + (p.monto || p.total || 0);
    });

    const dias    = Object.entries(diasMap).sort((a,b) => a[0].localeCompare(b[0]));
    const labels  = dias.map(([k]) => k.slice(5));          // MM-DD
    const ventas  = dias.map(([,v]) => v.vendido);
    const pedidos = dias.map(([,v]) => v.pedidos);
    const topIng  = Object.entries(ingMap).sort((a,b) => b[1]-a[1]).slice(0,8);

    const totalV  = ventas.reduce((s,v) => s+v, 0);
    const totalP  = pedidos.reduce((s,v) => s+v, 0);
    const maxDiaV = Math.max(...ventas);
    const maxDiaD = dias.find(([,v]) => v.vendido === maxDiaV)?.[0] ?? "–";

    _renderKPIs([
      [_fmt(totalV),         "TOTAL 30 DÍAS"],
      [String(totalP),       "PEDIDOS"],
      [totalP ? _fmt(totalV/totalP) : "–", "TICKET PROM."],
      [maxDiaD !== "–" ? maxDiaD.slice(8)+"-"+maxDiaD.slice(5,7)+"-"+maxDiaD.slice(0,4) : "–", "MEJOR DÍA"]
    ]);

    // Gráfica de línea — ventas
    _drawLine("rp-cvs-ventas", labels, ventas);

    // Gráfica de barras — ingenieros
    _drawBars("rp-cvs-ing", topIng.map(([a]) => a.length > 8 ? a.slice(0,8)+"…" : a), topIng.map(([,v]) => v));

    // Tabla desglose
    const tbody = document.getElementById("rp-tbody-tend");
    if (tbody) {
      const maxV = Math.max(...ventas, 1);
      tbody.innerHTML = dias.slice().reverse().map(([fecha, d]) => {
        const ticket = d.pedidos ? d.vendido / d.pedidos : 0;
        const pct    = Math.round((d.vendido / maxV) * 100);
        const barC   = d.vendido > 0 ? "#16A34A" : "#E5E7EB";
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="font-size:12px;color:var(--text-sec)">${fecha.slice(8)}-${fecha.slice(5,7)}-${fecha.slice(0,4)}</td>
          <td>${d.pedidos}</td>
          <td style="font-variant-numeric:tabular-nums;font-weight:${d.vendido?700:400}">
            ${d.vendido ? _fmt(d.vendido) : "–"}</td>
          <td style="font-variant-numeric:tabular-nums">
            ${ticket ? _fmt(ticket) : "–"}</td>
          <td>
            <div style="height:6px;border-radius:3px;width:${pct}%;background:${barC};min-width:${d.vendido?4:0}px;margin-inline:auto"></div>
          </td>
        </tr>`;
      }).join("");
    }

    _csvData = [
      ["Fecha","Pedidos","Vendido","Ticket promedio"],
      ...dias.map(([fecha, d]) => [fecha, d.pedidos, d.vendido.toFixed(2), d.pedidos ? (d.vendido/d.pedidos).toFixed(2) : 0])
    ];
  } catch (e) { console.error("[Reportes] tendencia:", e); }
}

// ── Canvas charts ─────────────────────────────────────────────
function _dark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : window.matchMedia?.("(prefers-color-scheme:dark)").matches;
}

function _setupCanvas(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const dpr = window.devicePixelRatio || 1;
  const rect = el.getBoundingClientRect();
  const w = rect.width || el.parentElement?.clientWidth || 300;
  const h = el.height || 140;
  el.width  = w * dpr;
  el.height = h * dpr;
  el.style.width  = w + "px";
  el.style.height = h + "px";
  const ctx = el.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

function _drawLine(id, labels, values) {
  const c = _setupCanvas(id); if (!c) return;
  const { ctx, w, h } = c;
  const dk   = _dark();
  const C_LINE = "#16A34A";
  const C_FILL = dk ? "rgba(22,163,74,.25)" : "rgba(22,163,74,.12)";
  const C_GRID = dk ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)";
  const C_TXT  = dk ? "#6B7280" : "#9CA3AF";
  const PL=4, PR=4, PT=8, PB=18;
  const cW = w-PL-PR, cH = h-PT-PB;
  const max = Math.max(...values, 1);
  const n   = values.length;
  const xOf = i => PL + (i / (n-1)) * cW;
  const yOf = v => PT + cH * (1 - v/max);

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = C_GRID; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
  [0.25,0.5,0.75,1].forEach(r => {
    const y = PT + cH*(1-r);
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL+cW, y); ctx.stroke();
  });
  ctx.setLineDash([]);

  // Area fill
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(values[0]));
  values.forEach((v,i) => { if (i>0) ctx.lineTo(xOf(i), yOf(v)); });
  ctx.lineTo(xOf(n-1), PT+cH);
  ctx.lineTo(xOf(0), PT+cH);
  ctx.closePath();
  ctx.fillStyle = C_FILL; ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = C_LINE; ctx.lineWidth = 2;
  values.forEach((v,i) => { i===0 ? ctx.moveTo(xOf(i),yOf(v)) : ctx.lineTo(xOf(i),yOf(v)); });
  ctx.stroke();

  // Labels every ~5 days
  ctx.fillStyle = C_TXT; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
  labels.forEach((l,i) => {
    if (i % 5 === 0 || i === n-1) ctx.fillText(l, xOf(i), h-4);
  });

  // Último punto highlight
  const lv = values[n-1];
  ctx.beginPath();
  ctx.arc(xOf(n-1), yOf(lv), 3.5, 0, Math.PI*2);
  ctx.fillStyle = C_LINE; ctx.fill();
}

function _drawBars(id, labels, values) {
  const c = _setupCanvas(id); if (!c) return;
  const { ctx, w, h } = c;
  const dk   = _dark();
  const COLORS = ["#16A34A","#1565C0","#E65100","#4527A0","#B45309","#0891B2","#9D174D","#374151"];
  const C_GRID = dk ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)";
  const C_TXT  = dk ? "#6B7280" : "#9CA3AF";
  const PL=4, PR=4, PT=8, PB=20;
  const cW = w-PL-PR, cH = h-PT-PB;
  const n   = values.length;
  const max = Math.max(...values, 1);
  const barW = cW / n;
  const gap  = Math.max(2, barW * 0.15);

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = C_GRID; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
  ctx.beginPath(); ctx.moveTo(PL, PT); ctx.lineTo(PL+cW, PT); ctx.stroke();
  ctx.setLineDash([]);

  values.forEach((v,i) => {
    const bh = (v/max) * cH;
    const x  = PL + i * barW + gap/2;
    const y  = PT + cH - bh;
    ctx.fillStyle = COLORS[i % COLORS.length];
    ctx.beginPath();
    ctx.roundRect?.(x, y, barW-gap, bh, [3,3,0,0]) ||
      ctx.rect(x, y, barW-gap, bh);
    ctx.fill();
    // Label
    ctx.fillStyle = C_TXT; ctx.font = "8px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(labels[i], x + (barW-gap)/2, h-4);
  });
}

// ── Excel export ──────────────────────────────────────────────
let _csvData = [];
function _exportarExcel() {
  if (!_csvData.length) { window.toast?.("Sin datos para exportar","warning"); return; }
  const ws = XLSX.utils.aoa_to_sheet(_csvData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Reporte");
  XLSX.writeFile(wb, `N10-${_tipo}-${new Date().toISOString().slice(0,10)}.xlsx`);
  window.toast?.("Exportando Excel…","info");
}

// ── Helpers de render ─────────────────────────────────────────
function _renderKPIs(items) {
  const el = document.getElementById("rp-kpis");
  if (!el) return;
  el.innerHTML = items.map(([v,l]) => `
    <div class="rk-item"><div class="rk-val">${v}</div><div class="rk-lbl">${l}</div></div>`).join("");
}

function _renderTabla(rows, cols) {
  const tbody = document.getElementById("rp-tbody");
  if (!tbody) return;
  if (!rows) {
    tbody.innerHTML = `<tr><td colspan="${cols}">
      <div class="empty-state" style="padding:20px">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-title">Sin datos en este período</div>
      </div>
    </td></tr>`;
    return;
  }
  tbody.innerHTML = rows.join("");
}

function _renderError(e, cols) {
  console.error("[Reportes]", e);
  if (!window.manejarErrorFirestore?.(e)) {
    const tbody = document.getElementById("rp-tbody");
    if (tbody) tbody.innerHTML = `<tr><td colspan="${cols}"
      style="color:#DC2626;padding:16px;text-align:center;font-size:12px">
      ⚠ Error al cargar datos: ${esc(e.message)}
    </td></tr>`;
    window.toast?.("Error al cargar reporte: " + e.message, "error");
  }
}

// ── Helpers de fecha ──────────────────────────────────────────
function _rangoPeriodo() {
  const hoy    = new Date();
  const inicio = d => { const n = new Date(d); n.setHours(0,0,0,0); return n; };
  const fin    = d => { const n = new Date(d); n.setHours(23,59,59,999); return n; };
  switch (_periodo) {
    case "hoy":
      return { desde: inicio(hoy), hasta: fin(hoy), label: "Hoy · " + _fmtD(hoy) };
    case "semana": {
      const lunes = new Date(hoy);
      lunes.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7));
      return { desde: inicio(lunes), hasta: fin(hoy),
        label: `Semana ${_semana(hoy)} · ${_fmtD(lunes)} — ${_fmtD(hoy)}` };
    }
    case "mes": {
      const p = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
      return { desde: inicio(p), hasta: fin(hoy),
        label: hoy.toLocaleDateString("es-MX", { month:"long", year:"numeric" }) };
    }
    case "trimestre": {
      const q  = Math.floor(hoy.getMonth() / 3);
      const p  = new Date(hoy.getFullYear(), q * 3, 1);
      return { desde: inicio(p), hasta: fin(hoy),
        label: `Q${q+1} ${hoy.getFullYear()} · ${_fmtD(p)} — ${_fmtD(hoy)}` };
    }
    default: {
      // Rango personalizado
      if (_fechaDesde && _fechaHasta) {
        return { desde: _fechaDesde, hasta: _fechaHasta,
          label: `${_fmtD(_fechaDesde)} — ${_fmtD(_fechaHasta)}` };
      }
      return { desde: inicio(hoy), hasta: fin(hoy), label: "Hoy" };
    }
  }
}

function _semana(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

function _fmtD(d) { return d.toLocaleDateString("es-MX", { day:"numeric", month:"short" }); }
function _fmt(n)  {
  if (typeof n !== "number") return "–";
  return new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN", minimumFractionDigits:0, maximumFractionDigits:0 }).format(n);
}
function _setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// CSS de tags del reporte
const style = document.createElement("style");
style.textContent = `
  .rtag-tg { background:#DCFCE7; color:#166534; }
  .rtag-ta { background:#FEF9C3; color:#92400E; }
  .rtag-tr { background:#FEE2E2; color:#DC2626; }
  @media print {
    .sidebar,.topbar,.subhdr,.statusbar,.report-body>:not(:last-child) { display:none !important; }
    body { overflow:visible; }
    .views-container,.view.active,.report-body { overflow:visible; height:auto; }
    .report-paper { box-shadow:none; }
  }
`;
if (!document.getElementById("report-styles")) {
  style.id = "report-styles";
  document.head.appendChild(style);
}
