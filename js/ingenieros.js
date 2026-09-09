// ══════════════════════════════════════════════════════════════
// ingenieros.js — Staff operativo con detalle completo
// Mejoras: KPIs · Zona/vehículo · Tel marcable · Filtros avanzados
//          Tiempo en campo · Productividad hoy · Drawer · Toggle tabla
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { estaEnJornadaHoy } from "./app.js";
import {
  collection, query, orderBy, where, onSnapshot,
  getDocs, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { exportarExcel } from "./excel-utils.js";

// ── Esc helper ────────────────────────────────────────────────
let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

// ── Columnas Excel ────────────────────────────────────────────
const _COLS_ING = [
  { key: "alias",     header: "Alias",           width: 14, required: true,  ejemplo: "jperez" },
  { key: "nombre",    header: "Nombre completo",  width: 24, required: true,  ejemplo: "Juan Pérez García" },
  { key: "telefono",  header: "Teléfono",         width: 16, ejemplo: "5551234567" },
  { key: "email",     header: "Correo",           width: 26, ejemplo: "jperez@empresa.com" },
  { key: "zona",      header: "Zona",             width: 14, ejemplo: "Norte" },
  { key: "vehiculo",  header: "Vehículo",         width: 16, ejemplo: "Nissan NP300 ABC-123" },
  { key: "activo",    header: "Activo (SI/NO)",   width: 14, tipo: "booleano", ejemplo: "SI" },
];
const _COLS_CLI = [
  { key: "nombre",       header: "Nombre",          width: 28, required: true },
  { key: "telefono",     header: "Teléfono",        width: 16 },
  { key: "direccion",    header: "Dirección",       width: 36 },
  { key: "segmento",     header: "Segmento",        width: 14 },
  { key: "saldo",        header: "Saldo ($)",       width: 14, tipo: "numero" },
  { key: "ingeniero",    header: "Ingeniero asig.", width: 18 },
  { key: "ultimaVisita", header: "Última visita",   width: 18, fmt: "fecha" },
  { key: "activo",       header: "Activo",          width: 10 },
];

// ── Exportaciones globales ────────────────────────────────────
window.Cli_xlExport = async function() {
  try {
    const snap = await getDocs(query(collection(db, "clientes"), orderBy("nombre")));
    const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    if (!rows.length) { window.toast?.("No hay clientes para exportar.", "info"); return; }
    exportarExcel(rows, _COLS_CLI, "Clientes", "Clientes");
  } catch(e) { window.toast?.("Error al exportar clientes.", "error"); }
};

window.Ing_xlExport = async function() {
  try {
    const snap = await getDocs(collection(db, "usuarios"));
    const rows = snap.docs
      .filter(d => ["INGENIERO","RECUPERADOR"].includes(d.data().rol))
      .map(d => ({ ...d.data(), id: d.id }));
    exportarExcel(rows, _COLS_ING, "Ingenieros", "Ingenieros");
  } catch(e) { window.toast?.("Error al exportar: " + e.message, "error"); }
};

// ── Estado del módulo ─────────────────────────────────────────
let _unsubUsuarios   = null;
let _unsubUbicaciones = null;
let _usuarios    = [];
let _ubicaciones = {};
let _pedidosHoy  = {};   // alias → count
let _visitasHoy  = {};   // alias → count
let _filtroActivo = "TODOS";
let _filtroSenal  = "TODAS";
let _filtroZona   = "TODAS";
let _busqueda     = "";
let _vistaTabla   = false;
let _drawerAlias  = null;

const fmt    = n => Number(n||0).toLocaleString("es-MX", { style:"currency", currency:"MXN" });
const fmtHora = d => new Date(d?.toDate?.() ?? d).toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" });
const DIAS   = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];

// ── Mount / Destroy ───────────────────────────────────────────
export const IngenierosModule = {
  mount(container) {
    container.innerHTML = _html();
    _bindUI();
    _escuchar();
    _cargarProductividad();
    return () => this.destroy();
  },
  destroy() {
    _unsubUsuarios?.();    _unsubUsuarios   = null;
    _unsubUbicaciones?.(); _unsubUbicaciones = null;
    _usuarios = []; _ubicaciones = {};
    _pedidosHoy = {}; _visitasHoy = {};
    _filtroActivo = "TODOS"; _filtroSenal = "TODAS";
    _filtroZona = "TODAS"; _busqueda = "";
    _vistaTabla = false; _drawerAlias = null;
    _unregEsc();
  }
};

// ── HTML principal ────────────────────────────────────────────
function _html() {
  return `
  <div style="padding:0 0 24px">

    <!-- KPIs -->
    <div id="ing-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
      gap:10px;margin-bottom:14px"></div>

    <!-- Controles -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);
      padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
      box-shadow:0 1px 3px rgba(0,0,0,.06)">

      <!-- Búsqueda -->
      <div style="position:relative;flex:1;min-width:160px">
        <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);
          font-size:13px;color:var(--text-muted)">🔍</span>
        <input id="ing-busqueda" type="text" placeholder="Buscar nombre o alias…"
          oninput="IngenierosUI.setBusqueda(this.value)"
          style="width:100%;box-sizing:border-box;padding:6px 10px 6px 30px;
            border:1px solid var(--border);border-radius:6px;font-size:12px;
            background:var(--surface);color:var(--text-primary)">
      </div>

      <!-- Jornada pills -->
      <span style="font-size:11px;font-weight:700;color:var(--text-muted)">Jornada:</span>
      ${[["TODOS","Todos",""],["EN_JORNADA","En jornada","#16A34A"],["FUERA","Fuera","#DC2626"],["EN_VIVO","● En vivo","#16A34A"]].map(([f,label,c]) => `
        <button class="filter-pill ${f==="TODOS"?"active":""}" data-ing-f="${f}"
          onclick="IngenierosUI.setFiltro('${f}')"
          ${c ? `style="border-color:${c};color:${c}"` : ""}>
          ${label}
        </button>`).join("")}

      <!-- Zona -->
      <select id="ing-zona-sel" onchange="IngenierosUI.setZona(this.value)"
        style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;
          font-size:12px;background:var(--surface);color:var(--text-primary)">
        <option value="TODAS">Todas las zonas</option>
      </select>

      <!-- Toggle vista -->
      <button id="ing-toggle-vista" onclick="IngenierosUI.toggleVista()"
        title="Cambiar vista"
        style="padding:5px 10px;border:1px solid var(--border);border-radius:6px;
          background:var(--surface);cursor:pointer;font-size:14px">⊞</button>

      <!-- Acciones -->
      <button onclick="Ing_xlExport()"
        style="padding:6px 12px;background:var(--accent);color:#fff;border:none;
          border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">⬇️ Excel</button>
      <button onclick="IngenierosUI.abrirAlta()"
        style="padding:6px 14px;border-radius:6px;border:none;background:#1B5E20;
          color:#fff;font-size:12px;font-weight:700;cursor:pointer">+ Nuevo staff</button>
    </div>

    <!-- Grid / Tabla de ingenieros -->
    <div id="ing-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px">
      <div style="padding:30px;text-align:center;color:var(--text-muted);font-size:13px;
        grid-column:1/-1">Cargando ingenieros…</div>
    </div>
  </div>

  <!-- Drawer lateral de detalle -->
  <div id="ing-drawer-overlay" onclick="IngenierosUI.cerrarDrawer()"
    style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:900;
      animation:ingFadeIn .15s ease"></div>
  <div id="ing-drawer"
    style="display:none;position:fixed;top:0;right:0;bottom:0;width:360px;max-width:92vw;
      background:var(--surface);border-left:1px solid var(--border);z-index:901;
      overflow-y:auto;box-shadow:-8px 0 32px rgba(0,0,0,.18);
      animation:ingSlideIn .2s ease">
    <div id="ing-drawer-body" style="padding:22px"></div>
  </div>

  <!-- Modal alta/edición -->
  <div id="ing-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);
    z-index:1000;align-items:center;justify-content:center">
    <div style="background:var(--surface);border-radius:14px;padding:28px;
      width:420px;max-width:94vw;border:1px solid var(--border);
      max-height:90vh;overflow-y:auto">
      <div style="font-size:15px;font-weight:800;color:var(--text-primary);margin-bottom:18px">
        Nuevo ingeniero / recuperador
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">
            Alias* <span style="color:var(--text-muted);font-weight:400">(sin espacios)</span>
          </label>
          <input id="ing-f-alias" type="text" maxlength="20" autocomplete="off" placeholder="jperez"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">Rol*</label>
          <select id="ing-f-rol"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
            <option value="INGENIERO">Ingeniero</option>
            <option value="RECUPERADOR">Recuperador</option>
            <option value="GERENTE_ZONA">Gerente de zona</option>
          </select>
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">Nombre completo*</label>
        <input id="ing-f-nombre" type="text" maxlength="80" placeholder="Juan Pérez García"
          style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
            font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">Correo*</label>
          <input id="ing-f-email" type="email" maxlength="80" placeholder="jperez@empresa.com"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">Teléfono</label>
          <input id="ing-f-tel" type="tel" maxlength="15" placeholder="5551234567"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">Zona</label>
          <input id="ing-f-zona" type="text" maxlength="40" placeholder="Norte"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">Vehículo</label>
          <input id="ing-f-vehiculo" type="text" maxlength="50" placeholder="Nissan NP300 ABC-123"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">
            Día de liquidación
          </label>
          <select id="ing-f-dia-liq"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
            <option value="1">Lunes</option>
            <option value="2">Martes</option>
            <option value="3">Miércoles</option>
            <option value="4">Jueves</option>
            <option value="5">Viernes</option>
            <option value="6">Sábado</option>
            <option value="0">Domingo</option>
          </select>
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;color:var(--text-sec);display:block;margin-bottom:4px">
            Salario base semanal ($)
          </label>
          <input id="ing-f-salario" type="number" min="0" step="100" placeholder="0.00"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:13px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;
        padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)">
        <div style="font-size:12px;font-weight:600;color:var(--text-primary);flex:1">
          Cuenta activa
          <span style="display:block;font-weight:400;color:var(--text-sec);font-size:11px">
            Desactivar impide el acceso a la plataforma y a la APK
          </span>
        </div>
        <input type="checkbox" id="ing-f-activo" checked style="display:none">
        <div id="ing-toggle-activo"
          onclick="(function(t){var cb=document.getElementById('ing-f-activo');cb.checked=!cb.checked;t.style.background=cb.checked?'#16a34a':'#D1D5DB';document.getElementById('ing-toggle-knob').style.left=cb.checked?'22px':'3px';})(this)"
          style="position:relative;width:44px;height:24px;border-radius:12px;background:#16a34a;cursor:pointer;
            transition:background .2s;flex-shrink:0">
          <div id="ing-toggle-knob"
            style="position:absolute;top:3px;left:22px;width:18px;height:18px;border-radius:50%;
              background:var(--surface);transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)"></div>
        </div>
      </div>
      <div style="background:#FEF9C3;border:1px solid #FDE047;border-radius:8px;padding:10px 12px;
        font-size:11px;color:#713F12;margin-bottom:18px;line-height:1.5">
        ⚠️ Después de guardar, crea la cuenta en <strong>Firebase Console → Authentication</strong>
        con el mismo correo. El ingeniero aparecerá en la APK en el próximo sync.
      </div>
      <div id="ing-modal-error" style="display:none;background:#FEE2E2;border-radius:6px;
        padding:8px 12px;font-size:11.5px;color:#DC2626;margin-bottom:12px"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button onclick="IngenierosUI.cerrarAlta()"
          style="padding:8px 18px;border:1px solid var(--border);border-radius:6px;
            background:transparent;color:var(--text-primary);font-size:12px;cursor:pointer">
          Cancelar
        </button>
        <button onclick="IngenierosUI.guardarAlta()"
          style="padding:8px 22px;border:none;border-radius:6px;
            background:#1B5E20;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
          Guardar
        </button>
      </div>
    </div>
  </div>

  <style>
    @keyframes ingFadeIn  { from { opacity:0 } to { opacity:1 } }
    @keyframes ingSlideIn { from { transform:translateX(100%) } to { transform:none } }
  </style>`;
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI() {
  window.IngenierosUI = {
    setFiltro(f) {
      _filtroActivo = f;
      document.querySelectorAll("[data-ing-f]").forEach(b =>
        b.classList.toggle("active", b.dataset.ingF === f));
      _render();
    },
    setZona(z)      { _filtroZona   = z; _render(); },
    setBusqueda(v)  { _busqueda     = v.toLowerCase().trim(); _render(); },
    toggleVista()   {
      _vistaTabla = !_vistaTabla;
      const btn = document.getElementById("ing-toggle-vista");
      if (btn) btn.textContent = _vistaTabla ? "⊟" : "⊞";
      const grid = document.getElementById("ing-grid");
      if (grid) {
        grid.style.gridTemplateColumns = _vistaTabla
          ? "1fr"
          : "repeat(auto-fill,minmax(290px,1fr))";
      }
      _render();
    },

    abrirDrawer(alias) {
      _drawerAlias = alias;
      const u = _usuarios.find(u => u.alias === alias || u.id === alias);
      if (!u) return;
      _renderDrawer(u);
      document.getElementById("ing-drawer-overlay").style.display = "block";
      document.getElementById("ing-drawer").style.display = "block";
      _regEsc(() => this.cerrarDrawer());
    },
    cerrarDrawer() {
      document.getElementById("ing-drawer-overlay").style.display = "none";
      document.getElementById("ing-drawer").style.display = "none";
      _drawerAlias = null;
      _unregEsc();
    },

    abrirAlta() {
      ["ing-f-alias","ing-f-nombre","ing-f-email","ing-f-tel","ing-f-zona","ing-f-vehiculo","ing-f-salario"]
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
      const diaEl = document.getElementById("ing-f-dia-liq");
      if (diaEl) diaEl.value = "1";
      const rol = document.getElementById("ing-f-rol");
      if (rol) rol.value = "INGENIERO";
      const err = document.getElementById("ing-modal-error");
      if (err) err.style.display = "none";
      const aliasEl = document.getElementById("ing-f-alias");
      if (aliasEl) aliasEl.readOnly = false;
      const activoCb = document.getElementById("ing-f-activo");
      const toggleBg = document.getElementById("ing-toggle-activo");
      const knob = document.getElementById("ing-toggle-knob");
      if (activoCb) activoCb.checked = true;
      if (toggleBg) toggleBg.style.background = "#16a34a";
      if (knob) knob.style.left = "22px";
      document.getElementById("ing-modal").style.display = "flex";
      _regEsc(() => IngenierosUI.cerrarAlta());
      setTimeout(() => document.getElementById("ing-f-alias")?.focus(), 80);
    },

    cerrarAlta() {
      _unregEsc();
      document.getElementById("ing-modal").style.display = "none";
    },

    async editarPerfil(alias) {
      const { getDoc, doc: fsDoc } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const { db: fdb } = await import("./firebase-config.js");
      const snap = await getDoc(fsDoc(fdb, "usuarios", alias));
      const u = snap.exists() ? snap.data() : {};

      document.getElementById("ing-f-alias").value     = alias;
      document.getElementById("ing-f-nombre").value    = u.nombre || "";
      document.getElementById("ing-f-email").value     = u.email  || "";
      document.getElementById("ing-f-tel").value       = u.telefono || "";
      document.getElementById("ing-f-zona").value      = u.zona    || "";
      document.getElementById("ing-f-vehiculo").value  = u.vehiculo || "";
      document.getElementById("ing-f-salario").value   = u.salarioBase || "";
      const diaEl = document.getElementById("ing-f-dia-liq");
      if (diaEl) diaEl.value = String(u.diaLiquidacion ?? 1);
      const rolEl = document.getElementById("ing-f-rol");
      if (rolEl && u.rol) rolEl.value = u.rol;
      const activoVal = u.activo !== false;
      const activoCb = document.getElementById("ing-f-activo");
      const toggleBg = document.getElementById("ing-toggle-activo");
      const knob = document.getElementById("ing-toggle-knob");
      if (activoCb) activoCb.checked = activoVal;
      if (toggleBg) toggleBg.style.background = activoVal ? "#16a34a" : "#D1D5DB";
      if (knob) knob.style.left = activoVal ? "22px" : "3px";
      document.getElementById("ing-f-alias").readOnly = true;
      document.getElementById("ing-modal").style.display = "flex";
      _regEsc(() => IngenierosUI.cerrarAlta());
    },

    async guardarAlta() {
      const alias   = document.getElementById("ing-f-alias").value.trim().toLowerCase().replace(/\s+/g,"");
      const nombre  = document.getElementById("ing-f-nombre").value.trim();
      const email   = document.getElementById("ing-f-email").value.trim().toLowerCase();
      const tel     = document.getElementById("ing-f-tel").value.trim();
      const zona    = document.getElementById("ing-f-zona").value.trim();
      const vehiculo    = document.getElementById("ing-f-vehiculo").value.trim();
      const rol         = document.getElementById("ing-f-rol").value;
      const diaLiq      = parseInt(document.getElementById("ing-f-dia-liq")?.value ?? "1");
      const salarioBase = parseFloat(document.getElementById("ing-f-salario")?.value) || 0;
      const activo      = document.getElementById("ing-f-activo")?.checked !== false;
      const esEdicion   = document.getElementById("ing-f-alias").readOnly;

      const errEl = document.getElementById("ing-modal-error");
      const mostrarError = msg => { errEl.textContent = msg; errEl.style.display = "block"; };

      if (!alias)  { mostrarError("El alias es obligatorio."); return; }
      if (!/^[a-z0-9_-]{2,20}$/.test(alias)) {
        mostrarError("Alias solo puede contener letras, números, guion o guion bajo (2-20 caracteres)."); return;
      }
      if (!nombre) { mostrarError("El nombre es obligatorio."); return; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        mostrarError("Ingresa un correo válido."); return;
      }

      errEl.style.display = "none";
      const btn = document.querySelector("#ing-modal button[onclick='IngenierosUI.guardarAlta()']");
      if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }

      try {
        const { setDoc, doc, serverTimestamp, getDoc } =
          await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const { db: fdb } = await import("./firebase-config.js");

        const ref = doc(fdb, "usuarios", alias);
        if (!esEdicion) {
          const existe = await getDoc(ref);
          if (existe.exists()) {
            mostrarError(`Ya existe un usuario con alias "${alias}". Usa uno diferente.`);
            if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
            return;
          }
        }

        await setDoc(ref, {
          alias, nombre, email,
          ...(tel      ? { telefono: tel }  : {}),
          ...(zona     ? { zona }           : {}),
          ...(vehiculo ? { vehiculo }       : {}),
          diaLiquidacion: diaLiq,
          salarioBase, rol, activo,
          creadoPor: window.Sesion?.alias ?? "web",
          creadoEn:  serverTimestamp()
        });

        document.getElementById("ing-f-alias").readOnly = false;
        window.toast?.(`Ingeniero "${alias}" ${esEdicion ? "actualizado" : "registrado"} correctamente.`, "success");
        this.cerrarAlta();
      } catch(e) {
        mostrarError("Error al guardar: " + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
      }
    }
  };
}

// ── Carga de productividad (pedidos + visitas de hoy) ─────────
async function _cargarProductividad() {
  const hoyInicio = new Date(); hoyInicio.setHours(0,0,0,0);
  const ts = Timestamp.fromDate(hoyInicio);
  try {
    const [snapPed, snapVis] = await Promise.all([
      getDocs(query(collection(db,"pedidos"),
        where("fechaCreacion",">=",ts))),
      getDocs(query(collection(db,"visitas"),
        where("fecha",">=",ts))),
    ]);
    _pedidosHoy = {};
    snapPed.forEach(d => {
      const alias = d.data().ingenieroAlias || d.data().ingeniero || "";
      if (alias) _pedidosHoy[alias] = (_pedidosHoy[alias]||0) + 1;
    });
    _visitasHoy = {};
    snapVis.forEach(d => {
      const alias = d.data().ingenieroAlias || d.data().alias || "";
      if (alias) _visitasHoy[alias] = (_visitasHoy[alias]||0) + 1;
    });
    _render();
  } catch(e) {
    console.warn("[Ingenieros] productividad:", e.message);
  }
}

// ── Listeners Firestore ───────────────────────────────────────
function _escuchar() {
  _unsubUsuarios = onSnapshot(
    query(collection(db,"usuarios"), orderBy("alias")),
    snap => {
      _usuarios = snap.docs.map(d => ({ id:d.id, ...d.data() }))
        .filter(u => u.activo !== false && ["INGENIERO","RECUPERADOR","GERENTE_ZONA"].includes(u.rol));
      _actualizarZonas();
      _render();
    },
    err => { console.error("[Ingenieros:usuarios]", err); }
  );

  _unsubUbicaciones = onSnapshot(
    collection(db,"ubicaciones"),
    snap => {
      _ubicaciones = {};
      snap.forEach(d => { _ubicaciones[d.id] = { id:d.id, ...d.data() }; });
      _render();
    },
    err => { console.error("[Ingenieros:ubicaciones]", err); }
  );
}

function _actualizarZonas() {
  const sel = document.getElementById("ing-zona-sel");
  if (!sel) return;
  const prev = sel.value;
  const zonas = [...new Set(_usuarios.map(u => u.zona).filter(Boolean))].sort();
  sel.innerHTML = `<option value="TODAS">Todas las zonas</option>` +
    zonas.map(z => `<option value="${z}"${z===prev?" selected":""}>${z}</option>`).join("");
}

// ── Render principal ──────────────────────────────────────────
function _render() {
  const ahora = Date.now();
  let lista = _usuarios.map(u => {
    const ub   = _ubicaciones[u.id] || _ubicaciones[u.alias] || null;
    const ts   = typeof ub?.timestamp === "number"
      ? ub.timestamp
      : (ub?.timestamp?.toDate?.()?.getTime() ?? 0);
    const mins = ts ? Math.floor((ahora - ts) / 60000) : null;
    const enJornada = estaEnJornadaHoy(ub);
    const enVivo    = mins !== null && mins < 5;
    // Tiempo en campo desde inicio de jornada
    const inicioTs  = ub?.inicioJornada?.toDate?.()?.getTime?.() ?? null;
    const tiempoCampo = inicioTs ? Math.floor((ahora - inicioTs) / 60000) : null;
    return { ...u, ub, ts, mins, enJornada, enVivo, tiempoCampo };
  });

  // Filtros
  if (_filtroActivo === "EN_JORNADA") lista = lista.filter(u => u.enJornada);
  if (_filtroActivo === "FUERA")      lista = lista.filter(u => !u.enJornada);
  if (_filtroActivo === "EN_VIVO")    lista = lista.filter(u => u.enVivo);
  if (_filtroZona !== "TODAS")        lista = lista.filter(u => u.zona === _filtroZona);
  if (_busqueda) {
    lista = lista.filter(u =>
      (u.nombre||"").toLowerCase().includes(_busqueda) ||
      (u.alias||"").toLowerCase().includes(_busqueda));
  }

  // KPIs
  const total     = _usuarios.length;
  const enJornada = _usuarios.filter(u => estaEnJornadaHoy(_ubicaciones[u.id]||_ubicaciones[u.alias])).length;
  const enVivo    = _usuarios.filter(u => {
    const ub = _ubicaciones[u.id]||_ubicaciones[u.alias];
    const ts = typeof ub?.timestamp==="number" ? ub.timestamp : (ub?.timestamp?.toDate?.()?.getTime()??0);
    return ts && (ahora-ts)/60000 < 5;
  }).length;
  const sinSenal = _usuarios.filter(u => {
    const ub = _ubicaciones[u.id]||_ubicaciones[u.alias];
    return !ub?.lat;
  }).length;
  _renderKPIs(total, enJornada, enVivo, sinSenal);

  const grid = document.getElementById("ing-grid");
  if (!grid) return;
  if (!lista.length) {
    grid.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-muted);
      font-size:13px;grid-column:1/-1">Sin ingenieros para este filtro.</div>`;
    return;
  }

  grid.innerHTML = _vistaTabla ? _renderTabla(lista) : lista.map(u => _renderTarjeta(u)).join("");

  // Si el drawer está abierto y el usuario cambió, re-renderizarlo
  if (_drawerAlias) {
    const u = lista.find(u => u.alias === _drawerAlias);
    if (u) _renderDrawer(u);
  }
}

function _renderKPIs(total, enJornada, enVivo, sinSenal) {
  const el = document.getElementById("ing-kpis");
  if (!el) return;
  el.innerHTML = [
    ["Total staff",    total,     "var(--text-primary)", "👥"],
    ["En jornada",     enJornada, "#16A34A",             "✅"],
    ["En vivo (GPS)",  enVivo,    "#2563EB",             "📡"],
    ["Sin señal GPS",  sinSenal,  "#DC2626",             "📵"],
  ].map(([label, val, color, ico]) => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;
      padding:12px 16px;border-left:4px solid ${color};box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;
        letter-spacing:.06em;margin-bottom:4px">${ico} ${label}</div>
      <div style="font-size:22px;font-weight:800;color:${color};font-variant-numeric:tabular-nums">${val}</div>
    </div>`).join("");
}

// ── Tarjeta individual ────────────────────────────────────────
function _renderTarjeta(u) {
  const senalColor = u.enVivo ? "#16A34A" : u.mins !== null && u.mins < 60 ? "#D97706" : "#9CA3AF";
  const jornadaBadge = u.enJornada
    ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;
        background:#DCFCE7;color:#16A34A">● En jornada</span>`
    : `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;
        background:var(--surface-2,#f1f5f9);color:var(--text-sec)">Fuera de jornada</span>`;
  const senalTxt = u.mins === null ? "Sin señal GPS"
    : u.mins < 5  ? "● En vivo"
    : u.mins < 60 ? `${u.mins} min sin señal`
    : "Sin señal reciente";
  const rolColor = u.rol === "RECUPERADOR" ? "#15803D" : u.rol === "GERENTE_ZONA" ? "#7C3AED" : "#1565C0";

  const tiempoHtml = u.tiempoCampo !== null
    ? `<span style="font-size:10px;background:#EFF6FF;color:#1D4ED8;padding:2px 7px;
        border-radius:6px;font-weight:600">⏱ ${_fmtTiempo(u.tiempoCampo)}</span>`
    : "";

  const prodHtml = (_pedidosHoy[u.alias]||_visitasHoy[u.alias])
    ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        ${_pedidosHoy[u.alias] ? `<span style="font-size:10px;background:#F0FDF4;color:#15803D;
          padding:2px 7px;border-radius:6px;font-weight:600">📦 ${_pedidosHoy[u.alias]} pedido${_pedidosHoy[u.alias]>1?"s":""}</span>` : ""}
        ${_visitasHoy[u.alias] ? `<span style="font-size:10px;background:#FEF3C7;color:#92400E;
          padding:2px 7px;border-radius:6px;font-weight:600">🏠 ${_visitasHoy[u.alias]} visita${_visitasHoy[u.alias]>1?"s":""}</span>` : ""}
      </div>`
    : "";

  return `<div onclick="IngenierosUI.abrirDrawer('${u.alias}')"
    style="background:var(--surface);border-radius:12px;border:1px solid var(--border);padding:16px;
      box-shadow:0 1px 3px rgba(0,0,0,.06);cursor:pointer;transition:box-shadow .15s,border-color .15s"
    onmouseenter="this.style.boxShadow='0 4px 12px rgba(0,0,0,.1)';this.style.borderColor='${rolColor}44'"
    onmouseleave="this.style.boxShadow='0 1px 3px rgba(0,0,0,.06)';this.style.borderColor='var(--border)'">

    <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:10px">
      <div style="width:40px;height:40px;border-radius:50%;background:${rolColor}1A;
        display:flex;align-items:center;justify-content:center;
        font-size:16px;font-weight:800;color:${rolColor};flex-shrink:0">
        ${(u.nombre||u.alias||"?").charAt(0).toUpperCase()}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:700;color:var(--text-primary);white-space:nowrap;
          overflow:hidden;text-overflow:ellipsis">${u.nombre || u.alias}</div>
        <div style="font-size:11px;color:var(--text-sec);margin-top:1px">${u.alias}</div>
        <div style="font-size:11px;color:${rolColor};font-weight:600;margin-top:1px">${u.rol}</div>
      </div>
      ${jornadaBadge}
    </div>

    <!-- GPS -->
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
      <span style="width:8px;height:8px;border-radius:50%;background:${senalColor};flex-shrink:0"></span>
      <span style="font-size:11px;color:${u.enVivo?"#16A34A":"var(--text-sec)"};font-weight:${u.enVivo?700:400}">${senalTxt}</span>
      ${u.ts ? `<span style="font-size:11px;color:var(--text-muted);margin-left:auto">${fmtHora(new Date(u.ts))}</span>` : ""}
    </div>

    <!-- Ubicación -->
    ${u.ub?.lat && u.ub?.lng
      ? `<a href="https://www.google.com/maps?q=${u.ub.lat},${u.ub.lng}" target="_blank"
          onclick="event.stopPropagation()"
          style="display:block;font-size:11px;color:#1565C0;text-decoration:none;font-weight:600">
          📍 Ver en Google Maps</a>`
      : `<span style="font-size:11px;color:var(--text-muted)">Sin ubicación registrada</span>`}

    <!-- Productividad hoy -->
    ${prodHtml}

    <!-- Footer badges -->
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);
      display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      ${u.diaLiquidacion !== undefined ? `<span style="font-size:10px;background:#EFF6FF;color:#1D4ED8;
          padding:2px 7px;border-radius:6px;font-weight:600">📅 Liq. ${DIAS[u.diaLiquidacion??1]}</span>` : ""}
      ${u.salarioBase > 0 ? `<span style="font-size:10px;background:#F0FDF4;color:#15803D;
          padding:2px 7px;border-radius:6px;font-weight:600">💵 ${fmt(u.salarioBase)}/sem</span>` : ""}
      ${u.zona ? `<span style="font-size:10px;background:#F5F3FF;color:#6D28D9;
          padding:2px 7px;border-radius:6px;font-weight:600">🗺️ ${u.zona}</span>` : ""}
      ${u.vehiculo ? `<span style="font-size:10px;background:#FFF7ED;color:#C2410C;
          padding:2px 7px;border-radius:6px;font-weight:600">🚗 ${u.vehiculo}</span>` : ""}
      ${tiempoHtml}
      <button onclick="event.stopPropagation();IngenierosUI.editarPerfil('${u.alias}')"
        style="margin-left:auto;font-size:10px;padding:3px 9px;border:1px solid var(--border);
          border-radius:5px;background:var(--surface);cursor:pointer;color:var(--text-primary);font-weight:600">
        ✏️ Editar
      </button>
    </div>
  </div>`;
}

// ── Vista tabla ───────────────────────────────────────────────
function _renderTabla(lista) {
  const thStyle = "padding:9px 12px;text-align:left;font-weight:700;color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;border-bottom:2px solid var(--border);background:var(--surface-2,#f8fafc)";
  const tdStyle = "padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:middle;font-size:12px";
  return `<div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);
    overflow:hidden;grid-column:1/-1">
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="${thStyle}">Nombre</th>
        <th style="${thStyle}">Rol</th>
        <th style="${thStyle}">Zona</th>
        <th style="${thStyle}">Jornada</th>
        <th style="${thStyle}">Señal GPS</th>
        <th style="${thStyle}">Hora señal</th>
        <th style="${thStyle}">Pedidos</th>
        <th style="${thStyle}">Visitas</th>
        <th style="${thStyle}">Vehículo</th>
        <th style="${thStyle}">Día liq.</th>
        <th style="${thStyle}">Teléfono</th>
        <th style="${thStyle}"></th>
      </tr></thead>
      <tbody>${lista.map(u => {
        const senalColor = u.enVivo ? "#16A34A" : u.mins !== null && u.mins < 60 ? "#D97706" : "#9CA3AF";
        const senalTxt   = u.mins === null ? "Sin señal" : u.mins < 5 ? "En vivo" : u.mins < 60 ? `${u.mins}m` : "Sin señal";
        const rolColor   = u.rol === "RECUPERADOR" ? "#15803D" : u.rol === "GERENTE_ZONA" ? "#7C3AED" : "#1565C0";
        return `<tr style="cursor:pointer" onclick="IngenierosUI.abrirDrawer('${u.alias}')"
          onmouseenter="this.style.background='var(--surface-2,#f8fafc)'"
          onmouseleave="this.style.background=''">
          <td style="${tdStyle}">
            <div style="font-weight:600;color:var(--text-primary)">${u.nombre||u.alias}</div>
            <div style="font-size:10px;color:var(--text-muted)">${u.alias}</div>
          </td>
          <td style="${tdStyle}"><span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:9px;
            background:${rolColor}18;color:${rolColor}">${u.rol}</span></td>
          <td style="${tdStyle};color:var(--text-muted)">${u.zona||"—"}</td>
          <td style="${tdStyle}">
            ${u.enJornada
              ? `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:9px;background:#DCFCE7;color:#16A34A">● En jornada</span>`
              : `<span style="font-size:10px;color:var(--text-muted)">Fuera</span>`}
          </td>
          <td style="${tdStyle}">
            <span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:${u.enVivo?700:400};color:${senalColor}">
              <span style="width:7px;height:7px;border-radius:50%;background:${senalColor}"></span>${senalTxt}
            </span>
          </td>
          <td style="${tdStyle};color:var(--text-muted)">${u.ts ? fmtHora(new Date(u.ts)) : "—"}</td>
          <td style="${tdStyle};text-align:center">
            ${_pedidosHoy[u.alias] ? `<span style="font-weight:700;color:#15803D">${_pedidosHoy[u.alias]}</span>` : `<span style="color:var(--text-muted)">—</span>`}
          </td>
          <td style="${tdStyle};text-align:center">
            ${_visitasHoy[u.alias] ? `<span style="font-weight:700;color:#92400E">${_visitasHoy[u.alias]}</span>` : `<span style="color:var(--text-muted)">—</span>`}
          </td>
          <td style="${tdStyle};color:var(--text-muted);font-size:11px">${u.vehiculo||"—"}</td>
          <td style="${tdStyle};color:var(--text-muted)">${u.diaLiquidacion!==undefined?DIAS[u.diaLiquidacion??1]:"—"}</td>
          <td style="${tdStyle}">
            ${u.telefono
              ? `<a href="tel:${u.telefono}" onclick="event.stopPropagation()"
                  style="font-size:11px;color:#1565C0;text-decoration:none;font-weight:600">
                  📞 ${u.telefono}</a>`
              : `<span style="color:var(--text-muted)">—</span>`}
          </td>
          <td style="${tdStyle}">
            <button onclick="event.stopPropagation();IngenierosUI.editarPerfil('${u.alias}')"
              style="font-size:10px;padding:3px 9px;border:1px solid var(--border);border-radius:5px;
                background:var(--surface);cursor:pointer;font-weight:600">✏️</button>
          </td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
  </div>`;
}

// ── Drawer de detalle ─────────────────────────────────────────
function _renderDrawer(u) {
  const body = document.getElementById("ing-drawer-body");
  if (!body) return;
  const rolColor   = u.rol === "RECUPERADOR" ? "#15803D" : u.rol === "GERENTE_ZONA" ? "#7C3AED" : "#1565C0";
  const senalColor = u.enVivo ? "#16A34A" : u.mins !== null && u.mins < 60 ? "#D97706" : "#9CA3AF";
  const senalTxt   = u.mins === null ? "Sin señal GPS" : u.mins < 5 ? "● En vivo" : u.mins < 60 ? `${u.mins} min sin señal` : "Sin señal reciente";

  const row = (ico, label, val, href) => {
    if (!val) return "";
    const content = href
      ? `<a href="${href}" target="_blank" style="color:#1565C0;text-decoration:none;font-weight:600">${val}</a>`
      : `<span style="font-weight:600;color:var(--text-primary)">${val}</span>`;
    return `<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:14px;flex-shrink:0">${ico}</span>
      <span style="font-size:11px;color:var(--text-muted);min-width:90px">${label}</span>
      ${content}
    </div>`;
  };

  const badge = (label, color, bg) =>
    `<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;
      font-weight:700;background:${bg};color:${color};margin:0 4px 4px 0">${label}</span>`;

  body.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:48px;height:48px;border-radius:50%;background:${rolColor}18;
          display:flex;align-items:center;justify-content:center;
          font-size:20px;font-weight:800;color:${rolColor}">
          ${(u.nombre||u.alias||"?").charAt(0).toUpperCase()}
        </div>
        <div>
          <div style="font-size:16px;font-weight:800;color:var(--text-primary)">${u.nombre||u.alias}</div>
          <div style="font-size:11px;color:var(--text-muted)">${u.alias}</div>
          <div style="margin-top:3px">${badge(u.rol, rolColor, rolColor+"18")}</div>
        </div>
      </div>
      <button onclick="IngenierosUI.cerrarDrawer()"
        style="width:30px;height:30px;border-radius:50%;border:1px solid var(--border);
          background:var(--surface);cursor:pointer;font-size:15px;display:flex;
          align-items:center;justify-content:center;flex-shrink:0">✕</button>
    </div>

    <!-- Estado GPS -->
    <div style="padding:12px 14px;border-radius:10px;border:1px solid ${senalColor}30;
      background:${senalColor}10;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:${u.ub?.lat?'8px':'0'}">
        <span style="width:10px;height:10px;border-radius:50%;background:${senalColor};flex-shrink:0"></span>
        <span style="font-size:12px;font-weight:700;color:${senalColor}">${senalTxt}</span>
        ${u.ts ? `<span style="font-size:11px;color:var(--text-muted);margin-left:auto">${fmtHora(new Date(u.ts))}</span>` : ""}
      </div>
      ${u.ub?.lat && u.ub?.lng
        ? `<a href="https://www.google.com/maps?q=${u.ub.lat},${u.ub.lng}" target="_blank"
            style="font-size:11px;color:#1565C0;text-decoration:none;font-weight:600">
            📍 ${u.ub.lat.toFixed(5)}, ${u.ub.lng.toFixed(5)} — Ver en Maps</a>` : ""}
      ${u.tiempoCampo !== null
        ? `<div style="margin-top:6px;font-size:11px;color:${senalColor};font-weight:600">
            ⏱ ${_fmtTiempo(u.tiempoCampo)} en campo</div>` : ""}
    </div>

    <!-- Productividad hoy -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
        padding:10px 12px;border-left:3px solid #15803D">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px">📦 Pedidos hoy</div>
        <div style="font-size:20px;font-weight:800;color:#15803D">${_pedidosHoy[u.alias]||0}</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
        padding:10px 12px;border-left:3px solid #92400E">
        <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:3px">🏠 Visitas hoy</div>
        <div style="font-size:20px;font-weight:800;color:#92400E">${_visitasHoy[u.alias]||0}</div>
      </div>
    </div>

    <!-- Datos del perfil -->
    <div style="margin-bottom:14px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
        color:var(--text-muted);margin-bottom:8px">Información</div>
      ${row("📧","Correo",     u.email,    `mailto:${u.email}`)}
      ${row("📞","Teléfono",   u.telefono, `tel:${u.telefono}`)}
      ${row("🗺️","Zona",       u.zona,     null)}
      ${row("🚗","Vehículo",   u.vehiculo, null)}
      ${row("📅","Liquidación",u.diaLiquidacion!==undefined ? `${DIAS[u.diaLiquidacion??1]}` : null, null)}
      ${row("💵","Salario/sem",u.salarioBase>0 ? fmt(u.salarioBase) : null, null)}
    </div>

    <!-- Jornada actual -->
    <div style="padding:10px 14px;border-radius:8px;border:1px solid var(--border);margin-bottom:14px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
        color:var(--text-muted);margin-bottom:6px">Estado de jornada</div>
      ${u.enJornada
        ? `<span style="font-size:12px;font-weight:700;color:#16A34A">● En jornada hoy</span>`
        : `<span style="font-size:12px;color:var(--text-muted)">Fuera de jornada</span>`}
    </div>

    <!-- Acciones rápidas -->
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="IngenierosUI.editarPerfil('${u.alias}')"
        style="flex:1;padding:8px;border:1px solid var(--border);border-radius:7px;
          background:var(--surface);cursor:pointer;font-size:12px;font-weight:600">
        ✏️ Editar perfil
      </button>
      ${u.ub?.lat && u.ub?.lng
        ? `<a href="https://www.google.com/maps?q=${u.ub.lat},${u.ub.lng}" target="_blank"
            style="flex:1;padding:8px;border:1px solid #1565C0;border-radius:7px;
              background:#EFF6FF;color:#1565C0;cursor:pointer;font-size:12px;font-weight:600;
              text-decoration:none;text-align:center">
            📍 Ver en mapa
          </a>` : ""}
      ${u.telefono
        ? `<a href="tel:${u.telefono}"
            style="flex:1;padding:8px;border:1px solid #15803D;border-radius:7px;
              background:#F0FDF4;color:#15803D;cursor:pointer;font-size:12px;font-weight:600;
              text-decoration:none;text-align:center">
            📞 Llamar
          </a>` : ""}
    </div>`;
}

// ── Helpers ───────────────────────────────────────────────────
function _fmtTiempo(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
