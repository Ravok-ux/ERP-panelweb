/**
 * Módulo Geocercas — N-10 Web Panel
 * Gestiona zonas autorizadas (círculos en mapa) configurables desde el web panel.
 * Los ingenieros APK descargan estas geocercas al hacer login y validan su posición localmente.
 */

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const GMAPS_KEY = "AIzaSyCl9_ouMqIVy1RBwRqBzLU0cjGJUsLIUGE";
let _gmapsLoaded = false;
let _gmapsLoading = false;
async function _loadGMaps() {
  if (typeof google !== "undefined" && google.maps) { _gmapsLoaded = true; return; }
  if (_gmapsLoaded) return;
  if (_gmapsLoading) {
    await new Promise(r => { const t = setInterval(() => { if (_gmapsLoaded) { clearInterval(t); r(); } }, 100); });
    return;
  }
  _gmapsLoading = true;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GMAPS_KEY}&libraries=places&language=es`;
    s.async = true; s.defer = true;
    s.onload  = () => { _gmapsLoaded = true; resolve(); };
    s.onerror = () => reject(new Error("Error cargando Google Maps"));
    document.head.appendChild(s);
  });
}

// ── Estado del módulo ──────────────────────────────────────────────────────────
let _map = null;
let _circles = {};          // id → google.maps.Circle
let _markers = {};          // id → google.maps.Marker (etiqueta de nombre)
let _unsubGeocercas = null;
let _geocercas = {};        // id → datos
let _modoEdicion = null;    // null | { tipo: 'nueva'|'editando', id?: string }
let _circuloTemporal = null;
let _markerDrag = null;

// ── Render principal ───────────────────────────────────────────────────────────
export const GeocercasModule = {

  mount(container) { this.render(container); },

  async render(container) {
    container.innerHTML = `
      <div class="geo-shell">
        <div class="geo-header">
          <h2 class="geo-title">🗺 Geocercas</h2>
          <button class="btn-primary" id="gBtnNueva">+ Nueva geocerca</button>
        </div>

        <div class="geo-body">
          <!-- Panel lateral: lista + formulario -->
          <div class="geo-sidebar">
            <div id="gLista" class="geo-lista"></div>
            <div id="gForm" class="geo-form" style="display:none"></div>
          </div>

          <!-- Mapa -->
          <div id="gMapCanvas" class="geo-map"></div>
        </div>
      </div>

      <style>
        .geo-shell { display:flex; flex-direction:column; height:100%; gap:0; }
        .geo-header { display:flex; align-items:center; justify-content:space-between;
                      padding:12px 16px; border-bottom:1px solid var(--border,#e2e8f0); }
        .geo-title  { margin:0; font-size:1.1rem; font-weight:700; }
        .geo-body   { display:flex; flex:1; overflow:hidden; }
        .geo-sidebar{ width:300px; min-width:260px; display:flex; flex-direction:column;
                      border-right:1px solid var(--border,#e2e8f0); overflow-y:auto; }
        .geo-map    { flex:1; }
        .geo-lista  { flex:1; padding:8px; }
        .geo-card   { background:var(--card-bg,#fff); border:1px solid var(--border,#e2e8f0);
                      border-radius:8px; padding:10px 12px; margin-bottom:8px; cursor:pointer;
                      transition:box-shadow .15s; }
        .geo-card:hover { box-shadow:0 2px 8px rgba(0,0,0,.12); }
        .geo-card.activa { border-left:4px solid var(--accent,#3b82f6); }
        .geo-card.inactiva { opacity:.55; }
        .geo-card-name { font-weight:600; font-size:.9rem; }
        .geo-card-meta { font-size:.78rem; color:var(--text-sec); margin-top:3px; }
        .geo-card-actions { display:flex; gap:6px; margin-top:8px; }
        .geo-form   { padding:12px; border-top:1px solid var(--border,#e2e8f0); }
        .geo-form h3{ margin:0 0 10px; font-size:.95rem; }
        .geo-field  { margin-bottom:10px; }
        .geo-field label { display:block; font-size:.8rem; font-weight:600;
                           margin-bottom:3px; color:var(--text-sec); }
        .geo-field input,.geo-field textarea,.geo-field select
                    { width:100%; padding:6px 8px; border:1px solid var(--border,#30363d);
                      background:var(--card-bg,#161B22); color:var(--text-primary,#E6EDF3);
                      border-radius:6px; font-size:.88rem; box-sizing:border-box; }
        .geo-form-actions { display:flex; gap:8px; margin-top:12px; }
        .btn-primary{ background:var(--accent,#3b82f6); color:#fff; border:none;
                      padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .btn-secondary{ background:transparent; border:1px solid var(--border,#30363d);
                        color:var(--text-primary,#E6EDF3);
                        padding:7px 14px; border-radius:6px; cursor:pointer; font-size:.88rem; }
        .btn-danger { background:#ef4444; color:#fff; border:none;
                      padding:5px 10px; border-radius:6px; cursor:pointer; font-size:.8rem; }
        .btn-sm     { padding:4px 10px; font-size:.78rem; }
        .geo-radio-hint { font-size:.78rem; color:var(--text-sec); margin-top:4px; }
        @media(max-width:700px){
          .geo-body { flex-direction:column; }
          .geo-sidebar { width:100%; border-right:none; border-bottom:1px solid var(--border,#e2e8f0); max-height:260px; }
          .geo-map  { height:300px; }
        }
      </style>
    `;

    try {
      await _loadGMaps();
    } catch(e) {
      container.querySelector("#gMapCanvas").innerHTML =
        `<div style="padding:40px;text-align:center;color:#EF4444">
          ⚠️ Error cargando Google Maps. Verifica tu conexión e intenta de nuevo.</div>`;
      return;
    }
    _initMap(container.querySelector("#gMapCanvas"));

    document.getElementById("gBtnNueva").addEventListener("click", () => _abrirFormulario(null));

    _unsubGeocercas = onSnapshot(collection(db, "geocercas"), snap => {
      snap.docChanges().forEach(change => {
        const id = change.doc.id;
        const d  = change.doc.data();
        if (change.type === "removed") {
          _geocercas[id] && delete _geocercas[id];
          _eliminarCirculo(id);
        } else {
          _geocercas[id] = { id, ...d };
          _dibujarCirculo({ id, ...d });
        }
      });
      _renderLista();
    });
  },

  destroy() {
    _unsubGeocercas?.();
    _unsubGeocercas = null;
    Object.values(_circles).forEach(c => c.setMap(null));
    Object.values(_markers).forEach(m => m.setMap(null));
    _circles = {}; _markers = {}; _geocercas = {};
    _circuloTemporal?.setMap(null); _circuloTemporal = null;
    _markerDrag?.setMap(null);      _markerDrag = null;
    _map = null; _modoEdicion = null;
  }
};

// ── Mapa ───────────────────────────────────────────────────────────────────────
function _initMap(canvas) {
  _map = new google.maps.Map(canvas, {
    center: { lat: 18.68, lng: -99.10 },
    zoom: 10,
    mapTypeId: "roadmap"
  });
  _map.addListener("click", e => {
    if (_modoEdicion) _moverCentroTemporal(e.latLng.lat(), e.latLng.lng());
  });
}

function _dibujarCirculo(g) {
  _eliminarCirculo(g.id);
  if (!_map) return;

  const color = g.color || "#4ADE80";
  const circle = new google.maps.Circle({
    map: _map,
    center: { lat: g.lat, lng: g.lng },
    radius: g.radioMetros || 300,
    strokeColor: color,
    strokeOpacity: 0.9,
    strokeWeight: 2,
    fillColor: color,
    fillOpacity: g.activa ? 0.18 : 0.07,
    clickable: true
  });
  circle.addListener("click", () => _abrirFormulario(g.id));

  const label = new google.maps.Marker({
    map: _map,
    position: { lat: g.lat, lng: g.lng },
    label: { text: g.nombre || g.id, color: "#1e293b", fontSize: "12px", fontWeight: "bold" },
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 0 }
  });

  _circles[g.id] = circle;
  _markers[g.id] = label;
}

function _eliminarCirculo(id) {
  _circles[id]?.setMap(null); delete _circles[id];
  _markers[id]?.setMap(null); delete _markers[id];
}

function _moverCentroTemporal(lat, lng) {
  if (!_circuloTemporal || !_markerDrag) return;
  const pos = { lat, lng };
  _circuloTemporal.setCenter(pos);
  _markerDrag.setPosition(pos);
  document.getElementById("gInputLat").value = lat.toFixed(6);
  document.getElementById("gInputLng").value = lng.toFixed(6);
}

// ── Lista lateral ──────────────────────────────────────────────────────────────
function _renderLista() {
  const lista = document.getElementById("gLista");
  if (!lista) return;
  const todas = Object.values(_geocercas).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));
  if (todas.length === 0) {
    lista.innerHTML = `<p style="color:var(--text-sec);font-size:.85rem;padding:8px">
      Sin geocercas. Crea la primera con el botón superior.</p>`;
    return;
  }
  lista.innerHTML = todas.map(g => `
    <div class="geo-card ${g.activa ? 'activa' : 'inactiva'}" data-id="${esc(g.id)}">
      <div class="geo-card-name">${esc(g.nombre || g.id)}</div>
      <div class="geo-card-meta">Radio: ${g.radioMetros}m · ${g.activa ? '✅ Activa' : '⛔ Inactiva'}</div>
      ${g.descripcion ? `<div class="geo-card-meta">${esc(g.descripcion)}</div>` : ""}
      <div class="geo-card-actions">
        <button class="btn-primary btn-sm" onclick="_gEditar('${esc(g.id)}')">Editar</button>
        <button class="btn-secondary btn-sm" onclick="_gCentrar('${esc(g.id)}')">Ver</button>
        <button class="btn-danger btn-sm" onclick="_gEliminar('${esc(g.id)}')">Eliminar</button>
      </div>
    </div>
  `).join("");
}

window._gEditar   = id => _abrirFormulario(id);
window._gCentrar  = id => {
  const g = _geocercas[id];
  if (g && _map) _map.panTo({ lat: g.lat, lng: g.lng });
};
window._gEliminar = async id => {
  if (!await window.modal({ title: "Eliminar geocerca", message: "¿Eliminar esta geocerca permanentemente?", danger: true, confirmLabel: "Eliminar" })) return;
  try {
    await deleteDoc(doc(db, "geocercas", id));
  } catch (e) {
    console.error("[geocercas] Error al eliminar:", e);
    window.toast?.("Error al eliminar la geocerca. Intenta de nuevo.", "error");
  }
};

// ── Formulario ─────────────────────────────────────────────────────────────────
function _abrirFormulario(id) {
  _modoEdicion = { tipo: id ? "editando" : "nueva", id };
  const g = id ? _geocercas[id] : null;

  const lat = g?.lat ?? _map?.getCenter()?.lat() ?? 24.8;
  const lng = g?.lng ?? _map?.getCenter()?.lng() ?? -107.4;
  const radio = g?.radioMetros ?? 300;

  // Círculo temporal de edición
  _circuloTemporal?.setMap(null);
  _markerDrag?.setMap(null);

  _circuloTemporal = new google.maps.Circle({
    map: _map,
    center: { lat, lng },
    radius: radio,
    strokeColor: "#f59e0b",
    strokeWeight: 2,
    fillColor: "#f59e0b",
    fillOpacity: 0.25,
    editable: false,
    clickable: false
  });

  _markerDrag = new google.maps.Marker({
    map: _map,
    position: { lat, lng },
    draggable: true,
    label: { text: "✛", color: "#1e293b", fontWeight: "bold" }
  });
  _markerDrag.addListener("drag", e => {
    const pos = e.latLng;
    _circuloTemporal.setCenter(pos);
    document.getElementById("gInputLat").value = pos.lat().toFixed(6);
    document.getElementById("gInputLng").value = pos.lng().toFixed(6);
  });

  if (_map) _map.panTo({ lat, lng });

  const form = document.getElementById("gForm");
  form.style.display = "block";
  form.innerHTML = `
    <h3>${id ? "Editar geocerca" : "Nueva geocerca"}</h3>
    <div class="geo-field">
      <label>Nombre</label>
      <input id="gInputNombre" type="text" maxlength="80"
             value="${esc(g?.nombre ?? "")}" placeholder="Nombre de la zona" />
    </div>
    <div class="geo-field">
      <label>Radio (metros)</label>
      <input id="gInputRadio" type="number" min="50" max="50000"
             value="${radio}" />
      <div class="geo-radio-hint">Mueve el marcador en el mapa para reposicionar el centro.</div>
    </div>
    <div class="geo-field">
      <label>Lat / Lng (centro)</label>
      <div style="display:flex;gap:6px">
        <input id="gInputLat" type="number" step="any" value="${lat.toFixed(6)}" placeholder="Lat" />
        <input id="gInputLng" type="number" step="any" value="${lng.toFixed(6)}" placeholder="Lng" />
      </div>
    </div>
    <div class="geo-field">
      <label>Color</label>
      <input id="gInputColor" type="color" value="${g?.color ?? "#4ADE80"}" style="height:32px;padding:2px 4px" />
    </div>
    <div class="geo-field">
      <label>Ingenieros autorizados (alias, uno por línea)</label>
      <textarea id="gInputAlias" rows="3" placeholder="PEDRO\nJUAN\n…">${_jsonArrayToLines(g?.aliasAutorizados)}</textarea>
    </div>
    <div class="geo-field">
      <label>Correos de alerta (uno por línea)</label>
      <textarea id="gInputEmails" rows="2" placeholder="jefe@empresa.com">${_jsonArrayToLines(g?.emailsAlerta)}</textarea>
    </div>
    <div class="geo-field">
      <label>Descripción</label>
      <input id="gInputDesc" type="text" maxlength="200" value="${esc(g?.descripcion ?? "")}" />
    </div>
    <div class="geo-field">
      <label>Estado</label>
      <select id="gInputActiva">
        <option value="1" ${(g?.activa ?? true) ? "selected" : ""}>Activa</option>
        <option value="0" ${!(g?.activa ?? true) ? "selected" : ""}>Inactiva</option>
      </select>
    </div>
    <div class="geo-form-actions">
      <button class="btn-primary" id="gBtnGuardar">Guardar</button>
      <button class="btn-secondary" id="gBtnCancelar">Cancelar</button>
    </div>
  `;

  // Sincronizar radio con el círculo temporal
  document.getElementById("gInputRadio").addEventListener("input", e => {
    const r = parseInt(e.target.value) || 300;
    _circuloTemporal?.setRadius(r);
  });

  document.getElementById("gBtnGuardar").addEventListener("click", _guardar);
  document.getElementById("gBtnCancelar").addEventListener("click", _cerrarFormulario);
}

function _cerrarFormulario() {
  _modoEdicion = null;
  _circuloTemporal?.setMap(null); _circuloTemporal = null;
  _markerDrag?.setMap(null);      _markerDrag = null;
  const form = document.getElementById("gForm");
  if (form) form.style.display = "none";
}

async function _guardar() {
  const nombre  = document.getElementById("gInputNombre").value.trim();
  const latVal  = parseFloat(document.getElementById("gInputLat").value);
  const lngVal  = parseFloat(document.getElementById("gInputLng").value);
  const radio   = parseInt(document.getElementById("gInputRadio").value) || 300;
  const color   = document.getElementById("gInputColor").value;
  const activa  = document.getElementById("gInputActiva").value === "1";
  const desc    = document.getElementById("gInputDesc").value.trim();
  const alias   = _linesToJsonArray(document.getElementById("gInputAlias").value);
  const emails  = _linesToJsonArray(document.getElementById("gInputEmails").value);

  if (!nombre) { window.toast?.("El nombre es obligatorio.", "warn"); return; }
  if (isNaN(latVal) || isNaN(lngVal)) { window.toast?.("Coordenadas inválidas.", "warn"); return; }

  const datos = {
    nombre, lat: latVal, lng: lngVal, radioMetros: radio,
    color, activa, descripcion: desc,
    aliasAutorizados: alias,
    emailsAlerta: emails,
    actualizadoPor: Sesion.alias,
    updatedAt: serverTimestamp()
  };

  const id = _modoEdicion?.id;
  if (id) {
    await updateDoc(doc(db, "geocercas", id), datos);
  } else {
    datos.creadoPor = Sesion.alias;
    datos.createdAt = serverTimestamp();
    await addDoc(collection(db, "geocercas"), datos);
  }
  _cerrarFormulario();
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _jsonArrayToLines(json) {
  if (!json) return "";
  try { return JSON.parse(json).join("\n"); } catch { return ""; }
}

function _linesToJsonArray(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  return JSON.stringify(lines);
}
