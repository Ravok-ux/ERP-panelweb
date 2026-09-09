// ══════════════════════════════════════════════════════════════
// crm.js — Módulo de prospectos / CRM
// Pipeline: NUEVO → CONTACTADO → PROPUESTA → GANADO / PERDIDO
// Al GANADO: crea documento en 'clientes' con frecuenciaVisita
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, logAudit, norm } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, doc, query, where, orderBy, limit,
  onSnapshot, addDoc, updateDoc, setDoc, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmtFecha = ts => ts
  ? new Date(typeof ts === "number" ? ts : ts.toMillis?.() ?? ts)
      .toLocaleDateString("es-MX", { day:"2-digit", month:"short", year:"numeric" })
  : "—";

const ETAPAS = [
  { id:"NUEVO",      label:"Nuevo",      color:"#6B7280", bg:"#F3F4F6" },
  { id:"CONTACTADO", label:"Contactado", color:"#1D4ED8", bg:"#DBEAFE" },
  { id:"PROPUESTA",  label:"Propuesta",  color:"#D97706", bg:"#FEF3C7" },
  { id:"GANADO",     label:"Ganado",     color:"#16A34A", bg:"#DCFCE7" },
  { id:"PERDIDO",    label:"Perdido",    color:"#DC2626", bg:"#FEE2E2" },
];
const etapaMap = Object.fromEntries(ETAPAS.map(e => [e.id, e]));

const FRECUENCIAS = [
  { id:"SEMANAL",    label:"Semanal (7 días)"     },
  { id:"QUINCENAL",  label:"Quincenal (15 días)"  },
  { id:"MENSUAL",    label:"Mensual (30 días)"     },
  { id:"BIMESTRAL",  label:"Bimestral (60 días)"  },
];

let _unsubs  = [];
let _ingenieros = [];

export const CrmModule = {
  mount(container) {
    container.innerHTML = `
    <div class="mod-wrap">
      <div class="mod-topbar">
        <h2 class="mod-title">🎯 CRM — Prospectos</h2>
        <div class="mod-actions">
          <button class="btn-primary" id="crm-nuevo-btn">+ Nuevo prospecto</button>
        </div>
      </div>

      <!-- Filtros -->
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
        <select class="sel-sm" id="crm-filtro-etapa">
          <option value="">Todas las etapas</option>
          ${ETAPAS.map(e => `<option value="${e.id}">${e.label}</option>`).join("")}
        </select>
        <select class="sel-sm" id="crm-filtro-ing">
          <option value="">Todos los ingenieros</option>
        </select>
        <input type="text" class="sel-sm" id="crm-buscar" placeholder="Buscar nombre, giro…" style="width:200px">
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="btn-outline crm-vista-btn active" data-vista="tabla">☰ Lista</button>
          <button class="btn-outline crm-vista-btn" data-vista="kanban">⬛ Kanban</button>
        </div>
      </div>

      <!-- KPIs -->
      <div class="kpi-row" style="margin-bottom:16px">
        ${ETAPAS.slice(0,4).map(e => `
        <div class="kpi-card" style="border-left-color:${e.color}">
          <div class="kpi-val" id="crm-kpi-${e.id}">–</div>
          <div class="kpi-label">${e.label}</div>
        </div>`).join("")}
        <div class="kpi-card" style="border-left-color:#7C3AED">
          <div class="kpi-val" id="crm-kpi-pipeline" style="font-size:13px">–</div>
          <div class="kpi-label">Pipeline ponderado</div>
        </div>
      </div>

      <div id="crm-view"></div>

      <!-- Panel detalle (side panel) -->
      <div class="side-panel hidden" id="crm-panel">
        <div class="sp-hdr">
          <span class="sp-title" id="crm-panel-nombre">–</span>
          <button class="sp-close" id="crm-panel-close">✕</button>
        </div>
        <div class="sp-body" id="crm-panel-body"></div>
      </div>
    </div>

    <!-- Modal nuevo / editar prospecto -->
    <div class="modal-overlay hidden" id="crm-modal">
      <div class="modal-box" style="max-width:500px">
        <div class="modal-hdr">
          <span class="modal-title" id="crm-modal-title">Nuevo prospecto</span>
          <button class="modal-close" id="crm-modal-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div class="form-group" style="grid-column:1/-1">
              <label class="form-label">Nombre del negocio *</label>
              <input class="form-input" type="text" id="crm-nombre" placeholder="Tienda, empresa o persona">
            </div>
            <div class="form-group">
              <label class="form-label">Teléfono</label>
              <input class="form-input" type="tel" id="crm-telefono" placeholder="669 000 0000">
            </div>
            <div class="form-group">
              <label class="form-label">Giro / tipo de negocio</label>
              <input class="form-input" type="text" id="crm-giro" placeholder="Papelería, restaurante…">
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label class="form-label">Dirección</label>
              <input class="form-input" type="text" id="crm-direccion" placeholder="Calle, colonia, ciudad">
            </div>
            <div class="form-group">
              <label class="form-label">Ingeniero asignado</label>
              <select class="form-input" id="crm-ing-asig">
                <option value="">Sin asignar</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Etapa inicial</label>
              <select class="form-input" id="crm-etapa">
                ${ETAPAS.filter(e => !["GANADO","PERDIDO"].includes(e.id))
                  .map(e => `<option value="${e.id}">${e.label}</option>`).join("")}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Valor estimado (MXN)</label>
              <input class="form-input" type="number" id="crm-valor" min="0" step="1000" placeholder="0">
            </div>
            <div class="form-group">
              <label class="form-label">Probabilidad %</label>
              <input class="form-input" type="number" id="crm-prob" min="0" max="100" step="5" placeholder="50">
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label class="form-label">Producto de interés</label>
              <input class="form-input" type="text" id="crm-producto" placeholder="Descripción del producto o servicio">
            </div>
            <div class="form-group" style="grid-column:1/-1">
              <label class="form-label">Notas iniciales</label>
              <textarea class="form-input" id="crm-notas" rows="2" placeholder="Intereses, observaciones…"></textarea>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="crm-cancel">Cancelar</button>
          <button class="btn-primary" id="crm-guardar">Guardar</button>
        </div>
      </div>
    </div>

    <!-- Modal convertir a cliente -->
    <div class="modal-overlay hidden" id="crm-conv-modal">
      <div class="modal-box" style="max-width:420px">
        <div class="modal-hdr">
          <span class="modal-title">🎉 Convertir a cliente</span>
          <button class="modal-close" id="crm-conv-close">✕</button>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
          <p style="font-size:13px;color:var(--text-sec);margin:0">
            El prospecto pasará a la lista de clientes activos y comenzará a aparecer
            en el calendario de visitas del ingeniero asignado.
          </p>
          <div class="form-group">
            <label class="form-label">Frecuencia de visita</label>
            <select class="form-input" id="crm-conv-frec">
              ${FRECUENCIAS.map(f => `<option value="${f.id}">${f.label}</option>`).join("")}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Segmento de cliente</label>
            <select class="form-input" id="crm-conv-seg">
              <option value="A">A — Alto volumen</option>
              <option value="B" selected>B — Volumen medio</option>
              <option value="C">C — Volumen bajo</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Límite de crédito (MXN)</label>
            <input class="form-input" type="number" id="crm-conv-credito" min="0" step="500" placeholder="0 = sin crédito">
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-outline" id="crm-conv-cancel">Cancelar</button>
          <button class="btn-primary" id="crm-conv-ok" style="background:#16A34A">✓ Convertir a cliente</button>
        </div>
      </div>
    </div>`;

    cargarNombres();
    _cargarIngenieros().then(() => _iniciarListeners());
    _bindUI();
    return () => this.destroy();
  },
  destroy() { _unsubs.forEach(u => u?.()); _unsubs = []; }
};

// ── Cargar ingenieros ─────────────────────────────────────────
async function _cargarIngenieros() {
  const [ingSnap, segSnap, prodSnap] = await Promise.all([
    getDocs(query(collection(db,"usuarios"), where("activo","==",true))),
    getDocs(query(collection(db,"segmentos"), orderBy("nombre"))),
    getDocs(query(collection(db,"productos"),  orderBy("nombre")))
  ]);

  _ingenieros = ingSnap.docs
    .filter(d => ["INGENIERO","RECUPERADOR"].includes(d.data().rol))
    .map(d => ({ uid: d.id, ...d.data() }))
    .sort((a, b) => (a.alias||"").localeCompare(b.alias||""));

  const opts = _ingenieros.map(u => `<option value="${esc(u.uid)}">${esc(u.alias||u.uid)}</option>`).join("");
  document.getElementById("crm-filtro-ing")?.insertAdjacentHTML("beforeend", opts);
  document.getElementById("crm-ing-asig")?.insertAdjacentHTML("beforeend", opts);

  // Segmentos dinámicos en "Convertir a cliente"
  const segSel = document.getElementById("crm-conv-seg");
  if (segSel && segSnap.docs.length) {
    segSel.innerHTML = `<option value="">Sin segmento</option>` +
      segSnap.docs.map(d => {
        const s = d.data();
        return `<option value="${esc(d.id)}">${esc(s.nombre)}</option>`;
      }).join("");
  }

  // Autocomplete de productos en "Producto de interés"
  const prodCache = prodSnap.docs.map(d => ({
    nombre: d.data().nombre || "", codigo: d.data().codigo || ""
  }));
  _bindProductoAC(prodCache);
}

function _bindProductoAC(productos) {
  const inp = document.getElementById("crm-producto");
  if (!inp) return;

  // Wrap input in a relative container and add dropdown
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative";
  inp.parentNode.insertBefore(wrap, inp);
  wrap.appendChild(inp);

  const dd = document.createElement("div");
  dd.id = "crm-prod-dd";
  dd.style.cssText = `display:none;position:absolute;top:100%;left:0;right:0;
    background:var(--surface);border:1px solid var(--border);border-radius:8px;
    box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:300;max-height:200px;overflow-y:auto;margin-top:2px`;
  wrap.appendChild(dd);

  inp.addEventListener("input", () => {
    const q = norm(inp.value);
    if (q.length < 2) { dd.style.display = "none"; return; }
    const matches = productos.filter(p =>
      norm(p.nombre).includes(q) || norm(p.codigo).includes(q)
    ).slice(0, 10);
    if (!matches.length) { dd.style.display = "none"; return; }
    dd.innerHTML = matches.map(p =>
      `<div data-nombre="${esc(p.nombre)}"
        style="padding:8px 12px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border)"
        onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background=''"
        onmousedown="event.preventDefault()">
        <span style="font-weight:600">${esc(p.nombre)}</span>
        <span style="font-size:10px;color:#9CA3AF;margin-left:6px">${esc(p.codigo)}</span>
      </div>`
    ).join("");
    dd.style.display = "block";
    dd.querySelectorAll("div[data-nombre]").forEach(el => {
      el.addEventListener("click", () => {
        inp.value = el.dataset.nombre;
        dd.style.display = "none";
      });
    });
  });
  inp.addEventListener("blur", () => setTimeout(() => { dd.style.display = "none"; }, 150));
}

// ── Bind UI ───────────────────────────────────────────────────
function _bindUI() {
  const cerrarModal = () => {
    document.getElementById("crm-modal")?.classList.add("hidden");
    document.getElementById("crm-modal").dataset.editId = "";
  };
  document.getElementById("crm-nuevo-btn")?.addEventListener("click", () => {
    document.getElementById("crm-modal-title").textContent = "Nuevo prospecto";
    ["crm-nombre","crm-telefono","crm-giro","crm-direccion","crm-notas"]
      .forEach(id => { const el = document.getElementById(id); if(el) el.value = ""; });
    document.getElementById("crm-modal")?.classList.remove("hidden");
  });
  document.getElementById("crm-modal-close")?.addEventListener("click", cerrarModal);
  document.getElementById("crm-cancel")?.addEventListener("click", cerrarModal);
  document.getElementById("crm-guardar")?.addEventListener("click", _guardarProspecto);

  document.getElementById("crm-conv-close")?.addEventListener("click", () =>
    document.getElementById("crm-conv-modal")?.classList.add("hidden"));
  document.getElementById("crm-conv-cancel")?.addEventListener("click", () =>
    document.getElementById("crm-conv-modal")?.classList.add("hidden"));
  document.getElementById("crm-conv-ok")?.addEventListener("click", _convertirACliente);

  document.getElementById("crm-panel-close")?.addEventListener("click", () =>
    document.getElementById("crm-panel")?.classList.add("hidden"));

  document.getElementById("crm-filtro-etapa")?.addEventListener("change", _renderVista);
  document.getElementById("crm-filtro-ing")?.addEventListener("change", _renderVista);
  document.getElementById("crm-buscar")?.addEventListener("input", _renderVista);

  document.querySelectorAll(".crm-vista-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".crm-vista-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _renderVista();
    });
  });
}

// ── Listeners Firestore ───────────────────────────────────────
let _todosProspectos = [];

function _iniciarListeners() {
  const q = query(collection(db,"prospectos"), orderBy("_ts","desc"), limit(300));
  _unsubs.push(onSnapshot(q, snap => {
    _todosProspectos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _actualizarKPIs(_todosProspectos);
    _renderVista();
  }, err => console.error("[CRM]", err)));
}

const fmtM = n => "$" + Math.round(n).toLocaleString("es-MX");

function _actualizarKPIs(rows) {
  ETAPAS.slice(0,4).forEach(e => {
    const el = document.getElementById(`crm-kpi-${e.id}`);
    if (el) el.textContent = rows.filter(r => r.etapa === e.id).length;
  });
  // Pipeline ponderado = Σ (valorEstimado * probabilidad / 100) para no PERDIDOS
  const pipeline = rows
    .filter(r => r.etapa !== "PERDIDO")
    .reduce((s, r) => s + ((r.valorEstimado || 0) * ((r.probabilidad ?? 50) / 100)), 0);
  const elP = document.getElementById("crm-kpi-pipeline");
  if (elP) elP.textContent = fmtM(pipeline);
}

// ── Filtrar ───────────────────────────────────────────────────
function _filtrados() {
  const etapa  = document.getElementById("crm-filtro-etapa")?.value || "";
  const ing    = document.getElementById("crm-filtro-ing")?.value   || "";
  const buscar = norm(document.getElementById("crm-buscar")?.value || "");
  return _todosProspectos.filter(r => {
    if (etapa  && r.etapa       !== etapa) return false;
    if (ing) {
      const ingObj = _ingenieros.find(u => u.uid === ing);
      if (r.ingenieroId !== ing && r.ingenieroAlias !== (ingObj?.alias || ingObj?.uid || "")) return false;
    }
    if (buscar && !norm(r.nombre).includes(buscar)
               && !norm(r.giro).includes(buscar)) return false;
    return true;
  });
}

// ── Render vista (tabla o kanban) ─────────────────────────────
function _renderVista() {
  const activeBtn = document.querySelector(".crm-vista-btn.active");
  const vista = activeBtn?.dataset.vista || "tabla";
  const rows  = _filtrados();
  if (vista === "kanban") _renderKanban(rows);
  else _renderTabla(rows);
}

function _renderTabla(rows) {
  const v = document.getElementById("crm-view");
  if (!rows.length) {
    v.innerHTML = `<div style="padding:48px;text-align:center;color:var(--text-sec)">Sin prospectos con estos filtros</div>`;
    return;
  }
  v.innerHTML = `<div style="overflow-x:auto"><table class="data-table" id="crm-tabla">
    <thead><tr>
      <th>NOMBRE / GIRO</th><th>TELÉFONO</th><th>INGENIERO</th>
      <th>ETAPA</th><th>NOTAS</th><th>FECHA</th><th></th>
    </tr></thead>
    <tbody>${rows.map(r => {
      const e = etapaMap[r.etapa] || etapaMap.NUEVO;
      return `<tr class="crm-row" data-id="${r.id}" style="cursor:pointer">
        <td>
          <div style="font-weight:700">${esc(r.nombre||"–")}</div>
          <div style="font-size:11px;color:var(--text-sec)">${esc(r.giro||"")}</div>
        </td>
        <td style="font-size:12px">${esc(r.telefono||"–")}</td>
        <td style="font-size:12px">${esc(resolverNombre(r.ingenieroAlias) || "Sin asignar")}</td>
        <td><span class="badge" style="background:${e.bg};color:${e.color}">${e.label}</span></td>
        <td style="font-size:11px;color:var(--text-sec);max-width:200px">${esc((r.notas||"").slice(0,80))}</td>
        <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(r._ts)}</td>
        <td style="white-space:nowrap">
          <select class="sel-sm crm-cambiar-etapa" data-id="${r.id}" style="font-size:11px">
            ${ETAPAS.map(e2 => `<option value="${e2.id}" ${e2.id===r.etapa?"selected":""}>${e2.label}</option>`).join("")}
          </select>
          ${(r.etapa === "GANADO" || r.etapa === "NEGOCIACIÓN") ? `
          <button class="btn-outline crm-crear-pedido"
            data-id="${r.id}"
            style="font-size:10px;padding:2px 6px;margin-left:4px;vertical-align:middle"
            title="Crear pedido borrador">📋 Pedido</button>` : ""}
        </td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;

  v.querySelectorAll(".crm-row").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest(".crm-cambiar-etapa")) return;
      _abrirPanel(row.dataset.id);
    });
  });
  v.querySelectorAll(".crm-cambiar-etapa").forEach(sel => {
    sel.addEventListener("change", () => _cambiarEtapa(sel.dataset.id, sel.value));
  });
  v.querySelectorAll(".crm-crear-pedido").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const prospecto = _todosProspectos.find(p => p.id === btn.dataset.id);
      if (prospecto) _crearPedidoDesdeProspecto(prospecto);
    });
  });
}

function _renderKanban(rows) {
  const v = document.getElementById("crm-view");
  v.innerHTML = `<div class="crm-kanban">${ETAPAS.map(e => `
    <div class="crm-col">
      <div class="crm-col-hdr" style="background:${e.bg};color:${e.color}">
        ${e.label}
        <span class="crm-col-count">${rows.filter(r=>r.etapa===e.id).length}</span>
      </div>
      <div class="crm-col-body">
        ${rows.filter(r=>r.etapa===e.id).map(r => `
          <div class="crm-card" data-id="${r.id}">
            <div style="font-weight:700;font-size:13px">${esc(r.nombre||"–")}</div>
            <div style="font-size:11px;color:var(--text-sec)">${esc(r.giro||"")}</div>
            <div style="font-size:11px;margin-top:6px">👷 ${esc(resolverNombre(r.ingenieroAlias) || "Sin asignar")}</div>
            <div style="font-size:10px;color:var(--text-sec);margin-top:4px">${fmtFecha(r._ts)}</div>
          </div>`).join("")}
      </div>
    </div>`).join("")}</div>`;

  v.querySelectorAll(".crm-card").forEach(card => {
    card.addEventListener("click", () => _abrirPanel(card.dataset.id));
  });
}

// ── Panel de detalle ──────────────────────────────────────────
function _abrirPanel(id) {
  const r = _todosProspectos.find(p => p.id === id);
  if (!r) return;
  const e = etapaMap[r.etapa] || etapaMap.NUEVO;
  const panel = document.getElementById("crm-panel");
  document.getElementById("crm-panel-nombre").textContent = r.nombre || "–";

  const esGanado  = r.etapa === "GANADO";
  const esPerdido = r.etapa === "PERDIDO";

  document.getElementById("crm-panel-body").innerHTML = `
    <div class="det-table">
      <div><span>Etapa</span><span><span class="badge" style="background:${e.bg};color:${e.color}">${e.label}</span></span></div>
      <div><span>Giro</span><span>${esc(r.giro||"–")}</span></div>
      <div><span>Teléfono</span><span>${esc(r.telefono||"–")}</span></div>
      <div><span>Dirección</span><span>${esc(r.direccion||"–")}</span></div>
      <div><span>Ingeniero</span><span>${esc(resolverNombre(r.ingenieroAlias) || "Sin asignar")}</span></div>
      <div><span>Registrado</span><span>${fmtFecha(r._ts)}</span></div>
      <div><span>Registró</span><span>${esc(r.creadoPor||"–")}</span></div>
    </div>
    <div style="margin-top:16px">
      <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:6px">NOTAS</div>
      <div style="font-size:13px;white-space:pre-wrap">${esc(r.notas||"Sin notas")}</div>
    </div>
    <div style="margin-top:16px">
      <div style="font-size:11px;font-weight:700;color:var(--text-sec);margin-bottom:8px">AGREGAR NOTA</div>
      <textarea class="form-input" id="crm-nota-txt" rows="2" placeholder="Seguimiento, comentarios…" style="width:100%;box-sizing:border-box"></textarea>
      <button class="btn-primary" id="crm-nota-ok" data-id="${r.id}" style="margin-top:8px;width:100%">Guardar nota</button>
    </div>
    <div style="margin-top:20px;display:flex;flex-direction:column;gap:8px">
      <div style="font-size:11px;font-weight:700;color:var(--text-sec)">AVANZAR ETAPA</div>
      ${!esGanado && !esPerdido ? `
      <select class="form-input" id="crm-nueva-etapa">
        ${ETAPAS.map(e2 => `<option value="${e2.id}" ${e2.id===r.etapa?"selected":""}>${e2.label}</option>`).join("")}
      </select>
      <button class="btn-outline" id="crm-avanzar-btn" data-id="${r.id}">Cambiar etapa</button>` : ""}
      ${!esGanado && !esPerdido ? `
      <button class="btn-primary" id="crm-ganar-btn" data-id="${r.id}"
        style="background:#16A34A;margin-top:4px">🎉 Marcar como GANADO → Convertir a cliente</button>
      <button class="btn-outline" id="crm-perder-btn" data-id="${r.id}"
        style="color:#DC2626;border-color:#DC2626">✗ Marcar como PERDIDO</button>` : ""}
      ${esGanado ? `<div style="padding:12px;background:#DCFCE7;border-radius:8px;font-size:12px;color:#15803D">
        ✅ Prospecto convertido a cliente</div>` : ""}
    </div>`;

  document.getElementById("crm-nota-ok")?.addEventListener("click", async () => {
    const txt = document.getElementById("crm-nota-txt")?.value.trim();
    if (!txt) return;
    const notas = (r.notas ? r.notas + "\n\n" : "") + `[${new Date().toLocaleDateString("es-MX")} · ${Sesion.alias}] ${txt}`;
    await updateDoc(doc(db,"prospectos",id), { notas, _ts: Date.now() })
      .catch(e => window.toast?.(e.message,"error"));
    window.toast?.("Nota guardada","success");
    document.getElementById("crm-nota-txt").value = "";
  });

  document.getElementById("crm-avanzar-btn")?.addEventListener("click", async () => {
    const nueva = document.getElementById("crm-nueva-etapa")?.value;
    if (nueva) await _cambiarEtapa(id, nueva);
  });

  document.getElementById("crm-ganar-btn")?.addEventListener("click", () => {
    document.getElementById("crm-conv-modal").dataset.prospectoId = id;
    document.getElementById("crm-conv-modal")?.classList.remove("hidden");
  });

  document.getElementById("crm-perder-btn")?.addEventListener("click", async () => {
    if (!await window.modal({ title: "Marcar como perdido", message: "¿Marcar este prospecto como PERDIDO?", danger: true, confirmLabel: "Marcar perdido" })) return;
    await _cambiarEtapa(id, "PERDIDO");
    panel.classList.add("hidden");
  });

  panel.classList.remove("hidden");
}

async function _cambiarEtapa(id, etapa) {
  await updateDoc(doc(db,"prospectos",id), { etapa, _ts: Date.now() })
    .catch(e => window.toast?.(e.message,"error"));
  if (etapa === "GANADO") {
    document.getElementById("crm-conv-modal").dataset.prospectoId = id;
    document.getElementById("crm-conv-modal")?.classList.remove("hidden");
  }
}

// ── Guardar prospecto ─────────────────────────────────────────
async function _guardarProspecto() {
  const nombre         = document.getElementById("crm-nombre")?.value.trim();
  const telefono       = document.getElementById("crm-telefono")?.value.trim();
  const giro           = document.getElementById("crm-giro")?.value.trim();
  const direccion      = document.getElementById("crm-direccion")?.value.trim();
  const notas          = document.getElementById("crm-notas")?.value.trim();
  const etapa          = document.getElementById("crm-etapa")?.value || "NUEVO";
  const ingId          = document.getElementById("crm-ing-asig")?.value;
  const valorEstimado  = parseFloat(document.getElementById("crm-valor")?.value || "0") || 0;
  const probabilidad   = parseInt(document.getElementById("crm-prob")?.value   || "50") || 50;
  const productoInteres = document.getElementById("crm-producto")?.value.trim() || "";

  if (!nombre) { window.toast?.("El nombre es obligatorio","error"); return; }
  const ing = _ingenieros.find(u => u.uid === ingId);
  const btn = document.getElementById("crm-guardar");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    await addDoc(collection(db,"prospectos"), {
      nombre, telefono, giro, direccion, notas, etapa,
      valorEstimado, probabilidad, productoInteres,
      ingenieroId: ingId || null, ingenieroAlias: ing?.alias || null,
      creadoPor: Sesion.alias, _ts: Date.now()
    });
    logAudit("PROSPECTO_CREADO", { nombre, giro, ingenieroAlias: ing?.alias || null, etapa });
    window.toast?.("Prospecto creado","success");
    document.getElementById("crm-modal")?.classList.add("hidden");
  } catch(e) { window.toast?.(e.message,"error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar"; }
}

// ── Crear pedido desde prospecto ─────────────────────────────
async function _crearPedidoDesdeProspecto(prospecto) {
  const ok = await window.modal({
    title: "Crear pedido borrador",
    message: `¿Crear pedido borrador para ${prospecto.nombre}?`,
    confirmLabel: "Crear pedido",
  });
  if (!ok) return;

  try {
    const ref = await addDoc(collection(db, "pedidos"), {
      clienteId:       prospecto.clienteId    || "",
      clienteNombre:   prospecto.nombre       || "",
      ingenieroAlias:  Sesion.alias           || "",
      status:          "BORRADOR",
      total:           0,
      _ts:             serverTimestamp(),
      fechaPedido:     serverTimestamp(),
      origenCRM:       prospecto.id,
      productoInteres: prospecto.productoInteres || "",
    });
    window.toast?.(`Pedido borrador creado (ID: ${ref.id.slice(0,8)}…)`, "success");
  } catch (e) {
    window.toast?.(e.message, "error");
  }
}

// ── Convertir a cliente ───────────────────────────────────────
async function _convertirACliente() {
  const id       = document.getElementById("crm-conv-modal")?.dataset.prospectoId;
  const frecuencia = document.getElementById("crm-conv-frec")?.value || "MENSUAL";
  const segmento   = document.getElementById("crm-conv-seg")?.value  || "B";
  const credito    = parseFloat(document.getElementById("crm-conv-credito")?.value || "0");
  if (!id) return;

  const prospecto = _todosProspectos.find(p => p.id === id);
  if (!prospecto) return;

  const btn = document.getElementById("crm-conv-ok");
  btn.disabled = true; btn.textContent = "Convirtiendo…";
  try {
    // Crear cliente
    const clienteRef = doc(collection(db,"clientes"));
    await setDoc(clienteRef, {
      nombre: prospecto.nombre,
      telefono: prospecto.telefono || "",
      direccion: prospecto.direccion || "",
      giro: prospecto.giro || "",
      ingenieroId: prospecto.ingenieroId || null,
      ingenieroAlias: prospecto.ingenieroAlias || null,
      frecuenciaVisita: frecuencia,
      segmento,
      limiteCredito: credito,
      activo: true,
      prospectoId: id,
      ultimaVisita: null,
      creadoPor: Sesion.alias,
      _ts: Date.now()
    });

    // Marcar prospecto GANADO
    await updateDoc(doc(db,"prospectos",id), {
      etapa: "GANADO", clienteId: clienteRef.id,
      ganadorEn: Date.now(), _ts: Date.now()
    });

    window.toast?.("¡Prospecto convertido a cliente! 🎉","success");
    document.getElementById("crm-conv-modal")?.classList.add("hidden");
    document.getElementById("crm-panel")?.classList.add("hidden");
  } catch(e) { window.toast?.(e.message,"error"); }
  finally { btn.disabled = false; btn.textContent = "✓ Convertir a cliente"; }
}
