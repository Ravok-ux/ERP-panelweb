/**
 * agroquimico.js — Módulo Agroquímico
 *
 * Tabs:
 *   calendario   — Calendario agrícola por cultivo/región con ventanas de aplicación óptima
 *   recetas      — Gestor de recetas de dosis y mezcla de productos
 *   trazabilidad — Trazabilidad campo → cultivo → venta
 */

import { db } from "./firebase-config.js";
import { esc } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, query, where, orderBy, limit, getDocs, addDoc,
  doc, setDoc, deleteDoc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { Sesion } from "./auth.js";

// ── ESC helper ───────────────────────────────────────────────
let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

// ── Constantes ────────────────────────────────────────────────
const CULTIVOS = ["Maíz","Jitomate","Chile","Papa","Cebolla","Sorgo","Trigo","Frijol","Aguacate","Cítricos","Mango","Caña","Alfalfa","Otro"];
const ETAPAS   = ["Germinación","Plántula","Vegetativo","Floración","Fructificación","Maduración","Cosecha","Post-cosecha"];
const MESES    = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
const UNIDADES = ["L/ha","kg/ha","ml/ha","g/ha","L/100L","ml/100L","g/100L"];

const ETAPA_COLOR = {
  "Germinación":    { bg:"#DCFCE7", col:"#166534" },
  "Plántula":       { bg:"#D1FAE5", col:"#065F46" },
  "Vegetativo":     { bg:"#A7F3D0", col:"#064E3B" },
  "Floración":      { bg:"#FEF3C7", col:"#92400E" },
  "Fructificación": { bg:"#FED7AA", col:"#9A3412" },
  "Maduración":     { bg:"#FECACA", col:"#991B1B" },
  "Cosecha":        { bg:"#E0E7FF", col:"#3730A3" },
  "Post-cosecha":   { bg:"#F3F4F6", col:"#374151" },
};
const etapaColor = e => ETAPA_COLOR[e] ?? { bg:"#F1F5F9", col:"#475569" };

const el  = id => document.getElementById(id);
const fmt = ts => ts ? new Date(ts).toLocaleDateString("es-MX",{day:"2-digit",month:"short",year:"numeric"}) : "—";

// ── CSS ────────────────────────────────────────────────────────
const AQ_CSS = `
.aq-shell{display:flex;flex-direction:column;height:100%;min-height:0}
.aq-header{display:flex;align-items:center;gap:14px;padding:20px 24px 0;flex-wrap:wrap}
.aq-header-icon{font-size:28px;line-height:1}
.aq-header-title{margin:0;font-size:17px;font-weight:900;letter-spacing:-.3px}
.aq-header-sub{font-size:11px;color:var(--text-sec)}
.aq-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);padding:0 24px;margin-top:14px;overflow-x:auto;flex-shrink:0}
.aq-tab{padding:10px 18px;border:none;border-bottom:2px solid transparent;background:transparent;
  cursor:pointer;font-size:12px;font-weight:600;color:var(--text-sec);white-space:nowrap;transition:color .15s,border-color .15s}
.aq-tab.active{color:#6366F1;border-bottom-color:#6366F1;font-weight:800}
.aq-content{flex:1;min-height:0;overflow-y:auto;padding:20px 24px}

/* Sección header */
.aq-sec{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.aq-sec-title{margin:0;font-size:15px;font-weight:800;flex:1}
.aq-sel{padding:5px 10px;border:1px solid var(--border);border-radius:7px;font-size:12px;
  background:var(--surface);color:var(--text-primary);cursor:pointer}
.aq-input-search{padding:5px 10px;border:1px solid var(--border);border-radius:7px;font-size:12px;
  background:var(--surface);color:var(--text-primary);width:200px}

/* Botones */
.aq-btn-primary{padding:7px 16px;border-radius:8px;border:none;background:#6366F1;color:#fff;
  font-size:12px;font-weight:700;cursor:pointer;transition:opacity .15s}
.aq-btn-primary:hover{opacity:.88}
.aq-btn-primary.green{background:#16A34A}
.aq-btn-secondary{padding:7px 14px;border-radius:8px;border:1px solid var(--border);
  background:transparent;color:var(--text-sec);font-size:12px;cursor:pointer}
.aq-btn-icon{background:none;border:none;cursor:pointer;padding:3px 6px;border-radius:5px;font-size:14px;transition:background .15s}
.aq-btn-icon:hover{background:var(--surface-2)}
.aq-btn-filter{padding:6px 14px;border-radius:7px;border:1px solid var(--border);
  background:var(--surface);color:var(--text-primary);font-size:12px;cursor:pointer;font-weight:600}
.aq-btn-filter:hover{background:var(--surface-2)}

/* KPIs */
.aq-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.aq-kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:14px 16px;border-left:4px solid var(--kpi-color,#6366F1);display:flex;flex-direction:column;gap:4px}
.aq-kpi-val{font-size:22px;font-weight:900;color:var(--kpi-color,#6366F1);font-variant-numeric:tabular-nums}
.aq-kpi-label{font-size:11px;color:var(--text-sec);font-weight:600}

/* Badge de etapa */
.aq-badge{display:inline-flex;align-items:center;padding:2px 9px;border-radius:20px;font-size:10px;font-weight:700}

/* Leyenda */
.aq-leyenda{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}

/* Grid gantt */
.aq-gantt{overflow-x:auto;margin-bottom:20px;border:1px solid var(--border);border-radius:10px;padding:12px}
.aq-gantt-grid{display:grid;gap:2px;font-size:10px}
.aq-gantt-cell-hdr{padding:6px 2px;text-align:center;font-weight:700;color:var(--text-sec);
  border-bottom:1px solid var(--border)}
.aq-gantt-label{padding:5px 8px;font-weight:700;font-size:11px;align-self:center;
  border-right:1px solid var(--border)}
.aq-gantt-cell{border-radius:3px;min-height:28px;display:flex;align-items:center;
  justify-content:center;font-size:9px;font-weight:700;overflow:hidden;
  white-space:nowrap;padding:0 2px}
.aq-gantt-empty{background:var(--surface-2)}
.aq-gantt-mes-actual{background:#6366F120;border-radius:4px}

/* Tabla */
.aq-tbl{width:100%;border-collapse:collapse;font-size:12px}
.aq-tbl thead tr{background:var(--surface-2)}
.aq-tbl th{padding:9px 12px;text-align:left;font-size:10px;font-weight:700;
  color:var(--text-sec);text-transform:uppercase;letter-spacing:.04em}
.aq-tbl td{padding:8px 12px;border-top:1px solid var(--border)}
.aq-tbl tr:hover td{background:var(--surface-2)}
.aq-tbl-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}

/* Cards recetas */
.aq-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.aq-card{border:1px solid var(--border);border-radius:12px;padding:16px;
  background:var(--surface);display:flex;flex-direction:column;gap:10px;transition:box-shadow .15s}
.aq-card:hover{box-shadow:0 4px 16px rgba(0,0,0,.08)}
.aq-card-header{display:flex;align-items:flex-start;gap:10px}
.aq-card-title{font-weight:800;font-size:13px;margin-bottom:4px}
.aq-card-tags{display:flex;gap:5px;flex-wrap:wrap}
.aq-card-actions{display:flex;gap:4px;flex-shrink:0}
.aq-prod-tbl{width:100%;border-collapse:collapse;font-size:11px}
.aq-prod-tbl th{text-align:left;padding:2px 0;font-weight:700;font-size:9px;
  color:var(--text-sec);text-transform:uppercase}
.aq-prod-tbl td{padding:3px 0;border-top:1px solid var(--border)}
.aq-warn-note{font-size:10px;color:#D97706;background:#FEF3C7;border-radius:6px;padding:6px 9px}
.aq-agua-note{font-size:10px;color:var(--text-sec)}

/* Filtros trazabilidad */
.aq-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.aq-date-sep{font-size:11px;color:var(--text-sec)}

/* Modal */
.aq-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(3px);
  display:flex;align-items:flex-start;justify-content:center;z-index:200;overflow-y:auto;padding:24px 16px}
.aq-modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;
  width:100%;box-shadow:0 24px 64px rgba(0,0,0,.4);display:flex;flex-direction:column;max-height:90vh}
.aq-modal-head{display:flex;align-items:center;gap:10px;padding:16px 20px;
  border-bottom:1px solid var(--border);flex-shrink:0}
.aq-modal-head-icon{font-size:20px;line-height:1}
.aq-modal-head-title{flex:1;font-size:13px;font-weight:800}
.aq-modal-head-close{background:none;border:none;cursor:pointer;font-size:18px;
  color:var(--text-sec);padding:2px 6px;border-radius:5px;transition:background .15s}
.aq-modal-head-close:hover{background:var(--surface-2)}
.aq-modal-body{padding:18px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}
.aq-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;
  border-top:1px solid var(--border);flex-shrink:0}

/* Campos de formulario */
.aq-field label{display:block;font-size:10px;font-weight:700;color:var(--text-sec);
  text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}
.aq-field input,.aq-field select,.aq-field textarea{width:100%;padding:8px 10px;
  border:1px solid var(--border);border-radius:7px;font-size:12px;
  background:var(--surface);color:var(--text-primary);box-sizing:border-box}
.aq-field textarea{resize:vertical}
.aq-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.aq-grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}

/* Filas de producto en modal */
.aq-prod-row{display:grid;grid-template-columns:1fr 80px 80px 28px;gap:6px;align-items:center}
.aq-prod-search-wrap{position:relative}
.aq-prod-search{width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
  font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box}
.aq-prod-lista{display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;
  background:var(--surface);border:1px solid var(--border);border-radius:6px;
  max-height:130px;overflow-y:auto;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,.3)}
.aq-prod-lista-item{padding:7px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border)}
.aq-prod-lista-item:hover{background:var(--surface-2)}
.aq-prod-dosis{padding:7px 8px;border:1px solid var(--border);border-radius:6px;
  font-size:12px;background:var(--surface);color:var(--text-primary);text-align:center;width:100%}
.aq-prod-unidad{padding:7px 6px;border:1px solid var(--border);border-radius:6px;
  font-size:11px;background:var(--surface);color:var(--text-primary);width:100%}
.aq-prod-del{background:none;border:none;cursor:pointer;color:#DC2626;font-size:16px;
  padding:2px;border-radius:4px;transition:background .15s}
.aq-prod-del:hover{background:#FEF2F2}
.aq-add-prod{margin-top:8px;padding:7px 14px;border:1px dashed var(--border);border-radius:7px;
  background:transparent;color:var(--text-sec);font-size:11px;cursor:pointer;width:100%;transition:background .15s}
.aq-add-prod:hover{background:var(--surface-2)}

/* Sección label de productos en modal */
.aq-prod-section-label{font-size:10px;font-weight:700;color:var(--text-sec);
  text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}

/* Estado vacío */
.aq-empty{padding:40px 16px;text-align:center;color:var(--text-sec);font-size:13px;grid-column:1/-1}

/* Chip pedido */
.aq-chip-pedido{font-size:10px;background:#E0F2FE;color:#0369A1;padding:2px 8px;border-radius:6px}

/* Receta selector info box */
.aq-info-box{font-size:11px;color:var(--text-sec);background:var(--surface-2);
  border-radius:7px;padding:8px 10px;border:1px solid var(--border)}
`;

// ── Estado del módulo ─────────────────────────────────────────
let _container = null;
let _tab       = "calendario";
let _unsubs    = [];

const TABS = [
  { id:"calendario",   label:"🌱 Calendario agrícola" },
  { id:"recetas",      label:"🧪 Recetas / Dosis"     },
  { id:"trazabilidad", label:"🔗 Trazabilidad"         },
];

// ── Mount / Destroy ───────────────────────────────────────────
export const AgroquimicoModule = { mount, destroy };

function mount(container) {
  _container = container;
  cargarNombres();

  // Inyectar CSS
  if (!document.getElementById("aq-styles")) {
    const s = document.createElement("style");
    s.id = "aq-styles";
    s.textContent = AQ_CSS;
    document.head.appendChild(s);
  }

  _container.innerHTML = `
    <div class="aq-shell">
      <div class="aq-header">
        <span class="aq-header-icon">🌿</span>
        <div>
          <h2 class="aq-header-title">Agroquímico</h2>
          <div class="aq-header-sub">Calendario agrícola · Recetas de aplicación · Trazabilidad</div>
        </div>
      </div>

      <div class="aq-tabs">
        ${TABS.map(t => `
          <button class="aq-tab" id="tab-btn-${t.id}" data-tab="${t.id}">${t.label}</button>
        `).join("")}
      </div>

      <div class="aq-content" id="aq-content-wrap">
        ${TABS.map(t => `<div id="tab-${t.id}" style="display:none"></div>`).join("")}
      </div>
    </div>`;

  TABS.forEach(t => {
    el(`tab-btn-${t.id}`)?.addEventListener("click", () => _activarTab(t.id));
  });
  _activarTab("calendario");
}

function destroy() {
  _unsubs.forEach(u => u?.());
  _unsubs = [];
  const style = document.getElementById("aq-styles");
  if (style) style.remove();
  if (_container) _container.innerHTML = "";
  _container = null;
}

function _activarTab(tab) {
  _tab = tab;
  _unsubs.forEach(u => u?.()); _unsubs = [];

  TABS.forEach(t => {
    const btn = el(`tab-btn-${t.id}`);
    const div = el(`tab-${t.id}`);
    const activo = t.id === tab;
    btn?.classList.toggle("active", activo);
    if (div) div.style.display = activo ? "block" : "none";
  });

  if (tab === "calendario")   _montarCalendario();
  if (tab === "recetas")      _montarRecetas();
  if (tab === "trazabilidad") _montarTrazabilidad();
}

// ══════════════════════════════════════════════════════════════
// TAB 1 — CALENDARIO AGRÍCOLA
// ══════════════════════════════════════════════════════════════
function _montarCalendario() {
  const wrap = el("tab-calendario");
  if (!wrap) return;

  const mesActual = new Date().getMonth(); // 0-based

  wrap.innerHTML = `
    <div class="aq-sec">
      <h3 class="aq-sec-title">🌱 Calendario agrícola por cultivo</h3>
      <select class="aq-sel" id="cal-filtro-cultivo">
        <option value="">Todos los cultivos</option>
        ${CULTIVOS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
      </select>
      <button class="aq-btn-primary green" id="cal-nuevo-btn">+ Nueva ventana</button>
    </div>

    <!-- Leyenda -->
    <div class="aq-leyenda">
      ${ETAPAS.map(e => {
        const c = etapaColor(e);
        return `<span class="aq-badge" style="background:${c.bg};color:${c.col}">${esc(e)}</span>`;
      }).join("")}
    </div>

    <!-- Grid Gantt -->
    <div class="aq-gantt">
      <div id="cal-grid"></div>
    </div>

    <!-- Tabla -->
    <div style="font-size:13px;font-weight:700;margin-bottom:10px;color:var(--text-primary)">Ventanas registradas</div>
    <div class="aq-tbl-wrap">
      <table class="aq-tbl">
        <thead><tr>
          <th>Cultivo</th><th>Región</th><th>Etapa</th>
          <th>Meses</th><th>Notas</th><th style="width:80px"></th>
        </tr></thead>
        <tbody id="cal-body">
          <tr><td colspan="6" class="aq-empty">Cargando…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Modal -->
    <div class="aq-modal-overlay" id="cal-modal" style="display:none">
      <div class="aq-modal" style="max-width:480px">
        <div class="aq-modal-head">
          <span class="aq-modal-head-icon">🌱</span>
          <div class="aq-modal-head-title" id="cal-modal-title">Nueva ventana de aplicación</div>
          <button class="aq-modal-head-close" id="cal-modal-close">✕</button>
        </div>
        <div class="aq-modal-body">
          <div class="aq-grid-2">
            <div class="aq-field">
              <label>Cultivo *</label>
              <select id="cal-f-cultivo">
                <option value="">— Seleccionar —</option>
                ${CULTIVOS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
              </select>
            </div>
            <div class="aq-field">
              <label>Región</label>
              <input id="cal-f-region" type="text" placeholder="Ej. Morelos, Puebla">
            </div>
          </div>
          <div class="aq-field">
            <label>Etapa fenológica *</label>
            <select id="cal-f-etapa">
              <option value="">— Seleccionar —</option>
              ${ETAPAS.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join("")}
            </select>
          </div>
          <div class="aq-grid-2">
            <div class="aq-field">
              <label>Mes inicio *</label>
              <select id="cal-f-desde">
                ${MESES.map((m,i) => `<option value="${i+1}">${m}</option>`).join("")}
              </select>
            </div>
            <div class="aq-field">
              <label>Mes fin *</label>
              <select id="cal-f-hasta">
                ${MESES.map((m,i) => `<option value="${i+1}">${m}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="aq-field">
            <label>Notas / Alertas</label>
            <input id="cal-f-notas" type="text" placeholder="Ej. Aplicar antes de floración">
          </div>
        </div>
        <div class="aq-modal-foot">
          <button class="aq-btn-secondary" id="cal-cancel">Cancelar</button>
          <button class="aq-btn-primary green" id="cal-guardar">Guardar</button>
        </div>
      </div>
    </div>`;

  let _editId = null;
  let _datos  = [];

  const cerrar = () => {
    _unregEsc();
    el("cal-modal").style.display = "none";
    _editId = null;
    ["cal-f-cultivo","cal-f-etapa","cal-f-region","cal-f-notas"].forEach(id => { if(el(id)) el(id).value=""; });
    if (el("cal-f-desde")) el("cal-f-desde").value = "1";
    if (el("cal-f-hasta")) el("cal-f-hasta").value = "12";
    if (el("cal-modal-title")) el("cal-modal-title").textContent = "Nueva ventana de aplicación";
    if (el("cal-guardar"))     el("cal-guardar").textContent     = "Guardar";
  };

  el("cal-nuevo-btn")?.addEventListener("click", () => { el("cal-modal").style.display = "flex"; _regEsc(cerrar); });
  el("cal-modal-close")?.addEventListener("click", cerrar);
  el("cal-cancel")?.addEventListener("click", cerrar);
  el("cal-modal")?.addEventListener("click", e => { if (e.target === el("cal-modal")) cerrar(); });
  el("cal-filtro-cultivo")?.addEventListener("change", () => _renderCalendario(_datos));

  el("cal-guardar")?.addEventListener("click", async () => {
    const cultivo = el("cal-f-cultivo")?.value;
    const etapa   = el("cal-f-etapa")?.value;
    const region  = el("cal-f-region")?.value.trim();
    const desde   = parseInt(el("cal-f-desde")?.value || "1");
    const hasta   = parseInt(el("cal-f-hasta")?.value || "12");
    const notas   = el("cal-f-notas")?.value.trim();
    if (!cultivo || !etapa)  { window.toast?.("Cultivo y etapa son requeridos","warn"); return; }
    if (desde > hasta)       { window.toast?.("Mes inicio debe ser ≤ mes fin","warn"); return; }

    const btn = el("cal-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const datos = { cultivo, etapa, region: region||"", notas: notas||"",
        mesInicio: desde, mesFin: hasta, quienRegistro: Sesion.alias, _ts: Date.now() };
      if (_editId) await setDoc(doc(db,"calendario_agricola",_editId), datos, { merge:true });
      else         await addDoc(collection(db,"calendario_agricola"), datos);
      window.toast?.(_editId ? "Actualizado" : "Ventana guardada","success");
      cerrar();
    } catch(e) { window.toast?.("Error: "+e.message,"error"); }
    finally { btn.disabled=false; btn.textContent="Guardar"; }
  });

  const q = query(collection(db,"calendario_agricola"), orderBy("_ts","desc"), limit(500));
  const unsub = onSnapshot(q, snap => {
    _datos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderCalendario(_datos);
  }, e => console.error("[Calendario]", e));
  _unsubs.push(unsub);

  function _renderCalendario(datos) {
    const filtro  = el("cal-filtro-cultivo")?.value || "";
    const filtrado = filtro ? datos.filter(d => d.cultivo === filtro) : datos;
    const tbody    = el("cal-body");
    const grid     = el("cal-grid");

    // Grid Gantt
    if (grid) {
      const cultivosUnicos = [...new Set(filtrado.map(d => d.cultivo))].sort();
      if (!cultivosUnicos.length) {
        grid.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-sec);font-size:12px">Sin registros</div>`;
      } else {
        grid.innerHTML = `
          <div class="aq-gantt-grid" style="grid-template-columns:130px repeat(12,1fr)">
            <div class="aq-gantt-cell-hdr" style="border-bottom:1px solid var(--border)">Cultivo</div>
            ${MESES.map((m,i) => `
              <div class="aq-gantt-cell-hdr ${i===mesActual?"aq-gantt-mes-actual":""}">${m}</div>
            `).join("")}
            ${cultivosUnicos.map(cult => {
              const ventanas = filtrado.filter(d => d.cultivo === cult);
              return `
                <div class="aq-gantt-label">${esc(cult)}</div>
                ${MESES.map((_,mi) => {
                  const v = ventanas.find(d => d.mesInicio <= mi+1 && d.mesFin >= mi+1);
                  if (!v) return `<div class="aq-gantt-cell aq-gantt-empty"></div>`;
                  const c = etapaColor(v.etapa);
                  return `<div class="aq-gantt-cell" title="${esc(v.etapa)}${v.region?" · "+v.region:""}"
                    style="background:${c.bg};color:${c.col};cursor:default">
                    ${v.etapa.slice(0,4)}
                  </div>`;
                }).join("")}`;
            }).join("")}
          </div>
          <div style="margin-top:8px;font-size:10px;color:var(--text-sec);text-align:right">
            Columna resaltada = mes actual
          </div>`;
      }
    }

    // Tabla
    if (!tbody) return;
    if (!filtrado.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="aq-empty">Sin ventanas registradas</td></tr>`;
      return;
    }
    tbody.innerHTML = filtrado.map(d => {
      const c = etapaColor(d.etapa);
      return `<tr>
        <td style="font-weight:700">${esc(d.cultivo)}</td>
        <td style="color:var(--text-sec)">${esc(d.region||"—")}</td>
        <td><span class="aq-badge" style="background:${c.bg};color:${c.col}">${esc(d.etapa)}</span></td>
        <td style="white-space:nowrap">${MESES[(d.mesInicio||1)-1]} – ${MESES[(d.mesFin||12)-1]}</td>
        <td style="color:var(--text-sec);max-width:180px">${esc(d.notas||"—")}</td>
        <td>
          <button class="aq-btn-icon cal-edit-btn" data-id="${esc(d.id)}" title="Editar">✏️</button>
          <button class="aq-btn-icon cal-del-btn"  data-id="${esc(d.id)}" title="Eliminar">🗑️</button>
        </td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".cal-edit-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const d = filtrado.find(x => x.id === btn.dataset.id); if (!d) return;
        _editId = d.id;
        if (el("cal-f-cultivo")) el("cal-f-cultivo").value = d.cultivo;
        if (el("cal-f-etapa"))   el("cal-f-etapa").value   = d.etapa;
        if (el("cal-f-region"))  el("cal-f-region").value  = d.region||"";
        if (el("cal-f-notas"))   el("cal-f-notas").value   = d.notas||"";
        if (el("cal-f-desde"))   el("cal-f-desde").value   = d.mesInicio||1;
        if (el("cal-f-hasta"))   el("cal-f-hasta").value   = d.mesFin||12;
        if (el("cal-modal-title")) el("cal-modal-title").textContent = "Editar ventana";
        if (el("cal-guardar"))     el("cal-guardar").textContent     = "Actualizar";
        el("cal-modal").style.display = "flex"; _regEsc(cerrar);
      });
    });
    tbody.querySelectorAll(".cal-del-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const ok = window.modal
          ? await window.modal({ title:"Eliminar ventana", message:"¿Eliminar esta ventana de aplicación?", danger:true, confirmLabel:"Eliminar" })
          : confirm("¿Eliminar esta ventana?");
        if (!ok) return;
        try { await deleteDoc(doc(db,"calendario_agricola",btn.dataset.id)); }
        catch(e) { window.toast?.("Error: "+e.message,"error"); }
      });
    });
  }
}

// ══════════════════════════════════════════════════════════════
// TAB 2 — RECETAS / DOSIS
// ══════════════════════════════════════════════════════════════
function _montarRecetas() {
  const wrap = el("tab-recetas");
  if (!wrap) return;

  wrap.innerHTML = `
    <div class="aq-sec">
      <h3 class="aq-sec-title">🧪 Recetas de dosis y mezcla</h3>
      <input class="aq-input-search" type="text" id="rec-buscar" placeholder="🔍 Buscar receta…">
      <select class="aq-sel" id="rec-filtro-cultivo">
        <option value="">Todos los cultivos</option>
        ${CULTIVOS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
      </select>
      <button class="aq-btn-primary" id="rec-nuevo-btn">+ Nueva receta</button>
    </div>

    <div class="aq-cards" id="rec-cards">
      <div class="aq-empty">Cargando…</div>
    </div>

    <!-- Modal receta -->
    <div class="aq-modal-overlay" id="rec-modal" style="display:none">
      <div class="aq-modal" style="max-width:580px">
        <div class="aq-modal-head">
          <span class="aq-modal-head-icon">🧪</span>
          <div class="aq-modal-head-title" id="rec-modal-title">Nueva receta</div>
          <button class="aq-modal-head-close" id="rec-modal-close">✕</button>
        </div>
        <div class="aq-modal-body">
          <div class="aq-field">
            <label>Nombre de la receta *</label>
            <input id="rec-f-nombre" type="text" placeholder="Ej. Arranque jitomate etapa vegetativa">
          </div>
          <div class="aq-grid-2">
            <div class="aq-field">
              <label>Cultivo *</label>
              <select id="rec-f-cultivo">
                <option value="">— Seleccionar —</option>
                ${CULTIVOS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
              </select>
            </div>
            <div class="aq-field">
              <label>Etapa *</label>
              <select id="rec-f-etapa">
                <option value="">— Seleccionar —</option>
                ${ETAPAS.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="aq-grid-2">
            <div class="aq-field">
              <label>Litros de agua / ha</label>
              <input id="rec-f-agua" type="number" min="0" placeholder="Ej. 200">
            </div>
            <div class="aq-field">
              <label>Hectáreas referencia</label>
              <input id="rec-f-ha" type="number" min="0" step="0.1" placeholder="Ej. 1">
            </div>
          </div>
          <div>
            <div class="aq-prod-section-label">Productos en la mezcla</div>
            <div id="rec-prod-rows" style="display:flex;flex-direction:column;gap:6px"></div>
            <button class="aq-add-prod" id="rec-add-prod" type="button">+ Agregar producto</button>
          </div>
          <div class="aq-field">
            <label>Notas / Advertencias</label>
            <textarea id="rec-f-notas" rows="2" placeholder="Ej. No mezclar con productos alcalinos. Aplicar en horas frescas."></textarea>
          </div>
        </div>
        <div class="aq-modal-foot">
          <button class="aq-btn-secondary" id="rec-cancel">Cancelar</button>
          <button class="aq-btn-primary" id="rec-guardar">Guardar receta</button>
        </div>
      </div>
    </div>`;

  let _catalogo = [];
  let _editId   = null;
  let _datos    = [];
  let _prodCount= 0;

  async function _cargarCatalogo() {
    if (_catalogo.length) return;
    const snap = await getDocs(query(collection(db,"inventario"), orderBy("nombre"), limit(600)));
    _catalogo = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  const cerrar = () => {
    _unregEsc();
    el("rec-modal").style.display = "none";
    _editId = null;
    ["rec-f-nombre","rec-f-cultivo","rec-f-etapa","rec-f-agua","rec-f-ha","rec-f-notas"].forEach(id => { if(el(id)) el(id).value=""; });
    if (el("rec-prod-rows"))  el("rec-prod-rows").innerHTML = "";
    if (el("rec-modal-title")) el("rec-modal-title").textContent = "Nueva receta";
    if (el("rec-guardar"))     el("rec-guardar").textContent     = "Guardar receta";
    _prodCount = 0;
  };

  el("rec-nuevo-btn")?.addEventListener("click", () => { cerrar(); el("rec-modal").style.display="flex"; _regEsc(cerrar); _agregarFila(); });
  el("rec-modal-close")?.addEventListener("click", cerrar);
  el("rec-cancel")?.addEventListener("click", cerrar);
  el("rec-modal")?.addEventListener("click", e => { if (e.target === el("rec-modal")) cerrar(); });
  el("rec-add-prod")?.addEventListener("click", () => _agregarFila());

  function _agregarFila(init = null) {
    const idx = _prodCount++;
    const row = document.createElement("div");
    row.className = "aq-prod-row";
    row.dataset.recIdx = idx;
    row.innerHTML = `
      <div class="aq-prod-search-wrap">
        <input type="text" class="aq-prod-search" placeholder="Producto" data-rec-search="${idx}" value="${esc(init?.nombre||"")}">
        <div class="aq-prod-lista" data-rec-lista="${idx}"></div>
        <input type="hidden" data-rec-prod-id="${idx}" value="${esc(init?.productoId||"")}">
      </div>
      <input type="number" class="aq-prod-dosis" placeholder="Dosis" min="0" step="0.01"
        data-rec-dosis="${idx}" value="${init?.dosis||""}">
      <select class="aq-prod-unidad" data-rec-unidad="${idx}">
        ${UNIDADES.map(u => `<option value="${u}" ${init?.unidad===u?"selected":""}>${u}</option>`).join("")}
      </select>
      <button type="button" class="aq-prod-del" data-rec-del="${idx}">✕</button>`;
    el("rec-prod-rows")?.appendChild(row);

    const sInp  = row.querySelector(`[data-rec-search="${idx}"]`);
    const lista = row.querySelector(`[data-rec-lista="${idx}"]`);
    const pidInp= row.querySelector(`[data-rec-prod-id="${idx}"]`);

    sInp?.addEventListener("focus", async () => { await _cargarCatalogo(); _mostrarLista(lista, sInp.value, pidInp, sInp); });
    sInp?.addEventListener("input", () => _mostrarLista(lista, sInp.value, pidInp, sInp));
    row.querySelector(`[data-rec-del="${idx}"]`)?.addEventListener("click", () => row.remove());
    document.addEventListener("click", e => { if (!lista?.contains(e.target) && e.target !== sInp) lista && (lista.style.display="none"); });
  }

  function _mostrarLista(lista, term, pidInp, sInp) {
    if (!lista) return;
    const t = (term||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
    const matches = _catalogo.filter(p => !t || (p.nombre||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").includes(t)).slice(0,20);
    if (!matches.length) { lista.style.display="none"; return; }
    lista.innerHTML = matches.map((p,i) => `<div class="aq-prod-lista-item" data-i="${i}">${esc(p.nombre||"")}</div>`).join("");
    lista.querySelectorAll(".aq-prod-lista-item").forEach(it => {
      it.addEventListener("click", () => {
        const p = matches[parseInt(it.dataset.i)];
        if (pidInp) pidInp.value = p.id;
        if (sInp)   sInp.value  = p.nombre;
        lista.style.display = "none";
      });
    });
    lista.style.display = "block";
  }

  el("rec-guardar")?.addEventListener("click", async () => {
    const nombre  = el("rec-f-nombre")?.value.trim();
    const cultivo = el("rec-f-cultivo")?.value;
    const etapa   = el("rec-f-etapa")?.value;
    const agua    = parseFloat(el("rec-f-agua")?.value||"0");
    const ha      = parseFloat(el("rec-f-ha")?.value||"1");
    const notas   = el("rec-f-notas")?.value.trim();
    if (!nombre || !cultivo || !etapa) { window.toast?.("Nombre, cultivo y etapa son requeridos","warn"); return; }

    const filas = [...document.querySelectorAll("#rec-prod-rows > div")];
    const productos = filas.map(row => {
      const idx = row.dataset.recIdx;
      return {
        productoId: row.querySelector(`[data-rec-prod-id="${idx}"]`)?.value||"",
        nombre:     row.querySelector(`[data-rec-search="${idx}"]`)?.value||"",
        dosis:      parseFloat(row.querySelector(`[data-rec-dosis="${idx}"]`)?.value||"0"),
        unidad:     row.querySelector(`[data-rec-unidad="${idx}"]`)?.value||"L/ha",
      };
    }).filter(p => p.nombre && p.dosis > 0);
    if (!productos.length) { window.toast?.("Agrega al menos un producto con dosis","warn"); return; }

    const btn = el("rec-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const datos = { nombre, cultivo, etapa, litrosAgua: agua||0, hectareas: ha||1,
        productos, notas: notas||"", quienRegistro: Sesion.alias, _ts: Date.now() };
      if (_editId) await setDoc(doc(db,"recetas_agroquimicas",_editId), datos, { merge:true });
      else         await addDoc(collection(db,"recetas_agroquimicas"), datos);
      window.toast?.(_editId ? "Receta actualizada" : "Receta guardada","success");
      cerrar();
    } catch(e) { window.toast?.("Error: "+e.message,"error"); }
    finally { btn.disabled=false; btn.textContent="Guardar receta"; }
  });

  const filtrar = () => {
    const cult = el("rec-filtro-cultivo")?.value||"";
    const txt  = (el("rec-buscar")?.value||"").toLowerCase();
    const filtrado = _datos.filter(d =>
      (!cult || d.cultivo===cult) &&
      (!txt  || (d.nombre||"").toLowerCase().includes(txt)||(d.etapa||"").toLowerCase().includes(txt))
    );
    _renderCards(filtrado);
  };
  el("rec-filtro-cultivo")?.addEventListener("change", filtrar);
  el("rec-buscar")?.addEventListener("input", filtrar);

  const q = query(collection(db,"recetas_agroquimicas"), orderBy("_ts","desc"), limit(500));
  const unsub = onSnapshot(q, snap => {
    _datos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    filtrar();
  }, e => console.error("[Recetas]", e));
  _unsubs.push(unsub);

  function _renderCards(datos) {
    const cards = el("rec-cards");
    if (!cards) return;
    if (!datos.length) {
      cards.innerHTML = `<div class="aq-empty">Sin recetas registradas. Presiona <strong>+ Nueva receta</strong> para comenzar.</div>`;
      return;
    }
    cards.innerHTML = datos.map(d => {
      const c = etapaColor(d.etapa);
      return `
      <div class="aq-card">
        <div class="aq-card-header">
          <div style="flex:1">
            <div class="aq-card-title">${esc(d.nombre)}</div>
            <div class="aq-card-tags">
              <span class="aq-badge" style="background:#E0F2FE;color:#0369A1">${esc(d.cultivo)}</span>
              <span class="aq-badge" style="background:${c.bg};color:${c.col}">${esc(d.etapa)}</span>
            </div>
          </div>
          <div class="aq-card-actions">
            <button class="aq-btn-icon rec-edit-btn" data-id="${esc(d.id)}" title="Editar">✏️</button>
            <button class="aq-btn-icon rec-del-btn"  data-id="${esc(d.id)}" title="Eliminar">🗑️</button>
          </div>
        </div>
        <table class="aq-prod-tbl">
          <thead><tr>
            <th>Producto</th><th style="text-align:right">Dosis</th><th style="text-align:right">Unidad</th>
          </tr></thead>
          <tbody>
            ${(d.productos||[]).map(p => `<tr>
              <td>${esc(p.nombre)}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${p.dosis}</td>
              <td style="text-align:right;color:var(--text-sec)">${esc(p.unidad)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        ${d.litrosAgua ? `<div class="aq-agua-note">💧 ${d.litrosAgua} L/ha · ${d.hectareas||1} ha referencia</div>` : ""}
        ${d.notas      ? `<div class="aq-warn-note">⚠️ ${esc(d.notas)}</div>` : ""}
      </div>`;
    }).join("");

    cards.querySelectorAll(".rec-edit-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const d = _datos.find(x => x.id===btn.dataset.id); if(!d) return;
        _editId = d.id;
        if(el("rec-f-nombre"))  el("rec-f-nombre").value  = d.nombre||"";
        if(el("rec-f-cultivo")) el("rec-f-cultivo").value = d.cultivo||"";
        if(el("rec-f-etapa"))   el("rec-f-etapa").value   = d.etapa||"";
        if(el("rec-f-agua"))    el("rec-f-agua").value    = d.litrosAgua||"";
        if(el("rec-f-ha"))      el("rec-f-ha").value      = d.hectareas||"";
        if(el("rec-f-notas"))   el("rec-f-notas").value   = d.notas||"";
        if(el("rec-prod-rows")) el("rec-prod-rows").innerHTML = "";
        _prodCount = 0;
        (d.productos||[]).forEach(p => _agregarFila(p));
        if(el("rec-modal-title")) el("rec-modal-title").textContent = "Editar receta";
        if(el("rec-guardar"))     el("rec-guardar").textContent     = "Actualizar";
        el("rec-modal").style.display = "flex"; _regEsc(cerrar);
      });
    });
    cards.querySelectorAll(".rec-del-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const ok = window.modal
          ? await window.modal({ title:"Eliminar receta", message:"¿Eliminar esta receta?", danger:true, confirmLabel:"Eliminar" })
          : confirm("¿Eliminar esta receta?");
        if (!ok) return;
        try { await deleteDoc(doc(db,"recetas_agroquimicas",btn.dataset.id)); }
        catch(e) { window.toast?.("Error: "+e.message,"error"); }
      });
    });
  }
}

// ══════════════════════════════════════════════════════════════
// TAB 3 — TRAZABILIDAD
// ══════════════════════════════════════════════════════════════
function _montarTrazabilidad() {
  const wrap = el("tab-trazabilidad");
  if (!wrap) return;

  const hoy    = new Date().toISOString().slice(0,10);
  const hace30 = new Date(Date.now()-30*86400000).toISOString().slice(0,10);

  let _ingenieros  = [];
  let _recetasDisp = [];
  let _catalogo2   = [];
  let _trzProdCount= 0;
  let _trzUnsub    = null;

  wrap.innerHTML = `
    <div class="aq-sec">
      <h3 class="aq-sec-title">🔗 Trazabilidad campo → cultivo → venta</h3>
      <button class="aq-btn-primary" id="trz-nuevo-btn">+ Registrar aplicación</button>
    </div>

    <div class="aq-kpis">
      <div class="aq-kpi" style="--kpi-color:#6366F1">
        <div class="aq-kpi-val" id="trz-kpi-apps">–</div>
        <div class="aq-kpi-label">🌿 Aplicaciones</div>
      </div>
      <div class="aq-kpi" style="--kpi-color:#16A34A">
        <div class="aq-kpi-val" id="trz-kpi-cultivos">–</div>
        <div class="aq-kpi-label">🌾 Cultivos distintos</div>
      </div>
      <div class="aq-kpi" style="--kpi-color:#0369A1">
        <div class="aq-kpi-val" id="trz-kpi-productos">–</div>
        <div class="aq-kpi-label">📦 Productos aplicados</div>
      </div>
      <div class="aq-kpi" style="--kpi-color:#D97706">
        <div class="aq-kpi-val" id="trz-kpi-ings">–</div>
        <div class="aq-kpi-label">🧑‍🌾 Ingenieros activos</div>
      </div>
    </div>

    <div class="aq-filters">
      <select class="aq-sel" id="trz-f-ing">
        <option value="">Todos los ingenieros</option>
      </select>
      <select class="aq-sel" id="trz-f-cultivo">
        <option value="">Todos los cultivos</option>
        ${CULTIVOS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
      </select>
      <span class="aq-date-sep">Desde</span>
      <input type="date" class="aq-sel" id="trz-desde" value="${hace30}">
      <span class="aq-date-sep">Hasta</span>
      <input type="date" class="aq-sel" id="trz-hasta" value="${hoy}">
      <button class="aq-btn-filter" id="trz-filtrar">Filtrar</button>
    </div>

    <div class="aq-tbl-wrap">
      <table class="aq-tbl">
        <thead><tr>
          <th>Fecha</th><th>Ingeniero</th><th>Cliente / Parcela</th>
          <th>Cultivo / Etapa</th><th>Productos</th><th>Resultado</th><th style="width:80px">Pedido</th>
        </tr></thead>
        <tbody id="trz-body">
          <tr><td colspan="7" class="aq-empty">Cargando…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Modal registro -->
    <div class="aq-modal-overlay" id="trz-modal" style="display:none">
      <div class="aq-modal" style="max-width:560px">
        <div class="aq-modal-head">
          <span class="aq-modal-head-icon">🔗</span>
          <div class="aq-modal-head-title">Registrar aplicación</div>
          <button class="aq-modal-head-close" id="trz-modal-close">✕</button>
        </div>
        <div class="aq-modal-body">
          <div class="aq-grid-2">
            <div class="aq-field">
              <label>Ingeniero *</label>
              <select id="trz-f-ing-sel"><option value="">— Seleccionar —</option></select>
            </div>
            <div class="aq-field">
              <label>Fecha aplicación *</label>
              <input id="trz-f-fecha" type="date" value="${hoy}">
            </div>
          </div>
          <div class="aq-grid-2">
            <div class="aq-field">
              <label>Cliente *</label>
              <input id="trz-f-cliente" type="text" placeholder="Nombre del cliente">
            </div>
            <div class="aq-field">
              <label>Parcela / Lote</label>
              <input id="trz-f-parcela" type="text" placeholder="Ej. Parcela Norte, Lote 3">
            </div>
          </div>
          <div class="aq-grid-2">
            <div class="aq-field">
              <label>Cultivo *</label>
              <select id="trz-f-cultivo-sel">
                <option value="">— Seleccionar —</option>
                ${CULTIVOS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
              </select>
            </div>
            <div class="aq-field">
              <label>Etapa</label>
              <select id="trz-f-etapa-sel">
                <option value="">— Seleccionar —</option>
                ${ETAPAS.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="aq-field">
            <label>Cargar desde receta (opcional)</label>
            <select id="trz-f-receta"><option value="">— Sin receta —</option></select>
          </div>
          <div>
            <div class="aq-prod-section-label">Productos aplicados</div>
            <div id="trz-prod-rows" style="display:flex;flex-direction:column;gap:6px"></div>
            <button class="aq-add-prod" id="trz-add-prod" type="button">+ Agregar producto</button>
          </div>
          <div class="aq-field">
            <label>Resultado / Observaciones</label>
            <textarea id="trz-f-resultado" rows="2" placeholder="Ej. Buena respuesta foliar. Cliente satisfecho."></textarea>
          </div>
          <div class="aq-field">
            <label>Pedido asociado (opcional)</label>
            <input id="trz-f-pedido" type="text" placeholder="Folio del pedido">
          </div>
        </div>
        <div class="aq-modal-foot">
          <button class="aq-btn-secondary" id="trz-cancel">Cancelar</button>
          <button class="aq-btn-primary" id="trz-guardar">Registrar</button>
        </div>
      </div>
    </div>`;

  const cerrarTrz = () => {
    _unregEsc();
    el("trz-modal").style.display = "none";
    ["trz-f-ing-sel","trz-f-cultivo-sel","trz-f-etapa-sel","trz-f-receta"].forEach(id => { if(el(id)) el(id).value=""; });
    ["trz-f-cliente","trz-f-parcela","trz-f-resultado","trz-f-pedido"].forEach(id => { if(el(id)) el(id).value=""; });
    if(el("trz-f-fecha"))     el("trz-f-fecha").value = hoy;
    if(el("trz-prod-rows"))   el("trz-prod-rows").innerHTML = "";
    _trzProdCount = 0;
  };

  el("trz-nuevo-btn")?.addEventListener("click",  () => { cerrarTrz(); el("trz-modal").style.display="flex"; _regEsc(cerrarTrz); _agregarFilaTrz(); });
  el("trz-modal-close")?.addEventListener("click", cerrarTrz);
  el("trz-cancel")?.addEventListener("click",      cerrarTrz);
  el("trz-modal")?.addEventListener("click", e => { if(e.target===el("trz-modal")) cerrarTrz(); });
  el("trz-add-prod")?.addEventListener("click", () => _agregarFilaTrz());

  // Cargar desde receta
  el("trz-f-receta")?.addEventListener("change", () => {
    const opt = el("trz-f-receta")?.selectedOptions[0];
    if (!opt?.value) return;
    try {
      const prods = JSON.parse(opt.dataset.productos||"[]");
      if(el("trz-prod-rows")) el("trz-prod-rows").innerHTML = "";
      _trzProdCount = 0;
      prods.forEach(p => _agregarFilaTrz(p));
    } catch {}
  });

  function _agregarFilaTrz(val = null) {
    const idx = _trzProdCount++;
    const row = document.createElement("div");
    row.className = "aq-prod-row";
    row.dataset.trzIdx = idx;
    row.innerHTML = `
      <div class="aq-prod-search-wrap">
        <input type="text" class="aq-prod-search" placeholder="Producto" data-trz-search="${idx}" value="${esc(val?.nombre||"")}">
        <div class="aq-prod-lista" data-trz-lista="${idx}"></div>
        <input type="hidden" data-trz-pid="${idx}" value="${esc(val?.productoId||"")}">
      </div>
      <input type="number" class="aq-prod-dosis" placeholder="Dosis" min="0" step="0.01"
        data-trz-dosis="${idx}" value="${val?.dosis||""}">
      <select class="aq-prod-unidad" data-trz-unidad="${idx}">
        ${UNIDADES.map(u => `<option value="${u}" ${val?.unidad===u?"selected":""}>${u}</option>`).join("")}
      </select>
      <button type="button" class="aq-prod-del" data-trz-del="${idx}">✕</button>`;
    el("trz-prod-rows")?.appendChild(row);

    const sInp  = row.querySelector(`[data-trz-search="${idx}"]`);
    const lista = row.querySelector(`[data-trz-lista="${idx}"]`);
    const pidInp= row.querySelector(`[data-trz-pid="${idx}"]`);

    const renderL = () => {
      const t = (sInp.value||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"");
      const matches = _catalogo2.filter(p => !t||(p.nombre||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").includes(t)).slice(0,20);
      if (!matches.length) { lista.style.display="none"; return; }
      lista.innerHTML = matches.map((p,i) => `<div class="aq-prod-lista-item" data-i="${i}">${esc(p.nombre||"")}</div>`).join("");
      lista.querySelectorAll(".aq-prod-lista-item").forEach(it => {
        it.addEventListener("click", () => {
          const p = matches[parseInt(it.dataset.i)];
          if(pidInp) pidInp.value = p.id;
          if(sInp)   sInp.value  = p.nombre;
          lista.style.display = "none";
        });
      });
      lista.style.display = "block";
    };
    sInp?.addEventListener("focus", renderL);
    sInp?.addEventListener("input", renderL);
    row.querySelector(`[data-trz-del="${idx}"]`)?.addEventListener("click", () => row.remove());
    document.addEventListener("click", e => { if(!lista?.contains(e.target)&&e.target!==sInp) lista&&(lista.style.display="none"); });
  }

  el("trz-guardar")?.addEventListener("click", async () => {
    const ingSel  = el("trz-f-ing-sel");
    const ingId   = ingSel?.value;
    const ingAlias= ingSel?.selectedOptions[0]?.textContent||"";
    const fecha   = el("trz-f-fecha")?.value||hoy;
    const cliente = el("trz-f-cliente")?.value.trim();
    const parcela = el("trz-f-parcela")?.value.trim();
    const cultivo = el("trz-f-cultivo-sel")?.value;
    const etapa   = el("trz-f-etapa-sel")?.value;
    const resultado= el("trz-f-resultado")?.value.trim();
    const pedidoId = el("trz-f-pedido")?.value.trim();

    if (!ingId)   { window.toast?.("Selecciona un ingeniero","warn"); return; }
    if (!cliente) { window.toast?.("Ingresa el cliente","warn"); return; }
    if (!cultivo) { window.toast?.("Selecciona el cultivo","warn"); return; }

    const filas = [...document.querySelectorAll("#trz-prod-rows > div")];
    const productos = filas.map(row => {
      const idx = row.dataset.trzIdx;
      return {
        productoId: row.querySelector(`[data-trz-pid="${idx}"]`)?.value||"",
        nombre:     row.querySelector(`[data-trz-search="${idx}"]`)?.value||"",
        dosis:      parseFloat(row.querySelector(`[data-trz-dosis="${idx}"]`)?.value||"0"),
        unidad:     row.querySelector(`[data-trz-unidad="${idx}"]`)?.value||"L/ha",
      };
    }).filter(p => p.nombre);

    const [y,m,d] = fecha.split("-").map(Number);
    const fechaTs = new Date(y,m-1,d,12,0,0).getTime();

    const btn = el("trz-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      await addDoc(collection(db,"trazabilidad_campo"), {
        ingenieroId: ingId, ingenieroAlias: ingAlias.trim(),
        clienteNombre: cliente, parcela: parcela||"",
        cultivo, etapa: etapa||"",
        productos, resultado: resultado||"",
        pedidoId: pedidoId||"",
        fechaAplicacion: fecha, fechaTs,
        quienRegistro: Sesion.alias, _ts: Date.now()
      });
      window.toast?.("Aplicación registrada","success");
      cerrarTrz();
    } catch(e) { window.toast?.("Error: "+e.message,"error"); }
    finally { btn.disabled=false; btn.textContent="Registrar"; }
  });

  // Carga inicial: ingenieros, recetas y catálogo
  async function _inicTrz() {
    try {
      const snap = await getDocs(query(collection(db,"usuarios"), where("activo","==",true), limit(200)));
      _ingenieros = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => ["INGENIERO","GERENTE","ADMINISTRADOR"].includes(u.rol||""));

      const addOpt = (selId, u) => {
        const opt = document.createElement("option");
        opt.value = u.uid; opt.textContent = u.alias||u.uid;
        document.getElementById(selId)?.appendChild(opt);
      };
      _ingenieros.forEach(u => { addOpt("trz-f-ing", u); addOpt("trz-f-ing-sel", u); });

      const rSnap = await getDocs(query(collection(db,"recetas_agroquimicas"), orderBy("nombre"), limit(200)));
      _recetasDisp = rSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const recSel = el("trz-f-receta");
      _recetasDisp.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = `${r.nombre} (${r.cultivo} · ${r.etapa})`;
        opt.dataset.productos = JSON.stringify(r.productos||[]);
        recSel?.appendChild(opt);
      });

      const cSnap = await getDocs(query(collection(db,"inventario"), orderBy("nombre"), limit(600)));
      _catalogo2 = cSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e) { console.error("[Trz init]", e); }
  }

  function _cargarTrz() {
    if (_trzUnsub) { _trzUnsub(); _trzUnsub = null; }

    const ingId  = el("trz-f-ing")?.value||"";
    const cultivo= el("trz-f-cultivo")?.value||"";
    const desde  = el("trz-desde")?.value;
    const hasta  = el("trz-hasta")?.value;
    const [dy,dm,dd] = (desde||"").split("-").map(Number);
    const [hy,hm,hd] = (hasta||"").split("-").map(Number);
    const desdeTs = desde ? new Date(dy,dm-1,dd,0,0,0).getTime() : Date.now()-30*86400000;
    const hastaTs = hasta ? new Date(hy,hm-1,hd,23,59,59).getTime() : Date.now();

    // Nota: si se filtra por ingeniero, Firestore requiere índice compuesto (ingenieroId + fechaTs).
    // Para evitar el error cuando el índice no existe, filtramos ingeniero client-side.
    const q = query(
      collection(db,"trazabilidad_campo"),
      where("fechaTs",">=",desdeTs),
      where("fechaTs","<=",hastaTs),
      orderBy("fechaTs","desc"),
      limit(500)
    );

    const tbody = el("trz-body");

    _trzUnsub = onSnapshot(q, snap => {
      let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (ingId)   rows = rows.filter(r => r.ingenieroId === ingId);
      if (cultivo) rows = rows.filter(r => r.cultivo === cultivo);

      // KPIs
      if(el("trz-kpi-apps"))      el("trz-kpi-apps").textContent      = rows.length;
      if(el("trz-kpi-cultivos"))  el("trz-kpi-cultivos").textContent  = new Set(rows.map(r=>r.cultivo)).size;
      if(el("trz-kpi-productos")) el("trz-kpi-productos").textContent = new Set(rows.flatMap(r=>(r.productos||[]).map(p=>p.productoId||p.nombre))).size;
      if(el("trz-kpi-ings"))      el("trz-kpi-ings").textContent      = new Set(rows.map(r=>r.ingenieroId)).size;

      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="aq-empty">Sin registros en el período</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map(r => {
        const c = etapaColor(r.etapa||"");
        return `<tr>
          <td style="white-space:nowrap">${fmt(r.fechaTs)}</td>
          <td>${esc(resolverNombre(r.ingenieroAlias))}</td>
          <td>
            <div style="font-weight:700">${esc(r.clienteNombre||"–")}</div>
            ${r.parcela?`<div style="font-size:10px;color:var(--text-sec)">${esc(r.parcela)}</div>`:""}
          </td>
          <td>
            <div style="font-weight:600">${esc(r.cultivo||"–")}</div>
            ${r.etapa?`<span class="aq-badge" style="background:${c.bg};color:${c.col};margin-top:2px">${esc(r.etapa)}</span>`:""}
          </td>
          <td style="max-width:180px">
            ${(r.productos||[]).map(p =>
              `<span style="display:inline-block;background:var(--surface-2);border:1px solid var(--border);
                border-radius:5px;padding:1px 6px;margin:1px;font-size:10px">
                ${esc(p.nombre)}${p.dosis?" "+p.dosis+" "+esc(p.unidad||""):""}
              </span>`).join("")}
          </td>
          <td style="color:var(--text-sec);max-width:160px">${esc(r.resultado||"–")}</td>
          <td>${r.pedidoId?`<span class="aq-chip-pedido">${esc(r.pedidoId)}</span>`:""}</td>
        </tr>`;
      }).join("");
    }, e => console.error("[Trazabilidad]", e));
    _unsubs.push(_trzUnsub);
  }

  el("trz-filtrar")?.addEventListener("click",  _cargarTrz);
  el("trz-f-ing")?.addEventListener("change",   _cargarTrz);
  el("trz-f-cultivo")?.addEventListener("change", _cargarTrz);

  _inicTrz().then(() => _cargarTrz());
}
