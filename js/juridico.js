// ══════════════════════════════════════════════════════════════
// juridico.js — Seguimiento jurídico de cuentas críticas
// Modelo: clientes con diasMaxVencidos >= 30 o semaforoColor ROJO/NARANJA
// Colecciones: clientes (lectura), juridico_notas (escritura)
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, norm } from "./app.js";
import {
  collection, doc, query, where, orderBy, limit,
  onSnapshot, addDoc, updateDoc, getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getIngenieros } from "./erp-cache.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";

const fmtMXN   = v => Number(v || 0).toLocaleString("es-MX", { style:"currency", currency:"MXN" });
const fmtFecha = ts => ts
  ? new Date(typeof ts === "number" ? ts : (ts.toMillis?.() ?? ts))
      .toLocaleDateString("es-MX", { day:"2-digit", month:"short", year:"numeric" })
  : "—";

const SEMAFORO_COLOR = {
  ROJO:    "#DC2626",
  NARANJA: "#D97706",
  VERDE:   "#16A34A",
};

let _unsub     = null;
let _clientes  = [];
let _panelId   = null;
let _ings      = []; // aliases de ingenieros para el filtro

export const JuridicoModule = {
  mount(container) {
    cargarNombres();
    container.innerHTML = `
    <div class="mod-wrap">
      <div class="mod-topbar">
        <h2 class="mod-title">⚖️ Módulo Jurídico</h2>
        <div class="mod-actions">
          <select class="sel-sm" id="jur-filtro-ing">
            <option value="">Todos los ingenieros</option>
          </select>
          <select class="sel-sm" id="jur-filtro-semaforo">
            <option value="">Todos</option>
            <option value="ROJO">🔴 Crítico</option>
            <option value="NARANJA">🟠 En seguimiento</option>
          </select>
          <div style="position:relative;display:inline-block">
            <input class="sel-sm" type="text" id="jur-buscar" placeholder="Buscar cliente…" style="width:180px">
            <div id="jur-buscar-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
              background:var(--surface);border:1px solid var(--border);border-radius:6px;
              max-height:220px;overflow-y:auto;z-index:200;box-shadow:0 4px 16px #0002;margin-top:2px;min-width:200px"></div>
          </div>
        </div>
      </div>

      <!-- KPIs -->
      <div class="kpi-row" style="margin-bottom:16px">
        <div class="kpi-card" style="border-left-color:#DC2626">
          <div class="kpi-icon">🔴</div>
          <div class="kpi-val" id="jur-kpi-crit">–</div>
          <div class="kpi-label">Cuentas críticas</div>
        </div>
        <div class="kpi-card" style="border-left-color:#D97706">
          <div class="kpi-icon">🟠</div>
          <div class="kpi-val" id="jur-kpi-seg">–</div>
          <div class="kpi-label">En seguimiento</div>
        </div>
        <div class="kpi-card" style="border-left-color:#1D4ED8">
          <div class="kpi-icon">💰</div>
          <div class="kpi-val" id="jur-kpi-saldo">–</div>
          <div class="kpi-label">Cartera en riesgo</div>
        </div>
        <div class="kpi-card" style="border-left-color:#7C3AED">
          <div class="kpi-icon">📅</div>
          <div class="kpi-val" id="jur-kpi-dias">–</div>
          <div class="kpi-label">Días prom. vencidos</div>
        </div>
      </div>

      <!-- Tabla -->
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>
            <th>CLIENTE</th>
            <th>INGENIERO</th>
            <th>SALDO</th>
            <th>DÍAS VENCIDOS</th>
            <th>SEMÁFORO</th>
            <th>ACCIONES</th>
          </tr></thead>
          <tbody id="jur-tbody">
            <tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Panel lateral de detalle -->
      <div id="jur-panel" class="side-panel hidden" style="width:420px">
        <div class="side-panel-header">
          <h3 id="jur-panel-titulo">Detalle</h3>
          <button id="jur-panel-cerrar" class="btn-icon">✕</button>
        </div>
        <div id="jur-panel-body" style="padding:16px;overflow-y:auto;max-height:calc(100vh - 120px)"></div>
      </div>
    </div>`;

    _iniciar();
    _bindUI();
    getIngenieros().then(ings => {
      _ings = ings;
      const sel = document.getElementById("jur-filtro-ing");
      if (sel) sel.innerHTML = `<option value="">Todos los ingenieros</option>` +
        ings.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
    });
  },
  destroy() {
    _unsub?.();
    _unsub = null;
    _clientes = [];
    _panelId = null;
  },
};

// ── Datos ───────────────────────────────────────────────────────

function _iniciar() {
  _unsub?.();
  const q = query(
    collection(db, "clientes"),
    where("activo", "==", true),
    orderBy("diasMaxVencidos", "desc"),
    limit(300)
  );
  _unsub = onSnapshot(q, snap => {
    _clientes = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(c => (c.diasMaxVencidos || 0) >= 30 || c.semaforoColor === "ROJO" || c.semaforoColor === "NARANJA");
    _render();
  }, err => console.error("[Juridico]", err));
}

// ── Render ──────────────────────────────────────────────────────

function _semaforo(c) {
  if (c.semaforoColor) return c.semaforoColor;
  const d = c.diasMaxVencidos || 0;
  return d >= 90 ? "ROJO" : "NARANJA";
}

function _render() {
  const filtroIng  = document.getElementById("jur-filtro-ing")?.value  || "";
  const filtroSem  = document.getElementById("jur-filtro-semaforo")?.value || "";
  const filtroBusc = norm(document.getElementById("jur-buscar")?.value || "");

  const lista = _clientes.filter(c => {
    if (filtroIng  && (c.ingenieroAlias || "") !== filtroIng) return false;
    if (filtroSem  && _semaforo(c) !== filtroSem) return false;
    if (filtroBusc && !norm(c.nombre).includes(filtroBusc)) return false;
    return true;
  });

  // KPIs
  const criticos = lista.filter(c => _semaforo(c) === "ROJO").length;
  const naranjas = lista.filter(c => _semaforo(c) === "NARANJA").length;
  const saldoTotal = lista.reduce((s, c) => s + (c.saldoPendiente || 0), 0);
  const diasProm = lista.length
    ? Math.round(lista.reduce((s, c) => s + (c.diasMaxVencidos || 0), 0) / lista.length)
    : 0;

  document.getElementById("jur-kpi-crit").textContent  = criticos;
  document.getElementById("jur-kpi-seg").textContent   = naranjas;
  document.getElementById("jur-kpi-saldo").textContent = fmtMXN(saldoTotal);
  document.getElementById("jur-kpi-dias").textContent  = diasProm + "d";

  const tbody = document.getElementById("jur-tbody");
  if (!tbody) return;

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-sec)">
      Sin cuentas en seguimiento jurídico</td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(c => {
    const sem    = _semaforo(c);
    const color  = SEMAFORO_COLOR[sem] || "var(--text-sec)";
    const label  = sem === "ROJO" ? "🔴 Crítico" : sem === "NARANJA" ? "🟠 Seguimiento" : "⚪ Revisión";
    return `<tr data-cid="${esc(c.id)}">
      <td>
        <div style="font-weight:700">${esc(c.nombre || "—")}</div>
        <div style="font-size:11px;color:var(--text-sec)">${esc(c.email || c.rfc || "")}</div>
      </td>
      <td style="font-size:12px">${esc(resolverNombre(c.ingenieroAlias))}</td>
      <td style="font-weight:700;color:${color};text-align:right;font-variant-numeric:tabular-nums">
        ${fmtMXN(c.saldoPendiente || 0)}
      </td>
      <td style="text-align:center;font-weight:700;color:${color}">
        ${c.diasMaxVencidos || 0}d
      </td>
      <td><span style="background:${color}22;color:${color};padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700">
        ${label}
      </span></td>
      <td>
        <button class="btn-sm btn-ver-jur" data-id="${esc(c.id)}">Ver expediente</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".btn-ver-jur").forEach(btn =>
    btn.addEventListener("click", () => _abrirPanel(btn.dataset.id)));
}

// ── Panel lateral ────────────────────────────────────────────────

async function _abrirPanel(clienteId) {
  _panelId = clienteId;
  const c = _clientes.find(x => x.id === clienteId);
  if (!c) return;

  const panel = document.getElementById("jur-panel");
  const titulo = document.getElementById("jur-panel-titulo");
  const body   = document.getElementById("jur-panel-body");

  titulo.textContent = c.nombre || "Cliente";
  body.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-sec)">Cargando notas…</div>`;
  panel.classList.remove("hidden");

  // Cargar notas jurídicas
  const notasSnap = await getDocs(
    query(collection(db, "juridico_notas"),
      where("clienteId", "==", clienteId),
      orderBy("creadaEn", "desc"),
      limit(50)
    )
  );
  const notas = notasSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  const color = SEMAFORO_COLOR[c.semaforoColor] || "var(--text-sec)";

  body.innerHTML = `
    <!-- Resumen cliente -->
    <div style="background:var(--surface2);border-radius:8px;padding:12px;margin-bottom:16px">
      <div style="font-size:13px;font-weight:700;margin-bottom:4px">${esc(c.nombre)}</div>
      <div style="font-size:12px;color:var(--text-sec);margin-bottom:8px">${esc(resolverNombre(c.ingenieroAlias))}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div><div style="font-size:11px;color:var(--text-sec)">Saldo</div>
          <div style="font-weight:700;color:${color}">${fmtMXN(c.saldoPendiente || 0)}</div></div>
        <div><div style="font-size:11px;color:var(--text-sec)">Días vencidos</div>
          <div style="font-weight:700;color:${color}">${c.diasMaxVencidos || 0}d</div></div>
        <div><div style="font-size:11px;color:var(--text-sec)">Últ. pago</div>
          <div style="font-weight:700">${fmtFecha(c.ultimoPago)}</div></div>
      </div>
    </div>

    <!-- Acciones rápidas -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <button class="btn-primary" id="jur-btn-nota" style="flex:1;min-width:120px">📝 Añadir nota</button>
      <button class="btn-outline" id="jur-btn-promesa" style="flex:1;min-width:120px">🤝 Promesa de pago</button>
    </div>

    <!-- Historial de notas -->
    <div style="font-size:12px;font-weight:700;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
      Historial jurídico (${notas.length})
    </div>
    <div id="jur-notas-lista">
      ${notas.length === 0
        ? `<div style="text-align:center;padding:24px;color:var(--text-sec);font-size:13px">Sin notas registradas</div>`
        : notas.map(n => `
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <span style="font-size:11px;font-weight:700;color:${_tipoColor(n.tipo)}">${esc(_tipoLabel(n.tipo))}</span>
              <span style="font-size:10px;color:var(--text-sec)">${esc(n.autor || "—")} · ${fmtFecha(n.creadaEn?.toMillis?.() ?? n.creadaEn)}</span>
            </div>
            <div style="font-size:12px;color:var(--text-primary);line-height:1.5">${esc(n.texto || "")}</div>
            ${n.fechaCompromiso ? `<div style="font-size:11px;color:var(--text-sec);margin-top:4px">📅 Compromiso: ${fmtFecha(n.fechaCompromiso)}</div>` : ""}
            ${n.montoCompromiso ? `<div style="font-size:11px;color:var(--text-sec)">💰 Monto: ${fmtMXN(n.montoCompromiso)}</div>` : ""}
          </div>`).join("")
      }
    </div>
  `;

  document.getElementById("jur-btn-nota")?.addEventListener("click",    () => _agregarNota(clienteId, "NOTA"));
  document.getElementById("jur-btn-promesa")?.addEventListener("click", () => _agregarNota(clienteId, "PROMESA"));
}

function _tipoLabel(tipo) {
  return { NOTA:"Nota jurídica", PROMESA:"Promesa de pago", ACUERDO:"Acuerdo", RESOLUCION:"Resolución" }[tipo] || tipo;
}
function _tipoColor(tipo) {
  return { NOTA:"var(--text)", PROMESA:"#1D4ED8", ACUERDO:"#16A34A", RESOLUCION:"#7C3AED" }[tipo] || "var(--text)";
}

// ── Acciones ────────────────────────────────────────────────────

async function _agregarNota(clienteId, tipo) {
  const esPromesa = tipo === "PROMESA";
  const c = _clientes.find(x => x.id === clienteId);

  const texto = await window.promptModal({
    title:       esPromesa ? "Registrar promesa de pago" : "Añadir nota jurídica",
    label:       esPromesa ? "Descripción del acuerdo" : "Nota",
    placeholder: esPromesa ? "El cliente se comprometió a pagar…" : "Detalles del seguimiento…",
  });
  if (texto === null) return;
  if (!texto.trim()) { window.toast?.("La nota no puede estar vacía", "error"); return; }

  let fechaCompromiso = null;
  let montoCompromiso = null;

  if (esPromesa) {
    const fechaStr = await window.promptModal({
      title:       "Fecha de compromiso",
      label:       "Fecha (YYYY-MM-DD)",
      placeholder: new Date().toISOString().slice(0, 10),
    });
    if (fechaStr && fechaStr.trim()) {
      fechaCompromiso = new Date(fechaStr.trim()).getTime() || null;
    }
    const montoStr = await window.promptModal({
      title:       "Monto comprometido",
      label:       "Monto (solo números)",
      placeholder: "0.00",
    });
    montoCompromiso = parseFloat(montoStr || "0") || null;
  }

  try {
    await addDoc(collection(db, "juridico_notas"), {
      clienteId,
      clienteNombre: c?.nombre || "",
      tipo,
      texto:         texto.trim(),
      fechaCompromiso,
      montoCompromiso,
      autor:         Sesion.alias,
      creadaEn:      serverTimestamp(),
      _ts:           Date.now(),
    });
    window.toast?.("Nota registrada", "success");
    // Reabrir panel para refrescar historial
    _abrirPanel(clienteId);
  } catch (err) {
    window.toast?.("Error: " + err.message, "error");
  }
}

// ── Bind UI ──────────────────────────────────────────────────────

function _bindUI() {
  document.getElementById("jur-panel-cerrar")?.addEventListener("click", () => {
    document.getElementById("jur-panel")?.classList.add("hidden");
    _panelId = null;
  });
  document.getElementById("jur-filtro-ing")?.addEventListener("change", _render);
  document.getElementById("jur-filtro-semaforo")?.addEventListener("change", _render);
  let _buscTimer;
  const jurBuscar = document.getElementById("jur-buscar");
  const jurBuscarDd = document.getElementById("jur-buscar-dd");
  jurBuscar?.addEventListener("input", () => {
    clearTimeout(_buscTimer);
    _buscTimer = setTimeout(_render, 250);
    const q = norm(jurBuscar.value);
    if (q.length < 2 || !jurBuscarDd) { if (jurBuscarDd) jurBuscarDd.style.display = "none"; return; }
    const matches = _clientes
      .filter(c => norm(c.nombre).includes(q))
      .slice(0, 12);
    if (!matches.length) { jurBuscarDd.style.display = "none"; return; }
    jurBuscarDd.innerHTML = matches.map(c =>
      `<div class="jur-dd-item" data-nombre="${esc(c.nombre)}"
        style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);color:var(--text-primary)">
        ${esc(c.nombre)}
      </div>`).join("");
    jurBuscarDd.style.display = "block";
    jurBuscarDd.querySelectorAll(".jur-dd-item").forEach(el =>
      el.addEventListener("mousedown", ev => {
        ev.preventDefault();
        jurBuscar.value = el.dataset.nombre;
        jurBuscarDd.style.display = "none";
        _render();
      }));
  });
  jurBuscar?.addEventListener("blur",   () => setTimeout(() => { if (jurBuscarDd) jurBuscarDd.style.display = "none"; }, 150));
  jurBuscar?.addEventListener("keydown", e => { if (e.key === "Escape" && jurBuscarDd) jurBuscarDd.style.display = "none"; });
}
