// gastos.js — Módulo de Gastos de Empleado (GERENTE / ADMINISTRADOR / MESA_CONTROL)
import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import {
  collection, query, where, orderBy, onSnapshot, limit,
  doc, updateDoc, addDoc, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { crearNotificacion } from "./notificaciones.js";
import { norm, esc } from "./app.js";

const ROLES_APROBADOR = ["GERENTE", "ADMINISTRADOR", "SUPER_ADMIN"];

const CATEGORIAS = {
  GASOLINA:     { icon: "⛽", label: "Gasolina"     },
  ALIMENTACION: { icon: "🍽️", label: "Alimentación" },
  HOSPEDAJE:    { icon: "🏨", label: "Hospedaje"     },
  TRANSPORTE:   { icon: "🚌", label: "Transporte"    },
  COMUNICACION: { icon: "📱", label: "Comunicación"  },
  HERRAMIENTA:  { icon: "🔧", label: "Herramienta"   },
  OTRO:         { icon: "📎", label: "Otro"           },
};

const STATUS_CONFIG = {
  PENDIENTE: { label: "⏳ Pendiente", css: "badge-warning" },
  APROBADO:  { label: "✅ Aprobado",  css: "badge-success" },
  RECHAZADO: { label: "❌ Rechazado", css: "badge-danger"  },
};

let _unsub       = null;
let _container   = null;
let _filtroStatus = "PENDIENTE";
let _filtroAlias  = "";
let _lastDocs     = [];
let _usuarios     = [];

export async function mount(container) {
  _container    = container;
  _filtroStatus = "PENDIENTE";
  _filtroAlias  = "";

  _inyectarEstilos();
  _container.innerHTML = _html();
  _bindFiltros();
  await _cargarUsuarios();
  _cargar();
}

export function destroy() {
  if (_unsub) { _unsub(); _unsub = null; }
  _filtroStatus = "PENDIENTE";
  _filtroAlias  = "";
  _lastDocs     = [];
  _container    = null;
}

// ─── Estilos (inyectados una sola vez) ──────────────────────────────────────

function _inyectarEstilos() {
  if (document.getElementById("gastos-style")) return;
  const s = document.createElement("style");
  s.id = "gastos-style";
  s.textContent = `
.gastos-wrap { padding:1rem; }
.gastos-header { display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem; }
.gastos-filtros { display:flex;gap:.5rem;flex-wrap:wrap;align-items:center; }
.gastos-filtros select,.gastos-filtros input { padding:.4rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);font-size:.9rem; }
.gastos-kpis { display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:1rem; }
.gastos-kpi-card { background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:4px; }
.gastos-kpi-card .kpi-icon { font-size:22px;line-height:1; }
.gastos-kpi-card .kpi-val { font-size:22px;font-weight:800;line-height:1.1; }
.gastos-kpi-card .kpi-lbl { font-size:11px;color:var(--text-sec);text-transform:uppercase;letter-spacing:.4px;font-weight:600; }
.gastos-resumen { font-size:.85rem;color:var(--text-sec);margin-bottom:.75rem; }
.tabla-scroll { overflow-x:auto; }
.tabla-gastos { width:100%;border-collapse:collapse;font-size:.9rem; }
.tabla-gastos th { background:var(--surface-2,#F9FAFB);padding:.6rem .8rem;text-align:left;font-weight:600;border-bottom:2px solid var(--border);white-space:nowrap; }
.tabla-gastos td { padding:.55rem .8rem;border-bottom:1px solid var(--border);vertical-align:middle; }
.tabla-gastos tr:hover td { background:var(--surface-2,#F9FAFB); }
.monto-cell { font-weight:700;color:#1D4ED8;white-space:nowrap; }
.gasto-badge { display:inline-block;padding:.2rem .5rem;border-radius:4px;font-size:.75rem;font-weight:700; }
.badge-warning { background:#FEF3C7;color:#92400E; }
.badge-success { background:#D1FAE5;color:#065F46; }
.badge-danger  { background:#FEE2E2;color:#991B1B; }
.btn-aprobar  { background:#16A34A;color:#fff;border:none;border-radius:5px;padding:.3rem .7rem;cursor:pointer;font-size:.8rem; }
.btn-rechazar { background:#DC2626;color:#fff;border:none;border-radius:5px;padding:.3rem .7rem;cursor:pointer;font-size:.8rem;margin-left:.3rem; }
.btn-aprobar:hover  { background:#15803D; }
.btn-rechazar:hover { background:#B91C1C; }
.gastos-modal-overlay { position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9000;display:flex;align-items:center;justify-content:center; }
.gastos-modal-box { background:var(--surface);border-radius:12px;padding:28px;width:min(440px,95vw);box-shadow:0 8px 32px #0003;display:flex;flex-direction:column;gap:14px; }
.gastos-modal-box h3 { margin:0;font-size:16px; }
.gastos-modal-box label { display:block;font-size:12px;font-weight:600;margin-bottom:5px; }
.gastos-modal-box select,.gastos-modal-box input,.gastos-modal-box textarea { width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--surface);color:var(--text-primary); }
.gastos-modal-footer { display:flex;gap:8px;justify-content:flex-end;margin-top:4px; }
`;
  document.head.appendChild(s);
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function _html() {
  const esAprobador = ROLES_APROBADOR.includes(Sesion.rol) || Sesion.esSuperAdmin?.();
  return `
<div class="gastos-wrap">
  <div class="gastos-header">
    <h2>💸 Gastos de Empleados</h2>
    <div class="gastos-filtros">
      <select id="g-status">
        <option value="">Todos</option>
        <option value="PENDIENTE" selected>Pendientes</option>
        <option value="APROBADO">Aprobados</option>
        <option value="RECHAZADO">Rechazados</option>
      </select>
      <div style="position:relative">
        <input id="g-alias" type="text" placeholder="Filtrar por alias…" style="width:160px" autocomplete="off"/>
        <div id="g-alias-dd" style="display:none;position:absolute;top:100%;left:0;right:0;
          background:var(--surface);border:1px solid var(--border);border-radius:6px;
          max-height:200px;overflow-y:auto;z-index:200;box-shadow:0 4px 16px #0002;margin-top:2px;min-width:160px"></div>
      </div>
      ${esAprobador ? `<button class="btn-primary" id="g-nuevo-btn" style="flex-shrink:0">+ Registrar gasto</button>` : ""}
    </div>
  </div>

  <!-- KPI cards -->
  <div class="gastos-kpis" id="g-kpis">
    <div class="gastos-kpi-card" style="border-left:4px solid #D97706">
      <div class="kpi-icon">⏳</div>
      <div class="kpi-val" id="g-kpi-pend-n" style="color:#D97706">–</div>
      <div class="kpi-lbl">Pendientes de aprobación</div>
    </div>
    <div class="gastos-kpi-card" style="border-left:4px solid #16A34A">
      <div class="kpi-icon">✅</div>
      <div class="kpi-val" id="g-kpi-apro-m" style="color:#16A34A">–</div>
      <div class="kpi-lbl">Aprobado este mes</div>
    </div>
    <div class="gastos-kpi-card" style="border-left:4px solid #2563EB">
      <div class="kpi-icon">💵</div>
      <div class="kpi-val" id="g-kpi-total-m" style="color:#2563EB">–</div>
      <div class="kpi-lbl">Total registrado este mes</div>
    </div>
    <div class="gastos-kpi-card" style="border-left:4px solid #DC2626">
      <div class="kpi-icon">❌</div>
      <div class="kpi-val" id="g-kpi-rech-n" style="color:#DC2626">–</div>
      <div class="kpi-lbl">Rechazados</div>
    </div>
  </div>

  <div class="gastos-resumen" id="gastos-resumen"></div>
  <div class="tabla-scroll">
    <table class="tabla-gastos">
      <thead>
        <tr>
          <th>Empleado</th><th>Categoría</th><th>Monto</th>
          <th>Descripción</th><th>Fecha</th><th>Status</th><th>Acciones</th>
        </tr>
      </thead>
      <tbody id="gastos-tbody"></tbody>
    </table>
    <p id="gastos-empty" style="display:none;text-align:center;color:var(--text-sec);padding:2rem">
      Sin gastos con estos filtros.
    </p>
  </div>
</div>`;
}

// ─── Cargar empleados ─────────────────────────────────────────────────────────

async function _cargarUsuarios() {
  try {
    const snap = await getDocs(query(
      collection(db, "usuarios"),
      where("activo", "==", true)
    ));
    _usuarios = snap.docs
      .filter(d => ["INGENIERO","RECUPERADOR","GERENTE_ZONA","MESA_CONTROL"].includes(d.data().rol))
      .map(d => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (a.alias || "").localeCompare(b.alias || ""));
  } catch { _usuarios = []; }
}

// ─── Filtros ─────────────────────────────────────────────────────────────────

function _bindFiltros() {
  _container.querySelector("#g-status")?.addEventListener("change", e => {
    _filtroStatus = e.target.value;
    _cargar();
  });

  const gAlias  = _container.querySelector("#g-alias");
  const gAliasDd = _container.querySelector("#g-alias-dd");
  let timer;
  gAlias?.addEventListener("input", e => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      _filtroAlias = norm(e.target.value.trim());
      _render(_lastDocs);
    }, 300);
    const q = norm(e.target.value.trim());
    if (q.length < 1 || !gAliasDd) { if (gAliasDd) gAliasDd.style.display = "none"; return; }
    const aliases = [...new Set(_lastDocs.map(d => d.alias).filter(Boolean))];
    const matches = aliases.filter(a => norm(a).includes(q)).slice(0, 12);
    if (!matches.length) { gAliasDd.style.display = "none"; return; }
    gAliasDd.innerHTML = matches.map(a =>
      `<div class="g-dd-item" data-nombre="${esc(a)}"
        style="padding:7px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border);color:var(--text-primary)">
        ${esc(a)}
      </div>`).join("");
    gAliasDd.style.display = "block";
    gAliasDd.querySelectorAll(".g-dd-item").forEach(el =>
      el.addEventListener("mousedown", ev => {
        ev.preventDefault();
        gAlias.value      = el.dataset.nombre;
        _filtroAlias      = norm(el.dataset.nombre);
        gAliasDd.style.display = "none";
        _render(_lastDocs);
      }));
  });
  gAlias?.addEventListener("blur",    () => setTimeout(() => { if (gAliasDd) gAliasDd.style.display = "none"; }, 150));
  gAlias?.addEventListener("keydown", e  => { if (e.key === "Escape" && gAliasDd) gAliasDd.style.display = "none"; });

  _container.querySelector("#g-nuevo-btn")?.addEventListener("click", _abrirModalNuevo);
}

// ─── Firestore ────────────────────────────────────────────────────────────────

function _cargar() {
  if (_unsub) { _unsub(); _unsub = null; }
  let q = query(collection(db, "gastos_empleado"), orderBy("_ts", "desc"), limit(500));
  if (_filtroStatus) {
    q = query(collection(db, "gastos_empleado"),
      where("status", "==", _filtroStatus), orderBy("_ts", "desc"), limit(500));
  }
  _unsub = onSnapshot(q, snap => {
    _lastDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _actualizarKPIs(_lastDocs);
    _render(_lastDocs);
  }, err => {
    console.error("[Gastos]", err);
    const tbody = _container?.querySelector("#gastos-tbody");
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:24px;text-align:center;color:#DC2626">
      Error al cargar: ${esc(err.message)}</td></tr>`;
  });
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────

function _actualizarKPIs(docs) {
  const ahora = new Date();
  const mesActual = ahora.getMonth();
  const anioActual = ahora.getFullYear();
  const esMesActual = ts => {
    const d = new Date(typeof ts === "number" ? ts : (ts?.toMillis?.() ?? ts));
    return d.getMonth() === mesActual && d.getFullYear() === anioActual;
  };

  // KPIs de toda la colección cargada (no solo el filtro activo)
  const pendientes = docs.filter(d => d.status === "PENDIENTE").length;
  const rechazados = docs.filter(d => d.status === "RECHAZADO").length;
  const aprobadosMes = docs
    .filter(d => d.status === "APROBADO" && esMesActual(d._ts))
    .reduce((s, d) => s + (d.monto || 0), 0);
  const totalMes = docs
    .filter(d => esMesActual(d._ts))
    .reduce((s, d) => s + (d.monto || 0), 0);

  const fmt = n => "$" + Math.round(n).toLocaleString("es-MX");
  const el = id => _container?.querySelector(id);
  if (el("#g-kpi-pend-n"))  el("#g-kpi-pend-n").textContent  = pendientes;
  if (el("#g-kpi-apro-m"))  el("#g-kpi-apro-m").textContent  = fmt(aprobadosMes);
  if (el("#g-kpi-total-m")) el("#g-kpi-total-m").textContent = fmt(totalMes);
  if (el("#g-kpi-rech-n"))  el("#g-kpi-rech-n").textContent  = rechazados;
}

// ─── Render tabla ─────────────────────────────────────────────────────────────

function _render(docs) {
  const tbody   = _container?.querySelector("#gastos-tbody");
  const empty   = _container?.querySelector("#gastos-empty");
  const resumen = _container?.querySelector("#gastos-resumen");
  if (!tbody) return;

  const filtrados = _filtroAlias
    ? docs.filter(d => norm(d.alias || "").includes(_filtroAlias))
    : docs;

  if (filtrados.length === 0) {
    tbody.innerHTML = "";
    if (empty)   empty.style.display = "block";
    if (resumen) resumen.textContent = "Sin registros";
    return;
  }
  if (empty)   empty.style.display = "none";
  const total = filtrados.reduce((s, d) => s + (d.monto || 0), 0);
  if (resumen) resumen.textContent =
    `${filtrados.length} gastos · $${total.toLocaleString("es-MX", { minimumFractionDigits: 2 })} total`;

  const esAprobador = ROLES_APROBADOR.includes(Sesion.rol) || Sesion.esSuperAdmin?.();

  tbody.innerHTML = filtrados.map(g => {
    const cat   = CATEGORIAS[g.categoria] || { icon: "📎", label: esc(g.categoria || "—") };
    const st    = STATUS_CONFIG[g.status] || STATUS_CONFIG.PENDIENTE;
    const fecha = g._ts
      ? new Date(typeof g._ts === "number" ? g._ts : (g._ts?.toMillis?.() ?? g._ts))
          .toLocaleString("es-MX", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
      : "—";
    const monto    = `$${(g.monto || 0).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`;
    const fotoLink = g.fotoUrl
      ? `<a href="${esc(g.fotoUrl)}" target="_blank" rel="noopener"
           style="font-size:.78rem;color:#2563EB;display:block;margin-bottom:.3rem">🖼️ Ver ticket</a>`
      : "";
    let acciones;
    if (g.status === "PENDIENTE" && esAprobador) {
      acciones = `<div>
        ${fotoLink}
        <button class="btn-aprobar"  data-id="${g.id}" data-uid="${esc(g.uid || "")}"
          data-alias="${esc(g.alias || g.uid || "")}" data-monto="${g.monto || 0}">✅ Aprobar</button>
        <button class="btn-rechazar" data-id="${g.id}" data-uid="${esc(g.uid || "")}"
          data-alias="${esc(g.alias || g.uid || "")}" data-monto="${g.monto || 0}">❌ Rechazar</button>
      </div>`;
    } else {
      const gestor = g.aprobadoPor || g.rechazadoPor || "—";
      acciones = `<div>${fotoLink}<span style="color:var(--text-sec);font-size:.8rem">${esc(gestor)}</span></div>`;
    }
    const motivoHtml = g.status === "RECHAZADO" && g.motivoRechazo
      ? `<div style="font-size:.74rem;color:#991B1B;margin-top:.2rem">Motivo: ${esc(g.motivoRechazo)}</div>` : "";

    return `<tr>
  <td>${esc(g.alias || g.uid || "—")}</td>
  <td>${cat.icon} ${cat.label}</td>
  <td class="monto-cell">${monto}</td>
  <td style="max-width:200px;word-break:break-word">${esc(g.descripcion || "—")}</td>
  <td style="white-space:nowrap;font-size:.8rem">${fecha}</td>
  <td><span class="gasto-badge ${st.css}">${st.label}</span>${motivoHtml}</td>
  <td>${acciones}</td>
</tr>`;
  }).join("");

  tbody.querySelectorAll(".btn-aprobar").forEach(btn => {
    btn.addEventListener("click", async () => {
      const { id, uid, alias, monto } = btn.dataset;
      const ok = window.modal
        ? await window.modal({ title: "Aprobar gasto", message: `¿Aprobar el gasto de ${alias} por $${Number(monto).toLocaleString("es-MX", { minimumFractionDigits: 2 })}?`, confirmLabel: "Aprobar" })
        : confirm(`¿Aprobar el gasto de ${alias} por $${Number(monto).toLocaleString("es-MX", { minimumFractionDigits: 2 })}?`);
      if (!ok) return;
      await _setStatus({ id, empleadoUid: uid, empleadoAlias: alias, status: "APROBADO" });
    });
  });

  tbody.querySelectorAll(".btn-rechazar").forEach(btn => {
    btn.addEventListener("click", async () => {
      const { id, uid, alias, monto } = btn.dataset;
      const motivo = window.promptModal
        ? await window.promptModal({ title: "Rechazar gasto", label: `Motivo — ${alias} · $${Number(monto).toLocaleString("es-MX", { minimumFractionDigits: 2 })}`, placeholder: "Escribe el motivo…", confirmLabel: "Rechazar" })
        : prompt(`Motivo de rechazo para el gasto de ${alias}:`);
      if (motivo === null || !motivo.trim()) return;
      await _setStatus({ id, empleadoUid: uid, empleadoAlias: alias, status: "RECHAZADO", motivoRechazo: motivo.trim() });
    });
  });
}

// ─── Cambiar status ───────────────────────────────────────────────────────────

async function _setStatus({ id, empleadoUid, empleadoAlias, status, motivoRechazo }) {
  try {
    await updateDoc(doc(db, "gastos_empleado", id), {
      status,
      ...(status === "APROBADO"
        ? { aprobadoPor: Sesion.alias, _tsAprobacion: serverTimestamp() }
        : { rechazadoPor: Sesion.alias, _tsRechazo: serverTimestamp(), motivoRechazo: motivoRechazo || null }),
    });
    await crearNotificacion({
      tipo:          status === "APROBADO" ? "GASTO_APROBADO" : "GASTO_RECHAZADO",
      mensaje:       status === "APROBADO"
        ? `Tu gasto fue aprobado por ${Sesion.alias}`
        : `Tu gasto fue rechazado por ${Sesion.alias}${motivoRechazo ? ". Motivo: " + motivoRechazo : ""}`,
      destinatarios: empleadoUid ? [empleadoUid] : ["TODOS"],
    });
    window.toast?.(status === "APROBADO" ? "Gasto aprobado ✅" : "Gasto rechazado ❌",
      status === "APROBADO" ? "success" : "error");
  } catch (e) {
    window.toast?.("Error: " + e.message, "error");
  }
}

// ─── Modal nuevo gasto (admin/gerente registra en nombre de empleado) ─────────

function _abrirModalNuevo() {
  const overlay = document.createElement("div");
  overlay.className = "gastos-modal-overlay";
  const hoy = new Date().toISOString().slice(0, 10);
  overlay.innerHTML = `
    <div class="gastos-modal-box">
      <h3>💸 Registrar gasto</h3>
      <div>
        <label>Empleado</label>
        <select id="gm-uid">
          <option value="">— Selecciona —</option>
          ${_usuarios.map(u => `<option value="${esc(u.uid)}" data-alias="${esc(u.alias || u.uid)}">${esc(u.alias || u.uid)}</option>`).join("")}
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label>Categoría</label>
          <select id="gm-cat">
            ${Object.entries(CATEGORIAS).map(([k, v]) =>
              `<option value="${k}">${v.icon} ${v.label}</option>`).join("")}
          </select>
        </div>
        <div>
          <label>Monto (MXN)</label>
          <input id="gm-monto" type="number" min="1" step="0.01" placeholder="0.00">
        </div>
      </div>
      <div>
        <label>Descripción</label>
        <input id="gm-desc" type="text" placeholder="Descripción del gasto…" maxlength="200">
      </div>
      <div>
        <label>Fecha</label>
        <input id="gm-fecha" type="date" value="${hoy}">
      </div>
      <div class="gastos-modal-footer">
        <button class="btn-outline" id="gm-cancel">Cancelar</button>
        <button class="btn-primary" id="gm-guardar">Guardar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector("#gm-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector("#gm-guardar").addEventListener("click", async () => {
    const uidSel  = overlay.querySelector("#gm-uid");
    const uid     = uidSel?.value;
    const alias   = uidSel?.options[uidSel.selectedIndex]?.dataset.alias || uid;
    const cat     = overlay.querySelector("#gm-cat")?.value;
    const monto   = parseFloat(overlay.querySelector("#gm-monto")?.value || "0");
    const desc    = overlay.querySelector("#gm-desc")?.value.trim();
    const fecha   = overlay.querySelector("#gm-fecha")?.value;

    if (!uid)    { window.toast?.("Selecciona un empleado", "error"); return; }
    if (monto <= 0) { window.toast?.("Ingresa un monto válido", "error"); return; }
    if (!desc)   { window.toast?.("Ingresa una descripción", "error"); return; }

    const btn = overlay.querySelector("#gm-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";

    const [y, m, d] = (fecha || hoy).split("-").map(Number);
    const _ts = new Date(y, m - 1, d, 12, 0, 0).getTime();

    try {
      await addDoc(collection(db, "gastos_empleado"), {
        uid, alias, categoria: cat, monto, descripcion: desc,
        fecha: fecha || hoy, _ts,
        status: "PENDIENTE",
        registradoPor: Sesion.alias,
        timestamp: serverTimestamp(),
      });
      window.toast?.("Gasto registrado", "success");
      overlay.remove();
    } catch (e) {
      window.toast?.("Error: " + e.message, "error");
      btn.disabled = false; btn.textContent = "Guardar";
    }
  });
}
