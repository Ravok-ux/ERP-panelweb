// ══════════════════════════════════════════════════════════════
// app.js — Router principal, inicialización del shell
// ══════════════════════════════════════════════════════════════

import { Auth, Sesion, iniciarInactivityTimer, detenerInactivityTimer } from "./auth.js";
import { PreferenciasModule, aplicarPrefsIniciales } from "./preferencias.js";
import { DashboardModule }  from "./dashboard.js";
import { MapaModule }       from "./mapa.js";
import { MapaClientesModule } from "./mapa-clientes.js";
import { FeedModule }       from "./feed.js";
import { UsuariosModule }   from "./usuarios.js";
import { ReportesModule }   from "./reportes.js";
import { PedidosModule }    from "./pedidos.js";
import { RemisionesModule } from "./remisiones.js";
import { CobranzaModule }   from "./cobranza.js";
import { IngenierosModule } from "./ingenieros.js";
import { ComisionesModule } from "./comisiones.js";
import { ComprasModule }       from "./compras.js";
import { ProveedoresModule }   from "./proveedores.js";
import { ConfigModule }        from "./config.js";
import { ComentariosModule }   from "./comentarios.js";
import { PreciosModule }         from "./precios.js";
import { ProductosControlModule } from "./productos-control.js";
import { GeocercasModule }        from "./geocercas.js";
import { MetasModule }            from "./metas.js";
import { AutorizacionesModule }   from "./autorizaciones.js";
import { FormulariosModule }      from "./formularios.js";
import { PromocionesModule }      from "./promociones.js";
import { SegmentoPrecioModule }   from "./precios-segmento.js";
import { ClientesModule }         from "./clientes.js";
import { HistorialVentasModule }  from "./historial-ventas.js";
import { BiAnalyticsModule }      from "./bi-analytics.js";
import { KardexModule }           from "./kardex.js";
import { CarteraModule }          from "./cartera.js";
import { VisitasModule }          from "./visitas.js";
import { CotizacionesPanelModule } from "./cotizaciones-panel.js";
import { DevolucionesModule }      from "./devoluciones.js";
import { ChatModule, iniciarChatBg, detenerChatBg } from "./chat.js";
import { RhModule }               from "./rh.js";
import { AuditoriaModule }        from "./auditoria.js";
import { InventarioModule }       from "./inventario.js";
import { CrmModule }              from "./crm.js";
import { mount as asistenciaMount, destroy as asistenciaDestroy } from "./asistencia.js";
import { mount as smsMount,        destroy as smsDestroy        } from "./sms.js";
import { LogisticaModule }        from "./logistica.js";
import { AgroquimicoModule }      from "./agroquimico.js";
import { IntegracionesModule }    from "./integraciones.js";
import { FinanzasModule }         from "./finanzas.js";
import { JuridicoModule }         from "./juridico.js";
import { ObservabilidadModule }   from "./observabilidad.js";
import { MiRhModule }             from "./mi-rh.js";
import { ManualesModule }          from "./manuales.js";
import { AsignacionesModule }      from "./asignaciones.js";
import { ConfigInteresesModule }   from "./config-intereses.js";
import { mount as rcMount, destroy as rcDestroy } from "./reportes-custom.js";
import { mount as cajaMount, destroy as cajaDestroy } from "./caja.js";
import { mount as gastosMount, destroy as gastosDestroy } from "./gastos.js";
import { mount as reabastoMount, destroy as reabastoDestroy } from "./reabasto.js";
import { BlacklistModule } from "./blacklist.js";
import { iniciarNotificaciones, detenerNotificaciones } from "./notificaciones.js";
import { iniciarFCM } from "./fcm.js";
import { db } from "./firebase-config.js";
import {
  collection, query, where, orderBy, limit as fsLimit, getDocs,
  startAt, endAt, addDoc, serverTimestamp as appSTS
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Sanitización XSS ──────────────────────────────────────────
// Usa esta función en TODOS los lugares donde datos de Firestore
// se insertan con innerHTML. Convierte caracteres peligrosos a
// entidades HTML para evitar XSS (Cross-Site Scripting).
const _escMap = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":"&#x27;" };
export function esc(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => _escMap[c]);
}

// ── Normalizador de búsqueda ──────────────────────────────────
// Usa esta función en filtros/autocompletes. Elimina tildes, iguala
// mayúsculas, convierte ll→y (yeísmo) para búsqueda tolerante.
export const norm = s =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ll/g, "y")
    .trim();

// ── Estado de jornada con validación de fecha ─────────────────
// Devuelve true solo si enJornada=true Y el timestamp es del día calendario actual.
// Evita que ingenieros que no cerraron jornada ayer aparezcan como activos hoy.
export function estaEnJornadaHoy(ubicacion) {
  if (!ubicacion?.enJornada) return false;
  const ts = ubicacion.timestamp;
  const msTs = typeof ts === "number" ? ts : (ts?.toDate?.()?.getTime() ?? 0);
  if (!msTs) return false;
  const hoy = new Date();
  const diaTs = new Date(msTs);
  return diaTs.getFullYear() === hoy.getFullYear()
      && diaTs.getMonth()    === hoy.getMonth()
      && diaTs.getDate()     === hoy.getDate();
}

// ── Auditoría ─────────────────────────────────────────────────
// Escribe un evento a audit_log. Silencioso — nunca bloquea la UI.
export async function logAudit(tipo, datos = {}) {
  try {
    const { Sesion: S } = await import("./auth.js");
    await addDoc(collection(db, "audit_log"), {
      tipo,                          // campo que auditoria.js espera
      alias:  S.alias  ?? null,      // campo que auditoria.js lee para "usuario"
      uid:    S.uid    ?? null,
      rol:    S.rol    ?? null,
      _ts:    Date.now(),            // número — auditoria.js filtra por _ts numérico
      ...datos,                      // folio, clienteId, etc. al nivel raíz para _descripcion()
    });
  } catch(e) { /* silencioso — auditoría no debe romper la UI */ }
}
// Exponerlo globalmente para módulos que no usen import
window.esc = esc;

// ── Modal de confirmación ─────────────────────────────────────
// Reemplaza confirm() / prompt() nativos con un modal estilizado.
// Uso: const ok = await window.modal({ message:"¿Seguro?", danger:true })
// Uso prompt: const txt = await window.promptModal({ label:"Motivo" })
window.modal = ({ title = "", message = "", confirmLabel = "Confirmar", cancelLabel = "Cancelar", danger = false } = {}) =>
  new Promise(resolve => {
    const o = document.createElement("div");
    o.id = "_gmodal";
    o.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9990;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px)";
    const confirmStyle = danger
      ? "background:#DC2626;color:#fff;border:1px solid #B91C1C"
      : "background:var(--primary,#1D5C33);color:#fff;border:1px solid #16A34A";
    o.innerHTML = `
      <div style="background:var(--surface,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;
        padding:24px 28px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.45)">
        ${title ? `<div style="font-size:14px;font-weight:700;color:var(--text-primary);margin-bottom:10px">${esc(title)}</div>` : ""}
        <div style="font-size:13px;color:var(--text-sec);line-height:1.6;margin-bottom:20px">${esc(message)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="_gm-c" style="padding:8px 18px;border-radius:7px;font-size:12px;font-weight:600;
            cursor:pointer;border:1px solid var(--border,#334155);background:transparent;color:var(--text-sec)">${esc(cancelLabel)}</button>
          <button id="_gm-ok" style="padding:8px 18px;border-radius:7px;font-size:12px;font-weight:600;
            cursor:pointer;${confirmStyle}">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const close = r => { o.remove(); resolve(r); };
    o.querySelector("#_gm-c").onclick  = () => close(false);
    o.querySelector("#_gm-ok").onclick = () => close(true);
    o.addEventListener("click", e => { if (e.target === o) close(false); });
    const onKey = e => { if (e.key === "Escape") { close(false); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(o);
    o.querySelector("#_gm-ok").focus();
  });

// ── Skeleton loader ───────────────────────────────────────────
// Genera N filas skeleton para mostrar mientras carga Firestore.
// Uso: container.innerHTML = window.skeleton(5, 4); // 5 filas, 4 columnas
window.skeleton = (rows = 4, cols = 4) => {
  const cells = Array(cols).fill(`<td><div class="skel-cell"></div></td>`).join("");
  const trs   = Array(rows).fill(`<tr>${cells}</tr>`).join("");
  if (!document.getElementById("_skel-style")) {
    const s = document.createElement("style");
    s.id = "_skel-style";
    s.textContent = `
      .skel-cell { height:12px; border-radius:4px;
        background: linear-gradient(90deg, var(--border,#e2e8f0) 25%, var(--surface2,#f8fafc) 50%, var(--border,#e2e8f0) 75%);
        background-size:200% 100%; animation:skel-shine 1.4s ease infinite; }
      @keyframes skel-shine { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
    `;
    document.head.appendChild(s);
  }
  return `<table style="width:100%;border-collapse:collapse"><tbody>${trs}</tbody></table>`;
};

window.promptModal = ({ title = "", label = "", placeholder = "", confirmLabel = "Aceptar", cancelLabel = "Cancelar" } = {}) =>
  new Promise(resolve => {
    const o = document.createElement("div");
    o.id = "_gpmodal";
    o.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9990;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px)";
    o.innerHTML = `
      <div style="background:var(--surface,#1e293b);border:1px solid var(--border,#334155);border-radius:12px;
        padding:24px 28px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.45)">
        ${title ? `<div style="font-size:14px;font-weight:700;color:var(--text-primary);margin-bottom:10px">${esc(title)}</div>` : ""}
        ${label ? `<label style="font-size:12px;color:var(--text-sec);display:block;margin-bottom:6px">${esc(label)}</label>` : ""}
        <input id="_gpi" type="text" placeholder="${esc(placeholder)}"
          style="width:100%;padding:9px 12px;border:1px solid var(--border,#334155);border-radius:7px;
            font-size:13px;background:var(--surface);color:var(--text-primary);margin-bottom:16px;outline:none">
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="_gpi-c" style="padding:8px 18px;border-radius:7px;font-size:12px;font-weight:600;
            cursor:pointer;border:1px solid var(--border,#334155);background:transparent;color:var(--text-sec)">${esc(cancelLabel)}</button>
          <button id="_gpi-ok" style="padding:8px 18px;border-radius:7px;font-size:12px;font-weight:600;
            cursor:pointer;background:var(--primary,#1D5C33);color:#fff;border:1px solid #16A34A">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const close = r => { o.remove(); resolve(r); };
    o.querySelector("#_gpi-c").onclick  = () => close(null);
    o.querySelector("#_gpi-ok").onclick = () => close(o.querySelector("#_gpi").value);
    o.addEventListener("click", e => { if (e.target === o) close(null); });
    const onKey = e => { if (e.key === "Escape") { close(null); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
    document.body.appendChild(o);
    o.querySelector("#_gpi").focus();
  });

// ── Módulos registrados por nombre de vista ────────────────────
const MODULES = {
  dashboard:  DashboardModule,
  mapa:          MapaModule,
  mapa_clientes: MapaClientesModule,
  feed:       FeedModule,
  usuarios:   UsuariosModule,
  reportes:   ReportesModule,
  pedidos:    PedidosModule,
  remisiones: RemisionesModule,
  cobranza:   CobranzaModule,
  ingenieros: IngenierosModule,
  comisiones: ComisionesModule,
  compras:      ComprasModule,
  proveedores:  ProveedoresModule,
  kardex:       KardexModule,
  cartera:      CarteraModule,
  visitas:      VisitasModule,
  cotizaciones: CotizacionesPanelModule,
  devoluciones: DevolucionesModule,
  chat:         ChatModule,
  rh:           RhModule,
  auditoria:    AuditoriaModule,
  inventario:   InventarioModule,
  crm:          CrmModule,
  asistencia:   { mount: asistenciaMount, destroy: asistenciaDestroy },
  sms:          { mount: smsMount,        destroy: smsDestroy },
  logistica:    LogisticaModule,
  agroquimico:  AgroquimicoModule,
  integraciones: IntegracionesModule,
  finanzas:      FinanzasModule,
  juridico:        JuridicoModule,
  observabilidad:  ObservabilidadModule,
  mi_rh:           MiRhModule,
  precios:      PreciosModule,
  productos:    ProductosControlModule,
  geocercas:      GeocercasModule,
  metas:          MetasModule,
  autorizaciones: AutorizacionesModule,
  formularios:    FormulariosModule,
  promociones:    PromocionesModule,
  precios_segmento: SegmentoPrecioModule,
  clientes:         ClientesModule,
  historial_ventas: HistorialVentasModule,
  bi_analytics:     BiAnalyticsModule,
  manuales:         ManualesModule,
  asignaciones:     AsignacionesModule,
  config:           ConfigModule,
  config_intereses: ConfigInteresesModule,
  comentarios:      ComentariosModule,
  reportes_custom:  { mount: rcMount, destroy: rcDestroy },
  caja:             { mount: cajaMount, destroy: cajaDestroy },
  gastos:           { mount: gastosMount, destroy: gastosDestroy },
  reabasto:         { mount: reabastoMount, destroy: reabastoDestroy },
  blacklist:        BlacklistModule,
};

let vistaActual = null;
let _unsubscribers = [];

// ── Iniciar app ────────────────────────────────────────────────
Auth.observarSesion(
  () => {
    iniciarInactivityTimer();
    _initShell();
    // Listeners de fondo del chat: badge + sonido desde cualquier vista
    setTimeout(() => iniciarChatBg(), 1200);
    aplicarPrefsIniciales(Sesion.uid).then(() => {
      // Navegar a vista por defecto de prefs si existe
      const defView = Sesion.prefs?.defaultView;
      _navigate(defView && defView !== "dashboard" ? defView : "dashboard");
    }).catch(() => _navigate("dashboard"));
  },
  () => {
    detenerInactivityTimer();
    detenerNotificaciones();
    detenerChatBg();
    _destroyAll();
    document.getElementById("app-shell").classList.add("hidden");
    document.getElementById("login-screen").classList.remove("hidden");
  }
);

// ── Shell ──────────────────────────────────────────────────────
function _initShell() {
  const shell = document.getElementById("app-shell");
  const login = document.getElementById("login-screen");
  login.classList.add("hidden");
  shell.classList.remove("hidden");

  // Iniciales de usuario en topbar y sidebar
  const initiales = (Sesion.alias || "?").slice(0, 2).toUpperCase();
  document.getElementById("sb-ava").textContent   = initiales;
  document.getElementById("sb-uname").textContent = Sesion.alias;
  document.getElementById("sb-urole").textContent = (Sesion.rol || "").replace("_", " ");
  document.getElementById("tb-ava").textContent   = initiales;
  document.getElementById("tb-uname").textContent = Sesion.alias;

  _aplicarVisibilidadSidebar();

  // Firebase status verde
  _setStatus("firebase", true, "Firebase conectado");

  // Fecha en sub-header
  const hoy = new Date();
  const opts = { weekday:"long", day:"numeric", month:"long", year:"numeric" };
  document.getElementById("subhdr-sub").textContent =
    hoy.toLocaleDateString("es-MX", opts) + " · Semana " + _weekNumber(hoy);
  document.getElementById("date-chip").textContent = "📅 Hoy · " + hoy.toLocaleDateString("es-MX", { day:"numeric", month:"short", year:"numeric" });

  // Iniciar sync clock
  _syncClock();

  // Iniciar toast container
  if (!document.getElementById("toast-container")) {
    const tc = document.createElement("div");
    tc.id = "toast-container";
    document.body.appendChild(tc);
  }
  window.toast = _toast;

  // Iniciar sistema de notificaciones web
  iniciarNotificaciones(
    document.getElementById("tb-notif-bell"),
    document.getElementById("tb-notif-count")
  );

  // Iniciar FCM push notifications (después de que el SW esté listo)
  setTimeout(() => iniciarFCM(), 3000);

  // Sidebar nav — event delegation con guard de descarte + ripple
  document.getElementById("sidebar").addEventListener("click", e => {
    const item = e.target.closest("[data-view]");
    if (!item) return;
    e.preventDefault();
    // Ripple
    const rect = item.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top  - size / 2;
    const ripple = document.createElement("span");
    ripple.className = "sb-ripple";
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px`;
    item.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
    _navigateGuarded(item.dataset.view);
  });

  // Sidebar toggle (móvil ≤800px)
  const sbToggle = document.getElementById("sb-toggle");
  const sbEl = document.getElementById("sidebar");
  if (sbToggle && sbEl) {
    sbToggle.addEventListener("click", () => sbEl.classList.toggle("sb-open"));
    document.querySelectorAll(".sb-item").forEach(el =>
      el.addEventListener("click", () => sbEl.classList.remove("sb-open"))
    );
  }

  // Secciones colapsables del sidebar
  _initSidebarCollapse();

  // ── Búsqueda global ─────────────────────────────────────────
  _initGlobalSearch();

  // ── Botón limpiar en todos los campos de búsqueda ───────────
  _initSearchClearButtons();

  // ── User popover ────────────────────────────────────────────
  const sbUser   = document.querySelector(".sb-user");
  const sbPop    = document.getElementById("sb-popover");
  const darkTgl  = document.getElementById("dark-toggle");
  const sbpLogout= document.getElementById("sbp-logout");

  // Sincronizar datos en el popover
  if (document.getElementById("sbp-ava"))  document.getElementById("sbp-ava").textContent  = initiales;
  if (document.getElementById("sbp-name")) document.getElementById("sbp-name").textContent = Sesion.alias;
  if (document.getElementById("sbp-role")) document.getElementById("sbp-role").textContent = Sesion.rol.replace("_"," ");

  // Abrir/cerrar popover
  if (sbUser && sbPop) {
    sbUser.style.cursor = "pointer";
    sbUser.addEventListener("click", e => {
      e.stopPropagation();
      sbPop.classList.toggle("hidden");
    });
    document.addEventListener("click", () => sbPop.classList.add("hidden"));
    sbPop.addEventListener("click", e => e.stopPropagation());
  }

  // Dark mode — persistido en localStorage por usuario
  const _dmKey = "n10_theme_" + (Sesion.uid || "default");
  const _applyTheme = dark => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    if (darkTgl) darkTgl.checked = dark;
  };
  _applyTheme(localStorage.getItem(_dmKey) === "dark");
  if (darkTgl) {
    darkTgl.addEventListener("change", () => {
      const isDark = darkTgl.checked;
      localStorage.setItem(_dmKey, isDark ? "dark" : "light");
      _applyTheme(isDark);
    });
  }

  // Preferencias desde popover
  const sbpPrefs = document.getElementById("sbp-prefs");
  if (sbpPrefs) {
    sbpPrefs.addEventListener("click", () => {
      sbPop?.classList.add("hidden");
      PreferenciasModule.abrir();
    });
  }

  // Logout desde popover
  if (sbpLogout) {
    sbpLogout.addEventListener("click", async () => {
      const ok = await window.modal({
        title: "Cerrar sesión",
        message: "¿Seguro que quieres salir? Se perderán los cambios no guardados.",
        confirmLabel: "Cerrar sesión",
        cancelLabel: "Cancelar",
        danger: true
      });
      if (ok) Auth.logout();
    });
  }

  // Prevenir cierre de pestaña con cambios pendientes
  window.addEventListener("beforeunload", e => {
    if (window.DirtyGuard?.isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // API global para que módulos marquen formularios sucios
  window.DirtyGuard = {
    _msg: null,
    set(msg = "Hay cambios sin guardar. ¿Salir de todas formas?") { this._msg = msg; },
    clear() { this._msg = null; },
    isDirty() { return this._msg !== null; },
    async confirm() {
      if (!this._msg) return true;
      return window.modal
        ? window.modal({ title: "Cambios sin guardar", message: this._msg, confirmLabel: "Salir sin guardar", cancelLabel: "Volver", danger: true })
        : window.confirm(this._msg);
    }
  };
}

// ── Navegación ─────────────────────────────────────────────────
async function _navigateGuarded(viewId) {
  if (vistaActual === viewId) return;
  if (window.DirtyGuard?.isDirty() && !await window.DirtyGuard.confirm()) return;
  window.DirtyGuard?.clear();
  _navigate(viewId);
}

function _navigate(viewId) {
  if (vistaActual === viewId) return;

  // Desmontar módulo anterior y limpiar guard
  if (vistaActual && MODULES[vistaActual]?.destroy) {
    MODULES[vistaActual].destroy();
  }
  window.DirtyGuard?.clear();
  _unsubscribers.forEach(fn => fn());
  _unsubscribers = [];

  // Sidebar active
  document.querySelectorAll(".sb-item").forEach(el => {
    el.classList.toggle("active", el.dataset.view === viewId);
  });

  // Ocultar todas las vistas, mostrar la activa
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  const el = document.getElementById("view-" + viewId);
  if (el) el.classList.add("active");

  // Breadcrumb
  const bc = { dashboard:"Dashboard", mapa:"Mapa en vivo", mapa_clientes:"Mapa de Clientes", feed:"Feed en vivo",
    ingenieros:"Staff operativo", pedidos:"Pedidos", remisiones:"Remisiones",
    cobranza:"Cobranza", usuarios:"Usuarios y flags", reportes:"Reportes",
    comisiones:"Comisiones", compras:"Órdenes de compra", proveedores:"Proveedores", kardex:"Kardex",
    cartera:"Cartera vencida", visitas:"Visitas", precios:"Precios y costos", config:"Config. tickets",
    config_intereses:"Tasas de interés",
    geocercas:"Geocercas", metas:"Metas de venta", autorizaciones:"Autorizaciones",
    formularios:"Formularios", promociones:"Recompensas y lealtad", precios_segmento:"Precios por segmento",
    productos:"Control de productos", comentarios:"Comentarios de clientes",
    inventario:"Inventario", crm:"CRM — Prospectos", logistica:"Logística de visitas",
    agroquimico:"Agroquímico",
    integraciones:"Integraciones",
    finanzas:"Finanzas",
    clientes:"Clientes", auditoria:"Auditoría", devoluciones:"Devoluciones",
    rh:"Recursos Humanos", mi_rh:"Mi RH", chat:"Chat interno",
    juridico:"Jurídico", observabilidad:"Observabilidad", manuales:"Manuales y Políticas",
    cotizaciones:"Cotizaciones", reportes_custom:"Reportes Configurables",
    asignaciones:"Asignaciones",
    reabasto:"Reabasto",
    caja:"Arqueo de Caja", gastos:"Gastos de Empleados",
    historial_ventas:"Historial de Ventas",
    asistencia:"Control de Asistencia",
    sms:"SMS Masivo",
    bi_analytics:"BI & Analytics",
    blacklist:"Blacklist" };
  const subs = { dashboard:"Resumen del día", mapa:"Ingenieros en campo", mapa_clientes:"Localización total de clientes georeferenciados",
    feed:"Actividades globales", usuarios:"Gestión de privilegios",
    reportes:"Generación de reportes", comisiones:"Nómina e incentivos por ingeniero",
    compras:"Órdenes a proveedores", cartera:"Cartera vencida por cliente", visitas:"Programación de visitas",
    geocercas:"Zonas autorizadas en mapa", metas:"Objetivos por ingeniero",
    autorizaciones:"Aprobación de pedidos pendientes", formularios:"Plantillas de campo",
    promociones:"Campañas y puntos de lealtad", precios_segmento:"Catálogo por segmento de cliente",
    productos:"Gestión del catálogo", comentarios:"Notas y seguimiento de clientes",
    inventario:"Stock en tiempo real por producto",
    crm:"Pipeline de prospectos y conversión a clientes",
    asistencia:"Registro de entradas/salidas y horarios del equipo en campo",
    sms:"Campañas de SMS masivo vía SendPulse con segmentación de clientes",
    logistica:"Visitas programadas por frecuencia de cliente",
    agroquimico:"Calendario agrícola, recetas de dosis y trazabilidad campo-cultivo-venta",
    integraciones:"Pasarela de pagos, SPEI, WhatsApp Business y API pública — activa por etapas",
    finanzas:"Contabilidad GL, cuentas por pagar, conciliación bancaria, estados financieros y centros de costo",
    proveedores:"Directorio de proveedores y condiciones de crédito",
    asignaciones:"Traspaso de clientes entre ingenieros con auditoría completa",
    clientes:"Directorio y saldos por cliente", historial_ventas:"Log de ventas por cliente para diagnóstico y aprendizaje IA",
    bi_analytics:"Dashboard con drill-down, rentabilidad, comparativo YoY/MoM y predicción de demanda",
    auditoria:"Registro de cambios críticos",
    devoluciones:"Gestión de devoluciones y créditos", rh:"Gestión de personal",
    mi_rh:"Mi expediente y nómina", chat:"Mensajería interna del equipo",
    juridico:"Acuerdos de congelamiento y cobranza legal",
    observabilidad:"Salud del sistema y métricas operativas",
    manuales:"Diagramas de flujo y políticas operativas",
    cotizaciones:"Cotizaciones activas y vencidas",
    reportes_custom:"Reportes con campos configurables por fuente de datos",
    reabasto:"Solicitudes de reabasto por ingeniero",
    caja:"Cortes y arqueos de caja por turno",
    gastos:"Solicitudes de gastos y reembolsos",
    blacklist:"Clientes morosos, fraudulentos y de alto riesgo" };
  document.getElementById("tb-bc").innerHTML =
    `${bc[viewId] ?? viewId} <span>/ ${subs[viewId] ?? ""}</span>`;
  document.getElementById("subhdr-title").textContent = bc[viewId] ?? viewId;

  // Montar módulo
  const mod = MODULES[viewId];
  if (mod?.mount) {
    const unsub = mod.mount(el);
    if (typeof unsub === "function") _unsubscribers.push(unsub);
    // Aplica dual-scroll inmediatamente y también cuando el módulo cargue datos async
    setTimeout(() => _initDualScroll(el), 80);
    const mo = new MutationObserver(() => _initDualScroll(el));
    mo.observe(el, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15000); // deja de observar tras 15s
  }

  vistaActual = viewId;
}

// ── Dual-scroll (barra superior + inferior en tablas anchas) ────
function _initDualScroll(root) {
  root.querySelectorAll("div").forEach(div => {
    if (div.style.overflowX !== "auto" || !div.querySelector("table") || div.dataset.dualDone) return;
    div.dataset.dualDone = "1";
    const mirror = document.createElement("div");
    mirror.style.cssText = "overflow-x:auto;overflow-y:hidden;height:14px;margin-bottom:2px;scrollbar-width:thin";
    const inner = document.createElement("div");
    inner.style.cssText = "height:1px;pointer-events:none";
    mirror.appendChild(inner);
    div.parentNode.insertBefore(mirror, div);
    div.addEventListener("scroll",   () => { mirror.scrollLeft = div.scrollLeft; },    { passive: true });
    mirror.addEventListener("scroll", () => { div.scrollLeft    = mirror.scrollLeft; }, { passive: true });
    const ro = new ResizeObserver(() => { inner.style.width = div.scrollWidth + "px"; });
    ro.observe(div);
  });
}

// ── Skeleton helpers (globales para todos los módulos) ──────────
window.skeletonRows = function(n = 5, cols = 4) {
  const cell = `<td style="padding:10px 8px"><div class="skeleton" style="height:12px;border-radius:3px"></div></td>`;
  return Array.from({ length: n }, () => `<tr>${cell.repeat(cols)}</tr>`).join("");
};

window.skeletonCards = function(n = 4) {
  return Array.from({ length: n }, () => `
    <div class="skeleton" style="height:72px;border-radius:8px;flex:1;min-width:140px"></div>`).join("");
};

// ── Helpers ────────────────────────────────────────────────────
function _destroyAll() {
  if (vistaActual && MODULES[vistaActual]?.destroy) MODULES[vistaActual].destroy();
  _unsubscribers.forEach(fn => fn());
  _unsubscribers = [];
  vistaActual = null;
}

function _setStatus(key, ok, text) {
  const el = document.getElementById("st-" + key);
  if (!el) return;
  el.innerHTML = `<span class="st-dot" style="background:${ok ? "#4ADE80" : "#EF4444"}"></span> ${text}`;
}

function _syncClock() {
  let count = 0;
  setInterval(() => {
    count++;
    document.getElementById("st-sync").textContent =
      count < 60 ? `🔄 Sync: hace ${count}s` : `🔄 Sync: hace ${Math.floor(count/60)}m`;
  }, 1000);
}

function _weekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
}

// ── Toast ──────────────────────────────────────────────────────
function _toast(msg, type = "info") {
  const tc = document.getElementById("toast-container");
  if (!tc) return;
  const icons = { success:"✅", error:"❌", info:"ℹ️" };
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type] ?? "•"}</span> ${msg}`;
  tc.appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3500);
}

// ── Simple list placeholder (módulos pendientes) ───────────────
function SimpleListModule(id, title, subtitle) {
  return {
    mount(container) {
      container.innerHTML = `
        <div style="flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:#9CA3AF;padding:40px">
          <div style="font-size:40px">${title.split(" ")[0]}</div>
          <div style="font-size:15px;font-weight:700;color:#374151">${title.replace(/^[^ ]+ /, "")}</div>
          <div style="font-size:12px">${subtitle} — módulo en construcción</div>
        </div>`;
    }
  };
}

// ── Búsqueda global ───────────────────────────────────────────
function _initGlobalSearch() {
  const input = document.getElementById("global-search");
  if (!input) return;

  // Catalogo de modulos: view -> { label, icon, keywords }
  const MODULOS = [
    { view:"dashboard",        icon:"📊", label:"Dashboard",               kw:"dashboard resumen dia ventas kpis" },
    { view:"pedidos",          icon:"📋", label:"Pedidos",                  kw:"pedidos ordenes folio borrador confirmado" },
    { view:"clientes",         icon:"🏢", label:"Clientes",                 kw:"clientes empresas semaforo credito" },
    { view:"historial_ventas", icon:"📋", label:"Historial de Ventas",       kw:"historial ventas compras cliente log diagnostico ia" },
    { view:"ingenieros",       icon:"👤", label:"Staff operativo",           kw:"ingenieros vendedores recuperadores campo representantes staff" },
    { view:"asignaciones",     icon:"🔄", label:"Asignaciones",             kw:"asignaciones traspaso reasignar clientes zonas rutas ingeniero" },
    { view:"remisiones",       icon:"📄", label:"Remisiones",               kw:"remisiones credito notas facturas" },
    { view:"cobranza",         icon:"💰", label:"Cobranza",                 kw:"cobranza cobros abonos pagos" },
    { view:"cartera",          icon:"📉", label:"Cartera vencida",          kw:"cartera vencida intereses mora semaforo" },
    { view:"crm",              icon:"🎯", label:"CRM Prospectos",           kw:"crm prospectos pipeline oportunidades" },
    { view:"cotizaciones",     icon:"📑", label:"Cotizaciones",             kw:"cotizaciones presupuestos propuestas" },
    { view:"comisiones",       icon:"💵", label:"Comisiones",               kw:"comisiones nomina incentivos bono" },
    { view:"compras",          icon:"🛒", label:"Ordenes de compra",        kw:"compras ordenes proveedores" },
    { view:"inventario",       icon:"📦", label:"Inventario",               kw:"inventario stock existencias bodega" },
    { view:"reabasto",         icon:"📥", label:"Reabasto",                 kw:"reabasto surtido solicitud almacen stock ingeniero" },
    { view:"kardex",           icon:"🗂️", label:"Kardex",                   kw:"kardex movimientos entradas salidas" },
    { view:"productos",        icon:"🏷️", label:"Control de productos",     kw:"productos catalogo precios costos" },
    { view:"precios",          icon:"💲", label:"Precios y costos",         kw:"precios costos lista" },
    { view:"precios_segmento", icon:"🔖", label:"Precios por segmento",     kw:"precios segmento descuento" },
    { view:"promociones",      icon:"🎁", label:"Recompensas y lealtad",    kw:"promociones recompensas lealtad puntos" },
    { view:"devoluciones",     icon:"↩️", label:"Devoluciones",             kw:"devoluciones retornos cambios" },
    { view:"asistencia",       icon:"🕐", label:"Control de Asistencia",    kw:"asistencia horarios entradas salidas registro personal" },
    { view:"sms",             icon:"📱", label:"SMS Masivo",                kw:"sms campanas masivo sendpulse mensajes marketing" },
    { view:"logistica",        icon:"🚚", label:"Logistica de visitas",     kw:"logistica rutas visitas" },
    { view:"agroquimico",      icon:"🌿", label:"Agroquímico",              kw:"agroquimico cultivos recetas dosis trazabilidad fitosanitario" },
    { view:"integraciones",    icon:"🔌", label:"Integraciones",            kw:"integraciones api pasarela pagos whatsapp spei webhooks stripe conekta" },
    { view:"finanzas",         icon:"💰", label:"Finanzas",                  kw:"finanzas contabilidad cuentas pagar presupuesto centros costo estados financieros gl ap" },
    { view:"visitas",          icon:"📍", label:"Visitas",                  kw:"visitas programacion agenda" },
    { view:"mapa",             icon:"🗺️", label:"Mapa en vivo",             kw:"mapa gps campo ubicacion" },
    { view:"mapa_clientes",   icon:"📍", label:"Mapa de Clientes",          kw:"mapa clientes georeferencia ubicacion visita" },
    { view:"geocercas",        icon:"📐", label:"Geocercas",                kw:"geocercas zonas areas autorizadas" },
    { view:"metas",            icon:"🏆", label:"Metas de venta",           kw:"metas objetivos cuota" },
    { view:"autorizaciones",   icon:"🔐", label:"Autorizaciones",           kw:"autorizaciones aprobaciones bloqueos" },
    { view:"usuarios",         icon:"⚙️", label:"Usuarios y flags",         kw:"usuarios roles permisos flags" },
    { view:"bi_analytics",     icon:"🧠", label:"BI & Analytics",            kw:"bi analytics inteligencia negocios rentabilidad demanda prediccion comparativo" },
    { view:"reportes",         icon:"📈", label:"Reportes",                 kw:"reportes graficas estadisticas" },
    { view:"reportes_custom",  icon:"🛠️", label:"Reportes Configurables",   kw:"reportes custom configurables aging" },
    { view:"auditoria",        icon:"🔍", label:"Auditoria",                kw:"auditoria log historial cambios" },
    { view:"comentarios",      icon:"💬", label:"Comentarios de clientes",  kw:"comentarios feedback clientes" },
    { view:"rh",               icon:"👥", label:"Recursos Humanos",         kw:"rh recursos humanos empleados" },
    { view:"mi_rh",            icon:"🪪", label:"Mi RH",                   kw:"mi rh mi perfil empleado" },
    { view:"juridico",         icon:"⚖️", label:"Juridico",                 kw:"juridico legal contratos" },
    { view:"observabilidad",   icon:"📡", label:"Observabilidad",           kw:"observabilidad logs errores monitoreo" },
    { view:"formularios",      icon:"📝", label:"Formularios",              kw:"formularios encuestas capturas" },
    { view:"config",           icon:"🎫", label:"Config tickets",           kw:"config configuracion tickets" },
    { view:"config_intereses", icon:"📊", label:"Tasas de interes",         kw:"tasas interes configuracion intereses" },
    { view:"manuales",         icon:"📚", label:"Manuales y Politicas",     kw:"manuales politicas documentos" },
    { view:"chat",             icon:"💬", label:"Chat interno",             kw:"chat mensajes comunicacion" },
    { view:"feed",             icon:"⚡", label:"Feed en vivo",             kw:"feed actividad tiempo real" },
  ];

  const dropdown = document.createElement("div");
  dropdown.id = "gs-dropdown";
  dropdown.style.cssText = [
    "position:absolute","top:calc(100% + 4px)","left:0","right:0","min-width:340px",
    "background:var(--surface,#1e2330)","border:1px solid var(--border,#333)",
    "border-radius:10px","box-shadow:0 8px 24px rgba(0,0,0,.35)",
    "max-height:420px","overflow-y:auto","z-index:9999","display:none","font-family:inherit"
  ].join(";");
  input.parentElement.style.position = "relative";
  input.parentElement.appendChild(dropdown);

  let _timer = null;
  let _cacheUsuarios = null;
  let _cacheClientes = null;

  input.addEventListener("input", () => {
    clearTimeout(_timer);
    const q = input.value.trim();
    if (q.length < 2) { dropdown.style.display = "none"; return; }
    _timer = setTimeout(() => _runSearch(q), 300);
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { dropdown.style.display = "none"; input.value = ""; }
  });

  document.addEventListener("click", e => {
    if (!input.parentElement.contains(e.target)) dropdown.style.display = "none";
  });

  function _match(str, q) {
    const h = (str || "").toLowerCase();
    return h.startsWith(q) ? 2 : h.includes(q) ? 1 : 0;
  }

  async function _runSearch(q) {
    dropdown.innerHTML = "<div style='padding:12px 14px;color:#888;font-size:13px'>🔍 Buscando…</div>";
    dropdown.style.display = "block";

    const qL = q.toLowerCase();
    const sections = [];

    // 1. Modulos (client-side instantaneo)
    const modItems = MODULOS
      .filter(m => _match(m.label, qL) > 0 || _match(m.kw, qL) > 0)
      .slice(0, 6)
      .map(m => ({ icon: m.icon, label: m.label, sub: "", view: m.view, id: "" }));
    if (modItems.length) sections.push({ header: "🏠 Módulos", color: "#6c8ebf", items: modItems });

    // 2. Ingenieros/Usuarios
    try {
      if (!_cacheUsuarios) {
        const snap = await getDocs(query(collection(db, "usuarios"), fsLimit(200)));
        _cacheUsuarios = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
      const ingItems = _cacheUsuarios
        .filter(u => _match(u.alias || "", qL) > 0 || _match(u.nombre || "", qL) > 0 || _match(u.email || "", qL) > 0)
        .slice(0, 5)
        .map(u => ({ icon: "👤", label: u.alias || u.nombre || u.email || u.id, sub: u.rol || "", view: "ingenieros", id: u.id }));
        if (ingItems.length) sections.push({ header: "👤 Ingenieros", color: "#82b366", items: ingItems });
    } catch(e2) {}

    // 3. Clientes (fetch top 150, filter client-side)
    try {
      if (!_cacheClientes) {
        const snap = await getDocs(query(collection(db, "clientes"), orderBy("nombre"), fsLimit(150)));
        _cacheClientes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
      const cliItems = _cacheClientes
        .filter(c => _match(c.nombre || "", qL) > 0 || _match(c.ciudad || "", qL) > 0)
        .slice(0, 5)
        .map(c => ({ icon: "🏢", label: c.nombre || c.id, sub: c.ciudad || c.semaforoColor || "", view: "clientes", id: c.id }));
      if (cliItems.length) sections.push({ header: "🏢 Clientes", color: "#d6b656", items: cliItems });
    } catch(e3) {}

    // 4. Pedidos (folio + clienteNombre + ingenieroAlias)
    try {
      const pedSnap = await getDocs(query(collection(db, "pedidos"), orderBy("folio"), fsLimit(200)));
      const pedItems = pedSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(p => _match(String(p.folio || ""), qL) > 0 || _match(p.clienteNombre || "", qL) > 0 || _match(p.ingenieroAlias || "", qL) > 0)
        .slice(0, 5)
        .map(p => ({ icon: "📋", label: "#" + p.folio + " — " + (p.clienteNombre || ""), sub: p.status || "", view: "pedidos", id: p.id }));
      if (pedItems.length) sections.push({ header: "📋 Pedidos", color: "#9673a6", items: pedItems });
    } catch(e4) {}

    // Render
    if (sections.length === 0) {
      dropdown.innerHTML = "<div style='padding:14px;color:#888;font-size:13px;text-align:center'>Sin resultados para <strong>&quot;" + esc(q) + "&quot;</strong></div>";
      return;
    }

    let html = "";
    for (const sec of sections) {
      html += "<div style='padding:6px 14px 4px;font-size:11px;font-weight:600;color:" + sec.color + ";letter-spacing:.5px;border-bottom:1px solid var(--border,#333)'>" + sec.header + "</div>";
      for (const r of sec.items) {
        html += "<div class='gs-item' data-view='" + esc(r.view) + "' data-id='" + esc(r.id) + "' style='padding:9px 14px;cursor:pointer;display:flex;gap:10px;align-items:center;border-bottom:1px solid rgba(255,255,255,.05)'>" +
          "<span style='font-size:15px;width:20px;text-align:center;flex-shrink:0'>" + r.icon + "</span>" +
          "<span style='font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + esc(r.label) + "</span>" +
          "<span style='font-size:11px;color:#888;flex-shrink:0'>" + esc(r.sub) + "</span>" +
          "</div>";
      }
    }
    dropdown.innerHTML = html;

    dropdown.querySelectorAll(".gs-item").forEach(el => {
      el.addEventListener("mouseenter", () => el.style.background = "rgba(255,255,255,.06)");
      el.addEventListener("mouseleave", () => el.style.background = "");
      el.addEventListener("click", () => {
        dropdown.style.display = "none";
        input.value = "";
        _cacheClientes = null;
        _navigateGuarded(el.dataset.view);
      });
    });
  }
}
// ── Botón ✕ limpiar en campos de búsqueda ─────────────────────
function _initSearchClearButtons() {
  // Selector que coincide con todos los campos de búsqueda del ERP
  const SEL = [
    'input[type="search"]',
    'input[placeholder*="uscar"]',
    'input[placeholder*="iltra"]',
    '#global-search',
    '.input-search',
    '.sel-sm[type="text"]',
  ].join(",");

  // Inyecta el estilo del botón una sola vez
  if (!document.getElementById("_clr-style")) {
    const st = document.createElement("style");
    st.id = "_clr-style";
    st.textContent = `
      .srch-wrap { position:relative; display:inline-flex; align-items:center; }
      .srch-wrap > input { padding-right:24px !important; box-sizing:border-box; }
      .srch-clr {
        position:absolute; right:5px; top:50%; transform:translateY(-50%);
        background:none; border:none; cursor:pointer; padding:0; line-height:1;
        color:#9CA3AF; font-size:14px; display:none; z-index:2;
        transition:color .15s;
      }
      .srch-clr:hover { color:#EF4444; }
    `;
    document.head.appendChild(st);
  }

  function _decorate(input) {
    if (input._clearDecorated) return;
    input._clearDecorated = true;

    // Si el padre ya es srch-wrap, no envolver de nuevo
    const parent = input.parentElement;
    if (!parent) return;
    if (!parent.classList.contains("srch-wrap")) {
      const wrap = document.createElement("span");
      wrap.className = "srch-wrap";
      // Copiar el width/flex del input al wrap para no romper el layout
      const cs = getComputedStyle(input);
      if (cs.flex && cs.flex !== "0 1 auto") wrap.style.flex = cs.flex;
      if (input.style.width) wrap.style.width = input.style.width;
      parent.insertBefore(wrap, input);
      wrap.appendChild(input);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "srch-clr";
    btn.title = "Limpiar búsqueda";
    btn.textContent = "✕";
    input.parentElement.appendChild(btn);

    const toggle = () => {
      btn.style.display = (input.value && input.value !== input.placeholder) ? "block" : "none";
    };
    input.addEventListener("input",  toggle);
    input.addEventListener("change", toggle);
    toggle();

    btn.addEventListener("click", () => {
      input.value = "";
      toggle();
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
    });
  }

  // Decorar inputs ya presentes
  document.querySelectorAll(SEL).forEach(_decorate);

  // Observer para inputs añadidos dinámicamente (al navegar entre módulos)
  const obs = new MutationObserver(mutations => {
    mutations.forEach(m => {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches?.(SEL)) _decorate(node);
        node.querySelectorAll?.(SEL).forEach(_decorate);
      });
    });
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// ── Sidebar collapsible sections ──────────────────────────────
function _initSidebarCollapse() {
  const KEY = "n10_sb_";

  document.querySelectorAll(".sb-group[data-section]").forEach(grp => {
    const section = grp.dataset.section;
    const items   = grp.nextElementSibling;
    if (!items || !items.classList.contains("sb-section-items")) return;

    // Estado guardado — pero nunca colapsar "campo" y "ventas" (módulos principales)
    const neverCollapse = new Set(["campo","ventas","principal"]);
    if (!neverCollapse.has(section) && localStorage.getItem(KEY + section) === "1") {
      grp.classList.add("sb-collapsed");
      items.classList.add("sb-collapsed");
    } else {
      // Asegurar que los módulos principales estén siempre expandidos
      localStorage.removeItem(KEY + section);
    }

    grp.addEventListener("click", () => {
      const closing = !grp.classList.contains("sb-collapsed");
      grp.classList.toggle("sb-collapsed");
      items.classList.toggle("sb-collapsed");
      localStorage.setItem(KEY + section, closing ? "1" : "0");
    });
  });
}

// ── Exponer navigate globalmente ───────────────────────────────
window.navigate = _navigate;

// ── Detector de red (S6 Offline resilience) ────────────────────
(function _initNetworkDetector() {
  let _banner = null;

  function _showBanner() {
    if (_banner) return;
    _banner = document.createElement("div");
    _banner.id = "offline-banner";
    _banner.style.cssText = [
      "position:fixed", "top:0", "left:0", "right:0", "z-index:9999",
      "background:#B45309", "color:#fff", "text-align:center",
      "padding:7px 16px", "font-size:12px", "font-weight:600",
      "letter-spacing:.3px", "box-shadow:0 2px 8px rgba(0,0,0,.4)",
    ].join(";");
    _banner.textContent = "⚠️  Sin conexión — mostrando datos en caché";
    document.body.prepend(_banner);
    _setStatus("firebase", false, "Sin red");
  }

  function _hideBanner() {
    _banner?.remove();
    _banner = null;
    _setStatus("firebase", true, "Firebase conectado");
  }

  window.addEventListener("offline", _showBanner);
  window.addEventListener("online",  _hideBanner);

  // Estado inicial
  if (!navigator.onLine) _showBanner();
}());

// ── Visibilidad de sidebar por rol ────────────────────────────
function _aplicarVisibilidadSidebar() {
  const SA  = Sesion.esSuperAdmin();
  const rol = Sesion.rol;
  const f   = k => Sesion.tieneFlag(k); // SA siempre true via tieneFlag

  // pv: visible si es SA o alguno de los roles dados
  const pv  = (...roles) => SA || roles.includes(rol);
  // pvF: visible si pv(...roles) O tiene el flag k
  const pvF = (k, ...roles) => pv(...roles) || f(k);

  // Mapa vista → visible
  const vis = {
    // Principal: todos
    dashboard:  true,
    mapa:       true,
    feed:       true,
    // Campo
    ingenieros:  pv("GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    clientes:    pvF("PUEDE_CREAR_CLIENTES","GERENTE","MESA_CONTROL","RECUPERADOR","INGENIERO","JURIDICO","ADMINISTRADOR"),
    pedidos:     pvF("PUEDE_VER_PEDIDOS","GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    remisiones:  pvF("PUEDE_REGISTRAR_REMISION","GERENTE","MESA_CONTROL","RECUPERADOR","ADMINISTRADOR"),
    cobranza:    pvF("PUEDE_REGISTRAR_ABONO","GERENTE","MESA_CONTROL","RECUPERADOR","ADMINISTRADOR"),
    // Supervisión
    comentarios: pv("GERENTE","GERENTE_ZONA","ADMINISTRADOR","MESA_CONTROL"),
    // Admin — Operaciones
    usuarios:    pv("GERENTE"),
    comisiones:  pvF("PUEDE_VER_COMISIONES","GERENTE","ADMINISTRADOR","INGENIERO"),
    compras:     pv("GERENTE","ALMACENISTA","ADMINISTRADOR"),
    kardex:      pv("GERENTE","ALMACENISTA","ADMINISTRADOR"),
    asignaciones:pvF("PUEDE_CREAR_CLIENTES","GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    cartera:     pvF("PUEDE_VER_CARTERA_GLOBAL","GERENTE","MESA_CONTROL","RECUPERADOR","ADMINISTRADOR"),
    visitas:     pv("GERENTE","MESA_CONTROL","INGENIERO","ADMINISTRADOR"),
    cotizaciones:pv("GERENTE","MESA_CONTROL","INGENIERO","ADMINISTRADOR"),
    inventario:  pvF("PUEDE_ACCESO_STOCK","GERENTE","ALMACENISTA","ADMINISTRADOR"),
    devoluciones:pv("GERENTE","MESA_CONTROL","RECUPERADOR","ADMINISTRADOR"),
    chat:        true,
    rh:          pvF("PUEDE_VER_RH","GERENTE","ADMINISTRADOR"),
    crm:         pv("GERENTE","MESA_CONTROL","JURIDICO","ADMINISTRADOR"),
    asistencia:  pv("GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    sms:         pv("GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    logistica:   pv("GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    agroquimico: pv("GERENTE","MESA_CONTROL","INGENIERO","ADMINISTRADOR"),
    integraciones: SA,  // solo SUPER_ADMIN puede gestionar — los demás ven estado en readonly via el módulo
    finanzas:      pv("GERENTE","ADMINISTRADOR"),
    juridico:        pv("GERENTE","JURIDICO","RECUPERADOR","ADMINISTRADOR"),
    observabilidad:  pv("GERENTE","ADMINISTRADOR"),
    mi_rh:           pv("INGENIERO","RECUPERADOR","ALMACENISTA"),
    // Admin — Control
    precios:          pv("GERENTE","ADMINISTRADOR"),
    geocercas:        pv("GERENTE","ADMINISTRADOR"),
    metas:            pv("GERENTE","ADMINISTRADOR"),
    autorizaciones:   pv("GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    auditoria:        pv("GERENTE","ADMINISTRADOR"),
    // Admin — Configuración
    formularios:      pv("GERENTE","ADMINISTRADOR"),
    promociones:      pv("GERENTE","ADMINISTRADOR"),
    precios_segmento: pv("GERENTE","ADMINISTRADOR"),
    productos:        pvF("PUEDE_IMPORTAR_CATALOGO","GERENTE","ALMACENISTA","ADMINISTRADOR"),
    config:           pv("GERENTE","ADMINISTRADOR"),
    config_intereses: SA,  // solo SUPER_ADMIN
    reportes:         pv("GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    reportes_custom:  pv("GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    caja:             pv("GERENTE","MESA_CONTROL","ADMINISTRADOR"),
    gastos:           pv("GERENTE","ADMINISTRADOR","MESA_CONTROL"),
    historial_ventas: pv("GERENTE","ADMINISTRADOR","MESA_CONTROL"),
    bi_analytics:     pv("GERENTE","ADMINISTRADOR","MESA_CONTROL"),
    blacklist:        pv("GERENTE","ADMINISTRADOR","MESA_CONTROL","INGENIERO","RECUPERADOR","JURIDICO","VENDEDOR"),
  };

  // Aplicar visibilidad a cada sb-item
  document.querySelectorAll(".sb-item[data-view]").forEach(el => {
    const v = el.dataset.view;
    el.style.display = vis[v] !== false ? "" : "none";
  });

  // Visibilidad de cada grupo — ocultar si ningún item del grupo es visible
  const $sup   = id => document.getElementById(id);
  const showEl = (id, show) => { const e = $sup(id); if (e) e.style.display = show ? "" : "none"; };
  const anyVis = views => views.some(v => vis[v] !== false);

  const grupos = [
    { grp: "sb-grupo-campo",         sbi: "sbi-campo",        views: ["ingenieros","clientes","mapa_clientes","asignaciones","pedidos","remisiones","visitas","manuales","agroquimico","logistica","geocercas","blacklist"] },
    { grp: "sb-grupo-ventas",        sbi: "sbi-ventas",       views: ["crm","cotizaciones","metas","formularios","promociones","sms","historial_ventas"] },
    { grp: "sb-grupo-juridico-sec",  sbi: "sbi-juridico-sec", views: ["juridico"] },
    { grp: "sb-grupo-catalogo",      sbi: "sbi-catalogo",     views: ["productos","precios","precios_segmento"] },
    { grp: "sb-grupo-inventario",    sbi: "sbi-inventario",   views: ["inventario","reabasto","compras","proveedores","kardex","devoluciones"] },
    { grp: "sb-grupo-finanzas",      sbi: "sbi-finanzas",     views: ["caja","gastos","finanzas","comisiones","cartera","config_intereses","cobranza"] },
    { grp: "sb-grupo-rrhh",          sbi: "sbi-rrhh",         views: ["rh","mi_rh","asistencia"] },
    { grp: "sb-grupo-analisis",      sbi: "sbi-analisis",     views: ["bi_analytics","reportes","reportes_custom"] },
    { grp: "sb-grupo-supervision",   sbi: "sbi-supervision",  views: ["comentarios","autorizaciones","auditoria","observabilidad","chat"] },
    { grp: "sb-grupo-sistema",       sbi: "sbi-sistema",      views: ["usuarios","config","integraciones"] },
  ];
  grupos.forEach(({ grp, sbi, views }) => {
    const show = anyVis(views);
    showEl(grp, show);
    showEl(sbi, show);
  });
}

// ══════════════════════════════════════════════════════════════
// COMBOBOX GLOBAL — convierte <select class="sel-sm|form-input">
// en un input buscable con chevron ▾. Se activa automáticamente
// via MutationObserver para cualquier módulo sin tocar su código.
// ══════════════════════════════════════════════════════════════
(function _initComboboxEngine() {
  const SEL = "select.sel-sm, select.form-input";
  // Selects que NO se deben convertir (multi-select internos o flags)
  const SKIP = new Set(["inv-tipo","cr-aplicar-preset"]);

  function _upgrade(sel) {
    if (sel._cmb || SKIP.has(sel.id) || sel.multiple) return;
    sel._cmb = true;

    // ── Crear wrapper ──────────────────────────────────────────
    const wrap = document.createElement("div");
    wrap.className = "sel-cmb-wrap";
    // Heredar ancho explícito del select si lo tiene
    if (sel.style.width) wrap.style.width = sel.style.width;
    else if (sel.style.minWidth) wrap.style.minWidth = sel.style.minWidth;
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    // Input visible
    const inp = document.createElement("input");
    inp.type = "text";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    inp.className = sel.className.replace("form-input","sel-sm");
    // Heredar estilos inline del select
    if (sel.style.cssText) inp.style.cssText = sel.style.cssText;
    inp.style.width = "100%";
    inp.style.boxSizing = "border-box";
    const _syncLabel = () => {
      const o = sel.options[sel.selectedIndex];
      inp.value = o ? o.text : "";
    };
    _syncLabel();
    inp.placeholder = inp.value || "Seleccionar…";

    // Chevron
    const chev = document.createElement("span");
    chev.className = "sel-cmb-chevron";
    chev.textContent = "▾";
    chev.setAttribute("aria-hidden", "true");

    // Dropdown
    const dd = document.createElement("div");
    dd.className = "sel-cmb-dd";

    // Ocultar select nativo pero mantenerlo funcional
    sel.style.cssText = "position:absolute;opacity:0;pointer-events:none;width:0;height:0;";

    wrap.appendChild(inp);
    wrap.appendChild(chev);
    wrap.appendChild(dd);

    // ── Lógica ────────────────────────────────────────────────
    const open  = () => { wrap.classList.add("open"); _render(inp.value); };
    const close = () => { wrap.classList.remove("open"); _syncLabel(); };

    function _render(term) {
      const q = term.trim().toLowerCase();
      const opts = [...sel.options];
      const matches = q
        ? opts.filter(o => o.text.toLowerCase().includes(q))
        : opts;

      if (!matches.length) {
        dd.innerHTML = `<div class="sel-cmb-empty">Sin resultados</div>`;
        return;
      }
      dd.innerHTML = matches.map(o => {
        const hi = q
          ? o.text.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "gi"),
              "<strong>$1</strong>")
          : o.text;
        return `<div class="sel-cmb-item" data-val="${o.value.replace(/"/g,"&quot;")}">${hi}</div>`;
      }).join("");

      dd.querySelectorAll(".sel-cmb-item").forEach(item => {
        // Marcar seleccionado
        if (item.dataset.val === sel.value) item.classList.add("active");
        item.addEventListener("mousedown", e => {
          e.preventDefault();
          sel.value = item.dataset.val;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          close();
        });
      });
    }

    inp.addEventListener("click",  () => wrap.classList.contains("open") ? close() : open());
    inp.addEventListener("focus",  open);
    inp.addEventListener("input",  () => { wrap.classList.add("open"); _render(inp.value); });
    inp.addEventListener("blur",   () => setTimeout(close, 160));
    inp.addEventListener("keydown", e => {
      if (e.key === "Escape") { close(); inp.blur(); }
      if (e.key === "Enter") {
        const first = dd.querySelector(".sel-cmb-item");
        if (first) first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      }
    });

    // Re-sincronizar label si el select cambia programáticamente
    const mo = new MutationObserver(_syncLabel);
    mo.observe(sel, { childList: true, attributes: true, attributeFilter: ["value"] });
    // También si las opciones se repoblan desde JS
    new MutationObserver(() => { if (wrap.classList.contains("open")) _render(inp.value); else _syncLabel(); })
      .observe(sel, { childList: true });
  }

  // Aplicar a todos los selects actuales y futuros
  function _scan(root) {
    root.querySelectorAll(SEL).forEach(_upgrade);
  }

  document.addEventListener("DOMContentLoaded", () => _scan(document));

  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n.matches?.(SEL)) _upgrade(n);
        if (n.querySelectorAll) _scan(n);
      });
    }
  });
  // Esperar a que exista body
  if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener("DOMContentLoaded", () =>
    obs.observe(document.body, { childList: true, subtree: true }));
})();
