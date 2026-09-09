// ══════════════════════════════════════════════════════════════
// observabilidad.js — Panel de salud del sistema y métricas
// Solo SA y GERENTE. Colecciones: metricas_diarias, backups_manifesto
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc } from "./app.js";
import {
  collection, query, orderBy, limit, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const HEALTH_URL = "https://us-central1-n10-erp.cloudfunctions.net/healthCheck";

const fmtFecha = ts => ts
  ? new Date(typeof ts === "number" ? ts : (ts.toMillis?.() ?? ts))
      .toLocaleString("es-MX", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" })
  : "—";

const fmtNum = n => (n ?? "—").toLocaleString?.("es-MX") ?? "—";

export const ObservabilidadModule = {
  mount(container) {
    if (!Sesion.esSuperAdmin?.() && !["GERENTE", "ADMINISTRADOR"].includes(Sesion.rol)) {
      container.innerHTML = `<div style="padding:48px;text-align:center;color:var(--text-sec)">
        Sin acceso a este módulo.</div>`;
      return;
    }

    container.innerHTML = `
    <div class="mod-wrap">
      <div class="mod-topbar">
        <h2 class="mod-title">📡 Observabilidad</h2>
        <div class="mod-actions">
          <button class="btn-outline" id="obs-refresh">🔄 Actualizar</button>
          <button class="btn-primary" id="obs-ping">🏓 Health check</button>
        </div>
      </div>

      <!-- Health status bar -->
      <div id="obs-health-bar" style="
        border-radius:8px;padding:12px 16px;margin-bottom:20px;
        background:var(--surface2);border:1px solid var(--border);
        display:flex;align-items:center;gap:12px;font-size:13px">
        <span id="obs-dot" style="width:10px;height:10px;border-radius:50%;background:#94a3b8;flex-shrink:0"></span>
        <span id="obs-health-txt">Sin verificar</span>
        <span id="obs-latencia" style="margin-left:auto;font-size:11px;color:var(--text-sec)"></span>
      </div>

      <!-- KPIs hoy -->
      <div style="margin-bottom:6px;font-size:11px;font-weight:700;color:var(--text-sec);
        text-transform:uppercase;letter-spacing:.5px">Métricas de hoy</div>
      <div class="kpi-row" style="margin-bottom:20px">
        <div class="kpi-card"><div class="kpi-icon">🛒</div><div class="kpi-val" id="obs-k-ped">–</div><div class="kpi-label">Pedidos</div></div>
        <div class="kpi-card"><div class="kpi-icon">📍</div><div class="kpi-val" id="obs-k-vis">–</div><div class="kpi-label">Visitas completadas</div></div>
        <div class="kpi-card"><div class="kpi-icon">💳</div><div class="kpi-val" id="obs-k-abo">–</div><div class="kpi-label">Abonos</div></div>
        <div class="kpi-card"><div class="kpi-icon">👥</div><div class="kpi-val" id="obs-k-usr">–</div><div class="kpi-label">Usuarios activos</div></div>
        <div class="kpi-card"><div class="kpi-icon">🏢</div><div class="kpi-val" id="obs-k-cli">–</div><div class="kpi-label">Clientes activos</div></div>
      </div>

      <!-- Histórico 7 días -->
      <div style="margin-bottom:6px;font-size:11px;font-weight:700;color:var(--text-sec);
        text-transform:uppercase;letter-spacing:.5px">Últimos 7 días</div>
      <div style="overflow-x:auto;margin-bottom:24px;background:var(--surface,#fff);border:1px solid var(--border);border-radius:8px">
        <table class="data-table" id="obs-tabla-hist" style="background:var(--surface,#fff)">
          <thead><tr>
            <th>Fecha</th><th>Pedidos</th><th>Visitas</th>
            <th>Abonos</th><th>Cotizaciones</th><th>Notificaciones</th>
          </tr></thead>
          <tbody id="obs-hist-body">
            <tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Último backup manifesto -->
      <div style="margin-bottom:6px;font-size:11px;font-weight:700;color:var(--text-sec);
        text-transform:uppercase;letter-spacing:.5px">Último backup manifesto</div>
      <div id="obs-backup-panel" style="
        background:var(--surface2);border:1px solid var(--border);
        border-radius:8px;padding:16px">
        <div style="color:var(--text-sec);font-size:13px">Cargando…</div>
      </div>
    </div>`;

    _cargar();
    document.getElementById("obs-refresh")?.addEventListener("click", _cargar);
    document.getElementById("obs-ping")?.addEventListener("click", _pingHealth);
  },
  destroy() {},
};

// ── Cargar datos ─────────────────────────────────────────────────

async function _cargar() {
  await Promise.all([_cargarMetricas(), _cargarBackup()]);
}

async function _cargarMetricas() {
  const hoy = new Date().toISOString().slice(0, 10);

  // Métricas del día de hoy
  try {
    const snap = await getDoc(doc(db, "metricas_diarias", hoy));
    const m = snap.exists() ? snap.data() : {};
    document.getElementById("obs-k-ped").textContent = fmtNum(m.pedidosHoy);
    document.getElementById("obs-k-vis").textContent = fmtNum(m.visitasCompletadas);
    document.getElementById("obs-k-abo").textContent = fmtNum(m.abonosHoy);
    document.getElementById("obs-k-usr").textContent = fmtNum(m.usuariosActivos);
    document.getElementById("obs-k-cli").textContent = fmtNum(m.clientesActivos);
  } catch (_) {}

  // Histórico últimos 7 días
  try {
    const snap = await getDocs(
      query(collection(db, "metricas_diarias"), orderBy("fecha", "desc"), limit(7))
    );
    const tbody = document.getElementById("obs-hist-body");
    if (!tbody) return;
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-sec,#6B7280)">
        📊 Sin datos — las métricas se generan automáticamente a las 23:55</td></tr>`;
      return;
    }
    tbody.innerHTML = snap.docs.map(d => {
      const m = d.data();
      const esHoy = m.fecha === hoy;
      return `<tr ${esHoy ? 'style="font-weight:700"' : ""}>
        <td>${esc(m.fecha)}${esHoy ? ' <span style="font-size:10px;color:#16A34A">HOY</span>' : ""}</td>
        <td style="text-align:center">${fmtNum(m.pedidosHoy)}</td>
        <td style="text-align:center">${fmtNum(m.visitasCompletadas)}</td>
        <td style="text-align:center">${fmtNum(m.abonosHoy)}</td>
        <td style="text-align:center">${fmtNum(m.cotizacionesHoy)}</td>
        <td style="text-align:center">${fmtNum(m.notificacionesHoy)}</td>
      </tr>`;
    }).join("");
  } catch (e) {
    console.error("[Observabilidad]", e);
  }
}

async function _cargarBackup() {
  const panel = document.getElementById("obs-backup-panel");
  if (!panel) return;
  try {
    const snap = await getDocs(
      query(collection(db, "backups_manifesto"), orderBy("_ts", "desc"), limit(1))
    );
    if (snap.empty) {
      panel.innerHTML = `<div style="color:var(--text-sec);font-size:13px">
        Sin backups — se generan automáticamente a las 02:00 hrs</div>`;
      return;
    }
    const b = snap.docs[0].data();
    const colRows = Object.entries(b.conteos || {}).map(([col, count]) =>
      `<div style="display:flex;justify-content:space-between;padding:4px 0;
        border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--text-sec)">${esc(col)}</span>
        <span style="font-variant-numeric:tabular-nums;font-weight:600">${fmtNum(count)}</span>
      </div>`
    ).join("");

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          <div style="font-size:14px;font-weight:700">📦 ${esc(b.fecha)}</div>
          <div style="font-size:11px;color:var(--text-sec)">Generado: ${fmtFecha(b._ts)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:20px;font-weight:800">${fmtNum(b.totalDocs)}</div>
          <div style="font-size:11px;color:var(--text-sec)">docs totales</div>
        </div>
      </div>
      <div>${colRows}</div>`;
  } catch (e) {
    panel.innerHTML = `<div style="color:#DC2626;font-size:13px">Error: ${esc(e.message)}</div>`;
  }
}

// ── Health ping ──────────────────────────────────────────────────

async function _pingHealth() {
  const dot = document.getElementById("obs-dot");
  const txt = document.getElementById("obs-health-txt");
  const lat = document.getElementById("obs-latencia");
  if (dot) dot.style.background = "#F59E0B";
  if (txt) txt.textContent = "Verificando…";
  if (lat) lat.textContent = "";

  try {
    const t0 = Date.now();
    const resp = await fetch(HEALTH_URL, { method: "GET" });
    const ms   = Date.now() - t0;
    const json = await resp.json();

    const ok = resp.ok && json.status === "OK";
    if (dot) dot.style.background = ok ? "#4ADE80" : "#EF4444";
    if (txt) txt.textContent = ok
      ? `Sistema operativo · Firestore ${json.latenciaMs}ms`
      : `Error: ${json.error || "respuesta inesperada"}`;
    if (lat) lat.textContent = `Ping total: ${ms}ms`;
  } catch (e) {
    if (dot) dot.style.background = "#EF4444";
    if (txt) txt.textContent = "No se pudo conectar con la función";
    if (lat) lat.textContent = e.message;
  }
}
