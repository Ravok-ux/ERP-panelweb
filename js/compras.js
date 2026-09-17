// ══════════════════════════════════════════════════════════════
// compras.js — Órdenes de compra a proveedores
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { esc, norm } from "./app.js";
import { Sesion } from "./auth.js";
import {
  collection, doc, onSnapshot, updateDoc, addDoc, getDoc, getDocs,
  query, orderBy, serverTimestamp, writeBatch, increment, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmtMXN = v => new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" }).format(v || 0);
const fmtFecha = ts => {
  if (!ts) return "–";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("es-MX", { day:"2-digit", month:"short", year:"numeric" });
};

const STATUS_COLOR = {
  BORRADOR:  "#FBBF24",
  ENVIADA:   "#60A5FA",
  RECIBIDA:  "#4ADE80",
  PARCIAL:   "#FB923C",
  CANCELADA: "#EF4444"
};

let _unsubs = [];

export const ComprasModule = {
  mount(container) {
    if (!Sesion.esSuperAdmin() && !["GERENTE","ADMINISTRADOR","ALMACENISTA"].includes(Sesion.rol)) {
      container.innerHTML = `
        <div class="empty-state" style="flex:1;justify-content:center">
          <div class="empty-state-icon">🔒</div>
          <div class="empty-state-title">Acceso restringido</div>
        </div>`;
      return;
    }
    container.innerHTML = _html();
    _bindAcciones();
    _escucharOC();
    return () => this.destroy();
  },

  destroy() {
    _unsubs.forEach(fn => fn && fn());
    _unsubs = [];
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  const statusOpts = ["BORRADOR","ENVIADA","PARCIAL","RECIBIDA","CANCELADA"];
  return `
  <div style="display:flex;flex-direction:column;height:100%">

    <!-- Header + filtros -->
    <div style="display:flex;align-items:center;gap:10px;padding:14px 20px;
      border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap">
      <div>
        <div style="font-size:13px;font-weight:800;color:var(--text-primary)">Órdenes de compra</div>
        <div style="font-size:10.5px;color:#9CA3AF" id="oc-subtitle">Cargando…</div>
      </div>
      <div style="flex:1"></div>

      <!-- Filtro status -->
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="oc-filter active" data-status=""
          style="font-size:11px;font-weight:700;border-radius:5px;padding:4px 10px;cursor:pointer;
            border:1px solid var(--border);background:var(--surface);color:var(--text-primary)">
          Todas
        </button>
        ${statusOpts.map(s => `
          <button class="oc-filter" data-status="${s}"
            style="font-size:11px;font-weight:700;border-radius:5px;padding:4px 10px;cursor:pointer;
              border:1px solid ${STATUS_COLOR[s]}44;background:${STATUS_COLOR[s]}11;color:${STATUS_COLOR[s]}">
            ${s}
          </button>`).join("")}
      </div>

      ${Sesion.esSuperAdmin() || Sesion.rol === "ADMINISTRADOR" ? `
      <button onclick="ComprasUI.nuevaOC()"
        style="background:#166534;border:1px solid #16A34A;border-radius:7px;padding:7px 14px;
          font-size:11.5px;font-weight:700;color:#4ADE80;cursor:pointer">
        + Nueva OC
      </button>` : ""}
    </div>

    <!-- KPIs -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;flex-shrink:0;
      border-bottom:1px solid var(--border)">
      ${[
        ["Total OCs",    "oc-kpi-total",   "#9CA3AF"],
        ["Borradores",   "oc-kpi-bor",     "#FBBF24"],
        ["En tránsito",  "oc-kpi-env",     "#60A5FA"],
        ["Monto total",  "oc-kpi-monto",   "#4ADE80"]
      ].map(([label, id, color]) => `
        <div style="padding:14px 20px;border-right:1px solid var(--border)">
          <div style="font-size:10px;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">${label}</div>
          <div id="${id}" style="font-size:20px;font-weight:800;color:${color}">–</div>
        </div>`).join("")}
    </div>

    <!-- Lista -->
    <div style="flex:1;overflow-y:auto;padding:12px 20px">
      <div id="oc-list">
        <div style="color:#9CA3AF;font-size:12px;text-align:center;padding:40px">Cargando…</div>
      </div>
    </div>
  </div>

  <!-- Modal: nueva OC -->
  <div id="modal-oc" class="modal-overlay hidden">
    <div class="modal" style="max-width:480px">
      <div class="modal-title">Nueva orden de compra</div>
      <div class="form-group">
        <label class="form-label">Proveedor</label>
        <input id="oc-proveedor-search" type="text" class="form-input" placeholder="Buscar o escribir proveedor…"
          autocomplete="off" oninput="ComprasUI._filtrarProveedores(this.value)">
        <input id="oc-proveedor" type="hidden" value="">
        <div id="oc-prov-dropdown" style="display:none;position:absolute;left:0;right:0;
          background:var(--surface,#1F2937);border:1px solid var(--border);border-radius:6px;
          max-height:150px;overflow-y:auto;z-index:20;box-shadow:0 4px 12px rgba(0,0,0,.3)"></div>
      </div>
      <div class="form-group">
        <label class="form-label">Notas / referencia</label>
        <textarea id="oc-notas" class="form-input" rows="3" placeholder="Detalles del pedido…"></textarea>
      </div>
      <div style="font-size:10px;color:#9CA3AF;margin-bottom:12px">
        Los productos y cantidades se agregan desde el APK al confirmar la recepción.
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="ComprasUI.cerrarModal()">Cancelar</button>
        <button class="btn-primary" style="width:auto;padding:8px 20px"
          onclick="ComprasUI.guardarOC()">Crear OC</button>
      </div>
    </div>
  </div>

  <!-- Modal: detalle OC -->
  <div id="modal-oc-detalle" class="modal-overlay hidden">
    <div class="modal" style="max-width:600px">
      <div class="modal-title" id="oc-det-title">Detalle OC</div>
      <div id="oc-det-body" style="margin-bottom:16px"></div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="ComprasUI.cerrarModal()">Cerrar</button>
        <span id="oc-det-acciones"></span>
      </div>
    </div>
  </div>`;
}

// ── Listener Firestore ─────────────────────────────────────────
function _escucharOC() {
  const q = query(collection(db, "ordenes_compra"), orderBy("fechaCreacion", "desc"));
  let _filtroStatus = "";

  const unsub = onSnapshot(q, snap => {
    const elSub  = document.getElementById("oc-subtitle");
    const elList = document.getElementById("oc-list");
    if (!elList) return;

    const todas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const visibles = _filtroStatus ? todas.filter(o => o.status === _filtroStatus) : todas;

    if (elSub) elSub.textContent = `${todas.length} órdenes`;

    // KPIs
    _setText("oc-kpi-total", todas.length);
    _setText("oc-kpi-bor",   todas.filter(o => o.status === "BORRADOR").length);
    _setText("oc-kpi-env",   todas.filter(o => ["ENVIADA","PARCIAL"].includes(o.status)).length);
    _setText("oc-kpi-monto", fmtMXN(todas.reduce((s, o) => s + (o.total || 0), 0)));

    if (visibles.length === 0) {
      elList.innerHTML = `<div style="color:#9CA3AF;font-size:12px;text-align:center;padding:40px">
        ${_filtroStatus ? `Sin OCs con status ${_filtroStatus}` : "Sin órdenes de compra"}</div>`;
      return;
    }

    elList.innerHTML = visibles.map(oc => {
      const sc = STATUS_COLOR[oc.status] || "#9CA3AF";
      return `
        <div onclick="ComprasUI.verDetalle('${oc.id}')"
          style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
            padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:border-color .15s"
          onmouseenter="this.style.borderColor='${sc}'" onmouseleave="this.style.borderColor='var(--border)'">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <div style="flex:1;font-size:13px;font-weight:700;color:var(--text-primary)">${oc.folio || oc.id}</div>
            <div style="font-size:11px;font-weight:700;color:${sc};background:${sc}22;
              border-radius:4px;padding:2px 8px">${oc.status}</div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-size:12px;color:#9CA3AF">${esc(oc.proveedorNombre || oc.proveedor || "–")}</div>
              <div style="font-size:10px;color:#6B7280;margin-top:2px">
                Creada: ${fmtFecha(oc.fechaCreacion)} · Por: ${esc(oc.creadoPor || "–")}
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:14px;font-weight:800;color:#4ADE80">${fmtMXN(oc.total)}</div>
              <div style="font-size:10px;color:#6B7280">${(oc.items || []).length} producto(s)</div>
            </div>
          </div>
        </div>`;
    }).join("");

    // Filtro buttons
    document.querySelectorAll(".oc-filter").forEach(btn => {
      btn.addEventListener("click", () => {
        _filtroStatus = btn.dataset.status;
        document.querySelectorAll(".oc-filter").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        // Re-render con mismo snap
        const vis = _filtroStatus ? todas.filter(o => o.status === _filtroStatus) : todas;
        // trigger re-render via fake click (simplest approach: just call update)
        _renderLista(elList, vis, _filtroStatus);
      });
    });

  }, err => {
    console.error("[Compras]", err);
    window.toast?.("Error al cargar órdenes de compra", "error");
  });
  _unsubs.push(unsub);
}

function _renderLista(el, visibles, filtroStatus) {
  if (visibles.length === 0) {
    el.innerHTML = `<div style="color:#9CA3AF;font-size:12px;text-align:center;padding:40px">
      ${filtroStatus ? `Sin OCs con status ${filtroStatus}` : "Sin órdenes de compra"}</div>`;
    return;
  }
  el.innerHTML = visibles.map(oc => {
    const sc = STATUS_COLOR[oc.status] || "#9CA3AF";
    return `
      <div onclick="ComprasUI.verDetalle('${oc.id}')"
        style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
          padding:12px 14px;margin-bottom:8px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <div style="flex:1;font-size:13px;font-weight:700;color:var(--text-primary)">${oc.folio || oc.id}</div>
          <div style="font-size:11px;font-weight:700;color:${sc};background:${sc}22;
            border-radius:4px;padding:2px 8px">${oc.status}</div>
        </div>
        <div style="font-size:12px;color:#9CA3AF">${esc(oc.proveedorNombre || oc.proveedor || "–")} · ${fmtFecha(oc.fechaCreacion)}</div>
        <div style="font-size:14px;font-weight:800;color:#4ADE80;margin-top:4px">${fmtMXN(oc.total)}</div>
      </div>`;
  }).join("");
}

// ── Acciones ──────────────────────────────────────────────────
function _bindAcciones() {
  window.ComprasUI = {

    async nuevaOC() {
      document.getElementById("modal-oc").classList.remove("hidden");
      document.getElementById("oc-proveedor-search").value = "";
      document.getElementById("oc-proveedor").value = "";
      // Cargar proveedores únicos de OCs anteriores + colección proveedores
      try {
        const [snapOC, snapProv] = await Promise.all([
          getDocs(collection(db, "ordenes_compra")),
          getDocs(collection(db, "proveedores")).catch(() => ({ docs: [] }))
        ]);
        const deOC = [...new Set(snapOC.docs.map(d => d.data().proveedorNombre || d.data().proveedor).filter(Boolean))];
        const deProv = snapProv.docs.map(d => d.data().nombre).filter(Boolean);
        window._proveedoresList = [...new Set([...deProv, ...deOC])].sort();
      } catch { window._proveedoresList = []; }
    },

    _filtrarProveedores(q) {
      const search = document.getElementById("oc-proveedor-search");
      const hidden = document.getElementById("oc-proveedor");
      const dd     = document.getElementById("oc-prov-dropdown");
      if (!search || !hidden || !dd) return;
      hidden.value = search.value;
      const qn   = norm(q);
      const lista = (window._proveedoresList || []).filter(p => norm(p).includes(qn));
      if (!qn || !lista.length) { dd.style.display = "none"; return; }
      dd.innerHTML = lista.slice(0, 15).map(p =>
        `<div class="oc-dd-item" data-nombre="${esc(p)}"
          style="padding:7px 10px;cursor:pointer;font-size:12px;color:var(--text-primary,#F9FAFB);
            border-bottom:1px solid var(--border)">${esc(p)}</div>`
      ).join("");
      dd.style.display = "block";
      dd.querySelectorAll(".oc-dd-item").forEach(el =>
        el.addEventListener("mousedown", ev => {
          ev.preventDefault();
          search.value = el.dataset.nombre;
          hidden.value = el.dataset.nombre;
          dd.style.display = "none";
        }));
      search.onblur = () => setTimeout(() => { dd.style.display = "none"; }, 150);
    },

    cerrarModal() {
      document.querySelectorAll(".modal-overlay").forEach(m => m.classList.add("hidden"));
    },

    async guardarOC() {
      const proveedor = document.getElementById("oc-proveedor").value.trim();
      const notas     = document.getElementById("oc-notas").value.trim();
      if (!proveedor) { window.toast?.("Nombre del proveedor requerido", "error"); return; }

      const folio = "OC-WEB-" + Date.now().toString().slice(-6);
      try {
        await addDoc(collection(db, "ordenes_compra"), {
          folio,
          proveedor,
          proveedorNombre: proveedor,
          notas,
          status: "BORRADOR",
          total: 0,
          items: [],
          creadoPor: Sesion.alias || Sesion.uid,
          fechaCreacion: serverTimestamp()
        });
        window.toast?.(`OC ${folio} creada`, "success");
        this.cerrarModal();
      } catch (e) {
        const msg = /permission|PERMISSION/.test(e.message || "")
          ? "Sin permisos para realizar esta acción."
          : "Error al guardar. Verifica tu conexión e intenta de nuevo.";
        window.toast?.(msg, "error");
      }
    },

    async verDetalle(ocId) {
      const { getDoc, doc: fsDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const snap = await getDoc(fsDoc(db, "ordenes_compra", ocId));
      if (!snap.exists()) return;
      const oc = snap.data();
      const sc = STATUS_COLOR[oc.status] || "#9CA3AF";

      document.getElementById("oc-det-title").textContent =
        `${oc.folio || ocId} · ${oc.proveedorNombre || oc.proveedor || "–"}`;

      const items = (oc.items || []).map(it => `
        <tr>
          <td style="padding:6px 8px">${esc(it.nombreProducto || it.nombre || "–")}</td>
          <td style="padding:6px 8px;text-align:right">${it.cantidad} ${it.unidad || ""}</td>
          <td style="padding:6px 8px;text-align:right">${fmtMXN(it.precioUnitario)}</td>
          <td style="padding:6px 8px;text-align:right">${fmtMXN(it.subtotal)}</td>
        </tr>`).join("");

      document.getElementById("oc-det-body").innerHTML = `
        <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap">
          <span style="font-size:12px;color:${sc};font-weight:700;background:${sc}22;
            border-radius:4px;padding:3px 10px">${oc.status}</span>
          <span style="font-size:11px;color:#9CA3AF">Creada: ${fmtFecha(oc.fechaCreacion)}</span>
          <span style="font-size:11px;color:#9CA3AF">Por: ${esc(oc.creadoPor || "–")}</span>
        </div>
        ${oc.notas ? `<div style="font-size:11px;color:#9CA3AF;margin-bottom:10px">📝 ${esc(oc.notas)}</div>` : ""}
        ${items ? `
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="padding:6px 8px;text-align:left;color:#6B7280;font-weight:600">Producto</th>
              <th style="padding:6px 8px;text-align:right;color:#6B7280;font-weight:600">Cant.</th>
              <th style="padding:6px 8px;text-align:right;color:#6B7280;font-weight:600">Precio unit.</th>
              <th style="padding:6px 8px;text-align:right;color:#6B7280;font-weight:600">Subtotal</th>
            </tr></thead>
            <tbody>${items}</tbody>
          </table>
        </div>
        <div style="text-align:right;margin-top:10px;font-size:15px;font-weight:800;color:#4ADE80">
          Total: ${fmtMXN(oc.total)}
        </div>` : `<div style="color:#9CA3AF;font-size:12px">Sin productos (se registran desde el APK)</div>`}`;

      // Acciones según status
      const puedeEditar = Sesion.esSuperAdmin() || ["GERENTE","ADMINISTRADOR"].includes(Sesion.rol);
      let acciones = "";
      if (puedeEditar && oc.status === "BORRADOR") {
        acciones += `<button onclick="ComprasUI.cambiarStatus('${ocId}','ENVIADA')"
          style="background:#1D4ED8;border:1px solid #2563EB;border-radius:6px;padding:7px 14px;
            font-size:11.5px;font-weight:700;color:#BAE6FD;cursor:pointer;margin-left:8px">
          ✉ Marcar enviada</button>`;
      }
      if (puedeEditar && ["ENVIADA","PARCIAL"].includes(oc.status)) {
        acciones += `<button onclick="ComprasUI.abrirRecepcion('${ocId}')"
          style="background:#166534;border:1px solid #16A34A;border-radius:6px;padding:7px 14px;
            font-size:11.5px;font-weight:700;color:#4ADE80;cursor:pointer;margin-left:8px">
          📥 Registrar recepción</button>`;
      }
      if (puedeEditar && oc.status !== "CANCELADA") {
        acciones += `<button onclick="ComprasUI.cambiarStatus('${ocId}','CANCELADA')"
          style="background:#7F1D1D;border:1px solid #EF4444;border-radius:6px;padding:7px 14px;
            font-size:11.5px;font-weight:700;color:#FCA5A5;cursor:pointer;margin-left:8px">
          ✖ Cancelar</button>`;
      }
      document.getElementById("oc-det-acciones").innerHTML = acciones;
      document.getElementById("modal-oc-detalle").classList.remove("hidden");
    },

    async cambiarStatus(ocId, nuevoStatus) {
      const _labelStatus = {
        CANCELADA: 'cancelar esta orden',
        RECIBIDA:  'marcar como recibida',
        ENVIADA:   'marcar como enviada',
        PENDIENTE: 'regresar a pendiente'
      };
      if (!await window.modal({ title: "Cambiar status", message: `¿Deseas ${_labelStatus[nuevoStatus] || nuevoStatus}?` })) return;
      try {
        await updateDoc(doc(db, "ordenes_compra", ocId), {
          status: nuevoStatus,
          modificadoPor: Sesion.alias || Sesion.uid,
          modificadoEn: serverTimestamp()
        });
        window.toast?.(`OC actualizada a ${nuevoStatus}`, "success");
        this.cerrarModal();
      } catch (e) {
        const msg = /permission|PERMISSION/.test(e.message || "")
          ? "Sin permisos para realizar esta acción."
          : "Ocurrió un error. Intenta de nuevo.";
        window.toast?.(msg, "error");
      }
    },

    // ── Recepción de OC → entrada automática a stock ─────────
    async abrirRecepcion(ocId) {
      const snap = await getDoc(doc(db, "ordenes_compra", ocId));
      if (!snap.exists()) return;
      const oc    = snap.data();
      const items = oc.items || [];

      const filas = items.map((it, idx) => `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:8px 10px;font-size:12px;color:var(--text-primary)">${esc(it.nombreProducto || it.nombre || "–")}</td>
          <td style="padding:8px 10px;text-align:center;font-size:12px;color:#9CA3AF">${it.cantidad} ${it.unidad || ""}</td>
          <td style="padding:8px 10px;text-align:center">
            <input type="number" min="0" step="any" data-idx="${idx}"
              data-idpret="${it.idPretoriano || it.productoId || ''}"
              data-nombre="${esc(it.nombreProducto || it.nombre || '')}"
              data-costo="${it.precioUnitario || 0}"
              class="oc-rec-qty" value="${it.cantidad}"
              style="width:80px;border:1px solid var(--border);border-radius:5px;
                padding:4px 6px;font-size:12px;background:var(--surface);color:var(--text-primary);
                text-align:right">
          </td>
          <td style="padding:8px 10px;text-align:center">
            <textarea class="oc-rec-nota" data-idx="${idx}" rows="1"
              placeholder="Diferencia / merma…"
              style="width:100%;border:1px solid var(--border);border-radius:5px;
                padding:4px 6px;font-size:11px;background:var(--surface);color:var(--text-primary);
                resize:none"></textarea>
          </td>
        </tr>`).join("");

      // Inyectar modal de recepción
      let modal = document.getElementById("modal-oc-recepcion");
      if (!modal) {
        modal = document.createElement("div");
        modal.id = "modal-oc-recepcion";
        modal.className = "modal-overlay hidden";
        document.body.appendChild(modal);
      }
      modal.innerHTML = `
        <div class="modal" style="max-width:660px">
          <div class="modal-title">📥 Recepción — ${esc(oc.folio || ocId)}</div>
          <div style="font-size:11px;color:#9CA3AF;margin-bottom:12px">
            Ajusta las cantidades reales recibidas. El stock se actualiza automáticamente al guardar.
          </div>
          <div style="overflow-x:auto;max-height:320px;overflow-y:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead>
                <tr style="background:var(--surface-2)">
                  <th style="padding:8px 10px;text-align:left;color:#6B7280;font-weight:600">Producto</th>
                  <th style="padding:8px 10px;text-align:center;color:#6B7280;font-weight:600">OC Cant.</th>
                  <th style="padding:8px 10px;text-align:center;color:#6B7280;font-weight:600">Recibido</th>
                  <th style="padding:8px 10px;text-align:center;color:#6B7280;font-weight:600">Nota / Diferencia</th>
                </tr>
              </thead>
              <tbody>${filas || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#9CA3AF">Sin productos en esta OC</td></tr>'}</tbody>
            </table>
          </div>
          ${items.length === 0 ? '<div style="font-size:11px;color:#FBBF24;margin-top:8px">⚠ Esta OC no tiene productos — agrega items desde el APK primero.</div>' : ''}
          <div class="modal-actions" style="margin-top:16px">
            <button class="btn-secondary" onclick="document.getElementById('modal-oc-recepcion').classList.add('hidden')">Cancelar</button>
            <button class="btn-primary" style="width:auto;padding:8px 20px"
              onclick="ComprasUI.confirmarRecepcion('${ocId}')">
              ✔ Confirmar recepción y actualizar stock
            </button>
          </div>
        </div>`;
      modal.classList.remove("hidden");
    },

    async confirmarRecepcion(ocId) {
      const entradas = [...document.querySelectorAll(".oc-rec-qty")].map(input => ({
        idPretoriano: input.dataset.idpret ? Number(input.dataset.idpret) : null,
        nombre:       input.dataset.nombre || "–",
        costo:        Number(input.dataset.costo) || 0,
        cantidad:     Number(input.value) || 0,
        nota:         document.querySelector(`.oc-rec-nota[data-idx="${input.dataset.idx}"]`)?.value || ""
      })).filter(e => e.cantidad > 0);

      if (entradas.length === 0) {
        window.toast?.("Ingresa al menos una cantidad mayor a 0", "error");
        return;
      }
      if (!await window.modal({ title: "Confirmar recepción", message: `¿Confirmar recepción de ${entradas.length} producto(s) y actualizar stock?`, confirmLabel: "Confirmar" })) return;

      try {
        const batch = writeBatch(db);
        const ts    = serverTimestamp();
        const now   = Date.now();

        for (const item of entradas) {
          if (!item.idPretoriano) continue;

          // Buscar producto en Firestore
          const { getDocs: gd, query: qry, where, collection: col, limit: lim } =
            await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
          const pSnap = await gd(qry(col(db, "productos"),
            where("idPretoriano", "==", item.idPretoriano), lim(1)));

          if (pSnap.empty) {
            console.warn(`[Recepción] idPretoriano=${item.idPretoriano} no encontrado`);
            continue;
          }
          const prodRef     = pSnap.docs[0].ref;
          const prodData    = pSnap.docs[0].data();
          const stockActual = prodData.stock || 0;
          const costoBefore = prodData.costo_base || prodData.costoBase || 0;

          // Guardar para historial después del commit
          item._productoId   = pSnap.docs[0].id;
          item._costoAnterior = costoBefore;
          item._precioBase   = prodData.precio_base || prodData.precioBase || 0;

          // Actualizar stock y costo_base si cambió
          const prodUpd = { stock: increment(item.cantidad), updatedAt: ts };
          if (item.costo > 0 && Math.abs(item.costo - costoBefore) > 0.01) {
            prodUpd.costo_base = item.costo;
            prodUpd.costoBase  = item.costo;
          }
          batch.update(prodRef, prodUpd);

          // Registrar en kardex
          const movRef = doc(collection(db, "movimientos_stock"));
          batch.set(movRef, {
            tipo:           "ENTRADA",
            motivo:         "OC",
            productoId:     pSnap.docs[0].id,
            idPretoriano:   item.idPretoriano,
            nombreProducto: item.nombre,
            cantidad:       item.cantidad,
            stockAntes:     stockActual,
            stockDespues:   stockActual + item.cantidad,
            costoUnitario:  item.costo,
            ocId,
            nota:           item.nota || "",
            quienRegistro:  Sesion.alias || Sesion.uid,
            timestamp:      ts,
            _ts:            now
          });
        }

        // Marcar OC como RECIBIDA (o PARCIAL si alguna cantidad difiere — simplificación: RECIBIDA)
        batch.update(doc(db, "ordenes_compra", ocId), {
          status:           "RECIBIDA",
          fechaRecepcion:   ts,
          recibidoPor:      Sesion.alias || Sesion.uid,
          modificadoEn:     ts
        });

        await batch.commit();

        // Registrar en historial_precios los productos cuyo costo cambió
        const histPromesas = entradas
          .filter(item => item._costoAnterior !== undefined && item.costo > 0
            && Math.abs(item.costo - item._costoAnterior) > 0.01)
          .map(item => addDoc(collection(db, "historial_precios"), {
            productoId:     item._productoId || "",
            nombreProducto: item.nombre,
            precioBase:     item._precioBase ?? 0,
            costoBase:      item.costo,
            precioAnterior: item._precioBase ?? 0,
            costoAnterior:  item._costoAnterior,
            cambiadoPor:    Sesion.alias || Sesion.uid || "–",
            fechaCambio:    serverTimestamp(),
            fuente:         "recepcion_compra",
            ocId,
            _ts:            Date.now(),
          }).catch(e => console.warn("[historial_precios]", e)));
        await Promise.all(histPromesas);

        window.toast?.(`Recepción registrada — stock actualizado en ${entradas.length} producto(s)`, "success");
        document.getElementById("modal-oc-recepcion")?.classList.add("hidden");
        document.getElementById("modal-oc-detalle")?.classList.add("hidden");
      } catch (err) {
        console.error("[confirmarRecepcion]", err);
        const msg = /permission|PERMISSION/.test(err.message || "")
          ? "Sin permisos para actualizar stock."
          : "Error al registrar recepción. Intenta de nuevo.";
        window.toast?.(msg, "error");
      }
    }
  };
}

function _setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
