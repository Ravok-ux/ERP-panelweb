// Cotizaciones — Panel web
import { db } from './firebase-config.js';
import { Sesion } from './auth.js';
import { esc, logAudit, norm } from './app.js';
import { cargarNombres, resolverNombre } from './nombres-cache.js';
import {
  collection, doc, addDoc, updateDoc, setDoc, getDoc,
  onSnapshot, query, orderBy, where, getDocs,
  serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const fmtMXN   = v => Number(v || 0).toLocaleString('es-MX', { style:'currency', currency:'MXN' });
const fmtMoneda = (v, m) => m === 'USD'
  ? `USD $${Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2})}`
  : fmtMXN(v);
const fmtFecha = ts => ts
  ? new Date(typeof ts === 'number' ? ts : ts.toMillis?.() ?? ts)
      .toLocaleDateString('es-MX',{day:'2-digit',month:'short',year:'numeric'})
  : '—';
const diasRestantes = venceEn => {
  if (!venceEn) return null;
  return Math.ceil((venceEn - Date.now()) / 86400000);
};

const ESTADOS = {
  BORRADOR:   { label:'Borrador',            color:'#6B7280', bg:'#F3F4F6', icon:'📝' },
  ENVIADA:    { label:'Enviada',             color:'#D97706', bg:'#FEF3C7', icon:'📤' },
  APROBADA:   { label:'Aprobada',            color:'#16A34A', bg:'#DCFCE7', icon:'✅' },
  RECHAZADA:  { label:'Rechazada',           color:'#DC2626', bg:'#FEE2E2', icon:'❌' },
  EXPIRADA:   { label:'Expirada',            color:'#9CA3AF', bg:'#F9FAFB', icon:'⏰' },
  CONVERTIDA: { label:'Convertida en pedido',color:'#7C3AED', bg:'#EDE9FE', icon:'🛒' },
};

export const CotizacionesPanelModule = (() => {
  let _unsub       = null;
  let _vigenciaDias = 15;
  let _filtroStatus = '';
  let _busqueda     = '';
  let _allDocs      = [];

  // ── Permisos ──────────────────────────────────────────────────────────
  const _puedeEditar = () =>
    Sesion.esSuperAdmin?.() || ['GERENTE','ADMINISTRADOR','GERENTE_ZONA'].includes(Sesion.rol);

  // ── Init ──────────────────────────────────────────────────────────────
  async function init(container) {
    try {
      const cfgSnap = await getDoc(doc(db, 'configuracion', 'cotizaciones'));
      if (cfgSnap.exists()) _vigenciaDias = cfgSnap.data().vigenciaDias || 15;
    } catch (_) {}

    container.innerHTML = `
    <style>
      .cot-wrap { padding:0 4px }
      .cot-header { display:flex; align-items:flex-start; justify-content:space-between;
        gap:12px; flex-wrap:wrap; margin-bottom:16px }
      .cot-kpis { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr));
        gap:10px; margin-bottom:16px }
      .cot-kpi { background:var(--surface); border:1px solid var(--border); border-radius:10px;
        padding:14px 16px; display:flex; flex-direction:column; gap:3px }
      .cot-kpi-val { font-size:24px; font-weight:800; font-variant-numeric:tabular-nums }
      .cot-kpi-lbl { font-size:10px; font-weight:600; color:#9CA3AF;
        text-transform:uppercase; letter-spacing:.06em }
      .cot-filtros { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:12px }
      .cot-pill { padding:5px 12px; border-radius:20px; border:1.5px solid var(--border);
        background:transparent; font-size:11.5px; font-weight:600;
        color:#6B7280; cursor:pointer; transition:all .15s; white-space:nowrap }
      .cot-pill.active { font-weight:700 }
      .cot-tabla-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:10px }
      .cot-tabla { width:100%; border-collapse:collapse; font-size:13px }
      .cot-tabla th { background:var(--surface); padding:10px 14px;
        text-align:left; font-size:10px; font-weight:700; color:#9CA3AF;
        text-transform:uppercase; letter-spacing:.06em;
        border-bottom:1px solid var(--border); white-space:nowrap }
      .cot-tabla td { padding:11px 14px; border-bottom:1px solid var(--border);
        color:var(--text-primary); vertical-align:middle }
      .cot-tabla tbody tr:last-child td { border-bottom:none }
      .cot-tabla tbody tr:hover { background:var(--surface) }
      .cot-folio { font-weight:700; font-family:monospace; font-size:12px }
      .cot-monto { font-variant-numeric:tabular-nums; font-weight:600;
        text-align:right; white-space:nowrap }
      .cot-estado { display:inline-flex; align-items:center; gap:4px;
        padding:3px 8px; border-radius:20px; font-size:11px; font-weight:700;
        white-space:nowrap }
      .cot-vence-ok   { color:#16A34A }
      .cot-vence-warn { color:#D97706; font-weight:700 }
      .cot-vence-venc { color:#DC2626; font-weight:700 }
      /* Modal detalle */
      .cot-modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5);
        z-index:2000; align-items:flex-start; justify-content:center;
        overflow-y:auto; padding:20px }
      .cot-modal.open { display:flex }
      .cot-modal-box { background:var(--surface); border:1px solid var(--border);
        border-radius:14px; width:100%; max-width:720px; box-shadow:0 24px 64px rgba(0,0,0,.4);
        overflow:hidden; margin:auto }
      .cot-modal-header { display:flex; align-items:center; gap:12px; padding:18px 20px;
        border-bottom:1px solid var(--border) }
      .cot-modal-body { padding:20px; overflow-y:auto; max-height:72vh }
      .cot-modal-footer { display:flex; justify-content:flex-end; gap:8px;
        padding:14px 20px; border-top:1px solid var(--border) }
      .cot-det-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px;
        margin-bottom:16px }
      .cot-det-field { display:flex; flex-direction:column; gap:3px }
      .cot-det-lbl { font-size:10px; font-weight:700; color:#9CA3AF;
        text-transform:uppercase; letter-spacing:.06em }
      .cot-det-val { font-size:13px; color:var(--text-primary); font-weight:500 }
      .cot-items-table { width:100%; border-collapse:collapse; font-size:12px; margin-top:12px }
      .cot-items-table th { background:var(--surface-2,var(--surface));
        padding:8px 12px; text-align:left; font-size:10px; font-weight:700;
        color:#9CA3AF; text-transform:uppercase; border-bottom:1px solid var(--border) }
      .cot-items-table td { padding:9px 12px; border-bottom:1px solid var(--border) }
      .cot-items-table tfoot td { font-weight:800; border-top:2px solid var(--border);
        border-bottom:none; padding-top:12px }
    </style>

    <div class="cot-wrap">
      <!-- Header -->
      <div class="cot-header">
        <div>
          <div id="cot-subtitulo" style="font-size:12px;color:#9CA3AF;margin-top:2px">Cargando…</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn-secondary" id="cot-btn-vigencia" style="font-size:12px">
            ⚙ Vigencia: <strong id="cot-vig-label">${_vigenciaDias}d</strong>
          </button>
          ${_puedeEditar() ? `<button class="btn-primary" id="cot-btn-nueva" style="font-size:12px">
            + Nueva cotización
          </button>` : ''}
        </div>
      </div>

      <!-- KPIs -->
      <div class="cot-kpis">
        <div class="cot-kpi">
          <div class="cot-kpi-val" id="kpi-total" style="color:var(--text-primary)">—</div>
          <div class="cot-kpi-lbl">Total</div>
        </div>
        <div class="cot-kpi">
          <div class="cot-kpi-val" id="kpi-enviadas" style="color:#D97706">—</div>
          <div class="cot-kpi-lbl">📤 Enviadas</div>
        </div>
        <div class="cot-kpi">
          <div class="cot-kpi-val" id="kpi-aprobadas" style="color:#16A34A">—</div>
          <div class="cot-kpi-lbl">✅ Aprobadas</div>
        </div>
        <div class="cot-kpi">
          <div class="cot-kpi-val" id="kpi-rechazadas" style="color:#DC2626">—</div>
          <div class="cot-kpi-lbl">❌ Rechazadas</div>
        </div>
        <div class="cot-kpi">
          <div class="cot-kpi-val" id="kpi-convertidas" style="color:#7C3AED">—</div>
          <div class="cot-kpi-lbl">🛒 Convertidas</div>
        </div>
      </div>

      <!-- Filtros -->
      <div class="cot-filtros">
        <span style="font-size:11px;font-weight:700;color:#9CA3AF;flex-shrink:0">Filtrar:</span>
        ${Object.entries(ESTADOS).map(([k,v]) =>
          `<button class="cot-pill" data-status="${k}"
            style="border-color:${v.color}20;color:${v.color}">
            ${v.icon} ${v.label}
          </button>`).join('')}
        <button class="cot-pill active" data-status=""
          style="background:var(--surface);color:var(--text-primary);
            border-color:var(--text-primary)">Todos</button>
        <input id="cot-buscar" type="search" placeholder="Buscar folio / cliente…"
          style="margin-left:auto;padding:6px 10px;border:1px solid var(--border);
            border-radius:7px;background:var(--surface);color:var(--text-primary);
            font-size:12px;min-width:200px">
      </div>

      <!-- Tabla -->
      <div class="cot-tabla-wrap">
        <table class="cot-tabla">
          <thead><tr>
            <th>Folio</th>
            <th>Cliente</th>
            <th>Ingeniero</th>
            <th style="text-align:right">Total</th>
            <th>Creada</th>
            <th>Vence</th>
            <th>Estado</th>
            <th></th>
          </tr></thead>
          <tbody id="cot-tbody">
            <tr><td colspan="8" style="padding:40px;text-align:center;color:#9CA3AF">
              Cargando cotizaciones…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Modal detalle / crear -->
    <div class="cot-modal" id="cot-modal">
      <div class="cot-modal-box">
        <div class="cot-modal-header">
          <div style="flex:1">
            <div style="font-size:14px;font-weight:800;color:var(--text-primary)"
              id="cot-modal-titulo">Cotización</div>
            <div style="font-size:11px;color:#9CA3AF;margin-top:2px" id="cot-modal-sub"></div>
          </div>
          <button id="cot-modal-close"
            style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);
              background:transparent;cursor:pointer;color:#64748B;font-size:14px">✕</button>
        </div>
        <div class="cot-modal-body" id="cot-modal-body"></div>
        <div class="cot-modal-footer" id="cot-modal-footer"></div>
      </div>
    </div>

    <!-- Modal config vigencia -->
    <div class="cot-modal" id="cot-modal-vig">
      <div class="cot-modal-box" style="max-width:360px">
        <div class="cot-modal-header">
          <div style="font-size:14px;font-weight:800;color:var(--text-primary)">
            ⚙ Vigencia por defecto
          </div>
          <button id="cot-vig-close"
            style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);
              background:transparent;cursor:pointer;color:#64748B;font-size:14px">✕</button>
        </div>
        <div class="cot-modal-body">
          <label style="font-size:12px;font-weight:600;color:#9CA3AF;
            text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">
            Días de vigencia
          </label>
          <input id="cot-vig-input" type="number" min="1" max="365" value="${_vigenciaDias}"
            style="width:100%;padding:10px 12px;border:1px solid var(--border);
              border-radius:8px;background:var(--surface);color:var(--text-primary);
              font-size:16px;font-weight:700;text-align:center;box-sizing:border-box">
        </div>
        <div class="cot-modal-footer">
          <button id="cot-vig-cancel" class="btn-secondary">Cancelar</button>
          <button id="cot-vig-guardar" class="btn-primary">Guardar</button>
        </div>
      </div>
    </div>`;

    cargarNombres();
    _bindUI(container);
    _escuchar();
  }

  // ── Firestore ─────────────────────────────────────────────────────────
  function _escuchar() {
    _unsub?.();
    const q = _filtroStatus
      ? query(collection(db,'cotizaciones'), where('status','==',_filtroStatus),
          orderBy('creadaEn','desc'), limit(300))
      : query(collection(db,'cotizaciones'), orderBy('creadaEn','desc'), limit(300));

    _unsub = onSnapshot(q, snap => {
      _allDocs = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      _actualizarKPIs();
      _renderTabla();
    }, err => {
      console.error('[Cotizaciones]', err);
      document.getElementById('cot-tbody').innerHTML =
        `<tr><td colspan="8" style="padding:32px;text-align:center;color:#DC2626">
          Error: ${err.message}</td></tr>`;
    });
  }

  function _actualizarKPIs() {
    const todos = _allDocs;
    const cnt = k => todos.filter(d => d.status === k).length;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('kpi-total', todos.length);
    set('kpi-enviadas', cnt('ENVIADA'));
    set('kpi-aprobadas', cnt('APROBADA'));
    set('kpi-rechazadas', cnt('RECHAZADA'));
    set('kpi-convertidas', cnt('CONVERTIDA'));
    const sub = document.getElementById('cot-subtitulo');
    if (sub) {
      const venc = todos.filter(d =>
        d.venceEn && d.venceEn < Date.now() &&
        !['EXPIRADA','CONVERTIDA','RECHAZADA'].includes(d.status)).length;
      sub.textContent = `${todos.length} cotizaciones · ${cnt('APROBADA')} aprobadas · ${cnt('CONVERTIDA')} convertidas`
        + (venc ? ` · ⚠️ ${venc} vencidas` : '');
    }
  }

  function _renderTabla() {
    const tbody = document.getElementById('cot-tbody');
    if (!tbody) return;
    const q = norm(_busqueda);
    const rows = _allDocs.filter(c =>
      !q ||
      norm(c.folio).includes(q) ||
      norm(c.clienteNombre).includes(q) ||
      norm(c.ingenieroAlias).includes(q)
    );

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="padding:40px;text-align:center;color:#9CA3AF">
        ${_allDocs.length ? 'Sin resultados para la búsqueda.' : 'Sin cotizaciones registradas.'}</td></tr>`;
      return;
    }

    const ahora = Date.now();
    tbody.innerHTML = rows.map(c => {
      const est = ESTADOS[c.status] || ESTADOS.BORRADOR;
      const dias = diasRestantes(c.venceEn);
      let venceCls = 'cot-vence-ok', venceTxt = '';
      if (c.venceEn) {
        if (dias === null) venceTxt = '—';
        else if (dias < 0) { venceCls = 'cot-vence-venc'; venceTxt = `${fmtFecha(c.venceEn)} ⚠️`; }
        else if (dias <= 3) { venceCls = 'cot-vence-warn'; venceTxt = `${fmtFecha(c.venceEn)} (${dias}d)`; }
        else venceTxt = fmtFecha(c.venceEn);
      } else venceTxt = '—';

      return `<tr style="cursor:pointer" data-id="${esc(c.id)}" class="cot-row">
        <td><span class="cot-folio">${esc(c.folio||'—')}</span></td>
        <td style="font-weight:500;max-width:180px;overflow:hidden;
          text-overflow:ellipsis;white-space:nowrap">${esc(c.clienteNombre||'—')}</td>
        <td style="color:#9CA3AF;font-size:12px">${esc(resolverNombre(c.ingenieroAlias) || '—')}</td>
        <td class="cot-monto">${fmtMoneda(c.total, c.moneda)}</td>
        <td style="font-size:12px;color:#9CA3AF;white-space:nowrap">${fmtFecha(c.creadaEn)}</td>
        <td class="${venceCls}" style="font-size:12px;white-space:nowrap">${venceTxt}</td>
        <td>
          <span class="cot-estado"
            style="background:${est.bg};color:${est.color}">
            ${est.icon} ${est.label}
          </span>
        </td>
        <td>
          <div style="display:flex;gap:4px">
            <button class="btn-sm btn-outline cot-ver" data-id="${esc(c.id)}"
              style="font-size:11px;padding:4px 10px">Ver</button>
            ${['ENVIADA','APROBADA'].includes(c.status) && _puedeEditar()
              ? `<button class="btn-sm cot-convertir" data-id="${esc(c.id)}"
                  style="font-size:11px;padding:4px 10px;background:#7C3AED;
                    color:#fff;border:none;border-radius:6px;cursor:pointer">
                  🛒 Pedido
                </button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.cot-ver').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const c = _allDocs.find(d => d.id === btn.dataset.id);
        if (c) _abrirDetalle(c);
      }));
    tbody.querySelectorAll('.cot-row').forEach(tr =>
      tr.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        const c = _allDocs.find(d => d.id === tr.dataset.id);
        if (c) _abrirDetalle(c);
      }));
    tbody.querySelectorAll('.cot-convertir').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _convertirEnPedido(btn.dataset.id);
      }));
  }

  // ── Detalle ───────────────────────────────────────────────────────────
  function _abrirDetalle(c) {
    const est = ESTADOS[c.status] || ESTADOS.BORRADOR;
    const items = c.items || [];
    const totalCalc = items.reduce((s,i) => s + (i.subtotal||0), 0);
    const dias = diasRestantes(c.venceEn);

    document.getElementById('cot-modal-titulo').textContent = c.folio || 'Cotización';
    document.getElementById('cot-modal-sub').innerHTML =
      `<span class="cot-estado" style="background:${est.bg};color:${est.color};
        display:inline-flex;align-items:center;gap:4px;padding:2px 8px;
        border-radius:20px;font-size:11px;font-weight:700">
        ${est.icon} ${est.label}
      </span>${dias !== null && dias < 0 ? ' · <span style="color:#DC2626;font-weight:700">⚠️ Vencida hace '+Math.abs(dias)+'d</span>' : dias !== null && dias <= 3 ? ` · <span style="color:#D97706;font-weight:700">Vence en ${dias}d</span>` : ''}`;

    document.getElementById('cot-modal-body').innerHTML = `
      <div class="cot-det-grid">
        <div class="cot-det-field">
          <span class="cot-det-lbl">Cliente</span>
          <span class="cot-det-val">${esc(c.clienteNombre||'—')}</span>
        </div>
        <div class="cot-det-field">
          <span class="cot-det-lbl">Ingeniero</span>
          <span class="cot-det-val">${esc(resolverNombre(c.ingenieroAlias) || '—')}</span>
        </div>
        <div class="cot-det-field">
          <span class="cot-det-lbl">Creada</span>
          <span class="cot-det-val">${fmtFecha(c.creadaEn)}</span>
        </div>
        <div class="cot-det-field">
          <span class="cot-det-lbl">Vence</span>
          <span class="cot-det-val ${dias !== null && dias < 0 ? 'cot-vence-venc' : dias !== null && dias <= 3 ? 'cot-vence-warn' : ''}">${fmtFecha(c.venceEn)}</span>
        </div>
        <div class="cot-det-field">
          <span class="cot-det-lbl">Moneda</span>
          <span class="cot-det-val">${c.moneda || 'MXN'}${c.moneda === 'USD' ? ` · TC $${Number(c.tipoCambio||0).toFixed(4)}` : ''}</span>
        </div>
        <div class="cot-det-field">
          <span class="cot-det-lbl">Vigencia</span>
          <span class="cot-det-val">${c.vigenciaDias || _vigenciaDias} días</span>
        </div>
        ${c.notas ? `<div class="cot-det-field" style="grid-column:1/-1">
          <span class="cot-det-lbl">Notas</span>
          <span class="cot-det-val">${esc(c.notas)}</span>
        </div>` : ''}
        ${c.pedidoFolio ? `<div class="cot-det-field" style="grid-column:1/-1">
          <span class="cot-det-lbl">Pedido generado</span>
          <span class="cot-det-val" style="color:#7C3AED;font-weight:700">🛒 ${esc(c.pedidoFolio)}</span>
        </div>` : ''}
      </div>

      <div style="overflow-x:auto">
        <table class="cot-items-table">
          <thead><tr>
            <th>Producto</th>
            <th style="text-align:right">Cant.</th>
            <th style="text-align:right">Precio unit.</th>
            <th style="text-align:right">Subtotal</th>
          </tr></thead>
          <tbody>
            ${items.length ? items.map(i => `<tr>
              <td>${esc(i.nombreProducto||i.nombre||'—')}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">
                ${Number(i.cantidad).toLocaleString('es-MX')}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">
                ${fmtMoneda(i.precioUnitario||i.precio, c.moneda)}</td>
              <td style="text-align:right;font-weight:700;font-variant-numeric:tabular-nums">
                ${fmtMoneda(i.subtotal, c.moneda)}</td>
            </tr>`).join('') :
            `<tr><td colspan="4" style="padding:20px;text-align:center;color:#9CA3AF">
              Sin productos en esta cotización.</td></tr>`}
          </tbody>
          <tfoot><tr>
            <td colspan="3" style="text-align:right;color:#9CA3AF;font-size:12px">TOTAL</td>
            <td style="text-align:right;font-size:16px;font-weight:800;font-variant-numeric:tabular-nums">
              ${fmtMoneda(c.total || totalCalc, c.moneda)}
            </td>
          </tr></tfoot>
        </table>
      </div>`;

    // Footer con acciones
    const footer = document.getElementById('cot-modal-footer');
    footer.innerHTML = '';
    if (_puedeEditar() && ['ENVIADA','APROBADA','BORRADOR'].includes(c.status)) {
      if (['ENVIADA','APROBADA'].includes(c.status)) {
        footer.innerHTML += `
          <button id="det-aprobar" class="btn-secondary" data-id="${esc(c.id)}"
            style="background:#DCFCE7;color:#16A34A;border-color:#16A34A40;font-size:12px">
            ✅ Aprobar
          </button>
          <button id="det-rechazar" class="btn-secondary" data-id="${esc(c.id)}"
            style="background:#FEE2E2;color:#DC2626;border-color:#DC262640;font-size:12px">
            ❌ Rechazar
          </button>
          <button id="det-convertir" class="btn-primary" data-id="${esc(c.id)}"
            style="background:#7C3AED;font-size:12px">
            🛒 Convertir en pedido
          </button>`;
      }
    }

    document.getElementById('det-aprobar')?.addEventListener('click', async e => {
      await _cambiarEstado(e.target.dataset.id, 'APROBADA');
    });
    document.getElementById('det-rechazar')?.addEventListener('click', async e => {
      if (!await window.modal?.({ title:'Rechazar cotización', message:'¿Confirmar rechazo?', confirmLabel:'Rechazar' })) return;
      await _cambiarEstado(e.target.dataset.id, 'RECHAZADA');
    });
    document.getElementById('det-convertir')?.addEventListener('click', async e => {
      _cerrarModal();
      await _convertirEnPedido(e.target.dataset.id);
    });

    document.getElementById('cot-modal').classList.add('open');
  }

  async function _cambiarEstado(id, nuevoEstado) {
    try {
      await updateDoc(doc(db,'cotizaciones',id), {
        status: nuevoEstado,
        actualizadoEn: serverTimestamp(),
        actualizadoPor: Sesion.alias
      });
      logAudit('COTIZACION_ESTADO', { id, estado: nuevoEstado });
      window.toast?.(`Estado actualizado a ${ESTADOS[nuevoEstado]?.label}`, 'success');
      _cerrarModal();
    } catch(e) { window.toast?.('Error: ' + e.message, 'error'); }
  }

  // ── Convertir en pedido ───────────────────────────────────────────────
  async function _convertirEnPedido(cotId) {
    if (!await window.modal?.({ title:'Convertir en pedido',
      message:'¿Convertir esta cotización en un pedido borrador?',
      confirmLabel:'Convertir' })) return;
    try {
      const cotSnap = await getDoc(doc(db,'cotizaciones',cotId));
      if (!cotSnap.exists()) { window.toast?.('No se encontró la cotización.','error'); return; }
      const c = cotSnap.data();

      // Folio secuencial
      const cfgRef = doc(db,'configuracion_erp','ULTIMO_FOLIO_PEDIDO_WEB');
      const cfgSnap = await getDoc(cfgRef);
      const ultimo = parseInt(cfgSnap.exists() ? cfgSnap.data().valor : '0') || 0;
      const siguiente = ultimo + 1;
      const folioPed = 'N10-PED-' + String(siguiente).padStart(5,'0');
      await setDoc(cfgRef, { valor: String(siguiente) }, { merge:true });

      const pedRef = await addDoc(collection(db,'pedidos'), {
        folio:          folioPed,
        clienteId:      c.clienteId || '',
        clienteNombre:  c.clienteNombre || '',
        ingenieroAlias: c.ingenieroAlias || '',
        tipoPedido:     'VENTA_RUTA',
        tipoVenta:      'CONTADO',
        status:         'BORRADOR',
        subtotal:       c.subtotal || 0,
        total:          c.total || 0,
        totalMxn:       c.totalMxn || c.total || 0,
        moneda:         c.moneda || 'MXN',
        tipoCambio:     c.tipoCambio || 1,
        items:          c.items || [],
        cotizacionId:   cotId,
        cotizacionFolio: c.folio || '',
        creadoEn:       serverTimestamp(),
        creadoPor:      Sesion.alias
      });

      await updateDoc(doc(db,'cotizaciones',cotId), {
        status: 'CONVERTIDA',
        pedidoFirestoreId: pedRef.id,
        pedidoFolio: folioPed,
        actualizadoEn: serverTimestamp()
      });

      logAudit('COTIZACION_CONVERTIDA', { cotId, folioPed });
      window.toast?.(`✅ Pedido ${folioPed} creado en borrador`, 'success');

      if (await window.modal?.({ title:'Pedido creado', message:`${folioPed} fue creado. ¿Ir al módulo de Pedidos?`,
        confirmLabel:'Ir a Pedidos', cancelLabel:'Quedarme' })) {
        window.navigate?.('pedidos');
      }
    } catch(e) { window.toast?.('Error al convertir: ' + e.message, 'error'); }
  }

  // ── UI ────────────────────────────────────────────────────────────────
  function _cerrarModal() {
    document.getElementById('cot-modal')?.classList.remove('open');
  }

  function _bindUI(container) {
    // Cerrar modal
    document.getElementById('cot-modal-close')?.addEventListener('click', _cerrarModal);
    document.getElementById('cot-modal')?.addEventListener('click', e => {
      if (e.target === document.getElementById('cot-modal')) _cerrarModal();
    });

    // Filtros de estado
    container.querySelectorAll('.cot-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.cot-pill').forEach(b => {
          const est = b.dataset.status ? ESTADOS[b.dataset.status] : null;
          b.classList.remove('active');
          b.style.background = 'transparent';
          b.style.fontWeight = '600';
          if (est) { b.style.color = est.color; b.style.borderColor = est.color + '30'; }
          else { b.style.color = '#6B7280'; b.style.borderColor = 'var(--border)'; }
        });
        btn.classList.add('active');
        btn.style.background = 'var(--surface)';
        btn.style.fontWeight = '700';
        if (btn.dataset.status) {
          const est = ESTADOS[btn.dataset.status];
          btn.style.borderColor = est.color;
        } else {
          btn.style.color = 'var(--text-primary)';
          btn.style.borderColor = 'var(--text-primary)';
        }
        _filtroStatus = btn.dataset.status;
        _escuchar();
      });
    });

    // Búsqueda
    container.querySelector('#cot-buscar')?.addEventListener('input', e => {
      _busqueda = e.target.value;
      _renderTabla();
    });

    // Config vigencia
    container.querySelector('#cot-btn-vigencia')?.addEventListener('click', () =>
      document.getElementById('cot-modal-vig').classList.add('open'));
    document.getElementById('cot-vig-close')?.addEventListener('click', () =>
      document.getElementById('cot-modal-vig').classList.remove('open'));
    document.getElementById('cot-vig-cancel')?.addEventListener('click', () =>
      document.getElementById('cot-modal-vig').classList.remove('open'));
    document.getElementById('cot-vig-guardar')?.addEventListener('click', async () => {
      const dias = parseInt(document.getElementById('cot-vig-input').value, 10);
      if (!dias || dias < 1) { window.toast?.('Ingresa días válidos','error'); return; }
      try {
        await setDoc(doc(db,'configuracion','cotizaciones'),
          { vigenciaDias: dias, actualizadoPor: Sesion.alias, actualizadoEn: serverTimestamp() },
          { merge:true });
        _vigenciaDias = dias;
        document.getElementById('cot-vig-label').textContent = `${dias}d`;
        document.getElementById('cot-modal-vig').classList.remove('open');
        window.toast?.('Vigencia actualizada','success');
      } catch(e) { window.toast?.('Error: ' + e.message, 'error'); }
    });

    // Nueva cotización (informativo por ahora — se crea desde APK)
    container.querySelector('#cot-btn-nueva')?.addEventListener('click', () => {
      window.toast?.('Las cotizaciones se crean desde el APK del ingeniero.','info');
    });
  }

  function destroy() {
    _unsub?.(); _unsub = null; _allDocs = []; _busqueda = ''; _filtroStatus = '';
  }

  return { init, mount: init, destroy };
})();
