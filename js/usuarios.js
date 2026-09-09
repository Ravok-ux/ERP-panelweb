// ══════════════════════════════════════════════════════════════
// usuarios.js — Gestión de usuarios y flags (SUPER_ADMIN / GERENTE)
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import {
  collection, doc, onSnapshot, updateDoc, setDoc, deleteDoc,
  serverTimestamp, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Definición de flags ────────────────────────────────────────
const PRIVILEGIOS = [
  { key:"PUEDE_EDITAR_PRECIO",        label:"Editar precio",          icon:"💲", soloSA: true },
  { key:"PUEDE_CANCELAR_PEDIDO",      label:"Cancelar pedido",        icon:"❌", soloSA: false },
  { key:"PUEDE_VER_CARTERA_GLOBAL",   label:"Cartera global",         icon:"👁", soloSA: false },
  { key:"PUEDE_IMPORTAR_CATALOGO",    label:"Import. catálogo",       icon:"📦", soloSA: false },
  { key:"PUEDE_EXPORTAR_BACKUP",      label:"Export. reportes",       icon:"💾", soloSA: false },
  { key:"PUEDE_REGISTRAR_REMISION",   label:"Remisión / liquidar",    icon:"📄", soloSA: false },
  { key:"PUEDE_REGISTRAR_ABONO",      label:"Abono / cobro",          icon:"💳", soloSA: false },
  { key:"PUEDE_VER_RH",               label:"Ver RH",                 icon:"👥", soloSA: false },
  { key:"PUEDE_EDITAR_NOMINA",        label:"Editar nómina",          icon:"💵", soloSA: true  },
  { key:"PUEDE_VER_CLIENTES",         label:"Ver clientes",           icon:"🧑", soloSA: false },
  { key:"PUEDE_EXPORTAR_CLIENTES",    label:"Exportar clientes",      icon:"📤", soloSA: false },
  { key:"PUEDE_VER_COBRANZA",         label:"Ver cobranza",           icon:"💰", soloSA: false },
  { key:"PUEDE_APROBAR_DEVOLUCIONES", label:"Aprobar devoluciones",   icon:"↩️", soloSA: false },
  { key:"PUEDE_CREAR_COTIZACIONES",   label:"Crear cotizaciones",     icon:"📝", soloSA: false }
];

const MODULOS = [
  { key:"PUEDE_CREAR_CLIENTES",     label:"Crear clientes",         icon:"👤" },
  { key:"PUEDE_ACCESO_STOCK",       label:"Stock / almacén",        icon:"📦" },
  { key:"PUEDE_CREAR_PEDIDOS",      label:"Crear pedidos",          icon:"🛒" },
  { key:"PUEDE_VER_PEDIDOS",        label:"Ver pedidos",            icon:"📋" },
  { key:"PUEDE_RUTA_OPTIMA",        label:"Ruta del día",           icon:"🗺" }
];

// Flags exclusivos de roles administrativos
const ADMIN_FLAGS = [
  { key:"PUEDE_ALMACEN_ENTRADAS",    label:"Entrada almacén",        icon:"📥" },
  { key:"PUEDE_ALMACEN_INVENTARIO",  label:"Inventario físico",      icon:"🔢" },
  { key:"PUEDE_AJUSTAR_INVENTARIO",  label:"Ajuste manual stock",    icon:"⚖️" },
  { key:"PUEDE_AUTORIZAR_PEDIDOS",   label:"Autorizar pedidos",      icon:"✅" },
  { key:"PUEDE_ORDENES_COMPRA",      label:"Órdenes compra",         icon:"🛒" },
  { key:"PUEDE_VER_COMISIONES",      label:"Ver comisiones",         icon:"📊" },
  { key:"PUEDE_CONFIG_COMISIONES",   label:"Config. comisiones",     icon:"⚙️" },
  { key:"PUEDE_CARTERA_GLOBAL",      label:"Cartera global (admin)", icon:"💰" },
  { key:"PUEDE_MODULO_JURIDICO",     label:"Módulo jurídico",        icon:"⚖️" },
  { key:"PUEDE_CONFIG_INTERESES",    label:"Config. intereses",      icon:"📈" },
  { key:"PUEDE_REPORTES_CUSTOM",     label:"Reportes custom",        icon:"📉" },
  { key:"PUEDE_ACCESO_SMS",          label:"Módulo SMS",             icon:"📱" },
  { key:"PUEDE_ACCESO_BI",           label:"BI Analytics",           icon:"📊" },
  { key:"PUEDE_ACCESO_GASTOS",       label:"Módulo gastos",          icon:"🧾" },
  { key:"PUEDE_VER_HISTORIAL",       label:"Historial ventas",       icon:"📅" },
  { key:"PUEDE_ACCESO_CAJA",         label:"Cortes de caja",         icon:"🏦" }
];

const TODOS_FLAGS = [...PRIVILEGIOS, ...MODULOS];
const TODOS_FLAGS_ADMIN = [...PRIVILEGIOS, ...MODULOS, ...ADMIN_FLAGS];

// ── Presets por rol (espejo de RolPreset.kt) ───────────────────
const PRESET = {
  SUPER_ADMIN: Object.fromEntries(TODOS_FLAGS.map(f => [f.key, true])),
  GERENTE: {
    PUEDE_EDITAR_PRECIO:        false,
    PUEDE_CANCELAR_PEDIDO:      true,
    PUEDE_VER_CARTERA_GLOBAL:   true,
    PUEDE_IMPORTAR_CATALOGO:    true,
    PUEDE_EXPORTAR_BACKUP:      true,
    PUEDE_REGISTRAR_REMISION:   true,
    PUEDE_REGISTRAR_ABONO:      true,
    PUEDE_VER_RH:               true,
    PUEDE_EDITAR_NOMINA:        false,
    PUEDE_VER_CLIENTES:         true,
    PUEDE_EXPORTAR_CLIENTES:    true,
    PUEDE_VER_COBRANZA:         true,
    PUEDE_APROBAR_DEVOLUCIONES: true,
    PUEDE_CREAR_COTIZACIONES:   true,
    PUEDE_CREAR_CLIENTES:       true,
    PUEDE_ACCESO_STOCK:         true,
    PUEDE_CREAR_PEDIDOS:        true,
    PUEDE_VER_PEDIDOS:          true,
    PUEDE_RUTA_OPTIMA:          true,
    PUEDE_ACCESO_SMS:           true,
    PUEDE_ACCESO_BI:            true,
    PUEDE_ACCESO_GASTOS:        true,
    PUEDE_VER_HISTORIAL:        true,
    PUEDE_ACCESO_CAJA:          true
  },
  INGENIERO: {
    PUEDE_EDITAR_PRECIO:        false,
    PUEDE_CANCELAR_PEDIDO:      false,
    PUEDE_VER_CARTERA_GLOBAL:   false,
    PUEDE_IMPORTAR_CATALOGO:    false,
    PUEDE_EXPORTAR_BACKUP:      false,
    PUEDE_REGISTRAR_REMISION:   true,
    PUEDE_REGISTRAR_ABONO:      true,
    PUEDE_VER_RH:               false,
    PUEDE_EDITAR_NOMINA:        false,
    PUEDE_VER_CLIENTES:         true,
    PUEDE_EXPORTAR_CLIENTES:    false,
    PUEDE_VER_COBRANZA:         false,
    PUEDE_APROBAR_DEVOLUCIONES: false,
    PUEDE_CREAR_COTIZACIONES:   true,
    PUEDE_CREAR_CLIENTES:       true,
    PUEDE_ACCESO_STOCK:         true,
    PUEDE_CREAR_PEDIDOS:        true,
    PUEDE_VER_PEDIDOS:          true,
    PUEDE_RUTA_OPTIMA:          true,
    PUEDE_REPORTES_CUSTOM:      false,
    PUEDE_CONFIG_INTERESES:     false,
    PUEDE_ACCESO_SMS:           false,
    PUEDE_ACCESO_BI:            false,
    PUEDE_ACCESO_GASTOS:        false,
    PUEDE_VER_HISTORIAL:        false,
    PUEDE_ACCESO_CAJA:          false
  },
  RECUPERADOR: {
    PUEDE_EDITAR_PRECIO:      false,
    PUEDE_CANCELAR_PEDIDO:    false,
    PUEDE_VER_CARTERA_GLOBAL: false,
    PUEDE_IMPORTAR_CATALOGO:  false,
    PUEDE_EXPORTAR_BACKUP:    false,
    PUEDE_REGISTRAR_REMISION: true,
    PUEDE_REGISTRAR_ABONO:    true,
    PUEDE_CREAR_CLIENTES:     false,
    PUEDE_ACCESO_STOCK:       false,
    PUEDE_CREAR_PEDIDOS:      false,
    PUEDE_VER_PEDIDOS:        false,
    PUEDE_RUTA_OPTIMA:        false,
    PUEDE_ALMACEN_ENTRADAS:   false,
    PUEDE_ALMACEN_INVENTARIO: false,
    PUEDE_ORDENES_COMPRA:     false,
    PUEDE_VER_COMISIONES:     false,
    PUEDE_CONFIG_COMISIONES:  false,
    PUEDE_CARTERA_GLOBAL:     false,
    PUEDE_MODULO_JURIDICO:    false,
    PUEDE_REPORTES_CUSTOM:    false,
    PUEDE_CONFIG_INTERESES:   false,
    PUEDE_ACCESO_SMS:         false,
    PUEDE_ACCESO_BI:          false,
    PUEDE_ACCESO_GASTOS:      false,
    PUEDE_VER_HISTORIAL:      false,
    PUEDE_ACCESO_CAJA:        false
  },
  ADMINISTRADOR: {
    PUEDE_EDITAR_PRECIO:        false,
    PUEDE_CANCELAR_PEDIDO:      true,
    PUEDE_VER_CARTERA_GLOBAL:   true,
    PUEDE_IMPORTAR_CATALOGO:    true,
    PUEDE_EXPORTAR_BACKUP:      true,
    PUEDE_REGISTRAR_REMISION:   true,
    PUEDE_REGISTRAR_ABONO:      true,
    PUEDE_VER_RH:               true,
    PUEDE_EDITAR_NOMINA:        false,
    PUEDE_VER_CLIENTES:         true,
    PUEDE_EXPORTAR_CLIENTES:    true,
    PUEDE_VER_COBRANZA:         true,
    PUEDE_APROBAR_DEVOLUCIONES: true,
    PUEDE_CREAR_COTIZACIONES:   true,
    PUEDE_CREAR_CLIENTES:       true,
    PUEDE_ACCESO_STOCK:         true,
    PUEDE_CREAR_PEDIDOS:        true,
    PUEDE_VER_PEDIDOS:          true,
    PUEDE_RUTA_OPTIMA:          false,
    PUEDE_ALMACEN_ENTRADAS:     true,
    PUEDE_ALMACEN_INVENTARIO:   true,
    PUEDE_AJUSTAR_INVENTARIO:   true,
    PUEDE_AUTORIZAR_PEDIDOS:    false,
    PUEDE_ORDENES_COMPRA:       true,
    PUEDE_VER_COMISIONES:       true,
    PUEDE_CONFIG_COMISIONES:    true,
    PUEDE_CARTERA_GLOBAL:       true,
    PUEDE_MODULO_JURIDICO:      false,
    PUEDE_CONFIG_INTERESES:     true,
    PUEDE_REPORTES_CUSTOM:      true,
    PUEDE_ACCESO_SMS:           false,
    PUEDE_ACCESO_BI:            true,
    PUEDE_ACCESO_GASTOS:        true,
    PUEDE_VER_HISTORIAL:        true,
    PUEDE_ACCESO_CAJA:          true
  },
  ALMACENISTA: {
    PUEDE_EDITAR_PRECIO:      false,
    PUEDE_CANCELAR_PEDIDO:    false,
    PUEDE_VER_CARTERA_GLOBAL: false,
    PUEDE_IMPORTAR_CATALOGO:  false,
    PUEDE_EXPORTAR_BACKUP:    false,
    PUEDE_REGISTRAR_REMISION: false,
    PUEDE_REGISTRAR_ABONO:    false,
    PUEDE_CREAR_CLIENTES:     false,
    PUEDE_ACCESO_STOCK:       true,
    PUEDE_CREAR_PEDIDOS:      false,
    PUEDE_VER_PEDIDOS:        true,
    PUEDE_RUTA_OPTIMA:        false,
    PUEDE_ALMACEN_ENTRADAS:   true,
    PUEDE_ALMACEN_INVENTARIO: true,
    PUEDE_AJUSTAR_INVENTARIO: true,
    PUEDE_AUTORIZAR_PEDIDOS:  false,
    PUEDE_ORDENES_COMPRA:     false,
    PUEDE_VER_COMISIONES:     false,
    PUEDE_CONFIG_COMISIONES:  false,
    PUEDE_CARTERA_GLOBAL:     false,
    PUEDE_MODULO_JURIDICO:    false,
    PUEDE_REPORTES_CUSTOM:    false,
    PUEDE_CONFIG_INTERESES:   false,
    PUEDE_ACCESO_SMS:         false,
    PUEDE_ACCESO_BI:          false,
    PUEDE_ACCESO_GASTOS:      false,
    PUEDE_VER_HISTORIAL:      false,
    PUEDE_ACCESO_CAJA:        false
  },
  JURIDICO: {
    PUEDE_EDITAR_PRECIO:      false,
    PUEDE_CANCELAR_PEDIDO:    false,
    PUEDE_VER_CARTERA_GLOBAL: true,
    PUEDE_IMPORTAR_CATALOGO:  false,
    PUEDE_EXPORTAR_BACKUP:    false,
    PUEDE_REGISTRAR_REMISION: false,
    PUEDE_REGISTRAR_ABONO:    true,
    PUEDE_CREAR_CLIENTES:     false,
    PUEDE_ACCESO_STOCK:       false,
    PUEDE_CREAR_PEDIDOS:      false,
    PUEDE_VER_PEDIDOS:        false,
    PUEDE_RUTA_OPTIMA:        false,
    PUEDE_ALMACEN_ENTRADAS:   false,
    PUEDE_ALMACEN_INVENTARIO: false,
    PUEDE_ORDENES_COMPRA:     false,
    PUEDE_VER_COMISIONES:     false,
    PUEDE_CONFIG_COMISIONES:  false,
    PUEDE_CARTERA_GLOBAL:     true,
    PUEDE_MODULO_JURIDICO:    true,
    PUEDE_REPORTES_CUSTOM:    false,
    PUEDE_CONFIG_INTERESES:   false,
    PUEDE_ACCESO_SMS:         false,
    PUEDE_ACCESO_BI:          false,
    PUEDE_ACCESO_GASTOS:      false,
    PUEDE_VER_HISTORIAL:      false,
    PUEDE_ACCESO_CAJA:        false
  },
  GERENTE_ZONA: {
    PUEDE_EDITAR_PRECIO:      false,
    PUEDE_CANCELAR_PEDIDO:    true,
    PUEDE_VER_CARTERA_GLOBAL: true,
    PUEDE_IMPORTAR_CATALOGO:  false,
    PUEDE_EXPORTAR_BACKUP:    true,
    PUEDE_REGISTRAR_REMISION: true,
    PUEDE_REGISTRAR_ABONO:    true,
    PUEDE_CREAR_CLIENTES:     true,
    PUEDE_ACCESO_STOCK:       true,
    PUEDE_CREAR_PEDIDOS:      true,
    PUEDE_VER_PEDIDOS:        true,
    PUEDE_RUTA_OPTIMA:        true,
    PUEDE_ALMACEN_ENTRADAS:   false,
    PUEDE_ALMACEN_INVENTARIO: false,
    PUEDE_ORDENES_COMPRA:     false,
    PUEDE_VER_COMISIONES:     true,
    PUEDE_CONFIG_COMISIONES:  false,
    PUEDE_CARTERA_GLOBAL:     true,
    PUEDE_MODULO_JURIDICO:    false,
    PUEDE_REPORTES_CUSTOM:    false,
    PUEDE_CONFIG_INTERESES:   false,
    PUEDE_ACCESO_SMS:         false,
    PUEDE_ACCESO_BI:          true,
    PUEDE_ACCESO_GASTOS:      false,
    PUEDE_VER_HISTORIAL:      true,
    PUEDE_ACCESO_CAJA:        false
  },
  MESA_CONTROL: {
    PUEDE_EDITAR_PRECIO:      false,
    PUEDE_CANCELAR_PEDIDO:    true,
    PUEDE_VER_CARTERA_GLOBAL: true,
    PUEDE_IMPORTAR_CATALOGO:  false,
    PUEDE_EXPORTAR_BACKUP:    true,
    PUEDE_REGISTRAR_REMISION: true,
    PUEDE_REGISTRAR_ABONO:    true,
    PUEDE_CREAR_CLIENTES:     true,
    PUEDE_ACCESO_STOCK:       true,
    PUEDE_CREAR_PEDIDOS:      true,
    PUEDE_VER_PEDIDOS:        true,
    PUEDE_RUTA_OPTIMA:        false,
    PUEDE_ALMACEN_ENTRADAS:   false,
    PUEDE_ALMACEN_INVENTARIO: false,
    PUEDE_AJUSTAR_INVENTARIO: false,
    PUEDE_AUTORIZAR_PEDIDOS:  true,
    PUEDE_ORDENES_COMPRA:     false,
    PUEDE_VER_COMISIONES:     false,
    PUEDE_CONFIG_COMISIONES:  false,
    PUEDE_CARTERA_GLOBAL:     false,
    PUEDE_MODULO_JURIDICO:    false,
    PUEDE_REPORTES_CUSTOM:    false,
    PUEDE_CONFIG_INTERESES:   false,
    PUEDE_ACCESO_SMS:         true,
    PUEDE_ACCESO_BI:          true,
    PUEDE_ACCESO_GASTOS:      true,
    PUEDE_VER_HISTORIAL:      true,
    PUEDE_ACCESO_CAJA:        true
  }
};

let _unsubs = [];

export const UsuariosModule = {
  mount(container) {
    if (!Sesion.esSuperAdmin() && Sesion.rol !== "GERENTE") {
      container.innerHTML = `
        <div class="empty-state" style="flex:1;justify-content:center">
          <div class="empty-state-icon">🔒</div>
          <div class="empty-state-title">Acceso restringido</div>
          <div class="empty-state-sub">Solo SUPER_ADMIN y GERENTE pueden gestionar usuarios</div>
        </div>`;
      return;
    }
    container.innerHTML = _html();
    document.getElementById("users-tbody").innerHTML = window.skeleton?.(5, 8) ?? "";
    _bindAcciones();
    _escucharUsuarios();
    return () => this.destroy();
  },

  destroy() {
    _unsubs.forEach(fn => fn && fn());
    _unsubs = [];
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  const colPriv = PRIVILEGIOS.map(f =>
    `<th class="toggle-col" title="${f.label}">${f.icon}</th>`).join("");
  const colMod = MODULOS.map(f =>
    `<th class="toggle-col" title="${f.label}">${f.icon}</th>`).join("");
  const colAdmin = ADMIN_FLAGS.map(f =>
    `<th class="toggle-col" title="${f.label} (admin)" style="background:#1e293b">${f.icon}</th>`).join("");
  const totalCols = 5 + TODOS_FLAGS_ADMIN.length;

  return `
  <div class="usuarios-body" style="display:flex;flex-direction:column">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-shrink:0">
      <div>
        <div style="font-size:13px;font-weight:800;color:var(--text-primary)">Usuarios y privilegios</div>
        <div style="font-size:10.5px;color:#9CA3AF;margin-top:1px" id="u-subtitle">Cargando…</div>
      </div>
      <div style="flex:1"></div>
      <button onclick="UsuariosUI.nuevoUsuario()"
        style="background:#166534;border:1px solid #16A34A;border-radius:7px;padding:7px 14px;
          font-size:11.5px;font-weight:700;color:#4ADE80;cursor:pointer">
        + Nuevo usuario
      </button>
    </div>

    <!-- Leyenda -->
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;padding:9px 14px;
      background:var(--surface);border-radius:8px;border:1px solid var(--border);flex-shrink:0">
      <span style="font-size:10px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.06em">
        Privilegios:
      </span>
      ${PRIVILEGIOS.map(f => `<span style="font-size:10px;color:#6B7280">${f.icon} ${f.label}</span>`).join("")}
      <span style="font-size:10px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-left:8px">
        Módulos:
      </span>
      ${MODULOS.map(f => `<span style="font-size:10px;color:#6B7280">${f.icon} ${f.label}</span>`).join("")}
      <span style="font-size:10px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.06em;margin-left:8px">Admin:</span>
      ${ADMIN_FLAGS.map(f => `<span style="font-size:10px;color:#94A3B8">${f.icon} ${f.label}</span>`).join("")}
    </div>

    <!-- Tabla -->
    <div style="flex:1;overflow-x:auto">
      <table class="flags-table" id="flags-table">
        <thead>
          <tr>
            <th>#</th>
            <th>USUARIO</th>
            <th>ROL</th>
            <th colspan="${PRIVILEGIOS.length}" style="text-align:center;font-size:9px;color:#9CA3AF;border-right:1px solid #374151">
              PRIVILEGIOS
            </th>
            <th colspan="${MODULOS.length}" style="text-align:center;font-size:9px;color:#9CA3AF;border-right:1px solid #374151">
              MÓDULOS
            </th>
            <th colspan="${ADMIN_FLAGS.length}" style="text-align:center;font-size:9px;color:#64748B;background:#1e293b">
              ADMIN
            </th>
            <th>ESTADO</th>
            <th>ACCIONES</th>
          </tr>
          <tr>
            <th colspan="3"></th>
            ${colPriv}
            ${colMod}
            ${colAdmin}
            <th colspan="2"></th>
          </tr>
        </thead>
        <tbody id="users-tbody">
          <tr><td colspan="${totalCols}" style="padding:24px;text-align:center;color:#9CA3AF;font-size:12px">
            Cargando usuarios…
          </td></tr>
        </tbody>
      </table>
    </div>

    <div style="margin-top:10px;font-size:10px;color:#9CA3AF">
      💡 Cada toggle se sincroniza con Firestore al instante.
      SUPER_ADMIN tiene todos los flags de forma implícita.
      Usa "Cambiar rol" para aplicar el preset completo de un rol.
    </div>
  </div>

  <!-- Modal: nuevo usuario -->
  <div id="modal-nuevo-usuario" class="modal-overlay hidden">
    <div class="modal">
      <div class="modal-title">Nuevo usuario</div>
      <div class="form-group">
        <label class="form-label">Correo electrónico</label>
        <input id="nu-email" type="email" class="form-input" placeholder="usuario@ejemplo.mx">
      </div>
      <div class="form-group">
        <label class="form-label">Alias / Nombre</label>
        <input id="nu-alias" type="text" class="form-input" placeholder="Ramírez E.">
      </div>
      <div class="form-group">
        <label class="form-label">Rol</label>
        <select id="nu-rol" class="form-input" onchange="UsuariosUI.previewPreset(this.value)">
          <option value="RECUPERADOR">RECUPERADOR — cobranza y abonos</option>
          <option value="INGENIERO" selected>INGENIERO — ventas y campo</option>
          <option value="GERENTE_ZONA">GERENTE_ZONA — gestión de zona</option>
          <option value="GERENTE">GERENTE — supervisión completa</option>
          <option value="ADMINISTRADOR">ADMINISTRADOR — operaciones completas</option>
          <option value="ALMACENISTA">ALMACENISTA — almacén y stock</option>
          <option value="JURIDICO">JURIDICO — cobranza legal</option>
          <option value="MESA_CONTROL">MESA_CONTROL — gestión de pedidos y cartera</option>
          ${Sesion.esSuperAdmin() ? '<option value="SUPER_ADMIN">SUPER_ADMIN</option>' : ""}
        </select>
      </div>
      <div id="nu-preset-preview" style="font-size:10px;padding:8px 10px;background:var(--surface);
        border-radius:6px;border:1px solid var(--border);margin-top:4px;color:#9CA3AF;line-height:1.7">
      </div>
      <div style="font-size:10.5px;color:#9CA3AF;padding:8px 10px;background:var(--surface);
        border-radius:6px;border:1px solid var(--border);margin-top:8px">
        ⚠️ El usuario debe registrarse con este correo en Firebase Auth. El perfil se crea
        automáticamente en su primer login; los flags del preset se aplican desde el panel.
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="UsuariosUI.cerrarModal()">Cancelar</button>
        <button class="btn-primary" style="width:auto;padding:8px 20px"
          onclick="UsuariosUI.guardarNuevo()">Guardar</button>
      </div>
    </div>
  </div>

  <!-- Modal: editar usuario -->
  <div id="modal-editar-usuario" class="modal-overlay hidden">
    <div class="modal">
      <div class="modal-title">Editar usuario</div>
      <div class="form-group">
        <label class="form-label">Alias / Nombre</label>
        <input id="eu-alias" type="text" class="form-input" placeholder="Ramírez E.">
      </div>
      <div class="form-group">
        <label class="form-label">Correo electrónico</label>
        <input id="eu-email" type="email" class="form-input" placeholder="usuario@ejemplo.mx">
      </div>
      <div style="font-size:10.5px;color:#9CA3AF;padding:8px 10px;background:var(--surface);
        border-radius:6px;border:1px solid var(--border);margin-top:4px">
        ℹ️ Cambiar el correo aquí solo actualiza el perfil de Firestore.
        El acceso de Firebase Auth permanece con el correo original.
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="UsuariosUI.cerrarModal()">Cancelar</button>
        <button class="btn-primary" style="width:auto;padding:8px 20px"
          onclick="UsuariosUI.guardarEditar()">Guardar</button>
      </div>
    </div>
  </div>

  <!-- Modal: eliminar permanentemente (solo SUPER_ADMIN) -->
  <div id="modal-eliminar-usuario" class="modal-overlay hidden">
    <div class="modal" style="max-width:400px">
      <div class="modal-title" style="color:#DC2626">⚠️ Eliminar usuario</div>
      <div id="del-info" style="font-size:12px;color:var(--text-primary);margin-bottom:14px;line-height:1.6"></div>
      <div style="background:#FEE2E2;border:1px solid #FECACA;border-radius:8px;padding:10px 14px;
        font-size:11px;color:#7F1D1D;margin-bottom:16px;line-height:1.6">
        Esta acción es <strong>permanente e irreversible</strong>. El documento se borrará de Firestore.<br>
        Para revocar el acceso de Firebase Auth deberás eliminarlo también desde la consola de Firebase.
      </div>
      <div style="font-size:11.5px;color:var(--text-primary);margin-bottom:6px">
        Escribe <strong id="del-confirm-hint" style="color:#DC2626"></strong> para confirmar:
      </div>
      <input id="del-confirm-input" type="text" class="form-input"
        placeholder="escribe el alias aquí" style="border-color:#DC2626;margin-bottom:16px"
        oninput="UsuariosUI._validarConfirmDelete()">
      <div class="modal-actions">
        <button class="btn-secondary" onclick="UsuariosUI.cerrarModal()">Cancelar</button>
        <button id="del-confirm-btn" class="btn-primary"
          style="background:#DC2626;border-color:#DC2626;opacity:.4;cursor:not-allowed;width:auto;padding:8px 20px"
          onclick="UsuariosUI._confirmarEliminar()" disabled>
          Eliminar permanentemente
        </button>
      </div>
    </div>
  </div>

  <!-- Modal: cambiar rol -->
  <div id="modal-cambiar-rol" class="modal-overlay hidden">
    <div class="modal">
      <div class="modal-title">Cambiar rol</div>
      <div id="cr-usuario-info" style="font-size:12px;color:#9CA3AF;margin-bottom:12px"></div>
      <div class="form-group">
        <label class="form-label">Nuevo rol</label>
        <select id="cr-rol" class="form-input" onchange="UsuariosUI.previewPresetCR(this.value)">
          <option value="RECUPERADOR">RECUPERADOR</option>
          <option value="INGENIERO">INGENIERO</option>
          <option value="GERENTE_ZONA">GERENTE_ZONA</option>
          <option value="GERENTE">GERENTE</option>
          <option value="ADMINISTRADOR">ADMINISTRADOR</option>
          <option value="ALMACENISTA">ALMACENISTA</option>
          <option value="JURIDICO">JURIDICO</option>
          <option value="MESA_CONTROL">MESA_CONTROL</option>
          ${Sesion.esSuperAdmin() ? '<option value="SUPER_ADMIN">SUPER_ADMIN</option>' : ""}
        </select>
      </div>
      <div id="cr-preset-preview" style="font-size:10px;padding:8px 10px;background:var(--surface);
        border-radius:6px;border:1px solid var(--border);margin-top:4px;color:#9CA3AF;line-height:1.7">
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:11px;margin-top:10px;color:#9CA3AF;cursor:pointer">
        <input type="checkbox" id="cr-aplicar-preset" checked>
        Aplicar preset de flags del nuevo rol
      </label>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="UsuariosUI.cerrarModal()">Cancelar</button>
        <button class="btn-primary" style="width:auto;padding:8px 20px"
          onclick="UsuariosUI.confirmarCambioRol()">Aplicar</button>
      </div>
    </div>
  </div>`;
}

// ── Listener Firestore ─────────────────────────────────────────
function _escucharUsuarios() {
  const q = query(collection(db, "usuarios"), orderBy("alias"));
  const totalCols = 5 + TODOS_FLAGS.length;

  const unsub = onSnapshot(q, snap => {
    const tbody = document.getElementById("users-tbody");
    if (!tbody) return;

    const subtitleEl = document.getElementById("u-subtitle");
    const activos = snap.docs.filter(d => d.data().activo !== false).length;
    if (subtitleEl) subtitleEl.textContent = `${snap.size} usuarios · ${activos} activos`;

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="${totalCols}">
        <div class="empty-state" style="padding:20px">
          <div class="empty-state-icon">👷</div>
          <div class="empty-state-title">Sin usuarios registrados</div>
        </div>
      </td></tr>`;
      return;
    }

    let i = 1;
    tbody.innerHTML = snap.docs.map(d => {
      const u    = d.data();
      const uid  = d.id;
      const esSA = u.rol === "SUPER_ADMIN";
      const activo = u.activo !== false;
      const ini  = (u.alias || "?").slice(0, 2).toUpperCase();
      const paleta = ["#7C3AED","#1D4ED8","#0E7490","#166534","#92400E","#1E3A5F","#6B21A8"];
      const color  = paleta[uid.charCodeAt(0) % paleta.length];
      const flags  = u.flags || {};

      const colsPriv = PRIVILEGIOS.map(f => `
        <td class="toggle-col">
          ${esSA
            ? `<label class="toggle"><input type="checkbox" checked disabled><span class="toggle-slider"></span></label>`
            : (!Sesion.esSuperAdmin() && f.soloSA
                ? `<label class="toggle" title="Solo Super Admin puede activar este flag" style="opacity:.5;cursor:not-allowed">
                    <input type="checkbox" ${flags[f.key] ? "checked" : ""} disabled>
                    <span class="toggle-slider"></span>
                   </label>`
                : `<label class="toggle">
                    <input type="checkbox" ${flags[f.key] ? "checked" : ""}
                      onchange="UsuariosUI.toggleFlag('${uid}','${f.key}',this.checked)">
                    <span class="toggle-slider"></span>
                   </label>`)}
        </td>`).join("");

      const colsMod = MODULOS.map(f => `
        <td class="toggle-col" style="border-left:${f === MODULOS[0] ? '1px solid #374151' : 'none'}">
          ${esSA
            ? `<label class="toggle"><input type="checkbox" checked disabled><span class="toggle-slider"></span></label>`
            : `<label class="toggle">
                <input type="checkbox" ${flags[f.key] !== false && (flags[f.key] ?? true) ? "checked" : ""}
                  onchange="UsuariosUI.toggleFlag('${uid}','${f.key}',this.checked)">
                <span class="toggle-slider"></span>
               </label>`}
        </td>`).join("");

      const colsAdmin = ADMIN_FLAGS.map(f => `
        <td class="toggle-col" style="background:#0f172a;border-left:${f === ADMIN_FLAGS[0] ? '1px solid #374151' : 'none'}">
          ${esSA
            ? `<label class="toggle"><input type="checkbox" checked disabled><span class="toggle-slider"></span></label>`
            : `<label class="toggle">
                <input type="checkbox" ${flags[f.key] ? "checked" : ""}
                  onchange="UsuariosUI.toggleFlag('${uid}','${f.key}',this.checked)">
                <span class="toggle-slider"></span>
               </label>`}
        </td>`).join("");

      return `
        <tr style="${!activo ? "opacity:.45" : ""}">
          <td class="rank-num">${i++}</td>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="user-ava" style="background:${color};color:#fff">${ini}</div>
              <div>
                <div class="user-name">${u.alias || "–"}</div>
                <div class="user-email">${u.email || "–"}</div>
              </div>
            </div>
          </td>
          <td><span class="role-pill ${_roleClass(u.rol)}">${u.rol || "–"}</span></td>
          ${colsPriv}
          ${colsMod}
          ${colsAdmin}
          <td>
            ${activo
              ? `<div style="display:flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:#16A34A">
                   <span style="width:5px;height:5px;border-radius:50%;background:#16A34A;display:inline-block"></span> Activo
                 </div>`
              : `<div style="display:flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:#DC2626">
                   <span style="width:5px;height:5px;border-radius:50%;background:#DC2626;display:inline-block"></span> Inactivo
                 </div>`}
          </td>
          <td>
            <div style="display:flex;gap:3px;flex-wrap:nowrap;align-items:center">
              ${esSA
                ? `<span style="font-size:9px;color:#9CA3AF;font-style:italic">Implícito</span>`
                : `<button class="action-btn edit"
                     onclick="UsuariosUI.abrirEditar('${uid}','${u.alias?.replace(/'/g,"\\'")}','${(u.email||"").replace(/'/g,"\\'")}')">
                     Editar
                   </button>
                   <button class="action-btn edit"
                     onclick="UsuariosUI.abrirCambioRol('${uid}','${u.rol}','${u.alias}')">
                     Rol
                   </button>
                   <button class="action-btn del"
                     onclick="UsuariosUI.toggleActivo('${uid}',${!activo})">
                     ${activo ? "Baja" : "Activar"}
                   </button>
                   ${Sesion.esSuperAdmin()
                     ? `<button class="action-btn del"
                          style="background:#7f1d1d;border-color:#991b1b;color:#fca5a5"
                          onclick="UsuariosUI.eliminarPermanente('${uid}','${(u.alias||u.email||"").replace(/'/g,"\\'")}')">
                          🗑
                        </button>`
                     : ""}`}
            </div>
          </td>
        </tr>`;
    }).join("");
  }, err => {
    console.error("[Usuarios]", err);
    window.toast?.("Error al cargar usuarios. Verifica la conexión.", "error");
  });

  _unsubs.push(unsub);
}

// ── Acciones ──────────────────────────────────────────────────
function _bindAcciones() {
  let _uidEditando = null;

  window.UsuariosUI = {

    nuevoUsuario() {
      const overlayEl = document.getElementById("modal-nuevo-usuario");
      overlayEl.classList.remove("hidden");
      this.previewPreset("INGENIERO");
      const cerrar = () => this.cerrarModal();
      overlayEl.addEventListener("click", e => { if (e.target === overlayEl) cerrar(); }, { once: true });
      const onKey = e => { if (e.key === "Escape") { cerrar(); document.removeEventListener("keydown", onKey); } };
      document.addEventListener("keydown", onKey);
    },

    cerrarModal() {
      document.querySelectorAll(".modal-overlay").forEach(m => m.classList.add("hidden"));
    },

    previewPreset(rol) {
      const el = document.getElementById("nu-preset-preview");
      if (!el) return;
      _renderPresetPreview(el, rol);
    },

    previewPresetCR(rol) {
      const el = document.getElementById("cr-preset-preview");
      if (!el) return;
      _renderPresetPreview(el, rol);
    },

    async guardarNuevo() {
      const email = document.getElementById("nu-email").value.trim().toLowerCase();
      const alias = document.getElementById("nu-alias").value.trim();
      const rol   = document.getElementById("nu-rol").value;

      if (!email || !alias) { window.toast?.("Completa todos los campos", "error"); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        window.toast?.("Correo inválido", "error"); return;
      }
      // Validaciones de longitud y caracteres permitidos
      if (alias.length > 60) { window.toast?.("El alias no puede superar 60 caracteres", "error"); return; }
      if (!/^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ0-9 _\-\.]+$/.test(alias)) {
        window.toast?.("El alias contiene caracteres no permitidos", "error"); return;
      }
      if (!PRESET[rol]) { window.toast?.("Rol no válido", "error"); return; }

      const uid = "pre_" + email.replace(/[@.]/g, "_") + "_" + Date.now();
      const flags = { ...PRESET[rol] };

      try {
        await setDoc(doc(db, "usuarios", uid), {
          email, alias, rol, activo: true, flags,
          creadoEn: serverTimestamp(),
          creadoPor: Sesion.uid,
          preRegistro: true
        });
        window.toast?.(`Usuario ${alias} pre-registrado como ${rol}`, "success");
        this.cerrarModal();
      } catch (e) {
        const msg = /permission|PERMISSION/.test(e.message || "")
          ? "Sin permisos para realizar esta acción."
          : "Error al guardar. Verifica tu conexión e intenta de nuevo.";
        window.toast?.(msg, "error");
      }
    },

    abrirEditar(uid, alias, email) {
      _uidEditando = uid;
      document.getElementById("eu-alias").value = alias;
      document.getElementById("eu-email").value = email;
      const overlayEl = document.getElementById("modal-editar-usuario");
      overlayEl.classList.remove("hidden");
      const cerrar = () => this.cerrarModal();
      overlayEl.addEventListener("click", e => { if (e.target === overlayEl) cerrar(); }, { once: true });
      const onKey = e => { if (e.key === "Escape") { cerrar(); document.removeEventListener("keydown", onKey); } };
      document.addEventListener("keydown", onKey);
    },

    async guardarEditar() {
      if (!_uidEditando) return;
      const alias = document.getElementById("eu-alias").value.trim();
      const email = document.getElementById("eu-email").value.trim().toLowerCase();
      if (!alias || !email) { window.toast?.("Completa todos los campos", "error"); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { window.toast?.("Correo inválido", "error"); return; }
      if (alias.length > 60) { window.toast?.("El alias no puede superar 60 caracteres", "error"); return; }
      if (!/^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ0-9 _\-\.]+$/.test(alias)) {
        window.toast?.("El alias contiene caracteres no permitidos", "error"); return;
      }
      try {
        await updateDoc(doc(db, "usuarios", _uidEditando), {
          alias, email,
          modificadoPor: Sesion.uid,
          modificadoEn: serverTimestamp()
        });
        window.toast?.("Usuario actualizado", "success");
        this.cerrarModal();
      } catch (e) {
        const msg = /permission|PERMISSION/.test(e.message || "")
          ? "Sin permisos para realizar esta acción."
          : "Error al guardar. Verifica tu conexión e intenta de nuevo.";
        window.toast?.(msg, "error");
      }
    },

    abrirCambioRol(uid, rolActual, alias) {
      _uidEditando = uid;
      document.getElementById("cr-usuario-info").textContent =
        `Usuario: ${alias} — Rol actual: ${rolActual}`;
      const sel = document.getElementById("cr-rol");
      sel.value = rolActual;
      this.previewPresetCR(rolActual);
      const overlayEl = document.getElementById("modal-cambiar-rol");
      overlayEl.classList.remove("hidden");
      const cerrar = () => this.cerrarModal();
      overlayEl.addEventListener("click", e => { if (e.target === overlayEl) cerrar(); }, { once: true });
      const onKey = e => { if (e.key === "Escape") { cerrar(); document.removeEventListener("keydown", onKey); } };
      document.addEventListener("keydown", onKey);
    },

    async confirmarCambioRol() {
      if (!_uidEditando) return;
      const nuevoRol    = document.getElementById("cr-rol").value;
      const aplicarPreset = document.getElementById("cr-aplicar-preset").checked;

      // Validar que el rol sea uno conocido antes de escribir en Firestore
      const ROLES_VALIDOS = ['SUPER_ADMIN','GERENTE','GERENTE_ZONA','INGENIERO',
                              'RECUPERADOR','ADMINISTRADOR','ALMACENISTA','JURIDICO','MESA_CONTROL'];
      if (!ROLES_VALIDOS.includes(nuevoRol)) {
        window.toast?.("Rol no válido", "error"); return;
      }

      const payload = {
        rol: nuevoRol,
        modificadoPor: Sesion.uid,
        modificadoEn: serverTimestamp()
      };
      if (aplicarPreset && PRESET[nuevoRol]) {
        const preset = PRESET[nuevoRol];
        Object.entries(preset).forEach(([k, v]) => {
          payload[`flags.${k}`] = v;
        });
      }

      try {
        await updateDoc(doc(db, "usuarios", _uidEditando), payload);
        window.toast?.(
          `Rol actualizado a ${nuevoRol}${aplicarPreset ? " con preset" : ""}`, "success");
        this.cerrarModal();
      } catch (e) {
        const msg = /permission|PERMISSION/.test(e.message || "")
          ? "Sin permisos para realizar esta acción."
          : "Error al guardar. Verifica tu conexión e intenta de nuevo.";
        window.toast?.(msg, "error");
      }
    },

    async toggleFlag(uid, flag, val) {
      try {
        await updateDoc(doc(db, "usuarios", uid), {
          [`flags.${flag}`]: val,
          modificadoPor: Sesion.uid,
          modificadoEn: serverTimestamp()
        });
      } catch (e) {
        const msg = /permission|PERMISSION/.test(e.message || "")
          ? "Sin permisos para realizar esta acción."
          : "Ocurrió un error. Intenta de nuevo.";
        window.toast?.(msg, "error");
      }
    },

    eliminarPermanente(uid, alias) {
      if (!Sesion.esSuperAdmin()) {
        window.toast?.("Solo SUPER_ADMIN puede eliminar usuarios permanentemente.", "error");
        return;
      }
      _uidEditando = uid;
      document.getElementById("del-info").innerHTML =
        `Vas a eliminar permanentemente al usuario <strong>${alias}</strong> (ID: <code style="font-size:10px">${uid}</code>).`;
      document.getElementById("del-confirm-hint").textContent = alias;
      document.getElementById("del-confirm-input").value = "";
      const btn = document.getElementById("del-confirm-btn");
      btn.disabled = true;
      btn.style.opacity = ".4";
      btn.style.cursor = "not-allowed";
      const overlay = document.getElementById("modal-eliminar-usuario");
      overlay.classList.remove("hidden");
      const cerrar = () => this.cerrarModal();
      overlay.addEventListener("click", e => { if (e.target === overlay) cerrar(); }, { once: true });
      const onKey = e => { if (e.key === "Escape") { cerrar(); document.removeEventListener("keydown", onKey); } };
      document.addEventListener("keydown", onKey);
    },

    _validarConfirmDelete() {
      const input = document.getElementById("del-confirm-input").value.trim();
      const hint  = document.getElementById("del-confirm-hint").textContent;
      const btn   = document.getElementById("del-confirm-btn");
      const ok    = input === hint;
      btn.disabled = !ok;
      btn.style.opacity = ok ? "1" : ".4";
      btn.style.cursor  = ok ? "pointer" : "not-allowed";
    },

    async _confirmarEliminar() {
      if (!_uidEditando || !Sesion.esSuperAdmin()) return;
      const btn = document.getElementById("del-confirm-btn");
      btn.disabled = true;
      btn.textContent = "Eliminando…";
      try {
        await deleteDoc(doc(db, "usuarios", _uidEditando));
        window.toast?.("Usuario eliminado permanentemente.", "success");
        this.cerrarModal();
      } catch (e) {
        const msg = /permission|PERMISSION/.test(e.message || "")
          ? "Sin permisos para eliminar."
          : "Error al eliminar. Intenta de nuevo.";
        window.toast?.(msg, "error");
        btn.disabled = false;
        btn.textContent = "Eliminar permanentemente";
      }
    },

    async toggleActivo(uid, nuevoEstado) {
      const accion = nuevoEstado ? "reactivar" : "dar de baja";
      if (!await window.modal({ title: nuevoEstado ? "Reactivar usuario" : "Dar de baja", message: `¿Deseas ${accion} a este usuario?`, danger: !nuevoEstado })) return;
      try {
        await updateDoc(doc(db, "usuarios", uid), {
          activo: nuevoEstado,
          modificadoPor: Sesion.uid,
          modificadoEn: serverTimestamp()
        });
        window.toast?.(`Usuario ${nuevoEstado ? "reactivado" : "dado de baja"}`, "success");
      } catch (e) {
        const msg = /permission|PERMISSION/.test(e.message || "")
          ? "Sin permisos para realizar esta acción."
          : "Ocurrió un error. Intenta de nuevo.";
        window.toast?.(msg, "error");
      }
    }
  };
}

// ── Helpers ───────────────────────────────────────────────────
const ROLES_ADMIN = new Set(["ADMINISTRADOR","ALMACENISTA","JURIDICO","GERENTE_ZONA"]);

function _roleClass(rol) {
  return {
    SUPER_ADMIN:"role-sa", GERENTE:"role-g", RECUPERADOR:"role-r",
    ADMINISTRADOR:"role-admin", ALMACENISTA:"role-almacen",
    JURIDICO:"role-juridico", GERENTE_ZONA:"role-gz"
  }[rol] || "role-i";
}

function _renderPresetPreview(el, rol) {
  const preset = PRESET[rol] || {};
  const flags  = ROLES_ADMIN.has(rol) ? TODOS_FLAGS_ADMIN : TODOS_FLAGS;
  const lineas = flags.map(f => {
    const ok = preset[f.key];
    return `<span style="color:${ok ? '#16A34A' : '#DC2626'}">${ok ? "✓" : "✗"} ${f.icon} ${f.label}</span>`;
  });
  el.innerHTML = `<b style="color:var(--text-primary)">Preset ${rol}:</b> ` + lineas.join("&nbsp;&nbsp;");
}
