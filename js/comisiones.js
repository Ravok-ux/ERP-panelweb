// ══════════════════════════════════════════════════════════════
// comisiones.js — Configuración de comisiones por ingeniero
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { esc } from "./app.js";
import { Sesion } from "./auth.js";
import {
  collection, doc, onSnapshot, setDoc, query, orderBy, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { TRAMOS_N10, META_LITROS_DEFAULT, calcComisionN10, proximoTramo } from "./comisiones-n10-engine.js";

const fmtMXN = v => new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN" }).format(v || 0);
const fmtL   = v => `${(v ?? 0).toLocaleString("es-MX")} L`;
const _mesActual = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; };

const DIAS_SEM = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

let _unsubs   = [];
let _tabActiva = "config"; // "config" | "n10" | "cobranza"

export const ComisionesModule = {
  mount(container) {
    if (!Sesion.esSuperAdmin() && Sesion.rol !== "GERENTE" && Sesion.rol !== "ADMINISTRADOR") {
      container.innerHTML = `
        <div class="empty-state" style="flex:1;justify-content:center">
          <div class="empty-state-icon">🔒</div>
          <div class="empty-state-title">Acceso restringido</div>
        </div>`;
      return;
    }
    container.innerHTML = _html();
    _bindAcciones();
    _escucharConfigs();
    _escucharLiquidaciones();
    _activarTab("config");
    return () => this.destroy();
  },

  destroy() {
    _unsubs.forEach(fn => fn && fn());
    _unsubs = [];
    _tabActiva = "config";
    _unsubCob?.(); _unsubCob = null;
    _unsubN10?.(); _unsubN10 = null;
  }
};

function _activarTab(tab) {
  _tabActiva = tab;
  document.querySelectorAll("[data-com-tab]").forEach(b =>
    b.classList.toggle("active", b.dataset.comTab === tab));
  document.getElementById("com-panel-config").style.display   = tab === "config"   ? "flex" : "none";
  document.getElementById("com-panel-n10").style.display      = tab === "n10"      ? "flex" : "none";
  document.getElementById("com-panel-cobranza").style.display = tab === "cobranza" ? "flex" : "none";
  if (tab === "n10")      _escucharN10(_mesActual());
  if (tab === "cobranza") _escucharCobranzaConfigs();
}

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  const mesHoy = _mesActual();
  return `
  <div style="display:flex;flex-direction:column;height:100%;gap:0">

    <!-- Header + tabs -->
    <div style="padding:14px 20px 0;border-bottom:1px solid var(--border);flex-shrink:0">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <div>
          <div style="font-size:13px;font-weight:800;color:var(--text-primary)">Comisiones e ingenieros</div>
          <div style="font-size:10.5px;color:var(--text-muted)" id="com-subtitle">Cargando…</div>
        </div>
        <div style="flex:1"></div>
        <button onclick="ComisionesUI.nuevaConfig()" id="com-btn-nueva"
          style="background:#166534;border:1px solid #16A34A;border-radius:7px;padding:7px 14px;
            font-size:11.5px;font-weight:700;color:#4ADE80;cursor:pointer">
          + Configurar ingeniero
        </button>
      </div>
      <div style="display:flex;gap:4px">
        <button data-com-tab="config" onclick="ComisionesUI.cambiarTab('config')"
          style="padding:6px 14px;border:none;border-radius:6px 6px 0 0;cursor:pointer;
            font-size:12px;font-weight:600;background:transparent;color:var(--text-muted)">
          ⚙️ Configuración
        </button>
        <button data-com-tab="n10" onclick="ComisionesUI.cambiarTab('n10')"
          style="padding:6px 14px;border:none;border-radius:6px 6px 0 0;cursor:pointer;
            font-size:12px;font-weight:600;background:transparent;color:var(--text-muted)">
          💧 N10 — Litros
        </button>
        <button data-com-tab="cobranza" onclick="ComisionesUI.cambiarTab('cobranza')"
          style="padding:6px 14px;border:none;border-radius:6px 6px 0 0;cursor:pointer;
            font-size:12px;font-weight:600;background:transparent;color:var(--text-muted)">
          💳 Cobranza
        </button>
      </div>
    </div>

    <!-- Panel: Configuración (existente) -->
    <div id="com-panel-config" style="display:flex;flex:1;overflow:hidden;gap:0">
      <div style="flex:1;overflow-y:auto;border-right:1px solid var(--border);padding:16px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;
          letter-spacing:.07em;margin-bottom:12px">Configuración por ingeniero</div>
        <div id="com-configs-list">
          <div style="color:var(--text-muted);font-size:12px;text-align:center;padding:32px">Cargando…</div>
        </div>
      </div>
      <div style="flex:1.2;overflow-y:auto;padding:16px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;
          letter-spacing:.07em;margin-bottom:12px">Historial de liquidaciones</div>
        <div id="com-liq-list">
          <div style="color:var(--text-muted);font-size:12px;text-align:center;padding:32px">Cargando…</div>
        </div>
      </div>
    </div>

    <!-- Panel: Cobranza -->
    <div id="com-panel-cobranza" style="display:none;flex-direction:column;flex:1;overflow:hidden">
      <div style="padding:12px 20px;border-bottom:1px solid var(--border);
        display:flex;align-items:center;gap:10px;flex-shrink:0">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">
          Reglas de comisión por cobranza — por ingeniero
        </div>
        <div style="flex:1"></div>
        <button onclick="ComisionesUI.nuevaCobranza()"
          style="background:#1E3A5F;border:1px solid #2563EB;border-radius:7px;padding:7px 14px;
            font-size:11.5px;font-weight:700;color:#60A5FA;cursor:pointer">
          + Configurar ingeniero
        </button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:16px 20px">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">
          Define cuánto se le paga al ingeniero por recuperar notas vencidas. Cada regla es editable en cualquier momento.
        </div>
        <div id="cob-config-list">
          <div style="color:var(--text-muted);text-align:center;padding:32px">Cargando…</div>
        </div>
      </div>
    </div>

    <!-- Panel: N10 Litros -->
    <div id="com-panel-n10" style="display:none;flex-direction:column;flex:1;overflow:hidden">
      <!-- Subheader N10 -->
      <div style="padding:12px 20px;border-bottom:1px solid var(--border);
        display:flex;align-items:center;gap:12px;flex-shrink:0;background:var(--surface)">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">
          Mes:
        </div>
        <input type="month" id="n10-mes-picker" value="${mesHoy}"
          onchange="ComisionesUI.setMesN10(this.value)"
          style="border:1px solid var(--border);border-radius:6px;padding:4px 8px;
            font-size:12px;background:var(--surface);color:var(--text-primary);cursor:pointer">
        <div style="flex:1"></div>
        <div style="font-size:10.5px;color:var(--text-muted)" id="n10-subtitle">Cargando…</div>
      </div>

      <!-- KPIs N10 -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:14px 20px;flex-shrink:0"
        id="n10-kpis">
        ${[["n10-k-litros","LITROS TOTALES MES","💧"],["n10-k-comision","COMISIÓN TOTAL","💰"],
           ["n10-k-activos","INGENIEROS ACTIVOS","👷"],["n10-k-top","TOP INGENIERO","🏆"]].map(([id,lbl,ico]) => `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
            <div style="font-size:10px;color:var(--text-muted);font-weight:700;text-transform:uppercase;
              letter-spacing:.06em;margin-bottom:6px">${ico} ${lbl}</div>
            <div style="font-size:18px;font-weight:800;color:var(--text-primary);
              font-variant-numeric:tabular-nums" id="${id}">–</div>
          </div>`).join("")}
      </div>

      <!-- Tabla tabulador N10 -->
      <div style="padding:0 20px 10px;flex-shrink:0">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <div style="padding:8px 14px;border-bottom:1px solid var(--border);
            font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">
            Tabulador vigente N10
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr)">
            ${TRAMOS_N10.map(t => `
              <div style="padding:10px 14px;border-right:1px solid var(--border);text-align:center">
                <div style="font-size:9px;color:var(--text-muted);font-weight:700;text-transform:uppercase">Tramo ${t.n}</div>
                <div style="font-size:13px;font-weight:800;color:#6366F1;margin:3px 0">$${t.rate}/L</div>
                <div style="font-size:9px;color:var(--text-muted)">${t.hasta === Infinity ? "500+ L" : `${t.desde}–${t.hasta} L`}</div>
              </div>`).join("")}
          </div>
        </div>
      </div>

      <!-- Tabla por ingeniero -->
      <div style="flex:1;overflow-y:auto;padding:0 20px 20px">
        <div id="n10-tabla" style="font-size:12px">
          <div style="color:var(--text-muted);text-align:center;padding:32px">Cargando…</div>
        </div>
      </div>
    </div>

  </div>

  <!-- Modal: configurar -->
  <div id="modal-comision" class="modal-overlay hidden">
    <div class="modal" style="max-width:500px">
      <div class="modal-title" id="com-modal-title">Configurar comisión</div>

      <div class="form-group">
        <label class="form-label">Ingeniero (alias)</label>
        <input id="com-alias" type="text" class="form-input" placeholder="Ramírez E." readonly>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group">
          <label class="form-label">Salario base semanal ($)</label>
          <input id="com-salario" type="number" class="form-input" placeholder="0.00" min="0" step="100">
        </div>
        <div class="form-group">
          <label class="form-label">Días laborales / semana</label>
          <select id="com-dias-lab" class="form-input">
            <option value="5">5 días (Lun–Vie)</option>
            <option value="6">6 días (Lun–Sáb)</option>
          </select>
        </div>
      </div>

      <div class="form-group" style="margin-top:8px">
        <label class="form-label">Inicio del período de liquidación</label>
        <select id="com-dia-liq" class="form-input" onchange="ComisionesUI._previewPeriodo()">
          <option value="1">Lunes → Domingo</option>
          <option value="2">Martes → Lunes</option>
          <option value="3">Miércoles → Martes</option>
          <option value="4">Jueves → Miércoles</option>
          <option value="5">Viernes → Jueves</option>
          <option value="6">Sábado → Viernes</option>
          <option value="0">Domingo → Sábado</option>
        </select>
        <div id="com-periodo-preview"
          style="font-size:10px;color:#60A5FA;margin-top:5px;padding:4px 8px;
            background:rgba(37,99,235,.1);border-radius:4px;display:none">
        </div>
      </div>

      <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;
        letter-spacing:.06em;margin:14px 0 8px">Tramos de comisión (por volumen de ventas)</div>

      <div id="com-tramos">
        <!-- generado dinámicamente -->
      </div>

      <button onclick="ComisionesUI.agregarTramo()"
        style="font-size:11px;color:#60A5FA;background:none;border:none;cursor:pointer;padding:4px 0;margin-bottom:12px">
        + Agregar tramo
      </button>

      <div style="font-size:10px;color:var(--text-muted);padding:8px 10px;background:var(--surface);
        border-radius:6px;border:1px solid var(--border);margin-bottom:12px">
        💡 Cada tramo aplica el porcentaje sobre el intervalo entre la meta anterior y esta.
        Ejemplo: hasta $100k → 3%, hasta $150k → 5% = sobre los primeros $100k cobra 3%, sobre el tramo $100k-$150k cobra 5%.
      </div>

      <div class="modal-actions">
        <button class="btn-secondary" onclick="ComisionesUI.cerrarModal()">Cancelar</button>
        <button class="btn-primary" style="width:auto;padding:8px 20px"
          onclick="ComisionesUI.guardarConfig()">Guardar</button>
      </div>
    </div>
  </div>

  <!-- Modal: cobranza config -->
  <div id="modal-cobranza" class="modal-overlay hidden">
    <div class="modal" style="max-width:480px">
      <div class="modal-title">Comisión de cobranza</div>
      <div class="form-group">
        <label class="form-label">Ingeniero (alias)</label>
        <input id="cob-alias" type="text" class="form-input" readonly>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5">
        Define la regla de comisión para notas vencidas recuperadas en el período de liquidación del ingeniero.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group">
          <label class="form-label">Umbral mora (días)</label>
          <input id="cob-umbral" type="number" class="form-input" min="0" step="1" placeholder="60"
            title="Días de vencimiento mínimos para que aplique la comisión">
        </div>
        <div class="form-group">
          <label class="form-label">Por cada $ cobrado</label>
          <input id="cob-por-cada" type="number" class="form-input" min="1" step="100" placeholder="1000"
            title="Cada cuántos pesos cobrados se genera una unidad de comisión">
        </div>
        <div class="form-group">
          <label class="form-label">Comisión por unidad ($)</label>
          <input id="cob-comision" type="number" class="form-input" min="0" step="1" placeholder="10"
            title="Pesos de comisión por cada unidad base cobrada">
        </div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);padding:8px 10px;background:var(--surface);
        border-radius:6px;border:1px solid var(--border);margin-bottom:14px" id="cob-ejemplo">
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="ComisionesUI.cerrarModal()">Cancelar</button>
        <button class="btn-primary" style="width:auto;padding:8px 20px"
          onclick="ComisionesUI.guardarCobranza()">Guardar</button>
      </div>
    </div>
  </div>

  <!-- Modal: alias selector -->
  <div id="modal-alias" class="modal-overlay hidden">
    <div class="modal" style="max-width:360px">
      <div class="modal-title">Seleccionar ingeniero</div>
      <div id="alias-list" style="max-height:260px;overflow-y:auto;margin-bottom:16px">
        Cargando…
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="ComisionesUI.cerrarModal()">Cancelar</button>
      </div>
    </div>
  </div>`;
}

// ── Listeners Firestore ────────────────────────────────────────
function _escucharConfigs() {
  const q = query(collection(db, "comision_config"), orderBy("aliasIngeniero"));
  const unsub = onSnapshot(q, snap => {
    const el = document.getElementById("com-configs-list");
    if (!el) return;

    const sub = document.getElementById("com-subtitle");
    if (sub) sub.textContent = `${snap.size} ingenieros configurados`;

    if (snap.empty) {
      el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:32px">
        Sin configuraciones. Usa "+ Configurar ingeniero".</div>`;
      return;
    }

    el.innerHTML = snap.docs.map(d => {
      const c = d.data();
      const tramos = _descTramos(c.tramosJson);
      return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
          padding:12px 14px;margin-bottom:8px">
          <div style="display:flex;align-items:center;margin-bottom:6px">
            <div style="flex:1;font-size:13px;font-weight:700;color:var(--text-primary)">${esc(c.aliasIngeniero)}</div>
            <div style="font-size:12px;color:#4ADE80;font-weight:700">
              ${fmtMXN(c.salarioBase)}/sem · ${c.diasLaborales||6}d
            </div>
          </div>
          <div style="font-size:11px;color:#60A5FA;margin-bottom:6px">
            📅 Período: ${DIAS_SEM[c.diaLiquidacion ?? 1]} → ${DIAS_SEM[((c.diaLiquidacion ?? 1) + 6) % 7]}
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${tramos}</div>
          <button onclick="ComisionesUI.editarConfig('${d.id}')"
            style="font-size:11px;background:var(--surface-2);border:1px solid var(--border);
              border-radius:5px;padding:4px 10px;cursor:pointer;color:var(--text-primary)">
            ✏️ Editar
          </button>
        </div>`;
    }).join("");
  }, err => {
    console.error("[Comisiones:configs]", err);
    window.toast?.("Error al cargar configuraciones", "error");
  });
  _unsubs.push(unsub);
}

function _escucharLiquidaciones() {
  const q = query(collection(db, "liquidacion_comision"), orderBy("fechaInicio", "desc"));
  const unsub = onSnapshot(q, snap => {
    const el = document.getElementById("com-liq-list");
    if (!el) return;

    if (snap.empty) {
      el.innerHTML = `<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:32px">
        Sin liquidaciones registradas.</div>`;
      return;
    }

    el.innerHTML = snap.docs.map(d => {
      const l = d.data();
      const statusColor = l.status === "PAGADO" ? "#4ADE80" : l.status === "CANCELADO" ? "#EF4444" : "#FBBF24";
      return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
          padding:12px 14px;margin-bottom:8px">
          <div style="display:flex;align-items:center;margin-bottom:4px">
            <div style="flex:1;font-size:13px;font-weight:700;color:var(--text-primary)">${esc(l.aliasIngeniero)}</div>
            <div style="font-size:11px;font-weight:700;color:${statusColor};
              background:${statusColor}22;border-radius:4px;padding:2px 8px">${esc(l.status || "PENDIENTE")}</div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${l.periodoLabel}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
            <div>
              <div style="font-size:9px;color:var(--text-sec);text-transform:uppercase">Ventas</div>
              <div style="font-size:12px;font-weight:700;color:var(--text-primary)">${fmtMXN(l.totalVendido)}</div>
            </div>
            <div>
              <div style="font-size:9px;color:var(--text-sec);text-transform:uppercase">Comisión</div>
              <div style="font-size:12px;font-weight:700;color:#60A5FA">${fmtMXN(l.montoComision)}</div>
            </div>
            <div>
              <div style="font-size:9px;color:var(--text-sec);text-transform:uppercase">Total pago</div>
              <div style="font-size:12px;font-weight:700;color:#4ADE80">${fmtMXN(l.totalPago)}</div>
            </div>
          </div>
          ${(Sesion.esSuperAdmin() || Sesion.rol === "ADMINISTRADOR") && l.status !== "PAGADO" ? `
          <div style="margin-top:8px;display:flex;gap:8px">
            <button onclick="ComisionesUI.marcarPagado('${d.id}')"
              style="font-size:11px;background:#166534;border:1px solid #16A34A;border-radius:5px;
                padding:4px 10px;cursor:pointer;color:#4ADE80">
              ✔ Marcar pagado
            </button>
          </div>` : ""}
        </div>`;
    }).join("");
  }, err => {
    console.error("[Comisiones:liq]", err);
    window.toast?.("Error al cargar liquidaciones", "error");
  });
  _unsubs.push(unsub);
}

// ── Acciones ──────────────────────────────────────────────────
function _bindAcciones() {
  let _editandoAlias = null;
  let _tramos = [];

  window.ComisionesUI = {

    nuevaConfig() {
      _escucharIngenieros();
    },

    async editarConfig(alias) {
      _editandoAlias = alias;
      let snap;
      try {
        snap = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")
          .then(m => m.getDoc(doc(db, "comision_config", alias)));
      } catch (e) {
        console.error("[comisiones] Error al cargar config:", e);
        window.toast?.("Error al cargar configuración. Intenta de nuevo.", "error");
        return;
      }
      const c = snap.exists() ? snap.data() : {};
      _tramos = _parseTramos(c.tramosJson) || [{ meta: 100000, pct: 3 }];

      document.getElementById("com-alias").value   = alias;
      document.getElementById("com-salario").value = c.salarioBase || 0;
      const diasEl = document.getElementById("com-dias-lab");
      if (diasEl) diasEl.value = String(c.diasLaborales || 6);
      const diaEl = document.getElementById("com-dia-liq");
      if (diaEl) { diaEl.value = String(c.diaLiquidacion ?? 1); ComisionesUI._previewPeriodo(); }
      _renderTramos();
      _unsubAlias?.(); _unsubAlias = null;
      document.getElementById("modal-alias").classList.add("hidden");
      document.getElementById("modal-comision").classList.remove("hidden");
    },

    cerrarModal() {
      document.querySelectorAll(".modal-overlay").forEach(m => m.classList.add("hidden"));
    },

    agregarTramo() {
      _tramos.push({ meta: 0, pct: 0 });
      _renderTramos();
    },

    eliminarTramo(idx) {
      _tramos.splice(idx, 1);
      _renderTramos();
    },

    async guardarConfig() {
      const alias       = document.getElementById("com-alias").value.trim();
      const salario     = parseFloat(document.getElementById("com-salario").value) || 0;
      const diasLab     = parseInt(document.getElementById("com-dias-lab")?.value) || 6;
      const diaLiq      = parseInt(document.getElementById("com-dia-liq")?.value ?? "1");
      if (!alias) { window.toast?.("Alias requerido", "error"); return; }

      // Leer tramos del DOM
      _tramos = [];
      document.querySelectorAll(".tramo-row").forEach(row => {
        const meta = parseFloat(row.querySelector(".tramo-meta")?.value ?? "0") || 0;
        const pct  = parseFloat(row.querySelector(".tramo-pct")?.value  ?? "0") || 0;
        _tramos.push({ meta, pct });
      });
      _tramos.sort((a, b) => a.meta - b.meta);

      try {
        const { updateDoc, doc: ud } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        await setDoc(doc(db, "comision_config", alias), {
          aliasIngeniero: alias,
          salarioBase: salario,
          diasLaborales: diasLab,
          diaLiquidacion: diaLiq,
          tramosJson: JSON.stringify(_tramos),
          actualizadoPor: Sesion.uid,
          actualizadoEn: serverTimestamp()
        });
        // Sincronizar diaLiquidacion y salarioBase al perfil del usuario
        try {
          await updateDoc(ud(db, "usuarios", alias), { diaLiquidacion: diaLiq, salarioBase: salario });
        } catch(_) { /* usuario puede no existir todavía */ }
        window.toast?.(`Configuración guardada para ${alias}`, "success");
        this.cerrarModal();
      } catch (e) {
        window.toast?.("Error: " + e.message, "error");
      }
    },

    async marcarPagado(liquidacionId) {
      if (!await window.modal({ title: "Marcar como pagada", message: "¿Marcar esta liquidación como pagada?", confirmLabel: "Sí, marcar" })) return;
      try {
        const { updateDoc, doc: fsDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        await updateDoc(fsDoc(db, "liquidacion_comision", liquidacionId), {
          status: "PAGADO",
          pagadoPor: Sesion.uid,
          pagadoEn: serverTimestamp()
        });
        window.toast?.("Liquidación marcada como pagada", "success");
      } catch (e) {
        window.toast?.("Error: " + e.message, "error");
      }
    },

    cambiarTab(tab) {
      const btn = document.getElementById("com-btn-nueva");
      if (btn) btn.style.display = tab === "config" ? "" : "none";
      _activarTab(tab);
    },

    _previewPeriodo() {
      const dia = parseInt(document.getElementById("com-dia-liq")?.value ?? "1");
      const el  = document.getElementById("com-periodo-preview");
      if (!el) return;
      // Calcular fechas de la semana actual que inicia en ese día
      const hoy = new Date();
      const dow = hoy.getDay(); // 0=Dom
      const diff = ((dia - dow) + 7) % 7;
      const ini = new Date(hoy); ini.setDate(hoy.getDate() - ((7 - diff) % 7 || 7));
      const fin = new Date(ini); fin.setDate(ini.getDate() + 6);
      const fmt = d => d.toLocaleDateString("es-MX", { weekday:"short", day:"numeric", month:"short" });
      el.textContent = `📅 Período actual: ${fmt(ini)} → ${fmt(fin)}`;
      el.style.display = "block";
    },

    nuevaCobranza() {
      _abrirSelectorAlias(alias => _abrirModalCobranza(alias));
    },

    async guardarCobranza() {
      const alias     = document.getElementById("cob-alias").value.trim();
      const umbral    = parseInt(document.getElementById("cob-umbral").value) || 60;
      const porCada   = parseFloat(document.getElementById("cob-por-cada").value) || 1000;
      const comision  = parseFloat(document.getElementById("cob-comision").value) || 10;
      if (!alias) { window.toast?.("Alias requerido", "error"); return; }
      try {
        await setDoc(doc(db, "comision_cobranza_config", alias), {
          aliasIngeniero: alias,
          umbralDias:   umbral,
          montoPorCada: porCada,
          comisionPor:  comision,
          actualizadoPor: Sesion.uid,
          actualizadoEn: serverTimestamp()
        });
        window.toast?.(`Regla de cobranza guardada para ${alias}`, "success");
        this.cerrarModal();
      } catch (e) {
        window.toast?.("Error: " + e.message, "error");
      }
    },

    setMesN10(mesKey) {
      _escucharN10(mesKey);
    },

    toggleVentasN10(uid, mesKey) {
      const det = document.querySelector(`.n10-ventas-detail[data-for-uid="${uid}"][data-for-mes="${mesKey}"]`);
      if (det) det.style.display = det.style.display === "none" ? "" : "none";
    },

    // Expuesto aquí para que _escucharCobranzaConfigs (scope externo) pueda accederlo
    abrirEditCobranza(alias) {
      _abrirModalCobranza(alias);
    }
  };

  function _abrirSelectorAlias(cb) {
    _escucharIngenieros(cb);
  }

  async function _abrirModalCobranza(alias) {
    document.getElementById("cob-alias").value = alias;
    // Cargar config existente si hay
    try {
      const { getDoc: gd, doc: fd } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const snap = await gd(fd(db, "comision_cobranza_config", alias));
      const c = snap.exists() ? snap.data() : {};
      document.getElementById("cob-umbral").value    = c.umbralDias   ?? 60;
      document.getElementById("cob-por-cada").value  = c.montoPorCada ?? 1000;
      document.getElementById("cob-comision").value  = c.comisionPor  ?? 10;
    } catch (_) {}
    _actualizarEjemploCobranza();
    _unsubAlias?.(); _unsubAlias = null;
    document.getElementById("modal-alias").classList.add("hidden");
    document.getElementById("modal-cobranza").classList.remove("hidden");
  }

  function _actualizarEjemploCobranza() {
    const porCada  = parseFloat(document.getElementById("cob-por-cada")?.value) || 1000;
    const com      = parseFloat(document.getElementById("cob-comision")?.value) || 10;
    const umbral   = parseInt(document.getElementById("cob-umbral")?.value) || 60;
    const el = document.getElementById("cob-ejemplo");
    if (el) el.innerHTML = `💡 Por cada <b>$${porCada.toLocaleString("es-MX")}</b> cobrado de notas vencidas a más de <b>${umbral} días</b>, el ingeniero recibe <b>$${com}</b> de comisión. Si cobra $${(porCada*5).toLocaleString("es-MX")} → recibe $${(com*5).toLocaleString("es-MX")}.`;
    // Actualizar en tiempo real al escribir
    ["cob-por-cada","cob-comision","cob-umbral"].forEach(id => {
      const el2 = document.getElementById(id);
      if (el2 && !el2._cobListenerSet) { el2._cobListenerSet = true; el2.addEventListener("input", _actualizarEjemploCobranza); }
    });
  }

  // Escuchar ingenieros disponibles para el selector
  // Guardar unsub del listener de ingenieros para cancelarlo al cerrar modal
  let _unsubAlias = null;

  function _escucharIngenieros(onSelect) {
    const q = query(collection(db, "usuarios"), orderBy("alias"));
    const list = document.getElementById("alias-list");
    if (!list) return;

    window._comAliasCallback = onSelect || (alias => ComisionesUI.editarConfig(alias));

    // Cancelar listener previo antes de abrir uno nuevo
    _unsubAlias?.();
    _unsubAlias = onSnapshot(q, snap => {
      const ingenieros = snap.docs
        .filter(d => ["INGENIERO","RECUPERADOR"].includes(d.data().rol) && d.data().activo !== false);
      list.innerHTML = ingenieros.length === 0
        ? `<div style="color:var(--text-muted);text-align:center;padding:16px">Sin ingenieros registrados</div>`
        : ingenieros.map(d => {
            const u = d.data();
            const alias = u.alias || d.id;
            return `
              <div onclick="window._comAliasCallback('${alias}')"
                style="padding:10px 12px;border-radius:6px;cursor:pointer;
                  border-bottom:1px solid var(--border);font-size:13px;color:var(--text-primary);
                  font-weight:600">
                ${alias}
                <span style="font-size:10px;color:var(--text-muted);font-weight:400;margin-left:6px">${u.email || ""}</span>
              </div>`;
          }).join("");
    });
    document.getElementById("modal-alias").classList.remove("hidden");
  }

  function _renderTramos() {
    const el = document.getElementById("com-tramos");
    if (!el) return;
    el.innerHTML = _tramos.map((t, i) => `
      <div class="tramo-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <div style="flex:1">
          <label style="font-size:10px;color:var(--text-muted)">Meta ventas ($)</label>
          <input class="tramo-meta form-input" type="number" value="${t.meta}" min="0" step="1000"
            style="width:100%;margin-top:2px">
        </div>
        <div style="flex:0.6">
          <label style="font-size:10px;color:var(--text-muted)">% comisión</label>
          <input class="tramo-pct form-input" type="number" value="${t.pct}" min="0" max="100" step="0.5"
            style="width:100%;margin-top:2px">
        </div>
        <button onclick="ComisionesUI.eliminarTramo(${i})"
          style="margin-top:16px;background:none;border:none;cursor:pointer;color:#EF4444;font-size:16px">✕</button>
      </div>`).join("");
  }
}

// ── Cobranza config listener ──────────────────────────────────
let _unsubCob = null;
function _escucharCobranzaConfigs() {
  _unsubCob?.();
  const el = document.getElementById("cob-config-list");
  if (!el) return;

  const q = query(collection(db, "comision_cobranza_config"), orderBy("aliasIngeniero"));
  _unsubCob = onSnapshot(q, snap => {
    if (!document.getElementById("cob-config-list")) return;
    if (snap.empty) {
      el.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:40px">
        Sin reglas de cobranza. Usa "+ Configurar ingeniero".</div>`;
      return;
    }
    el.innerHTML = snap.docs.map(d => {
      const c = d.data();
      return `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
          padding:12px 14px;margin-bottom:8px">
          <div style="display:flex;align-items:center;margin-bottom:6px">
            <div style="flex:1;font-size:13px;font-weight:700;color:var(--text-primary)">${esc(c.aliasIngeniero)}</div>
            <div style="font-size:11px;color:#60A5FA;font-weight:700">
              $${(c.comisionPor||0)} / $${(c.montoPorCada||1000).toLocaleString("es-MX")}
            </div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
            Umbral: <b>${c.umbralDias||60} días</b> de mora · Por cada <b>$${(c.montoPorCada||1000).toLocaleString("es-MX")}</b> cobrado → <b>$${c.comisionPor||10}</b>
          </div>
          <button onclick="_abrirEditCobranza('${d.id}')"
            style="font-size:11px;background:var(--surface-2);border:1px solid var(--border);
              border-radius:5px;padding:4px 10px;cursor:pointer;color:var(--text-primary)">
            ✏️ Editar
          </button>
        </div>`;
    }).join("");
  }, err => console.error("[Comisiones:cobranza]", err));

  window._abrirEditCobranza = alias => ComisionesUI.abrirEditCobranza(alias);
}

// ── N10: listener tiempo real ─────────────────────────────────
let _unsubN10 = null;

function _escucharN10(mesKey) {
  _unsubN10?.();
  const el = document.getElementById("n10-tabla");
  if (!el) return;
  el.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:32px">Cargando…</div>`;

  const q = query(collection(db, "comisiones_n10"), where("mes_key", "==", mesKey));
  _unsubN10 = onSnapshot(q, snap => {
    _unsubs = _unsubs.filter(fn => fn !== _unsubN10); // evitar duplicado
    _unsubs.push(_unsubN10);

    const registros = snap.docs.map(d => d.data()).sort((a, b) => b.litros - a.litros);
    const totalLitros   = registros.reduce((s, r) => s + (r.litros ?? 0), 0);
    const totalComision = registros.reduce((s, r) => s + (r.comision ?? 0), 0);
    const top           = registros[0];

    // KPIs
    _setN10Text("n10-k-litros",   fmtL(totalLitros));
    _setN10Text("n10-k-comision", fmtMXN(totalComision));
    _setN10Text("n10-k-activos",  String(registros.length));
    _setN10Text("n10-k-top",      top ? `${esc(top.alias)} · ${fmtL(top.litros)}` : "–");

    const sub = document.getElementById("n10-subtitle");
    if (sub) sub.textContent = `${registros.length} ingeniero${registros.length !== 1 ? "s" : ""} · ${mesKey}`;

    if (registros.length === 0) {
      el.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:40px">
        Sin ventas N10 registradas para ${mesKey}.<br>
        <span style="font-size:11px">Las comisiones se generan automáticamente al marcar un pedido como Entregado.</span>
      </div>`;
      return;
    }

    el.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:var(--surface-2);border-bottom:1px solid var(--border)">
              <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-muted)">INGENIERO</th>
              <th style="padding:10px 14px;text-align:right;font-weight:700;color:var(--text-muted)">LITROS MES</th>
              <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-muted)">TRAMO</th>
              <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-muted)">$/L</th>
              <th style="padding:10px 14px;text-align:right;font-weight:700;color:var(--text-muted)">COMISIÓN</th>
              <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-muted)">AVANCE vs META</th>
            </tr>
          </thead>
          <tbody>
            ${registros.map(r => _rowN10(r)).join("")}
          </tbody>
        </table>
      </div>`;
  }, err => {
    console.error("[N10 comisiones]", err);
    const el2 = document.getElementById("n10-tabla");
    if (el2) el2.innerHTML = `<div style="color:#EF4444;padding:20px">Error al cargar: ${esc(err.message)}</div>`;
  });
}

function _rowN10(r) {
  const pct    = Math.min(100, Math.round(((r.litros ?? 0) / META_LITROS_DEFAULT) * 100));
  const { siguiente, faltan } = proximoTramo(r.litros ?? 0);
  const tramoColor = ["#9CA3AF","#FBBF24","#34D399","#6366F1"][Math.max(0, (r.tramo ?? 1) - 1)];
  const ventas = Array.isArray(r.ventas) ? r.ventas : [];
  const uid = esc(r.uid ?? "");

  return `
    <tr style="border-bottom:1px solid var(--border);cursor:pointer"
      onclick="ComisionesUI.toggleVentasN10('${uid}','${esc(r.mes_key)}')"
      data-n10-row="${uid}">
      <td style="padding:10px 14px;font-weight:700;color:var(--text-primary)">${esc(r.alias ?? "–")}</td>
      <td style="padding:10px 14px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700">
        ${fmtL(r.litros)}</td>
      <td style="padding:10px 14px;text-align:center">
        <span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;
          background:${tramoColor}22;color:${tramoColor}">
          T${r.tramo ?? "–"} · $${r.rate ?? 0}/L
        </span>
      </td>
      <td style="padding:10px 14px;text-align:center;color:${tramoColor};font-weight:700">
        $${r.rate ?? 0}</td>
      <td style="padding:10px 14px;text-align:right;font-weight:800;color:#4ADE80;
        font-variant-numeric:tabular-nums">${fmtMXN(r.comision)}</td>
      <td style="padding:10px 14px;min-width:180px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${pct}%;background:${pct>=100?"#4ADE80":"#6366F1"};
              border-radius:3px;transition:width .4s"></div>
          </div>
          <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;min-width:32px">${pct}%</span>
        </div>
        ${faltan ? `<div style="font-size:9px;color:var(--text-muted);margin-top:2px">Faltan ${faltan} L → T${proximoTramo(r.litros).tramoSig ?? "∞"}</div>` : `<div style="font-size:9px;color:#4ADE80;margin-top:2px">✓ Meta superada</div>`}
      </td>
    </tr>
    <tr class="n10-ventas-detail" data-for-uid="${uid}" data-for-mes="${esc(r.mes_key)}" style="display:none">
      <td colspan="6" style="padding:0 14px 12px;background:var(--surface)">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);margin:8px 0 6px">
          Ventas individuales (${ventas.length})
        </div>
        ${ventas.length === 0
          ? `<div style="color:var(--text-muted);font-size:11px">Sin ventas registradas</div>`
          : `<table style="width:100%;border-collapse:collapse;font-size:11px">
              <tr style="color:var(--text-muted)">
                <th style="text-align:left;padding:3px 8px;font-weight:600">Pedido</th>
                <th style="text-align:left;padding:3px 8px;font-weight:600">Cliente</th>
                <th style="text-align:right;padding:3px 8px;font-weight:600">Litros</th>
                <th style="text-align:left;padding:3px 8px;font-weight:600">Fecha</th>
              </tr>
              ${ventas.map(v => `
                <tr style="border-top:1px solid var(--border)">
                  <td style="padding:4px 8px;font-weight:700;font-family:monospace">${esc(v.ventaId ?? "–")}</td>
                  <td style="padding:4px 8px">${esc(v.cliente ?? "–")}</td>
                  <td style="padding:4px 8px;text-align:right;font-weight:700">${fmtL(v.litros)}</td>
                  <td style="padding:4px 8px;color:var(--text-muted)">
                    ${v.fecha ? new Date(v.fecha).toLocaleDateString("es-MX",{day:"numeric",month:"short"}) : "–"}
                  </td>
                </tr>`).join("")}
            </table>`}
      </td>
    </tr>`;
}

function _setN10Text(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Helpers ───────────────────────────────────────────────────
function _parseTramos(json) {
  try { return JSON.parse(json || "[]"); } catch { return []; }
}

function _descTramos(json) {
  const tramos = _parseTramos(json);
  if (!tramos.length) return "Sin tramos configurados";
  return tramos.map((t, i) => {
    const desde = i === 0 ? 0 : tramos[i - 1].meta;
    return `${new Intl.NumberFormat("es-MX", { notation:"compact", currency:"MXN" }).format(desde)}–${new Intl.NumberFormat("es-MX", { notation:"compact" }).format(t.meta)}: <b style="color:#60A5FA">${t.pct}%</b>`;
  }).join("  ·  ");
}
