// ══════════════════════════════════════════════════════════════
// pedidos.js — Historial de pedidos con filtros y detalle
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import {
  collection, query, orderBy, limit, where, onSnapshot, doc, updateDoc, getDoc,
  addDoc, getDocs, Timestamp, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { registrarVentaN10, revertirVentaN10 } from "./comisiones-n10-engine.js";
import { getIngenieros } from "./erp-cache.js";
import { logAudit, norm } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";

let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

let _unsub    = null;
let _filtroStatus  = "TODOS";
let _filtroAlias   = "TODOS";
let _pedidos  = [];

const STATUS = ["TODOS","BORRADOR","CONFIRMADO","EN_RUTA","ENTREGADO","FACTURADO","CANCELADO"];
const STATUS_COLOR = {
  BORRADOR:   "#9E9E9E", CONFIRMADO: "#1565C0", EN_RUTA:    "#E65100",
  ENTREGADO:  "#1B5E20", FACTURADO:  "#4527A0", CANCELADO:  "#B71C1C"
};
const fmt = new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" });
const fmtDt = d => new Date(d?.toDate?.() ?? d).toLocaleDateString("es-MX", { day:"numeric", month:"short", year:"numeric" });

export const PedidosModule = {
  mount(container) {
    cargarNombres();
    container.innerHTML = _html();
    document.getElementById("pd-tbody").innerHTML = window.skeleton?.(6, 7) ?? "";
    _bindUI();
    _escuchar();
    _precargarCaches(); // carga clientes y productos en background al abrir el módulo
    return () => this.destroy();
  },
  destroy() { _unsub?.(); _unsub = null; _pedidos = []; _filtroStatus = "TODOS"; _filtroAlias = "TODOS"; }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <div style="padding:0 0 20px">

    <!-- Controles -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
      padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
      box-shadow:var(--shadow)">
      <span style="font-size:11px;font-weight:700;color:var(--text-sec);text-transform:uppercase;
        letter-spacing:.04em">Estado:</span>
      ${STATUS.map(s => {
        const colors = {TODOS:"",BORRADOR:"#D97706",CONFIRMADO:"#2563EB",EN_RUTA:"#7C3AED",
          ENTREGADO:"#16A34A",FACTURADO:"#0E7490",CANCELADO:"#DC2626"};
        const c = colors[s] || "var(--text-sec)";
        return `<button class="filter-pill ${s==="TODOS"?"active":""}" data-status="${s}"
          onclick="PedidosUI.setStatus('${s}')"
          style="${s!=="TODOS"?`border-color:${c};color:${c}`:""}">
          ${s === "TODOS" ? "Todos" : s.replace(/_/g," ")}
        </button>`;}).join("")}
      <div style="flex:1"></div>
      <select id="pd-sel-alias" onchange="PedidosUI.setAlias(this.value)"
        style="border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:12px;
          background:var(--surface);color:var(--text-primary)">
        <option value="TODOS">Todos los ingenieros</option>
      </select>
      <button onclick="PedidosUI.nuevoPedido()"
        style="padding:7px 14px;background:#1B5E20;color:#fff;border:none;border-radius:6px;
          cursor:pointer;font-size:13px;font-weight:700">
        + Pedido
      </button>
    </div>

    <!-- Modal Nuevo Pedido -->
    <div id="pd-form-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);
      z-index:1001;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto">
      <div style="background:var(--surface);border-radius:16px;width:680px;max-width:100%;
        border:1px solid var(--border);box-shadow:0 8px 32px rgba(0,0,0,.22);margin:auto">
        <div id="pd-form-body" style="padding:24px"></div>
      </div>
    </div>

    <!-- KPIs rápidos -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px" id="pd-kpis">
      ${[
        {l:"Total",        id:"Total",        c:"var(--text-primary)"},
        {l:"Confirmados",  id:"Confirmados",  c:"#2563EB"},
        {l:"En ruta",      id:"Enruta",       c:"#7C3AED"},
        {l:"Entregados",   id:"Entregados",   c:"#16A34A"},
      ].map(({l,id,c}) =>
        `<div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
          padding:14px 16px;box-shadow:var(--shadow)">
          <div style="font-size:22px;font-weight:900;color:${c};font-variant-numeric:tabular-nums"
            id="pd-k-${id}">0</div>
          <div style="font-size:10px;font-weight:700;color:var(--text-sec);margin-top:3px;
            text-transform:uppercase;letter-spacing:.04em">${l}</div>
        </div>`).join("")}
    </div>

    <!-- Tabla -->
    <div style="background:var(--surface,#fff);border-radius:10px;border:1px solid var(--border,#E5E7EB);overflow:hidden;
      box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:var(--surface2,#F9FAFB);border-bottom:1px solid var(--border,#E5E7EB)">
              <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-primary)">FOLIO</th>
              <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-primary)">CLIENTE</th>
              <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-primary)">INGENIERO</th>
              <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-primary)">FECHA</th>
              <th style="padding:10px 14px;text-align:right;font-weight:700;color:var(--text-primary)">TOTAL</th>
              <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-primary)">STATUS</th>
              <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-primary)">TIPO</th>
            </tr>
          </thead>
          <tbody id="pd-tbody">
            <tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-muted)">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

// ── UI Bind ───────────────────────────────────────────────────
function _bindUI() {
  window._pedCancelar  = _cancelarPedido;
  window._pedEditar    = _editarPedido;
  window._pedAvanzar   = _avanzarStatus;
  window._pedEntregado = _marcarEntregado;
  window.PedidosUI = {
    setStatus(s) {
      _filtroStatus = s;
      document.querySelectorAll("[data-status]").forEach(b =>
        b.classList.toggle("active", b.dataset.status === s));
      _renderTabla();
    },
    setAlias(a) { _filtroAlias = a; _renderTabla(); },
    nuevoPedido() { _abrirFormPedido(); },
    cerrarFormPedido() {
      _unregEsc();
      const m = document.getElementById("pd-form-modal");
      if (m) m.style.display = "none";
      _pedidoLineas = [];
      _pedidoCliente = null;
    },
    buscarCliente(q) { _buscarClientePedido(q); },
    seleccionarCliente(id, nombre) { _seleccionarCliente(id, nombre); },
    buscarProducto(q) { _buscarProductoPedido(q); },
    agregarProducto(id, nombre, precio) { _agregarLinea(id, nombre, precio); },
    quitarLinea(idx) { _quitarLinea(idx); },
    confirmarPedido() { _confirmarPedido(); },
    _actualizarCantidad(idx, val) { _actualizarCantidadImpl(idx, val); },
    _actualizarPrecio(idx, val)   { _actualizarPrecioImpl(idx, val); },
    _cambiarCliente()              { _cambiarClienteImpl(); },
    async _filtrarIng(q) {
      const dd    = document.getElementById("pd-ing-dd");
      const input = document.getElementById("pd-ingeniero");
      if (!dd || !input) return;
      const ings = await getIngenieros();
      const filtrados = q
        ? ings.filter(a => norm(a).includes(norm(q)))
        : ings;
      if (!filtrados.length) { dd.style.display = "none"; return; }
      dd.innerHTML = filtrados.map(a =>
        `<div class="pd-ing-item" data-alias="${esc(a)}"
          style="padding:8px 12px;cursor:pointer;font-size:13px;color:var(--text-primary);
            border-bottom:1px solid var(--border)">${esc(a)}</div>`
      ).join("");
      dd.style.display = "block";
      dd.querySelectorAll(".pd-ing-item").forEach(el =>
        el.addEventListener("mousedown", ev => {
          ev.preventDefault();
          input.value = el.dataset.alias;
          dd.style.display = "none";
        }));
      input.onblur = () => setTimeout(() => { dd.style.display = "none"; }, 150);
    }
  };
}

// ── Firestore listener ────────────────────────────────────────
function _escuchar() {
  const q = query(collection(db, "pedidos"), orderBy("fechaPedido", "desc"), limit(500));
  _unsub = onSnapshot(q, snap => {
    _pedidos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Poblar selector de ingenieros
    const aliases = [...new Set(_pedidos.map(p => p.ingenieroAlias || p.vendedor || "–").filter(Boolean))].sort();
    const sel = document.getElementById("pd-sel-alias");
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = `<option value="TODOS">Todos los ingenieros</option>` +
        aliases.map(a => `<option value="${a}"${a === prev ? " selected" : ""}>${esc(resolverNombre(a))}</option>`).join("");
    }

    _renderTabla();
  }, err => {
    console.error("[Pedidos]", err);
    window.toast?.("Error al cargar pedidos.", "error");
  });
}

// ── Render ────────────────────────────────────────────────────
function _renderTabla() {
  let lista = _pedidos;
  if (_filtroStatus !== "TODOS") lista = lista.filter(p => p.status === _filtroStatus);
  if (_filtroAlias  !== "TODOS") lista = lista.filter(p => (p.ingenieroAlias || p.vendedor) === _filtroAlias);

  // KPIs
  _setText("pd-k-Total",        String(lista.length));
  _setText("pd-k-Confirmados",  String(lista.filter(p => p.status === "CONFIRMADO").length));
  _setText("pd-k-Enruta",       String(lista.filter(p => p.status === "EN_RUTA").length));
  _setText("pd-k-Entregados",   String(lista.filter(p => p.status === "ENTREGADO").length));

  const tbody = document.getElementById("pd-tbody");
  if (!tbody) return;
  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-muted)">
      Sin pedidos para este filtro.</td></tr>`;
    return;
  }
  const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  tbody.innerHTML = lista.map(p => {
    const color = STATUS_COLOR[p.status] ?? "#9E9E9E";
    return `<tr style="border-bottom:1px solid var(--border);cursor:pointer" data-id="${esc(p.id)}">
      <td style="padding:10px 14px;font-weight:700;font-variant-numeric:tabular-nums">${esc(p.folio || p.id)}</td>
      <td style="padding:10px 14px">${esc(p.clienteNombre || p.clienteId || "–")}</td>
      <td style="padding:10px 14px">${esc(resolverNombre(p.ingenieroAlias || p.vendedor))}</td>
      <td style="padding:10px 14px;color:var(--text-sec)">${p.fechaPedido ? fmtDt(p.fechaPedido) : "–"}</td>
      <td style="padding:10px 14px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums">
        ${fmt.format(p.total || 0)}</td>
      <td style="padding:10px 14px;text-align:center">
        <span style="font-size:9px;font-weight:800;padding:3px 8px;border-radius:8px;
          background:${color}1A;color:${color}">${esc(p.status?.replace(/_/g," ") || "–")}</span></td>
      <td style="padding:10px 14px;text-align:center;color:var(--text-sec);font-size:11px">
        ${esc(p.tipoVenta || "–")}</td>
    </tr>`;
  }).join("");

  // Click handler: expand/collapse fila de detalle (solo un listener por tbody)
  if (!tbody._detListenerAttached) {
  tbody.addEventListener("click", e => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id;
    const existing = tbody.querySelector(`tr.tr-detalle[data-for="${id}"]`);
    if (existing) { existing.remove(); return; }
    // Cerrar cualquier otro detalle abierto
    tbody.querySelectorAll("tr.tr-detalle").forEach(r => r.remove());
    const ped = _pedidos.find(p => p.id === id);
    if (!ped) return;
    const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
    const det = document.createElement("tr");
    det.className = "tr-detalle";
    det.dataset.for = id;

    const puedeEditar   = Sesion.esSuperAdmin?.() || ["GERENTE","ADMINISTRADOR"].includes(Sesion.rol);
    const puedeMesa     = puedeEditar || Sesion.rol === "MESA_CONTROL";
    const yaCancel      = ped.status === "CANCELADO";
    const yaFacturado   = ped.status === "FACTURADO";

    const itms = ped.items || ped.productos || [];
    const itmsHtml = itms.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px">
          <tr style="color:var(--text-sec)">
            <th style="text-align:left;padding:3px 6px;font-weight:600">Producto</th>
            <th style="text-align:center;padding:3px 6px;font-weight:600">Cant.</th>
            <th style="text-align:right;padding:3px 6px;font-weight:600">Precio</th>
            <th style="text-align:right;padding:3px 6px;font-weight:600">Subtotal</th>
          </tr>
          ${itms.map(it => `<tr>
            <td style="padding:3px 6px">${esc(it.nombre || it.producto || "–")}</td>
            <td style="padding:3px 6px;text-align:center">${it.cantidad ?? 1}</td>
            <td style="padding:3px 6px;text-align:right">$${(it.precio||0).toLocaleString("es-MX")}</td>
            <td style="padding:3px 6px;text-align:right;font-weight:700">
              $${((it.cantidad||1)*(it.precio||0)).toLocaleString("es-MX")}</td>
          </tr>`).join("")}
        </table>`
      : `<span style="color:var(--text-muted);font-size:11px">Sin detalle de productos</span>`;

    // ── Botones de workflow según status actual ─────────────────
    const btn = (txt, onclick, bg="#1D5C33") =>
      `<button onclick="${onclick}" style="font-size:11px;padding:4px 12px;
       background:${bg};color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600">${txt}</button>`;

    let acnsHtml;
    if (yaCancel) {
      acnsHtml = `<div style="margin-top:8px;font-size:11px;color:#B71C1C;font-weight:700">
        ✕ Cancelado${ped.motivoCancelacion ? ': ' + esc(ped.motivoCancelacion) : ''}</div>`;
    } else if (yaFacturado) {
      acnsHtml = `<div style="margin-top:8px;font-size:11px;color:#4527A0;font-weight:700">
        🧾 Facturado${ped.facturadoEn ? ' · ' + fmtDt(ped.facturadoEn) : ''}</div>`;
    } else {
      const btns = [];
      const s = ped.status;
      if (s === "BORRADOR"   && puedeEditar) btns.push(btn("✓ Confirmar",  `window._pedAvanzar('${esc(id)}','CONFIRMADO')`, "#1565C0"));
      if (s === "CONFIRMADO" && puedeMesa)   btns.push(btn("🚚 En ruta",   `window._pedAvanzar('${esc(id)}','EN_RUTA')`,    "#E65100"));
      if (s === "EN_RUTA"    && puedeMesa)   btns.push(btn("📦 Entregado", `window._pedEntregado('${esc(id)}')`,            "#1B5E20"));
      if (s === "ENTREGADO"  && puedeEditar) btns.push(btn("🧾 Facturado", `window._pedAvanzar('${esc(id)}','FACTURADO')`, "#4527A0"));
      if (puedeEditar) btns.push(btn("✏️ Cantidades", `window._pedEditar('${esc(id)}')`, "#374151"));
      if (puedeMesa)   btns.push(btn("✕ Cancelar",   `window._pedCancelar('${esc(id)}')`, "#DC2626"));
      acnsHtml = `<div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">${btns.join("")}</div>`;
    }

    det.innerHTML = `<td colspan="99" style="padding:12px 16px;background:var(--surface,#f8fafc)">
  <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#374151">
    <span><strong>Folio:</strong> ${esc(ped.folio || ped.id)}</span>
    <span><strong>Cliente:</strong> ${esc(ped.cliente || ped.clienteNombre || "–")}</span>
    <span><strong>Total:</strong> $${(ped.total||0).toLocaleString("es-MX",{minimumFractionDigits:2})}</span>
    <span><strong>Ingeniero:</strong> ${esc(resolverNombre(ped.ingeniero || ped.ingenieroAlias))}</span>
    ${ped.notas ? `<span><strong>Notas:</strong> ${esc(ped.notas)}</span>` : ""}
  </div>
  ${itmsHtml}
  ${acnsHtml}
</td>`;
    tr.insertAdjacentElement("afterend", det);
  });
  tbody._detListenerAttached = true;
  } // end if !_detListenerAttached
}

// ── Avanzar status ────────────────────────────────────────────
async function _avanzarStatus(pedidoId, nuevoStatus) {
  const labels = { CONFIRMADO:"confirmar", EN_RUTA:"marcar en ruta", FACTURADO:"marcar como facturado" };

  // Bloqueo de crédito al confirmar
  if (nuevoStatus === "CONFIRMADO") {
    const ped = _pedidos.find(p => p.id === pedidoId);
    const clienteId = ped?.clienteId;
    if (clienteId) {
      const cSnap = await getDoc(doc(db, "clientes", clienteId));
      if (cSnap.exists()) {
        const c = cSnap.data();
        const esGerente = Sesion.esSuperAdmin?.() || ["GERENTE","SUPER_ADMIN"].includes(Sesion.rol);
        const statusBloqueante = ["CRÍTICO","GRAVE"].includes(c.semaforoColor) || c.bloqueado;
        if (statusBloqueante && !esGerente) {
          const fmt = n => "$" + (n||0).toLocaleString("es-MX",{minimumFractionDigits:2});
          await window.modal?.({
            title:   "⛔ Crédito bloqueado",
            message: `${c.nombre || "Este cliente"} tiene semáforo ${c.semaforoColor ?? "bloqueado"}.\n` +
                     `Deuda: ${fmt(c.totalAPagarTotal ?? c.saldoPendiente)} (capital ${fmt(c.saldoCapitalTotal ?? c.saldoPendiente)} + interés ${fmt(c.interesTotal ?? 0)}).\n` +
                     `Solo GERENTE puede confirmar pedidos a clientes en mora crítica.`,
            confirm: "Entendido",
            cancel:  null,
            danger:  true,
          });
          // Enviar pedido a cola de autorización
          await updateDoc(doc(db, "pedidos", pedidoId), {
            status:       "PENDIENTE_AUTORIZACION",
            motivoBloqueo: "SEMAFORO_" + c.semaforoColor,
            bloqueadoPor:  Sesion.uid,
            _tsBloqueo:    serverTimestamp()
          });
          window.toast?.("Pedido enviado a autorización por semáforo " + c.semaforoColor, "warn");
          return;
        }
        if (statusBloqueante && esGerente) {
          const fmt = n => "$" + (n||0).toLocaleString("es-MX",{minimumFractionDigits:2});
          const autorizar = await window.modal?.({
            title:   "⚠️ Cliente con mora crítica",
            message: `${c.nombre || "Este cliente"} tiene semáforo ${c.semaforoColor ?? "bloqueado"}.\n` +
                     `Deuda total: ${fmt(c.totalAPagarTotal ?? c.saldoPendiente)}.\n` +
                     `Como GERENTE puedes autorizar excepcionalmente.`,
            confirm: "Autorizar excepción",
            cancel:  "Cancelar",
            danger:  true,
          });
          if (!autorizar) return;
        }
      }
    }
  }

  const ok = await window.modal?.({
    title:   "Cambiar status",
    message: `¿${labels[nuevoStatus] || nuevoStatus} el pedido?`,
    confirm: "Sí, continuar",
    cancel:  "Cancelar"
  });
  if (!ok) return;
  const campos = {
    status: nuevoStatus,
    [`${nuevoStatus.toLowerCase()}En`]: Date.now(),
    [`${nuevoStatus.toLowerCase()}Por`]: Sesion.alias || Sesion.uid
  };
  // Mapeo de campo timestamp según status
  if (nuevoStatus === "CONFIRMADO")  { campos.confirmadoEn  = Date.now(); campos.confirmadoPor  = Sesion.alias || Sesion.uid; }
  if (nuevoStatus === "EN_RUTA")     { campos.enRutaEn      = Date.now(); campos.enRutaPor      = Sesion.alias || Sesion.uid; }
  if (nuevoStatus === "FACTURADO")   { campos.facturadoEn   = Date.now(); campos.facturadoPor   = Sesion.alias || Sesion.uid; }
  try {
    await updateDoc(doc(db, "pedidos", pedidoId), campos);
    window.toast?.(`Pedido marcado como ${nuevoStatus.replace(/_/g," ")}`, "success");
    document.querySelector(`tr.tr-detalle[data-for="${pedidoId}"]`)?.remove();
  } catch(e) {
    console.error("[Pedidos] avanzar:", e);
    window.toast?.("Error: " + e.message, "error");
  }
}

async function _marcarEntregado(pedidoId) {
  const receptor = await window.promptModal?.({
    title:       "Confirmar entrega",
    label:       "¿Quién recibió el pedido?",
    placeholder: "Nombre del receptor…"
  });
  if (receptor === null) return;
  if (!receptor.trim()) { window.toast?.("Ingresa el nombre del receptor", "warning"); return; }
  const entregadoEn = Date.now();
  try {
    await updateDoc(doc(db, "pedidos", pedidoId), {
      status:       "ENTREGADO",
      entregadoEn,
      entregadoPor: Sesion.alias || Sesion.uid,
      recibioCon:   receptor.trim()
    });
    window.toast?.("Entrega confirmada", "success");
    document.querySelector(`tr.tr-detalle[data-for="${pedidoId}"]`)?.remove();
    const ped = _pedidos.find(p => p.id === pedidoId);
    // Registrar comisión N10 en background
    if (ped) _comisionN10Entrega({ ...ped, entregadoEn }).catch(e => console.warn("[N10 comision]", e));
    // Crear remisión de crédito si el pedido es a crédito
    if (ped) _crearRemisionCredito({ ...ped, entregadoEn, recibioCon: receptor.trim() }).catch(e => console.warn("[Remision]", e));
  } catch(e) {
    console.error("[Pedidos] entregado:", e);
    window.toast?.("Error: " + e.message, "error");
  }
}

/**
 * Calcula litros N10 del pedido y los registra en comisiones_n10.
 * Busca metadata de producto en la colección "inventario" si el item no la trae.
 */
async function _comisionN10Entrega(ped) {
  const items = ped.items || ped.productos || [];
  if (!items.length) return;

  let litrosN10 = 0;
  for (const it of items) {
    // Metadata ya embebida en el item (pedidos nuevos)
    if (it.familia === "N10" && it.litros_por_unidad > 0) {
      litrosN10 += (it.cantidad ?? 1) * it.litros_por_unidad;
      continue;
    }
    // Fallback: buscar en catálogo de productos y en inventario
    const pid = it.productoId || it.id;
    if (pid) {
      let prodData = null;
      // 1) Buscar en colección "productos" (catálogo principal — tiene familia y litros_por_unidad)
      try {
        const snapProd = await getDoc(doc(db, "productos", pid));
        if (snapProd.exists()) prodData = snapProd.data();
      } catch(_) {}
      // 2) Fallback: colección "inventario"
      if (!prodData) {
        try {
          const snapInv = await getDoc(doc(db, "inventario", pid));
          if (snapInv.exists()) prodData = snapInv.data();
        } catch(_) {}
      }
      if (prodData?.familia === "N10" && (prodData.litros_por_unidad ?? 0) > 0) {
        litrosN10 += (it.cantidad ?? 1) * prodData.litros_por_unidad;
      }
    }
  }

  if (litrosN10 <= 0) return;

  const uid   = ped.ingenieroUid || ped.uid || ped.vendedorUid;
  const alias = ped.ingenieroAlias || ped.vendedor || ped.ingeniero || "–";
  if (!uid) { console.warn("[N10] Sin UID de ingeniero en pedido", ped.id); return; }

  const res = await registrarVentaN10({
    uid, alias, litros: litrosN10,
    ventaId: ped.id,
    cliente: ped.clienteNombre || ped.cliente || "–",
    fecha:   new Date(ped.entregadoEn || Date.now()),
  });
  console.info(`[N10] +${litrosN10}L → Tramo ${res.tramo} | Comisión: $${res.comisionNueva}`);
}

/**
 * Crea automáticamente una nota en remisiones_credito cuando un pedido
 * con tipoPago === "credito" (o "CREDITO") es marcado como ENTREGADO.
 * Si ya existe una remisión para este pedido (pedidoId), no duplica.
 */
async function _crearRemisionCredito(ped) {
  const tipoPago = (ped.tipoPago || ped.condicionesPago || "").toString().toLowerCase();
  if (!tipoPago.includes("credito") && !tipoPago.includes("crédito")) return;

  const total = ped.total ?? ped.monto ?? 0;
  if (total <= 0) return;

  // Evitar duplicados: buscar si ya existe remisión para este pedidoId
  const existQ = await getDocs(query(
    collection(db, "remisiones_credito"),
    where("pedidoId", "==", ped.id),
    limit(1)
  ));
  if (!existQ.empty) return; // ya existe

  const uid   = ped.ingenieroUid || ped.uid || ped.vendedorUid || "";
  const alias = ped.ingenieroAlias || ped.vendedor || ped.ingeniero || "–";

  await addDoc(collection(db, "remisiones_credito"), {
    pedidoId:       ped.id,
    folio:          ped.folio || ped.id,
    clienteId:      ped.clienteId || ped.cliente_id || "",
    clienteNombre:  ped.clienteNombre || ped.cliente || "–",
    ingenieroUid:   uid,
    ingenieroAlias: alias,
    montoOriginal:  total,
    totalAbonado:   0,
    abonos:         [],
    status:         "ACTIVA",
    tipoPago:       ped.tipoPago || "CREDITO",
    diasCredito:    ped.diasCredito ?? 30,
    fechaCreacion:  serverTimestamp(),
    fechaVencimiento: new Date(Date.now() + (ped.diasCredito ?? 30) * 86400000),
    entregadoEn:    ped.entregadoEn || Date.now(),
    recibioCon:     ped.recibioCon || "",
    creadoPor:      Sesion.alias || Sesion.uid,
    _ts:            Date.now(),
  });
  console.info(`[Remision] Nota de crédito creada para pedido ${ped.folio || ped.id} — $${total}`);
}

// ── Cancelar pedido ───────────────────────────────────────────
async function _cancelarPedido(pedidoId) {
  const razon = await window.promptModal({ title: "Cancelar pedido", label: "Motivo de cancelación", placeholder: "Motivo…" });
  if (razon === null) return; // usuario canceló el diálogo
  if (!razon.trim()) { window.toast?.("Ingresa un motivo", "warning"); return; }

  const ped = _pedidos.find(p => p.id === pedidoId);
  try {
    await updateDoc(doc(db, "pedidos", pedidoId), {
      status:             "CANCELADO",
      motivoCancelacion:  razon.trim(),
      canceladoEn:        Date.now(),
      canceladoPor:       Sesion.alias || Sesion.uid || "–"
    });
    window.toast?.("Pedido cancelado", "success");
    document.querySelector(`tr.tr-detalle[data-for="${pedidoId}"]`)?.remove();
    // Revertir comisión N10 si el pedido ya estaba entregado
    if (ped?.status === "ENTREGADO") _comisionN10Revertir(ped).catch(e => console.warn("[N10 revert]", e));
  } catch(e) {
    console.error("[Pedidos] cancelar:", e);
    window.toast?.("Error: " + e.message, "error");
  }
}

async function _comisionN10Revertir(ped) {
  const items = ped.items || ped.productos || [];
  let litrosN10 = 0;
  for (const it of items) {
    if (it.familia === "N10" && it.litros_por_unidad > 0) {
      litrosN10 += (it.cantidad ?? 1) * it.litros_por_unidad;
      continue;
    }
    const pid = it.productoId || it.id;
    if (pid) {
      const snap = await getDoc(doc(db, "inventario", pid));
      if (snap.exists()) {
        const prod = snap.data();
        if (prod.familia === "N10" && prod.litros_por_unidad > 0) {
          litrosN10 += (it.cantidad ?? 1) * prod.litros_por_unidad;
        }
      }
    }
  }
  if (litrosN10 <= 0) return;
  const uid = ped.ingenieroUid || ped.uid || ped.vendedorUid;
  if (!uid) return;
  await revertirVentaN10({ uid, litros: litrosN10, ventaId: ped.id, fecha: new Date(ped.entregadoEn || Date.now()) });
  console.info(`[N10] Revertidos ${litrosN10}L de pedido cancelado ${ped.id}`);
}

// ── Editar cantidades de pedido ───────────────────────────────
function _editarPedido(pedidoId) {
  const ped = _pedidos.find(p => p.id === pedidoId);
  if (!ped) return;
  const items = ped.items || ped.productos || [];
  if (!items.length) { window.toast?.("Este pedido no tiene items editables", "info"); return; }

  // Modal inline
  const overlay = document.createElement("div");
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;
    display:flex;align-items:center;justify-content:center`;
  const modal = document.createElement("div");
  modal.style.cssText = `background:var(--surface,#fff);border-radius:12px;padding:20px;
    width:380px;max-width:95vw;max-height:80vh;overflow-y:auto;
    box-shadow:0 8px 32px rgba(0,0,0,.2)`;
  const esc2 = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  modal.innerHTML = `
    <div style="font-weight:800;font-size:14px;margin-bottom:12px">
      ✏️ Editar cantidades — ${esc2(ped.folio || ped.id)}</div>
    <div style="font-size:11px;color:var(--text-sec);margin-bottom:10px">
      Solo cantidades. Los precios requieren autorización especial.</div>
    ${items.map((it, i) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="flex:1;font-size:12px">${esc2(it.nombre || it.producto || "–")}</span>
        <input type="number" min="1" value="${it.cantidad || 1}" data-idx="${i}"
          style="width:64px;padding:4px 6px;border:1px solid #D1D5DB;border-radius:6px;
          font-size:12px;text-align:center" class="pd-edit-qty">
      </div>`).join("")}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button id="pd-edit-cancel" style="padding:6px 14px;border:1px solid #D1D5DB;border-radius:6px;
        background:none;cursor:pointer;font-size:12px">Cancelar</button>
      <button id="pd-edit-save" style="padding:6px 14px;background:#1D5C33;color:#fff;border:none;
        border-radius:6px;cursor:pointer;font-size:12px;font-weight:700">Guardar</button>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.querySelector("#pd-edit-cancel").onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.querySelector("#pd-edit-save").onclick = async () => {
    const newItems = items.map((it, i) => {
      const inp = overlay.querySelector(`.pd-edit-qty[data-idx="${i}"]`);
      const qty = Math.max(1, parseInt(inp?.value || it.cantidad || 1));
      return { ...it, cantidad: qty };
    });
    const newTotal = newItems.reduce((s, it) => s + (it.cantidad * (it.precio||0)), 0);
    try {
      await updateDoc(doc(db, "pedidos", pedidoId), {
        items:       newItems,
        productos:   newItems,
        total:       newTotal,
        editadoEn:   Date.now(),
        editadoPor:  Sesion.alias || Sesion.uid || "–"
      });
      window.toast?.("Pedido actualizado", "success");
      overlay.remove();
      document.querySelector(`tr.tr-detalle[data-for="${pedidoId}"]`)?.remove();
    } catch(e) {
      console.error("[Pedidos] editar:", e);
      window.toast?.("Error: " + e.message, "error");
    }
  };
}

function _setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

// ═══════════════════════════════════════════════════════════════
// NUEVO PEDIDO desde panel web
// ═══════════════════════════════════════════════════════════════
let _pedidoLineas  = [];
let _pedidoCliente = null;

// ── Pre-carga de caches ───────────────────────────────────────
async function _precargarCaches() {
  // Clientes
  if (!window._clientesCache?.length) {
    try {
      const snap = await getDocs(query(collection(db, "clientes"), limit(500)));
      window._clientesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(c => c.nombre)
        .sort((a, b) => (a.nombre||"").localeCompare(b.nombre||""));
    } catch(e) { console.warn("[Pedidos/clientes cache]", e); }
  }
  // Productos
  if (!window._productosCache?.length) {
    try {
      const snap = await getDocs(query(collection(db, "productos"), limit(500)));
      window._productosCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(p => p.nombre)
        .sort((a, b) => (a.nombre||"").localeCompare(b.nombre||""));
    } catch(e) { console.warn("[Pedidos/productos cache]", e); }
  }
}

function _pdinputStyle() {
  return `width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
    font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;`;
}

function _abrirFormPedido() {
  _pedidoLineas  = [];
  _pedidoCliente = null;
  const modal = document.getElementById("pd-form-modal");
  const body  = document.getElementById("pd-form-body");
  if (!modal || !body) return;
  _renderFormPedido(body);
  modal.style.display = "flex";
  _regEsc(() => PedidosUI.cerrarFormPedido());
}

function _renderFormPedido(body) {
  const lineasHtml = _pedidoLineas.length === 0
    ? `<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px">
        Sin productos aún</td></tr>`
    : _pedidoLineas.map((l, i) => `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px;font-size:12px">${esc(l.nombre)}</td>
        <td style="padding:8px 10px;text-align:center">
          <input type="number" min="1" value="${l.cantidad}"
            onchange="PedidosUI._actualizarCantidad(${i},this.value)"
            style="width:60px;text-align:center;padding:4px;border:1px solid var(--border);
              border-radius:4px;background:var(--surface);color:var(--text-primary)">
        </td>
        <td style="padding:8px 10px;text-align:right">
          <input type="number" min="0" step="0.01" value="${l.precio}"
            onchange="PedidosUI._actualizarPrecio(${i},this.value)"
            style="width:90px;text-align:right;padding:4px;border:1px solid var(--border);
              border-radius:4px;background:var(--surface);color:var(--text-primary)">
        </td>
        <td style="padding:8px 10px;text-align:right;font-weight:700;font-size:12px">
          $${(l.cantidad * l.precio).toLocaleString("es-MX",{minimumFractionDigits:2})}
        </td>
        <td style="padding:8px 10px;text-align:center">
          <button onclick="PedidosUI.quitarLinea(${i})"
            style="border:none;background:#FEE2E2;color:#DC2626;padding:3px 9px;border-radius:5px;cursor:pointer;font-size:11px">
            ✕
          </button>
        </td>
      </tr>`).join("");

  const total = _pedidoLineas.reduce((s, l) => s + l.cantidad * l.precio, 0);

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
      <div style="font-size:16px;font-weight:800;color:var(--text-primary)">📋 Nuevo Pedido</div>
      <button onclick="PedidosUI.cerrarFormPedido()"
        style="border:none;background:transparent;font-size:20px;cursor:pointer;color:var(--text-muted)">✕</button>
    </div>

    <!-- Paso 1: Cliente -->
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:800;color:var(--text-sec);letter-spacing:.06em;
        text-transform:uppercase;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:10px">
        👤 Paso 1 — Cliente
      </div>
      ${_pedidoCliente
        ? `<div style="display:flex;align-items:center;gap:10px;background:var(--surface-2);
              padding:10px 14px;border-radius:8px;border:1px solid var(--border)">
            <span style="font-size:13px;font-weight:700;color:var(--text-primary)">
              ✅ ${esc(_pedidoCliente.nombre)}
            </span>
            <span style="font-size:11px;color:var(--text-sec)">${esc(_pedidoCliente.ingeniero||"")}</span>
            <button onclick="PedidosUI._cambiarCliente()"
              style="margin-left:auto;font-size:11px;border:1px solid var(--border);
                background:transparent;padding:3px 10px;border-radius:5px;cursor:pointer;color:var(--text-sec)">
              Cambiar
            </button>
          </div>`
        : `<div style="position:relative">
            <input id="pd-cli-search" type="text" placeholder="Buscar cliente por nombre…"
              oninput="PedidosUI.buscarCliente(this.value)"
              onblur="setTimeout(()=>{const d=document.getElementById('pd-cli-results');if(d)d.style.display='none'},150)"
              style="${_pdinputStyle()}">
            <div id="pd-cli-results" style="display:none;position:absolute;left:0;right:0;top:100%;
              background:var(--surface);border:1px solid var(--border);border-radius:8px;
              max-height:220px;overflow-y:auto;z-index:10;
              box-shadow:0 8px 24px rgba(0,0,0,.15);margin-top:3px"></div>
          </div>`}
    </div>

    <!-- Paso 2: Productos -->
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:800;color:var(--text-sec);letter-spacing:.06em;
        text-transform:uppercase;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:10px">
        📦 Paso 2 — Productos
      </div>
      <div style="position:relative;margin-bottom:10px">
        <input id="pd-prod-search" type="text" placeholder="Buscar producto por nombre o código…"
          oninput="PedidosUI.buscarProducto(this.value)"
          onblur="setTimeout(()=>{const d=document.getElementById('pd-prod-results');if(d)d.style.display='none'},150)"
          style="${_pdinputStyle()}">
        <div id="pd-prod-results" style="display:none;position:absolute;left:0;right:0;top:100%;
          background:var(--surface);border:1px solid var(--border);border-radius:8px;
          max-height:220px;overflow-y:auto;z-index:10;
          box-shadow:0 8px 24px rgba(0,0,0,.15);margin-top:3px"></div>
      </div>
      <div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:var(--surface-2);border-bottom:1px solid var(--border)">
              <th style="padding:8px 10px;text-align:left;font-weight:700;color:var(--text-sec)">Producto</th>
              <th style="padding:8px 10px;text-align:center;font-weight:700;color:var(--text-sec)">Cant.</th>
              <th style="padding:8px 10px;text-align:right;font-weight:700;color:var(--text-sec)">Precio</th>
              <th style="padding:8px 10px;text-align:right;font-weight:700;color:var(--text-sec)">Subtotal</th>
              <th style="padding:8px 10px;width:40px"></th>
            </tr>
          </thead>
          <tbody>${lineasHtml}</tbody>
        </table>
      </div>
      ${_pedidoLineas.length > 0
        ? `<div style="text-align:right;font-size:16px;font-weight:800;color:var(--text-primary);
              padding:10px 14px">
            TOTAL: $${total.toLocaleString("es-MX",{minimumFractionDigits:2})}
          </div>`
        : ""}
    </div>

    <!-- Paso 3: Detalles -->
    <div style="margin-bottom:18px">
      <div style="font-size:11px;font-weight:800;color:var(--text-sec);letter-spacing:.06em;
        text-transform:uppercase;border-bottom:1px solid var(--border);padding-bottom:6px;margin-bottom:10px">
        📝 Paso 3 — Detalles
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">
            Ingeniero asignado
          </div>
          <div style="position:relative">
            <input id="pd-ingeniero" style="${_pdinputStyle()}" autocomplete="off"
              value="${esc(_pedidoCliente?.ingeniero || '')}"
              oninput="PedidosUI._filtrarIng(this.value)"
              onfocus="PedidosUI._filtrarIng(this.value)"
              placeholder="Buscar ingeniero…">
            <div id="pd-ing-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
              background:var(--surface);border:1px solid var(--border);border-radius:6px;
              max-height:140px;overflow-y:auto;z-index:20;box-shadow:0 4px 12px rgba(0,0,0,.3)"></div>
          </div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">
            Tipo de venta
          </div>
          <select id="pd-tipo" style="${_pdinputStyle()}">
            ${["Contado","Crédito"].map(t =>
              `<option>${t}</option>`).join("")}
          </select>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">
            Condiciones de pago
          </div>
          <input id="pd-condpago" style="${_pdinputStyle()}" placeholder="Ej: Crédito 30 días">
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">
            Fecha de entrega estimada
          </div>
          <input id="pd-fecha-entrega" type="date" style="${_pdinputStyle()}">
        </div>
      </div>
      <div style="margin-top:10px">
        <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">
          Notas del pedido
        </div>
        <textarea id="pd-notas" rows="2" style="${_pdinputStyle()}resize:vertical;"
          placeholder="Instrucciones especiales, referencias…"></textarea>
      </div>
    </div>

    <!-- Confirmar -->
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button onclick="PedidosUI.cerrarFormPedido()"
        style="padding:9px 20px;border:1px solid var(--border);border-radius:6px;
          background:transparent;color:var(--text-sec);font-size:13px;cursor:pointer">
        Cancelar
      </button>
      <button onclick="PedidosUI.confirmarPedido()"
        style="padding:9px 26px;border:none;border-radius:6px;
          background:#1B5E20;color:#fff;font-size:13px;font-weight:700;cursor:pointer"
        id="pd-btn-confirmar">
        ✅ Confirmar pedido
      </button>
    </div>`;
}

function _reRenderFormPedido() {
  const body = document.getElementById("pd-form-body");
  if (body) _renderFormPedido(body);
}

async function _buscarClientePedido(q) {
  const res = document.getElementById("pd-cli-results");
  if (!res) return;
  if (!q || q.length < 2) { res.style.display = "none"; res.innerHTML = ""; return; }
  // Si el cache está vacío, intentar cargarlo ahora
  if (!window._clientesCache?.length) await _precargarCaches();
  const qLow = norm(q);
  const lista = (window._clientesCache || []).filter(c =>
    norm(c.nombre).includes(qLow) ||
    norm(c.telefono).includes(qLow) ||
    norm(c.clienteId).includes(qLow)
  ).slice(0, 10);

  if (!lista.length) {
    res.innerHTML = `<div style="padding:10px 14px;font-size:12px;color:#9CA3AF">Sin resultados para "${esc(q)}"</div>`;
    res.style.display = "block";
    return;
  }
  res.innerHTML = lista.map(c =>
    `<div class="pd-dd-cli" data-id="${esc(c.id)}" data-nombre="${esc(c.nombre)}"
      style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);
        font-size:12px;color:var(--text-primary);display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${esc(c.nombre)}
        </div>
        ${c.zona ? `<div style="font-size:10px;color:#9CA3AF">${esc(c.zona)}</div>` : ""}
      </div>
      ${c.ingeniero ? `<span style="font-size:11px;color:#2563EB;font-weight:600;flex-shrink:0">${esc(c.ingeniero)}</span>` : ""}
    </div>`
  ).join("");
  res.style.display = "block";
  // Event delegation — evita onclick inline
  res.querySelectorAll(".pd-dd-cli").forEach(el => {
    el.addEventListener("mouseenter", () => el.style.background = "var(--surface-2)");
    el.addEventListener("mouseleave", () => el.style.background = "");
    el.addEventListener("mousedown", e => {
      e.preventDefault();
      _seleccionarCliente(el.dataset.id, el.dataset.nombre);
    });
  });
}

function _seleccionarCliente(id, nombre) {
  const c = (window._clientesCache || []).find(x => x.id === id) || { id, nombre };
  _pedidoCliente = { id: c.id, nombre: c.nombre, ingeniero: c.ingeniero || "" };
  _reRenderFormPedido();
}

async function _buscarProductoPedido(q) {
  const res = document.getElementById("pd-prod-results");
  if (!res) return;
  if (!q || q.length < 2) { res.style.display = "none"; res.innerHTML = ""; return; }
  if (!window._productosCache?.length) await _precargarCaches();
  const qLow = norm(q);
  const lista = (window._productosCache || []).filter(p =>
    norm(p.nombre).includes(qLow) ||
    norm(p.codigoN10 || p.codigo).includes(qLow) ||
    norm(p.codigoN10 || p.codigo || p.numero).includes(qLow)
  ).slice(0, 10);

  if (!lista.length) {
    res.innerHTML = `<div style="padding:10px 14px;font-size:12px;color:#9CA3AF">Sin productos para "${esc(q)}"</div>`;
    res.style.display = "block";
    return;
  }
  res.innerHTML = lista.map(p => {
    const precio = p.precioBase ?? p.precio_base ?? p.precio ?? 0;
    const codigo = p.codigoN10 || p.codigo || p.numero || "";
    return `<div class="pd-dd-prod"
      data-id="${esc(p.id)}" data-nombre="${esc(p.nombre)}" data-precio="${precio}"
      style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);
        font-size:12px;color:var(--text-primary);display:flex;align-items:center;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${esc(p.nombre)}
        </div>
        ${codigo ? `<div style="font-size:10px;color:#9CA3AF">${esc(codigo)}</div>` : ""}
      </div>
      <span style="font-weight:800;color:#2563EB;flex-shrink:0;font-variant-numeric:tabular-nums">
        $${precio.toLocaleString("es-MX",{minimumFractionDigits:2})}
      </span>
    </div>`;
  }).join("");
  res.style.display = "block";
  res.querySelectorAll(".pd-dd-prod").forEach(el => {
    el.addEventListener("mouseenter", () => el.style.background = "var(--surface-2)");
    el.addEventListener("mouseleave", () => el.style.background = "");
    el.addEventListener("mousedown", e => {
      e.preventDefault();
      _agregarLinea(el.dataset.id, el.dataset.nombre, el.dataset.precio);
    });
  });
}

function _agregarLinea(productoId, nombre, precio) {
  const existing = _pedidoLineas.find(l => l.productoId === productoId);
  if (existing) { existing.cantidad++; }
  else { _pedidoLineas.push({ productoId, nombre, precio: Number(precio) || 0, cantidad: 1 }); }
  const res = document.getElementById("pd-prod-results");
  if (res) res.innerHTML = "";
  const inp = document.getElementById("pd-prod-search");
  if (inp) inp.value = "";
  _reRenderFormPedido();
}

function _quitarLinea(idx) {
  _pedidoLineas.splice(idx, 1);
  _reRenderFormPedido();
}

// Estos métodos se agregan a PedidosUI en _bindUI(); aquí son las implementaciones
function _actualizarCantidadImpl(idx, val) {
  if (_pedidoLineas[idx]) { _pedidoLineas[idx].cantidad = Math.max(1, parseInt(val) || 1); _reRenderFormPedido(); }
}
function _actualizarPrecioImpl(idx, val) {
  if (_pedidoLineas[idx]) { _pedidoLineas[idx].precio = parseFloat(val) || 0; _reRenderFormPedido(); }
}
function _cambiarClienteImpl() {
  _pedidoCliente = null; _reRenderFormPedido();
}

async function _confirmarPedido() {
  if (!_pedidoCliente) { window.toast?.("Selecciona un cliente.", "warn"); return; }
  if (!_pedidoLineas.length) { window.toast?.("Agrega al menos un producto.", "warn"); return; }

  const btn = document.getElementById("pd-btn-confirmar");
  if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }

  const total   = _pedidoLineas.reduce((s, l) => s + l.cantidad * l.precio, 0);
  const ingeniero = (document.getElementById("pd-ingeniero")?.value || "").trim();
  if (!ingeniero) { window.toast?.("Selecciona un ingeniero asignado.", "warn"); if (btn) { btn.disabled = false; btn.textContent = "✅ Confirmar pedido"; } return; }

  // Folio único con contador atómico
  const contadorRef = doc(db, "config", "contadores");
  let folio;
  try {
    folio = await runTransaction(db, async tx => {
      const snap = await tx.get(contadorRef);
      const n = (snap.exists() ? (snap.data().pedidos || 0) : 0) + 1;
      tx.set(contadorRef, { pedidos: n }, { merge: true });
      return "W-" + String(n).padStart(5, "0");
    });
  } catch(e) {
    folio = "W-" + Date.now().toString(36).toUpperCase(); // fallback
  }

  const payload = {
    folio,
    clienteId:       _pedidoCliente.id,
    clienteNombre:   _pedidoCliente.nombre,
    cliente:         _pedidoCliente.nombre,
    ingenieroAlias:  ingeniero,
    vendedor:        ingeniero,
    items:           _pedidoLineas.map(l => ({ ...l })),
    productos:       _pedidoLineas.map(l => ({ ...l })),
    total,
    tipoVenta:       document.getElementById("pd-tipo")?.value || "Contado",
    condicionesPago: document.getElementById("pd-condpago")?.value || "",
    notas:           document.getElementById("pd-notas")?.value?.trim() || "",
    fechaEntrega:    document.getElementById("pd-fecha-entrega")?.value || null,
    status:          "CONFIRMADO",
    origen:          "web",
    fechaPedido:     serverTimestamp(),
    creadoEn:        serverTimestamp(),
    creadoPor:       Sesion.alias ?? "web",
    confirmadoEn:    Date.now(),
    confirmadoPor:   Sesion.alias ?? "web",
  };

  try {
    const ref = await addDoc(collection(db, "pedidos"), payload);
    logAudit("PEDIDO_CONFIRMADO", { folio, pedidoId: ref.id, clienteId: payload.clienteId, total, ingeniero });
    window.toast?.(`✅ Pedido ${folio} creado y confirmado.`, "success");
    window.PedidosUI.cerrarFormPedido();
  } catch(e) {
    window.toast?.("Error al crear pedido: " + e.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "✅ Confirmar pedido"; }
  }
}
