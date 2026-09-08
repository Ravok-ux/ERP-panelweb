// ══════════════════════════════════════════════════════════════
// dashboard.js — KPIs en tiempo real + ranking + mini-mapa + feed
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, estaEnJornadaHoy } from "./app.js";
import {
  collection, query, where, onSnapshot, orderBy,
  limit, Timestamp, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Canvas chart helpers ───────────────────────────────────────
function _cvs(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const dpr = window.devicePixelRatio || 1;
  const w   = el.clientWidth  || parseInt(el.style.width)  || 300;
  const h   = el.clientHeight || parseInt(el.style.height) || 110;
  el.width  = w * dpr;
  el.height = h * dpr;
  const ctx = el.getContext("2d");
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}
function _dark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : window.matchMedia("(prefers-color-scheme:dark)").matches;
}

function _chartLinea(id, labels, values) {
  const c = _cvs(id); if (!c) return;
  const { ctx, w, h } = c;
  const dk   = _dark();
  const C_LINE = "#16A34A", C_FILL = dk ? "rgba(22,163,74,.3)" : "rgba(22,163,74,.15)";
  const C_TXT  = dk ? "#9CA3AF" : "#6B7280", C_GRID = dk ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)";
  const PL=6, PR=6, PT=10, PB=22;
  const cW = w-PL-PR, cH = h-PT-PB;
  const max = Math.max(...values, 1);
  const n   = values.length;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = C_GRID; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
  [0.5, 1].forEach(r => {
    const y = PT + cH * (1 - r);
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL+cW, y); ctx.stroke();
  });
  ctx.setLineDash([]);

  const pts = values.map((v, i) => ({
    x: PL + (n > 1 ? (i / (n-1)) * cW : cW/2),
    y: PT + cH - (v / max) * cH
  }));

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[n-1].x, PT+cH);
  ctx.lineTo(pts[0].x, PT+cH);
  ctx.closePath();
  ctx.fillStyle = C_FILL; ctx.fill();

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = C_LINE; ctx.lineWidth = 2; ctx.stroke();

  pts.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2);
    ctx.fillStyle = C_LINE; ctx.fill();
    ctx.fillStyle = C_TXT; ctx.font = "9px system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText(labels[i], p.x, h-4);
  });
}

function _chartBarras(id, entries) {
  const c = _cvs(id); if (!c) return;
  const { ctx, w, h } = c;
  const dk  = _dark();
  const C_BAR  = dk ? "#4ADE80" : "#16A34A";
  const C_TXT  = dk ? "#9CA3AF" : "#6B7280";
  const C_TRCK = dk ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.05)";

  ctx.clearRect(0, 0, w, h);
  if (!entries.length) {
    ctx.fillStyle = C_TXT; ctx.font = "11px system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Sin datos", w/2, h/2); return;
  }

  const LABEL_W = 74, PAD = 6;
  const max   = entries[0][1] || 1;
  const rowH  = (h - PAD*2) / entries.length;

  entries.forEach(([nombre, valor], i) => {
    const y    = PAD + i * rowH;
    const bH   = Math.max(8, rowH - 6);
    const bY   = y + (rowH - bH)/2;
    const bW   = Math.max(2, ((valor/max) * (w - PAD - LABEL_W - PAD)));

    ctx.fillStyle = C_TRCK;
    ctx.fillRect(PAD + LABEL_W, bY, w - PAD - LABEL_W - PAD, bH);
    ctx.fillStyle = C_BAR;
    ctx.fillRect(PAD + LABEL_W, bY, bW, bH);

    const lbl = nombre.length > 11 ? nombre.slice(0,10)+"…" : nombre;
    ctx.fillStyle = C_TXT; ctx.font = "9px system-ui,sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(lbl, PAD + LABEL_W - 3, bY + bH/2);
  });
}

function _chartDonut(id, cobrado, pendiente) {
  const c = _cvs(id); if (!c) return;
  const { ctx, w, h } = c;
  const dk  = _dark();
  const C_COB  = "#16A34A", C_PEN = dk ? "#374151" : "#E5E7EB";
  const C_TXT  = dk ? "#E6EDF3" : "#111827", C_SUB = dk ? "#9CA3AF" : "#6B7280";
  const C_HOLE = dk ? "#1C2029" : "#FFFFFF";

  ctx.clearRect(0, 0, w, h);
  const total = cobrado + pendiente || 1;
  const cx = w/2, cy = (h-14)/2 + 4;
  const R  = Math.min(cx, cy) - 8;
  const r  = R * 0.58;
  const a0 = -Math.PI/2;
  const aC = (cobrado/total) * Math.PI * 2;

  ctx.beginPath(); ctx.arc(cx,cy,R,a0,a0+aC);
  ctx.arc(cx,cy,r,a0+aC,a0,true); ctx.closePath();
  ctx.fillStyle = C_COB; ctx.fill();
  ctx.beginPath(); ctx.arc(cx,cy,R,a0+aC,a0+Math.PI*2);
  ctx.arc(cx,cy,r,a0+Math.PI*2,a0+aC,true); ctx.closePath();
  ctx.fillStyle = C_PEN; ctx.fill();
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.fillStyle = C_HOLE; ctx.fill();

  const pct = Math.round((cobrado/total)*100);
  ctx.fillStyle = C_TXT; ctx.font = "bold 13px system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(pct+"%", cx, cy-2);
  ctx.fillStyle = C_SUB; ctx.font = "8px system-ui,sans-serif";
  ctx.fillText("cobrado", cx, cy+9);

  const lY = h - 7;
  ctx.fillStyle = C_COB; ctx.fillRect(4, lY-5, 7, 7);
  ctx.fillStyle = C_SUB; ctx.font = "8px system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText("Cobrado", 14, lY);
  ctx.fillStyle = C_PEN; ctx.fillRect(w/2+2, lY-5, 7, 7);
  ctx.fillStyle = C_SUB; ctx.fillText("Pendiente", w/2+12, lY);
}

// ── Gráfica: Meta mensual (barra progreso + acumulado) ─────────
function _chartMeta(id, actual, meta) {
  const c = _cvs(id); if (!c) return;
  const { ctx, w, h } = c;
  const dk   = _dark();
  const pct  = meta > 0 ? Math.min(actual / meta, 1) : 0;
  const C_OK = "#16A34A", C_MID = "#D97706", C_BAD = "#DC2626";
  const C_TRK = dk ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.07)";
  const C_TXT = dk ? "#E6EDF3" : "#111827";
  const C_SUB = dk ? "#9CA3AF" : "#6B7280";
  const color = pct >= 0.8 ? C_OK : pct >= 0.5 ? C_MID : C_BAD;

  ctx.clearRect(0, 0, w, h);

  // Barra de progreso
  const bY = h / 2 - 10, bH = 16, PL = 10, PR = 10;
  const bW = w - PL - PR;
  ctx.fillStyle = C_TRK;
  ctx.roundRect ? ctx.roundRect(PL, bY, bW, bH, 4) : ctx.fillRect(PL, bY, bW, bH);
  ctx.fill();
  ctx.fillStyle = color;
  const fill = Math.max(4, pct * bW);
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(PL, bY, fill, bH, 4) : ctx.fillRect(PL, bY, fill, bH);
  ctx.fill();

  // Labels
  ctx.fillStyle = C_TXT; ctx.font = "bold 11px system-ui,sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText(_fmt(actual), PL, bY - 4);
  ctx.fillStyle = C_SUB; ctx.font = "9px system-ui,sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("meta " + _fmt(meta), w - PR, bY - 4);

  // % centrado en barra
  ctx.fillStyle = "#fff"; ctx.font = "bold 10px system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if (pct > 0.15) ctx.fillText(Math.round(pct * 100) + "%", PL + fill / 2, bY + bH / 2);

  // Sub label
  ctx.fillStyle = C_SUB; ctx.font = "9px system-ui,sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  const diasMes = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate();
  const diaActual = new Date().getDate();
  ctx.fillText(`Día ${diaActual} de ${diasMes} — ${Math.round(pct*100)}% del objetivo`, w/2, h - 4);
}

// ── Gráfica: Cobrado 4 semanas (barras verticales) ────────────
function _chartCobranzaSemanas(id, semanas) {
  const c = _cvs(id); if (!c) return;
  const { ctx, w, h } = c;
  const dk  = _dark();
  const C_BAR = "#2563EB", C_HOY = "#60A5FA";
  const C_TXT = dk ? "#9CA3AF" : "#6B7280";
  const C_GRD = dk ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.05)";
  const PL=8, PR=8, PT=10, PB=22;
  const cW = w-PL-PR, cH = h-PT-PB;
  const max = Math.max(...semanas.map(s => s.total), 1);
  const n   = semanas.length;
  const bW  = Math.floor(cW / n) - 4;

  ctx.clearRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = C_GRD; ctx.lineWidth = 1; ctx.setLineDash([2,3]);
  [0.5, 1].forEach(r => {
    const y = PT + cH * (1-r);
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL+cW, y); ctx.stroke();
  });
  ctx.setLineDash([]);

  semanas.forEach((s, i) => {
    const x    = PL + i * (cW/n) + (cW/n - bW) / 2;
    const bH   = Math.max(2, (s.total / max) * cH);
    const bTop = PT + cH - bH;
    const isLast = i === n-1;

    ctx.fillStyle = isLast ? C_HOY : C_BAR;
    if (ctx.roundRect) {
      ctx.beginPath(); ctx.roundRect(x, bTop, bW, bH, [3,3,0,0]); ctx.fill();
    } else {
      ctx.fillRect(x, bTop, bW, bH);
    }

    // Label monto arriba de barra
    if (s.total > 0) {
      ctx.fillStyle = C_TXT; ctx.font = "8px system-ui,sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.fillText(_fmtK(s.total), x + bW/2, bTop - 2);
    }

    // Label semana abajo
    ctx.fillStyle = C_TXT; ctx.font = isLast ? "bold 8px system-ui,sans-serif" : "8px system-ui,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText(s.label, x + bW/2, h - 4);
  });
}

// ── Gráfica: Embudo CRM ───────────────────────────────────────
function _chartFunnel(id, etapas) {
  const c = _cvs(id); if (!c) return;
  const { ctx, w, h } = c;
  const dk   = _dark();
  const C_TXT = dk ? "#E6EDF3" : "#111827";
  const C_SUB = dk ? "#9CA3AF" : "#6B7280";
  const COLORS = ["#6B7280","#2563EB","#D97706","#16A34A"];
  const n   = etapas.length;
  const max = Math.max(...etapas.map(e => e.count), 1);
  const PAD = 6, LABEL_W = 80, barMaxW = w - LABEL_W - PAD*3 - 30;
  const rowH = (h - PAD*2) / n;

  ctx.clearRect(0, 0, w, h);

  etapas.forEach((e, i) => {
    const y   = PAD + i * rowH;
    const bH  = Math.max(10, rowH - 6);
    const bY  = y + (rowH - bH) / 2;
    const bW  = Math.max(4, (e.count / max) * barMaxW);
    const col = COLORS[i % COLORS.length];

    // Track
    ctx.fillStyle = dk ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.05)";
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(PAD + LABEL_W, bY, barMaxW, bH, 3); ctx.fill(); }
    else ctx.fillRect(PAD + LABEL_W, bY, barMaxW, bH);

    // Bar
    ctx.fillStyle = col;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(PAD + LABEL_W, bY, bW, bH, 3); ctx.fill(); }
    else ctx.fillRect(PAD + LABEL_W, bY, bW, bH);

    // Label etapa
    ctx.fillStyle = C_TXT; ctx.font = "9px system-ui,sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(e.label, PAD + LABEL_W - 4, bY + bH/2);

    // Count
    ctx.fillStyle = C_SUB; ctx.font = "bold 9px system-ui,sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(String(e.count), PAD + LABEL_W + bW + 4, bY + bH/2);
  });
}

let _unsubs = [];

export const DashboardModule = {
  mount(container) {
    container.innerHTML = _html();
    _bindMapBtn();

    const unsub1  = _escucharKPIs();
    const unsub2  = _escucharCobranzaKPI();
    const unsub2b = _escucharInteresKPI();
    const unsub3  = _escucharCotizacionesKPI();
    const unsub4  = _escucharStockKPI();
    const unsub5  = _escucharDevolucionesKPI();
    const unsub6  = _escucharRanking();
    const unsub7  = _escucharUbicaciones();
    const unsub8  = _escucharFeedDash();
    const unsub9  = _escucharCharts();
    const unsub10 = _escucharFilaTres();
    const unsub11 = _escucharClientesSnapshot();
    const unsub12 = _escucharChartsNuevos();

    _unsubs = [unsub1, unsub2, unsub2b, unsub3, unsub4, unsub5,
               unsub6, unsub7, unsub8, unsub9, unsub10, unsub11, unsub12];
    return () => this.destroy();
  },

  destroy() {
    _unsubs.forEach(fn => fn && fn());
    _unsubs = [];
  }
};

// ── Estructura HTML ────────────────────────────────────────────
function _html() {
  return `
  <div class="dash-body">

    <!-- LEFT -->
    <div class="dash-left">

      <!-- KPIs fila 1: operación -->
      <div class="kpi-row" id="kpi-row">
        ${_kpiSkeleton("💰", "Vendido hoy",     "green")}
        ${_kpiSkeleton("📈", "Interés en riesgo","red")}
        ${_kpiSkeleton("🛒", "Pedidos activos",  "amber")}
        ${_kpiSkeleton("👷", "En campo",          "violet")}
      </div>

      <!-- KPIs fila 2: alertas -->
      <div class="kpi-row" id="kpi-row-2" style="margin-top:8px">
        ${_kpiSkeleton("📋", "Cotizaciones activas", "violet")}
        ${_kpiSkeleton("💸", "Cobranza vencida",     "red")}
        ${_kpiSkeleton("⚠️",  "Stock crítico",        "amber")}
        ${_kpiSkeleton("↩️",  "Devoluciones pend.",   "red")}
      </div>

      <!-- KPIs fila 3: caja -->
      <div class="kpi-row" id="kpi-row-3" style="margin-top:8px">
        ${_kpiSkeleton("🏦", "Cobrado hoy",      "blue")}
        ${_kpiSkeleton("💵", "Cobrado este mes",  "blue")}
        ${_kpiSkeleton("🎯", "Meta cobranza",    "green")}
        ${_kpiSkeleton("💸", "Gastos del día",   "amber")}
      </div>

      <!-- Gráficas fila 1: existentes -->
      <div class="charts-row" id="dash-charts-row">
        <div class="chart-card" style="flex:2">
          <div class="chart-label">📈 Ventas 7 días</div>
          <canvas id="ch-ventas" style="width:100%;height:110px;display:block"></canvas>
        </div>
        <div class="chart-card" style="flex:2">
          <div class="chart-label">📦 Top 5 productos</div>
          <canvas id="ch-productos" style="width:100%;height:110px;display:block"></canvas>
        </div>
        <div class="chart-card" style="flex:1;min-width:130px">
          <div class="chart-label">💰 Cobrado vs Cartera</div>
          <canvas id="ch-donut" style="width:100%;height:110px;display:block"></canvas>
        </div>
      </div>

      <!-- Gráficas fila 2: nuevas -->
      <div class="charts-row" id="dash-charts-row-2" style="margin-top:8px">
        <div class="chart-card" style="flex:3">
          <div class="chart-label">🎯 Ventas vs Meta mensual</div>
          <canvas id="ch-meta" style="width:100%;height:80px;display:block"></canvas>
        </div>
        <div class="chart-card" style="flex:2">
          <div class="chart-label">💳 Cobrado · últimas 4 semanas</div>
          <canvas id="ch-cob-sem" style="width:100%;height:80px;display:block"></canvas>
        </div>
        <div class="chart-card" style="flex:2">
          <div class="chart-label">🎯 Embudo CRM</div>
          <canvas id="ch-crm" style="width:100%;height:80px;display:block"></canvas>
        </div>
      </div>

      <!-- Sección Clientes -->
      <div class="sec-hdr" style="margin-top:12px">
        <span class="sec-title">Radiografía de clientes</span>
        <span class="sec-link" onclick="navigate('clientes')">Ver todos →</span>
      </div>
      <div id="dash-clientes-snapshot" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <!-- Semáforo chips + nuevos + sin visita -->
        <div id="dash-semaforo-chips" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <span style="font-size:11px;color:#888">Cargando…</span>
        </div>
      </div>
      <div id="dash-top-deudores" style="margin-bottom:12px">
        <!-- Top 5 deudores -->
      </div>

      <!-- Ranking -->
      <div class="sec-hdr">
        <span class="sec-title">Ranking de ingenieros · hoy</span>
        <span class="sec-link" onclick="navigate('ingenieros')">Ver todos →</span>
      </div>
      <table class="rank-table">
        <thead>
          <tr>
            <th>#</th><th>INGENIERO</th><th>VENDIDO</th>
            <th>% META</th><th>VISITAS</th><th>COB. MES</th><th>ESTADO</th>
          </tr>
        </thead>
        <tbody id="ranking-body">
          <tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px">
            <div class="skeleton" style="height:12px;width:200px;margin:0 auto"></div>
          </td></tr>
        </tbody>
      </table>
    </div>

    <!-- RIGHT PANEL -->
    <div class="dash-right">
      <div class="rp-map" id="rp-map-container">
        <div class="rp-map-grid" id="rp-map-grid"></div>
        <div class="rp-map-label">
          <span class="live-dot"></span> En vivo
        </div>
        <div id="rp-pins"></div>
        <a class="rp-map-btn" href="#" onclick="event.preventDefault();navigate('mapa')">
          Ver mapa completo →
        </a>
      </div>
      <div class="rp-feed-hdr">
        <div class="rp-feed-title">
          <span class="live-dot"></span> Feed en vivo
        </div>
        <span class="rp-filter">Filtrar ▾</span>
      </div>
      <div class="rp-feed" id="dash-feed">
        <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:11px">Cargando…</div>
      </div>
    </div>

  </div>`;
}

function _kpiSkeleton(icon, label, color) {
  const borders = { green:"#16A34A", blue:"#2563EB", amber:"#D97706",
                    violet:"#7C3AED", red:"#DC2626" };
  return `
    <div class="kpi-card" style="border-left-color:${borders[color] || '#6B7280'}">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-val skeleton" style="height:22px;width:90px">–</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-delta nt">–</div>
    </div>`;
}

// ── Fila 1 KPIs: Vendido hoy, Interés en riesgo, Pedidos activos, En campo ──
function _escucharKPIs() {
  const hoyInicio = _inicioDia();
  const pedidosQ  = query(
    collection(db, "pedidos"),
    where("fechaPedido", ">=", Timestamp.fromDate(hoyInicio))
  );

  return onSnapshot(pedidosQ, snap => {
    let vendido = 0, activos = 0;
    snap.forEach(d => {
      const p = d.data();
      if (["CONFIRMADO","EN_RUTA","ENTREGADO","FACTURADO"].includes(p.status))
        vendido += (p.total || 0);
      if (["CONFIRMADO","EN_RUTA","ENTREGADO"].includes(p.status)) activos++;
    });
    _renderKPI(0, "💰", "Vendido hoy",     _fmt(vendido),   "+18%", "up",  "#16A34A");
    _renderKPI(2, "🛒", "Pedidos activos", String(activos),
      `${activos} en curso`, "nt", "#D97706");
  }, _logErr("KPIs-pedidos"));
}

// ── KPI: Cotizaciones activas ─────────────────────────────────
function _escucharCotizacionesKPI() {
  const q = query(
    collection(db, "cotizaciones"),
    where("status", "in", ["BORRADOR","ENVIADA","APROBADA"])
  );
  return onSnapshot(q, snap => {
    const vencenHoy = snap.docs.filter(d => {
      const v = d.data().venceEn;
      if (!v) return false;
      const diff = v - Date.now();
      return diff > 0 && diff < 86400000;
    }).length;
    _renderKPI2(0, "📋", "Cotizaciones activas", String(snap.size),
      vencenHoy > 0 ? `${vencenHoy} vencen hoy` : "Al día",
      vencenHoy > 0 ? "dn" : "nt", "#7C3AED");
  }, _logErr("kpi-cotizaciones"));
}

// ── KPI: Cobranza vencida ────────────────────────────────────
function _escucharCobranzaKPI() {
  const q = query(
    collection(db, "clientes"),
    where("semaforoColor", "in", ["CRÍTICO","GRAVE","MODERADO","LEVE"])
  );
  return onSnapshot(q, snap => {
    let totalAPagar = 0, interes = 0;
    snap.forEach(d => {
      const c = d.data();
      totalAPagar += (c.totalAPagarTotal ?? c.saldoPendiente ?? 0);
      interes     += (c.interesTotal ?? 0);
    });
    const sub = interes > 0
      ? `${snap.size} clientes · +${_fmt(interes)} interés`
      : `${snap.size} clientes`;
    _renderKPI2(1, "💸", "Cartera vencida", _fmt(totalAPagar),
      sub, snap.size > 0 ? "dn" : "nt", "#DC2626");
  }, _logErr("kpi-cobranza"));
}

// ── KPI: Interés en riesgo ────────────────────────────────────
function _escucharInteresKPI() {
  const q = query(
    collection(db, "clientes"),
    where("semaforoColor", "in", ["CRÍTICO","GRAVE"])
  );
  return onSnapshot(q, snap => {
    let interesRiesgo = 0;
    snap.forEach(d => { interesRiesgo += (d.data().interesTotal ?? 0); });
    _renderKPI(1, "📈", "Interés en riesgo", _fmt(interesRiesgo),
      snap.size > 0 ? `${snap.size} cuentas críticas` : "Sin mora crítica",
      snap.size > 0 ? "dn" : "nt", "#DC2626");
  }, _logErr("kpi-interes-riesgo"));
}

// ── KPI: Stock crítico ────────────────────────────────────────
function _escucharStockKPI() {
  const q = query(
    collection(db, "alertas_stock"),
    where("resuelta", "==", false)
  );
  return onSnapshot(q, snap => {
    _renderKPI2(2, "⚠️", "Stock crítico", String(snap.size),
      snap.size > 0 ? "Requiere compra" : "Inventario OK",
      snap.size > 0 ? "dn" : "nt", "#D97706");
  }, _logErr("kpi-stock"));
}

// ── KPI: Devoluciones pendientes ──────────────────────────────
function _escucharDevolucionesKPI() {
  const q = query(
    collection(db, "devoluciones"),
    where("status", "==", "PENDIENTE")
  );
  return onSnapshot(q, snap => {
    const monto = snap.docs.reduce((s, d) => s + (d.data().monto || 0), 0);
    _renderKPI2(3, "↩️", "Devoluciones pend.", String(snap.size),
      snap.size > 0 ? _fmt(monto) + " acumulado" : "Sin pendientes",
      snap.size > 0 ? "dn" : "nt", "#DC2626");
  }, _logErr("kpi-devoluciones"));
}

// ── Fila 3: Caja — Cobrado hoy, Cobrado mes, Meta cobranza, Gastos ──
function _escucharFilaTres() {
  const hoyInicio = _inicioDia();
  const mesInicio = _inicioMes();

  // Cobrado hoy + mes: leer abonos de remisiones_credito (array abonos[])
  // Usamos un snapshot de remisiones activas/recientes
  const remQ = query(
    collection(db, "remisiones_credito"),
    where("status", "!=", "PAGADO"),
    limit(500)
  );

  let cobradoHoy = 0, cobradoMes = 0, metaTotal = 0, gastosHoy = 0;
  let remUnsub = null, metaUnsub = null, gastosUnsub = null;

  // --- Remisiones → cobrado hoy y mes ---
  remUnsub = onSnapshot(remQ, snap => {
    cobradoHoy = 0; cobradoMes = 0;
    snap.forEach(d => {
      const abonos = d.data().abonos || [];
      abonos.forEach(a => {
        const ts = a.fecha?.toDate?.() ?? (a.fecha ? new Date(a.fecha) : null);
        if (!ts) return;
        if (ts >= hoyInicio) cobradoHoy += (a.monto || 0);
        if (ts >= mesInicio) cobradoMes += (a.monto || 0);
      });
    });
    _renderFilaTres(cobradoHoy, cobradoMes, metaTotal, gastosHoy);
  }, _logErr("fila3-remisiones"));

  // --- Metas individuales (suma) ---
  metaUnsub = onSnapshot(collection(db, "metas"), snap => {
    const mes = new Date().getMonth();
    const anio = new Date().getFullYear();
    metaTotal = 0;
    snap.forEach(d => {
      const m = d.data();
      // Acepta campo metaMensual, meta, o metas[mes]
      if (Array.isArray(m.metas)) {
        metaTotal += (m.metas[mes] || 0);
      } else {
        metaTotal += (m.metaMensual || m.meta || 0);
      }
    });
    _renderFilaTres(cobradoHoy, cobradoMes, metaTotal, gastosHoy);
  }, _logErr("fila3-metas"));

  // --- Gastos del día aprobados ---
  const gastosQ = query(collection(db, "gastos_empleado"), limit(300));
  gastosUnsub = onSnapshot(gastosQ, snap => {
    gastosHoy = snap.docs.filter(d => {
      const g  = d.data();
      if (g.status && g.status !== "APROBADO") return false;
      const ts = g._ts?.toDate?.() ?? g.fecha?.toDate?.() ?? (g.fecha ? new Date(g.fecha) : null);
      return ts && ts >= hoyInicio;
    }).reduce((s, d) => s + (d.data().monto || 0), 0);
    _renderFilaTres(cobradoHoy, cobradoMes, metaTotal, gastosHoy);
  }, err => console.warn("[Dashboard:fila3-gastos]", err.code || err.message));

  return () => {
    remUnsub && remUnsub();
    metaUnsub && metaUnsub();
    gastosUnsub && gastosUnsub();
  };
}

function _renderFilaTres(cobHoy, cobMes, meta, gastos) {
  const flujo = cobHoy - gastos;
  const pctMeta = meta > 0 ? Math.round((cobMes / meta) * 100) : 0;
  _renderKPI3(0, "🏦", "Cobrado hoy",     _fmt(cobHoy),
    flujo >= 0 ? `Flujo neto +${_fmt(flujo)}` : `Flujo neto ${_fmt(flujo)}`,
    flujo >= 0 ? "up" : "dn", "#2563EB");
  _renderKPI3(1, "💵", "Cobrado este mes", _fmt(cobMes),
    meta > 0 ? `${pctMeta}% de la meta mensual` : "Sin meta configurada",
    pctMeta >= 80 ? "up" : pctMeta >= 50 ? "nt" : "dn", "#2563EB");
  _renderKPI3(2, "🎯", "Meta cobranza",   meta > 0 ? _fmt(meta) : "–",
    meta > 0 ? `Falta ${_fmt(Math.max(0, meta - cobMes))}` : "Configura metas individuales",
    "nt", "#16A34A");
  _renderKPI3(3, "💸", "Gastos del día",  _fmt(gastos),
    gastos > 0 ? "Aprobados hoy" : "Sin gastos hoy",
    gastos > cobHoy * 0.3 ? "dn" : "nt", "#D97706");
}

// ── Clientes Snapshot: semáforo + nuevos + sin visita + top deudores ──
function _escucharClientesSnapshot() {
  // 1. Semáforo distribution + nuevos + top deudores
  const cliUnsub = onSnapshot(collection(db, "clientes"), snap => {
    const dist = { CRÍTICO: 0, GRAVE: 0, MODERADO: 0, LEVE: 0, POR_VENCER: 0 };
    const mesInicio = _inicioMes();
    let nuevos = 0;
    const conDeuda = [];

    snap.forEach(d => {
      const c = d.data();
      if (dist[c.semaforoColor] !== undefined) dist[c.semaforoColor]++;
      const ts = c._ts?.toDate?.() ?? (c._ts ? new Date(c._ts) : null);
      if (ts && ts >= mesInicio) nuevos++;
      if ((c.totalAPagarTotal || 0) > 0)
        conDeuda.push({ nombre: c.nombre || d.id, total: c.totalAPagarTotal || 0, sem: c.semaforoColor || "" });
    });

    const top5 = conDeuda.sort((a,b) => b.total - a.total).slice(0,5);
    _renderSemaforoChips(dist, nuevos, snap.size);
    _renderTopDeudores(top5);
  }, _logErr("clientes-snapshot"));

  // 2. Clientes sin visita reciente — desde config_dashboard o umbral fijo 30d
  let umbraldias = 30;
  getDoc(doc(db, "config_dashboard", "default")).then(d => {
    if (d.exists()) umbraldias = d.data().diasSinVisita || 30;
  }).catch(() => {});

  const visitasQ = query(
    collection(db, "visitas"),
    where("fecha", ">=", Timestamp.fromDate(new Date(Date.now() - 60 * 86400000))),
    limit(500)
  );
  const sinVisUnsub = onSnapshot(visitasQ, snap => {
    const umbral = new Date(Date.now() - umbraldias * 86400000);
    const ultimaVisita = {};
    snap.forEach(d => {
      const v = d.data();
      const ts = v.fecha?.toDate?.() ?? (v.fecha ? new Date(v.fecha) : null);
      if (!ts || !v.clienteId) return;
      if (!ultimaVisita[v.clienteId] || ts > ultimaVisita[v.clienteId])
        ultimaVisita[v.clienteId] = ts;
    });
    const sinVisita = Object.values(ultimaVisita).filter(t => t < umbral).length;
    const chip = document.getElementById("chip-sin-visita");
    if (chip) chip.textContent = `📍 ${sinVisita} sin visita +${umbraldias}d`;
  }, _logErr("sin-visita"));

  return () => { cliUnsub(); sinVisUnsub(); };
}

function _renderSemaforoChips(dist, nuevos, total) {
  const el = document.getElementById("dash-semaforo-chips");
  if (!el) return;
  const SEM = [
    { key:"CRÍTICO",   col:"#C0504D", bg:"rgba(192,80,77,.15)",  label:"CRÍTICO" },
    { key:"GRAVE",     col:"#F79646", bg:"rgba(247,150,70,.15)", label:"GRAVE" },
    { key:"MODERADO",  col:"#8DB4E2", bg:"rgba(141,180,226,.15)",label:"MODERADO" },
    { key:"LEVE",      col:"#c8c800", bg:"rgba(200,200,0,.12)",  label:"LEVE" },
    { key:"POR_VENCER",col:"#92D050", bg:"rgba(146,208,80,.15)", label:"POR VENCER" },
  ];
  const chips = SEM.map(s => `
    <span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;
      background:${s.bg};border:1px solid ${s.col}40;font-size:11px;color:${s.col};font-weight:600">
      ${dist[s.key] || 0} ${s.label}
    </span>`).join("");

  el.innerHTML = chips +
    `<span style="font-size:11px;color:#888;margin-left:6px">· ${nuevos} nuevos este mes</span>
     <span id="chip-sin-visita" style="font-size:11px;color:#888;margin-left:6px">📍 …</span>`;
}

function _renderTopDeudores(top5) {
  const el = document.getElementById("dash-top-deudores");
  if (!el) return;
  if (!top5.length) { el.innerHTML = ""; return; }

  const SEM_COL = { CRÍTICO:"#C0504D", GRAVE:"#F79646", MODERADO:"#8DB4E2", LEVE:"#c8c800", POR_VENCER:"#92D050" };
  el.innerHTML = `
    <div style="font-size:11px;font-weight:600;color:#888;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">
      Top deudores
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      ${top5.map((c, i) => {
        const col = SEM_COL[c.sem] || "#6B7280";
        return `<tr style="border-bottom:1px solid rgba(255,255,255,.05)">
          <td style="padding:4px 0;color:#888;width:16px">${i+1}</td>
          <td style="padding:4px 6px">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${col};margin-right:4px"></span>
            ${esc(c.nombre)}
          </td>
          <td style="padding:4px 0;text-align:right;font-weight:600;color:#E6EDF3">${_fmt(c.total)}</td>
        </tr>`;
      }).join("")}
    </table>`;
}

// ── Gráficas nuevas: Meta mensual, Cobrado semanas, CRM funnel ──
function _escucharChartsNuevos() {
  const mesInicio = _inicioMes();
  let metaTotal = 0;

  // Meta mensual de metas collection
  const metaUnsub = onSnapshot(collection(db, "metas"), snap => {
    const mes = new Date().getMonth();
    metaTotal = 0;
    snap.forEach(d => {
      const m = d.data();
      if (Array.isArray(m.metas)) metaTotal += (m.metas[mes] || 0);
      else metaTotal += (m.metaMensual || m.meta || 0);
    });
    // Re-renderizar con datos de ventas actuales (se actualiza cuando cambie remisiones)
    _redrawMetaChart(metaTotal);
  }, _logErr("charts-meta"));

  // Ventas acumuladas del mes
  const ventasMesQ = query(
    collection(db, "pedidos"),
    where("fechaPedido", ">=", Timestamp.fromDate(mesInicio)),
    limit(2000)
  );
  let ventasMes = 0;
  const ventasUnsub = onSnapshot(ventasMesQ, snap => {
    ventasMes = 0;
    snap.forEach(d => {
      const p = d.data();
      if (["CONFIRMADO","EN_RUTA","ENTREGADO","FACTURADO"].includes(p.status))
        ventasMes += (p.total || 0);
    });
    _redrawMetaChart(metaTotal);
  }, _logErr("charts-ventas-mes"));

  function _redrawMetaChart(meta) {
    setTimeout(() => _chartMeta("ch-meta", ventasMes, meta), 50);
  }

  // Cobrado 4 semanas (desde remisiones abonos)
  const hace4sem = new Date(Date.now() - 28 * 86400000);
  hace4sem.setHours(0,0,0,0);
  const remSemQ = query(
    collection(db, "remisiones_credito"),
    limit(500)
  );
  const semUnsub = onSnapshot(remSemQ, snap => {
    const semanas = _buildSemanas();
    snap.forEach(d => {
      const abonos = d.data().abonos || [];
      abonos.forEach(a => {
        const ts = a.fecha?.toDate?.() ?? (a.fecha ? new Date(a.fecha) : null);
        if (!ts || ts < hace4sem) return;
        const wIdx = _semanaIdx(ts);
        if (wIdx >= 0 && wIdx < 4) semanas[wIdx].total += (a.monto || 0);
      });
    });
    setTimeout(() => _chartCobranzaSemanas("ch-cob-sem", semanas), 50);
  }, _logErr("charts-cobranza-sem"));

  // CRM funnel
  const ETAPAS_CRM = ["NUEVO","CONTACTO","NEGOCIACION","GANADO"];
  const crmUnsub = onSnapshot(collection(db, "prospectos"), snap => {
    const counts = { NUEVO:0, CONTACTO:0, NEGOCIACION:0, GANADO:0 };
    snap.forEach(d => {
      const etapa = (d.data().etapa || "").toUpperCase().replace(/[ÁÉÍÓÚ]/g, c =>
        ({Á:"A",É:"E",Í:"I",Ó:"O",Ú:"U"})[c] || c);
      if (counts[etapa] !== undefined) counts[etapa]++;
    });
    const data = [
      { label:"Nuevo",       count: counts.NUEVO },
      { label:"Contacto",    count: counts.CONTACTO },
      { label:"Negociación", count: counts.NEGOCIACION },
      { label:"Ganado",      count: counts.GANADO },
    ];
    setTimeout(() => _chartFunnel("ch-crm", data), 50);
  }, _logErr("charts-crm"));

  return () => { metaUnsub(); ventasUnsub(); semUnsub(); crmUnsub(); };
}

function _buildSemanas() {
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  return [3,2,1,0].map(i => {
    const d = new Date(hoy.getTime() - i * 7 * 86400000);
    const lbl = i === 0 ? "Esta" : `S-${i}`;
    return { label: lbl, total: 0, start: new Date(d.getTime() - 6*86400000) };
  });
}

function _semanaIdx(ts) {
  const hoy = new Date(); hoy.setHours(23,59,59,999);
  const diff = Math.floor((hoy - ts) / 86400000);
  if (diff < 7)  return 3;
  if (diff < 14) return 2;
  if (diff < 21) return 1;
  if (diff < 28) return 0;
  return -1;
}

// ── Ranking ───────────────────────────────────────────────────
function _escucharRanking() {
  const hoyInicio  = _inicioDia();
  const mesInicio  = _inicioMes();

  return onSnapshot(collection(db, "ubicaciones"), snap => {
    const enCampo = {};
    snap.forEach(d => {
      const u = d.data();
      if (estaEnJornadaHoy(u)) enCampo[u.alias] = true;
    });

    const n = Object.keys(enCampo).length;
    const cc = document.getElementById("chip-count");
    const lc = document.getElementById("live-count");
    if (cc) cc.textContent = n;
    if (lc) lc.textContent = n;

    _renderKPI(3, "👷", "En campo", n + " activos",
      n < 5 ? "Bajo equipo" : "Jornada activa", n < 5 ? "dn" : "nt", "#7C3AED");

    const stC = document.getElementById("st-campo");
    if (stC) stC.innerHTML = `<span class="st-dot" style="background:#4ADE80"></span> ${n} en campo`;

    // Pedidos de hoy para vendido
    const pedHoyQ = query(
      collection(db, "pedidos"),
      where("fechaPedido", ">=", Timestamp.fromDate(hoyInicio)),
      orderBy("fechaPedido", "desc")
    );

    onSnapshot(pedHoyQ, psnap => {
      const totales = {}, conteo = {};
      psnap.forEach(d => {
        const p = d.data();
        const alias = p.vendedor || p.ingenieroAlias || p.alias || "–";
        if (["CONFIRMADO","EN_RUTA","ENTREGADO","FACTURADO"].includes(p.status)) {
          totales[alias] = (totales[alias] || 0) + (p.total || 0);
        }
        conteo[alias] = (conteo[alias] || 0) + 1;
      });

      // Visitas de hoy por ingeniero
      const visitasHoyQ = query(
        collection(db, "log_actividades"),
        where("tipo", "==", "VISITA_REGISTRADA"),
        where("timestamp", ">=", Timestamp.fromDate(hoyInicio))
      );
      getDocs(visitasHoyQ).then(vsnap => {
        const visitasHoy = {};
        vsnap.forEach(d => {
          const alias = d.data().alias || "–";
          visitasHoy[alias] = (visitasHoy[alias] || 0) + 1;
        });

        // Cobrado del mes por ingeniero (desde remisiones abonos[].cobrador)
        const remMesQ = query(
          collection(db, "remisiones_credito"),
          where("_tsUltimoAbono", ">=", Timestamp.fromDate(mesInicio)),
          limit(500)
        );
        getDocs(remMesQ).then(rsnap => {
          const cobMes = {};
          rsnap.forEach(d => {
            const abonos = d.data().abonos || [];
            abonos.forEach(a => {
              const ts = a.fecha?.toDate?.() ?? (a.fecha ? new Date(a.fecha) : null);
              if (!ts || ts < mesInicio) return;
              const cobrador = a.cobrador || a.alias || "–";
              cobMes[cobrador] = (cobMes[cobrador] || 0) + (a.monto || 0);
            });
          });

          // Metas individuales
          getDocs(collection(db, "metas")).then(msnap => {
            const metaIng = {};
            const mes = new Date().getMonth();
            msnap.forEach(d => {
              const m = d.data();
              const alias = m.alias || m.ingeniero || d.id;
              if (Array.isArray(m.metas)) metaIng[alias] = m.metas[mes] || 30000;
              else metaIng[alias] = m.metaMensual || m.meta || 30000;
            });

            const ranking = Object.entries(totales)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8);

            const tbody = document.getElementById("ranking-body");
            if (!tbody) return;

            if (ranking.length === 0) {
              tbody.innerHTML = `<tr><td colspan="7">
                <div class="empty-state" style="padding:20px">
                  <div class="empty-state-icon">📊</div>
                  <div class="empty-state-title">Sin ventas hoy aún</div>
                </div></td></tr>`;
              return;
            }

            const META_DIA = 30000;
            tbody.innerHTML = ranking.map(([alias, total], i) => {
              const meta   = metaIng[alias] || META_DIA;
              const pct    = Math.min(Math.round((total / meta) * 100), 100);
              const bar    = pct >= 70 ? "#16A34A" : pct >= 40 ? "#D97706" : "#DC2626";
              const est    = enCampo[alias]
                ? `<span class="pill pill-campo">● En campo</span>`
                : `<span class="pill pill-off">○ Sin campo</span>`;
              const vis    = visitasHoy[alias] || 0;
              const cob    = cobMes[alias] || 0;
              return `
                <tr>
                  <td class="rank-num">${i+1}</td>
                  <td><span class="rank-name">${esc(alias)}</span></td>
                  <td class="rank-money">${_fmt(total)}</td>
                  <td>
                    <div class="bar-wrap"><div class="bar-fill" style="width:${pct}%;background:${bar}"></div></div>
                    <div class="bar-pct">${pct}%</div>
                  </td>
                  <td style="text-align:center;font-size:12px">${vis}</td>
                  <td class="rank-money" style="font-size:11px">${cob > 0 ? _fmt(cob) : "–"}</td>
                  <td>${est}</td>
                </tr>`;
            }).join("");
          }).catch(() => {});
        }).catch(() => {});
      }).catch(() => {});
    }, _logErr("ranking-pedidos"));
  }, _logErr("ubicaciones"));
}

function _escucharUbicaciones() {
  return onSnapshot(collection(db, "ubicaciones"), snap => {
    const pinsEl = document.getElementById("rp-pins");
    const grid   = document.getElementById("rp-map-grid");
    if (!pinsEl || !grid) return;

    pinsEl.innerHTML = "";
    const bounds = { minLat: 28, maxLat: 32, minLng: -112, maxLng: -107 };

    snap.forEach(d => {
      const u = d.data();
      if (!u.lat || !u.lng || !estaEnJornadaHoy(u)) return;

      const x = _norm(u.lng, bounds.minLng, bounds.maxLng) * 100;
      const y = (1 - _norm(u.lat, bounds.minLat, bounds.maxLat)) * 100;

      const pin = document.createElement("div");
      pin.className = "map-pin";
      pin.style.cssText = `left:${x}%;top:${y}%;background:#16A34A;`;
      pin.title = u.alias || "Ingeniero";
      pinsEl.appendChild(pin);
    });
  }, _logErr("ubicaciones-map"));
}

// ── Gráficas originales ───────────────────────────────────────
function _escucharCharts() {
  const hace7 = new Date(Date.now() - 7 * 86400000);
  hace7.setHours(0, 0, 0, 0);
  const q = query(
    collection(db, "pedidos"),
    where("fechaPedido", ">=", Timestamp.fromDate(hace7)),
    limit(1000)
  );
  return onSnapshot(q, snap => {
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const diasKeys = [];
    const diasVenta = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(hoy.getTime() - i * 86400000);
      const k = d.toISOString().slice(0, 10);
      diasKeys.push(k); diasVenta[k] = 0;
    }

    const prods = {};
    let cobrado = 0, pendiente = 0;

    snap.forEach(d => {
      const p  = d.data();
      const ts = p.fechaPedido?.toDate?.() ?? new Date(p.fechaPedido || 0);
      const k  = ts.toISOString().slice(0, 10);
      if (k in diasVenta) diasVenta[k] += (p.total || 0);

      (p.items || p.productos || []).forEach(it => {
        const nombre = it.nombre || it.producto || "Producto";
        prods[nombre] = (prods[nombre] || 0) + ((it.cantidad || 1) * (it.precio || 0));
      });

      if (["ENTREGADO","FACTURADO"].includes(p.status)) cobrado   += (p.total || 0);
      else                                               pendiente += (p.total || 0);
    });

    const labels = diasKeys.map(k => {
      const d = new Date(k + "T12:00:00");
      return d.toLocaleDateString("es-MX", { weekday: "short" });
    });
    const values = diasKeys.map(k => diasVenta[k]);
    const top5   = Object.entries(prods).sort((a,b) => b[1]-a[1]).slice(0,5);

    _chartLinea("ch-ventas", labels, values);
    _chartBarras("ch-productos", top5);
    _chartDonut("ch-donut", cobrado, pendiente);
  }, _logErr("charts-s4"));
}

function _escucharFeedDash() {
  const feedQ = query(
    collection(db, "log_actividades"),
    orderBy("timestamp", "desc"),
    limit(20)
  );

  return onSnapshot(feedQ, snap => {
    const el = document.getElementById("dash-feed");
    if (!el) return;

    if (snap.empty) {
      el.innerHTML = `<div class="empty-state" style="padding:20px">
        <div class="empty-state-icon">⚡</div>
        <div class="empty-state-title">Sin actividad reciente</div>
      </div>`;
      return;
    }

    el.innerHTML = snap.docs.map(d => {
      const a   = d.data();
      const cfg = _eventConfig(a.tipo);
      const ts  = _tiempoRelativo(a.timestamp?.toDate?.() || new Date());
      return `
        <div class="feed-event" style="border-color:${cfg.color}">
          <div class="ev-icon">${cfg.icon}</div>
          <div class="ev-body">
            <div class="ev-who">${esc(a.alias) || "–"}</div>
            <div class="ev-what">${esc(_resumenActividad(a))}</div>
            <div class="ev-time">${ts}</div>
          </div>
        </div>`;
    }).join("");

    const badge = document.getElementById("feed-badge");
    if (badge) {
      badge.textContent = snap.size;
      badge.classList.toggle("hidden", snap.size === 0);
    }
  }, _logErr("feed-dash"));
}

// ── Render helpers ────────────────────────────────────────────
function _renderKPI(idx, icon, label, val, delta, deltaClass, borderColor) {
  const cards = document.querySelectorAll("#kpi-row .kpi-card");
  if (!cards[idx]) return;
  cards[idx].style.borderLeftColor = borderColor;
  cards[idx].innerHTML = `
    <div class="kpi-icon">${icon}</div>
    <div class="kpi-val">${val}</div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-delta ${deltaClass}">${delta}</div>`;
}

function _renderKPI2(idx, icon, label, val, delta, deltaClass, borderColor) {
  const cards = document.querySelectorAll("#kpi-row-2 .kpi-card");
  if (!cards[idx]) return;
  cards[idx].style.borderLeftColor = borderColor;
  cards[idx].innerHTML = `
    <div class="kpi-icon">${icon}</div>
    <div class="kpi-val">${val}</div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-delta ${deltaClass}">${delta}</div>`;
}

function _renderKPI3(idx, icon, label, val, delta, deltaClass, borderColor) {
  const cards = document.querySelectorAll("#kpi-row-3 .kpi-card");
  if (!cards[idx]) return;
  cards[idx].style.borderLeftColor = borderColor;
  cards[idx].innerHTML = `
    <div class="kpi-icon">${icon}</div>
    <div class="kpi-val">${val}</div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-delta ${deltaClass}">${delta}</div>`;
}

// ── Helpers ───────────────────────────────────────────────────
function _inicioDia() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
}

function _inicioMes() {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
}

function _fmt(n) {
  if (n >= 1000000) return "$" + (n/1000000).toFixed(1) + "M";
  if (n >= 1000)    return "$" + (n/1000).toFixed(1) + "k";
  return "$" + Math.round(n).toLocaleString("es-MX");
}

function _fmtK(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + "M";
  if (n >= 1000)    return (n/1000).toFixed(0) + "k";
  return String(Math.round(n));
}

function _norm(v, min, max) {
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}

function _tiempoRelativo(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)   return "Hace " + diff + "s";
  if (diff < 3600) return "Hace " + Math.floor(diff/60) + " min";
  return "Hace " + Math.floor(diff/3600) + "h";
}

const EVENTOS = {
  PEDIDO_CONFIRMADO:  { icon:"🛒", color:"#16A34A" },
  PEDIDO_EN_RUTA:     { icon:"🚚", color:"#D97706" },
  PEDIDO_ENTREGADO:   { icon:"✅", color:"#16A34A" },
  ABONO_REGISTRADO:   { icon:"💳", color:"#2563EB" },
  REMISION_CREADA:    { icon:"📄", color:"#7C3AED" },
  JORNADA_INICIO:     { icon:"🚀", color:"#D97706" },
  JORNADA_FIN:        { icon:"🏁", color:"#6B7280" },
  PEDIDO_CANCELADO:   { icon:"❌", color:"#DC2626" },
  VISITA_REGISTRADA:  { icon:"📍", color:"#2563EB" },
};
function _eventConfig(tipo) { return EVENTOS[tipo] || { icon:"•", color:"#6B7280" }; }

function _resumenActividad(a) {
  switch(a.tipo) {
    case "PEDIDO_CONFIRMADO": return `Pedido ${a.folio || "–"} · ${_fmt(a.total || 0)}`;
    case "ABONO_REGISTRADO":  return `Abono ${_fmt(a.monto || 0)} → ${a.remision || "–"}`;
    case "REMISION_CREADA":   return `Remisión ${a.remision || "–"} · ${_fmt(a.total || 0)}`;
    case "JORNADA_INICIO":    return `Inició jornada — ${a.zona || "–"}`;
    case "JORNADA_FIN":       return `Terminó jornada`;
    case "PEDIDO_ENTREGADO":  return `Entregó ${a.folio || "–"}`;
    case "VISITA_REGISTRADA": return `Visita: ${a.cliente || "–"}`;
    default: return a.descripcion || a.tipo || "–";
  }
}

function _bindMapBtn() {}

function _logErr(ctx) {
  return err => {
    console.error(`[Dashboard:${ctx}]`, err);
    if (!window.manejarErrorFirestore?.(err))
      window.toast?.(`Error de conexión en ${ctx}. Reintentando…`, "error");
  };
}
