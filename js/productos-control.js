// ══════════════════════════════════════════════════════════════
// productos-control.js — Catálogo de productos
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { Sesion } from "./auth.js";
import { norm } from "./app.js";
import { exportarExcel, descargarPlantilla, importarExcel, toolbarHTML, puedeImportar,
         descargarPlantillaStock, importarPlantillaStock } from "./excel-utils.js";
import {
  collection, doc, query, orderBy, onSnapshot,
  updateDoc, addDoc, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── ESC helper ───────────────────────────────────────────────
let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

// ── Columnas Excel ────────────────────────────────────────────
const _COLS_PROD = [
  { key: "codigo",         header: "Código N10",       width: 14, required: true },
  { key: "nombre",         header: "Nombre",            width: 30, required: true },
  { key: "descripcion",    header: "Descripción",       width: 30 },
  { key: "marca",          header: "Marca",             width: 16 },
  { key: "categoria",      header: "Categoría",         width: 16 },
  { key: "subcategoria",   header: "Subcategoría",      width: 16 },
  { key: "precio_base",    header: "Precio cliente",    width: 14, tipo: "numero" },
  { key: "clave_sat",      header: "Clave SAT",         width: 12 },
  { key: "peso",           header: "Peso",              width: 10, tipo: "numero" },
  { key: "impuesto",       header: "Impuesto",          width: 16 },
  { key: "activo",         header: "Activo (SI/NO)",    width: 12, tipo: "booleano" },
];

// ── Definición de todas las columnas disponibles ──────────────
const ALL_COLS = [
  { key: "check",          label: "✓",              locked: true  },
  { key: "foto",           label: "FOTO"                          },
  { key: "numero",         label: "ID"                            },
  { key: "codigo",         label: "CÓDIGO"                        },
  { key: "clave_sat",      label: "CLAVE SAT"                     },
  { key: "nombre_sucursal",label: "NOMBRE SUCURSAL"               },
  { key: "nombre",         label: "NOMBRE"                        },
  { key: "precio_base",    label: "PRECIO"                        },
  { key: "marca",          label: "MARCA"                         },
  { key: "categoria",      label: "CATEGORÍA"                     },
  { key: "peso",           label: "PESO"                          },
  { key: "stock",          label: "STOCK"                         },
  { key: "granel",         label: "GRANEL"                        },
  { key: "descripcion",    label: "DESCRIPCIÓN"                   },
  { key: "impuesto",       label: "CON O SIN IMPUESTO"            },
  { key: "materia_prima",  label: "MAT. PRIMA"                    },
  { key: "estado",         label: "ESTADO"                        },
  { key: "acciones",       label: "ACCIONES",       locked: true  },
];
const DEFAULT_COLS = ALL_COLS.map(c => c.key);
const LS_KEY = "n10_prod_cols";

function _loadCols() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (Array.isArray(saved) && saved.length > 0) {
      // Agregar columnas nuevas que no estén en el set guardado (excepto acciones que ya va al final)
      const missing = DEFAULT_COLS.filter(k => !saved.includes(k) && k !== "acciones");
      return missing.length ? [...saved.slice(0, -1), ...missing, "acciones"] : saved;
    }
  } catch {}
  return [...DEFAULT_COLS];
}
function _saveCols(cols) { localStorage.setItem(LS_KEY, JSON.stringify(cols)); }

// ── Funciones globales Excel ──────────────────────────────────
window.Prod_xlExport = async function() {
  try {
    const { getDocs, collection: col } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db: fdb } = await import("./firebase-config.js");
    const snap = await getDocs(col(fdb, "productos"));
    const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    exportarExcel(rows, _COLS_PROD, "Productos", "Productos");
  } catch(e) { window.toast?.("Error al exportar: " + e.message, "error"); console.error(e); }
};
window.Prod_xlPlantilla = function() { descargarPlantilla(_COLS_PROD, "Productos", "Productos"); };

// ── Stock: descargar plantilla e importar ─────────────────────
window.Prod_stockPlantilla = async function() {
  try {
    const { getDocs, collection: col } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db: fdb } = await import("./firebase-config.js");
    const snap = await getDocs(col(fdb, "productos"));
    const productos = snap.docs
      .map(d => ({ codigo: d.data().codigo || d.id, nombre: d.data().nombre || "" }))
      .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    descargarPlantillaStock(productos);
  } catch(e) { window.toast?.("Error al generar plantilla de stock.", "error"); console.error(e); }
};

window.Prod_stockImportar = async function() {
  if (!puedeImportar()) { window.toast?.("Sin permisos para importar.", "error"); return; }
  try {
    const registros = await importarPlantillaStock();
    if (!registros.length) return;
    const { getDocs, collection: col, doc: d, writeBatch } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db: fdb } = await import("./firebase-config.js");

    // Construir mapa codigo → { docId, invId }
    const snap = await getDocs(col(fdb, "productos"));
    const codigoMap = new Map();
    snap.docs.forEach(pd => {
      const data = pd.data();
      if (data.codigo) codigoMap.set(data.codigo, {
        docId: pd.id,
        invId: data.codigoN10 || data.codigo   // ID en colección inventario
      });
    });

    let ok = 0, noMatch = 0;
    const ts = Date.now();
    // Procesar en chunks de 249 (2 ops por registro: productos + inventario)
    const validos = registros.filter(r => codigoMap.has(r.codigo));
    noMatch = registros.length - validos.length;
    for (let i = 0; i < validos.length; i += 249) {
      const chunk = validos.slice(i, i + 249);
      const batch = writeBatch(fdb);
      for (const r of chunk) {
        const { docId, invId } = codigoMap.get(r.codigo);
        batch.update(d(fdb, "productos", docId), { stock: r.stock, stockActual: r.stock, actualizadoEn: new Date() });
        batch.set(d(fdb, "inventario", invId), { stockActual: r.stock, _ts: ts }, { merge: true });
        ok++;
      }
      await batch.commit();
    }
    window.toast?.(`Stock actualizado: ${ok} productos${noMatch ? `, ${noMatch} sin coincidencia` : ""}.`,
      ok > 0 ? "success" : "warning");
  } catch(e) { window.toast?.("Error al importar stock: " + e.message, "error"); console.error(e); }
};
window.Prod_xlImport = async function() {
  if (!puedeImportar()) { window.toast?.("Sin permisos para importar.", "error"); return; }
  try {
    const registros = await importarExcel(_COLS_PROD);
    if (!registros.length) return;
    const { doc: d, setDoc, serverTimestamp: st } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db: fdb } = await import("./firebase-config.js");
    let ok = 0, err = 0;
    for (const r of registros) {
      try {
        const id = r.codigo || r.id;
        await setDoc(d(fdb, "productos", id), { ...r, actualizadoPor: window.Sesion?.alias ?? "import", actualizadoEn: st() }, { merge: true });
        ok++;
      } catch { err++; }
    }
    window.toast?.(`Importación: ${ok} productos${err ? `, ${err} errores` : ""}.`, ok > 0 ? "success" : "error");
  } catch(e) { window.toast?.("Error en importación: " + e.message, "error"); console.error(e); }
};

const fmtMXN = v => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(v || 0);

const ROLES_LECTURA = ["SUPER_ADMIN","GERENTE","ADMINISTRADOR","GERENTE_ZONA"];
const PUEDE_EDITAR  = () => Sesion.esSuperAdmin() || Sesion.tieneFlag?.("PUEDE_EDITAR_PRECIO") || Sesion.rol === "GERENTE";

let _unsubs       = [];
let _todos        = [];
let _busqueda     = "";
let _filtroActivo = "todos";
let _colsVisibles = _loadCols();

export const ProductosControlModule = {
  mount(container) {
    if (!ROLES_LECTURA.includes(Sesion.rol) && !Sesion.esSuperAdmin()) {
      container.innerHTML = `<div class="empty-state" style="flex:1;justify-content:center">
        <div class="empty-state-icon">🔒</div>
        <div class="empty-state-title">Acceso restringido</div>
        <div class="empty-state-sub">Solo gerentes y administradores pueden ver el catálogo.</div>
      </div>`;
      return;
    }
    container.innerHTML = _html();
    document.getElementById("pc-tbody").innerHTML = window.skeleton?.(5, 6) ?? "";
    _bindUI();
    _escuchar();
    return () => this.destroy();
  },
  destroy() {
    _unsubs.forEach(fn => fn && fn());
    _unsubs = []; _todos = []; _busqueda = ""; _filtroActivo = "todos";
  }
};

// ── HTML principal ────────────────────────────────────────────
function _html() {
  return `
  <div id="pc-root" style="display:flex;flex-direction:column;height:100%;position:relative">

    <!-- ── Vista lista (tabla) ── -->
    <div id="pc-list-view" style="display:flex;flex-direction:column;height:100%">

      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;padding:14px 20px;
        border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;font-weight:800;color:var(--text-primary)">Catálogo de Productos</div>
          <div style="font-size:10.5px;color:#9CA3AF" id="pc-subtitle">Cargando…</div>
        </div>
        <div style="flex:1"></div>
        <input id="pc-buscar" type="text"
          placeholder="Buscar por Nombre / Descripción / Código / Clave SAT…"
          style="padding:7px 12px;border-radius:6px;border:1px solid var(--border);
            background:var(--surface);color:var(--text-primary);font-size:12px;width:280px">
        ${PUEDE_EDITAR() ? `
          <button onclick="ProdCtrlUI.abrirAltaProducto()"
            style="padding:7px 16px;border-radius:6px;border:none;background:#1B5E20;
              color:#fff;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">
            + Nuevo producto
          </button>` : ""}
        <button onclick="ProdCtrlUI.abrirConfigCols()" title="Configurar columnas"
          style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);
            background:var(--surface);color:var(--text-primary);font-size:12px;
            font-weight:600;cursor:pointer;white-space:nowrap;display:inline-flex;
            align-items:center;gap:5px">
          ⚙ Columnas
        </button>
      </div>

      <!-- KPIs -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;flex-shrink:0;
        border-bottom:1px solid var(--border)">
        ${[["pc-kpi-total","Total","#9CA3AF"],["pc-kpi-activos","Activos","#4ADE80"],
           ["pc-kpi-inact","Inactivos","#F87171"],["pc-kpi-sinprecio","Sin precio","#FBBF24"]
          ].map(([id,lbl,col]) => `
          <div style="padding:12px 18px;border-right:1px solid var(--border)">
            <div style="font-size:10px;color:#6B7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">${lbl}</div>
            <div id="${id}" style="font-size:18px;font-weight:800;color:${col}">–</div>
          </div>`).join("")}
      </div>

      <!-- Barra de acciones masivas (oculta hasta seleccionar) -->
      <div id="pc-bulk-bar" style="display:none;align-items:center;gap:10px;
        padding:10px 20px;background:#1e3a5f;border-bottom:1px solid #2563EB;flex-shrink:0">
        <span style="font-size:13px;font-weight:700;color:#93C5FD" id="pc-bulk-count">0 seleccionados</span>
        <div style="flex:1"></div>
        <button onclick="ProdCtrlUI.bulkExportar()"
          style="padding:6px 14px;border-radius:6px;border:1px solid #3B82F6;
            background:transparent;color:#93C5FD;font-size:12px;font-weight:700;cursor:pointer">
          ↓ Exportar Excel
        </button>
        <button onclick="ProdCtrlUI.bulkDesactivar()"
          style="padding:6px 14px;border-radius:6px;border:none;
            background:#DC2626;color:#fff;font-size:12px;font-weight:700;cursor:pointer">
          Desactivar seleccionados
        </button>
        <button onclick="ProdCtrlUI.toggleTodos(false)"
          style="padding:6px 10px;border-radius:6px;border:1px solid #374151;
            background:transparent;color:#9CA3AF;font-size:12px;cursor:pointer">
          ✕ Cancelar
        </button>
      </div>

      <!-- Filtros + toolbar -->
      <div style="display:flex;align-items:center;gap:8px;padding:10px 20px;
        border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap">
        ${["todos","activos","inactivos"].map(f => `
          <button class="filter-pill ${f==="todos"?"active":""}" data-filtro="${f}"
            onclick="ProdCtrlUI.setFiltro('${f}')">
            ${{todos:"Todos",activos:"Activos",inactivos:"Inactivos"}[f]}
          </button>`).join("")}
        <div style="flex:1"></div>
        ${puedeImportar() ? `
          <button onclick="Prod_stockPlantilla()" title="Descargar plantilla de actualización de stock"
            style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);
              background:var(--surface);color:var(--text-primary);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">
            📦 Plantilla Stock
          </button>
          <button onclick="Prod_stockImportar()" title="Importar stock desde Excel"
            style="padding:6px 12px;border-radius:6px;border:none;background:#1B5E20;
              color:#fff;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap">
            ⬆ Importar Stock
          </button>` : ""}
        ${toolbarHTML("Prod")}
      </div>

      <!-- Scrollbar espejo superior -->
      <div id="pc-topscroll"
        style="overflow-x:auto;overflow-y:hidden;height:14px;flex-shrink:0;
          border-bottom:1px solid var(--border);background:var(--surface-2)">
        <div id="pc-topscroll-inner" style="height:1px;min-width:1500px"></div>
      </div>

      <!-- Tabla -->
      <div id="pc-tablewrap" style="flex:1;overflow:auto;min-height:0" data-dual-done="1">
        <table style="border-collapse:collapse;font-size:12px;min-width:1500px;width:100%" id="pc-table">
          <thead id="pc-thead">
            <tr style="background:var(--surface-2);border-bottom:2px solid var(--border);
              position:sticky;top:0;z-index:2">
            </tr>
          </thead>
          <tbody id="pc-tbody">
            <tr><td colspan="16" style="text-align:center;color:#9CA3AF;padding:40px">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Vista de detalle de producto ── -->
    <div id="pc-detail-view" style="display:none;flex-direction:column;height:100%"></div>

    <!-- ── Modal Edición completa ── -->
    <div id="pc-modal-edit" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);
      z-index:1000;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--surface);border-radius:14px;width:560px;max-width:100%;
        max-height:90vh;overflow-y:auto;border:1px solid var(--border);padding:28px">
        <div style="font-size:15px;font-weight:800;color:var(--text-primary);margin-bottom:20px"
          id="pc-edit-titulo">Editar producto</div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          ${_field("pc-e-nombre",      "Nombre*",          "text",   "Nombre del producto")}
          ${_field("pc-e-codigo",      "Código N10",       "text",   "N10-0001")}
          ${_field("pc-e-clave_sat",   "Clave SAT",        "text",   "Ej. 10101502")}
          ${_field("pc-e-nombre_suc",  "Nombre Sucursal",  "text",   "Nutricion de 10")}
          ${_comboField("pc-e-marca",       "Marca",         "Selecciona o escribe…")}
          ${_comboField("pc-e-categoria",   "Categoría",     "Selecciona o escribe…")}
          ${_comboField("pc-e-subcategoria","Subcategoría",  "Selecciona o escribe…")}
          ${_field("pc-e-precio",      "Precio cliente ($)","number","0.00")}
          ${_field("pc-e-costo",       "Costo ($)",        "number", "0.00")}
          ${_field("pc-e-peso",        "Peso",             "number", "0.0")}
          <div>
            <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Embalaje / Unidad</label>
            <select id="pc-e-unidad"
              style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
                font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;appearance:auto"
              onchange="ProdCtrlUI.onUnidadChange(this)">
              <option value="">— Sin especificar —</option>
              <option value="Bulto">Bulto</option>
              <option value="Caja">Caja</option>
              <option value="Garrafa">Garrafa</option>
              <option value="Paquete">Paquete</option>
              <option value="Pieza">Pieza</option>
              <option value="Pieza granel">Pieza granel</option>
              <option value="Porrón">Porrón</option>
              <option value="__nueva__">+ Agregar nueva…</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Familia / tipo</label>
            <select id="pc-e-familia"
              onchange="document.getElementById('pc-e-litros-wrap').style.display=this.value==='N10'?'':'none'"
              style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
                font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;appearance:auto">
              <option value="">Estándar</option>
              <option value="N10">💧 N10 — Litros</option>
            </select>
          </div>
          <div id="pc-e-litros-wrap" style="display:none">
            ${_field("pc-e-litros_pu", "Litros por unidad", "number", "0.0")}
          </div>
        </div>

        <div style="margin-bottom:12px">
          <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Descripción</label>
          <textarea id="pc-e-descripcion" rows="2"
            style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
              font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;
              resize:vertical;font-family:inherit"></textarea>
        </div>

        <!-- ── Foto del producto ── -->
        <div style="margin-bottom:14px;border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--surface-2)">
          <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:8px">Foto del producto</label>
          <div style="display:flex;align-items:center;gap:12px">
            <div id="pc-foto-preview" style="width:72px;height:72px;border-radius:8px;border:1px solid var(--border);
              background:var(--surface);display:flex;align-items:center;justify-content:center;
              overflow:hidden;flex-shrink:0;font-size:28px">📷</div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <input type="file" id="pc-foto-input" accept="image/*" style="display:none"
                onchange="ProdCtrlUI.previsualizarFoto(this)">
              <button onclick="document.getElementById('pc-foto-input').click()"
                style="padding:6px 14px;border:1px solid var(--border);border-radius:6px;
                  background:transparent;color:var(--text-primary);font-size:11px;cursor:pointer;font-weight:600">
                📁 Seleccionar imagen
              </button>
              <button id="pc-foto-quitar-btn" onclick="ProdCtrlUI.quitarFotoProd()" style="display:none;
                padding:6px 14px;border:1px solid #FCA5A5;border-radius:6px;
                background:transparent;color:#DC2626;font-size:11px;cursor:pointer;font-weight:600">
                🗑 Quitar foto
              </button>
              <span style="font-size:10px;color:#6B7280">JPG, PNG o WEBP · máx 5 MB</span>
            </div>
          </div>
          <div id="pc-foto-progreso" style="display:none;margin-top:8px;font-size:11px;color:#6B7280">Subiendo foto…</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px">
          <div>
            <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">Impuesto</label>
            <select id="pc-e-impuesto"
              style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
                font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box">
              <option value="Exento">Exento de Impuesto</option>
              <option value="IVA">Con IVA 16%</option>
              <option value="IEPS">Con IEPS</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:10px;padding-top:18px">
            <label style="font-size:11px;font-weight:600;color:#6B7280">Materia prima</label>
            <input type="checkbox" id="pc-e-materia_prima" style="width:16px;height:16px;cursor:pointer">
            <label style="font-size:11px;font-weight:600;color:#6B7280;margin-left:16px">Activo</label>
            <input type="checkbox" id="pc-e-activo" style="width:16px;height:16px;cursor:pointer">
          </div>
        </div>

        <div id="pc-edit-error" style="display:none;background:#FEE2E2;border-radius:6px;
          padding:8px 12px;font-size:11.5px;color:#DC2626;margin-bottom:12px"></div>

        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button onclick="ProdCtrlUI.cerrarEdicion()"
            style="padding:8px 18px;border:1px solid var(--border);border-radius:6px;
              background:var(--surface-2,#F3F4F6);color:var(--text-primary);font-size:12px;
              font-weight:600;cursor:pointer">
            Cancelar
          </button>
          <button onclick="ProdCtrlUI.guardarEdicion()"
            style="padding:8px 22px;border:none;border-radius:6px;
              background:#1B5E20;color:#fff;font-size:12px;font-weight:700;cursor:pointer"
            id="pc-edit-save-btn">
            Guardar cambios
          </button>
        </div>
      </div>
    </div>

    <!-- ── Modal configuración de columnas ── -->
    <div id="pc-modal-cols" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);
      z-index:1000;align-items:center;justify-content:center;padding:16px">
      <div style="background:var(--surface);border-radius:14px;width:360px;max-width:100%;
        border:1px solid var(--border);padding:24px;max-height:90vh;overflow-y:auto">
        <div style="font-size:14px;font-weight:800;color:var(--text-primary);margin-bottom:4px">Configurar columnas</div>
        <div style="font-size:11px;color:#9CA3AF;margin-bottom:16px">Arrastra para reordenar · desmarca para ocultar</div>
        <ul id="pc-cols-list" style="list-style:none;padding:0;margin:0 0 18px;display:flex;flex-direction:column;gap:6px"></ul>
        <div style="display:flex;gap:8px;justify-content:space-between">
          <button onclick="ProdCtrlUI.resetCols()"
            style="padding:7px 14px;border:1px solid var(--border);border-radius:6px;
              background:var(--surface-2,#F3F4F6);color:var(--text-sec,#6B7280);font-size:11px;
              font-weight:600;cursor:pointer">Restablecer</button>
          <div style="display:flex;gap:8px">
            <button onclick="document.getElementById('pc-modal-cols').style.display='none'"
              style="padding:7px 14px;border:1px solid var(--border);border-radius:6px;
                background:var(--surface-2,#F3F4F6);color:var(--text-primary);font-size:12px;
                font-weight:600;cursor:pointer">Cancelar</button>
            <button onclick="ProdCtrlUI.guardarCols()"
              style="padding:7px 18px;border:none;border-radius:6px;
                background:#1B5E20;color:#fff;font-size:12px;font-weight:700;cursor:pointer">Aplicar</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function _th(extra) {
  return `padding:9px 10px;text-align:left;font-size:10px;font-weight:700;
    color:#9CA3AF;letter-spacing:.05em;white-space:nowrap;${extra || ""}`;
}

function _field(id, label, type, placeholder) {
  return `<div>
    <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">${label}</label>
    <input id="${id}" type="${type}" placeholder="${placeholder}"
      style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
        font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box"
      ${type==="number" ? 'min="0" step="0.01"' : 'maxlength="120"'}>
  </div>`;
}

// Select con opción "+ Agregar nueva…" para GERENTE/ADMIN
function _comboField(id, label, placeholder) {
  return `<div>
    <label style="font-size:11px;font-weight:600;color:#6B7280;display:block;margin-bottom:4px">${label}</label>
    <select id="${id}"
      style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;
        font-size:12px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;
        appearance:auto">
      <option value="">${placeholder}</option>
    </select>
  </div>`;
}

// ── Listener Firestore ────────────────────────────────────────
function _escuchar() {
  const q = query(collection(db, "productos"), orderBy("numero"), limit(2000));
  const unsub = onSnapshot(q, snap => {
    _todos = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
    _renderizar();
    _syncTopScrollWidth();
  }, err => {
    console.error("[Productos]", err);
    window.toast?.("Error al cargar productos", "error");
  });
  _unsubs.push(unsub);
}

// ── Catálogo de Marcas / Categorías / Subcategorías ───────────
const _cat = { marcas: [], categorias: [], subcategorias: [] };
const _CAT_KEYS = { "pc-e-marca": "marcas", "pc-e-categoria": "categorias", "pc-e-subcategoria": "subcategorias" };
const _PUEDE_CAT = () => Sesion.esSuperAdmin?.() || ["GERENTE","ADMINISTRADOR"].includes(Sesion.rol);

let _catCargado = false;

function _catLoad() {
  // Extrae valores únicos directamente de los productos ya cargados
  const campos = { marcas: "marca", categorias: "categoria", subcategorias: "subcategoria" };
  for (const [tipo, campo] of Object.entries(campos)) {
    const existentes = new Set(_cat[tipo]);
    _todos.forEach(p => { const v = (p[campo] || "").trim(); if (v) existentes.add(v); });
    _cat[tipo] = [...existentes].sort((a, b) => a.localeCompare(b, "es"));
  }
  _catCargado = true;
  return Promise.resolve();
}

function _catAgregar(tipo, valor) {
  valor = (valor || "").trim();
  if (!valor || _cat[tipo].includes(valor)) return;
  _cat[tipo] = [..._cat[tipo], valor].sort((a, b) => a.localeCompare(b, "es"));
}

const _CAT_TIPO_CAMPO = { marcas: "marca", categorias: "categoria", subcategorias: "subcategoria" };
const _CAT_CAMPO_TIPO = { marca: "marcas", categoria: "categorias", subcategoria: "subcategorias" };

// Rellena los <select> con las opciones del catálogo
function _catPopulateDatalist(currentValues = {}) {
  const campos = [
    { inputId: "pc-e-marca",        tipo: "marcas",        cur: currentValues.marca        || "" },
    { inputId: "pc-e-categoria",    tipo: "categorias",    cur: currentValues.categoria    || "" },
    { inputId: "pc-e-subcategoria", tipo: "subcategorias", cur: currentValues.subcategoria || "" },
  ];
  const puedeAgregar = _PUEDE_CAT();

  for (const { inputId, tipo, cur } of campos) {
    const sel = document.getElementById(inputId);
    if (!sel || sel.tagName !== "SELECT") continue;
    const campo = _CAT_TIPO_CAMPO[tipo];

    const opts = _cat[tipo].map(v =>
      `<option value="${esc(v)}">${esc(v)}</option>`
    ).join("");
    const addOpt = puedeAgregar
      ? `<option value="__nuevo__">+ Agregar nueva opción…</option>` : "";
    sel.innerHTML = `<option value="">Selecciona o escribe…</option>${opts}${addOpt}`;
    if (cur && _cat[tipo].includes(cur)) sel.value = cur;

    sel.onchange = async function() {
      if (sel.value !== "__nuevo__") return;
      const nombre = _CAT_TIPO_CAMPO[tipo];
      const nuevo = await window.promptModal?.({ title: `Nueva ${nombre}`, label: nombre, placeholder: `Escribe la nueva ${nombre.toLowerCase()}…` });
      if (nuevo && nuevo.trim()) {
        _catAgregar(tipo, nuevo.trim());
        _catPopulateDatalist({ ...currentValues, [campo]: nuevo.trim() });
      } else {
        sel.value = cur || "";
      }
    };
  }
}

// ── Render tabla ──────────────────────────────────────────────
function _renderizarHeader() {
  const row = document.querySelector("#pc-thead tr");
  if (!row) return;
  const cols = _colsVisibles;
  const puedeEditar = PUEDE_EDITAR();
  row.innerHTML = cols.map(key => {
    const meta = ALL_COLS.find(c => c.key === key);
    if (!meta) return "";
    if (key === "acciones" && !puedeEditar) return "";
    const wide = ["nombre","descripcion"].includes(key);
    if (key === "check") {
      return `<th style="${_th("width:36px;")}">
        <input type="checkbox" id="pc-chk-all" title="Seleccionar todos"
          style="cursor:pointer" onchange="ProdCtrlUI.toggleTodos(this.checked)">
      </th>`;
    }
    return `<th style="${_th(wide ? "min-width:180px;" : "")}">${meta.label}</th>`;
  }).join("");
}


function _renderizar() {
  const tbody = document.getElementById("pc-tbody");
  if (!tbody) return;

  const filtrados   = _aplicarFiltros();
  const puedeEditar = PUEDE_EDITAR();

  _renderizarHeader();

  // KPIs
  _setText("pc-kpi-total",    _todos.length);
  _setText("pc-kpi-activos",  _todos.filter(p => p.activo !== false).length);
  _setText("pc-kpi-inact",    _todos.filter(p => p.activo === false).length);
  _setText("pc-kpi-sinprecio",_todos.filter(p => !(p.precio_base > 0)).length);
  const sub = document.getElementById("pc-subtitle");
  if (sub) sub.textContent = `${filtrados.length} de ${_todos.length} productos`;

  if (!filtrados.length) {
    tbody.innerHTML = `<tr><td colspan="${_colsVisibles.length}" style="text-align:center;color:#9CA3AF;padding:40px">
      <div style="font-size:24px;margin-bottom:8px">📦</div>
      ${_busqueda ? "Sin resultados para la búsqueda." : "Sin productos en catálogo."}
    </td></tr>`;
    return;
  }

  const COL_TD = "padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;";

  tbody.innerHTML = filtrados.map((p, i) => {
    const activo   = p.activo !== false;
    const num      = p.numero ?? (i + 1);
    const codigo   = p.codigo || ("N10-" + String(Math.round(num)).padStart(4, "0"));
    const matPrima = p.materia_prima === true ? "Sí" : "–";
    const impuesto = !p.impuesto || p.impuesto === "Exento" ? "Exento de Impuesto"
                   : p.impuesto === "IVA" ? "Con IVA 16%"
                   : p.impuesto;

    const cells = _colsVisibles.map(key => {
      if (key === "acciones" && !puedeEditar) return "";
      switch(key) {
        case "check":
          return `<td style="${COL_TD}"><input type="checkbox" class="pc-chk-row" data-id="${esc(p._docId)}"
            style="cursor:pointer" onchange="ProdCtrlUI.bulkBarActualizar()"></td>`;
        case "foto":
          return p.fotoUrl
            ? `<td style="${COL_TD}text-align:center"><img src="${esc(p.fotoUrl)}" alt="foto"
                style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:zoom-in"
                onclick="(function(s){var o=document.createElement('div');o.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out';var i=document.createElement('img');i.src=s;i.style.cssText='max-width:90vw;max-height:90vh;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.5)';o.appendChild(i);o.onclick=function(){o.remove()};document.body.appendChild(o)})(this.src)" title="Ver foto"></td>`
            : `<td style="${COL_TD}text-align:center;color:#6B7280;font-size:18px">📷</td>`;
        case "numero":
          return `<td style="${COL_TD}color:#9CA3AF;font-variant-numeric:tabular-nums">${num}</td>`;
        case "codigo":
          return `<td style="${COL_TD}font-weight:700;color:var(--text-primary);font-family:monospace;cursor:pointer"
            onclick="ProdCtrlUI.abrirDetalle('${esc(p._docId)}')" title="Ver detalle">${esc(codigo)}</td>`;
        case "clave_sat":
          return `<td style="${COL_TD}color:#6B7280">${esc(p.clave_sat || "–")}</td>`;
        case "nombre_sucursal":
          return `<td style="${COL_TD}color:#6B7280">${esc(p.nombre_sucursal || "Nutricion de 10")}</td>`;
        case "nombre":
          return `<td style="${COL_TD}max-width:200px;overflow:hidden;text-overflow:ellipsis;
            font-weight:600;color:var(--text-primary);white-space:nowrap;cursor:pointer"
            title="${esc(p.nombre)}"
            onclick="ProdCtrlUI.abrirDetalle('${esc(p._docId)}')">${esc(p.nombre || "–")}</td>`;
        case "precio_base":
          return `<td style="${COL_TD}text-align:right;font-weight:700;font-variant-numeric:tabular-nums;
            color:${p.precio_base > 0 ? "#4ADE80" : "#9CA3AF"}">
            ${p.precio_base > 0 ? fmtMXN(p.precio_base) : "–"}</td>`;
        case "marca":
          return `<td style="${COL_TD}color:#6B7280">${esc(p.marca || "–")}</td>`;
        case "categoria":
          return `<td style="${COL_TD}color:#6B7280">${esc(p.categoria || "–")}</td>`;
        case "peso":
          return `<td style="${COL_TD}color:#6B7280;text-align:right">${p.peso > 0 ? p.peso : "–"}</td>`;
        case "stock":
          return `<td style="${COL_TD}color:#6B7280;text-align:right;font-variant-numeric:tabular-nums">${p.stock ?? "–"}</td>`;
        case "granel":
          return p.granel
            ? `<td style="${COL_TD}text-align:center">
                <span title="${p.granel_dosis||""}${p.granel_unidad||""}/dosis · $${p.granel_precio_dosis||0} · ${p.granel_partes||"?"}pzs"
                  style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;
                    background:#052e16;color:#4ADE80;font-size:10px;font-weight:700;border:1px solid #166534">
                  ✓ Granel
                </span>
              </td>`
            : `<td style="${COL_TD}text-align:center;color:#374151">–</td>`;
        case "descripcion":
          return `<td style="${COL_TD}max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            color:#9CA3AF" title="${esc(p.descripcion)}">${esc(p.descripcion || "–")}</td>`;
        case "impuesto":
          return `<td style="${COL_TD}color:#6B7280;white-space:nowrap">${esc(impuesto)}</td>`;
        case "materia_prima":
          return `<td style="${COL_TD}color:#6B7280;text-align:center">${matPrima}</td>`;
        case "estado":
          return `<td style="${COL_TD}text-align:center">
            <span style="font-size:10px;font-weight:700;padding:3px 10px;border-radius:9px;
              background:${activo?"#DCFCE7":"#FEE2E2"};color:${activo?"#166534":"#DC2626"}">
              ${activo ? "Activo" : "Inactivo"}
            </span></td>`;
        case "acciones":
          return `<td style="${COL_TD}">
            <div style="display:flex;gap:5px;align-items:center;white-space:nowrap">
              <button onclick="ProdCtrlUI.abrirEdicion('${esc(p._docId)}')" title="Editar"
                style="padding:3px 10px;border-radius:5px;border:1px solid #374151;
                  background:transparent;color:var(--text-primary);font-size:11px;cursor:pointer;font-weight:600">
                ✏ Editar
              </button>
              <button onclick="ProdCtrlUI.toggleActivo('${esc(p._docId)}',${!activo})"
                style="padding:3px 10px;border-radius:5px;border:none;font-size:11px;cursor:pointer;font-weight:600;
                  background:${activo?"#FEE2E2":"#DCFCE7"};color:${activo?"#DC2626":"#166534"}">
                ${activo ? "Desactivar" : "Activar"}
              </button>
            </div></td>`;
        default: return `<td style="${COL_TD}">–</td>`;
      }
    }).join("");

    return `<tr style="${!activo ? "opacity:.45;" : ""}background:${i%2===1?"var(--surface-2))":"transparent"}"
      >${cells}</tr>`;
  }).join("");
}

function _aplicarFiltros() {
  let lista = _todos;
  if (_filtroActivo === "activos")   lista = lista.filter(p => p.activo !== false);
  if (_filtroActivo === "inactivos") lista = lista.filter(p => p.activo === false);
  if (_busqueda.length >= 2) {
    const q = norm(_busqueda);
    lista = lista.filter(p =>
      norm(p.nombre      || "").includes(q) ||
      norm(p.descripcion || "").includes(q) ||
      norm(p.codigo      || "").includes(q) ||
      norm(p.clave_sat   || "").includes(q) ||
      norm(p.marca       || "").includes(q) ||
      norm(p.categoria   || "").includes(q)
    );
  }
  return lista;
}

// ── Sync scrollbar superior ───────────────────────────────────
function _syncTopScrollWidth() {
  const inner = document.getElementById("pc-topscroll-inner");
  const table = document.getElementById("pc-table");
  if (inner && table) inner.style.width = table.scrollWidth + "px";
}

// ── Vista de detalle ──────────────────────────────────────────
function _renderDetalle(docId) {
  const p = _todos.find(x => x._docId === docId);
  if (!p) return;

  const activo   = p.activo !== false;
  const num      = p.numero ?? "–";
  const codigo   = p.codigo || ("N10-" + String(Math.round(p.numero ?? 0)).padStart(4,"0"));
  const tieneIVA = p.impuesto === "IVA";
  const granel   = p.granel === true;

  const dv = document.getElementById("pc-detail-view");
  dv.innerHTML = `
    <!-- Barra superior -->
    <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;
      border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap">
      <button onclick="ProdCtrlUI.cerrarDetalle()"
        style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);
          background:var(--surface);color:var(--text-primary);font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px">
        ← Catálogo
      </button>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:800;color:var(--text-primary);white-space:nowrap;
          overflow:hidden;text-overflow:ellipsis">${esc(p.nombre || "Producto")}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:1px">
          ${esc(codigo)} · ID: ${num} · ${esc(p.marca || "Sin marca")} · ${esc(p.categoria || "Sin categoría")}
        </div>
      </div>
      <span style="padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;
        background:${activo?"#DCFCE7":"#FEE2E2"};color:${activo?"#166534":"#DC2626"}">
        ${activo ? "Activo" : "Inactivo"}
      </span>
      ${PUEDE_EDITAR() ? `
        <button onclick="ProdCtrlUI.abrirEdicion('${esc(docId)}')"
          style="padding:7px 14px;border-radius:6px;border:1px solid var(--border);
            background:var(--surface);color:var(--text-primary);font-size:12px;font-weight:600;cursor:pointer">
          ✏ Editar
        </button>
        <button onclick="ProdCtrlUI.toggleActivo('${esc(docId)}',${!activo})"
          style="padding:7px 14px;border-radius:6px;border:none;font-size:12px;font-weight:700;cursor:pointer;
            background:${activo?"#FEE2E2":"#DCFCE7"};color:${activo?"#DC2626":"#166534"}">
          ${activo ? "Desactivar" : "Activar"}
        </button>` : ""}
    </div>

    <!-- Tabs -->
    <div style="display:flex;gap:0;flex-shrink:0;border-bottom:1px solid var(--border);padding:0 20px">
      ${["general","precios","stock","granel"].map((t,i) => `
        <button class="pd-tab ${i===0?"pd-tab-active":""}" data-tab="${t}"
          onclick="ProdCtrlUI.switchTab('${t}')"
          style="padding:10px 18px;border:none;background:none;cursor:pointer;font-size:12px;font-weight:600;
            border-bottom:2px solid ${i===0?"#4ADE80":"transparent"};
            color:${i===0?"#4ADE80":"#9CA3AF"};margin-bottom:-1px;transition:all .15s">
          ${{general:"General",precios:"Precios",stock:"Stock",granel:"Venta a Granel"}[t]}
        </button>`).join("")}
    </div>

    <!-- Contenido tabs -->
    <div id="pd-body" style="flex:1;overflow:auto;padding:24px 20px;min-height:0">
      <!-- Tab general -->
      <div id="pd-tab-general">
        ${p.fotoUrl ? `
        <div style="margin-bottom:20px;display:flex;align-items:flex-start;gap:16px">
          <img src="${esc(p.fotoUrl)}" alt="${esc(p.nombre)}"
            style="width:120px;height:120px;object-fit:cover;border-radius:10px;
                   border:1px solid var(--border);flex-shrink:0;cursor:zoom-in"
            ondblclick="(function(el){
              const ov=document.createElement('div');
              ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
              const im=document.createElement('img');
              im.src=el.src;im.style.cssText='max-width:90vw;max-height:90vh;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,.5)';
              ov.appendChild(im);
              ov.onclick=()=>ov.remove();
              document.body.appendChild(ov);
            })(this)"
            title="Doble clic para ampliar">
          <div style="display:flex;flex-direction:column;justify-content:center;gap:4px">
            <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em">Foto del producto</div>
            <div style="font-size:11px;color:#6B7280">Doble clic para ampliar</div>
          </div>
        </div>` : ""}
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px">
          ${_dfield("Código N10",         esc(codigo))}
          ${_dfield("Clave SAT",          esc(p.clave_sat || "–"))}
          ${_dfield("Nombre Sucursal",     esc(p.nombre_sucursal || "Nutricion de 10"))}
          ${_dfield("Marca",              esc(p.marca || "–"))}
          ${_dfield("Categoría",          esc(p.categoria || "–"))}
          ${_dfield("Subcategoría",       esc(p.subcategoria || "–"))}
          ${_dfield("Embalaje / Unidad",   esc(p.unidad || "–"))}
          ${p.granel === true && p.granel_partes ? _dfield("Granel",
            `<span style="color:#4ADE80;font-weight:700">✓ Activo</span> &nbsp;·&nbsp; ${p.granel_dosis}${p.granel_unidad}/dosis &nbsp;·&nbsp; ${p.granel_partes} dosis/pieza &nbsp;·&nbsp; $${(p.granel_precio_dosis||0).toLocaleString("es-MX",{minimumFractionDigits:2})}`) : ""}
          ${_dfield("Peso",               p.peso > 0 ? p.peso + " kg" : "–")}
          ${_dfield("Familia",            p.familia === "N10" ? "💧 N10 — Litros" : "Estándar")}
          ${p.familia === "N10" ? _dfield("Litros por unidad", p.litros_por_unidad > 0 ? p.litros_por_unidad + " L" : "–") : ""}
          <div>
            <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Impuesto IVA</div>
            <div style="display:flex;align-items:center;gap:10px">
              ${PUEDE_EDITAR() ? `
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                  <div style="position:relative;width:40px;height:22px">
                    <input type="checkbox" id="pd-iva-toggle" ${tieneIVA?"checked":""}
                      style="opacity:0;position:absolute;inset:0;cursor:pointer;z-index:1"
                      onchange="ProdCtrlUI.toggleIVA('${esc(docId)}', this.checked)">
                    <div id="pd-iva-track" style="position:absolute;inset:0;border-radius:11px;
                      background:${tieneIVA?"#4ADE80":"#374151"};transition:background .2s"></div>
                    <div id="pd-iva-thumb" style="position:absolute;top:3px;left:${tieneIVA?"21px":"3px"};
                      width:16px;height:16px;border-radius:50%;background:var(--surface);transition:left .2s"></div>
                  </div>
                  <span id="pd-iva-label" style="font-size:13px;font-weight:700;color:${tieneIVA?"#4ADE80":"var(--text-primary)"}">
                    ${tieneIVA?"Con IVA 16%":"Sin IVA"}
                  </span>
                </label>` : `
                <span style="font-size:13px;font-weight:700;color:${tieneIVA?"#4ADE80":"var(--text-sec)"}">
                  ${tieneIVA?"Con IVA 16%":"Sin IVA"}
                </span>`}
            </div>
          </div>
          ${_dfield("Materia Prima",      p.materia_prima === true ? "Sí" : "No")}
          ${_dfield("Creado por",         esc(p.creadoPor || "–"))}
          ${_dfield("Modificado por",     esc(p.modificadoPor || "–") + (p.modificadoEn?.toDate ? ` <span style="font-size:10px;color:#9CA3AF;font-weight:400">· ${p.modificadoEn.toDate().toLocaleString("es-MX",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}</span>` : ""))}
        </div>
        ${p.descripcion ? `
          <div style="margin-top:20px">
            <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Descripción</div>
            <div style="font-size:13px;color:var(--text-primary);line-height:1.6;background:var(--surface-2));
              border-radius:8px;padding:12px 16px;border:1px solid var(--border)">${esc(p.descripcion)}</div>
          </div>` : ""}
      </div>

      <!-- Tab precios -->
      <div id="pd-tab-precios" style="display:none">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">
          ${_pkpi("Precio cliente", p.precio_base > 0 ? fmtMXN(p.precio_base) : "–", "#4ADE80")}
          ${_pkpi("Costo base",     p.costo_base  > 0 ? fmtMXN(p.costo_base)  : "–", "#9CA3AF")}
          ${p.precio_base > 0 && p.costo_base > 0 ? `
            ${_pkpi("Margen bruto", fmtMXN(p.precio_base - p.costo_base), "#FBBF24")}
            ${_pkpi("% Margen",     (((p.precio_base - p.costo_base) / p.precio_base) * 100).toFixed(1) + "%", "#60A5FA")}
          ` : ""}
        </div>
        <div style="margin-top:20px;padding:16px;background:var(--surface-2));
          border-radius:8px;border:1px solid var(--border);font-size:12px;color:#9CA3AF">
          Los precios por segmento se gestionan en <b style="color:var(--text-primary)">Precios por Segmento</b>.
        </div>
      </div>

      <!-- Tab stock -->
      <div id="pd-tab-stock" style="display:none">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px">
          ${_pkpi("Stock actual", p.stock ?? "–", p.stock > 0 ? "#4ADE80" : "#F87171")}
          ${_pkpi("Mínimo stock", p.stock_minimo ?? "–", "#9CA3AF")}
        </div>
        <div style="margin-top:20px;padding:16px;background:var(--surface-2));
          border-radius:8px;border:1px solid var(--border);font-size:12px;color:#9CA3AF">
          El stock se actualiza desde los movimientos de almacén (entradas / salidas de pedidos).
          Para ajuste manual usa el botón Editar en la barra superior.
        </div>
      </div>

      <!-- Tab granel -->
      <div id="pd-tab-granel" style="display:none">
        ${(() => {
          // Derivar cantidad total del envase desde el nombre del producto
          const nombreProd = p.nombre || "";
          let granelTotalDeriv = p.granel_total || 0;
          let granelUnidadDeriv = p.granel_unidad || "";
          if (!granelTotalDeriv) {
            const mNum = nombreProd.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|L|ml|lt|lts)\b/i);
            if (mNum) {
              const val = parseFloat(mNum[1].replace(",","."));
              const un  = mNum[2].toLowerCase().replace("lt","L").replace("lts","L");
              // Normalizar a unidad base
              if (un === "kg")       { granelTotalDeriv = val * 1000; granelUnidadDeriv = "g"; }
              else if (un === "g")   { granelTotalDeriv = val;        granelUnidadDeriv = "g"; }
              else if (un === "l")   { granelTotalDeriv = val * 1000; granelUnidadDeriv = "ml"; }
              else if (un === "ml")  { granelTotalDeriv = val;        granelUnidadDeriv = "ml"; }
            }
          }
          const dosisVal    = p.granel_dosis   || "";
          const precioVal   = p.granel_precio_dosis || "";
          const partes      = (dosisVal && granelTotalDeriv) ? Math.floor(granelTotalDeriv / dosisVal) : null;
          const unidadLabel = granelUnidadDeriv || "g";
          const derivMsg    = granelTotalDeriv && !p.granel_total
            ? `<span style="font-size:10px;color:#6B7280">Detectado del nombre: <b>${granelTotalDeriv}${unidadLabel}</b> — ajusta si es incorrecto</span>`
            : "";

          return `
          <div style="padding:16px;background:var(--surface-2));border-radius:10px;border:1px solid var(--border)">
            <!-- Header toggle -->
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:${granel?"20px":"0"}">
              <div style="flex:1">
                <div style="font-size:13px;font-weight:700;color:var(--text-primary)">Venta a Granel</div>
                <div style="font-size:11px;color:#9CA3AF;margin-top:2px">
                  Permite vender fracciones del producto con precio por dosis diferenciado
                </div>
              </div>
              ${PUEDE_EDITAR() ? `
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                  <div style="position:relative;width:40px;height:22px">
                    <input type="checkbox" id="pd-granel-toggle" ${granel?"checked":""}
                      style="opacity:0;position:absolute;inset:0;cursor:pointer;z-index:1"
                      onchange="ProdCtrlUI.toggleGranel('${esc(docId)}', this.checked)">
                    <div id="pd-granel-track" style="position:absolute;inset:0;border-radius:11px;
                      background:${granel?"#4ADE80":"#374151"};transition:background .2s"></div>
                    <div id="pd-granel-thumb" style="position:absolute;top:3px;left:${granel?"21px":"3px"};
                      width:16px;height:16px;border-radius:50%;background:var(--surface);transition:left .2s"></div>
                  </div>
                  <span style="font-size:12px;font-weight:600;color:${granel?"#4ADE80":"#9CA3AF"}">
                    ${granel?"Habilitado":"Deshabilitado"}
                  </span>
                </label>` : `<span style="font-size:12px;font-weight:700;color:${granel?"#4ADE80":"#9CA3AF"}">${granel?"Habilitado":"Deshabilitado"}</span>`}
            </div>

            ${granel ? `
              <div style="border-top:1px solid var(--border);padding-top:16px">

                <!-- Envase detectado -->
                <div style="margin-bottom:14px;padding:10px 14px;background:var(--surface);
                  border-radius:8px;border:1px solid var(--border);display:flex;align-items:center;gap:10px">
                  <div style="flex:1">
                    <div style="font-size:10px;color:#9CA3AF;margin-bottom:3px">CONTENIDO TOTAL DEL ENVASE</div>
                    <div style="display:flex;align-items:center;gap:8px">
                      <input type="number" id="pd-granel-total" value="${granelTotalDeriv || ""}" min="0.001" step="any"
                        ${!PUEDE_EDITAR()?"disabled":""}
                        oninput="ProdCtrlUI.recalcPartes()"
                        style="width:110px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;
                          font-size:13px;font-weight:700;background:var(--surface-2));color:var(--text-primary);box-sizing:border-box">
                      <select id="pd-granel-unidad" ${!PUEDE_EDITAR()?"disabled":""}
                        onchange="ProdCtrlUI.recalcPartes()"
                        style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;
                          font-size:13px;background:var(--surface-2));color:var(--text-primary)">
                        <option value="g"  ${unidadLabel==="g" ?"selected":""}>g</option>
                        <option value="ml" ${unidadLabel==="ml"?"selected":""}>ml</option>
                        <option value="kg" ${unidadLabel==="kg"?"selected":""}>kg</option>
                        <option value="L"  ${unidadLabel==="L" ?"selected":""}>L</option>
                      </select>
                    </div>
                    ${derivMsg}
                  </div>
                </div>

                <!-- 2 campos principales -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
                  <!-- Dosis -->
                  <div style="padding:14px;background:var(--surface);border-radius:8px;border:1px solid var(--border)">
                    <label style="font-size:10px;color:#9CA3AF;display:block;margin-bottom:6px;letter-spacing:.06em">
                      PESO / VOLUMEN DE LA DOSIS
                    </label>
                    <div style="display:flex;align-items:center;gap:6px">
                      <input type="number" id="pd-granel-dosis" value="${dosisVal}" min="0.001" step="any"
                        ${!PUEDE_EDITAR()?"disabled":""}
                        oninput="ProdCtrlUI.recalcPartes()"
                        style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
                          font-size:15px;font-weight:700;background:var(--surface-2));color:var(--text-primary);box-sizing:border-box">
                      <span id="pd-granel-unidad-label"
                        style="font-size:12px;color:#9CA3AF;font-weight:600;min-width:20px">${unidadLabel}</span>
                    </div>
                    <div style="font-size:10px;color:#9CA3AF;margin-top:6px">
                      Ej: 100 g por aplicación
                    </div>
                  </div>

                  <!-- Precio por dosis -->
                  <div style="padding:14px;background:var(--surface);border-radius:8px;border:1px solid var(--border)">
                    <label style="font-size:10px;color:#9CA3AF;display:block;margin-bottom:6px;letter-spacing:.06em">
                      PRECIO POR DOSIS ($)
                    </label>
                    <div style="display:flex;align-items:center;gap:6px">
                      <span style="font-size:13px;color:#9CA3AF;font-weight:600">$</span>
                      <input type="number" id="pd-granel-precio" value="${precioVal}" min="0" step="0.01"
                        ${!PUEDE_EDITAR()?"disabled":""}
                        style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:6px;
                          font-size:15px;font-weight:700;background:var(--surface-2));color:var(--text-primary);box-sizing:border-box">
                    </div>
                    <div style="font-size:10px;color:#9CA3AF;margin-top:6px">
                      Precio al menudeo — mayor al proporcional
                    </div>
                  </div>
                </div>

                <!-- Partes calculadas -->
                <div id="pd-granel-partes-box" style="padding:12px 16px;border-radius:8px;
                  background:${partes?"#052e16":"var(--surface)"};border:1px solid ${partes?"#166534":"var(--border)"};
                  display:flex;align-items:center;gap:10px;margin-bottom:14px">
                  <div style="font-size:20px">📦</div>
                  <div>
                    <span id="pd-granel-partes-num"
                      style="font-size:18px;font-weight:800;color:${partes?"#4ADE80":"#9CA3AF"}">
                      ${partes ?? "–"}
                    </span>
                    <span id="pd-granel-partes-label"
                      style="font-size:12px;color:${partes?"#86EFAC":"#9CA3AF"};margin-left:6px">
                      ${partes ? `dosis por pieza (${granelTotalDeriv}${unidadLabel} ÷ ${dosisVal}${unidadLabel})` : "Captura dosis para calcular las partes"}
                    </span>
                  </div>
                </div>

                ${PUEDE_EDITAR() ? `
                  <div style="text-align:right">
                    <button onclick="ProdCtrlUI.guardarGranel('${esc(docId)}')"
                      style="padding:8px 20px;border:none;border-radius:8px;
                        background:#16a34a;color:#fff;font-size:13px;font-weight:700;cursor:pointer">
                      Guardar configuración granel
                    </button>
                  </div>` : ""}
              </div>
            ` : `
              <div style="text-align:center;padding:32px 0;color:#9CA3AF;font-size:12px">
                Activa el toggle para configurar precio y dosis de venta al menudeo.
              </div>
            `}
          </div>`;
        })()}
      </div>
    </div>`;
}

// Helpers para campos de detalle
function _dfield(label, val) {
  return `<div>
    <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">${label}</div>
    <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${val}</div>
  </div>`;
}
function _pkpi(label, val, color) {
  return `<div style="background:var(--surface-2));border:1px solid var(--border);
    border-radius:10px;padding:16px">
    <div style="font-size:10px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${label}</div>
    <div style="font-size:22px;font-weight:800;color:${color};font-variant-numeric:tabular-nums">${val}</div>
  </div>`;
}

// ── UI Actions ────────────────────────────────────────────────
function _bindUI() {
  let _editandoId = null;

  const input = document.getElementById("pc-buscar");
  if (input) {
    let t;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => { _busqueda = input.value.trim(); _renderizar(); _syncTopScrollWidth(); }, 250);
    });
  }

  // Sync scrollbars superior / inferior
  const topScroll  = document.getElementById("pc-topscroll");
  const tableWrap  = document.getElementById("pc-tablewrap");
  if (topScroll && tableWrap) {
    let _syncing = false;
    topScroll.addEventListener("scroll", () => {
      if (_syncing) return; _syncing = true;
      tableWrap.scrollLeft = topScroll.scrollLeft;
      _syncing = false;
    });
    tableWrap.addEventListener("scroll", () => {
      if (_syncing) return; _syncing = true;
      topScroll.scrollLeft = tableWrap.scrollLeft;
      _syncing = false;
    });
  }

  // ── Estado foto ──────────────────────────────────────────────
  let _fotoFile   = null;   // File seleccionado pendiente de subir
  let _fotoUrlActual = null; // URL ya guardada en Firestore
  let _fotoEliminada = false;

  function _resetFotoUI(url) {
    _fotoFile = null;
    _fotoUrlActual = url;
    _fotoEliminada = false;
    const prev   = document.getElementById("pc-foto-preview");
    const inp    = document.getElementById("pc-foto-input");
    const btnQ   = document.getElementById("pc-foto-quitar-btn");
    const prog   = document.getElementById("pc-foto-progreso");
    if (inp)  inp.value = "";
    if (prog) prog.style.display = "none";
    if (prev) {
      if (url) {
        prev.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover">`;
        if (btnQ) btnQ.style.display = "";
      } else {
        prev.innerHTML = "📷";
        if (btnQ) btnQ.style.display = "none";
      }
    }
  }

  window.ProdCtrlUI = {

    onUnidadChange(sel) {
      if (sel.value !== "__nueva__") return;
      const nueva = prompt("Nombre del nuevo embalaje/unidad:");
      if (!nueva || !nueva.trim()) { sel.value = ""; return; }
      const val = nueva.trim();
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = val;
      sel.insertBefore(opt, sel.querySelector("[value='__nueva__']"));
      sel.value = val;
    },

    setFiltro(f) {
      _filtroActivo = f;
      document.querySelectorAll("[data-filtro]").forEach(b =>
        b.classList.toggle("active", b.dataset.filtro === f));
      _renderizar();
      _syncTopScrollWidth();
    },

    bulkBarActualizar() {
      const checks = [...document.querySelectorAll(".pc-chk-row:checked")];
      const bar = document.getElementById("pc-bulk-bar");
      const lbl = document.getElementById("pc-bulk-count");
      if (!bar) return;
      if (checks.length > 0) {
        bar.style.display = "flex";
        if (lbl) lbl.textContent = `${checks.length} seleccionado${checks.length > 1 ? "s" : ""}`;
      } else {
        bar.style.display = "none";
      }
      const all = document.querySelectorAll(".pc-chk-row");
      const chkAll = document.getElementById("pc-chk-all");
      if (chkAll) chkAll.indeterminate = checks.length > 0 && checks.length < all.length;
      if (chkAll && checks.length === all.length && all.length > 0) chkAll.checked = true;
      if (chkAll && checks.length === 0) chkAll.checked = false;
    },

    toggleTodos(checked) {
      document.querySelectorAll(".pc-chk-row").forEach(c => { c.checked = checked; });
      this.bulkBarActualizar();
    },

    _getCheckedIds() {
      return [...document.querySelectorAll(".pc-chk-row:checked")].map(c => c.dataset.id);
    },

    async bulkDesactivar() {
      const ids = this._getCheckedIds();
      if (!ids.length) return;
      if (!confirm(`¿Desactivar ${ids.length} producto${ids.length > 1 ? "s" : ""}? Esta acción se puede revertir.`)) return;
      try {
        const batch = writeBatch(db);
        ids.forEach(id => batch.update(doc(db, "productos", id), {
          activo: false, modificadoPor: Sesion.alias, modificadoEn: serverTimestamp()
        }));
        await batch.commit();
        window.toast?.(`${ids.length} producto${ids.length > 1 ? "s" : ""} desactivado${ids.length > 1 ? "s" : ""}.`, "success");
        document.getElementById("pc-bulk-bar").style.display = "none";
      } catch(e) { window.toast?.("Error al desactivar: " + e.message, "error"); }
    },

    bulkExportar() {
      const ids = new Set(this._getCheckedIds());
      const seleccionados = _todos.filter(p => ids.has(p._docId));
      if (!seleccionados.length) return;
      const filas = seleccionados.map(p => ({
        "Código N10":  p.codigo || "",
        "ID":          p.numero || "",
        "Nombre":      p.nombre || "",
        "Precio":      p.precio_base || 0,
        "Costo":       p.costo_base  || 0,
        "Marca":       p.marca || "",
        "Categoría":   p.categoria || "",
        "Unidad":      p.unidad || "",
        "Peso (kg)":   p.peso || "",
        "Stock":       p.stock || 0,
        "Activo":      p.activo !== false ? "Sí" : "No",
        "Granel":        p.granel ? "Sí" : "No",
        "Dosis":         p.granel_dosis ? `${p.granel_dosis}${p.granel_unidad}` : "",
        "Partes/pieza":  p.granel_partes || "",
        "Precio dosis":  p.granel_precio_dosis || "",
      }));
      exportarExcelProductos?.(filas, `productos_seleccionados_${ids.size}`);
      window.toast?.(`Excel con ${ids.size} productos generado.`, "success");
    },

    // ── Vista de detalle ──────────────────────────────────────
    abrirDetalle(docId) {
      document.getElementById("pc-list-view").style.display = "none";
      const dv = document.getElementById("pc-detail-view");
      dv.style.display = "flex";
      _renderDetalle(docId);
    },

    cerrarDetalle() {
      document.getElementById("pc-detail-view").style.display = "none";
      document.getElementById("pc-list-view").style.display = "flex";
    },

    switchTab(tab) {
      ["general","precios","stock","granel"].forEach(t => {
        const el = document.getElementById(`pd-tab-${t}`);
        if (el) el.style.display = t === tab ? "block" : "none";
      });
      document.querySelectorAll(".pd-tab").forEach(btn => {
        const active = btn.dataset.tab === tab;
        btn.style.borderBottomColor = active ? "#4ADE80" : "transparent";
        btn.style.color = active ? "#4ADE80" : "#9CA3AF";
      });
    },

    recalcPartes() {
      const total  = parseFloat(document.getElementById("pd-granel-total")?.value)  || 0;
      const dosis  = parseFloat(document.getElementById("pd-granel-dosis")?.value)  || 0;
      const unidad = document.getElementById("pd-granel-unidad")?.value || "g";
      // Sincronizar etiqueta de unidad junto al campo dosis
      const lbl = document.getElementById("pd-granel-unidad-label");
      if (lbl) lbl.textContent = unidad;
      const box = document.getElementById("pd-granel-partes-box");
      const num = document.getElementById("pd-granel-partes-num");
      const lab = document.getElementById("pd-granel-partes-label");
      if (!num) return;
      if (total > 0 && dosis > 0) {
        const partes = Math.floor(total / dosis);
        num.textContent = partes;
        num.style.color = "#4ADE80";
        if (lab) { lab.textContent = `dosis por pieza (${total}${unidad} ÷ ${dosis}${unidad})`; lab.style.color = "#86EFAC"; }
        if (box) { box.style.background = "#052e16"; box.style.borderColor = "#166534"; }
      } else {
        num.textContent = "–"; num.style.color = "#9CA3AF";
        if (lab) { lab.textContent = "Captura dosis para calcular las partes"; lab.style.color = "#9CA3AF"; }
        if (box) { box.style.background = "var(--surface)"; box.style.borderColor = "var(--border)"; }
      }
    },

    async toggleIVA(docId, enabled) {
      const track = document.getElementById("pd-iva-track");
      const thumb = document.getElementById("pd-iva-thumb");
      const label = document.getElementById("pd-iva-label");
      if (track) track.style.background = enabled ? "#4ADE80" : "#374151";
      if (thumb) thumb.style.left = enabled ? "21px" : "3px";
      if (label) { label.textContent = enabled ? "Con IVA 16%" : "Sin IVA"; label.style.color = enabled ? "#4ADE80" : "var(--text-primary)"; }
      try {
        await updateDoc(doc(db, "productos", docId), {
          impuesto: enabled ? "IVA" : "Exento",
          modificadoPor: Sesion.alias, modificadoEn: serverTimestamp()
        });
        const p = _todos.find(x => x._docId === docId);
        if (p) p.impuesto = enabled ? "IVA" : "Exento";
        window.toast?.(enabled ? "IVA 16% activado para este producto." : "IVA desactivado — producto exento.", "success");
      } catch(e) {
        window.toast?.("Error: " + e.message, "error");
      }
    },

    async toggleGranel(docId, enabled) {
      const track = document.getElementById("pd-granel-track");
      const thumb = document.getElementById("pd-granel-thumb");
      if (track) track.style.background = enabled ? "#4ADE80" : "#374151";
      if (thumb) thumb.style.left = enabled ? "21px" : "3px";
      try {
        await updateDoc(doc(db, "productos", docId), {
          granel: enabled, modificadoPor: Sesion.alias, modificadoEn: serverTimestamp()
        });
        // Re-render detail to show/hide granel fields
        setTimeout(() => _renderDetalle(docId), 300);
      } catch(e) {
        window.toast?.("Error: " + e.message, "error");
      }
    },

    async guardarGranel(docId) {
      const total  = parseFloat(document.getElementById("pd-granel-total")?.value)  || 0;
      const dosis  = parseFloat(document.getElementById("pd-granel-dosis")?.value)  || 0;
      const precio = parseFloat(document.getElementById("pd-granel-precio")?.value) || 0;
      const unidad = document.getElementById("pd-granel-unidad")?.value || "g";
      if (!total || !dosis || !precio) {
        window.toast?.("Completa contenido total, dosis y precio por dosis.", "error"); return;
      }
      if (dosis >= total) {
        window.toast?.("La dosis no puede ser mayor o igual al contenido total del envase.", "error"); return;
      }
      const partes = Math.floor(total / dosis);
      try {
        await updateDoc(doc(db, "productos", docId), {
          granel_total:       total,
          granel_dosis:       dosis,
          granel_unidad:      unidad,
          granel_precio_dosis: precio,
          granel_partes:      partes,
          modificadoPor: Sesion.alias, modificadoEn: serverTimestamp()
        });
        window.toast?.(`Configuración granel guardada — ${partes} dosis de ${dosis}${unidad} por pieza.`, "success");
      } catch(e) {
        window.toast?.("Error: " + e.message, "error");
      }
    },

    // ── Configuración de columnas ─────────────────────────────
    abrirConfigCols() {
      const list = document.getElementById("pc-cols-list");
      if (!list) return;

      // Construir orden actual: primero los que están en _colsVisibles, luego los que no
      const ordered = [
        ..._colsVisibles,
        ...ALL_COLS.map(c => c.key).filter(k => !_colsVisibles.includes(k))
      ];

      list.innerHTML = ordered.map(key => {
        const meta = ALL_COLS.find(c => c.key === key);
        if (!meta) return "";
        const visible = _colsVisibles.includes(key);
        return `<li data-col="${key}" draggable="${!meta.locked}"
          style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;
            border:1px solid var(--border);background:var(--surface);cursor:${meta.locked?"default":"grab"};
            user-select:none;transition:opacity .15s;${!visible?"opacity:.45":""}">
          <span style="font-size:14px;color:#9CA3AF">${meta.locked ? "⊝" : "⠿"}</span>
          <span style="flex:1;font-size:12px;font-weight:600;color:var(--text-primary)">${meta.label}</span>
          <input type="checkbox" ${visible?"checked":""} ${meta.locked?"disabled":""} style="cursor:pointer"
            onchange="this.closest('li').style.opacity=this.checked?'1':'.45'">
        </li>`;
      }).join("");

      // Drag & drop — pointer events (funciona en táctil y mouse)
      let _dragSrc = null;
      const _liOpacity = li => li.querySelector("input")?.checked !== false ? "1" : ".45";
      list.addEventListener("pointerdown", e => {
        const li = e.target.closest("li[draggable='true']");
        if (!li || e.target.tagName === "INPUT") return;
        e.preventDefault();
        _dragSrc = li;
        list.setPointerCapture(e.pointerId);
        li.style.opacity = ".35";
        li.style.boxShadow = "0 4px 14px rgba(0,0,0,.18)";
      }, { passive: false });
      list.addEventListener("pointermove", e => {
        if (!_dragSrc) return;
        e.preventDefault();
        const all = [...list.querySelectorAll("li")];
        const over = all.find(li => {
          if (li === _dragSrc) return false;
          const r = li.getBoundingClientRect();
          return e.clientY >= r.top && e.clientY <= r.bottom;
        });
        if (over) {
          const fi = all.indexOf(_dragSrc), ti = all.indexOf(over);
          if (fi < ti) list.insertBefore(_dragSrc, over.nextSibling);
          else         list.insertBefore(_dragSrc, over);
        }
      }, { passive: false });
      const _endDrag = () => {
        if (!_dragSrc) return;
        _dragSrc.style.opacity = _liOpacity(_dragSrc);
        _dragSrc.style.boxShadow = "";
        _dragSrc = null;
      };
      list.addEventListener("pointerup",     _endDrag);
      list.addEventListener("pointercancel", _endDrag);

      document.getElementById("pc-modal-cols").style.display = "flex";
      _regEsc(() => { document.getElementById("pc-modal-cols").style.display = "none"; _unregEsc(); });
    },

    guardarCols() {
      const list = document.getElementById("pc-cols-list");
      if (!list) return;
      const newCols = [...list.querySelectorAll("li")].filter(li => {
        const meta = ALL_COLS.find(c => c.key === li.dataset.col);
        return meta?.locked || li.querySelector("input")?.checked;
      }).map(li => li.dataset.col);

      _colsVisibles = newCols;
      _saveCols(newCols);
      document.getElementById("pc-modal-cols").style.display = "none";
      _renderizar();
      _syncTopScrollWidth();
    },

    resetCols() {
      _colsVisibles = [...DEFAULT_COLS];
      _saveCols(_colsVisibles);
      document.getElementById("pc-modal-cols").style.display = "none";
      _renderizar();
      _syncTopScrollWidth();
    },

    // ── Editar producto completo ──────────────────────────────
    abrirEdicion(docId) {
      const p = _todos.find(x => x._docId === docId);
      if (!p) return;
      _editandoId = docId;
      _catLoad().then(() => _catPopulateDatalist({ marca: p.marca, categoria: p.categoria, subcategoria: p.subcategoria }));

      _val("pc-e-nombre",       p.nombre      ?? "");
      _val("pc-e-codigo",       p.codigo      ?? docId);
      // El código N10 es inmutable una vez asignado
      const codigoEl = document.getElementById("pc-e-codigo");
      if (codigoEl) { codigoEl.readOnly = true; codigoEl.style.opacity = "0.6"; codigoEl.title = "El código N10 es permanente y no puede modificarse"; }
      _val("pc-e-clave_sat",    p.clave_sat   ?? "");
      _val("pc-e-nombre_suc",   p.nombre_sucursal ?? "Nutricion de 10");
      // pc-e-marca/categoria/subcategoria son <select> — los rellena _catPopulateDatalist
      _val("pc-e-precio",       p.precio_base ?? "");
      _val("pc-e-costo",        p.costo_base  ?? "");
      _val("pc-e-peso",         p.peso        ?? "");
      _val("pc-e-descripcion",  p.descripcion ?? "");

      // Embalaje / Unidad
      const selUnidad = document.getElementById("pc-e-unidad");
      if (selUnidad) {
        const unidadVal = p.unidad ?? "";
        const existe = [...selUnidad.options].some(o => o.value === unidadVal);
        if (unidadVal && !existe) {
          const opt = document.createElement("option");
          opt.value = unidadVal; opt.textContent = unidadVal;
          selUnidad.insertBefore(opt, selUnidad.querySelector("[value='__nueva__']"));
        }
        selUnidad.value = unidadVal;
      }

      const selImp = document.getElementById("pc-e-impuesto");
      if (selImp) selImp.value = p.impuesto ?? "Exento";

      const chkMat = document.getElementById("pc-e-materia_prima");
      if (chkMat) chkMat.checked = p.materia_prima === true;

      const chkAct = document.getElementById("pc-e-activo");
      if (chkAct) chkAct.checked = p.activo !== false;

      const selFam = document.getElementById("pc-e-familia");
      if (selFam) {
        selFam.value = p.familia ?? "";
        const wrap = document.getElementById("pc-e-litros-wrap");
        if (wrap) wrap.style.display = selFam.value === "N10" ? "" : "none";
      }
      _val("pc-e-litros_pu", p.litros_por_unidad ?? "");

      _setText("pc-edit-titulo", `Editar: ${p.nombre || docId}`);
      const err = document.getElementById("pc-edit-error");
      if (err) err.style.display = "none";

      // Cargar foto actual
      _resetFotoUI(p.fotoUrl || null);

      document.getElementById("pc-modal-edit").style.display = "flex";
      _regEsc(() => ProdCtrlUI.cerrarEdicion());
      setTimeout(() => document.getElementById("pc-e-nombre")?.focus(), 80);
    },

    cerrarEdicion() {
      _unregEsc();
      document.getElementById("pc-modal-edit").style.display = "none";
      _editandoId = null;
      _fotoFile = null;
    },

    previsualizarFoto(input) {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { window.toast?.("La imagen supera 5 MB.", "error"); return; }
      _fotoFile = file;
      _fotoEliminada = false;
      const prev = document.getElementById("pc-foto-preview");
      const btnQ = document.getElementById("pc-foto-quitar-btn");
      if (prev) {
        const reader = new FileReader();
        reader.onload = e => {
          prev.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;
          if (btnQ) btnQ.style.display = "";
        };
        reader.readAsDataURL(file);
      }
    },

    quitarFotoProd() {
      _fotoFile = null;
      _fotoEliminada = true;
      const prev = document.getElementById("pc-foto-preview");
      const inp  = document.getElementById("pc-foto-input");
      const btnQ = document.getElementById("pc-foto-quitar-btn");
      if (prev) prev.innerHTML = "📷";
      if (inp)  inp.value = "";
      if (btnQ) btnQ.style.display = "none";
    },

    async guardarEdicion() {
      const esNuevo = !_editandoId;
      const nombre  = document.getElementById("pc-e-nombre")?.value.trim();
      const errEl   = document.getElementById("pc-edit-error");
      if (!nombre) { errEl.textContent = "El nombre es obligatorio."; errEl.style.display = "block"; return; }
      const btn = document.getElementById("pc-edit-save-btn");
      if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }

      try {
        const p = esNuevo ? null : _todos.find(x => x._docId === _editandoId);
        const codigoInput = document.getElementById("pc-e-codigo")?.value.trim();
        const nextNum  = esNuevo ? Math.max(..._todos.map(x => x.numero ?? 0), 0) + 1 : (p?.numero ?? 0);
        const codigo   = codigoInput || p?.codigo || ("N10-" + String(Math.round(nextNum)).padStart(4, "0"));

        const data = {
          nombre,
          codigo,
          clave_sat:       document.getElementById("pc-e-clave_sat")?.value.trim()    || "",
          nombre_sucursal: document.getElementById("pc-e-nombre_suc")?.value.trim()  || "Nutricion de 10",
          marca:           document.getElementById("pc-e-marca")?.value.trim()        || "",
          categoria:       document.getElementById("pc-e-categoria")?.value.trim()    || "",
          subcategoria:    document.getElementById("pc-e-subcategoria")?.value.trim() || "",
          descripcion:     document.getElementById("pc-e-descripcion")?.value.trim()  || "",
          precio_base:     parseFloat(document.getElementById("pc-e-precio")?.value) || 0,
          costo_base:      parseFloat(document.getElementById("pc-e-costo")?.value)  || 0,
          peso:            parseFloat(document.getElementById("pc-e-peso")?.value)   || 0,
          impuesto:        document.getElementById("pc-e-impuesto")?.value || "Exento",
          materia_prima:   document.getElementById("pc-e-materia_prima")?.checked === true,
          activo:          document.getElementById("pc-e-activo")?.checked !== false,
          familia:         document.getElementById("pc-e-familia")?.value || "",
          litros_por_unidad: parseFloat(document.getElementById("pc-e-litros_pu")?.value) || 0,
          unidad:          (() => { const v = document.getElementById("pc-e-unidad")?.value || ""; return v === "__nueva__" ? "" : v; })(),
        };

        // Agregar valores nuevos al catálogo local (en memoria)
        if (_PUEDE_CAT()) {
          if (data.marca)        _catAgregar("marcas",        data.marca);
          if (data.categoria)    _catAgregar("categorias",    data.categoria);
          if (data.subcategoria) _catAgregar("subcategorias", data.subcategoria);
        }

        // ── Subir / eliminar foto si hay cambio ──────────────
        let docIdFinal = _editandoId;
        if (esNuevo) {
          const newRef = await addDoc(collection(db, "productos"), {
            ...data, numero: nextNum, creadoPor: Sesion.alias, creadoEn: serverTimestamp()
          });
          docIdFinal = newRef.id;
          window.toast?.(`Producto "${nombre}" creado con código ${codigo}.`, "success");
        } else {
          await updateDoc(doc(db, "productos", _editandoId), {
            ...data, modificadoPor: Sesion.alias, modificadoEn: serverTimestamp()
          });
          window.toast?.("Producto actualizado.", "success");
        }

        // Subir foto si hay archivo pendiente
        if (_fotoFile && docIdFinal) {
          try {
            const prog = document.getElementById("pc-foto-progreso");
            if (prog) prog.style.display = "";
            const { getStorage, ref: sRef, uploadBytes, getDownloadURL }
              = await import("./firebase-storage.js");
            const storage = getStorage();
            const path    = `fotos/productos/${docIdFinal}/principal.jpg`;
            const snap2   = await uploadBytes(sRef(storage, path), _fotoFile, { contentType: _fotoFile.type });
            const url     = await getDownloadURL(snap2.ref);
            await updateDoc(doc(db, "productos", docIdFinal), { fotoUrl: url });
            if (prog) prog.style.display = "none";
          } catch(fe) { console.warn("Error subiendo foto:", fe); }
        }

        // Eliminar foto si el usuario la quitó
        if (_fotoEliminada && !esNuevo && _fotoUrlActual) {
          try {
            const { getStorage, ref: sRef, deleteObject } = await import("./firebase-storage.js");
            const storage = getStorage();
            await deleteObject(sRef(storage, `fotos/productos/${docIdFinal}/principal.jpg`));
            await updateDoc(doc(db, "productos", docIdFinal), { fotoUrl: "" });
          } catch(fe) { console.warn("Error eliminando foto:", fe); }
        }

        this.cerrarEdicion();
      } catch(e) {
        errEl.textContent = "Error: " + e.message; errEl.style.display = "block";
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = esNuevo ? "Guardar producto" : "Guardar cambios"; }
      }
    },

    // ── Nuevo producto ────────────────────────────────────────
    abrirAltaProducto() {
      _editandoId = null;
      _catLoad().then(_catPopulateDatalist);
      const nextNum   = Math.max(..._todos.map(p => p.numero ?? 0), 0) + 1;
      const nextCodigo = "N10-" + String(nextNum).padStart(4, "0");
      ["pc-e-nombre","pc-e-clave_sat",
       "pc-e-marca","pc-e-categoria","pc-e-subcategoria",
       "pc-e-precio","pc-e-costo","pc-e-peso","pc-e-descripcion"
      ].forEach(id => _val(id, ""));
      _val("pc-e-codigo",    nextCodigo);
      // Código editable solo en productos nuevos
      const codigoElN = document.getElementById("pc-e-codigo");
      if (codigoElN) { codigoElN.readOnly = false; codigoElN.style.opacity = "1"; codigoElN.title = ""; }
      _val("pc-e-nombre_suc","Nutricion de 10");
      const selImp = document.getElementById("pc-e-impuesto");
      if (selImp) selImp.value = "Exento";
      const chkM = document.getElementById("pc-e-materia_prima"); if (chkM) chkM.checked = false;
      const chkA = document.getElementById("pc-e-activo"); if (chkA) chkA.checked = true;
      _setText("pc-edit-titulo", "Nuevo producto");
      const err = document.getElementById("pc-edit-error"); if (err) err.style.display = "none";
      _resetFotoUI(null);
      document.getElementById("pc-modal-edit").style.display = "flex";
      _regEsc(() => ProdCtrlUI.cerrarEdicion());
      setTimeout(() => document.getElementById("pc-e-nombre")?.focus(), 80);
    },

    async toggleActivo(docId, nuevoEstado) {
      const p = _todos.find(x => x._docId === docId);
      const accion = nuevoEstado ? "activar" : "desactivar";
      if (!await window.modal({ title: `${nuevoEstado ? "Activar" : "Desactivar"} producto`, message: `¿Deseas ${accion} "${p?.nombre ?? docId}"?` })) return;
      try {
        await updateDoc(doc(db, "productos", docId), {
          activo: nuevoEstado, modificadoPor: Sesion.alias, modificadoEn: serverTimestamp()
        });
        window.toast?.(`Producto ${nuevoEstado ? "activado" : "desactivado"}`, "success");
        // Si estamos en el detalle, re-renderizarlo
        const dv = document.getElementById("pc-detail-view");
        if (dv && dv.style.display !== "none") {
          setTimeout(() => _renderDetalle(docId), 200);
        }
      } catch(e) { window.toast?.("Error: " + e.message, "error"); }
    }
  };
}

// ── Helpers ───────────────────────────────────────────────────
function _setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = String(val ?? ""); }
function _val(id, v)       { const el = document.getElementById(id); if (el) el.value = String(v ?? ""); }

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
