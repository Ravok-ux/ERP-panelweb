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
    <div class="kpi-card" style="border-left-color:${color}">
      <div class="kpi-icon">${ico}</div>
      <div class="kpi-val">${val}</div>
      <div class="kpi-label">${lbl}</div>
    </div>`;

  return `
<div class="kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:18px">
  ${kpi("💰","VENTAS PERÍODO",MXN(total),"var(--text-muted,#9CA3AF)")}
  ${kpi("📋","PEDIDOS",NUM(datos.length),"#60A5FA")}
  ${kpi("🧾","TICKET PROMEDIO",MXN(ticket),"#FBBF24")}
  ${kpi("🏢","CLIENTES ACTIVOS",NUM(cls),"#A78BFA")}
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

// ── Tab Comparativo KPI Ingenieros ───────────────────────────────

function _isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
function _weekRange(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}
function _toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v === "number") return new Date(v);
  return null;
}

const KPI_DEFS = [
  { key:"venta",        label:"Venta semanal",       icon:"&#x1F4B0;", metaField:"metaMonto",        fmt:MXN,              peso:0.20 },
  { key:"visitas",      label:"Visitas",              icon:"&#x1F4CD;", metaField:"metaVisitas",       fmt:NUM,              peso:0.20 },
  { key:"litros",       label:"Litros N10",           icon:"&#x1F4A7;", metaField:"metaLitros",        fmt:v=>`${NUM(v)} L`, peso:0.20 },
  { key:"recuperacion", label:"Recuperacion cartera", icon:"&#x1F4B3;", metaField:"metaRecuperacion",  fmt:MXN,              peso:0.20 },
  { key:"prospectos",   label:"Prospectos",           icon:"&#x1F9F2;", metaField:"metaProspectos",    fmt:NUM,              peso:0.05 },
  { key:"convertidos",  label:"Convertidos",          icon:"&#x1F504;", metaField:"metaConvertidos",   fmt:NUM,              peso:0.15 },
];
const ING_COLORS = ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4"];

async function _cargarIngenieros() {
  try {
    const snap = await getDocs(query(collection(db, "usuarios"),
      where("rol", "==", "INGENIERO"), where("activo", "==", true)));
    if (snap.docs.length > 0)
      return snap.docs.map(d => ({
        alias: d.data().alias || d.id,
        nombre: resolverNombre(d.data().alias || d.id) || d.data().nombre || d.data().alias || d.id
      }));
  } catch(_) {}
  const aliases = [...new Set(_pedidos.map(p => p.ingeniero).filter(Boolean))];
  return aliases.map(a => ({ alias: a, nombre: a }));
}

async function _cargarKPIs(aliases, semanas, year) {
  const kpiData = {};
  const metas   = {};
  aliases.forEach(a => { kpiData[a] = {}; metas[a] = {}; });

  // Metas
  try {
    const metaSnap = await getDocs(collection(db, "metas"));
    const metaDocs = metaSnap.docs.map(d => d.data());
    aliases.forEach(alias => {
      const relevant = metaDocs.filter(m => m.alias === alias);
      if (!relevant.length) return;
      const best = relevant.reduce((a,b) => ((a.fechaInicio||0) >= (b.fechaInicio||0) ? a : b));
      metas[alias] = {
        metaMonto:        Number(best.metaMonto        || 0),
        metaVisitas:      Number(best.metaVisitas      || 0),
        metaLitros:       Number(best.metaLitros       || 0),
        metaRecuperacion: Number(best.metaRecuperacion || 0),
        metaProspectos:   Number(best.metaProspectos   || 0),
        metaConvertidos:  Number(best.metaConvertidos  || 0),
      };
    });
  } catch(_) {}

  // Pedidos por alias
  const VALID_S = ["CONFIRMADO","ENTREGADO","confirmado","entregado","Confirmado","Entregado"];
  const pedidosPorAlias = {};
  for (const alias of aliases) {
    try {
      const snap = await getDocs(query(collection(db, "pedidos"),
        where("ingenieroAlias", "==", alias), limit(500)));
      pedidosPorAlias[alias] = snap.docs.map(d => ({ ...d.data(), _id: d.id }))
        .filter(p => VALID_S.includes(p.status));
    } catch(_) { pedidosPorAlias[alias] = []; }
  }

  // Visitas por alias
  const visitasPorAlias = {};
  for (const alias of aliases) {
    try {
      const snap = await getDocs(query(collection(db, "visitas"),
        where("aliasVendedor", "==", alias), limit(500)));
      visitasPorAlias[alias] = snap.docs.map(d => d.data());
    } catch(_) { visitasPorAlias[alias] = []; }
  }

  // Comisiones N10 por alias
  const comisionesPorAlias = {};
  for (const alias of aliases) {
    try {
      const snap = await getDocs(query(collection(db, "comisiones_n10"),
        where("ingenieroAlias", "==", alias), limit(500)));
      comisionesPorAlias[alias] = snap.docs.map(d => d.data());
    } catch(_) { comisionesPorAlias[alias] = null; }
  }

  // Remisiones credito (una sola vez)
  let remisiones = [];
  try {
    const snap = await getDocs(query(collection(db, "remisiones_credito"), limit(1000)));
    remisiones = snap.docs.map(d => d.data());
  } catch(_) {}

  // Clientes por alias
  const clientesPorAlias = {};
  for (const alias of aliases) {
    try {
      const snap = await getDocs(query(collection(db, "clientes"),
        where("ingeniero", "==", alias), limit(500)));
      clientesPorAlias[alias] = snap.docs.map(d => ({ ...d.data(), _id: d.id }));
    } catch(_) { clientesPorAlias[alias] = []; }
  }

  // Calcular KPIs
  for (const alias of aliases) {
    for (const sem of semanas) {
      const { start, end } = _weekRange(year, sem);
      const startMs = start.getTime(), endMs = end.getTime();

      // Venta
      const pedSem = (pedidosPorAlias[alias] || []).filter(p => {
        const d = _toDate(p.fechaPedido ?? p.createdAt);
        return d && d.getTime() >= startMs && d.getTime() <= endMs;
      });
      const venta = pedSem.reduce((s, p) => s + Number(p.total || p.monto || 0), 0);

      // Visitas
      const visSem = (visitasPorAlias[alias] || []).filter(v => {
        const d = _toDate(v.timestamp);
        return d && d.getTime() >= startMs && d.getTime() <= endMs;
      });
      const visitas = visSem.length;

      // Litros N10
      let litros = 0;
      if (comisionesPorAlias[alias]) {
        const comSem = comisionesPorAlias[alias].filter(c => {
          const d = _toDate(c.fecha);
          return d && d.getTime() >= startMs && d.getTime() <= endMs;
        });
        litros = comSem.reduce((s,c) => s + Number(c.litros || 0), 0);
      } else {
        pedSem.forEach(p => {
          (Array.isArray(p.items) ? p.items : []).forEach(it => {
            const marc = (it.marca || "").toLowerCase();
            if (marc.includes("nutrici") || marc.includes("n10"))
              litros += Number(it.litros_por_unidad || 0) * Number(it.cantidad || 0);
          });
        });
      }

      // Recuperacion
      let recuperacion = 0;
      remisiones.forEach(rem => {
        (Array.isArray(rem.abonos) ? rem.abonos : []).forEach(ab => {
          if (ab.quienRegistro !== alias) return;
          const d = ab.fecha ? new Date(ab.fecha + "T12:00:00") : null;
          if (d && d.getTime() >= startMs && d.getTime() <= endMs)
            recuperacion += Number(ab.monto || 0);
        });
      });

      // Prospectos
      const clSem = (clientesPorAlias[alias] || []).filter(c => {
        const raw = c.creadoEn;
        const d = _toDate(raw) || (typeof raw === "number" ? new Date(raw) : null);
        return d && d.getTime() >= startMs && d.getTime() <= endMs;
      });
      const prospectos = clSem.length;

      // Convertidos: prospectos que tienen pedido en la semana
      const clienteIdsSem = new Set(clSem.map(c => c._id));
      const pedClientesSem = new Set(pedSem.map(p => p.clienteId).filter(Boolean));
      const convertidos = clienteIdsSem.size > 0
        ? [...clienteIdsSem].filter(id => pedClientesSem.has(id)).length
        : 0;

      kpiData[alias][sem] = { venta, visitas, litros, recuperacion, prospectos, convertidos };
    }
  }

  return { kpiData, metas };
}

function _calcularInsights(kpiData, metas, aliases, semanas) {
  const insights = [];
  const recs = [];

  const getMetaVal = (alias, kd) => metas[alias]?.[kd.metaField] || 0;
  const promKPI = (alias, key) => {
    const vals = semanas.map(s => kpiData[alias]?.[s]?.[key] || 0);
    return vals.reduce((a,b)=>a+b,0) / Math.max(vals.length,1);
  };
  const pctProm = (alias, kd) => {
    const m = getMetaVal(alias, kd);
    return m > 0 ? promKPI(alias, kd.key) / m : null;
  };

  // R1 - Brecha
  if (aliases.length >= 2) {
    KPI_DEFS.forEach(kd => {
      const pcts = aliases.map(a => ({ a, p: pctProm(a, kd) })).filter(x => x.p !== null);
      if (pcts.length < 2) return;
      pcts.sort((a,b) => b.p - a.p);
      const best = pcts[0], worst = pcts[pcts.length-1];
      const brecha = (best.p - worst.p) * 100;
      if (brecha > 30) {
        insights.push({ tipo:"critico", texto: `${kd.label}: ${resolverNombre(best.a)||best.a} promedia ${Math.round(best.p*100)}% de meta vs ${resolverNombre(worst.a)||worst.a} ${Math.round(worst.p*100)}% — brecha de ${Math.round(brecha)} pp` });
        recs.push(`Nivelar ${kd.label.toLowerCase()}: acompanar a ${resolverNombre(worst.a)||worst.a} para identificar brechas operativas vs ${resolverNombre(best.a)||best.a}`);
      }
    });
  }

  // R2 - KPI sistemico bajo
  KPI_DEFS.forEach(kd => {
    const pcts = aliases.map(a => pctProm(a, kd)).filter(p => p !== null);
    if (!pcts.length) return;
    const minP = Math.min(...pcts), maxP = Math.max(...pcts);
    if (maxP < 0.6) {
      insights.push({ tipo:"critico", texto: `${kd.label}: ningun ingeniero supera el 60% de meta (rango ${Math.round(minP*100)}%–${Math.round(maxP*100)}%)` });
      recs.push(`Revisar meta de ${kd.label.toLowerCase()}: todos estan por debajo del 60%; puede ser meta fuera de rango o dato no registrado`);
    }
  });

  // R3 - Problema de cierre
  aliases.forEach(alias => {
    const pVis = pctProm(alias, KPI_DEFS[1]);
    const pCon = pctProm(alias, KPI_DEFS[5]);
    if (pVis !== null && pCon !== null && pVis > 0.7 && pCon < 0.45) {
      insights.push({ tipo:"alerta", texto: `${resolverNombre(alias)||alias}: visita al ${Math.round(pVis*100)}% pero convierte al ${Math.round(pCon*100)}% — posible problema en cierre, no en actividad` });
      recs.push(`Foco en cierre para ${resolverNombre(alias)||alias}: visitas (${Math.round(pVis*100)}%) son suficientes; la conversion (${Math.round(pCon*100)}%) requiere acompanamiento en ruta`);
    }
  });

  // R4 - Caida de tendencia
  if (semanas.length >= 3) {
    aliases.forEach(alias => {
      const bajando = KPI_DEFS.filter(kd => {
        const vals = semanas.map(s => kpiData[alias]?.[s]?.[kd.key] || 0);
        const n = vals.length;
        return vals[n-1] < vals[n-2] && vals[n-2] < vals[n-3];
      });
      if (bajando.length >= 2) {
        const lastSem = semanas[semanas.length-1];
        insights.push({ tipo:"alerta", texto: `${resolverNombre(alias)||alias} S${semanas[semanas.length-2]}→S${lastSem}: caida en ${bajando.map(k=>k.label).join(", ")} — verificar si la semana esta completa` });
      }
    });
  }

  // R5 - Pico de prospecteo sin cierre
  aliases.forEach(alias => {
    const metaP = metas[alias]?.metaProspectos || 0;
    const metaC = metas[alias]?.metaConvertidos || 0;
    if (!metaP || !metaC) return;
    semanas.forEach(s => {
      const prosp = kpiData[alias]?.[s]?.prospectos || 0;
      const conv  = kpiData[alias]?.[s]?.convertidos || 0;
      if (prosp / metaP > 1.3 && conv / metaC < 0.3)
        insights.push({ tipo:"info", texto: `S${s} ${resolverNombre(alias)||alias}: ${Math.round(prosp/metaP*100)}% de meta en prospectos pero solo ${Math.round(conv/metaC*100)}% en convertidos — pipeline sin cerrar` });
    });
  });

  // R6 - Cartera volatil
  aliases.forEach(alias => {
    const vals = semanas.map(s => kpiData[alias]?.[s]?.recuperacion || 0).filter(v=>v>0);
    if (vals.length < 2) return;
    const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
    const desv = Math.sqrt(vals.reduce((a,v)=>a+(v-avg)**2,0)/vals.length);
    if (desv > 0.25 * avg && avg > 0) {
      const minV = Math.min(...vals), maxV = Math.max(...vals);
      const minS = semanas[vals.indexOf(minV)], maxS = semanas[vals.indexOf(maxV)];
      insights.push({ tipo:"alerta", texto: `${resolverNombre(alias)||alias}: recuperacion volatil — min ${MXN(minV)} (S${minS}) vs max ${MXN(maxV)} (S${maxS}), sin patron estable` });
    }
  });

  // R7 - Semana estrella
  aliases.forEach(alias => {
    semanas.forEach(s => {
      const sobreMeta = KPI_DEFS.filter(kd => {
        const val = kpiData[alias]?.[s]?.[kd.key] || 0;
        const metaVal = metas[alias]?.[kd.metaField] || 0;
        return metaVal > 0 && val >= metaVal;
      });
      if (sobreMeta.length >= 3)
        insights.push({ tipo:"positivo", texto: `${resolverNombre(alias)||alias} S${s}: supero meta en ${sobreMeta.map(k=>k.label).join(", ")} — identificar y replicar condiciones` });
    });
  });

  return { insights, recs };
}

function _grafTendencia(kpiData, metas, aliases, semanas, kd) {
  const W=580, H=180, pL=58, pB=28, pR=16, pT=20;
  const iW=W-pL-pR, iH=H-pB-pT;
  const all = aliases.flatMap(a => semanas.map(s => kpiData[a]?.[s]?.[kd.key]||0));
  const allMetas = aliases.map(a => metas[a]?.[kd.metaField]||0);
  const maxVal = Math.max(...all, ...allMetas, 1);
  const xPos = i => pL + (i / Math.max(semanas.length-1,1)) * iW;
  const yPos = v => pT + iH - (v/maxVal) * iH;
  const fmtY = v => v>=1e6?(v/1e6).toFixed(1)+"M":v>=1000?Math.round(v/1000)+"k":Math.round(v);

  const gridLines = [0,0.25,0.5,0.75,1].map(r => {
    const y = pT + iH - r*iH;
    return `<line x1="${pL}" y1="${y}" x2="${pL+iW}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>
    <text x="${pL-4}" y="${y+3}" text-anchor="end" font-size="8" fill="var(--text-muted)">${fmtY(r*maxVal)}</text>`;
  }).join("");

  const xLabels = semanas.map((s,i) =>
    `<text x="${xPos(i)}" y="${H-6}" text-anchor="middle" font-size="8" fill="var(--text-muted)">S${s}</text>`
  ).join("");

  let svgLines = "";
  aliases.forEach((alias, ai) => {
    const color = ING_COLORS[ai % ING_COLORS.length];
    const pts = semanas.map((s,i) => [xPos(i), yPos(kpiData[alias]?.[s]?.[kd.key]||0)]);
    if (pts.length < 2) return;
    svgLines += `<path d="M${pts.map(p=>p.join(",")).join(" L")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
    pts.forEach(([x,y],i) =>
      svgLines += `<circle cx="${x}" cy="${y}" r="3" fill="${color}" stroke="var(--surface)" stroke-width="1.5"><title>${esc(resolverNombre(alias)||alias)} S${semanas[i]}: ${kd.fmt(kpiData[alias]?.[semanas[i]]?.[kd.key]||0)}</title></circle>`
    );
    const metaVal = metas[alias]?.[kd.metaField]||0;
    if (metaVal>0) {
      const yM = yPos(metaVal);
      svgLines += `<line x1="${pL}" y1="${yM}" x2="${pL+iW}" y2="${yM}" stroke="${color}" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>`;
    }
  });

  let legend = "";
  aliases.forEach((alias,ai) => {
    const color = ING_COLORS[ai % ING_COLORS.length];
    const lx = pL + ai * 120;
    legend += `<rect x="${lx}" y="6" width="10" height="3" fill="${color}" rx="1"/>
    <text x="${lx+13}" y="10" font-size="8" fill="var(--text-secondary)">${esc(resolverNombre(alias)||alias)}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto">
    ${gridLines}${xLabels}${svgLines}${legend}
  </svg>`;
}

function _grafBarrasCumplimiento(kpiData, metas, aliases, semanas) {
  if (!aliases.length) return "<p>Sin datos</p>";
  const W=580, barH=22, gap=4, padL=110, padR=50, padT=28, padB=16;
  const groupH = (barH+gap)*aliases.length;
  const groupGap = 14;
  const H = padT + KPI_DEFS.length*(groupH+groupGap) + padB;

  let rects = `<text x="${padL}" y="16" font-size="9" fill="var(--text-muted)">Promedio del periodo — linea punteada = 100% de meta</text>`;
  KPI_DEFS.forEach((kd,ki) => {
    const gY = padT + ki*(groupH+groupGap);
    rects += `<text x="${padL-6}" y="${gY+groupH/2+4}" text-anchor="end" font-size="8" fill="var(--text-secondary)">${esc(kd.label)}</text>`;
    aliases.forEach((alias,ai) => {
      const avg = semanas.reduce((s,w)=>s+(kpiData[alias]?.[w]?.[kd.key]||0),0)/Math.max(semanas.length,1);
      const metaVal = metas[alias]?.[kd.metaField]||0;
      const pctVal = metaVal>0 ? Math.min(avg/metaVal,1.5) : 0;
      const pctDisp = metaVal>0 ? Math.round(avg/metaVal*100) : 0;
      const barW = pctVal*(W-padL-padR);
      const y = gY+ai*(barH+gap);
      const fillCol = pctDisp>=100?"#16A34A":pctDisp>=60?"#FBBF24":"#EF4444";
      rects += `<rect x="${padL}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${fillCol}" opacity="0.85"/>
      <text x="${padL+barW+4}" y="${y+barH/2+4}" font-size="8" fill="var(--text-primary)" font-weight="600">${pctDisp}%</text>`;
    });
    const x100 = padL+(W-padL-padR);
    rects += `<line x1="${x100}" y1="${gY}" x2="${x100}" y2="${gY+groupH}" stroke="#6B7280" stroke-width="0.8" stroke-dasharray="3 2"/>`;
  });

  let legend = "";
  aliases.forEach((alias,ai) => {
    const color = ING_COLORS[ai%ING_COLORS.length];
    legend += `<rect x="${padL+ai*130}" y="0" width="10" height="3" fill="${color}" rx="1"/>
    <text x="${padL+ai*130+13}" y="4" font-size="8" fill="var(--text-secondary)">${esc(resolverNombre(alias)||alias)}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto">
    ${legend}${rects}
  </svg>`;
}

function _grafEmbudo(kpiData, metas, aliases, semanas) {
  const W=560, rowH=36, padL=120, padR=80, padT=22;
  const H = padT + aliases.length*(rowH+8)+20;
  let rows = "";
  aliases.forEach((alias,ai) => {
    const color = ING_COLORS[ai%ING_COLORS.length];
    const totP = semanas.reduce((s,w)=>s+(kpiData[alias]?.[w]?.prospectos||0),0);
    const totC = semanas.reduce((s,w)=>s+(kpiData[alias]?.[w]?.convertidos||0),0);
    const tasa = totP>0?Math.round(totC/totP*100):0;
    const maxW = W-padL-padR;
    const cBarW = totP>0?Math.round(totC/totP*maxW):0;
    const y = padT+ai*(rowH+8);
    rows += `<text x="${padL-6}" y="${y+rowH/2+4}" text-anchor="end" font-size="9" fill="var(--text-secondary)" font-weight="600">${esc(resolverNombre(alias)||alias)}</text>
    <rect x="${padL}" y="${y}" width="${maxW}" height="${rowH/2-2}" rx="2" fill="${color}" opacity="0.18"/>
    <text x="${padL+maxW/2}" y="${y+rowH/4+3}" text-anchor="middle" font-size="8" fill="var(--text-secondary)">${NUM(totP)} prospectos</text>
    <rect x="${padL}" y="${y+rowH/2+2}" width="${cBarW}" height="${rowH/2-2}" rx="2" fill="${color}" opacity="0.75"/>
    <text x="${padL+Math.max(cBarW/2,4)}" y="${y+rowH-4}" text-anchor="middle" font-size="8" fill="var(--surface)">${NUM(totC)} conv.</text>
    <text x="${padL+maxW+6}" y="${y+rowH/2+4}" font-size="9" fill="${tasa>=50?"#16A34A":tasa>=25?"#D97706":"#DC2626"}" font-weight="700">${tasa}%</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto">
    <text x="${padL}" y="14" font-size="9" fill="var(--text-muted)">Prospectos → Convertidos (total del periodo)</text>
    ${rows}
  </svg>`;
}

function _grafHeatmap(kpiData, metas, aliases, semanas) {
  const cols = [];
  aliases.forEach(a => semanas.forEach(s => cols.push({ alias:a, sem:s })));
  const cellW = Math.min(62, Math.floor(500/Math.max(cols.length,1)));
  const cellH = 28;
  const labelW = 120;
  const W = labelW+cols.length*(cellW+2)+10;
  const H = 32+KPI_DEFS.length*(cellH+2);

  let cells = "";
  cols.forEach((col,ci) => {
    const x = labelW+ci*(cellW+2);
    const nm = (resolverNombre(col.alias)||col.alias).split(" ")[0];
    cells += `<text x="${x+cellW/2}" y="12" text-anchor="middle" font-size="7" fill="var(--text-muted)">${esc(nm)}</text>
    <text x="${x+cellW/2}" y="22" text-anchor="middle" font-size="7" fill="var(--text-muted)">S${col.sem}</text>`;
  });

  KPI_DEFS.forEach((kd,ki) => {
    const y = 32+ki*(cellH+2);
    cells += `<text x="${labelW-4}" y="${y+cellH/2+4}" text-anchor="end" font-size="8" fill="var(--text-secondary)">${esc(kd.label)}</text>`;
    cols.forEach((col,ci) => {
      const x = labelW+ci*(cellW+2);
      const val = kpiData[col.alias]?.[col.sem]?.[kd.key]||0;
      const metaVal = metas[col.alias]?.[kd.metaField]||0;
      const pctVal = metaVal>0?val/metaVal:null;
      const bg = pctVal===null?"#E5E7EB":pctVal>=1?"#16A34A":pctVal>=0.6?"#FBBF24":"#EF4444";
      const tx = pctVal===null?"—":Math.round(pctVal*100)+"%";
      const tc = pctVal===null?"#6B7280":"#fff";
      cells += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="3" fill="${bg}"/>
      <text x="${x+cellW/2}" y="${y+cellH/2+4}" text-anchor="middle" font-size="8" fill="${tc}" font-weight="700">${tx}</text>`;
    });
  });

  return `<svg viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto">${cells}</svg>`;
}

function _tabKpiIngenieros() {
  const ahora = new Date();
  const semActual = _isoWeek(ahora);
  const yearActual = ahora.getFullYear();

  const semOptsIni = Array.from({length:52},(_,i)=>i+1).map(s =>
    `<option value="${s}" ${s===Math.max(semActual-6,1)?"selected":""}>${"S"+s}</option>`
  ).join("");
  const semOptsFin = Array.from({length:52},(_,i)=>i+1).map(s =>
    `<option value="${s}" ${s===semActual?"selected":""}>${"S"+s}</option>`
  ).join("");

  const html = `<div id="bi-comp-wrap">
  <div class="bi-card" style="margin-bottom:14px" id="bi-comp-config">
    <div class="bi-card-title">&#x1F465; Analisis Comparativo de Ingenieros</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Periodo</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          <label style="font-size:12px;color:var(--text-secondary)">Anio:</label>
          <select id="bi-comp-year" style="background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:5px 8px;font-size:12px">
            <option value="${yearActual-1}">${yearActual-1}</option>
            <option value="${yearActual}" selected>${yearActual}</option>
          </select>
          <label style="font-size:12px;color:var(--text-secondary)">Sem. inicio:</label>
          <select id="bi-comp-sem-ini" style="background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:5px 8px;font-size:12px">${semOptsIni}</select>
          <label style="font-size:12px;color:var(--text-secondary)">Sem. fin:</label>
          <select id="bi-comp-sem-fin" style="background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:5px 8px;font-size:12px">${semOptsFin}</select>
        </div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Modo de comparacion</div>
        <div class="bi-comp-toggle" style="margin-bottom:10px">
          <button id="bi-comp-modo-todos" class="active" onclick="window._biCompToggleModo('todos')">Todos vs Meta</button>
          <button id="bi-comp-modo-grupos" onclick="window._biCompToggleModo('grupos')">Grupo A vs Grupo B</button>
        </div>
        <div id="bi-comp-todos-wrap">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Ingenieros: <span id="bi-comp-ing-count">Cargando...</span></div>
          <select id="bi-comp-sel-todos" multiple style="width:100%;height:80px;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:4px;font-size:12px"></select>
          <div style="font-size:10px;color:var(--text-muted);margin-top:3px">Ctrl+clic para varios. Sin seleccion = todos.</div>
        </div>
        <div id="bi-comp-grupos-wrap" style="display:none">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Grupo A:</div>
          <select id="bi-comp-grupoA" multiple style="width:100%;height:70px;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:4px;font-size:12px"></select>
          <div style="font-size:11px;color:var(--text-muted);margin:6px 0 4px">Grupo B:</div>
          <select id="bi-comp-grupoB" multiple style="width:100%;height:70px;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:4px;font-size:12px"></select>
        </div>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:12px">
      <button onclick="window._biAnalizar()" style="background:var(--accent,#16A34A);color:#fff;border:none;border-radius:8px;padding:9px 24px;font-size:13px;font-weight:700;cursor:pointer">&#x25B6; ANALIZAR</button>
    </div>
  </div>
  <div id="bi-comp-resultados"></div>
</div>`;

  // Cargar ingenieros async
  setTimeout(async () => {
    const wrap    = document.getElementById("bi-comp-sel-todos");
    const wrapA   = document.getElementById("bi-comp-grupoA");
    const wrapB   = document.getElementById("bi-comp-grupoB");
    const countEl = document.getElementById("bi-comp-ing-count");
    if (!wrap) return;
    const ings = await _cargarIngenieros();
    if (countEl) countEl.textContent = ings.length + " ingenieros";
    const optsHtml = ings.map(ing =>
      `<option value="${esc(ing.alias)}">${esc(ing.nombre||ing.alias)}</option>`
    ).join("");
    wrap.innerHTML = optsHtml;
    if (wrapA) wrapA.innerHTML = optsHtml;
    if (wrapB) wrapB.innerHTML = optsHtml;
  }, 0);

  window._biCompModo = "todos";
  window._biCompToggleModo = (modo) => {
    window._biCompModo = modo;
    document.getElementById("bi-comp-modo-todos")?.classList.toggle("active", modo==="todos");
    document.getElementById("bi-comp-modo-grupos")?.classList.toggle("active", modo==="grupos");
    const wT = document.getElementById("bi-comp-todos-wrap");
    const wG = document.getElementById("bi-comp-grupos-wrap");
    if (wT) wT.style.display = modo==="todos" ? "" : "none";
    if (wG) wG.style.display = modo==="grupos" ? "" : "none";
  };

  window._biAnalizar = async () => {
    const res = document.getElementById("bi-comp-resultados");
    if (!res) return;
    res.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)">
      <div style="font-size:32px;margin-bottom:10px">&#x23F3;</div>Cargando datos...</div>`;

    const year = parseInt(document.getElementById("bi-comp-year")?.value || new Date().getFullYear());
    const sIni = parseInt(document.getElementById("bi-comp-sem-ini")?.value || 1);
    const sFin = parseInt(document.getElementById("bi-comp-sem-fin")?.value || 1);
    const semanas = [];
    for (let s=sIni; s<=sFin; s++) semanas.push(s);
    if (!semanas.length) {
      res.innerHTML = `<p style="color:#EF4444;padding:20px">Selecciona un rango de semanas valido.</p>`;
      return;
    }

    let aliases = [];
    if (window._biCompModo === "grupos") {
      const selA = [...(document.getElementById("bi-comp-grupoA")?.selectedOptions||[])].map(o=>o.value);
      const selB = [...(document.getElementById("bi-comp-grupoB")?.selectedOptions||[])].map(o=>o.value);
      aliases = [...new Set([...selA,...selB])];
    } else {
      const sel = [...(document.getElementById("bi-comp-sel-todos")?.selectedOptions||[])].map(o=>o.value);
      if (sel.length) {
        aliases = sel;
      } else {
        const ings = await _cargarIngenieros();
        aliases = ings.map(i=>i.alias);
      }
    }
    if (!aliases.length) {
      res.innerHTML = `<p style="color:#EF4444;padding:20px">Selecciona al menos un ingeniero.</p>`;
      return;
    }

    try {
      const { kpiData, metas } = await _cargarKPIs(aliases, semanas, year);
      const bloques = [];

      bloques.push(`<div class="bi-card" style="margin-bottom:14px">
        <div class="bi-card-title">&#x1F4B0; Tendencia — Venta semanal</div>
        ${_grafTendencia(kpiData,metas,aliases,semanas,KPI_DEFS[0])}
      </div>`);

      bloques.push(`<div class="bi-card" style="margin-bottom:14px">
        <div class="bi-card-title">&#x1F4B3; Tendencia — Recuperacion de cartera</div>
        ${_grafTendencia(kpiData,metas,aliases,semanas,KPI_DEFS[3])}
      </div>`);

      bloques.push(`<div class="bi-card" style="margin-bottom:14px">
        <div class="bi-card-title">&#x1F4A7; Tendencia — Litros N10</div>
        ${_grafTendencia(kpiData,metas,aliases,semanas,KPI_DEFS[2])}
      </div>`);

      bloques.push(`<div class="bi-card" style="margin-bottom:14px">
        <div class="bi-card-title">&#x1F4CA; % Cumplimiento por KPI (promedio del periodo)</div>
        ${_grafBarrasCumplimiento(kpiData,metas,aliases,semanas)}
      </div>`);

      bloques.push(`<div class="bi-card" style="margin-bottom:14px">
        <div class="bi-card-title">&#x1F9F2; Embudo de conversion: Prospectos → Convertidos</div>
        ${_grafEmbudo(kpiData,metas,aliases,semanas)}
      </div>`);

      bloques.push(`<div class="bi-card" style="margin-bottom:14px">
        <div class="bi-card-title">&#x1F321;&#xFE0F; Mapa de calor KPI × Semana</div>
        <div style="font-size:10px;color:var(--text-muted);margin-bottom:8px">
          <span style="background:#16A34A;color:#fff;padding:2px 6px;border-radius:3px;margin-right:6px">&#x2265;100%</span>
          <span style="background:#FBBF24;color:#fff;padding:2px 6px;border-radius:3px;margin-right:6px">60–99%</span>
          <span style="background:#EF4444;color:#fff;padding:2px 6px;border-radius:3px;margin-right:6px">&lt;60%</span>
          <span style="background:#E5E7EB;color:#6B7280;padding:2px 6px;border-radius:3px">Sin meta</span>
        </div>
        <div style="overflow-x:auto">${_grafHeatmap(kpiData,metas,aliases,semanas)}</div>
      </div>`);

      const { insights, recs } = _calcularInsights(kpiData,metas,aliases,semanas);
      const insHtml = insights.length
        ? insights.map(ins =>
            `<div class="bi-comp-insight ${ins.tipo}">
              <span>${ins.tipo==="critico"?"&#x1F534;":ins.tipo==="alerta"?"&#x1F7E1;":ins.tipo==="positivo"?"&#x1F7E2;":"&#x1F535;"}</span>
              <span>${esc(ins.texto)}</span>
            </div>`
          ).join("")
        : `<p style="color:var(--text-muted);font-size:13px">No se detectaron insights significativos para el periodo seleccionado.</p>`;

      const recsHtml = recs.length
        ? `<ol style="margin:0;padding-left:18px;font-size:13px;line-height:1.8;color:var(--text-secondary)">${recs.map(r=>`<li>${esc(r)}</li>`).join("")}</ol>`
        : "";

      bloques.push(`<div class="bi-card" style="margin-bottom:14px">
        <div class="bi-card-title">&#x1F4A1; Insights del periodo</div>
        ${insHtml}
        ${recs.length?`<div class="bi-card-title" style="margin-top:14px">&#x1F3AF; Recomendaciones</div>${recsHtml}`:""}
      </div>`);

      res.innerHTML = bloques.join("");
    } catch(e) {
      res.innerHTML = `<div style="padding:20px;color:#EF4444">Error al analizar: ${esc(e.message)}</div>`;
      console.error("[BI Comparativo]", e);
    }
  };

  return html;
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
    if (!b) return "<span style='color:var(--text-muted)'>&#8212;</span>";
    const d = (a-b)/b*100;
    const col = d>=0?"#4ADE80":"#F87171";
    return `<span style="color:${col};font-weight:600">${d>=0?"&#9650;":"&#9660;"} ${Math.abs(d).toFixed(1)}%</span>`;
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
      <thead><tr><th>Metrica</th><th>${hX}</th><th>${hY}</th><th>&#916;</th></tr></thead>
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
    <div class="bi-card-title">MoM &#8212; Mes actual vs anterior</div>
    ${tbl(kA,kB,mesAct,mesAnt)}
  </div>
  <div class="bi-card">
    <div class="bi-card-title">YoY &#8212; Mes actual vs mismo mes anio anterior</div>
    ${tbl(kA,kC,mesAct,mesYoY)}
  </div>
</div>
<div class="bi-card">
  <div class="bi-card-title">Historico mensual &#8212; ultimos 6 meses</div>
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
    <div class="kpi-card" style="border-left-color:${color}">
      <div class="kpi-icon">${ico}</div>
      <div class="kpi-val">${val}</div>
      <div class="kpi-label">${lbl}${sub ? ` · ${sub}` : ""}</div>
    </div>`;

  // Top 20 productos por valor en costo
  const topProds = [...rows].sort((a, b) => b.valorCosto - a.valorCosto).slice(0, 20);
  const barMax   = topProds[0]?.valorCosto || 1;

  return `
<!-- KPIs globales -->
<div class="kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-bottom:18px">
  ${_kpi("📦", "VALOR EN COSTO",  MXN(totalCosto),  "var(--text-muted,#9CA3AF)")}
  ${_kpi("🏷️", "VALOR EN PRECIO", MXN(totalPrecio), "#4ADE80", margen >= 0 ? `+${MXN(margen)} margen` : `${MXN(margen)}`)}
  ${_kpi("📊", "% MARGEN BRUTO",  `${margenPct.toFixed(1)}%`, "#FBBF24")}
  ${_kpi("🔄", "ROTACIÓN ANUAL",  rotacion ? `${rotacion}×` : "—", "#60A5FA", dio ? `${dio} días inv.` : "")}
  ${_kpi("💸", "HOLDING COST",    MXN(costoHolding), "#F87171", `${carryPct.toFixed(1)}% del inventario`)}
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
    { id:"dashboard",     label:"&#x1F4CA; Dashboard" },
    { id:"rentabilidad",  label:"&#x1F4B0; Rentabilidad" },
    { id:"comparativo",   label:"&#x1F4C5; Comparativo" },
    { id:"kpi_ingenieros",label:"&#x1F465; KPI Ingenieros" },
    { id:"demanda",       label:"&#x1F52E; Demanda" },
    { id:"inventario",    label:"&#x1F3ED; Inventario" },
  ];

  let body = "";
  if (_tab === "dashboard")      body = _tabDashboard(datos);
  if (_tab === "rentabilidad")   body = _tabRentabilidad(datos);
  if (_tab === "comparativo")    body = _tabComparativo(_pedidos);
  if (_tab === "kpi_ingenieros") body = _tabKpiIngenieros();
  if (_tab === "demanda")        body = _tabDemanda(_pedidos);
  if (_tab === "inventario")     body = _tabInventario();

  _container.innerHTML = `
<style>
  .bi-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}
  .bi-card-title{font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:12px}
  .bi-tab{background:transparent;border:none;border-bottom:2px solid transparent;padding:8px 18px;cursor:pointer;font-size:13px;color:var(--text-secondary)}
  .bi-tab.active{border-bottom-color:var(--accent);color:var(--text-primary);font-weight:600}
  .bi-table{width:100%;border-collapse:collapse;font-size:12px}
  .bi-table th{text-align:center;padding:6px 8px;border-bottom:2px solid var(--border);color:var(--text-muted);font-size:11px;font-weight:600;white-space:nowrap;background:var(--surface-2,var(--bg));position:sticky;top:0;z-index:2}
  .bi-table td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:center}
  .bi-table tbody tr:hover{background:var(--surface2)}
  .bi-filter select{background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
  .bi-comp-toggle{display:flex;gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .bi-comp-toggle button{background:transparent;border:none;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;color:var(--text-sec);transition:all .15s}
  .bi-comp-toggle button.active{background:var(--green-dark,#1B5E20);color:#fff}
  .bi-comp-insight{padding:10px 14px;border-radius:8px;margin-bottom:8px;font-size:13px;line-height:1.5;display:flex;gap:10px;align-items:flex-start}
  .bi-comp-insight.critico{background:#FEF2F2;color:#991B1B;border-left:3px solid #EF4444}
  .bi-comp-insight.alerta{background:#FFFBEB;color:#92400E;border-left:3px solid #F59E0B}
  .bi-comp-insight.positivo{background:#F0FDF4;color:#166534;border-left:3px solid #16A34A}
  .bi-comp-insight.info{background:#EFF6FF;color:#1E40AF;border-left:3px solid #3B82F6}
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
