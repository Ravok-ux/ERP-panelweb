// ══════════════════════════════════════════════════════════════
// blacklist.js — Clientes en lista negra
// Colección: blacklist / Storage: blacklist/{id}/adjuntos/*
// ══════════════════════════════════════════════════════════════

import { db, storage }  from "./firebase-config.js";
import { Sesion }        from "./auth.js";
import { esc, logAudit, norm } from "./app.js";
import {
  collection, doc, query, where, orderBy, limit,
  onSnapshot, addDoc, updateDoc, getDoc, getDocs,
  serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// ── Constantes ─────────────────────────────────────────────────
const NIVELES = {
  ALTO:  { label:"ALTO",  color:"#DC2626", bg:"#FEF2F2" },
  MEDIO: { label:"MEDIO", color:"#D97706", bg:"#FFFBEB" },
  BAJO:  { label:"BAJO",  color:"#16A34A", bg:"#F0FDF4" },
};
const CATEGORIAS = ["MOROSO","FRAUDULENTO","CONFLICTIVO","INCOBRABLE","OTRO"];
const ROLES_ADMIN = ["SUPER_ADMIN","GERENTE","ADMINISTRADOR"];

// ── Estado del módulo ──────────────────────────────────────────
let _unsub   = null;
let _allRows = [];
let _filtro  = { texto:"", nivel:"", categoria:"", estado:"ACTIVO" };

// ── Exportable: chequeo rápido desde otros módulos ─────────────
let _blacklistCache = [];

export async function cargarCacheBlacklist() {
  try {
    const snap = await getDocs(
      query(collection(db, "blacklist"), where("estado","==","ACTIVO"))
    );
    _blacklistCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(_) {}
}

export function clienteEnBlacklist(clienteId, nombre) {
  return _blacklistCache.find(b =>
    (clienteId && b.clienteId === clienteId) ||
    (nombre && norm(b.clienteNombre) === norm(nombre))
  ) || null;
}

// ── Permisos ───────────────────────────────────────────────────
function _puedeVer()     { return Sesion.esSuperAdmin?.() || true; }
function _puedeGestionar() {
  return Sesion.esSuperAdmin?.() || ROLES_ADMIN.includes(Sesion.rol);
}

// ── Módulo principal ───────────────────────────────────────────
export const BlacklistModule = {
  mount(container) {
    container.innerHTML = `
    <div class="mod-wrap">
      <div class="mod-topbar">
        <h2 class="mod-title">🚫 Blacklist</h2>
        ${_puedeGestionar() ? `<button class="btn-primary" id="bl-nuevo-btn">+ Agregar</button>` : ""}
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
        <input type="text" class="sel-sm" id="bl-buscar"
          placeholder="Buscar por nombre, zona…" style="width:220px"
          oninput="window._blFiltrar()">
        <select class="sel-sm" id="bl-f-nivel" onchange="window._blFiltrar()">
          <option value="">Todos los niveles</option>
          <option value="ALTO">🔴 Alto riesgo</option>
          <option value="MEDIO">🟡 Medio riesgo</option>
          <option value="BAJO">🟢 Bajo riesgo</option>
        </select>
        <select class="sel-sm" id="bl-f-cat" onchange="window._blFiltrar()">
          <option value="">Todas las categorías</option>
          ${CATEGORIAS.map(c=>`<option value="${c}">${c}</option>`).join("")}
        </select>
        <select class="sel-sm" id="bl-f-estado" onchange="window._blFiltrar()">
          <option value="ACTIVO">En lista negra</option>
          <option value="REHABILITADO">Rehabilitados</option>
          <option value="">Todos</option>
        </select>
      </div>

      <div id="bl-lista"></div>
    </div>

    <!-- Modal agregar / editar -->
    <div id="bl-modal" class="modal-overlay" style="display:none;z-index:9000">
      <div class="modal-box" style="width:660px">
        <div class="modal-hdr">
          <span class="modal-title" id="bl-modal-titulo">Agregar a Blacklist</span>
          <button class="modal-close" onclick="window._blCerrarModal()">✕</button>
        </div>
        <div class="modal-body" id="bl-modal-body"></div>
        <div class="modal-footer" id="bl-modal-footer"></div>
      </div>
    </div>

    <!-- Panel detalle -->
    <div id="bl-panel" class="modal-overlay" style="display:none;z-index:9000">
      <div class="modal-box" style="width:720px">
        <div class="modal-hdr">
          <span class="modal-title">Expediente</span>
          <button class="modal-close" onclick="window._blCerrarPanel()">✕</button>
        </div>
        <div class="modal-body" id="bl-panel-body"></div>
      </div>
    </div>`;

    document.getElementById("bl-nuevo-btn")?.addEventListener("click", () => _abrirModal(null));

    window._blFiltrar    = _filtrar;
    window._blCerrarModal = _cerrarModal;
    window._blCerrarPanel = _cerrarPanel;

    // ESC cierra el modal o panel activo
    window._blEscHandler = e => {
      if (e.key !== "Escape") return;
      if (document.getElementById("bl-modal")?.style.display !== "none") { _cerrarModal(); return; }
      if (document.getElementById("bl-panel")?.style.display  !== "none") { _cerrarPanel(); }
    };
    document.addEventListener("keydown", window._blEscHandler);
    window._blAbrirDetalle = _abrirDetalle;
    window._blEditar     = id => { const r = _allRows.find(r=>r.id===id); if(r) _abrirModal(r); };
    window._blSolicitarRehab = _solicitarRehab;
    window._blAprobarRehab   = _aprobarRehab;

    _iniciarListener();
    cargarCacheBlacklist();

    return () => this.destroy();
  },
  destroy() {
    _unsub?.(); _unsub = null;
    if (window._blEscHandler) {
      document.removeEventListener("keydown", window._blEscHandler);
      delete window._blEscHandler;
    }
    delete window._blFiltrar;
    delete window._blCerrarModal;
    delete window._blCerrarPanel;
    delete window._blAbrirDetalle;
    delete window._blEditar;
    delete window._blSolicitarRehab;
    delete window._blAprobarRehab;
  }
};

// ── Listener en tiempo real ────────────────────────────────────
function _iniciarListener() {
  const q = query(collection(db, "blacklist"), orderBy("creadoEn","desc"), limit(300));
  _unsub = onSnapshot(q, snap => {
    _allRows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _blacklistCache = _allRows.filter(r => r.estado === "ACTIVO");
    _filtrar();
  }, err => console.error("[Blacklist]", err));
}

// ── Filtrar y renderizar lista ─────────────────────────────────
function _filtrar() {
  _filtro.texto     = (document.getElementById("bl-buscar")?.value || "").toLowerCase();
  _filtro.nivel     = document.getElementById("bl-f-nivel")?.value   || "";
  _filtro.categoria = document.getElementById("bl-f-cat")?.value     || "";
  _filtro.estado    = document.getElementById("bl-f-estado")?.value  || "";

  const rows = _allRows.filter(r => {
    if (_filtro.estado && r.estado !== _filtro.estado) return false;
    if (_filtro.nivel && r.nivelRiesgo !== _filtro.nivel) return false;
    if (_filtro.categoria && r.categoria !== _filtro.categoria) return false;
    if (_filtro.texto) {
      const hay = `${r.clienteNombre} ${r.zona||""} ${r.descripcion||""}`.toLowerCase();
      if (!hay.includes(_filtro.texto)) return false;
    }
    return true;
  });

  const el = document.getElementById("bl-lista");
  if (!el) return;

  if (!rows.length) {
    el.innerHTML = `<div style="padding:48px;text-align:center;color:var(--text-sec)">
      No hay registros que coincidan con los filtros.</div>`;
    return;
  }

  el.innerHTML = `
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="border-bottom:2px solid var(--border)">
        <th style="text-align:left;padding:10px 8px">CLIENTE</th>
        <th style="text-align:left;padding:10px 8px">ZONA</th>
        <th style="text-align:left;padding:10px 8px">CATEGORÍA</th>
        <th style="text-align:center;padding:10px 8px">RIESGO</th>
        <th style="text-align:right;padding:10px 8px">ADEUDO</th>
        <th style="text-align:center;padding:10px 8px">ESTADO</th>
        <th style="padding:10px 8px"></th>
      </tr>
    </thead>
    <tbody>
    ${rows.map(r => {
      const nv = NIVELES[r.nivelRiesgo] || NIVELES.MEDIO;
      const esRehab = r.estado === "REHABILITADO";
      return `
      <tr style="border-bottom:1px solid var(--border);${esRehab?"opacity:.6":""}">
        <td style="padding:10px 8px;font-weight:600">${esc(r.clienteNombre||"–")}</td>
        <td style="padding:10px 8px;color:var(--text-sec)">${esc(r.zona||"–")}</td>
        <td style="padding:10px 8px">
          <span style="background:#F3F4F6;color:#374151;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600">
            ${esc(r.categoria||"–")}
          </span>
        </td>
        <td style="padding:10px 8px;text-align:center">
          <span style="background:${nv.bg};color:${nv.color};padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;border:1px solid ${nv.color}20">
            ${nv.label}
          </span>
        </td>
        <td style="padding:10px 8px;text-align:right;font-variant-numeric:tabular-nums;color:${r.montoAdeudo>0?"#DC2626":"var(--text-sec)"}">
          ${r.montoAdeudo > 0
            ? Number(r.montoAdeudo).toLocaleString("es-MX",{style:"currency",currency:"MXN"})
            : "–"}
        </td>
        <td style="padding:10px 8px;text-align:center">
          ${esRehab
            ? `<span style="background:#DCFCE7;color:var(--green-dark,#1B5E20);padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600">✓ Rehabilitado</span>`
            : `<span style="background:#FEE2E2;color:#DC2626;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600">🚫 Activo</span>`}
        </td>
        <td style="padding:10px 8px;text-align:right">
          <button onclick="_blAbrirDetalle('${r.id}')"
            style="padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:none;cursor:pointer;font-size:12px;color:var(--text-pri)">
            Ver expediente
          </button>
        </td>
      </tr>`;
    }).join("")}
    </tbody>
  </table>`;
}

// ── Detalle / expediente ───────────────────────────────────────
async function _abrirDetalle(id) {
  const r = _allRows.find(r => r.id === id);
  if (!r) return;
  const nv = NIVELES[r.nivelRiesgo] || NIVELES.MEDIO;
  const esRehab = r.estado === "REHABILITADO";
  const puedeGestionar = _puedeGestionar();

  const fechaCreado = r.creadoEn?.toDate
    ? r.creadoEn.toDate().toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"})
    : "–";

  // Adjuntos
  const adjuntos = r.adjuntos || [];

  // Historial
  const historial = r.historial || [];

  // Rehabilitación pendiente
  const rehabPendiente = r.rehabSolicitud?.estado === "PENDIENTE";

  document.getElementById("bl-panel-body").innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px">
      <div>
        <div style="font-size:22px;font-weight:800;margin-bottom:4px">${esc(r.clienteNombre||"–")}</div>
        <div style="color:var(--text-sec);font-size:13px">${esc(r.zona||"")}${r.ingenieroPrevio?` · Último ingeniero: ${esc(r.ingenieroPrevio)}`:""}</div>
      </div>
      <span style="background:${nv.bg};color:${nv.color};padding:6px 16px;border-radius:20px;font-size:13px;font-weight:800;border:1px solid ${nv.color}40;white-space:nowrap">
        ${nv.label} RIESGO
      </span>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px">
      ${_dfield("Categoría", esc(r.categoria||"–"))}
      ${_dfield("Estado", esRehab
        ? `<span style="color:var(--green-dark,#1B5E20);font-weight:700">✓ Rehabilitado</span>`
        : `<span style="color:#DC2626;font-weight:700">🚫 En lista negra</span>`)}
      ${_dfield("Adeudo", r.montoAdeudo > 0
        ? `<span style="color:#DC2626;font-weight:700">${Number(r.montoAdeudo).toLocaleString("es-MX",{style:"currency",currency:"MXN"})}</span>`
        : "Sin adeudo registrado")}
      ${_dfield("Registrado", fechaCreado)}
      ${_dfield("Registrado por", esc(r.creadoPorNombre||"–"))}
    </div>

    <div style="background:var(--bg-sec);border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Descripción del caso</div>
      <div style="font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(r.descripcion||"Sin descripción")}</div>
    </div>

    <!-- Adjuntos -->
    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;color:var(--text-sec);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">
        Adjuntos del expediente (${adjuntos.length})
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px" id="bl-adjuntos-lista">
        ${adjuntos.map((a,i) => `
          <a href="${esc(a.url)}" target="_blank"
            style="display:flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--border);border-radius:6px;text-decoration:none;font-size:12px;color:var(--text-pri);background:var(--card-bg)">
            📎 ${esc(a.nombre||`Archivo ${i+1}`)}
          </a>`).join("") || `<span style="color:var(--text-sec);font-size:13px">Sin adjuntos</span>`}
      </div>
      ${puedeGestionar && !esRehab ? `
      <label style="display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:6px 14px;border:1px dashed var(--border);border-radius:6px;cursor:pointer;font-size:12px;color:var(--text-sec)">
        + Subir archivo
        <input type="file" style="display:none" multiple accept="image/*,.pdf,.docx,.xlsx"
          onchange="window._blSubirAdjunto('${id}', this)">
      </label>` : ""}
    </div>

    <!-- Historial -->
    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;color:var(--text-sec);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">
        Historial de cambios
      </div>
      <div style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
        ${historial.length === 0
          ? `<span style="color:var(--text-sec);font-size:13px">Sin historial</span>`
          : historial.slice().reverse().map(h => `
          <div style="display:flex;gap:10px;font-size:12px;padding:8px;background:var(--bg-sec);border-radius:6px">
            <span style="color:var(--text-sec);white-space:nowrap">${h.fecha||""}</span>
            <span style="color:var(--text-sec)">${esc(h.usuario||"")}</span>
            <span style="flex:1">${esc(h.accion||"")}</span>
          </div>`).join("")}
      </div>
    </div>

    <!-- Acciones -->
    ${(!esRehab && puedeGestionar) || (!esRehab && !puedeGestionar) ? `
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;padding-top:8px">
      ${!esRehab && puedeGestionar ? `
        <button class="btn-outline" onclick="_blEditar('${id}')">✏️ Editar expediente</button>
        <button class="btn-primary" style="background:var(--green-dark,#1B5E20)" onclick="_blAprobarRehab('${id}')">✓ Rehabilitar cliente</button>` : ""}
      ${!esRehab && !puedeGestionar ? `
        ${rehabPendiente
          ? `<span style="color:#D97706;font-size:13px;padding:8px">⏳ Solicitud pendiente de aprobación</span>`
          : `<button class="btn-outline" style="border-color:#D97706;color:#D97706" onclick="_blSolicitarRehab('${id}')">Solicitar rehabilitación</button>`}` : ""}
    </div>` : ""}`;

  window._blSubirAdjunto = (docId, input) => _subirAdjuntos(docId, input.files);

  document.getElementById("bl-panel").style.display = "flex";
}

function _dfield(label, valor) {
  return `<div style="background:var(--bg-sec);border-radius:8px;padding:12px">
    <div style="font-size:10px;font-weight:700;color:var(--text-sec);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">${label}</div>
    <div style="font-size:13px;font-weight:600">${valor}</div>
  </div>`;
}

// ── Modal agregar / editar ─────────────────────────────────────
async function _abrirModal(registro) {
  if (!_puedeGestionar()) return;

  const editar = !!registro;
  document.getElementById("bl-modal-titulo").textContent = editar
    ? "Editar expediente" : "Agregar a Blacklist";

  // Cargar lista de clientes para el selector
  let opcionesClientes = "";
  try {
    const snap = await getDocs(query(collection(db, "clientes"), orderBy("nombre"), limit(500)));
    opcionesClientes = snap.docs.map(d => {
      const c = d.data();
      const sel = editar && registro.clienteId === d.id ? "selected" : "";
      return `<option value="${d.id}" data-nombre="${esc(c.nombre||"")}" data-zona="${esc(c.zona||"")}" ${sel}>${esc(c.nombre||d.id)}${c.zona?` (${c.zona})`:""}</option>`;
    }).join("");
  } catch(_) {}

  document.getElementById("bl-modal-body").innerHTML = `
    <div class="form-group">
      <label class="form-label">CLIENTE</label>
      <select class="form-input" id="bl-f-cliente" onchange="window._blClienteChange()">
        <option value="">— Selecciona un cliente del sistema —</option>
        ${opcionesClientes}
      </select>
      <div style="margin-top:8px;font-size:11px;color:var(--text-sec)">O escribe el nombre si no está en el sistema:</div>
      <input type="text" class="form-input" id="bl-f-nombre" placeholder="Nombre del cliente"
        style="margin-top:6px" value="${esc(registro?.clienteNombre||"")}">
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="form-group">
        <label class="form-label">NIVEL DE RIESGO *</label>
        <select class="form-input" id="bl-f-riesgo">
          ${Object.keys(NIVELES).map(k=>
            `<option value="${k}" ${registro?.nivelRiesgo===k?"selected":""}>${k}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">CATEGORÍA *</label>
        <select class="form-input" id="bl-f-categoria">
          ${CATEGORIAS.map(c=>
            `<option value="${c}" ${registro?.categoria===c?"selected":""}>${c}</option>`
          ).join("")}
        </select>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="form-group">
        <label class="form-label">ZONA</label>
        <input type="text" class="form-input" id="bl-f-zona"
          placeholder="Zona del cliente" value="${esc(registro?.zona||"")}">
      </div>
      <div class="form-group">
        <label class="form-label">MONTO ADEUDO (MXN)</label>
        <input type="number" class="form-input" id="bl-f-monto"
          placeholder="0.00" min="0" value="${registro?.montoAdeudo||""}">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">INGENIERO PREVIO</label>
      <input type="text" class="form-input" id="bl-f-ingprev"
        placeholder="Nombre del ingeniero que lo atendía"
        value="${esc(registro?.ingenieroPrevio||"")}">
    </div>

    <div class="form-group">
      <label class="form-label">DESCRIPCIÓN DEL CASO *</label>
      <textarea id="bl-f-desc" rows="5" class="form-input"
        style="resize:vertical;font-family:inherit"
        placeholder="Describe el historial: motivos, incidentes, fechas, deuda pendiente, acuerdos rotos…">${esc(registro?.descripcion||"")}</textarea>
    </div>`;

  document.getElementById("bl-modal-footer").innerHTML = `
    <button class="btn-outline" onclick="window._blCerrarModal()">Cancelar</button>
    <button id="bl-guardar-btn" class="btn-primary" style="background:#DC2626"
      onclick="window._blGuardar(${editar ? `'${registro.id}'` : "null"})">
      ${editar ? "Guardar cambios" : "Agregar a lista negra"}
    </button>`;

  window._blClienteChange = () => {
    const sel = document.getElementById("bl-f-cliente");
    const opt = sel.options[sel.selectedIndex];
    if (opt.value) {
      document.getElementById("bl-f-nombre").value = opt.dataset.nombre || "";
      document.getElementById("bl-f-zona").value   = opt.dataset.zona   || "";
    }
  };

  window._blGuardar = id => _guardar(id);
  document.getElementById("bl-modal").style.display = "flex";
}

function _cerrarModal() {
  document.getElementById("bl-modal").style.display = "none";
}
function _cerrarPanel() {
  document.getElementById("bl-panel").style.display = "none";
}

// ── Guardar ────────────────────────────────────────────────────
async function _guardar(registroId) {
  const clienteSel = document.getElementById("bl-f-cliente")?.value || "";
  const nombre     = (document.getElementById("bl-f-nombre")?.value || "").trim();
  const riesgo     = document.getElementById("bl-f-riesgo")?.value  || "MEDIO";
  const categoria  = document.getElementById("bl-f-categoria")?.value || "MOROSO";
  const zona       = (document.getElementById("bl-f-zona")?.value   || "").trim();
  const monto      = parseFloat(document.getElementById("bl-f-monto")?.value || 0) || 0;
  const ingPrev    = (document.getElementById("bl-f-ingprev")?.value || "").trim();
  const desc       = (document.getElementById("bl-f-desc")?.value   || "").trim();

  if (!nombre) { alert("El nombre del cliente es obligatorio."); return; }
  if (!desc)   { alert("La descripción del caso es obligatoria."); return; }

  const btn = document.getElementById("bl-guardar-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }

  const ahora = new Date().toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"});
  const accion = registroId ? "Expediente actualizado" : "Agregado a lista negra";

  const entrada = {
    fecha:   ahora,
    usuario: Sesion.nombre || Sesion.email || "–",
    accion:  `${accion} · Nivel: ${riesgo} · Categoría: ${categoria}`,
  };

  const payload = {
    clienteId:       clienteSel || null,
    clienteNombre:   nombre,
    zona,
    nivelRiesgo:     riesgo,
    categoria,
    montoAdeudo:     monto,
    ingenieroPrevio: ingPrev,
    descripcion:     desc,
    estado:          "ACTIVO",
  };

  try {
    if (registroId) {
      await updateDoc(doc(db, "blacklist", registroId), {
        ...payload,
        historial: arrayUnion(entrada),
      });
    } else {
      await addDoc(collection(db, "blacklist"), {
        ...payload,
        adjuntos:  [],
        historial: [entrada],
        creadoEn:  serverTimestamp(),
        creadoPor: Sesion.uid,
        creadoPorNombre: Sesion.nombre || Sesion.email || "–",
      });
    }

    // Si el cliente existe en colección clientes, marcar flag en su doc
    if (clienteSel) {
      await updateDoc(doc(db, "clientes", clienteSel), { enBlacklist: true }).catch(()=>{});
    }

    logAudit?.("blacklist_guardado", { nombre, riesgo, categoria });
    _cerrarModal();
  } catch(e) {
    alert("Error al guardar: " + e.message);
    if (btn) { btn.disabled = false; btn.textContent = registroId ? "Guardar cambios" : "Agregar a lista negra"; }
  }
}

// ── Adjuntos ───────────────────────────────────────────────────
async function _subirAdjuntos(docId, files) {
  if (!files || !files.length) return;
  const filesArr = Array.from(files);

  // Feedback visual
  const listaEl = document.getElementById("bl-adjuntos-lista");
  if (listaEl) listaEl.innerHTML += `<span style="color:var(--text-sec);font-size:12px">Subiendo ${filesArr.length} archivo(s)…</span>`;

  try {
    const uploads = await Promise.all(filesArr.map(async file => {
      const path = `blacklist/${docId}/adjuntos/${Date.now()}_${file.name}`;
      const r = storageRef(storage, path);
      await uploadBytes(r, file);
      const url = await getDownloadURL(r);
      return { nombre: file.name, url, path };
    }));

    await updateDoc(doc(db, "blacklist", docId), {
      adjuntos: arrayUnion(...uploads),
    });

    // Refrescar panel
    _abrirDetalle(docId);
  } catch(e) {
    alert("Error al subir adjunto: " + e.message);
  }
}

// ── Solicitar rehabilitación (roles bajos) ─────────────────────
async function _solicitarRehab(id) {
  const r = _allRows.find(r => r.id === id);
  if (!r) return;

  const motivo = prompt("Describe el motivo de la solicitud de rehabilitación:");
  if (!motivo?.trim()) return;

  const ahora = new Date().toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"});

  await updateDoc(doc(db, "blacklist", id), {
    rehabSolicitud: {
      estado:       "PENDIENTE",
      solicitadoPor: Sesion.uid,
      solicitadoPorNombre: Sesion.nombre || Sesion.email,
      motivo:       motivo.trim(),
      fecha:        ahora,
    },
    historial: arrayUnion({
      fecha:   ahora,
      usuario: Sesion.nombre || Sesion.email,
      accion:  `Solicitud de rehabilitación: "${motivo.trim()}"`,
    }),
  });

  // Notificar a todos los admins
  await _notificarAdmins(r, motivo.trim());
  alert("Solicitud enviada. Un administrador revisará el caso.");
  _abrirDetalle(id);
}

async function _notificarAdmins(registro, motivo) {
  try {
    const adminsSnap = await getDocs(
      query(collection(db, "usuarios"),
        where("rol","in",["GERENTE","ADMINISTRADOR","SUPER_ADMIN"]))
    );
    const uids = adminsSnap.docs.map(d => d.id);
    if (!uids.length) return;

    await addDoc(collection(db, "notificaciones_web"), {
      tipo:          "BLACKLIST_REHAB_SOLICITUD",
      titulo:        "Solicitud de rehabilitación — Blacklist",
      mensaje:       `${Sesion.nombre||"Un usuario"} solicita rehabilitar a "${registro.clienteNombre}". Motivo: ${motivo}`,
      destinatarios: uids,
      leida:         false,
      timestamp:     serverTimestamp(),
      datos:         { blacklistId: registro.id, clienteNombre: registro.clienteNombre },
    });
  } catch(e) { console.warn("Error notificando admins:", e); }
}

// ── Aprobar rehabilitación (solo admins) ───────────────────────
async function _aprobarRehab(id) {
  if (!_puedeGestionar()) return;
  const r = _allRows.find(r => r.id === id);
  if (!r) return;

  const justificacion = prompt(`¿Confirmas la rehabilitación de "${r.clienteNombre}"?\nEscribe la justificación:`);
  if (!justificacion?.trim()) return;

  const ahora = new Date().toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"});

  await updateDoc(doc(db, "blacklist", id), {
    estado:           "REHABILITADO",
    rehabSolicitud:   { estado: "APROBADO" },
    rehabilitadoPor:  Sesion.nombre || Sesion.email,
    rehabilitadoEn:   ahora,
    justificacionRehab: justificacion.trim(),
    historial: arrayUnion({
      fecha:   ahora,
      usuario: Sesion.nombre || Sesion.email,
      accion:  `Cliente rehabilitado. Justificación: "${justificacion.trim()}"`,
    }),
  });

  // Quitar flag en clientes
  if (r.clienteId) {
    await updateDoc(doc(db, "clientes", r.clienteId), { enBlacklist: false }).catch(()=>{});
  }

  logAudit?.("blacklist_rehabilitado", { id, nombre: r.clienteNombre });
  _cerrarPanel();
  alert(`"${r.clienteNombre}" ha sido rehabilitado. El historial queda registrado.`);
}
