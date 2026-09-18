// ══════════════════════════════════════════════════════════════
// entradas.js — Entradas de inventario al almacén sin OC
// Flujo: BORRADOR → COTEJO → CONFIRMADO
// ══════════════════════════════════════════════════════════════
import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { esc, logAudit, norm } from "./app.js";
import {
  collection, query, orderBy, onSnapshot, addDoc,
  doc, updateDoc, getDoc, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── ESC helper ────────────────────────────────────────────────
let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

// ── Permisos ──────────────────────────────────────────────────
const PUEDE = () => ["SUPER_ADMIN","ADMINISTRADOR","ALMACENISTA"].includes(Sesion.rol);

// ── Estado local ──────────────────────────────────────────────
let _unsub      = null;
let _container  = null;
let _entradas   = [];
let _productos  = [];
let _filtroEstado = "";
// Carrito (modal captura)
let _carrito    = [];     // { productoId, nombre, codigoN10, unidad, cantidadCapturada, costoUnitario }
let _editandoId = null;   // id entrada en edición (modo cotejo)

// ── Estados ───────────────────────────────────────────────────
const ESTADO_INFO = {
  BORRADOR:    { label: "Borrador",    color: "#6B7280", bg: "rgba(107,114,128,.12)" },
  COTEJO:      { label: "En cotejo",   color: "#2563EB", bg: "rgba(37,99,235,.12)"   },
  CONFIRMADO:  { label: "Confirmado",  color: "#16A34A", bg: "rgba(22,163,74,.12)"   },
};

// ── Mount / Destroy ───────────────────────────────────────────
export function mount(container) {
  _container = container;
  _container.innerHTML = _html();
  _bindEvents();
  _cargarProductos();
  _escuchar();
}

export function destroy() {
  _unsub?.(); _unsub = null;
  _unregEsc();
  _container  = null;
  _entradas   = [];
  _carrito    = [];
  _editandoId = null;
}

// ── HTML base ─────────────────────────────────────────────────
function _html() {
  return `
<div style="padding:16px 20px;max-width:1300px;margin:0 auto">

  <!-- KPIs -->
  <div id="ent-kpis" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px"></div>

  <!-- Filtros + botón nuevo -->
  <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px">
    <select id="ent-filtro-estado" style="padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-primary);font-size:13px;cursor:pointer">
      <option value="">Todas las entradas</option>
      <option value="BORRADOR">Borradores</option>
      <option value="COTEJO">En cotejo</option>
      <option value="CONFIRMADO">Confirmadas</option>
    </select>
    ${PUEDE() ? `<button id="ent-btn-nueva" style="margin-left:auto;background:var(--green-dark,#1B5E20);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer;font-size:13px">+ Nueva entrada</button>` : ""}
  </div>

  <!-- Tabla -->
  <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:var(--surface-2);border-bottom:2px solid var(--border)">
          <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-muted);font-size:11px;letter-spacing:.05em">PROVEEDOR</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-muted);font-size:11px;letter-spacing:.05em">REFERENCIA</th>
          <th style="padding:10px 14px;text-align:left;font-weight:700;color:var(--text-muted);font-size:11px;letter-spacing:.05em">FECHA</th>
          <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-muted);font-size:11px;letter-spacing:.05em">PRODUCTOS</th>
          <th style="padding:10px 14px;text-align:right;font-weight:700;color:var(--text-muted);font-size:11px;letter-spacing:.05em">TOTAL</th>
          <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-muted);font-size:11px;letter-spacing:.05em">ESTADO</th>
          <th style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-muted);font-size:11px;letter-spacing:.05em">ACCIONES</th>
        </tr>
      </thead>
      <tbody id="ent-tbody">
        <tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text-muted)">Cargando…</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Modal captura / cotejo -->
  <div id="ent-modal-bg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;overflow-y:auto;padding:20px 10px">
    <div id="ent-modal" style="background:var(--surface);border-radius:14px;padding:0;width:min(720px,98vw);margin:0 auto;box-shadow:0 8px 40px rgba(0,0,0,.35)">

      <!-- Header modal -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;background:var(--surface-2);border-radius:14px 14px 0 0;border-bottom:1px solid var(--border)">
        <div>
          <div id="ent-modal-titulo" style="font-size:16px;font-weight:800;color:var(--text-primary)">Nueva entrada de inventario</div>
          <div id="ent-modal-sub" style="font-size:12px;color:var(--text-muted);margin-top:2px">Captura los productos y cantidades a ingresar al almacén</div>
        </div>
        <button id="ent-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted);padding:4px 8px">✕</button>
      </div>

      <div style="padding:20px">

        <!-- Datos generales (solo en captura, no en cotejo) -->
        <div id="ent-datos-generales">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:5px;letter-spacing:.05em">PROVEEDOR / ORIGEN</label>
              <input id="ent-f-proveedor" type="text" placeholder="Nombre del proveedor o fuente"
                style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:13px;background:var(--surface);color:var(--text-primary)">
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:5px;letter-spacing:.05em">REFERENCIA (FOLIO / REMISIÓN)</label>
              <input id="ent-f-referencia" type="text" placeholder="Ej. REM-2026-001 o número de factura"
                style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:13px;background:var(--surface);color:var(--text-primary)">
            </div>
          </div>
        </div>

        <!-- Buscador de productos (solo en captura) -->
        <div id="ent-buscador-wrap" style="margin-bottom:14px">
          <label style="font-size:11px;font-weight:700;color:var(--text-muted);display:block;margin-bottom:5px;letter-spacing:.05em">BUSCAR PRODUCTO</label>
          <div style="display:flex;gap:8px">
            <input id="ent-buscar" type="text" placeholder="Nombre o código N10…"
              style="flex:1;border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:13px;background:var(--surface);color:var(--text-primary)">
          </div>
          <div id="ent-sugerencias" style="border:1px solid var(--border);border-radius:8px;background:var(--surface);margin-top:4px;display:none;max-height:200px;overflow-y:auto"></div>
        </div>

        <!-- Carrito -->
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);letter-spacing:.05em;margin-bottom:8px">PRODUCTOS EN ESTA ENTRADA</div>
        <div id="ent-carrito-wrap" style="border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:16px">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="background:var(--surface-2)">
                <th style="padding:8px 12px;text-align:left;font-size:11px;color:var(--text-muted);font-weight:700">PRODUCTO</th>
                <th style="padding:8px 12px;text-align:center;font-size:11px;color:var(--text-muted);font-weight:700">CAPTURADO</th>
                <th id="ent-th-cotejado" style="padding:8px 12px;text-align:center;font-size:11px;color:var(--text-muted);font-weight:700;display:none">FÍSICO CONTADO</th>
                <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-muted);font-weight:700">COSTO UNIT.</th>
                <th style="padding:8px 12px;text-align:right;font-size:11px;color:var(--text-muted);font-weight:700">SUBTOTAL</th>
                <th id="ent-th-accion" style="padding:8px 12px;text-align:center;font-size:11px;color:var(--text-muted);font-weight:700"></th>
              </tr>
            </thead>
            <tbody id="ent-carrito-tbody"></tbody>
          </table>
          <div id="ent-carrito-empty" style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px">
            Busca y agrega productos arriba
          </div>
        </div>

        <!-- Totales -->
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--surface-2);border-radius:8px;margin-bottom:16px">
          <span style="font-size:13px;color:var(--text-muted)">Total de compra</span>
          <span id="ent-total" style="font-size:18px;font-weight:800;color:var(--text-primary)">$0.00</span>
        </div>

        <!-- Alerta diferencia (cotejo) -->
        <div id="ent-alerta-dif" style="display:none;padding:10px 14px;background:rgba(220,38,38,.1);border-left:3px solid #DC2626;border-radius:6px;margin-bottom:14px;font-size:13px;color:#DC2626;font-weight:700">
          ⚠ Hay diferencias entre las cantidades capturadas y el conteo físico. Al confirmar, se registrará la cantidad física real.
        </div>

        <!-- Botones acción -->
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="ent-btn-cancelar" style="background:none;border:1px solid var(--border);border-radius:8px;padding:9px 20px;font-weight:600;cursor:pointer;color:var(--text-primary);font-size:13px">Cancelar</button>
          <button id="ent-btn-accion" style="background:var(--green-dark,#1B5E20);color:#fff;border:none;border-radius:8px;padding:9px 22px;font-weight:700;cursor:pointer;font-size:13px">Guardar borrador</button>
        </div>

      </div>
    </div>
  </div>

</div>
<style>
#ent-buscar:focus { outline:2px solid #16A34A; }
</style>`;
}

// ── Eventos ───────────────────────────────────────────────────
function _bindEvents() {
  const $ = id => _container.querySelector(`#${id}`);

  $("ent-filtro-estado")?.addEventListener("change", e => {
    _filtroEstado = e.target.value;
    _render();
  });

  $("ent-btn-nueva")?.addEventListener("click", _abrirModalNueva);
  $("ent-modal-close")?.addEventListener("click", _cerrarModal);
  $("ent-btn-cancelar")?.addEventListener("click", _cerrarModal);

  $("ent-modal-bg")?.addEventListener("click", e => {
    if (e.target === e.currentTarget) _cerrarModal();
  });

  // Buscador de productos con debounce
  let _searchTimer = null;
  $("ent-buscar")?.addEventListener("input", e => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => _buscarProducto(e.target.value), 180);
  });

  $("ent-btn-accion")?.addEventListener("click", _ejecutarAccion);
}

// ── Firestore listener ────────────────────────────────────────
function _escuchar() {
  const q = query(collection(db, "entradas_almacen"), orderBy("_ts", "desc"));
  _unsub = onSnapshot(q, snap => {
    _entradas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _render();
    _renderKpis();
  });
}

async function _cargarProductos() {
  if (_productos.length) return;
  const snap = await getDocs(collection(db, "productos"));
  _productos = snap.docs
    .map(d => {
      const data = d.data();
      // Normalizar: algunos docs usan `codigo`, otros `codigoN10`
      if (!data.codigoN10 && data.codigo) data.codigoN10 = data.codigo;
      return { id: d.id, ...data };
    })
    .filter(p => p.activo !== false)
    .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
}

// ── Render KPIs ───────────────────────────────────────────────
function _renderKpis() {
  const borradores  = _entradas.filter(e => e.estado === "BORRADOR").length;
  const enCotejo    = _entradas.filter(e => e.estado === "COTEJO").length;
  const confirmadas = _entradas.filter(e => e.estado === "CONFIRMADO").length;
  const totalValor  = _entradas
    .filter(e => e.estado === "CONFIRMADO")
    .reduce((s, e) => s + (e.totalCosto || 0), 0);

  const kpi = (icon, label, val, color) =>
    `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
      <div style="font-size:20px">${icon}</div>
      <div style="font-size:22px;font-weight:800;color:${color};font-variant-numeric:tabular-nums">${val}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${label}</div>
    </div>`;

  const wrap = _container.querySelector("#ent-kpis");
  if (wrap) wrap.innerHTML =
    kpi("📝", "Borradores",   borradores,  "#6B7280") +
    kpi("🔍", "En cotejo",    enCotejo,    "#2563EB") +
    kpi("✅", "Confirmadas",  confirmadas, "#16A34A") +
    kpi("💰", "Valor ingresado", `$${totalValor.toLocaleString("es-MX",{minimumFractionDigits:2,maximumFractionDigits:2})}`, "#7C3AED");
}

// ── Render tabla ──────────────────────────────────────────────
function _render() {
  const tbody = _container?.querySelector("#ent-tbody");
  if (!tbody) return;

  let lista = _entradas;
  if (_filtroEstado) lista = lista.filter(e => e.estado === _filtroEstado);

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text-muted)">
      ${_filtroEstado ? "No hay entradas con ese filtro" : "Sin entradas registradas — crea una nueva"}
    </td></tr>`;
    return;
  }

  tbody.innerHTML = lista.map(e => {
    const inf   = ESTADO_INFO[e.estado] || ESTADO_INFO.BORRADOR;
    const fecha = e._ts ? new Date(e._ts).toLocaleString("es-MX",{dateStyle:"short",timeStyle:"short"}) : "–";
    const total = (e.totalCosto || 0).toLocaleString("es-MX",{style:"currency",currency:"MXN"});
    const items = (e.items || []).length;
    const hasDif = e.hayDiferencia ? `<span title="Diferencia en cotejo" style="margin-left:6px;font-size:11px;background:#DC2626;color:#fff;padding:2px 6px;border-radius:4px;font-weight:700">⚠ DIF</span>` : "";

    let acciones = "";
    if (PUEDE()) {
      if (e.estado === "BORRADOR")
        acciones = `<button class="ent-btn-cotejo" data-id="${esc(e.id)}"
          style="background:#2563EB;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer">
          Iniciar cotejo</button>`;
      else if (e.estado === "COTEJO")
        acciones = `<button class="ent-btn-confirmar" data-id="${esc(e.id)}"
          style="background:#16A34A;color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:700;cursor:pointer">
          Confirmar</button>`;
    }

    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:10px 14px;font-weight:600;color:var(--text-primary)">${esc(e.proveedor || "–")}</td>
      <td style="padding:10px 14px;font-size:12px;color:var(--text-muted);font-family:monospace">${esc(e.referencia || "–")}</td>
      <td style="padding:10px 14px;font-size:12px;color:var(--text-muted);white-space:nowrap">${fecha}</td>
      <td style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text-primary)">${items}</td>
      <td style="padding:10px 14px;text-align:right;font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums">${total}</td>
      <td style="padding:10px 14px;text-align:center">
        <span style="background:${inf.bg};color:${inf.color};border-radius:5px;padding:3px 10px;font-size:11px;font-weight:700">${inf.label}</span>
        ${hasDif}
      </td>
      <td style="padding:10px 14px;text-align:center">${acciones}</td>
    </tr>`;
  }).join("");

  // Botones acción tabla
  tbody.querySelectorAll(".ent-btn-cotejo").forEach(btn =>
    btn.addEventListener("click", () => _abrirModalCotejo(btn.dataset.id)));
  tbody.querySelectorAll(".ent-btn-confirmar").forEach(btn =>
    btn.addEventListener("click", () => _abrirModalCotejo(btn.dataset.id)));
}

// ── Buscador productos ────────────────────────────────────────
function _buscarProducto(q) {
  const sug = _container?.querySelector("#ent-sugerencias");
  if (!sug) return;
  const term = norm(q.trim());
  if (!term) { sug.style.display = "none"; return; }

  const matches = _productos
    .filter(p => norm(p.nombre || "").includes(term) || norm(p.codigoN10 || "").includes(term))
    .slice(0, 8);

  if (!matches.length) { sug.style.display = "none"; return; }

  sug.style.display = "block";
  sug.innerHTML = matches.map(p =>
    `<div class="ent-sug-item" data-id="${esc(p.id)}"
      style="padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border);color:var(--text-primary)">
      <strong>${esc(p.nombre)}</strong>
      <span style="font-size:11px;color:var(--text-muted);margin-left:8px;font-family:monospace">${esc(p.codigoN10||"")}</span>
      <span style="float:right;font-size:11px;color:var(--text-muted)">${esc(p.unidad||"")}</span>
    </div>`
  ).join("");

  sug.querySelectorAll(".ent-sug-item").forEach(item =>
    item.addEventListener("click", () => {
      const prod = _productos.find(p => p.id === item.dataset.id);
      if (prod) _agregarAlCarrito(prod);
      sug.style.display = "none";
      const buscar = _container?.querySelector("#ent-buscar");
      if (buscar) buscar.value = "";
    })
  );
}

// ── Carrito ───────────────────────────────────────────────────
function _agregarAlCarrito(prod) {
  const idx = _carrito.findIndex(i => i.productoId === prod.id);
  if (idx >= 0) {
    _carrito[idx].cantidadCapturada += 1;
  } else {
    _carrito.push({
      productoId:       prod.id,
      nombre:           prod.nombre || "–",
      codigoN10:        prod.codigoN10 || "",
      unidad:           prod.unidad || "",
      cantidadCapturada: 1,
      cantidadCotejada:  1,
      costoUnitario:    prod.costoPromedio || prod.precioBase || 0,
    });
  }
  _renderCarrito(false);
}

function _renderCarrito(modoCotejo) {
  const tbody = _container?.querySelector("#ent-carrito-tbody");
  const empty = _container?.querySelector("#ent-carrito-empty");
  const total = _container?.querySelector("#ent-total");
  const thCot = _container?.querySelector("#ent-th-cotejado");
  const thAcc = _container?.querySelector("#ent-th-accion");
  if (!tbody) return;

  if (thCot) thCot.style.display = modoCotejo ? "" : "none";
  if (thAcc) thAcc.style.display = modoCotejo ? "none" : "";

  if (!_carrito.length) {
    tbody.innerHTML = "";
    if (empty) empty.style.display = "block";
    if (total) total.textContent = "$0.00";
    return;
  }
  if (empty) empty.style.display = "none";

  let totalVal = 0;
  tbody.innerHTML = _carrito.map((item, i) => {
    const sub = (item.cantidadCapturada || 0) * (item.costoUnitario || 0);
    totalVal += sub;
    const hasDif = modoCotejo && item.cantidadCotejada !== item.cantidadCapturada;
    const rowStyle = hasDif ? "border-left:3px solid #DC2626;background:rgba(220,38,38,.05)" : "";
    return `<tr style="border-bottom:1px solid var(--border);${rowStyle}">
      <td style="padding:8px 12px;color:var(--text-primary)">
        <div style="font-weight:700;font-size:13px">${esc(item.nombre)}</div>
        <div style="font-size:11px;color:var(--text-muted);font-family:monospace">${esc(item.codigoN10)}</div>
      </td>
      <td style="padding:8px 12px;text-align:center">
        ${modoCotejo
          ? `<span style="font-size:13px;font-weight:700;color:var(--text-muted)">${item.cantidadCapturada}</span>`
          : `<input type="number" class="ent-qty" data-idx="${i}" min="0.01" step="0.01" value="${item.cantidadCapturada}"
              style="width:70px;text-align:center;border:1px solid var(--border);border-radius:6px;padding:5px;font-size:13px;font-weight:700;background:var(--surface);color:var(--text-primary)">`
        }
      </td>
      ${modoCotejo ? `<td style="padding:8px 12px;text-align:center">
        <input type="number" class="ent-cotejado" data-idx="${i}" min="0" step="0.01" value="${item.cantidadCotejada}"
          style="width:70px;text-align:center;border:1px solid ${hasDif?"#DC2626":"var(--border)"};border-radius:6px;padding:5px;font-size:13px;font-weight:700;background:var(--surface);color:${hasDif?"#DC2626":"var(--text-primary)"}">
      </td>` : ""}
      <td style="padding:8px 12px;text-align:right">
        <input type="number" class="ent-costo" data-idx="${i}" min="0" step="0.01" value="${item.costoUnitario}"
          style="width:90px;text-align:right;border:1px solid var(--border);border-radius:6px;padding:5px;font-size:13px;background:var(--surface);color:var(--text-primary)">
      </td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;color:var(--text-primary);font-variant-numeric:tabular-nums">
        ${sub.toLocaleString("es-MX",{style:"currency",currency:"MXN"})}
      </td>
      ${!modoCotejo ? `<td style="padding:8px 12px;text-align:center">
        <button class="ent-remove" data-idx="${i}"
          style="background:none;border:none;color:#DC2626;font-size:18px;cursor:pointer;font-weight:700">×</button>
      </td>` : ""}
    </tr>`;
  }).join("");

  if (total) total.textContent = totalVal.toLocaleString("es-MX",{style:"currency",currency:"MXN"});

  // Listeners inputs
  tbody.querySelectorAll(".ent-qty").forEach(inp =>
    inp.addEventListener("change", e => {
      const idx = +e.target.dataset.idx;
      _carrito[idx].cantidadCapturada = Math.max(0.01, parseFloat(e.target.value) || 0.01);
      _carrito[idx].cantidadCotejada  = _carrito[idx].cantidadCapturada;
      _renderCarrito(modoCotejo);
    })
  );
  tbody.querySelectorAll(".ent-cotejado").forEach(inp =>
    inp.addEventListener("change", e => {
      const idx = +e.target.dataset.idx;
      _carrito[idx].cantidadCotejada = Math.max(0, parseFloat(e.target.value) || 0);
      _renderCarrito(modoCotejo);
      _actualizarAlertaDif();
    })
  );
  tbody.querySelectorAll(".ent-costo").forEach(inp =>
    inp.addEventListener("change", e => {
      const idx = +e.target.dataset.idx;
      _carrito[idx].costoUnitario = Math.max(0, parseFloat(e.target.value) || 0);
      _renderCarrito(modoCotejo);
    })
  );
  tbody.querySelectorAll(".ent-remove").forEach(btn =>
    btn.addEventListener("click", e => {
      _carrito.splice(+e.target.dataset.idx, 1);
      _renderCarrito(modoCotejo);
    })
  );
}

function _actualizarAlertaDif() {
  const hasDif = _carrito.some(i => i.cantidadCotejada !== i.cantidadCapturada);
  const alerta = _container?.querySelector("#ent-alerta-dif");
  if (alerta) alerta.style.display = hasDif ? "block" : "none";
}

// ── Modales ───────────────────────────────────────────────────
function _abrirModalNueva() {
  _carrito    = [];
  _editandoId = null;

  const $ = id => _container.querySelector(`#${id}`);
  $("ent-modal-titulo").textContent = "Nueva entrada de inventario";
  $("ent-modal-sub").textContent    = "Captura los productos y cantidades a ingresar al almacén";
  $("ent-btn-accion").textContent   = "Guardar borrador";
  $("ent-btn-accion").style.background = "#6B7280";
  $("ent-datos-generales").style.display = "";
  $("ent-buscador-wrap").style.display   = "";
  $("ent-f-proveedor").value  = "";
  $("ent-f-referencia").value = "";
  $("ent-alerta-dif").style.display = "none";

  _renderCarrito(false);
  $("ent-modal-bg").style.display = "block";
  _regEsc(_cerrarModal);
}

async function _abrirModalCotejo(entradaId) {
  const entrada = _entradas.find(e => e.id === entradaId);
  if (!entrada) return;

  _editandoId = entradaId;
  const modoCotejo = entrada.estado === "COTEJO";

  // Cargar items en carrito
  _carrito = (entrada.items || []).map(it => ({ ...it, cantidadCotejada: it.cantidadCotejada ?? it.cantidadCapturada }));

  const $ = id => _container.querySelector(`#${id}`);
  if (modoCotejo) {
    $("ent-modal-titulo").textContent = "Cotejo de entrada";
    $("ent-modal-sub").textContent    = `Verifica físicamente las cantidades — ${esc(entrada.proveedor || "")} · ${esc(entrada.referencia || "")}`;
    $("ent-btn-accion").textContent   = "Confirmar entrada";
    $("ent-btn-accion").style.background = "#16A34A";
  } else {
    $("ent-modal-titulo").textContent = "Iniciar cotejo";
    $("ent-modal-sub").textContent    = `Cambia estado a COTEJO y permite verificar cantidades físicas`;
    $("ent-btn-accion").textContent   = "Enviar a cotejo";
    $("ent-btn-accion").style.background = "#2563EB";
  }

  $("ent-datos-generales").style.display = "none";
  $("ent-buscador-wrap").style.display   = "none";
  $("ent-alerta-dif").style.display      = "none";

  _renderCarrito(true);
  $("ent-modal-bg").style.display = "block";
  _regEsc(_cerrarModal);
}

function _cerrarModal() {
  const bg = _container?.querySelector("#ent-modal-bg");
  if (bg) bg.style.display = "none";
  _unregEsc();
  _carrito    = [];
  _editandoId = null;
}

// ── Acción principal (guardar / enviar / confirmar) ───────────
async function _ejecutarAccion() {
  const btn = _container?.querySelector("#ent-btn-accion");
  if (!btn || btn.disabled) return;

  if (!_editandoId) {
    await _guardarBorrador();
  } else {
    const entrada = _entradas.find(e => e.id === _editandoId);
    if (!entrada) return;
    if (entrada.estado === "BORRADOR") await _enviarACotejo(entrada);
    else if (entrada.estado === "COTEJO") await _confirmarEntrada(entrada);
  }
}

async function _guardarBorrador() {
  const proveedor  = _container?.querySelector("#ent-f-proveedor")?.value.trim() || "";
  const referencia = _container?.querySelector("#ent-f-referencia")?.value.trim() || "";

  if (!proveedor) {
    alert("Ingresa el proveedor o fuente de la mercancía."); return;
  }
  if (!_carrito.length) {
    alert("Agrega al menos un producto."); return;
  }

  const totalCosto = _carrito.reduce((s, i) => s + i.cantidadCapturada * i.costoUnitario, 0);
  const ahora = Date.now();

  const data = {
    estado:       "BORRADOR",
    proveedor,
    referencia,
    _ts:          ahora,
    creadoPor:    Sesion.uid,
    creadoAlias:  Sesion.alias || Sesion.uid,
    hayDiferencia: false,
    totalCosto,
    items: _carrito.map(i => ({
      productoId:        i.productoId,
      nombre:            i.nombre,
      codigoN10:         i.codigoN10,
      unidad:            i.unidad,
      cantidadCapturada: i.cantidadCapturada,
      cantidadCotejada:  i.cantidadCapturada,
      costoUnitario:     i.costoUnitario,
      costoTotal:        i.cantidadCapturada * i.costoUnitario,
    })),
  };

  await addDoc(collection(db, "entradas_almacen"), data);
  logAudit("entrada_borrador", { proveedor, referencia, productos: _carrito.length });
  _cerrarModal();
}

async function _enviarACotejo(entrada) {
  await updateDoc(doc(db, "entradas_almacen", entrada.id), {
    estado:       "COTEJO",
    cotejoAlias:  Sesion.alias || Sesion.uid,
    cotejoPor:    Sesion.uid,
    tsCotejo:     Date.now(),
  });
  logAudit("entrada_cotejo", { id: entrada.id });
  _cerrarModal();
}

async function _confirmarEntrada(entrada) {
  if (!_carrito.length) return;

  const hayDif = _carrito.some(i => i.cantidadCotejada !== i.cantidadCapturada);
  const ahora  = Date.now();

  // Calcular nuevo totalCosto basado en cantidad cotejada
  const totalCosto = _carrito.reduce((s, i) => s + i.cantidadCotejada * i.costoUnitario, 0);

  const batch = writeBatch(db);

  // 1. Actualizar entrada
  const entradaRef = doc(db, "entradas_almacen", entrada.id);
  const itemsActualizados = _carrito.map(i => ({
    ...i,
    costoTotal: i.cantidadCotejada * i.costoUnitario,
    diferencia: i.cantidadCapturada - i.cantidadCotejada,
  }));
  batch.update(entradaRef, {
    estado:          "CONFIRMADO",
    items:           itemsActualizados,
    hayDiferencia:   hayDif,
    totalCosto,
    confirmadoPor:   Sesion.uid,
    confirmadoAlias: Sesion.alias || Sesion.uid,
    tsConfirmado:    ahora,
  });

  // 2. Actualizar stock y costo promedio por producto
  for (const item of _carrito) {
    const prodRef  = doc(db, "productos", item.productoId);
    const prodSnap = await getDoc(prodRef);
    if (!prodSnap.exists()) continue;

    const pd         = prodSnap.data();
    const stockActual = pd.stock || pd.stockActual || 0;
    const costoActual = pd.costoPromedio || 0;
    const nuevaCant   = item.cantidadCotejada;
    const stockNuevo  = stockActual + nuevaCant;

    // Costo promedio ponderado
    const nuevoCosto = stockActual + nuevaCant > 0
      ? (stockActual * costoActual + nuevaCant * item.costoUnitario) / (stockActual + nuevaCant)
      : item.costoUnitario;

    batch.update(prodRef, {
      stock:         stockNuevo,
      stockActual:   stockNuevo,
      costoPromedio: nuevoCosto,
      _ts:           ahora,
    });

    // 3. Sincronizar colección `inventario` (leída por inventario.js)
    // Key = codigoN10 cuando existe; si no, se omite (el módulo Inventario
    // solo muestra productos que ya tienen una entrada en esa colección)
    if (item.codigoN10) {
      const invRef = doc(db, "inventario", item.codigoN10);
      batch.set(invRef, {
        nombre:      item.nombre,
        stockActual: stockNuevo,
        unidad:      item.unidad || "",
        _ts:         ahora,
      }, { merge: true });
    }

    // 4. Kardex
    const movRef = doc(collection(db, "movimientos_stock"));
    batch.set(movRef, {
      tipo:           "ENTRADA_ALMACEN",
      entradaId:      entrada.id,
      productoId:     item.productoId,
      nombreProducto: item.nombre,
      codigoN10:      item.codigoN10,
      cantidad:       nuevaCant,
      costoUnitario:  item.costoUnitario,
      costoTotal:     nuevaCant * item.costoUnitario,
      stockAntes:     stockActual,
      stockDespues:   stockNuevo,
      proveedor:      entrada.proveedor || "",
      referencia:     entrada.referencia || "",
      quienRegistro:  Sesion.alias || Sesion.uid,
      _ts:            ahora,
    });
  }

  await batch.commit();
  logAudit("entrada_confirmada", { id: entrada.id, hayDif, productos: _carrito.length, totalCosto });
  _cerrarModal();
}
