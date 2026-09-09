// ══════════════════════════════════════════════════════════════
// reabasto.js — Módulo de Solicitudes de Reabasto (Panel Web)
// ══════════════════════════════════════════════════════════════
import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, logAudit, norm } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, query, where, orderBy, onSnapshot,
  doc, updateDoc, getDoc, getDocs, setDoc, limit,
  serverTimestamp, writeBatch, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── ESC helper ───────────────────────────────────────────────
let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

// ── Permisos ───────────────────────────────────────────────────
const PUEDE_GESTIONAR = () =>
  ["SUPER_ADMIN","GERENTE","ADMINISTRADOR","ALMACENISTA"].includes(Sesion.rol);

// ── Estado local ───────────────────────────────────────────────
let _unsub       = null;
let _unsubStock  = null;
let _solicitudes  = [];
let _stockIng     = [];
let _filtroStock  = "";
let _filtroTab    = "PENDIENTE";
let _container    = null;

// ── Estados y colores ─────────────────────────────────────────
const ESTADOS = {
  PENDIENTE:           { label: "Pendiente",           color: "#F59E0B", bg: "#FEF3C7" },
  EN_PROCESO:          { label: "En proceso",          color: "#2563EB", bg: "#DBEAFE" },
  SURTIDO:             { label: "Surtido",             color: "#7C3AED", bg: "#EDE9FE" },
  RECIBIDO_COMPLETO:   { label: "Recibido completo",   color: "#16A34A", bg: "#DCFCE7" },
  RECIBIDO_PARCIAL:    { label: "Recibido parcial",    color: "#D97706", bg: "#FEF3C7" },
};

const TABS = [
  { key: "PENDIENTE",  label: "Pendientes",  icon: "⏳" },
  { key: "EN_PROCESO", label: "En proceso",  icon: "🔄" },
  { key: "SURTIDO",    label: "Surtidos",    icon: "📦" },
  { key: "HISTORIAL",  label: "Historial",   icon: "📋" },
  { key: "STOCK",      label: "Stock ingenieros", icon: "🚛" },
];

// ── Mount / Destroy ───────────────────────────────────────────
export function mount(container) {
  cargarNombres();
  _container = container;
  _container.innerHTML = _html();
  _bindTabs();
  _escuchar();
  _escucharStock();
}

export function destroy() {
  _unsub?.();
  _unsubStock?.();
  _unsub = null;
  _unsubStock = null;
  _solicitudes = [];
  _stockIng    = [];
  _container = null;
}

// ── HTML base ─────────────────────────────────────────────────
function _html() {
  return `
  <div style="padding:16px 20px;max-width:1200px;margin:0 auto">
    <!-- KPIs -->
    <div id="reb-kpis" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:16px"></div>

    <!-- Tabs -->
    <div id="reb-tabs" style="display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px">
      ${TABS.map(t => `
        <button class="reb-tab ${t.key==="PENDIENTE"?"active":""}" data-tab="${t.key}"
          style="padding:9px 16px;border:none;background:none;cursor:pointer;font-size:12px;font-weight:600;
            border-bottom:2px solid ${t.key==="PENDIENTE"?"#F59E0B":"transparent"};
            color:${t.key==="PENDIENTE"?"#F59E0B":"#9CA3AF"};margin-bottom:-1px;transition:all .15s">
          ${t.icon} ${t.label} <span class="reb-tab-count" data-tab="${t.key}" style="margin-left:4px;font-size:10px;opacity:.7"></span>
        </button>`).join("")}
    </div>

    <!-- Lista -->
    <div id="reb-lista" style="display:flex;flex-direction:column;gap:8px">
      <div style="padding:40px;text-align:center;color:#9CA3AF;font-size:13px">Cargando solicitudes…</div>
    </div>
  </div>

  <!-- Modal detalle -->
  <div id="reb-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;
    align-items:center;justify-content:center;overflow-y:auto;padding:20px">
    <div id="reb-modal-inner" style="background:var(--surface);border-radius:12px;width:100%;max-width:700px;
      max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)"></div>
  </div>`;
}

// ── Tabs ──────────────────────────────────────────────────────
function _bindTabs() {
  document.querySelectorAll(".reb-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      _filtroTab = btn.dataset.tab;
      document.querySelectorAll(".reb-tab").forEach(b => {
        const active = b.dataset.tab === _filtroTab;
        b.style.borderBottomColor = active ? "#F59E0B" : "transparent";
        b.style.color = active ? "#F59E0B" : "#9CA3AF";
      });
      _renderLista();
    });
  });
}

// ── Listener Firestore ────────────────────────────────────────
function _escuchar() {
  _unsub?.();
  const q = query(
    collection(db, "solicitudes_reabasto"),
    orderBy("_ts", "desc"),
    limit(200)
  );
  _unsub = onSnapshot(q, snap => {
    _solicitudes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderKPIs();
    _renderConteoTabs();
    _renderLista();
  }, err => {
    console.error("[reabasto] onSnapshot error:", err);
    const el = document.getElementById("reb-lista");
    if (el) el.innerHTML = `<div style="padding:40px;text-align:center;color:#DC2626;font-size:13px">
      Error al cargar solicitudes: ${err.message}</div>`;
  });
}

// ── KPIs ──────────────────────────────────────────────────────
function _renderKPIs() {
  const el = document.getElementById("reb-kpis");
  if (!el) return;
  const pend    = _solicitudes.filter(s => s.estado === "PENDIENTE").length;
  const enProc  = _solicitudes.filter(s => s.estado === "EN_PROCESO").length;
  const sinStock = _solicitudes.filter(s => s.tieneProductosSinStock && ["PENDIENTE","EN_PROCESO"].includes(s.estado)).length;
  const hoy     = new Date(); hoy.setHours(0,0,0,0);
  const hoyN    = _solicitudes.filter(s => s._ts >= hoy.getTime() && s.estado === "PENDIENTE").length;

  const kpi = (id, val, label, color) => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
      <div style="font-size:22px;font-weight:800;color:${color}">${val}</div>
      <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-top:2px">${label}</div>
    </div>`;

  el.innerHTML =
    kpi("k1", pend,     "Pendientes",          "#F59E0B") +
    kpi("k2", enProc,   "En proceso",          "#2563EB") +
    kpi("k3", sinStock, "Con producto faltante","#DC2626") +
    kpi("k4", hoyN,     "Nuevas hoy",          "#7C3AED");
}

// ── Conteo tabs ───────────────────────────────────────────────
function _renderConteoTabs() {
  TABS.forEach(t => {
    const el = document.querySelector(`.reb-tab-count[data-tab="${t.key}"]`);
    if (!el) return;
    let n = 0;
    if (t.key === "HISTORIAL") {
      n = _solicitudes.filter(s => ["RECIBIDO_COMPLETO","RECIBIDO_PARCIAL"].includes(s.estado)).length;
    } else if (t.key === "STOCK") {
      n = _stockIng.length;
    } else {
      n = _solicitudes.filter(s => s.estado === t.key).length;
    }
    el.textContent = n > 0 ? `(${n})` : "";
  });
}

// ── Lista ─────────────────────────────────────────────────────
function _renderLista() {
  const el = document.getElementById("reb-lista");
  if (!el) return;

  if (_filtroTab === "STOCK") { _renderStockIngenieros(el); return; }

  const filtradas = _filtroTab === "HISTORIAL"
    ? _solicitudes.filter(s => ["RECIBIDO_COMPLETO","RECIBIDO_PARCIAL"].includes(s.estado))
    : _solicitudes.filter(s => s.estado === _filtroTab);

  if (!filtradas.length) {
    el.innerHTML = `<div style="padding:40px;text-align:center;color:#9CA3AF;font-size:13px">
      Sin solicitudes en este estado.</div>`;
    return;
  }

  el.innerHTML = filtradas.map(s => _cardSolicitud(s)).join("");
  el.querySelectorAll(".reb-card").forEach(card => {
    card.addEventListener("click", () => _abrirDetalle(card.dataset.id));
  });
}

function _cardSolicitud(s) {
  const est     = ESTADOS[s.estado] || ESTADOS.PENDIENTE;
  const fecha   = s._ts ? new Date(s._ts).toLocaleDateString("es-MX",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "–";
  const nItems  = (s.items || []).length;
  const sinStock = (s.items || []).filter(i => !i.hayStock).length;
  const alerta  = s.tieneProductosSinStock && sinStock > 0;

  return `
  <div class="reb-card" data-id="${s.id}" style="background:var(--surface);border:1px solid ${alerta?"#FECACA":"var(--border)"};
    border-radius:10px;padding:14px 18px;cursor:pointer;transition:box-shadow .15s;
    ${alerta?"border-left:4px solid #DC2626;":""}">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px;color:var(--text-primary)">
          ${esc(resolverNombre(s.ingenieroAlias))}
          ${alerta?`<span style="margin-left:8px;font-size:10px;background:#FEE2E2;color:#DC2626;
            padding:2px 7px;border-radius:9px;font-weight:700">⚠ ${sinStock} sin stock</span>`:""}
        </div>
        <div style="font-size:11px;color:#6B7280;margin-top:2px">${fecha} · ${nItems} producto${nItems!==1?"s":""}</div>
        ${s.notasIngeniero ? `<div style="font-size:11px;color:#6B7280;margin-top:4px;font-style:italic">"${esc(s.notasIngeniero)}"</div>` : ""}
      </div>
      <span style="font-size:10px;font-weight:700;padding:4px 10px;border-radius:20px;
        background:${est.bg};color:${est.color};white-space:nowrap">${est.label}</span>
      <span style="color:#9CA3AF;font-size:16px">›</span>
    </div>
  </div>`;
}

// ── Modal detalle ─────────────────────────────────────────────
function _abrirDetalle(id) {
  const s = _solicitudes.find(x => x.id === id);
  if (!s) return;
  const modal = document.getElementById("reb-modal");
  const inner = document.getElementById("reb-modal-inner");
  inner.innerHTML = _htmlDetalle(s);
  modal.style.display = "flex";
  modal.onclick = e => { if (e.target === modal) _cerrarModal(); };
  _regEsc(_cerrarModal);
  _bindAccionesDetalle(s);
}

function _cerrarModal() {
  _unregEsc();
  const modal = document.getElementById("reb-modal");
  if (modal) modal.style.display = "none";
}

function _htmlDetalle(s) {
  const est   = ESTADOS[s.estado] || ESTADOS.PENDIENTE;
  const fecha = s._ts ? new Date(s._ts).toLocaleDateString("es-MX",{dateStyle:"medium",timeStyle:"short"}) : "–";
  const puede = PUEDE_GESTIONAR();

  const filasItems = (s.items || []).map((item, i) => {
    const sinStock = !item.hayStock;
    const puedeEditar = puede && s.estado === "EN_PROCESO";
    return `
    <tr style="border-bottom:1px solid var(--border);${sinStock?"background:#FFF7F7":""}">
      <td style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--text-primary)">${esc(item.nombre||"–")}</td>
      <td style="padding:8px 12px;font-size:11px;font-family:monospace;color:#6B7280">${esc(item.codigo||"–")}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;font-weight:700">${item.cantidadSolicitada||0}</td>
      <td style="padding:8px 12px;text-align:center;font-size:11px;color:${item.stockAlmacen>0?"#16A34A":"#DC2626"}">
        ${item.stockAlmacen||0} ${sinStock?`<span style="font-size:9px;background:#FEE2E2;color:#DC2626;padding:1px 5px;border-radius:6px">SIN STOCK</span>`:""}
      </td>
      <td style="padding:8px 12px;text-align:center">
        ${puedeEditar
          ? `<input type="number" class="reb-qty-surtida" data-idx="${i}" min="0" max="${item.cantidadSolicitada}"
              value="${item.cantidadSurtida ?? item.cantidadSolicitada}"
              style="width:60px;text-align:center;border:1px solid var(--border);border-radius:6px;padding:4px;font-size:12px;background:var(--surface)">`
          : `<span style="font-size:12px">${item.cantidadSurtida ?? "–"}</span>`}
      </td>
      <td style="padding:8px 12px;text-align:center;font-size:12px">
        ${item.cantidadRecibida ?? "–"}
      </td>
    </tr>`;
  }).join("");

  const botonesAccion = () => {
    if (!puede) return "";
    if (s.estado === "PENDIENTE") return `
      <button id="reb-btn-tomar" style="padding:9px 20px;border-radius:8px;border:none;font-weight:700;font-size:12px;
        cursor:pointer;background:#2563EB;color:#fff">🔄 Tomar solicitud</button>`;
    if (s.estado === "EN_PROCESO") return `
      <button id="reb-btn-surtir" style="padding:9px 20px;border-radius:8px;border:none;font-weight:700;font-size:12px;
        cursor:pointer;background:#7C3AED;color:#fff">📦 Marcar como surtido</button>`;
    return "";
  };

  return `
  <div style="padding:20px">
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <button onclick="window._rebCerrar()" style="padding:6px 12px;border:1px solid var(--border);
        border-radius:6px;background:transparent;color:var(--text-primary);font-size:12px;cursor:pointer">✕ Cerrar</button>
      <div style="flex:1">
        <div style="font-size:15px;font-weight:800;color:var(--text-primary)">
          Solicitud — ${esc(resolverNombre(s.ingenieroAlias))}
        </div>
        <div style="font-size:11px;color:#9CA3AF">${fecha} · Zona: ${esc(s.zona||"–")}</div>
      </div>
      <span style="font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;
        background:${est.bg};color:${est.color}">${est.label}</span>
    </div>

    <!-- Tabla productos -->
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:16px">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="background:var(--surface-2)">
            <th style="padding:8px 12px;text-align:left;font-weight:700;color:#9CA3AF;font-size:10px">PRODUCTO</th>
            <th style="padding:8px 12px;text-align:left;font-weight:700;color:#9CA3AF;font-size:10px">CÓDIGO</th>
            <th style="padding:8px 12px;text-align:center;font-weight:700;color:#9CA3AF;font-size:10px">SOLICITADO</th>
            <th style="padding:8px 12px;text-align:center;font-weight:700;color:#9CA3AF;font-size:10px">STOCK ALMACÉN</th>
            <th style="padding:8px 12px;text-align:center;font-weight:700;color:#9CA3AF;font-size:10px">SURTIDO</th>
            <th style="padding:8px 12px;text-align:center;font-weight:700;color:#9CA3AF;font-size:10px">RECIBIDO</th>
          </tr>
        </thead>
        <tbody>${filasItems}</tbody>
      </table>
    </div>

    <!-- Notas -->
    ${s.notasIngeniero ? `<div style="margin-bottom:12px;padding:10px 14px;background:var(--surface-2);border-radius:8px;font-size:12px">
      <span style="font-size:10px;color:#9CA3AF;font-weight:600">NOTA DEL INGENIERO:</span><br>
      ${esc(s.notasIngeniero)}
    </div>` : ""}
    ${s.notasAlmacenista ? `<div style="margin-bottom:12px;padding:10px 14px;background:var(--surface-2);border-radius:8px;font-size:12px">
      <span style="font-size:10px;color:#9CA3AF;font-weight:600">NOTA DEL ALMACENISTA:</span><br>
      ${esc(s.notasAlmacenista)}
    </div>` : ""}

    <!-- Notas almacenista al surtir -->
    ${puede && s.estado === "EN_PROCESO" ? `
    <div style="margin-bottom:16px">
      <label style="font-size:11px;color:#6B7280;font-weight:600;display:block;margin-bottom:4px">Notas del almacenista (opcional)</label>
      <textarea id="reb-notas-alm" rows="2" placeholder="Observaciones al surtir…"
        style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;
          padding:8px 12px;font-size:12px;background:var(--surface);color:var(--text-primary);resize:vertical">${s.notasAlmacenista||""}</textarea>
    </div>` : ""}

    <!-- Acciones -->
    <div style="display:flex;gap:8px;justify-content:flex-end">
      ${botonesAccion()}
    </div>
    <div id="reb-detalle-error" style="display:none;margin-top:8px;font-size:12px;color:#DC2626;text-align:right"></div>
  </div>`;
}

function _bindAccionesDetalle(s) {
  window._rebCerrar = _cerrarModal;

  document.getElementById("reb-btn-tomar")?.addEventListener("click", async () => {
    await _tomarSolicitud(s.id);
  });
  document.getElementById("reb-btn-surtir")?.addEventListener("click", async () => {
    await _surtirSolicitud(s);
  });
}

// ── Acciones ──────────────────────────────────────────────────
async function _tomarSolicitud(id) {
  const btn = document.getElementById("reb-btn-tomar");
  if (btn) { btn.disabled = true; btn.textContent = "Procesando…"; }
  try {
    await updateDoc(doc(db, "solicitudes_reabasto", id), {
      estado: "EN_PROCESO",
      almacenistaAlias: Sesion.alias,
      almacenistaUid:   Sesion.uid,
      tsTomado:         Date.now(),
    });
    await logAudit("REABASTO_EN_PROCESO", { solicitudId: id, almacenista: Sesion.alias });
    _cerrarModal();
    window.toast?.("Solicitud tomada. Ajusta las cantidades y márcala como surtida.", "success");
  } catch(e) {
    const err = document.getElementById("reb-detalle-error");
    if (err) { err.textContent = e.message; err.style.display = "block"; }
    if (btn) { btn.disabled = false; btn.textContent = "🔄 Tomar solicitud"; }
  }
}

async function _surtirSolicitud(s) {
  const btn = document.getElementById("reb-btn-surtir");
  if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }
  try {
    // Leer cantidades surtidas editadas
    const inputs = document.querySelectorAll(".reb-qty-surtida");
    const itemsActualizados = (s.items || []).map((item, i) => {
      const inp = document.querySelector(`.reb-qty-surtida[data-idx="${i}"]`);
      const cant = inp ? Math.max(0, parseInt(inp.value) || 0) : (item.cantidadSurtida ?? item.cantidadSolicitada);
      return { ...item, cantidadSurtida: cant };
    });

    const notas = document.getElementById("reb-notas-alm")?.value.trim() || "";
    await updateDoc(doc(db, "solicitudes_reabasto", s.id), {
      estado:            "SURTIDO",
      items:             itemsActualizados,
      notasAlmacenista:  notas,
      tsSurtido:         Date.now(),
    });

    // Descontar del stock del almacén
    const batch = writeBatch(db);
    for (const item of itemsActualizados) {
      if (!item.productoId || !item.cantidadSurtida) continue;
      const prodRef = doc(db, "productos", item.productoId);
      const prodSnap = await getDoc(prodRef);
      if (!prodSnap.exists()) continue;
      const stockActual = prodSnap.data().stock ?? 0;
      batch.update(prodRef, { stock: Math.max(0, stockActual - item.cantidadSurtida) });
      // Movimiento en kardex
      const movRef = doc(collection(db, "movimientos_stock"));
      batch.set(movRef, {
        tipo: "SALIDA", motivo: "REABASTO_INGENIERO",
        productoId: item.productoId,
        nombreProducto: item.nombre,
        cantidad: item.cantidadSurtida,
        stockAntes: stockActual,
        stockDespues: Math.max(0, stockActual - item.cantidadSurtida),
        solicitudId: s.id,
        ingenieroAlias: s.ingenieroAlias,
        quienRegistro: Sesion.alias,
        _ts: Date.now(),
      });
    }
    await batch.commit();

    await logAudit("REABASTO_SURTIDO", { solicitudId: s.id, ingeniero: s.ingenieroAlias, almacenista: Sesion.alias });

    // Notificación web push al ingeniero
    await _notificarIngeniero(s, itemsActualizados);

    _cerrarModal();
    window.toast?.("Solicitud marcada como surtida. Se notificó al ingeniero.", "success");
  } catch(e) {
    const err = document.getElementById("reb-detalle-error");
    if (err) { err.textContent = e.message; err.style.display = "block"; }
    if (btn) { btn.disabled = false; btn.textContent = "📦 Marcar como surtido"; }
  }
}

async function _notificarIngeniero(s, items) {
  try {
    const { addDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    await addDoc(collection(db, "notificaciones_web"), {
      tipo: "REABASTO_SURTIDO",
      titulo: "Reabasto listo para recoger",
      mensaje: `Tu solicitud de ${items.length} producto(s) fue surtida por ${Sesion.alias}.`,
      destinatarios: [s.ingenieroUid],
      leida: false,
      timestamp: serverTimestamp(),
      _ts: Date.now(),
      datos: { solicitudId: s.id },
    });
  } catch(e) { /* silencioso */ }
}

// ══════════════════════════════════════════════════════════════
// STOCK POR INGENIERO — tiempo real
// ══════════════════════════════════════════════════════════════

function _escucharStock() {
  _unsubStock?.();
  const q = query(collection(db, "stock_ingenieros"), orderBy("ingenieroAlias", "asc"));
  _unsubStock = onSnapshot(q, snap => {
    _stockIng = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (_filtroTab === "STOCK") _renderLista();
  });
}

function _renderStockIngenieros(el) {
  const ahora = Date.now();
  const DIAS_40 = 40 * 24 * 60 * 60 * 1000;

  const filtrados = _filtroStock
    ? _stockIng.filter(ing => norm(ing.ingenieroAlias).includes(norm(_filtroStock)))
    : _stockIng;

  const listaHtml = filtrados.length
    ? filtrados.map(ing => _cardStockIngeniero(ing, ahora, DIAS_40)).join("")
    : `<div style="padding:32px;text-align:center;color:#9CA3AF;font-size:13px">
        Sin datos de stock publicados. Los ingenieros sincronizan su inventario desde el APK.</div>`;

  el.innerHTML = `
    <div style="margin-bottom:14px;display:flex;gap:8px;align-items:center">
      <div style="position:relative;flex:1">
        <input id="reb-stock-buscar" type="text" placeholder="Filtrar por ingeniero…"
          value="${esc(_filtroStock)}"
          style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;padding:8px 12px;
            font-size:12px;background:var(--surface);color:var(--text-primary)">
        <div id="reb-stock-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
          background:var(--surface);border:1px solid var(--border);border-radius:8px;
          max-height:200px;overflow-y:auto;z-index:200;box-shadow:0 4px 16px #0002;margin-top:2px"></div>
      </div>
      ${filtrados.length ? `<span style="font-size:11px;color:#9CA3AF">${filtrados.length} ingeniero${filtrados.length!==1?"s":""}</span>` : ""}
      <button id="reb-nueva-asignacion"
        style="padding:7px 14px;font-size:12px;font-weight:700;border:none;border-radius:8px;
          background:#7C3AED;color:#fff;cursor:pointer;flex-shrink:0;white-space:nowrap">
        + Asignar stock
      </button>
    </div>
    ${listaHtml}
  `;

  const rebBuscar = document.getElementById("reb-stock-buscar");
  const rebDd     = document.getElementById("reb-stock-dd");
  rebBuscar?.addEventListener("input", e => {
    _filtroStock = e.target.value;
    _renderLista();
    const q = norm(_filtroStock);
    if (q.length < 1 || !rebDd) { if (rebDd) rebDd.style.display = "none"; return; }
    const aliases = [...new Set(_stockIng.map(i => i.ingenieroAlias).filter(Boolean))];
    const matches = aliases.filter(a => norm(a).includes(q)).slice(0, 12);
    if (!matches.length) { rebDd.style.display = "none"; return; }
    rebDd.innerHTML = matches.map(a =>
      `<div class="reb-dd-item" data-nombre="${esc(a)}"
        style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);color:var(--text-primary)">
        ${esc(a)}
      </div>`).join("");
    rebDd.style.display = "block";
    rebDd.querySelectorAll(".reb-dd-item").forEach(el2 =>
      el2.addEventListener("mousedown", ev => {
        ev.preventDefault();
        rebBuscar.value = el2.dataset.nombre;
        _filtroStock = el2.dataset.nombre;
        rebDd.style.display = "none";
        _renderLista();
      }));
  });
  rebBuscar?.addEventListener("blur",   () => setTimeout(() => { if (rebDd) rebDd.style.display = "none"; }, 150));
  rebBuscar?.addEventListener("keydown", e => { if (e.key === "Escape" && rebDd) rebDd.style.display = "none"; });

  document.getElementById("reb-nueva-asignacion")?.addEventListener("click", () => {
    _abrirAsignarConSelector();
  });

  el.querySelectorAll(".reb-asignar-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const uid   = btn.dataset.uid;
      const alias = btn.dataset.alias;
      const ing   = _stockIng.find(i => i.id === uid);
      _abrirAsignar(uid, alias, ing?.items || []);
    });
  });

  el.querySelectorAll(".reb-stock-card").forEach(card => {
    card.addEventListener("click", () => {
      const detail = card.nextElementSibling;
      if (detail?.classList.contains("reb-stock-detail")) {
        detail.style.display = detail.style.display === "none" ? "block" : "none";
      }
    });
  });
}

function _cardStockIngeniero(ing, ahora, DIAS_40) {
  const items         = ing.items || [];
  const totalItems    = items.length;
  const estancados    = items.filter(i => i.cantidad > 0 && i.ultimoMovimiento && (ahora - i.ultimoMovimiento) > DIAS_40);
  const sinProductos  = totalItems === 0;
  const tsSync        = ing._ts ? new Date(ing._ts).toLocaleDateString("es-MX",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "–";

  const filasItems = items.length === 0
    ? `<tr><td colspan="4" style="padding:10px;text-align:center;color:#9CA3AF;font-size:11px">Sin productos en vehículo</td></tr>`
    : items.map(item => {
        const diasSinMov = item.ultimoMovimiento ? Math.floor((ahora - item.ultimoMovimiento) / 86400000) : null;
        const estancado  = item.cantidad > 0 && diasSinMov !== null && diasSinMov > 40;
        return `
        <tr style="border-bottom:1px solid var(--border);${estancado?"background:#FFF7F7":""}">
          <td style="padding:7px 10px;font-size:12px;color:var(--text-primary)">${esc(item.nombre||"–")}</td>
          <td style="padding:7px 10px;font-size:11px;font-family:monospace;color:#6B7280">${esc(item.codigoN10||"–")}</td>
          <td style="padding:7px 10px;text-align:right;font-size:13px;font-weight:700;color:${item.cantidad>0?"var(--text-primary)":"#9CA3AF"}">
            ${Number(item.cantidad||0).toFixed(1)} ${esc(item.unidad||"")}
          </td>
          <td style="padding:7px 10px;text-align:center;font-size:10px;color:${estancado?"#DC2626":"#9CA3AF"}">
            ${diasSinMov !== null ? `${diasSinMov}d${estancado?" ⚠":""}` : "–"}
          </td>
        </tr>`;
      }).join("");

  return `
  <div class="reb-stock-card" style="background:var(--surface);border:1px solid ${estancados.length?"#FECACA":"var(--border)"};
    border-radius:10px;margin-bottom:8px;cursor:pointer;
    ${estancados.length?"border-left:4px solid #DC2626;":""}">
    <div style="padding:14px 16px;display:flex;align-items:center;gap:10px">
      <div style="width:36px;height:36px;border-radius:50%;background:#EDE9FE;
        display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">🚛</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13px;color:var(--text-primary)">${esc(resolverNombre(ing.ingenieroAlias))}</div>
        <div style="font-size:11px;color:#6B7280">
          ${totalItems} producto${totalItems!==1?"s":""}
          ${estancados.length ? `· <span style="color:#DC2626;font-weight:600">${estancados.length} estancado${estancados.length!==1?"s":""}</span>` : ""}
          · Sync: ${tsSync}
        </div>
      </div>
      <button class="reb-asignar-btn"
        data-uid="${esc(ing.id)}"
        data-alias="${esc(ing.ingenieroAlias||'')}"
        style="padding:5px 10px;font-size:11px;font-weight:600;border:1px solid #7C3AED;
          border-radius:6px;background:#EDE9FE;color:#7C3AED;cursor:pointer;flex-shrink:0">
        + Asignar
      </button>
      <span style="font-size:18px;color:#9CA3AF">›</span>
    </div>
  </div>
  <div class="reb-stock-detail" style="display:none;margin-top:-8px;margin-bottom:8px;
    border:1px solid var(--border);border-top:none;border-radius:0 0 10px 10px;overflow:hidden">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:var(--surface-2)">
          <th style="padding:7px 10px;text-align:left;font-size:10px;color:#9CA3AF;font-weight:700">PRODUCTO</th>
          <th style="padding:7px 10px;text-align:left;font-size:10px;color:#9CA3AF;font-weight:700">CÓDIGO</th>
          <th style="padding:7px 10px;text-align:right;font-size:10px;color:#9CA3AF;font-weight:700">CANTIDAD</th>
          <th style="padding:7px 10px;text-align:center;font-size:10px;color:#9CA3AF;font-weight:700">DÍAS SIN MOV</th>
        </tr>
      </thead>
      <tbody>${filasItems}</tbody>
    </table>
  </div>`;
}

// ══════════════════════════════════════════════════════════════
// Asignación directa de stock a ingeniero
// ══════════════════════════════════════════════════════════════

let _asignarProductos = [];    // caché de productos para búsqueda
let _asignarSelProd   = null;  // producto seleccionado en modal

function _inyectarModalAsignar() {
  if (document.getElementById("reb-asignar-modal")) return;
  const m = document.createElement("div");
  m.id = "reb-asignar-modal";
  m.style.cssText = `display:none;position:fixed;inset:0;z-index:9000;
    background:#0007;align-items:center;justify-content:center`;
  m.innerHTML = `
    <div style="background:var(--surface);border-radius:14px;padding:24px;width:min(440px,94vw);
      box-shadow:0 8px 40px #0005;position:relative">
      <button id="reb-asignar-cerrar" style="position:absolute;top:12px;right:14px;
        background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-secondary)">✕</button>
      <div style="font-weight:700;font-size:15px;color:var(--text-primary);margin-bottom:4px">
        Asignar stock directo</div>
      <div id="reb-asignar-ing-nombre"
        style="font-size:12px;color:#7C3AED;margin-bottom:16px"></div>

      <label style="font-size:11px;font-weight:600;color:#9CA3AF;display:block;margin-bottom:4px">PRODUCTO</label>
      <div style="position:relative;margin-bottom:14px">
        <input id="reb-asignar-buscar" type="text" autocomplete="off"
          placeholder="Buscar por nombre o código N10…"
          style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;
            padding:9px 12px;font-size:13px;background:var(--surface);color:var(--text-primary)">
        <div id="reb-asignar-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
          background:var(--surface);border:1px solid var(--border);border-radius:8px;
          max-height:200px;overflow-y:auto;z-index:200;box-shadow:0 4px 16px #0003;margin-top:2px"></div>
      </div>
      <div id="reb-asignar-prod-info" style="display:none;margin-bottom:14px;padding:8px 12px;
        background:var(--surface-2);border-radius:8px;font-size:12px;color:var(--text-primary)"></div>

      <label style="font-size:11px;font-weight:600;color:#9CA3AF;display:block;margin-bottom:4px">CANTIDAD</label>
      <input id="reb-asignar-cantidad" type="number" min="0" step="1" value=""
        style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;
          padding:9px 12px;font-size:15px;font-weight:700;background:var(--surface);
          color:var(--text-primary);margin-bottom:18px">

      <div id="reb-asignar-error" style="display:none;color:#DC2626;font-size:12px;margin-bottom:10px"></div>

      <button id="reb-asignar-guardar" style="width:100%;padding:11px;border:none;border-radius:8px;
        background:#7C3AED;color:#fff;font-size:14px;font-weight:700;cursor:pointer">
        Guardar asignación
      </button>
    </div>`;
  document.body.appendChild(m);

  document.getElementById("reb-asignar-cerrar").addEventListener("click", _cerrarAsignar);
  m.addEventListener("click", e => { if (e.target === m) _cerrarAsignar(); });

  const buscar = document.getElementById("reb-asignar-buscar");
  const dd     = document.getElementById("reb-asignar-dd");

  buscar.addEventListener("input", () => {
    _asignarSelProd = null;
    document.getElementById("reb-asignar-prod-info").style.display = "none";
    const q = norm(buscar.value);
    if (q.length < 2) { dd.style.display = "none"; return; }
    const matches = _asignarProductos
      .filter(p => norm(p.nombre||"").includes(q) || norm(p.codigoN10||"").includes(q))
      .slice(0, 12);
    if (!matches.length) { dd.style.display = "none"; return; }
    dd.innerHTML = matches.map(p =>
      `<div class="reb-ad-item" data-id="${p.id}"
        style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border);color:var(--text-primary)">
        <span style="font-weight:600">${esc(p.nombre||"")}</span>
        <span style="color:#9CA3AF;font-size:11px;margin-left:6px">${esc(p.codigoN10||"")}</span>
      </div>`).join("");
    dd.style.display = "block";
    dd.querySelectorAll(".reb-ad-item").forEach(el2 =>
      el2.addEventListener("mousedown", ev => {
        ev.preventDefault();
        const prod = _asignarProductos.find(p => p.id === el2.dataset.id);
        if (!prod) return;
        _asignarSelProd = prod;
        buscar.value = prod.nombre;
        dd.style.display = "none";
        const info = document.getElementById("reb-asignar-prod-info");
        info.textContent = `${prod.codigoN10 || "–"}  ·  ${prod.unidad || "–"}`;
        info.style.display = "block";
      }));
  });
  buscar.addEventListener("blur", () => setTimeout(() => { dd.style.display = "none"; }, 150));

  document.getElementById("reb-asignar-guardar").addEventListener("click", _guardarAsignacion);
}

async function _abrirAsignarConSelector() {
  _inyectarModalAsignar();

  // Mostrar campo de selección de ingeniero
  let ingRow = document.getElementById("reb-asignar-ing-row");
  if (!ingRow) {
    const modal = document.getElementById("reb-asignar-modal");
    const inner = modal?.querySelector("div");
    if (!inner) return;
    ingRow = document.createElement("div");
    ingRow.id = "reb-asignar-ing-row";
    ingRow.style.cssText = "margin-bottom:14px";
    ingRow.innerHTML = `
      <label style="font-size:11px;font-weight:600;color:#9CA3AF;display:block;margin-bottom:4px">INGENIERO</label>
      <div style="position:relative">
        <input id="reb-asignar-ing-buscar" type="text" autocomplete="off"
          placeholder="Buscar ingeniero…"
          style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;
            padding:9px 12px;font-size:13px;background:var(--surface);color:var(--text-primary)">
        <div id="reb-asignar-ing-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
          background:var(--surface);border:1px solid var(--border);border-radius:8px;
          max-height:180px;overflow-y:auto;z-index:210;box-shadow:0 4px 16px #0003;margin-top:2px"></div>
      </div>`;
    const ingNomEl = document.getElementById("reb-asignar-ing-nombre");
    inner.insertBefore(ingRow, ingNomEl);

    // Cargar ingenieros desde Firestore
    let _ingenieros = [];
    try {
      const snap = await getDocs(collection(db, "usuarios"));
      _ingenieros = snap.docs
        .map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => ["INGENIERO","RECUPERADOR","ALMACENISTA"].includes(u.rol) && u.activo !== false)
        .sort((a, b) => (a.alias||"").localeCompare(b.alias||"", "es"));
    } catch (_) {}

    const ingBuscar = document.getElementById("reb-asignar-ing-buscar");
    const ingDd     = document.getElementById("reb-asignar-ing-dd");
    ingBuscar.addEventListener("input", () => {
      const q = norm(ingBuscar.value);
      const matches = q.length < 1 ? _ingenieros : _ingenieros.filter(i => norm(i.alias||"").includes(q));
      if (!matches.length) { ingDd.style.display = "none"; return; }
      ingDd.innerHTML = matches.slice(0,12).map(i =>
        `<div class="reb-ing-item" data-uid="${esc(i.uid)}" data-alias="${esc(i.alias||"")}"
          style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);color:var(--text-primary)">
          ${esc(i.alias||"")} <span style="font-size:10px;color:#9CA3AF">${esc(i.rol||"")}</span>
        </div>`).join("");
      ingDd.style.display = "block";
      ingDd.querySelectorAll(".reb-ing-item").forEach(el2 =>
        el2.addEventListener("mousedown", ev => {
          ev.preventDefault();
          ingBuscar.value = el2.dataset.alias;
          ingDd.style.display = "none";
          const modal = document.getElementById("reb-asignar-modal");
          modal.dataset.uid   = el2.dataset.uid;
          modal.dataset.alias = el2.dataset.alias;
          document.getElementById("reb-asignar-ing-nombre").textContent = el2.dataset.alias;
        }));
    });
    ingBuscar.addEventListener("focus", () => ingBuscar.dispatchEvent(new Event("input")));
    ingBuscar.addEventListener("blur",  () => setTimeout(() => { ingDd.style.display = "none"; }, 150));
  }

  // Resetear estado
  document.getElementById("reb-asignar-ing-row").style.display = "block";
  const ingBuscar = document.getElementById("reb-asignar-ing-buscar");
  if (ingBuscar) { ingBuscar.value = ""; }
  document.getElementById("reb-asignar-ing-nombre").textContent = "";
  _asignarSelProd = null;
  document.getElementById("reb-asignar-buscar").value = "";
  document.getElementById("reb-asignar-dd").style.display = "none";
  document.getElementById("reb-asignar-prod-info").style.display = "none";
  document.getElementById("reb-asignar-cantidad").value = "";
  document.getElementById("reb-asignar-error").style.display = "none";

  const modal = document.getElementById("reb-asignar-modal");
  modal.dataset.uid   = "";
  modal.dataset.alias = "";
  modal.style.display = "flex";
  _regEsc(_cerrarAsignar);

  if (!_asignarProductos.length) {
    getDocs(collection(db, "productos")).then(snap => {
      _asignarProductos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(p => p.activo !== false)
        .sort((a, b) => (a.nombre||"").localeCompare(b.nombre||"", "es"));
    }).catch(() => {});
  }
}

function _abrirAsignar(uid, alias, currentItems) {
  _inyectarModalAsignar();
  _asignarSelProd = null;
  document.getElementById("reb-asignar-buscar").value = "";
  document.getElementById("reb-asignar-dd").style.display = "none";
  document.getElementById("reb-asignar-prod-info").style.display = "none";
  document.getElementById("reb-asignar-cantidad").value = "";
  document.getElementById("reb-asignar-error").style.display = "none";
  document.getElementById("reb-asignar-ing-nombre").textContent = alias;
  // Ocultar selector de ingeniero (ya está definido por la card)
  const ingRow = document.getElementById("reb-asignar-ing-row");
  if (ingRow) ingRow.style.display = "none";

  const modal = document.getElementById("reb-asignar-modal");
  modal.dataset.uid   = uid;
  modal.dataset.alias = alias;
  modal.style.display = "flex";
  _regEsc(_cerrarAsignar);

  if (!_asignarProductos.length) {
    getDocs(collection(db, "productos")).then(snap => {
      _asignarProductos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(p => p.activo !== false)
        .sort((a, b) => (a.nombre||"").localeCompare(b.nombre||"", "es"));
    }).catch(() => {});
  }
}

function _cerrarAsignar() {
  const modal = document.getElementById("reb-asignar-modal");
  if (modal) modal.style.display = "none";
  _unregEsc();
}

async function _guardarAsignacion() {
  const modal    = document.getElementById("reb-asignar-modal");
  const uid      = modal?.dataset.uid;
  const alias    = modal?.dataset.alias;
  const errEl    = document.getElementById("reb-asignar-error");
  const btn      = document.getElementById("reb-asignar-guardar");
  const cantStr  = document.getElementById("reb-asignar-cantidad").value.trim();

  errEl.style.display = "none";
  if (!uid)             { errEl.textContent = "Error: sin ingeniero."; errEl.style.display = "block"; return; }
  if (!_asignarSelProd) { errEl.textContent = "Selecciona un producto."; errEl.style.display = "block"; return; }
  const cantidad = parseFloat(cantStr);
  if (isNaN(cantidad) || cantidad < 0) { errEl.textContent = "Cantidad inválida."; errEl.style.display = "block"; return; }

  btn.disabled = true;
  btn.textContent = "Guardando…";

  try {
    const docRef  = doc(db, "stock_ingenieros", uid);
    const snap    = await getDoc(docRef);
    const actual  = snap.exists() ? (snap.data().items || []) : [];
    const prod    = _asignarSelProd;
    const ahora   = Date.now();

    const idx = actual.findIndex(i => i.productoId === prod.id || i.codigoN10 === prod.codigoN10);
    if (idx >= 0) {
      actual[idx] = { ...actual[idx], cantidad, ultimoMovimiento: ahora };
    } else {
      actual.push({
        productoId:       prod.id,
        nombre:           prod.nombre || "",
        codigoN10:        prod.codigoN10 || "",
        unidad:           prod.unidad || "",
        cantidad,
        ultimoMovimiento: ahora
      });
    }

    const baseData = snap.exists() ? {} : {
      ingenieroUid:   uid,
      ingenieroAlias: alias,
      almacenId:      0
    };

    await setDoc(docRef, { ...baseData, items: actual, _ts: ahora }, { merge: true });

    await logAudit("asignar_stock_ingeniero", {
      uid, alias,
      producto: prod.nombre, codigoN10: prod.codigoN10, cantidad
    });

    window.toast?.(`Stock asignado: ${prod.nombre} × ${cantidad}`, "success");
    _cerrarAsignar();
  } catch (e) {
    errEl.textContent = "Error: " + e.message;
    errEl.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar asignación";
  }
}

