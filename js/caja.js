// caja.js — Arqueo/Corte de Caja (MESA_CONTROL / GERENTE — vista cajero web)
import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { norm } from "./app.js";
import { cargarNombres, resolverNombre, getIngenieros } from "./nombres-cache.js";
import {
  collection, query, orderBy, onSnapshot, doc, getDoc,
  where, getDocs, addDoc, updateDoc, serverTimestamp, limit, Timestamp
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
  document.removeEventListener("keydown", _onKeyDown);
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
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
      <select id="caja-filtro-status" class="form-input" style="width:auto">
        <option value="">Todos</option>
        <option value="PENDIENTE">Pendientes</option>
        <option value="VALIDADO">Validados</option>
        <option value="DIFERENCIA">Con diferencia</option>
      </select>
      <select id="caja-filtro-alias" class="form-input" style="width:auto">
        <option value="">Todos</option>
      </select>
      <button id="caja-btn-nuevo" style="background:#16A34A;color:#fff;border:none;border-radius:6px;padding:.4rem .9rem;font-size:.9rem;font-weight:700;cursor:pointer">+ Nuevo corte</button>
    </div>
  </div>

  <div id="caja-resumen" class="caja-resumen-bar"></div>

  <div style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 250px)">
    <table class="tabla-caja">
      <thead>
        <tr>
          <th>Vendedor</th><th>Fecha / Turno</th><th>Origen</th>
          <th>Declarado</th><th>Sistema</th><th>Diferencia</th>
          <th>Efectivo</th><th>Tarjeta</th><th>Transferencia</th>
          <th>Status</th><th>Acciones</th>
        </tr>
      </thead>
      <tbody id="caja-tbody"></tbody>
    </table>
    <p id="caja-empty" style="display:none;text-align:center;color:var(--muted);padding:2rem">Sin cortes con estos filtros.</p>
  </div>
</div>

<!-- Modal nuevo corte -->
<div id="caja-modal" class="caja-modal-bg" style="display:none">
  <div class="caja-modal">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <h3 style="margin:0;font-size:1rem">Nuevo corte de caja</h3>
      <button id="caja-modal-close" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-muted)">✕</button>
    </div>

    <div class="caja-form-row">
      <label>Vendedor / Recuperador</label>
      <select id="caja-f-alias">
        <option value="">Selecciona…</option>
      </select>
    </div>
    <div class="caja-form-row">
      <label>Turno</label>
      <select id="caja-f-turno">
        <option value="MAÑANA">Mañana</option>
        <option value="TARDE">Tarde</option>
        <option value="JORNADA">Jornada completa</option>
        <option value="OFICINA">Oficina</option>
      </select>
    </div>

    <div style="background:var(--surface-2);border-radius:10px;padding:.75rem;margin:.75rem 0">
      <div style="font-size:.78rem;font-weight:700;color:var(--text-muted);margin-bottom:.5rem">
        TOTAL SISTEMA (calculado)
        <span id="caja-sistema-loading" style="display:none;margin-left:8px;font-size:.72rem;font-weight:400;color:#2563EB">⏳ calculando…</span>
      </div>
      <div id="caja-f-sistema" style="font-size:1.4rem;font-weight:800;color:#16A34A">$0.00</div>
      <div id="caja-f-sistema-detalle" style="font-size:.78rem;color:var(--text-muted);margin-top:.25rem"></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-bottom:.5rem">
      <div class="caja-form-row" style="margin-bottom:0">
        <label>Efectivo declarado</label>
        <input id="caja-f-ef" type="number" min="0" step="0.01" placeholder="0.00">
      </div>
      <div class="caja-form-row" style="margin-bottom:0">
        <label>Tarjeta declarada</label>
        <input id="caja-f-tj" type="number" min="0" step="0.01" placeholder="0.00">
      </div>
    </div>
    <div class="caja-form-row">
      <label>Transferencia declarada</label>
      <input id="caja-f-tr" type="number" min="0" step="0.01" placeholder="0.00">
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-top:1px solid var(--border)">
      <div>
        <span style="font-size:.85rem;color:var(--text-muted)">Total declarado: </span>
        <span id="caja-f-declarado" style="font-weight:700">$0.00</span>
        &nbsp;·&nbsp;
        <span style="font-size:.85rem;color:var(--text-muted)">Diferencia: </span>
        <span id="caja-f-diferencia" style="font-weight:700">$0.00</span>
      </div>
      <div style="display:flex;gap:.5rem">
        <button id="caja-btn-cancelar" style="background:none;border:1px solid var(--border);border-radius:6px;padding:.5rem 1.2rem;font-weight:600;cursor:pointer;color:var(--text-primary)">Cancelar</button>
        <button id="caja-btn-guardar" style="background:#16A34A;color:#fff;border:none;border-radius:6px;padding:.5rem 1.2rem;font-weight:700;cursor:pointer">Guardar corte</button>
      </div>
    </div>
  </div>
</div>

<style>
.caja-wrap { padding:1rem; }
.caja-header { display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem; }
.caja-resumen-bar { font-size:.85rem;color:var(--muted);margin-bottom:.75rem; }
.tabla-caja { width:100%;border-collapse:collapse;font-size:.88rem; }
.tabla-caja th { background:var(--surface-2);padding:.6rem .8rem;text-align:left;font-weight:600;border-bottom:2px solid var(--border);white-space:nowrap;position:sticky;top:0;z-index:2 }
.tabla-caja td { padding:.55rem .8rem;border-bottom:1px solid var(--border);vertical-align:top; }
.tabla-caja tr:hover td { background:var(--surface-2); }
.monto-pos { color:#16A34A;font-weight:700; }
.monto-neg { color:#DC2626;font-weight:700; }
.badge-pend { background:#FEF3C7;color:#92400E;border-radius:4px;padding:.2rem .4rem;font-size:.75rem;font-weight:700; }
.badge-val  { background:#D1FAE5;color:#065F46;border-radius:4px;padding:.2rem .4rem;font-size:.75rem;font-weight:700; }
.badge-dif  { background:#FEE2E2;color:#991B1B;border-radius:4px;padding:.2rem .4rem;font-size:.75rem;font-weight:700; }
.badge-auto { background:#EDE9FE;color:#5B21B6;border-radius:4px;padding:.2rem .4rem;font-size:.72rem;font-weight:700; }
.badge-man  { background:#E0F2FE;color:#0369A1;border-radius:4px;padding:.2rem .4rem;font-size:.72rem;font-weight:700; }
.badge-liq  { background:#FEF3C7;color:#92400E;border-radius:4px;padding:.2rem .4rem;font-size:.72rem;font-weight:700; }
.btn-validar  { background:#16A34A;color:#fff;border:none;border-radius:5px;padding:.3rem .6rem;cursor:pointer;font-size:.8rem; }
.btn-rechazar { background:#DC2626;color:#fff;border:none;border-radius:5px;padding:.3rem .6rem;cursor:pointer;font-size:.8rem;margin-left:.3rem; }
.caja-modal-bg { position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center; }
.caja-modal { background:var(--surface);border-radius:12px;padding:1.25rem 1.5rem;width:min(560px,95vw);max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.3); }
.caja-form-row { display:flex;flex-direction:column;gap:.25rem;margin-bottom:.6rem; }
.caja-form-row label { font-size:.78rem;font-weight:600;color:var(--text-muted); }
.caja-form-row input,.caja-form-row select { padding:.4rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);font-size:.9rem; }
</style>`;
}

// ─── Estado ──────────────────────────────────────────────────────────────────

let _filtroStatus = "";
let _filtroAlias  = "";
let _lastDocs     = [];
let _sistemaCache = { alias:"", ef:0, tj:0, tr:0 };

// ─── Eventos ─────────────────────────────────────────────────────────────────

function _bindEvents() {
  _container.querySelector("#caja-filtro-status").addEventListener("change", e => {
    _filtroStatus = e.target.value;
    _cargarCortes();
  });
  _container.querySelector("#caja-filtro-alias").addEventListener("change", e => {
    _filtroAlias = e.target.value;
    _render(_lastDocs);
  });
  _container.querySelector("#caja-btn-nuevo").addEventListener("click", _abrirModal);
  _container.querySelector("#caja-modal-close").addEventListener("click", _cerrarModal);
  _container.querySelector("#caja-btn-cancelar").addEventListener("click", _cerrarModal);
  _container.querySelector("#caja-modal").addEventListener("click", e => {
    if (e.target === e.currentTarget) _cerrarModal();
  });
  document.addEventListener("keydown", _onKeyDown);

  // Recalcular total declarado y diferencia al cambiar montos
  ["caja-f-ef","caja-f-tj","caja-f-tr"].forEach(id => {
    _container.querySelector(`#${id}`).addEventListener("input", _actualizarTotalesModal);
  });

  _container.querySelector("#caja-f-alias").addEventListener("change", async e => {
    const sistemaEl = _container.querySelector("#caja-sistema-loading");
    if (sistemaEl) { sistemaEl.style.display = "inline"; }
    await _calcularSistema(e.target.value);
    if (sistemaEl) { sistemaEl.style.display = "none"; }
    _actualizarTotalesModal();
  });

  _container.querySelector("#caja-btn-guardar").addEventListener("click", _guardarCorte);
}

async function _abrirModal() {
  await cargarNombres();
  const ingenieros = getIngenieros(["INGENIERO", "RECUPERADOR", "ADMINISTRADOR"]);
  const sel = _container.querySelector("#caja-f-alias");
  sel.innerHTML = `<option value="">Selecciona…</option>` +
    ingenieros.map(u => `<option value="${u.alias || u.uid}">${u.nombre || u.alias}</option>`).join("");
  _container.querySelector("#caja-modal").style.display = "flex";
  _sistemaCache = { alias:"", ef:0, tj:0, tr:0 };
  _actualizarTotalesModal();
}

function _cerrarModal() {
  _container.querySelector("#caja-modal").style.display = "none";
}

function _onKeyDown(e) {
  if (e.key === "Escape") _cerrarModal();
}

async function _calcularSistema(alias) {
  if (!alias) { _sistemaCache = { alias:"", ef:0, tj:0, tr:0 }; return; }

  const ahora     = new Date();
  const inicioDia = new Date(ahora); inicioDia.setHours(0,0,0,0);
  const tsInicio  = Timestamp.fromDate(inicioDia);

  let ef = 0, tj = 0, tr = 0;

  // 1) Abonos del día desde remisiones_credito (cobros de crédito embebidos)
  const remSnap = await getDocs(query(
    collection(db, "remisiones_credito"),
    where("ingenieroAlias", "==", alias)
  ));

  remSnap.docs.forEach(d => {
    const r = d.data();
    (r.abonos || []).forEach(ab => {
      if (!ab.fecha) return;
      const fechaAb = new Date(ab.fecha + (ab.fecha.includes("T") ? "" : "T12:00:00"));
      if (fechaAb < inicioDia) return;
      const monto = ab.monto || 0;
      const forma = (ab.formaPago || "EFECTIVO").toUpperCase();
      if (forma.includes("TARJETA")) tj += monto;
      else if (forma.includes("TRANSFER")) tr += monto;
      else ef += monto;
    });
  });

  // 2) Pedidos de contado entregados hoy (ingenieroAlias o alias en el campo)
  const [pedSnap1, pedSnap2] = await Promise.all([
    getDocs(query(collection(db, "pedidos"),
      where("ingenieroAlias", "==", alias),
      where("status", "==", "ENTREGADO"),
      where("entregadoEn", ">=", inicioDia.getTime())
    )),
    getDocs(query(collection(db, "pedidos"),
      where("alias", "==", alias),
      where("status", "==", "ENTREGADO"),
      where("entregadoEn", ">=", inicioDia.getTime())
    )),
  ]);

  const pedidosIds = new Set();
  const procesarPedido = d => {
    if (pedidosIds.has(d.id)) return;
    pedidosIds.add(d.id);
    const p = d.data();
    const tipoPago = (p.tipoPago || p.tipoVenta || "").toUpperCase();
    if (tipoPago.includes("CREDITO")) return; // el crédito ya va por remisiones
    const monto = Number(p.total || p.monto || 0);
    const forma = (p.metodoPago || p.formaPago || "EFECTIVO").toUpperCase();
    if (forma.includes("TARJETA")) tj += monto;
    else if (forma.includes("TRANSFER")) tr += monto;
    else ef += monto;
  };
  pedSnap1.docs.forEach(procesarPedido);
  pedSnap2.docs.forEach(procesarPedido);

  _sistemaCache = { alias, ef, tj, tr };

  const detEl = _container.querySelector("#caja-f-sistema-detalle");
  const total = ef + tj + tr;
  _container.querySelector("#caja-f-sistema").textContent = _fmt(total);
  detEl.textContent = `Efectivo $${ef.toFixed(2)} · Tarjeta $${tj.toFixed(2)} · Transf. $${tr.toFixed(2)}`;
}

function _actualizarTotalesModal() {
  const ef = parseFloat(_container.querySelector("#caja-f-ef").value) || 0;
  const tj = parseFloat(_container.querySelector("#caja-f-tj").value) || 0;
  const tr = parseFloat(_container.querySelector("#caja-f-tr").value) || 0;
  const declarado = ef + tj + tr;
  const sistema   = _sistemaCache.ef + _sistemaCache.tj + _sistemaCache.tr;
  const dif       = declarado - sistema;

  _container.querySelector("#caja-f-declarado").textContent = _fmt(declarado);
  const difEl = _container.querySelector("#caja-f-diferencia");
  difEl.textContent = _fmt(dif);
  difEl.style.color = Math.abs(dif) < 0.5 ? "#16A34A" : "#DC2626";
}

async function _guardarCorte() {
  const alias = _container.querySelector("#caja-f-alias").value;
  if (!alias) { window.toast?.("Selecciona un vendedor.", "error"); return; }

  const ef  = parseFloat(_container.querySelector("#caja-f-ef").value) || 0;
  const tj  = parseFloat(_container.querySelector("#caja-f-tj").value) || 0;
  const tr  = parseFloat(_container.querySelector("#caja-f-tr").value) || 0;
  const totalDeclarado = ef + tj + tr;
  const totalSistema   = _sistemaCache.ef + _sistemaCache.tj + _sistemaCache.tr;
  const dif            = totalDeclarado - totalSistema;
  const turno = _container.querySelector("#caja-f-turno").value;
  const hoyStr = new Date().toISOString().slice(0, 10);

  const btn = _container.querySelector("#caja-btn-guardar");
  btn.disabled = true; btn.textContent = "Guardando…";

  try {
    await addDoc(collection(db, "cortes_caja"), {
      uid:           Sesion.uid,
      alias,
      totalDeclarado,
      totalSistema,
      efectivo:      ef,
      tarjeta:       tj,
      transferencia: tr,
      status:        "PENDIENTE",
      turno,
      fechaStr:      hoyStr,
      origen:        "MANUAL",
      creadoPor:     Sesion.alias || Sesion.uid,
      _ts:           Date.now(),
      timestamp:     serverTimestamp(),
    });
    _cerrarModal();
    // Limpiar formulario
    ["caja-f-ef","caja-f-tj","caja-f-tr"].forEach(id => { _container.querySelector(`#${id}`).value = ""; });
    _container.querySelector("#caja-f-alias").value = "";
  } catch(e) {
    window.toast?.("Error al guardar: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Guardar corte";
  }
}

// ─── Firestore ────────────────────────────────────────────────────────────────

function _cargarCortes() {
  if (_unsub) { _unsub(); _unsub = null; }
  let q = query(collection(db, "cortes_caja"), orderBy("_ts", "desc"), limit(300));
  if (_filtroStatus) {
    q = query(collection(db, "cortes_caja"), where("status", "==", _filtroStatus), orderBy("_ts", "desc"), limit(300));
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
    const fecha    = c._ts ? new Date(c._ts).toLocaleString("es-MX", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) : "—";
    const acciones = c.status === "PENDIENTE" ? `
      <button class="btn-validar" data-id="${c.id}">Validar</button>
      <button class="btn-rechazar" data-id="${c.id}">Diferencia</button>` : `<span style="font-size:.8rem;color:var(--muted)">${c.validadoAlias || resolverNombre(c.validadoPor) || "—"}</span>`;
    const origenBadge = c.origen === "AUTO"
      ? `<span class="badge-auto">AUTO</span>`
      : c.origen === "LIQUIDACION"
        ? `<span class="badge-liq">LIQUIDACIÓN</span>`
        : `<span class="badge-man">MANUAL</span>`;
    return `<tr>
      <td>${resolverNombre(c.alias) || c.alias || c.uid}</td>
      <td style="white-space:nowrap;font-size:.8rem">${fecha}<br><span style="color:var(--muted)">${c.turno || "—"}</span></td>
      <td>${origenBadge}</td>
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
  const label = status === "VALIDADO" ? "validar" : "marcar con diferencia";
  const ok = window.modal
    ? await window.modal({ title: "Confirmar acción", message: `¿Deseas ${label} este corte de caja?`, confirmLabel: status === "VALIDADO" ? "Validar" : "Confirmar diferencia" })
    : confirm(`¿${label.charAt(0).toUpperCase() + label.slice(1)} este corte?`);
  if (!ok) return;
  try {
    await updateDoc(doc(db, "cortes_caja", id), {
      status,
      validadoPor:  Sesion.uid,
      validadoAlias: Sesion.alias || "",
      timestampValidacion: serverTimestamp(),
    });
  } catch(e) {
    window.toast?.("Error: " + e.message, "error");
  }
}
