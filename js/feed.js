// ══════════════════════════════════════════════════════════════
// feed.js — Feed global de actividades en tiempo real
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import {
  collection, query, orderBy, limit, where, onSnapshot, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#x27;"}[c]));

let _unsubs = [];
let _filtroTipo   = "TODOS";
let _filtroAlias  = "TODOS";
let _aliases = new Set();

export const FeedModule = {
  mount(container) {
    container.innerHTML = _html();
    // Limpiar badge de nav al entrar al feed
    const badge = document.getElementById("feed-badge");
    if (badge) { badge.textContent = "0"; badge.classList.add("hidden"); }
    _bindFiltros();
    _cargarIngenieros();
    _escucharFeed();
    return () => this.destroy();
  },
  destroy() {
    _unsubs.forEach(fn => fn && fn());
    _unsubs = [];
    _filtroTipo  = "TODOS";
    _filtroAlias = "TODOS";
    _aliases     = new Set();
    _ultimoSnap  = null;
  }
};

const TIPOS = ["TODOS","PEDIDO_CONFIRMADO","PEDIDO_ENTREGADO","PEDIDO_CANCELADO",
               "ABONO_REGISTRADO","REMISION_CREADA","JORNADA_INICIO","JORNADA_FIN","VISITA_REGISTRADA"];

const TIPO_LABEL = {
  TODOS:"Todos", PEDIDO_CONFIRMADO:"Pedidos", PEDIDO_ENTREGADO:"Entregados",
  PEDIDO_CANCELADO:"Cancelados", ABONO_REGISTRADO:"Abonos", REMISION_CREADA:"Remisiones",
  JORNADA_INICIO:"Inicio jornada", JORNADA_FIN:"Fin jornada", VISITA_REGISTRADA:"Visitas"
};

const EV_COLOR = {
  PEDIDO_CONFIRMADO:"#16A34A", PEDIDO_ENTREGADO:"#16A34A", PEDIDO_CANCELADO:"#DC2626",
  ABONO_REGISTRADO:"#2563EB",  REMISION_CREADA:"#7C3AED",  JORNADA_INICIO:"#D97706",
  JORNADA_FIN:"#6B7280",       VISITA_REGISTRADA:"#2563EB"
};
const EV_ICON = {
  PEDIDO_CONFIRMADO:"🛒", PEDIDO_ENTREGADO:"✅", PEDIDO_CANCELADO:"❌",
  ABONO_REGISTRADO:"💳",  REMISION_CREADA:"📄",  JORNADA_INICIO:"🚀",
  JORNADA_FIN:"🏁",       VISITA_REGISTRADA:"📍"
};
const EV_PILL_CLASS = {
  PEDIDO_CONFIRMADO:"pill-entg", PEDIDO_ENTREGADO:"pill-entg", PEDIDO_CANCELADO:"pill-venc",
  ABONO_REGISTRADO:"pill-conf",  REMISION_CREADA:"pill-ruta",  JORNADA_INICIO:"pill-ruta",
  JORNADA_FIN:"pill-off",        VISITA_REGISTRADA:"pill-conf"
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
    <!-- Filtros -->
    <div style="background:var(--surface);border-bottom:1px solid var(--border);padding:10px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0">
      <span style="font-size:11px;font-weight:700;color:var(--text-sec)">Tipo:</span>
      <div id="tipo-filters" style="display:flex;gap:5px;flex-wrap:wrap">
        ${TIPOS.map(t => {
          const c = EV_COLOR[t] || "";
          const style = (t !== "TODOS" && c) ? `border-color:${c};color:${c}` : "";
          return `<button class="filter-pill ${t==='TODOS'?'active':''}" data-tipo="${t}"
            onclick="FeedUI.setTipo('${t}')" ${style ? `style="${style}"` : ""}>
            ${TIPO_LABEL[t]}
          </button>`;}).join("")}
      </div>
      <div style="width:1px;height:18px;background:var(--border);margin:0 4px"></div>
      <span style="font-size:11px;font-weight:700;color:var(--text-sec)">Ingeniero:</span>
      <select id="alias-select" onchange="FeedUI.setAlias(this.value)"
        style="border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;color:var(--text-primary);background:var(--surface)">
        <option value="TODOS">Todos</option>
      </select>
      <div style="flex:1"></div>
      <span id="feed-last-ts" style="font-size:11px;color:var(--text-sec);margin-right:6px"></span>
      <span id="feed-count" style="font-size:11px;color:var(--text-sec)">– eventos</span>
    </div>

    <!-- Lista -->
    <div style="flex:1;overflow-y:auto;padding:14px 18px" id="feed-list">
      <div style="text-align:center;padding:24px;color:var(--text-sec);font-size:12px">Cargando feed…</div>
    </div>
  </div>`;
}

// ── Bind ──────────────────────────────────────────────────────
function _bindFiltros() {
  window.FeedUI = {
    setTipo(tipo) {
      _filtroTipo = tipo;
      document.querySelectorAll("[data-tipo]").forEach(b =>
        b.classList.toggle("active", b.dataset.tipo === tipo));
      _renderFeed(_ultimoSnap);
    },
    setAlias(alias) {
      _filtroAlias = alias;
      _renderFeed(_ultimoSnap);
    }
  };
}

// ── Ingenieros ────────────────────────────────────────────────
async function _cargarIngenieros() {
  try {
    const snap = await getDocs(query(
      collection(db, "usuarios"),
      where("rol", "in", ["INGENIERO", "RECUPERADOR"]),
      where("activo", "==", true)
    ));
    snap.forEach(d => {
      const alias = d.data().alias;
      if (alias) _aliases.add(alias);
    });
    _updateAliasSelect();
  } catch (e) {
    console.warn("[Feed] No se pudieron cargar ingenieros:", e);
  }
}

// ── Listener ──────────────────────────────────────────────────
let _ultimoSnap = null;

function _escucharFeed() {
  const q = query(
    collection(db, "log_actividades"),
    orderBy("timestamp", "desc"),
    limit(200)
  );

  const unsub = onSnapshot(q, snap => {
    _ultimoSnap = snap;

    // Recolectar aliases únicos
    snap.forEach(d => {
      const alias = d.data().alias;
      if (alias) _aliases.add(alias);
    });
    _updateAliasSelect();
    _renderFeed(snap);
  }, err => {
    console.error("[Feed]", err);
    window.toast?.("Error al cargar el feed. Verifica la conexión.", "error");
  });

  _unsubs.push(unsub);
}

function _renderFeed(snap) {
  if (!snap) return;
  const el = document.getElementById("feed-list");
  if (!el) return;

  let docs = snap.docs;

  // Filtrar por tipo
  if (_filtroTipo !== "TODOS") {
    docs = docs.filter(d => d.data().tipo === _filtroTipo);
  }
  // Filtrar por alias
  if (_filtroAlias !== "TODOS") {
    docs = docs.filter(d => d.data().alias === _filtroAlias);
  }

  // Contador
  const cntEl = document.getElementById("feed-count");
  if (cntEl) cntEl.textContent = `${docs.length} eventos`;
  const tsEl = document.getElementById("feed-last-ts");
  if (tsEl) {
    const now = new Date();
    tsEl.textContent = `Actualizado ${now.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}`;
  }

  if (docs.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚡</div>
        <div class="empty-state-title">Sin actividad para este filtro</div>
        <div class="empty-state-sub">Cambia el tipo o el ingeniero</div>
      </div>`;
    return;
  }

  el.innerHTML = docs.map(d => {
    const a   = d.data();
    const c   = EV_COLOR[a.tipo]      || "#6B7280";
    const ico = EV_ICON[a.tipo]       || "•";
    const pc  = EV_PILL_CLASS[a.tipo] || "pill-off";
    const ts  = _fmtTs(a.timestamp?.toDate?.() || new Date());
    const det = _detalle(a);

    return `
      <div class="feed-card" style="border-radius:10px;padding:12px 16px;border:1px solid var(--border);
        display:flex;gap:12px;align-items:center;margin-bottom:7px;cursor:pointer">
        <div style="width:36px;height:36px;border-radius:8px;background:${c}1A;
          display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${ico}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:var(--text-primary)">${esc(a.alias) || "–"} · ${_tipoLabel(a.tipo)}</div>
          <div style="font-size:11px;color:var(--text-sec);margin-top:2px">${det}</div>
        </div>
        <div style="font-size:10px;color:var(--text-sec);white-space:nowrap;text-align:right">
          <div>${ts.hora}</div>
          <div style="margin-top:1px">${ts.fecha}</div>
        </div>
        <span class="pill ${pc}">${TIPO_LABEL[a.tipo] || a.tipo}</span>
      </div>`;
  }).join("");
}

function _updateAliasSelect() {
  const sel = document.getElementById("alias-select");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="TODOS">Todos</option>` +
    [..._aliases].sort().map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  sel.value = _aliases.has(current) ? current : "TODOS";
}

// ── Helpers ───────────────────────────────────────────────────
function _tipoLabel(tipo) { return TIPO_LABEL[tipo] || tipo; }

function _detalle(a) {
  switch(a.tipo) {
    case "PEDIDO_CONFIRMADO": return `${a.folio || "–"} · ${a.cliente || "–"} · ${_fmt(a.total)}`;
    case "PEDIDO_ENTREGADO":  return `Entregó ${a.folio || "–"} a ${a.cliente || "–"}`;
    case "PEDIDO_CANCELADO":  return `Canceló ${a.folio || "–"} — ${a.motivo || "sin motivo"}`;
    case "ABONO_REGISTRADO":  return `${_fmt(a.monto)} en remisión ${a.remision || "–"} · ${a.formaPago || "–"}`;
    case "REMISION_CREADA":   return `${a.remision || "–"} · ${a.cliente || "–"} · ${_fmt(a.total)} · ${a.plazo || "–"}d`;
    case "JORNADA_INICIO":    return `Zona: ${a.zona || "–"} · GPS activo`;
    case "JORNADA_FIN":       return `Duración: ${a.duracion || "–"}`;
    case "VISITA_REGISTRADA": return `${a.cliente || "–"} · ${a.resultado || "–"}`;
    default: return a.descripcion || "–";
  }
}

function _fmt(n) {
  if (!n) return "–";
  return "$" + Number(n).toLocaleString("es-MX");
}

function _fmtTs(date) {
  const hora  = date.toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" });
  const fecha = date.toLocaleDateString("es-MX",  { day:"numeric", month:"short" });
  return { hora, fecha };
}

// ── CSS para filter pills (inyectado una vez) ─────────────────
const style = document.createElement("style");
style.textContent = `
  .feed-card { background: var(--surface); transition: background .12s; }
  .feed-card:hover { background: var(--surface-2); }
`;
if (!document.getElementById("feed-styles")) {
  style.id = "feed-styles";
  document.head.appendChild(style);
}
