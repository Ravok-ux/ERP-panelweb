// ══════════════════════════════════════════════════════════════
// logistica.js — Visitas programadas por frecuencia
// Modelo: ingeniero lleva stock en su auto y visita clientes según
//         frecuencia (SEMANAL / QUINCENAL / MENSUAL / BIMESTRAL)
// Panel web: calendario de visitas por día / ingeniero
// APK: lista "mis clientes hoy" calculada desde este módulo
// Colecciones: clientes (campo frecuenciaVisita + ultimaVisita)
//              visitas_programadas
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc } from "./app.js";
import { cargarNombres, resolverNombre } from "./nombres-cache.js";
import {
  collection, doc, query, where, orderBy, limit,
  onSnapshot, addDoc, updateDoc, getDocs, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmtFecha = ts => ts
  ? new Date(typeof ts === "number" ? ts : ts.toMillis?.() ?? ts)
      .toLocaleDateString("es-MX", { day:"2-digit", month:"short", year:"numeric" })
  : "—";
const fmtHora  = ts => ts
  ? new Date(typeof ts === "number" ? ts : ts.toMillis?.() ?? ts)
      .toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit" })
  : "—";

const FRECUENCIA_DIAS = { SEMANAL:7, QUINCENAL:15, MENSUAL:30, BIMESTRAL:60 };
const FREQ_LABEL      = { SEMANAL:"Semanal",QUINCENAL:"Quincenal",MENSUAL:"Mensual",BIMESTRAL:"Bimestral" };
const STATUS_BADGE = {
  PENDIENTE: `<span class="badge badge-amber">PENDIENTE</span>`,
  COMPLETADA:`<span class="badge" style="background:#DCFCE7;color:#15803D">COMPLETADA</span>`,
  OMITIDA:   `<span class="badge badge-gray">OMITIDA</span>`,
};

let _unsubs     = [];
let _ingenieros = [];

export const LogisticaModule = {
  mount(container) {
    cargarNombres();
    container.innerHTML = `
    <div class="mod-wrap">
      <div class="mod-topbar">
        <h2 class="mod-title">🚗 Logística de visitas</h2>
        <div class="mod-actions">
          <button class="btn-outline" id="log-gen-semana-btn">📅 Generar semana</button>
          <button class="btn-primary" id="log-gen-btn">⚡ Generar visitas del día</button>
        </div>
      </div>

      <!-- Tabs vista -->
      <div style="display:flex;gap:0;margin-bottom:16px;border-bottom:2px solid var(--border);flex-wrap:wrap">
        <button class="log-tab active" data-tab="dia"         style="padding:8px 20px;background:none;border:none;cursor:pointer;font-weight:700;font-size:13px;border-bottom:2px solid var(--primary);margin-bottom:-2px;color:var(--primary)">📋 Día</button>
        <button class="log-tab" data-tab="semana"             style="padding:8px 20px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-sec)">📅 Semana</button>
        <button class="log-tab" data-tab="atrasados"          style="padding:8px 20px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-sec)">⚠️ Atrasados</button>
        <button class="log-tab" data-tab="rutas"              style="padding:8px 20px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-sec)">🗺️ Rutas</button>
        <button class="log-tab" data-tab="entregas"           style="padding:8px 20px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-sec)">📦 Entregas campo</button>
        <button class="log-tab" data-tab="cumplimiento"       style="padding:8px 20px;background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-sec)">📊 Cumplimiento</button>
      </div>

      <!-- Vista día -->
      <div id="log-tab-dia">

      <!-- Filtros -->
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
        <select class="sel-sm" id="log-filtro-ing">
          <option value="">Todos los ingenieros</option>
        </select>
        <select class="sel-sm" id="log-filtro-status">
          <option value="">Todos los estados</option>
          <option value="PENDIENTE">Pendiente</option>
          <option value="COMPLETADA">Completada</option>
          <option value="OMITIDA">Omitida</option>
        </select>
        <input type="date" class="sel-sm" id="log-fecha" value="${new Date().toISOString().slice(0,10)}">
        <button class="btn-outline" id="log-buscar-btn">Buscar</button>
      </div>

      <!-- KPIs -->
      <div class="kpi-row" style="margin-bottom:16px">
        <div class="kpi-card" style="border-left-color:#D97706">
          <div class="kpi-icon">📋</div><div class="kpi-val" id="log-kpi-total">–</div>
          <div class="kpi-label">Visitas del día</div>
        </div>
        <div class="kpi-card" style="border-left-color:#16A34A">
          <div class="kpi-icon">✅</div><div class="kpi-val" id="log-kpi-comp">–</div>
          <div class="kpi-label">Completadas</div>
        </div>
        <div class="kpi-card" style="border-left-color:#DC2626">
          <div class="kpi-icon">⏳</div><div class="kpi-val" id="log-kpi-pend">–</div>
          <div class="kpi-label">Pendientes</div>
        </div>
        <div class="kpi-card" style="border-left-color:#1D4ED8">
          <div class="kpi-icon">📊</div><div class="kpi-val" id="log-kpi-pct">–</div>
          <div class="kpi-label">% cumplimiento</div>
        </div>
      </div>

      <!-- Tabla de visitas -->
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>
            <th>INGENIERO</th><th>CLIENTE</th><th>FRECUENCIA</th>
            <th>ÚLT. VISITA</th><th>STATUS</th><th>CHECK-IN</th>
            <th>NOTAS</th><th>ACCIONES</th>
          </tr></thead>
          <tbody id="log-body">
            <tr><td colspan="8" style="padding:24px;text-align:center;color:var(--text-sec)">
              Selecciona una fecha y presiona Buscar</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Sección clientes por frecuencia -->
      <div style="margin-top:32px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <h3 style="font-size:15px;font-weight:700;margin:0">📋 Clientes y frecuencias asignadas</h3>
          <div style="display:flex;gap:8px">
            <select class="sel-sm" id="log-clientes-ing">
              <option value="">Todos los ingenieros</option>
            </select>
            <select class="sel-sm" id="log-clientes-frec">
              <option value="">Todas las frecuencias</option>
              <option value="SEMANAL">Semanal</option>
              <option value="QUINCENAL">Quincenal</option>
              <option value="MENSUAL">Mensual</option>
              <option value="BIMESTRAL">Bimestral</option>
            </select>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr>
              <th>CLIENTE</th><th>INGENIERO</th><th>FRECUENCIA</th>
              <th>ÚLTIMA VISITA</th><th>PRÓXIMA VISITA</th><th>DÍAS RESTANTES</th>
            </tr></thead>
            <tbody id="log-clientes-body">
              <tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div><!-- /log-tab-dia -->

      <!-- Vista semana -->
      <div id="log-tab-semana" style="display:none">
        <div id="log-semana-grid"></div>
      </div>

      <!-- Vista atrasados -->
      <div id="log-tab-atrasados" style="display:none">
        <div id="log-atrasados-content"></div>
      </div>

      <!-- Vista rutas -->
      <div id="log-tab-rutas" style="display:none">
        <div id="log-rutas-content"></div>
      </div>

      <!-- Vista entregas campo -->
      <div id="log-tab-entregas" style="display:none">
        <div id="log-entregas-content"></div>
      </div>

      <!-- Vista cumplimiento -->
      <div id="log-tab-cumplimiento" style="display:none">
        <div id="log-cumplimiento-content"></div>
      </div>

    </div>`;

    _cargarIngenieros().then(() => {
      _escucharVisitas();
      _escucharClientes();
    });
    _bindUI();
    return () => this.destroy();
  },
  destroy() { _unsubs.forEach(u => u?.()); _unsubs = []; }
};

async function _cargarIngenieros() {
  const snap = await getDocs(query(collection(db,"usuarios"), where("activo","==",true), orderBy("alias")));
  _ingenieros = snap.docs
    .filter(d => ["INGENIERO","RECUPERADOR"].includes(d.data().rol))
    .map(d => ({ uid: d.id, ...d.data() }));
  const opts = _ingenieros.map(u => `<option value="${esc(u.uid)}">${esc(u.alias||u.uid)}</option>`).join("");
  ["log-filtro-ing","log-clientes-ing"].forEach(id => {
    document.getElementById(id)?.insertAdjacentHTML("beforeend", opts);
  });
}

function _bindUI() {
  document.getElementById("log-buscar-btn")?.addEventListener("click", _escucharVisitas);
  document.getElementById("log-filtro-ing")?.addEventListener("change", _escucharVisitas);
  document.getElementById("log-filtro-status")?.addEventListener("change", _escucharVisitas);
  document.getElementById("log-clientes-ing")?.addEventListener("change", _escucharClientes);
  document.getElementById("log-clientes-frec")?.addEventListener("change", _escucharClientes);
  document.getElementById("log-gen-btn")?.addEventListener("click", _generarVisitasDelDia);
  document.getElementById("log-gen-semana-btn")?.addEventListener("click", _generarVisitasSemana);

  // Tabs
  document.querySelectorAll(".log-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".log-tab").forEach(b => {
        b.classList.remove("active");
        b.style.borderBottom = "none";
        b.style.color = "var(--text-sec)";
        b.style.fontWeight = "400";
      });
      btn.classList.add("active");
      btn.style.borderBottom = "2px solid var(--primary)";
      btn.style.color = "var(--primary)";
      btn.style.fontWeight = "700";
      const tab = btn.dataset.tab;
      document.getElementById("log-tab-dia").style.display          = tab === "dia"          ? "" : "none";
      document.getElementById("log-tab-semana").style.display       = tab === "semana"       ? "" : "none";
      document.getElementById("log-tab-atrasados").style.display    = tab === "atrasados"    ? "" : "none";
      document.getElementById("log-tab-rutas").style.display        = tab === "rutas"        ? "" : "none";
      document.getElementById("log-tab-entregas").style.display     = tab === "entregas"     ? "" : "none";
      document.getElementById("log-tab-cumplimiento").style.display = tab === "cumplimiento" ? "" : "none";
      if (tab === "semana")      _cargarVistaSemana();
      if (tab === "atrasados")   _cargarAtrasados();
      if (tab === "rutas")       _montarRutas();
      if (tab === "entregas")    _montarEntregas();
      if (tab === "cumplimiento")_montarCumplimiento();
    });
  });
}

// ── Visitas programadas ───────────────────────────────────────
function _escucharVisitas() {
  _unsubs.filter(u => u._tag === "visitas").forEach(u => u?.());
  _unsubs = _unsubs.filter(u => u._tag !== "visitas");

  const fecha  = document.getElementById("log-fecha")?.value || new Date().toISOString().slice(0,10);
  const ingId  = document.getElementById("log-filtro-ing")?.value || "";
  const status = document.getElementById("log-filtro-status")?.value || "";

  const [y,m,d] = fecha.split("-").map(Number);
  const desdeTs = new Date(y,m-1,d,0,0,0).getTime();
  const hastaTs = new Date(y,m-1,d,23,59,59).getTime();

  let constraints = [
    where("fechaTs",">=",desdeTs), where("fechaTs","<=",hastaTs),
    orderBy("fechaTs","asc"), limit(500)
  ];
  if (ingId)  constraints = [where("ingenieroId","==",ingId), ...constraints];
  if (status) constraints = [where("status","==",status), ...constraints];
  const q = query(collection(db,"visitas_programadas"), ...constraints);

  const tbody = document.getElementById("log-body");
  if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center">Cargando…</td></tr>`;

  const unsub = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderVisitas(rows);
  }, err => console.error("[Logistica]", err));
  unsub._tag = "visitas";
  _unsubs.push(unsub);
}

function _renderVisitas(rows) {
  const total = rows.length;
  const comp  = rows.filter(r => r.status === "COMPLETADA").length;
  const pend  = rows.filter(r => r.status === "PENDIENTE").length;
  const pct   = total > 0 ? Math.round(comp/total*100) : 0;

  const el = id => document.getElementById(id);
  if(el("log-kpi-total")) el("log-kpi-total").textContent = total;
  if(el("log-kpi-comp"))  el("log-kpi-comp").textContent  = comp;
  if(el("log-kpi-pend"))  el("log-kpi-pend").textContent  = pend;
  if(el("log-kpi-pct"))   el("log-kpi-pct").textContent   = pct + "%";

  const tbody = document.getElementById("log-body");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:32px;text-align:center;color:var(--text-sec)">
      Sin visitas programadas para esta fecha</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const isPend = r.status === "PENDIENTE";
    return `<tr>
      <td style="font-weight:600">${esc(resolverNombre(r.ingenieroAlias))}</td>
      <td>
        <div style="font-weight:700">${esc(r.clienteNombre||"–")}</div>
        <div style="font-size:11px;color:var(--text-sec)">${esc(r.clienteDireccion||"")}</div>
      </td>
      <td><span class="badge badge-gray" style="font-size:10px">${esc(FREQ_LABEL[r.frecuencia]||r.frecuencia||"–")}</span></td>
      <td style="font-size:11px;color:var(--text-sec)">${fmtFecha(r.ultimaVisita)}</td>
      <td>${STATUS_BADGE[r.status] || `<span class="badge badge-gray">${esc(r.status)}</span>`}</td>
      <td style="font-size:11px;color:var(--text-sec)">${r.checkInTs ? fmtHora(r.checkInTs) : "–"}</td>
      <td style="font-size:11px;max-width:160px;color:var(--text-sec)">${esc(r.notas||"")}</td>
      <td style="white-space:nowrap">
        ${isPend ? `
          <button class="btn-sm btn-green" data-id="${r.id}" data-act="comp">✓ Completar</button>
          <button class="btn-sm btn-outline" data-id="${r.id}" data-act="omit" style="margin-left:4px">Omitir</button>
        ` : "–"}
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const { id, act } = btn.dataset;
      if (act === "comp") {
        const notas = await window.promptModal({ title: "Completar visita", label: "Notas de la visita (opcional)", placeholder: "Notas…" });
        if (notas === null) return;
        await updateDoc(doc(db,"visitas_programadas",id), {
          status: "COMPLETADA", notas: notas||"",
          checkInTs: Date.now(), completadaEn: Date.now()
        });
        // Actualizar ultimaVisita en el cliente
        const row = rows.find(r => r.id === id);
        if (row?.clienteId) {
          await updateDoc(doc(db,"clientes",row.clienteId), { ultimaVisita: Date.now() });
        }
        window.toast?.("Visita completada","success");
      } else {
        await updateDoc(doc(db,"visitas_programadas",id), { status:"OMITIDA" });
        window.toast?.("Visita omitida","info");
      }
    });
  });
}

// ── Clientes con frecuencia ───────────────────────────────────
let _clientesUnsub = null;

function _escucharClientes() {
  _clientesUnsub?.(); _clientesUnsub = null;
  const ingId = document.getElementById("log-clientes-ing")?.value || "";
  const frec  = document.getElementById("log-clientes-frec")?.value || "";

  let constraints = [where("activo","==",true), orderBy("nombre"), limit(500)];
  if (ingId) constraints = [where("ingenieroId","==",ingId), ...constraints];
  if (frec)  constraints = [where("frecuenciaVisita","==",frec), ...constraints];
  const q = query(collection(db,"clientes"), ...constraints);

  const tbody = document.getElementById("log-clientes-body");
  _clientesUnsub = onSnapshot(q, snap => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.frecuenciaVisita); // solo clientes con frecuencia asignada
    _renderClientesFrecuencia(rows);
  }, err => console.error("[Logistica-Clientes]", err));
  _unsubs.push(_clientesUnsub);
}

function _renderClientesFrecuencia(rows) {
  const tbody = document.getElementById("log-clientes-body");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-sec)">
      Sin clientes con frecuencia asignada</td></tr>`;
    return;
  }
  const ahora = Date.now();
  tbody.innerHTML = rows.map(r => {
    const dias   = FRECUENCIA_DIAS[r.frecuenciaVisita] || 30;
    const ultima = r.ultimaVisita || 0;
    const proxTs = ultima + dias * 86400000;
    const faltan = Math.ceil((proxTs - ahora) / 86400000);
    const atrasado = faltan < 0;
    const hoy      = faltan === 0;
    const colorDias = atrasado ? "#DC2626" : hoy ? "#D97706" : faltan <= 2 ? "#D97706" : "#16A34A";

    return `<tr>
      <td style="font-weight:700">${esc(r.nombre||"–")}</td>
      <td style="font-size:12px">${esc(resolverNombre(r.ingenieroAlias))}</td>
      <td><span class="badge badge-gray" style="font-size:10px">${esc(FREQ_LABEL[r.frecuenciaVisita]||r.frecuenciaVisita)}</span></td>
      <td style="font-size:11px;color:var(--text-sec)">${ultima ? fmtFecha(ultima) : "Nunca"}</td>
      <td style="font-size:11px">${fmtFecha(proxTs)}</td>
      <td style="font-weight:700;color:${colorDias}">
        ${atrasado ? `⚠️ ${Math.abs(faltan)} días atrasado` : hoy ? "📍 HOY" : `${faltan} días`}
      </td>
    </tr>`;
  }).join("");
}

// ── Generar visitas del día ───────────────────────────────────
async function _generarVisitasDelDia() {
  const fecha    = document.getElementById("log-fecha")?.value || new Date().toISOString().slice(0,10);
  const [y,m,d]  = fecha.split("-").map(Number);
  const fechaTs   = new Date(y,m-1,d,0,0,0).getTime();
  const fechaFinTs= new Date(y,m-1,d,23,59,59).getTime();
  const ahora     = Date.now();

  if (!await window.modal({ title: "Generar visitas", message: `¿Generar visitas programadas para el ${fecha}? Solo se crearán clientes cuya próxima visita cae en esa fecha.`, confirmLabel: "Generar" })) return;

  const btn = document.getElementById("log-gen-btn");
  btn.disabled = true; btn.textContent = "Generando…";

  try {
    const snap = await getDocs(query(
      collection(db,"clientes"),
      where("activo","==",true),
      limit(500)
    ));
    const clientes = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.frecuenciaVisita);

    // Verificar visitas ya existentes ese día
    const existSnap = await getDocs(query(
      collection(db,"visitas_programadas"),
      where("fechaTs",">=",fechaTs),
      where("fechaTs","<=",fechaFinTs)
    ));
    const yaExisten = new Set(existSnap.docs.map(d => d.data().clienteId));

    const batch = [];
    for (const c of clientes) {
      if (yaExisten.has(c.id)) continue;
      const dias   = FRECUENCIA_DIAS[c.frecuenciaVisita] || 30;
      const ultima = c.ultimaVisita || 0;
      const proxTs = ultima + dias * 86400000;
      // Incluir si la próxima visita cae dentro del día seleccionado o está atrasada y el día es hoy/futuro
      const proxFecha = new Date(proxTs).toISOString().slice(0,10);
      if (proxFecha !== fecha) continue;

      batch.push(addDoc(collection(db,"visitas_programadas"), {
        clienteId:       c.id,
        clienteNombre:   c.nombre || "",
        clienteDireccion:c.direccion || "",
        ingenieroId:     c.ingenieroId || null,
        ingenieroAlias:  c.ingenieroAlias || null,
        frecuencia:      c.frecuenciaVisita,
        fecha,
        fechaTs,
        ultimaVisita:    c.ultimaVisita || null,
        status:          "PENDIENTE",
        generadoEn:      ahora,
        _ts:             ahora
      }));
    }

    if (!batch.length) {
      window.toast?.("No hay visitas que generar para esa fecha","info");
    } else {
      await Promise.all(batch);
      window.toast?.(`${batch.length} visitas generadas para ${fecha}`,"success");
    }
    _escucharVisitas();
  } catch(e) { window.toast?.(e.message,"error"); }
  finally { btn.disabled = false; btn.textContent = "⚡ Generar visitas del día"; }
}

// ══════════════════════════════════════════════════════════════
// VISTA SEMANAL
// ══════════════════════════════════════════════════════════════

// Devuelve [lunes, martes, … domingo] de la semana que contiene `fecha`
function _diasSemana(fecha = new Date()) {
  const d = new Date(fecha); d.setHours(0,0,0,0);
  const dow = (d.getDay() + 6) % 7; // 0=lun … 6=dom
  const lunes = new Date(d); lunes.setDate(d.getDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(lunes); x.setDate(lunes.getDate() + i);
    return x;
  });
}

const _DIA_LABEL = ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"];

async function _cargarVistaSemana() {
  const wrap = document.getElementById("log-semana-grid");
  if (!wrap) return;
  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-sec)">Cargando semana…</div>`;

  try {
    const dias   = _diasSemana();
    const desde  = dias[0].getTime();
    const hasta  = dias[6].getTime() + 86_399_999;

    const snap = await getDocs(query(
      collection(db,"visitas_programadas"),
      where("fechaTs",">=",desde), where("fechaTs","<=",hasta),
      orderBy("fechaTs","asc"), limit(2000)
    ));
    const visitas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Agrupar por día (iso) y por status
    const porDia = {}; // "yyyy-mm-dd" → { total, comp, pend, omit, ings: Set }
    visitas.forEach(v => {
      const k = v.fecha || new Date(v.fechaTs).toISOString().slice(0,10);
      if (!porDia[k]) porDia[k] = { total:0, comp:0, pend:0, omit:0, ings: new Set() };
      porDia[k].total++;
      if (v.status === "COMPLETADA") porDia[k].comp++;
      else if (v.status === "OMITIDA") porDia[k].omit++;
      else porDia[k].pend++;
      if (v.ingenieroAlias) porDia[k].ings.add(v.ingenieroAlias);
    });

    // Semana de navegación
    const semanaLabel = `${dias[0].toLocaleDateString("es-MX",{day:"numeric",month:"short"})} – ${dias[6].toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"})}`;
    const hoyIso = new Date().toISOString().slice(0,10);

    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:700">Semana: ${semanaLabel}</span>
        <button class="btn-outline" id="log-sem-prev" style="font-size:12px;padding:4px 12px">‹ Anterior</button>
        <button class="btn-outline" id="log-sem-hoy" style="font-size:12px;padding:4px 12px">Hoy</button>
        <button class="btn-outline" id="log-sem-next" style="font-size:12px;padding:4px 12px">Siguiente ›</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px">
        ${dias.map((dia, i) => {
          const iso  = dia.toISOString().slice(0,10);
          const data = porDia[iso] || { total:0, comp:0, pend:0, omit:0, ings: new Set() };
          const esHoy = iso === hoyIso;
          const pct  = data.total ? Math.round(data.comp / data.total * 100) : null;
          const barW = pct ?? 0;
          const ings = [...data.ings].slice(0,3).join(", ") + (data.ings.size > 3 ? ` +${data.ings.size-3}` : "");
          return `
            <div data-fecha="${esc(iso)}" class="log-sem-dia"
              style="border:1px solid ${esHoy ? "var(--primary)" : "var(--border)"};
                     border-radius:10px;padding:10px 8px;cursor:pointer;
                     background:${esHoy ? "var(--primary-light,#EFF6FF)" : "var(--card-bg,#fff)"};
                     transition:box-shadow .15s"
              onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,.12)'"
              onmouseout="this.style.boxShadow='none'">
              <div style="font-size:11px;font-weight:700;color:${esHoy?"var(--primary)":"var(--text-sec)"};text-transform:uppercase;letter-spacing:.04em">${_DIA_LABEL[i]}</div>
              <div style="font-size:20px;font-weight:800;margin:2px 0;color:${esHoy?"var(--primary)":"var(--text-primary)"}">${dia.getDate()}</div>
              ${data.total ? `
                <div style="font-size:11px;color:var(--text-sec);margin-bottom:4px">${data.total} visita${data.total!==1?"s":""}</div>
                <div style="height:4px;border-radius:2px;background:var(--border);margin-bottom:4px;overflow:hidden">
                  <div style="height:100%;width:${barW}%;background:#16A34A;border-radius:2px;transition:width .3s"></div>
                </div>
                <div style="font-size:10px;display:flex;gap:4px;flex-wrap:wrap">
                  ${data.comp ? `<span style="color:#16A34A">✓${data.comp}</span>` : ""}
                  ${data.pend ? `<span style="color:#D97706">⏳${data.pend}</span>` : ""}
                  ${data.omit ? `<span style="color:#9CA3AF">–${data.omit}</span>` : ""}
                </div>
                ${ings ? `<div style="font-size:9px;color:var(--text-sec);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(ings)}</div>` : ""}
              ` : `<div style="font-size:11px;color:var(--text-sec)">Sin visitas</div>`}
            </div>`;
        }).join("")}
      </div>

      <!-- Detalle del día seleccionado -->
      <div id="log-sem-detalle" style="margin-top:20px"></div>`;

    // Click en día → muestra tabla de ese día
    wrap.querySelectorAll(".log-sem-dia").forEach(card => {
      card.addEventListener("click", () => {
        const fecha = card.dataset.fecha;
        document.getElementById("log-fecha").value = fecha;
        document.querySelector(".log-tab[data-tab='dia']").click();
        _escucharVisitas();
      });
    });

    // Navegación semana anterior / siguiente / hoy
    let _semRef = dias[0];
    wrap.querySelector("#log-sem-prev")?.addEventListener("click", () => {
      _semRef = new Date(_semRef); _semRef.setDate(_semRef.getDate() - 7);
      _cargarVistaSemanaDesde(_semRef);
    });
    wrap.querySelector("#log-sem-next")?.addEventListener("click", () => {
      _semRef = new Date(_semRef); _semRef.setDate(_semRef.getDate() + 7);
      _cargarVistaSemanaDesde(_semRef);
    });
    wrap.querySelector("#log-sem-hoy")?.addEventListener("click", () => {
      _semRef = new Date(); _cargarVistaSemanaDesde(_semRef);
    });

  } catch(e) {
    wrap.innerHTML = `<div style="padding:16px;color:#DC2626">${esc(e.message)}</div>`;
    console.error("[Logistica-Semana]", e);
  }
}

// Re-renderiza la semana a partir de un Date de referencia
async function _cargarVistaSemanaDesde(ref) {
  // Actualizamos el input de fecha al lunes de la semana y recargamos
  const dias  = _diasSemana(ref);
  document.getElementById("log-fecha").value = dias[0].toISOString().slice(0,10);
  await _cargarVistaSemana();
}

// ══════════════════════════════════════════════════════════════
// CLIENTES ATRASADOS
// ══════════════════════════════════════════════════════════════

async function _cargarAtrasados() {
  const wrap = document.getElementById("log-atrasados-content");
  if (!wrap) return;
  wrap.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-sec)">Calculando clientes atrasados…</div>`;

  try {
    const ahora = Date.now();
    const snap  = await getDocs(query(
      collection(db,"clientes"),
      where("activo","==",true),
      limit(600)
    ));
    const todos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.frecuenciaVisita);

    const atrasados = todos
      .map(c => {
        const dias   = FRECUENCIA_DIAS[c.frecuenciaVisita] || 30;
        const ultima = c.ultimaVisita || 0;
        const proxTs = ultima + dias * 86_400_000;
        const retraso = Math.floor((ahora - proxTs) / 86_400_000);
        return { ...c, dias, proxTs, retraso };
      })
      .filter(c => c.retraso > 0)
      .sort((a, b) => b.retraso - a.retraso);

    if (!atrasados.length) {
      wrap.innerHTML = `
        <div style="padding:48px;text-align:center;color:var(--text-sec)">
          <div style="font-size:32px;margin-bottom:8px">✅</div>
          <div style="font-weight:700;font-size:15px">Ningún cliente atrasado</div>
          <div style="font-size:12px;margin-top:4px">Todos los clientes tienen sus visitas al día</div>
        </div>`;
      return;
    }

    const criticos = atrasados.filter(c => c.retraso > c.dias);       // más de un período
    const normales  = atrasados.filter(c => c.retraso <= c.dias);

    const color = r => r > 30 ? "#DC2626" : r > 14 ? "#D97706" : "#F59E0B";

    const renderFila = c => `
      <tr>
        <td style="font-weight:700">${esc(c.nombre||"–")}</td>
        <td style="font-size:12px">${esc(resolverNombre(c.ingenieroAlias))}</td>
        <td><span class="badge badge-gray" style="font-size:10px">${esc(FREQ_LABEL[c.frecuenciaVisita]||c.frecuenciaVisita)}</span></td>
        <td style="font-size:11px;color:var(--text-sec)">${c.ultimaVisita ? fmtFecha(c.ultimaVisita) : "Nunca"}</td>
        <td style="font-weight:800;color:${color(c.retraso)}">⚠️ ${c.retraso} día${c.retraso!==1?"s":""}</td>
      </tr>`;

    wrap.innerHTML = `
      <!-- KPIs atrasados -->
      <div class="kpi-row" style="margin-bottom:20px">
        <div class="kpi-card" style="border-left-color:#DC2626">
          <div class="kpi-icon">🚨</div>
          <div class="kpi-val">${criticos.length}</div>
          <div class="kpi-label">Críticos (más de un período)</div>
        </div>
        <div class="kpi-card" style="border-left-color:#D97706">
          <div class="kpi-icon">⚠️</div>
          <div class="kpi-val">${normales.length}</div>
          <div class="kpi-label">Levemente atrasados</div>
        </div>
        <div class="kpi-card" style="border-left-color:#6B7280">
          <div class="kpi-icon">👥</div>
          <div class="kpi-val">${atrasados.length}</div>
          <div class="kpi-label">Total atrasados</div>
        </div>
      </div>

      ${criticos.length ? `
        <h3 style="font-size:13px;font-weight:700;color:#DC2626;margin-bottom:8px">🚨 Críticos — más de un período sin visita</h3>
        <div style="overflow-x:auto;margin-bottom:24px">
          <table class="data-table">
            <thead><tr><th>CLIENTE</th><th>INGENIERO</th><th>FRECUENCIA</th><th>ÚLTIMA VISITA</th><th>RETRASO</th></tr></thead>
            <tbody>${criticos.map(renderFila).join("")}</tbody>
          </table>
        </div>` : ""}

      ${normales.length ? `
        <h3 style="font-size:13px;font-weight:700;color:#D97706;margin-bottom:8px">⚠️ Pendientes de visita</h3>
        <div style="overflow-x:auto">
          <table class="data-table">
            <thead><tr><th>CLIENTE</th><th>INGENIERO</th><th>FRECUENCIA</th><th>ÚLTIMA VISITA</th><th>RETRASO</th></tr></thead>
            <tbody>${normales.map(renderFila).join("")}</tbody>
          </table>
        </div>` : ""}`;

  } catch(e) {
    wrap.innerHTML = `<div style="padding:16px;color:#DC2626">${esc(e.message)}</div>`;
    console.error("[Logistica-Atrasados]", e);
  }
}

// ══════════════════════════════════════════════════════════════
// GENERADOR INTELIGENTE DE SEMANA
// Genera visitas para toda la semana actual:
// - Clientes cuya próxima visita cae dentro de Lun-Dom
// - Clientes atrasados (proxTs < hoy): se asignan al día de hoy o al primer día futuro disponible
// ══════════════════════════════════════════════════════════════

async function _generarVisitasSemana() {
  const dias   = _diasSemana();
  const lunes  = dias[0];
  const domingo= dias[6];
  const semLabel = `${lunes.toLocaleDateString("es-MX",{day:"numeric",month:"short"})} – ${domingo.toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"})}`;

  if (!await window.modal({
    title: "Generar visitas de la semana",
    message: `¿Generar visitas programadas para ${semLabel}?\n\nIncluye clientes cuya próxima visita cae esta semana y clientes con retraso.`,
    confirmLabel: "Generar"
  })) return;

  const btn = document.getElementById("log-gen-semana-btn");
  btn.disabled = true; btn.textContent = "Generando…";

  try {
    const ahora    = Date.now();
    const desdeTs  = lunes.getTime();
    const hastaTs  = domingo.getTime() + 86_399_999;
    const hoyIso   = new Date().toISOString().slice(0,10);

    // Clientes con frecuencia
    const cliSnap = await getDocs(query(
      collection(db,"clientes"), where("activo","==",true), limit(600)
    ));
    const clientes = cliSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(c => c.frecuenciaVisita);

    // Visitas ya existentes esta semana (para deduplicar)
    const existSnap = await getDocs(query(
      collection(db,"visitas_programadas"),
      where("fechaTs",">=",desdeTs), where("fechaTs","<=",hastaTs)
    ));
    const yaExisten = new Set(existSnap.docs.map(d => d.data().clienteId));

    const pendientes = [];  // { cliente, fecha, fechaTs }

    for (const c of clientes) {
      if (yaExisten.has(c.id)) continue;

      const diasFrec = FRECUENCIA_DIAS[c.frecuenciaVisita] || 30;
      const ultima   = c.ultimaVisita || 0;
      const proxTs   = ultima + diasFrec * 86_400_000;
      const proxIso  = new Date(proxTs).toISOString().slice(0,10);

      let fechaAsignar = null;
      let fechaTsAsignar = null;

      if (proxTs >= desdeTs && proxTs <= hastaTs) {
        // Próxima visita cae dentro de la semana — asignar en esa fecha exacta
        fechaAsignar   = proxIso;
        fechaTsAsignar = new Date(proxTs).setHours(0,0,0,0);
      } else if (proxTs < desdeTs) {
        // Atrasado — asignar al día de hoy si cae en la semana, si no al lunes
        const refDia = ahora >= desdeTs && ahora <= hastaTs ? hoyIso : lunes.toISOString().slice(0,10);
        fechaAsignar   = refDia;
        const [y,m,d]  = refDia.split("-").map(Number);
        fechaTsAsignar = new Date(y,m-1,d,0,0,0).getTime();
      }

      if (!fechaAsignar) continue;

      pendientes.push(addDoc(collection(db,"visitas_programadas"), {
        clienteId:        c.id,
        clienteNombre:    c.nombre || "",
        clienteDireccion: c.direccion || "",
        ingenieroId:      c.ingenieroId || null,
        ingenieroAlias:   c.ingenieroAlias || null,
        frecuencia:       c.frecuenciaVisita,
        fecha:            fechaAsignar,
        fechaTs:          fechaTsAsignar,
        ultimaVisita:     c.ultimaVisita || null,
        status:           "PENDIENTE",
        generadoEn:       ahora,
        _ts:              ahora
      }));
    }

    if (!pendientes.length) {
      window.toast?.("No hay visitas nuevas que generar esta semana", "info");
    } else {
      await Promise.all(pendientes);
      window.toast?.(`✅ ${pendientes.length} visita${pendientes.length!==1?"s":""} generadas para ${semLabel}`, "success");
    }
    _cargarVistaSemana();
  } catch(e) {
    window.toast?.(e.message, "error");
    console.error("[GenerarSemana]", e);
  } finally {
    btn.disabled = false; btn.textContent = "📅 Generar semana";
  }
}

// ══════════════════════════════════════════════════════════════
// ALTO/69 — OPTIMIZACIÓN DE RUTAS
// Ordena las visitas pendientes del día por proximidad geográfica
// usando nearest-neighbor sobre coordenadas lat/lng de cada cliente
// ══════════════════════════════════════════════════════════════
async function _montarRutas() {
  const wrap = document.getElementById("log-rutas-content");
  if (!wrap) return;
  const hoy = new Date().toISOString().slice(0,10);
  wrap.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
      <h3 style="margin:0;font-size:15px;font-weight:800;flex:1">🗺️ Optimización de rutas del día</h3>
      <select class="sel-sm" id="rut-filtro-ing">
        <option value="">— Seleccionar ingeniero —</option>
        ${_ingenieros.map(u => `<option value="${esc(u.uid)}">${esc(u.alias||u.uid)}</option>`).join("")}
      </select>
      <input type="date" class="sel-sm" id="rut-fecha" value="${hoy}">
      <button class="btn-primary" id="rut-optimizar-btn">⚡ Calcular ruta óptima</button>
      <button class="btn-outline" id="rut-maps-btn" style="display:none">🗺️ Abrir en Maps</button>
    </div>
    <div id="rut-resultado">
      <div style="padding:32px;text-align:center;color:var(--text-sec);font-size:13px">
        Selecciona un ingeniero y presiona <strong>Calcular ruta óptima</strong>
      </div>
    </div>`;

  document.getElementById("rut-optimizar-btn")?.addEventListener("click", async () => {
    const ingId = document.getElementById("rut-filtro-ing")?.value;
    const fecha = document.getElementById("rut-fecha")?.value || hoy;
    if (!ingId) { window.toast?.("Selecciona un ingeniero","warn"); return; }
    await _calcularRutaOptima(ingId, fecha);
  });
}

async function _calcularRutaOptima(ingId, fecha) {
  const res = document.getElementById("rut-resultado");
  if (!res) return;
  res.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-sec)">Calculando ruta…</div>`;

  try {
    const [y,m,d] = fecha.split("-").map(Number);
    const desdeTs = new Date(y,m-1,d,0,0,0).getTime();
    const hastaTs = new Date(y,m-1,d,23,59,59).getTime();

    // Visitas pendientes del día para el ingeniero
    const vSnap = await getDocs(query(
      collection(db,"visitas_programadas"),
      where("ingenieroId","==",ingId),
      where("fechaTs",">=",desdeTs), where("fechaTs","<=",hastaTs),
      orderBy("fechaTs","asc"), limit(200)
    ));
    const visitas = vSnap.docs.map(d2 => ({ id: d2.id, ...d2.data() }));
    if (!visitas.length) {
      res.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-sec)">Sin visitas programadas para ese día</div>`;
      return;
    }

    // Obtener coordenadas de cada cliente
    const cIds = [...new Set(visitas.map(v => v.clienteId).filter(Boolean))];
    const coordMap = {};
    if (cIds.length) {
      const cSnap = await getDocs(query(collection(db,"clientes"), where("activo","==",true), limit(600)));
      cSnap.docs.forEach(d2 => {
        const data = d2.data();
        if (data.lat && data.lng) coordMap[d2.id] = { lat: data.lat, lng: data.lng };
      });
    }

    // Nearest-neighbor desde punto de origen (0,0 = sin GPS → ordenar por ciudad/zona)
    const conCoords = visitas.filter(v => coordMap[v.clienteId]);
    const sinCoords = visitas.filter(v => !coordMap[v.clienteId]);

    let rutaOrdenada = [];
    if (conCoords.length > 1) {
      const dist = (a, b) => {
        const dLat = a.lat - b.lat, dLng = a.lng - b.lng;
        return Math.sqrt(dLat*dLat + dLng*dLng);
      };
      let restantes = [...conCoords];
      let actual = coordMap[restantes[0].clienteId];
      while (restantes.length) {
        let minIdx = 0, minD = Infinity;
        restantes.forEach((v, i) => {
          const c = coordMap[v.clienteId];
          if (!c) return;
          const d2 = dist(actual, c);
          if (d2 < minD) { minD = d2; minIdx = i; }
        });
        const sel = restantes.splice(minIdx, 1)[0];
        rutaOrdenada.push(sel);
        actual = coordMap[sel.clienteId] || actual;
      }
    } else {
      rutaOrdenada = conCoords;
    }
    rutaOrdenada = [...rutaOrdenada, ...sinCoords];

    // Construir URL Google Maps waypoints
    const waypoints = rutaOrdenada
      .map(v => coordMap[v.clienteId])
      .filter(Boolean)
      .map(c => `${c.lat},${c.lng}`);
    const mapsUrl = waypoints.length >= 2
      ? `https://www.google.com/maps/dir/${waypoints.join("/")}`
      : waypoints.length === 1
      ? `https://www.google.com/maps/search/?api=1&query=${waypoints[0]}`
      : "";

    const mapsBtn = document.getElementById("rut-maps-btn");
    if (mapsBtn && mapsUrl) {
      mapsBtn.style.display = "";
      mapsBtn.onclick = () => window.open(mapsUrl, "_blank");
    }

    // Calcular distancia total estimada (grados → km aprox)
    let kmTotal = 0;
    for (let i = 1; i < rutaOrdenada.length; i++) {
      const a = coordMap[rutaOrdenada[i-1].clienteId];
      const b = coordMap[rutaOrdenada[i].clienteId];
      if (a && b) {
        const dLat = (a.lat - b.lat) * 111;
        const dLng = (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180);
        kmTotal += Math.sqrt(dLat*dLat + dLng*dLng);
      }
    }

    const ing = _ingenieros.find(u => u.uid === ingId);
    res.innerHTML = `
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap">
        <div class="kpi-card" style="border-left-color:#7C3AED">
          <div class="kpi-icon">📍</div>
          <div class="kpi-val">${rutaOrdenada.length}</div>
          <div class="kpi-label">Paradas</div>
        </div>
        <div class="kpi-card" style="border-left-color:#1D4ED8">
          <div class="kpi-icon">🛣️</div>
          <div class="kpi-val">${kmTotal > 0 ? kmTotal.toFixed(1)+" km" : "—"}</div>
          <div class="kpi-label">Dist. estimada</div>
        </div>
        <div class="kpi-card" style="border-left-color:#D97706">
          <div class="kpi-icon">⏱️</div>
          <div class="kpi-val">${kmTotal > 0 ? Math.round(kmTotal / 40 * 60) + " min" : "—"}</div>
          <div class="kpi-label">Tiempo aprox.</div>
        </div>
      </div>

      <div style="margin-bottom:10px;font-size:12px;color:var(--text-sec)">
        Ruta optimizada para <strong style="color:var(--text-primary)">${esc(ing?.alias||ingId)}</strong> — ${esc(fecha)}
        ${sinCoords.length ? `<span style="color:#D97706"> · ${sinCoords.length} sin coordenadas (al final)</span>` : ""}
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        ${rutaOrdenada.map((v, i) => {
          const coords = coordMap[v.clienteId];
          const sinGps = !coords;
          return `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;
            border:1px solid var(--border);border-radius:10px;background:var(--surface-2)">
            <div style="width:28px;height:28px;border-radius:50%;background:#7C3AED;color:#fff;
              font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;
              flex-shrink:0">${i+1}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:13px">${esc(v.clienteNombre||"–")}</div>
              <div style="font-size:11px;color:#64748B">${esc(v.clienteDireccion||"")}</div>
              ${sinGps ? `<div style="font-size:10px;color:#D97706">⚠️ Sin coordenadas GPS</div>` : ""}
            </div>
            <div style="text-align:right;flex-shrink:0">
              <span class="badge ${v.status==="COMPLETADA"?"badge-green":v.status==="OMITIDA"?"badge-gray":"badge-amber"}">
                ${v.status}
              </span>
              ${coords ? `<br><a href="https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}"
                target="_blank" rel="noopener"
                style="font-size:10px;color:#2563EB;text-decoration:none;margin-top:3px;display:inline-block">
                📍 Maps</a>` : ""}
            </div>
          </div>`;
        }).join("")}
      </div>`;
  } catch(e) {
    res.innerHTML = `<div style="padding:16px;color:#DC2626">${esc(e.message)}</div>`;
    console.error("[Rutas]", e);
  }
}

// ══════════════════════════════════════════════════════════════
// MEDIO/72 — REGISTRO DE ENTREGAS EN CAMPO
// Colección: entregas_campo
// Al registrar, crea AJUSTE_SALIDA en movimientos_stock
// ══════════════════════════════════════════════════════════════
function _montarEntregas() {
  const wrap = document.getElementById("log-entregas-content");
  if (!wrap) return;
  const hoy    = new Date().toISOString().slice(0,10);
  const hace7  = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
  wrap.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
      <h3 style="margin:0;font-size:15px;font-weight:800;flex:1">📦 Entregas en campo</h3>
      <button class="btn-primary" id="ent-nueva-btn">+ Registrar entrega</button>
    </div>

    <div class="kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left-color:#16A34A">
        <div class="kpi-icon">📦</div><div class="kpi-val" id="ent-kpi-total">–</div>
        <div class="kpi-label">Entregas</div>
      </div>
      <div class="kpi-card" style="border-left-color:#2563EB">
        <div class="kpi-icon">📏</div><div class="kpi-val" id="ent-kpi-unidades">–</div>
        <div class="kpi-label">Unidades entregadas</div>
      </div>
      <div class="kpi-card" style="border-left-color:#7C3AED">
        <div class="kpi-icon">💰</div><div class="kpi-val" id="ent-kpi-importe">–</div>
        <div class="kpi-label">Importe estimado</div>
      </div>
    </div>

    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <select class="sel-sm" id="ent-filtro-ing">
        <option value="">Todos los ingenieros</option>
        ${_ingenieros.map(u => `<option value="${esc(u.uid)}">${esc(u.alias||u.uid)}</option>`).join("")}
      </select>
      <span style="font-size:11px;color:var(--text-sec)">Desde</span>
      <input type="date" class="sel-sm" id="ent-desde" value="${hace7}">
      <span style="font-size:11px;color:var(--text-sec)">Hasta</span>
      <input type="date" class="sel-sm" id="ent-hasta" value="${hoy}">
      <button class="btn-outline" id="ent-filtrar">Filtrar</button>
    </div>

    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>FECHA</th><th>INGENIERO</th><th>CLIENTE</th>
          <th>PRODUCTOS</th><th style="text-align:right">IMPORTE</th><th>NOTAS</th>
        </tr></thead>
        <tbody id="ent-body">
          <tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Modal nueva entrega -->
    <div class="modal-overlay hidden" id="ent-modal">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;
        width:100%;max-width:560px;box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden;
        display:flex;flex-direction:column">
        <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
          <span style="font-size:22px">📦</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:800">Registrar entrega en campo</div>
            <div style="font-size:11px;color:#64748B">Genera automáticamente un movimiento de salida de inventario</div>
          </div>
          <button id="ent-modal-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#64748B">✕</button>
        </div>
        <div style="padding:18px 20px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;max-height:70vh">

          <!-- Ingeniero y cliente -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">INGENIERO</label>
              <select class="form-input" id="ent-ing" style="width:100%">
                <option value="">— Seleccionar —</option>
                ${_ingenieros.map(u => `<option value="${esc(u.uid)}" data-alias="${esc(u.alias||u.uid)}">${esc(u.alias||u.uid)}</option>`).join("")}
              </select>
            </div>
            <div>
              <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">VISITA ASOCIADA (opcional)</label>
              <select class="form-input" id="ent-visita" style="width:100%">
                <option value="">— Sin vincular —</option>
              </select>
            </div>
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">CLIENTE</label>
            <input class="form-input" id="ent-cliente" type="text" placeholder="Nombre del cliente" style="width:100%">
          </div>

          <!-- Productos -->
          <div>
            <div style="font-size:10px;font-weight:700;color:#64748B;text-transform:uppercase;margin-bottom:8px">
              Productos entregados
            </div>
            <div id="ent-prod-rows" style="display:flex;flex-direction:column;gap:6px"></div>
            <button id="ent-add-prod" type="button"
              style="margin-top:8px;padding:6px 14px;border:1px dashed var(--border);border-radius:7px;
                background:transparent;color:#64748B;font-size:11px;cursor:pointer;width:100%">
              + Agregar producto
            </button>
          </div>

          <div>
            <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">NOTAS</label>
            <input class="form-input" id="ent-notas" type="text" placeholder="Observaciones…" style="width:100%">
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border)">
          <button id="ent-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);
            background:transparent;color:#94A3B8;font-size:12px;cursor:pointer">Cancelar</button>
          <button id="ent-guardar" style="padding:8px 22px;border-radius:8px;border:none;
            background:#16A34A;color:#fff;font-size:12px;font-weight:700;cursor:pointer">✔ Registrar entrega</button>
        </div>
      </div>
    </div>`;

  // ── Catálogo de inventario para el buscador de productos ──
  let _cataloEnt = [];
  async function _cargarCatalogoEnt() {
    if (_cataloEnt.length) return;
    const { getDocs: gd2, collection: col2, orderBy: ob2, query: q2 } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const snap = await gd2(q2(col2(db,"inventario"), ob2("nombre")));
    _cataloEnt = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  let _entProdCount = 0;

  function _agregarFilaProd() {
    const idx = _entProdCount++;
    const row = document.createElement("div");
    row.dataset.prodIdx = idx;
    row.style.cssText = "display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center";
    row.innerHTML = `
      <div style="position:relative">
        <input type="text" placeholder="Buscar producto…" data-search="${idx}"
          style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
            font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
        <div data-lista="${idx}" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;
          background:var(--surface);border:1px solid var(--border);border-radius:6px;
          max-height:140px;overflow-y:auto;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,.4)"></div>
        <input type="hidden" data-prod-id="${idx}">
        <input type="hidden" data-prod-nom="${idx}">
        <input type="hidden" data-prod-costo="${idx}">
      </div>
      <input type="number" placeholder="Cant." min="1" step="1" data-cant="${idx}"
        style="width:70px;padding:7px 8px;border:1px solid var(--border);border-radius:6px;
          font-size:12px;background:var(--surface);color:var(--text-primary);text-align:center">
      <span style="font-size:11px;color:#64748B" data-total-label="${idx}">$0</span>
      <button type="button" data-del="${idx}"
        style="background:none;border:none;cursor:pointer;color:#DC2626;font-size:16px;padding:2px 4px">✕</button>`;
    document.getElementById("ent-prod-rows")?.appendChild(row);

    const searchInp = row.querySelector(`[data-search="${idx}"]`);
    const listaEl   = row.querySelector(`[data-lista="${idx}"]`);
    const cantInp   = row.querySelector(`[data-cant="${idx}"]`);
    const totalLbl  = row.querySelector(`[data-total-label="${idx}"]`);
    const prodIdInp = row.querySelector(`[data-prod-id="${idx}"]`);
    const prodNomInp= row.querySelector(`[data-prod-nom="${idx}"]`);
    const costoInp  = row.querySelector(`[data-prod-costo="${idx}"]`);

    searchInp?.addEventListener("focus", async () => {
      await _cargarCatalogoEnt();
      _renderListaProd(listaEl, searchInp.value, idx, prodIdInp, prodNomInp, costoInp, searchInp, totalLbl, cantInp);
    });
    searchInp?.addEventListener("input", () => {
      _renderListaProd(listaEl, searchInp.value, idx, prodIdInp, prodNomInp, costoInp, searchInp, totalLbl, cantInp);
    });
    cantInp?.addEventListener("input", () => {
      const c = parseFloat(cantInp.value||"0");
      const p = parseFloat(costoInp?.value||"0");
      if (totalLbl) totalLbl.textContent = "$" + (c*p).toLocaleString("es-MX",{maximumFractionDigits:0});
    });
    row.querySelector(`[data-del="${idx}"]`)?.addEventListener("click", () => row.remove());
    document.addEventListener("click", e => {
      if (!listaEl?.contains(e.target) && e.target !== searchInp) listaEl && (listaEl.style.display="none");
    });
  }

  function _renderListaProd(listaEl, term, idx, prodIdInp, prodNomInp, costoInp, searchInp, totalLbl, cantInp) {
    if (!listaEl) return;
    const { norm: nrm } = { norm: s => (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"") };
    const t = nrm(term);
    const matches = _cataloEnt.filter(p => !t || nrm(p.nombre||"").includes(t)).slice(0,25);
    if (!matches.length) { listaEl.style.display="none"; return; }
    listaEl.innerHTML = matches.map((p,i) =>
      `<div data-i="${i}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);
        display:flex;justify-content:space-between"
        onmouseenter="this.style.background='var(--surface-2)'"
        onmouseleave="this.style.background='transparent'">
        <div>
          <div style="font-size:12px;font-weight:600">${esc(p.nombre||"")}</div>
          <div style="font-size:10px;color:#64748B">Stock: ${p.stockActual??0} · $${p.costo||0}</div>
        </div>
      </div>`).join("");
    listaEl.querySelectorAll("[data-i]").forEach(el => {
      el.addEventListener("click", () => {
        const p = matches[parseInt(el.dataset.i)];
        if (prodIdInp)  prodIdInp.value  = p.id;
        if (prodNomInp) prodNomInp.value = p.nombre;
        if (costoInp)   costoInp.value   = p.costo || 0;
        if (searchInp)  searchInp.value  = p.nombre;
        const c = parseFloat(cantInp?.value||"1");
        if (totalLbl)   totalLbl.textContent = "$" + (c*(p.costo||0)).toLocaleString("es-MX",{maximumFractionDigits:0});
        listaEl.style.display="none";
      });
    });
    listaEl.style.display="block";
  }

  document.getElementById("ent-add-prod")?.addEventListener("click", _agregarFilaProd);
  _agregarFilaProd(); // fila inicial

  // ── Cargar visitas del ingeniero para vincular ──
  document.getElementById("ent-ing")?.addEventListener("change", async () => {
    const ingId = document.getElementById("ent-ing")?.value;
    const sel   = document.getElementById("ent-visita");
    if (!sel) return;
    sel.innerHTML = `<option value="">— Sin vincular —</option>`;
    if (!ingId) return;
    try {
      const hoyTs = new Date(); hoyTs.setHours(0,0,0,0);
      const snap  = await getDocs(query(
        collection(db,"visitas_programadas"),
        where("ingenieroId","==",ingId),
        where("fechaTs",">=",hoyTs.getTime()),
        where("fechaTs","<=",hoyTs.getTime()+86399999),
        orderBy("fechaTs","asc"), limit(50)
      ));
      snap.docs.forEach(d2 => {
        const v = d2.data();
        const opt = document.createElement("option");
        opt.value = d2.id;
        opt.textContent = v.clienteNombre||d2.id;
        opt.dataset.cliente = v.clienteNombre||"";
        sel.appendChild(opt);
      });
    } catch {}
  });

  // Auto-rellenar cliente al elegir visita
  document.getElementById("ent-visita")?.addEventListener("change", () => {
    const sel = document.getElementById("ent-visita");
    const opt = sel?.selectedOptions[0];
    const cli = document.getElementById("ent-cliente");
    if (cli && opt?.dataset.cliente) cli.value = opt.dataset.cliente;
  });

  // ── Modal lifecycle ──
  const cerrar = () => document.getElementById("ent-modal")?.classList.add("hidden");
  document.getElementById("ent-nueva-btn")?.addEventListener("click", () => {
    document.getElementById("ent-modal")?.classList.remove("hidden");
  });
  document.getElementById("ent-modal-close")?.addEventListener("click", cerrar);
  document.getElementById("ent-cancel")?.addEventListener("click", cerrar);
  document.getElementById("ent-modal")?.addEventListener("click", e => {
    if (e.target === document.getElementById("ent-modal")) cerrar();
  });

  // ── Guardar entrega ──
  document.getElementById("ent-guardar")?.addEventListener("click", async () => {
    const ingId    = document.getElementById("ent-ing")?.value;
    const ingAlias = document.getElementById("ent-ing")?.selectedOptions[0]?.dataset.alias || "";
    const visitaId = document.getElementById("ent-visita")?.value || "";
    const cliente  = document.getElementById("ent-cliente")?.value.trim();
    const notas    = document.getElementById("ent-notas")?.value.trim();

    if (!ingId)    { window.toast?.("Selecciona un ingeniero","warn"); return; }
    if (!cliente)  { window.toast?.("Ingresa el nombre del cliente","warn"); return; }

    // Recopilar filas de productos
    const rows2 = [...document.querySelectorAll("#ent-prod-rows > div")];
    const productos = rows2.map(row => {
      const idx2 = row.dataset.prodIdx;
      return {
        productoId:  row.querySelector(`[data-prod-id="${idx2}"]`)?.value || "",
        nombre:      row.querySelector(`[data-prod-nom="${idx2}"]`)?.value || "",
        costo:       parseFloat(row.querySelector(`[data-prod-costo="${idx2}"]`)?.value||"0"),
        cantidad:    parseFloat(row.querySelector(`[data-cant="${idx2}"]`)?.value||"0"),
      };
    }).filter(p => p.productoId && p.cantidad > 0);

    if (!productos.length) { window.toast?.("Agrega al menos un producto con cantidad","warn"); return; }

    const btn = document.getElementById("ent-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const { addDoc: ad, collection: col, doc: dc, setDoc: sd, getDoc: gd2 } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

      const importe = productos.reduce((s,p) => s + p.cantidad * p.costo, 0);
      const entregaRef = await ad(col(db,"entregas_campo"), {
        ingenieroId: ingId, ingenieroAlias: ingAlias,
        visitaId: visitaId || null,
        clienteNombre: cliente, notas: notas||"",
        productos, importe,
        registradoPor: Sesion.alias, _ts: Date.now()
      });

      // Crear movimientos de stock por cada producto
      for (const p of productos) {
        try {
          const invSnap = await gd2(dc(db,"inventario",p.productoId));
          const stockAntes = invSnap.exists() ? (invSnap.data().stockActual ?? 0) : 0;
          const stockDespues = Math.max(0, stockAntes - p.cantidad);
          await ad(col(db,"movimientos_stock"), {
            productoId: p.productoId, nombreProducto: p.nombre,
            tipo: "SALIDA", cantidad: p.cantidad,
            stockAntes, stockDespues,
            motivo: `Entrega campo — ${cliente}`,
            quienRegistro: Sesion.alias, _ts: Date.now()
          });
          await sd(dc(db,"inventario",p.productoId), { stockActual: stockDespues, _ts: Date.now() }, { merge:true });
        } catch(eStock) { console.warn("[Entrega stock]", eStock.message); }
      }

      // Si tiene visita vinculada, marcarla como COMPLETADA
      if (visitaId) {
        try {
          const { updateDoc: upd2, doc: dc2 } =
            await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
          await upd2(dc2(db,"visitas_programadas",visitaId), {
            status:"COMPLETADA", checkInTs:Date.now(), completadaEn:Date.now(),
            notas:`Entrega campo ref: ${entregaRef.id}`
          });
        } catch {}
      }

      window.toast?.("Entrega registrada y stock actualizado","success");
      cerrar();
      _cargarEntregas();
    } catch(e) { window.toast?.("Error: " + e.message,"error"); }
    finally { btn.disabled=false; btn.textContent="✔ Registrar entrega"; }
  });

  // ── Escuchar entregas ──
  let _entUnsub = null;
  function _cargarEntregas() {
    _entUnsub?.();
    const ingId  = document.getElementById("ent-filtro-ing")?.value || "";
    const desde  = document.getElementById("ent-desde")?.value;
    const hasta  = document.getElementById("ent-hasta")?.value;
    const [dy,dm,dd] = (desde||"").split("-").map(Number);
    const [hy,hm,hd] = (hasta||"").split("-").map(Number);
    const desdeTs = desde ? new Date(dy,dm-1,dd,0,0,0).getTime() : Date.now()-7*86400000;
    const hastaTs = hasta ? new Date(hy,hm-1,hd,23,59,59).getTime() : Date.now();

    let cs = [where("_ts",">=",desdeTs), where("_ts","<=",hastaTs),
      orderBy("_ts","desc"), limit(300)];
    if (ingId) cs = [where("ingenieroId","==",ingId), ...cs];
    const q = query(collection(db,"entregas_campo"), ...cs);

    const tbody = document.getElementById("ent-body");
    const fmtMXN = v => Number(v||0).toLocaleString("es-MX",{style:"currency",currency:"MXN"});

    _entUnsub = onSnapshot(q, snap => {
      const rows = snap.docs.map(d2 => ({ id: d2.id, ...d2.data() }));
      const unidades = rows.reduce((s,r) => s + r.productos.reduce((s2,p) => s2+p.cantidad,0), 0);
      const importe  = rows.reduce((s,r) => s + (r.importe||0), 0);
      const el = id => document.getElementById(id);
      if (el("ent-kpi-total"))    el("ent-kpi-total").textContent    = rows.length;
      if (el("ent-kpi-unidades")) el("ent-kpi-unidades").textContent = unidades;
      if (el("ent-kpi-importe"))  el("ent-kpi-importe").textContent  = fmtMXN(importe);

      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-sec)">Sin entregas en el período</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map(r => `<tr>
        <td style="font-size:11px;white-space:nowrap">${fmtFecha(r._ts)}</td>
        <td style="font-size:12px">${esc(resolverNombre(r.ingenieroAlias))}</td>
        <td style="font-weight:600">${esc(r.clienteNombre||"–")}</td>
        <td style="font-size:11px;max-width:200px">
          ${(r.productos||[]).map(p =>
            `<span style="display:inline-block;background:var(--surface-2);border:1px solid var(--border);
              border-radius:5px;padding:1px 6px;margin:1px;font-size:10px">
              ${esc(p.nombre)} ×${p.cantidad}</span>`).join("")}
        </td>
        <td style="text-align:right;font-weight:700">${fmtMXN(r.importe)}</td>
        <td style="font-size:11px;color:var(--text-sec)">${esc(r.notas||"–")}</td>
      </tr>`).join("");
    }, err => console.error("[Entregas]", err));
    _unsubs.push(_entUnsub);
  }
  document.getElementById("ent-filtrar")?.addEventListener("click", _cargarEntregas);
  document.getElementById("ent-filtro-ing")?.addEventListener("change", _cargarEntregas);
  _cargarEntregas();
}

// ══════════════════════════════════════════════════════════════
// MEDIO/65 — DASHBOARD DE CUMPLIMIENTO MENSUAL
// ══════════════════════════════════════════════════════════════
function _montarCumplimiento() {
  const wrap = document.getElementById("log-cumplimiento-content");
  if (!wrap) return;
  const ahora = new Date();
  const mesActual = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,"0")}`;
  wrap.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
      <h3 style="margin:0;font-size:15px;font-weight:800;flex:1">📊 Cumplimiento mensual</h3>
      <input type="month" class="sel-sm" id="cum-mes" value="${mesActual}">
      <button class="btn-primary" id="cum-calcular">Calcular</button>
    </div>
    <div id="cum-resultado">
      <div style="padding:32px;text-align:center;color:var(--text-sec)">Selecciona un mes y presiona Calcular</div>
    </div>`;

  document.getElementById("cum-calcular")?.addEventListener("click", _calcularCumplimiento);
}

async function _calcularCumplimiento() {
  const res = document.getElementById("cum-resultado");
  if (!res) return;
  const mes = document.getElementById("cum-mes")?.value || "";
  if (!mes) { window.toast?.("Selecciona un mes","warn"); return; }
  res.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-sec)">Calculando…</div>`;

  try {
    const [yr, mo] = mes.split("-").map(Number);
    const inicio = new Date(yr, mo-1, 1, 0, 0, 0).getTime();
    const fin    = new Date(yr, mo,   0, 23, 59, 59).getTime();

    const snap = await getDocs(query(
      collection(db,"visitas_programadas"),
      where("fechaTs",">=",inicio), where("fechaTs","<=",fin),
      orderBy("fechaTs","asc"), limit(3000)
    ));
    const visitas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (!visitas.length) {
      res.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-sec)">Sin visitas programadas en ese mes</div>`;
      return;
    }

    // Agrupar por ingeniero
    const porIng = {};
    visitas.forEach(v => {
      const alias = v.ingenieroAlias || v.ingenieroId || "Sin asignar";
      if (!porIng[alias]) porIng[alias] = { total:0, comp:0, omit:0, pend:0 };
      porIng[alias].total++;
      if (v.status === "COMPLETADA") porIng[alias].comp++;
      else if (v.status === "OMITIDA") porIng[alias].pend++;
      else porIng[alias].pend++;
      if (v.status === "OMITIDA") porIng[alias].omit++;
    });

    const ings = Object.entries(porIng).sort((a,b) => {
      const pA = a[1].total > 0 ? a[1].comp/a[1].total : 0;
      const pB = b[1].total > 0 ? b[1].comp/b[1].total : 0;
      return pB - pA;
    });

    const total  = visitas.length;
    const comp   = visitas.filter(v => v.status==="COMPLETADA").length;
    const omit   = visitas.filter(v => v.status==="OMITIDA").length;
    const pend   = visitas.filter(v => v.status==="PENDIENTE").length;
    const pct    = total > 0 ? Math.round(comp/total*100) : 0;

    // Tendencia semanal (grupos de 7 días dentro del mes)
    const semanas = [];
    const diasMes = new Date(yr, mo, 0).getDate();
    for (let s = 0; s < 5; s++) {
      const desde = new Date(yr, mo-1, s*7+1).getTime();
      const hasta = new Date(yr, mo-1, Math.min((s+1)*7, diasMes), 23, 59, 59).getTime();
      const del   = visitas.filter(v => v.fechaTs >= desde && v.fechaTs <= hasta);
      const c     = del.filter(v => v.status==="COMPLETADA").length;
      if (del.length) semanas.push({ label:`S${s+1}`, total:del.length, comp:c, pct: del.length ? Math.round(c/del.length*100) : 0 });
    }

    // SVG tendencia semanal
    const svgW = 400, svgH = 100, pad = 30;
    const nSem = semanas.length || 1;
    const xStep = (svgW - pad*2) / Math.max(nSem-1, 1);
    const pts = semanas.map((s,i) => ({ x: pad + i*xStep, y: svgH - pad - (s.pct/100)*(svgH-pad*2) }));
    const polyline = pts.map(p => `${p.x},${p.y}`).join(" ");
    const area = `${pts[0]?.x},${svgH-pad} ` + polyline + ` ${pts[pts.length-1]?.x},${svgH-pad}`;
    const svgLinea = semanas.length >= 2 ? `
      <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;max-width:400px;height:auto" role="img" aria-label="Tendencia semanal">
        <polygon points="${area}" fill="#6366F120"/>
        <polyline points="${polyline}" fill="none" stroke="#6366F1" stroke-width="2" stroke-linejoin="round"/>
        ${pts.map((p,i) => `
          <circle cx="${p.x}" cy="${p.y}" r="4" fill="#6366F1"/>
          <text x="${p.x}" y="${p.y-7}" text-anchor="middle" font-size="9" fill="currentColor">${semanas[i].pct}%</text>
          <text x="${p.x}" y="${svgH-pad+12}" text-anchor="middle" font-size="9" fill="#94A3B8">${semanas[i].label}</text>`).join("")}
      </svg>` : `<div style="font-size:11px;color:#94A3B8">Datos insuficientes para tendencia</div>`;

    res.innerHTML = `
      <!-- KPIs globales -->
      <div class="kpi-row" style="margin-bottom:20px">
        <div class="kpi-card" style="border-left-color:#6366F1">
          <div class="kpi-icon">📋</div><div class="kpi-val">${total}</div>
          <div class="kpi-label">Programadas</div>
        </div>
        <div class="kpi-card" style="border-left-color:#16A34A">
          <div class="kpi-icon">✅</div><div class="kpi-val">${comp}</div>
          <div class="kpi-label">Completadas</div>
        </div>
        <div class="kpi-card" style="border-left-color:#DC2626">
          <div class="kpi-icon">⏳</div><div class="kpi-val">${pend}</div>
          <div class="kpi-label">Pendientes</div>
        </div>
        <div class="kpi-card" style="border-left-color:#94A3B8">
          <div class="kpi-icon">–</div><div class="kpi-val">${omit}</div>
          <div class="kpi-label">Omitidas</div>
        </div>
        <div class="kpi-card" style="border-left-color:#1D4ED8">
          <div class="kpi-icon">📊</div>
          <div class="kpi-val" style="color:${pct>=80?"#16A34A":pct>=60?"#D97706":"#DC2626"}">${pct}%</div>
          <div class="kpi-label">% Cumplimiento</div>
        </div>
      </div>

      <!-- Tendencia semanal -->
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;
        padding:16px;margin-bottom:20px">
        <div style="font-size:12px;font-weight:700;margin-bottom:10px">📈 Tendencia semanal — % completadas</div>
        ${svgLinea}
      </div>

      <!-- Tabla por ingeniero -->
      <div style="font-size:13px;font-weight:700;margin-bottom:10px">Cumplimiento por ingeniero</div>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>
            <th>INGENIERO</th>
            <th style="text-align:right">PROGRAMADAS</th>
            <th style="text-align:right">COMPLETADAS</th>
            <th style="text-align:right">OMITIDAS</th>
            <th>% CUMPLIMIENTO</th>
          </tr></thead>
          <tbody>
            ${ings.map(([alias, d]) => {
              const p2 = d.total > 0 ? Math.round(d.comp/d.total*100) : 0;
              const col2 = p2 >= 80 ? "#16A34A" : p2 >= 60 ? "#D97706" : "#DC2626";
              return `<tr>
                <td style="font-weight:700">${esc(alias)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${d.total}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;color:#16A34A">${d.comp}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums;color:#94A3B8">${d.omit}</td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    <div style="flex:1;height:7px;border-radius:4px;background:var(--border)">
                      <div style="height:7px;border-radius:4px;background:${col2};width:${p2}%;max-width:100%;transition:width .3s"></div>
                    </div>
                    <span style="font-weight:800;font-size:12px;color:${col2};min-width:35px;text-align:right">${p2}%</span>
                  </div>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  } catch(e) {
    res.innerHTML = `<div style="padding:16px;color:#DC2626">${esc(e.message)}</div>`;
    console.error("[Cumplimiento]", e);
  }
}
