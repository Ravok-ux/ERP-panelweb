/**
 * integraciones.js — Módulo de Integraciones externas
 *
 * Tabs / Integraciones:
 *   pasarela   — Alto/73  Pasarela de pagos (Stripe / Conekta / OXXO Pay)
 *   spei       — Alto/75  Conciliación bancaria manual asistida (SPEI / CSV)
 *   whatsapp   — Medio/64 WhatsApp Business API — simulado, cola en Firestore
 *   api        — Bajo/48  API pública y webhooks para terceros
 *
 * Flags: cada integración tiene `activo` en Firestore.
 * Solo SUPER_ADMIN puede cambiar configuración y activar/desactivar.
 * Todos los roles ven el estado pero no pueden modificar.
 */

import { db }    from "./firebase-config.js";
import { esc }   from "./app.js";
import { Sesion } from "./auth.js";
import {
  doc, getDoc, setDoc, addDoc, getDocs,
  collection, query, where, orderBy, limit, onSnapshot,
  deleteDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Helpers ──────────────────────────────────────────────────
const el  = id => document.getElementById(id);
const fmt = ts => ts ? new Date(ts).toLocaleString("es-MX",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
const SA  = () => Sesion.esSuperAdmin();

// ── Colecciones ───────────────────────────────────────────────
const COL_CFG     = "config_integraciones";
const COL_WA      = "whatsapp_queue";
const COL_SPEI    = "spei_conciliaciones";
const COL_TOKENS  = "api_tokens";
const COL_HOOKS   = "webhook_endpoints";
const COL_EVENTS  = "webhook_events";

// ── Estado ────────────────────────────────────────────────────
let _container = null;
let _tab       = "pasarela";
let _unsubs    = [];

// Configs cargadas desde Firestore (una por tab)
let _cfg = { pasarela:{}, spei:{}, whatsapp:{}, api:{} };

const TABS = [
  { id:"pasarela",  label:"💳 Pasarela de pagos",   badge:"pasarela"  },
  { id:"spei",      label:"🏦 Conciliación SPEI",    badge:"spei"      },
  { id:"whatsapp",  label:"💬 WhatsApp Business",    badge:"whatsapp"  },
  { id:"api",       label:"🔌 API & Webhooks",       badge:"api"       },
];

// ── Mount / Destroy ───────────────────────────────────────────
export const IntegracionesModule = { mount, destroy };

function mount(container) {
  _container = container;
  _container.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;min-height:0;padding:20px 24px;gap:0">

      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap">
        <span style="font-size:28px">🔌</span>
        <div style="flex:1">
          <h2 style="margin:0;font-size:17px;font-weight:900;letter-spacing:-.3px">Integraciones externas</h2>
          <div style="font-size:11px;color:#64748B">Activa o desactiva cada integración conforme crece la operación</div>
        </div>
        ${SA() ? "" : `<div style="font-size:11px;padding:6px 12px;background:#FEF3C7;color:#92400E;border-radius:8px;border:1px solid #FDE68A">
          Solo SUPER_ADMIN puede modificar la configuración</div>`}
      </div>

      <!-- Tabs -->
      <div style="display:flex;gap:6px;border-bottom:1px solid var(--border);margin-bottom:20px;overflow-x:auto;flex-shrink:0">
        ${TABS.map(t => `
          <button id="tab-btn-${t.id}" data-tab="${t.id}"
            style="padding:9px 16px;border:none;border-bottom:2px solid transparent;
              background:transparent;cursor:pointer;font-size:12px;font-weight:600;
              color:#64748B;white-space:nowrap;transition:color .15s,border-color .15s;
              display:flex;align-items:center;gap:6px">
            ${t.label}
            <span id="tab-badge-${t.id}" style="font-size:9px;padding:2px 6px;border-radius:10px;
              font-weight:800;background:#E2E8F0;color:#64748B">—</span>
          </button>`).join("")}
      </div>

      ${TABS.map(t => `<div id="tab-${t.id}" style="display:none;flex:1;min-height:0;overflow-y:auto"></div>`).join("")}
    </div>`;

  TABS.forEach(t => el(`tab-btn-${t.id}`)?.addEventListener("click", () => _activarTab(t.id)));
  _cargarCfgsYBadges();
  _activarTab("pasarela");
}

function destroy() {
  _unsubs.forEach(u => u?.());
  _unsubs = [];
  _cfg = { pasarela:{}, spei:{}, whatsapp:{}, api:{} };
  if (_container) _container.innerHTML = "";
  _container = null;
}

async function _cargarCfgsYBadges() {
  for (const t of TABS) {
    try {
      const snap = await getDoc(doc(db, COL_CFG, t.id));
      if (snap.exists()) {
        _cfg[t.id] = snap.data();
        _actualizarBadge(t.id, snap.data());
      }
    } catch {}
  }
}

function _actualizarBadge(tabId, cfg) {
  const badge = el(`tab-badge-${tabId}`);
  if (!badge) return;
  const estado = cfg.estado || "INACTIVA";
  const estilos = {
    INACTIVA:   { bg:"#E2E8F0", col:"#64748B" },
    CONFIGURADA:{ bg:"#FEF3C7", col:"#92400E" },
    ACTIVA:     { bg:"#DCFCE7", col:"#166534" },
  };
  const s = estilos[estado] || estilos.INACTIVA;
  badge.style.background = s.bg;
  badge.style.color       = s.col;
  badge.textContent       = estado;
}

function _activarTab(tab) {
  _tab = tab;
  _unsubs.forEach(u => u?.()); _unsubs = [];

  TABS.forEach(t => {
    const btn = el(`tab-btn-${t.id}`);
    const div = el(`tab-${t.id}`);
    const act = t.id === tab;
    if (btn) {
      btn.style.color       = act ? "#6366F1" : "#64748B";
      btn.style.borderColor = act ? "#6366F1" : "transparent";
      btn.style.fontWeight  = act ? "800" : "600";
    }
    if (div) div.style.display = act ? "block" : "none";
  });

  if (tab === "pasarela")  _montarPasarela();
  if (tab === "spei")      _montarSpei();
  if (tab === "whatsapp")  _montarWhatsapp();
  if (tab === "api")       _montarApi();
}

// ── Widget reutilizable: toggle + estado ──────────────────────
function _headerIntegracion({ id, icon, nombre, descripcion, proveedores }) {
  const cfg    = _cfg[id] || {};
  const activo = cfg.activo === true;
  const estado = cfg.estado || "INACTIVA";
  const estBg  = estado==="ACTIVA" ? "#DCFCE7" : estado==="CONFIGURADA" ? "#FEF3C7" : "#F1F5F9";
  const estCol = estado==="ACTIVA" ? "#166534" : estado==="CONFIGURADA" ? "#92400E" : "#64748B";
  const prov   = proveedores ? `<div style="font-size:10px;color:#64748B;margin-top:3px">
    ${proveedores.map(p => `<span style="background:var(--surface-2);border:1px solid var(--border);
      border-radius:5px;padding:1px 7px;margin-right:4px">${esc(p)}</span>`).join("")}
  </div>` : "";

  return `
    <div style="display:flex;align-items:flex-start;gap:14px;padding:18px 20px;
      border:1px solid var(--border);border-radius:12px;background:var(--surface);
      margin-bottom:20px;flex-wrap:wrap">
      <span style="font-size:32px;flex-shrink:0">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:800;margin-bottom:4px">${esc(nombre)}</div>
        <div style="font-size:12px;color:#64748B;line-height:1.5">${esc(descripcion)}</div>
        ${prov}
        ${cfg.activadoPor ? `<div style="font-size:10px;color:#94A3B8;margin-top:4px">
          Última modificación: ${esc(cfg.activadoPor)} · ${fmt(cfg._ts)}</div>` : ""}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
        <span style="background:${estBg};color:${estCol};padding:3px 12px;border-radius:20px;
          font-size:10px;font-weight:800">${estado}</span>
        ${SA() ? `
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <span style="font-size:11px;color:#64748B">${activo?"Desactivar":"Activar"}</span>
            <div id="toggle-${id}" data-id="${id}" data-activo="${activo}"
              style="width:42px;height:24px;border-radius:12px;cursor:pointer;position:relative;
                background:${activo?"#6366F1":"#CBD5E1"};transition:background .2s;flex-shrink:0">
              <div style="position:absolute;top:3px;left:${activo?"21px":"3px"};
                width:18px;height:18px;border-radius:50%;background:#fff;
                box-shadow:0 1px 4px rgba(0,0,0,.3);transition:left .2s"></div>
            </div>
          </label>` : ""}
      </div>
    </div>`;
}

async function _toggleIntegracion(id) {
  if (!SA()) return;
  const snap  = await getDoc(doc(db, COL_CFG, id));
  const cfg   = snap.exists() ? snap.data() : {};
  const nuevoActivo = !(cfg.activo === true);
  const nuevoEstado = nuevoActivo
    ? (cfg.configurada ? "ACTIVA" : "CONFIGURADA")
    : "INACTIVA";
  await setDoc(doc(db, COL_CFG, id), {
    ...cfg, activo: nuevoActivo, estado: nuevoEstado,
    activadoPor: Sesion.alias, _ts: Date.now()
  }, { merge: true });
  _cfg[id] = { ...cfg, activo: nuevoActivo, estado: nuevoEstado,
    activadoPor: Sesion.alias, _ts: Date.now() };
  _actualizarBadge(id, _cfg[id]);
  window.toast?.(nuevoActivo ? `${id} activada` : `${id} desactivada`, nuevoActivo ? "success" : "warn");
  _activarTab(id);
}

// ══════════════════════════════════════════════════════════════
// ALTO/73 — PASARELA DE PAGOS (Stripe / Conekta / OXXO Pay)
// ══════════════════════════════════════════════════════════════
function _montarPasarela() {
  const wrap = el("tab-pasarela");
  if (!wrap) return;
  const cfg = _cfg.pasarela || {};

  wrap.innerHTML = `
    ${_headerIntegracion({
      id:"pasarela", icon:"💳",
      nombre:"Pasarela de pagos",
      descripcion:"Acepta tarjetas, OXXO y transferencias SPEI desde el sistema. Genera links de pago por pedido y registra automáticamente el cobro en cobranza.",
      proveedores:["Stripe","Conekta","OXXO Pay"]
    })}

    <!-- Selector de proveedor -->
    <div style="border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:16px;background:var(--surface)">
      <div style="font-size:13px;font-weight:800;margin-bottom:14px">⚙️ Configuración</div>

      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px" id="pas-proveedores">
        ${["Stripe","Conekta","OXXO Pay"].map(p => {
          const sel = (cfg.proveedor||"Stripe") === p;
          return `<div data-prov="${esc(p)}" class="pas-prov-card"
            style="border:2px solid ${sel?"#6366F1":"var(--border)"};border-radius:10px;
              padding:14px;text-align:center;cursor:${SA()?"pointer":"default"};
              background:${sel?"#EEF2FF":"var(--surface-2)"}">
            <div style="font-size:22px;margin-bottom:4px">
              ${p==="Stripe"?"🟦":p==="Conekta"?"🟧":"🟩"}
            </div>
            <div style="font-size:12px;font-weight:700;color:${sel?"#6366F1":"var(--text-primary)"}">${esc(p)}</div>
            ${sel?`<div style="font-size:9px;color:#6366F1;font-weight:800;margin-top:2px">SELECCIONADO</div>`:""}
          </div>`;
        }).join("")}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">API KEY (pública)</label>
          <input class="form-input" id="pas-api-key" type="text"
            placeholder="pk_live_… / user_…"
            value="${esc(cfg.apiKeyPub||"")}"
            ${SA()?"":"readonly"}
            style="width:100%;font-family:monospace;font-size:11px">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">API KEY (secreta) <span style="color:#DC2626">🔒</span></label>
          <input class="form-input" id="pas-api-secret" type="password"
            placeholder="sk_live_… / private_key_…"
            value="${esc(cfg.apiKeySecret||"")}"
            ${SA()?"":"readonly"}
            style="width:100%;font-family:monospace;font-size:11px">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">WEBHOOK SECRET</label>
          <input class="form-input" id="pas-webhook-secret" type="password"
            placeholder="whsec_…"
            value="${esc(cfg.webhookSecret||"")}"
            ${SA()?"":"readonly"}
            style="width:100%;font-family:monospace;font-size:11px">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">MODO</label>
          <select class="form-input" id="pas-modo" ${SA()?"":"disabled"} style="width:100%">
            <option value="sandbox" ${(cfg.modo||"sandbox")==="sandbox"?"selected":""}>🧪 Sandbox (pruebas)</option>
            <option value="live" ${cfg.modo==="live"?"selected":""}>🚀 Live (producción)</option>
          </select>
        </div>
      </div>

      ${SA() ? `
      <div style="display:flex;gap:8px;margin-top:16px">
        <button id="pas-guardar" style="padding:8px 20px;border-radius:8px;border:none;
          background:#6366F1;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
          💾 Guardar configuración
        </button>
        <button id="pas-probar" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);
          background:transparent;color:#64748B;font-size:12px;cursor:pointer">
          🧪 Probar conexión
        </button>
      </div>` : ""}
    </div>

    <!-- Métodos de pago habilitados -->
    <div style="border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:16px;background:var(--surface)">
      <div style="font-size:13px;font-weight:800;margin-bottom:12px">💳 Métodos de pago habilitados</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">
        ${[
          { id:"card",     icon:"💳", label:"Tarjeta crédito/déb." },
          { id:"oxxo",     icon:"🏪", label:"OXXO"                 },
          { id:"spei",     icon:"🏦", label:"Transferencia SPEI"    },
          { id:"amex",     icon:"🟦", label:"American Express"      },
        ].map(m => {
          const on = cfg.metodos?.[m.id] !== false;
          return `<label style="display:flex;align-items:center;gap:8px;padding:10px 12px;
            border:1px solid var(--border);border-radius:8px;cursor:${SA()?"pointer":"default"};
            background:${on?"#EEF2FF":"var(--surface-2)"}">
            <input type="checkbox" id="pas-met-${m.id}" ${on?"checked":""} ${SA()?"":"disabled"}
              style="accent-color:#6366F1">
            <span style="font-size:13px">${m.icon}</span>
            <span style="font-size:11px;font-weight:600">${esc(m.label)}</span>
          </label>`;
        }).join("")}
      </div>
    </div>

    <!-- Historial de links generados (vacío si inactivo) -->
    <div style="border:1px solid var(--border);border-radius:12px;padding:18px 20px;background:var(--surface)">
      <div style="font-size:13px;font-weight:800;margin-bottom:12px">🔗 Links de pago recientes</div>
      ${cfg.activo ? `
        <div id="pas-links-body">
          <div style="padding:20px;text-align:center;color:var(--text-sec);font-size:12px">
            Los links de pago generados desde pedidos aparecerán aquí
          </div>
        </div>` : `
        <div style="padding:20px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px;opacity:.4">🔒</div>
          <div style="font-size:12px;color:#94A3B8">Integración inactiva — activa la pasarela para generar links de pago</div>
        </div>`}
    </div>`;

  // ── Selector de proveedor ──
  if (SA()) {
    let _provSel = cfg.proveedor || "Stripe";
    wrap.querySelectorAll(".pas-prov-card").forEach(card => {
      card.addEventListener("click", () => {
        _provSel = card.dataset.prov;
        wrap.querySelectorAll(".pas-prov-card").forEach(c => {
          const act = c.dataset.prov === _provSel;
          c.style.borderColor = act ? "#6366F1" : "var(--border)";
          c.style.background  = act ? "#EEF2FF" : "var(--surface-2)";
          c.querySelector("div:last-child").innerHTML = act
            ? `<div style="font-size:9px;color:#6366F1;font-weight:800;margin-top:2px">SELECCIONADO</div>` : "";
          c.querySelector("div:nth-child(2)").style.color = act ? "#6366F1" : "var(--text-primary)";
        });
      });
    });

    el("pas-guardar")?.addEventListener("click", async () => {
      const btn = el("pas-guardar");
      btn.disabled = true; btn.textContent = "Guardando…";
      try {
        const metodos = {};
        ["card","oxxo","spei","amex"].forEach(m => {
          metodos[m] = el(`pas-met-${m}`)?.checked ?? false;
        });
        const datos = {
          proveedor: _provSel,
          apiKeyPub:      el("pas-api-key")?.value.trim()    || "",
          apiKeySecret:   el("pas-api-secret")?.value.trim() || "",
          webhookSecret:  el("pas-webhook-secret")?.value.trim() || "",
          modo:           el("pas-modo")?.value || "sandbox",
          metodos,
          configurada: true,
          estado: (_cfg.pasarela?.activo) ? "ACTIVA" : "CONFIGURADA",
          activadoPor: Sesion.alias, _ts: Date.now()
        };
        await setDoc(doc(db, COL_CFG, "pasarela"), datos, { merge: true });
        _cfg.pasarela = { ..._cfg.pasarela, ...datos };
        _actualizarBadge("pasarela", _cfg.pasarela);
        window.toast?.("Configuración guardada","success");
      } catch(e) { window.toast?.("Error: "+e.message,"error"); }
      finally { btn.disabled=false; btn.textContent="💾 Guardar configuración"; }
    });

    el("pas-probar")?.addEventListener("click", () => {
      window.toast?.("Conexión de prueba: OK (sandbox simulado)","success");
    });

    el(`toggle-pasarela`)?.addEventListener("click", () => _toggleIntegracion("pasarela"));
  }
}

// ══════════════════════════════════════════════════════════════
// ALTO/75 — CONCILIACIÓN BANCARIA SPEI (manual asistida)
// Colección: spei_conciliaciones
// ══════════════════════════════════════════════════════════════
function _montarSpei() {
  const wrap = el("tab-spei");
  if (!wrap) return;
  const cfg = _cfg.spei || {};

  wrap.innerHTML = `
    ${_headerIntegracion({
      id:"spei", icon:"🏦",
      nombre:"Conciliación bancaria SPEI",
      descripcion:"Carga el estado de cuenta del banco (CSV) y el sistema cruza automáticamente cada depósito contra los cobros registrados. Reduce de horas a minutos el trabajo de Mesa de Control.",
      proveedores:["BBVA","Banamex (CityBanamex)","Banorte","HSBC","STP"]
    })}

    <!-- Carga CSV -->
    <div style="border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:16px;background:var(--surface)">
      <div style="font-size:13px;font-weight:800;margin-bottom:14px">📄 Cargar estado de cuenta (CSV)</div>

      <div style="border:2px dashed var(--border);border-radius:10px;padding:28px;
        text-align:center;background:var(--surface-2);margin-bottom:14px;position:relative" id="spei-drop-zone">
        <div style="font-size:32px;margin-bottom:8px">📊</div>
        <div style="font-size:13px;font-weight:700;margin-bottom:4px">Arrastra tu CSV aquí</div>
        <div style="font-size:11px;color:#64748B;margin-bottom:12px">
          Formato esperado: fecha, referencia, concepto, cargo, abono, saldo
        </div>
        <input type="file" id="spei-csv-input" accept=".csv,.txt"
          style="position:absolute;inset:0;opacity:0;cursor:pointer">
        <button onclick="document.getElementById('spei-csv-input').click()"
          style="padding:8px 18px;border-radius:8px;border:1px solid var(--border);
            background:var(--surface);font-size:12px;font-weight:600;cursor:pointer;
            color:var(--text-primary)">
          📂 Seleccionar archivo
        </button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">COL. REFERENCIA</label>
          <input class="form-input" id="spei-col-ref" type="number" min="1" value="${cfg.colRef||2}"
            style="width:100%;text-align:center" placeholder="2">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">COL. ABONO</label>
          <input class="form-input" id="spei-col-abono" type="number" min="1" value="${cfg.colAbono||5}"
            style="width:100%;text-align:center" placeholder="5">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">COL. FECHA</label>
          <input class="form-input" id="spei-col-fecha" type="number" min="1" value="${cfg.colFecha||1}"
            style="width:100%;text-align:center" placeholder="1">
        </div>
      </div>
      <button id="spei-conciliar" style="padding:8px 20px;border-radius:8px;border:none;
        background:#1D4ED8;color:#fff;font-size:12px;font-weight:700;cursor:pointer;opacity:.5"
        disabled>
        🔄 Conciliar contra cobranza
      </button>
      <span id="spei-archivo-nombre" style="font-size:11px;color:#64748B;margin-left:10px"></span>
    </div>

    <!-- Resultado de conciliación -->
    <div id="spei-resultado" style="display:none">
      <div class="kpi-row" style="margin-bottom:16px">
        <div class="kpi-card" style="border-left-color:#16A34A">
          <div class="kpi-icon">✅</div><div class="kpi-val" id="spei-kpi-match">0</div>
          <div class="kpi-label">Conciliados</div>
        </div>
        <div class="kpi-card" style="border-left-color:#DC2626">
          <div class="kpi-icon">❓</div><div class="kpi-val" id="spei-kpi-nomatch">0</div>
          <div class="kpi-label">Sin coincidencia</div>
        </div>
        <div class="kpi-card" style="border-left-color:#D97706">
          <div class="kpi-icon">⚠️</div><div class="kpi-val" id="spei-kpi-parcial">0</div>
          <div class="kpi-label">Parciales</div>
        </div>
        <div class="kpi-card" style="border-left-color:#6366F1">
          <div class="kpi-icon">💰</div><div class="kpi-val" id="spei-kpi-total">$0</div>
          <div class="kpi-label">Total conciliado</div>
        </div>
      </div>

      <div style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 250px)">
        <table class="data-table">
          <thead><tr>
            <th>FECHA</th><th>REFERENCIA</th><th>CONCEPTO / BANCO</th>
            <th style="text-align:right">ABONO</th><th>CLIENTE DETECTADO</th>
            <th>ESTADO</th>
          </tr></thead>
          <tbody id="spei-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Historial de conciliaciones -->
    <div style="border:1px solid var(--border);border-radius:12px;padding:18px 20px;
      margin-top:16px;background:var(--surface)">
      <div style="font-size:13px;font-weight:800;margin-bottom:12px">🗂️ Historial de conciliaciones</div>
      <div id="spei-historial">
        <div style="padding:20px;text-align:center;color:var(--text-sec);font-size:12px">
          Las conciliaciones guardadas aparecen aquí
        </div>
      </div>
    </div>`;

  // ── Lógica CSV ──
  let _csvRows = [];

  el("spei-csv-input")?.addEventListener("change", e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (el("spei-archivo-nombre")) el("spei-archivo-nombre").textContent = file.name;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result || "";
      _csvRows = _parseCsv(text);
      if (el("spei-conciliar")) {
        el("spei-conciliar").disabled = false;
        el("spei-conciliar").style.opacity = "1";
      }
      window.toast?.(`${_csvRows.length} movimientos cargados del CSV`, "success");
    };
    reader.readAsText(file, "latin1");
  });

  el("spei-conciliar")?.addEventListener("click", async () => {
    if (!_csvRows.length) return;
    const btn = el("spei-conciliar");
    btn.disabled = true; btn.textContent = "Conciliando…";
    try {
      const colRef   = parseInt(el("spei-col-ref")?.value||"2")   - 1;
      const colAbono = parseInt(el("spei-col-abono")?.value||"5") - 1;
      const colFecha = parseInt(el("spei-col-fecha")?.value||"1") - 1;

      // Cargar pagos de cobranza del último año
      const hace365 = Date.now() - 365*86400000;
      const cobSnap = await getDocs(query(
        collection(db,"cobranza"), where("_ts",">=",hace365), limit(3000)
      ));
      const cobros = cobSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const resultado = _csvRows.map(row => {
        const ref    = (row[colRef]   || "").trim();
        const abono  = parseFloat((row[colAbono] || "0").replace(/[,$\s]/g,"")) || 0;
        const fecha  = (row[colFecha] || "").trim();
        const concepto = row.slice(0,8).join(" | ").slice(0,80);

        if (!abono || abono <= 0) return null;

        // Buscar por referencia o por monto exacto
        let match = cobros.find(c => ref && (c.referencia||"").includes(ref));
        let tipo  = "EXACTO";
        if (!match) {
          match = cobros.find(c => Math.abs((c.monto||c.importe||0) - abono) < 1);
          tipo = match ? "MONTO" : null;
        }
        return { ref, abono, fecha, concepto, match, tipo };
      }).filter(Boolean);

      const matches  = resultado.filter(r => r.match && r.tipo === "EXACTO");
      const parciales= resultado.filter(r => r.match && r.tipo === "MONTO");
      const noMatch  = resultado.filter(r => !r.match);
      const total    = matches.reduce((s,r) => s+r.abono, 0) + parciales.reduce((s,r)=>s+r.abono,0);

      if (el("spei-kpi-match"))   el("spei-kpi-match").textContent   = matches.length;
      if (el("spei-kpi-nomatch")) el("spei-kpi-nomatch").textContent = noMatch.length;
      if (el("spei-kpi-parcial")) el("spei-kpi-parcial").textContent = parciales.length;
      if (el("spei-kpi-total"))   el("spei-kpi-total").textContent   =
        total.toLocaleString("es-MX",{style:"currency",currency:"MXN"});

      const tbody = el("spei-body");
      const fmtMXN = v => Number(v).toLocaleString("es-MX",{style:"currency",currency:"MXN"});
      if (tbody) tbody.innerHTML = resultado.map(r => `<tr>
        <td style="font-size:11px;white-space:nowrap">${esc(r.fecha)}</td>
        <td style="font-family:monospace;font-size:11px">${esc(r.ref||"–")}</td>
        <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(r.concepto)}</td>
        <td style="text-align:right;font-weight:700;font-variant-numeric:tabular-nums">${fmtMXN(r.abono)}</td>
        <td style="font-size:11px">${r.match ? esc(r.match.clienteNombre||r.match.cliente||"—") : "—"}</td>
        <td>${r.match
          ? `<span style="background:${r.tipo==="EXACTO"?"#DCFCE7":"#FEF3C7"};
              color:${r.tipo==="EXACTO"?"#166534":"#92400E"};
              padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700">
              ${r.tipo==="EXACTO"?"✅ Conciliado":"⚠️ Monto similar"}</span>`
          : `<span style="background:#FEE2E2;color:#991B1B;
              padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700">❓ Sin match</span>`}
        </td>
      </tr>`).join("");

      if (el("spei-resultado")) el("spei-resultado").style.display = "block";

      // Guardar historial en Firestore
      await addDoc(collection(db, COL_SPEI), {
        total: resultado.length, matches: matches.length,
        parciales: parciales.length, noMatch: noMatch.length,
        importeTotal: total, quienCargó: Sesion.alias, _ts: Date.now()
      });
      _cargarHistorialSpei();
    } catch(e) { window.toast?.("Error: "+e.message,"error"); }
    finally { btn.disabled=false; btn.textContent="🔄 Conciliar contra cobranza"; }
  });

  function _parseCsv(text) {
    return text.split(/\r?\n/)
      .map(line => line.split(/,|;|\t/).map(c => c.replace(/^["']|["']$/g,"").trim()))
      .filter(row => row.length > 2 && row.some(c => c));
  }

  async function _cargarHistorialSpei() {
    try {
      const snap = await getDocs(query(collection(db,COL_SPEI), orderBy("_ts","desc"), limit(20)));
      const div  = el("spei-historial");
      if (!div) return;
      if (!snap.docs.length) {
        div.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-sec);font-size:12px">Sin historial</div>`;
        return;
      }
      div.innerHTML = snap.docs.map(d => {
        const r = d.data();
        return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;
          border-bottom:1px solid var(--border)">
          <div style="flex:1">
            <div style="font-size:12px;font-weight:700">${fmt(r._ts)}</div>
            <div style="font-size:11px;color:#64748B">Por: ${esc(r.quienCargó||"—")}</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <span style="background:#DCFCE7;color:#166534;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">
              ✅ ${r.matches} conciliados</span>
            <span style="background:#FEF3C7;color:#92400E;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">
              ⚠️ ${r.parciales} parciales</span>
            <span style="background:#FEE2E2;color:#991B1B;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">
              ❓ ${r.noMatch} sin match</span>
          </div>
        </div>`;
      }).join("");
    } catch {}
  }
  _cargarHistorialSpei();

  if (SA()) el(`toggle-spei`)?.addEventListener("click", () => _toggleIntegracion("spei"));
}

// ══════════════════════════════════════════════════════════════
// MEDIO/64 — WHATSAPP BUSINESS API (simulado / cola en Firestore)
// Colección: whatsapp_queue
// ══════════════════════════════════════════════════════════════
function _montarWhatsapp() {
  const wrap = el("tab-whatsapp");
  if (!wrap) return;
  const cfg = _cfg.whatsapp || {};

  const PLANTILLAS = [
    { id:"vencimiento",    label:"Recordatorio de vencimiento",   vars:["{{cliente}}","{{monto}}","{{dias}}"] },
    { id:"estado_cuenta",  label:"Estado de cuenta",              vars:["{{cliente}}","{{saldo}}","{{limite}}"] },
    { id:"confirmacion",   label:"Confirmación de pedido",        vars:["{{cliente}}","{{folio}}","{{total}}"] },
    { id:"cobranza",       label:"Aviso de cobranza",             vars:["{{cliente}}","{{referencia}}","{{monto}}"] },
  ];

  wrap.innerHTML = `
    ${_headerIntegracion({
      id:"whatsapp", icon:"💬",
      nombre:"WhatsApp Business API",
      descripcion:"Envía vencimientos, estados de cuenta y confirmaciones directamente al WhatsApp del cliente. Los mensajes se encolan en Firestore y se despachan cuando la integración está activa.",
      proveedores:["Meta (oficial)","Twilio","360dialog","Vonage"]
    })}

    <!-- Configuración API -->
    <div style="border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:16px;background:var(--surface)">
      <div style="font-size:13px;font-weight:800;margin-bottom:14px">⚙️ Credenciales Meta for Developers</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">PHONE NUMBER ID</label>
          <input class="form-input" id="wa-phone-id" type="text"
            placeholder="123456789012345"
            value="${esc(cfg.phoneNumberId||"")}"
            ${SA()?"":"readonly"}
            style="width:100%;font-family:monospace;font-size:11px">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">ACCESS TOKEN <span style="color:#DC2626">🔒</span></label>
          <input class="form-input" id="wa-token" type="password"
            placeholder="EAA…"
            value="${esc(cfg.accessToken||"")}"
            ${SA()?"":"readonly"}
            style="width:100%;font-family:monospace;font-size:11px">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">WABA ID (Business Account)</label>
          <input class="form-input" id="wa-waba-id" type="text"
            placeholder="WABA ID"
            value="${esc(cfg.wabaId||"")}"
            ${SA()?"":"readonly"}
            style="width:100%;font-family:monospace;font-size:11px">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">PROVEEDOR</label>
          <select class="form-input" id="wa-proveedor" ${SA()?"":"disabled"} style="width:100%">
            ${["Meta (oficial)","Twilio","360dialog","Vonage"].map(p =>
              `<option value="${p}" ${(cfg.proveedor||"Meta (oficial)")==p?"selected":""}>${esc(p)}</option>`).join("")}
          </select>
        </div>
      </div>
      ${SA() ? `
      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="wa-guardar" style="padding:8px 20px;border-radius:8px;border:none;
          background:#16A34A;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
          💾 Guardar
        </button>
        <button id="wa-test" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);
          background:transparent;color:#64748B;font-size:12px;cursor:pointer">
          🧪 Mensaje de prueba
        </button>
      </div>` : ""}
    </div>

    <!-- Plantillas -->
    <div style="border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:16px;background:var(--surface)">
      <div style="font-size:13px;font-weight:800;margin-bottom:12px">📋 Plantillas aprobadas</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px">
        ${PLANTILLAS.map(p => {
          const on = cfg.plantillas?.[p.id] !== false;
          return `<div style="border:1px solid ${on?"#16A34A":"var(--border)"};border-radius:10px;padding:14px;
            background:${on?"#F0FDF4":"var(--surface-2)"}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <div style="font-size:12px;font-weight:700">${esc(p.label)}</div>
              ${SA() ? `<label style="cursor:pointer">
                <input type="checkbox" id="wa-plt-${p.id}" ${on?"checked":""} style="accent-color:#16A34A">
              </label>` : `<span style="font-size:10px;color:${on?"#166534":"#94A3B8"};font-weight:700">${on?"ACTIVA":"INACTIVA"}</span>`}
            </div>
            <div style="font-size:10px;color:#64748B">Variables: ${p.vars.map(v=>`<code style="background:var(--surface);padding:1px 4px;border-radius:3px">${v}</code>`).join(", ")}</div>
          </div>`;
        }).join("")}
      </div>
    </div>

    <!-- Cola de mensajes -->
    <div style="border:1px solid var(--border);border-radius:12px;padding:18px 20px;background:var(--surface)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="font-size:13px;font-weight:800;flex:1">📤 Cola de mensajes</div>
        <span style="font-size:11px;padding:4px 10px;border-radius:20px;
          background:${cfg.activo?"#DCFCE7":"#FEE2E2"};color:${cfg.activo?"#166534":"#991B1B"};font-weight:700">
          ${cfg.activo?"EN VIVO (simulado)":"RETENIDOS (inactivo)"}
        </span>
      </div>
      <div id="wa-cola-body">
        <div style="padding:20px;text-align:center;color:var(--text-sec);font-size:12px">Cargando cola…</div>
      </div>
    </div>`;

  // ── Guardar config ──
  if (SA()) {
    el("wa-guardar")?.addEventListener("click", async () => {
      const btn = el("wa-guardar");
      btn.disabled = true; btn.textContent = "Guardando…";
      try {
        const plantillas = {};
        PLANTILLAS.forEach(p => { plantillas[p.id] = el(`wa-plt-${p.id}`)?.checked ?? false; });
        const datos = {
          phoneNumberId: el("wa-phone-id")?.value.trim()||"",
          accessToken:   el("wa-token")?.value.trim()||"",
          wabaId:        el("wa-waba-id")?.value.trim()||"",
          proveedor:     el("wa-proveedor")?.value||"Meta (oficial)",
          plantillas, configurada: true,
          estado: _cfg.whatsapp?.activo ? "ACTIVA" : "CONFIGURADA",
          activadoPor: Sesion.alias, _ts: Date.now()
        };
        await setDoc(doc(db, COL_CFG, "whatsapp"), datos, { merge: true });
        _cfg.whatsapp = { ..._cfg.whatsapp, ...datos };
        _actualizarBadge("whatsapp", _cfg.whatsapp);
        window.toast?.("Configuración de WhatsApp guardada","success");
      } catch(e) { window.toast?.("Error: "+e.message,"error"); }
      finally { btn.disabled=false; btn.textContent="💾 Guardar"; }
    });

    el("wa-test")?.addEventListener("click", async () => {
      await addDoc(collection(db, COL_WA), {
        tipo: "TEST", plantilla: "test", destinatario: "5500000000",
        clienteNombre: "PRUEBA", variables: {}, estado: "SIMULADO",
        quienEnvió: Sesion.alias, _ts: Date.now()
      });
      window.toast?.("Mensaje de prueba encolado (simulado)","success");
      _cargarCola();
    });

    el(`toggle-whatsapp`)?.addEventListener("click", () => _toggleIntegracion("whatsapp"));
  }

  // ── Cola de mensajes en tiempo real ──
  function _cargarCola() {
    const q = query(collection(db, COL_WA), orderBy("_ts","desc"), limit(50));
    const unsub = onSnapshot(q, snap => {
      const div = el("wa-cola-body");
      if (!div) return;
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!rows.length) {
        div.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-sec);font-size:12px">
          Cola vacía — los mensajes aparecerán aquí cuando se generen desde cobranza o pedidos</div>`;
        return;
      }
      div.innerHTML = `<div style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 250px)"><table class="data-table">
        <thead><tr><th>FECHA</th><th>TIPO</th><th>CLIENTE</th><th>TELÉFONO</th><th>ESTADO</th></tr></thead>
        <tbody>${rows.map(r => {
          const estBg = r.estado==="ENVIADO"?"#DCFCE7":r.estado==="ERROR"?"#FEE2E2":"#FEF3C7";
          const estCol= r.estado==="ENVIADO"?"#166534":r.estado==="ERROR"?"#991B1B":"#92400E";
          return `<tr>
            <td style="font-size:11px;white-space:nowrap">${fmt(r._ts)}</td>
            <td><span style="background:#E0F2FE;color:#0369A1;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700">${esc(r.plantilla||r.tipo)}</span></td>
            <td style="font-weight:600">${esc(r.clienteNombre||"—")}</td>
            <td style="font-family:monospace;font-size:11px">${esc(r.destinatario||"—")}</td>
            <td><span style="background:${estBg};color:${estCol};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">${esc(r.estado||"PENDIENTE")}</span></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`;
    }, e => console.error("[WA cola]", e));
    _unsubs.push(unsub);
  }
  _cargarCola();
}

// ══════════════════════════════════════════════════════════════
// BAJO/48 — API PÚBLICA Y WEBHOOKS PARA TERCEROS
// Colecciones: api_tokens, webhook_endpoints, webhook_events
// ══════════════════════════════════════════════════════════════
function _montarApi() {
  const wrap = el("tab-api");
  if (!wrap) return;
  const cfg = _cfg.api || {};

  // Endpoints disponibles para exponer
  const ENDPOINTS = [
    { path:"/v1/clientes",         metodos:["GET"],        desc:"Lista de clientes activos"       },
    { path:"/v1/pedidos",          metodos:["GET","POST"],  desc:"Consulta y creación de pedidos"  },
    { path:"/v1/inventario",       metodos:["GET"],        desc:"Stock disponible por producto"    },
    { path:"/v1/precios",          metodos:["GET"],        desc:"Lista de precios por segmento"    },
    { path:"/v1/cobranza",         metodos:["GET"],        desc:"Saldos y vencimientos"            },
    { path:"/v1/webhooks/eventos", metodos:["POST"],       desc:"Endpoint receptor de eventos"     },
  ];

  const EVENTOS_WH = ["pedido.creado","pedido.confirmado","pedido.entregado",
    "pago.registrado","cliente.actualizado","inventario.bajo"];

  wrap.innerHTML = `
    ${_headerIntegracion({
      id:"api", icon:"🔌",
      nombre:"API pública y webhooks",
      descripcion:"Expone endpoints REST para laboratorios, proveedores y clientes corporativos. También permite registrar webhooks para que sistemas externos reciban eventos en tiempo real.",
      proveedores:["REST JSON","API Key auth","HMAC signatures"]
    })}

    <!-- Tabs internas -->
    <div style="display:flex;gap:6px;margin-bottom:16px;border-bottom:1px solid var(--border)">
      ${["tokens","webhooks","endpoints","eventos"].map(t =>
        `<button id="api-sub-${t}"
          style="padding:8px 14px;border:none;border-bottom:2px solid ${t==="tokens"?"#6366F1":"transparent"};
            background:transparent;cursor:pointer;font-size:11px;font-weight:600;
            color:${t==="tokens"?"#6366F1":"#64748B"}">
          ${{tokens:"🔑 Tokens",webhooks:"🪝 Webhooks",endpoints:"📖 Endpoints",eventos:"📋 Eventos"}[t]}
        </button>`).join("")}
    </div>

    <div id="api-sub-tokens-content"></div>
    <div id="api-sub-webhooks-content" style="display:none"></div>
    <div id="api-sub-endpoints-content" style="display:none"></div>
    <div id="api-sub-eventos-content" style="display:none"></div>`;

  // Bind sub-tabs
  ["tokens","webhooks","endpoints","eventos"].forEach(t => {
    el(`api-sub-${t}`)?.addEventListener("click", () => {
      ["tokens","webhooks","endpoints","eventos"].forEach(tt => {
        const btn = el(`api-sub-${tt}`);
        const div = el(`api-sub-${tt}-content`);
        const act = tt === t;
        if (btn) { btn.style.color = act?"#6366F1":"#64748B"; btn.style.borderColor=act?"#6366F1":"transparent"; }
        if (div) div.style.display = act ? "block" : "none";
      });
      if (t === "tokens")    _renderTokens();
      if (t === "webhooks")  _renderWebhooks();
      if (t === "endpoints") _renderEndpoints();
      if (t === "eventos")   _renderEventos();
    });
  });

  if (SA()) el(`toggle-api`)?.addEventListener("click", () => _toggleIntegracion("api"));

  // ── Sub-tab: Tokens ──
  async function _renderTokens() {
    const div = el("api-sub-tokens-content");
    if (!div) return;
    div.innerHTML = `
      ${SA() ? `
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px">
        <div style="flex:1;min-width:160px">
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">NOMBRE DEL CONSUMIDOR</label>
          <input class="form-input" id="api-tok-nombre" type="text" placeholder="Ej. Laboratorio Omega, Proveedor XYZ" style="width:100%">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">TIPO</label>
          <select class="form-input" id="api-tok-tipo" style="width:160px">
            <option value="read">Solo lectura</option>
            <option value="write">Lectura + escritura</option>
            <option value="full">Acceso completo</option>
          </select>
        </div>
        <button id="api-tok-generar" style="padding:8px 18px;border-radius:8px;border:none;
          background:#6366F1;color:#fff;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">
          🔑 Generar token
        </button>
      </div>` : ""}
      <div id="api-tok-body"><div style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</div></div>`;

    if (SA()) {
      el("api-tok-generar")?.addEventListener("click", async () => {
        const nombre = el("api-tok-nombre")?.value.trim();
        const tipo   = el("api-tok-tipo")?.value || "read";
        if (!nombre) { window.toast?.("Ingresa el nombre del consumidor","warn"); return; }
        const token = _generarToken();
        const btn = el("api-tok-generar");
        btn.disabled = true;
        try {
          await addDoc(collection(db, COL_TOKENS), {
            nombre, tipo, token, activo: true,
            creadoPor: Sesion.alias, _ts: Date.now(), ultimoUso: null
          });
          if (el("api-tok-nombre")) el("api-tok-nombre").value = "";
          window.toast?.(`Token generado para ${nombre}. Cópialo ahora — no se mostrará completo después.`,"success");
          // Mostrar token completo UNA SOLA VEZ
          setTimeout(() => alert(`Token generado:\n${token}\n\nCópialo ahora — no se volverá a mostrar completo.`), 200);
          _cargarTokens();
        } catch(e) { window.toast?.("Error: "+e.message,"error"); }
        finally { btn.disabled=false; }
      });
    }
    _cargarTokens();
  }

  async function _cargarTokens() {
    const div = el("api-tok-body");
    if (!div) return;
    try {
      const snap = await getDocs(query(collection(db,COL_TOKENS), orderBy("_ts","desc"), limit(100)));
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!rows.length) {
        div.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-sec);font-size:12px">
          Sin tokens generados. Crea el primero para permitir acceso externo a la API.</div>`;
        return;
      }
      div.innerHTML = `<div style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 250px)"><table class="data-table">
        <thead><tr><th>CONSUMIDOR</th><th>TIPO</th><th>TOKEN (preview)</th>
          <th>ESTADO</th><th>CREADO</th>${SA()?"<th></th>":""}</tr></thead>
        <tbody>${rows.map(r => {
          const preview = (r.token||"").slice(0,8) + "…" + (r.token||"").slice(-4);
          const tipoBg = r.tipo==="full"?"#FEE2E2":r.tipo==="write"?"#FEF3C7":"#E0F2FE";
          const tipoCol= r.tipo==="full"?"#991B1B":r.tipo==="write"?"#92400E":"#0369A1";
          return `<tr>
            <td style="font-weight:700">${esc(r.nombre||"—")}</td>
            <td><span style="background:${tipoBg};color:${tipoCol};padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700">${esc(r.tipo)}</span></td>
            <td style="font-family:monospace;font-size:11px;color:#64748B">${esc(preview)}</td>
            <td><span style="background:${r.activo?"#DCFCE7":"#F1F5F9"};color:${r.activo?"#166534":"#64748B"};
              padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">
              ${r.activo?"ACTIVO":"REVOCADO"}</span></td>
            <td style="font-size:11px;white-space:nowrap">${fmt(r._ts)}</td>
            ${SA() ? `<td>
              <button data-id="${esc(r.id)}" data-activo="${r.activo}" class="tok-toggle-btn"
                style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 6px;
                  color:${r.activo?"#DC2626":"#16A34A"}">
                ${r.activo?"🚫 Revocar":"✅ Activar"}</button>
            </td>` : ""}
          </tr>`;
        }).join("")}</tbody>
      </table></div>`;

      if (SA()) {
        div.querySelectorAll(".tok-toggle-btn").forEach(btn => {
          btn.addEventListener("click", async () => {
            const nuevoActivo = btn.dataset.activo !== "true";
            await updateDoc(doc(db,COL_TOKENS,btn.dataset.id), { activo: nuevoActivo });
            _cargarTokens();
          });
        });
      }
    } catch(e) { div.innerHTML = `<div style="padding:16px;color:#DC2626">${esc(e.message)}</div>`; }
  }

  // ── Sub-tab: Webhooks ──
  async function _renderWebhooks() {
    const div = el("api-sub-webhooks-content");
    if (!div) return;
    div.innerHTML = `
      ${SA() ? `
      <div style="border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:16px;background:var(--surface)">
        <div style="font-size:12px;font-weight:700;margin-bottom:12px">Registrar endpoint receptor</div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end">
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:5px">URL DEL ENDPOINT *</label>
            <input class="form-input" id="wh-url" type="url" placeholder="https://app.laboratorio.com/webhook/n10" style="width:100%;font-family:monospace;font-size:11px">
          </div>
          <button id="wh-agregar" style="padding:8px 16px;border-radius:8px;border:none;
            background:#6366F1;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
            Agregar
          </button>
        </div>
        <div style="margin-top:12px">
          <label style="font-size:10px;font-weight:700;color:#64748B;display:block;margin-bottom:8px">EVENTOS A SUSCRIBIR</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${EVENTOS_WH.map(e => `<label style="display:flex;align-items:center;gap:5px;padding:4px 10px;
              border:1px solid var(--border);border-radius:20px;cursor:pointer;font-size:11px">
              <input type="checkbox" id="wh-ev-${e.replace(/\./g,"-")}" style="accent-color:#6366F1">
              ${esc(e)}
            </label>`).join("")}
          </div>
        </div>
      </div>` : ""}
      <div id="wh-body"><div style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</div></div>`;

    if (SA()) {
      el("wh-agregar")?.addEventListener("click", async () => {
        const url = el("wh-url")?.value.trim();
        if (!url || !url.startsWith("http")) { window.toast?.("URL inválida","warn"); return; }
        const eventos = EVENTOS_WH.filter(e => el(`wh-ev-${e.replace(/\./g,"-")}`)?.checked);
        if (!eventos.length) { window.toast?.("Selecciona al menos un evento","warn"); return; }
        const secret = _generarToken(24);
        await addDoc(collection(db, COL_HOOKS), {
          url, eventos, secret, activo: true,
          creadoPor: Sesion.alias, _ts: Date.now()
        });
        window.toast?.("Webhook registrado","success");
        if (el("wh-url")) el("wh-url").value = "";
        _cargarWebhooks();
      });
    }
    _cargarWebhooks();
  }

  async function _cargarWebhooks() {
    const div = el("wh-body");
    if (!div) return;
    try {
      const snap = await getDocs(query(collection(db,COL_HOOKS), orderBy("_ts","desc"), limit(50)));
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!rows.length) {
        div.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-sec);font-size:12px">
          Sin webhooks registrados.</div>`;
        return;
      }
      div.innerHTML = rows.map(r => `
        <div style="border:1px solid var(--border);border-radius:10px;padding:14px;
          margin-bottom:8px;background:var(--surface)">
          <div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
            <div style="flex:1;min-width:0">
              <div style="font-family:monospace;font-size:11px;font-weight:700;word-break:break-all">${esc(r.url)}</div>
              <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
                ${(r.eventos||[]).map(e => `<span style="background:#E0F2FE;color:#0369A1;padding:1px 7px;border-radius:10px;font-size:10px">${esc(e)}</span>`).join("")}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
              <span style="background:${r.activo?"#DCFCE7":"#F1F5F9"};color:${r.activo?"#166534":"#64748B"};
                padding:2px 10px;border-radius:10px;font-size:10px;font-weight:700">${r.activo?"ACTIVO":"INACTIVO"}</span>
              ${SA() ? `<div style="display:flex;gap:4px">
                <button data-id="${esc(r.id)}" data-activo="${r.activo}" class="wh-toggle-btn"
                  style="background:none;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:11px;padding:3px 8px">
                  ${r.activo?"Pausar":"Activar"}</button>
                <button data-id="${esc(r.id)}" class="wh-del-btn"
                  style="background:none;border:1px solid #FECACA;border-radius:6px;cursor:pointer;font-size:11px;padding:3px 8px;color:#DC2626">
                  🗑️</button>
              </div>` : ""}
            </div>
          </div>
          <div style="font-size:10px;color:#94A3B8;margin-top:6px">
            Secret HMAC: <code style="font-family:monospace">${(r.secret||"").slice(0,12)}…</code> · Registrado ${fmt(r._ts)}
          </div>
        </div>`).join("");

      if (SA()) {
        div.querySelectorAll(".wh-toggle-btn").forEach(btn => {
          btn.addEventListener("click", async () => {
            await updateDoc(doc(db,COL_HOOKS,btn.dataset.id), { activo: btn.dataset.activo!=="true" });
            _cargarWebhooks();
          });
        });
        div.querySelectorAll(".wh-del-btn").forEach(btn => {
          btn.addEventListener("click", async () => {
            if (!confirm("¿Eliminar este webhook?")) return;
            await deleteDoc(doc(db,COL_HOOKS,btn.dataset.id));
            _cargarWebhooks();
          });
        });
      }
    } catch(e) { div.innerHTML = `<div style="padding:16px;color:#DC2626">${esc(e.message)}</div>`; }
  }

  // ── Sub-tab: Endpoints disponibles ──
  function _renderEndpoints() {
    const div = el("api-sub-endpoints-content");
    if (!div) return;
    div.innerHTML = `
      <div style="border:1px solid #E0F2FE;border-radius:10px;padding:14px 16px;
        background:#F0F9FF;margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;color:#0369A1;margin-bottom:4px">Base URL</div>
        <code style="font-family:monospace;font-size:12px;color:#0C4A6E">
          https://n10-erp.web.app/api</code>
        <div style="font-size:11px;color:#0369A1;margin-top:6px">
          Autenticación: <code>Authorization: Bearer {token}</code>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${ENDPOINTS.map(ep => `
          <div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;background:var(--surface)">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <div style="display:flex;gap:4px">
                ${ep.metodos.map(m => `<span style="background:${m==="GET"?"#DCFCE7":m==="POST"?"#E0F2FE":"#FEF3C7"};
                  color:${m==="GET"?"#166534":m==="POST"?"#0369A1":"#92400E"};
                  padding:2px 8px;border-radius:5px;font-size:10px;font-weight:800;font-family:monospace">${m}</span>`).join("")}
              </div>
              <code style="font-family:monospace;font-size:12px;font-weight:700;flex:1">${esc(ep.path)}</code>
              <span style="background:${cfg.activo?"#DCFCE7":"#F1F5F9"};color:${cfg.activo?"#166534":"#94A3B8"};
                padding:2px 10px;border-radius:10px;font-size:10px;font-weight:700">
                ${cfg.activo?"DISPONIBLE":"INACTIVO"}</span>
            </div>
            <div style="font-size:11px;color:#64748B;margin-top:4px">${esc(ep.desc)}</div>
          </div>`).join("")}
      </div>`;
  }

  // ── Sub-tab: Log de eventos ──
  async function _renderEventos() {
    const div = el("api-sub-eventos-content");
    if (!div) return;
    div.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-sec)">Cargando eventos…</div>`;
    try {
      const snap = await getDocs(query(collection(db,COL_EVENTS), orderBy("_ts","desc"), limit(100)));
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!rows.length) {
        div.innerHTML = `<div style="padding:32px;text-align:center;color:var(--text-sec);font-size:12px">
          Sin eventos registrados. Los eventos aparecerán aquí cuando la API esté activa.</div>`;
        return;
      }
      div.innerHTML = `<div style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 250px)"><table class="data-table">
        <thead><tr><th>FECHA</th><th>EVENTO</th><th>WEBHOOK</th><th>STATUS</th><th>PAYLOAD</th></tr></thead>
        <tbody>${rows.map(r => {
          const stBg = r.status===200?"#DCFCE7":r.status>=400?"#FEE2E2":"#FEF3C7";
          const stCol= r.status===200?"#166534":r.status>=400?"#991B1B":"#92400E";
          return `<tr>
            <td style="font-size:11px;white-space:nowrap">${fmt(r._ts)}</td>
            <td><span style="background:#E0F2FE;color:#0369A1;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700">${esc(r.evento||"—")}</span></td>
            <td style="font-family:monospace;font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis">${esc(r.webhook||"—")}</td>
            <td><span style="background:${stBg};color:${stCol};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">${r.status||"—"}</span></td>
            <td style="font-size:10px;color:#64748B;max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(JSON.stringify(r.payload||{})).slice(0,60)}…</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`;
    } catch(e) { div.innerHTML = `<div style="padding:16px;color:#DC2626">${esc(e.message)}</div>`; }
  }

  // Render inicial
  _renderTokens();
}

// ── Utilidad: genera token aleatorio ─────────────────────────
function _generarToken(len = 48) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let t = "n10_";
  for (let i = 0; i < len; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}
