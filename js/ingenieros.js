// ══════════════════════════════════════════════════════════════
// ingenieros.js — Listado de ingenieros con estado de jornada y KPIs
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { estaEnJornadaHoy } from "./app.js";
import {
  collection, query, orderBy, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { exportarExcel } from "./excel-utils.js";

let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

const _COLS_ING = [
  { key: "alias",     header: "Alias",           width: 14, required: true,  ejemplo: "jperez" },
  { key: "nombre",    header: "Nombre completo",  width: 24, required: true,  ejemplo: "Juan Pérez García" },
  { key: "telefono",  header: "Teléfono",         width: 16, ejemplo: "5551234567" },
  { key: "email",     header: "Correo",           width: 26, ejemplo: "jperez@empresa.com" },
  { key: "zona",      header: "Zona",             width: 14, ejemplo: "Norte" },
  { key: "vehiculo",  header: "Vehículo",         width: 16, ejemplo: "Nissan NP300 ABC-123" },
  { key: "activo",    header: "Activo (SI/NO)",   width: 14, tipo: "booleano", ejemplo: "SI" },
];

// Columnas para exportación de clientes (solo lectura — datos provienen de la APK)
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

// ── Exportación de clientes ───────────────────────────────────
window.Cli_xlExport = async function() {
  try {
    const { getDocs, collection, orderBy, query } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db } = await import("./firebase-config.js");
    window.toast?.("Preparando exportación de clientes…", "info");
    const snap = await getDocs(query(collection(db, "clientes"), orderBy("nombre")));
    const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    if (rows.length === 0) { window.toast?.("No hay clientes para exportar.", "info"); return; }
    exportarExcel(rows, _COLS_CLI, "Clientes", "Clientes");
  } catch(e) { window.toast?.("Error al exportar clientes.", "error"); }
};

let _unsubUsuarios   = null;
let _unsubUbicaciones = null;
let _usuarios    = [];
let _ubicaciones = {};
let _filtroActivo = "TODOS";

const fmtHora = d => new Date(d?.toDate?.() ?? d).toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" });
const fmtDt   = d => new Date(d?.toDate?.() ?? d).toLocaleDateString("es-MX", { day:"numeric", month:"short" });

export const IngenierosModule = {
  mount(container) {
    container.innerHTML = _html();
    _bindUI();
    _escuchar();
    return () => this.destroy();
  },
  destroy() {
    _unsubUsuarios?.();   _unsubUsuarios   = null;
    _unsubUbicaciones?.(); _unsubUbicaciones = null;
    _usuarios = []; _ubicaciones = {}; _filtroActivo = "TODOS";
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <div style="padding:0 0 20px">

    <!-- Controles -->
    <div style="background:var(--surface);border-radius:10px;border:1px solid var(--border);padding:12px 16px;
      margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
      box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <span style="font-size:12px;font-weight:700;color:var(--text-primary)">Jornada:</span>
      ${[["TODOS","Todos",""],["EN_JORNADA","En jornada","#16A34A"],["FUERA","Fuera","#DC2626"]].map(([f,label,c]) => `
        <button class="filter-pill ${f==="TODOS"?"active":""}" data-ing-f="${f}"
          onclick="IngenierosUI.setFiltro('${f}')"
          ${c ? `style="border-color:${c};color:${c}"` : ""}>
          ${label}
        </button>`).join("")}
      <button onclick="Ing_xlExport()" style="margin-left:auto;padding:7px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">⬇️ Excel</button>
      <button onclick="IngenierosUI.abrirAlta()"
        style="padding:6px 14px;border-radius:6px;border:none;background:#1B5E20;
          color:#fff;font-size:12px;font-weight:700;cursor:pointer">
        + Nuevo staff
      </button>
    </div>

    <!-- Tarjetas de ingenieros -->
    <div id="ing-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">
      <div style="padding:30px;text-align:center;color:var(--text-muted);font-size:13px;
        grid-column:1/-1">Cargando ingenieros…</div>
    </div>
  </div>

  <!-- Modal alta de ingeniero -->
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
            Alias* <span style="color:var(--text-muted);font-weight:400">(ID único, sin espacios)</span>
          </label>
          <input id="ing-f-alias" type="text" maxlength="20" autocomplete="off"
            placeholder="jperez"
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
            Día de liquidación <span style="color:var(--text-muted);font-weight:400">(inicio de semana)</span>
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
        padding:10px 14px;border:1px solid var(--border);border-radius:8px;
        background:var(--surface)">
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
        ⚠️ Después de guardar, crea la cuenta de acceso en <strong>Firebase Console → Authentication</strong>
        usando el mismo correo. El ingeniero aparecerá en la APK en el próximo sync.
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
  </div>`;
}

// ── UI Bind ───────────────────────────────────────────────────
function _bindUI() {
  window.IngenierosUI = {
    setFiltro(f) {
      _filtroActivo = f;
      document.querySelectorAll("[data-ing-f]").forEach(b =>
        b.classList.toggle("active", b.dataset.ingF === f));
      _render();
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
      document.getElementById("ing-modal").style.display = "flex";
      _regEsc(() => IngenierosUI.cerrarAlta());
      setTimeout(() => document.getElementById("ing-f-alias")?.focus(), 80);
    },

    cerrarAlta() {
      _unregEsc();
      document.getElementById("ing-modal").style.display = "none";
    },

    async editarPerfil(alias) {
      // Cargar datos actuales
      const { getDoc, doc: fsDoc, setDoc: fsSet, serverTimestamp: sTs } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const { db: fdb } = await import("./firebase-config.js");
      const snap = await getDoc(fsDoc(fdb, "usuarios", alias));
      const u = snap.exists() ? snap.data() : {};

      // Rellenar modal con datos existentes
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
      const activoCb = document.getElementById("ing-f-activo");
      const toggleBg = document.getElementById("ing-toggle-activo");
      const activoVal = u.activo !== false;
      if (activoCb) activoCb.checked = activoVal;
      if (toggleBg) toggleBg.style.background = activoVal ? "#16a34a" : "#D1D5DB";
      const knob = document.getElementById("ing-toggle-knob");
      if (knob) knob.style.left = activoVal ? "22px" : "3px";
      // Alias no editable en modo edición
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
        const { setDoc, doc, serverTimestamp, getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const { db: fdb } = await import("./firebase-config.js");

        const ref = doc(fdb, "usuarios", alias);
        const existe = await getDoc(ref);
        const esEdicion = document.getElementById("ing-f-alias").readOnly;
        if (!esEdicion && existe.exists()) {
          mostrarError(`Ya existe un usuario con alias "${alias}". Usa uno diferente.`);
          if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
          return;
        }

        await setDoc(ref, {
          alias, nombre, email,
          ...(tel        ? { telefono: tel }           : {}),
          ...(zona       ? { zona }                    : {}),
          ...(vehiculo   ? { vehiculo }                : {}),
          diaLiquidacion: diaLiq,
          salarioBase,
          rol,
          activo,
          creadoPor: window.Sesion?.alias ?? "web",
          creadoEn:  serverTimestamp()
        });

        // Restaurar alias editable para la próxima apertura
        document.getElementById("ing-f-alias").readOnly = false;
        const esEd = document.getElementById("ing-f-alias").readOnly;
        window.toast?.(`Ingeniero "${alias}" ${esEd ? "actualizado" : "registrado"} correctamente.`, "success");
        this.cerrarAlta();
      } catch(e) {
        mostrarError("Error al guardar: " + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
      }
    }
  };
}

// ── Firestore listeners ───────────────────────────────────────
function _escuchar() {
  _unsubUsuarios = onSnapshot(
    query(collection(db, "usuarios"), orderBy("alias")),
    snap => {
      _usuarios = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(u => u.activo !== false && ["INGENIERO","RECUPERADOR"].includes(u.rol));
      _render();
    },
    err => {
      console.error("[Ingenieros:usuarios]", err);
      window.toast?.("Error al cargar ingenieros.", "error");
    }
  );

  _unsubUbicaciones = onSnapshot(
    collection(db, "ubicaciones"),
    snap => {
      _ubicaciones = {};
      snap.forEach(d => { _ubicaciones[d.id] = { id: d.id, ...d.data() }; });
      _render();
    },
    err => {
      console.error("[Ingenieros:ubicaciones]", err);
    }
  );
}

// ── Render ────────────────────────────────────────────────────
function _render() {
  const ahora = Date.now();
  let lista = _usuarios.map(u => {
    const ub   = _ubicaciones[u.id] || _ubicaciones[u.alias] || null;
    const ts   = typeof ub?.timestamp === 'number' ? ub.timestamp : (ub?.timestamp?.toDate?.()?.getTime() ?? 0);
    const mins = ts ? Math.floor((ahora - ts) / 60000) : null;
    const enJornada = estaEnJornadaHoy(ub);
    return { ...u, ub, ts, mins, enJornada };
  });

  if (_filtroActivo === "EN_JORNADA") lista = lista.filter(u => u.enJornada);
  if (_filtroActivo === "FUERA")      lista = lista.filter(u => !u.enJornada);

  const grid = document.getElementById("ing-grid");
  if (!grid) return;
  if (lista.length === 0) {
    grid.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:13px;
      grid-column:1/-1">Sin ingenieros para este filtro.</div>`;
    return;
  }

  grid.innerHTML = lista.map(u => {
    const enVivo = u.mins !== null && u.mins < 5;
    const senalColor = enVivo ? "#16A34A" : u.mins !== null && u.mins < 60 ? "#D97706" : "#9CA3AF";
    const jornadaBadge = u.enJornada
      ? `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;
          background:#DCFCE7;color:#16A34A">● En jornada</span>`
      : `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;
          background:var(--surface-2);color:var(--text-sec)">Fuera de jornada</span>`;
    const senalTxt = u.mins === null
      ? "Sin señal GPS"
      : u.mins < 5 ? "En vivo"
      : u.mins < 60 ? `${u.mins} min sin señal`
      : "Sin señal reciente";
    const rolColor = u.rol === "RECUPERADOR" ? "#15803D" : "#1565C0";

    return `<div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);padding:16px;
      box-shadow:0 1px 3px rgba(0,0,0,.06)">
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:10px">
        <div style="width:40px;height:40px;border-radius:50%;background:${rolColor}1A;
          display:flex;align-items:center;justify-content:center;
          font-size:16px;font-weight:800;color:${rolColor};flex-shrink:0">
          ${(u.alias || u.email || "?").charAt(0).toUpperCase()}
        </div>
        <div style="flex:1;min-width:0">
          ${u.nombre ? `<div style="font-size:14px;font-weight:700;color:var(--text-primary);white-space:nowrap;
            overflow:hidden;text-overflow:ellipsis">${u.nombre}</div>
          <div style="font-size:11px;color:var(--text-sec);margin-top:1px">${u.alias || u.email}</div>` :
          `<div style="font-size:14px;font-weight:700;color:var(--text-primary);white-space:nowrap;
            overflow:hidden;text-overflow:ellipsis">${u.alias || u.email}</div>`}
          <div style="font-size:11px;color:${rolColor};font-weight:600;margin-top:1px">${u.rol || "–"}</div>
        </div>
        ${jornadaBadge}
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="width:8px;height:8px;border-radius:50%;background:${senalColor};flex-shrink:0"></span>
        <span style="font-size:11px;color:var(--text-sec)">${senalTxt}</span>
        ${u.ts ? `<span style="font-size:11px;color:var(--text-muted);margin-left:auto">${fmtHora(new Date(u.ts))}</span>` : ""}
      </div>
      ${u.ub?.lat && u.ub?.lng
        ? `<a href="https://www.google.com/maps?q=${u.ub.lat},${u.ub.lng}" target="_blank"
            style="display:block;font-size:11px;color:#1565C0;text-decoration:none;font-weight:600">
            📍 Ver en Google Maps</a>`
        : `<span style="font-size:11px;color:var(--text-muted)">Sin ubicación registrada</span>`}
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);
        display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        ${u.diaLiquidacion !== undefined
          ? `<span style="font-size:10px;background:#EFF6FF;color:#1D4ED8;padding:2px 7px;border-radius:6px;font-weight:600">
              📅 Liq. ${["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"][u.diaLiquidacion ?? 1]}
             </span>`
          : ""}
        ${u.salarioBase > 0
          ? `<span style="font-size:10px;background:#F0FDF4;color:#15803D;padding:2px 7px;border-radius:6px;font-weight:600">
              💵 $${u.salarioBase.toLocaleString("es-MX")}/sem
             </span>`
          : ""}
        <button onclick="IngenierosUI.editarPerfil('${u.alias}')"
          style="margin-left:auto;font-size:10px;padding:3px 9px;border:1px solid var(--border);
            border-radius:5px;background:var(--surface);cursor:pointer;color:var(--text-primary);font-weight:600">
          ✏️ Editar
        </button>
      </div>
    </div>`;
  }).join("");
}

// ── Excel handlers (globales para onclick en HTML) ─────────────
window.Ing_xlExport = async function() {
  try {
    const { getDocs, collection: col } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db: fdb } = await import("./firebase-config.js");
    const snap = await getDocs(col(fdb, "usuarios"));
    const rows = snap.docs
      .filter(d => ["INGENIERO","RECUPERADOR"].includes(d.data().rol))
      .map(d => ({ ...d.data(), id: d.id }));
    exportarExcel(rows, _COLS_ING, "Ingenieros", "Ingenieros");
  } catch(e) {
    window.toast?.("Error al exportar: " + e.message, "error");
  }
};

