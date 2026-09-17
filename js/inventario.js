// ══════════════════════════════════════════════════════════════
// inventario.js — Stock en tiempo real + movimientos
// Colecciones: inventario / movimientos_stock
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, logAudit, norm } from "./app.js";
import {
  collection, doc, query, where, orderBy, limit,
  onSnapshot, addDoc, updateDoc, setDoc, getDoc, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmtMXN   = v => Number(v || 0).toLocaleString("es-MX", { style:"currency", currency:"MXN" });
const fmtFecha = ts => ts
  ? new Date(typeof ts === "number" ? ts : ts.toMillis?.() ?? ts)
      .toLocaleDateString("es-MX", { day:"2-digit", month:"short", year:"numeric" })
  : "—";

const TABS = [
  { id:"stock",       label:"📦 Stock actual"    },
  { id:"movimientos", label:"🔄 Movimientos"     },
  { id:"conteo",      label:"📋 Conteo físico"   },
  { id:"alertas",     label:"🔔 Alertas mín/máx" },
  { id:"mermas",      label:"🗑️ Mermas"           },
];

let _tab       = "stock";
let _unsubs    = [];   // listeners permanentes (stock, alertas)
let _unsubsMov = [];   // listeners de movimientos (re-creados al filtrar)
let _allRows   = [];

export const InventarioModule = {
  mount(container) {
    if (!_puedeVer()) {
      container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-sec)">
        Acceso restringido.</div>`;
      return;
    }
    container.innerHTML = `
    <div class="mod-wrap">
      <div class="mod-topbar"><h2 class="mod-title">📦 Inventario</h2></div>
      <div class="rh-tabs" id="inv-tabs">
        ${TABS.map((t,i) =>
          `<button class="rh-tab ${i===0?"active":""}" data-tab="${t.id}">${t.label}</button>`
        ).join("")}
      </div>
      <div id="inv-content"></div>
    </div>`;
    document.getElementById("inv-tabs")?.addEventListener("click", e => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      document.querySelectorAll("#inv-tabs .rh-tab")
        .forEach(b => b.classList.toggle("active", b === btn));
      _activarTab(btn.dataset.tab);
    });
    _activarTab("stock");
    return () => this.destroy();
  },
  destroy() {
    _unsubs.forEach(u => u?.()); _unsubs = [];
    _unsubsMov.forEach(u => u?.()); _unsubsMov = [];
    _allRows = [];
    if (window._invEscHandler) {
      document.removeEventListener("keydown", window._invEscHandler);
      delete window._invEscHandler;
    }
  }
};

function _puedeVer()    { return Sesion.esSuperAdmin?.() || ["GERENTE","ADMINISTRADOR","MESA_CONTROL","GERENTE_ZONA","INGENIERO","VENDEDOR"].includes(Sesion.rol); }
function _puedeEditar() { return Sesion.esSuperAdmin?.() || ["GERENTE","ADMINISTRADOR"].includes(Sesion.rol) || Sesion.flags?.PUEDE_AJUSTAR_INVENTARIO; }

function _activarTab(tab) {
  _tab = tab;
  _unsubs.forEach(u => u?.()); _unsubs = [];
  if (tab === "stock")            _montarStock();
  else if (tab === "movimientos") _montarMovimientos();
  else if (tab === "conteo")      _montarConteoFisico();
  else if (tab === "alertas")     _montarAlertas();
  else if (tab === "mermas")      _montarMermas();
}

// ══════════════════════════════════════════════════════════════
// STOCK ACTUAL
// ══════════════════════════════════════════════════════════════
async function _montarStock() {
  document.getElementById("inv-content").innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <input type="text" class="sel-sm" id="inv-buscar" placeholder="Buscar producto o SKU…" style="width:220px">
      <select class="sel-sm" id="inv-filtro-estado">
        <option value="">Todos</option>
        <option value="bajo">⚠️ Bajo mínimo</option>
        <option value="ok">✅ Con stock</option>
        <option value="cero">🔴 Sin stock</option>
      </select>
      ${_puedeEditar() ? `<button class="btn-primary" id="inv-ajuste-btn">+ Ajuste / editar mínimo</button>` : ""}
      <button id="inv-xlsx-btn" style="padding:7px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">⬇️ Excel</button>
    </div>

    <div class="kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left-color:#1D4ED8">
        <div class="kpi-icon">📦</div><div class="kpi-val" id="inv-kpi-total">–</div>
        <div class="kpi-label">Productos</div>
      </div>
      <div class="kpi-card" style="border-left-color:#DC2626">
        <div class="kpi-icon">⚠️</div><div class="kpi-val" id="inv-kpi-bajo">–</div>
        <div class="kpi-label">Bajo mínimo</div>
      </div>
      <div class="kpi-card" style="border-left-color:#16A34A">
        <div class="kpi-icon">💰</div><div class="kpi-val" id="inv-kpi-valor">–</div>
        <div class="kpi-label">Valor estimado</div>
      </div>
    </div>

    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>PRODUCTO</th><th>CÓDIGO N10</th>
          <th style="text-align:right">STOCK</th>
          <th style="text-align:right">MÍNIMO</th>
          <th>UNIDAD</th><th style="text-align:right">COSTO</th>
          <th>ESTADO</th><th>ÚLT. MOV.</th>
          ${_puedeEditar() ? "<th></th>" : ""}
        </tr></thead>
        <tbody id="inv-body">
          ${window.skeleton?.(5, 9) ?? ""}
        </tbody>
      </table>
    </div>

    <!-- Modal ajuste — rediseñado -->
    <div class="modal-overlay hidden" id="inv-modal">
      <div style="background:var(--surface);border:1px solid var(--border);
        border-radius:14px;width:100%;max-width:480px;box-shadow:0 24px 64px rgba(0,0,0,.5);
        overflow:hidden;display:flex;flex-direction:column">

        <!-- Header del modal -->
        <div style="display:flex;align-items:center;gap:12px;padding:18px 20px;
          border-bottom:1px solid var(--border)">
          <div style="width:36px;height:36px;border-radius:9px;background:#6366F122;
            display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">
            📦
          </div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:800;color:var(--text-primary)"
              id="inv-modal-title">Ajuste de inventario</div>
            <div style="font-size:11px;color:#64748B;margin-top:1px">
              Registra entradas, salidas o edita mínimos
            </div>
          </div>
          <button id="inv-modal-close"
            style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);
              background:transparent;cursor:pointer;color:#64748B;font-size:14px;
              display:flex;align-items:center;justify-content:center">✕</button>
        </div>

        <!-- Cuerpo -->
        <div style="padding:18px 20px;display:flex;flex-direction:column;gap:16px;overflow-y:auto;max-height:72vh">

          <!-- Selector de tipo: tarjetas -->
          <div>
            <div style="font-size:10px;font-weight:700;color:#64748B;text-transform:uppercase;
              letter-spacing:.08em;margin-bottom:8px">Tipo de operación</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px" id="inv-tipo-grid">
              ${[
                { v:"AJUSTE_ENTRADA",    ico:"➕", lbl:"Entrada",        desc:"Suma al stock"            },
                { v:"AJUSTE_SALIDA",     ico:"➖", lbl:"Salida",         desc:"Resta al stock"           },
                { v:"AJUSTE_INVENTARIO", ico:"🔁", lbl:"Inventario",     desc:"Reemplaza el stock"       },
                { v:"EDITAR_MINIMO",     ico:"📏", lbl:"Editar mínimo",  desc:"Cambia stock mínimo"      },
              ].map((op, i) => `
                <button type="button" data-inv-tipo="${op.v}"
                  onclick="window._invSelTipo('${op.v}')"
                  style="display:flex;align-items:center;gap:10px;padding:10px 12px;
                    border-radius:8px;cursor:pointer;text-align:left;width:100%;
                    border:1.5px solid ${i===0?"#6366F1":"var(--border)"};
                    background:${i===0?"#6366F114":"transparent"};
                    transition:border-color .15s,background .15s">
                  <span style="font-size:18px;line-height:1">${op.ico}</span>
                  <span>
                    <span style="display:block;font-size:12px;font-weight:700;
                      color:${i===0?"#6366F1":"var(--text-primary)"}" class="inv-tipo-lbl">${op.lbl}</span>
                    <span style="display:block;font-size:10px;color:#64748B">${op.desc}</span>
                  </span>
                </button>`).join("")}
            </div>
            <!-- select oculto que mantiene el valor para el código existente -->
            <select id="inv-tipo" style="display:none">
              <option value="AJUSTE_ENTRADA">AJUSTE_ENTRADA</option>
              <option value="AJUSTE_SALIDA">AJUSTE_SALIDA</option>
              <option value="AJUSTE_INVENTARIO">AJUSTE_INVENTARIO</option>
              <option value="EDITAR_MINIMO">EDITAR_MINIMO</option>
            </select>
          </div>

          <!-- Producto: buscador desde catálogo -->
          <div style="background:var(--surface-2);border:1px solid var(--border);
            border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px">
            <div style="font-size:10px;font-weight:700;color:#64748B;text-transform:uppercase;
              letter-spacing:.08em">Producto del catálogo</div>

            <!-- Buscador autocomplete -->
            <div style="position:relative">
              <label style="font-size:10px;color:#94A3B8;font-weight:600;display:block;margin-bottom:4px">
                Buscar producto
              </label>
              <div style="position:relative">
                <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);
                  font-size:13px;pointer-events:none">🔍</span>
                <input type="text" id="inv-prod-search"
                  placeholder="Escribe para buscar…"
                  autocomplete="off"
                  style="width:100%;padding:8px 10px 8px 32px;border:1px solid var(--border);
                    border-radius:8px;background:var(--surface);color:var(--text-primary);
                    font-size:12px;box-sizing:border-box">
              </div>
              <!-- Lista de resultados -->
              <div id="inv-prod-lista"
                style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;
                  background:var(--surface);border:1px solid var(--border);
                  border-radius:8px;max-height:200px;overflow-y:auto;z-index:999;
                  box-shadow:0 8px 24px rgba(0,0,0,.4)">
              </div>
            </div>

            <!-- Producto seleccionado (chip) -->
            <div id="inv-prod-chip" style="display:none;align-items:center;gap:10px;
              background:#6366F114;border:1px solid #6366F140;border-radius:8px;padding:10px 12px">
              <div style="flex:1">
                <div style="font-size:12px;font-weight:700;color:var(--text-primary)"
                  id="inv-chip-nombre">—</div>
                <div style="font-size:10px;color:#64748B;margin-top:2px;font-family:monospace"
                  id="inv-chip-codigo">—</div>
              </div>
              <button type="button" onclick="window._invLimpiarProducto()"
                style="background:none;border:none;cursor:pointer;color:#64748B;font-size:16px;padding:2px 4px"
                title="Cambiar producto">✕</button>
            </div>

            <!-- Campos ocultos usados por _guardarAjuste -->
            <input type="hidden" id="inv-prod-id">
            <input type="hidden" id="inv-prod-nom">
            <input type="hidden" id="inv-prod-docid">
            <input type="hidden" id="inv-prod-unidad">
          </div>

          <!-- Cantidad + Costo + Motivo -->
          <div style="display:flex;gap:10px">
            <div style="flex:0.7">
              <label style="font-size:10px;color:#94A3B8;font-weight:700;text-transform:uppercase;
                letter-spacing:.06em;display:block;margin-bottom:5px" id="inv-cant-label">
                Cantidad
              </label>
              <input class="form-input" type="number" id="inv-cantidad" min="0" step="1" placeholder="0"
                style="width:100%;font-size:16px;font-weight:700;text-align:center;
                  font-variant-numeric:tabular-nums">
            </div>
            <div style="flex:0.7">
              <label style="font-size:10px;color:#94A3B8;font-weight:700;text-transform:uppercase;
                letter-spacing:.06em;display:block;margin-bottom:5px">
                Costo unitario
              </label>
              <div style="position:relative">
                <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);
                  font-size:12px;color:#64748B;pointer-events:none">$</span>
                <input class="form-input" type="number" id="inv-costo" min="0" step="0.01" placeholder="0.00"
                  style="width:100%;padding-left:20px;font-variant-numeric:tabular-nums">
              </div>
            </div>
            <div style="flex:1.3">
              <label style="font-size:10px;color:#94A3B8;font-weight:700;text-transform:uppercase;
                letter-spacing:.06em;display:block;margin-bottom:5px">
                Motivo / referencia
              </label>
              <input class="form-input" type="text" id="inv-motivo"
                placeholder="Recepción, conteo físico…" style="width:100%">
            </div>
          </div>

          <!-- Sección N10 -->
          <div style="border-radius:10px;border:1.5px solid #6366F140;
            background:linear-gradient(135deg,#6366F108,#818CF808);overflow:hidden">
            <div style="padding:10px 14px;border-bottom:1px solid #6366F130;
              display:flex;align-items:center;gap:8px">
              <span style="font-size:15px">💧</span>
              <div>
                <div style="font-size:11px;font-weight:800;color:#818CF8">Familia Nutrición de 10 (N10)</div>
                <div style="font-size:9.5px;color:#64748B">Requerido para comisiones automáticas por litro</div>
              </div>
            </div>
            <div style="padding:12px 14px;display:flex;gap:10px">
              <div style="flex:1">
                <label style="font-size:10px;color:#94A3B8;font-weight:600;display:block;margin-bottom:8px">
                  Familia
                </label>
                <div style="display:flex;gap:6px">
                  <button type="button" data-fam="" onclick="window._invSelFamilia('')"
                    id="inv-fam-otra"
                    style="flex:1;padding:7px 6px;border-radius:7px;border:1.5px solid #6366F1;
                      background:#6366F114;font-size:11px;font-weight:700;color:#6366F1;cursor:pointer">
                    Otra
                  </button>
                  <button type="button" data-fam="N10" onclick="window._invSelFamilia('N10')"
                    id="inv-fam-n10"
                    style="flex:1;padding:7px 6px;border-radius:7px;border:1.5px solid var(--border);
                      background:transparent;font-size:11px;font-weight:700;color:var(--text-sec);cursor:pointer">
                    💧 N10
                  </button>
                </div>
                <input type="hidden" id="inv-familia">
              </div>
              <div style="flex:1;opacity:.4;transition:opacity .2s" id="inv-litros-wrap">
                <label style="font-size:10px;color:#94A3B8;font-weight:600;display:block;margin-bottom:4px">
                  Litros por unidad
                </label>
                <div style="position:relative">
                  <input class="form-input" type="number" id="inv-litros-u"
                    min="0" step="0.5" placeholder="20"
                    style="width:100%;padding-right:28px">
                  <span style="position:absolute;right:10px;top:50%;transform:translateY(-50%);
                    font-size:10px;color:#64748B;pointer-events:none">L</span>
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- Footer -->
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;
          padding:14px 20px;border-top:1px solid var(--border)">
          <button id="inv-cancel"
            style="padding:8px 18px;border-radius:8px;border:1px solid var(--border);
              background:transparent;color:#94A3B8;font-size:12px;font-weight:600;cursor:pointer">
            Cancelar
          </button>
          <button id="inv-guardar"
            style="padding:8px 22px;border-radius:8px;border:none;
              background:#6366F1;color:#fff;font-size:12px;font-weight:700;cursor:pointer;
              display:flex;align-items:center;gap:6px;transition:background .15s">
            <span>✔</span> Guardar ajuste
          </button>
        </div>
      </div>
    </div>`;

  // Selector de familia (botones toggle)
  window._invSelFamilia = (val) => {
    document.getElementById("inv-familia").value = val;
    const esN10 = val === "N10";
    const btnOtra = document.getElementById("inv-fam-otra");
    const btnN10  = document.getElementById("inv-fam-n10");
    const wrap    = document.getElementById("inv-litros-wrap");
    if (btnOtra) {
      btnOtra.style.borderColor = esN10 ? "var(--border)" : "#6366F1";
      btnOtra.style.background  = esN10 ? "transparent"   : "#6366F114";
      btnOtra.style.color       = esN10 ? "var(--text-sec)": "#6366F1";
    }
    if (btnN10) {
      btnN10.style.borderColor = esN10 ? "#6366F1" : "var(--border)";
      btnN10.style.background  = esN10 ? "#6366F114" : "transparent";
      btnN10.style.color       = esN10 ? "#6366F1" : "var(--text-sec)";
    }
    if (wrap) wrap.style.opacity = esN10 ? "1" : ".4";
  };

  // Selector visual de tipo por tarjetas
  window._invSelTipo = (val) => {
    document.getElementById("inv-tipo").value = val;
    document.querySelectorAll("[data-inv-tipo]").forEach(btn => {
      const sel = btn.dataset.invTipo === val;
      btn.style.borderColor  = sel ? "#6366F1" : "var(--border)";
      btn.style.background   = sel ? "#6366F114" : "transparent";
      btn.querySelector(".inv-tipo-lbl").style.color = sel ? "#6366F1" : "var(--text-primary)";
    });
    const label = document.getElementById("inv-cant-label");
    if (label) label.textContent = val === "EDITAR_MINIMO" ? "Nuevo mínimo" : "Cantidad";
  };

  // ── Autocomplete de producto desde colección "productos" ──────
  let _catalogoCache = [];

  async function _cargarCatalogo() {
    if (_catalogoCache.length) return _catalogoCache;
    const { getDocs, query: q2, collection: col2, orderBy: ob2 } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const snap = await getDocs(q2(col2(db, "productos"), ob2("nombre")));
    _catalogoCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.activo !== false);
    return _catalogoCache;
  }

  function _invSelProducto(prod) {
    document.getElementById("inv-prod-id").value      = prod.codigoN10 || prod.codigo || prod.id;
    document.getElementById("inv-prod-docid").value   = prod.id;
    document.getElementById("inv-prod-nom").value     = prod.nombre;
    document.getElementById("inv-prod-unidad").value  = prod.unidad || "";
    document.getElementById("inv-chip-nombre").textContent = prod.nombre;
    document.getElementById("inv-chip-codigo").textContent = `Código: ${prod.codigoN10 || prod.codigo || prod.id}`;
    document.getElementById("inv-prod-chip").style.display   = "flex";
    document.getElementById("inv-prod-search").style.display = "none";
    document.getElementById("inv-prod-lista").style.display  = "none";
    // Pre-poblar N10 si el producto ya tiene familia definida
    if (prod.familia) {
      window._invSelFamilia?.(prod.familia);
      const litEl = document.getElementById("inv-litros-u");
      if (litEl) litEl.value = prod.litros_por_unidad || "";
    }
  }

  window._invLimpiarProducto = () => {
    document.getElementById("inv-prod-id").value      = "";
    document.getElementById("inv-prod-docid").value   = "";
    document.getElementById("inv-prod-nom").value     = "";
    document.getElementById("inv-prod-unidad").value  = "";
    document.getElementById("inv-prod-chip").style.display   = "none";
    document.getElementById("inv-prod-search").style.display = "";
    document.getElementById("inv-prod-search").value = "";
    document.getElementById("inv-prod-search").focus();
  };

  const searchEl = document.getElementById("inv-prod-search");
  const listaEl  = document.getElementById("inv-prod-lista");

  searchEl?.addEventListener("focus", async () => {
    await _cargarCatalogo();
    _renderLista(searchEl.value);
  });

  searchEl?.addEventListener("input", () => _renderLista(searchEl.value));

  document.addEventListener("click", e => {
    if (!listaEl?.contains(e.target) && e.target !== searchEl)
      listaEl && (listaEl.style.display = "none");
  });

  function _renderLista(term) {
    if (!listaEl) return;
    const t = norm(term);
    const matches = _catalogoCache.filter(p =>
      !t ||
      norm(p.nombre).includes(t) ||
      norm(p.codigoN10).includes(t) ||
      norm(p.codigo).includes(t) ||
      norm(p.categoria).includes(t)
    ).slice(0, 40);

    if (!matches.length) {
      listaEl.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:#64748B;text-align:center">
        Sin resultados para "${esc(term)}"</div>`;
      listaEl.style.display = "block";
      return;
    }

    listaEl.innerHTML = matches.map(p => {
      const n10 = p.familia === "N10"
        ? `<span style="font-size:9px;background:#6366F122;color:#818CF8;border-radius:4px;
            padding:1px 5px;margin-left:4px;font-weight:700">N10</span>` : "";
      return `
        <div data-prod-idx="${_catalogoCache.indexOf(p)}"
          style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border);
            display:flex;align-items:center;gap:10px;transition:background .1s"
          onmouseenter="this.style.background='#6366F110'"
          onmouseleave="this.style.background='transparent'">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;color:var(--text-primary);
              white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${esc(p.nombre)}${n10}
            </div>
            <div style="font-size:10px;color:#64748B;margin-top:1px">
              ${(p.codigoN10||p.codigo) ? `<span style="font-family:monospace">${esc(p.codigoN10||p.codigo)}</span>` : ""}
              ${p.categoria ? ` · ${esc(p.categoria)}` : ""}
              ${(p.precioBase || p.precio_base) ? ` · $${Number(p.precioBase ?? p.precio_base).toLocaleString("es-MX")}` : ""}
            </div>
          </div>
        </div>`;
    }).join("");

    listaEl.querySelectorAll("[data-prod-idx]").forEach(el => {
      el.addEventListener("click", () => {
        const prod = _catalogoCache[parseInt(el.dataset.prodIdx)];
        if (prod) _invSelProducto(prod);
      });
    });

    listaEl.style.display = "block";
  }

  // ── Modal lifecycle ───────────────────────────────────────────
  const cerrarModal = () => {
    document.getElementById("inv-modal")?.classList.add("hidden");
    // Resetear buscador
    window._invLimpiarProducto?.();
    document.getElementById("inv-cantidad").value = "";
    document.getElementById("inv-costo").value    = "";
    document.getElementById("inv-motivo").value   = "";
    window._invSelFamilia?.("");
    document.getElementById("inv-litros-u").value = "";
  };

  document.getElementById("inv-ajuste-btn")?.addEventListener("click", async () => {
    document.getElementById("inv-modal-title").textContent = "Ajuste de inventario";
    window._invSelTipo("AJUSTE_ENTRADA");
    document.getElementById("inv-modal")?.classList.remove("hidden");
    // Precarga catálogo en background para que el buscador sea inmediato
    _cargarCatalogo();
  });
  document.getElementById("inv-modal-close")?.addEventListener("click", cerrarModal);
  document.getElementById("inv-cancel")?.addEventListener("click", cerrarModal);
  document.getElementById("inv-guardar")?.addEventListener("click", _guardarAjuste);
  document.getElementById("inv-modal")?.addEventListener("click", e => {
    if (e.target === document.getElementById("inv-modal")) cerrarModal();
  });
  window._invEscHandler = e => {
    if (e.key === "Escape" && !document.getElementById("inv-modal")?.classList.contains("hidden")) cerrarModal();
  };
  document.addEventListener("keydown", window._invEscHandler);

  const _filtrar = () => {
    const buscar = norm(document.getElementById("inv-buscar")?.value || "");
    const estado = document.getElementById("inv-filtro-estado")?.value || "";
    let rows = _allRows;
    if (buscar) rows = rows.filter(r =>
      norm(r.nombre).includes(buscar) ||
      norm(r.sku).includes(buscar) ||
      norm(r.codigoN10).includes(buscar));
    if (estado === "bajo")  rows = rows.filter(r => r.stockActual > 0 && r.stockActual <= (r.stockMinimo||0));
    if (estado === "ok")    rows = rows.filter(r => r.stockActual > (r.stockMinimo||0));
    if (estado === "cero")  rows = rows.filter(r => (r.stockActual||0) <= 0);
    _renderStock(rows);
  };
  document.getElementById("inv-buscar")?.addEventListener("input", _filtrar);
  document.getElementById("inv-filtro-estado")?.addEventListener("change", _filtrar);
  document.getElementById("inv-xlsx-btn")?.addEventListener("click", () => _exportXlsx(_allRows));

  // Cargar catálogo de unidades y costo_base ANTES del snapshot
  const _prodUnidadMap   = {}; // codigoN10 → unidad
  const _prodUnidadByNom = {}; // norm(nombre) → unidad  (fallback cuando falta codigoN10)
  const _prodCostoMap    = {}; // codigoN10 → costo_base
  const _prodCostoByNom  = {}; // norm(nombre) → costo_base
  try {
    const prodSnap = await getDocs(collection(db, "productos"));
    prodSnap.docs.forEach(d => {
      const p = d.data();
      if (p.unidad) {
        if (p.codigoN10) _prodUnidadMap[p.codigoN10] = p.unidad;
        if (p.nombre)    _prodUnidadByNom[norm(p.nombre)] = p.unidad;
      }
      const cb = p.costo_base || p.costoBase || 0;
      if (cb > 0) {
        if (p.codigoN10) _prodCostoMap[p.codigoN10] = cb;
        if (p.nombre)    _prodCostoByNom[norm(p.nombre)] = cb;
      }
    });
  } catch (_) {}

  const q = query(collection(db, "inventario"), orderBy("nombre"), limit(500));
  _unsubs.push(onSnapshot(q, snap => {
    _allRows = snap.docs.map(d => {
      const data = d.data();
      data.unidad = _prodUnidadMap[d.id]
        || _prodUnidadMap[data.codigoN10]
        || _prodUnidadByNom[norm(data.nombre || "")]
        || data.unidad || "";
      // Usar costo_base del catálogo si el doc de inventario no tiene costo propio
      if (!(data.costo > 0)) {
        data.costo = _prodCostoMap[d.id]
          || _prodCostoMap[data.codigoN10]
          || _prodCostoByNom[norm(data.nombre || "")]
          || 0;
      }
      return { id: d.id, ...data };
    });
    _filtrar();
  }, err => console.error("[Inventario]", err)));
}

function _renderStock(rows) {
  const bajo  = rows.filter(r => (r.stockActual||0) > 0 && (r.stockActual||0) <= (r.stockMinimo||0));
  const valor = rows.reduce((s,r) => s + (r.stockActual||0)*(r.costo||0), 0);
  const el = id => document.getElementById(id);
  if (el("inv-kpi-total")) el("inv-kpi-total").textContent = rows.length;
  if (el("inv-kpi-bajo"))  el("inv-kpi-bajo").textContent  = bajo.length;
  if (el("inv-kpi-valor")) el("inv-kpi-valor").textContent = fmtMXN(valor);

  const tbody = document.getElementById("inv-body");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:32px;text-align:center;color:var(--text-sec)">
      Sin productos con stock registrado. Usa <strong>+ Ajuste / editar mínimo</strong> para agregar el primero.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const stock = r.stockActual ?? 0;
    const min   = r.stockMinimo ?? 0;
    const sinStock  = stock <= 0;
    const bajoMin   = !sinStock && stock <= min && min > 0;
    const color = sinStock ? "#DC2626" : bajoMin ? "#D97706" : "#16A34A";
    const pct   = min > 0 ? Math.min(100, Math.round(stock/min*100)) : 100;
    const badge = sinStock
      ? `<span class="badge badge-red">SIN STOCK</span>`
      : bajoMin
      ? `<span class="badge badge-amber">BAJO MÍN</span>`
      : `<span class="badge" style="background:#DCFCE7;color:#15803D">OK</span>`;
    const rowBg = sinStock ? "background:rgba(220,38,38,.04)" : bajoMin ? "background:rgba(217,119,6,.03)" : "";
    const editBtn = _puedeEditar()
      ? `<button class="btn-sm btn-outline inv-edit-btn"
           data-id="${esc(r.id)}" data-nom="${esc(r.nombre||"")}"
           data-stock="${stock}" data-min="${min}">✏️</button>`
      : "";
    return `<tr style="${rowBg}">
      <td style="font-weight:700">${esc(r.nombre||"–")}</td>
      <td style="font-size:11px;color:var(--text-sec);font-family:monospace">${esc(r.codigoN10||r.id||"–")}</td>
      <td style="text-align:right;font-weight:800;font-size:15px;color:${color}">${stock}</td>
      <td style="text-align:right;color:var(--text-sec)">${min}</td>
      <td style="font-size:12px">${esc(r.unidad||"–")}</td>
      <td style="text-align:right;font-size:12px">${fmtMXN(r.costo)}</td>
      <td>
        ${badge}
        <div style="margin-top:4px;height:5px;border-radius:3px;background:var(--border)">
          <div style="height:5px;border-radius:3px;background:${color};width:${pct}%;max-width:100%;transition:width .3s"></div>
        </div>
      </td>
      <td style="font-size:11px;color:var(--text-sec);white-space:nowrap">${fmtFecha(r._ts)}</td>
      ${_puedeEditar() ? `<td>${editBtn}</td>` : ""}
    </tr>`;
  }).join("");

  tbody.querySelectorAll(".inv-edit-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const { id, nom } = btn.dataset;
      document.getElementById("inv-modal-title").textContent = `Editar: ${nom}`;
      window._invSelTipo?.("AJUSTE_ENTRADA");

      // Mostrar chip del producto (fijo, el user no puede cambiarlo aquí)
      document.getElementById("inv-prod-id").value  = id;
      document.getElementById("inv-prod-nom").value = nom;
      document.getElementById("inv-chip-nombre").textContent = nom;
      document.getElementById("inv-chip-codigo").textContent = `ID: ${id}`;
      document.getElementById("inv-prod-chip").style.display   = "flex";
      document.getElementById("inv-prod-search").style.display = "none";
      // Poblar docid buscando en productos por codigoN10 o codigo
      try {
        const { getDocs: gdD, query: qD, collection: colD, where: wD } =
          await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        let docIdProd = "";
        const snap1 = await gdD(qD(colD(db, "productos"), wD("codigoN10", "==", id))).catch(() => null);
        if (snap1 && !snap1.empty) { docIdProd = snap1.docs[0].id; }
        if (!docIdProd) {
          const snap2 = await gdD(qD(colD(db, "productos"), wD("codigo", "==", id))).catch(() => null);
          if (snap2 && !snap2.empty) docIdProd = snap2.docs[0].id;
        }
        document.getElementById("inv-prod-docid").value = docIdProd;
      } catch { document.getElementById("inv-prod-docid").value = ""; }

      // Pre-poblar campos N10 y costo desde Firestore
      try {
        const snap = await getDoc(doc(db, "inventario", id));
        if (snap.exists()) {
          const d = snap.data();
          const famEl   = document.getElementById("inv-familia");
          const litEl   = document.getElementById("inv-litros-u");
          const wrap    = document.getElementById("inv-litros-wrap");
          const costoEl = document.getElementById("inv-costo");
          if (famEl)   famEl.value = d.familia || "";
          if (litEl)   litEl.value = d.litros_por_unidad || "";
          if (wrap)    wrap.style.opacity = d.familia === "N10" ? "1" : ".4";
          if (costoEl) costoEl.value = d.costo > 0 ? d.costo : "";
        }
      } catch { /* no bloquear si falla */ }
      document.getElementById("inv-modal")?.classList.remove("hidden");
    });
  });
}

async function _guardarAjuste() {
  const tipo       = document.getElementById("inv-tipo")?.value;
  const prodId     = document.getElementById("inv-prod-id")?.value.trim();
  const prodDocId  = document.getElementById("inv-prod-docid")?.value.trim();
  const prodNom    = document.getElementById("inv-prod-nom")?.value.trim();
  const prodUnidad = document.getElementById("inv-prod-unidad")?.value.trim() || "";
  const cant       = parseFloat(document.getElementById("inv-cantidad")?.value || "0");
  const costo      = parseFloat(document.getElementById("inv-costo")?.value    || "0") || 0;
  const motivo     = document.getElementById("inv-motivo")?.value.trim();
  const familia    = document.getElementById("inv-familia")?.value || "";
  const litrosU    = parseFloat(document.getElementById("inv-litros-u")?.value || "0");

  if (!prodId || !prodNom) { window.toast?.("Selecciona un producto del catálogo", "error"); return; }
  if (cant < 0) { window.toast?.("La cantidad no puede ser negativa", "error"); return; }

  const n10Meta = familia === "N10" ? { familia: "N10", litros_por_unidad: litrosU || 0 }
                                    : { familia: familia || null, litros_por_unidad: 0 };

  const btn = document.getElementById("inv-guardar");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    const invRef = doc(db, "inventario", prodId);
    const snap   = await getDoc(invRef);
    const stockAntes = snap.exists() ? (snap.data().stockActual ?? 0) : 0;
    let stockDespues = cant;

    if (tipo === "EDITAR_MINIMO") {
      await setDoc(invRef, { nombre: prodNom, stockMinimo: cant, ...n10Meta, _ts: Date.now() }, { merge: true });
      window.toast?.("Mínimo actualizado", "success");
    } else {
      if (tipo === "AJUSTE_ENTRADA")    stockDespues = stockAntes + cant;
      else if (tipo === "AJUSTE_SALIDA") stockDespues = Math.max(0, stockAntes - cant);

      await addDoc(collection(db, "movimientos_stock"), {
        productoId: prodId, nombreProducto: prodNom, tipo, cantidad: cant,
        stockAntes, stockDespues, motivo,
        quienRegistro: Sesion.alias, _ts: Date.now()
      });
      const unidadData = prodUnidad ? { unidad: prodUnidad } : {};
      const costoData  = costo > 0  ? { costo }            : {};
      await setDoc(invRef, { nombre: prodNom, stockActual: stockDespues, ...unidadData, ...costoData, ...n10Meta, _ts: Date.now() }, { merge: true });
      // Sincronizar `productos`: stock (leído por productos-control) y stockActual (leído por el APK)
      // prodDocId es el Firestore doc ID real; si no está (ajuste desde tabla), buscar por codigoN10
      let docIdParaProductos = prodDocId;
      if (!docIdParaProductos) {
        const { getDocs, query: q2, collection: col2, where: w2 } =
          await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const snap2 = await getDocs(q2(col2(db, "productos"), w2("codigoN10", "==", prodId))).catch(() => null);
        if (snap2 && !snap2.empty) docIdParaProductos = snap2.docs[0].id;
      }
      if (!docIdParaProductos) {
        // Fallback: buscar por campo 'codigo' (campo estándar en productos) si codigoN10 no encontró
        const { getDocs: gd3, query: q3, collection: col3, where: w3 } =
          await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const snap3 = await gd3(q3(col3(db, "productos"), w3("codigo", "==", prodId))).catch(() => null);
        if (snap3 && !snap3.empty) docIdParaProductos = snap3.docs[0].id;
      }
      if (docIdParaProductos) {
        await updateDoc(doc(db, "productos", docIdParaProductos), { stock: stockDespues, stockActual: stockDespues, _ts: Date.now() })
          .catch(e => { console.error("[inv] Error al actualizar productos:", e.message); window.toast?.("Aviso: stock guardado en inventario pero no en catálogo: " + e.message, "warning"); });
      }
      logAudit(tipo === "AJUSTE_ENTRADA" ? "STOCK_ENTRADA" : tipo === "AJUSTE_SALIDA" ? "STOCK_SALIDA" : "AJUSTE_INVENTARIO",
        { productoId: prodId, productoNombre: prodNom, cantidad: cant, stockAntes, stockDespues, motivo });
      window.toast?.("Ajuste guardado", "success");
    }
    document.getElementById("inv-modal")?.classList.add("hidden");
    document.getElementById("inv-prod-id").disabled  = false;
    document.getElementById("inv-prod-nom").disabled = false;
    document.getElementById("inv-cantidad").value  = "";
    document.getElementById("inv-costo").value     = "";
    document.getElementById("inv-motivo").value    = "";
    window._invSelFamilia?.("");
    document.getElementById("inv-litros-u").value  = "";
  } catch(e) { window.toast?.("Error: " + e.message, "error"); }
  finally { btn.disabled = false; btn.textContent = "Guardar"; }
}

// ══════════════════════════════════════════════════════════════
// MOVIMIENTOS
// ══════════════════════════════════════════════════════════════
function _montarMovimientos() {
  const hoy   = new Date().toISOString().slice(0,10);
  const hace7 = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
  document.getElementById("inv-content").innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <select class="sel-sm" id="mov-tipo">
        <option value="">Todos los tipos</option>
        <option value="SALIDA">🔴 Salida (pedido)</option>
        <option value="ENTRADA">🟢 Entrada</option>
        <option value="DEVOLUCION">🔵 Devolución</option>
        <option value="AJUSTE_ENTRADA">➕ Ajuste entrada</option>
        <option value="AJUSTE_SALIDA">➖ Ajuste salida</option>
        <option value="AJUSTE_INVENTARIO">🔁 Inventario físico</option>
      </select>
      <span style="font-size:11px;color:var(--text-sec)">Desde</span>
      <input type="date" class="sel-sm" id="mov-desde" value="${hace7}">
      <span style="font-size:11px;color:var(--text-sec)">Hasta</span>
      <input type="date" class="sel-sm" id="mov-hasta" value="${hoy}">
      <button class="btn-primary" id="mov-filtrar">Filtrar</button>
    </div>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>FECHA</th><th>TIPO</th><th>PRODUCTO</th>
          <th style="text-align:right">CANT.</th>
          <th style="text-align:right">ANTES</th>
          <th style="text-align:right">DESPUÉS</th>
          <th>MOTIVO / REF.</th><th>REGISTRÓ</th>
        </tr></thead>
        <tbody id="mov-body">
          <tr><td colspan="8" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
        </tbody>
      </table>
    </div>`;

  document.getElementById("mov-filtrar")?.addEventListener("click", _escucharMovimientos);
  _escucharMovimientos();
}

function _escucharMovimientos() {
  _unsubsMov.forEach(u => u?.()); _unsubsMov = [];
  const tipo  = document.getElementById("mov-tipo")?.value || "";
  const desde = document.getElementById("mov-desde")?.value;
  const hasta = document.getElementById("mov-hasta")?.value;
  const [dy,dm,dd] = (desde||"").split("-").map(Number);
  const [hy,hm,hd] = (hasta||"").split("-").map(Number);
  const desdeTs = desde ? new Date(dy,dm-1,dd,0,0,0).getTime() : Date.now()-7*86400000;
  const hastaTs = hasta ? new Date(hy,hm-1,hd,23,59,59).getTime() : Date.now();

  let constraints = [where("_ts",">=",desdeTs), where("_ts","<=",hastaTs),
    orderBy("_ts","desc"), limit(500)];
  if (tipo) constraints = [where("tipo","==",tipo), ...constraints];
  const q = query(collection(db, "movimientos_stock"), ...constraints);

  const tbody = document.getElementById("mov-body");
  const ICON = { SALIDA:"🔴", ENTRADA:"🟢", ENTRADA_ALMACEN:"🟢", DEVOLUCION:"🔵",
    AJUSTE_ENTRADA:"➕", AJUSTE_SALIDA:"➖", AJUSTE_INVENTARIO:"🔁" };

  _unsubsMov.push(onSnapshot(q, snap => {
    if (!tbody) return;
    const rows = snap.docs.map(d => d.data());
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="padding:32px;text-align:center;color:var(--text-sec)">Sin movimientos</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => `<tr>
      <td style="font-size:11px;color:var(--text-sec);white-space:nowrap">${fmtFecha(r._ts)}</td>
      <td style="font-size:12px">${ICON[r.tipo]||"•"} ${esc(r.tipo||"–")}</td>
      <td style="font-weight:600">${esc(r.nombreProducto||r.productoId||"–")}</td>
      <td style="text-align:right;font-weight:700">${r.cantidad??""}</td>
      <td style="text-align:right;color:var(--text-sec)">${r.stockAntes??""}</td>
      <td style="text-align:right;font-weight:700">${r.stockDespues??""}</td>
      <td style="font-size:11px;color:var(--text-sec);max-width:200px">${esc(r.motivo||r.folio||r.pedidoId||"–")}</td>
      <td style="font-size:11px">${esc(r.quienRegistro||"sistema")}</td>
    </tr>`).join("");
  }, err => console.error("[Mov]", err)));
}

function _exportXlsx(rows) {
  if (!rows.length) { window.toast?.("Sin datos para exportar","warning"); return; }
  const h = ["Producto","SKU","Stock actual","Stock mínimo","Unidad","Costo unitario","Valor total","Actualizado"];
  const d = rows.map(r => [r.nombre||"",r.sku||"",r.stockActual??0,r.stockMinimo??0,
    r.unidad||"",r.costo||0,(r.stockActual||0)*(r.costo||0),fmtFecha(r._ts)]);
  const ws = XLSX.utils.aoa_to_sheet([h, ...d]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Inventario");
  XLSX.writeFile(wb, `N10-inventario-${new Date().toISOString().slice(0,10)}.xlsx`);
  window.toast?.("Exportando Excel…","info");
}

// ══════════════════════════════════════════════════════════════
// CONTEO FÍSICO CÍCLICO  (Alto / 73)
// Colección: conteos_fisicos
// ══════════════════════════════════════════════════════════════
function _montarConteoFisico() {
  if (!_puedeEditar()) {
    document.getElementById("inv-content").innerHTML =
      `<div style="padding:40px;text-align:center;color:var(--text-sec)">Solo GERENTE o ADMINISTRADOR pueden gestionar conteos.</div>`;
    return;
  }
  document.getElementById("inv-content").innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
      <h3 style="margin:0;font-size:15px;font-weight:800;flex:1">📋 Conteo físico cíclico</h3>
      <button class="btn-primary" id="cnt-nuevo-btn">+ Nuevo conteo</button>
    </div>

    <!-- Vista: lista de conteos o form de conteo activo -->
    <div id="cnt-vista-lista">
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>
            <th>FECHA</th><th>ALMACÉN</th><th>ESTADO</th><th>PRODUCTOS</th>
            <th>DIFERENCIAS</th><th>REGISTRÓ</th><th></th>
          </tr></thead>
          <tbody id="cnt-lista-body">
            <tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Form conteo activo (oculto al inicio) -->
    <div id="cnt-vista-form" style="display:none">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <button id="cnt-back-btn" style="padding:6px 12px;border:1px solid var(--border);
          background:transparent;border-radius:7px;cursor:pointer;font-size:12px;color:var(--text-sec)">
          ← Volver
        </button>
        <div style="flex:1;min-width:160px">
          <div style="font-size:13px;font-weight:800" id="cnt-form-titulo">Conteo — </div>
          <div style="font-size:11px;color:var(--text-sec)">Ingresa el conteo real de cada producto y aplica los ajustes</div>
        </div>
        <select id="cnt-almacen" style="padding:6px 10px;border:1px solid var(--border);border-radius:8px;
          background:var(--surface);color:var(--text-primary);font-size:12px;font-weight:600;min-width:180px">
          <option value="CENTRAL">🏭 Almacén central</option>
        </select>
        <button id="cnt-aplicar-btn" style="padding:8px 18px;border-radius:8px;border:none;
          background:#16A34A;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
          ✔ Cerrar y aplicar ajustes
        </button>
      </div>

      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <input id="cnt-buscar" type="text" placeholder="🔍 Buscar producto…"
          style="flex:1;min-width:200px;padding:7px 12px;border:1px solid var(--border);
            border-radius:8px;background:var(--surface);color:var(--text-primary);font-size:13px">
        <div style="font-size:12px;color:var(--text-sec);white-space:nowrap">
          <strong style="color:var(--text-primary)" id="cnt-resumen-difs">—</strong> con diferencia ·
          <strong style="color:var(--text-primary)" id="cnt-resumen-vis">—</strong> visibles
        </div>
      </div>

      <div style="overflow-x:auto">
        <table class="data-table">
          <thead><tr>
            <th>PRODUCTO</th><th style="text-align:right">STOCK SISTEMA</th>
            <th style="text-align:right;width:130px">CONTEO REAL</th>
            <th style="text-align:right">DIFERENCIA</th><th>ESTADO</th>
          </tr></thead>
          <tbody id="cnt-form-body"></tbody>
        </table>
      </div>
    </div>`;

  // ── Historial de conteos ───────────────────────────────────
  let _conteoActivo = null;
  let _conteoItems  = [];   // [{productoId, nombre, stockSistema, stockConteo}]

  const { getDocs: gd2, query: q2, collection: col2, orderBy: ob2, limit: lim2, addDoc: ad2, doc: dc2, updateDoc: upd2 } =
    { getDocs: null, query: null, collection: null, orderBy: null, limit: null, addDoc: null, doc: null, updateDoc: null };

  async function _cargarHistorial() {
    const { getDocs, query: qry, collection: colRef, orderBy: oby, limit: lmt } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const tbody = document.getElementById("cnt-lista-body");
    if (!tbody) return;
    try {
      const snap = await getDocs(qry(colRef(db, "conteos_fisicos"), oby("_ts","desc"), lmt(30)));
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!docs.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--text-sec)">
          Sin conteos registrados. Crea el primero con <strong>+ Nuevo conteo</strong>.</td></tr>`;
        return;
      }
      tbody.innerHTML = docs.map(c => {
        const prods   = c.productos?.length ?? 0;
        const difs    = (c.productos||[]).filter(p => p.diferencia !== 0).length;
        const estado  = c.estado === "CERRADO"
          ? `<span class="badge" style="background:#DCFCE7;color:#15803D">CERRADO</span>`
          : `<span class="badge badge-amber">ABIERTO</span>`;
        const accion  = c.estado === "ABIERTO"
          ? `<button class="btn-sm btn-outline cnt-open-btn" data-id="${esc(c.id)}">Continuar ▶</button>`
          : `<button class="btn-sm cnt-ver-btn" style="padding:4px 8px;font-size:10px;background:var(--surface-2);
              border:1px solid var(--border);border-radius:5px;cursor:pointer"
              data-id="${esc(c.id)}">Ver detalle</button>`;
        const almLabel = !c.almacen || c.almacen === "CENTRAL" ? "🏭 Central"
          : c.almacen.startsWith("ING_") ? `👷 ${c.almacenNombre || c.almacen.replace("ING_","")}`
          : c.almacen;
        const adeudoBadge = c.adeudoId
          ? `<span title="Generó nota de adeudo en Mi RH"
               style="display:inline-flex;align-items:center;gap:3px;font-size:10px;
                 background:#FEE2E2;color:#991B1B;border-radius:4px;padding:2px 6px;margin-left:6px;font-weight:700">
               ⚠️ ADEUDO
             </span>`
          : "";
        return `<tr>
          <td style="font-size:11px;white-space:nowrap">${fmtFecha(c._ts)}</td>
          <td style="font-size:11px">${almLabel}${adeudoBadge}</td>
          <td>${estado}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${prods}</td>
          <td style="text-align:right;font-weight:700;color:${difs>0?"#D97706":"#16A34A"}">${difs}</td>
          <td style="font-size:11px;color:var(--text-sec)">${esc(c.quienCreo||"–")}</td>
          <td>${accion}</td>
        </tr>`;
      }).join("");
      tbody.querySelectorAll(".cnt-open-btn,.cnt-ver-btn").forEach(btn => {
        btn.addEventListener("click", () => _abrirConteo(docs.find(d => d.id === btn.dataset.id)));
      });
    } catch(e) { console.error("[Conteo]", e); }
  }
  _cargarHistorial();

  // ── Nuevo conteo ───────────────────────────────────────────
  document.getElementById("cnt-nuevo-btn")?.addEventListener("click", async () => {
    const { addDoc: ad, collection: colRef, doc: dc, getDoc: gdc } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

    const selEl = document.getElementById("cnt-almacen");
    const almacen = selEl?.value || "CENTRAL";
    const almacenNombre = selEl?.options[selEl.selectedIndex]?.text?.replace(/^[🏭👷]\s*/u,"") || "Central";
    const ingUid = almacen.startsWith("ING_") ? almacen.replace("ING_","") : null;

    let productos;
    if (ingUid) {
      // Leer stock personal del ingeniero
      try {
        const ingDoc = await gdc(dc(db, "stock_ingenieros", ingUid));
        const items = ingDoc.exists() ? (ingDoc.data().items || {}) : {};
        productos = Object.entries(items).map(([productoId, d]) => ({
          productoId, nombre: d.nombre || productoId,
          stockSistema: d.cantidad ?? 0, stockConteo: null, diferencia: 0
        }));
        if (!productos.length) { window.toast?.("Este ingeniero no tiene stock registrado","warning"); return; }
      } catch(e) { window.toast?.("Error leyendo stock del ingeniero: " + e.message,"error"); return; }
    } else {
      if (!_allRows.length) { window.toast?.("Carga el tab Stock primero","warning"); return; }
      productos = _allRows.map(r => ({
        productoId: r.id, nombre: r.nombre||"",
        stockSistema: r.stockActual ?? 0, stockConteo: null, diferencia: 0
      }));
    }

    try {
      const ref = await ad(colRef(db, "conteos_fisicos"), {
        estado: "ABIERTO", productos, almacen, almacenNombre,
        ingUid: ingUid || null,
        quienCreo: Sesion.alias, _ts: Date.now()
      });
      logAudit("CONTEO_CREADO", { conteoId: ref.id, productos: productos.length, almacen });
      _conteoActivo = { id: ref.id, estado:"ABIERTO", productos, almacen, almacenNombre, ingUid: ingUid||null, quienCreo: Sesion.alias, _ts: Date.now() };
      _conteoItems  = productos.map(p => ({ ...p }));
      _renderFormConteo(false);
    } catch(e) { window.toast?.("Error: " + e.message,"error"); }
  });

  function _abrirConteo(c) {
    _conteoActivo = c;
    _conteoItems  = (c.productos||[]).map(p => ({ ...p }));
    _renderFormConteo(c.estado === "CERRADO");
  }

  function _renderFormConteo(soloLectura) {
    document.getElementById("cnt-vista-lista").style.display = "none";
    document.getElementById("cnt-vista-form").style.display  = "";
    document.getElementById("cnt-form-titulo").textContent =
      `Conteo — ${fmtFecha(_conteoActivo._ts)} ${soloLectura?"(cerrado)":""}`;
    document.getElementById("cnt-aplicar-btn").style.display = soloLectura ? "none" : "";

    // Buscador: filtrar filas en tiempo real
    const buscarEl = document.getElementById("cnt-buscar");
    if (buscarEl) {
      buscarEl.value = "";
      buscarEl.oninput = () => {
        const q = norm(buscarEl.value);
        document.querySelectorAll("#cnt-form-body tr").forEach(tr => {
          tr.hidden = q ? !norm(tr.dataset.nombre || "").includes(q) : false;
        });
        _actualizarResumen();
      };
    }

    // Cargar ingenieros en el dropdown de almacén
    _cargarIngenierosDrop();

    const tbody = document.getElementById("cnt-form-body");
    if (!tbody) return;
    _actualizarResumen();

    tbody.innerHTML = _conteoItems.map((p, i) => {
      const dif = (p.stockConteo ?? p.stockSistema) - p.stockSistema;
      const difColor = dif > 0 ? "#16A34A" : dif < 0 ? "#DC2626" : "var(--text-sec)";
      const badge = dif === 0
        ? `<span class="badge" style="background:#F1F5F9;color:#64748B">Sin diferencia</span>`
        : dif > 0
        ? `<span class="badge" style="background:#DCFCE7;color:#15803D">Sobrante ▲</span>`
        : `<span class="badge badge-red">Faltante ▼</span>`;
      return `<tr data-nombre="${esc(p.nombre)}">
        <td style="font-weight:600">${esc(p.nombre)}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${p.stockSistema}</td>
        <td style="text-align:right">
          ${soloLectura
            ? `<span style="font-weight:700">${p.stockConteo ?? "–"}</span>`
            : `<input type="number" min="0" step="1" value="${p.stockConteo ?? ""}"
                data-cnt-idx="${i}"
                style="width:90px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;
                  text-align:right;background:var(--surface);color:var(--text-primary);
                  font-size:13px;font-weight:700;font-variant-numeric:tabular-nums"
                placeholder="${p.stockSistema}">`}
        </td>
        <td style="text-align:right;font-weight:800;color:${difColor};font-variant-numeric:tabular-nums"
          data-dif-idx="${i}">
          ${dif === 0 ? "0" : (dif > 0 ? "+" : "") + dif}
        </td>
        <td>${badge}</td>
      </tr>`;
    }).join("");

    if (!soloLectura) {
      tbody.querySelectorAll("input[data-cnt-idx]").forEach(inp => {
        inp.addEventListener("input", () => {
          const i = parseInt(inp.dataset.cntIdx);
          const v = inp.value === "" ? null : parseFloat(inp.value);
          _conteoItems[i].stockConteo = v;
          const dif = (v ?? _conteoItems[i].stockSistema) - _conteoItems[i].stockSistema;
          _conteoItems[i].diferencia  = dif;
          const difEl = tbody.querySelector(`[data-dif-idx="${i}"]`);
          if (difEl) {
            difEl.textContent = dif === 0 ? "0" : (dif > 0 ? "+" : "") + dif;
            difEl.style.color  = dif > 0 ? "#16A34A" : dif < 0 ? "#DC2626" : "var(--text-sec)";
          }
          _actualizarResumen();
        });
      });
    }
  }

  function _actualizarResumen() {
    const difs = _conteoItems.filter(p => p.diferencia !== 0).length;
    const el = document.getElementById("cnt-resumen-difs");
    if (el) el.textContent = difs;
    const visibles = document.querySelectorAll("#cnt-form-body tr:not([hidden])").length;
    const elVis = document.getElementById("cnt-resumen-vis");
    if (elVis) elVis.textContent = visibles || _conteoItems.length;
  }

  async function _cargarIngenierosDrop() {
    const sel = document.getElementById("cnt-almacen");
    if (!sel) return;
    // Limpiar opciones previas excepto la central
    [...sel.options].forEach(o => { if (o.value !== "CENTRAL") o.remove(); });
    try {
      const { getDocs: gd, collection: colRef, query: qry, where: wh } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const snap = await gd(qry(colRef(db, "usuarios"), wh("rol", "==", "INGENIERO"), wh("activo","==",true)));
      snap.forEach(d => {
        const u = d.data();
        const opt = document.createElement("option");
        opt.value = "ING_" + d.id;
        opt.textContent = `👷 ${u.nombre || u.alias || d.id}`;
        opt.dataset.uid = d.id;
        sel.appendChild(opt);
      });
    } catch(_) {}
  }

  document.getElementById("cnt-back-btn")?.addEventListener("click", () => {
    document.getElementById("cnt-vista-lista").style.display = "";
    document.getElementById("cnt-vista-form").style.display  = "none";
    _cargarHistorial();
  });

  document.getElementById("cnt-aplicar-btn")?.addEventListener("click", async () => {
    const conDif = _conteoItems.filter(p => p.stockConteo !== null && p.diferencia !== 0);
    const ingUid = _conteoActivo.ingUid || null;
    const etiqueta = ingUid ? "stock del ingeniero" : "inventario";
    if (!conDif.length) { window.toast?.("Sin diferencias para ajustar","info"); return; }
    if (!confirm(`¿Aplicar ${conDif.length} ajuste(s) al ${etiqueta} y cerrar el conteo?`)) return;

    const btn = document.getElementById("cnt-aplicar-btn");
    btn.disabled = true; btn.textContent = "Aplicando…";
    try {
      const { addDoc: ad, collection: colRef, doc: dc, updateDoc: upd, setDoc: sd, getDoc: gdc } =
        await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

      const fmtConteo = fmtFecha(_conteoActivo._ts);
      const faltantes = conDif.filter(p => p.diferencia < 0);
      const sobrantes = conDif.filter(p => p.diferencia > 0);

      for (const p of conDif) {
        const nuevo = (p.stockConteo ?? p.stockSistema);
        const tipoMov = ingUid ? "AJUSTE_INGENIERO" : "AJUSTE_INVENTARIO";

        await ad(colRef(db, "movimientos_stock"), {
          productoId: p.productoId, nombreProducto: p.nombre,
          tipo: tipoMov, cantidad: Math.abs(p.diferencia),
          stockAntes: p.stockSistema, stockDespues: nuevo,
          motivo: `Conteo físico ${fmtConteo}${ingUid ? ` — ${_conteoActivo.almacenNombre}` : ""}`,
          quienRegistro: Sesion.alias, ingUid: ingUid || null, _ts: Date.now()
        });

        if (ingUid) {
          // Actualizar stock personal del ingeniero
          await upd(dc(db, "stock_ingenieros", ingUid), {
            [`items.${p.productoId}.cantidad`]: nuevo,
            [`items.${p.productoId}._tsConteo`]: Date.now()
          });
        } else {
          await sd(dc(db, "inventario", p.productoId), { stockActual: nuevo, _ts: Date.now() }, { merge: true });
        }
      }

      const productosActualizados = _conteoItems.map(p => ({
        ...p, stockConteo: p.stockConteo ?? p.stockSistema,
        diferencia: (p.stockConteo ?? p.stockSistema) - p.stockSistema
      }));
      const almacenSel = document.getElementById("cnt-almacen")?.value || _conteoActivo.almacen || "CENTRAL";
      const almNom = document.getElementById("cnt-almacen")?.options[document.getElementById("cnt-almacen").selectedIndex]?.text?.replace(/^[🏭👷]\s*/u,"") || _conteoActivo.almacenNombre || "Central";

      // Generar nota de adeudo en RH si hay faltantes de ingeniero
      let adeudoRef = null;
      if (ingUid && faltantes.length) {
        // Buscar costo unitario para calcular monto
        const lineas = await Promise.all(faltantes.map(async p => {
          let costo = 0;
          try {
            const invDoc = await gdc(dc(db, "inventario", p.productoId));
            costo = invDoc.data()?.costoUnitario || invDoc.data()?.costo || 0;
          } catch(_) {}
          return { nombre: p.nombre, faltante: Math.abs(p.diferencia), costo, subtotal: Math.abs(p.diferencia) * costo };
        }));
        const montoTotal = lineas.reduce((s,l) => s + l.subtotal, 0);
        const conceptoLineas = lineas.map(l =>
          `${l.nombre}: ${l.faltante} uds${l.costo ? ` × $${l.costo.toFixed(2)} = $${l.subtotal.toFixed(2)}` : ""}`
        ).join("\n");

        const adeudoDoc = await ad(colRef(db, "rh_anticipos"), {
          uid: ingUid,
          alias: _conteoActivo.almacenNombre,
          tipo: "ADEUDO_INVENTARIO",
          monto: montoTotal,
          motivo: `Adeudo por conteo físico ${fmtConteo} — ${faltantes.length} producto(s) faltante(s):\n${conceptoLineas}`,
          conteoId: _conteoActivo.id,
          status: "ADEUDO",
          creadoPor: Sesion.alias,
          timestamp: Date.now(), _ts: Date.now()
        });
        adeudoRef = adeudoDoc.id;
        logAudit("ADEUDO_INVENTARIO_CREADO", { adeudoId: adeudoDoc.id, ingUid, monto: montoTotal });

        // Notificar al ingeniero afectado
        try {
          await ad(colRef(db, "notificaciones_web"), {
            tipo:          "ADEUDO_INVENTARIO",
            titulo:        "Adeudo de inventario registrado",
            mensaje:       `Se registró un adeudo de ${new Intl.NumberFormat("es-MX",{style:"currency",currency:"MXN"}).format(montoTotal)} por ${faltantes.length} producto(s) faltante(s) en el conteo del ${fmtConteo}. Consulta Mi RH → Anticipos.`,
            destinatarios: [ingUid],
            leida:         false,
            timestamp:     Date.now(),
            datos:         { adeudoId: adeudoDoc.id, conteoId: _conteoActivo.id, monto: montoTotal },
          });
        } catch(_) {}
      }

      await upd(dc(db, "conteos_fisicos", _conteoActivo.id), {
        estado: "CERRADO", productos: productosActualizados,
        almacen: almacenSel, almacenNombre: almNom,
        adeudoId: adeudoRef || null,
        quienCerro: Sesion.alias, fechaCierre: Date.now()
      });

      logAudit("CONTEO_CERRADO", { conteoId: _conteoActivo.id, ajustes: conDif.length, ingUid });
      window.toast?.(`Conteo cerrado. ${conDif.length} ajuste(s) aplicado(s)`, "success");

      // ── Mostrar reporte de hallazgos ─────────────────────────
      _mostrarReporteConteo({
        almacenNombre: almNom,
        ingUid,
        fmtConteo,
        faltantes: conDif.filter(p => p.diferencia < 0),
        sobrantes: conDif.filter(p => p.diferencia > 0),
        adeudoId: adeudoRef
      });

    } catch(e) { window.toast?.("Error: " + e.message, "error"); }
    finally { btn.disabled = false; btn.textContent = "✔ Cerrar y aplicar ajustes"; }
  });

  function _mostrarReporteConteo({ almacenNombre, ingUid, fmtConteo, faltantes, sobrantes, adeudoId }) {
    const fmtMXN = v => Number(v||0).toLocaleString("es-MX",{style:"currency",currency:"MXN"});
    const filasF = faltantes.map(p => `<tr>
      <td style="padding:6px 10px;font-weight:600">${esc(p.nombre)}</td>
      <td style="padding:6px 10px;text-align:right">${p.stockSistema}</td>
      <td style="padding:6px 10px;text-align:right">${p.stockConteo ?? "–"}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:800;color:#DC2626">${p.diferencia}</td>
    </tr>`).join("");
    const filasS = sobrantes.map(p => `<tr>
      <td style="padding:6px 10px;font-weight:600">${esc(p.nombre)}</td>
      <td style="padding:6px 10px;text-align:right">${p.stockSistema}</td>
      <td style="padding:6px 10px;text-align:right">${p.stockConteo ?? "–"}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:800;color:#16A34A">+${p.diferencia}</td>
    </tr>`).join("");

    const adeudoBanner = adeudoId
      ? `<div style="margin-top:16px;padding:12px 16px;background:#FEF2F2;border:1px solid #FECACA;
            border-radius:10px;display:flex;gap:10px;align-items:center">
           <span style="font-size:22px">⚠️</span>
           <div>
             <div style="font-weight:800;color:#DC2626;font-size:13px">Nota de adeudo generada</div>
             <div style="font-size:11px;color:#7F1D1D;margin-top:2px">
               Registrada en Mi RH → Anticipos con concepto <strong>ADEUDO</strong>.
               Cambia a <strong>PAGADO</strong> cuando el ingeniero liquide.
             </div>
           </div>
         </div>`
      : "";

    const html = `<div class="modal-overlay" id="cnt-reporte-overlay" style="display:flex;z-index:9999">
      <div class="modal-box" style="max-width:600px;width:100%">
        <div class="modal-hdr">
          <span>📋 Reporte de hallazgos — ${esc(almacenNombre)} · ${fmtConteo}</span>
          <button class="modal-close" id="cnt-rep-close">✕</button>
        </div>
        <div class="modal-body" style="max-height:70vh;overflow-y:auto">
          ${faltantes.length ? `
          <div style="margin-bottom:16px">
            <div style="font-size:12px;font-weight:800;color:#DC2626;margin-bottom:6px;letter-spacing:.05em">
              🔴 FALTANTES (${faltantes.length})
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="background:var(--surface-2)">
                <th style="padding:6px 10px;text-align:left;font-size:10px;letter-spacing:.05em">PRODUCTO</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px">SISTEMA</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px">CONTEO</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px">DIFERENCIA</th>
              </tr></thead>
              <tbody>${filasF}</tbody>
            </table>
          </div>` : ""}
          ${sobrantes.length ? `
          <div style="margin-bottom:16px">
            <div style="font-size:12px;font-weight:800;color:#16A34A;margin-bottom:6px;letter-spacing:.05em">
              🟢 SOBRANTES (${sobrantes.length})
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="background:var(--surface-2)">
                <th style="padding:6px 10px;text-align:left;font-size:10px;letter-spacing:.05em">PRODUCTO</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px">SISTEMA</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px">CONTEO</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px">DIFERENCIA</th>
              </tr></thead>
              <tbody>${filasS}</tbody>
            </table>
          </div>` : ""}
          ${!faltantes.length && !sobrantes.length
            ? `<div style="padding:24px;text-align:center;color:var(--text-sec)">Sin diferencias encontradas.</div>`
            : ""}
          ${adeudoBanner}
        </div>
        <div class="modal-footer" style="justify-content:flex-end">
          <button class="btn-primary" id="cnt-rep-close2">Cerrar reporte</button>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML("beforeend", html);
    const cerrarRep = () => document.getElementById("cnt-reporte-overlay")?.remove();
    document.getElementById("cnt-rep-close")?.addEventListener("click", cerrarRep);
    document.getElementById("cnt-rep-close2")?.addEventListener("click", () => {
      cerrarRep();
      document.getElementById("cnt-vista-lista").style.display = "";
      document.getElementById("cnt-vista-form").style.display  = "none";
      _cargarHistorial();
    });
    document.getElementById("cnt-reporte-overlay")?.addEventListener("click", e => {
      if (e.target.id === "cnt-reporte-overlay") { cerrarRep(); _cargarHistorial(); }
    });
  }
}

// ══════════════════════════════════════════════════════════════
// ALERTAS MÍN/MÁX  (Alto / 76)
// Lee inventario; permite configurar stockMaximo por producto
// ══════════════════════════════════════════════════════════════
function _montarAlertas() {
  document.getElementById("inv-content").innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
      <h3 style="margin:0;font-size:15px;font-weight:800;flex:1">🔔 Alertas de stock mín/máx</h3>
      <input type="text" class="sel-sm" id="alr-buscar" placeholder="Buscar…" style="width:180px">
    </div>

    <div class="kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left-color:#DC2626">
        <div class="kpi-icon">🔴</div><div class="kpi-val" id="alr-kpi-bajo">–</div>
        <div class="kpi-label">Bajo mínimo</div>
      </div>
      <div class="kpi-card" style="border-left-color:#7C3AED">
        <div class="kpi-icon">🟣</div><div class="kpi-val" id="alr-kpi-sobre">–</div>
        <div class="kpi-label">Sobre máximo</div>
      </div>
      <div class="kpi-card" style="border-left-color:#16A34A">
        <div class="kpi-icon">✅</div><div class="kpi-val" id="alr-kpi-ok">–</div>
        <div class="kpi-label">En rango</div>
      </div>
      <div class="kpi-card" style="border-left-color:#94A3B8">
        <div class="kpi-icon">⚙️</div><div class="kpi-val" id="alr-kpi-sinmax">–</div>
        <div class="kpi-label">Sin máximo config.</div>
      </div>
    </div>

    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>PRODUCTO</th>
          <th style="text-align:right">STOCK</th>
          <th style="text-align:right">MÍN</th>
          <th style="text-align:right">MÁX</th>
          <th>ALERTA</th>
          <th>NIVEL</th>
          ${_puedeEditar() ? "<th>CONFIG</th>" : ""}
        </tr></thead>
        <tbody id="alr-body"></tbody>
      </table>
    </div>

    <!-- Modal configurar máximo -->
    <div class="modal-overlay hidden" id="alr-modal">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;
        width:100%;max-width:420px;box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden">
        <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
          <span style="font-size:22px">📏</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:800" id="alr-modal-nom">Configurar límites</div>
            <div style="font-size:11px;color:#64748B">Stock mínimo y máximo por producto</div>
          </div>
          <button id="alr-modal-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#64748B">✕</button>
        </div>
        <div style="padding:20px;display:flex;flex-direction:column;gap:14px">
          <input type="hidden" id="alr-prod-id">
          <div style="display:flex;gap:12px">
            <div style="flex:1">
              <label style="font-size:10px;color:#94A3B8;font-weight:700;display:block;margin-bottom:5px">Stock MÍNIMO</label>
              <input class="form-input" type="number" id="alr-minimo" min="0" step="1" placeholder="0"
                style="text-align:center;font-weight:700;font-size:16px">
            </div>
            <div style="flex:1">
              <label style="font-size:10px;color:#94A3B8;font-weight:700;display:block;margin-bottom:5px">Stock MÁXIMO</label>
              <input class="form-input" type="number" id="alr-maximo" min="0" step="1" placeholder="0"
                style="text-align:center;font-weight:700;font-size:16px">
            </div>
          </div>
          <p style="font-size:11px;color:#64748B;margin:0">
            El sistema mostrará alertas cuando el stock salga de este rango.
          </p>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border)">
          <button id="alr-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);
            background:transparent;color:#94A3B8;font-size:12px;cursor:pointer">Cancelar</button>
          <button id="alr-guardar" style="padding:8px 22px;border-radius:8px;border:none;
            background:#6366F1;color:#fff;font-size:12px;font-weight:700;cursor:pointer">Guardar</button>
        </div>
      </div>
    </div>`;

  let _alrRows = [];
  const cerrarAlrModal = () => document.getElementById("alr-modal")?.classList.add("hidden");

  function _renderAlertas(rows) {
    const bajo   = rows.filter(r => (r.stockActual??0) > 0 && (r.stockActual??0) <= (r.stockMinimo||0));
    const cero   = rows.filter(r => (r.stockActual??0) <= 0);
    const sobre  = rows.filter(r => r.stockMaximo > 0 && (r.stockActual??0) > r.stockMaximo);
    const sinMax = rows.filter(r => !(r.stockMaximo > 0));
    const ok     = rows.filter(r => !bajo.includes(r) && !cero.includes(r) && !sobre.includes(r));
    const el = id => document.getElementById(id);
    if (el("alr-kpi-bajo"))   el("alr-kpi-bajo").textContent   = bajo.length + cero.length;
    if (el("alr-kpi-sobre"))  el("alr-kpi-sobre").textContent  = sobre.length;
    if (el("alr-kpi-ok"))     el("alr-kpi-ok").textContent     = ok.length;
    if (el("alr-kpi-sinmax")) el("alr-kpi-sinmax").textContent = sinMax.length;

    const tbody = document.getElementById("alr-body");
    if (!tbody) return;
    const sorted = [...rows].sort((a,b) => {
      const alertaA = _nivelAlerta(a), alertaB = _nivelAlerta(b);
      const ord = { CRITICO:0, BAJO_MIN:1, SOBRE_MAX:2, OK:3, SIN_MAX:4 };
      return (ord[alertaA]??9) - (ord[alertaB]??9);
    });
    tbody.innerHTML = sorted.map(r => {
      const stock  = r.stockActual ?? 0;
      const min    = r.stockMinimo ?? 0;
      const max    = r.stockMaximo ?? 0;
      const alerta = _nivelAlerta(r);
      const badge  = {
        CRITICO:   `<span class="badge badge-red">🔴 SIN STOCK</span>`,
        BAJO_MIN:  `<span class="badge badge-amber">⚠️ BAJO MÍN</span>`,
        SOBRE_MAX: `<span class="badge" style="background:#F3E8FF;color:#7C3AED">🟣 SOBRE MÁX</span>`,
        OK:        `<span class="badge" style="background:#DCFCE7;color:#15803D">✅ OK</span>`,
        SIN_MAX:   `<span class="badge" style="background:#F1F5F9;color:#64748B">⚙️ Sin máx</span>`,
      }[alerta] || "";
      const pct    = max > 0 ? Math.min(100, Math.round(stock/max*100)) : (min > 0 ? Math.min(100,Math.round(stock/min*100)) : 50);
      const barCol = alerta === "CRITICO" ? "#DC2626" : alerta === "BAJO_MIN" ? "#D97706" : alerta === "SOBRE_MAX" ? "#7C3AED" : "#16A34A";
      const maxLbl = max > 0 ? max : `<span style="color:#94A3B8;font-style:italic">—</span>`;
      const cfg    = _puedeEditar()
        ? `<button class="btn-sm btn-outline alr-cfg-btn"
             data-id="${esc(r.id)}" data-nom="${esc(r.nombre||"")}"
             data-min="${min}" data-max="${max}">⚙️ Config</button>`
        : "";
      return `<tr>
        <td style="font-weight:600">${esc(r.nombre||"–")}</td>
        <td style="text-align:right;font-weight:800;font-size:15px;font-variant-numeric:tabular-nums">${stock}</td>
        <td style="text-align:right;color:var(--text-sec);font-variant-numeric:tabular-nums">${min}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${maxLbl}</td>
        <td>${badge}</td>
        <td>
          <div style="height:6px;border-radius:3px;background:var(--border);width:80px">
            <div style="height:6px;border-radius:3px;background:${barCol};width:${pct}%;max-width:100%;transition:width .3s"></div>
          </div>
          <div style="font-size:9px;color:var(--text-sec);margin-top:2px">${pct}% del máx</div>
        </td>
        ${_puedeEditar() ? `<td>${cfg}</td>` : ""}
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".alr-cfg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.getElementById("alr-prod-id").value = btn.dataset.id;
        document.getElementById("alr-modal-nom").textContent = btn.dataset.nom;
        document.getElementById("alr-minimo").value = btn.dataset.min || "";
        document.getElementById("alr-maximo").value = btn.dataset.max || "";
        document.getElementById("alr-modal")?.classList.remove("hidden");
      });
    });
  }

  function _nivelAlerta(r) {
    const stock = r.stockActual ?? 0;
    const min   = r.stockMinimo ?? 0;
    const max   = r.stockMaximo ?? 0;
    if (stock <= 0) return "CRITICO";
    if (min > 0 && stock <= min) return "BAJO_MIN";
    if (max > 0 && stock > max)  return "SOBRE_MAX";
    if (max <= 0) return "SIN_MAX";
    return "OK";
  }

  const q = query(collection(db, "inventario"), orderBy("nombre"), limit(500));
  _unsubs.push(onSnapshot(q, snap => {
    _alrRows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderAlertas(_alrRows);
  }, err => console.error("[Alertas]", err)));

  document.getElementById("alr-buscar")?.addEventListener("input", e => {
    const t = norm(e.target.value);
    _renderAlertas(t ? _alrRows.filter(r => norm(r.nombre||"").includes(t)) : _alrRows);
  });

  document.getElementById("alr-modal-close")?.addEventListener("click", cerrarAlrModal);
  document.getElementById("alr-cancel")?.addEventListener("click", cerrarAlrModal);
  document.getElementById("alr-modal")?.addEventListener("click", e => {
    if (e.target === document.getElementById("alr-modal")) cerrarAlrModal();
  });

  document.getElementById("alr-guardar")?.addEventListener("click", async () => {
    const prodId = document.getElementById("alr-prod-id")?.value;
    const minVal = parseFloat(document.getElementById("alr-minimo")?.value || "0");
    const maxVal = parseFloat(document.getElementById("alr-maximo")?.value || "0");
    if (!prodId) return;
    if (maxVal > 0 && minVal > maxVal) { window.toast?.("El máximo debe ser mayor que el mínimo","error"); return; }
    const btn = document.getElementById("alr-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      await setDoc(doc(db, "inventario", prodId), { stockMinimo: minVal, stockMaximo: maxVal, _ts: Date.now() }, { merge: true });
      logAudit("CONFIG_STOCK_LIMITES", { productoId: prodId, stockMinimo: minVal, stockMaximo: maxVal });
      window.toast?.("Límites guardados","success");
      cerrarAlrModal();
    } catch(e) { window.toast?.("Error: " + e.message,"error"); }
    finally { btn.disabled = false; btn.textContent = "Guardar"; }
  });
}

// ══════════════════════════════════════════════════════════════
// MERMAS  (Medio / 62)
// Tipo formal: MERMA — subtipo: ROTURA / DERRAME / VENCIMIENTO / PERDIDA / OTRO
// Escribe a movimientos_stock con tipo:"MERMA" y campo motivoMerma
// ══════════════════════════════════════════════════════════════
function _montarMermas() {
  const hoy   = new Date().toISOString().slice(0,10);
  const hace30 = new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  document.getElementById("inv-content").innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <h3 style="margin:0;font-size:15px;font-weight:800;flex:1">🗑️ Mermas y ajustes</h3>
      ${_puedeEditar() ? `<button class="btn-primary" id="mrm-nueva-btn">+ Registrar merma</button>` : ""}
    </div>

    <div class="kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left-color:#DC2626">
        <div class="kpi-icon">🗑️</div><div class="kpi-val" id="mrm-kpi-total">–</div>
        <div class="kpi-label">Mermas este mes</div>
      </div>
      <div class="kpi-card" style="border-left-color:#D97706">
        <div class="kpi-icon">📦</div><div class="kpi-val" id="mrm-kpi-unidades">–</div>
        <div class="kpi-label">Unidades perdidas</div>
      </div>
      <div class="kpi-card" style="border-left-color:#7C3AED">
        <div class="kpi-icon">💸</div><div class="kpi-val" id="mrm-kpi-valor">–</div>
        <div class="kpi-label">Valor estimado</div>
      </div>
    </div>

    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <select class="sel-sm" id="mrm-tipo-fil">
        <option value="">Todos los motivos</option>
        <option value="ROTURA">Rotura</option>
        <option value="DERRAME">Derrame</option>
        <option value="VENCIMIENTO">Vencimiento</option>
        <option value="PERDIDA">Pérdida</option>
        <option value="OTRO">Otro</option>
      </select>
      <span style="font-size:11px;color:var(--text-sec)">Desde</span>
      <input type="date" class="sel-sm" id="mrm-desde" value="${hace30}">
      <span style="font-size:11px;color:var(--text-sec)">Hasta</span>
      <input type="date" class="sel-sm" id="mrm-hasta" value="${hoy}">
      <button class="btn-primary" id="mrm-filtrar">Filtrar</button>
      <button id="mrm-xlsx-btn" style="padding:7px 12px;background:var(--accent);color:#fff;
        border:none;border-radius:6px;cursor:pointer;font-size:13px">⬇️ Excel</button>
    </div>

    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>FECHA</th><th>PRODUCTO</th><th>MOTIVO</th>
          <th style="text-align:right">CANT.</th>
          <th style="text-align:right">STOCK ANTES</th>
          <th style="text-align:right">STOCK DESPUÉS</th>
          <th>OBSERVACIONES</th><th>REGISTRÓ</th>
        </tr></thead>
        <tbody id="mrm-body">
          <tr><td colspan="8" style="padding:24px;text-align:center;color:var(--text-sec)">Cargando…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Modal nueva merma -->
    <div class="modal-overlay hidden" id="mrm-modal">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;
        width:100%;max-width:500px;box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden;
        display:flex;flex-direction:column">
        <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
          <span style="font-size:22px">🗑️</span>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:800">Registrar merma</div>
            <div style="font-size:11px;color:#64748B">Rotura · Derrame · Vencimiento · Pérdida</div>
          </div>
          <button id="mrm-modal-close" style="background:none;border:none;cursor:pointer;font-size:18px;color:#64748B">✕</button>
        </div>
        <div style="padding:18px 20px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;max-height:70vh">

          <!-- Tipo de merma -->
          <div>
            <div style="font-size:10px;font-weight:700;color:#64748B;text-transform:uppercase;
              letter-spacing:.08em;margin-bottom:8px">Motivo de la merma</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
              ${[
                { v:"ROTURA",      ico:"💥", lbl:"Rotura"     },
                { v:"DERRAME",     ico:"💧", lbl:"Derrame"    },
                { v:"VENCIMIENTO", ico:"📅", lbl:"Vencimiento"},
                { v:"PERDIDA",     ico:"❓", lbl:"Pérdida"    },
                { v:"OTRO",        ico:"📝", lbl:"Otro"       },
              ].map((op,i) => `
                <button type="button" data-mrm-motivo="${op.v}"
                  onclick="window._mrmSelMotivo('${op.v}')"
                  style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 6px;
                    border-radius:8px;cursor:pointer;border:1.5px solid ${i===0?"#DC2626":"var(--border)"};
                    background:${i===0?"#FEF2F2":"transparent"};transition:border-color .15s,background .15s">
                  <span style="font-size:18px">${op.ico}</span>
                  <span class="mrm-motivo-lbl" style="font-size:10px;font-weight:700;
                    color:${i===0?"#DC2626":"var(--text-sec)"}">${op.lbl}</span>
                </button>`).join("")}
            </div>
            <input type="hidden" id="mrm-motivo-val" value="ROTURA">
          </div>

          <!-- Producto buscador -->
          <div style="background:var(--surface-2);border:1px solid var(--border);
            border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px">
            <div style="font-size:10px;font-weight:700;color:#64748B;text-transform:uppercase">Producto</div>
            <div style="position:relative">
              <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:13px;pointer-events:none">🔍</span>
              <input type="text" id="mrm-prod-search" placeholder="Buscar producto…" autocomplete="off"
                style="width:100%;padding:8px 10px 8px 32px;border:1px solid var(--border);
                  border-radius:8px;background:var(--surface);color:var(--text-primary);font-size:12px;box-sizing:border-box">
              <div id="mrm-prod-lista" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;
                background:var(--surface);border:1px solid var(--border);border-radius:8px;
                max-height:160px;overflow-y:auto;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,.4)"></div>
            </div>
            <div id="mrm-prod-chip" style="display:none;align-items:center;gap:10px;
              background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px 12px">
              <div style="flex:1">
                <div style="font-size:12px;font-weight:700;color:var(--text-primary)" id="mrm-chip-nom">—</div>
                <div style="font-size:11px;color:#64748B" id="mrm-chip-stock">Stock sistema: —</div>
              </div>
              <button type="button" onclick="window._mrmLimpiarProd()"
                style="background:none;border:none;cursor:pointer;color:#64748B;font-size:16px">✕</button>
            </div>
            <input type="hidden" id="mrm-prod-id">
            <input type="hidden" id="mrm-prod-nom">
            <input type="hidden" id="mrm-prod-stock">
          </div>

          <!-- Cantidad y observaciones -->
          <div style="display:flex;gap:10px">
            <div style="flex:0.7">
              <label style="font-size:10px;color:#94A3B8;font-weight:700;text-transform:uppercase;display:block;margin-bottom:5px">
                Cantidad merma
              </label>
              <input class="form-input" type="number" id="mrm-cantidad" min="1" step="1" placeholder="0"
                style="width:100%;font-size:16px;font-weight:700;text-align:center">
            </div>
            <div style="flex:1.3">
              <label style="font-size:10px;color:#94A3B8;font-weight:700;text-transform:uppercase;display:block;margin-bottom:5px">
                Observaciones
              </label>
              <input class="form-input" type="text" id="mrm-obs" placeholder="Lote, folio, descripción…" style="width:100%">
            </div>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border)">
          <button id="mrm-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid var(--border);
            background:transparent;color:#94A3B8;font-size:12px;cursor:pointer">Cancelar</button>
          <button id="mrm-guardar" style="padding:8px 22px;border-radius:8px;border:none;
            background:#DC2626;color:#fff;font-size:12px;font-weight:700;cursor:pointer">✔ Registrar merma</button>
        </div>
      </div>
    </div>`;

  // ── Motivo selector ────────────────────────────────────────
  window._mrmSelMotivo = (val) => {
    document.getElementById("mrm-motivo-val").value = val;
    document.querySelectorAll("[data-mrm-motivo]").forEach(btn => {
      const sel = btn.dataset.mrmMotivo === val;
      btn.style.borderColor = sel ? "#DC2626" : "var(--border)";
      btn.style.background  = sel ? "#FEF2F2" : "transparent";
      btn.querySelector(".mrm-motivo-lbl").style.color = sel ? "#DC2626" : "var(--text-sec)";
    });
  };

  // ── Autocomplete producto ──────────────────────────────────
  let _mrmCatalogo = [];
  async function _cargarCatalogoMrm() {
    if (_mrmCatalogo.length) return;
    const { getDocs, query: q2, collection: c2, orderBy: o2 } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const snap = await getDocs(q2(c2(db, "inventario"), o2("nombre")));
    _mrmCatalogo = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  function _mrmRenderLista(term) {
    const listaEl = document.getElementById("mrm-prod-lista");
    if (!listaEl) return;
    const t = norm(term);
    const matches = _mrmCatalogo.filter(p => !t || norm(p.nombre||"").includes(t)).slice(0,30);
    if (!matches.length) {
      listaEl.innerHTML = `<div style="padding:12px;font-size:12px;color:#64748B;text-align:center">Sin resultados</div>`;
      listaEl.style.display = "block"; return;
    }
    listaEl.innerHTML = matches.map((p,i) => `
      <div data-mrm-idx="${i}" style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border);
        display:flex;justify-content:space-between;align-items:center"
        onmouseenter="this.style.background='#FEF2F220'" onmouseleave="this.style.background='transparent'">
        <div>
          <div style="font-size:12px;font-weight:600">${esc(p.nombre||"")}</div>
          <div style="font-size:10px;color:#64748B">Stock: ${p.stockActual??0} ${p.unidad||"pieza"}</div>
        </div>
      </div>`).join("");
    listaEl.querySelectorAll("[data-mrm-idx]").forEach(el => {
      el.addEventListener("click", () => {
        const p = matches[parseInt(el.dataset.mrmIdx)];
        document.getElementById("mrm-prod-id").value    = p.id;
        document.getElementById("mrm-prod-nom").value   = p.nombre;
        document.getElementById("mrm-prod-stock").value = p.stockActual ?? 0;
        document.getElementById("mrm-chip-nom").textContent   = p.nombre;
        document.getElementById("mrm-chip-stock").textContent = `Stock sistema: ${p.stockActual??0} ${p.unidad||"pieza"}`;
        document.getElementById("mrm-prod-chip").style.display   = "flex";
        document.getElementById("mrm-prod-search").style.display = "none";
        listaEl.style.display = "none";
      });
    });
    listaEl.style.display = "block";
  }

  window._mrmLimpiarProd = () => {
    document.getElementById("mrm-prod-id").value    = "";
    document.getElementById("mrm-prod-nom").value   = "";
    document.getElementById("mrm-prod-stock").value = "";
    document.getElementById("mrm-prod-chip").style.display   = "none";
    document.getElementById("mrm-prod-search").style.display = "";
    document.getElementById("mrm-prod-search").value = "";
    document.getElementById("mrm-prod-search").focus();
  };

  const mrmSearch = document.getElementById("mrm-prod-search");
  mrmSearch?.addEventListener("focus", async () => { await _cargarCatalogoMrm(); _mrmRenderLista(mrmSearch.value); });
  mrmSearch?.addEventListener("input", () => _mrmRenderLista(mrmSearch.value));
  document.addEventListener("click", e => {
    const lista = document.getElementById("mrm-prod-lista");
    if (lista && !lista.contains(e.target) && e.target !== mrmSearch) lista.style.display = "none";
  });

  // ── Modal lifecycle ────────────────────────────────────────
  const cerrarMrmModal = () => {
    document.getElementById("mrm-modal")?.classList.add("hidden");
    window._mrmLimpiarProd?.();
    document.getElementById("mrm-cantidad").value = "";
    document.getElementById("mrm-obs").value = "";
    window._mrmSelMotivo?.("ROTURA");
  };

  document.getElementById("mrm-nueva-btn")?.addEventListener("click", () => {
    window._mrmSelMotivo("ROTURA");
    document.getElementById("mrm-modal")?.classList.remove("hidden");
    _cargarCatalogoMrm();
  });
  document.getElementById("mrm-modal-close")?.addEventListener("click", cerrarMrmModal);
  document.getElementById("mrm-cancel")?.addEventListener("click", cerrarMrmModal);
  document.getElementById("mrm-modal")?.addEventListener("click", e => {
    if (e.target === document.getElementById("mrm-modal")) cerrarMrmModal();
  });

  // ── Guardar merma ──────────────────────────────────────────
  document.getElementById("mrm-guardar")?.addEventListener("click", async () => {
    const prodId   = document.getElementById("mrm-prod-id")?.value.trim();
    const prodNom  = document.getElementById("mrm-prod-nom")?.value.trim();
    const stockAnt = parseFloat(document.getElementById("mrm-prod-stock")?.value || "0");
    const motivo   = document.getElementById("mrm-motivo-val")?.value || "OTRO";
    const cant     = parseFloat(document.getElementById("mrm-cantidad")?.value || "0");
    const obs      = document.getElementById("mrm-obs")?.value.trim();

    if (!prodId) { window.toast?.("Selecciona un producto","error"); return; }
    if (cant <= 0) { window.toast?.("La cantidad debe ser mayor a 0","error"); return; }
    if (cant > stockAnt) { window.toast?.(`Solo hay ${stockAnt} en stock. Ajusta la cantidad.`,"error"); return; }

    const btn = document.getElementById("mrm-guardar");
    btn.disabled = true; btn.textContent = "Guardando…";
    try {
      const stockDespues = Math.max(0, stockAnt - cant);
      await addDoc(collection(db, "movimientos_stock"), {
        productoId: prodId, nombreProducto: prodNom,
        tipo: "MERMA", motivoMerma: motivo, cantidad: cant,
        stockAntes: stockAnt, stockDespues,
        motivo: obs || motivo,
        quienRegistro: Sesion.alias, _ts: Date.now()
      });
      await setDoc(doc(db, "inventario", prodId), { stockActual: stockDespues, _ts: Date.now() }, { merge: true });
      logAudit("MERMA_REGISTRADA", { productoId: prodId, productoNombre: prodNom, motivoMerma: motivo, cantidad: cant, stockAntes: stockAnt, stockDespues });
      window.toast?.("Merma registrada","success");
      cerrarMrmModal();
      _escucharMermas();
    } catch(e) { window.toast?.("Error: " + e.message,"error"); }
    finally { btn.disabled = false; btn.textContent = "✔ Registrar merma"; }
  });

  // ── Historial de mermas ───────────────────────────────────
  let _mrmRowsCache = [];

  function _escucharMermas() {
    _unsubs.forEach(u => u?.()); _unsubs = [];
    const tipoFil = document.getElementById("mrm-tipo-fil")?.value || "";
    const desde   = document.getElementById("mrm-desde")?.value;
    const hasta   = document.getElementById("mrm-hasta")?.value;
    const [dy,dm,dd] = (desde||"").split("-").map(Number);
    const [hy,hm,hd] = (hasta||"").split("-").map(Number);
    const desdeTs = desde ? new Date(dy,dm-1,dd,0,0,0).getTime() : Date.now()-30*86400000;
    const hastaTs = hasta ? new Date(hy,hm-1,hd,23,59,59).getTime() : Date.now();

    let cs = [where("tipo","==","MERMA"), where("_ts",">=",desdeTs), where("_ts","<=",hastaTs),
      orderBy("_ts","desc"), limit(500)];
    const q = query(collection(db, "movimientos_stock"), ...cs);

    const MOTIVO_ICON = { ROTURA:"💥", DERRAME:"💧", VENCIMIENTO:"📅", PERDIDA:"❓", OTRO:"📝" };
    const MOTIVO_LBL  = { ROTURA:"Rotura", DERRAME:"Derrame", VENCIMIENTO:"Vencimiento", PERDIDA:"Pérdida", OTRO:"Otro" };

    _unsubs.push(onSnapshot(q, snap => {
      let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (tipoFil) rows = rows.filter(r => r.motivoMerma === tipoFil);
      _mrmRowsCache = rows;

      // KPIs
      const mes0 = new Date(); mes0.setDate(1); mes0.setHours(0,0,0,0);
      const delMes = rows.filter(r => r._ts >= mes0.getTime());
      const unidades = delMes.reduce((s,r) => s + (r.cantidad||0), 0);
      const el = id => document.getElementById(id);
      if (el("mrm-kpi-total"))    el("mrm-kpi-total").textContent   = delMes.length;
      if (el("mrm-kpi-unidades")) el("mrm-kpi-unidades").textContent = unidades;
      // Valor: buscamos en _allRows
      const valorMes = delMes.reduce((s,r) => {
        const prod = _allRows.find(p => p.id === r.productoId);
        return s + (r.cantidad||0) * (prod?.costo||0);
      }, 0);
      if (el("mrm-kpi-valor")) el("mrm-kpi-valor").textContent = fmtMXN(valorMes);

      const tbody = document.getElementById("mrm-body");
      if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="padding:32px;text-align:center;color:var(--text-sec)">Sin mermas registradas en el período</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map(r => `<tr>
        <td style="font-size:11px;white-space:nowrap">${fmtFecha(r._ts)}</td>
        <td style="font-weight:600">${esc(r.nombreProducto||r.productoId||"–")}</td>
        <td>
          <span style="font-size:13px">${MOTIVO_ICON[r.motivoMerma]||"📝"}</span>
          <span style="font-size:11px;margin-left:4px">${MOTIVO_LBL[r.motivoMerma]||esc(r.motivoMerma||"–")}</span>
        </td>
        <td style="text-align:right;font-weight:700;color:#DC2626;font-variant-numeric:tabular-nums">${r.cantidad??""}</td>
        <td style="text-align:right;color:var(--text-sec);font-variant-numeric:tabular-nums">${r.stockAntes??""}</td>
        <td style="text-align:right;font-variant-numeric:tabular-nums">${r.stockDespues??""}</td>
        <td style="font-size:11px;color:var(--text-sec);max-width:180px">${esc(r.motivo||"–")}</td>
        <td style="font-size:11px">${esc(r.quienRegistro||"sistema")}</td>
      </tr>`).join("");
    }, err => console.error("[Mermas]", err)));
  }

  document.getElementById("mrm-filtrar")?.addEventListener("click", _escucharMermas);
  document.getElementById("mrm-xlsx-btn")?.addEventListener("click", () => {
    if (!_mrmRowsCache.length) { window.toast?.("Sin datos","warning"); return; }
    const MOTIVO_LBL = { ROTURA:"Rotura", DERRAME:"Derrame", VENCIMIENTO:"Vencimiento", PERDIDA:"Pérdida", OTRO:"Otro" };
    const h = ["Fecha","Producto","Motivo","Cantidad","Stock antes","Stock después","Observaciones","Registró"];
    const d = _mrmRowsCache.map(r => [
      fmtFecha(r._ts), r.nombreProducto||"", MOTIVO_LBL[r.motivoMerma]||r.motivoMerma||"",
      r.cantidad??0, r.stockAntes??0, r.stockDespues??0, r.motivo||"", r.quienRegistro||""
    ]);
    const ws = XLSX.utils.aoa_to_sheet([h,...d]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mermas");
    XLSX.writeFile(wb, `N10-mermas-${new Date().toISOString().slice(0,10)}.xlsx`);
    window.toast?.("Exportando Excel…","info");
  });

  _escucharMermas();
}
