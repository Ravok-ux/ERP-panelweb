// W5 — Motor de Promociones S3
import { db } from './firebase-config.js';
import { Sesion } from './auth.js';
import { norm } from './app.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, getDoc,
  onSnapshot, query, orderBy, where, getDocs,
  serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}[c]));

let _escFn = null;
const _regEsc   = fn => { _unregEsc(); _escFn = e => { if (e.key === "Escape") fn(); }; document.addEventListener("keydown", _escFn); };
const _unregEsc = () => { if (_escFn) { document.removeEventListener("keydown", _escFn); _escFn = null; } };

const TIPOS_PROMO = {
  DESCUENTO_MONTO_PEDIDO:    'Descuento $ en pedido',
  DESCUENTO_MONTO_PRODUCTO:  'Descuento $ en producto',
  PRODUCTO_GRATIS:           'Producto gratis',
  PRECIO_FLASH:              'Precio flash',
  PUNTOS_LEALTAD:            'Puntos de lealtad'
};

// Colección unificada usada por el motor del APK y el panel web
const COL_CAMPANAS   = 'campanas_promociones';
const COL_PUNTOS     = 'puntos_cliente';
const COL_HISTORIAL  = 'historial_puntos';

export const PromocionesModule = (() => {
  let _unsubCampanas = null;
  let _unsubPuntos   = null;

  function _puedeConfig() {
    return Sesion.tieneFlag('PUEDE_CONFIG_PROMOCIONES');
  }

  // ── Init ──────────────────────────────────────────────────────────────

  function init(container) {
    const btnNuevo = _puedeConfig()
      ? '<button class="btn-primary" id="btnNuevaCampana">+ Nueva Campaña</button>'
      : '';
    container.innerHTML = `
      <style>
        #promo-tabs { display:flex; gap:4px; padding:4px; background:var(--surface-2);
          border-radius:10px; width:fit-content; margin-bottom:16px; }
        .promo-tab { padding:7px 18px; border-radius:7px; border:none; cursor:pointer;
          font-size:12px; font-weight:600; color:var(--text-sec); background:transparent;
          transition:background .15s, color .15s; }
        .promo-tab.active { background:var(--surface); color:var(--text-primary);
          box-shadow:0 1px 4px rgba(0,0,0,.12); }
        #gridCampanas { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
        .promo-card { background:var(--surface); border:1px solid var(--border); border-radius:12px;
          overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,.06);
          transition:box-shadow .15s, transform .15s; }
        .promo-card:hover { box-shadow:0 4px 12px rgba(0,0,0,.12); transform:translateY(-1px); }
        .promo-card-top { padding:14px 16px 0; }
        .promo-card-title { font-size:14px; font-weight:800; color:var(--text-primary); margin-bottom:4px; }
        .promo-card-tipo { font-size:10px; font-weight:700; padding:2px 8px; border-radius:6px;
          background:var(--surface-2); color:#60A5FA; border:1px solid var(--border);
          display:inline-block; margin-bottom:6px; }
        .promo-card-desc { font-size:11px; color:var(--text-sec); padding:0 16px;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:6px; }
        .promo-card-dates { font-size:10px; color:#9CA3AF; padding:0 16px 10px;
          border-bottom:1px solid var(--border); }
        .promo-card-footer { display:flex; align-items:center; padding:10px 16px; gap:6px; }
        .promo-modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.6);
          backdrop-filter:blur(3px); z-index:1000; align-items:flex-start; justify-content:center;
          padding:32px 12px 48px; overflow-y:auto; }
        .promo-modal-overlay.open { display:flex; }
        .modal-overlay { display:flex; position:fixed; inset:0; background:rgba(0,0,0,.6);
          backdrop-filter:blur(3px); z-index:1000; align-items:center; justify-content:center; }
        .modal-overlay.hidden { display:none; }
        .modal-box { background:var(--surface); border-radius:14px; padding:24px;
          width:min(420px,95vw); border:1px solid var(--border);
          box-shadow:0 16px 48px rgba(0,0,0,.18); display:flex; flex-direction:column; gap:12px; }
        .modal-box h4 { margin:0; font-size:15px; font-weight:800; color:var(--text-primary); }
        .modal-box label { display:flex; flex-direction:column; gap:4px;
          font-size:11px; font-weight:700; color:var(--text-sec); text-transform:uppercase; letter-spacing:.06em; }
        .modal-box .input-select, .modal-box .input-text { padding:9px 12px; border-radius:8px;
          border:1.5px solid var(--border); background:var(--surface);
          color:var(--text-primary); font-size:13px; width:100%; box-sizing:border-box; }
        .modal-box .form-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:4px; }
        .promo-modal { background:var(--surface); border-radius:18px;
          width:500px; max-width:96vw; border:1px solid var(--border);
          box-shadow:0 24px 64px rgba(0,0,0,.18); overflow:hidden; }
        .promo-modal-header { padding:22px 24px 18px;
          border-bottom:1px solid var(--border);
          display:flex; align-items:flex-start; justify-content:space-between; gap:12px;
          background:linear-gradient(135deg,rgba(59,130,246,.06) 0%,transparent 60%); }
        .promo-modal-icon { width:38px; height:38px; border-radius:10px;
          background:linear-gradient(135deg,#3B82F6,#1D4ED8);
          display:flex; align-items:center; justify-content:center;
          font-size:18px; flex-shrink:0; }
        .promo-modal-title { font-size:16px; font-weight:800; color:var(--text-primary);
          line-height:1.2; margin:0; }
        .promo-modal-subtitle { font-size:11px; color:var(--text-sec); margin-top:2px; }
        .promo-modal-close { background:none; border:none; cursor:pointer;
          color:var(--text-sec); padding:4px; line-height:1; border-radius:6px;
          font-size:16px; transition:background .15s,color .15s; flex-shrink:0; margin-top:2px; }
        .promo-modal-close:hover { background:var(--surface-2); color:var(--text-primary); }
        .promo-modal-body { padding:22px 24px; }
        .pf-row { margin-bottom:16px; }
        .pf-label { font-size:10.5px; font-weight:700; color:var(--text-sec);
          text-transform:uppercase; letter-spacing:.07em; display:block; margin-bottom:5px; }
        .pf-input { width:100%; padding:10px 13px; padding-right:32px; border-radius:9px;
          border:1.5px solid var(--border); background:var(--surface);
          color:var(--text-primary); font-size:13.5px; box-sizing:border-box;
          transition:border-color .15s, box-shadow .15s; }
        .pf-input::placeholder { color:var(--text-sec); opacity:.6; }
        .pf-input:focus { outline:none; border-color:#3B82F6;
          box-shadow:0 0 0 3px rgba(59,130,246,.14); background:var(--surface); }
        .pf-2col { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .pf-campos-tipo { background:var(--surface); border:1.5px solid var(--border);
          border-radius:11px; overflow:hidden; padding:0; }
        .cpt-head { display:flex; align-items:center; gap:10px; padding:11px 15px;
          background:#0F2040; border-bottom:1px solid #1E3A5F; }
        .cpt-head-icon { width:28px; height:28px; border-radius:7px; background:#1D4ED8;
          display:flex; align-items:center; justify-content:center;
          font-size:14px; flex-shrink:0; }
        .cpt-head-title { font-size:11px; font-weight:700; color:#93C5FD;
          text-transform:uppercase; letter-spacing:.08em; }
        .cpt-body { padding:4px 0; }
        .cpt-row { display:flex; align-items:center; gap:10px;
          padding:9px 15px; border-bottom:1px solid var(--border); }
        .cpt-row:last-child { border-bottom:none; }
        .cpt-key { flex:1; font-size:12.5px; color:var(--text-sec); font-weight:500; }
        .cpt-val { display:flex; align-items:center; gap:0; border:1.5px solid var(--border);
          border-radius:8px; overflow:hidden; background:var(--surface-2,var(--surface)); }
        .cpt-unit { font-size:11px; font-weight:700; color:#6B7280;
          background:#1F2937; padding:0 9px; height:36px; display:flex;
          align-items:center; border-right:1px solid var(--border); }
        .cpt-input { border:none; outline:none; background:transparent;
          color:var(--text-primary); font-size:13px; font-weight:700;
          padding:0 10px; height:36px; width:90px; text-align:right;
          font-variant-numeric:tabular-nums; }
        .cpt-input-wide { width:140px; text-align:left; font-weight:500; font-size:13px; }
        .cpt-select { border:none; outline:none; background:var(--surface-2,var(--surface));
          color:var(--text-primary); font-size:13px; font-weight:600;
          padding:0 10px; height:36px; cursor:pointer; }
        .pf-check-row { display:flex; align-items:center; gap:10px;
          padding:11px 14px; background:var(--surface-2); border-radius:9px;
          border:1.5px solid var(--border); cursor:pointer; }
        .pf-check-row input[type=checkbox] { width:16px; height:16px;
          accent-color:#3B82F6; cursor:pointer; flex-shrink:0; }
        .pf-check-label { font-size:13px; font-weight:600; color:var(--text-primary);
          user-select:none; }
        .pf-check-sub { font-size:11px; color:var(--text-sec); margin-top:1px; }
        .promo-form-actions { display:flex; gap:10px; justify-content:flex-end;
          padding:16px 24px; border-top:1px solid var(--border);
          background:var(--surface-2); }
      </style>

      <!-- Cabecera -->
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="font-size:18px;font-weight:800;color:var(--text-primary)">Motor de Promociones</div>
          <div style="font-size:11px;color:var(--text-sec);margin-top:2px">Campañas, puntos de lealtad e historial de canje</div>
        </div>
        ${btnNuevo ? btnNuevo.replace('class="btn-primary"',
          'style="padding:9px 18px;border-radius:8px;border:none;background:#1565C0;color:#fff;font-size:13px;font-weight:700;cursor:pointer"') : ""}
      </div>

      <!-- Tabs pill -->
      <div id="promo-tabs">
        <button class="promo-tab active" data-tab="campanas">🎁 Campañas</button>
        <button class="promo-tab" data-tab="puntos">⭐ Puntos por cliente</button>
        <button class="promo-tab" data-tab="historial">📋 Historial de canje</button>
      </div>

      <div id="tabCampanas" class="tab-panel">
        <div id="gridCampanas"></div>
      </div>

      <div id="tabPuntos" class="tab-panel hidden">
        <div style="margin-bottom:12px">
          <input id="buscarCliente" type="text" placeholder="Buscar cliente…"
            style="width:100%;max-width:320px;padding:8px 12px;border-radius:8px;
              border:1px solid var(--border);background:var(--surface);
              color:var(--text-primary);font-size:12px;box-sizing:border-box">
        </div>
        <div style="overflow:auto;border-radius:10px;border:1px solid var(--border)">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="border-bottom:2px solid var(--border)">
                <th style="padding:9px 14px;text-align:left;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Cliente</th>
                <th style="padding:9px 14px;text-align:right;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Puntos</th>
                <th style="padding:9px 14px;text-align:left;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Última actividad</th>
                <th style="padding:9px 14px;text-align:center;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Acciones</th>
              </tr>
            </thead>
            <tbody id="tbodyPuntos"></tbody>
          </table>
        </div>
      </div>

      <div id="tabHistorial" class="tab-panel hidden">
        <div style="overflow:auto;border-radius:10px;border:1px solid var(--border)">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="border-bottom:2px solid var(--border)">
                <th style="padding:9px 14px;text-align:left;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Fecha</th>
                <th style="padding:9px 14px;text-align:left;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Cliente</th>
                <th style="padding:9px 14px;text-align:left;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Campaña</th>
                <th style="padding:9px 14px;text-align:right;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Puntos</th>
                <th style="padding:9px 14px;text-align:center;font-weight:700;color:#9CA3AF;font-size:10px;text-transform:uppercase">Tipo</th>
              </tr>
            </thead>
            <tbody id="tbodyHistorial"></tbody>
          </table>
        </div>
      </div>

      <!-- Modal campaña (centrado) -->
      <div id="modalCampanaOverlay" class="promo-modal-overlay">
        <div class="promo-modal">
          <div class="promo-modal-header">
            <div style="display:flex;align-items:center;gap:12px">
              <div class="promo-modal-icon">🎁</div>
              <div>
                <div class="promo-modal-title" id="panelCampanaTitulo">Nueva campaña</div>
                <div class="promo-modal-subtitle">Configura los parámetros de la promoción</div>
              </div>
            </div>
            <button id="cerrarPanelCampana" class="promo-modal-close" title="Cerrar">✕</button>
          </div>
          <form id="formCampana" novalidate>
            <div class="promo-modal-body">
              <div class="pf-row">
                <label class="pf-label">Nombre *</label>
                <input name="nombre" class="pf-input" required maxlength="80" placeholder="Ej: Campaña Temporada Maíz 2026">
              </div>
              <div class="pf-row">
                <label class="pf-label">Descripción</label>
                <textarea name="descripcion" class="pf-input" rows="2" maxlength="300"
                  style="resize:vertical" placeholder="Descripción breve de la campaña…"></textarea>
              </div>
              <div class="pf-row">
                <label class="pf-label">Tipo de promoción</label>
                <select name="tipo" id="selectTipoPromo" class="pf-input">
                  ${Object.entries(TIPOS_PROMO).map(([k,v]) => `<option value="${k}">${v}</option>`).join('')}
                </select>
              </div>
              <div class="pf-2col pf-row">
                <div>
                  <label class="pf-label">Fecha inicio *</label>
                  <input name="fechaInicio" type="date" class="pf-input" required>
                </div>
                <div>
                  <label class="pf-label">Fecha fin *</label>
                  <input name="fechaFin" type="date" class="pf-input" required>
                </div>
              </div>
              <div id="camposTipo" class="pf-row pf-campos-tipo"></div>
              <div class="pf-row" style="margin-bottom:0">
                <label class="pf-check-row">
                  <input name="activa" type="checkbox" checked>
                  <div>
                    <div class="pf-check-label">Campaña activa</div>
                    <div class="pf-check-sub">Los clientes podrán ver y aplicar esta promoción</div>
                  </div>
                </label>
              </div>
            </div>
            <div class="promo-form-actions">
              <button type="button" id="btnCancelarCampana"
                style="padding:9px 20px;border:1.5px solid var(--border);border-radius:9px;
                  background:transparent;color:var(--text-sec);font-size:13px;font-weight:600;cursor:pointer;transition:background .15s">
                Cancelar
              </button>
              <button type="submit"
                style="padding:9px 24px;border:none;border-radius:9px;
                  background:linear-gradient(135deg,#2563EB,#1D4ED8);color:#fff;
                  font-size:13px;font-weight:700;cursor:pointer;
                  box-shadow:0 2px 8px rgba(37,99,235,.35);transition:opacity .15s">
                💾 Guardar campaña
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Modal ajuste manual de puntos -->
      <div id="modalPuntos" class="modal-overlay hidden">
        <div class="modal-box">
          <h4 id="modalPuntosTitulo">Ajustar puntos</h4>
          <form id="formAjustePuntos" novalidate>
            <input type="hidden" name="clienteId">
            <input type="hidden" name="clienteNombre">
            <label>Operación
              <select name="operacion" class="input-select">
                <option value="sumar">Sumar puntos</option>
                <option value="restar">Restar puntos</option>
                <option value="canje">Registrar canje</option>
              </select>
            </label>
            <label>Puntos <input name="puntos" type="number" class="input-text" min="1" required></label>
            <label>Campaña <select name="campanaId" class="input-select"><option value="">Sin campaña</option></select></label>
            <label>Nota <input name="nota" class="input-text" maxlength="200"></label>
            <div class="form-actions">
              <button type="button" id="btnCancelarPuntos" class="btn-secondary">Cancelar</button>
              <button type="submit" class="btn-primary">Confirmar</button>
            </div>
          </form>
        </div>
      </div>
    `;

    _bindTabs(container);
    _bindCampanas(container);
    _bindPuntos(container);
    _escucharCampanas(container);
    _escucharHistorial(container);
  }

  // ── Tabs ──────────────────────────────────────────────────────────────

  function _bindTabs(container) {
    container.querySelectorAll('.promo-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.promo-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        container.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
        const panel = container.querySelector(`#tab${btn.dataset.tab.charAt(0).toUpperCase() + btn.dataset.tab.slice(1)}`);
        if (panel) panel.classList.remove('hidden');
        if (btn.dataset.tab === 'puntos') _cargarPuntos(container, '');
      });
    });
  }

  // ── Campos dinámicos según tipo ───────────────────────────────────────

  function _renderCamposTipo(tipo, datos = {}) {
    const row = (label, inputHtml) =>
      `<div class="cpt-row"><span class="cpt-key">${label}</span>${inputHtml}</div>`;
    const num = (name, val, unit, opts = '') =>
      `<div class="cpt-val"><span class="cpt-unit">${unit}</span>
        <input name="${name}" type="number" class="cpt-input" value="${val}" ${opts}></div>`;
    const txt = (name, val, ph = '') =>
      `<div class="cpt-val" style="flex:0 0 auto">
        <input name="${name}" type="text" class="cpt-input cpt-input-wide"
          value="${esc(val)}" placeholder="${ph}" style="border:none;border-right:none"></div>`;
    const sel = (name, options) =>
      `<div class="cpt-val"><select name="${name}" class="cpt-select">${options}</select></div>`;

    const icons = {
      DESCUENTO_MONTO_PEDIDO:   { icon:'💲', title:'Descuento en pedido' },
      DESCUENTO_MONTO_PRODUCTO: { icon:'📦', title:'Descuento en producto' },
      PRODUCTO_GRATIS:          { icon:'🎁', title:'Producto gratis' },
      PRECIO_FLASH:             { icon:'⚡', title:'Precio flash' },
      PUNTOS_LEALTAD:           { icon:'⭐', title:'Puntos de lealtad' },
    };
    const { icon, title } = icons[tipo] || { icon:'⚙️', title:'Parámetros' };

    let rows = '';
    switch (tipo) {
      case 'DESCUENTO_MONTO_PEDIDO':
        rows =
          row('Umbral del pedido',    num('umbralPedido',   datos.umbralPedido   ?? 1000, 'MXN', 'min="0" step="1" required')) +
          row('Monto de descuento',   num('montoDescuento', datos.montoDescuento ?? 100,  'MXN $', 'min="1" step="1" required'));
        break;

      case 'DESCUENTO_MONTO_PRODUCTO':
        rows =
          row('ID Pretoriano',        num('productoIdPretoriano', datos.productoIdPretoriano ?? '', '#', 'min="1" required placeholder="ej. 4521"')) +
          row('Umbral producto',      num('umbralProducto',       datos.umbralProducto       ?? 0,  'MXN', 'min="0" step="1"')) +
          row('Monto de descuento',   num('montoDescuento',       datos.montoDescuento       ?? 50, 'MXN $', 'min="1" step="1" required'));
        break;

      case 'PRODUCTO_GRATIS':
        rows =
          row('Modo de activación', sel('modoGratis',
            `<option value="POR_MONTO" ${(datos.modoGratis ?? 'POR_MONTO') === 'POR_MONTO' ? 'selected' : ''}>Por monto de pedido</option>
             <option value="POR_PRODUCTO" ${datos.modoGratis === 'POR_PRODUCTO' ? 'selected' : ''}>Por producto específico</option>`)) +
          row('Umbral de monto',        num('umbralMonto',                datos.umbralMonto                ?? 2000, 'MXN', 'min="0" step="1"')) +
          row('ID trigger (producto)',  num('productoTriggerIdPretoriano', datos.productoTriggerIdPretoriano ?? '',   '#', 'min="0" placeholder="0 = ignorar"')) +
          row('Cantidad mínima',        num('cantidadMinimaTrigger',       datos.cantidadMinimaTrigger       ?? 1,    'uds', 'min="1" step="1"')) +
          row('ID producto gratis',     num('productoGratisIdPretoriano',  datos.productoGratisIdPretoriano  ?? '',   '#', 'min="1" required')) +
          row('Nombre producto gratis', txt('productoGratisNombre',        datos.productoGratisNombre        ?? '',   'Ej: Fertilizante Premium')) +
          row('Cantidad a regalar',     num('cantidadGratis',              datos.cantidadGratis              ?? 1,    'uds', 'min="1" step="1"')) +
          row('Valor referencia',       num('valorUnitarioGratis',         datos.valorUnitarioGratis         ?? 0,    'MXN', 'min="0" step="0.01"'));
        break;

      case 'PRECIO_FLASH':
        rows =
          row('ID Pretoriano',  num('productoIdPretoriano', datos.productoIdPretoriano ?? '', '#',     'min="1" required placeholder="ej. 3318"')) +
          row('Precio flash',   num('precioFlash',          datos.precioFlash          ?? '', 'MXN $', 'min="0.01" step="0.01" required'));
        break;

      case 'PUNTOS_LEALTAD':
        rows =
          row('Puntos por cada $1 MXN', num('puntosPorPeso', datos.puntosPorPeso ?? 1, 'pts', 'min="0.01" step="0.01" required'));
        break;

      default:
        return '';
    }

    return `
      <div class="cpt-head">
        <div class="cpt-head-icon">${icon}</div>
        <div class="cpt-head-title">${title}</div>
      </div>
      <div class="cpt-body">${rows}</div>`;
  }

  // ── Campañas ──────────────────────────────────────────────────────────

  function _escucharCampanas(container) {
    if (_unsubCampanas) _unsubCampanas();
    const q = query(collection(db, COL_CAMPANAS), orderBy('fechaInicioTs', 'desc'));
    _unsubCampanas = onSnapshot(q, snap => {
      const grid = container.querySelector('#gridCampanas');
      if (!snap.docs.length) {
        grid.innerHTML = '<p class="empty-msg">Sin campañas aún.</p>';
        return;
      }
      const ahora = Date.now();
      grid.innerHTML = snap.docs.map(d => {
        const c = d.data();
        const finTs = c.fechaFinTs || 0;
        const vigente = c.activa && finTs > ahora;
        const tipoLabel = TIPOS_PROMO[c.tipo] || c.tipo || '—';
        const puedeEditar = _puedeConfig();
        return `<div class="promo-card" data-id="${esc(d.id)}">
          <div class="promo-card-top">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
              <div class="promo-card-title">${esc(c.nombre)}</div>
              <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;white-space:nowrap;
                background:${vigente ? '#16A34A22' : '#9CA3AF22'};color:${vigente ? '#22C55E' : '#9CA3AF'}">
                ${vigente ? '● Activa' : '○ Inactiva'}
              </span>
            </div>
            <span class="promo-card-tipo">${esc(tipoLabel)}</span>
          </div>
          <div class="promo-card-desc">${esc(c.descripcion || 'Sin descripción')}</div>
          <div class="promo-card-dates">📅 ${_tsToDate(c.fechaInicioTs)} → ${_tsToDate(c.fechaFinTs)}</div>
          <div class="promo-card-footer">
            ${puedeEditar ? `<button class="btn-sm btn-edit" data-id="${esc(d.id)}"
              style="flex:1;padding:7px;border-radius:7px;border:1px solid var(--border);
                background:var(--surface-2);color:var(--text-sec);font-size:11px;cursor:pointer">
              ✏️ Editar</button>
              <button class="btn-sm btn-del" data-id="${esc(d.id)}"
                style="padding:7px 10px;border-radius:7px;border:1px solid #FCA5A5;
                  background:#FEF2F2;color:#EF4444;font-size:11px;cursor:pointer">
                🗑️</button>` : ''}
          </div>
        </div>`;
      }).join('');

      if (_puedeConfig()) {
        grid.querySelectorAll('.btn-edit').forEach(btn =>
          btn.addEventListener('click', () => _abrirPanelCampana(container, snap.docs.find(d => d.id === btn.dataset.id))));
        grid.querySelectorAll('.btn-del').forEach(btn =>
          btn.addEventListener('click', () => _eliminarCampana(btn.dataset.id)));
      }
    });
  }

  function _bindCampanas(container) {
    if (!_puedeConfig()) return;

    container.querySelector('#btnNuevaCampana')?.addEventListener('click', () =>
      _abrirPanelCampana(container, null));
    container.querySelector('#cerrarPanelCampana').addEventListener('click', () =>
      _cerrarPanelCampana(container));
    container.querySelector('#btnCancelarCampana').addEventListener('click', () =>
      _cerrarPanelCampana(container));
    container.querySelector('#modalCampanaOverlay').addEventListener('click', e => {
      if (e.target === e.currentTarget) _cerrarPanelCampana(container);
    });

    container.querySelector('#selectTipoPromo')?.addEventListener('change', e => {
      container.querySelector('#camposTipo').innerHTML = _renderCamposTipo(e.target.value);
    });

    container.querySelector('#formCampana').addEventListener('submit', async e => {
      e.preventDefault();
      await _guardarCampana(container, e.target);
    });
  }

  function _abrirPanelCampana(container, docSnap) {
    const panel  = container.querySelector('#modalCampanaOverlay');
    const titulo = container.querySelector('#panelCampanaTitulo');
    const form   = container.querySelector('#formCampana');
    form.reset();
    delete form.dataset.editId;

    let tipo = 'DESCUENTO_MONTO_PEDIDO';
    let datos = {};

    if (docSnap) {
      titulo.textContent = 'Editar campaña';
      const c = docSnap.data();
      tipo = c.tipo || tipo;
      datos = c;
      form.nombre.value      = c.nombre || '';
      form.descripcion.value = c.descripcion || '';
      form.activa.checked    = c.activa !== false;
      form.fechaInicio.value = _tsToDateInput(c.fechaInicioTs);
      form.fechaFin.value    = _tsToDateInput(c.fechaFinTs);
      form.dataset.editId    = docSnap.id;
    } else {
      titulo.textContent = 'Nueva campaña';
    }

    const sel = form.querySelector('[name="tipo"]');
    if (sel) sel.value = tipo;
    container.querySelector('#camposTipo').innerHTML = _renderCamposTipo(tipo, datos);
    panel.classList.add('open');
    _regEsc(() => _cerrarPanelCampana(container));
  }

  function _cerrarPanelCampana(container) {
    _unregEsc();
    container.querySelector('#modalCampanaOverlay').classList.remove('open');
  }

  async function _guardarCampana(container, form) {
    const nombre     = form.nombre.value.trim();
    const fechaInicio = form.fechaInicio.value;
    const fechaFin   = form.fechaFin.value;
    if (!nombre)                        { window.toast?.('El nombre es obligatorio.', 'warn'); return; }
    if (!fechaInicio || !fechaFin)      { window.toast?.('Las fechas son obligatorias.', 'warn'); return; }
    if (fechaFin < fechaInicio)         { window.toast?.('La fecha fin debe ser posterior.', 'warn'); return; }

    const tipo = form.tipo?.value || 'DESCUENTO_MONTO_PEDIDO';
    const fechaInicioTs = new Date(fechaInicio + 'T00:00:00').getTime();
    const fechaFinTs    = new Date(fechaFin    + 'T23:59:59').getTime();

    const datos = {
      nombre:       nombre.slice(0, 80),
      descripcion:  form.descripcion.value.trim().slice(0, 300),
      tipo,
      fechaInicio,
      fechaFin,
      fechaInicioTs,
      fechaFinTs,
      activa:       form.activa.checked,
      actualizadoEn: serverTimestamp(),
      actualizadoPor: Sesion.alias
    };

    // Campos específicos por tipo
    const fd = f => form.querySelector(`[name="${f}"]`);
    switch (tipo) {
      case 'DESCUENTO_MONTO_PEDIDO':
        datos.umbralPedido   = parseFloat(fd('umbralPedido')?.value) || 0;
        datos.montoDescuento = parseFloat(fd('montoDescuento')?.value) || 0;
        break;
      case 'DESCUENTO_MONTO_PRODUCTO':
        datos.productoIdPretoriano = parseInt(fd('productoIdPretoriano')?.value, 10) || 0;
        datos.umbralProducto       = parseFloat(fd('umbralProducto')?.value) || 0;
        datos.montoDescuento       = parseFloat(fd('montoDescuento')?.value) || 0;
        break;
      case 'PRODUCTO_GRATIS':
        datos.modoGratis                  = fd('modoGratis')?.value || 'POR_MONTO';
        datos.umbralMonto                 = parseFloat(fd('umbralMonto')?.value) || 0;
        datos.productoTriggerIdPretoriano = parseInt(fd('productoTriggerIdPretoriano')?.value, 10) || 0;
        datos.cantidadMinimaTrigger       = parseFloat(fd('cantidadMinimaTrigger')?.value) || 1;
        datos.productoGratisIdPretoriano  = parseInt(fd('productoGratisIdPretoriano')?.value, 10) || 0;
        datos.productoGratisNombre        = fd('productoGratisNombre')?.value.trim() || '';
        datos.cantidadGratis              = parseFloat(fd('cantidadGratis')?.value) || 1;
        datos.valorUnitarioGratis         = parseFloat(fd('valorUnitarioGratis')?.value) || 0;
        break;
      case 'PRECIO_FLASH':
        datos.productoIdPretoriano = parseInt(fd('productoIdPretoriano')?.value, 10) || 0;
        datos.precioFlash          = parseFloat(fd('precioFlash')?.value) || 0;
        break;
      case 'PUNTOS_LEALTAD':
        datos.puntosPorPeso = parseFloat(fd('puntosPorPeso')?.value) || 1;
        break;
    }

    try {
      if (form.dataset.editId) {
        await updateDoc(doc(db, COL_CAMPANAS, form.dataset.editId), datos);
      } else {
        datos.creadoEn  = serverTimestamp();
        datos.creadoPor = Sesion.alias;
        await addDoc(collection(db, COL_CAMPANAS), datos);
      }
      _cerrarPanelCampana(container);
    } catch (err) {
      window.toast?.('Error al guardar: ' + err.message, 'error');
    }
  }

  async function _eliminarCampana(id) {
    if (!await window.modal({ title: "Eliminar campaña", message: "¿Eliminar esta campaña?", danger: true, confirmLabel: "Eliminar" })) return;
    try { await deleteDoc(doc(db, COL_CAMPANAS, id)); }
    catch (err) { window.toast?.("Error al eliminar: " + err.message, "error"); }
  }

  // ── Puntos por cliente ────────────────────────────────────────────────

  function _bindPuntos(container) {
    container.querySelector('#buscarCliente').addEventListener('input', e =>
      _cargarPuntos(container, e.target.value.trim()));

    container.querySelector('#formAjustePuntos').addEventListener('submit', async e => {
      e.preventDefault();
      await _confirmarAjustePuntos(container, e.target);
    });
    container.querySelector('#btnCancelarPuntos').addEventListener('click', () =>
      container.querySelector('#modalPuntos').classList.add('hidden'));
  }

  async function _cargarPuntos(container, busqueda) {
    const tbody = container.querySelector('#tbodyPuntos');
    tbody.innerHTML = '<tr><td colspan="4">Cargando…</td></tr>';
    try {
      const snap = await getDocs(query(collection(db, COL_PUNTOS), orderBy('puntos', 'desc'), limit(100)));
      if (!snap.docs.length) { tbody.innerHTML = '<tr><td colspan="4">Sin registros.</td></tr>'; return; }

      // Resolver nombres de cliente en paralelo desde la colección 'clientes'
      const nombresMap = {};
      await Promise.all(snap.docs.map(async d => {
        const p = d.data();
        if (p.clienteNombre) { nombresMap[d.id] = p.clienteNombre; return; }
        try {
          const cs = await getDoc(doc(db, 'clientes', d.id));
          nombresMap[d.id] = cs.exists() ? (cs.data().nombre || p.clienteId || d.id) : (p.clienteId || d.id);
        } catch (_) { nombresMap[d.id] = p.clienteId || d.id; }
      }));

      let docs = snap.docs;
      if (busqueda) {
        const lower = norm(busqueda);
        docs = docs.filter(d => norm(nombresMap[d.id] || '').includes(lower));
      }
      if (!docs.length) { tbody.innerHTML = '<tr><td colspan="4">Sin resultados.</td></tr>'; return; }

      tbody.innerHTML = docs.map(d => {
        const p = d.data();
        const nombre = nombresMap[d.id] || d.id;
        const ts = p.ultimaActividad;
        const fecha = ts ? new Date(typeof ts === 'number' ? ts : ts.toMillis?.() ?? ts).toLocaleDateString('es-MX') : '—';
        return `<tr>
          <td style="font-weight:500">${esc(nombre)}</td>
          <td class="num" style="text-align:right;font-weight:700;font-variant-numeric:tabular-nums">${Number(p.puntos || 0).toLocaleString('es-MX')}</td>
          <td style="font-size:11px;color:#9CA3AF">${esc(fecha)}</td>
          <td style="text-align:center"><button class="btn-sm" data-cid="${esc(d.id)}" data-cnombre="${esc(nombre)}">Ajustar</button></td>
        </tr>`;
      }).join('');
      tbody.querySelectorAll('button[data-cid]').forEach(btn =>
        btn.addEventListener('click', () => _abrirModalPuntos(container, btn.dataset.cid, btn.dataset.cnombre)));
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4">Error: ${esc(err.message)}</td></tr>`;
    }
  }

  async function _abrirModalPuntos(container, clienteId, clienteNombre) {
    const modal = container.querySelector('#modalPuntos');
    const form  = container.querySelector('#formAjustePuntos');
    form.reset();
    form.clienteId.value = clienteId;
    form.clienteNombre.value = clienteNombre;
    container.querySelector('#modalPuntosTitulo').textContent = `Ajustar puntos — ${clienteNombre}`;
    _regEsc(() => { modal.classList.add('hidden'); _unregEsc(); });

    const sel = form.campanaId;
    sel.innerHTML = '<option value="">Sin campaña</option>';
    try {
      const ahora = Date.now();
      const snap = await getDocs(query(collection(db, COL_CAMPANAS),
        where('activa', '==', true)));
      const docsVigentes = snap.docs.filter(d => (d.data().fechaFinTs || 0) >= ahora);
      docsVigentes.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id; opt.textContent = d.data().nombre;
        sel.appendChild(opt);
      });
    } catch (_) {}
    modal.classList.remove('hidden');
  }

  async function _confirmarAjustePuntos(container, form) {
    const clienteId = form.clienteId.value;
    const puntos    = parseInt(form.puntos.value, 10);
    if (!clienteId || isNaN(puntos) || puntos < 1) { window.toast?.('Ingresa un número de puntos válido.', 'warn'); return; }
    const delta = form.operacion.value === 'sumar' ? puntos : -Math.abs(puntos);
    try {
      await addDoc(collection(db, COL_HISTORIAL), {
        clienteId,
        clienteNombre: form.clienteNombre.value || clienteId,
        campanaId: form.campanaId.value || null,
        puntos: delta,
        tipo: form.operacion.value,
        nota: form.nota.value.trim().slice(0, 200),
        registradoEn:  serverTimestamp(),
        registradoPor: Sesion.alias
      });
      const ref  = doc(db, COL_PUNTOS, clienteId);
      const snap = await getDoc(ref);
      const nuevo = Math.max(0, (snap.exists() ? (snap.data().puntos || 0) : 0) + delta);
      const clienteNombreGuardado = form.clienteNombre.value || clienteId;
      await setDoc(ref, { puntos: nuevo, clienteNombre: clienteNombreGuardado, ultimaActividad: Date.now() }, { merge: true });
      container.querySelector('#modalPuntos').classList.add('hidden');
      _cargarPuntos(container, '');
    } catch (err) { window.toast?.('Error: ' + err.message, 'error'); }
  }

  // ── Historial de canje ────────────────────────────────────────────────

  function _escucharHistorial(container) {
    if (_unsubPuntos) _unsubPuntos();
    const q = query(collection(db, COL_HISTORIAL), orderBy('registradoEn', 'desc'), limit(200));
    _unsubPuntos = onSnapshot(q, snap => {
      const tbody = container.querySelector('#tbodyHistorial');
      if (snap.empty) { tbody.innerHTML = '<tr><td colspan="5">Sin registros.</td></tr>'; return; }
      tbody.innerHTML = snap.docs.map(d => {
        const h = d.data();
        const fecha = h.registradoEn?.toDate ? h.registradoEn.toDate().toLocaleDateString('es-MX') : '—';
        const signo = h.puntos > 0 ? '+' : '';
        return `<tr>
          <td>${esc(fecha)}</td>
          <td>${esc(h.clienteNombre || h.clienteId || '')}</td>
          <td>${esc(h.campanaId || '—')}</td>
          <td class="num">${signo}${esc(String(h.puntos))}</td>
          <td>${esc(h.tipo || '')}</td>
        </tr>`;
      }).join('');
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  function _tsToDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function _tsToDateInput(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function destroy() {
    if (_unsubCampanas) { _unsubCampanas(); _unsubCampanas = null; }
    if (_unsubPuntos)   { _unsubPuntos();   _unsubPuntos   = null; }
  }

  return { init, mount: init, destroy };
})();

// ─── S31: Configuración de lealtad por producto / categoría ──────────────────
// Colección: lealtad_config_producto/{id}
//   { tipo: "producto"|"categoria", refId, nombre, puntosPorPeso, activo }
// ─────────────────────────────────────────────────────────────────────────────
export const LealtadConfigModule = (() => {
  const COL = 'lealtad_config_producto';
  let _unsub   = null;
  let _container = null;

  function mount(container) {
    _container = container;
    _container.innerHTML = _html();
    _bindEvents();
    _cargar();
  }

  function destroy() { if (_unsub) { _unsub(); _unsub = null; } }

  function _html() {
    return `
<div style="padding:1rem">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
    <h3 style="margin:0">⭐ Lealtad por Producto / Categoría</h3>
    <button id="lc-btn-nuevo" style="background:#7C3AED;color:#fff;border:none;border-radius:7px;padding:.5rem 1rem;cursor:pointer;font-weight:700">+ Nueva regla</button>
  </div>
  <p style="font-size:.85rem;color:var(--muted);margin-bottom:1rem">
    Define puntos específicos por producto o categoría. Si un producto tiene regla propia, se usa esa; si no, la de su categoría; si no, la global de la campaña.
  </p>
  <div id="lc-tabla-wrap" style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:.9rem">
      <thead>
        <tr style="background:var(--surface-2)">
          <th style="padding:.6rem .8rem;text-align:left;border-bottom:2px solid var(--border)">Tipo</th>
          <th style="padding:.6rem .8rem;text-align:left;border-bottom:2px solid var(--border)">Nombre</th>
          <th style="padding:.6rem .8rem;text-align:left;border-bottom:2px solid var(--border)">Pts / $1</th>
          <th style="padding:.6rem .8rem;text-align:left;border-bottom:2px solid var(--border)">Activo</th>
          <th style="padding:.6rem .8rem;text-align:left;border-bottom:2px solid var(--border)">Acciones</th>
        </tr>
      </thead>
      <tbody id="lc-tbody"></tbody>
    </table>
    <p id="lc-empty" style="text-align:center;color:var(--muted);padding:2rem;display:none">Sin reglas configuradas.</p>
  </div>
</div>
<div id="lc-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;justify-content:center;align-items:center">
  <div style="background:var(--surface);border-radius:12px;padding:1.5rem;width:min(400px,95vw)">
    <h4 id="lc-modal-title" style="margin:0 0 1rem">Nueva regla de lealtad</h4>
    <label style="display:block;font-size:.82rem;font-weight:700;margin-bottom:.3rem">Tipo</label>
    <select id="lc-tipo" style="width:100%;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);margin-bottom:.75rem">
      <option value="producto">Producto específico</option>
      <option value="categoria">Categoría de productos</option>
    </select>
    <label style="display:block;font-size:.82rem;font-weight:700;margin-bottom:.3rem">ID de referencia (refId)</label>
    <input id="lc-refid" type="text" placeholder="ID del producto o nombre de categoría"
      style="width:100%;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;margin-bottom:.75rem" />
    <label style="display:block;font-size:.82rem;font-weight:700;margin-bottom:.3rem">Nombre descriptivo</label>
    <input id="lc-nombre" type="text" placeholder="Ej: Fertilizante Premium / Categoría Herbicidas"
      style="width:100%;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;margin-bottom:.75rem" />
    <label style="display:block;font-size:.82rem;font-weight:700;margin-bottom:.3rem">Puntos por cada $1</label>
    <input id="lc-puntos" type="number" min="0.01" step="0.01" value="2"
      style="width:100%;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-primary);box-sizing:border-box;margin-bottom:.75rem" />
    <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin-bottom:1rem">
      <input id="lc-activo" type="checkbox" checked /> Activo
    </label>
    <div style="display:flex;gap:.5rem;justify-content:flex-end">
      <button id="lc-btn-cancelar" style="padding:.5rem 1rem;border:1px solid var(--border);border-radius:6px;background:var(--surface);cursor:pointer">Cancelar</button>
      <button id="lc-btn-guardar" style="padding:.5rem 1rem;background:#7C3AED;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700">Guardar</button>
    </div>
  </div>
</div>`;
  }

  function _bindEvents() {
    _container.querySelector("#lc-btn-nuevo").addEventListener("click", () => _abrirModal());
    _container.querySelector("#lc-btn-cancelar").addEventListener("click", _cerrarModal);
    _container.querySelector("#lc-btn-guardar").addEventListener("click", _guardar);
  }

  function _cargar() {
    _unsub = onSnapshot(query(collection(db, COL), orderBy("nombre")), snap => {
      const tbody = _container?.querySelector("#lc-tbody");
      const empty = _container?.querySelector("#lc-empty");
      if (!tbody) return;
      if (snap.empty) { tbody.innerHTML = ""; empty.style.display = "block"; return; }
      empty.style.display = "none";
      tbody.innerHTML = snap.docs.map(doc => {
        const d = doc.data();
        return `<tr>
          <td style="padding:.5rem .8rem;border-bottom:1px solid var(--border)">${d.tipo === "producto" ? "📦 Producto" : "🗂️ Categoría"}</td>
          <td style="padding:.5rem .8rem;border-bottom:1px solid var(--border)">${d.nombre || d.refId}</td>
          <td style="padding:.5rem .8rem;border-bottom:1px solid var(--border);font-weight:700;color:#7C3AED">${d.puntosPorPeso ?? 1}</td>
          <td style="padding:.5rem .8rem;border-bottom:1px solid var(--border)">${d.activo ? "✅" : "⏸️"}</td>
          <td style="padding:.5rem .8rem;border-bottom:1px solid var(--border)">
            <button class="lc-edit" data-id="${doc.id}" style="background:none;border:1px solid var(--border);border-radius:5px;padding:.2rem .5rem;cursor:pointer;font-size:.8rem">Editar</button>
            <button class="lc-del" data-id="${doc.id}" style="background:none;border:1px solid #DC2626;color:#DC2626;border-radius:5px;padding:.2rem .5rem;cursor:pointer;font-size:.8rem;margin-left:.3rem">Borrar</button>
          </td>
        </tr>`;
      }).join("");

      tbody.querySelectorAll(".lc-edit").forEach(btn => {
        const doc2 = snap.docs.find(d => d.id === btn.dataset.id);
        if (doc2) btn.addEventListener("click", () => _abrirModal(doc2.id, doc2.data()));
      });
      tbody.querySelectorAll(".lc-del").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!await window.modal({ title: "Eliminar regla", message: "¿Eliminar esta regla de lealtad?", danger: true, confirmLabel: "Eliminar" })) return;
          try { await deleteDoc(doc(db, COL, btn.dataset.id)); }
          catch (err) { window.toast?.("Error al eliminar: " + err.message, "error"); }
        });
      });
    });
  }

  let _editId = null;

  function _abrirModal(id = null, data = null) {
    _editId = id;
    const overlay = _container.querySelector("#lc-modal-overlay");
    _container.querySelector("#lc-modal-title").textContent = id ? "Editar regla" : "Nueva regla de lealtad";
    if (data) {
      _container.querySelector("#lc-tipo").value    = data.tipo    || "producto";
      _container.querySelector("#lc-refid").value   = data.refId   || "";
      _container.querySelector("#lc-nombre").value  = data.nombre  || "";
      _container.querySelector("#lc-puntos").value  = data.puntosPorPeso ?? 1;
      _container.querySelector("#lc-activo").checked = data.activo !== false;
    } else {
      _container.querySelector("#lc-tipo").value    = "producto";
      _container.querySelector("#lc-refid").value   = "";
      _container.querySelector("#lc-nombre").value  = "";
      _container.querySelector("#lc-puntos").value  = "2";
      _container.querySelector("#lc-activo").checked = true;
    }
    overlay.style.display = "flex";
  }

  function _cerrarModal() {
    _container.querySelector("#lc-modal-overlay").style.display = "none";
    _editId = null;
  }

  async function _guardar() {
    const tipo   = _container.querySelector("#lc-tipo").value;
    const refId  = _container.querySelector("#lc-refid").value.trim();
    const nombre = _container.querySelector("#lc-nombre").value.trim();
    const pts    = parseFloat(_container.querySelector("#lc-puntos").value) || 1;
    const activo = _container.querySelector("#lc-activo").checked;
    if (!refId) { window.toast?.("Ingresa el ID de referencia.", "warn"); return; }

    const payload = { tipo, refId, nombre: nombre || refId, puntosPorPeso: pts, activo, timestamp: serverTimestamp() };
    const btn = _container.querySelector("#lc-btn-guardar");
    if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }
    try {
      if (_editId) {
        await setDoc(doc(db, COL, _editId), payload, { merge: true });
      } else {
        await addDoc(collection(db, COL), payload);
      }
      _cerrarModal();
    } catch (err) {
      window.toast?.("Error al guardar: " + err.message, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Guardar"; }
    }
  }

  return { mount, destroy };
})();
