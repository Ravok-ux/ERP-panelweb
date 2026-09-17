// bi-analytics.js — BI & Analytics: Dashboard drill-down | Rentabilidad | Comparativo | Demanda | Inventario

import { db } from "./firebase-config.js";
import {
  collection, getDocs, query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";

// ── Estado ────────────────────────────────────────────────────────
let _container = null;
let _destroyed  = false;
let _pedidos    = [];   // todos los pedidos confirmados
let _tab        = "dashboard";
let _filtros    = { periodo: "30", ingeniero: "", zona: "" };

// Inventario analytics state
let _invItems   = [];   // {nombre, familia, stockActual, costo, precioVenta, valorCosto, valorPrecio}
let _cogsData   = { total: 0, dias: 30 };
let _carryParams = null;

// ── Formato ───────────────────────────────────────────────────────
const MXN  = v => new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN", minimumFractionDigits:0 }).format(v || 0);
const NUM  = v => new Intl.NumberFormat("es-MX").format(v || 0);
const esc  = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

// ── Carga Firestore ───────────────────────────────────────────────
async function _cargar() {
  const STATI = ["CONFIRMADO","ENTREGADO","confirmado","entregado","Confirmado","Entregado"];
  let docs = [];
  try {
    const snap = await getDocs(
      query(collection(db, "pedidos"),
        where("status", "in", STATI),
        orderBy("fechaPedido", "desc"),
        limit(3000)
      )
    );
    docs = snap.docs;
  } catch {
    // si falla el índice, traemos sin filtro y filtramos en cliente
    const snap2 = await getDocs(
      query(collection(db, "pedidos"), orderBy("fechaPedido", "desc"), limit(3000))
    );
    docs = snap2.docs.filter(d => STATI.includes(d.data().status));
  }

  _pedidos = docs.map(d => {
    const r = d.data();
    // APK escribe fechaPedido como ms number; fallback a createdAt
    const tsRaw = r.fechaPedido ?? r.createdAt;
    const fecha = tsRaw?.toDate?.()
      || (typeof tsRaw === "number" ? new Date(tsRaw) : new Date(0));
    return {
      id:        d.id,
      monto:     Number(r.monto || r.total || 0),
      fecha,
      zona:      r.zona      || "Sin zona",
      ingeniero: resolverNombre(r.ingenieroAlias || r.alias || r.ingeniero) || "Desconocido",
      cliente:   r.clienteNombre  || r.cliente || "Desconocido",
      clienteId: r.clienteId || "",
      productos: Array.isArray(r.items) ? r.items : (Array.isArray(r.productos) ? r.productos : []),
      pago:      r.tipoVenta || r.metodoPago || "—",
    };
  });
}

// ── Filtrado activo ───────────────────────────────────────────────
function _filtrar() {
  const cut = new Date(Date.now() - parseInt(_filtros.periodo) * 86400000);
  return _pedidos.filter(p =>
    p.fecha >= cut &&
    (!_filtros.ingeniero || p.ingeniero === _filtros.ingeniero) &&
    (!_filtros.zona      || p.zona      === _filtros.zona)
  );
}

// ── Agrupaciones ─────────────────────────────────────────────────
function _agrupar(datos, campo) {
  const m = {};
  datos.forEach(p => {
    const k = p[campo] || "—";
    if (!m[k]) m[k] = { key:k, total:0, count:0, clientes:new Set() };
    m[k].total += p.monto; m[k].count++;
    m[k].clientes.add(p.clienteId || p.cliente);
  });
  return Object.values(m)
    .map(x => ({ ...x, clientes:x.clientes.size, ticket: x.total/x.count }))
    .sort((a,b) => b.total - a.total);
}

function _productos(datos) {
  const m = {};
  datos.forEach(p => p.productos.forEach(pr => {
    if (!pr.nombre) return;
    const k = pr.nombre.trim().toLowerCase(); // normalizar case para agrupar correctamente
    const display = pr.nombre.trim();
    if (!m[k]) m[k] = { nombre: display, categoria: pr.categoria || "—", unidades: 0, total: 0 };
    m[k].unidades += Number(pr.cantidad || 1);
    m[k].total    += Number(pr.subtotal || pr.importe || (pr.precio * Number(pr.cantidad || 1))) || 0;
  }));
  return Object.values(m).sort((a,b) => b.total - a.total);
}

function _porMes(todos, nMeses) {
  const ahora = new Date();
  return Array.from({ length: nMeses }, (_, i) => {
    const d   = new Date(ahora.getFullYear(), ahora.getMonth() - (nMeses - 1 - i), 1);
    const fin = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
    const g   = todos.filter(p => p.fecha >= d && p.fecha <= fin);
    return {
      label: MESES[d.getMonth()] + " " + String(d.getFullYear()).slice(2),
      total: g.reduce((s,p) => s + p.monto, 0),
      count: g.length,
    };
  });
}

// ── Mini bar ─────────────────────────────────────────────────────
function _bars(items, valFn, labelFn, color = "var(--accent)") {
  if (!items.length) return `<p style="color:var(--text-muted);font-size:12px">Sin datos</p>`;
  const max = Math.max(...items.map(valFn), 1);
  return items.slice(0, 12).map(x => {
    const pct = Math.round(valFn(x) / max * 100);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
      <div style="width:108px;font-size:11px;color:var(--text-secondary);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0">${esc(labelFn(x))}</div>
      <div style="flex:1;background:var(--surface2);border-radius:3px;height:16px">
        <div style="width:${pct}%;background:${color};height:100%;border-radius:3px"></div>
      </div>
      <div style="width:82px;font-size:11px;font-weight:600;color:var(--text-primary);text-align:right">${MXN(valFn(x))}</div>
    </div>`;
  }).join("");
}

// ── Gráfica de línea SVG ──────────────────────────────────────────
function _linea(buckets, color = "#4ADE80") {
  if (!buckets.length) return "";
  const max = Math.max(...buckets.map(b => b.total), 1);
  const W=560, H=110, pL=52, pB=22, pR=16, pT=10;
  const iW=W-pL-pR, iH=H-pB-pT;

  const pts = buckets.map((b,i) => {
    const x = pL + (i / Math.max(buckets.length-1,1)) * iW;
    const y = pT + iH - (b.total / max) * iH;
    return [x, y];
  });

  const line  = "M" + pts.map(p => p.join(",")).join(" L");
  const area  = `M${pL},${pT+iH} L` + pts.map(p => p.join(",")).join(" L") + ` L${pL+iW},${pT+iH} Z`;

  const grid = [0,0.25,0.5,0.75,1].map(r => {
    const y = pT + iH - r*iH;
    const v = r*max;
    const lbl = v>=1e6 ? (v/1e6).toFixed(1)+"M" : v>=1000 ? Math.round(v/1000)+"k" : Math.round(v);
    return `<line x1="${pL}" y1="${y}" x2="${pL+iW}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>
      <text x="${pL-4}" y="${y+3}" text-anchor="end" font-size="9" fill="var(--text-muted)">${lbl}</text>`;
  }).join("");

  const labels = buckets.map((b,i) => {
    const x = pL + (i / Math.max(buckets.length-1,1)) * iW;
    return `<text x="${x}" y="${H-4}" text-anchor="middle" font-size="9" fill="var(--text-muted)">${esc(b.label)}</text>`;
  }).join("");

  const dots = pts.map(([x,y],i) =>
    `<circle cx="${x}" cy="${y}" r="3" fill="${color}" stroke="var(--surface)" stroke-width="1.5">
       <title>${buckets[i].label}: ${MXN(buckets[i].total)}</title></circle>`
  ).join("");

  return `<div style="overflow-x:auto">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px" preserveAspectRatio="none">
      <defs><linearGradient id="biG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#biG)"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      ${dots}
      ${labels}
    </svg>
  </div>`;
}

// ── Tab Dashboard ─────────────────────────────────────────────────
function _tabDashboard(datos) {
  const total   = datos.reduce((s,p) => s+p.monto, 0);
  const ticket  = datos.length ? total/datos.length : 0;
  const cls     = new Set(datos.map(p => p.clienteId||p.cliente)).size;
  const semanas = _porMes(datos, 8).map(m => ({ ...m, label: m.label.slice(0,3) }));

  const kpi = (ico, lbl, val, color) => `
    <div class="bi-kpi">
      <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px">${ico} ${lbl}</div>
      <div style="font-size:20px;font-weight:700;color:${color}">${val}</div>
    </div>`;

  return `
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:18px">
  ${kpi("💰","Ventas período",MXN(total),"var(--text-primary)")}
  ${kpi("📋","Pedidos",NUM(datos.length),"#60A5FA")}
  ${kpi("🧾","Ticket promedio",MXN(ticket),"#FBBF24")}
  ${kpi("🏢","Clientes activos",NUM(cls),"#A78BFA")}
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
  <div class="bi-card">
    <div class="bi-card-title">Por ingeniero</div>
    ${_bars(_agrupar(datos,"ingeniero"), x=>x.total, x=>x.key)}
  </div>
  <div class="bi-card">
    <div class="bi-card-title">Por zona</div>
    ${_bars(_agrupar(datos,"zona"), x=>x.total, x=>x.key, "#60A5FA")}
  </div>
</div>

<div class="bi-card" style="margin-bottom:14px">
  <div class="bi-card-title">Tendencia — últimos 8 meses</div>
  ${_linea(semanas)}
</div>

<div class="bi-card">
  <div class="bi-card-title">Top productos por monto</div>
  ${_bars(_productos(datos), x=>x.total, x=>x.nombre, "#4ADE80")}
</div>`;
}

// ── Tab Rentabilidad ──────────────────────────────────────────────
function _tabRentabilidad(datos) {
  const clientes = _agrupar(datos, "cliente");
  const zonas    = _agrupar(datos, "zona");
  const totalG   = clientes.reduce((s,x)=>s+x.total, 0);

  const rowCl = clientes.slice(0,30).map((c,i) => {
    const pct = totalG ? (c.total/totalG*100).toFixed(1) : 0;
    const w   = Math.round(c.total/(clientes[0]?.total||1)*100);
    return `<tr>
      <td style="color:var(--text-muted);font-size:11px">${i+1}</td>
      <td style="font-weight:500;text-align:left">${esc(c.key)}</td>
      <td style="font-family:monospace">${MXN(c.total)}</td>
      <td>
        <div style="display:flex;align-items:center;justify-content:center;gap:5px">
          <div style="width:56px;background:var(--surface2);border-radius:2px;height:7px">
            <div style="width:${w}%;background:#4ADE80;height:100%;border-radius:2px"></div>
          </div>
          <span style="font-size:11px;color:var(--text-muted)">${pct}%</span>
        </div>
      </td>
      <td>${c.count}</td>
      <td style="font-family:monospace">${MXN(c.ticket)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Sin datos</td></tr>`;

  const rowZ = zonas.map(z => {
    const pct = totalG ? (z.total/totalG*100).toFixed(1) : 0;
    return `<tr>
      <td style="font-weight:500">${esc(z.key)}</td>
      <td style="font-family:monospace">${MXN(z.total)}</td>
      <td>${pct}%</td>
      <td>${z.count}</td>
      <td>${z.clientes}</td>
      <td style="font-family:monospace">${MXN(z.ticket)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Sin datos</td></tr>`;

  return `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
  <div class="bi-card">
    <div class="bi-card-title">Rentabilidad por zona</div>
    <div style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 250px)">
      <table class="bi-table">
        <thead><tr><th>Zona</th><th>Total</th><th>%</th><th>Pedidos</th><th>Clientes</th><th>Ticket prom.</th></tr></thead>
        <tbody>${rowZ}</tbody>
      </table>
    </div>
  </div>
  <div class="bi-card">
    <div class="bi-card-title">Top 30 clientes por volumen</div>
    <div style="overflow-x:auto;max-height:440px">
      <table class="bi-table">
        <thead><tr><th>#</th><th style="text-align:left">Cliente</th><th>Total</th><th>Part.</th><th>Pedidos</th><th>Ticket prom.</th></tr></thead>
        <tbody>${rowCl}</tbody>
      </table>
    </div>
  </div>
</div>`;
}

// ── Tab Comparativo YoY / MoM ─────────────────────────────────────
function _tabComparativo(todos) {
  const ahora = new Date();

  const rango = (d0, d1) => todos.filter(p => p.fecha >= d0 && p.fecha <= d1);
  const kpis  = g => ({
    total:   g.reduce((s,p)=>s+p.monto,0),
    count:   g.length,
    ticket:  g.length ? g.reduce((s,p)=>s+p.monto,0)/g.length : 0,
    clientes:new Set(g.map(p=>p.cliente)).size,
  });

  const inicioAct = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const inicioAnt = new Date(ahora.getFullYear(), ahora.getMonth()-1, 1);
  const finAnt    = new Date(ahora.getFullYear(), ahora.getMonth(), 0, 23,59,59);
  const inicioYoY = new Date(ahora.getFullYear()-1, ahora.getMonth(), 1);
  const finYoY    = new Date(ahora.getFullYear()-1, ahora.getMonth()+1, 0, 23,59,59);

  const kA = kpis(todos.filter(p=>p.fecha>=inicioAct));
  const kB = kpis(rango(inicioAnt, finAnt));
  const kC = kpis(rango(inicioYoY, finYoY));

  const dlt = (a,b) => {
    if (!b) return "<span style='color:var(--text-muted)'>—</span>";
    const d = (a-b)/b*100;
    const col = d>=0?"#4ADE80":"#F87171";
    return `<span style="color:${col};font-weight:600">${d>=0?"▲":"▼"} ${Math.abs(d).toFixed(1)}%</span>`;
  };

  const mN = MESES[ahora.getMonth()];
  const mA = MESES[(ahora.getMonth()+11)%12];
  const yr = ahora.getFullYear();
  const mesAct = `${mN} ${yr}`;
  const mesAnt = `${mA} ${ahora.getMonth()===0?yr-1:yr}`;
  const mesYoY = `${mN} ${yr-1}`;

  const hist6 = _porMes(todos, 6);
  const rowH  = hist6.map(m => `<tr>
    <td>${m.label}</td>
    <td style="font-family:monospace">${MXN(m.total)}</td>
    <td>${NUM(m.count)}</td>
    <td>${MXN(m.count?m.total/m.count:0)}</td>
  </tr>`).join("");

  const tbl = (kX, kY, hX, hY) => `
    <table class="bi-table">
      <thead><tr><th>Métrica</th><th>${hX}</th><th>${hY}</th><th>Δ</th></tr></thead>
      <tbody>
        <tr><td>Ventas</td><td>${MXN(kX.total)}</td><td>${MXN(kY.total)}</td><td>${dlt(kX.total,kY.total)}</td></tr>
        <tr><td>Pedidos</td><td>${kX.count}</td><td>${kY.count}</td><td>${dlt(kX.count,kY.count)}</td></tr>
        <tr><td>Ticket prom.</td><td>${MXN(kX.ticket)}</td><td>${MXN(kY.ticket)}</td><td>${dlt(kX.ticket,kY.ticket)}</td></tr>
        <tr><td>Clientes</td><td>${kX.clientes}</td><td>${kY.clientes}</td><td>${dlt(kX.clientes,kY.clientes)}</td></tr>
      </tbody>
    </table>`;

  return `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
  <div class="bi-card">
    <div class="bi-card-title">MoM — Mes actual vs anterior</div>
    ${tbl(kA,kB,mesAct,mesAnt)}
  </div>
  <div class="bi-card">
    <div class="bi-card-title">YoY — Mes actual vs mismo mes año anterior</div>
    ${tbl(kA,kC,mesAct,mesYoY)}
  </div>
</div>
<div class="bi-card">
  <div class="bi-card-title">Histórico mensual — últimos 6 meses</div>
  ${_linea(hist6,"#60A5FA")}
  <table class="bi-table" style="margin-top:10px">
    <thead><tr><th>Mes</th><th>Ventas</th><th>Pedidos</th><th>Ticket prom.</th></tr></thead>
    <tbody>${rowH}</tbody>
  </table>
</div>`;
}

// ── Tab Predicción de demanda ─────────────────────────────────────
function _tabDemanda(todos) {
  const ahora = new Date();
  const nMeses = 6;

  // Construir historial por producto × mes
  const mesesDef = Array.from({ length: nMeses }, (_,i) => {
    const d = new Date(ahora.getFullYear(), ahora.getMonth()-(nMeses-1-i), 1);
    return {
      label: MESES[d.getMonth()] + " " + String(d.getFullYear()).slice(2),
      ini:   d,
      fin:   new Date(d.getFullYear(), d.getMonth()+1, 0, 23,59,59),
    };
  });

  const histProd = {};
  mesesDef.forEach(({ label, ini, fin }) => {
    const grp = todos.filter(p => p.fecha >= ini && p.fecha <= fin);
    grp.forEach(p => p.productos.forEach(pr => {
      if (!pr.nombre) return;
      const k = pr.nombre.trim().toLowerCase();
      const display = pr.nombre.trim();
      if (!histProd[k]) histProd[k] = { nombre: display, h: Array(nMeses).fill(0) };
      const idx = mesesDef.findIndex(m => m.label === label);
      if (idx >= 0) histProd[k].h[idx] += Number(pr.cantidad || 1);
    }));
  });

  // Proyección: promedio ponderado últimos 3 meses (pesos 1,2,3)
  const proySiguiente = h => {
    const u = h.slice(-3);
    return Math.ceil((u[0]*1 + u[1]*2 + u[2]*3) / 6);
  };

  const products = Object.values(histProd)
    .map(p => ({ ...p, total: p.h.reduce((s,v)=>s+v,0), proy: proySiguiente(p.h) }))
    .sort((a,b) => b.total - a.total)
    .slice(0, 25);

  const siguienteMes = MESES[(ahora.getMonth()+1)%12] + " " +
    (ahora.getMonth()===11 ? ahora.getFullYear()+1 : ahora.getFullYear());

  const heads = mesesDef.map(m => `<th style="text-align:center">${m.label}</th>`).join("");

  const rows = products.map(p => {
    const celdas = p.h.map(v => `<td style="text-align:center">${v||"—"}</td>`).join("");
    const tend = p.h[5] > p.h[4] ? "📈" : p.h[5] < p.h[4] ? "📉" : "➡️";
    const col  = p.proy > (p.h[5]||0) ? "#4ADE80" : "#F87171";
    return `<tr>
      <td style="font-weight:500;white-space:nowrap">${esc(p.nombre)}</td>
      ${celdas}
      <td style="text-align:center">${tend}</td>
      <td style="text-align:center;font-weight:700;color:${col}">${p.proy||"—"}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="${nMeses+3}" style="text-align:center;color:var(--text-muted)">Sin datos suficientes</td></tr>`;

  return `
<div class="bi-card">
  <div class="bi-card-title">Proyección de demanda — ${siguienteMes}</div>
  <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">
    Promedio ponderado de los últimos 3 meses (peso 1×–2×–3×).
    Basada en ${todos.length} pedidos históricos. Unidades vendidas por producto.
  </p>
  <div style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 250px)">
    <table class="bi-table">
      <thead><tr>
        <th>Producto</th>${heads}
        <th style="text-align:center">Tend.</th>
        <th style="text-align:center">Proy. ${MESES[(ahora.getMonth()+1)%12]}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;
}

// ══════════════════════════════════════════════════════════════════
// INVENTARIO ANALYTICS — carga y tab
// ══════════════════════════════════════════════════════════════════

async function _cargarInventario() {
  // 1. Mapa costo_base / precio_base / familia desde catálogo productos
  const costoMap = {}, precioMap = {}, familiaMap = {};
  try {
    const prodSnap = await getDocs(collection(db, "productos"));
    prodSnap.docs.forEach(d => {
      const p = d.data();
      const keys = [p.codigoN10, p.codigo, p.nombre].filter(Boolean);
      const cb = Number(p.costo_base || p.costoBase || 0);
      const pb = Number(p.precio_base || p.precio_cliente || p.precioBase || 0);
      const fam = p.familia || p.categoria || "—";
      keys.forEach(k => {
        if (cb > 0) { costoMap[k] = cb; costoMap[String(k).toLowerCase().trim()] = cb; }
        if (pb > 0) { precioMap[k] = pb; precioMap[String(k).toLowerCase().trim()] = pb; }
        familiaMap[k] = fam;
        familiaMap[String(k).toLowerCase().trim()] = fam;
      });
    });
  } catch (_) {}

  // 2. Inventario actual
  try {
    const norm = s => String(s || "").toLowerCase().trim();
    const invSnap = await getDocs(query(collection(db, "inventario"), orderBy("nombre"), limit(500)));
    _invItems = invSnap.docs.map(d => {
      const data = d.data();
      const keys = [d.id, data.codigoN10, data.nombre].filter(Boolean);
      const rawCosto = Number(data.costo);
      const costo  = rawCosto > 0 ? rawCosto
        : (keys.reduce((v, k) => v || costoMap[k] || costoMap[norm(k)], 0) || 0);
      const precio = keys.reduce((v, k) => v || precioMap[k] || precioMap[norm(k)], 0) || 0;
      const fam    = data.familia || keys.reduce((v, k) => v || familiaMap[k] || familiaMap[norm(k)], "") || "—";
      const stock  = Number(data.stockActual) || 0;
      return {
        id: d.id, nombre: data.nombre || d.id, familia: fam,
        stockActual: stock, costo, precioVenta: precio,
        valorCosto:  stock * costo,
        valorPrecio: stock * precio,
      };
    });
  } catch (_) { _invItems = []; }

  // 3. COGS últimos 30 días desde movimientos_stock tipo salida
  try {
    const desde = Date.now() - 30 * 86400000;
    const costoFallback = k => costoMap[k] || 0;
    let q;
    try {
      q = query(
        collection(db, "movimientos_stock"),
        where("tipo", "in", ["SALIDA","AJUSTE_SALIDA","SALIDA_ALMACEN","REABASTO_INGENIERO"]),
        orderBy("_ts","desc"), limit(2000)
      );
    } catch {
      q = query(collection(db, "movimientos_stock"), orderBy("_ts","desc"), limit(2000));
    }
    const movSnap = await getDocs(q);
    let cogs30 = 0;
    movSnap.docs.forEach(d => {
      const m = d.data();
      if (m._ts < desde) return;
      const c = m.costoUnitario || costoFallback(m.productoId) || costoFallback(m.nombreProducto) || 0;
      cogs30 += (m.cantidad || 0) * c;
    });
    _cogsData = { total: cogs30, dias: 30 };
  } catch (_) { _cogsData = { total: 0, dias: 30 }; }
}

function _loadCarryParams() {
  if (_carryParams) return _carryParams;
  try {
    _carryParams = JSON.parse(localStorage.getItem("bi_carry_params") || "null");
  } catch (_) {}
  if (!_carryParams) _carryParams = { tasaCapital: 12, bodegaMes: 0, serviciosMes: 0, mermasPct: 2 };
  return _carryParams;
}

function _saveCarryParams(p) {
  _carryParams = p;
  try { localStorage.setItem("bi_carry_params", JSON.stringify(p)); } catch (_) {}
}

// ── Tab Inventario ─────────────────────────────────────────────────
function _tabInventario() {
  const p = _loadCarryParams();
  const rows = _invItems.filter(r => r.stockActual > 0);

  // Totales globales
  const totalCosto  = rows.reduce((s, r) => s + (Number(r.valorCosto) || 0), 0);
  const totalPrecio = rows.reduce((s, r) => s + (Number(r.valorPrecio) || 0), 0);
  const margen      = totalPrecio - totalCosto;
  const margenPct   = totalCosto > 0 ? margen / totalCosto * 100 : 0;

  // DIO global: (InvProm / COGS_anual) × 365
  const cogsAnual = _cogsData.total * (365 / Math.max(_cogsData.dias, 1));
  const dio       = cogsAnual > 0 ? Math.round(totalCosto / cogsAnual * 365) : null;
  const rotacion  = cogsAnual > 0 ? (cogsAnual / totalCosto).toFixed(1) : null;

  // DIO + valor por familia
  const famMap = {};
  rows.forEach(r => {
    if (!famMap[r.familia]) famMap[r.familia] = { valorCosto: 0, valorPrecio: 0, unidades: 0 };
    famMap[r.familia].valorCosto  += (Number(r.valorCosto)  || 0);
    famMap[r.familia].valorPrecio += (Number(r.valorPrecio) || 0);
    famMap[r.familia].unidades    += (Number(r.stockActual) || 0);
  });
  const famRows = Object.entries(famMap)
    .map(([fam, v]) => {
      const pct   = totalCosto > 0 ? v.valorCosto / totalCosto * 100 : 0;
      const dioF  = cogsAnual > 0 ? Math.round(v.valorCosto / (cogsAnual * (v.valorCosto / (totalCosto || 1))) * 365) : null;
      return { fam, ...v, pct, dio: dioF };
    })
    .sort((a, b) => b.valorCosto - a.valorCosto);

  // Carrying cost desglose
  const costoCapital   = totalCosto * (p.tasaCapital / 100);
  const costoBodega    = (p.bodegaMes   || 0) * 12;
  const costoServicios = (p.serviciosMes || 0) * 12;
  const costoMermas    = totalCosto * ((p.mermasPct || 0) / 100);
  const costoHolding   = costoCapital + costoBodega + costoServicios + costoMermas;
  const carryPct       = totalCosto > 0 ? costoHolding / totalCosto * 100 : 0;

  const _cc = (lbl, val, color) => `
    <div style="display:flex;justify-content:space-between;align-items:center;
      padding:9px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:12px;color:var(--text-sec)">${lbl}</span>
      <span style="font-weight:700;font-size:13px;color:${color}">${MXN(val)}</span>
    </div>`;

  const _kpi = (ico, lbl, val, color, sub = "") => `
    <div class="bi-kpi">
      <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px">${ico} ${lbl}</div>
      <div style="font-size:20px;font-weight:700;color:${color}">${val}</div>
      ${sub ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">${sub}</div>` : ""}
    </div>`;

  // Top 20 productos por valor en costo
  const topProds = [...rows].sort((a, b) => b.valorCosto - a.valorCosto).slice(0, 20);
  const barMax   = topProds[0]?.valorCosto || 1;

  return `
<!-- KPIs globales -->
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:18px">
  ${_kpi("📦", "Valor en costo",  MXN(totalCosto),  "var(--text-primary)")}
  ${_kpi("🏷️", "Valor en precio", MXN(totalPrecio), "#4ADE80", margen >= 0 ? `+${MXN(margen)} margen` : `${MXN(margen)}`)}
  ${_kpi("📊", "% Margen bruto",  `${margenPct.toFixed(1)}%`, "#FBBF24")}
  ${_kpi("🔄", "Rotación anual",  rotacion ? `${rotacion}×` : "—", "#60A5FA", dio ? `${dio} días inv.` : "")}
  ${_kpi("💸", "Holding cost",    MXN(costoHolding), "#F87171", `${carryPct.toFixed(1)}% del inventario`)}
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">

  <!-- Valor y DIO por familia -->
  <div class="bi-card">
    <div class="bi-card-title">📂 Valor & DIO por familia</div>
    <div style="overflow-x:auto;max-height:340px">
      <table class="bi-table">
        <thead><tr>
          <th style="text-align:left">Familia</th>
          <th>Valor costo</th><th>Valor precio</th>
          <th>% part.</th><th>DIO (días)</th>
        </tr></thead>
        <tbody>${famRows.length ? famRows.map(r => {
          const dioCol = r.dio == null ? "var(--text-muted)"
            : r.dio > 90 ? "#F87171" : r.dio > 45 ? "#FBBF24" : "#4ADE80";
          return `<tr>
            <td style="text-align:left;font-weight:600">${esc(r.fam)}</td>
            <td style="font-family:monospace">${MXN(r.valorCosto)}</td>
            <td style="font-family:monospace;color:#4ADE80">${MXN(r.valorPrecio)}</td>
            <td>${r.pct.toFixed(1)}%</td>
            <td style="font-weight:700;color:${dioCol}">${r.dio ?? "—"}</td>
          </tr>`;
        }).join("") : `<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Sin datos con costo configurado</td></tr>`}</tbody>
      </table>
    </div>
    ${cogsAnual > 0 ? `
    <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">
      COGS estimado anual: <strong>${MXN(cogsAnual)}</strong>
      (basado en salidas de los últimos 30 días × 12.17).<br>
      <span style="color:#F87171">DIO &gt; 90 días</span> ·
      <span style="color:#FBBF24">DIO 45–90 días</span> ·
      <span style="color:#4ADE80">DIO &lt; 45 días</span>
    </div>` : `<div style="margin-top:8px;font-size:11px;color:#F87171">
      Sin movimientos de salida recientes — COGS = 0. Los DIO no se pueden calcular.
    </div>`}
  </div>

  <!-- Costo de almacenamiento parametrizable -->
  <div class="bi-card">
    <div class="bi-card-title">💰 Costo de almacenamiento (carrying cost)</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
      <div>
        <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:4px">
          Tasa de capital / WACC (% anual)
        </label>
        <input id="bi-cc-capital" type="number" class="form-input" min="0" max="100" step="0.5"
          value="${p.tasaCapital}" style="width:100%">
      </div>
      <div>
        <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:4px">
          % merma / obsolescencia anual
        </label>
        <input id="bi-cc-merma" type="number" class="form-input" min="0" max="50" step="0.1"
          value="${p.mermasPct}" style="width:100%">
      </div>
      <div>
        <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:4px">
          Renta / bodega (MXN/mes)
        </label>
        <input id="bi-cc-bodega" type="number" class="form-input" min="0" step="100"
          value="${p.bodegaMes}" style="width:100%">
      </div>
      <div>
        <label style="font-size:10px;color:var(--text-muted);display:block;margin-bottom:4px">
          Servicios / seguros (MXN/mes)
        </label>
        <input id="bi-cc-serv" type="number" class="form-input" min="0" step="100"
          value="${p.serviciosMes}" style="width:100%">
      </div>
    </div>
    <button id="bi-cc-recalc" class="btn-primary" style="width:100%;margin-bottom:14px">
      Recalcular
    </button>
    <div style="border-top:1px solid var(--border);padding-top:10px">
      ${_cc("💼 Costo de capital (" + p.tasaCapital + "% de " + MXN(totalCosto) + ")", costoCapital, "#60A5FA")}
      ${_cc("🏭 Almacenamiento físico (renta+svc × 12)", costoBodega + costoServicios, "#FBBF24")}
      ${_cc("⚠️ Riesgo (merma " + p.mermasPct + "% de inventario)", costoMermas, "#F87171")}
      <div style="display:flex;justify-content:space-between;align-items:center;padding-top:10px">
        <span style="font-size:13px;font-weight:700">Total anual estimado</span>
        <span style="font-size:16px;font-weight:800;color:#F87171">${MXN(costoHolding)}</span>
      </div>
      <div style="text-align:right;font-size:11px;color:var(--text-muted);margin-top:2px">
        = ${carryPct.toFixed(1)}% del valor inventario en costo
      </div>
    </div>
  </div>
</div>

<!-- Tabla de productos por valor -->
<div class="bi-card">
  <div class="bi-card-title">📋 Top 20 SKUs por valor en costo</div>
  <div style="overflow-x:auto;max-height:380px">
    <table class="bi-table">
      <thead><tr>
        <th style="text-align:left">Producto</th>
        <th>Familia</th><th>Stock</th>
        <th>Costo unit.</th><th>Precio venta</th>
        <th>Valor costo</th><th>Valor precio</th><th>% part.</th>
      </tr></thead>
      <tbody>${topProds.length ? topProds.map(r => {
        const pct = totalCosto > 0 ? (r.valorCosto / totalCosto * 100).toFixed(1) : "0.0";
        const w   = Math.round(r.valorCosto / barMax * 100);
        return `<tr>
          <td style="text-align:left;font-weight:600">${esc(r.nombre)}</td>
          <td style="font-size:11px;color:var(--text-muted)">${esc(r.familia)}</td>
          <td style="font-variant-numeric:tabular-nums">${NUM(r.stockActual)}</td>
          <td style="font-family:monospace">${r.costo > 0 ? MXN(r.costo) : "—"}</td>
          <td style="font-family:monospace;color:#4ADE80">${r.precioVenta > 0 ? MXN(r.precioVenta) : "—"}</td>
          <td style="font-family:monospace;font-weight:700">${MXN(r.valorCosto)}</td>
          <td style="font-family:monospace;color:#4ADE80">${r.valorPrecio > 0 ? MXN(r.valorPrecio) : "—"}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              <div style="width:44px;height:6px;background:var(--border);border-radius:3px;flex-shrink:0">
                <div style="width:${w}%;height:100%;background:#60A5FA;border-radius:3px"></div>
              </div>
              <span style="font-size:11px;font-weight:600;color:var(--text-primary);white-space:nowrap">${pct}%</span>
            </div>
          </td>
        </tr>`;
      }).join("") : `<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">
        Sin productos con costo configurado en catálogo
      </td></tr>`}</tbody>
    </table>
  </div>
</div>`;
}

// ── Render principal ──────────────────────────────────────────────
function _render() {
  if (!_container) return;

  const datos    = _filtrar();
  const ings     = [...new Set(_pedidos.map(p=>p.ingeniero))].sort();
  const zonas    = [...new Set(_pedidos.map(p=>p.zona))].sort();

  const selIng  = ["", ...ings].map(v =>
    `<option value="${esc(v)}" ${_filtros.ingeniero===v?"selected":""}>${v||"Todos los ingenieros"}</option>`
  ).join("");
  const selZona = ["", ...zonas].map(v =>
    `<option value="${esc(v)}" ${_filtros.zona===v?"selected":""}>${v||"Todas las zonas"}</option>`
  ).join("");

  const TABS = [
    { id:"dashboard",    label:"📊 Dashboard" },
    { id:"rentabilidad", label:"💰 Rentabilidad" },
    { id:"comparativo",  label:"📅 Comparativo" },
    { id:"demanda",      label:"🔮 Demanda" },
    { id:"inventario",   label:"🏭 Inventario" },
  ];

  let body = "";
  if (_tab === "dashboard")    body = _tabDashboard(datos);
  if (_tab === "rentabilidad") body = _tabRentabilidad(datos);
  if (_tab === "comparativo")  body = _tabComparativo(_pedidos);
  if (_tab === "demanda")      body = _tabDemanda(_pedidos);
  if (_tab === "inventario")   body = _tabInventario();

  _container.innerHTML = `
<style>
  .bi-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}
  .bi-card-title{font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:12px}
  .bi-kpi{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px}
  .bi-tab{background:transparent;border:none;border-bottom:2px solid transparent;padding:8px 18px;cursor:pointer;font-size:13px;color:var(--text-secondary)}
  .bi-tab.active{border-bottom-color:var(--accent);color:var(--text-primary);font-weight:600}
  .bi-table{width:100%;border-collapse:collapse;font-size:12px}
  .bi-table th{text-align:center;padding:6px 8px;border-bottom:2px solid var(--border);color:var(--text-muted);font-size:11px;font-weight:600;white-space:nowrap;background:var(--surface-2,var(--bg));position:sticky;top:0;z-index:2}
  .bi-table td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:center}
  .bi-table tbody tr:hover{background:var(--surface2)}
  .bi-filter select{background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
</style>

<div style="padding:20px">

  <!-- Filtros -->
  <div class="bi-filter" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
    <select id="bi-periodo">
      <option value="7"   ${_filtros.periodo==="7"  ?"selected":""}>Últimos 7 días</option>
      <option value="30"  ${_filtros.periodo==="30" ?"selected":""}>Últimos 30 días</option>
      <option value="90"  ${_filtros.periodo==="90" ?"selected":""}>Últimos 90 días</option>
      <option value="180" ${_filtros.periodo==="180"?"selected":""}>Últimos 6 meses</option>
      <option value="365" ${_filtros.periodo==="365"?"selected":""}>Último año</option>
    </select>
    <select id="bi-ingeniero">${selIng}</select>
    <select id="bi-zona">${selZona}</select>
    <span style="font-size:12px;color:var(--text-muted);margin-left:auto">${datos.length} pedidos en el período</span>
  </div>

  <!-- Tabs -->
  <div style="display:flex;border-bottom:1px solid var(--border);margin-bottom:20px">
    ${TABS.map(t => `<button class="bi-tab ${_tab===t.id?"active":""}" data-tab="${t.id}">${t.label}</button>`).join("")}
  </div>

  <!-- Contenido -->
  ${body}
</div>`;

  _container.querySelector("#bi-periodo")?.addEventListener("change", e => { _filtros.periodo = e.target.value; _render(); });
  _container.querySelector("#bi-ingeniero")?.addEventListener("change", e => { _filtros.ingeniero = e.target.value; _render(); });
  _container.querySelector("#bi-zona")?.addEventListener("change", e => { _filtros.zona = e.target.value; _render(); });
  _container.querySelectorAll(".bi-tab").forEach(btn =>
    btn.addEventListener("click", () => { _tab = btn.dataset.tab; _render(); })
  );
  // Carrying cost recalculate
  _container.querySelector("#bi-cc-recalc")?.addEventListener("click", () => {
    const get = id => parseFloat(_container.querySelector(`#${id}`)?.value || "0") || 0;
    _saveCarryParams({
      tasaCapital:  get("bi-cc-capital"),
      bodegaMes:    get("bi-cc-bodega"),
      serviciosMes: get("bi-cc-serv"),
      mermasPct:    get("bi-cc-merma"),
    });
    _render();
  });
}

// ── Exports ───────────────────────────────────────────────────────
export const BiAnalyticsModule = {
  async mount(container) {
    await cargarNombres();
    _container = container;
    _destroyed  = false;
    _tab        = "dashboard";
    _filtros    = { periodo: "30", ingeniero: "", zona: "" };

    container.innerHTML = `<div style="padding:50px;text-align:center;color:var(--text-muted)">
      <div style="font-size:36px;margin-bottom:10px">📊</div>
      Cargando análisis…
    </div>`;

    try {
      await Promise.all([_cargar(), _cargarInventario()]);
    } catch(e) {
      console.error("[BI] Error:", e);
      container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-muted)">
        Error al cargar: ${esc(e.message)}
      </div>`;
      return;
    }

    if (_destroyed) return;
    _render();
  },

  destroy() {
    _destroyed = true;
    _container = null;
  }
};
