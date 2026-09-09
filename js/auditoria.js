// ══════════════════════════════════════════════════════════════
// auditoria.js — Panel de auditoría y trazabilidad completa
// Fuentes: audit_log (cambios críticos) + log_actividades (operaciones)
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, norm } from "./app.js";
import {
  collection, query, where, orderBy, limit,
  onSnapshot, getDocs, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _unsub = null;
let _rows  = [];
let _ings  = [];

const fmtFecha = ts => {
  if (!ts) return "—";
  const ms = typeof ts === "number" ? ts : ts.toMillis?.() ?? ts;
  return new Date(ms).toLocaleString("es-MX", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
};
const fmtDay = ts => {
  const d = new Date(typeof ts === "number" ? ts : 0);
  return d.toLocaleDateString("es-MX", { day:"2-digit", month:"short" });
};

// ── Tipos de evento ───────────────────────────────────────────
const TIPOS = {
  // Auditoría crítica
  PRECIO_EDITADO:         { icon: "💲", sev: "alta",  label: "Precio editado"         },
  DESCUENTO_APROBADO:     { icon: "🏷️", sev: "alta",  label: "Pedido autorizado"      },
  CLIENTE_DESBLOQUEADO:   { icon: "🔓", sev: "alta",  label: "Cliente desbloqueado"   },
  CLIENTE_BLOQUEADO:      { icon: "🔒", sev: "media", label: "Cliente bloqueado"       },
  DEVOLUCION_APROBADA:    { icon: "↩️", sev: "alta",  label: "Devolución aprobada"    },
  ANTICIPO_APROBADO:      { icon: "💵", sev: "alta",  label: "Anticipo aprobado"      },
  USUARIO_CREADO:         { icon: "👤", sev: "media", label: "Usuario creado"         },
  USUARIO_MODIFICADO:     { icon: "✏️", sev: "media", label: "Usuario modificado"     },
  ROL_CAMBIADO:           { icon: "🔑", sev: "alta",  label: "Rol cambiado"           },
  CONFIG_MODIFICADA:      { icon: "⚙️", sev: "media", label: "Configuración modificada"},
  PEDIDO_CANCELADO:       { icon: "❌", sev: "media", label: "Pedido rechazado"       },
  PEDIDO_APROBADO:        { icon: "✅", sev: "alta",  label: "Pedido aprobado"        },
  PEDIDO_RECHAZADO:       { icon: "🚫", sev: "alta",  label: "Pedido rechazado"       },
  PEDIDO_INFO_REQUERIDA:  { icon: "💬", sev: "media", label: "Info solicitada"        },
  // Almacén
  STOCK_ENTRADA:          { icon: "📥", sev: "media", label: "Entrada de stock"       },
  STOCK_SALIDA:           { icon: "📤", sev: "media", label: "Salida de stock"        },
  AJUSTE_INVENTARIO:      { icon: "🔁", sev: "alta",  label: "Ajuste inventario"      },
  // Operaciones normales
  PEDIDO_CONFIRMADO:      { icon: "🛒", sev: "baja",  label: "Pedido confirmado"      },
  PEDIDO_ENTREGADO:       { icon: "✅", sev: "baja",  label: "Pedido entregado"       },
  REMISION_CREADA:        { icon: "📄", sev: "baja",  label: "Remisión creada"        },
  ABONO_REGISTRADO:       { icon: "💳", sev: "baja",  label: "Abono registrado"       },
  ABONO_CONCILIADO:       { icon: "✔️", sev: "baja",  label: "Abono conciliado"       },
  JORNADA_INICIO:         { icon: "🚀", sev: "baja",  label: "Jornada iniciada"       },
  JORNADA_FIN:            { icon: "🏁", sev: "baja",  label: "Jornada terminada"      },
  VISITA_REGISTRADA:      { icon: "📍", sev: "baja",  label: "Visita registrada"      },
  PROSPECTO_CREADO:       { icon: "🎯", sev: "baja",  label: "Prospecto creado"       },
  PROSPECTO_CONVERTIDO:   { icon: "🏆", sev: "media", label: "Prospecto convertido"   },
};

const SEV_CLS = { alta: "badge-red", media: "badge-amber", baja: "badge-gray" };
const FUENTES = [
  { id: "audit",       label: "🔴 Cambios críticos (audit_log)"    },
  { id: "actividades", label: "📋 Actividades generales"            },
  { id: "ambas",       label: "📊 Todas las fuentes"               },
];

export const AuditoriaModule = {
  mount(container) {
    if (!_puedeVer()) {
      container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-sec)">
        Acceso restringido a administradores.</div>`;
      return;
    }
    container.innerHTML = _html();
    document.getElementById("aud-body").innerHTML = window.skeleton?.(5, 6) ?? "";
    _cargarIngenieros().then(() => _bindUI());
    _escuchar();
    return () => this.destroy();
  },
  destroy() {
    _unsub?.();  _unsub  = null;
    _unsubA?.(); _unsubA = null;
    _unsubB?.(); _unsubB = null;
    _rows = []; _rowsRaw = [];
    _mapaAmbasA = {}; _mapaAmbasB = {};
  }
};

function _puedeVer() {
  return Sesion.esSuperAdmin?.() || ["GERENTE","ADMINISTRADOR"].includes(Sesion.rol);
}

async function _cargarIngenieros() {
  try {
    // Sin orderBy para evitar índice compuesto; sort en JS
    const snap = await getDocs(query(
      collection(db, "usuarios"),
      where("activo", "==", true)
    ));
    _ings = snap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .filter(d => d.alias)
      .sort((a, b) => (a.alias || "").localeCompare(b.alias || ""));
    const sel = document.getElementById("aud-ingeniero");
    if (sel) {
      sel.innerHTML = `<option value="">Todos los usuarios</option>` +
        _ings.map(i => `<option value="${esc(i.alias)}">${esc(i.alias)} (${esc(i.rol || "–")})</option>`).join("");
    }
  } catch(e) { console.error("[Auditoria] cargarIngenieros:", e); }
}

// ── HTML ─────────────────────────────────────────────────────
function _html() {
  const hoy   = new Date().toISOString().slice(0, 10);
  const hace7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  return `
  <div class="mod-wrap">
    <div class="mod-topbar">
      <h2 class="mod-title">🔍 Panel de Auditoría</h2>
      <div class="mod-actions">
        <button id="aud-export-xlsx" style="padding:7px 12px;background:var(--accent);color:#fff;
          border:none;border-radius:6px;cursor:pointer;font-size:13px">⬇️ Excel</button>
      </div>
    </div>

    <!-- Filtros -->
    <div class="aud-filters" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;
      padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px">
      <select class="sel-sm" id="aud-fuente">
        ${FUENTES.map(f => `<option value="${f.id}">${f.label}</option>`).join("")}
      </select>
      <select class="sel-sm" id="aud-sev">
        <option value="">Todas las severidades</option>
        <option value="alta">🔴 Alta</option>
        <option value="media">🟡 Media</option>
        <option value="baja">⚪ Baja</option>
      </select>
      <select class="sel-sm" id="aud-ingeniero" style="min-width:160px">
        <option value="">Todos los ingenieros</option>
      </select>
      <input type="text" class="sel-sm" id="aud-usuario"
        placeholder="Filtrar por alias…" style="width:140px">
      <span style="font-size:11px;color:var(--text-sec);align-self:center">Desde</span>
      <input type="date" class="sel-sm" id="aud-desde" value="${hace7}">
      <span style="font-size:11px;color:var(--text-sec);align-self:center">Hasta</span>
      <input type="date" class="sel-sm" id="aud-hasta" value="${hoy}">
      <button class="btn-primary" id="aud-filtrar">Filtrar</button>
    </div>

    <!-- KPIs -->
    <div class="kpi-row" style="margin-bottom:14px">
      <div class="kpi-card" style="border-left-color:#DC2626">
        <div class="kpi-icon">🔴</div>
        <div class="kpi-val" id="aud-kpi-alta">–</div>
        <div class="kpi-label">Sev. alta</div>
      </div>
      <div class="kpi-card" style="border-left-color:#D97706">
        <div class="kpi-icon">🟡</div>
        <div class="kpi-val" id="aud-kpi-media">–</div>
        <div class="kpi-label">Sev. media</div>
      </div>
      <div class="kpi-card" style="border-left-color:#6B7280">
        <div class="kpi-icon">📋</div>
        <div class="kpi-val" id="aud-kpi-total">–</div>
        <div class="kpi-label">Total eventos</div>
      </div>
      <div class="kpi-card" style="border-left-color:#6366F1">
        <div class="kpi-icon">📦</div>
        <div class="kpi-val" id="aud-kpi-stock">–</div>
        <div class="kpi-label">Mov. almacén</div>
      </div>
      <div class="kpi-card" style="border-left-color:#10B981">
        <div class="kpi-icon">👥</div>
        <div class="kpi-val" id="aud-kpi-users">–</div>
        <div class="kpi-label">Usuarios activos</div>
      </div>
    </div>

    <!-- Gráfica de barras por día -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;
      padding:14px 18px;margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;color:var(--text-sec);
        text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">
        Eventos por día
      </div>
      <div id="aud-chart" style="overflow-x:auto"></div>
    </div>

    <!-- Tabla -->
    <div style="overflow-x:auto">
      <table class="data-table" id="aud-table">
        <thead>
          <tr>
            <th>FECHA / HORA</th><th>TIPO</th><th>SEV.</th>
            <th>USUARIO</th><th>DESCRIPCIÓN</th><th>REFERENCIA</th>
          </tr>
        </thead>
        <tbody id="aud-body">
          <tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
        </tbody>
      </table>
    </div>
  </div>`;
}

// ── Bind ─────────────────────────────────────────────────────
function _bindUI() {
  document.getElementById("aud-filtrar")?.addEventListener("click", _escuchar);
  document.getElementById("aud-export-xlsx")?.addEventListener("click", _exportarExcel);
  document.getElementById("aud-ingeniero")?.addEventListener("change", _aplicarFiltrosCliente);
  document.getElementById("aud-sev")?.addEventListener("change", _aplicarFiltrosCliente);
  document.getElementById("aud-usuario")?.addEventListener("input", _aplicarFiltrosCliente);
}

// ── Consulta Firestore ────────────────────────────────────────
let _rowsRaw = [];
let _unsubA = null;
let _unsubB = null;
let _mapaAmbasA = {};
let _mapaAmbasB = {};

function _mergeAmbas() {
  _rowsRaw = [
    ...Object.values(_mapaAmbasA),
    ...Object.values(_mapaAmbasB),
  ].sort((a, b) => (b._ts || 0) - (a._ts || 0));
  _aplicarFiltrosCliente();
}

async function _escuchar() {
  _unsub?.();  _unsub  = null;
  _unsubA?.(); _unsubA = null;
  _unsubB?.(); _unsubB = null;
  _mapaAmbasA = {}; _mapaAmbasB = {};

  const fuente  = document.getElementById("aud-fuente")?.value || "audit";
  const desde   = document.getElementById("aud-desde")?.value;
  const hasta   = document.getElementById("aud-hasta")?.value;

  const [dy,dm,dd] = (desde || "").split("-").map(Number);
  const [hy,hm,hd] = (hasta  || "").split("-").map(Number);
  const desdeTs = desde ? new Date(dy,dm-1,dd,0,0,0).getTime()    : Date.now() - 7*86400000;
  const hastaTs = hasta ? new Date(hy,hm-1,hd,23,59,59).getTime() : Date.now();

  const tbody = document.getElementById("aud-body");
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:24px;text-align:center">Cargando…</td></tr>`;

  // Sin orderBy — Firestore no requiere índice compuesto; sort en JS
  const _buildQ = col => query(
    collection(db, col),
    where("_ts", ">=", desdeTs),
    where("_ts", "<=", hastaTs),
    limit(500)
  );

  const _onErr = err => {
    console.error("[Auditoria]", err);
    if (err.code === "failed-precondition") return; // índice pendiente, silencioso
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="color:#DC2626;padding:16px;text-align:center">
      Error: ${esc(err.message)}</td></tr>`;
  };

  const _prevSize = _rowsRaw.length;

  if (fuente === "ambas") {
    _unsubA = onSnapshot(_buildQ("audit_log"), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === "removed") delete _mapaAmbasA[ch.doc.id];
        else _mapaAmbasA[ch.doc.id] = { id: ch.doc.id, _fuente: "audit_log", ...ch.doc.data() };
      });
      _alertarNuevos(snap, _prevSize);
      _mergeAmbas();
    }, _onErr);
    _unsubB = onSnapshot(_buildQ("log_actividades"), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === "removed") delete _mapaAmbasB[ch.doc.id];
        else _mapaAmbasB[ch.doc.id] = { id: ch.doc.id, _fuente: "log_actividades", ...ch.doc.data() };
      });
      _mergeAmbas();
    }, _onErr);
  } else {
    const col = fuente === "actividades" ? "log_actividades" : "audit_log";
    _unsub = onSnapshot(_buildQ(col), snap => {
      _rowsRaw = snap.docs
        .map(d => ({ id: d.id, _fuente: col, ...d.data() }))
        .sort((a, b) => (b._ts || 0) - (a._ts || 0));
      _alertarNuevos(snap, _prevSize);
      _aplicarFiltrosCliente();
    }, _onErr);
  }
}

function _alertarNuevos(snap, prevSize) {
  if (prevSize === 0) return; // carga inicial, no alertar
  snap.docChanges().forEach(ch => {
    if (ch.type !== "added") return;
    const d = ch.doc.data();
    const cfg = TIPOS[d.tipo];
    if (cfg?.sev === "alta") {
      window.toast?.(`🔴 Evento crítico: ${cfg.label} — ${d.alias || d.quien || ""}`, "error");
    }
  });
}

function _aplicarFiltrosCliente() {
  let rows = [..._rowsRaw];

  const uFilter  = norm(document.getElementById("aud-usuario")?.value.trim() ?? "");
  const ingFilter = document.getElementById("aud-ingeniero")?.value || "";
  const sevFiltro = document.getElementById("aud-sev")?.value;

  if (uFilter)   rows = rows.filter(r => norm(r.alias || r.usuario || r.quien || "").includes(uFilter));
  if (ingFilter) rows = rows.filter(r => (r.alias || r.ingenieroAlias || r.quien || "") === ingFilter);
  if (sevFiltro) rows = rows.filter(r => (TIPOS[r.tipo]?.sev || "baja") === sevFiltro);

  _rows = rows;
  _renderTabla(rows);
  _renderChart(rows);
}

// ── Gráfica de barras por día ─────────────────────────────────
function _renderChart(rows) {
  const chartEl = document.getElementById("aud-chart");
  if (!chartEl) return;

  if (!rows.length) { chartEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-sec);font-size:12px">Sin datos para graficar</div>`; return; }

  // Agrupar por día
  const byDay = {};
  rows.forEach(r => {
    if (!r._ts) return;
    const day = new Date(r._ts).toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = { total: 0, alta: 0, media: 0, baja: 0 };
    byDay[day].total++;
    const sev = TIPOS[r.tipo]?.sev || "baja";
    byDay[day][sev]++;
  });

  const days  = Object.keys(byDay).sort();
  const maxV  = Math.max(...days.map(d => byDay[d].total), 1);
  const W     = Math.max(days.length * 48, 300);
  const H     = 120;
  const barW  = 32;
  const gap   = 48;
  const padL  = 8;
  const padB  = 28;
  const plotH = H - padB - 10;

  const bars = days.map((day, i) => {
    const { total, alta, media } = byDay[day];
    const h = Math.max(4, Math.round((total / maxV) * plotH));
    const x = padL + i * gap;
    const y = H - padB - h;
    const fill = alta > 0 ? "#EF4444" : media > 0 ? "#F59E0B" : "#6366F1";
    const label = fmtDay(new Date(day + "T12:00:00").getTime());
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="4" fill="${fill}" opacity=".85"/>
      <text x="${x + barW/2}" y="${y - 4}" text-anchor="middle" font-size="10" fill="currentColor">${total}</text>
      <text x="${x + barW/2}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#9CA3AF">${label}</text>`;
  }).join("");

  // Línea base
  chartEl.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block;min-width:${W}px;overflow:visible">
      <line x1="${padL}" y1="${H - padB}" x2="${padL + days.length * gap}" y2="${H - padB}"
        stroke="var(--border)" stroke-width="1"/>
      ${bars}
    </svg>`;
}

// ── Render tabla ──────────────────────────────────────────────
function _renderTabla(rows) {
  const alta  = rows.filter(r => (TIPOS[r.tipo]?.sev || "baja") === "alta").length;
  const media = rows.filter(r => (TIPOS[r.tipo]?.sev || "baja") === "media").length;
  const stock = rows.filter(r => ["STOCK_ENTRADA","STOCK_SALIDA","AJUSTE_INVENTARIO"].includes(r.tipo)).length;
  const usuarios = new Set(rows.map(r => r.alias || r.usuario || r.quien || "").filter(Boolean)).size;

  const el = id => document.getElementById(id);
  if (el("aud-kpi-alta"))  el("aud-kpi-alta").textContent  = alta;
  if (el("aud-kpi-media")) el("aud-kpi-media").textContent = media;
  if (el("aud-kpi-total")) el("aud-kpi-total").textContent = rows.length;
  if (el("aud-kpi-stock")) el("aud-kpi-stock").textContent = stock;
  if (el("aud-kpi-users")) el("aud-kpi-users").textContent = usuarios;

  const tbody = document.getElementById("aud-body");
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-sec)">
      Sin eventos en el período seleccionado</td></tr>`;
    _renderChart([]);
    return;
  }

  tbody.innerHTML = rows.map((r, idx) => {
    const cfg  = TIPOS[r.tipo] || { icon: "•", sev: "baja", label: r.tipo || "Evento" };
    const ts   = r._ts || r.timestamp?.toMillis?.() || 0;
    const desc = _descripcion(r);
    const ref  = r.folio || r.pedidoId || r.remision || r.clienteNombre || r.productoNombre || r.productoId || "–";
    const rowBg = cfg.sev === "alta" ? "background:rgba(220,38,38,.04)"
                : cfg.sev === "media" ? "background:rgba(245,158,11,.02)" : "";

    return `<tr style="${rowBg};cursor:pointer" onclick="window._audDetalle(${idx})" title="Ver detalle">
      <td style="white-space:nowrap;font-size:12px;color:var(--text-sec)">${fmtFecha(ts)}</td>
      <td>
        <span style="font-size:14px">${cfg.icon}</span>
        <span style="font-size:11px;font-weight:700;margin-left:4px">${esc(cfg.label)}</span>
      </td>
      <td><span class="badge ${SEV_CLS[cfg.sev] || "badge-gray"}">${cfg.sev.toUpperCase()}</span></td>
      <td style="font-weight:600">${esc(r.alias || r.usuario || r.quien || r.quienRegistro || "–")}</td>
      <td style="font-size:12px;max-width:280px">${esc(desc)}</td>
      <td style="font-size:11px;color:var(--text-sec);white-space:nowrap">${esc(String(ref))}</td>
    </tr>`;
  }).join("");
}

function _descripcion(r) {
  switch (r.tipo) {
    case "PRECIO_EDITADO":
      return `${r.productoNombre || r.producto || "–"}: ${r.precioAntes ?? "?"} → ${r.precioDespues ?? "?"}`;
    case "DESCUENTO_APROBADO":
      return `${r.folio || "–"} · ${r.clienteNombre || "–"} · ${new Intl.NumberFormat("es-MX",{style:"currency",currency:"MXN"}).format(r.total||0)}`;
    case "CLIENTE_DESBLOQUEADO":
      return `${r.clienteNombre || "–"} desbloqueado${r.horas ? " por " + r.horas + "h" : ""}`;
    case "DEVOLUCION_APROBADA":
      return `${r.folio || "–"} · $${Number(r.monto || 0).toLocaleString("es-MX")}`;
    case "ANTICIPO_APROBADO":
      return `${r.alias || "–"} · $${Number(r.monto || 0).toLocaleString("es-MX")}`;
    case "ROL_CAMBIADO":
      return `${r.usuario || "–"}: ${r.rolAntes || "?"} → ${r.rolDespues || "?"}`;
    case "PEDIDO_CONFIRMADO":
      return `${r.folio || "–"} · $${Number(r.total || 0).toLocaleString("es-MX")} · ${r.clienteNombre || "–"}`;
    case "PEDIDO_CANCELADO":
      return `${r.folio || "–"} rechazado · ${r.motivoRechazo || "–"}`;
    case "PEDIDO_APROBADO":
      return `${r.folio || "–"} · ${r.clienteNombre || "–"} · $${Number(r.total || 0).toLocaleString("es-MX")}`;
    case "PEDIDO_RECHAZADO":
      return `${r.folio || "–"} · ${r.motivo || r.motivoRechazo || "Sin motivo"}`;
    case "PEDIDO_INFO_REQUERIDA":
      return `${r.folio || "–"} · se solicitó información adicional`;
    case "ABONO_REGISTRADO":
      return `$${Number(r.monto || 0).toLocaleString("es-MX")} → ${r.remision || r.remisionId || "–"}`;
    case "ABONO_CONCILIADO":
      return `Remisión ${r.remisionId || "–"} · abono #${r.abonoIdx ?? "?"}`;
    case "STOCK_ENTRADA":
      return `${r.productoNombre || r.productoId || "–"}: +${r.cantidad} unidades → stock ${r.stockDespues}`;
    case "STOCK_SALIDA":
      return `${r.productoNombre || r.productoId || "–"}: -${r.cantidad} unidades → stock ${r.stockDespues}`;
    case "AJUSTE_INVENTARIO":
      return `${r.productoNombre || r.productoId || "–"}: ${r.stockAntes} → ${r.stockDespues} · ${r.motivo || "–"}`;
    case "PROSPECTO_CREADO":
      return `${r.nombre || "–"} · ${r.empresa || "–"}`;
    case "PROSPECTO_CONVERTIDO":
      return `${r.nombre || "–"} convertido a cliente`;
    default:
      return r.descripcion || r.detalle || r.notas || "–";
  }
}

// ── Modal de detalle ──────────────────────────────────────────
window._audDetalle = function(idx) {
  const r = _rows[idx];
  if (!r) return;
  const cfg = TIPOS[r.tipo] || { icon: "•", sev: "baja", label: r.tipo || "Evento" };
  const ts  = r._ts || r.timestamp?.toMillis?.() || 0;

  // Campos técnicos omitidos del detalle visual
  const omit = new Set(["id", "_fuente"]);
  const campos = Object.entries(r)
    .filter(([k]) => !omit.has(k))
    .sort(([a], [b]) => a.localeCompare(b));

  const filas = campos.map(([k, v]) => {
    let val = v;
    if (k === "_ts" && typeof v === "number") val = fmtFecha(v);
    else if (v && typeof v === "object" && typeof v.toMillis === "function") val = fmtFecha(v.toMillis());
    else if (typeof v === "object") val = JSON.stringify(v, null, 2);
    return `<tr>
      <td style="font-size:11px;color:var(--text-sec);white-space:nowrap;padding:5px 8px;vertical-align:top">${esc(k)}</td>
      <td style="font-size:12px;padding:5px 8px;word-break:break-all"><pre style="margin:0;font-family:monospace;white-space:pre-wrap">${esc(String(val ?? "–"))}</pre></td>
    </tr>`;
  }).join("");

  const html = `
    <div style="font-size:12px;color:var(--text-sec);margin-bottom:8px">
      ${cfg.icon} <strong>${esc(cfg.label)}</strong> ·
      <span class="badge ${SEV_CLS[cfg.sev] || "badge-gray"}">${cfg.sev.toUpperCase()}</span> ·
      ${fmtFecha(ts)} · fuente: <code>${esc(r._fuente || "–")}</code>
    </div>
    <div style="overflow-x:auto;max-height:60vh;overflow-y:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="font-size:11px;text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Campo</th>
          <th style="font-size:11px;text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Valor</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`;

  window.modal?.({
    title: `Detalle de evento — ${esc(r.folio || r.id || "")}`,
    message: html,
    confirmLabel: "Cerrar",
    danger: false,
  });
};

// ── Exportar Excel ────────────────────────────────────────────
function _exportarExcel() {
  if (!_rows.length) { window.toast?.("Sin datos para exportar", "warning"); return; }
  const headers = ["Fecha/Hora","Tipo","Severidad","Fuente","Usuario","Descripción","Referencia"];
  const data = _rows.map(r => {
    const cfg = TIPOS[r.tipo] || { label: r.tipo || "–", sev: "baja" };
    const ts  = r._ts || r.timestamp?.toMillis?.() || 0;
    return [
      fmtFecha(ts), cfg.label, cfg.sev, r._fuente || "–",
      r.alias || r.usuario || r.quien || r.quienRegistro || "–",
      _descripcion(r),
      r.folio || r.pedidoId || r.remision || r.clienteNombre || r.productoId || "–"
    ];
  });
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Auditoría");
  XLSX.writeFile(wb, `N10-auditoria-${new Date().toISOString().slice(0,10)}.xlsx`);
  window.toast?.("Exportando Excel…", "info");
}
