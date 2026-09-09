/**
 * Módulo Autorizaciones de Pedido — N-10 Web Panel
 * El administrador aprueba o rechaza pedidos en estado PENDIENTE_AUTORIZACION.
 * El APK marcará pedidos con ese status cuando superen el umbral o sean a crédito
 * (implementado en Batch 3 / A5). Este módulo gestiona el flujo desde el panel.
 */

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, doc, updateDoc, getDocs,
  onSnapshot, query, where, orderBy, limit,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { logAudit } from "./app.js";

let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

const STATUS_PENDIENTE = "PENDIENTE_AUTORIZACION";
const STATUS_CONFIRMADO = "CONFIRMADO";
const STATUS_RECHAZADO  = "RECHAZADO";

// ── Estado ─────────────────────────────────────────────────────────────────────
let _unsubPendientes = null;
let _unsubHistorial  = null;
let _pendientes = {};  // id → pedido
let _historial  = [];  // últimos resueltos

// ── Render ─────────────────────────────────────────────────────────────────────
export const AutorizacionesModule = {

  mount(container) {
    if (!Sesion.esSuperAdmin?.() && !Sesion.flags?.PUEDE_AUTORIZAR_PEDIDOS) {
      container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-sec)">
        <div style="font-size:40px;margin-bottom:12px">🔒</div>
        <div style="font-weight:700;font-size:15px">Acceso restringido</div>
        <div style="font-size:12px;margin-top:6px">Solo Mesa de Control y Super Admin pueden autorizar pedidos.</div>
      </div>`;
      return;
    }
    this.render(container);
  },

  render(container) {
    cargarNombres();
    container.innerHTML = `
      <div class="aut-shell">
        <div class="aut-header">
          <h2 class="aut-title">✅ Autorizaciones de Pedido</h2>
          <div class="aut-badge" id="autBadge" style="display:none"></div>
        </div>

        <div class="aut-body">
          <!-- Pendientes -->
          <section class="aut-section">
            <div class="aut-section-title">🔔 Pendientes de autorización</div>
            <div id="autPendientesWrap"></div>
          </section>

          <!-- Historial reciente -->
          <section class="aut-section">
            <div class="aut-section-title">📋 Historial reciente (últimos 30 días)</div>
            <div id="autHistorialWrap"></div>
          </section>
        </div>

        <!-- Modal de rechazo -->
        <div id="autModalRechazo" class="aut-modal-overlay" style="display:none">
          <div class="aut-modal">
            <div class="aut-modal-title">Motivo de rechazo</div>
            <textarea id="autMotivoInput" rows="3" placeholder="Describe el motivo del rechazo…"
              style="width:100%;padding:8px;border:1px solid var(--border,#e2e8f0);border-radius:6px;
                     font-size:.88rem;box-sizing:border-box;margin-top:8px"></textarea>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="aut-btn-danger" id="autBtnConfRechazo">Confirmar rechazo</button>
              <button class="aut-btn-secondary" id="autBtnCancelRechazo">Cancelar</button>
            </div>
          </div>
        </div>
      </div>

      <style>
        .aut-shell  { display:flex; flex-direction:column; height:100%; }
        .aut-header { display:flex; align-items:center; gap:12px; padding:12px 16px;
                      border-bottom:1px solid var(--border,#e2e8f0); }
        .aut-title  { margin:0; font-size:1.1rem; font-weight:700; }
        .aut-badge  { background:#ef4444; color:#fff; border-radius:20px; padding:2px 10px;
                      font-size:.8rem; font-weight:700; }
        .aut-body   { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:24px; }
        .aut-section-title { font-size:.85rem; font-weight:700; color:var(--text-sec);
                             text-transform:uppercase; letter-spacing:.05em; margin-bottom:10px; }
        .aut-card   { background:var(--card-bg,#fff); border:1px solid var(--border,#e2e8f0);
                      border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:8px; }
        .aut-card.pendiente { border-left:4px solid #f59e0b; }
        .aut-card.confirmado{ border-left:4px solid #22c55e; }
        .aut-card.rechazado { border-left:4px solid #ef4444; }
        .aut-card-top { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:4px; }
        .aut-folio  { font-weight:700; font-size:.95rem; }
        .aut-total  { font-size:1rem; font-weight:700; color:var(--accent,#3b82f6); }
        .aut-meta   { font-size:.8rem; color:var(--text-sec); }
        .aut-items  { font-size:.8rem; border-top:1px solid var(--border,#e2e8f0); padding-top:8px; }
        .aut-items-title { font-weight:600; margin-bottom:4px; }
        .aut-item-row { display:flex; justify-content:space-between; padding:2px 0; }
        .aut-actions{ display:flex; gap:8px; flex-wrap:wrap; }
        .aut-pill   { display:inline-block; border-radius:20px; padding:2px 10px; font-size:.76rem; font-weight:600; }
        .aut-pill.pend { background:#fef3c7; color:#92400e; }
        .aut-pill.ok   { background:#dcfce7; color:#166534; }
        .aut-pill.rec  { background:#fee2e2; color:#991b1b; }
        .aut-resolucion { font-size:.8rem; color:var(--text-sec); border-top:1px solid var(--border,#e2e8f0); padding-top:8px; }
        .aut-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.4);
                             display:flex; align-items:center; justify-content:center; z-index:300; }
        .aut-modal  { background:var(--card-bg,#fff); border-radius:10px; padding:20px;
                      width:min(380px,90vw); }
        .aut-modal-title { font-weight:700; font-size:.95rem; }
        .aut-btn-primary  { background:var(--accent,#3b82f6); color:#fff; border:none;
                        padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .aut-btn-secondary{ background:transparent; border:1px solid var(--border,#e2e8f0);
                        padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .aut-btn-danger   { background:#ef4444; color:#fff; border:none;
                        padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .btn-success  { background:#22c55e; color:#fff; border:none;
                        padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .btn-sm       { padding:5px 11px; font-size:.8rem; }
        .empty-state  { padding:20px; text-align:center; color:var(--text-sec);
                        font-size:.88rem; }
      </style>
    `;

    _suscribirPendientes();
    _suscribirHistorial();
  },

  destroy() {
    _unsubPendientes?.();
    _unsubHistorial?.();
    _unsubPendientes = _unsubHistorial = null;
    _pendientes = {}; _historial = [];
  }
};

// ── Suscripciones ──────────────────────────────────────────────────────────────
function _suscribirPendientes() {
  const q = query(
    collection(db, "pedidos"),
    where("status", "==", STATUS_PENDIENTE),
    orderBy("fechaPedido", "desc")
  );
  _unsubPendientes = onSnapshot(q, snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === "removed") delete _pendientes[ch.doc.id];
      else _pendientes[ch.doc.id] = { id: ch.doc.id, ...ch.doc.data() };
    });
    _renderPendientes();
  });
}

function _suscribirHistorial() {
  const hace30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const q = query(
    collection(db, "pedidos"),
    where("status", "in", [STATUS_CONFIRMADO, STATUS_RECHAZADO]),
    where("fechaAutorizacion", ">=", hace30),
    orderBy("fechaAutorizacion", "desc"),
    limit(50)
  );
  _unsubHistorial = onSnapshot(q, snap => {
    _historial = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderHistorial();
  });
}

// ── Render pendientes ──────────────────────────────────────────────────────────
function _renderPendientes() {
  const wrap = document.getElementById("autPendientesWrap");
  if (!wrap) return;

  const lista = Object.values(_pendientes).sort((a, b) => (b.fechaPedido || 0) - (a.fechaPedido || 0));

  // Badge en header
  const badge = document.getElementById("autBadge");
  if (badge) {
    badge.style.display = lista.length ? "inline-block" : "none";
    badge.textContent = lista.length === 1 ? "1 pendiente" : `${lista.length} pendientes`;
  }

  if (lista.length === 0) {
    wrap.innerHTML = `<div class="empty-state">Sin pedidos pendientes de autorización.</div>`;
    return;
  }

  wrap.innerHTML = lista.map(p => `
    <div class="aut-card pendiente" id="aut-pend-${esc(p.id)}">
      <div class="aut-card-top">
        <div>
          <div class="aut-folio">${esc(p.folio || p.id)}</div>
          <div class="aut-meta">
            👤 ${esc(resolverNombre(p.ingenieroAlias))} &nbsp;·&nbsp;
            🏭 ${esc(p.clienteNombre || "–")} &nbsp;·&nbsp;
            📅 ${_fmtFecha(p.fechaPedido)} &nbsp;·&nbsp;
            ${esc(p.tipoVenta || "CONTADO")} · ${esc(p.tipoPedido || "VENTA_RUTA")}
          </div>
        </div>
        <div class="aut-total">${_fmtMXN(p.total)}</div>
      </div>
      ${p.motivoBloqueo ? `<div style="margin-top:2px"><span style="color:#DC2626;font-size:11px">🔒 ${esc(p.motivoBloqueo)}</span></div>` : ""}
      ${p.notas ? `<div class="aut-meta">📝 ${esc(p.notas)}</div>` : ""}
      <div id="aut-items-${esc(p.id)}" class="aut-items">
        <div class="aut-items-title">Productos</div>
        <div class="aut-items-loading" style="color:var(--text-sec);font-size:.78rem">Cargando…</div>
      </div>
      <div class="aut-actions">
        <button class="btn-success btn-sm" onclick="_autAprobar('${esc(p.id)}')">✓ Aprobar</button>
        <button class="aut-btn-danger btn-sm" onclick="_autRechazar('${esc(p.id)}')">✗ Rechazar</button>
      </div>
    </div>
  `).join("");

  lista.forEach(p => _cargarItems(p.id, `aut-items-${p.id}`));
}

// ── Render historial ───────────────────────────────────────────────────────────
function _renderHistorial() {
  const wrap = document.getElementById("autHistorialWrap");
  if (!wrap) return;

  if (_historial.length === 0) {
    wrap.innerHTML = `<div class="empty-state">Sin resoluciones en los últimos 30 días.</div>`;
    return;
  }

  wrap.innerHTML = _historial.map(p => {
    const esOk = p.status === STATUS_CONFIRMADO;
    return `
      <div class="aut-card ${esOk ? "confirmado" : "rechazado"}" style="margin-bottom:8px">
        <div class="aut-card-top">
          <div>
            <div class="aut-folio">${esc(p.folio || p.id)}</div>
            <div class="aut-meta">👤 ${esc(resolverNombre(p.ingenieroAlias))} · 🏭 ${esc(p.clienteNombre || "–")} · 📅 ${_fmtFecha(p.fechaPedido)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <span class="aut-total">${_fmtMXN(p.total)}</span>
            <span class="aut-pill ${esOk ? "ok" : "rec"}">${esOk ? "✓ Aprobado" : "✗ Rechazado"}</span>
          </div>
        </div>
        <div class="aut-resolucion">
          ${esOk
            ? `Aprobado por <b>${esc(p.autorizadoPor || "–")}</b> el ${_fmtFecha(p.fechaAutorizacion)}`
            : `Rechazado por <b>${esc(p.rechazadoPor || "–")}</b> el ${_fmtFecha(p.fechaAutorizacion)}${p.motivoRechazo ? ` · "${esc(p.motivoRechazo)}"` : ""}`
          }
        </div>
      </div>
    `;
  }).join("");
}

// ── Render items desde array incrustado en el pedido ──────────────────────────
function _cargarItems(pedidoId, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const p = _pendientes[pedidoId];
  const lineas = p?.items || p?.productos || [];
  if (!lineas.length) {
    el.innerHTML = '<div style="color:var(--text-sec);font-size:.78rem">Sin detalle de productos</div>';
    return;
  }
  const rows = lineas.map(it =>
    `<div class="aut-item-row">
      <span>${esc(it.nombre || it.nombreProducto || "–")} × ${it.cantidad || 0}</span>
      <span>${_fmtMXN((it.cantidad || 0) * (it.precio || 0))}</span>
    </div>`
  ).join("");
  el.innerHTML = `<div class="aut-items-title">Productos</div>${rows}`;
}

// ── Acciones ───────────────────────────────────────────────────────────────────
const _enProgreso = new Set();

window._autAprobar = async id => {
  if (_enProgreso.has(id)) return;
  const folio = _pendientes[id]?.folio || id;
  const ok = await window.modal({
    title: "Aprobar pedido",
    message: `¿Confirmas la aprobación del pedido ${folio}?`,
    confirmLabel: "Aprobar"
  });
  if (!ok) return;
  _enProgreso.add(id);
  try {
    const p = _pendientes[id];
    await updateDoc(doc(db, "pedidos", id), {
      status:           STATUS_CONFIRMADO,
      autorizadoPor:    Sesion.alias,
      fechaAutorizacion: Date.now(),
      updatedAt:        serverTimestamp()
    });
    logAudit("DESCUENTO_APROBADO", { folio: p?.folio || id, clienteNombre: p?.clienteNombre, total: p?.total, ingeniero: p?.ingenieroAlias });
  } catch (e) {
    window.toast?.("Error al aprobar. Intenta de nuevo.", "error");
  } finally {
    _enProgreso.delete(id);
  }
};

let _rechazandoId = null;
window._autRechazar = id => {
  _rechazandoId = id;
  const overlay = document.getElementById("autModalRechazo");
  if (!overlay) return;
  overlay.style.display = "flex";
  _regEsc(() => { overlay.style.display = "none"; _rechazandoId = null; _unregEsc(); });
  const motivoInput = document.getElementById("autMotivoInput");
  if (motivoInput) { motivoInput.value = ""; motivoInput.focus(); }

  document.getElementById("autBtnConfRechazo").onclick = async () => {
    const motivo = document.getElementById("autMotivoInput").value.trim();
    if (!motivo) { window.toast?.("Escribe el motivo de rechazo.", "error"); return; }
    try {
      const p = _pendientes[_rechazandoId];
      await updateDoc(doc(db, "pedidos", _rechazandoId), {
        status:           STATUS_RECHAZADO,
        rechazadoPor:     Sesion.alias,
        motivoRechazo:    motivo,
        fechaAutorizacion: Date.now(),
        updatedAt:        serverTimestamp()
      });
      logAudit("PEDIDO_CANCELADO", { folio: p?.folio || _rechazandoId, clienteNombre: p?.clienteNombre, total: p?.total, ingeniero: p?.ingenieroAlias, motivoRechazo: motivo });
      overlay.style.display = "none";
      _rechazandoId = null;
    } catch (e) {
      window.toast?.("Error al rechazar. Intenta de nuevo.", "error");
    }
  };
  document.getElementById("autBtnCancelRechazo").onclick = () => {
    overlay.style.display = "none";
    _rechazandoId = null;
  };
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _fmtMXN(n) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency", currency: "MXN",
    minimumFractionDigits: 0, maximumFractionDigits: 0
  }).format(n || 0);
}

function _fmtFecha(ts) {
  if (!ts) return "–";
  const d = typeof ts === "number" ? new Date(ts) : ts?.toDate?.() ?? new Date(ts);
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}
