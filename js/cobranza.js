// ══════════════════════════════════════════════════════════════
// cobranza.js — Historial de abonos con motor de intereses
//
// Fuente: remisiones_credito (abonos embebidos en cada nota).
// Cada fila = un abono individual con contexto de su nota:
//   deuda antes del abono, interés generado en ese momento,
//   si fue pago parcial o liquidación total.
// ══════════════════════════════════════════════════════════════

import { db }    from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, logAudit }   from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import { calcularRemision } from "./intereses-engine.js";
import {
  collection, query, orderBy, limit, onSnapshot,
  doc, getDoc, updateDoc, arrayUnion, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmt   = new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" });
const fmtDt = iso => {
  // Añadir hora local noon para evitar parse UTC en fechas sin tiempo
  const s = iso?.includes("T") ? iso : (iso + "T12:00:00");
  return new Date(s).toLocaleDateString("es-MX", { day:"numeric", month:"short", year:"numeric" });
};

let _unsub         = null;
let _remisiones    = [];  // docs completos con abonos[]
let _filtroPeriodo = "semana";
let _filtroAlias   = "TODOS";

export const CobranzaModule = {
  mount(container) {
    container.innerHTML = _html();
    _bindUI();
    _escuchar();
    return () => this.destroy();
  },
  destroy() {
    _unsub?.(); _unsub = null;
    _remisiones = []; _filtroPeriodo = "semana"; _filtroAlias = "TODOS";
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <div style="display:flex;flex-direction:column;gap:0;padding:0 0 20px">

    <!-- Controles -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
      padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:12px;font-weight:700;color:var(--text-primary)">Período:</span>
      ${["hoy","semana","mes"].map(p => `
        <button class="filter-pill ${p==="semana"?"active":""}" data-cob-p="${p}"
          onclick="CobranzaUI.setPeriodo('${p}')">
          ${{hoy:"Hoy",semana:"Esta semana",mes:"Este mes"}[p]}
        </button>`).join("")}
      <div style="flex:1"></div>
      <select id="cob-sel-alias" onchange="CobranzaUI.setAlias(this.value)"
        style="border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px;
          background:var(--surface);color:var(--text-primary)">
        <option value="TODOS">Todos los recuperadores</option>
      </select>
    </div>

    <!-- KPIs -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px">
      ${[
        ["cob-k-abonos",   "ABONOS",          "💳", "var(--text-primary)"],
        ["cob-k-total",    "TOTAL COBRADO",    "💵", "#16A34A"],
        ["cob-k-capital",  "CAPITAL COBRADO",  "🏦", "#2563EB"],
        ["cob-k-interes",  "INTERÉS COBRADO",  "📈", "#F59E0B"],
        ["cob-k-liquidadas","NOTAS LIQUIDADAS","✅", "#7C3AED"],
      ].map(([id,l,ico,col]) => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;
          padding:14px 16px;box-shadow:var(--shadow)">
          <div style="font-size:9.5px;font-weight:700;color:var(--text-sec);text-transform:uppercase;
            letter-spacing:.06em;margin-bottom:5px">${ico} ${l}</div>
          <div style="font-size:17px;font-weight:800;color:${col};font-variant-numeric:tabular-nums"
            id="${id}">–</div>
        </div>`).join("")}
    </div>

    <!-- Ranking -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
      padding:16px;margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;
        letter-spacing:.05em;margin-bottom:10px">Ranking de cobranza</div>
      <div id="cob-ranking"></div>
    </div>

    <!-- Tabla -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);overflow:hidden">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11.5px">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              <th style="${_th()}">FECHA</th>
              <th style="${_th()}">CLIENTE</th>
              <th style="${_th()}">NOTA</th>
              <th style="${_th()}">RECUPERADOR</th>
              <th style="${_th('right')}">ABONO</th>
              <th style="${_th('right')}">INTERÉS PAGADO</th>
              <th style="${_th('right')}">DEUDA RESTANTE</th>
              <th style="${_th('center')}">TIPO</th>
              <th style="${_th('center')}">RECIBO</th>
              <th style="${_th('center')}">CONCILIAR</th>
            </tr>
          </thead>
          <tbody id="cob-tbody">
            <tr><td colspan="10" style="padding:24px;text-align:center;color:var(--text-muted)">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

const _th = (align = "left") =>
  `padding:9px 14px;text-align:${align};font-weight:700;color:var(--text-muted);font-size:10px;
   text-transform:uppercase;letter-spacing:.06em;white-space:nowrap`;

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI() {
  window.CobranzaUI = {
    setPeriodo(p) {
      _filtroPeriodo = p;
      document.querySelectorAll("[data-cob-p]").forEach(b =>
        b.classList.toggle("active", b.dataset.cobP === p));
      _renderTabla();
    },
    setAlias(a) { _filtroAlias = a; _renderTabla(); },

    async conciliar(remisionId, abonoIdx) {
      const puedeConc = Sesion.esSuperAdmin?.() ||
        ["GERENTE","ADMINISTRADOR","MESA_CONTROL"].includes(Sesion.rol);
      if (!puedeConc) return;

      try {
        await updateDoc(doc(db, "remisiones_credito", remisionId), {
          abonosConciliados: arrayUnion({
            idx:              abonoIdx,
            confirmadoPor:    Sesion.alias,
            fechaConfirmacion: new Date().toISOString(),
          }),
        });
        logAudit("ABONO_CONCILIADO", { remisionId, abonoIdx });
        window.toast?.("Abono conciliado.", "success");
      } catch(e) {
        window.toast?.("Error: " + e.message, "error");
      }
    },
  };
}

// ── Firestore listener ────────────────────────────────────────
function _escuchar() {
  const q = query(
    collection(db, "remisiones_credito"),
    orderBy("fechaCreacion", "desc"),
    limit(500)
  );
  _unsub = onSnapshot(q, async snap => {
    _remisiones = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await cargarNombres();

    // Poblar selector de alias con quienes hicieron abonos
    const aliases = [...new Set(
      _remisiones.flatMap(r => (r.abonos ?? []).map(a => a.quienRegistro || r.ingenieroAlias || "–"))
    )].filter(Boolean).sort();

    const sel = document.getElementById("cob-sel-alias");
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = `<option value="TODOS">Todos los recuperadores</option>` +
        aliases.map(a => `<option value="${esc(a)}"${a === prev?" selected":""}>${esc(resolverNombre(a))}</option>`).join("");
    }

    _renderTabla();
  }, err => {
    console.error("[Cobranza]", err);
    window.toast?.("Error al cargar cobranza.", "error");
  });
}

// ── Aplanar abonos de todas las remisiones ────────────────────
function _aplanarAbonos() {
  const rows = [];
  for (const r of _remisiones) {
    const abonos = r.abonos ?? [];
    const conciliados = new Set(
      (r.abonosConciliados ?? []).map(c => c.idx)
    );
    abonos.forEach((ab, idx) => {
      // Reconstruir estado de la nota justo DESPUÉS de este abono
      const totalAbonado = abonos.slice(0, idx + 1).reduce((s, a) => s + a.monto, 0);
      const notaConAbono = { ...r, totalAbonado };
      const fechaAbono   = new Date(ab.fecha + (ab.fecha.includes("T") ? "" : "T12:00:00"));
      const calc         = calcularRemision(notaConAbono, fechaAbono);

      // Cuánto del abono fue a capital vs interés
      // El abono primero cubre el interés generado en esa fecha, luego el capital
      const interesEnFecha = calc.interesGenerado;
      const capitalAntes   = Math.max(0, r.montoOriginal - abonos.slice(0, idx).reduce((s,a) => s+a.monto, 0));
      const interesAbono   = Math.min(ab.monto, Math.max(0, interesEnFecha));
      const capitalAbono   = Math.max(0, ab.monto - interesAbono);

      rows.push({
        remisionId:    r.id,
        folio:         r.folio || r.id,
        clienteNombre: r.clienteNombre || "–",
        ingenieroAlias: ab.quienRegistro || r.ingenieroAlias || "–",
        fecha:         ab.fecha,
        monto:         ab.monto,
        recibo:        ab.recibo || "–",
        interesAbono,
        capitalAbono,
        deudaRestante: calc.deudaRestante,
        esLiquidacion: calc.deudaRestante <= 0,
        interesAlLiquidar: r.interesAlLiquidar ?? 0,
        abonoIdx:      idx,
        conciliado:    conciliados.has(idx),
      });
    });
  }
  // Ordenar por fecha descendente
  return rows.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

// ── Render ────────────────────────────────────────────────────
function _renderTabla() {
  const { desde } = _rango();
  let lista = _aplanarAbonos().filter(a => {
    const s = a.fecha?.includes("T") ? a.fecha : (a.fecha + "T12:00:00");
    return new Date(s).getTime() >= desde;
  });
  if (_filtroAlias !== "TODOS") lista = lista.filter(a => a.ingenieroAlias === _filtroAlias);

  // KPIs
  const totalCobrado    = lista.reduce((s, a) => s + a.monto,        0);
  const totalCapital    = lista.reduce((s, a) => s + a.capitalAbono,  0);
  const totalInteres    = lista.reduce((s, a) => s + a.interesAbono,  0);
  const liquidaciones   = lista.filter(a => a.esLiquidacion).length;

  _set("cob-k-abonos",    String(lista.length));
  _set("cob-k-total",     fmt.format(totalCobrado));
  _set("cob-k-capital",   fmt.format(totalCapital));
  _set("cob-k-interes",   fmt.format(totalInteres));
  _set("cob-k-liquidadas",String(liquidaciones));

  // Ranking
  const por = {};
  lista.forEach(a => { por[a.ingenieroAlias] = (por[a.ingenieroAlias] || 0) + a.monto; });
  const ranked = Object.entries(por).sort((a, b) => b[1] - a[1]);
  const maxVal = ranked[0]?.[1] || 1;
  const rankEl = document.getElementById("cob-ranking");
  if (rankEl) {
    rankEl.innerHTML = ranked.length
      ? ranked.map(([alias, monto], i) => {
          const pct = Math.round((monto / maxVal) * 100);
          return `<div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
              <span style="font-weight:600">${i+1}. ${esc(resolverNombre(alias))}</span>
              <span style="font-weight:700;font-variant-numeric:tabular-nums">${fmt.format(monto)}</span>
            </div>
            <div style="height:5px;background:var(--border);border-radius:3px">
              <div style="height:100%;border-radius:3px;width:${pct}%;background:#16A34A"></div>
            </div>
          </div>`;
        }).join("")
      : `<div style="color:var(--text-muted);font-size:12px">Sin cobranza en este período.</div>`;
  }

  // Tabla
  const tbody = document.getElementById("cob-tbody");
  if (!tbody) return;
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="padding:24px;text-align:center;color:var(--text-muted)">
      Sin abonos en este período.</td></tr>`;
    return;
  }

  const puedeConc = Sesion.esSuperAdmin?.() ||
    ["GERENTE","ADMINISTRADOR","MESA_CONTROL"].includes(Sesion.rol);

  tbody.innerHTML = lista.map(a => {
    const concBtn = a.conciliado
      ? `<span style="font-size:10px;color:#22C55E;font-weight:700">✓ Conciliado</span>`
      : puedeConc
        ? `<button onclick="CobranzaUI.conciliar('${esc(a.remisionId)}', ${a.abonoIdx})"
             style="font-size:10px;padding:3px 9px;background:#14532D;color:#4ADE80;
             border:1px solid #16A34A;border-radius:5px;cursor:pointer;font-weight:600">Conciliar</button>`
        : `<span style="font-size:10px;color:var(--text-muted)">Pendiente</span>`;

    const tipoBadge = a.esLiquidacion
      ? `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:6px;
          background:#16A34A22;color:#22C55E">LIQUIDACIÓN</span>`
      : `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:6px;
          background:#1E3A5F;color:#60A5FA">PARCIAL</span>`;

    return `<tr style="border-bottom:1px solid var(--border);${a.conciliado ? "opacity:.65" : ""}">
      <td style="padding:8px 14px;color:var(--text-muted);white-space:nowrap">${fmtDt(a.fecha)}</td>
      <td style="padding:8px 14px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${esc(a.clienteNombre)}</td>
      <td style="padding:8px 14px;font-family:monospace;font-weight:700;font-size:11px;color:var(--text-muted)">
        ${esc(a.folio)}</td>
      <td style="padding:8px 14px">${esc(resolverNombre(a.ingenieroAlias))}</td>
      <td style="padding:8px 14px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:#22C55E">
        ${fmt.format(a.monto)}</td>
      <td style="padding:8px 14px;text-align:right;font-variant-numeric:tabular-nums;
        color:${a.interesAbono > 0 ? "#F59E0B" : "#9CA3AF"}">
        ${a.interesAbono > 0 ? fmt.format(a.interesAbono) : "–"}</td>
      <td style="padding:8px 14px;text-align:right;font-variant-numeric:tabular-nums;
        color:${a.deudaRestante > 0 ? "#EF4444" : "#22C55E"}">
        ${a.deudaRestante > 0 ? fmt.format(a.deudaRestante) : "SALDADO"}</td>
      <td style="padding:8px 14px;text-align:center">${tipoBadge}</td>
      <td style="padding:8px 14px;text-align:center;font-size:10px;color:var(--text-muted);font-family:monospace">
        ${esc(a.recibo)}</td>
      <td style="padding:8px 14px;text-align:center">${concBtn}</td>
    </tr>`;
  }).join("");
}

// ── Helpers ───────────────────────────────────────────────────
function _rango() {
  if (_filtroPeriodo === "hoy") {
    const h = new Date(); h.setHours(0,0,0,0);
    return { desde: h.getTime() };
  }
  if (_filtroPeriodo === "mes") {
    const m = new Date(); m.setDate(1); m.setHours(0,0,0,0);
    return { desde: m.getTime() };
  }
  const s = new Date();
  const dow = s.getDay() || 7; // 1=lun … 7=dom (semana ISO: lunes a domingo)
  s.setDate(s.getDate() - dow + 1); s.setHours(0,0,0,0);
  return { desde: s.getTime() };
}

function _set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
