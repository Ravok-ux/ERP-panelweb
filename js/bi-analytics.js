// bi-analytics.js — BI & Analytics: Dashboard drill-down | Rentabilidad | Comparativo | Demanda

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
        orderBy("fechaCreacion", "desc"),
        limit(3000)
      )
    );
    docs = snap.docs;
  } catch {
    // si falla el índice, traemos sin filtro y filtramos en cliente
    const snap2 = await getDocs(
      query(collection(db, "pedidos"), orderBy("fechaCreacion", "desc"), limit(3000))
    );
    docs = snap2.docs.filter(d => STATI.includes(d.data().status));
  }

  _pedidos = docs.map(d => {
    const r = d.data();
    const fecha = r.fechaCreacion?.toDate?.()
      || (typeof r.fechaCreacion === "number" ? new Date(r.fechaCreacion) : new Date(0));
    return {
      id:        d.id,
      monto:     Number(r.monto || r.total || 0),
      fecha,
      zona:      r.zona      || "Sin zona",
      ingeniero: resolverNombre(r.ingenieroAlias || r.alias || r.ingeniero) || "Desconocido",
      cliente:   r.clienteNombre  || r.cliente || "Desconocido",
      clienteId: r.clienteId || "",
      productos: Array.isArray(r.productos) ? r.productos : [],
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
    const k = pr.nombre || "—";
    if (!m[k]) m[k] = { nombre:k, categoria:pr.categoria||"—", unidades:0, total:0 };
    m[k].unidades += Number(pr.cantidad || 1);
    m[k].total    += Number(pr.precioUnitario || 0) * Number(pr.cantidad || 1);
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
  <div class="bi-card-title">Tendencia — últimas 8 semanas</div>
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
      <td style="color:var(--text-muted);text-align:center;font-size:11px">${i+1}</td>
      <td style="font-weight:500">${esc(c.key)}</td>
      <td style="font-family:monospace">${MXN(c.total)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:5px">
          <div style="width:56px;background:var(--surface2);border-radius:2px;height:7px">
            <div style="width:${w}%;background:#4ADE80;height:100%;border-radius:2px"></div>
          </div>
          <span style="font-size:11px;color:var(--text-muted)">${pct}%</span>
        </div>
      </td>
      <td style="text-align:right">${c.count}</td>
      <td style="text-align:right">${MXN(c.ticket)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Sin datos</td></tr>`;

  const rowZ = zonas.map(z => {
    const pct = totalG ? (z.total/totalG*100).toFixed(1) : 0;
    return `<tr>
      <td style="font-weight:500">${esc(z.key)}</td>
      <td style="font-family:monospace">${MXN(z.total)}</td>
      <td>${pct}%</td>
      <td style="text-align:right">${z.count}</td>
      <td style="text-align:right">${z.clientes}</td>
      <td style="text-align:right">${MXN(z.ticket)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">Sin datos</td></tr>`;

  return `
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
  <div class="bi-card">
    <div class="bi-card-title">Rentabilidad por zona</div>
    <div style="overflow-x:auto">
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
        <thead><tr><th>#</th><th>Cliente</th><th>Total</th><th>Part.</th><th>Pedidos</th><th>Ticket prom.</th></tr></thead>
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
    <td style="text-align:right">${NUM(m.count)}</td>
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
      const k = pr.nombre || "—";
      if (!histProd[k]) histProd[k] = { nombre:k, h: Array(nMeses).fill(0) };
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
  <div style="overflow-x:auto">
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
  ];

  let body = "";
  if (_tab === "dashboard")    body = _tabDashboard(datos);
  if (_tab === "rentabilidad") body = _tabRentabilidad(datos);
  if (_tab === "comparativo")  body = _tabComparativo(_pedidos);
  if (_tab === "demanda")      body = _tabDemanda(_pedidos);

  _container.innerHTML = `
<style>
  .bi-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}
  .bi-card-title{font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:12px}
  .bi-kpi{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px}
  .bi-tab{background:transparent;border:none;border-bottom:2px solid transparent;padding:8px 18px;cursor:pointer;font-size:13px;color:var(--text-secondary)}
  .bi-tab.active{border-bottom-color:var(--accent);color:var(--text-primary);font-weight:600}
  .bi-table{width:100%;border-collapse:collapse;font-size:12px}
  .bi-table th{text-align:left;padding:6px 8px;border-bottom:2px solid var(--border);color:var(--text-muted);font-size:11px;font-weight:600;white-space:nowrap}
  .bi-table td{padding:6px 8px;border-bottom:1px solid var(--border)}
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
      await _cargar();
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
