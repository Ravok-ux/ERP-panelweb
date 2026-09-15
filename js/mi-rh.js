// ══════════════════════════════════════════════════════════════
// mi-rh.js — Vista propia de RH para ingenieros (S10)
// Cada usuario ve SOLO sus propios registros.
// No puede aprobar ni ver datos de otros.
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc } from "./app.js";
import {
  collection, doc, addDoc, onSnapshot,
  query, orderBy, where, limit, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmtMXN   = v => Number(v || 0).toLocaleString("es-MX", { style:"currency", currency:"MXN" });
const fmtFecha = ts => ts
  ? new Date(typeof ts === "number" ? ts : (ts.toMillis?.() ?? ts))
      .toLocaleDateString("es-MX", { day:"2-digit", month:"short", year:"numeric" })
  : "—";
const fmtHora  = ts => ts
  ? new Date(typeof ts === "number" ? ts : (ts.toMillis?.() ?? ts))
      .toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" })
  : "—";

const TABS = [
  { id:"asistencia", label:"📅 Mis asistencias" },
  { id:"vacaciones", label:"🏖️ Mis vacaciones"  },
  { id:"anticipos",  label:"💵 Mis anticipos"   },
  { id:"nomina",     label:"💼 Mis recibos"      },
];

const STATUS_BADGE = {
  PRESENTE:   `<span class="badge" style="background:#DCFCE7;color:#15803D">PRESENTE</span>`,
  TARDANZA:   `<span class="badge badge-amber">TARDANZA</span>`,
  AUSENTE:    `<span class="badge badge-red">AUSENTE</span>`,
  PENDIENTE:  `<span class="badge badge-amber">PENDIENTE</span>`,
  APROBADA:   `<span class="badge" style="background:#DCFCE7;color:#15803D">APROBADA</span>`,
  APROBADO:   `<span class="badge" style="background:#DCFCE7;color:#15803D">APROBADO</span>`,
  RECHAZADA:  `<span class="badge badge-red">RECHAZADA</span>`,
  RECHAZADO:  `<span class="badge badge-red">RECHAZADO</span>`,
  DESCONTADO: `<span class="badge badge-gray">DESCONTADO</span>`,
  PAGADO:     `<span class="badge" style="background:#DCFCE7;color:#15803D">PAGADO</span>`,
};

let _tabActiva = "asistencia";
let _unsubs    = [];

export const MiRhModule = {
  mount(container) {
    container.innerHTML = `
    <div class="mod-wrap">
      <div class="mod-topbar">
        <h2 class="mod-title">👤 Mi RH — ${esc(Sesion.alias)}</h2>
      </div>
      <div class="rh-tabs" id="mirh-tabs">
        ${TABS.map(t => `
          <button class="rh-tab ${t.id === "asistencia" ? "active" : ""}" data-tab="${t.id}">
            ${t.label}
          </button>`).join("")}
      </div>
      <div id="mirh-content"></div>
    </div>`;

    document.getElementById("mirh-tabs")?.addEventListener("click", e => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      document.querySelectorAll(".rh-tab").forEach(b => b.classList.toggle("active", b === btn));
      _activarTab(btn.dataset.tab);
    });

    _activarTab("asistencia");
  },
  destroy() { _unsubs.forEach(u => u?.()); _unsubs = []; },
};

function _activarTab(tab) {
  _tabActiva = tab;
  _unsubs.forEach(u => u?.()); _unsubs = [];
  if (tab === "asistencia") _montarAsistencia();
  else if (tab === "vacaciones") _montarVacaciones();
  else if (tab === "anticipos")  _montarAnticipos();
  else if (tab === "nomina")     _montarNomina();
}

// ══════════════════════════════════════════════════════════════
// MIS ASISTENCIAS
// ══════════════════════════════════════════════════════════════
function _montarAsistencia() {
  const content = document.getElementById("mirh-content");
  content.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <input type="date" class="sel-sm" id="masi-desde"
        value="${new Date(Date.now() - 29*86400000).toISOString().slice(0,10)}">
      <span style="font-size:12px;color:var(--text-sec)">–</span>
      <input type="date" class="sel-sm" id="masi-hasta"
        value="${new Date().toISOString().slice(0,10)}">
      <button class="btn-outline" id="masi-buscar">Buscar</button>
    </div>

    <div class="kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left-color:#16A34A">
        <div class="kpi-icon">✅</div><div class="kpi-val" id="masi-k-pres">–</div>
        <div class="kpi-label">Días presentes</div>
      </div>
      <div class="kpi-card" style="border-left-color:#D97706">
        <div class="kpi-icon">⏰</div><div class="kpi-val" id="masi-k-tard">–</div>
        <div class="kpi-label">Tardanzas</div>
      </div>
      <div class="kpi-card" style="border-left-color:#DC2626">
        <div class="kpi-icon">❌</div><div class="kpi-val" id="masi-k-aus">–</div>
        <div class="kpi-label">Ausencias</div>
      </div>
    </div>

    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>FECHA</th><th>CHECK-IN</th><th>CHECK-OUT</th>
          <th>HORAS</th><th>STATUS</th><th>NOTAS</th>
        </tr></thead>
        <tbody id="masi-body">
          <tr><td colspan="6" style="padding:24px;text-align:center">Cargando…</td></tr>
        </tbody>
      </table>
    </div>`;

  const buscar = () => _escucharAsistencia();
  document.getElementById("masi-buscar")?.addEventListener("click", buscar);
  _escucharAsistencia();
}

function _escucharAsistencia() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const desde = new Date(document.getElementById("masi-desde")?.value || "").getTime() || 0;
  const hasta = new Date(document.getElementById("masi-hasta")?.value || "").getTime() + 86399999;

  const q = query(
    collection(db, "rh_asistencia"),
    where("uid", "==", Sesion.uid),
    where("fecha", ">=", document.getElementById("masi-desde")?.value || ""),
    where("fecha", "<=", document.getElementById("masi-hasta")?.value || "9999"),
    orderBy("fecha", "desc"),
    limit(90)
  );

  const unsub = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const pres = rows.filter(r => r.status === "PRESENTE").length;
    const tard = rows.filter(r => r.status === "TARDANZA").length;
    const aus  = rows.filter(r => r.status === "AUSENTE").length;

    document.getElementById("masi-k-pres").textContent = pres;
    document.getElementById("masi-k-tard").textContent = tard;
    document.getElementById("masi-k-aus").textContent  = aus;

    const tbody = document.getElementById("masi-body");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-sec)">
        Sin registros en el período</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const hrs = r.checkIn && r.checkOut
        ? ((r.checkOut - r.checkIn) / 3600000).toFixed(1) + "h"
        : "—";
      return `<tr>
        <td style="font-weight:600">${esc(r.fecha || fmtFecha(r.checkIn))}</td>
        <td>${fmtHora(r.checkIn)}</td>
        <td>${fmtHora(r.checkOut)}</td>
        <td style="text-align:center">${hrs}</td>
        <td>${STATUS_BADGE[r.status] || esc(r.status)}</td>
        <td style="font-size:11px;color:var(--text-sec)">${esc(r.notas || "")}</td>
      </tr>`;
    }).join("");
  }, err => {
    console.error("[MiRH-Asistencia]", err);
    const tbody = document.getElementById("masi-body");
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:24px;text-align:center;color:#DC2626">
      Error al cargar asistencia${err.code === "failed-precondition" ? ": índice compuesto requerido en Firestore" : ""}.
    </td></tr>`;
  });
  _unsubs.push(unsub);
}

// ══════════════════════════════════════════════════════════════
// MIS VACACIONES
// ══════════════════════════════════════════════════════════════
function _montarVacaciones() {
  const content = document.getElementById("mirh-content");
  content.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
      <button class="btn-primary" id="mvac-nueva">+ Solicitar vacaciones</button>
    </div>

    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>DESDE</th><th>HASTA</th><th>DÍAS</th>
          <th>MOTIVO</th><th>STATUS</th><th>SOLICITADA</th>
        </tr></thead>
        <tbody id="mvac-body">
          <tr><td colspan="6" style="padding:24px;text-align:center">Cargando…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Modal -->
    <div class="modal-overlay hidden" id="mvac-modal">
      <div class="modal-box" style="max-width:400px">
        <div class="modal-hdr">
          <span class="modal-title">Solicitar vacaciones</span>
          <button class="modal-close" id="mvac-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label class="form-label">Fecha inicio</label>
              <input class="form-input" type="date" id="mvac-desde">
            </div>
            <div class="form-group">
              <label class="form-label">Fecha fin</label>
              <input class="form-input" type="date" id="mvac-hasta">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Motivo</label>
            <textarea class="form-input" id="mvac-motivo" rows="2"
              placeholder="Vacaciones anuales, permiso médico…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="mvac-cancel">Cancelar</button>
          <button class="btn-primary" id="mvac-guardar">Enviar solicitud</button>
        </div>
      </div>
    </div>`;

  document.getElementById("mvac-nueva")?.addEventListener("click", () =>
    document.getElementById("mvac-modal")?.classList.remove("hidden"));
  document.getElementById("mvac-close")?.addEventListener("click", () =>
    document.getElementById("mvac-modal")?.classList.add("hidden"));
  document.getElementById("mvac-cancel")?.addEventListener("click", () =>
    document.getElementById("mvac-modal")?.classList.add("hidden"));
  document.getElementById("mvac-guardar")?.addEventListener("click", _solicitarVacaciones);

  const q = query(
    collection(db, "rh_vacaciones"),
    where("uid", "==", Sesion.uid),
    orderBy("solicitadaEn", "desc"),
    limit(50)
  );
  const unsub = onSnapshot(q, snap => {
    const tbody = document.getElementById("mvac-body");
    if (!tbody) return;
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-sec)">
        Sin solicitudes de vacaciones</td></tr>`;
      return;
    }
    tbody.innerHTML = snap.docs.map(d => {
      const v = d.data();
      return `<tr>
        <td>${esc(v.desde)}</td>
        <td>${esc(v.hasta)}</td>
        <td style="text-align:center;font-weight:700">${v.diasSolicitados || "—"}</td>
        <td style="font-size:12px;color:var(--text-sec)">${esc(v.motivo || "")}</td>
        <td>${STATUS_BADGE[v.status] || esc(v.status)}</td>
        <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(v.solicitadaEn)}</td>
      </tr>`;
    }).join("");
  }, err => console.error("[MiRH-Vac]", err));
  _unsubs.push(unsub);
}

async function _solicitarVacaciones() {
  const desde  = document.getElementById("mvac-desde")?.value;
  const hasta  = document.getElementById("mvac-hasta")?.value;
  const motivo = document.getElementById("mvac-motivo")?.value?.trim();

  if (!desde || !hasta) { window.toast?.("Selecciona fechas de inicio y fin", "error"); return; }
  if (desde > hasta)    { window.toast?.("La fecha de inicio debe ser antes del fin", "error"); return; }

  const dias = Math.ceil((new Date(hasta) - new Date(desde)) / 86400000) + 1;
  const btn  = document.getElementById("mvac-guardar");
  btn.disabled = true;

  try {
    await addDoc(collection(db, "rh_vacaciones"), {
      uid:              Sesion.uid,
      alias:            Sesion.alias,
      desde,
      hasta,
      diasSolicitados:  dias,
      motivo:           motivo || "",
      status:           "PENDIENTE",
      solicitadaEn:     Date.now(),
      _ts:              Date.now(),
    });
    document.getElementById("mvac-modal")?.classList.add("hidden");
    window.toast?.(`Solicitud enviada — ${dias} días pendientes de aprobación`, "success");
  } catch (e) {
    window.toast?.("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════
// MIS ANTICIPOS
// ══════════════════════════════════════════════════════════════
function _montarAnticipos() {
  const content = document.getElementById("mirh-content");
  content.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
      <button class="btn-primary" id="mant-nueva">+ Solicitar anticipo</button>
    </div>

    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>MONTO</th><th>MOTIVO</th><th>STATUS</th><th>SOLICITADO</th>
        </tr></thead>
        <tbody id="mant-body">
          <tr><td colspan="4" style="padding:24px;text-align:center">Cargando…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Modal -->
    <div class="modal-overlay hidden" id="mant-modal">
      <div class="modal-box" style="max-width:380px">
        <div class="modal-hdr">
          <span class="modal-title">Solicitar anticipo</span>
          <button class="modal-close" id="mant-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">Monto solicitado (MXN)</label>
            <input class="form-input" type="number" id="mant-monto" min="100" step="50" placeholder="0.00">
          </div>
          <div class="form-group">
            <label class="form-label">Motivo</label>
            <input class="form-input" type="text" id="mant-motivo"
              placeholder="Urgencia médica, gastos de viaje…">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="mant-cancel">Cancelar</button>
          <button class="btn-primary" id="mant-guardar">Enviar solicitud</button>
        </div>
      </div>
    </div>`;

  document.getElementById("mant-nueva")?.addEventListener("click", () =>
    document.getElementById("mant-modal")?.classList.remove("hidden"));
  document.getElementById("mant-close")?.addEventListener("click", () =>
    document.getElementById("mant-modal")?.classList.add("hidden"));
  document.getElementById("mant-cancel")?.addEventListener("click", () =>
    document.getElementById("mant-modal")?.classList.add("hidden"));
  document.getElementById("mant-guardar")?.addEventListener("click", _solicitarAnticipo);

  const q = query(
    collection(db, "rh_anticipos"),
    where("uid", "==", Sesion.uid),
    orderBy("solicitadoEn", "desc"),
    limit(50)
  );
  const unsub = onSnapshot(q, snap => {
    const tbody = document.getElementById("mant-body");
    if (!tbody) return;
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="4" style="padding:32px;text-align:center;color:var(--text-sec)">
        Sin anticipos registrados</td></tr>`;
      return;
    }
    tbody.innerHTML = snap.docs.map(d => {
      const a = d.data();
      return `<tr>
        <td style="font-weight:700;font-variant-numeric:tabular-nums">${fmtMXN(a.monto)}</td>
        <td style="font-size:12px;color:var(--text-sec)">${esc(a.motivo || "")}</td>
        <td>${STATUS_BADGE[a.status] || esc(a.status)}</td>
        <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(a.solicitadoEn)}</td>
      </tr>`;
    }).join("");
  }, err => console.error("[MiRH-Ant]", err));
  _unsubs.push(unsub);
}

async function _solicitarAnticipo() {
  const monto  = parseFloat(document.getElementById("mant-monto")?.value || "0");
  const motivo = document.getElementById("mant-motivo")?.value?.trim();

  if (!monto || monto < 100) { window.toast?.("Monto mínimo: $100", "error"); return; }
  if (!motivo)               { window.toast?.("Escribe el motivo del anticipo", "error"); return; }

  const btn = document.getElementById("mant-guardar");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "rh_anticipos"), {
      uid:          Sesion.uid,
      alias:        Sesion.alias,
      monto,
      motivo,
      status:       "PENDIENTE",
      solicitadoEn: Date.now(),
      _ts:          Date.now(),
    });
    document.getElementById("mant-modal")?.classList.add("hidden");
    window.toast?.("Anticipo solicitado — pendiente de aprobación", "success");
  } catch (e) {
    window.toast?.("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════
// MIS RECIBOS DE NÓMINA
// ══════════════════════════════════════════════════════════════
function _montarNomina() {
  const content = document.getElementById("mirh-content");
  content.innerHTML = `
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>PERÍODO</th>
          <th style="text-align:right">SALARIO BASE</th>
          <th style="text-align:right">DEDUCCIONES</th>
          <th style="text-align:right">DESC. ANTICIPOS</th>
          <th style="text-align:right">NETO PAGADO</th>
          <th>STATUS</th>
          <th>FECHA PAGO</th>
        </tr></thead>
        <tbody id="mnom-body">
          <tr><td colspan="7" style="padding:24px;text-align:center">Cargando…</td></tr>
        </tbody>
      </table>
    </div>`;

  const q = query(
    collection(db, "rh_nomina"),
    where("uid", "==", Sesion.uid),
    orderBy("pagoEn", "desc"),
    limit(52) // hasta un año de recibos
  );
  const unsub = onSnapshot(q, snap => {
    const tbody = document.getElementById("mnom-body");
    if (!tbody) return;
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--text-sec)">
        Sin recibos de nómina registrados</td></tr>`;
      return;
    }
    tbody.innerHTML = snap.docs.map(d => {
      const n = d.data();
      return `<tr>
        <td style="font-weight:600">${esc(n.periodo || "—")}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtMXN(n.salarioBase)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;color:#DC2626">${fmtMXN(n.deducciones || 0)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums;color:#DC2626">${fmtMXN(n.descuentoAnticipos || 0)}</td>
        <td style="text-align:right;font-weight:700;font-variant-numeric:tabular-nums;color:#16A34A">
          ${fmtMXN(n.netoPagado)}</td>
        <td>${STATUS_BADGE[n.status] || esc(n.status || "")}</td>
        <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(n.pagoEn)}</td>
      </tr>`;
    }).join("");
  }, err => console.error("[MiRH-Nom]", err));
  _unsubs.push(unsub);
}
