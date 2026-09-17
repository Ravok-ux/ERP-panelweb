// W7 — Catálogo de Precios por Segmento
import { exportarExcel, descargarPlantilla, importarExcel, toolbarHTML, puedeImportar } from "./excel-utils.js";
import { db } from './firebase-config.js';
import { norm } from './app.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, getDocs, where,
  serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}[c]));

const _COLS_SEG = [
  { key: "segmento",         header: "Segmento",          width: 16, required: true, ejemplo: "Premium" },
  { key: "codigo_producto",  header: "Código producto",   width: 16, required: true, ejemplo: "PROD-001" },
  { key: "nombre_producto",  header: "Nombre producto",   width: 28, ejemplo: "Proteína Whey 1kg" },
  { key: "precio",           header: "Precio",            width: 12, tipo: "numero", required: true, ejemplo: "380.00" },
  { key: "descuento_pct",    header: "Descuento %",       width: 14, tipo: "numero", ejemplo: "15" },
  { key: "notas",            header: "Notas",             width: 24, ejemplo: "Precio especial distribuidor" },
];

export const SegmentoPrecioModule = (() => {
  let _unsubSegmentos  = null;
  let _unsubClientes   = null;
  let _segmentosCache  = [];
  let _segmentoActivo  = null; // id del segmento en edición de matriz

  // ── Init ──────────────────────────────────────────────────────────────

  function init(container) {
    container.innerHTML = `
      <style>
        #seg-tabs { display:flex; gap:4px; padding:4px; background:var(--surface-2);
          border-radius:10px; width:fit-content; margin-bottom:16px; }
        .seg-tab { padding:7px 18px; border-radius:7px; border:none; cursor:pointer;
          font-size:12px; font-weight:600; color:var(--text-sec); background:transparent;
          transition:background .15s, color .15s; }
        .seg-tab.active { background:var(--surface); color:var(--text-primary);
          box-shadow:0 1px 4px rgba(0,0,0,.12); }
        #seg-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px; }
        .seg-card { background:var(--surface); border:1px solid var(--border); border-radius:12px;
          overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,.06);
          transition:box-shadow .15s, transform .15s; }
        .seg-card:hover { box-shadow:0 4px 12px rgba(0,0,0,.12); transform:translateY(-1px); }
        .seg-card-accent { height:4px; }
        .seg-card-body { padding:14px 16px; }
        .seg-card-name { font-size:14px; font-weight:800; color:var(--text-primary); margin-bottom:3px; }
        .seg-card-desc { font-size:11px; color:var(--text-sec); margin-bottom:10px; min-height:16px;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .seg-card-meta { display:flex; gap:10px; margin-bottom:12px; }
        .seg-card-badge { font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px; }
        .seg-card-actions { display:flex; gap:6px; }
        .seg-card-actions button { flex:1; padding:6px 0; border-radius:7px; font-size:11px;
          font-weight:600; cursor:pointer; border:1px solid var(--border);
          background:var(--surface-2); color:var(--text-sec); transition:background .12s; }
        .seg-card-actions button:hover { background:var(--border); }
        .seg-card-actions .btn-precios { background:#EFF6FF; color:#1E40AF;
          border-color:#BFDBFE; }
        [data-theme="dark"] .seg-card-actions .btn-precios { background:#1E3A5F;
          color:#93C5FD; border-color:#1E40AF; }
        .matriz-table { width:100%; border-collapse:collapse; font-size:12px; }
        .matriz-table th { position:sticky; top:0; background:var(--surface);
          padding:9px 12px; text-align:left; font-weight:700; color:#9CA3AF;
          font-size:10px; text-transform:uppercase; letter-spacing:.06em;
          border-bottom:2px solid var(--border); z-index:1; }
        .matriz-table td { padding:7px 12px; border-bottom:1px solid var(--border); }
        .matriz-table tr:hover td { background:var(--surface-2); }
        .var-pos { color:#22C55E; font-size:10px; font-weight:700; }
        .var-neg { color:#F87171; font-size:10px; font-weight:700; }
        .seg-modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.55);
          z-index:1000; align-items:center; justify-content:center; }
        .seg-modal-overlay.open { display:flex; }
        .seg-modal { background:var(--surface); border-radius:14px; padding:28px;
          width:400px; max-width:94vw; border:1px solid var(--border); }
        .seg-modal-title { font-size:15px; font-weight:800; color:var(--text-primary); margin-bottom:20px; }
        .seg-form-row { margin-bottom:14px; }
        .seg-form-label { font-size:11px; font-weight:700; color:var(--text-sec);
          text-transform:uppercase; letter-spacing:.05em; display:block; margin-bottom:5px; }
        .seg-form-input { width:100%; padding:9px 12px; border-radius:8px;
          border:1px solid var(--border); background:var(--surface-2);
          color:var(--text-primary); font-size:13px; box-sizing:border-box; }
        .seg-form-input:focus { outline:none; border-color:#3B82F6;
          box-shadow:0 0 0 3px rgba(59,130,246,.15); }
        .seg-color-row { display:flex; align-items:center; gap:10px; }
        .seg-color-preview { width:32px; height:32px; border-radius:8px; border:1px solid var(--border);
          flex-shrink:0; transition:background .1s; }
        .seg-form-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:20px; }
        .cli-seg-search { width:100%; padding:8px 12px; border-radius:8px;
          border:1px solid var(--border); background:var(--surface-2);
          color:var(--text-primary); font-size:12px; box-sizing:border-box; margin-bottom:12px; }
      </style>

      <!-- Cabecera -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="font-size:18px;font-weight:800;color:var(--text-primary)">Precios por Segmento</div>
          <div style="font-size:11px;color:var(--text-sec);margin-top:2px">Catálogo de segmentos y precios diferenciados por cliente</div>
        </div>
        ${toolbarHTML("Seg")}
        <button id="btnNuevoSegmento"
          style="padding:9px 18px;border-radius:8px;border:none;background:#1565C0;
            color:#fff;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">
          + Nuevo segmento
        </button>
      </div>

      <!-- Tabs pill -->
      <div id="seg-tabs">
        <button class="seg-tab active" data-tab="segmentos">🏷️ Segmentos</button>
        <button class="seg-tab" data-tab="matriz">💲 Matriz de precios</button>
        <button class="seg-tab" data-tab="clientes">👥 Clientes</button>
      </div>

      <!-- Tab segmentos -->
      <div id="tabSegmentos" class="tab-panel">
        <div id="gridSegmentos"></div>
      </div>

      <!-- Tab matriz de precios -->
      <div id="tabMatriz" class="tab-panel hidden">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
          <select id="selectSegmentoMatriz"
            style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);
              background:var(--surface);color:var(--text-primary);font-size:12px;min-width:180px">
            <option value="">— Seleccionar segmento —</option>
          </select>
          <input id="buscarMatriz" type="text" placeholder="Buscar producto…" autocomplete="off"
            style="flex:1;min-width:180px;max-width:280px;padding:8px 12px;border-radius:8px;
              border:1px solid var(--border);background:var(--surface);color:var(--text-primary);
              font-size:12px">
          <button id="btnGuardarMatriz"
            style="padding:8px 18px;border-radius:8px;border:none;background:#1565C0;
              color:#fff;font-size:12px;font-weight:700;cursor:pointer">
            💾 Guardar cambios
          </button>
        </div>
        <div style="overflow:auto;max-height:calc(100vh - 280px);border-radius:10px;
          border:1px solid var(--border)">
          <table class="matriz-table" id="tablaMatriz">
            <thead><tr>
              <th>ID</th><th>Producto</th>
              <th style="text-align:center">Precio base</th>
              <th style="text-align:center">Precio segmento</th>
              <th style="text-align:center">Variación</th>
              <th style="text-align:center">Activo</th>
            </tr></thead>
            <tbody id="tbodyMatriz">
              <tr><td colspan="6" style="padding:30px;text-align:center;color:#9CA3AF">
                Selecciona un segmento para ver la matriz de precios.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Tab clientes -->
      <div id="tabClientes" class="tab-panel hidden">
        <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
          <select id="selectSegmentoCliente"
            style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);
              background:var(--surface);color:var(--text-primary);font-size:12px;min-width:180px">
            <option value="">— Ver segmento —</option>
          </select>
          <div style="position:relative;flex:1;min-width:220px">
            <input id="seg-cli-buscar" type="text" placeholder="Buscar cliente para asignar…" autocomplete="off"
              style="width:100%;padding:8px 32px 8px 12px;border-radius:8px;border:1px solid var(--border);
                background:var(--surface);color:var(--text-primary);font-size:12px;box-sizing:border-box">
            <div id="seg-cli-dd" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:300;
              background:var(--surface);border:1px solid var(--border);border-radius:8px;
              box-shadow:0 6px 20px rgba(0,0,0,.25);max-height:240px;overflow-y:auto;margin-top:3px"></div>
          </div>
        </div>
        <div style="overflow:auto;max-height:calc(100vh - 280px);border-radius:10px;
          border:1px solid var(--border)">
          <table class="matriz-table">
            <thead><tr>
              <th>Cliente</th><th>Vendedor</th><th>Segmento actual</th><th>Cambiar segmento</th>
            </tr></thead>
            <tbody id="tbodyClientesSegmento">
              <tr><td colspan="4" style="padding:30px;text-align:center;color:#9CA3AF">
                Selecciona un segmento.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Modal segmento (centrado) -->
      <div id="modalSegmentoOverlay" class="seg-modal-overlay">
        <div class="seg-modal">
          <div class="seg-modal-title" id="panelSegmentoTitulo">Nuevo segmento</div>
          <form id="formSegmento" novalidate>
            <div class="seg-form-row">
              <label class="seg-form-label">Nombre *</label>
              <input name="nombre" class="seg-form-input" required maxlength="60" placeholder="Ej: Distribuidor Premium">
            </div>
            <div class="seg-form-row">
              <label class="seg-form-label">Descripción</label>
              <textarea name="descripcion" class="seg-form-input" rows="2" maxlength="200"
                placeholder="Descripción breve del segmento…" style="resize:vertical"></textarea>
            </div>
            <div class="seg-form-row">
              <label class="seg-form-label">Color identificador</label>
              <div class="seg-color-row">
                <div class="seg-color-preview" id="segColorPreview" style="background:#3B82F6"></div>
                <input name="color" type="color" value="#3B82F6"
                  style="width:80px;height:36px;border-radius:8px;border:1px solid var(--border);cursor:pointer;padding:2px"
                  oninput="document.getElementById('segColorPreview').style.background=this.value">
                <span style="font-size:11px;color:var(--text-sec)">Aparece en cards y chips</span>
              </div>
            </div>
            <div class="seg-form-row">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text-primary)">
                <input name="activo" type="checkbox" checked style="width:15px;height:15px"> Segmento activo
              </label>
            </div>
            <div class="seg-form-actions">
              <button type="button" id="btnCancelarSegmento"
                style="padding:9px 20px;border:1px solid var(--border);border-radius:8px;
                  background:transparent;color:var(--text-sec);font-size:13px;cursor:pointer">
                Cancelar
              </button>
              <button type="submit"
                style="padding:9px 24px;border:none;border-radius:8px;
                  background:#1565C0;color:#fff;font-size:13px;font-weight:700;cursor:pointer">
                Guardar
              </button>
            </div>
          </form>
        </div>
      </div>
    `;

    _bindTabs(container);
    _bindSegmentos(container);
    _bindMatriz(container);
    _bindClientesSegmento(container);
    _escucharSegmentos(container);
  }

  // ── Tabs ──────────────────────────────────────────────────────────────

  function _bindTabs(container) {
    container.querySelectorAll('.seg-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.seg-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        container.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
        const key = btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1);
        container.querySelector(`#tab${key}`).classList.remove('hidden');
      });
    });
  }

  // ── Segmentos CRUD ────────────────────────────────────────────────────

  function _escucharSegmentos(container) {
    if (_unsubSegmentos) _unsubSegmentos();
    const q = query(collection(db, 'segmentos'), orderBy('nombre'));
    _unsubSegmentos = onSnapshot(q, snap => {
      _segmentosCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _renderGridSegmentos(container, snap.docs);
      _actualizarSelectores(container);
    });
  }

  function _renderGridSegmentos(container, docs) {
    const grid = container.querySelector('#gridSegmentos');
    if (!docs.length) {
      grid.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-sec);
        grid-column:1/-1;font-size:13px">Sin segmentos. Crea el primero con "+ Nuevo segmento".</div>`;
      return;
    }
    grid.innerHTML = docs.map(d => {
      const s = d.data();
      const color  = s.color || '#3B82F6';
      const activo = s.activo !== false;
      return `<div class="seg-card" data-id="${esc(d.id)}">
        <div class="seg-card-accent" style="background:${esc(color)}"></div>
        <div class="seg-card-body">
          <div class="seg-card-name">${esc(s.nombre)}</div>
          <div class="seg-card-desc">${esc(s.descripcion || 'Sin descripción')}</div>
          <div class="seg-card-meta">
            <span class="seg-card-badge" style="background:${activo ? color + '22' : '#9CA3AF22'};
              color:${activo ? color : '#9CA3AF'}">
              ${activo ? '● Activo' : '○ Inactivo'}
            </span>
          </div>
          <div class="seg-card-actions">
            <button class="btn-edit" data-id="${esc(d.id)}">✏️ Editar</button>
            <button class="btn-precios" data-id="${esc(d.id)}">💲 Precios</button>
            <button class="btn-del" data-id="${esc(d.id)}">🗑️</button>
          </div>
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.btn-edit').forEach(btn =>
      btn.addEventListener('click', () => _abrirPanelSegmento(container, docs.find(d => d.id === btn.dataset.id))));
    grid.querySelectorAll('.btn-precios').forEach(btn =>
      btn.addEventListener('click', () => {
        container.querySelectorAll('.seg-tab').forEach(b => b.classList.remove('active'));
        container.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
        const tabBtn = [...container.querySelectorAll('.seg-tab')].find(b => b.dataset.tab === 'matriz');
        if (tabBtn) tabBtn.classList.add('active');
        container.querySelector('#tabMatriz')?.classList.remove('hidden');
        const sel = container.querySelector('#selectSegmentoMatriz');
        if (sel) { sel.value = btn.dataset.id; sel.dispatchEvent(new Event('change')); }
      }));
    grid.querySelectorAll('.btn-del').forEach(btn =>
      btn.addEventListener('click', () => _eliminarSegmento(btn.dataset.id)));
  }

  function _actualizarSelectores(container) {
    const opciones = _segmentosCache.map(s =>
      `<option value="${esc(s.id)}">${esc(s.nombre)}</option>`).join('');
    const vacío = '<option value="">— selecciona —</option>';
    [container.querySelector('#selectSegmentoMatriz'),
     container.querySelector('#selectSegmentoCliente')].forEach(sel => {
      if (!sel) return;
      const val = sel.value;
      sel.innerHTML = vacío + opciones;
      if (val) sel.value = val;
    });
  }

  function _bindSegmentos(container) {
    container.querySelector('#btnNuevoSegmento').addEventListener('click', () =>
      _abrirPanelSegmento(container, null));
    container.querySelector('#btnCancelarSegmento').addEventListener('click', () =>
      container.querySelector('#modalSegmentoOverlay').classList.remove('open'));
    container.querySelector('#modalSegmentoOverlay').addEventListener('click', e => {
      if (e.target === e.currentTarget)
        e.currentTarget.classList.remove('open');
    });
    container.querySelector('#formSegmento').addEventListener('submit', async e => {
      e.preventDefault();
      await _guardarSegmento(container, e.target);
    });
    container.querySelector('#seg-cli-buscar')?.addEventListener('input', e => {
      const q = norm(e.target.value);
      container.querySelectorAll('#tbodyClientesSegmento tr[data-nombre]').forEach(tr => {
        tr.style.display = !q || norm(tr.dataset.nombre).includes(q) ? '' : 'none';
      });
    });
  }

  function _abrirPanelSegmento(container, docSnap) {
    const overlay = container.querySelector('#modalSegmentoOverlay');
    const titulo  = container.querySelector('#panelSegmentoTitulo');
    const form    = container.querySelector('#formSegmento');
    form.reset();
    delete form.dataset.editId;

    if (docSnap) {
      titulo.textContent = 'Editar segmento';
      const s = docSnap.data();
      form.nombre.value      = s.nombre || '';
      form.descripcion.value = s.descripcion || '';
      form.color.value       = s.color || '#3B82F6';
      form.activo.checked    = s.activo !== false;
      form.dataset.editId    = docSnap.id;
      document.getElementById('segColorPreview').style.background = s.color || '#3B82F6';
    } else {
      titulo.textContent = 'Nuevo segmento';
      form.color.value = '#3B82F6';
      document.getElementById('segColorPreview').style.background = '#3B82F6';
    }
    overlay.classList.add('open');
  }

  async function _guardarSegmento(container, form) {
    const nombre = form.nombre.value.trim();
    if (!nombre) { window.toast?.('El nombre es obligatorio.', 'warn'); return; }

    const datos = {
      nombre:      nombre.slice(0, 60),
      descripcion: form.descripcion.value.trim().slice(0, 200),
      color:       form.color.value,
      activo:      form.activo.checked,
      actualizadoEn: serverTimestamp()
    };

    try {
      if (form.dataset.editId) {
        await updateDoc(doc(db, 'segmentos', form.dataset.editId), datos);
      } else {
        datos.creadoEn = serverTimestamp();
        await addDoc(collection(db, 'segmentos'), datos);
      }
      container.querySelector('#modalSegmentoOverlay').classList.remove('open');
    } catch (err) {
      window.toast?.("Error al guardar: " + err.message, "error");
    }
  }

  async function _eliminarSegmento(id) {
    if (!await window.modal({ title: "Eliminar segmento", message: "¿Eliminar este segmento? Los precios asociados también se eliminarán.", danger: true, confirmLabel: "Eliminar" })) return;
    try {
      // Borrar precios_segmento asociados
      const preciosSnap = await getDocs(query(collection(db, 'precios_segmento'),
        where('segmentoId', '==', id)));
      const batch = writeBatch(db);
      preciosSnap.forEach(d => batch.delete(d.ref));
      batch.delete(doc(db, 'segmentos', id));
      await batch.commit();
    } catch (err) {
      window.toast?.('Error al eliminar: ' + err.message, 'error');
    }
  }

  // ── Matriz de precios ─────────────────────────────────────────────────

  function _bindMatriz(container) {
    container.querySelector('#selectSegmentoMatriz').addEventListener('change', e => {
      _segmentoActivo = e.target.value || null;
      if (_segmentoActivo) _cargarMatriz(container, _segmentoActivo);
      else container.querySelector('#tbodyMatriz').innerHTML = '';
    });

    container.querySelector('#buscarMatriz').addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      container.querySelectorAll('#tbodyMatriz tr[data-idpretoriano]').forEach(tr => {
        const nombre = (tr.dataset.nombre || '').toLowerCase();
        const id     = (tr.dataset.idpretoriano || '').toLowerCase();
        tr.style.display = (!q || nombre.includes(q) || id.includes(q)) ? '' : 'none';
      });
    });

    container.querySelector('#btnGuardarMatriz').addEventListener('click', async () => {
      if (!_segmentoActivo) { window.toast?.('Selecciona un segmento.', 'warn'); return; }
      await _guardarMatriz(container, _segmentoActivo);
    });
  }

  async function _cargarMatriz(container, segmentoId) {
    const tbody = container.querySelector('#tbodyMatriz');
    tbody.innerHTML = '<tr><td colspan="6">Cargando productos…</td></tr>';
    try {
      const [productosSnap, preciosSnap] = await Promise.all([
        getDocs(query(collection(db, 'productos'), orderBy('nombre'))),
        getDocs(query(collection(db, 'precios_segmento'), where('segmentoId', '==', segmentoId)))
      ]);
      const preciosMap = {};
      preciosSnap.forEach(d => {
        const p = d.data();
        preciosMap[p.idPretoriano] = { docId: d.id, precio: p.precio, activo: p.activo !== false };
      });

      if (!productosSnap.docs.length) {
        tbody.innerHTML = '<tr><td colspan="6">Sin productos en catálogo.</td></tr>';
        return;
      }

      const _productosDocs = productosSnap.docs;
      tbody.innerHTML = _productosDocs.map(d => {
        const p    = d.data();
        const prev = preciosMap[p.idPretoriano] || {};
        const base    = p.precioBase ?? p.precio_base ?? null;
        const precio  = prev.precio ?? '';
        const activo  = prev.activo !== false;
        const varHtml = (precio !== '' && base != null && base > 0)
          ? (() => {
              const pct = ((parseFloat(precio) - base) / base * 100);
              const cls = pct >= 0 ? 'var-pos' : 'var-neg';
              return `<span class="${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
            })()
          : '<span style="color:#9CA3AF;font-size:10px">—</span>';
        return `<tr data-idpretoriano="${esc(String(p.idPretoriano))}"
                    data-docid="${esc(prev.docId || '')}"
                    data-nombre="${esc(p.nombre)}"
                    data-base="${esc(String(base ?? ''))}">
          <td style="font-family:monospace;color:#9CA3AF;font-size:11px">${esc(String(p.idPretoriano))}</td>
          <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            font-weight:600;color:var(--text-primary)">${esc(p.nombre)}</td>
          <td style="text-align:center;font-variant-numeric:tabular-nums;color:#9CA3AF">
            ${base != null ? '$' + base.toFixed(2) : '—'}</td>
          <td style="text-align:center"><input type="number" class="input-precio" min="0" step="0.01"
               value="${esc(String(precio))}" placeholder=""
               style="width:110px;padding:5px 8px;border-radius:6px;border:1px solid var(--border);
                 background:var(--surface-2);color:var(--text-primary);font-size:12px;
                 text-align:right;font-variant-numeric:tabular-nums">
          </td>
          <td class="var-cell" style="text-align:center">${varHtml}</td>
          <td style="text-align:center"><input type="checkbox" class="chk-activo" ${activo ? 'checked' : ''}></td>
        </tr>`;
      }).join('');

      // Attach input listeners for variation calculation (avoids inline oninput escaping issues)
      tbody.querySelectorAll('tr[data-idpretoriano]').forEach(tr => {
        const base = parseFloat(tr.dataset.base) || 0;
        const inp  = tr.querySelector('.input-precio');
        if (!inp) return;
        inp.addEventListener('input', () => {
          const v  = parseFloat(inp.value);
          const el = tr.querySelector('.var-cell');
          if (!el) return;
          if (base > 0 && !isNaN(v)) {
            const pct = ((v - base) / base * 100);
            const cls = pct >= 0 ? 'var-pos' : 'var-neg';
            el.innerHTML = `<span class="${cls}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
          } else {
            el.innerHTML = '<span style="color:#9CA3AF;font-size:10px">—</span>';
          }
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6">Error: ${esc(err.message)}</td></tr>`;
    }
  }

  async function _guardarMatriz(container, segmentoId) {
    const filas = container.querySelectorAll('#tbodyMatriz tr[data-idpretoriano]');
    if (!filas.length) return;

    const batch = writeBatch(db);
    let cambios = 0;

    filas.forEach(fila => {
      const idPretoriano = parseInt(fila.dataset.idpretoriano, 10) || 0;
      const nombreProducto = fila.dataset.nombre;
      const precioInput = fila.querySelector('.input-precio').value.trim();
      const activo = fila.querySelector('.chk-activo').checked;
      const precio  = parseFloat(precioInput);
      const docId   = fila.dataset.docid;

      if (precioInput === '' && !docId) return; // sin precio y sin doc previo → omitir

      const datos = {
        segmentoId,
        idPretoriano,
        nombreProducto,
        precio:    isNaN(precio) ? 0 : precio,
        activo,
        syncTs:    Date.now()
      };

      if (docId) {
        batch.update(doc(db, 'precios_segmento', docId), datos);
      } else if (precioInput !== '') {
        const ref = doc(collection(db, 'precios_segmento'));
        batch.set(ref, datos);
      }
      cambios++;
    });

    if (!cambios) { window.toast?.('Sin cambios para guardar.', 'warn'); return; }

    try {
      await batch.commit();
      window.toast?.('Matriz de precios guardada.', 'success');
    } catch (err) {
      window.toast?.('Error al guardar: ' + err.message, 'error');
    }
  }

  // ── Clientes por segmento ─────────────────────────────────────────────

  let _clientesCache = [];  // [{id, nombre, aliasVendedor, segmentoId}]
  let _cliCacheLoaded = false;

  async function _cargarCacheClientes() {
    if (_cliCacheLoaded) return;
    const snap = await getDocs(query(collection(db, 'clientes'), orderBy('nombre')));
    _clientesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _cliCacheLoaded = true;
  }

  function _bindClientesSegmento(container) {
    container.querySelector('#selectSegmentoCliente').addEventListener('change', e => {
      _cargarClientesDeSegmento(container, e.target.value || null);
    });

    // Autocomplete: buscar cualquier cliente para asignarlo a un segmento
    const input = container.querySelector('#seg-cli-buscar');
    const dd    = container.querySelector('#seg-cli-dd');
    if (!input || !dd) return;

    input.addEventListener('input', async () => {
      const q = (input.value || '').trim().toLowerCase();
      if (q.length < 2) { dd.style.display = 'none'; return; }

      await _cargarCacheClientes();
      const matches = _clientesCache
        .filter(c => (c.nombre || '').toLowerCase().includes(q))
        .slice(0, 15);

      if (!matches.length) { dd.style.display = 'none'; return; }

      dd.innerHTML = matches.map(c => {
        const segNombre = _segmentosCache.find(s => s.id === c.segmentoId)?.nombre || '';
        return `<div data-cid="${esc(c.id)}"
          style="padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--border);
            display:flex;align-items:center;justify-content:space-between;gap:8px"
          onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background=''">
          <div>
            <div style="font-weight:600;font-size:12px;color:var(--text-primary)">${esc(c.nombre || c.id)}</div>
            <div style="font-size:10px;color:#9CA3AF">${esc(c.aliasVendedor || '')}</div>
          </div>
          ${segNombre ? `<span style="font-size:10px;padding:2px 7px;border-radius:4px;
            background:var(--surface-2);border:1px solid var(--border);white-space:nowrap">${esc(segNombre)}</span>` : ''}
        </div>`;
      }).join('');
      dd.style.display = 'block';

      dd.querySelectorAll('div[data-cid]').forEach(el => {
        el.addEventListener('mousedown', e => e.preventDefault());
        el.addEventListener('click', async () => {
          const segId = container.querySelector('#selectSegmentoCliente').value;
          if (!segId) {
            window.toast?.('Selecciona primero un segmento.', 'warn');
            return;
          }
          const cid = el.dataset.cid;
          const cliente = _clientesCache.find(c => c.id === cid);
          if (!cliente) return;
          try {
            await updateDoc(doc(db, 'clientes', cid),
              { segmentoId: segId, actualizadoEn: serverTimestamp() });
            // Update local cache
            cliente.segmentoId = segId;
            input.value = '';
            dd.style.display = 'none';
            // Reload table to show the newly added client
            _cargarClientesDeSegmento(container, segId);
            window.toast?.(`${cliente.nombre} asignado al segmento.`, 'success');
          } catch (err) {
            window.toast?.('Error al asignar: ' + err.message, 'error');
          }
        });
      });
    });

    input.addEventListener('blur', () => setTimeout(() => { dd.style.display = 'none'; }, 150));
  }

  async function _cargarClientesDeSegmento(container, segmentoId) {
    const tbody = container.querySelector('#tbodyClientesSegmento');
    if (!segmentoId) { tbody.innerHTML = ''; return; }
    tbody.innerHTML = '<tr><td colspan="4">Cargando…</td></tr>';

    try {
      const snap = await getDocs(query(collection(db, 'clientes'),
        where('segmentoId', '==', segmentoId)));
      snap.docs.sort((a, b) => (a.data().nombre || '').localeCompare(b.data().nombre || ''));

      if (snap.empty) {
        tbody.innerHTML = '<tr><td colspan="4" style="padding:30px;text-align:center;color:#9CA3AF">Sin clientes en este segmento.<br><span style="font-size:10px">Usa el buscador de arriba para asignar clientes.</span></td></tr>';
        return;
      }

      tbody.innerHTML = snap.docs.map(d => {
        const c = d.data();
        const segNombre = _segmentosCache.find(s => s.id === c.segmentoId)?.nombre || '—';
        return `<tr data-clienteid="${esc(d.id)}" data-nombre="${esc(c.nombre || d.id)}">
          <td style="font-weight:600;color:var(--text-primary)">${esc(c.nombre || d.id)}</td>
          <td style="color:#9CA3AF">${esc(c.aliasVendedor || '—')}</td>
          <td><span style="font-size:10px;padding:2px 8px;border-radius:6px;
            background:var(--surface-2);border:1px solid var(--border)">${esc(segNombre)}</span></td>
          <td>
            <select class="sel-segmento input-select-sm" data-cid="${esc(d.id)}">
              <option value="">Sin segmento</option>
              ${_segmentosCache.map(s =>
                `<option value="${esc(s.id)}" ${s.id === c.segmentoId ? 'selected' : ''}>${esc(s.nombre)}</option>`
              ).join('')}
            </select>
          </td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('.sel-segmento').forEach(sel => {
        sel.dataset.prevVal = sel.value;
        sel.addEventListener('change', async e => {
          const nuevoSegmento = e.target.value;
          const tr = e.target.closest('tr');
          const cid = e.target.dataset.cid;
          try {
            await updateDoc(doc(db, 'clientes', cid),
              { segmentoId: nuevoSegmento, actualizadoEn: serverTimestamp() });
            // Update local cache
            const cached = _clientesCache.find(c => c.id === cid);
            if (cached) cached.segmentoId = nuevoSegmento;
            tr?.remove();
            if (!tbody.querySelectorAll('tr[data-clienteid]').length) {
              tbody.innerHTML = '<tr><td colspan="4" style="padding:30px;text-align:center;color:#9CA3AF">Sin clientes en este segmento.<br><span style="font-size:10px">Usa el buscador de arriba para asignar clientes.</span></td></tr>';
            }
          } catch (err) {
            window.toast?.('Error al actualizar cliente: ' + err.message, 'error');
            e.target.value = e.target.dataset.prevVal || '';
          }
          e.target.dataset.prevVal = nuevoSegmento;
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4">Error: ${esc(err.message)}</td></tr>`;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  function destroy() {
    if (_unsubSegmentos) { _unsubSegmentos(); _unsubSegmentos = null; }
    _unsubClientes = null;
  }

  return { init, mount: init, destroy };
})();

// ── Excel: Exportar ───────────────────────────────────────────
window.Seg_xlExport = async function() {
  try {
    const { getDocs, collection } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db } = await import("./firebase-config.js");
    const snap = await getDocs(collection(db, "precios_segmento"));
    const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    exportarExcel(rows, _COLS_SEG, "PreciosSegmento", "Precios por Segmento");
  } catch(e) { window.toast?.("Error al exportar.", "error"); }
};

// ── Excel: Plantilla ──────────────────────────────────────────
window.Seg_xlPlantilla = function() {
  descargarPlantilla(_COLS_SEG, "PreciosSegmento", "Precios por Segmento");
};

// ── Excel: Importar ───────────────────────────────────────────
window.Seg_xlImport = async function() {
  if (!puedeImportar()) { window.toast?.("Sin permisos.", "error"); return; }
  try {
    const registros = await importarExcel(_COLS_SEG);
    if (!registros.length) return;
    const { doc, setDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const { db } = await import("./firebase-config.js");
    let ok = 0, err = 0;
    for (const r of registros) {
      try {
        const id = `${r.segmento}_${r.codigo_producto}`;
        await setDoc(doc(db, "precios_segmento", id), {
          ...r, actualizadoPor: window.Sesion?.alias ?? "import", actualizadoEn: serverTimestamp()
        }, { merge: true });
        ok++;
      } catch(e2) { err++; }
    }
    window.toast?.(`Importación: ${ok} precios${err ? `, ${err} errores` : ""}.`, ok > 0 ? "success" : "error");
  } catch(e) { window.toast?.("Error en importación.", "error"); }
};
