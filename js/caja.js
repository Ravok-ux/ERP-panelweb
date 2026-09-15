// caja.js — Arqueo/Corte de Caja (MESA_CONTROL / GERENTE — vista cajero web)
import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { norm } from "./app.js";
import {
  collection, query, orderBy, onSnapshot, doc, getDoc,
  where, getDocs, addDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _unsub = null;
let _container = null;

export function mount(container) {
  _container = container;
  _container.innerHTML = _html();
  _bindEvents();
  _cargarCortes();
}

export function destroy() {
  if (_unsub) { _unsub(); _unsub = null; }
  _filtroStatus = "";
  _filtroAlias  = "";
  _lastDocs     = [];
  _container    = null;
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function _html() {
  return `
<div class="caja-wrap">
  <div class="caja-header">
    <h2>🏦 Arqueo / Corte de Caja</h2>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap">
      <select id="caja-filtro-status" style="padding:.4rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);font-size:.9rem">
        <option value="">Todos</option>
        <option value="PENDIENTE">Pendientes</option>
        <option value="VALIDADO">Validados</option>
        <option value="DIFERENCIA">Con diferencia</option>
      </select>
      <select id="caja-filtro-alias"
        style="padding:.4rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);font-size:.9rem">
        <option value="">Todos</option>
      </select>
    </div>
  </div>

  <div id="caja-resumen" class="caja-resumen-bar"></div>

  <div style="overflow-x:auto">
    <table class="tabla-caja">
      <thead>
        <tr>
          <th>Vendedor</th>
          <th>Fecha / Turno</th>
          <th>Declarado</th>
          <th>Sistema</th>
          <th>Diferencia</th>
          <th>Efectivo</th>
          <th>Tarjeta</th>
          <th>Transferencia</th>
          <th>Status</th>
          <th>Acciones</th>
        </tr>
      </thead>
      <tbody id="caja-tbody"></tbody>
    </table>
    <p id="caja-empty" style="display:none;text-align:center;color:var(--muted);padding:2rem">Sin cortes con estos filtros.</p>
  </div>
</div>

<style>
.caja-wrap { padding:1rem; }
.caja-header { display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem; }
.caja-resumen-bar { font-size:.85rem;color:var(--muted);margin-bottom:.75rem; }
.tabla-caja { width:100%;border-collapse:collapse;font-size:.88rem; }
.tabla-caja th { background:var(--surface-2);padding:.6rem .8rem;text-align:left;font-weight:600;border-bottom:2px solid var(--border);white-space:nowrap; }
.tabla-caja td { padding:.55rem .8rem;border-bottom:1px solid var(--border);vertical-align:top; }
.tabla-caja tr:hover td { background:var(--surface-2); }
.monto-pos { color:#16A34A;font-weight:700; }
.monto-neg { color:#DC2626;font-weight:700; }
.badge-pend { background:#FEF3C7;color:#92400E;border-radius:4px;padding:.2rem .4rem;font-size:.75rem;font-weight:700; }
.badge-val  { background:#D1FAE5;color:#065F46;border-radius:4px;padding:.2rem .4rem;font-size:.75rem;font-weight:700; }
.badge-dif  { background:#FEE2E2;color:#991B1B;border-radius:4px;padding:.2rem .4rem;font-size:.75rem;font-weight:700; }
.btn-validar { background:#16A34A;color:#fff;border:none;border-radius:5px;padding:.3rem .6rem;cursor:pointer;font-size:.8rem; }
.btn-rechazar { background:#DC2626;color:#fff;border:none;border-radius:5px;padding:.3rem .6rem;cursor:pointer;font-size:.8rem;margin-left:.3rem; }
</style>`;
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

let _filtroStatus = "";
let _filtroAlias  = "";
let _lastDocs     = [];

function _bindEvents() {
  _container.querySelector("#caja-filtro-status").addEventListener("change", e => {
    _filtroStatus = e.target.value;
    _cargarCortes();
  });
  _container.querySelector("#caja-filtro-alias").addEventListener("change", e => {
    _filtroAlias = e.target.value;
    _render(_lastDocs);
  });
}

// ─── Firestore ────────────────────────────────────────────────────────────────

function _cargarCortes() {
  if (_unsub) { _unsub(); _unsub = null; }
  let q = query(collection(db, "cortes_caja"), orderBy("_ts", "desc"));
  if (_filtroStatus) {
    q = query(collection(db, "cortes_caja"), where("status", "==", _filtroStatus), orderBy("_ts", "desc"));
  }
  _unsub = onSnapshot(q, snap => {
    _lastDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _actualizarDropdownAlias(_lastDocs);
    _render(_lastDocs);
  });
}

function _fmt(n) {
  return `$${(n || 0).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
}

function _actualizarDropdownAlias(docs) {
  const sel = _container?.querySelector("#caja-filtro-alias");
  if (!sel) return;
  const prevVal = sel.value;
  const aliases = [...new Set(docs.map(d => d.alias).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  sel.innerHTML = '<option value="">Todos</option>' +
    aliases.map(a => `<option value="${a}">${a}</option>`).join("");
  if (prevVal && aliases.includes(prevVal)) sel.value = prevVal;
  else _filtroAlias = "";
}

function _render(docs) {
  const tbody  = _container?.querySelector("#caja-tbody");
  const empty  = _container?.querySelector("#caja-empty");
  const resumen = _container?.querySelector("#caja-resumen");
  if (!tbody) return;

  const filtrados = _filtroAlias
    ? docs.filter(d => d.alias === _filtroAlias)
    : docs;

  if (filtrados.length === 0) {
    tbody.innerHTML = "";
    empty.style.display = "block";
    resumen.textContent = "Sin cortes";
    return;
  }
  empty.style.display = "none";

  const totalDeclarado = filtrados.reduce((s, d) => s + (d.totalDeclarado || 0), 0);
  const totalSistema   = filtrados.reduce((s, d) => s + (d.totalSistema   || 0), 0);
  const difTotal       = totalDeclarado - totalSistema;
  resumen.innerHTML = `${filtrados.length} cortes · Declarado: <b>${_fmt(totalDeclarado)}</b> · Sistema: <b>${_fmt(totalSistema)}</b> · Diferencia: <b style="color:${difTotal < 0 ? '#DC2626' : '#16A34A'}">${_fmt(difTotal)}</b>`;

  tbody.innerHTML = filtrados.map(c => {
    const dif     = (c.totalDeclarado || 0) - (c.totalSistema || 0);
    const difCls  = dif < -1 ? "monto-neg" : dif > 1 ? "monto-pos" : "";
    const badgeCls = c.status === "VALIDADO" ? "badge-val" : c.status === "DIFERENCIA" ? "badge-dif" : "badge-pend";
    const fecha    = c._ts ? new Date(c._ts).toLocaleDateString("es-MX", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) : "—";
    const acciones = c.status === "PENDIENTE" ? `
      <button class="btn-validar" data-id="${c.id}">Validar</button>
      <button class="btn-rechazar" data-id="${c.id}">Diferencia</button>` : `<span style="font-size:.8rem;color:var(--muted)">${c.validadoPor || "—"}</span>`;
    return `<tr>
      <td>${c.alias || c.uid}</td>
      <td style="white-space:nowrap;font-size:.8rem">${fecha}<br><span style="color:var(--muted)">${c.turno || "—"}</span></td>
      <td>${_fmt(c.totalDeclarado)}</td>
      <td>${_fmt(c.totalSistema)}</td>
      <td class="${difCls}">${_fmt(dif)}</td>
      <td>${_fmt(c.efectivo)}</td>
      <td>${_fmt(c.tarjeta)}</td>
      <td>${_fmt(c.transferencia)}</td>
      <td><span class="${badgeCls}">${c.status}</span></td>
      <td>${acciones}</td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".btn-validar").forEach(btn => {
    btn.addEventListener("click", () => _setStatus(btn.dataset.id, "VALIDADO"));
  });
  tbody.querySelectorAll(".btn-rechazar").forEach(btn => {
    btn.addEventListener("click", () => _setStatus(btn.dataset.id, "DIFERENCIA"));
  });
}

async function _setStatus(id, status) {
  await updateDoc(doc(db, "cortes_caja", id), {
    status,
    validadoPor:  Sesion.uid,
    validadoAlias: Sesion.alias || "",
    timestampValidacion: serverTimestamp(),
  });
}
