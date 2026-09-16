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
let _unsub        = null;
let _unsubStock   = null;
let _solicitudes  = [];
let _stockIng     = [];
let _filtroStock  = "";
let _filtroTab    = "PENDIENTE";
let _container    = null;
let _prevPendCount = -1;   // para detectar nuevas requisiciones

// ── Badge sidebar ─────────────────────────────────────────────
function _actualizarBadgeSidebar(n) {
  let badge = document.getElementById("reb-sidebar-badge");
  const link = document.querySelector('a[data-view="reabasto"]');
  if (!link) return;
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "reb-sidebar-badge";
    badge.className = "sb-badge aut-alarm";
    badge.style.cssText = "margin-left:auto;animation:reb-badge-pulse 0.8s ease-in-out infinite";
    link.appendChild(badge);
  }
  if (n > 0) {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// ── Alarma sonora ─────────────────────────────────────────────
let _audioCtx = null;
function _sonarAlarma() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    // Secuencia: 3 pitidos urgentes
    [[0, 880, 0.18], [0.22, 1100, 0.15], [0.42, 880, 0.18]].forEach(([t, freq, dur]) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + dur);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + dur + 0.05);
    });
  } catch (_) {}
}

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
  // Badge persiste en sidebar — se actualiza al montar de nuevo
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
    const pendN = _solicitudes.filter(s => s.estado === "PENDIENTE").length;
    _actualizarBadgeSidebar(pendN);
    // Alarma solo cuando llega una nueva (no en la carga inicial)
    if (_prevPendCount >= 0 && pendN > _prevPendCount) _sonarAlarma();
    _prevPendCount = pendN;
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
  const fecha = s._ts ? new Date(s._ts).toLocaleString("es-MX",{dateStyle:"medium",timeStyle:"short"}) : "–";
  const puede = PUEDE_GESTIONAR();

  const filasItems = (s.items || []).map((item, i) => {
    const sinStock = !item.hayStock;
    const puedeEditar = puede && s.estado === "EN_PROCESO";
    const rowBg = sinStock ? "background:rgba(220,38,38,.10);border-left:3px solid #DC2626" : "border-left:3px solid transparent";
    return `
    <tr style="border-bottom:1px solid var(--border);${rowBg}">
      <td style="padding:8px 12px;font-size:13px;font-weight:700;color:var(--text-primary)">${esc(item.nombre||"–")}</td>
      <td style="padding:8px 12px;font-size:11px;font-family:monospace;color:var(--text-muted)">${esc(item.codigoN10||"–")}</td>
      <td style="padding:8px 12px;text-align:center;font-size:13px;font-weight:800;color:var(--text-primary)">${item.cantidadSolicitada||0}</td>
      <td style="padding:8px 12px;text-align:center;font-size:12px;font-weight:700;color:${(item.stockAlmacen||0)>0?"#22C55E":"#F87171"}">
        ${item.stockAlmacen||0}
        ${sinStock?`<span style="display:inline-block;font-size:9px;font-weight:800;background:#DC2626;color:#fff;
          padding:2px 6px;border-radius:4px;margin-left:4px;letter-spacing:.03em">SIN STOCK</span>`:""}
      </td>
      <td style="padding:8px 12px;text-align:center;font-size:13px;font-weight:700;color:var(--text-primary)">
        ${puedeEditar
          ? `<input type="number" class="reb-qty-surtida" data-idx="${i}" min="0" max="${item.cantidadSolicitada}"
              value="${item.cantidadSurtida ?? item.cantidadSolicitada}"
              style="width:64px;text-align:center;border:1px solid var(--border);border-radius:6px;
                padding:5px;font-size:13px;font-weight:700;background:var(--surface);color:var(--text-primary)">`
          : `<span>${item.cantidadSurtida ?? "–"}</span>`}
      </td>
      <td style="padding:8px 12px;text-align:center;font-size:13px;font-weight:700;color:var(--text-primary)">
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
  <div style="padding:0">
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:12px;padding:16px 20px;
      border-bottom:1px solid var(--border);background:var(--surface-2);border-radius:12px 12px 0 0">
      <button onclick="window._rebCerrar()" style="flex-shrink:0;padding:7px 14px;border:1px solid var(--border);
        border-radius:7px;background:var(--surface);color:var(--text-primary);font-size:12px;font-weight:600;cursor:pointer">✕ Cerrar</button>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:800;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          📦 ${esc(resolverNombre(s.ingenieroAlias))}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${fecha}</div>
      </div>
      <span style="flex-shrink:0;font-size:11px;font-weight:800;padding:5px 14px;border-radius:20px;letter-spacing:.04em;
        background:${est.bg};color:${est.color}">${est.label}</span>
    </div>

    <!-- Tabla productos -->
    <div style="padding:16px 20px">
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:14px">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--surface-2)">
            <th style="padding:9px 12px;text-align:left;font-weight:700;color:var(--text-muted);font-size:10px;letter-spacing:.06em">PRODUCTO</th>
            <th style="padding:9px 12px;text-align:left;font-weight:700;color:var(--text-muted);font-size:10px;letter-spacing:.06em">CÓDIGO</th>
            <th style="padding:9px 12px;text-align:center;font-weight:700;color:var(--text-muted);font-size:10px;letter-spacing:.06em">SOLICITADO</th>
            <th style="padding:9px 12px;text-align:center;font-weight:700;color:var(--text-muted);font-size:10px;letter-spacing:.06em">STOCK ALMACÉN</th>
            <th style="padding:9px 12px;text-align:center;font-weight:700;color:var(--text-muted);font-size:10px;letter-spacing:.06em">SURTIDO</th>
            <th style="padding:9px 12px;text-align:center;font-weight:700;color:var(--text-muted);font-size:10px;letter-spacing:.06em">RECIBIDO</th>
          </tr>
        </thead>
        <tbody>${filasItems}</tbody>
      </table>
    </div>

    <!-- Notas -->
    ${s.notasIngeniero ? `<div style="margin-bottom:10px;padding:10px 14px;background:var(--surface-2);border-radius:8px;
      border-left:3px solid #F59E0B;font-size:12px;color:var(--text-primary)">
      <span style="font-size:10px;color:#F59E0B;font-weight:700;letter-spacing:.05em">NOTA DEL INGENIERO</span><br>
      <span style="margin-top:3px;display:block">${esc(s.notasIngeniero)}</span>
    </div>` : ""}
    ${s.notasAlmacenista ? `<div style="margin-bottom:10px;padding:10px 14px;background:var(--surface-2);border-radius:8px;
      border-left:3px solid #7C3AED;font-size:12px;color:var(--text-primary)">
      <span style="font-size:10px;color:#7C3AED;font-weight:700;letter-spacing:.05em">NOTA DEL ALMACENISTA</span><br>
      <span style="margin-top:3px;display:block">${esc(s.notasAlmacenista)}</span>
    </div>` : ""}

    <!-- Notas almacenista al surtir -->
    ${puede && s.estado === "EN_PROCESO" ? `
    <div style="margin-bottom:14px">
      <label style="font-size:11px;color:var(--text-muted);font-weight:600;display:block;margin-bottom:5px;letter-spacing:.05em">OBSERVACIONES AL SURTIR (opcional)</label>
      <textarea id="reb-notas-alm" rows="2" placeholder="Ej: faltó 1 unidad de FURADAN, se reintegra al almacén"
        style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;
          padding:9px 12px;font-size:12px;background:var(--surface);color:var(--text-primary);resize:vertical">${s.notasAlmacenista||""}</textarea>
    </div>` : ""}

    <!-- Acciones -->
    <div style="display:flex;gap:8px;justify-content:flex-end;padding-top:4px">
      ${botonesAccion()}
    </div>
    <div id="reb-detalle-error" style="display:none;margin-top:10px;font-size:12px;font-weight:600;color:#F87171;
      background:rgba(220,38,38,.12);padding:8px 12px;border-radius:6px;text-align:right"></div>
    </div><!-- /padding wrapper -->
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
      const pData = prodSnap.data();
      const stockActual = pData.stock ?? 0;
      const stockDespues = Math.max(0, stockActual - item.cantidadSurtida);
      batch.update(prodRef, { stock: stockDespues, stockActual: stockDespues });
      // Sincronizar inventario
      const invId = pData.codigoN10 || pData.codigo;
      if (invId) {
        batch.set(doc(db, "inventario", invId), { stockActual: stockDespues, _ts: Date.now() }, { merge: true });
      }
      // Movimiento en kardex
      const movRef = doc(collection(db, "movimientos_stock"));
      batch.set(movRef, {
        tipo: "SALIDA", motivo: "REABASTO_INGENIERO",
        productoId: item.productoId,
        nombreProducto: item.nombre,
        cantidad: item.cantidadSurtida,
        stockAntes: stockActual,
        stockDespues,
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
      _abrirAsignar(uid, alias);
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
// MODAL CARRITO — Asignación directa multi-SKU a ingeniero
// Crea solicitudes_reabasto con origen:"DIRECTA" para que el
// ingeniero coteje y acepte desde el APK.
// ══════════════════════════════════════════════════════════════

let _cart        = [];   // [{ prod, cantidad }]
let _cartUid     = "";
let _cartAlias   = "";
let _catalogoProd = [];  // caché de productos
let _catalogoIng  = [];  // caché de ingenieros
let _cartSelProd  = null;

// ── Inyectar modal (solo una vez en el DOM) ───────────────────
function _inyectarModalAsignar() {
  if (document.getElementById("reb-asignar-modal")) return;
  const m = document.createElement("div");
  m.id = "reb-asignar-modal";
  m.style.cssText = `display:none;position:fixed;inset:0;z-index:9000;
    background:rgba(0,0,0,.55);align-items:flex-start;justify-content:center;
    padding:24px 12px;overflow-y:auto`;
  m.innerHTML = `
  <div style="background:var(--surface);border-radius:14px;width:min(620px,100%);
    box-shadow:0 12px 48px rgba(0,0,0,.4);position:relative;margin:auto">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;
      padding:18px 20px 14px;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:800;font-size:15px;color:var(--text-primary)">📦 Nueva asignación de stock</div>
        <div id="reb-cart-ing-label" style="font-size:12px;color:#7C3AED;margin-top:2px"></div>
      </div>
      <button id="reb-asignar-cerrar" style="background:none;border:none;font-size:20px;
        cursor:pointer;color:var(--text-muted);line-height:1">✕</button>
    </div>

    <div style="padding:18px 20px;display:flex;flex-direction:column;gap:14px">

      <!-- Selector ingeniero -->
      <div id="reb-cart-ing-wrap">
        <label style="font-size:11px;font-weight:700;color:#9CA3AF;display:block;margin-bottom:5px;letter-spacing:.05em">DESTINATARIO</label>
        <select id="reb-cart-ing-select"
          style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;
            padding:9px 12px;font-size:13px;background:var(--surface);color:var(--text-primary);cursor:pointer">
          <option value="" disabled selected>— Selecciona un ingeniero —</option>
        </select>
      </div>

      <!-- Buscador producto + cantidad -->
      <div style="background:var(--surface-2);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px">
        <label style="font-size:11px;font-weight:700;color:#9CA3AF;letter-spacing:.05em">AGREGAR PRODUCTO</label>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <div style="flex:1;position:relative">
            <input id="reb-cart-prod-buscar" type="text" autocomplete="off" placeholder="Nombre o código N10…"
              style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;
                padding:8px 12px;font-size:13px;background:var(--surface);color:var(--text-primary)">
            <div id="reb-cart-prod-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
              background:var(--surface);border:1px solid var(--border);border-radius:8px;
              max-height:220px;overflow-y:auto;z-index:300;box-shadow:0 6px 20px rgba(0,0,0,.15);margin-top:3px"></div>
          </div>
          <input id="reb-cart-cant" type="number" min="0.01" step="1" placeholder="Cant."
            style="width:76px;flex-shrink:0;border:1px solid var(--border);border-radius:8px;
              padding:8px 10px;font-size:14px;font-weight:700;text-align:center;
              background:var(--surface);color:var(--text-primary)">
          <button id="reb-cart-agregar" style="flex-shrink:0;padding:8px 14px;border:none;border-radius:8px;
            background:#7C3AED;color:#fff;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">
            + Agregar
          </button>
        </div>
        <div id="reb-cart-prod-info" style="display:none;font-size:11px;color:#6B7280;padding:2px 4px"></div>
      </div>

      <!-- Carrito -->
      <div>
        <div style="font-size:11px;font-weight:700;color:#9CA3AF;letter-spacing:.05em;margin-bottom:8px">
          PRODUCTOS EN LA ASIGNACIÓN <span id="reb-cart-count" style="color:#7C3AED"></span>
        </div>
        <div id="reb-cart-lista" style="display:flex;flex-direction:column;gap:6px;min-height:40px">
          <div id="reb-cart-vacio" style="padding:16px;text-align:center;color:#9CA3AF;font-size:12px;
            border:1px dashed var(--border);border-radius:8px">
            Agrega productos usando el buscador de arriba
          </div>
        </div>
      </div>

      <!-- Error + botón enviar -->
      <div id="reb-cart-error" style="display:none;color:#DC2626;font-size:12px;padding:8px 12px;
        background:#FEF2F2;border-radius:6px"></div>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="reb-cart-cancelar" style="padding:10px 18px;border:1px solid var(--border);
          border-radius:8px;background:none;color:var(--text-primary);font-size:13px;font-weight:600;cursor:pointer">
          Cancelar
        </button>
        <button id="reb-cart-enviar" style="padding:10px 22px;border:none;border-radius:8px;
          background:#7C3AED;color:#fff;font-size:13px;font-weight:700;cursor:pointer">
          Enviar asignación →
        </button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(m);

  // Cerrar
  document.getElementById("reb-asignar-cerrar").addEventListener("click", _cerrarAsignar);
  document.getElementById("reb-cart-cancelar").addEventListener("click", _cerrarAsignar);
  m.addEventListener("mousedown", e => { if (e.target === m) _cerrarAsignar(); });

  // Selector ingeniero (dropdown)
  const ingSelect = document.getElementById("reb-cart-ing-select");
  ingSelect.addEventListener("change", () => {
    const uid = ingSelect.value;
    const ing = _catalogoIng.find(i => i.uid === uid);
    _cartUid   = uid;
    _cartAlias = ing ? (ing.alias || "") : "";
    const nombre = ing ? (ing.nombre || ing.alias || uid) : uid;
    document.getElementById("reb-cart-ing-label").textContent = uid ? `→ ${nombre}` : "";
  });

  // Buscador producto
  const prodInput = document.getElementById("reb-cart-prod-buscar");
  const prodDd    = document.getElementById("reb-cart-prod-dd");
  const prodInfo  = document.getElementById("reb-cart-prod-info");
  prodInput.addEventListener("input", () => {
    _cartSelProd = null;
    prodInfo.style.display = "none";
    const q = norm(prodInput.value);
    if (q.length < 2) { prodDd.style.display = "none"; return; }
    const matches = _catalogoProd
      .filter(p => norm(p.nombre||"").includes(q) || norm(p.codigoN10||"").includes(q))
      .slice(0, 14);
    if (!matches.length) { prodDd.style.display = "none"; return; }
    prodDd.innerHTML = matches.map(p =>
      `<div class="reb-cp-item" data-id="${p.id}"
        style="padding:9px 14px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border);color:var(--text-primary)">
        <span style="font-weight:600">${esc(p.nombre||"")}</span>
        <span style="color:#9CA3AF;font-size:11px;margin-left:6px">${esc(p.codigoN10||"")}</span>
        <span style="color:${(p.stock||0)>0?"#16A34A":"#DC2626"};font-size:11px;margin-left:6px">
          Stock: ${p.stock||0} ${esc(p.unidad||"")}
        </span>
      </div>`).join("");
    prodDd.style.display = "block";
    prodDd.querySelectorAll(".reb-cp-item").forEach(el2 =>
      el2.addEventListener("mousedown", ev => {
        ev.preventDefault();
        const prod = _catalogoProd.find(p => p.id === el2.dataset.id);
        if (!prod) return;
        _cartSelProd   = prod;
        prodInput.value = prod.nombre;
        prodDd.style.display = "none";
        prodInfo.textContent = `${prod.codigoN10||"–"} · ${prod.unidad||"–"} · Stock almacén: ${prod.stock||0}`;
        prodInfo.style.display = "block";
        document.getElementById("reb-cart-cant").focus();
      }));
  });
  prodInput.addEventListener("blur", () => setTimeout(() => { prodDd.style.display = "none"; }, 150));

  // Agregar al carrito
  document.getElementById("reb-cart-agregar").addEventListener("click", () => {
    const errEl = document.getElementById("reb-cart-error");
    errEl.style.display = "none";
    if (!_cartSelProd) { errEl.textContent = "Selecciona un producto del buscador."; errEl.style.display = "block"; return; }
    const cant = parseFloat(document.getElementById("reb-cart-cant").value);
    if (isNaN(cant) || cant <= 0) { errEl.textContent = "Ingresa una cantidad mayor a 0."; errEl.style.display = "block"; return; }
    const existe = _cart.findIndex(c => c.prod.id === _cartSelProd.id);
    if (existe >= 0) {
      _cart[existe].cantidad += cant;
    } else {
      _cart.push({ prod: _cartSelProd, cantidad: cant });
    }
    prodInput.value = "";
    document.getElementById("reb-cart-cant").value = "";
    prodInfo.style.display = "none";
    _cartSelProd = null;
    _renderCarrito();
    prodInput.focus();
  });

  // Enviar
  document.getElementById("reb-cart-enviar").addEventListener("click", _enviarAsignacion);
}

function _renderCarrito() {
  const lista  = document.getElementById("reb-cart-lista");
  const vacio  = document.getElementById("reb-cart-vacio");
  const count  = document.getElementById("reb-cart-count");
  if (!lista) return;
  count.textContent = _cart.length > 0 ? `(${_cart.length})` : "";
  if (_cart.length === 0) {
    lista.innerHTML = "";
    lista.appendChild(vacio || document.createElement("div"));
    if (vacio) vacio.style.display = "block";
    return;
  }
  if (vacio) vacio.style.display = "none";
  lista.innerHTML = _cart.map((c, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;
      background:var(--surface-2);border-radius:8px;border:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(c.prod.nombre||"")}</div>
        <div style="font-size:11px;color:#6B7280">${esc(c.prod.codigoN10||"–")} · ${esc(c.prod.unidad||"")}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <button class="reb-cart-menos" data-i="${i}"
          style="width:26px;height:26px;border:1px solid var(--border);border-radius:6px;
            background:none;cursor:pointer;font-size:14px;font-weight:700;color:var(--text-primary)">−</button>
        <span style="font-size:14px;font-weight:800;color:#7C3AED;min-width:36px;text-align:center">${c.cantidad}</span>
        <button class="reb-cart-mas" data-i="${i}"
          style="width:26px;height:26px;border:1px solid var(--border);border-radius:6px;
            background:none;cursor:pointer;font-size:14px;font-weight:700;color:var(--text-primary)">+</button>
      </div>
      <button class="reb-cart-quitar" data-i="${i}"
        style="background:none;border:none;cursor:pointer;font-size:16px;color:#9CA3AF;padding:4px">✕</button>
    </div>`).join("");

  lista.querySelectorAll(".reb-cart-quitar").forEach(btn =>
    btn.addEventListener("click", () => { _cart.splice(parseInt(btn.dataset.i), 1); _renderCarrito(); }));
  lista.querySelectorAll(".reb-cart-menos").forEach(btn =>
    btn.addEventListener("click", () => {
      const i = parseInt(btn.dataset.i);
      if (_cart[i].cantidad > 1) { _cart[i].cantidad--; _renderCarrito(); }
    }));
  lista.querySelectorAll(".reb-cart-mas").forEach(btn =>
    btn.addEventListener("click", () => { _cart[parseInt(btn.dataset.i)].cantidad++; _renderCarrito(); }));
}

async function _abrirAsignarConSelector() {
  _inyectarModalAsignar();
  _cart = []; _cartUid = ""; _cartAlias = "";
  _cartSelProd = null;
  const ingSelectReset = document.getElementById("reb-cart-ing-select");
  if (ingSelectReset) ingSelectReset.selectedIndex = 0;
  document.getElementById("reb-cart-ing-label").textContent = "";
  document.getElementById("reb-cart-prod-buscar").value = "";
  document.getElementById("reb-cart-cant").value = "";
  document.getElementById("reb-cart-prod-info").style.display = "none";
  document.getElementById("reb-cart-error").style.display = "none";
  document.getElementById("reb-cart-ing-wrap").style.display = "block";
  _renderCarrito();
  const modal = document.getElementById("reb-asignar-modal");
  modal.style.display = "flex";
  _regEsc(_cerrarAsignar);
  _cargarCatalogos();
}

function _abrirAsignar(uid, alias) {
  _inyectarModalAsignar();
  _cart = []; _cartUid = uid; _cartAlias = alias;
  _cartSelProd = null;
  document.getElementById("reb-cart-ing-label").textContent = `→ ${resolverNombre(alias) || alias}`;
  document.getElementById("reb-cart-ing-wrap").style.display = "none";
  document.getElementById("reb-cart-prod-buscar").value = "";
  document.getElementById("reb-cart-cant").value = "";
  document.getElementById("reb-cart-prod-info").style.display = "none";
  document.getElementById("reb-cart-error").style.display = "none";
  _renderCarrito();
  const modal = document.getElementById("reb-asignar-modal");
  modal.style.display = "flex";
  _regEsc(_cerrarAsignar);
  _cargarCatalogos();
}

function _cerrarAsignar() {
  const modal = document.getElementById("reb-asignar-modal");
  if (modal) modal.style.display = "none";
  _unregEsc();
}

function _poblarSelectIng() {
  const sel = document.getElementById("reb-cart-ing-select");
  if (!sel) return;
  sel.innerHTML = `<option value="" disabled selected>— Selecciona un ingeniero —</option>` +
    _catalogoIng.map(i =>
      `<option value="${esc(i.uid)}" data-uid="${esc(i.uid)}" data-alias="${esc(i.alias||"")}">
        ${esc(i.nombre || i.alias || i.uid)}
      </option>`
    ).join("");
}

function _cargarCatalogos() {
  if (!_catalogoProd.length) {
    getDocs(collection(db, "productos")).then(snap => {
      _catalogoProd = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(p => p.activo !== false)
        .sort((a, b) => (a.nombre||"").localeCompare(b.nombre||"", "es"));
    }).catch(() => {});
  }
  if (!_catalogoIng.length) {
    getDocs(collection(db, "usuarios")).then(snap => {
      _catalogoIng = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => u.rol === "INGENIERO" && u.activo !== false)
        .sort((a, b) => (a.alias||"").localeCompare(b.alias||"", "es"));
      _poblarSelectIng();
    }).catch(() => {});
  } else {
    _poblarSelectIng();
  }
}

async function _enviarAsignacion() {
  const errEl = document.getElementById("reb-cart-error");
  const btn   = document.getElementById("reb-cart-enviar");
  errEl.style.display = "none";
  if (!_cartUid)      { errEl.textContent = "Selecciona un ingeniero destinatario."; errEl.style.display = "block"; return; }
  if (!_cart.length)  { errEl.textContent = "Agrega al menos un producto al carrito."; errEl.style.display = "block"; return; }
  btn.disabled = true; btn.textContent = "Enviando…";
  try {
    const { addDoc: _add } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const ahora   = Date.now();
    const hoyStr  = new Date().toISOString().slice(0,10);
    const items   = await Promise.all(_cart.map(async c => {
      // Leer stock actual del almacén para registrarlo
      const prodSnap = await getDoc(doc(db, "productos", c.prod.id));
      const stockAlmacen = prodSnap.exists() ? (prodSnap.data().stock ?? 0) : 0;
      return {
        productoId:         c.prod.id,
        nombre:             c.prod.nombre || "",
        codigoN10:          c.prod.codigoN10 || "",
        unidad:             c.prod.unidad || "",
        cantidadSolicitada: c.cantidad,
        cantidadSurtida:    c.cantidad,
        cantidadRecibida:   null,
        stockAlmacen,
        hayStock:           stockAlmacen >= c.cantidad,
      };
    }));
    await _add(collection(db, "solicitudes_reabasto"), {
      ingenieroUid:        _cartUid,
      ingenieroAlias:      _cartAlias,
      origen:              "DIRECTA",
      estado:              "PENDIENTE",
      items,
      fechaStr:            hoyStr,
      almacenistaAlias:    Sesion.alias,
      almacenistaUid:      Sesion.uid,
      notasAlmacenista:    "",
      tieneProductosSinStock: items.some(i => !i.hayStock),
      _ts:                 ahora,
      timestamp:           serverTimestamp(),
    });
    await logAudit("REABASTO_ASIGNACION_DIRECTA", {
      ingeniero: _cartAlias, items: items.length, por: Sesion.alias
    });
    window.toast?.(`Asignación enviada a ${resolverNombre(_cartAlias)||_cartAlias} — ${items.length} producto(s)`, "success");
    _cerrarAsignar();
  } catch(e) {
    errEl.textContent = "Error al enviar: " + e.message;
    errEl.style.display = "block";
  } finally {
    btn.disabled = false; btn.textContent = "Enviar asignación →";
  }
}

