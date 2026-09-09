// ══════════════════════════════════════════════════════════════
// remisiones.js — Cartera de crédito con motor de intereses
// ══════════════════════════════════════════════════════════════

import { db }    from "./firebase-config.js";
import { esc }   from "./app.js";
import { Sesion } from "./auth.js";
import {
  calcularRemision, calcularAbono, enriquecerRemisiones,
  resumenCartera, STATUS_COLOR, TASA_SEMANAL_DEFAULT, DIAS_GRACIA_DEFAULT
} from "./intereses-engine.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, query, orderBy, limit, onSnapshot,
  doc, getDoc, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmt    = new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" });
const fmtDia = d => {
  const dt = d?.toDate?.() ?? (typeof d === "string" ? new Date(d) : d);
  return dt instanceof Date && !isNaN(dt)
    ? dt.toLocaleDateString("es-MX", { day:"numeric", month:"short", year:"numeric" })
    : "–";
};

const FILTROS = ["TODOS","POR_VENCER","LEVE","MODERADO","GRAVE","CRÍTICO","PAGADO"];

let _unsub      = null;
let _remisiones = [];
let _filtro     = "TODOS";
let _config     = { tasaSemanal: TASA_SEMANAL_DEFAULT, diasGracia: DIAS_GRACIA_DEFAULT };
let _abonoTarget = null; // remision sobre la que se abre el modal

export const RemisionesModule = {
  mount(container) {
    container.innerHTML = _html();
    _bindUI();
    cargarNombres().then(() => _renderTabla());
    _cargarConfig().then(() => _escuchar());
    return () => this.destroy();
  },
  destroy() {
    _unsub?.(); _unsub = null;
    _remisiones = []; _filtro = "TODOS"; _abonoTarget = null;
  }
};

// ── Cargar configuración de intereses ────────────────────────
async function _cargarConfig() {
  try {
    const snap = await getDoc(doc(db, "config_intereses", "default"));
    if (snap.exists()) _config = { ..._config, ...snap.data() };
  } catch(e) {
    console.warn("[Remisiones] config_intereses no accesible:", e.code);
  }
}

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <div style="display:flex;flex-direction:column;height:100%;gap:0;padding:0">

    <!-- KPIs -->
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;padding:14px 20px;flex-shrink:0">
      ${[
        ["rst-k-notas",    "NOTAS ACTIVAS",   "📋", "var(--text-primary)"],
        ["rst-k-vencidas", "VENCIDAS",         "⚠️",  "#DC2626"],
        ["rst-k-capital",  "CAPITAL PENDIENTE","💵",  "#2563EB"],
        ["rst-k-interes",  "INTERÉS GENERADO", "📈",  "#F59E0B"],
        ["rst-k-total",    "TOTAL A PAGAR",    "💰",  "#F97316"],
      ].map(([id,lbl,ico,col]) => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;box-shadow:var(--shadow)">
          <div style="font-size:10px;color:var(--text-sec);font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${ico} ${lbl}</div>
          <div style="font-size:17px;font-weight:800;color:${col};font-variant-numeric:tabular-nums" id="${id}">–</div>
        </div>`).join("")}
    </div>

    <!-- Filtros -->
    <div style="padding:0 20px 10px;flex-shrink:0;display:flex;gap:6px;flex-wrap:wrap">
      ${FILTROS.map(f => {
        const FC = {TODOS:"",POR_VENCER:"#D97706",LEVE:"#16A34A",MODERADO:"#2563EB",
          GRAVE:"#F97316","CRÍTICO":"#DC2626",PAGADO:"#0E7490"};
        const c = FC[f] || "";
        return `<button class="filter-pill" data-rst-f="${f}" onclick="RemisionesUI.setFiltro('${f}')"
          ${c ? `style="border-color:${c};color:${c}"` : ""}>
          ${f === "TODOS" ? "Todos" : f}
        </button>`;}).join("")}
    </div>

    <!-- Tabla -->
    <div style="flex:1;overflow:auto;padding:0 20px 20px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:11.5px">
            <thead>
              <tr style="background:var(--surface-2);border-bottom:1px solid var(--border)">
                <th style="${_th()}">FOLIO</th>
                <th style="${_th('center')}">EMITIDO</th>
                <th style="${_th()}">CLIENTE</th>
                <th style="${_th()}">INGENIERO</th>
                <th style="${_th('right')}">MONTO ORIG.</th>
                <th style="${_th('right')}">INTERÉS GEN.</th>
                <th style="${_th('right')}">TOTAL A PAGAR</th>
                <th style="${_th('right')}">ABONADO</th>
                <th style="${_th('right')}">DEUDA RESTANTE</th>
                <th style="${_th('center')}">DÍAS MORA</th>
                <th style="${_th('center')}">VENCE</th>
                <th style="${_th('center')}">STATUS</th>
                <th style="${_th('center')}">ORIGEN</th>
                <th style="${_th('center')}">ACCIÓN</th>
              </tr>
            </thead>
            <tbody id="rst-tbody">
              <tr><td colspan="14" style="padding:32px;text-align:center;color:var(--text-muted)">Cargando…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </div>

  <!-- Modal: historial de abonos -->
  <div id="rst-modal-hist" class="modal-overlay hidden" onclick="if(event.target===this)RemisionesUI.cerrarHistorial()">
    <div class="modal" style="max-width:780px;width:96vw">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div class="modal-title" style="margin:0" id="rst-hist-titulo">Historial de abonos</div>
        <button onclick="RemisionesUI.cerrarHistorial()"
          style="background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;line-height:1">×</button>
      </div>
      <div id="rst-hist-resumen" style="background:var(--surface-2);border:1px solid var(--border);
        border-radius:8px;padding:12px 16px;margin-bottom:14px;font-size:12px;line-height:2;display:grid;
        grid-template-columns:repeat(4,1fr);gap:4px 16px"></div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11.5px">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              <th style="${_th()}">#</th>
              <th style="${_th()}">FECHA</th>
              <th style="${_th('right')}">ABONO</th>
              <th style="${_th('right')}">CAPITAL</th>
              <th style="${_th('right')}">INTERÉS</th>
              <th style="${_th('right')}">DEUDA RESTANTE</th>
              <th style="${_th('center')}">TIPO</th>
              <th style="${_th()}">RECIBO</th>
              <th style="${_th()}">REGISTRÓ</th>
              <th style="${_th('center')}">CONCILIADO</th>
            </tr>
          </thead>
          <tbody id="rst-hist-tbody"></tbody>
        </table>
      </div>
      <div id="rst-hist-vacio" style="display:none;padding:32px;text-align:center;color:var(--text-muted);font-size:13px">
        Esta nota no tiene abonos registrados aún.
      </div>
    </div>
  </div>

  <!-- Modal: registrar abono -->
  <div id="rst-modal-abono" class="modal-overlay hidden">
    <div class="modal" style="max-width:440px">
      <div class="modal-title">Registrar abono</div>
      <div id="rst-abono-info" style="background:var(--surface-2);border-radius:8px;
        padding:12px 14px;margin-bottom:16px;font-size:12px;line-height:1.7;border:1px solid var(--border)">
      </div>
      <div class="form-group">
        <label class="form-label">Monto del abono ($) *</label>
        <input id="rst-abono-monto" type="number" class="form-input" min="0.01" step="0.01" placeholder="0.00">
      </div>
      <div class="form-group">
        <label class="form-label">Número de recibo</label>
        <input id="rst-abono-recibo" type="text" class="form-input" placeholder="Folio o número de recibo">
      </div>
      <div class="form-group">
        <label class="form-label">Fecha del pago</label>
        <input id="rst-abono-fecha" type="date" class="form-input"
          value="${new Date().toISOString().slice(0,10)}">
      </div>
      <div id="rst-abono-preview" style="font-size:12px;color:var(--text-muted);margin-bottom:12px"></div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="RemisionesUI.cerrarAbono()">Cancelar</button>
        <button class="btn-primary" style="width:auto;padding:8px 20px"
          onclick="RemisionesUI.guardarAbono()">Guardar abono</button>
      </div>
    </div>
  </div>`;
}

const _th = (align = "left") =>
  `padding:10px 14px;text-align:${align};font-weight:700;color:var(--text-muted);font-size:10px;
   text-transform:uppercase;letter-spacing:.06em;white-space:nowrap`;

// ── UI Bind ───────────────────────────────────────────────────
function _bindUI() {
  window.RemisionesUI = {
    setFiltro(f) {
      _filtro = f;
      document.querySelectorAll("[data-rst-f]").forEach(b => {
        const activo = b.dataset.rstF === f;
        b.style.background = activo ? "var(--text-primary)" : "transparent";
        b.style.color      = activo ? "var(--surface)" : "#9CA3AF";
        b.style.borderColor= activo ? "var(--text-primary)" : "var(--border)";
      });
      _renderTabla();
    },

    abrirAbono(id) {
      _abonoTarget = _remisiones.find(r => r.id === id);
      if (!_abonoTarget) return;
      const calc = calcularRemision(_abonoTarget);
      document.getElementById("rst-abono-info").innerHTML = `
        <b>${esc(_abonoTarget.folio || _abonoTarget.id)}</b> · ${esc(_abonoTarget.clienteNombre || "–")}<br>
        Monto original: <b>${fmt.format(_abonoTarget.montoOriginal)}</b>
        &nbsp;·&nbsp; Abonado: <b>${fmt.format(_abonoTarget.totalAbonado ?? 0)}</b><br>
        Interés generado: <b style="color:#F59E0B">${fmt.format(calc.interesGenerado)}</b>
        &nbsp;·&nbsp; Deuda restante hoy: <b style="color:#EF4444">${fmt.format(calc.deudaRestante)}</b>`;
      document.getElementById("rst-abono-monto").value  = "";
      document.getElementById("rst-abono-recibo").value = "";
      document.getElementById("rst-abono-fecha").value  = new Date().toISOString().slice(0,10);
      document.getElementById("rst-abono-preview").textContent = "";
      document.getElementById("rst-modal-abono").classList.remove("hidden");
      setTimeout(() => document.getElementById("rst-abono-monto")?.focus(), 80);

      // Preview en tiempo real
      document.getElementById("rst-abono-monto").oninput = () => _previewAbono();
    },

    cerrarAbono() {
      document.getElementById("rst-modal-abono").classList.add("hidden");
      _abonoTarget = null;
    },

    abrirHistorial(id) {
      const r = _remisiones.find(r => r.id === id);
      if (!r) return;
      const abonos       = r.abonos ?? [];
      const conciliados  = new Set((r.abonosConciliados ?? []).map(c => c.idx));

      // Título y resumen
      _set("rst-hist-titulo", `Historial · ${r.folio || r.id}`);
      const calc = calcularRemision(r);
      const resEl = document.getElementById("rst-hist-resumen");
      if (resEl) resEl.innerHTML = [
        [`📋 Nota`, `<b>${esc(r.folio || r.id)}</b>`],
        [`👤 Cliente`, `<b>${esc(r.clienteNombre || "–")}</b>`],
        [`💵 Monto original`, `<b>${fmt.format(r.montoOriginal ?? 0)}</b>`],
        [`✅ Total abonado`, `<b style="color:#22C55E">${fmt.format(r.totalAbonado ?? 0)}</b>`],
        [`📈 Interés generado`, `<b style="color:#F59E0B">${fmt.format(calc.interesGenerado)}</b>`],
        [`💰 Deuda restante`, `<b style="color:${calc.deudaRestante > 0 ? "#EF4444" : "#22C55E"}">${calc.deudaRestante > 0 ? fmt.format(calc.deudaRestante) : "SALDADO"}</b>`],
        [`📅 Vence`, `<b>${fmtDia(r.fechaVencimiento)}</b>`],
        [`🏷️ Status`, `<b>${r.status ?? "–"}</b>`],
      ].map(([lbl, val]) =>
        `<div><span style="color:var(--text-muted)">${lbl}</span><br>${val}</div>`
      ).join("");

      // Tabla de abonos
      const tbody = document.getElementById("rst-hist-tbody");
      const vacio = document.getElementById("rst-hist-vacio");
      if (!tbody) return;

      if (!abonos.length) {
        tbody.innerHTML = "";
        vacio.style.display = "";
      } else {
        vacio.style.display = "none";
        tbody.innerHTML = abonos.map((ab, idx) => {
          const totalAbonado = abonos.slice(0, idx + 1).reduce((s, a) => s + a.monto, 0);
          const fechaAbono   = new Date(ab.fecha + (ab.fecha.includes("T") ? "" : "T12:00:00"));
          const calcPost     = calcularRemision({ ...r, totalAbonado }, fechaAbono);
          const interesEnFecha = calcularRemision({ ...r, totalAbonado: abonos.slice(0, idx).reduce((s,a)=>s+a.monto,0) }, fechaAbono).interesGenerado;
          const interesAbono = Math.min(ab.monto, Math.max(0, interesEnFecha));
          const capitalAbono = Math.max(0, ab.monto - interesAbono);
          const esLiq        = calcPost.deudaRestante <= 0;
          const conciliado   = conciliados.has(idx);

          return `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 14px;color:var(--text-muted);font-size:10px">${idx + 1}</td>
            <td style="padding:8px 14px;white-space:nowrap;color:var(--text-muted)">
              ${fmtDia(ab.fecha)}</td>
            <td style="padding:8px 14px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:#22C55E">
              ${fmt.format(ab.monto)}</td>
            <td style="padding:8px 14px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-primary)">
              ${fmt.format(capitalAbono)}</td>
            <td style="padding:8px 14px;text-align:right;font-variant-numeric:tabular-nums;
              color:${interesAbono > 0 ? "#F59E0B" : "#9CA3AF"}">
              ${interesAbono > 0 ? fmt.format(interesAbono) : "–"}</td>
            <td style="padding:8px 14px;text-align:right;font-variant-numeric:tabular-nums;
              color:${calcPost.deudaRestante > 0 ? "#EF4444" : "#22C55E"}">
              ${calcPost.deudaRestante > 0 ? fmt.format(calcPost.deudaRestante) : "SALDADO"}</td>
            <td style="padding:8px 14px;text-align:center">
              ${esLiq
                ? `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:6px;background:#16A34A22;color:#22C55E">LIQUIDACIÓN</span>`
                : `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:6px;background:#1E3A5F;color:#60A5FA">PARCIAL</span>`}
            </td>
            <td style="padding:8px 14px;font-family:monospace;font-size:10px;color:var(--text-muted)">
              ${esc(ab.recibo || "–")}</td>
            <td style="padding:8px 14px;font-size:11px">
              ${esc(ab.quienRegistro || "–")}</td>
            <td style="padding:8px 14px;text-align:center;font-size:10px">
              ${conciliado
                ? `<span style="color:#22C55E;font-weight:700">✓</span>`
                : `<span style="color:var(--text-muted)">–</span>`}
            </td>
          </tr>`;
        }).join("");
      }

      document.getElementById("rst-modal-hist").classList.remove("hidden");
    },

    cerrarHistorial() {
      document.getElementById("rst-modal-hist").classList.add("hidden");
    },

    async guardarAbono() {
      if (!_abonoTarget) return;
      const monto  = parseFloat(document.getElementById("rst-abono-monto").value) || 0;
      const recibo = document.getElementById("rst-abono-recibo").value.trim();
      const fechaStr = document.getElementById("rst-abono-fecha").value;
      if (monto <= 0) { window.toast?.("Ingresa un monto válido.", "error"); return; }

      const fecha = new Date(fechaStr + "T12:00:00");
      const { update, liquidada } = calcularAbono(_abonoTarget, { monto, recibo, fecha });

      try {
        await updateDoc(doc(db, "remisiones_credito", _abonoTarget.id), {
          ...update,
          modificadoPor: Sesion.alias,
          modificadoEn: serverTimestamp(),
        });
        window.toast?.(
          liquidada
            ? `✅ Nota liquidada. Total pagado: ${fmt.format((_abonoTarget.totalAbonado ?? 0) + monto)}`
            : `Abono de ${fmt.format(monto)} registrado.`,
          "success"
        );
        this.cerrarAbono();
      } catch(e) {
        window.toast?.("Error: " + e.message, "error");
      }
    },
  };
}

function _previewAbono() {
  if (!_abonoTarget) return;
  const monto = parseFloat(document.getElementById("rst-abono-monto").value) || 0;
  const fechaStr = document.getElementById("rst-abono-fecha").value;
  const fecha = new Date(fechaStr + "T12:00:00");
  const { liquidada, update } = calcularAbono(_abonoTarget, { monto, recibo: "", fecha });
  const calc = calcularRemision({ ..._abonoTarget, totalAbonado: update.totalAbonado }, fecha);
  const el = document.getElementById("rst-abono-preview");
  if (!el) return;
  el.innerHTML = liquidada
    ? `<span style="color:#22C55E;font-weight:700">✅ Este abono liquida la nota completamente.</span>`
    : `Deuda restante después del abono: <b style="color:#EF4444">${fmt.format(calc.deudaRestante)}</b>`;
}

// ── Firestore listener ────────────────────────────────────────
function _escuchar() {
  const q = query(collection(db, "remisiones_credito"), orderBy("fechaCreacion", "desc"), limit(500));
  _unsub = onSnapshot(q, snap => {
    _remisiones = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderTabla();
  }, err => {
    console.error("[Remisiones]", err);
    window.toast?.("Error al cargar remisiones.", "error");
  });
}

// ── Render ────────────────────────────────────────────────────
function _renderTabla() {
  const hoy = new Date();
  const enriched = enriquecerRemisiones(_remisiones, hoy);
  const resumen  = resumenCartera(enriched);

  // KPIs
  _set("rst-k-notas",    String(resumen.notasActivas));
  _set("rst-k-vencidas", String(resumen.notasVencidas));
  _set("rst-k-capital",  fmt.format(resumen.saldoCapitalTotal));
  _set("rst-k-interes",  fmt.format(resumen.interesTotal));
  _set("rst-k-total",    fmt.format(resumen.totalAPagarTotal));

  // Filtro
  const lista = _filtro === "TODOS"
    ? enriched
    : enriched.filter(r => r.status === _filtro);

  const tbody = document.getElementById("rst-tbody");
  if (!tbody) return;

  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="14" style="padding:32px;text-align:center;color:var(--text-muted)">
      Sin remisiones para este filtro.</td></tr>`;
    return;
  }

  const esAdmin = Sesion.esSuperAdmin?.() || ["ADMINISTRADOR","GERENTE"].includes(Sesion.rol);

  tbody.innerHTML = lista.map(r => {
    const col     = STATUS_COLOR[r.status] ?? STATUS_COLOR.FUTURA;
    const mora    = r.diasAtraso < 0 ? Math.abs(r.diasAtraso) : 0;
    const pagado  = r.status === "PAGADO";

    return `<tr style="border-bottom:1px solid var(--border);${pagado ? "opacity:.6" : ""}">
      <td style="padding:9px 14px;font-weight:700;font-family:monospace;white-space:nowrap">
        ${esc(r.folio || r.id)}</td>
      <td style="padding:9px 14px;text-align:center;color:var(--text-muted);white-space:nowrap;font-size:11px">
        ${fmtDia(r.fechaCreacion)}</td>
      <td style="padding:9px 14px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${esc(r.clienteNombre || "–")}</td>
      <td style="padding:9px 14px;color:var(--text-muted)">${esc(resolverNombre(r.ingenieroAlias))}</td>
      <td style="padding:9px 14px;text-align:right;font-variant-numeric:tabular-nums">
        ${fmt.format(r.montoOriginal ?? 0)}</td>
      <td style="padding:9px 14px;text-align:right;font-variant-numeric:tabular-nums;
        color:${r.interesActivo ? "#F59E0B" : "#9CA3AF"}">
        ${r.interesActivo ? fmt.format(r.interesGenerado) : "–"}</td>
      <td style="padding:9px 14px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;
        color:${pagado ? "#22C55E" : "#EF4444"}">
        ${pagado ? "PAGADO" : fmt.format(r.deudaRestante)}</td>
      <td style="padding:9px 14px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-muted)">
        ${fmt.format(r.totalAbonado ?? 0)}</td>
      <td style="padding:9px 14px;text-align:right;font-variant-numeric:tabular-nums">
        ${pagado ? "–" : fmt.format(r.deudaRestante)}</td>
      <td style="padding:9px 14px;text-align:center;font-weight:700;
        color:${mora > 0 ? col.badge : "#9CA3AF"}">
        ${mora > 0 ? mora + " días" : "–"}</td>
      <td style="padding:9px 14px;text-align:center;color:var(--text-muted);white-space:nowrap">
        ${fmtDia(r.fechaVencimiento)}</td>
      <td style="padding:9px 14px;text-align:center">
        <span style="font-size:9px;font-weight:800;padding:3px 8px;border-radius:8px;white-space:nowrap;
          background:${col.badge}22;color:${col.badge}">${r.status}</span>
      </td>
      <td style="padding:9px 14px;text-align:center">
        ${r._origen === "apk"
          ? `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:6px;
              background:#FEF3C7;color:#92400E;border:1px solid #F59E0B">APK</span>`
          : `<span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:6px;
              background:#EFF6FF;color:#1E40AF;border:1px solid #93C5FD">Panel</span>`}
      </td>
      <td style="padding:9px 14px;text-align:center">
        <div style="display:flex;gap:5px;justify-content:center;flex-wrap:wrap">
          ${!pagado && esAdmin
            ? `<button onclick="RemisionesUI.abrirAbono('${r.id}')"
                style="font-size:10px;font-weight:700;padding:4px 10px;border-radius:5px;cursor:pointer;
                  background:#1B5E20;border:1px solid #16A34A;color:#4ADE80">
                + Abono</button>`
            : ""}
          <button onclick="RemisionesUI.abrirHistorial('${r.id}')"
            style="font-size:10px;font-weight:700;padding:4px 10px;border-radius:5px;cursor:pointer;
              background:transparent;border:1px solid #3B82F6;color:#60A5FA">
            📋 Historial</button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

function _set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
