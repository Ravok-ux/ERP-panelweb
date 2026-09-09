// ══════════════════════════════════════════════════════════════
// rh.js — Módulo de Recursos Humanos básico
// Asistencia · Vacaciones · Anticipos
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc } from "./app.js";
import {
  collection, doc, addDoc, updateDoc, onSnapshot,
  query, orderBy, where, getDocs, serverTimestamp, limit, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmtMXN   = v => Number(v || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const fmtFecha = ts => ts ? new Date(typeof ts === "number" ? ts : ts.toMillis?.() ?? ts)
  .toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtHora  = ts => ts ? new Date(typeof ts === "number" ? ts : ts.toMillis?.() ?? ts)
  .toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "—";

const TABS = [
  { id: "asistencia",  label: "📅 Asistencia"    },
  { id: "vacaciones",  label: "🏖️ Vacaciones"    },
  { id: "anticipos",   label: "💵 Anticipos"     },
  { id: "nomina",      label: "💼 Nómina"        },
  { id: "evaluacion",  label: "⭐ Evaluación"    },
  { id: "reclutamiento", label: "🧑‍💼 Reclutamiento" },
];

let _tabActiva  = "asistencia";
let _unsubs     = [];
let _usuarios   = [];

export const RhModule = {
  mount(container) {
    if (!_puedeVer()) {
      container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-sec)">
        Acceso restringido a administradores y gerentes.</div>`;
      return;
    }
    container.innerHTML = _html();
    _bindTabs();
    _cargarUsuarios().then(() => _activarTab("asistencia"));
    return () => this.destroy();
  },
  destroy() { _unsubs.forEach(u => u?.()); _unsubs = []; }
};

function _puedeVer() {
  return Sesion.esSuperAdmin?.() || ["GERENTE","ADMINISTRADOR"].includes(Sesion.rol) || Sesion.tieneFlag("PUEDE_VER_RH");
}
function _puedeAprobar() {
  return Sesion.esSuperAdmin?.() || ["GERENTE","ADMINISTRADOR"].includes(Sesion.rol);
}

// ── HTML ─────────────────────────────────────────────────────
function _html() {
  return `
  <div class="mod-wrap">
    <div class="mod-topbar">
      <h2 class="mod-title">👥 Recursos Humanos</h2>
    </div>
    <div class="rh-tabs" id="rh-tabs">
      ${TABS.map(t => `
        <button class="rh-tab ${t.id === "asistencia" ? "active" : ""}" data-tab="${t.id}">
          ${t.label}
        </button>`).join("")}
    </div>
    <div id="rh-content"></div>
  </div>`;
}

// ── Tabs ─────────────────────────────────────────────────────
function _bindTabs() {
  document.getElementById("rh-tabs")?.addEventListener("click", e => {
    const btn = e.target.closest("[data-tab]");
    if (!btn) return;
    document.querySelectorAll(".rh-tab").forEach(b => b.classList.toggle("active", b === btn));
    _activarTab(btn.dataset.tab);
  });
}

function _activarTab(tab) {
  _tabActiva = tab;
  _unsubs.forEach(u => u?.()); _unsubs = [];
  if (tab === "asistencia")    _montarAsistencia();
  else if (tab === "vacaciones")   _montarVacaciones();
  else if (tab === "anticipos")    _montarAnticipos();
  else if (tab === "nomina")       _montarNomina();
  else if (tab === "evaluacion")   _montarEvaluacion();
  else if (tab === "reclutamiento") _montarReclutamiento();
}

// ── Cargar lista de usuarios ──────────────────────────────────
async function _cargarUsuarios() {
  try {
    const snap = await getDocs(query(collection(db, "usuarios"), where("activo", "==", true)));
    _usuarios = snap.docs
      .filter(d => ["INGENIERO","RECUPERADOR"].includes(d.data().rol))
      .map(d => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (a.alias||"").localeCompare(b.alias||""));
  } catch(e) { _usuarios = []; }
}

function _optUsuarios(extraOpt = "") {
  return `<option value="">Todos los ingenieros</option>` + extraOpt +
    _usuarios.map(u => `<option value="${esc(u.uid)}">${esc(u.alias || u.uid)}</option>`).join("");
}

// ══════════════════════════════════════════════════════════════
// ASISTENCIA
// ══════════════════════════════════════════════════════════════
function _montarAsistencia() {
  const content = document.getElementById("rh-content");
  const hoy = new Date(); hoy.setHours(0,0,0,0);

  content.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <select class="sel-sm" id="asi-vista">
        <option value="dia">Vista por día</option>
        <option value="mes">Resumen mensual</option>
      </select>
      <select class="sel-sm" id="asi-filtro-uid">${_optUsuarios()}</select>
      <input type="date" class="sel-sm" id="asi-filtro-fecha"
        value="${new Date().toISOString().slice(0,10)}">
      <input type="month" class="sel-sm hidden" id="asi-filtro-mes"
        value="${new Date().toISOString().slice(0,7)}">
      <div style="display:flex;gap:8px;flex-shrink:0;margin-left:auto">
        <button class="btn-primary" id="asi-reg-btn">+ Registrar asistencia</button>
        <button id="asi-xlsx-btn" style="padding:7px 12px;background:#16A34A;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">⬇️ Excel</button>
      </div>
    </div>

    <!-- KPIs del día -->
    <div class="kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left-color:#16A34A">
        <div class="kpi-icon">✅</div>
        <div class="kpi-val" id="asi-kpi-pres">–</div>
        <div class="kpi-label">Presentes hoy</div>
      </div>
      <div class="kpi-card" style="border-left-color:#DC2626">
        <div class="kpi-icon">❌</div>
        <div class="kpi-val" id="asi-kpi-aus">–</div>
        <div class="kpi-label">Ausentes</div>
      </div>
      <div class="kpi-card" style="border-left-color:#D97706">
        <div class="kpi-icon">⏰</div>
        <div class="kpi-val" id="asi-kpi-tard">–</div>
        <div class="kpi-label">Tardanzas</div>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th data-diaria>INGENIERO</th><th>FECHA</th><th>CHECK-IN</th>
          <th>CHECK-OUT</th><th>HORAS</th><th>STATUS</th><th>NOTAS</th>
        </tr>
      </thead>
      <tbody id="asi-body">
        ${window.skeleton?.(5, 7) ?? ""}
      </tbody>
    </table>

    <!-- Modal registro -->
    <div class="modal-overlay hidden" id="asi-modal">
      <div class="modal-box" style="max-width:420px">
        <div class="modal-hdr">
          <span class="modal-title">Registrar asistencia</span>
          <button class="modal-close" id="asi-modal-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">Ingeniero</label>
            <select class="form-input" id="asi-uid">
              <option value="">— Selecciona un ingeniero —</option>
              ${_usuarios.map(u => `<option value="${esc(u.uid)}">${esc(u.alias || u.uid)}</option>`).join("")}
            </select>
          </div>
          <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label class="form-label">Fecha</label>
              <input class="form-input" type="date" id="asi-fecha" value="${new Date().toISOString().slice(0,10)}">
            </div>
            <div class="form-group">
              <label class="form-label">Status</label>
              <select class="form-input" id="asi-status">
                <option value="PRESENTE">Presente</option>
                <option value="AUSENTE">Ausente</option>
                <option value="TARDANZA">Tardanza</option>
                <option value="PERMISO">Permiso</option>
                <option value="VACACIONES">Vacaciones</option>
              </select>
            </div>
          </div>
          <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label class="form-label">Check-in</label>
              <input class="form-input" type="time" id="asi-checkin" value="08:00">
            </div>
            <div class="form-group">
              <label class="form-label">Check-out</label>
              <input class="form-input" type="time" id="asi-checkout" value="17:00">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Notas</label>
            <input class="form-input" type="text" id="asi-notas" placeholder="Opcional">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="asi-cancel">Cancelar</button>
          <button class="btn-primary" id="asi-guardar">Guardar</button>
        </div>
      </div>
    </div>`;

  // Bind
  document.getElementById("asi-reg-btn")?.addEventListener("click", () =>
    document.getElementById("asi-modal")?.classList.remove("hidden"));
  document.getElementById("asi-modal-close")?.addEventListener("click", () =>
    document.getElementById("asi-modal")?.classList.add("hidden"));
  document.getElementById("asi-cancel")?.addEventListener("click", () =>
    document.getElementById("asi-modal")?.classList.add("hidden"));
  document.getElementById("asi-guardar")?.addEventListener("click", _guardarAsistencia);
  document.getElementById("asi-filtro-uid")?.addEventListener("change", _escucharAsistencia);
  document.getElementById("asi-filtro-fecha")?.addEventListener("change", _escucharAsistencia);
  document.getElementById("asi-filtro-mes")?.addEventListener("change", _escucharAsistencia);
  document.getElementById("asi-xlsx-btn")?.addEventListener("click", _exportarAsistencia);
  document.getElementById("asi-vista")?.addEventListener("change", e => {
    const esMes = e.target.value === "mes";
    document.getElementById("asi-filtro-fecha")?.classList.toggle("hidden", esMes);
    document.getElementById("asi-filtro-mes")?.classList.toggle("hidden", !esMes);
    _escucharAsistencia();
  });

  _escucharAsistencia();
}

function _escucharAsistencia() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const uid   = document.getElementById("asi-filtro-uid")?.value;
  const vista = document.getElementById("asi-vista")?.value || "dia";

  let desde, hasta;
  if (vista === "mes") {
    const mes = document.getElementById("asi-filtro-mes")?.value || new Date().toISOString().slice(0,7);
    const [y,m] = mes.split("-").map(Number);
    desde = new Date(y,m-1,1,0,0,0).getTime();
    hasta = new Date(y,m,0,23,59,59).getTime();
  } else {
    const fecha = document.getElementById("asi-filtro-fecha")?.value || new Date().toISOString().slice(0,10);
    const [y,m,d] = fecha.split("-").map(Number);
    desde = new Date(y,m-1,d,0,0,0).getTime();
    hasta = new Date(y,m-1,d,23,59,59).getTime();
  }

  let q = query(collection(db, "rh_asistencia"),
    where("fechaTs", ">=", desde), where("fechaTs", "<=", hasta),
    orderBy("fechaTs", "desc"), limit(200));
  if (uid) q = query(collection(db, "rh_asistencia"),
    where("uid", "==", uid),
    where("fechaTs", ">=", desde), where("fechaTs", "<=", hasta),
    orderBy("fechaTs", "desc"), limit(200));

  const unsub = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const vista = document.getElementById("asi-vista")?.value || "dia";
    if (vista === "mes") _renderResumenMensual(rows);
    else _renderAsistencia(rows);
  }, err => console.error("[RH-Asistencia]", err));
  _unsubs.push(unsub);
}

function _renderResumenMensual(rows) {
  // Agrupar por usuario y contar presentes/ausentes/tardanzas
  const porUid = {};
  _usuarios.forEach(u => { porUid[u.uid] = { alias:u.alias||u.uid, pres:0, aus:0, tard:0, perm:0, vac:0 }; });
  rows.forEach(r => {
    if (!porUid[r.uid]) porUid[r.uid] = { alias:r.alias||r.uid, pres:0, aus:0, tard:0, perm:0, vac:0 };
    if (r.status === "PRESENTE")   porUid[r.uid].pres++;
    if (r.status === "AUSENTE")    porUid[r.uid].aus++;
    if (r.status === "TARDANZA")   porUid[r.uid].tard++;
    if (r.status === "PERMISO")    porUid[r.uid].perm++;
    if (r.status === "VACACIONES") porUid[r.uid].vac++;
  });
  const totalDias = rows.length ? Math.max(...Object.values(porUid).map(u => u.pres+u.aus+u.tard+u.perm+u.vac), 1) : 1;
  const filas = Object.values(porUid).map(u => {
    const total = u.pres+u.aus+u.tard+u.perm+u.vac;
    const pct   = total ? Math.round(u.pres/total*100) : 0;
    const col   = pct>=80?"#16A34A":pct>=60?"#D97706":"#DC2626";
    return `<tr>
      <td style="font-weight:600">${esc(u.alias)}</td>
      <td style="text-align:center;color:#16A34A;font-weight:700">${u.pres}</td>
      <td style="text-align:center;color:#DC2626">${u.aus}</td>
      <td style="text-align:center;color:#D97706">${u.tard}</td>
      <td style="text-align:center;color:#6366F1">${u.perm}</td>
      <td style="text-align:center;color:#A855F7">${u.vac}</td>
      <td style="text-align:center;font-weight:700;color:${col}">${pct}%</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-sec)">Sin registros</td></tr>`;

  const tbody = document.getElementById("asi-body");
  const thead = tbody?.closest("table")?.querySelector("thead tr");
  if (thead) thead.innerHTML = `<th>INGENIERO</th><th>✅ Presentes</th><th>❌ Ausentes</th><th>⏰ Tardanzas</th><th>🟡 Permisos</th><th>🟣 Vacaciones</th><th>% Asistencia</th>`;
  // (sin data-diaria → _renderAsistencia sabrá que necesita restaurar headers)
  if (tbody) tbody.innerHTML = filas;
}

let _asiRowsCache = [];
function _exportarAsistencia() {
  if (!_asiRowsCache.length) { window.toast?.("Sin datos para exportar","warning"); return; }
  const h = ["Ingeniero","Fecha","Check-in","Check-out","Horas","Status","Notas"];
  const d = _asiRowsCache.map(r => [
    r.alias||"", r.fecha||"", r.checkIn||"", r.checkOut||"",
    r.checkIn && r.checkOut ? ((r.checkOutTs-r.checkInTs)/3600000).toFixed(1) : "",
    r.status||"", r.notas||""
  ]);
  const ws = XLSX.utils.aoa_to_sheet([h,...d]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Asistencia");
  XLSX.writeFile(wb, `N10-asistencia-${new Date().toISOString().slice(0,10)}.xlsx`);
  window.toast?.("Excel generado","info");
}

function _renderAsistencia(rows) {
  _asiRowsCache = rows;
  const presentes  = rows.filter(r => r.status === "PRESENTE").length;
  const ausentes   = rows.filter(r => r.status === "AUSENTE").length;
  const tardanzas  = rows.filter(r => r.status === "TARDANZA").length;
  const el = id => document.getElementById(id);
  if (el("asi-kpi-pres"))  el("asi-kpi-pres").textContent  = presentes;
  if (el("asi-kpi-aus"))   el("asi-kpi-aus").textContent   = ausentes;
  if (el("asi-kpi-tard"))  el("asi-kpi-tard").textContent  = tardanzas;

  // Restaurar encabezados en caso de que se haya cambiado a vista mensual antes
  const thead = document.querySelector("#asi-body")?.closest("table")?.querySelector("thead tr");
  if (thead && !thead.querySelector("th[data-diaria]")) {
    thead.innerHTML = `<th data-diaria>INGENIERO</th><th>FECHA</th><th>CHECK-IN</th><th>CHECK-OUT</th><th>HORAS</th><th>STATUS</th><th>NOTAS</th>`;
  }

  const STATUS_CLS = {
    PRESENTE: "badge-green", AUSENTE: "badge-red",
    TARDANZA: "badge-amber", PERMISO: "badge-yellow", VACACIONES: "badge-purple"
  };
  const tbody = document.getElementById("asi-body");
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text-sec)">Sin registros</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const horas = r.checkIn && r.checkOut
      ? ((r.checkOutTs - r.checkInTs) / 3600000).toFixed(1) + "h" : "–";
    return `<tr>
      <td><b>${esc(r.alias || "–")}</b></td>
      <td>${fmtFecha(r.fechaTs)}</td>
      <td>${r.checkIn || "–"}</td>
      <td>${r.checkOut || "–"}</td>
      <td>${horas}</td>
      <td><span class="badge ${STATUS_CLS[r.status] || "badge-gray"}">${esc(r.status)}</span></td>
      <td style="color:var(--text-sec);font-size:12px">${esc(r.notas || "")}</td>
    </tr>`;
  }).join("");
}

async function _guardarAsistencia() {
  const uid     = document.getElementById("asi-uid")?.value;
  const fecha   = document.getElementById("asi-fecha")?.value;
  const status  = document.getElementById("asi-status")?.value;
  const checkIn = document.getElementById("asi-checkin")?.value;
  const checkOut= document.getElementById("asi-checkout")?.value;
  const notas   = document.getElementById("asi-notas")?.value.trim();

  if (!uid || !fecha) { window.toast?.("Selecciona un ingeniero y fecha", "error"); return; }

  const usuario = _usuarios.find(u => u.uid === uid);
  const [y,m,d] = fecha.split("-").map(Number);
  const fechaTs = new Date(y,m-1,d,0,0,0).getTime();
  const [hi,mi] = (checkIn || "08:00").split(":").map(Number);
  const [ho,mo] = (checkOut|| "17:00").split(":").map(Number);
  const checkInTs  = new Date(y,m-1,d,hi,mi).getTime();
  const checkOutTs = new Date(y,m-1,d,ho,mo).getTime();

  const btn = document.getElementById("asi-guardar");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    await addDoc(collection(db, "rh_asistencia"), {
      uid, alias: usuario?.alias || uid, status,
      fecha, fechaTs, checkIn, checkOut, checkInTs, checkOutTs,
      notas, registradoPor: Sesion.alias, timestamp: serverTimestamp(), _ts: Date.now()
    });
    window.toast?.("Asistencia registrada", "success");
    document.getElementById("asi-modal")?.classList.add("hidden");
  } catch(e) { window.toast?.("Error: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar"; }
}

// ══════════════════════════════════════════════════════════════
// VACACIONES
// ══════════════════════════════════════════════════════════════
function _montarVacaciones() {
  const content = document.getElementById("rh-content");
  const puedeApr = _puedeAprobar();

  content.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <select class="sel-sm" id="vac-filtro-tipo">
        <option value="">Todos los tipos</option>
        <option value="VACACIONES">Vacaciones</option>
        <option value="PERMISO_GOCE">Permiso con goce</option>
        <option value="PERMISO_SIN_GOCE">Permiso sin goce</option>
        <option value="INCAPACIDAD_IMSS">Incapacidad IMSS</option>
        <option value="INCAPACIDAD_LABORAL">Incapacidad laboral</option>
      </select>
      <select class="sel-sm" id="vac-filtro-status">
        <option value="">Todos los estados</option>
        <option value="PENDIENTE">Pendiente</option>
        <option value="APROBADA">Aprobada</option>
        <option value="RECHAZADA">Rechazada</option>
      </select>
      <button class="btn-primary" id="vac-nueva-btn">+ Nueva solicitud</button>
      <button id="vac-saldo-btn" style="padding:7px 12px;background:var(--surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;cursor:pointer;font-size:13px">📊 Saldo de días</button>
    </div>

    <div id="vac-saldo-panel" class="hidden" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:16px">
      <b style="font-size:13px">Saldo de días de vacaciones por empleado</b>
      <table class="data-table" id="vac-saldo-table" style="margin-top:10px">
        <thead><tr><th>Ingeniero</th><th style="text-align:right">Días disponibles</th><th style="text-align:right">Usados</th><th style="text-align:right">Saldo</th><th>Acción</th></tr></thead>
        <tbody id="vac-saldo-body"><tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-sec)">Cargando…</td></tr></tbody>
      </table>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>INGENIERO</th><th>TIPO</th><th>DESDE</th><th>HASTA</th><th>DÍAS</th>
          <th>MOTIVO</th><th>STATUS</th><th>SOLICITADA</th>
          ${puedeApr ? "<th>ACCIÓN</th>" : ""}
        </tr>
      </thead>
      <tbody id="vac-body">
        <tr><td colspan="9" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
      </tbody>
    </table>

    <!-- Modal solicitud -->
    <div class="modal-overlay hidden" id="vac-modal">
      <div class="modal-box" style="max-width:420px">
        <div class="modal-hdr">
          <span class="modal-title">Solicitud de vacaciones</span>
          <button class="modal-close" id="vac-modal-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">Ingeniero</label>
            <select class="form-input" id="vac-uid">${_optUsuarios()}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Tipo de ausencia</label>
            <select class="form-input" id="vac-tipo">
              <option value="VACACIONES">🏖️ Vacaciones anuales</option>
              <option value="PERMISO_GOCE">✅ Permiso con goce de sueldo</option>
              <option value="PERMISO_SIN_GOCE">⚠️ Permiso sin goce de sueldo</option>
              <option value="INCAPACIDAD_IMSS">🏥 Incapacidad IMSS</option>
              <option value="INCAPACIDAD_LABORAL">🤕 Incapacidad laboral</option>
            </select>
          </div>
          <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label class="form-label">Fecha inicio</label>
              <input class="form-input" type="date" id="vac-desde">
            </div>
            <div class="form-group">
              <label class="form-label">Fecha fin</label>
              <input class="form-input" type="date" id="vac-hasta">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Folio IMSS / Documento (opcional)</label>
            <input class="form-input" type="text" id="vac-folio" placeholder="Folio de incapacidad o referencia">
          </div>
          <div class="form-group">
            <label class="form-label">Motivo / notas</label>
            <textarea class="form-input" id="vac-motivo" rows="2" placeholder="Vacaciones anuales, permiso médico…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="vac-cancel">Cancelar</button>
          <button class="btn-primary" id="vac-guardar">Solicitar</button>
        </div>
      </div>
    </div>`;

  document.getElementById("vac-nueva-btn")?.addEventListener("click", () =>
    document.getElementById("vac-modal")?.classList.remove("hidden"));
  document.getElementById("vac-modal-close")?.addEventListener("click", () =>
    document.getElementById("vac-modal")?.classList.add("hidden"));
  document.getElementById("vac-cancel")?.addEventListener("click", () =>
    document.getElementById("vac-modal")?.classList.add("hidden"));
  document.getElementById("vac-guardar")?.addEventListener("click", _guardarVacacion);
  document.getElementById("vac-filtro-status")?.addEventListener("change", _escucharVacaciones);
  document.getElementById("vac-filtro-tipo")?.addEventListener("change", _escucharVacaciones);
  document.getElementById("vac-saldo-btn")?.addEventListener("click", () => {
    const panel = document.getElementById("vac-saldo-panel");
    panel?.classList.toggle("hidden");
    if (!panel?.classList.contains("hidden")) _cargarSaldosVacaciones();
  });

  _escucharVacaciones();
}

function _escucharVacaciones() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const st   = document.getElementById("vac-filtro-status")?.value;
  const tipo = document.getElementById("vac-filtro-tipo")?.value;
  let constraints = [orderBy("_ts","desc"), limit(300)];
  if (st)   constraints = [where("status","==",st), ...constraints];
  if (tipo) constraints = [where("tipo","==",tipo), ...constraints];
  let q = query(collection(db, "rh_vacaciones"), ...constraints);

  const unsub = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderVacaciones(rows);
  }, err => console.error("[RH-Vacaciones]", err));
  _unsubs.push(unsub);
}

function _renderVacaciones(rows) {
  const puedeApr = _puedeAprobar();
  const ST = { PENDIENTE:"badge-yellow", APROBADA:"badge-green", RECHAZADA:"badge-red" };
  const tbody = document.getElementById("vac-body");
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:var(--text-sec)">Sin solicitudes</td></tr>`;
    return;
  }
  const TIPO_LABEL = {
    VACACIONES:"🏖️ Vacaciones", PERMISO_GOCE:"✅ C/ goce",
    PERMISO_SIN_GOCE:"⚠️ S/ goce", INCAPACIDAD_IMSS:"🏥 IMSS",
    INCAPACIDAD_LABORAL:"🤕 Laboral"
  };
  tbody.innerHTML = rows.map(r => {
    const dias = r.desdeTs && r.hastaTs
      ? Math.round((r.hastaTs - r.desdeTs) / 86400000) + 1 : "–";
    const accBtn = puedeApr && r.status === "PENDIENTE"
      ? `<button class="btn-sm btn-green" data-id="${r.id}" data-act="apr">✓</button>
         <button class="btn-sm btn-red"   data-id="${r.id}" data-act="rec" style="margin-left:4px">✗</button>`
      : `<span style="font-size:11px;color:var(--text-sec)">${r.aprobadaPor || r.rechazadaPor || "—"}</span>`;
    return `<tr>
      <td><b>${esc(r.alias || "–")}</b></td>
      <td style="font-size:12px">${esc(TIPO_LABEL[r.tipo] || r.tipo || "—")}</td>
      <td>${fmtFecha(r.desdeTs)}</td>
      <td>${fmtFecha(r.hastaTs)}</td>
      <td style="text-align:center">${dias}</td>
      <td style="font-size:12px;color:var(--text-sec)">${esc(r.motivo || "–")}</td>
      <td><span class="badge ${ST[r.status] || "badge-gray"}">${esc(r.status)}</span></td>
      <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(r._ts)}</td>
      ${puedeApr ? `<td class="td-actions">${accBtn}</td>` : ""}
    </tr>`;
  }).join("");

  if (puedeApr) {
    tbody.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", () => {
        const { id, act } = btn.dataset;
        if (act === "apr") _aprobarVacacion(id);
        else _rechazarVacacion(id);
      });
    });
  }
}

async function _cargarSaldosVacaciones() {
  const tbody = document.getElementById("vac-saldo-body");
  if (!tbody) return;
  try {
    const snap = await getDocs(query(collection(db,"rh_vacaciones"), where("status","==","APROBADA"), where("tipo","==","VACACIONES"), limit(500)));
    const diasUsados = {};
    snap.docs.forEach(d => {
      const r = d.data();
      const dias = r.desdeTs && r.hastaTs ? Math.round((r.hastaTs-r.desdeTs)/86400000)+1 : 0;
      if (!diasUsados[r.uid]) diasUsados[r.uid] = 0;
      diasUsados[r.uid] += dias;
    });
    tbody.innerHTML = _usuarios.map(u => {
      const disponibles = u.diasVacaciones || 15;
      const usados      = diasUsados[u.uid] || 0;
      const saldo       = disponibles - usados;
      const col         = saldo>7?"#16A34A":saldo>0?"#D97706":"#DC2626";
      return `<tr>
        <td style="font-weight:600">${esc(u.alias||u.uid)}</td>
        <td style="text-align:right">${disponibles}</td>
        <td style="text-align:right;color:#DC2626">${usados}</td>
        <td style="text-align:right;font-weight:700;color:${col}">${saldo}</td>
        <td>
          <button class="btn-sm btn-outline" data-uid="${u.uid}" data-alias="${esc(u.alias)}" data-dias="${disponibles}" data-act="editar-dias">✏️ Editar</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-sec)">Sin empleados</td></tr>`;

    tbody.querySelectorAll("[data-act='editar-dias']").forEach(btn => {
      btn.addEventListener("click", async () => {
        const dias = parseInt(await window.promptModal({ title:`Días de vacaciones — ${btn.dataset.alias}`, label:"Días disponibles al año", placeholder:"15" }) || "");
        if (isNaN(dias) || dias < 0) return;
        await updateDoc(doc(db,"usuarios",btn.dataset.uid), { diasVacaciones: dias }).catch(e => window.toast?.(e.message,"error"));
        const u = _usuarios.find(x => x.uid===btn.dataset.uid);
        if (u) u.diasVacaciones = dias;
        _cargarSaldosVacaciones();
        window.toast?.("Saldo actualizado","success");
      });
    });
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#DC2626">${esc(e.message)}</td></tr>`;
  }
}

async function _guardarVacacion() {
  const uid    = document.getElementById("vac-uid")?.value;
  const tipo   = document.getElementById("vac-tipo")?.value || "VACACIONES";
  const desde  = document.getElementById("vac-desde")?.value;
  const hasta  = document.getElementById("vac-hasta")?.value;
  const folio  = document.getElementById("vac-folio")?.value.trim();
  const motivo = document.getElementById("vac-motivo")?.value.trim();
  if (!uid || !desde || !hasta) { window.toast?.("Completa todos los campos", "error"); return; }
  const usuario = _usuarios.find(u => u.uid === uid);
  const [dy,dm,dd] = desde.split("-").map(Number);
  const [hy,hm,hd] = hasta.split("-").map(Number);
  const desdeTs = new Date(dy,dm-1,dd).getTime();
  const hastaTs = new Date(hy,hm-1,hd,23,59,59).getTime();
  if (hastaTs < desdeTs) { window.toast?.("La fecha de fin debe ser posterior a la de inicio", "error"); return; }
  const btn = document.getElementById("vac-guardar");
  btn.disabled = true; btn.textContent = "Enviando…";
  try {
    await addDoc(collection(db, "rh_vacaciones"), {
      uid, alias: usuario?.alias || uid, tipo, desde, hasta, desdeTs, hastaTs,
      folio: folio || "", motivo, status: "PENDIENTE", solicitadaPor: Sesion.alias,
      timestamp: serverTimestamp(), _ts: Date.now()
    });
    window.toast?.("Solicitud enviada", "success");
    document.getElementById("vac-modal")?.classList.add("hidden");
  } catch(e) { window.toast?.("Error: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Solicitar"; }
}

async function _aprobarVacacion(id) {
  await updateDoc(doc(db, "rh_vacaciones", id), {
    status: "APROBADA", aprobadaPor: Sesion.alias, aprobadaEn: serverTimestamp()
  }).catch(e => window.toast?.("Error: " + e.message, "error"));
  window.toast?.("Vacaciones aprobadas", "success");
}
async function _rechazarVacacion(id) {
  const motivo = await window.promptModal({ title: "Rechazar vacaciones", label: "Motivo del rechazo (opcional)", placeholder: "Motivo…" });
  if (motivo === null) return;
  await updateDoc(doc(db, "rh_vacaciones", id), {
    status: "RECHAZADA", rechazadaPor: Sesion.alias, motivoRechazo: motivo
  }).catch(e => window.toast?.("Error: " + e.message, "error"));
  window.toast?.("Solicitud rechazada", "success");
}

// ══════════════════════════════════════════════════════════════
// ANTICIPOS
// ══════════════════════════════════════════════════════════════
function _montarAnticipos() {
  const content = document.getElementById("rh-content");
  const puedeApr = _puedeAprobar();

  content.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <select class="sel-sm" id="ant-filtro-uid">${_optUsuarios()}</select>
      <select class="sel-sm" id="ant-filtro-status">
        <option value="">Todos los estados</option>
        <option value="PENDIENTE">Pendiente</option>
        <option value="APROBADO">Aprobado</option>
        <option value="RECHAZADO">Rechazado</option>
        <option value="DESCONTADO">Descontado de nómina</option>
      </select>
      <button class="btn-primary" id="ant-nueva-btn">+ Nuevo anticipo</button>
    </div>

    <!-- KPIs de anticipos -->
    <div class="kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left-color:#D97706">
        <div class="kpi-icon">⏳</div>
        <div class="kpi-val" id="ant-kpi-pend">–</div>
        <div class="kpi-label">Por aprobar</div>
      </div>
      <div class="kpi-card" style="border-left-color:#DC2626">
        <div class="kpi-icon">💵</div>
        <div class="kpi-val" id="ant-kpi-monto">–</div>
        <div class="kpi-label">Aprobados pendientes de descuento</div>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>INGENIERO</th><th>MONTO</th><th>MOTIVO</th>
          <th>STATUS</th><th>FECHA</th>
          ${puedeApr ? "<th>ACCIÓN</th>" : ""}
        </tr>
      </thead>
      <tbody id="ant-body">
        <tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
      </tbody>
    </table>

    <!-- Modal solicitud -->
    <div class="modal-overlay hidden" id="ant-modal">
      <div class="modal-box" style="max-width:400px">
        <div class="modal-hdr">
          <span class="modal-title">Solicitar anticipo</span>
          <button class="modal-close" id="ant-modal-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">Ingeniero</label>
            <select class="form-input" id="ant-uid">${_optUsuarios()}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Monto solicitado</label>
            <input class="form-input" type="number" id="ant-monto" min="1" step="50" placeholder="0.00">
          </div>
          <div class="form-group">
            <label class="form-label">Motivo</label>
            <input class="form-input" type="text" id="ant-motivo" placeholder="Urgencia médica, gastos de viaje…">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="ant-cancel">Cancelar</button>
          <button class="btn-primary" id="ant-guardar">Solicitar</button>
        </div>
      </div>
    </div>`;

  document.getElementById("ant-nueva-btn")?.addEventListener("click", () =>
    document.getElementById("ant-modal")?.classList.remove("hidden"));
  document.getElementById("ant-modal-close")?.addEventListener("click", () =>
    document.getElementById("ant-modal")?.classList.add("hidden"));
  document.getElementById("ant-cancel")?.addEventListener("click", () =>
    document.getElementById("ant-modal")?.classList.add("hidden"));
  document.getElementById("ant-guardar")?.addEventListener("click", _guardarAnticipo);
  document.getElementById("ant-filtro-uid")?.addEventListener("change", _escucharAnticipos);
  document.getElementById("ant-filtro-status")?.addEventListener("change", _escucharAnticipos);

  _escucharAnticipos();
}

function _escucharAnticipos() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const uid = document.getElementById("ant-filtro-uid")?.value;
  const st  = document.getElementById("ant-filtro-status")?.value;

  let constraints = [orderBy("_ts", "desc"), limit(200)];
  if (uid) constraints = [where("uid", "==", uid), ...constraints];
  if (st)  constraints = [where("status", "==", st), ...constraints];
  const q = query(collection(db, "rh_anticipos"), ...constraints);

  const unsub = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderAnticipos(rows);
  }, err => console.error("[RH-Anticipos]", err));
  _unsubs.push(unsub);
}

function _renderAnticipos(rows) {
  const puedeApr = _puedeAprobar();
  const ST = { PENDIENTE:"badge-yellow", APROBADO:"badge-green", RECHAZADO:"badge-red", DESCONTADO:"badge-purple", ADEUDO:"badge-red", PAGADO:"badge-green" };
  const pending = rows.filter(r => r.status === "PENDIENTE").length;
  const montoAprobado = rows.filter(r => r.status === "APROBADO").reduce((s,r) => s + (r.monto||0), 0);
  const el = id => document.getElementById(id);
  if (el("ant-kpi-pend"))  el("ant-kpi-pend").textContent  = pending;
  if (el("ant-kpi-monto")) el("ant-kpi-monto").textContent = fmtMXN(montoAprobado);

  const tbody = document.getElementById("ant-body");
  if (!tbody) return;
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Sin anticipos</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const accBtn = puedeApr && r.status === "PENDIENTE"
      ? `<button class="btn-sm btn-green" data-id="${r.id}" data-act="apr">✓ Aprobar</button>
         <button class="btn-sm btn-red"   data-id="${r.id}" data-act="rec" style="margin-left:4px">✗ Rechazar</button>`
      : puedeApr && r.status === "APROBADO"
      ? `<button class="btn-sm btn-outline" data-id="${r.id}" data-act="desc">✓ Descontar de nómina</button>`
      : puedeApr && r.status === "ADEUDO"
      ? `<button class="btn-sm btn-green" data-id="${r.id}" data-act="pagar">💰 Marcar pagado</button>`
      : `<span style="font-size:11px;color:var(--text-sec)">${r.aprobadoPor || r.rechazadoPor || r.pagadoPor || "—"}</span>`;
    return `<tr>
      <td><b>${esc(r.alias || "–")}</b></td>
      <td style="font-weight:700">${fmtMXN(r.monto)}</td>
      <td style="font-size:12px">${esc(r.motivo || "–")}</td>
      <td><span class="badge ${ST[r.status] || "badge-gray"}">${esc(r.status)}</span></td>
      <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(r._ts)}</td>
      ${puedeApr ? `<td class="td-actions">${accBtn}</td>` : ""}
    </tr>`;
  }).join("");

  if (puedeApr) {
    tbody.querySelectorAll("[data-act]").forEach(btn => {
      btn.addEventListener("click", () => {
        const { id, act } = btn.dataset;
        if (act === "apr")  _aprobarAnticipo(id);
        else if (act === "rec")  _rechazarAnticipo(id);
        else if (act === "desc") _descontarAnticipo(id);
        else if (act === "pagar") _pagarAdeudo(id);
      });
    });
  }
}

async function _guardarAnticipo() {
  const uid    = document.getElementById("ant-uid")?.value;
  const monto  = parseFloat(document.getElementById("ant-monto")?.value || "0");
  const motivo = document.getElementById("ant-motivo")?.value.trim();
  if (!uid || monto <= 0) { window.toast?.("Completa todos los campos", "error"); return; }
  const usuario = _usuarios.find(u => u.uid === uid);
  const btn = document.getElementById("ant-guardar");
  btn.disabled = true; btn.textContent = "Enviando…";
  try {
    await addDoc(collection(db, "rh_anticipos"), {
      uid, alias: usuario?.alias || uid, monto, motivo,
      status: "PENDIENTE", solicitadoPor: Sesion.alias,
      timestamp: serverTimestamp(), _ts: Date.now()
    });
    window.toast?.("Solicitud enviada", "success");
    document.getElementById("ant-modal")?.classList.add("hidden");
  } catch(e) { window.toast?.("Error: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Solicitar"; }
}

async function _aprobarAnticipo(id) {
  await updateDoc(doc(db, "rh_anticipos", id), {
    status: "APROBADO", aprobadoPor: Sesion.alias, aprobadoEn: serverTimestamp()
  }).catch(e => window.toast?.("Error: " + e.message, "error"));
  window.toast?.("Anticipo aprobado", "success");
}
async function _rechazarAnticipo(id) {
  const motivo = await window.promptModal({ title: "Rechazar anticipo", label: "Motivo del rechazo", placeholder: "Motivo…" });
  if (motivo === null) return;
  if (!motivo.trim()) { window.toast?.("Ingresa un motivo", "warning"); return; }
  await updateDoc(doc(db, "rh_anticipos", id), {
    status: "RECHAZADO", rechazadoPor: Sesion.alias, motivoRechazo: motivo.trim()
  }).catch(e => window.toast?.("Error: " + e.message, "error"));
  window.toast?.("Anticipo rechazado", "success");
}
async function _descontarAnticipo(id) {
  if (!await window.modal({ title: "Descontar de nómina", message: "¿Marcar este anticipo como descontado de nómina?", confirmLabel: "Confirmar" })) return;
  await updateDoc(doc(db, "rh_anticipos", id), {
    status: "DESCONTADO", descontadoPor: Sesion.alias, descontadoEn: serverTimestamp()
  }).catch(e => window.toast?.("Error: " + e.message, "error"));
  window.toast?.("Marcado como descontado", "success");
}

async function _pagarAdeudo(id) {
  if (!await window.modal({ title: "Marcar como pagado", message: "¿Confirmar que el ingeniero liquidó este adeudo de inventario?", confirmLabel: "Sí, pagado" })) return;
  await updateDoc(doc(db, "rh_anticipos", id), {
    status: "PAGADO", pagadoPor: Sesion.alias, pagadoEn: serverTimestamp()
  }).catch(e => window.toast?.("Error: " + e.message, "error"));
  window.toast?.("Adeudo marcado como pagado", "success");
}

// ══════════════════════════════════════════════════════════════
// NÓMINA SEMANAL
// Cálculo: salario_semanal − anticipos_descontados_semana
//          − (ausencias × valor_día)
// ══════════════════════════════════════════════════════════════
function _montarNomina() {
  if (!_puedeAprobar()) {
    document.getElementById("rh-content").innerHTML =
      `<div style="padding:32px;text-align:center;color:var(--text-sec)">Solo gerentes y administradores.</div>`;
    return;
  }
  const hoy    = new Date();
  // Lunes de la semana actual
  const lunes  = new Date(hoy); lunes.setDate(hoy.getDate() - ((hoy.getDay()+6)%7)); lunes.setHours(0,0,0,0);
  const domingo= new Date(lunes); domingo.setDate(lunes.getDate()+6); domingo.setHours(23,59,59,999);
  const semanaLabel = `${lunes.toLocaleDateString("es-MX",{day:"numeric",month:"short"})} – ${domingo.toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"})}`;

  const fmtIso = d => d.toISOString().slice(0,10);

  document.getElementById("rh-content").innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <span style="font-size:11px;color:var(--text-sec)">Semana:</span>
      <input type="date" class="sel-sm" id="nom-desde" value="${fmtIso(lunes)}">
      <span style="font-size:11px;color:var(--text-sec)">–</span>
      <input type="date" class="sel-sm" id="nom-hasta" value="${fmtIso(domingo)}">
      <button class="btn-primary" id="nom-calcular">Calcular nómina</button>
      <button id="nom-xlsx" style="padding:7px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">⬇️ Excel</button>
    </div>
    <div id="nom-semana-label" style="font-size:12px;color:var(--text-sec);margin-bottom:16px">
      Semana: ${semanaLabel}
    </div>

    <div style="overflow-x:auto">
      <table class="data-table" id="nom-table">
        <thead><tr>
          <th>INGENIERO</th>
          <th style="text-align:right">SALARIO SEMANAL</th>
          <th style="text-align:right">DÍAS PRESENTES</th>
          <th style="text-align:right">AUSENCIAS</th>
          <th style="text-align:right">DESC. AUSENCIAS</th>
          <th style="text-align:right">DESC. ANTICIPOS</th>
          <th style="text-align:right">ADEUDOS INV.</th>
          <th style="text-align:right">NETO A PAGAR</th>
          <th>ACCIÓN</th>
        </tr></thead>
        <tbody id="nom-body">
          <tr><td colspan="8" style="padding:32px;text-align:center;color:var(--text-sec)">
            Presiona "Calcular nómina" para generar el resumen</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Modal editar salario -->
    <div class="modal-overlay hidden" id="nom-sal-modal">
      <div class="modal-box" style="max-width:380px">
        <div class="modal-hdr">
          <span class="modal-title" id="nom-sal-title">Salario semanal</span>
          <button class="modal-close" id="nom-sal-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <p style="font-size:12px;color:var(--text-sec);margin:0">
            El salario semanal se guarda en el perfil del usuario y se usa para cálculos futuros.
          </p>
          <div class="form-group">
            <label class="form-label">Salario semanal (MXN)</label>
            <input class="form-input" type="number" id="nom-sal-val" min="0" step="50" placeholder="0.00">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="nom-sal-cancel">Cancelar</button>
          <button class="btn-primary" id="nom-sal-ok">Guardar</button>
        </div>
      </div>
    </div>`;

  document.getElementById("nom-calcular")?.addEventListener("click", _calcularNomina);
  document.getElementById("nom-xlsx")?.addEventListener("click", _exportarNomina);
  document.getElementById("nom-sal-close")?.addEventListener("click", () =>
    document.getElementById("nom-sal-modal")?.classList.add("hidden"));
  document.getElementById("nom-sal-cancel")?.addEventListener("click", () =>
    document.getElementById("nom-sal-modal")?.classList.add("hidden"));
  document.getElementById("nom-sal-ok")?.addEventListener("click", _guardarSalario);

  document.getElementById("nom-desde")?.addEventListener("change", () => {
    const desde = document.getElementById("nom-desde")?.value;
    const hasta = document.getElementById("nom-hasta")?.value;
    if (desde && hasta) {
      const d1 = new Date(desde); const d2 = new Date(hasta);
      document.getElementById("nom-semana-label").textContent =
        `Semana: ${d1.toLocaleDateString("es-MX",{day:"numeric",month:"short"})} – ${d2.toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"})}`;
    }
  });

  // Calcular al montar
  _calcularNomina();
}

let _nominaData = [];

async function _calcularNomina() {
  const desde = document.getElementById("nom-desde")?.value;
  const hasta = document.getElementById("nom-hasta")?.value;
  if (!desde || !hasta) return;

  const [dy,dm,dd] = desde.split("-").map(Number);
  const [hy,hm,hd] = hasta.split("-").map(Number);
  const desdeTs = new Date(dy,dm-1,dd,0,0,0).getTime();
  const hastaTs = new Date(hy,hm-1,hd,23,59,59).getTime();
  const diasPeriodo = Math.round((hastaTs - desdeTs) / 86400000) + 1;

  const tbody = document.getElementById("nom-body");
  if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="padding:24px;text-align:center">Calculando…</td></tr>`;

  try {
    // 1. Asistencia del período
    const asiSnap = await getDocs(query(
      collection(db,"rh_asistencia"),
      where("fechaTs",">=",desdeTs), where("fechaTs","<=",hastaTs),
      orderBy("fechaTs","asc"), limit(2000)
    ));
    const asiRows = asiSnap.docs.map(d => d.data());

    // 2. Anticipos APROBADOS + adeudos de inventario activos (sin límite de período para adeudos)
    const antSnap = await getDocs(query(
      collection(db,"rh_anticipos"),
      where("_ts",">=",desdeTs), where("_ts","<=",hastaTs),
      where("status","in",["APROBADO","DESCONTADO"]),
      orderBy("_ts","asc"), limit(500)
    ));
    const antRows = antSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Adeudos de inventario ACTIVOS (todos, no solo del período — persisten semana a semana)
    const adeudoSnap = await getDocs(query(
      collection(db,"rh_anticipos"),
      where("tipo","==","ADEUDO_INVENTARIO"),
      where("status","==","ADEUDO"),
      limit(500)
    ));
    const adeudosActivos = adeudoSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Agrupar por usuario
    const porUid = {};
    for (const u of _usuarios) {
      porUid[u.uid] = {
        uid: u.uid, alias: u.alias || u.uid,
        salarioSemanal: u.salarioSemanal || 0,
        asistencias: [], anticipos: [], adeudos: []
      };
    }
    asiRows.forEach(r => { if (porUid[r.uid]) porUid[r.uid].asistencias.push(r); });
    antRows.forEach(r => { if (porUid[r.uid]) porUid[r.uid].anticipos.push(r); });
    adeudosActivos.forEach(r => { if (porUid[r.uid]) porUid[r.uid].adeudos.push(r); });

    _nominaData = Object.values(porUid).map(u => {
      const presentes      = u.asistencias.filter(a => ["PRESENTE","TARDANZA"].includes(a.status)).length;
      const ausencias      = u.asistencias.filter(a => a.status === "AUSENTE").length;
      const salario        = u.salarioSemanal;
      const valorDia       = diasPeriodo > 0 ? salario / diasPeriodo : 0;
      const descAus        = ausencias * valorDia;
      const descAnt        = u.anticipos.reduce((s,a) => s + (a.monto||0), 0);
      // Adeudos: saldo pendiente total (montoOriginal - montoAbonado)
      const saldoAdeudos   = u.adeudos.reduce((s,a) => {
        const original = a.montoOriginal ?? a.monto ?? 0;
        const abonado  = a.montoAbonado ?? 0;
        return s + Math.max(0, original - abonado);
      }, 0);
      // El abono de esta semana lo ingresa el admin en la UI — no se descuenta automáticamente
      const abonoSemana    = u.adeudos.reduce((s,a) => s + (a._abonoSemana || 0), 0);
      const descAdeudo     = abonoSemana; // solo el abono confirmado por el admin
      const neto           = Math.max(0, salario - descAus - descAnt - descAdeudo);
      return { ...u, presentes, ausencias, salario, valorDia, descAus, descAnt, descAdeudo, saldoAdeudos, neto };
    });

    _renderNomina(_nominaData);
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding:16px;text-align:center;color:#DC2626">${esc(e.message)}</td></tr>`;
    console.error("[Nomina]", e);
  }
}

function _renderNomina(rows) {
  const tbody = document.getElementById("nom-body");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:32px;text-align:center;color:var(--text-sec)">Sin empleados</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const sinSalario = r.salario <= 0;
    // Celda de adeudos: muestra saldo + input de abono
    const tieneAdeudos = r.saldoAdeudos > 0;
    // Mínimo de abono = 20% del monto original del adeudo más grande activo
    const montoOriginalTotal = r.adeudos.reduce((s,a) => s + (a.montoOriginal ?? a.monto ?? 0), 0);
    const minAbono = Math.ceil(montoOriginalTotal * 0.20 * 100) / 100;
    const adeudoCell = tieneAdeudos
      ? `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
           <div>
             <span style="color:#DC2626;font-weight:700">${fmtMXN(r.saldoAdeudos)}</span>
             <span style="font-size:9px;background:#FEE2E2;color:#991B1B;border-radius:4px;
               padding:1px 5px;margin-left:5px">⚠️ saldo</span>
           </div>
           <div style="display:flex;align-items:center;gap:4px">
             <span style="font-size:10px;color:var(--text-sec)">Abono:</span>
             <input type="number" min="${minAbono}" step="0.01"
               placeholder="mín ${fmtMXN(minAbono)}"
               data-uid="${r.uid}" data-min="${minAbono}" data-saldo="${r.saldoAdeudos}"
               class="nom-abono-inp"
               style="width:100px;padding:3px 6px;border:1px solid #FCA5A5;border-radius:5px;
                 font-size:11px;text-align:right;background:var(--surface);color:var(--text-primary)">
           </div>
           <div style="font-size:9px;color:#9CA3AF">Mín 20% del total: ${fmtMXN(minAbono)}</div>
         </div>
         <button class="btn-sm" data-uid="${r.uid}" data-alias="${esc(r.alias)}" data-act="nuevo-adeudo"
           style="margin-top:4px;font-size:9px;background:#FEE2E2;color:#991B1B;border:1px solid #FCA5A5">+ Nuevo adeudo</button>`
      : `<span style="color:var(--text-sec)">—</span>
         <button class="btn-sm" data-uid="${r.uid}" data-alias="${esc(r.alias)}" data-act="nuevo-adeudo"
           style="margin-left:4px;font-size:9px;background:#FEF3C7;color:#92400E;border:1px solid #FCD34D">+ Adeudo</button>`;
    return `<tr style="${sinSalario ? "opacity:.55" : ""}">
      <td style="font-weight:700">${esc(r.alias)}</td>
      <td style="text-align:right">
        ${fmtMXN(r.salario)}
        <button class="btn-sm btn-outline" data-uid="${r.uid}" data-alias="${esc(r.alias)}"
          data-sal="${r.salario}" data-act="editar-sal"
          style="margin-left:6px;font-size:10px">✏️</button>
      </td>
      <td style="text-align:right">${r.presentes}</td>
      <td style="text-align:right;color:${r.ausencias>0?"#DC2626":"inherit"}">${r.ausencias}</td>
      <td style="text-align:right;color:#DC2626">${fmtMXN(r.descAus)}</td>
      <td style="text-align:right;color:#D97706">${fmtMXN(r.descAnt)}</td>
      <td style="text-align:right">${adeudoCell}</td>
      <td style="text-align:right;font-weight:800;font-size:15px;color:${r.neto>0?"var(--primary)":"#DC2626"}"
          class="nom-neto-cell" data-uid="${r.uid}">${fmtMXN(r.neto)}</td>
      <td>
        <button class="btn-sm btn-green" data-uid="${r.uid}" data-act="pagar"
          ${r.salario <= 0 ? "disabled style='opacity:.4;cursor:not-allowed'" : ""}>✓ Registrar pago</button>
      </td>
    </tr>`;
  }).join("");

  // Listener inputs de abono: recalcula neto en tiempo real
  tbody.querySelectorAll(".nom-abono-inp").forEach(inp => {
    inp.addEventListener("input", () => {
      const uid    = inp.dataset.uid;
      const row    = _nominaData.find(r => r.uid === uid);
      if (!row) return;
      const abono  = parseFloat(inp.value) || 0;
      // Guardar el abono provisional en el dato de fila
      row.adeudos.forEach(a => { a._abonoSemana = 0; });
      // Distribuir abono entre adeudos activos (de mayor a menor antigüedad)
      let restante = abono;
      for (const a of row.adeudos) {
        const saldo = Math.max(0, (a.montoOriginal ?? a.monto ?? 0) - (a.montoAbonado ?? 0));
        const aplicar = Math.min(saldo, restante);
        a._abonoSemana = aplicar;
        restante -= aplicar;
        if (restante <= 0) break;
      }
      row.descAdeudo = row.adeudos.reduce((s,a) => s + (a._abonoSemana||0), 0);
      row.neto = Math.max(0, row.salario - row.descAus - row.descAnt - row.descAdeudo);
      const netoCell = tbody.querySelector(`.nom-neto-cell[data-uid="${uid}"]`);
      if (netoCell) {
        netoCell.textContent = fmtMXN(row.neto);
        netoCell.style.color = row.neto > 0 ? "var(--primary)" : "#DC2626";
      }
    });
  });

  tbody.querySelectorAll("[data-act='editar-sal']").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("nom-sal-title").textContent = `Salario semanal: ${btn.dataset.alias}`;
      document.getElementById("nom-sal-val").value = btn.dataset.sal || "0";
      document.getElementById("nom-sal-modal").dataset.uid = btn.dataset.uid;
      document.getElementById("nom-sal-modal")?.classList.remove("hidden");
    });
  });

  tbody.querySelectorAll("[data-act='nuevo-adeudo']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.uid;
      const alias = btn.dataset.alias;
      // Modal de captura usando el sistema de modales del ERP
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center";
      overlay.innerHTML = `
        <div style="background:var(--bg-card,#fff);border-radius:12px;padding:28px;width:380px;box-shadow:0 8px 32px rgba(0,0,0,.2)">
          <h3 style="margin:0 0 16px;font-size:16px">Registrar adeudo de inventario</h3>
          <p style="margin:0 0 16px;font-size:13px;color:var(--text-sec)">Ingeniero: <b>${alias}</b></p>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px">Monto del adeudo (MXN)</label>
          <input id="adeudo-monto" type="number" min="1" step="0.01" value="2500"
            style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--border,#ddd);border-radius:6px;font-size:14px;margin-bottom:14px">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px">Descripción / motivo</label>
          <textarea id="adeudo-motivo" rows="3"
            style="width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--border,#ddd);border-radius:6px;font-size:13px;margin-bottom:20px;resize:vertical">Productos faltantes de inventario</textarea>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button id="adeudo-cancel" class="btn-sm btn-outline" style="padding:8px 16px">Cancelar</button>
            <button id="adeudo-save" class="btn-sm btn-red" style="padding:8px 16px;background:#DC2626;color:#fff;border:none;border-radius:6px;cursor:pointer">Registrar adeudo</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      document.getElementById("adeudo-monto").focus();
      document.getElementById("adeudo-cancel").onclick = () => overlay.remove();
      document.getElementById("adeudo-save").onclick = async () => {
        const monto = parseFloat(document.getElementById("adeudo-monto").value || "0");
        const motivo = document.getElementById("adeudo-motivo").value.trim() || "Productos faltantes de inventario";
        if (!monto || monto <= 0) { window.toast?.("Ingresa un monto válido", "error"); return; }
        overlay.remove();
        try {
          await addDoc(collection(db, "rh_anticipos"), {
            uid, alias,
            tipo: "ADEUDO_INVENTARIO",
            monto,
            montoOriginal: monto,
            montoAbonado:  0,
            motivo,
            status: "ADEUDO",
            creadoPor: Sesion.alias,
            timestamp: Date.now(), _ts: Date.now()
          });
          window.toast?.(`Adeudo de ${fmtMXN(monto)} registrado para ${alias}`, "success");
          document.getElementById("nom-calcular")?.click();
        } catch(e) {
          window.toast?.("Error: " + e.message, "error");
        }
      };
    });
  });

  tbody.querySelectorAll("[data-act='pagar']").forEach(btn => {
    btn.addEventListener("click", async () => {
      const row = _nominaData.find(r => r.uid === btn.dataset.uid);
      if (!row || row.salario <= 0) return;

      // Validar abono si hay adeudos activos
      if (row.saldoAdeudos > 0) {
        const montoOriginalTotal = row.adeudos.reduce((s,a) => s + (a.montoOriginal ?? a.monto ?? 0), 0);
        const minAbono = Math.ceil(montoOriginalTotal * 0.20 * 100) / 100;
        const abonoIngresado = row.adeudos.reduce((s,a) => s + (a._abonoSemana||0), 0);
        if (abonoIngresado <= 0) {
          window.toast?.(`Ingresa el abono al adeudo (mín ${fmtMXN(minAbono)})`, "error");
          return;
        }
        if (abonoIngresado < minAbono - 0.01) {
          window.toast?.(`El abono mínimo es ${fmtMXN(minAbono)} (20% del total del adeudo)`, "error");
          return;
        }
      }

      const resumen = row.saldoAdeudos > 0
        ? `\n• Abono a adeudo: ${fmtMXN(row.descAdeudo)}\n• Saldo restante adeudo: ${fmtMXN(Math.max(0, row.saldoAdeudos - row.descAdeudo))}`
        : "";
      if (!await window.modal({
        title: "Registrar pago de nómina",
        message: `Confirmar pago para ${row.alias}:\n• Salario: ${fmtMXN(row.salario)}\n• Desc. ausencias: ${fmtMXN(row.descAus)}\n• Desc. anticipos: ${fmtMXN(row.descAnt)}${resumen}\n• NETO A PAGAR: ${fmtMXN(row.neto)}`,
        confirmLabel: "Registrar pago"
      })) return;

      try {
        const desde  = document.getElementById("nom-desde")?.value;
        const hasta  = document.getElementById("nom-hasta")?.value;
        const periodo = `${desde} al ${hasta}`;
        const ahora   = Date.now();

        await addDoc(collection(db,"rh_pagos_nomina"), {
          uid: row.uid, alias: row.alias,
          desde, hasta,
          salarioSemanal: row.salario,
          descAusencias:  row.descAus,
          descAnticipos:  row.descAnt,
          descAdeudos:    row.descAdeudo || 0,
          neto:           row.neto,
          pagadoPor:      Sesion.alias, _ts: ahora
        });

        await addDoc(collection(db,"rh_nomina"), {
          uid:                row.uid,
          alias:              row.alias,
          periodo,
          salarioBase:        row.salario,
          diasPresentes:      row.presentes,
          ausencias:          row.ausencias,
          deducciones:        row.descAus,
          descuentoAnticipos: row.descAnt,
          descuentoAdeudos:   row.descAdeudo || 0,
          netoPagado:         row.neto,
          status:             "PAGADO",
          pagadoPor:          Sesion.alias,
          pagoEn:             ahora,
          _ts:                ahora,
        });

        // Marcar anticipos del período como DESCONTADO
        for (const ant of row.anticipos.filter(a => a.status === "APROBADO")) {
          await updateDoc(doc(db,"rh_anticipos", ant.id), {
            status:"DESCONTADO", descontadoPor: Sesion.alias
          }).catch(() => {});
        }

        // Actualizar saldo de adeudos de inventario con el abono de esta semana
        for (const ade of row.adeudos.filter(a => a.status === "ADEUDO")) {
          const abono       = ade._abonoSemana || 0;
          if (abono <= 0) continue;
          const original    = ade.montoOriginal ?? ade.monto ?? 0;
          const yaAbonado   = ade.montoAbonado ?? 0;
          const nuevoAbonado = Math.min(original, yaAbonado + abono);
          const liquidado   = nuevoAbonado >= original - 0.01;
          const updateData  = {
            montoOriginal: original,
            montoAbonado:  nuevoAbonado,
            ultimoAbono:   abono,
            ultimoAbonoPor: Sesion.alias,
            ultimoAbonoEn: ahora,
          };
          if (liquidado) {
            updateData.status    = "PAGADO";
            updateData.pagadoPor = Sesion.alias;
            updateData.pagadoEn  = ahora;
            updateData.nota      = `Liquidado vía nómina ${periodo}`;
          }
          await updateDoc(doc(db,"rh_anticipos", ade.id), updateData).catch(() => {});
        }

        window.toast?.(`Pago registrado para ${row.alias}`, "success");
        _calcularNomina();
      } catch(e) { window.toast?.(e.message, "error"); }
    });
  });
}

async function _guardarSalario() {
  const uid = document.getElementById("nom-sal-modal")?.dataset.uid;
  const sal = parseFloat(document.getElementById("nom-sal-val")?.value || "0");
  if (!uid || sal < 0) return;

  const btn = document.getElementById("nom-sal-ok");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    await updateDoc(doc(db,"usuarios",uid), { salarioSemanal: sal });
    // Actualizar local
    const u = _usuarios.find(x => x.uid === uid);
    if (u) u.salarioSemanal = sal;
    window.toast?.("Salario actualizado","success");
    document.getElementById("nom-sal-modal")?.classList.add("hidden");
    _calcularNomina();
  } catch(e) { window.toast?.(e.message,"error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar"; }
}

function _exportarNomina() {
  if (!_nominaData.length) { window.toast?.("Calcula primero la nómina","warning"); return; }
  const desde = document.getElementById("nom-desde")?.value || "";
  const hasta  = document.getElementById("nom-hasta")?.value  || "";
  const h = ["Ingeniero","Salario semanal","Días presentes","Ausencias","Desc. ausencias","Desc. anticipos","Neto a pagar"];
  const d = _nominaData.map(r => [r.alias,r.salario,r.presentes,r.ausencias,r.descAus.toFixed(2),r.descAnt.toFixed(2),r.neto.toFixed(2)]);
  const ws = XLSX.utils.aoa_to_sheet([h, ...d]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Nómina");
  XLSX.writeFile(wb, `N10-nomina-${desde}-${hasta}.xlsx`);
  window.toast?.("Exportando Excel…","info");
}

// ══════════════════════════════════════════════════════════════
// EVALUACIÓN DE DESEMPEÑO
// Ciclo 360°: 5 criterios con calificación 1-5 + promedio
// Colecciones: rh_evaluaciones
// ══════════════════════════════════════════════════════════════
const CRITERIOS = [
  { id:"metas",      label:"🎯 Cumplimiento de metas de venta" },
  { id:"puntual",    label:"⏰ Puntualidad y asistencia"       },
  { id:"actitud",    label:"😊 Actitud y proactividad"         },
  { id:"equipo",     label:"🤝 Trabajo en equipo"              },
  { id:"conocim",    label:"🌱 Conocimiento técnico / producto" },
];

function _montarEvaluacion() {
  const puedeApr = _puedeAprobar();
  const content  = document.getElementById("rh-content");
  content.innerHTML = `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <select class="sel-sm" id="ev-filtro-uid">${_optUsuarios()}</select>
      ${puedeApr ? `<button class="btn-primary" id="ev-nueva-btn">+ Nueva evaluación</button>` : ""}
    </div>

    <table class="data-table">
      <thead><tr>
        <th>INGENIERO</th><th>PERÍODO</th>
        ${CRITERIOS.map(c => `<th title="${c.label}" style="text-align:center">${c.id.slice(0,5)}</th>`).join("")}
        <th style="text-align:center">PROM.</th><th>COMENTARIO</th><th>EVALUADOR</th><th>FECHA</th>
      </tr></thead>
      <tbody id="ev-body">
        <tr><td colspan="${7+CRITERIOS.length}" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
      </tbody>
    </table>

    <!-- Modal evaluación -->
    <div class="modal-overlay hidden" id="ev-modal">
      <div class="modal-box" style="max-width:520px">
        <div class="modal-hdr">
          <span class="modal-title">Nueva evaluación de desempeño</span>
          <button class="modal-close" id="ev-modal-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label class="form-label">Ingeniero</label>
              <select class="form-input" id="ev-uid">${_optUsuarios()}</select>
            </div>
            <div class="form-group">
              <label class="form-label">Período evaluado</label>
              <input class="form-input" type="text" id="ev-periodo" placeholder="Q2 2026 / Sem 1 2026">
            </div>
          </div>

          <div style="background:var(--surface2);border-radius:8px;padding:14px">
            <p style="font-size:12px;color:var(--text-sec);margin-bottom:12px">
              Califica del <b>1</b> (deficiente) al <b>5</b> (excelente) cada criterio:
            </p>
            ${CRITERIOS.map(c => `
              <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
                <label style="flex:1;font-size:13px">${c.label}</label>
                <div style="display:flex;gap:4px" id="stars-${c.id}">
                  ${[1,2,3,4,5].map(n =>
                    `<button type="button" class="ev-star" data-crit="${c.id}" data-val="${n}"
                      style="width:30px;height:30px;border-radius:50%;border:2px solid var(--border);background:var(--surface);
                        cursor:pointer;font-size:16px;line-height:1">⭐</button>`
                  ).join("")}
                </div>
                <span class="ev-star-val" id="val-${c.id}" style="width:16px;text-align:center;font-weight:700;color:var(--text-sec)">—</span>
              </div>`
            ).join("")}
          </div>

          <div class="form-group">
            <label class="form-label">Comentarios generales</label>
            <textarea class="form-input" id="ev-comentario" rows="3" placeholder="Fortalezas, áreas de mejora, objetivos próximo período…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="ev-cancel">Cancelar</button>
          <button class="btn-primary" id="ev-guardar">Guardar evaluación</button>
        </div>
      </div>
    </div>`;

  if (puedeApr) {
    document.getElementById("ev-nueva-btn")?.addEventListener("click", () => {
      // Reset estrellas
      CRITERIOS.forEach(c => {
        document.querySelectorAll(`[data-crit="${c.id}"]`).forEach(btn => btn.style.background = "var(--surface)");
        const valEl = document.getElementById(`val-${c.id}`);
        if (valEl) valEl.textContent = "—";
      });
      document.getElementById("ev-modal")?.classList.remove("hidden");
    });
  }
  document.getElementById("ev-modal-close")?.addEventListener("click", () =>
    document.getElementById("ev-modal")?.classList.add("hidden"));
  document.getElementById("ev-cancel")?.addEventListener("click", () =>
    document.getElementById("ev-modal")?.classList.add("hidden"));
  document.getElementById("ev-guardar")?.addEventListener("click", _guardarEvaluacion);
  document.getElementById("ev-filtro-uid")?.addEventListener("change", _escucharEvaluaciones);

  // Interacción estrellas
  document.getElementById("ev-modal")?.addEventListener("click", e => {
    const btn = e.target.closest(".ev-star");
    if (!btn) return;
    const { crit, val } = btn.dataset;
    const n = parseInt(val);
    document.querySelectorAll(`[data-crit="${crit}"]`).forEach((b, i) => {
      b.style.background = i < n ? "#FBBF24" : "var(--surface)";
    });
    const valEl = document.getElementById(`val-${crit}`);
    if (valEl) { valEl.textContent = n; valEl.style.color = "var(--text-primary)"; }
  });

  _escucharEvaluaciones();
}

function _escucharEvaluaciones() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const uid = document.getElementById("ev-filtro-uid")?.value;
  let q = query(collection(db,"rh_evaluaciones"), orderBy("_ts","desc"), limit(200));
  if (uid) q = query(collection(db,"rh_evaluaciones"), where("uid","==",uid), orderBy("_ts","desc"), limit(200));
  const unsub = onSnapshot(q, snap => {
    _renderEvaluaciones(snap.docs.map(d => ({ id:d.id, ...d.data() })));
  }, err => console.error("[RH-Eval]",err));
  _unsubs.push(unsub);
}

function _renderEvaluaciones(rows) {
  const tbody = document.getElementById("ev-body");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${7+CRITERIOS.length}" style="padding:24px;text-align:center;color:var(--text-sec)">Sin evaluaciones</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const califs = CRITERIOS.map(c => r.calificaciones?.[c.id] || 0);
    const prom   = califs.reduce((s,v)=>s+v,0)/CRITERIOS.length;
    const col    = prom>=4?"#16A34A":prom>=3?"#D97706":"#DC2626";
    const stars  = (n) => "⭐".repeat(Math.round(n)) || "—";
    return `<tr>
      <td style="font-weight:600">${esc(r.alias||"—")}</td>
      <td style="font-size:12px">${esc(r.periodo||"—")}</td>
      ${califs.map(v => `<td style="text-align:center;font-weight:600;color:${v>=4?"#16A34A":v>=3?"#D97706":"#DC2626"}">${v||"—"}</td>`).join("")}
      <td style="text-align:center;font-weight:800;font-size:16px;color:${col}">${prom.toFixed(1)}</td>
      <td style="font-size:12px;color:var(--text-sec);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.comentario||"—")}</td>
      <td style="font-size:11px;color:var(--text-sec)">${esc(r.evaluadoPor||"—")}</td>
      <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(r._ts)}</td>
    </tr>`;
  }).join("");
}

async function _guardarEvaluacion() {
  const uid      = document.getElementById("ev-uid")?.value;
  const periodo  = document.getElementById("ev-periodo")?.value.trim();
  const coment   = document.getElementById("ev-comentario")?.value.trim();
  if (!uid || !periodo) { window.toast?.("Selecciona ingeniero y período","error"); return; }

  const calificaciones = {};
  for (const c of CRITERIOS) {
    const val = parseInt(document.getElementById(`val-${c.id}`)?.textContent || "0");
    if (!val) { window.toast?.(`Califica el criterio: ${c.label}`,"warning"); return; }
    calificaciones[c.id] = val;
  }

  const usuario = _usuarios.find(u => u.uid === uid);
  const btn = document.getElementById("ev-guardar");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    await addDoc(collection(db,"rh_evaluaciones"), {
      uid, alias: usuario?.alias||uid, periodo,
      calificaciones, comentario: coment,
      evaluadoPor: Sesion.alias,
      timestamp: serverTimestamp(), _ts: Date.now()
    });
    window.toast?.("Evaluación guardada","success");
    document.getElementById("ev-modal")?.classList.add("hidden");
  } catch(e) { window.toast?.(e.message,"error"); }
  finally { btn.disabled=false; btn.textContent="Guardar evaluación"; }
}

// ══════════════════════════════════════════════════════════════
// RECLUTAMIENTO & ONBOARDING
// Vacantes → Candidatos → Pipeline → Checklist alta empleado
// Colecciones: rh_vacantes, rh_candidatos
// ══════════════════════════════════════════════════════════════
const PIPELINE = ["Postulado","Entrevista","Prueba técnica","Oferta enviada","Contratado","Rechazado"];
const PIPELINE_COL = {
  "Postulado":"badge-gray","Entrevista":"badge-blue","Prueba técnica":"badge-amber",
  "Oferta enviada":"badge-yellow","Contratado":"badge-green","Rechazado":"badge-red"
};
const CHECKLIST_ITEMS = [
  "Contrato firmado","Alta IMSS registrada","Credencial / INE entregada",
  "Comprobante domicilio","RFC y CURP en expediente","Cuenta bancaria registrada",
  "Celular de empresa asignado","Acceso al sistema creado","Ruta y zona asignada",
  "Inducción completada","Primer checkin de campo"
];

let _vacantes = [];

function _montarReclutamiento() {
  const puedeApr = _puedeAprobar();
  const content  = document.getElementById("rh-content");
  content.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <select class="sel-sm" id="rec-vista">
        <option value="vacantes">📋 Vacantes</option>
        <option value="candidatos">👤 Candidatos</option>
        <option value="onboarding">✅ Onboarding</option>
      </select>
      <div id="rec-acciones"></div>
    </div>
    <div id="rec-content"></div>`;

  document.getElementById("rec-vista")?.addEventListener("change", e => _activarVistaRec(e.target.value));
  _activarVistaRec("vacantes");
}

function _activarVistaRec(vista) {
  const puedeApr = _puedeAprobar();
  const accEl = document.getElementById("rec-acciones");
  if (accEl) {
    accEl.innerHTML = vista === "vacantes"
      ? (puedeApr ? `<button class="btn-primary" id="rec-nueva-vac">+ Nueva vacante</button>` : "")
      : vista === "candidatos"
      ? `<button class="btn-primary" id="rec-nuevo-cand">+ Agregar candidato</button>`
      : "";
  }
  if (vista === "vacantes")    _mostrarVacantes();
  if (vista === "candidatos")  _mostrarCandidatos();
  if (vista === "onboarding")  _mostrarOnboarding();
}

// ── Vacantes ───────────────────────────────────────────────────
function _mostrarVacantes() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const el = document.getElementById("rec-content");
  el.innerHTML = `
    <table class="data-table">
      <thead><tr><th>PUESTO</th><th>ZONA</th><th>SALARIO PROPUESTO</th><th>STATUS</th><th>CREADA</th><th>ACCIÓN</th></tr></thead>
      <tbody id="vac-list-body"><tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr></tbody>
    </table>

    <!-- Modal nueva vacante -->
    <div class="modal-overlay hidden" id="rec-vac-modal">
      <div class="modal-box" style="max-width:420px">
        <div class="modal-hdr">
          <span class="modal-title">Nueva vacante</span>
          <button class="modal-close" id="rec-vac-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">Puesto</label>
            <input class="form-input" type="text" id="rec-puesto" placeholder="Ingeniero agrónomo, Recuperador de cartera…">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label class="form-label">Zona</label>
              <input class="form-input" type="text" id="rec-zona-vac" placeholder="Norte, Sur…">
            </div>
            <div class="form-group">
              <label class="form-label">Salario semanal propuesto</label>
              <input class="form-input" type="number" id="rec-salario" min="0" step="50" placeholder="0.00">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Descripción / requisitos</label>
            <textarea class="form-input" id="rec-desc" rows="3" placeholder="Experiencia requerida, estudios, disponibilidad…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="rec-vac-cancel">Cancelar</button>
          <button class="btn-primary" id="rec-vac-guardar">Crear vacante</button>
        </div>
      </div>
    </div>`;

  document.getElementById("rec-nueva-vac")?.addEventListener("click", () =>
    document.getElementById("rec-vac-modal")?.classList.remove("hidden"));
  document.getElementById("rec-vac-close")?.addEventListener("click", () =>
    document.getElementById("rec-vac-modal")?.classList.add("hidden"));
  document.getElementById("rec-vac-cancel")?.addEventListener("click", () =>
    document.getElementById("rec-vac-modal")?.classList.add("hidden"));
  document.getElementById("rec-vac-guardar")?.addEventListener("click", _crearVacante);

  const unsub = onSnapshot(
    query(collection(db,"rh_vacantes"), orderBy("_ts","desc"), limit(100)),
    snap => {
      _vacantes = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      const tbody = document.getElementById("vac-list-body");
      if (!tbody) return;
      tbody.innerHTML = _vacantes.map(v => `<tr>
        <td style="font-weight:600">${esc(v.puesto||"—")}</td>
        <td>${esc(v.zona||"—")}</td>
        <td>${fmtMXN(v.salario)}/sem</td>
        <td><span class="badge ${v.status==="ABIERTA"?"badge-green":v.status==="CUBIERTA"?"badge-purple":"badge-gray"}">${esc(v.status||"ABIERTA")}</span></td>
        <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(v._ts)}</td>
        <td>
          ${_puedeAprobar() ? `<button class="btn-sm btn-outline" data-id="${v.id}" data-act="cerrar">✓ Cubrir</button>` : ""}
        </td>
      </tr>`).join("") || `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Sin vacantes</td></tr>`;

      tbody.querySelectorAll("[data-act='cerrar']").forEach(btn => {
        btn.addEventListener("click", async () => {
          await updateDoc(doc(db,"rh_vacantes",btn.dataset.id), { status:"CUBIERTA" }).catch(e => window.toast?.(e.message,"error"));
          window.toast?.("Vacante marcada como cubierta","success");
        });
      });
    }, err => console.error("[RH-Vacantes]",err)
  );
  _unsubs.push(unsub);
}

async function _crearVacante() {
  const puesto  = document.getElementById("rec-puesto")?.value.trim();
  const zona    = document.getElementById("rec-zona-vac")?.value.trim();
  const salario = parseFloat(document.getElementById("rec-salario")?.value||"0");
  const desc    = document.getElementById("rec-desc")?.value.trim();
  if (!puesto) { window.toast?.("Ingresa el nombre del puesto","error"); return; }
  const btn = document.getElementById("rec-vac-guardar");
  btn.disabled=true; btn.textContent="Creando…";
  try {
    await addDoc(collection(db,"rh_vacantes"), {
      puesto, zona, salario, descripcion: desc,
      status:"ABIERTA", creadoPor: Sesion.alias,
      timestamp: serverTimestamp(), _ts: Date.now()
    });
    window.toast?.("Vacante creada","success");
    document.getElementById("rec-vac-modal")?.classList.add("hidden");
  } catch(e) { window.toast?.(e.message,"error"); }
  finally { btn.disabled=false; btn.textContent="Crear vacante"; }
}

// ── Candidatos ─────────────────────────────────────────────────
function _mostrarCandidatos() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const el = document.getElementById("rec-content");
  el.innerHTML = `
    <div style="margin-bottom:12px">
      <select class="sel-sm" id="cand-filtro-vac">
        <option value="">Todas las vacantes</option>
        ${_vacantes.map(v => `<option value="${v.id}">${esc(v.puesto)}</option>`).join("")}
      </select>
    </div>
    <table class="data-table">
      <thead><tr><th>CANDIDATO</th><th>VACANTE</th><th>ETAPA</th><th>TELÉFONO</th><th>NOTAS</th><th>ACCIÓN</th></tr></thead>
      <tbody id="cand-body"><tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr></tbody>
    </table>

    <!-- Modal candidato -->
    <div class="modal-overlay hidden" id="cand-modal">
      <div class="modal-box" style="max-width:420px">
        <div class="modal-hdr">
          <span class="modal-title">Agregar candidato</span>
          <button class="modal-close" id="cand-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="form-group">
            <label class="form-label">Nombre completo</label>
            <input class="form-input" type="text" id="cand-nombre" placeholder="Nombre del candidato">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group">
              <label class="form-label">Vacante</label>
              <select class="form-input" id="cand-vacante-id">
                <option value="">Sin vacante</option>
                ${_vacantes.filter(v=>v.status==="ABIERTA").map(v=>`<option value="${v.id}">${esc(v.puesto)}</option>`).join("")}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Teléfono</label>
              <input class="form-input" type="tel" id="cand-tel" placeholder="10 dígitos">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Notas</label>
            <textarea class="form-input" id="cand-notas" rows="2" placeholder="Fuente, referencias, experiencia…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="cand-cancel">Cancelar</button>
          <button class="btn-primary" id="cand-guardar">Agregar</button>
        </div>
      </div>
    </div>`;

  document.getElementById("rec-nuevo-cand")?.addEventListener("click", () =>
    document.getElementById("cand-modal")?.classList.remove("hidden"));
  document.getElementById("cand-close")?.addEventListener("click", () =>
    document.getElementById("cand-modal")?.classList.add("hidden"));
  document.getElementById("cand-cancel")?.addEventListener("click", () =>
    document.getElementById("cand-modal")?.classList.add("hidden"));
  document.getElementById("cand-guardar")?.addEventListener("click", _crearCandidato);
  document.getElementById("cand-filtro-vac")?.addEventListener("change", () => _escucharCandidatos());
  _escucharCandidatos();
}

function _escucharCandidatos() {
  _unsubs.filter((_, i) => i > 0).forEach(u => u?.());  // mantener solo primera unsub de vacantes
  const vacId = document.getElementById("cand-filtro-vac")?.value;
  let q = query(collection(db,"rh_candidatos"), orderBy("_ts","desc"), limit(200));
  if (vacId) q = query(collection(db,"rh_candidatos"), where("vacanteId","==",vacId), orderBy("_ts","desc"), limit(200));
  const unsub = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    const tbody = document.getElementById("cand-body");
    if (!tbody) return;
    tbody.innerHTML = rows.map(r => {
      const v = _vacantes.find(x => x.id===r.vacanteId);
      const opts = PIPELINE.map(p => `<option value="${p}" ${r.etapa===p?"selected":""}>${p}</option>`).join("");
      return `<tr>
        <td style="font-weight:600">${esc(r.nombre||"—")}</td>
        <td style="font-size:12px">${esc(v?.puesto||r.vacanteId||"—")}</td>
        <td><span class="badge ${PIPELINE_COL[r.etapa]||"badge-gray"}">${esc(r.etapa||"Postulado")}</span></td>
        <td style="font-size:12px">${esc(r.telefono||"—")}</td>
        <td style="font-size:12px;color:var(--text-sec);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.notas||"—")}</td>
        <td>
          <select class="sel-sm" style="font-size:11px" data-id="${r.id}" data-act="etapa">${opts}</select>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Sin candidatos</td></tr>`;

    tbody.querySelectorAll("[data-act='etapa']").forEach(sel => {
      sel.addEventListener("change", async () => {
        await updateDoc(doc(db,"rh_candidatos",sel.dataset.id), { etapa: sel.value })
          .catch(e => window.toast?.(e.message,"error"));
        if (sel.value === "Contratado") {
          window.toast?.("✅ Candidato contratado — recuerda crear el checklist de onboarding","success");
        }
      });
    });
  }, err => console.error("[RH-Candidatos]",err));
  _unsubs.push(unsub);
}

async function _crearCandidato() {
  const nombre   = document.getElementById("cand-nombre")?.value.trim();
  const vacanteId= document.getElementById("cand-vacante-id")?.value;
  const telefono = document.getElementById("cand-tel")?.value.trim();
  const notas    = document.getElementById("cand-notas")?.value.trim();
  if (!nombre) { window.toast?.("Ingresa el nombre del candidato","error"); return; }
  const btn = document.getElementById("cand-guardar");
  btn.disabled=true; btn.textContent="Guardando…";
  try {
    await addDoc(collection(db,"rh_candidatos"), {
      nombre, vacanteId, telefono, notas, etapa:"Postulado",
      registradoPor: Sesion.alias, timestamp: serverTimestamp(), _ts: Date.now()
    });
    window.toast?.("Candidato agregado","success");
    document.getElementById("cand-modal")?.classList.add("hidden");
  } catch(e) { window.toast?.(e.message,"error"); }
  finally { btn.disabled=false; btn.textContent="Agregar"; }
}

// ── Onboarding ─────────────────────────────────────────────────
function _mostrarOnboarding() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const el = document.getElementById("rec-content");
  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:16px">
      <select class="sel-sm" id="ob-uid">${_optUsuarios()}</select>
      <button class="btn-primary" id="ob-crear-btn">+ Nuevo checklist</button>
    </div>
    <div id="ob-list"></div>`;

  document.getElementById("ob-uid")?.addEventListener("change", _escucharOnboarding);
  document.getElementById("ob-crear-btn")?.addEventListener("click", _crearOnboarding);
  _escucharOnboarding();
}

function _escucharOnboarding() {
  _unsubs.forEach(u => u?.()); _unsubs = [];
  const uid = document.getElementById("ob-uid")?.value;
  let q = query(collection(db,"rh_onboarding"), orderBy("_ts","desc"), limit(50));
  if (uid) q = query(collection(db,"rh_onboarding"), where("uid","==",uid), orderBy("_ts","desc"), limit(50));

  const unsub = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    const el   = document.getElementById("ob-list");
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = `<p style="color:var(--text-sec);padding:24px;text-align:center">Sin checklists de onboarding</p>`;
      return;
    }
    el.innerHTML = rows.map(r => {
      const items = r.items || CHECKLIST_ITEMS.map(t => ({ texto:t, completado:false }));
      const done  = items.filter(i=>i.completado).length;
      const pct   = Math.round(done/items.length*100);
      const col   = pct===100?"#16A34A":pct>=50?"#D97706":"#DC2626";
      const itemsHtml = items.map((it,idx) => `
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:5px 0;border-bottom:1px solid var(--border)">
          <input type="checkbox" ${it.completado?"checked":""} data-doc="${r.id}" data-idx="${idx}">
          <span style="font-size:13px;${it.completado?"text-decoration:line-through;color:var(--text-sec)":""}">${esc(it.texto)}</span>
        </label>`).join("");
      return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <div>
              <span style="font-weight:700;font-size:14px">${esc(r.alias||r.uid)}</span>
              <span style="font-size:11px;color:var(--text-sec);margin-left:8px">Alta: ${fmtFecha(r._ts)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="background:var(--surface2);border-radius:4px;height:8px;width:100px">
                <div style="background:${col};height:100%;width:${pct}%;border-radius:4px"></div>
              </div>
              <span style="font-weight:700;color:${col}">${pct}%</span>
            </div>
          </div>
          <div>${itemsHtml}</div>
        </div>`;
    }).join("");

    // Checkboxes
    el.querySelectorAll("[data-doc][data-idx]").forEach(cb => {
      cb.addEventListener("change", async () => {
        const { doc: docId, idx } = cb.dataset;
        const row = rows.find(r => r.id===docId);
        if (!row) return;
        const items = [...(row.items || CHECKLIST_ITEMS.map(t=>({ texto:t, completado:false })))];
        items[parseInt(idx)].completado = cb.checked;
        await updateDoc(doc(db,"rh_onboarding",docId), { items }).catch(e => window.toast?.(e.message,"error"));
      });
    });
  }, err => console.error("[RH-Onboarding]",err));
  _unsubs.push(unsub);
}

async function _crearOnboarding() {
  const uid = document.getElementById("ob-uid")?.value;
  if (!uid) { window.toast?.("Selecciona el empleado","error"); return; }
  const ya = _vacantes; // reuse check
  const usuario = _usuarios.find(u => u.uid===uid);
  try {
    await addDoc(collection(db,"rh_onboarding"), {
      uid, alias: usuario?.alias||uid,
      items: CHECKLIST_ITEMS.map(t => ({ texto:t, completado:false })),
      creadoPor: Sesion.alias, timestamp: serverTimestamp(), _ts: Date.now()
    });
    window.toast?.("Checklist de onboarding creado","success");
  } catch(e) { window.toast?.(e.message,"error"); }
}
