// ══════════════════════════════════════════════════════════════
// devoluciones.js — Módulo de devoluciones N10 ERP
// Flujo: solicitud → aprobación/rechazo → ajuste inventario + cartera
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, logAudit, norm } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, doc, addDoc, updateDoc, onSnapshot,
  query, orderBy, where, getDocs, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { crearNotificacion } from "./notificaciones.js";
import { getClientes } from "./erp-cache.js";

let _unsub = null;

const fmtMXN   = v => Number(v || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const fmtFecha = ts => ts ? new Date(ts).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" }) : "—";

const STATUS = {
  PENDIENTE:  { label: "Pendiente",  cls: "badge-yellow" },
  APROBADA:   { label: "Aprobada",   cls: "badge-green"  },
  RECHAZADA:  { label: "Rechazada",  cls: "badge-red"    },
  PROCESADA:  { label: "Procesada",  cls: "badge-purple" },
};

const MOTIVOS = [
  "Producto dañado", "Error en pedido", "Producto incorrecto",
  "Caducidad próxima", "No solicitado", "Otro"
];

export const DevolucionesModule = {
  mount(container) {
    cargarNombres();
    container.innerHTML = _html();
    document.getElementById("dev-body").innerHTML = window.skeleton?.(5, 6) ?? "";
    _bindFiltros();
    _bindNueva();
    _escuchar();
    return () => this.destroy();
  },
  destroy() {
    if (_unsub) { _unsub(); _unsub = null; }
  }
};

// ── HTML ─────────────────────────────────────────────────────
function _html() {
  const puedeAprobar = Sesion.esSuperAdmin() || ["GERENTE","GERENTE_ZONA","ADMINISTRADOR","MESA_CONTROL"].includes(Sesion.rol);
  return `
  <div class="mod-wrap">
    <div class="mod-topbar">
      <h2 class="mod-title">↩️ Devoluciones</h2>
      <div class="mod-actions">
        <select id="dev-filtro-status" class="sel-sm">
          <option value="">Todos los estados</option>
          ${Object.entries(STATUS).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join("")}
        </select>
        <button class="btn-primary" id="btn-nueva-dev">+ Nueva devolución</button>
      </div>
    </div>

    <!-- Tarjetas KPI -->
    <div class="kpi-row" id="dev-kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left-color:#D97706">
        <div class="kpi-icon">⏳</div>
        <div class="kpi-val" id="dev-kpi-pend">–</div>
        <div class="kpi-label">Pendientes</div>
      </div>
      <div class="kpi-card" style="border-left-color:#DC2626">
        <div class="kpi-icon">💰</div>
        <div class="kpi-val" id="dev-kpi-monto">–</div>
        <div class="kpi-label">Monto mes actual</div>
      </div>
      <div class="kpi-card" style="border-left-color:#16A34A">
        <div class="kpi-icon">✅</div>
        <div class="kpi-val" id="dev-kpi-aprobadas">–</div>
        <div class="kpi-label">Aprobadas este mes</div>
      </div>
    </div>

    <table class="data-table" id="dev-table">
      <thead>
        <tr>
          <th>Folio</th><th>CLIENTE</th><th>INGENIERO</th>
          <th>MOTIVO</th><th>MONTO</th><th>STATUS</th>
          <th>FECHA</th>${puedeAprobar ? "<th>ACCIÓN</th>" : ""}
        </tr>
      </thead>
      <tbody id="dev-body">
        <tr><td colspan="8" style="text-align:center;padding:24px;color:#9CA3AF">Cargando…</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Modal nueva devolución -->
  <div class="modal-overlay hidden" id="dev-modal">
    <div class="modal-box" style="max-width:540px">
      <div class="modal-hdr">
        <span class="modal-title">Nueva solicitud de devolución</span>
        <button class="modal-close" id="dev-modal-close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
        <div class="form-group">
          <label class="form-label">Folio de remisión / pedido</label>
          <input id="dev-folio-ref" class="form-input" placeholder="N10-XXXXX o N10-PED-XXXXX">
        </div>
        <div class="form-group" style="position:relative">
          <label class="form-label">Cliente</label>
          <input id="dev-cliente" class="form-input" placeholder="Buscar cliente…"
            autocomplete="off" oninput="DevolucionesUI._filtrarCliente(this.value)">
          <div id="dev-cli-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
            background:var(--surface,#1F2937);border:1px solid var(--border);border-radius:6px;
            max-height:140px;overflow-y:auto;z-index:20;box-shadow:0 4px 12px rgba(0,0,0,.3)"></div>
        </div>
        <div class="form-group">
          <label class="form-label">Productos a devolver</label>
          <textarea id="dev-productos" class="form-input" rows="3"
            placeholder="Ej: 2x Producto A, 1x Producto B"></textarea>
        </div>
        <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label class="form-label">Monto a devolver</label>
            <input id="dev-monto" class="form-input" type="number" min="0" step="0.01" placeholder="0.00">
          </div>
          <div class="form-group">
            <label class="form-label">Motivo</label>
            <select id="dev-motivo" class="form-input">
              ${MOTIVOS.map(m => `<option>${m}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Notas adicionales</label>
          <textarea id="dev-notas" class="form-input" rows="2" placeholder="Detalles opcionales…"></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-outline" id="dev-cancel">Cancelar</button>
        <button class="btn-primary" id="dev-guardar">Enviar solicitud</button>
      </div>
    </div>
  </div>

  <!-- Panel lateral de detalle -->
  <div class="side-panel hidden" id="dev-side">
    <div class="side-panel-hdr">
      <span class="side-panel-title" id="dev-side-folio">Devolución</span>
      <button class="modal-close" id="dev-side-close">✕</button>
    </div>
    <div class="side-panel-body" id="dev-side-body"></div>
  </div>`;
}

// ── Listener ──────────────────────────────────────────────────
function _escuchar(statusFiltro = "") {
  if (_unsub) _unsub();

  let q = query(
    collection(db, "devoluciones"),
    orderBy("timestamp", "desc"),
    limit(100)
  );
  if (statusFiltro) {
    q = query(
      collection(db, "devoluciones"),
      where("status", "==", statusFiltro),
      orderBy("timestamp", "desc"),
      limit(100)
    );
  }

  _unsub = onSnapshot(q, snap => {
    const devs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderTabla(devs);
    _renderKPIs(devs);
  }, err => console.error("[Devoluciones]", err));
}

// ── Render tabla ──────────────────────────────────────────────
function _renderTabla(devs) {
  const tbody = document.getElementById("dev-body");
  if (!tbody) return;

  const puedeAprobar = Sesion.esSuperAdmin() || ["GERENTE","GERENTE_ZONA","ADMINISTRADOR","MESA_CONTROL"].includes(Sesion.rol);

  if (devs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state" style="padding:32px;text-align:center">
      <div class="empty-state-icon">↩️</div>
      <div class="empty-state-title">Sin devoluciones</div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = devs.map(d => {
    const st  = STATUS[d.status] || STATUS.PENDIENTE;
    const acc = puedeAprobar && d.status === "PENDIENTE"
      ? `<button class="btn-sm btn-green" data-id="${d.id}" data-action="aprobar">✓ Aprobar</button>
         <button class="btn-sm btn-red" data-id="${d.id}" data-action="rechazar" style="margin-left:4px">✗ Rechazar</button>`
      : `<button class="btn-sm btn-outline" data-id="${d.id}" data-action="ver">Ver</button>`;

    return `<tr>
      <td><b>${esc(d.folio || d.id.slice(-6).toUpperCase())}</b></td>
      <td>${esc(d.clienteNombre || "–")}</td>
      <td>${esc(resolverNombre(d.ingenieroAlias))}</td>
      <td>${esc(d.motivo || "–")}</td>
      <td>${fmtMXN(d.monto)}</td>
      <td><span class="badge ${st.cls}">${st.label}</span></td>
      <td>${fmtFecha(d._ts || d.timestamp?.toMillis?.())}</td>
      ${puedeAprobar ? `<td class="td-actions">${acc}</td>` : ""}
    </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const { id, action } = btn.dataset;
      if (action === "aprobar")  _aprobarDev(id, devs.find(d => d.id === id));
      else if (action === "rechazar") _rechazarDev(id, devs.find(d => d.id === id));
      else _abrirDetalle(devs.find(d => d.id === id));
    });
  });
}

// ── KPIs ──────────────────────────────────────────────────────
function _renderKPIs(devs) {
  const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
  const initMs = inicioMes.getTime();

  const pendientes = devs.filter(d => d.status === "PENDIENTE").length;
  const delMes     = devs.filter(d => (d._ts || 0) >= initMs);
  const monto      = delMes.reduce((s, d) => s + (d.monto || 0), 0);
  const aprobadas  = delMes.filter(d => ["APROBADA","PROCESADA"].includes(d.status)).length;

  const el = id => document.getElementById(id);
  if (el("dev-kpi-pend"))     el("dev-kpi-pend").textContent     = pendientes;
  if (el("dev-kpi-monto"))    el("dev-kpi-monto").textContent    = fmtMXN(monto);
  if (el("dev-kpi-aprobadas")) el("dev-kpi-aprobadas").textContent = aprobadas;
}

// ── Nueva solicitud ───────────────────────────────────────────
// ── Autocomplete cliente en devolución ────────────────────────
window.DevolucionesUI = {
  async _filtrarCliente(q) {
    const dd    = document.getElementById("dev-cli-dd");
    const input = document.getElementById("dev-cliente");
    if (!dd || !input) return;
    const lista = await getClientes();
    const qn    = norm(q);
    const filtrados = lista.filter(c =>
      norm(c.nombre).includes(qn) || norm(c.clienteId).includes(qn)
    );
    if (!qn || !filtrados.length) { dd.style.display = "none"; return; }
    dd.innerHTML = filtrados.slice(0, 15).map(c =>
      `<div class="dev-dd-item" data-nombre="${esc(c.nombre)}"
        style="padding:7px 10px;cursor:pointer;font-size:12px;color:var(--text-primary);border-bottom:1px solid var(--border)">
        <span style="font-weight:600">${esc(c.nombre)}</span>
        ${c.clienteId ? `<span style="color:#9CA3AF;font-size:10px;margin-left:6px">${esc(c.clienteId)}</span>` : ""}
      </div>`
    ).join("");
    dd.style.display = "block";
    dd.querySelectorAll(".dev-dd-item").forEach(el =>
      el.addEventListener("mousedown", ev => {
        ev.preventDefault();
        input.value = el.dataset.nombre;
        dd.style.display = "none";
      }));
    input.onblur = () => setTimeout(() => { dd.style.display = "none"; }, 150);
  }
};

function _bindNueva() {
  document.getElementById("btn-nueva-dev")?.addEventListener("click", () => {
    document.getElementById("dev-modal")?.classList.remove("hidden");
  });
  document.getElementById("dev-modal-close")?.addEventListener("click", _cerrarModal);
  document.getElementById("dev-cancel")?.addEventListener("click", _cerrarModal);
  document.getElementById("dev-guardar")?.addEventListener("click", _guardarSolicitud);
}

function _cerrarModal() {
  document.getElementById("dev-modal")?.classList.add("hidden");
}

async function _guardarSolicitud() {
  const folioRef  = document.getElementById("dev-folio-ref")?.value.trim();
  const cliente   = document.getElementById("dev-cliente")?.value.trim();
  const productos = document.getElementById("dev-productos")?.value.trim();
  const monto     = parseFloat(document.getElementById("dev-monto")?.value || "0");
  const motivo    = document.getElementById("dev-motivo")?.value;
  const notas     = document.getElementById("dev-notas")?.value.trim();

  if (!folioRef || !cliente || !productos || monto <= 0) {
    window.toast?.("Completa todos los campos obligatorios", "error");
    return;
  }

  const btn = document.getElementById("dev-guardar");
  btn.disabled = true;
  btn.textContent = "Guardando…";

  try {
    // Generar folio DEV-XXXXX
    const snap = await getDocs(query(
      collection(db, "devoluciones"), orderBy("_ts", "desc"), limit(1)
    ));
    const ultimo = snap.empty ? 0 : (snap.docs[0].data()._folioNum || 0);
    const num    = ultimo + 1;
    const folio  = "DEV-" + String(num).padStart(5, "0");

    await addDoc(collection(db, "devoluciones"), {
      folio,
      _folioNum:      num,
      folioRef,
      clienteNombre:  cliente,
      ingenieroAlias: Sesion.alias || "—",
      ingenieroUid:   Sesion.uid   || "—",
      productos,
      monto,
      motivo,
      notas,
      status:         "PENDIENTE",
      timestamp:      serverTimestamp(),
      _ts:            Date.now(),
    });

    // Notificar a Mesa de Control / Admin
    await crearNotificacion({
      tipo:         "DEVOLUCION_SOLICITADA",
      mensaje:      `${Sesion.alias} solicitó devolución ${folio} · ${fmtMXN(monto)} · ${motivo}`,
      destinatarios: ["TODOS"],
      accion:       { vista: "devoluciones" },
    });

    window.toast?.(`Solicitud ${folio} enviada`, "success");
    _cerrarModal();
  } catch (e) {
    console.error("[Devoluciones] guardar:", e);
    window.toast?.("Error al guardar: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Enviar solicitud";
  }
}

// ── Aprobar ──────────────────────────────────────────────────
async function _aprobarDev(id, dev) {
  if (!await window.modal({ title: "Aprobar devolución", message: `¿Aprobar devolución ${dev?.folio}? Se ajustará el inventario y la cartera del cliente.`, confirmLabel: "Aprobar" })) return;
  try {
    await updateDoc(doc(db, "devoluciones", id), {
      status:          "APROBADA",
      aprobadaPor:     Sesion.alias,
      aprobadaEn:      serverTimestamp(),
      aprobadaEn_ts:   Date.now(),
    });
    logAudit("DEVOLUCION_APROBADA", { folio: dev?.folio, monto: dev?.monto, clienteNombre: dev?.clienteNombre, ingeniero: dev?.ingenieroAlias });
    window.toast?.("Devolución aprobada. Ajustando inventario…", "success");

    await crearNotificacion({
      tipo:          "DEVOLUCION_APROBADA",
      mensaje:       `Devolución ${dev?.folio} aprobada por ${Sesion.alias}`,
      destinatarios: [dev?.ingenieroUid || "TODOS"],
      accion:        { vista: "devoluciones" },
    });
  } catch (e) {
    window.toast?.("Error: " + e.message, "error");
  }
}

// ── Rechazar ─────────────────────────────────────────────────
async function _rechazarDev(id, dev) {
  const motivo = await window.promptModal({ title: "Rechazar devolución", label: "Motivo del rechazo (opcional)", placeholder: "Motivo…" });
  if (motivo === null) return; // cancelado
  try {
    await updateDoc(doc(db, "devoluciones", id), {
      status:        "RECHAZADA",
      rechazadaPor:  Sesion.alias,
      rechazadaEn:   serverTimestamp(),
      motivoRechazo: motivo || "",
    });
    window.toast?.("Devolución rechazada", "success");

    await crearNotificacion({
      tipo:          "DEVOLUCION_RECHAZADA",
      mensaje:       `Devolución ${dev?.folio} rechazada. ${motivo ? "Motivo: " + motivo : ""}`,
      destinatarios: [dev?.ingenieroUid || "TODOS"],
      accion:        { vista: "devoluciones" },
    });
  } catch (e) {
    window.toast?.("Error: " + e.message, "error");
  }
}

// ── Detalle lateral ──────────────────────────────────────────
function _abrirDetalle(dev) {
  if (!dev) return;
  const st = STATUS[dev.status] || STATUS.PENDIENTE;
  document.getElementById("dev-side-folio").textContent = dev.folio || "Devolución";
  document.getElementById("dev-side-body").innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;padding:16px">
      <div><span class="badge ${st.cls}">${st.label}</span></div>
      <table class="det-table">
        <tr><th>Cliente</th><td>${esc(dev.clienteNombre)}</td></tr>
        <tr><th>Ingeniero</th><td>${esc(resolverNombre(dev.ingenieroAlias))}</td></tr>
        <tr><th>Folio ref.</th><td>${esc(dev.folioRef)}</td></tr>
        <tr><th>Productos</th><td>${esc(dev.productos)}</td></tr>
        <tr><th>Monto</th><td><b>${fmtMXN(dev.monto)}</b></td></tr>
        <tr><th>Motivo</th><td>${esc(dev.motivo)}</td></tr>
        <tr><th>Notas</th><td>${esc(dev.notas || "—")}</td></tr>
        ${dev.aprobadaPor ? `<tr><th>Aprobada por</th><td>${esc(dev.aprobadaPor)}</td></tr>` : ""}
        ${dev.rechazadaPor ? `<tr><th>Rechazada por</th><td>${esc(dev.rechazadaPor)}</td></tr>` : ""}
        ${dev.motivoRechazo ? `<tr><th>Motivo rechazo</th><td>${esc(dev.motivoRechazo)}</td></tr>` : ""}
      </table>
    </div>`;
  document.getElementById("dev-side")?.classList.remove("hidden");
  document.getElementById("dev-side-close")?.addEventListener("click", () => {
    document.getElementById("dev-side")?.classList.add("hidden");
  }, { once: true });
}

// ── Filtros ──────────────────────────────────────────────────
function _bindFiltros() {
  document.getElementById("dev-filtro-status")?.addEventListener("change", e => {
    _escuchar(e.target.value);
  });
}
