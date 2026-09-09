// ══════════════════════════════════════════════════════════════
// asignaciones.js — Traspaso de clientes entre ingenieros
// Arquitectura: campo clientes/{id}.ingeniero = alias
// Log en colección: traspasos/{id}
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { esc, norm } from "./app.js";
import { Sesion } from "./auth.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, query, orderBy, onSnapshot, getDocs,
  doc, updateDoc, addDoc, serverTimestamp, limit, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Estado ─────────────────────────────────────────────────────
let _unsubClientes   = null;
let _unsubTraspasos  = null;
let _clientes        = [];
let _ingenieros      = [];   // aliases únicos de clientes (panel izq)
let _usuariosIng     = [];   // aliases rol=INGENIERO (dropdown destino)
let _selIngenieroOri = null;
let _seleccionados   = new Set();
let _tabActiva       = "asignar";
let _filtroClientes  = "";
let _busquedaGlobal  = "";   // Mejora 5: búsqueda global
let _histFiltroOri   = "";   // Mejora 4: filtro historial origen
let _histFiltroDest  = "";   // Mejora 4: filtro historial destino
let _histFiltroFecha = "";   // Mejora 4: filtro historial fecha
let _histExpandidos  = new Set(); // Mejora 4: filas expandidas

// Umbral días sin visita (Mejora 2)
const DIAS_SIN_VISITA = 30;

const fmt   = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fmtDt = ts => {
  if (!ts) return "—";
  try { return new Date(ts?.toDate?.() ?? ts).toLocaleDateString("es-MX",
    { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
};
const fmtDate = ts => {
  if (!ts) return "—";
  try { return new Date(ts?.toDate?.() ?? ts).toLocaleDateString("es-MX",
    { day: "numeric", month: "short", year: "numeric" }); }
  catch { return "—"; }
};

function _diasDesdeVisita(ultimaVisita) {
  if (!ultimaVisita) return null;
  try {
    const d = new Date(ultimaVisita?.toDate?.() ?? ultimaVisita);
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  } catch { return null; }
}

// ── Módulo exportado ──────────────────────────────────────────
export const AsignacionesModule = {
  mount(container) {
    container.innerHTML = _htmlShell();
    _bindTabs();
    _escucharClientes();
    return () => this.destroy();
  },
  destroy() {
    _unsubClientes?.();
    _unsubTraspasos?.();
    _unsubClientes = _unsubTraspasos = null;
    _clientes = []; _ingenieros = []; _usuariosIng = [];
    _selIngenieroOri = null; _seleccionados.clear();
    _tabActiva = "asignar"; _filtroClientes = "";
    _busquedaGlobal = ""; _histFiltroOri = "";
    _histFiltroDest = ""; _histFiltroFecha = "";
    _histExpandidos.clear();
  }
};

// ── Shell HTML ────────────────────────────────────────────────
function _htmlShell() {
  return `
  <div style="display:flex;flex-direction:column;height:100%;gap:0">

    <!-- Header + tabs -->
    <div style="background:var(--surface);border-bottom:1px solid var(--border);padding:14px 16px 0;flex-shrink:0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:1.1rem;font-weight:800;color:var(--text-primary)">🔄 Asignaciones</div>
          <div style="font-size:11px;color:var(--text-sec);margin-top:2px">
            Traspaso de clientes entre ingenieros con auditoría completa
          </div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <!-- Mejora 5: búsqueda global -->
          <div style="position:relative">
            <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--text-sec);font-size:14px">🔍</span>
            <input id="asig-busqueda-global" type="text" placeholder="Buscar cliente global…"
              oninput="AsigUI.buscarGlobal(this.value)"
              style="padding:6px 10px 6px 28px;border:1px solid var(--border);border-radius:8px;
                font-size:12px;background:var(--surface);color:var(--text-primary);width:200px">
          </div>
          <div id="asig-kpis" style="display:flex;gap:8px;flex-wrap:wrap"></div>
        </div>
      </div>
      <div style="display:flex;gap:0;border-bottom:1px solid var(--border)">
        <button class="asig-tab active" data-tab="asignar" onclick="AsigUI.setTab('asignar')"
          style="${_tabStyle(true)}">🔄 Reasignar clientes</button>
        <button class="asig-tab" data-tab="historial" onclick="AsigUI.setTab('historial')"
          style="${_tabStyle(false)}">📋 Historial de traspasos</button>
      </div>
    </div>

    <!-- Contenido -->
    <div id="asig-content" style="flex:1;overflow:hidden;display:flex;flex-direction:column"></div>

    <!-- Modal reasignar -->
    <div id="asig-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);
      z-index:1001;align-items:center;justify-content:center;padding:20px">
      <div style="background:var(--surface);border-radius:14px;width:520px;max-width:100%;
        max-height:90vh;overflow-y:auto;
        border:1px solid var(--border);box-shadow:0 8px 32px rgba(0,0,0,.22);padding:24px">
        <div id="asig-modal-body"></div>
      </div>
    </div>
  </div>`;
}

function _tabStyle(activa) {
  return `padding:8px 18px;border:none;background:transparent;cursor:pointer;font-size:13px;
    font-weight:${activa ? "700" : "500"};color:${activa ? "#1565C0" : "var(--text-sec)"};
    border-bottom:${activa ? "2px solid #1565C0" : "2px solid transparent"};
    margin-bottom:-1px;transition:all .15s`;
}

// ── Tabs ──────────────────────────────────────────────────────
function _bindTabs() {
  window.AsigUI = {
    setTab(tab) {
      _tabActiva = tab;
      document.querySelectorAll(".asig-tab").forEach(b => {
        const activa = b.dataset.tab === tab;
        b.style.fontWeight   = activa ? "700" : "500";
        b.style.color        = activa ? "#1565C0" : "var(--text-sec)";
        b.style.borderBottom = activa ? "2px solid #1565C0" : "2px solid transparent";
      });
      if (tab === "asignar")   _renderAsignar();
      if (tab === "historial") _renderHistorial();
    },
    seleccionarIngeniero(alias) { _seleccionarIngeniero(alias); },
    toggleCliente(id) {
      if (_seleccionados.has(id)) _seleccionados.delete(id);
      else _seleccionados.add(id);
      _renderListaClientes();
    },
    seleccionarTodos() {
      const lista = _selIngenieroOri === "__sin_asignar__"
        ? _clientes.filter(c => !c.ingeniero)
        : _clientesDeIngeniero(_selIngenieroOri);
      if (_seleccionados.size > 0 && _seleccionados.size === lista.length)
        _seleccionados.clear();
      else lista.forEach(c => _seleccionados.add(c.id));
      _renderListaClientes();
    },
    filtrarClientes(q) { _filtroClientes = norm(q); _renderListaClientes(); },
    buscarGlobal(q) {
      _busquedaGlobal = norm(q);
      if (_tabActiva === "asignar") _renderBusquedaGlobal();
    },
    abrirModalReasignar() { _abrirModalReasignar(); },
    cerrarModal() { document.getElementById("asig-modal").style.display = "none"; },
    confirmarTraspaso() { _confirmarTraspaso(); },
    // Historial
    filtrarHistorial() { _renderTablaHistorial(); },
    toggleExpandir(id) {
      if (_histExpandidos.has(id)) _histExpandidos.delete(id);
      else _histExpandidos.add(id);
      _renderTablaHistorial();
    },
    exportarHistorialExcel() { _exportarHistorialExcel(); },
  };
}

// ── Datos ─────────────────────────────────────────────────────
async function _cargarUsuariosIngenieros() {
  try {
    const snap = await getDocs(query(
      collection(db, "usuarios"),
      where("rol", "==", "INGENIERO")
    ));
    _usuariosIng = snap.docs
      .filter(d => d.data().activo !== false)
      .map(d => d.data().alias || d.data().email || d.id)
      .filter(Boolean)
      .sort();
  } catch { _usuariosIng = []; }
}

function _escucharClientes() {
  _cargarUsuariosIngenieros();
  cargarNombres();
  _unsubClientes = onSnapshot(
    query(collection(db, "clientes"), orderBy("nombre")),
    snap => {
      _clientes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _ingenieros = [...new Set(_clientes.map(c => c.ingeniero).filter(Boolean))].sort();
      _renderKPIs();
      if (_tabActiva === "asignar") {
        if (_busquedaGlobal) _renderBusquedaGlobal();
        else _renderAsignar();
      }
    },
    err => console.error("[Asignaciones] clientes:", err)
  );
}

function _clientesDeIngeniero(alias) {
  if (!alias) return [];
  const q = _filtroClientes;
  return _clientes.filter(c => {
    const esPropio     = c.ingeniero === alias;
    const esCompartido = c.compartido === true && (c.ingenierosCompartidos || []).includes(alias);
    if (!esPropio && !esCompartido) return false;
    return !q || norm(c.nombre).includes(q) ||
                 norm(c.zona).includes(q) ||
                 norm(c.ciudad).includes(q);
  });
}

// ── KPIs ──────────────────────────────────────────────────────
function _renderKPIs() {
  const el = document.getElementById("asig-kpis");
  if (!el) return;
  const sinAsignar = _clientes.filter(c => !c.ingeniero).length;
  const sinVisita  = _clientes.filter(c => {
    const d = _diasDesdeVisita(c.ultimaVisita);
    return d !== null && d > DIAS_SIN_VISITA;
  }).length;
  const kpi = (label, val, color) =>
    `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;
      padding:8px 14px;text-align:center">
      <div style="font-size:18px;font-weight:800;color:${color}">${val}</div>
      <div style="font-size:10px;color:var(--text-sec);font-weight:600">${label}</div>
    </div>`;
  el.innerHTML =
    kpi("CLIENTES", _clientes.length, "var(--text-primary)") +
    kpi("INGENIEROS", _ingenieros.length, "#1565C0") +
    kpi("SIN ASIGNAR", sinAsignar, sinAsignar > 0 ? "#DC2626" : "#16A34A") +
    (sinVisita > 0 ? kpi(`+${DIAS_SIN_VISITA}d SIN VISITA`, sinVisita, "#D97706") : "");
}

// ── Mejora 5: Búsqueda global de clientes ─────────────────────
function _renderBusquedaGlobal() {
  const content = document.getElementById("asig-content");
  if (!content) return;

  if (!_busquedaGlobal) { _renderAsignar(); return; }

  const resultados = _clientes.filter(c =>
    norm(c.nombre).includes(_busquedaGlobal) ||
    norm(c.zona).includes(_busquedaGlobal) ||
    norm(c.ciudad).includes(_busquedaGlobal) ||
    norm(c.ingeniero).includes(_busquedaGlobal)
  );

  content.innerHTML = `
  <div style="padding:16px;overflow-y:auto;flex:1">
    <div style="font-size:12px;font-weight:700;color:var(--text-sec);margin-bottom:12px">
      Resultados para "<span style="color:var(--text-primary)">${esc(_busquedaGlobal)}</span>"
      — ${resultados.length} cliente${resultados.length !== 1 ? "s" : ""}
    </div>
    ${!resultados.length
      ? `<div style="padding:40px;text-align:center;color:var(--text-sec);font-size:13px">Sin resultados.</div>`
      : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">
          ${resultados.map(c => {
            const dias = _diasDesdeVisita(c.ultimaVisita);
            const sinVisita = dias !== null && dias > DIAS_SIN_VISITA;
            const saldo = Number(c.saldo) || 0;
            return `<div style="background:var(--surface);border:1px solid var(--border);
                border-radius:10px;padding:12px">
              <div style="font-size:12px;font-weight:700;color:var(--text-primary)">
                ${esc(c.nombre || "—")}
              </div>
              <div style="font-size:11px;color:var(--text-sec);margin-top:2px">
                ${esc(c.zona || "")}${c.ciudad ? ` · ${esc(c.ciudad)}` : ""}
              </div>
              <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                <span style="font-size:10px;background:#EFF6FF;color:#1565C0;padding:2px 8px;
                  border-radius:9px;font-weight:600">
                  👤 ${esc(resolverNombre(c.ingeniero) || c.ingeniero || "Sin asignar")}
                </span>
                ${saldo > 0 ? `<span style="font-size:10px;background:rgba(220,38,38,0.12);
                  color:#DC2626;padding:2px 7px;border-radius:9px;font-weight:600">
                  ${fmt.format(saldo)}</span>` : ""}
                ${sinVisita ? `<span style="font-size:10px;background:#FEF3C7;color:#D97706;
                  padding:2px 7px;border-radius:9px;font-weight:700">⚠️ ${dias}d sin visita</span>` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>`}
  </div>`;
}

// ── Vista Reasignar ───────────────────────────────────────────
function _renderAsignar() {
  const content = document.getElementById("asig-content");
  if (!content) return;

  // Mejora 1: calcular saldos por ingeniero
  const saldoPorIngeniero = {};
  const maxSaldo = Math.max(1, ..._ingenieros.map(alias => {
    const s = _clientes
      .filter(c => c.ingeniero === alias || (c.compartido && (c.ingenierosCompartidos||[]).includes(alias)))
      .reduce((acc, c) => acc + (Number(c.saldo) || 0), 0);
    saldoPorIngeniero[alias] = s;
    return s;
  }));

  content.innerHTML = `
  <div style="display:flex;height:100%;overflow:hidden">
    <!-- Panel izquierdo: ingenieros -->
    <div style="width:260px;flex-shrink:0;border-right:1px solid var(--border);overflow-y:auto;padding:12px">
      <div style="font-size:10px;font-weight:800;color:var(--text-sec);letter-spacing:.06em;
        text-transform:uppercase;margin-bottom:8px">Ingenieros</div>
      ${_ingenieros.map(alias => {
        const clientes = _clientes.filter(c =>
          c.ingeniero === alias ||
          (c.compartido === true && (c.ingenierosCompartidos||[]).includes(alias))
        );
        const count  = clientes.length;
        const saldo  = saldoPorIngeniero[alias] || 0;
        const pct    = Math.round((saldo / maxSaldo) * 100);
        const activo = alias === _selIngenieroOri;
        const nombre = resolverNombre(alias);
        return `<div onclick="AsigUI.seleccionarIngeniero('${esc(alias)}')"
          style="padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:6px;
            background:${activo ? "#EFF6FF" : "transparent"};
            border:1px solid ${activo ? "#BFDBFE" : "transparent"};transition:all .1s"
          onmouseover="this.style.background='${activo?"#EFF6FF":"var(--surface-2)"}'"
          onmouseout="this.style.background='${activo ? "#EFF6FF" : "transparent"}'">
          <div style="font-size:12px;font-weight:${activo?"800":"600"};color:${activo?"#1565C0":"var(--text-primary)"}">
            ${esc(nombre)}
          </div>
          ${nombre !== alias ? `<div style="font-size:10px;color:var(--text-sec);margin-top:1px">@${esc(alias)}</div>` : ""}
          <div style="font-size:11px;color:var(--text-sec);margin-top:3px">
            ${count} cliente${count!==1?"s":""}
            ${saldo > 0 ? `· <span style="color:#DC2626;font-weight:700">${fmt.format(saldo)}</span>` : ""}
          </div>
          ${saldo > 0 ? `
          <div style="margin-top:6px;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:#1565C0;border-radius:2px;transition:width .3s"></div>
          </div>` : ""}
        </div>`;
      }).join("")}
      ${_clientes.filter(c => !c.ingeniero).length > 0
        ? `<div onclick="AsigUI.seleccionarIngeniero('__sin_asignar__')"
            style="padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:4px;
              background:${_selIngenieroOri==='__sin_asignar__'?"#FEF2F2":"transparent"};
              border:1px solid ${_selIngenieroOri==='__sin_asignar__'?"#FECACA":"transparent"}">
            <div style="font-size:12px;font-weight:600;color:#DC2626">⚠️ Sin asignar</div>
            <div style="font-size:11px;color:var(--text-sec)">
              ${_clientes.filter(c=>!c.ingeniero).length} clientes
            </div>
          </div>`
        : ""}
    </div>

    <!-- Panel derecho: clientes del ingeniero seleccionado -->
    <div style="flex:1;overflow:hidden;display:flex;flex-direction:column">
      <div id="asig-lista-header" style="padding:12px 16px;border-bottom:1px solid var(--border);
        flex-shrink:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap"></div>
      <div id="asig-lista-clientes" style="flex:1;overflow-y:auto;padding:12px 16px"></div>
    </div>
  </div>`;

  _renderListaClientes();
}

function _seleccionarIngeniero(alias) {
  _selIngenieroOri = alias;
  _seleccionados.clear();
  _filtroClientes = "";
  _renderAsignar();
}

function _renderListaClientes() {
  const header = document.getElementById("asig-lista-header");
  const lista  = document.getElementById("asig-lista-clientes");
  if (!header || !lista) return;

  if (!_selIngenieroOri) {
    header.innerHTML = `<span style="font-size:13px;color:var(--text-sec)">
      ← Selecciona un ingeniero para ver sus clientes</span>`;
    lista.innerHTML = "";
    return;
  }

  const clientes = _selIngenieroOri === "__sin_asignar__"
    ? _clientes.filter(c => !c.ingeniero && (
        !_filtroClientes ||
        norm(c.nombre).includes(_filtroClientes) ||
        norm(c.zona).includes(_filtroClientes)
      ))
    : _clientesDeIngeniero(_selIngenieroOri);

  const label = _selIngenieroOri === "__sin_asignar__"
    ? "Sin asignar"
    : (resolverNombre(_selIngenieroOri) || _selIngenieroOri);
  const nSel = _seleccionados.size;

  header.innerHTML = `
    <div style="font-size:13px;font-weight:700;color:var(--text-primary)">
      ${esc(label)} — ${clientes.length} cliente${clientes.length!==1?"s":""}
    </div>
    <input type="text" placeholder="Filtrar…" value="${esc(_filtroClientes)}"
      oninput="AsigUI.filtrarClientes(this.value)"
      style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;
        font-size:12px;background:var(--surface);color:var(--text-primary);width:180px">
    <button onclick="AsigUI.seleccionarTodos()"
      style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;
        background:transparent;font-size:11px;cursor:pointer;color:var(--text-sec)">
      ${nSel === clientes.length && clientes.length > 0 ? "Deselect. todos" : "Sel. todos"}
    </button>
    ${nSel > 0
      ? `<button onclick="AsigUI.abrirModalReasignar()"
          style="padding:6px 16px;border:none;border-radius:6px;background:#1565C0;
            color:#fff;font-size:12px;font-weight:700;cursor:pointer;margin-left:auto">
          🔄 Reasignar ${nSel} cliente${nSel!==1?"s":""}
        </button>`
      : ""}`;

  if (!clientes.length) {
    lista.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-sec);font-size:13px">
      Sin clientes para este filtro.</div>`;
    return;
  }

  lista.innerHTML = `
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">
    ${clientes.map(c => {
      const sel   = _seleccionados.has(c.id);
      const saldo = Number(c.saldo) || 0;
      // Mejora 2: días sin visita
      const dias     = _diasDesdeVisita(c.ultimaVisita);
      const sinVisita = dias !== null && dias > DIAS_SIN_VISITA;
      return `<div onclick="AsigUI.toggleCliente('${esc(c.id)}')"
        style="background:${sel?"rgba(37,99,235,0.12)":"var(--surface)"};
          border:2px solid ${sel?"#2563EB":"var(--border)"};
          border-radius:10px;padding:12px;cursor:pointer;transition:all .1s">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <input type="checkbox" ${sel?"checked":""} style="margin-top:3px;pointer-events:none"
            onclick="event.preventDefault()">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:700;color:var(--text-primary);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.nombre||"—")}</div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:2px">
              ${esc(c.zona||"")}${c.ciudad?` · ${esc(c.ciudad)}`:""}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">
          ${c.segmento
            ? `<span style="font-size:10px;background:rgba(37,99,235,0.15);color:var(--blue,#2563EB);padding:2px 7px;
                border-radius:9px;font-weight:600">${esc(c.segmento)}</span>`
            : ""}
          ${saldo > 0
            ? `<span style="font-size:10px;background:rgba(220,38,38,0.12);color:#DC2626;padding:2px 7px;
                border-radius:9px;font-weight:600">${fmt.format(saldo)}</span>`
            : ""}
          ${c.estadoLegal && c.estadoLegal !== "Al corriente"
            ? `<span style="font-size:10px;background:rgba(217,119,6,0.15);color:#D97706;padding:2px 7px;
                border-radius:9px;font-weight:600">${esc(c.estadoLegal)}</span>`
            : ""}
          ${sinVisita
            ? `<span style="font-size:10px;background:#FEF3C7;color:#D97706;padding:2px 7px;
                border-radius:9px;font-weight:700" title="Última visita: ${fmtDate(c.ultimaVisita)}">
                ⚠️ ${dias}d sin visita</span>`
            : (dias !== null ? `<span style="font-size:10px;color:var(--text-sec);padding:2px 0"
                title="Última visita: ${fmtDate(c.ultimaVisita)}">🏠 hace ${dias}d</span>` : "")}
        </div>
      </div>`;
    }).join("")}
  </div>`;
}

// ── Modal Reasignar ───────────────────────────────────────────
function _abrirModalReasignar() {
  if (_seleccionados.size === 0) { window.toast?.("Selecciona al menos un cliente.", "warn"); return; }
  const modal = document.getElementById("asig-modal");
  const body  = document.getElementById("asig-modal-body");
  if (!modal || !body) return;

  const fusionados = [...new Set([
    ..._usuariosIng,
    ..._ingenieros.filter(a => a !== "__sin_asignar__")
  ])].sort();
  const optsIng = fusionados
    .filter(a => a !== _selIngenieroOri)
    .map(a => `<option value="${esc(a)}">${esc(resolverNombre(a) || a)}</option>`).join("");
  const razones = ["Cambio de ruta", "Ausencia de ingeniero", "Redistribución de zona",
                   "Solicitud del cliente", "Reorganización territorial", "Otra"];

  // Mejora 3: preview de clientes seleccionados
  const clientesSeleccionados = _clientes.filter(c => _seleccionados.has(c.id));
  const previewClientes = clientesSeleccionados.slice(0, 8);
  const excedente = clientesSeleccionados.length - previewClientes.length;

  // Mejora 6: distribución antes/después (calcular al seleccionar destino)
  const origenLabel = _selIngenieroOri === "__sin_asignar__" ? "Sin asignar" :
    (resolverNombre(_selIngenieroOri) || _selIngenieroOri);
  const countOrigen = _selIngenieroOri === "__sin_asignar__"
    ? _clientes.filter(c => !c.ingeniero).length
    : _clientesDeIngeniero(_selIngenieroOri).length;

  body.innerHTML = `
    <div style="font-size:16px;font-weight:800;color:var(--text-primary);margin-bottom:16px">
      🔄 Reasignar ${_seleccionados.size} cliente${_seleccionados.size!==1?"s":""}
    </div>

    <!-- Mejora 3: preview de clientes -->
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;
      padding:10px 14px;margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:8px;
        text-transform:uppercase;letter-spacing:.04em">Clientes a traspasar</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${previewClientes.map(c => `
          <span style="font-size:11px;background:var(--surface);border:1px solid var(--border);
            padding:3px 10px;border-radius:20px;color:var(--text-primary)">
            ${esc(c.nombre || c.id)}
          </span>`).join("")}
        ${excedente > 0
          ? `<span style="font-size:11px;background:var(--surface-2);border:1px solid var(--border);
              padding:3px 10px;border-radius:20px;color:var(--text-sec);font-weight:700">
              +${excedente} más…</span>`
          : ""}
      </div>
    </div>

    <div style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">
        Ingeniero destino *
      </div>
      <select id="asig-destino" onchange="AsigUI._actualizarDistribucion()"
        style="width:100%;padding:8px 10px;border:1px solid var(--border);
          border-radius:6px;font-size:13px;background:var(--surface);color:var(--text-primary)">
        <option value="">— Seleccionar —</option>
        ${optsIng}
      </select>
    </div>

    <!-- Mejora 6: distribución antes/después -->
    <div id="asig-distribucion" style="background:var(--surface-2);border:1px solid var(--border);
      border-radius:8px;padding:10px 14px;margin-bottom:16px;display:none">
      <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:10px;
        text-transform:uppercase;letter-spacing:.04em">Distribución tras el traspaso</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <div style="font-size:11px;color:var(--text-sec);margin-bottom:4px">
            <span style="color:#D97706;font-weight:700">Origen</span> — ${esc(origenLabel)}
          </div>
          <div id="asig-dist-origen" style="font-size:13px;font-weight:800;color:var(--text-primary)">
            ${countOrigen} → <span id="asig-dist-ori-post">—</span>
          </div>
          <div style="margin-top:4px;height:6px;background:var(--border);border-radius:3px">
            <div id="asig-dist-bar-ori" style="height:100%;background:#D97706;border-radius:3px;width:100%;transition:width .3s"></div>
          </div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-sec);margin-bottom:4px">
            <span style="color:#1565C0;font-weight:700">Destino</span> — <span id="asig-dist-dest-label">—</span>
          </div>
          <div id="asig-dist-destino" style="font-size:13px;font-weight:800;color:var(--text-primary)">
            <span id="asig-dist-dest-pre">—</span> → <span id="asig-dist-dest-post">—</span>
          </div>
          <div style="margin-top:4px;height:6px;background:var(--border);border-radius:3px">
            <div id="asig-dist-bar-dest" style="height:100%;background:#1565C0;border-radius:3px;width:0%;transition:width .3s"></div>
          </div>
        </div>
      </div>
    </div>

    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px">
        Razón del traspaso *
      </div>
      <select id="asig-razon-sel" onchange="document.getElementById('asig-razon-txt').style.display=this.value==='Otra'?'block':'none'"
        style="width:100%;padding:8px 10px;border:1px solid var(--border);
          border-radius:6px;font-size:13px;background:var(--surface);color:var(--text-primary);margin-bottom:6px">
        <option value="">— Seleccionar —</option>
        ${razones.map(r => `<option value="${r}">${r}</option>`).join("")}
      </select>
      <textarea id="asig-razon-txt" rows="2" placeholder="Describe la razón…"
        style="display:none;width:100%;padding:8px 10px;border:1px solid var(--border);
          border-radius:6px;font-size:12px;background:var(--surface);color:var(--text-primary);
          box-sizing:border-box;resize:vertical"></textarea>
    </div>

    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button onclick="AsigUI.cerrarModal()"
        style="padding:9px 20px;border:1px solid var(--border);border-radius:6px;
          background:transparent;color:var(--text-sec);font-size:13px;cursor:pointer">
        Cancelar
      </button>
      <button id="asig-btn-confirmar" onclick="AsigUI.confirmarTraspaso()"
        style="padding:9px 24px;border:none;border-radius:6px;
          background:#1565C0;color:#fff;font-size:13px;font-weight:700;cursor:pointer">
        ✅ Confirmar traspaso
      </button>
    </div>`;

  // Mejora 6: vincular función de distribución al namespace global
  window.AsigUI._actualizarDistribucion = () => {
    const destAlias = document.getElementById("asig-destino")?.value;
    if (!destAlias) { document.getElementById("asig-distribucion").style.display = "none"; return; }

    const distDiv = document.getElementById("asig-distribucion");
    if (distDiv) distDiv.style.display = "block";

    const nMover    = _seleccionados.size;
    const oriPost   = countOrigen - nMover;
    const destPre   = _clientes.filter(c => c.ingeniero === destAlias ||
      (c.compartido && (c.ingenierosCompartidos||[]).includes(destAlias))).length;
    const destPost  = destPre + nMover;
    const maxVal    = Math.max(countOrigen, destPost, 1);
    const destLabel = resolverNombre(destAlias) || destAlias;

    const el = id => document.getElementById(id);
    if (el("asig-dist-ori-post"))    el("asig-dist-ori-post").textContent  = oriPost;
    if (el("asig-dist-dest-label"))  el("asig-dist-dest-label").textContent = esc(destLabel);
    if (el("asig-dist-dest-pre"))    el("asig-dist-dest-pre").textContent  = destPre;
    if (el("asig-dist-dest-post"))   el("asig-dist-dest-post").textContent = destPost;
    if (el("asig-dist-bar-ori"))     el("asig-dist-bar-ori").style.width   = Math.round((oriPost/maxVal)*100) + "%";
    if (el("asig-dist-bar-dest"))    el("asig-dist-bar-dest").style.width  = Math.round((destPost/maxVal)*100) + "%";
  };

  modal.style.display = "flex";
}

async function _confirmarTraspaso() {
  const destino  = document.getElementById("asig-destino")?.value?.trim();
  const razonSel = document.getElementById("asig-razon-sel")?.value;
  const razonTxt = document.getElementById("asig-razon-txt")?.value?.trim();
  const razon    = razonSel === "Otra" ? razonTxt : razonSel;

  if (!destino) { window.toast?.("Selecciona el ingeniero destino.", "warn"); return; }
  if (!razon)   { window.toast?.("Indica la razón del traspaso.", "warn"); return; }

  const btn = document.getElementById("asig-btn-confirmar");
  if (btn) { btn.disabled = true; btn.textContent = "Procesando…"; }

  const clienteIds = [..._seleccionados];
  const origen = _selIngenieroOri === "__sin_asignar__" ? null : _selIngenieroOri;

  try {
    for (const id of clienteIds) {
      await updateDoc(doc(db, "clientes", id), {
        ingeniero:         destino,
        ingenieroAnterior: origen,
        traspasoEn:        serverTimestamp(),
        traspasadoPor:     Sesion.alias ?? "web",
      });
    }

    document.getElementById("asig-modal").style.display = "none";
    _seleccionados.clear();
    _filtroClientes = "";

    window.toast?.(
      `✅ ${clienteIds.length} cliente${clienteIds.length!==1?"s":""} traspasado${clienteIds.length!==1?"s":""} a ${resolverNombre(destino)||destino}.`,
      "success"
    );

    addDoc(collection(db, "traspasos"), {
      fecha:            serverTimestamp(),
      realizadoPor:     Sesion.alias ?? "web",
      realizadoPorUid:  Sesion.uid ?? null,
      ingenieroOrigen:  origen,
      ingenieroDestino: destino,
      clienteIds,
      clienteNombres:   _clientes.filter(c => clienteIds.includes(c.id)).map(c => c.nombre || c.id),
      cantidadClientes: clienteIds.length,
      razon,
      tipo: clienteIds.length === 1 ? "individual" : "masivo",
    }).catch(e => console.warn("[Asignaciones] Log traspaso:", e.message));

  } catch(e) {
    window.toast?.("Error en traspaso: " + e.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "✅ Confirmar traspaso"; }
  }
}

// ── Historial de traspasos ────────────────────────────────────
let _historialData = [];

function _renderHistorial() {
  const content = document.getElementById("asig-content");
  if (!content) return;

  // Opciones de ingenieros para filtros
  const optsIngs = [...new Set(
    _clientes.map(c => c.ingeniero).filter(Boolean)
  )].sort().map(a =>
    `<option value="${esc(a)}">${esc(resolverNombre(a) || a)}</option>`
  ).join("");

  content.innerHTML = `
  <div style="padding:16px;height:100%;overflow-y:auto;box-sizing:border-box">
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">

      <!-- Controles del historial -->
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);
        display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:700;color:var(--text-primary)">Historial de traspasos</span>
        <span style="font-size:11px;color:var(--text-sec)" id="asig-hist-count"></span>
        <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="asig-hist-ori" onchange="AsigUI.filtrarHistorial()"
            style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;
              font-size:11px;background:var(--surface);color:var(--text-primary)">
            <option value="">Cualquier origen</option>
            ${optsIngs}
          </select>
          <select id="asig-hist-dest" onchange="AsigUI.filtrarHistorial()"
            style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;
              font-size:11px;background:var(--surface);color:var(--text-primary)">
            <option value="">Cualquier destino</option>
            ${optsIngs}
          </select>
          <input type="date" id="asig-hist-fecha" onchange="AsigUI.filtrarHistorial()"
            style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;
              font-size:11px;background:var(--surface);color:var(--text-primary)">
          <button onclick="AsigUI.exportarHistorialExcel()"
            style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;
              background:transparent;font-size:11px;cursor:pointer;color:var(--text-sec);
              display:flex;align-items:center;gap:4px">
            📥 Excel
          </button>
        </div>
      </div>

      <div id="asig-hist-body" style="overflow-x:auto">
        <div style="padding:20px;text-align:center;color:var(--text-sec);font-size:13px">Cargando…</div>
      </div>
    </div>
  </div>`;

  _cargarHistorial();
}

async function _cargarHistorial() {
  const body = document.getElementById("asig-hist-body");
  if (!body) return;

  _unsubTraspasos?.();
  _unsubTraspasos = onSnapshot(
    query(collection(db, "traspasos"), orderBy("fecha", "desc"), limit(300)),
    snap => {
      _historialData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _renderTablaHistorial();
    },
    err => {
      console.error("[Asignaciones] historial:", err);
      if (body) body.innerHTML = `<div style="padding:32px;text-align:center;color:#DC2626;font-size:13px">
        Error al cargar historial: ${esc(err.message)}</div>`;
    }
  );
}

function _renderTablaHistorial() {
  const body  = document.getElementById("asig-hist-body");
  const count = document.getElementById("asig-hist-count");
  if (!body) return;

  // Leer filtros
  const fOri   = document.getElementById("asig-hist-ori")?.value   || "";
  const fDest  = document.getElementById("asig-hist-dest")?.value  || "";
  const fFecha = document.getElementById("asig-hist-fecha")?.value || "";

  let traspasos = _historialData;
  if (fOri)   traspasos = traspasos.filter(t => (t.ingenieroOrigen||"") === fOri);
  if (fDest)  traspasos = traspasos.filter(t => (t.ingenieroDestino||"") === fDest);
  if (fFecha) {
    const d0 = new Date(fFecha + "T00:00:00");
    const d1 = new Date(fFecha + "T23:59:59");
    traspasos = traspasos.filter(t => {
      try {
        const d = new Date(t.fecha?.toDate?.() ?? t.fecha);
        return d >= d0 && d <= d1;
      } catch { return false; }
    });
  }

  if (count) count.textContent = `${traspasos.length} registro${traspasos.length!==1?"s":""}`;

  if (!traspasos.length) {
    body.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-sec);font-size:13px">
      Sin traspasos para este filtro.</div>`;
    return;
  }

  body.innerHTML = `
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead>
      <tr style="background:var(--surface-2);border-bottom:1px solid var(--border)">
        <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec);white-space:nowrap">Fecha</th>
        <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec)">Por</th>
        <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec)">Origen</th>
        <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec)">Destino</th>
        <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-sec)">#</th>
        <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-sec)">Razón</th>
        <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-sec)">Tipo</th>
        <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-sec)">Clientes</th>
      </tr>
    </thead>
    <tbody>
      ${traspasos.map((t, i) => {
        const expandido = _histExpandidos.has(t.id);
        const nombres   = t.clienteNombres || t.clienteIds || [];
        return `
        <tr style="border-bottom:1px solid var(--border);${i%2===1?"background:var(--surface-2)":""}">
          <td style="padding:10px 14px;color:var(--text-sec);white-space:nowrap">${fmtDt(t.fecha)}</td>
          <td style="padding:10px 14px;font-weight:600;color:var(--text-primary)">${esc(t.realizadoPor||"—")}</td>
          <td style="padding:10px 14px;color:#D97706">
            ${esc(resolverNombre(t.ingenieroOrigen) || t.ingenieroOrigen || "Sin asignar")}
          </td>
          <td style="padding:10px 14px;color:var(--blue,#2563EB);font-weight:700">
            ${esc(resolverNombre(t.ingenieroDestino) || t.ingenieroDestino || "—")}
          </td>
          <td style="padding:10px 14px;text-align:center">
            <span style="font-size:13px;font-weight:800;color:var(--text-primary)">${t.cantidadClientes||nombres.length||0}</span>
          </td>
          <td style="padding:10px 14px;color:var(--text-sec);max-width:180px;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
            title="${esc(t.razon||"")}">${esc(t.razon||"—")}</td>
          <td style="padding:10px 14px;text-align:center">
            <span style="font-size:10px;padding:2px 8px;border-radius:9px;font-weight:700;
              background:${t.tipo==="masivo"?"#EDE9FE":"#ECFDF5"};
              color:${t.tipo==="masivo"?"#7C3AED":"#15803D"}">
              ${t.tipo||"individual"}
            </span>
          </td>
          <td style="padding:10px 14px;text-align:center">
            ${nombres.length > 0
              ? `<button onclick="AsigUI.toggleExpandir('${esc(t.id)}')"
                  style="padding:3px 8px;border:1px solid var(--border);border-radius:5px;
                    background:transparent;font-size:10px;cursor:pointer;color:var(--text-sec)">
                  ${expandido ? "▲ Ocultar" : "▼ Ver"}
                </button>`
              : "—"}
          </td>
        </tr>
        ${expandido && nombres.length > 0 ? `
        <tr style="border-bottom:1px solid var(--border);background:${i%2===1?"var(--surface-2)":"var(--surface)"}">
          <td colspan="8" style="padding:8px 14px 12px 48px">
            <div style="display:flex;flex-wrap:wrap;gap:5px">
              ${nombres.map(n => `
                <span style="font-size:11px;background:var(--surface-2);border:1px solid var(--border);
                  padding:2px 8px;border-radius:12px;color:var(--text-primary)">${esc(n)}</span>
              `).join("")}
            </div>
          </td>
        </tr>` : ""}`;
      }).join("")}
    </tbody>
  </table>`;
}

// ── Excel export historial ─────────────────────────────────────
function _exportarHistorialExcel() {
  try {
    if (typeof XLSX === "undefined") {
      window.toast?.("Librería Excel no disponible.", "error"); return;
    }
    const fOri   = document.getElementById("asig-hist-ori")?.value  || "";
    const fDest  = document.getElementById("asig-hist-dest")?.value || "";
    const fFecha = document.getElementById("asig-hist-fecha")?.value || "";

    let datos = _historialData;
    if (fOri)   datos = datos.filter(t => (t.ingenieroOrigen||"")  === fOri);
    if (fDest)  datos = datos.filter(t => (t.ingenieroDestino||"") === fDest);
    if (fFecha) {
      const d0 = new Date(fFecha + "T00:00:00");
      const d1 = new Date(fFecha + "T23:59:59");
      datos = datos.filter(t => {
        try { const d = new Date(t.fecha?.toDate?.() ?? t.fecha); return d >= d0 && d <= d1; }
        catch { return false; }
      });
    }

    const rows = datos.map(t => ({
      "Fecha":     fmtDt(t.fecha),
      "Realizado por": t.realizadoPor || "—",
      "Origen":    resolverNombre(t.ingenieroOrigen) || t.ingenieroOrigen || "Sin asignar",
      "Destino":   resolverNombre(t.ingenieroDestino) || t.ingenieroDestino || "—",
      "# Clientes": t.cantidadClientes || t.clienteIds?.length || 0,
      "Clientes":  (t.clienteNombres || t.clienteIds || []).join(", "),
      "Razón":     t.razon || "—",
      "Tipo":      t.tipo || "individual",
    }));

    const ws  = XLSX.utils.json_to_sheet(rows);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Historial");
    XLSX.writeFile(wb, `traspasos_${new Date().toISOString().slice(0,10)}.xlsx`);
    window.toast?.("Excel generado correctamente.", "success");
  } catch(e) {
    window.toast?.("Error al exportar: " + e.message, "error");
  }
}
