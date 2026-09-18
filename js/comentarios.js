// ══════════════════════════════════════════════════════════════
// comentarios.js — Bitácora de comentarios y notas por cliente
// ══════════════════════════════════════════════════════════════

import { db }    from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, norm } from "./app.js";
import {
  collection, query, orderBy, limit, where,
  onSnapshot, addDoc, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _unsubs        = [];
let _filtroAlias   = "TODOS";
let _filtroTipo    = "TODOS";
let _busqueda      = "";
let _docsComents   = [];
let _docsLog       = [];
let _clientesCache = [];

const TIPO_CFG = {
  COMENTARIO_MANUAL:     { color:"#2563EB", icon:"💬", label:"Comentario"            },
  VISITA_REGISTRADA:     { color:"#16A34A", icon:"📍", label:"Visita registrada"     },
  VISITA_SOSPECHOSA:     { color:"#DC2626", icon:"🚨", label:"Visita sospechosa"     },
  ACUERDO_CONGELAMIENTO: { color:"#7C3AED", icon:"❄️",  label:"Acuerdo congelamiento" },
  PROMESA_PAGO:          { color:"#D97706", icon:"📅", label:"Promesa de pago"       },
  CONGELAMIENTO:         { color:"#7C3AED", icon:"❄️",  label:"Congelamiento"        },
  VISITA:                { color:"#16A34A", icon:"📍", label:"Visita"               },
  EDICION:               { color:"#6B7280", icon:"✏️",  label:"Edición"             },
};
const CAT_COLOR = {
  SEGUIMIENTO:"#2563EB", ACUERDO:"#7C3AED", RIESGO:"#DC2626",
  INFORMACION:"#0891B2", ALERTA:"#D97706"
};
const _tipoCfg = t => TIPO_CFG[t] ?? { color:"#9CA3AF", icon:"📝", label: t || "Otro" };
const _catColor = c => CAT_COLOR[c] ?? "#6B7280";

const _puedeVer = () =>
  Sesion.esSuperAdmin?.() ||
  ["GERENTE","GERENTE_ZONA","ADMINISTRADOR","MESA_CONTROL"].includes(Sesion.rol);

const _puedeEscribir = () =>
  Sesion.esSuperAdmin?.() ||
  ["GERENTE","GERENTE_ZONA","ADMINISTRADOR","MESA_CONTROL"].includes(Sesion.rol);

const _fmtTs = ts => {
  if (!ts) return "—";
  const d = ts?.toDate?.() ?? (typeof ts === "number" ? new Date(ts) : null);
  if (!d || isNaN(d)) return "—";
  return d.toLocaleString("es-MX", {
    day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"
  });
};

// ── Módulo ────────────────────────────────────────────────────
export const ComentariosModule = {
  mount(container) {
    if (!_puedeVer()) {
      container.innerHTML = `<div style="padding:60px;text-align:center;color:#9CA3AF">🔒 Sin acceso a este módulo.</div>`;
      return;
    }
    _filtroAlias = "TODOS"; _filtroTipo = "TODOS"; _busqueda = "";
    _docsComents = []; _docsLog = [];
    container.innerHTML = _html();
    _bindUI(container);
    _escuchar();
    _cargarClientes(container);
  },
  destroy() {
    _unsubs.forEach(fn => fn?.());
    _unsubs = [];
    delete window.ComentariosUI;
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  const tipoOpts = [
    ["TODOS","Todos"],
    ...Object.entries(TIPO_CFG).map(([k,v]) => [k, `${v.icon} ${v.label}`])
  ].map(([k,l]) => `<option value="${k}">${l}</option>`).join("");

  return `
  <style>
    .com-kpi { background:var(--surface);border:1px solid var(--border);
      border-radius:10px;padding:12px 16px }
    .com-kpi-val { font-size:22px;font-weight:800;font-variant-numeric:tabular-nums }
    .com-kpi-lbl { font-size:10px;font-weight:600;color:#9CA3AF;
      text-transform:uppercase;letter-spacing:.05em;margin-top:2px }
    .com-card { background:var(--surface);border:1px solid var(--border);
      border-radius:10px;padding:12px 16px;margin-bottom:8px }
    .com-input { width:100%;padding:7px 10px;border:1px solid var(--border);
      border-radius:7px;background:var(--surface);color:var(--text-primary);
      font-size:12px;box-sizing:border-box }
    .com-dd-item { padding:8px 12px;cursor:pointer;font-size:12px;
      border-bottom:1px solid var(--border);color:var(--text-primary) }
    .com-dd-item:hover { background:var(--surface) }
  </style>

  <div style="display:flex;height:100%;gap:0;overflow:hidden">

    <!-- Columna principal -->
    <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0">

      <!-- Toolbar -->
      <div style="padding:12px 0 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0">
        <div style="flex:1;min-width:180px;position:relative">
          <input id="com-search" type="search" placeholder="🔍 Buscar cliente, alias o nota…"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);
              border-radius:7px;background:var(--surface);color:var(--text-primary);
              font-size:13px;box-sizing:border-box">
          <div id="com-search-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
            background:var(--surface);border:1px solid var(--border);border-radius:8px;
            max-height:200px;overflow-y:auto;z-index:20;
            box-shadow:0 8px 24px rgba(0,0,0,.15);margin-top:3px"></div>
        </div>
        <select id="com-alias-sel"
          style="padding:7px 10px;border:1px solid var(--border);border-radius:7px;
            background:var(--surface);color:var(--text-primary);font-size:12px">
          <option value="TODOS">Todos los usuarios</option>
        </select>
        <select id="com-tipo-sel"
          style="padding:7px 10px;border:1px solid var(--border);border-radius:7px;
            background:var(--surface);color:var(--text-primary);font-size:12px">
          ${tipoOpts}
        </select>
        <span id="com-count" style="font-size:11px;color:#9CA3AF;white-space:nowrap">Cargando…</span>
      </div>

      <!-- KPIs -->
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));
        gap:8px;margin-bottom:12px;flex-shrink:0">
        <div class="com-kpi">
          <div class="com-kpi-val" id="com-k-total" style="color:var(--text-primary)">—</div>
          <div class="com-kpi-lbl">Total</div>
        </div>
        <div class="com-kpi">
          <div class="com-kpi-val" id="com-k-hoy" style="color:#2563EB">—</div>
          <div class="com-kpi-lbl">Hoy</div>
        </div>
        <div class="com-kpi">
          <div class="com-kpi-val" id="com-k-semana" style="color:var(--green-dark,#1B5E20)">—</div>
          <div class="com-kpi-lbl">Esta semana</div>
        </div>
        <div class="com-kpi">
          <div class="com-kpi-val" id="com-k-alertas" style="color:#DC2626">—</div>
          <div class="com-kpi-lbl">🚨 Alertas</div>
        </div>
        <div class="com-kpi">
          <div class="com-kpi-val" id="com-k-promesas" style="color:#D97706">—</div>
          <div class="com-kpi-lbl">📅 Promesas</div>
        </div>
      </div>

      <!-- Lista -->
      <div id="com-lista" style="flex:1;overflow-y:auto">
        <div style="padding:48px;text-align:center;color:#9CA3AF">Cargando comentarios…</div>
      </div>
    </div>

    <!-- Panel nuevo comentario -->
    ${_puedeEscribir() ? `
    <div style="width:290px;flex-shrink:0;border-left:1px solid var(--border);
      padding:16px;overflow-y:auto;background:var(--surface);display:flex;flex-direction:column;gap:12px">

      <div style="font-size:12px;font-weight:800;letter-spacing:.06em;color:var(--text-primary)">
        AGREGAR COMENTARIO
      </div>

      <!-- Cliente -->
      <div style="position:relative">
        <label style="font-size:11px;color:#9CA3AF;display:block;margin-bottom:4px">Cliente</label>
        <input id="com-new-cli-search" type="text" autocomplete="off"
          placeholder="Buscar cliente por nombre o ID…" class="com-input">
        <input id="com-new-cli-val" type="hidden">
        <div id="com-cli-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
          background:var(--surface);border:1px solid var(--border);border-radius:8px;
          max-height:180px;overflow-y:auto;z-index:20;box-shadow:0 8px 24px rgba(0,0,0,.15);
          margin-top:3px"></div>
      </div>

      <!-- Texto -->
      <div>
        <label style="font-size:11px;color:#9CA3AF;display:block;margin-bottom:4px">Comentario / nota</label>
        <textarea id="com-new-texto" rows="5"
          placeholder="Escribe aquí el comentario o nota sobre el cliente…"
          style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:7px;
            background:var(--surface);color:var(--text-primary);font-size:12px;
            resize:vertical;box-sizing:border-box;min-height:90px"></textarea>
        <div id="com-new-chars" style="font-size:10px;color:#9CA3AF;text-align:right;margin-top:2px">0 / 1000</div>
      </div>

      <!-- Categoría -->
      <div>
        <label style="font-size:11px;color:#9CA3AF;display:block;margin-bottom:4px">Categoría</label>
        <select id="com-new-cat" class="com-input">
          <option value="SEGUIMIENTO">Seguimiento</option>
          <option value="ACUERDO">Acuerdo</option>
          <option value="RIESGO">Riesgo</option>
          <option value="INFORMACION">Información</option>
          <option value="ALERTA">Alerta</option>
        </select>
      </div>

      <button id="com-btn-guardar"
        style="padding:9px;background:#16A34A;color:#fff;border:none;border-radius:8px;
          font-size:13px;font-weight:700;cursor:pointer;width:100%">
        Guardar comentario
      </button>

      <div id="com-new-msg" style="font-size:11px;text-align:center;min-height:16px"></div>
    </div>` : ""}
  </div>`;
}

// ── Firestore ─────────────────────────────────────────────────
function _escuchar() {
  // 1. Comentarios manuales — sin orderBy para no depender del índice
  _unsubs.push(onSnapshot(
    query(collection(db, "comentarios_cliente"), limit(300)),
    snap => {
      _docsComents = snap.docs.map(d => ({ ...d.data(), _src:"comentario" }));
      _render();
    },
    err => {
      console.error("[Comentarios:comentarios_cliente]", err);
      _render();
    }
  ));

  // 2. Log de actividades — solo where sin orderBy para evitar índice compuesto
  _unsubs.push(onSnapshot(
    query(collection(db, "log_actividades"),
      where("tipoAccion", "in", [
        "VISITA_REGISTRADA","VISITA_SOSPECHOSA","ACUERDO_CONGELAMIENTO","PROMESA_PAGO"
      ]),
      limit(200)
    ),
    snap => {
      _docsLog = snap.docs.map(d => ({ ...d.data(), _src:"log" }));
      _render();
    },
    err => {
      console.error("[Comentarios:log_actividades]", err);
      // No interrumpir — mostrar solo los comentarios manuales
    }
  ));
}

// ── Render ────────────────────────────────────────────────────
function _render() {
  const lista = document.getElementById("com-lista");
  if (!lista) return;

  const _tsMs = d => {
    const ts = d.timestamp || d._ts || d.creadoEn;
    if (!ts) return 0;
    return ts?.toMillis?.() ?? (typeof ts === "number" ? ts : 0);
  };

  let todos = [..._docsComents, ..._docsLog].sort((a, b) => _tsMs(b) - _tsMs(a));

  // KPIs sobre el total sin filtrar
  _renderKPIs(todos);
  // Actualizar select de alias
  _actualizarAliasSelect();

  // Filtros
  if (_filtroAlias !== "TODOS")
    todos = todos.filter(d => (d.alias || d.usuarioAlias || "") === _filtroAlias);
  if (_filtroTipo !== "TODOS")
    todos = todos.filter(d => d.tipoAccion === _filtroTipo);
  if (_busqueda) {
    const q = norm(_busqueda);
    todos = todos.filter(d =>
      norm([d.clienteNombre, d.cliente, d.alias, d.usuarioAlias, d.texto, d.descripcion]
        .join(" ")).includes(q));
  }

  const cntEl = document.getElementById("com-count");
  if (cntEl) cntEl.textContent = `${todos.length} registros`;

  if (!todos.length) {
    const msg = (_docsComents.length + _docsLog.length) === 0
      ? "Sin comentarios registrados aún. Usa el panel derecho para agregar el primero."
      : "Sin registros para los filtros seleccionados.";
    lista.innerHTML = `<div style="padding:60px;text-align:center;color:#9CA3AF;font-size:13px">${msg}</div>`;
    return;
  }

  lista.innerHTML = todos.slice(0, 150).map(_tarjeta).join("");
}

function _renderKPIs(todos) {
  const hoy   = new Date(); hoy.setHours(0,0,0,0);
  const en7   = new Date(hoy); en7.setDate(hoy.getDate() - 7);
  const _d    = d => { const ts = d.timestamp || d._ts || d.creadoEn; if (!ts) return null; const x = ts?.toDate?.(); return x || new Date(ts); };
  const set   = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("com-k-total",   todos.length);
  set("com-k-hoy",     todos.filter(d => { const x = _d(d); return x && x >= hoy; }).length);
  set("com-k-semana",  todos.filter(d => { const x = _d(d); return x && x >= en7 && x < hoy; }).length);
  set("com-k-alertas", todos.filter(d => d.tipoAccion === "VISITA_SOSPECHOSA").length);
  set("com-k-promesas",todos.filter(d => d.tipoAccion === "PROMESA_PAGO").length);
}

function _tarjeta(d) {
  const ts      = _fmtTs(d.timestamp || d._ts || d.creadoEn);
  const alias   = esc(d.alias || d.usuarioAlias || "—");
  const cliente = esc(d.clienteNombre || d.cliente || "—");
  const texto   = esc(d.texto || d.descripcion || d.detalle || "—");
  const cfg     = _tipoCfg(d.tipoAccion);
  const catColor = d.categoria ? _catColor(d.categoria) : null;

  const badges = [
    d.tipoAccion === "VISITA_SOSPECHOSA"
      ? `<span style="font-size:10px;padding:2px 7px;border-radius:20px;
          background:#FEE2E2;color:#991B1B;font-weight:700">⚠ SOSPECHOSA</span>`
      : "",
    catColor
      ? `<span style="font-size:10px;padding:2px 7px;border-radius:20px;
          background:${catColor}18;color:${catColor};font-weight:700">${esc(d.categoria)}</span>`
      : ""
  ].filter(Boolean).join(" ");

  return `
  <div class="com-card" style="border-left:3px solid ${cfg.color}">
    <div style="display:flex;gap:12px">
      <div style="font-size:18px;flex-shrink:0;line-height:1.4">${cfg.icon}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-bottom:5px">
          <span style="font-size:13px;font-weight:700">${cliente}</span>
          <span style="font-size:11px;color:#9CA3AF">·</span>
          <span style="font-size:11px;color:${cfg.color};font-weight:600">${cfg.label}</span>
          ${badges}
        </div>
        <div style="font-size:12.5px;line-height:1.5;margin-bottom:6px;word-break:break-word">${texto}</div>
        <div style="font-size:11px;color:#9CA3AF">👤 ${alias} · 🕐 ${ts}</div>
      </div>
    </div>
  </div>`;
}

function _actualizarAliasSelect() {
  const sel = document.getElementById("com-alias-sel");
  if (!sel) return;
  const prev = sel.value;
  const aliasSet = new Set();
  [..._docsComents, ..._docsLog].forEach(d => {
    const a = d.alias || d.usuarioAlias;
    if (a) aliasSet.add(a);
  });
  sel.innerHTML = `<option value="TODOS">Todos los usuarios</option>` +
    [...aliasSet].sort().map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  if (aliasSet.has(prev)) sel.value = prev;
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI(container) {
  // Búsqueda principal con autocomplete de clientes
  const searchInput = container.querySelector("#com-search");
  const searchDd    = container.querySelector("#com-search-dd");
  searchInput?.addEventListener("input", e => {
    _busqueda = e.target.value;
    _render();
    // Autocomplete de clientes desde caché
    const q = norm(_busqueda);
    if (q.length < 2 || !searchDd) { if (searchDd) searchDd.style.display = "none"; return; }
    const matches = _clientesCache
      .filter(c => norm(c.nombre).includes(q) || norm(c.clienteId).includes(q))
      .slice(0, 10);
    if (!matches.length) { searchDd.style.display = "none"; return; }
    searchDd.innerHTML = matches.map(c =>
      `<div class="com-dd-item" data-nombre="${esc(c.nombre)}">
        <span style="font-weight:600">${esc(c.nombre)}</span>
        ${c.clienteId ? `<span style="color:#9CA3AF;font-size:10px;margin-left:6px">${esc(c.clienteId)}</span>` : ""}
      </div>`
    ).join("");
    searchDd.style.display = "block";
    searchDd.querySelectorAll(".com-dd-item").forEach(el =>
      el.addEventListener("mousedown", ev => {
        ev.preventDefault();
        searchInput.value = el.dataset.nombre;
        _busqueda = el.dataset.nombre;
        searchDd.style.display = "none";
        _render();
      }));
  });
  searchInput?.addEventListener("blur",  () => setTimeout(() => { if (searchDd) searchDd.style.display = "none"; }, 150));
  searchInput?.addEventListener("keydown", e => { if (e.key === "Escape" && searchDd) searchDd.style.display = "none"; });
  container.querySelector("#com-alias-sel")?.addEventListener("change", e => {
    _filtroAlias = e.target.value;
    _render();
  });
  container.querySelector("#com-tipo-sel")?.addEventListener("change", e => {
    _filtroTipo = e.target.value;
    _render();
  });

  // Contador de caracteres en textarea
  const textarea = container.querySelector("#com-new-texto");
  const charsEl  = container.querySelector("#com-new-chars");
  textarea?.addEventListener("input", () => {
    if (charsEl) charsEl.textContent = `${textarea.value.length} / 1000`;
  });

  // Guardar comentario
  container.querySelector("#com-btn-guardar")?.addEventListener("click", () => _guardar(container));
}

// ── Autocomplete clientes ─────────────────────────────────────
async function _cargarClientes(container) {
  try {
    const snap = await getDocs(query(collection(db, "clientes"), limit(500)));
    _clientesCache = snap.docs
      .map(d => ({ id:d.id, nombre:d.data().nombre||"", clienteId:d.data().clienteId||"" }))
      .filter(c => c.nombre)
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
  } catch(e) { console.warn("[Comentarios/clientes]", e); }
  _bindClienteSearch(container);
}

function _bindClienteSearch(container) {
  const input  = container.querySelector("#com-new-cli-search");
  const hidden = container.querySelector("#com-new-cli-val");
  const dd     = container.querySelector("#com-cli-dd");
  if (!input || !hidden || !dd) return;

  const mostrar = lista => {
    if (!lista.length) { dd.style.display = "none"; return; }
    dd.innerHTML = lista.slice(0, 20).map(c =>
      `<div class="com-dd-item" data-id="${esc(c.id)}" data-nombre="${esc(c.nombre)}">
        <span style="font-weight:600">${esc(c.nombre)}</span>
        ${c.clienteId ? `<span style="color:#9CA3AF;font-size:10px;margin-left:6px">${esc(c.clienteId)}</span>` : ""}
      </div>`
    ).join("");
    dd.style.display = "block";
    dd.querySelectorAll(".com-dd-item").forEach(el =>
      el.addEventListener("mousedown", e => {
        e.preventDefault();
        input.value  = el.dataset.nombre;
        hidden.value = el.dataset.nombre;
        dd.style.display = "none";
      }));
  };

  input.addEventListener("input", () => {
    const q = norm(input.value.trim());
    hidden.value = ""; // se asigna solo al seleccionar del dropdown
    if (!q) { dd.style.display = "none"; return; }
    mostrar(_clientesCache.filter(c =>
      norm(c.nombre).includes(q) || norm(c.clienteId).includes(q)));
  });
  input.addEventListener("blur",  () => setTimeout(() => { dd.style.display = "none"; }, 150));
  input.addEventListener("focus", () => { if (input.value.trim()) input.dispatchEvent(new Event("input")); });
}

// ── Guardar ───────────────────────────────────────────────────
async function _guardar(container) {
  const clienteNombre = container.querySelector("#com-new-cli-val")?.value.trim();
  const texto         = container.querySelector("#com-new-texto")?.value.trim();
  const categoria     = container.querySelector("#com-new-cat")?.value;
  const msgEl         = container.querySelector("#com-new-msg");
  const btn           = container.querySelector("#com-btn-guardar");

  const mostrarMsg = (txt, color) => {
    if (!msgEl) return;
    msgEl.textContent = txt;
    msgEl.style.color = color;
  };

  if (!clienteNombre || !texto) {
    mostrarMsg("Completa el cliente y el comentario.", "#DC2626"); return;
  }
  if (texto.length > 1000) {
    mostrarMsg("El comentario supera 1000 caracteres.", "#DC2626"); return;
  }

  if (btn) btn.disabled = true;
  try {
    await addDoc(collection(db, "comentarios_cliente"), {
      clienteNombre: clienteNombre.substring(0, 100),
      texto:         texto.substring(0, 1000),
      categoria,
      alias:         Sesion.alias,
      rol:           Sesion.rol,
      uid:           Sesion.uid,
      tipoAccion:    "COMENTARIO_MANUAL",
      timestamp:     serverTimestamp()
    });
    container.querySelector("#com-new-cli-search").value = "";
    container.querySelector("#com-new-cli-val").value    = "";
    container.querySelector("#com-new-texto").value      = "";
    const charsEl = container.querySelector("#com-new-chars");
    if (charsEl) charsEl.textContent = "0 / 1000";
    mostrarMsg("✓ Comentario guardado", "#16A34A");
    window.toast?.("Comentario guardado", "success");
    setTimeout(() => mostrarMsg("", ""), 3000);
  } catch (e) {
    console.error("[Comentarios/guardar]", e);
    mostrarMsg("Error: " + e.message, "#DC2626");
  } finally {
    if (btn) btn.disabled = false;
  }
}
