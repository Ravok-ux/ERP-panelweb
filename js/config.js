// ══════════════════════════════════════════════════════════════
// config.js — Configuración de tickets térmicos (header + footer)
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const DOC_PATH = "configuracion/tickets";

const DEFAULTS = {
    nombreEmpresa: "NUTRICIÓN DE 10",
    subtitulo:     "Agroquímicos y Nutrición",
    telefono:      "(667) 123-4567",
    sitioWeb:      "nutricionde10.com.mx",
    footerVenta:    "Precios sin IVA. Factura disponible en oficina con este folio.\nGracias por su preferencia.",
    footerAbono:    "Este recibo no cancela la deuda total.\nConserve su comprobante. Exija factura en oficina.",
    footerRemision: "El cliente acepta los productos en buen estado al recibir este comprobante.\nFactura disponible al liquidar el adeudo.",
};

// Campos con maxlength para el contador de caracteres
const CHAR_FIELDS = [
    { id: "cfg-nombre",         max: 40 },
    { id: "cfg-subtitulo",      max: 40 },
    { id: "cfg-telefono",       max: 20 },
    { id: "cfg-sitioweb",       max: 40 },
    { id: "cfg-footer-venta",   max: 200 },
    { id: "cfg-footer-abono",   max: 200 },
    { id: "cfg-footer-remision",max: 200 },
];

function _puedeAcceder() {
    const rol = Sesion.rol;
    return rol === "SUPER_ADMIN" || rol === "GERENTE" || rol === "ADMINISTRADOR";
}

function _html() {
    return `
<div class="cfg-wrap">

  <!-- ── Encabezado del ticket ── -->
  <div class="cfg-card">
    <div class="cfg-card-head">
      <div class="cfg-card-icon">🏢</div>
      <div>
        <div class="cfg-card-title">Encabezado del ticket</div>
        <div class="cfg-card-sub">Se imprime en todos los tipos de ticket</div>
      </div>
    </div>
    <div class="cfg-fields">
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-nombre">Nombre de la empresa</label>
        <input class="cfg-input" id="cfg-nombre" type="text" maxlength="40" placeholder="NUTRICIÓN DE 10">
        <div class="cfg-char-count" id="cnt-cfg-nombre">0 / 40</div>
      </div>
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-subtitulo">Subtítulo / giro</label>
        <input class="cfg-input" id="cfg-subtitulo" type="text" maxlength="40" placeholder="Agroquímicos y Nutrición">
        <div class="cfg-char-count" id="cnt-cfg-subtitulo">0 / 40</div>
      </div>
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-telefono">Teléfono</label>
        <input class="cfg-input" id="cfg-telefono" type="tel" maxlength="20" placeholder="(667) 123-4567">
        <div class="cfg-char-count" id="cnt-cfg-telefono">0 / 20</div>
      </div>
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-sitioweb">Sitio web</label>
        <input class="cfg-input" id="cfg-sitioweb" type="text" maxlength="40" placeholder="nutricionde10.com.mx">
        <div class="cfg-char-count" id="cnt-cfg-sitioweb">0 / 40</div>
      </div>
    </div>
  </div>

  <!-- ── Pie de página por tipo ── -->
  <div class="cfg-card">
    <div class="cfg-card-head">
      <div class="cfg-card-icon">📝</div>
      <div>
        <div class="cfg-card-title">Pie de página por tipo de ticket</div>
        <div class="cfg-card-sub">Cada tipo tiene su propio pie; use saltos de línea para separar renglones</div>
      </div>
    </div>
    <div class="cfg-fields">
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-footer-venta">Ticket de venta / pedido</label>
        <textarea class="cfg-textarea" id="cfg-footer-venta" rows="3" maxlength="200"></textarea>
        <div class="cfg-char-count" id="cnt-cfg-footer-venta">0 / 200</div>
      </div>
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-footer-abono">Recibo de abono</label>
        <textarea class="cfg-textarea" id="cfg-footer-abono" rows="3" maxlength="200"></textarea>
        <div class="cfg-char-count" id="cnt-cfg-footer-abono">0 / 200</div>
      </div>
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-footer-remision">Remisión a crédito</label>
        <textarea class="cfg-textarea" id="cfg-footer-remision" rows="3" maxlength="200"></textarea>
        <div class="cfg-char-count" id="cnt-cfg-footer-remision">0 / 200</div>
      </div>
    </div>
  </div>

  <!-- ── Control operativo ── -->
  <div class="cfg-card" id="ctrl-card">
    <div class="cfg-card-head">
      <div class="cfg-card-icon">🎛️</div>
      <div>
        <div class="cfg-card-title">Control operativo</div>
        <div class="cfg-card-sub">Activa o desactiva módulos para TODOS los usuarios de la app al instante</div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:0">
      ${[
        ["credito",    "💳", "Módulo de crédito",    "Registro de remisiones, abonos y cartera"],
        ["pedidos",    "🛒", "Módulo de pedidos",    "Creación y seguimiento de pedidos de venta"],
        ["devolucion", "↩️", "Devoluciones",         "Registro de devoluciones de producto"],
        ["comisiones", "📊", "Comisiones / tablero", "Acceso al tablero de rendimiento y comisiones"]
      ].map(([key, icon, label, desc], i, arr) => `
        <div style="display:flex;align-items:center;gap:14px;padding:14px 0;
          ${i < arr.length - 1 ? "border-bottom:1px solid var(--border);" : ""}">
          <span style="font-size:20px;width:28px;text-align:center">${icon}</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:500;color:var(--text-primary)">${label}</div>
            <div style="font-size:11px;color:var(--text-secondary);margin-top:1px">${desc}</div>
          </div>
          <label class="ctrl-toggle" title="Activar o desactivar ${label}">
            <input type="checkbox" id="ctrl-${key}" data-key="${key}" checked
              onchange="ControlUI.toggle('${key}', this.checked)">
            <span class="ctrl-slider"></span>
          </label>
        </div>`).join("")}
    </div>
    <div style="margin-top:10px;font-size:10.5px;color:#9CA3AF;line-height:1.5">
      ⚡ Los cambios se aplican en la próxima apertura de la app. La desactivación de un usuario
      activo se aplica en tiempo real. <span id="ctrl-ts" style="color:#6B7280"></span>
    </div>
  </div>

  <!-- ── Alertas automáticas de cobranza ── -->
  <div class="cfg-card" id="cfg-alertas-cobranza-card">
    <div class="cfg-card-head">
      <div class="cfg-card-icon">💸</div>
      <div>
        <div class="cfg-card-title">Alertas automáticas de cobranza</div>
        <div class="cfg-card-sub">Se generan notificaciones diarias a las 09:00 AM</div>
      </div>
    </div>
    <div class="cfg-fields">
      <div class="cfg-toggle-row">
        <label class="cfg-label" for="cfg-alert-activo">Activar alertas de cobranza</label>
        <input type="checkbox" id="cfg-alert-activo">
      </div>
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-alert-aviso">Días de aviso previo al vencimiento</label>
        <input class="cfg-input" id="cfg-alert-aviso" type="number" min="1" max="30" value="3">
      </div>
      <div class="cfg-field-wrap">
        <label class="cfg-label" for="cfg-alert-postvenc">Alertar cuando ya venció hace (días)</label>
        <input class="cfg-input" id="cfg-alert-postvenc" type="number" min="1" max="30" value="1">
      </div>
    </div>
  </div>

  <!-- ── Acciones ── -->
  <div class="cfg-actions">
    <div id="cfg-status" class="cfg-status hidden"></div>
    <button class="cfg-btn-secondary" id="cfg-btn-reset">Restaurar valores iniciales</button>
    <button class="cfg-btn-primary" id="cfg-btn-guardar">Guardar cambios</button>
  </div>

  <!-- ── Vista previa ── -->
  <div class="cfg-preview-card">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div class="cfg-preview-head" style="margin-bottom:0">Vista previa del ticket</div>
      <div class="cfg-preview-tabs">
        <button class="cfg-prev-tab active" data-footer="venta">Venta</button>
        <button class="cfg-prev-tab" data-footer="abono">Abono</button>
        <button class="cfg-prev-tab" data-footer="remision">Remisión</button>
      </div>
    </div>
    <div class="cfg-receipt" id="cfg-preview">
      <div class="cr-brand" id="pr-nombre">NUTRICIÓN DE 10</div>
      <div class="cr-sub" id="pr-subtitulo">Agroquímicos y Nutrición</div>
      <div class="cr-sub" id="pr-telefono">(667) 123-4567</div>
      <div class="cr-sub" id="pr-sitioweb">nutricionde10.com.mx</div>
      <div class="cr-div"></div>
      <div class="cr-footer" id="pr-footer"></div>
    </div>
  </div>

</div>`;
}

const _css = `
.cfg-wrap {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 16px 40px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.cfg-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px 24px;
  box-shadow: var(--shadow);
}
.cfg-card-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 20px;
}
.cfg-card-icon { font-size: 22px; line-height: 1; margin-top: 2px; }
.cfg-card-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.cfg-card-sub { font-size: 12px; color: var(--text-sec); margin-top: 2px; }
.cfg-fields { display: flex; flex-direction: column; gap: 14px; }
.cfg-field-wrap { display: flex; flex-direction: column; gap: 5px; }
.cfg-label { font-size: 12px; color: var(--text-sec); font-weight: 600; }
.cfg-char-count { font-size: 11px; color: var(--text-muted, #6B7280); text-align: right; }
.cfg-char-count.near { color: #D97706; }
.cfg-char-count.full { color: #DC2626; font-weight: 700; }
.cfg-input, .cfg-textarea {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  font-size: 14px;
  color: var(--text-primary);
  font-family: inherit;
  resize: vertical;
}
.cfg-input:focus, .cfg-textarea:focus {
  outline: none;
  border-color: #3B82F6;
  box-shadow: 0 0 0 3px rgba(59,130,246,.14);
}
.cfg-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}
.cfg-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.cfg-status {
  flex: 1;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: var(--radius, 8px);
}
.cfg-status.ok  { background: var(--green-bg); color: #16A34A; }
.cfg-status.err { background: #FEE2E2; color: #DC2626; }
.cfg-status.hidden { display: none; }
.cfg-btn-primary {
  background: var(--green-dark);
  color: #fff;
  border: none;
  border-radius: var(--radius);
  padding: 9px 20px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.cfg-btn-primary:hover { background: var(--green-mid); }
.cfg-btn-secondary {
  background: transparent;
  color: var(--text-sec);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 9px 20px;
  font-size: 13px;
  cursor: pointer;
  margin-left: auto;
}
.cfg-btn-secondary:hover { background: var(--surface-2); }
.cfg-preview-card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px 24px;
}
.cfg-preview-head {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.cfg-preview-tabs {
  display: flex;
  gap: 4px;
}
.cfg-prev-tab {
  padding: 4px 12px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-sec);
  cursor: pointer;
  transition: all .15s;
}
.cfg-prev-tab:hover { background: var(--surface); }
.cfg-prev-tab.active {
  background: #1E3A5F;
  color: #93C5FD;
  border-color: #2563EB;
}
.cfg-receipt {
  width: 220px;
  background: #FAFAF6;
  border: 0.5px solid #CCC;
  border-top: 2px dashed #BBB;
  padding: 10px;
  font-family: 'Courier New', Courier, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: #111;
  margin: 16px auto 0;
}
.cr-brand { font-weight: bold; font-size: 13px; text-align: center; color: #1A5C2E; }
.cr-sub { text-align: center; color: #555; font-size: 10px; }
.cr-div { border-top: 1px dashed #888; margin: 6px 0; }
.cr-footer { font-size: 10px; color: #777; text-align: center; white-space: pre-line; }

/* ── Control operativo toggles (azul, consistente con sistema global) ── */
.ctrl-toggle {
  position: relative; display: inline-block;
  width: 40px; height: 22px; cursor: pointer; flex-shrink: 0;
}
.ctrl-toggle input { opacity: 0 !important; width: 0 !important; height: 0 !important; position: absolute; }
.ctrl-slider {
  position: absolute; inset: 0; border-radius: 22px;
  background: #4B5563; transition: background .2s;
}
.ctrl-slider::before {
  content: ""; position: absolute;
  width: 16px; height: 16px; border-radius: 50%;
  left: 3px; top: 3px; background: #fff; transition: transform .2s;
}
.ctrl-toggle input:checked + .ctrl-slider { background: #2563EB; }
.ctrl-toggle input:checked + .ctrl-slider::before { transform: translateX(18px); }
.ctrl-toggle input:disabled + .ctrl-slider { opacity: .45; cursor: not-allowed; }
`;

// ── Control operativo ─────────────────────────────────────────
const CONTROL_DOC = "configuracion/control";
const FUNC_KEYS   = ["credito", "pedidos", "devolucion", "comisiones"];
let _ctrlUnsub = null;

function _iniciarControlListener() {
  _ctrlUnsub?.();
  const ref = doc(db, ...CONTROL_DOC.split("/"));
  _ctrlUnsub = onSnapshot(ref, snap => {
    const data = snap.exists() ? snap.data() : {};
    const func = data.funcionalidades ?? {};
    FUNC_KEYS.forEach(key => {
      const activo = func[key] !== false;
      const cb = document.getElementById(`ctrl-${key}`);
      if (cb) cb.checked = activo;
    });
    const ts = document.getElementById("ctrl-ts");
    if (ts) {
      ts.textContent = data.actualizadoEn
        ? `Último cambio: ${(data.actualizadoEn.toDate?.() ?? new Date(data.actualizadoEn)).toLocaleString("es-MX")} por ${data.actualizadoPor ?? "–"}`
        : "Sin cambios registrados";
    }
  }, err => console.error("[Control]", err));
}

window.ControlUI = {
  async toggle(key, activo) {
    try {
      await setDoc(doc(db, ...CONTROL_DOC.split("/")), {
        funcionalidades: { [key]: activo },
        actualizadoPor: Sesion.alias,
        actualizadoEn: serverTimestamp()
      }, { merge: true });
    } catch (e) {
      window.toast?.("Error al guardar control: " + e.message, "error");
      const cb = document.getElementById(`ctrl-${key}`);
      if (cb) cb.checked = !activo;
    }
  }
};

// ── Módulo principal ──────────────────────────────────────────
export const ConfigModule = {

    _styleEl: null,
    _previewFooter: "venta",   // tab activo en la vista previa

    mount(container) {
        if (!_puedeAcceder()) {
            container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-secondary)">
                Acceso restringido a administradores.</div>`;
            return;
        }

        if (!this._styleEl) {
            this._styleEl = document.createElement("style");
            this._styleEl.textContent = _css;
            document.head.appendChild(this._styleEl);
        }

        container.innerHTML = _html();
        _iniciarControlListener();
        this._cargarDatos();
        this._bindEventos();
        this._cargarAlertasCobranza();
    },

    async _cargarDatos() {
        try {
            const snap = await getDoc(doc(db, ...DOC_PATH.split("/")));
            const data = snap.exists() ? { ...DEFAULTS, ...snap.data() } : { ...DEFAULTS };
            this._poblarFormulario(data);
            this._actualizarContadores();
            this._actualizarPreview();
        } catch {
            this._poblarFormulario(DEFAULTS);
            this._actualizarContadores();
            this._actualizarPreview();
        }
    },

    _poblarFormulario(data) {
        document.getElementById("cfg-nombre").value         = data.nombreEmpresa ?? "";
        document.getElementById("cfg-subtitulo").value      = data.subtitulo     ?? "";
        document.getElementById("cfg-telefono").value       = data.telefono      ?? "";
        document.getElementById("cfg-sitioweb").value       = data.sitioWeb      ?? "";
        document.getElementById("cfg-footer-venta").value   = data.footerVenta    ?? "";
        document.getElementById("cfg-footer-abono").value   = data.footerAbono   ?? "";
        document.getElementById("cfg-footer-remision").value = data.footerRemision ?? "";
    },

    _leerFormulario() {
        return {
            nombreEmpresa:  document.getElementById("cfg-nombre").value.trim().toUpperCase(),
            subtitulo:      document.getElementById("cfg-subtitulo").value.trim(),
            telefono:       document.getElementById("cfg-telefono").value.trim(),
            sitioWeb:       document.getElementById("cfg-sitioweb").value.trim(),
            footerVenta:    document.getElementById("cfg-footer-venta").value.trim(),
            footerAbono:    document.getElementById("cfg-footer-abono").value.trim(),
            footerRemision: document.getElementById("cfg-footer-remision").value.trim(),
        };
    },

    _actualizarContadores() {
        CHAR_FIELDS.forEach(({ id, max }) => {
            const el  = document.getElementById(id);
            const cnt = document.getElementById(`cnt-${id}`);
            if (!el || !cnt) return;
            const len = el.value.length;
            cnt.textContent = `${len} / ${max}`;
            cnt.className = "cfg-char-count" + (len >= max ? " full" : len >= max * 0.85 ? " near" : "");
        });
    },

    _actualizarPreview() {
        const g = id => document.getElementById(id)?.value || "";
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set("pr-nombre",    g("cfg-nombre").toUpperCase() || " ");
        set("pr-subtitulo", g("cfg-subtitulo") || " ");
        set("pr-telefono",  g("cfg-telefono")  || " ");
        set("pr-sitioweb",  g("cfg-sitioweb")  || " ");

        const footerMap = { venta: "cfg-footer-venta", abono: "cfg-footer-abono", remision: "cfg-footer-remision" };
        set("pr-footer", g(footerMap[this._previewFooter]) || " ");
    },

    _setStatus(msg, tipo) {
        const el = document.getElementById("cfg-status");
        if (!el) return;
        el.textContent = msg;
        el.className = `cfg-status ${tipo}`;
        if (tipo === "ok") setTimeout(() => { el.className = "cfg-status hidden"; }, 3000);
    },

    _bindEventos() {
        // Actualizar preview + contadores en tiempo real
        CHAR_FIELDS.forEach(({ id }) => {
            document.getElementById(id)?.addEventListener("input", () => {
                this._actualizarContadores();
                this._actualizarPreview();
            });
        });

        // Tabs de vista previa
        document.querySelectorAll(".cfg-prev-tab").forEach(tab => {
            tab.addEventListener("click", () => {
                document.querySelectorAll(".cfg-prev-tab").forEach(t => t.classList.remove("active"));
                tab.classList.add("active");
                this._previewFooter = tab.dataset.footer;
                this._actualizarPreview();
            });
        });

        // Restaurar
        document.getElementById("cfg-btn-reset")?.addEventListener("click", async () => {
            if (!await window.modal({ title: "Restaurar valores", message: "¿Restaurar los valores iniciales? Se perderán los cambios no guardados." })) return;
            this._poblarFormulario(DEFAULTS);
            this._actualizarContadores();
            this._actualizarPreview();
        });

        // Guardar (incluye alertas)
        document.getElementById("cfg-btn-guardar")?.addEventListener("click", () => this._guardar());
    },

    async _guardar() {
        const data = this._leerFormulario();

        if (!data.nombreEmpresa) {
            this._setStatus("El nombre de la empresa es obligatorio.", "err");
            return;
        }

        const btn = document.getElementById("cfg-btn-guardar");
        if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }

        try {
            // Guardar configuración de tickets
            await setDoc(doc(db, ...DOC_PATH.split("/")), {
                ...data,
                ultimoEditor:       Sesion.alias,
                fechaActualizacion: Date.now(),
            });

            // Guardar alertas en el mismo flujo
            await this._guardarAlertasInterno();

            this._setStatus("Configuración guardada correctamente.", "ok");
        } catch (e) {
            this._setStatus("Error al guardar. Verifique la conexión.", "err");
            console.error(e);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "Guardar cambios"; }
        }
    },

    async _cargarAlertasCobranza() {
        try {
            const snap = await getDoc(doc(db, "configuracion", "alertas_cobranza"));
            const d = snap.exists() ? snap.data() : {};
            const el = id => document.getElementById(id);
            if (el("cfg-alert-activo"))   el("cfg-alert-activo").checked = d.activo !== false;
            if (el("cfg-alert-aviso"))    el("cfg-alert-aviso").value    = d.diasAviso ?? 3;
            if (el("cfg-alert-postvenc")) el("cfg-alert-postvenc").value = d.diasPostVencimiento ?? 1;
        } catch (e) { console.error("[Config] alertas cobranza:", e); }
    },

    async _guardarAlertasInterno() {
        const activo = document.getElementById("cfg-alert-activo")?.checked ?? true;
        const aviso  = Number(document.getElementById("cfg-alert-aviso")?.value)  || 3;
        const post   = Number(document.getElementById("cfg-alert-postvenc")?.value) || 1;
        await setDoc(doc(db, "configuracion", "alertas_cobranza"), {
            activo, diasAviso: aviso, diasPostVencimiento: post,
            ultimoEditor: Sesion.alias, fechaActualizacion: Date.now()
        });
    },

    destroy() {
        _ctrlUnsub?.();
        _ctrlUnsub = null;
    }
};
