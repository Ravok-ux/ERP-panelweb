// asistencia.js — Control de Asistencia y Horarios (GERENTE / MESA_CONTROL)
import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { norm } from "./app.js";
import {
  collection, query, where, orderBy, onSnapshot, doc,
  setDoc, getDoc, getDocs, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _unsub    = null;
let _container = null;

export function mount(container) {
  _container = container;
  _container.innerHTML = _html();
  _bindEvents();
  _cargar();
}

export function destroy() {
  if (_unsub) { _unsub(); _unsub = null; }
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function _html() {
  return `
<div class="asi-wrap">
  <div class="asi-header">
    <h2>🕐 Control de Asistencia</h2>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
      <input id="asi-fecha-ini" type="date" style="${estiloInput}" />
      <input id="asi-fecha-fin" type="date" style="${estiloInput}" />
      <input id="asi-alias-fil" type="text" placeholder="Filtrar por alias…" style="${estiloInput};width:140px" />
      <button id="asi-btn-buscar" style="background:#2563EB;color:#fff;border:none;border-radius:7px;padding:.4rem 1rem;font-weight:700;cursor:pointer">Buscar</button>
    </div>
  </div>

  <div id="asi-tabs" style="display:flex;gap:.4rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:.75rem">
    <button class="asi-tab asi-tab-active" data-tab="asistencia">📋 Asistencia</button>
    <button class="asi-tab" data-tab="horarios">⚙️ Horarios</button>
  </div>

  <div id="tab-asistencia">
    <div id="asi-resumen" style="font-size:.85rem;color:var(--muted);margin-bottom:.75rem"></div>
    <div style="overflow-x:auto">
      <table class="asi-tabla">
        <thead>
          <tr>
            <th>Empleado</th><th>Fecha</th><th>Entrada</th><th>Salida</th>
            <th>Duración</th><th>Retardo</th><th>Status</th>
          </tr>
        </thead>
        <tbody id="asi-tbody"></tbody>
      </table>
      <p id="asi-empty" style="display:none;text-align:center;color:var(--muted);padding:2rem">Sin registros.</p>
    </div>
  </div>

  <div id="tab-horarios" style="display:none">
    <div class="asi-hor-panel">
      <div class="asi-hor-form">
        <h3>Configurar horario</h3>
        <label class="asi-label">Empleado</label>
        <select id="hor-alias" style="${estiloInput};width:100%;box-sizing:border-box;margin-bottom:.75rem">
          <option value="">— Seleccionar empleado —</option>
        </select>
        <label class="asi-label">Hora entrada esperada</label>
        <input id="hor-entrada" type="time" value="08:00" style="${estiloInput};margin-bottom:.75rem" />
        <label class="asi-label">Hora salida esperada</label>
        <input id="hor-salida" type="time" value="18:00" style="${estiloInput};margin-bottom:.75rem" />
        <label class="asi-label">Tolerancia retardo (minutos)</label>
        <input id="hor-tolerancia" type="number" value="15" min="0" style="${estiloInput};margin-bottom:1rem" />
        <button id="hor-btn-guardar" style="background:#7C3AED;color:#fff;border:none;border-radius:7px;padding:.5rem 1.2rem;font-weight:700;cursor:pointer">Guardar horario</button>
      </div>
      <div class="asi-hor-lista">
        <h3>Horarios configurados</h3>
        <div id="hor-lista-content"><p style="color:var(--muted)">Cargando…</p></div>
      </div>
    </div>
  </div>
</div>

<style>
.asi-wrap { padding:1rem; }
.asi-header { display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem; }
.asi-tab { background:none;border:1px solid var(--border);border-radius:6px;padding:.4rem .8rem;cursor:pointer;font-size:.85rem;color:var(--text-primary); }
.asi-tab:hover { background:var(--surface-2); }
.asi-tab-active { background:#2563EB;color:#fff;border-color:#2563EB;font-weight:700; }
.asi-tabla { width:100%;border-collapse:collapse;font-size:.88rem; }
.asi-tabla th { background:var(--surface-2);padding:.6rem .8rem;text-align:left;font-weight:600;border-bottom:2px solid var(--border);white-space:nowrap; }
.asi-tabla td { padding:.55rem .8rem;border-bottom:1px solid var(--border); }
.asi-tabla tr:hover td { background:var(--surface-2); }
.asi-badge-ok  { background:#D1FAE5;color:#065F46;border-radius:4px;padding:.15rem .4rem;font-size:.75rem;font-weight:700; }
.asi-badge-ret { background:#FEF3C7;color:#92400E;border-radius:4px;padding:.15rem .4rem;font-size:.75rem;font-weight:700; }
.asi-badge-aus { background:#FEE2E2;color:#991B1B;border-radius:4px;padding:.15rem .4rem;font-size:.75rem;font-weight:700; }
.asi-label { display:block;font-size:.82rem;font-weight:700;margin-bottom:.3rem; }
.asi-hor-panel { display:grid;grid-template-columns:350px 1fr;gap:1rem; }
@media(max-width:700px) { .asi-hor-panel { grid-template-columns:1fr; } }
.asi-hor-form, .asi-hor-lista { background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:1.25rem; }
.asi-hor-form h3, .asi-hor-lista h3 { margin:0 0 1rem;font-size:1rem; }
.hor-item { display:flex;justify-content:space-between;align-items:center;padding:.6rem 0;border-bottom:1px solid var(--border);font-size:.88rem; }
.hor-item:last-child { border-bottom:none; }
</style>`;
}

const estiloInput = "padding:.4rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);font-size:.88rem";

// ─── Eventos ─────────────────────────────────────────────────────────────────

function _bindEvents() {
  // Fecha default: últimos 7 días
  const hoy = new Date();
  const hace7 = new Date(hoy); hace7.setDate(hace7.getDate() - 7);
  _container.querySelector("#asi-fecha-ini").value = hace7.toISOString().slice(0,10);
  _container.querySelector("#asi-fecha-fin").value = hoy.toISOString().slice(0,10);

  _container.querySelector("#asi-btn-buscar").addEventListener("click", _cargar);
  _container.querySelector("#hor-btn-guardar").addEventListener("click", _guardarHorario);

  // Tabs
  _container.querySelectorAll(".asi-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      _container.querySelectorAll(".asi-tab").forEach(b => b.classList.toggle("asi-tab-active", b === btn));
      _container.querySelector("#tab-asistencia").style.display = btn.dataset.tab === "asistencia" ? "block" : "none";
      _container.querySelector("#tab-horarios").style.display   = btn.dataset.tab === "horarios"   ? "block" : "none";
      if (btn.dataset.tab === "horarios") { _cargarEmpleadosSelect(); _cargarHorarios(); }
    });
  });
}

// ─── Asistencia ───────────────────────────────────────────────────────────────

let _lastHorarios = {};

async function _cargar() {
  if (_unsub) { _unsub(); _unsub = null; }

  const ini   = new Date(_container.querySelector("#asi-fecha-ini").value).getTime();
  const fin   = new Date(_container.querySelector("#asi-fecha-fin").value).getTime() + 86_400_000;
  const alias = _container.querySelector("#asi-alias-fil").value.trim().toLowerCase();

  // Cargar horarios para calcular retardos
  const horSnap = await getDocs(collection(db, "horarios_empleado"));
  horSnap.docs.forEach(d => { _lastHorarios[d.id] = d.data(); });

  let q = query(collection(db, "asistencias"), where("_ts", ">=", ini), where("_ts", "<=", fin), orderBy("_ts", "desc"), limit(300));
  _unsub = onSnapshot(q, snap => {
    let docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (alias) docs = docs.filter(d => norm(d.alias || "").includes(norm(alias)));
    _renderTabla(docs);
  });
}

function _hhmm(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

function _renderTabla(docs) {
  const tbody  = _container?.querySelector("#asi-tbody");
  const empty  = _container?.querySelector("#asi-empty");
  const resumen = _container?.querySelector("#asi-resumen");
  if (!tbody) return;

  if (docs.length === 0) { tbody.innerHTML = ""; empty.style.display = "block"; resumen.textContent = "Sin registros"; return; }
  empty.style.display = "none";

  const puntual  = docs.filter(d => _statusAsistencia(d) === "PUNTUAL").length;
  const retardo  = docs.filter(d => _statusAsistencia(d) === "RETARDO").length;
  const ausente  = docs.filter(d => _statusAsistencia(d) === "SIN_SALIDA").length;
  resumen.textContent = `${docs.length} registros · ${puntual} puntuales · ${retardo} con retardo · ${ausente} sin cierre`;

  tbody.innerHTML = docs.map(d => {
    const horario = _lastHorarios[d.alias] || null;
    const dur     = d.duracionMinutos ? `${Math.floor(d.duracionMinutos/60)}h ${d.duracionMinutos%60}m` : "—";
    const status  = _statusAsistencia(d, horario);
    const retMinutos = _retardoMin(d, horario);
    const retTxt  = retMinutos > 0 ? `${retMinutos} min` : "—";
    const { cls, lbl } = status === "PUNTUAL" ? { cls:"asi-badge-ok", lbl:"✅ Puntual" }
      : status === "RETARDO" ? { cls:"asi-badge-ret", lbl:`⏰ Retardo` }
      : { cls:"asi-badge-aus", lbl:"⚠️ Sin cierre" };
    return `<tr>
      <td style="font-weight:600">${d.alias}</td>
      <td style="white-space:nowrap;font-size:.82rem">${d.fecha || "—"}</td>
      <td>${_hhmm(d.checkInTs)}</td>
      <td>${_hhmm(d.checkOutTs || 0)}</td>
      <td>${dur}</td>
      <td style="color:${retMinutos > 0 ? '#D97706' : 'var(--muted)'}">${retTxt}</td>
      <td><span class="${cls}">${lbl}</span></td>
    </tr>`;
  }).join("");
}

function _statusAsistencia(d, horario) {
  if (!d.checkOutTs || d.checkOutTs === 0) return "SIN_SALIDA";
  if (horario && d.checkInTs) {
    const retardo = _retardoMin(d, horario);
    if (retardo > (horario.toleranciaMin || 15)) return "RETARDO";
  }
  return "PUNTUAL";
}

function _retardoMin(d, horario) {
  if (!horario || !d.checkInTs || !d.fecha) return 0;
  const [hh, mm] = (horario.horaEntrada || "08:00").split(":").map(Number);
  const esperado  = new Date(d.fecha + "T" + (horario.horaEntrada || "08:00") + ":00").getTime();
  const real      = d.checkInTs;
  return Math.max(0, Math.floor((real - esperado) / 60000));
}

// ─── Horarios ─────────────────────────────────────────────────────────────────

async function _cargarEmpleadosSelect() {
  const sel = _container?.querySelector("#hor-alias");
  if (!sel || sel.options.length > 1) return; // ya poblado
  try {
    const snap = await getDocs(query(collection(db, "usuarios"), where("activo", "==", true)));
    const EXCLUIR = ["SUPER_ADMIN"];
    const empleados = snap.docs
      .filter(d => !EXCLUIR.includes(d.data().rol))
      .map(d => d.data().alias)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    empleados.forEach(alias => {
      const opt = document.createElement("option");
      opt.value = alias;
      opt.textContent = alias;
      sel.appendChild(opt);
    });
  } catch(e) { console.warn("[Asistencia] No se pudieron cargar empleados:", e); }
}

async function _cargarHorarios() {
  const snap = await getDocs(collection(db, "horarios_empleado"));
  const div  = _container?.querySelector("#hor-lista-content");
  if (!div) return;
  if (snap.empty) { div.innerHTML = '<p style="color:var(--muted)">Sin horarios configurados.</p>'; return; }
  div.innerHTML = snap.docs.map(d => {
    const h = d.data();
    return `<div class="hor-item">
      <div>
        <strong>${d.id}</strong><br>
        <span style="font-size:.8rem;color:var(--muted)">${h.horaEntrada || "—"} → ${h.horaSalida || "—"} · Tolerancia ${h.toleranciaMin || 15} min</span>
      </div>
      <button class="hor-del" data-alias="${d.id}"
        style="background:none;border:1px solid #DC2626;color:#DC2626;border-radius:5px;padding:.2rem .5rem;cursor:pointer;font-size:.8rem">Borrar</button>
    </div>`;
  }).join("");

  div.querySelectorAll(".hor-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      const ok = window.modal
        ? await window.modal({ title: "Eliminar horario", message: `¿Eliminar horario de ${btn.dataset.alias}?`, danger: true, confirmLabel: "Eliminar" })
        : confirm(`¿Eliminar horario de ${btn.dataset.alias}?`);
      if (!ok) return;
      const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      await deleteDoc(doc(db, "horarios_empleado", btn.dataset.alias));
      _cargarHorarios();
    });
  });
}

async function _guardarHorario() {
  const alias      = _container.querySelector("#hor-alias").value.trim();
  const entrada    = _container.querySelector("#hor-entrada").value;
  const salida     = _container.querySelector("#hor-salida").value;
  const tolerancia = parseInt(_container.querySelector("#hor-tolerancia").value) || 15;
  if (!alias) { window.toast?.("Ingresa el alias del empleado.", "warn"); return; }

  await setDoc(doc(db, "horarios_empleado", alias), {
    alias, horaEntrada: entrada, horaSalida: salida,
    toleranciaMin: tolerancia,
    actualizadoPor: Sesion.uid,
    timestamp: serverTimestamp(),
  });
  _container.querySelector("#hor-alias").value = "";
  _cargarHorarios();
  _lastHorarios[alias] = { horaEntrada: entrada, horaSalida: salida, toleranciaMin: tolerancia };
  window.toast?.("Horario guardado correctamente.", "success");
}
