// ══════════════════════════════════════════════════════════════
// proveedores.js — Catálogo de proveedores (CRUD completo)
// Visible: ADMINISTRADOR, SUPER_ADMIN
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, norm } from "./app.js";
import { invalidarCache } from "./erp-cache.js";
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc,
  query, orderBy, serverTimestamp, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

let _provs    = [];
let _filtro   = "";
let _editId   = null;

const CATEGORIAS = ["Agroquímicos","Fertilizantes","Semillas","Empaques","Maquinaria","Servicios","Logística","Otro"];

export const ProveedoresModule = {
  mount(container) {
    if (!_puedeVer()) {
      container.innerHTML = `<div style="padding:40px;text-align:center;color:#9CA3AF">Sin acceso.</div>`;
      return () => {};
    }
    _provs = []; _filtro = ""; _editId = null; _filtrosCat = "";
    container.innerHTML = _html();
    _bindUI();
    _cargar();
    return () => {};
  }
};

function _puedeVer() {
  return Sesion.esSuperAdmin() || ["ADMINISTRADOR","GERENTE"].includes(Sesion.rol);
}

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <div style="padding:20px 24px;max-width:1100px;margin:0 auto">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:16px;font-weight:800;color:var(--text-primary)">🏭 Proveedores</div>
        <div id="prov-sub" style="font-size:11px;color:#9CA3AF;margin-top:2px">Cargando…</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="search" id="prov-search" placeholder="Buscar proveedor…"
          oninput="ProveedoresUI.buscar(this.value)"
          style="padding:7px 12px;border:1px solid var(--border);border-radius:8px;font-size:12px;
            background:var(--surface);color:var(--text-primary);width:200px">
        <select id="prov-cat-filter" onchange="ProveedoresUI.filtrarCat(this.value)"
          style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;
            background:var(--surface);color:var(--text-primary)">
          <option value="">Todas las categorías</option>
          ${CATEGORIAS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
        </select>
        <button onclick="ProveedoresUI.nuevo()"
          style="padding:8px 16px;background:#1565C0;color:#fff;border:none;border-radius:8px;
            font-size:12px;font-weight:700;cursor:pointer">+ Nuevo proveedor</button>
      </div>
    </div>

    <!-- Tabla -->
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--surface-2)">
            <th style="${_th()}">NOMBRE</th>
            <th style="${_th()}">RFC</th>
            <th style="${_th()}">CATEGORÍA</th>
            <th style="${_th()}">CONTACTO</th>
            <th style="${_th()}">TELÉFONO</th>
            <th style="${_th()}">EMAIL</th>
            <th style="${_th()}">ESTADO</th>
            <th style="${_th()}"></th>
          </tr>
        </thead>
        <tbody id="prov-tbody">
          <tr><td colspan="8" style="padding:30px;text-align:center;color:#9CA3AF">Cargando…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Modal nuevo/editar -->
    <div id="prov-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);
      z-index:1010;align-items:center;justify-content:center;padding:20px">
      <div style="background:var(--surface);border-radius:14px;width:560px;max-width:100%;
        max-height:90vh;overflow-y:auto;border:1px solid var(--border);padding:24px">

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
          <span id="prov-modal-titulo" style="font-size:15px;font-weight:800;color:var(--text-primary)">Nuevo proveedor</span>
          <button onclick="ProveedoresUI.cerrar()"
            style="border:none;background:transparent;font-size:20px;cursor:pointer;color:#9CA3AF">✕</button>
        </div>

        <div style="display:grid;gap:12px">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
            ${_field("Nombre *", `<input id="pf-nombre" style="${_inp()}" placeholder="Nombre del proveedor">`)}
            ${_field("RFC", `<input id="pf-rfc" style="${_inp()}" placeholder="XAXX010101000">`)}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            ${_field("Categoría", `<select id="pf-categoria" style="${_inp()}">
              <option value="">— Seleccionar —</option>
              ${CATEGORIAS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
            </select>`)}
            ${_field("Contacto (persona)", `<input id="pf-contacto" style="${_inp()}" placeholder="Nombre del contacto">`)}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            ${_field("Teléfono", `<input id="pf-telefono" style="${_inp()}" placeholder="10 dígitos">`)}
            ${_field("Email", `<input id="pf-email" type="email" style="${_inp()}" placeholder="correo@proveedor.com">`)}
          </div>
          ${_field("Dirección / Observaciones", `<textarea id="pf-notas" rows="2"
            style="${_inp()}resize:vertical" placeholder="Dirección, condiciones de pago, notas…"></textarea>`)}
          <div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:var(--text-primary)">
              <input type="checkbox" id="pf-activo" checked style="width:14px;height:14px">
              Proveedor activo
            </label>
          </div>
        </div>

        <div id="prov-modal-err" style="display:none;background:#FEE2E2;border-radius:6px;
          padding:8px 12px;font-size:11.5px;color:#DC2626;margin-top:12px"></div>

        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
          <button onclick="ProveedoresUI.cerrar()"
            style="padding:8px 18px;border:1px solid var(--border);border-radius:6px;
              background:transparent;color:var(--text-sec);font-size:12px;cursor:pointer">Cancelar</button>
          <button onclick="ProveedoresUI.guardar()"
            style="padding:8px 22px;border:none;border-radius:6px;
              background:var(--green-dark,#1B5E20);color:#fff;font-size:12px;font-weight:700;cursor:pointer">Guardar</button>
        </div>
      </div>
    </div>
  </div>`;
}

function _th() { return "padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:#9CA3AF;white-space:nowrap;"; }
function _inp() { return "width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;"; }
function _field(label, html) {
  return `<div><label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">${label}</label>${html}</div>`;
}

// ── Datos ─────────────────────────────────────────────────────
let _filtrosCat = "";

async function _cargar() {
  try {
    const snap = await getDocs(query(collection(db, "proveedores"), orderBy("nombre")));
    _provs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    document.getElementById("prov-sub").textContent =
      `${_provs.length} proveedores · ${_provs.filter(p => p.activo !== false).length} activos`;
    _render();
  } catch(e) {
    document.getElementById("prov-sub").textContent = "Error al cargar.";
  }
}

function _render() {
  const q  = norm(_filtro);
  const lista = _provs.filter(p => {
    const pass = !q || norm([p.nombre,p.rfc,p.contacto,p.email,p.categoria].join(" ")).includes(q);
    const passCat = !_filtrosCat || p.categoria === _filtrosCat;
    return pass && passCat;
  });

  const tbody = document.getElementById("prov-tbody");
  if (!tbody) return;

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:30px;text-align:center;color:#9CA3AF">Sin resultados.</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(p => {
    const activo = p.activo !== false;
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:10px 14px;font-size:12px;font-weight:700;color:var(--text-primary)">${esc(p.nombre||"—")}</td>
      <td style="padding:10px 14px;font-size:11px;font-family:monospace;color:#9CA3AF">${esc(p.rfc||"—")}</td>
      <td style="padding:10px 14px">
        ${p.categoria ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;
          background:var(--green-dark,#1B5E20)22;color:var(--green-dark,#1B5E20)">${esc(p.categoria)}</span>` : "—"}
      </td>
      <td style="padding:10px 14px;font-size:12px;color:var(--text-sec)">${esc(p.contacto||"—")}</td>
      <td style="padding:10px 14px;font-size:12px;color:var(--text-sec)">${esc(p.telefono||"—")}</td>
      <td style="padding:10px 14px;font-size:12px;color:var(--text-sec)">${esc(p.email||"—")}</td>
      <td style="padding:10px 14px">
        <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;
          background:${activo?"#16A34A22":"#9CA3AF22"};color:${activo?"#16A34A":"#9CA3AF"}">
          ${activo?"Activo":"Inactivo"}
        </span>
      </td>
      <td style="padding:10px 14px;white-space:nowrap">
        <button onclick="ProveedoresUI.editar('${esc(p.id)}')"
          style="padding:4px 10px;border:1px solid #1565C0;border-radius:5px;background:transparent;
            color:var(--green-dark,#1B5E20);font-size:11px;cursor:pointer;margin-right:4px">Editar</button>
        <button onclick="ProveedoresUI.eliminar('${esc(p.id)}','${esc(p.nombre||"")}')"
          style="padding:4px 10px;border:1px solid #DC2626;border-radius:5px;background:transparent;
            color:#DC2626;font-size:11px;cursor:pointer">Eliminar</button>
      </td>
    </tr>`;
  }).join("");
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI() {
  window.ProveedoresUI = {
    buscar(v) { _filtro = v; _render(); },
    filtrarCat(v) { _filtrosCat = v; _render(); },

    nuevo() {
      _editId = null;
      document.getElementById("prov-modal-titulo").textContent = "Nuevo proveedor";
      ["pf-nombre","pf-rfc","pf-contacto","pf-telefono","pf-email","pf-notas"].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = "";
      });
      document.getElementById("pf-categoria").value = "";
      document.getElementById("pf-activo").checked  = true;
      document.getElementById("prov-modal-err").style.display = "none";
      document.getElementById("prov-modal").style.display = "flex";
      _regEsc(() => ProveedoresUI.cerrar());
    },

    editar(id) {
      const p = _provs.find(x => x.id === id);
      if (!p) return;
      _editId = id;
      document.getElementById("prov-modal-titulo").textContent = "Editar proveedor";
      document.getElementById("pf-nombre").value    = p.nombre    || "";
      document.getElementById("pf-rfc").value       = p.rfc       || "";
      document.getElementById("pf-categoria").value = p.categoria || "";
      document.getElementById("pf-contacto").value  = p.contacto  || "";
      document.getElementById("pf-telefono").value  = p.telefono  || "";
      document.getElementById("pf-email").value     = p.email     || "";
      document.getElementById("pf-notas").value     = p.notas     || "";
      document.getElementById("pf-activo").checked  = p.activo !== false;
      document.getElementById("prov-modal-err").style.display = "none";
      document.getElementById("prov-modal").style.display = "flex";
      _regEsc(() => ProveedoresUI.cerrar());
    },

    cerrar() {
      _unregEsc();
      document.getElementById("prov-modal").style.display = "none";
    },

    async guardar() {
      const nombre    = document.getElementById("pf-nombre")?.value.trim();
      const rfc       = document.getElementById("pf-rfc")?.value.trim().toUpperCase();
      const categoria = document.getElementById("pf-categoria")?.value;
      const contacto  = document.getElementById("pf-contacto")?.value.trim();
      const telefono  = document.getElementById("pf-telefono")?.value.trim();
      const email     = document.getElementById("pf-email")?.value.trim().toLowerCase();
      const notas     = document.getElementById("pf-notas")?.value.trim();
      const activo    = document.getElementById("pf-activo")?.checked ?? true;
      const errEl     = document.getElementById("prov-modal-err");

      if (!nombre) { errEl.textContent = "El nombre es obligatorio."; errEl.style.display = "block"; return; }
      errEl.style.display = "none";

      const datos = { nombre, rfc, categoria, contacto, telefono, email, notas, activo,
        actualizadoPor: Sesion.alias, actualizadoEn: serverTimestamp() };

      try {
        if (_editId) {
          await updateDoc(doc(db, "proveedores", _editId), datos);
          window.toast?.("Proveedor actualizado.", "success");
        } else {
          datos.creadoPor = Sesion.alias;
          datos.creadoEn  = serverTimestamp();
          await addDoc(collection(db, "proveedores"), datos);
          window.toast?.("Proveedor creado.", "success");
        }
        invalidarCache("proveedores");
        document.getElementById("prov-modal").style.display = "none";
        await _cargar();
      } catch(e) {
        errEl.textContent = "Error: " + e.message;
        errEl.style.display = "block";
      }
    },

    async eliminar(id, nombre) {
      const ok = window.modal
        ? await window.modal({ title: "Eliminar proveedor", message: `¿Eliminar "${nombre}"? Esta acción no se puede deshacer.`, danger: true, confirmLabel: "Eliminar" })
        : confirm(`¿Eliminar proveedor "${nombre}"? Esta acción no se puede deshacer.`);
      if (!ok) return;
      try {
        await deleteDoc(doc(db, "proveedores", id));
        invalidarCache("proveedores");
        window.toast?.("Proveedor eliminado.", "success");
        await _cargar();
      } catch(e) {
        window.toast?.("Error al eliminar: " + e.message, "error");
      }
    }
  };

  // Cerrar al hacer clic fuera del modal
  document.getElementById("prov-modal")?.addEventListener("click", e => {
    if (e.target.id === "prov-modal") window.ProveedoresUI.cerrar();
  });
}
