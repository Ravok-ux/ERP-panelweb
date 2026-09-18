/**
 * Módulo Formularios Dinámicos — N-10 Web Panel
 * El administrador crea plantillas de formularios que los ingenieros
 * completan desde el APK durante visitas o inspecciones en campo.
 *
 * Estructura Firestore:
 *   formularios/{id}       — plantillas
 *   respuestas_formulario/{id} — respuestas enviadas desde el APK
 */

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { exportarExcel } from "./excel-utils.js";

let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };
import {
  collection, doc, addDoc, setDoc, deleteDoc,
  onSnapshot, query, where, limit, getDocs, getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const TIPOS_CAMPO = [
  { valor: "texto",     label: "Texto libre" },
  { valor: "numero",    label: "Número" },
  { valor: "seleccion", label: "Selección única" },
  { valor: "multiple",  label: "Selección múltiple" },
  { valor: "fecha",     label: "Fecha" },
  { valor: "checkbox",  label: "Sí / No" },
  { valor: "foto",      label: "Foto" },
];

// ── Estado ─────────────────────────────────────────────────────────────────────
let _unsubForms    = null;
let _unsubResp     = null;
let _formularios   = {};   // id → form doc
let _respuestas    = [];   // últimas respuestas
let _tabActual     = "plantillas";
let _formSeleccionado = null;  // id del form para ver respuestas

// ── Render ─────────────────────────────────────────────────────────────────────
export const FormulariosModule = {

  mount(container) { this.render(container); },

  render(container) {
    container.innerHTML = `
      <div class="frm-shell">
        <div class="frm-header">
          <h2 class="frm-title">📋 Formularios Dinámicos</h2>
          <div class="frm-tabs">
            <button class="frm-tab active" data-tab="plantillas">Plantillas</button>
            <button class="frm-tab" data-tab="respuestas">Respuestas</button>
          </div>
          <button class="btn-primary" id="frmBtnNuevo" style="margin-left:auto">+ Nueva plantilla</button>
        </div>

        <div id="frmContenido" class="frm-contenido"></div>

        <!-- Modal de plantilla -->
        <div id="frmModalOverlay" class="frm-modal-overlay" style="display:none">
          <div class="frm-modal" id="frmModal"></div>
        </div>

        <!-- Panel lateral de respuestas -->
        <div id="frmRespPanel" class="frm-resp-panel" style="display:none">
          <div class="frm-resp-header">
            <span id="frmRespTitulo"></span>
            <button class="btn-secondary btn-sm" onclick="_frmCerrarResp()">✕ Cerrar</button>
          </div>
          <div id="frmRespBody" class="frm-resp-body"></div>
        </div>
      </div>

      <style>
        .frm-shell { display:flex; flex-direction:column; height:100%; }
        .frm-header{ display:flex; align-items:center; gap:10px; padding:12px 16px;
                     border-bottom:1px solid var(--border,#e2e8f0); flex-wrap:wrap; }
        .frm-title { margin:0; font-size:1.1rem; font-weight:700; white-space:nowrap; }
        .frm-tabs  { display:flex; background:var(--border,#e2e8f0); border-radius:8px; padding:2px; gap:2px; }
        .frm-tab   { background:none; border:none; padding:5px 14px; border-radius:6px;
                     cursor:pointer; font-size:.85rem; color:var(--text-sec); }
        .frm-tab.active { background:var(--surface); color:var(--text-primary); font-weight:600; }
        .frm-contenido { flex:1; overflow-y:auto; padding:16px; min-height:0;
                         display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
                         gap:12px; align-content:start; }
        .frm-card  { background:var(--surface); border:1px solid var(--border,#e2e8f0);
                     border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:8px; }
        .frm-card.inactivo { opacity:.6; }
        .frm-card-name { font-weight:700; font-size:.95rem; }
        .frm-card-meta { font-size:.78rem; color:var(--text-sec); }
        .frm-card-campos { font-size:.78rem; }
        .frm-campo-chip{ display:inline-block; background:var(--accent-soft,#eff6ff);
                         color:var(--accent,#3b82f6); border-radius:20px; padding:1px 8px;
                         margin:2px; font-size:.73rem; }
        .frm-card-actions { display:flex; gap:6px; flex-wrap:wrap; }
        .frm-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45);
                             display:flex; align-items:flex-start; justify-content:center;
                             overflow-y:auto; z-index:200; padding:20px 0; }
        .frm-modal { background:var(--surface); border-radius:12px; padding:20px;
                     width:min(560px,95vw); }
        .frm-m-title { font-size:1rem; font-weight:700; margin:0 0 14px; }
        .frm-field { margin-bottom:10px; }
        .frm-field label { display:block; font-size:.8rem; font-weight:600;
                           margin-bottom:3px; color:var(--text-sec); }
        .frm-field input,.frm-field select,.frm-field textarea
                   { width:100%; padding:7px 9px; border:1px solid var(--border,#e2e8f0);
                     border-radius:6px; font-size:.88rem; box-sizing:border-box; }
        .frm-campos-lista { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
        .frm-campo-item { background:var(--surface,#f8fafc); border:1px solid var(--border,#e2e8f0);
                          border-radius:8px; padding:8px 10px; display:flex; align-items:center; gap:8px; }
        .frm-campo-drag { cursor:grab; color:var(--text-sec); font-size:1rem; }
        .frm-campo-info { flex:1; font-size:.85rem; }
        .frm-campo-tipo { font-size:.72rem; color:var(--text-sec); }
        .frm-m-actions { display:flex; gap:8px; margin-top:14px; }
        .frm-resp-panel{ position:fixed; right:0; top:0; bottom:0; width:min(480px,100vw);
                         background:var(--surface); border-left:1px solid var(--border,#e2e8f0);
                         display:flex; flex-direction:column; z-index:100; box-shadow:-4px 0 16px rgba(0,0,0,.1); }
        .frm-resp-header{ display:flex; align-items:center; justify-content:space-between;
                          padding:12px 14px; border-bottom:1px solid var(--border,#e2e8f0);
                          font-weight:700; font-size:.9rem; }
        .frm-resp-body { flex:1; overflow-y:auto; padding:12px; }
        .frm-resp-card { background:var(--surface,#f8fafc); border:1px solid var(--border,#e2e8f0);
                         border-radius:8px; padding:10px 12px; margin-bottom:8px; }
        .frm-resp-meta { font-size:.76rem; color:var(--text-sec); margin-bottom:6px; }
        .frm-resp-row  { display:flex; gap:8px; font-size:.82rem; padding:3px 0;
                         border-bottom:1px solid var(--border,#e2e8f0); }
        .frm-resp-row:last-child { border:none; }
        .frm-resp-label { font-weight:600; min-width:120px; color:var(--text-sec); }
        .btn-primary   { background:var(--accent,#3b82f6); color:#fff; border:none;
                         padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .btn-secondary { background:transparent; border:1px solid var(--border,#30363d);
                         color:var(--text-primary,#E6EDF3);
                         padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .btn-danger    { background:#ef4444; color:#fff; border:none;
                         padding:5px 10px; border-radius:6px; cursor:pointer; font-size:.8rem; }
        .btn-success   { background:#22c55e; color:#fff; border:none;
                         padding:5px 10px; border-radius:6px; cursor:pointer; font-size:.8rem; }
        .btn-sm        { padding:4px 10px; font-size:.78rem; }
        .empty-state   { grid-column:1/-1; text-align:center; padding:40px 16px;
                         color:var(--text-sec); font-size:.9rem; }
        .frm-add-campo { display:flex; gap:6px; margin-bottom:8px; }
        .frm-add-campo select { flex:1; }
      </style>
    `;

    // Tabs
    container.querySelectorAll(".frm-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        container.querySelectorAll(".frm-tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        _tabActual = btn.dataset.tab;
        const btnNuevo = document.getElementById("frmBtnNuevo");
        if (btnNuevo) btnNuevo.style.display = _tabActual === "plantillas" ? "" : "none";
        if (_tabActual === "plantillas") {
          _renderPlantillas();
        } else {
          _suscribirRespuestas();
        }
      });
    });

    document.getElementById("frmBtnNuevo").addEventListener("click", () => _abrirModal(null));

    _unsubForms = onSnapshot(collection(db, "formularios"), snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === "removed") delete _formularios[ch.doc.id];
        else _formularios[ch.doc.id] = { id: ch.doc.id, ...ch.doc.data() };
      });
      if (_tabActual === "plantillas") _renderPlantillas();
    });
  },

  destroy() {
    _unsubForms?.();
    _unsubResp?.();
    _unsubForms = _unsubResp = null;
    _formularios = {}; _respuestas = [];
    _tabActual = "plantillas"; _formSeleccionado = null;
  }
};

// ── Suscripción en tiempo real a respuestas ────────────────────────────────────
function _suscribirRespuestas() {
  if (_unsubResp) return; // ya activa
  const wrap = document.getElementById("frmContenido");
  if (wrap) wrap.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Cargando respuestas…</div>`;

  _unsubResp = onSnapshot(
    query(collection(db, "respuestas_formulario"), limit(200)),
    snap => {
      const docs = [...snap.docs]
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.timestamp?.seconds ?? 0) - (a.timestamp?.seconds ?? 0));
      _respuestas = docs;
      _renderTablaRespuestas(docs);
    },
    () => {
      const w = document.getElementById("frmContenido");
      if (w) w.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Error cargando respuestas.</div>`;
    }
  );
}

// ── Tab: Plantillas ────────────────────────────────────────────────────────────
function _renderPlantillas() {
  const wrap = document.getElementById("frmContenido");
  if (!wrap) return;
  const lista = Object.values(_formularios).sort((a, b) =>
    (a.titulo || "").localeCompare(b.titulo || ""));

  if (lista.length === 0) {
    wrap.innerHTML = `<div class="empty-state">Sin plantillas. Crea la primera con "+ Nueva plantilla".</div>`;
    return;
  }

  wrap.innerHTML = lista.map(f => {
    const campos = f.campos || [];
    const chips = campos.slice(0, 5).map(c =>
      `<span class="frm-campo-chip">${esc(c.etiqueta || c.tipo)}</span>`
    ).join("") + (campos.length > 5 ? `<span class="frm-campo-chip">+${campos.length - 5}</span>` : "");
    return `
      <div class="frm-card ${f.activo === false ? "inactivo" : ""}">
        <div class="frm-card-name">${esc(f.titulo)}</div>
        <div class="frm-card-meta">
          ${campos.length} campo${campos.length !== 1 ? "s" : ""} &nbsp;·&nbsp;
          ${f.activo !== false ? "✅ Activo" : "⛔ Inactivo"}
          ${f.asignadoA?.length ? ` &nbsp;·&nbsp; ${esc(f.asignadoA.join(", "))}` : " &nbsp;·&nbsp; Todos"}
        </div>
        ${f.descripcion ? `<div class="frm-card-meta">${esc(f.descripcion)}</div>` : ""}
        <div class="frm-card-campos">${chips}</div>
        <div class="frm-card-actions">
          <button class="btn-primary btn-sm" onclick="_frmEditar('${esc(f.id)}')">Editar</button>
          <button class="btn-success btn-sm" onclick="_frmVerRespuestas('${esc(f.id)}')">Ver respuestas</button>
          <button class="btn-danger btn-sm" onclick="_frmEliminar('${esc(f.id)}')">Eliminar</button>
        </div>
      </div>
    `;
  }).join("");
}

// ── Tab: Respuestas globales ───────────────────────────────────────────────────
function _renderTablaRespuestas(docs) {
  const wrap = document.getElementById("frmContenido");
  if (!wrap) return;

  if (!docs.length) {
    wrap.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Sin respuestas registradas aún.</div>`;
    return;
  }

  wrap.innerHTML = `
    <div style="grid-column:1/-1">
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <button id="frmBtnExportar" class="btn-secondary btn-sm">⬇ Exportar Excel</button>
      </div>
      <div style="overflow-x:auto;border:1px solid var(--border,#e2e8f0);border-radius:10px">
        <table style="width:100%;border-collapse:collapse;font-size:.84rem">
          <thead>
            <tr style="background:var(--surface-2,#f8fafc);text-align:left">
              <th style="padding:9px 12px;font-size:.76rem;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em">Formulario</th>
              <th style="padding:9px 12px;font-size:.76rem;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em">Ingeniero</th>
              <th style="padding:9px 12px;font-size:.76rem;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em">Cliente</th>
              <th style="padding:9px 12px;font-size:.76rem;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em">Fecha</th>
              <th style="padding:9px 12px;font-size:.76rem;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em">Ver</th>
            </tr>
          </thead>
          <tbody>
            ${docs.map(r => `
              <tr style="border-top:1px solid var(--border,#e2e8f0)">
                <td style="padding:8px 12px">${esc(r.formularioTitulo || r.formularioId)}</td>
                <td style="padding:8px 12px">${esc(r.aliasIngeniero || "–")}</td>
                <td style="padding:8px 12px">${esc(r.clienteNombre || "–")}</td>
                <td style="padding:8px 12px;white-space:nowrap;font-size:.8rem">${_fmtFecha(r.timestamp)}</td>
                <td style="padding:8px 12px">
                  <button class="btn-primary btn-sm frm-btn-ver" data-id="${esc(r.id)}">Ver</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;

  wrap.querySelectorAll(".frm-btn-ver").forEach(btn =>
    btn.addEventListener("click", () => _frmVerRespuestaById(btn.dataset.id))
  );

  wrap.querySelector("#frmBtnExportar")?.addEventListener("click", () => _exportarRespuestas(docs));
}

// ── Panel lateral: respuestas de una plantilla ─────────────────────────────────
window._frmVerRespuestas = async id => {
  _formSeleccionado = id;
  const form = _formularios[id];
  const panel = document.getElementById("frmRespPanel");
  const titulo = document.getElementById("frmRespTitulo");
  const body   = document.getElementById("frmRespBody");

  titulo.textContent = `Respuestas: ${form?.titulo || id}`;
  body.innerHTML = `<div style="padding:12px;color:var(--text-sec)">Cargando…</div>`;
  panel.style.display = "flex";
  _regEsc(window._frmCerrarResp);

  try {
    const q = query(
      collection(db, "respuestas_formulario"),
      where("formularioId", "==", id),
      limit(50)
    );
    const snap = await getDocs(q);
    if (snap.empty) { body.innerHTML = `<div style="padding:12px">Sin respuestas para esta plantilla.</div>`; return; }

    const docsOrdenados = [...snap.docs].sort((a, b) =>
      (b.data().timestamp?.seconds ?? 0) - (a.data().timestamp?.seconds ?? 0)
    );
    const campos = form?.campos || [];
    body.innerHTML = docsOrdenados.map(d => {
      const r = d.data();
      const filas = campos.map(c => {
        const val = r.respuestas?.[c.id];
        let valHtml;
        if (c.tipo === "foto" && val) {
          valHtml = `<a href="${esc(val)}" target="_blank" rel="noopener">
            <img src="${esc(val)}" alt="foto" style="max-width:120px;max-height:80px;
              border-radius:6px;border:1px solid var(--border);cursor:zoom-in;object-fit:cover">
          </a>`;
        } else {
          valHtml = esc(Array.isArray(val) ? val.join(", ") : (val ?? "–"));
        }
        return `<div class="frm-resp-row">
          <span class="frm-resp-label">${esc(c.etiqueta)}</span>
          <span>${valHtml}</span>
        </div>`;
      }).join("");
      return `<div class="frm-resp-card">
        <div class="frm-resp-meta">
          👤 ${esc(r.aliasIngeniero || "–")} &nbsp;·&nbsp;
          🏭 ${esc(r.clienteNombre || "–")} &nbsp;·&nbsp;
          📅 ${_fmtFecha(r.timestamp)}
        </div>
        ${filas || "<em>Sin datos</em>"}
      </div>`;
    }).join("");
  } catch (e) {
    body.innerHTML = `<div style="padding:12px">Error al cargar.</div>`;
  }
};

window._frmCerrarResp = () => {
  _unregEsc();
  document.getElementById("frmRespPanel").style.display = "none";
};

window._frmVerRespuesta = id => _frmVerRespuestaById(id);

async function _frmVerRespuestaById(id) {
  // Primero busca en caché local, si no, consulta Firestore directamente
  let r = _respuestas.find(x => x.id === id);
  if (!r) {
    try {
      const snap = await getDoc(doc(db, "respuestas_formulario", id));
      if (!snap.exists()) return;
      r = { id: snap.id, ...snap.data() };
    } catch { return; }
  }
  window._frmVerRespuestas(r.formularioId);
}

// ── Acciones de plantilla ──────────────────────────────────────────────────────
window._frmEditar   = id => _abrirModal(id);
window._frmEliminar = async id => {
  const confirmar = window.modal
    ? await window.modal({ title: "Eliminar plantilla", message: "¿Eliminar esta plantilla? Las respuestas existentes no se borrarán.", danger: true, confirmLabel: "Eliminar" })
    : confirm("¿Eliminar esta plantilla?");
  if (!confirmar) return;
  await deleteDoc(doc(db, "formularios", id));
};

// ── Modal de plantilla ─────────────────────────────────────────────────────────
let _camposEnEdicion = [];  // [{id, tipo, etiqueta, obligatorio, opciones}]

function _abrirModal(id) {
  const f = id ? _formularios[id] : null;
  _camposEnEdicion = f?.campos ? JSON.parse(JSON.stringify(f.campos)) : [];

  document.getElementById("frmModal").innerHTML = `
    <div class="frm-m-title">${id ? "Editar plantilla" : "Nueva plantilla"}</div>
    <div class="frm-field">
      <label>Título del formulario</label>
      <input id="fmTitulo" type="text" maxlength="100" value="${esc(f?.titulo ?? "")}" placeholder="Nombre del formulario" />
    </div>
    <div class="frm-field">
      <label>Descripción</label>
      <input id="fmDesc" type="text" maxlength="250" value="${esc(f?.descripcion ?? "")}" />
    </div>
    <div class="frm-field">
      <label>Asignado a (alias, separados por coma — vacío = todos)</label>
      <input id="fmAsignado" type="text" value="${esc((f?.asignadoA || []).join(", "))}" placeholder="PEDRO, JUAN, …" />
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <div class="frm-field" style="flex:1">
        <label>Estado</label>
        <select id="fmActivo">
          <option value="1" ${f?.activo !== false ? "selected" : ""}>Activo</option>
          <option value="0" ${f?.activo === false ? "selected" : ""}>Inactivo</option>
        </select>
      </div>
    </div>

    <div style="font-size:.85rem;font-weight:700;margin-bottom:6px">Campos del formulario</div>
    <div id="fmCamposLista" class="frm-campos-lista"></div>

    <div class="frm-add-campo">
      <select id="fmNuevoCampoTipo">
        ${TIPOS_CAMPO.map(t => `<option value="${t.valor}">${t.label}</option>`).join("")}
      </select>
      <button class="btn-secondary btn-sm" onclick="_fmAgregarCampo()">+ Agregar campo</button>
    </div>

    <div class="frm-m-actions">
      <button class="btn-primary" id="fmBtnGuardar">Guardar</button>
      <button class="btn-secondary" id="fmBtnCancelar">Cancelar</button>
    </div>
  `;

  document.getElementById("frmModalOverlay").style.display = "flex";
  _regEsc(_cerrarModal);
  _renderCamposModal();

  document.getElementById("fmBtnGuardar").addEventListener("click", () => _guardarPlantilla(id));
  document.getElementById("fmBtnCancelar").addEventListener("click", _cerrarModal);
  document.getElementById("frmModalOverlay").addEventListener("click", e => {
    if (e.target === document.getElementById("frmModalOverlay")) _cerrarModal();
  });
}

function _cerrarModal() {
  _unregEsc();
  document.getElementById("frmModalOverlay").style.display = "none";
}

function _renderCamposModal() {
  const lista = document.getElementById("fmCamposLista");
  if (!lista) return;
  if (_camposEnEdicion.length === 0) {
    lista.innerHTML = `<div style="font-size:.82rem;color:var(--text-sec);padding:6px 0">Sin campos. Agrega al menos uno.</div>`;
    return;
  }
  lista.innerHTML = _camposEnEdicion.map((c, i) => `
    <div class="frm-campo-item" data-i="${i}">
      <span class="frm-campo-drag">⠿</span>
      <div class="frm-campo-info">
        <div>${esc(c.etiqueta || "(sin etiqueta)")}</div>
        <div class="frm-campo-tipo">${_labelTipo(c.tipo)}${c.obligatorio ? " · Obligatorio" : ""}</div>
        ${c.tipo === "seleccion" || c.tipo === "multiple"
          ? `<div class="frm-campo-tipo">Opciones: ${esc((c.opciones || []).join(", "))}</div>` : ""}
      </div>
      <button class="btn-secondary btn-sm" onclick="_fmEditarCampo(${i})">✏</button>
      <button class="btn-danger btn-sm" onclick="_fmEliminarCampo(${i})">✕</button>
    </div>
  `).join("");
}

window._fmAgregarCampo = () => {
  const tipo = document.getElementById("fmNuevoCampoTipo").value;
  _camposEnEdicion.push({
    id: `campo_${Date.now()}`,
    tipo,
    etiqueta: "",
    obligatorio: false,
    opciones: []
  });
  _renderCamposModal();
  // Abrir edición del nuevo campo inmediatamente
  _fmEditarCampo(_camposEnEdicion.length - 1);
};

window._fmEliminarCampo = i => {
  _camposEnEdicion.splice(i, 1);
  _renderCamposModal();
};

window._fmEditarCampo = i => {
  const c = _camposEnEdicion[i];
  const dlg = document.createElement("div");
  dlg.className = "frm-modal-overlay";
  dlg.style.zIndex = "300";
  dlg.innerHTML = `
    <div class="frm-modal">
      <div class="frm-m-title">Configurar campo: ${_labelTipo(c.tipo)}</div>
      <div class="frm-field">
        <label>Etiqueta (texto que ve el ingeniero)</label>
        <input id="ceEtiqueta" type="text" maxlength="100" value="${esc(c.etiqueta)}" />
      </div>
      <div class="frm-field">
        <label><input id="ceObligatorio" type="checkbox" ${c.obligatorio ? "checked" : ""} style="width:auto;margin-right:6px">Obligatorio</label>
      </div>
      ${c.tipo === "seleccion" || c.tipo === "multiple" ? `
        <div class="frm-field">
          <label>Opciones (una por línea)</label>
          <textarea id="ceOpciones" rows="4">${esc((c.opciones || []).join("\n"))}</textarea>
        </div>
      ` : ""}
      ${c.tipo === "texto" || c.tipo === "numero" ? `
        <div class="frm-field">
          <label>Placeholder</label>
          <input id="cePlaceholder" type="text" maxlength="100" value="${esc(c.placeholder || "")}" />
        </div>
      ` : ""}
      <div class="frm-m-actions">
        <button class="btn-primary" id="ceBtnOk">Aceptar</button>
        <button class="btn-secondary" id="ceBtnCancelar">Cancelar</button>
      </div>
    </div>
  `;
  document.body.appendChild(dlg);

  const cerrar = () => document.body.removeChild(dlg);

  dlg.querySelector("#ceBtnOk").addEventListener("click", () => {
    _camposEnEdicion[i] = {
      ...c,
      etiqueta:     dlg.querySelector("#ceEtiqueta").value.trim(),
      obligatorio:  dlg.querySelector("#ceObligatorio").checked,
      opciones:     dlg.querySelector("#ceOpciones")
        ? dlg.querySelector("#ceOpciones").value.split("\n").map(l => l.trim()).filter(Boolean)
        : c.opciones,
      placeholder:  dlg.querySelector("#cePlaceholder")?.value.trim() || ""
    };
    cerrar();
    _renderCamposModal();
  });
  dlg.querySelector("#ceBtnCancelar").addEventListener("click", cerrar);
};

async function _guardarPlantilla(id) {
  const titulo   = document.getElementById("fmTitulo").value.trim();
  const desc     = document.getElementById("fmDesc").value.trim();
  const activo   = document.getElementById("fmActivo").value === "1";
  const asignado = document.getElementById("fmAsignado").value
    .split(",").map(s => s.trim()).filter(Boolean);

  if (!titulo) { window.toast?.("El título es obligatorio.", "warn"); return; }
  if (_camposEnEdicion.length === 0) { window.toast?.("Agrega al menos un campo.", "warn"); return; }

  const btn = document.getElementById("fmBtnGuardar");
  if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }

  const datos = {
    titulo, descripcion: desc, activo,
    asignadoA: asignado,
    campos: _camposEnEdicion,
    actualizadoPor: Sesion.alias,
    updatedAt: serverTimestamp()
  };

  try {
    if (id) {
      await setDoc(doc(db, "formularios", id), datos, { merge: true });
    } else {
      datos.creadoPor = Sesion.alias;
      datos.createdAt = serverTimestamp();
      await addDoc(collection(db, "formularios"), datos);
    }
    _cerrarModal();
  } catch (e) {
    window.toast?.("Error al guardar: " + e.message, "error");
    if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
  }
}

// ── Exportar respuestas a Excel ───────────────────────────────────────────────
function _exportarRespuestas(docs) {
  const cols = [
    { key: "formularioTitulo", header: "Formulario",  width: 28 },
    { key: "aliasIngeniero",   header: "Ingeniero",   width: 18 },
    { key: "clienteNombre",    header: "Cliente",     width: 28 },
    { key: "clienteId",        header: "Cliente ID",  width: 16 },
    { key: "fecha",            header: "Fecha",       width: 20 },
  ];
  // Recolectar todas las etiquetas de campos únicos que aparezcan en las respuestas
  const camposIdx = {};
  docs.forEach(r => {
    const form = _formularios[r.formularioId];
    (form?.campos || []).forEach(c => {
      if (!camposIdx[c.id]) {
        camposIdx[c.id] = c.etiqueta || c.id;
        cols.push({ key: `resp_${c.id}`, header: c.etiqueta || c.id, width: 22 });
      }
    });
  });
  const rows = docs.map(r => {
    const row = {
      formularioTitulo: r.formularioTitulo || r.formularioId || "",
      aliasIngeniero:   r.aliasIngeniero   || "",
      clienteNombre:    r.clienteNombre    || "",
      clienteId:        r.clienteId        || "",
      fecha:            _fmtFecha(r.timestamp),
    };
    Object.keys(camposIdx).forEach(cid => {
      const val = r.respuestas?.[cid];
      row[`resp_${cid}`] = Array.isArray(val) ? val.join(", ") : (val ?? "");
    });
    return row;
  });
  exportarExcel(rows, cols, `respuestas_formularios_${new Date().toISOString().slice(0,10)}.xlsx`, "Respuestas");
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function _labelTipo(tipo) {
  return TIPOS_CAMPO.find(t => t.valor === tipo)?.label ?? tipo;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _fmtFecha(ts) {
  if (!ts) return "–";
  const d = typeof ts === "number" ? new Date(ts) : ts?.toDate?.() ?? new Date(ts);
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit" });
}
