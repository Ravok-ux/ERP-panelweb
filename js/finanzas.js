import { db } from './firebase-config.js';
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, getDocs, query, where, orderBy, limit,
  serverTimestamp, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { Sesion } from './auth.js';

// ─── Estado del módulo ────────────────────────────────────────────────────────
let _unsubs = [];
let _tabActivo = 'gl';
let _unsubPolizas    = null;
let _unsubFacturas   = null;
let _unsubPresupuesto = null;
let _unsubCCLista    = null;
let _cuentasCache    = [];

const TABS = [
  { id: 'gl',           icon: '📒', label: 'Contabilidad GL'    },
  { id: 'ap',           icon: '🧾', label: 'Cuentas por Pagar'  },
  { id: 'conciliacion', icon: '🏦', label: 'Conciliación'       },
  { id: 'estados',      icon: '📊', label: 'Estados Financieros'},
  { id: 'presupuesto',  icon: '📅', label: 'Presupuesto'        },
  { id: 'centros',      icon: '🏷️', label: 'Centros de Costo'  },
];

const TIPOS_CUENTA = ['ACTIVO','PASIVO','CAPITAL','INGRESO','GASTO'];
const TIPOS_POLIZA = ['DIARIO','INGRESOS','EGRESOS','APERTURA','CIERRE'];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function fmt(n) { return Number(n||0).toLocaleString('es-MX',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('es-MX');
}
function fmtDateISO(ts) {
  if (!ts) return hoy();
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().slice(0,10);
}
function hoy() { return new Date().toISOString().slice(0,10); }

// ─── CSS inyectado una sola vez ───────────────────────────────────────────────
const FIN_CSS = `
/* ── Finanzas module styles ── */
#fin-wrap { font-family: inherit; }

/* Tabs */
.fin-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--surface-2, #f1f5f9);
  border-radius: 12px;
  margin-bottom: 20px;
  overflow-x: auto;
  scrollbar-width: none;
}
.fin-tabs::-webkit-scrollbar { display: none; }
.fin-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  background: transparent;
  color: var(--text-muted, #64748b);
  transition: background .15s, color .15s, box-shadow .15s;
}
.fin-tab:hover { background: var(--surface, #fff); color: var(--text, #0f172a); }
.fin-tab.active {
  background: var(--surface, #fff);
  color: var(--accent, #16a34a);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0,0,0,.12);
}
.fin-tab-icon { font-size: 15px; }

/* KPI tiles */
.fin-kpis { display: grid; gap: 12px; margin-bottom: 18px; }
.fin-kpi {
  background: var(--surface, #fff);
  border-radius: 10px;
  padding: 14px 16px;
  border: 1px solid var(--border, #e2e8f0);
  border-left: 4px solid var(--kpi-color, #3b82f6);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fin-kpi-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted, #64748b); }
.fin-kpi-val { font-size: 20px; font-weight: 700; color: var(--kpi-color, #3b82f6); font-variant-numeric: tabular-nums; }

/* Section headings */
.fin-sec {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.fin-sec-title {
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .06em;
  color: var(--text, #0f172a);
  white-space: nowrap;
}
.fin-sec-line { flex: 1; height: 1px; background: var(--border, #e2e8f0); }

/* Cards */
.fin-card {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 10px;
  padding: 16px;
}

/* Tables */
.fin-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.fin-tbl thead th {
  text-align: left;
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .05em;
  color: var(--text-muted, #64748b);
  border-bottom: 2px solid var(--border, #e2e8f0);
  background: var(--surface-2, #f8fafc);
}
.fin-tbl thead th.r, .fin-tbl td.r { text-align: right; font-variant-numeric: tabular-nums; }
.fin-tbl tbody tr { transition: background .1s; }
.fin-tbl tbody tr:hover { background: var(--surface-2, #f8fafc); }
.fin-tbl tbody td { padding: 8px 10px; border-bottom: 1px solid var(--border, #e2e8f0); vertical-align: middle; }
.fin-tbl tbody tr:last-child td { border-bottom: none; }
.fin-tbl tbody tr.total-row td { font-weight: 700; background: var(--surface-2, #f8fafc); border-top: 2px solid var(--border, #e2e8f0); }

/* Badges */
.fin-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .04em;
}

/* Inline icon actions */
.fin-acts { display: flex; gap: 4px; }
.fin-btn-icon {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  transition: background .1s, border-color .1s;
}
.fin-btn-icon:hover { background: var(--surface-2, #f1f5f9); border-color: var(--text-muted, #94a3b8); }

/* Buttons */
.fin-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px; border-radius: 7px; border: none;
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: filter .1s;
}
.fin-btn:hover { filter: brightness(.93); }
.fin-btn-primary { background: var(--accent, #16a34a); color: #fff; }
.fin-btn-secondary {
  background: transparent;
  border: 1px solid var(--border, #d1d5db);
  color: var(--text, #374151);
}
.fin-btn-sm { padding: 5px 10px; font-size: 12px; }

/* Forms */
.fin-form-grid { display: grid; gap: 12px; }
.fin-form-grid.cols2 { grid-template-columns: 1fr 1fr; }
.fin-form-grid.cols3 { grid-template-columns: 1fr 1fr 1fr; }
.fin-field label { display: block; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted, #64748b); margin-bottom: 4px; }
.fin-field input, .fin-field select { width: 100%; box-sizing: border-box; }

/* Modals */
.fin-modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.45);
  backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
  z-index: 9000;
  animation: finFadeIn .15s ease;
}
@keyframes finFadeIn { from { opacity: 0; } to { opacity: 1; } }
.fin-modal {
  background: var(--surface, #fff);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0,0,0,.25);
  display: flex; flex-direction: column;
  max-height: 90vh;
  animation: finSlideUp .18s ease;
  overflow: hidden;
}
@keyframes finSlideUp { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }
.fin-modal-head {
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--border, #e2e8f0);
  display: flex; align-items: center; justify-content: space-between;
}
.fin-modal-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
.fin-modal-close {
  width: 30px; height: 30px; border-radius: 50%; border: none; background: var(--surface-2, #f1f5f9);
  font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: var(--text-muted);
}
.fin-modal-close:hover { background: var(--border); }
.fin-modal-body { padding: 20px 22px; overflow-y: auto; flex: 1; }
.fin-modal-foot {
  padding: 14px 22px;
  border-top: 1px solid var(--border, #e2e8f0);
  display: flex; justify-content: flex-end; gap: 8px;
}

/* Misc */
.fin-empty { text-align: center; padding: 32px; color: var(--text-muted, #94a3b8); font-size: 13px; }
.fin-loading { text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px; }
.fin-row-bar {
  height: 5px;
  background: var(--border, #e2e8f0);
  border-radius: 3px;
  margin-top: 3px;
  overflow: hidden;
}
.fin-row-bar-fill { height: 100%; border-radius: 3px; transition: width .3s; }

/* Calendar vencimientos */
.fin-venc-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 0; border-bottom: 1px solid var(--border, #e2e8f0);
}
.fin-venc-item:last-child { border-bottom: none; }

/* Conciliación results */
.fin-diff-ok  { color: #16a34a; font-weight: 700; }
.fin-diff-err { color: #dc2626; font-weight: 700; }
`;

// ─── mount / destroy ─────────────────────────────────────────────────────────
export const FinanzasModule = {
  mount(container) {
    // Inyectar CSS una sola vez
    if (!document.getElementById('fin-styles')) {
      const s = document.createElement('style');
      s.id = 'fin-styles';
      s.textContent = FIN_CSS;
      document.head.appendChild(s);
    }
    container.innerHTML = `<div id="fin-wrap">
      <div class="fin-tabs" id="fin-tabs"></div>
      <div id="fin-content"></div>
    </div>`;
    _renderTabs();
    _activarTab('gl');
  },
  destroy() {
    _unsubs.forEach(u => u());
    _unsubs = [];
    _unsubPolizas = _unsubFacturas = _unsubPresupuesto = _unsubCCLista = null;
    _tabActivo = 'gl';
  }
};

// ─── Tab nav ──────────────────────────────────────────────────────────────────
function _renderTabs() {
  const bar = el('fin-tabs');
  if (!bar) return;
  bar.innerHTML = TABS.map(t => `
    <button class="fin-tab${t.id === _tabActivo ? ' active' : ''}"
      onclick="window._finTab('${t.id}')">
      <span class="fin-tab-icon">${t.icon}</span>${t.label}
    </button>`).join('');
  window._finTab = (id) => _activarTab(id);
}

function _activarTab(id) {
  _unsubs.forEach(u => u());
  _unsubs = [];
  _tabActivo = id;
  _renderTabs();
  const c = el('fin-content');
  if (!c) return;
  c.innerHTML = '<div class="fin-loading">Cargando…</div>';
  ({ gl: _montarGL, ap: _montarAP, conciliacion: _montarConciliacion,
     estados: _montarEstados, presupuesto: _montarPresupuesto, centros: _montarCentros,
  }[id] || (() => {}))();
}

// ─── Shared UI helpers ────────────────────────────────────────────────────────
function _kpiBar(items) {
  return `<div class="fin-kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
    ${items.map(([l,v,color]) => `
      <div class="fin-kpi" style="--kpi-color:${color}">
        <div class="fin-kpi-label">${l}</div>
        <div class="fin-kpi-val">${v}</div>
      </div>`).join('')}
  </div>`;
}

function _secHead(title) {
  return `<div class="fin-sec"><span class="fin-sec-title">${title}</span><span class="fin-sec-line"></span></div>`;
}

function _badgeStyle(text, color = '#64748b', bg = '#f1f5f9') {
  return `<span class="fin-badge" style="background:${bg};color:${color}">${text}</span>`;
}

function _modal(id, title, bodyHtml, footHtml, width = '480px') {
  document.getElementById(id)?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="fin-modal-overlay" id="${id}">
      <div class="fin-modal" style="width:${width}">
        <div class="fin-modal-head">
          <h3>${title}</h3>
          <button class="fin-modal-close" onclick="document.getElementById('${id}').remove()">✕</button>
        </div>
        <div class="fin-modal-body">${bodyHtml}</div>
        <div class="fin-modal-foot">${footHtml}</div>
      </div>
    </div>`);
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB GL — Contabilidad General
// ══════════════════════════════════════════════════════════════════════════════
function _montarGL() {
  const c = el('fin-content');
  c.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="fin-card">
        ${_secHead('Catálogo de Cuentas')}
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
          <button class="fin-btn fin-btn-primary fin-btn-sm" onclick="window._glNuevaCuenta()">+ Cuenta</button>
        </div>
        <div id="gl-cuentas-lista"><div class="fin-loading">Cargando…</div></div>
      </div>
      <div class="fin-card">
        ${_secHead('Pólizas Contables')}
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
          <select id="gl-filtro-tipo" onchange="window._glFiltrarPolizas()" class="input" style="flex:1;font-size:13px">
            <option value="">Todos los tipos</option>
            ${TIPOS_POLIZA.map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
          <input type="month" id="gl-filtro-mes" value="${hoy().slice(0,7)}"
            onchange="window._glFiltrarPolizas()" class="input" style="flex:1;font-size:13px">
          <button class="fin-btn fin-btn-primary fin-btn-sm" onclick="window._glNuevaPoliza()">+ Póliza</button>
        </div>
        <div id="gl-polizas-lista"><div class="fin-loading">Cargando…</div></div>
      </div>
    </div>
    <div class="fin-card" style="margin-top:16px">
      ${_secHead('Libro Mayor')}
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
        <select id="gl-cuenta-sel" class="input" style="flex:1;font-size:13px" onchange="window._glVerLibro()">
          <option value="">— Seleccionar cuenta —</option>
        </select>
        <input type="month" id="gl-libro-mes" value="${hoy().slice(0,7)}"
          onchange="window._glVerLibro()" class="input" style="font-size:13px">
      </div>
      <div id="gl-libro-contenido"><div class="fin-empty">Selecciona una cuenta para ver el libro mayor.</div></div>
    </div>`;

  _glCargarCuentas();
  _glCargarPolizas();
  window._glNuevaCuenta   = () => _glModalCuenta(null);
  window._glNuevaPoliza   = () => _glModalPoliza(null);
  window._glFiltrarPolizas = () => _glCargarPolizas();
  window._glVerLibro      = () => _glCargarLibro();
}

function _glCargarCuentas() {
  const q = query(collection(db,'cuentas_contables'), orderBy('codigo'));
  const unsub = onSnapshot(q, snap => {
    const cuentas = snap.docs.map(d => ({id:d.id,...d.data()}));
    _cuentasCache = cuentas;
    const sel = el('gl-cuenta-sel');
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = '<option value="">— Seleccionar cuenta —</option>' +
        cuentas.map(c => `<option value="${c.id}">${c.codigo} — ${c.nombre}</option>`).join('');
      if (prev) sel.value = prev;
    }
    const lista = el('gl-cuentas-lista');
    if (!lista) return;
    if (!cuentas.length) { lista.innerHTML = '<div class="fin-empty">Sin cuentas registradas</div>'; return; }

    const TIPO_COLORS = {ACTIVO:'#3b82f6',PASIVO:'#ef4444',CAPITAL:'#8b5cf6',INGRESO:'#10b981',GASTO:'#f59e0b'};
    lista.innerHTML = `<table class="fin-tbl">
      <thead><tr>
        <th>Código</th><th>Nombre</th><th>Tipo</th><th class="r">Saldo</th><th></th>
      </tr></thead>
      <tbody>${cuentas.map(c => {
        const tc = TIPO_COLORS[c.tipo] || '#64748b';
        return `<tr>
          <td><code style="font-size:11px;background:var(--surface-2);padding:2px 5px;border-radius:4px">${c.codigo}</code></td>
          <td style="font-weight:500">${c.nombre}</td>
          <td>${_badgeStyle(c.tipo, tc, tc+'18')}</td>
          <td class="r" style="font-weight:600">$${fmt(c.saldo||0)}</td>
          <td><div class="fin-acts">
            <button class="fin-btn-icon" title="Editar" onclick="window._glEditCuenta('${c.id}')">✏️</button>
            <button class="fin-btn-icon" title="Eliminar" onclick="window._glDelCuenta('${c.id}','${c.nombre.replace(/'/g,"\\'")}')">🗑️</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    window._glEditCuenta = (id) => _glModalCuenta(cuentas.find(c=>c.id===id));
    window._glDelCuenta  = (id,nombre) => {
      window.modal(`¿Eliminar cuenta "${nombre}"?`, async () => {
        await deleteDoc(doc(db,'cuentas_contables',id));
      });
    };
  }, e => console.error('[finanzas] cuentas_contables:', e));
  _unsubs.push(unsub);
}

function _glCargarPolizas() {
  if (_unsubPolizas) { _unsubPolizas(); _unsubPolizas = null; }
  const tipo  = el('gl-filtro-tipo')?.value || '';
  const mes   = el('gl-filtro-mes')?.value  || hoy().slice(0,7);
  const inicio = new Date(mes+'-01');
  const fin    = new Date(inicio.getFullYear(), inicio.getMonth()+1, 0, 23,59,59);

  const q = query(collection(db,'polizas'),
    where('fecha','>=',Timestamp.fromDate(inicio)),
    where('fecha','<=',Timestamp.fromDate(fin)),
    orderBy('fecha','desc'));

  const unsub = onSnapshot(q, snap => {
    let polizas = snap.docs.map(d => ({id:d.id,...d.data()}));
    if (tipo) polizas = polizas.filter(p => p.tipo === tipo);
    const lista = el('gl-polizas-lista');
    if (!lista) return;
    if (!polizas.length) { lista.innerHTML = '<div class="fin-empty">Sin pólizas en el período</div>'; return; }

    const TIPO_COLORS = {DIARIO:'#3b82f6',INGRESOS:'#10b981',EGRESOS:'#ef4444',APERTURA:'#8b5cf6',CIERRE:'#64748b'};
    lista.innerHTML = `<table class="fin-tbl">
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th class="r">Total</th><th></th></tr></thead>
      <tbody>${polizas.map(p => {
        const tc = TIPO_COLORS[p.tipo] || '#64748b';
        return `<tr>
          <td style="white-space:nowrap">${fmtDate(p.fecha)}</td>
          <td>${_badgeStyle(p.tipo, tc, tc+'18')}</td>
          <td style="color:var(--text-muted)">${p.concepto||'—'}</td>
          <td class="r" style="font-weight:600">$${fmt(p.total)}</td>
          <td><div class="fin-acts">
            <button class="fin-btn-icon" title="Ver" onclick="window._glVerPoliza('${p.id}')">👁️</button>
            <button class="fin-btn-icon" title="Eliminar" onclick="window._glDelPoliza('${p.id}')">🗑️</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    window._glVerPoliza  = (id) => _glModalPoliza(polizas.find(p=>p.id===id), true);
    window._glDelPoliza  = (id) => {
      window.modal('¿Eliminar póliza?', async () => {
        await deleteDoc(doc(db,'polizas',id));
      });
    };
  }, e => console.error('[finanzas] polizas:', e));
  _unsubPolizas = unsub;
  _unsubs.push(unsub);
}

async function _glCargarLibro() {
  const cuentaId = el('gl-cuenta-sel')?.value;
  const mes      = el('gl-libro-mes')?.value || hoy().slice(0,7);
  const div      = el('gl-libro-contenido');
  if (!div) return;
  if (!cuentaId) { div.innerHTML = '<div class="fin-empty">Selecciona una cuenta</div>'; return; }
  div.innerHTML = '<div class="fin-loading">Calculando…</div>';

  const inicio = new Date(mes+'-01');
  const fin    = new Date(inicio.getFullYear(), inicio.getMonth()+1, 0, 23,59,59);
  const snap   = await getDocs(query(collection(db,'polizas'),
    where('fecha','>=',Timestamp.fromDate(inicio)),
    where('fecha','<=',Timestamp.fromDate(fin)), orderBy('fecha')));

  let movs = [];
  snap.docs.forEach(d => {
    const p = d.data();
    (p.movimientos||[]).forEach(m => {
      if (m.cuentaId === cuentaId) movs.push({...m, fecha:p.fecha, concepto:p.concepto});
    });
  });

  if (!movs.length) { div.innerHTML = '<div class="fin-empty">Sin movimientos en el período</div>'; return; }
  let saldo = 0;
  div.innerHTML = `<div style="overflow-x:auto"><table class="fin-tbl">
    <thead><tr><th>Fecha</th><th>Concepto</th><th class="r">Cargo</th><th class="r">Abono</th><th class="r">Saldo</th></tr></thead>
    <tbody>${movs.map(m => {
      saldo += (m.cargo||0) - (m.abono||0);
      return `<tr>
        <td>${fmtDate(m.fecha)}</td>
        <td>${m.concepto||'—'}</td>
        <td class="r" style="color:${m.cargo?'#ef4444':'var(--text-muted)'}">${m.cargo?'$'+fmt(m.cargo):''}</td>
        <td class="r" style="color:${m.abono?'#10b981':'var(--text-muted)'}">${m.abono?'$'+fmt(m.abono):''}</td>
        <td class="r" style="font-weight:700">$${fmt(saldo)}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function _glModalCuenta(cuenta) {
  const editar = !!cuenta;
  const body = `<div class="fin-form-grid cols2">
    <div class="fin-field" style="grid-column:1/2">
      <label>Código SAT</label>
      <input id="mc-codigo" class="input" placeholder="1.1.01" value="${cuenta?.codigo||''}">
    </div>
    <div class="fin-field">
      <label>Tipo</label>
      <select id="mc-tipo" class="input">
        ${TIPOS_CUENTA.map(t=>`<option value="${t}"${cuenta?.tipo===t?' selected':''}>${t}</option>`).join('')}
      </select>
    </div>
    <div class="fin-field" style="grid-column:1/-1">
      <label>Nombre</label>
      <input id="mc-nombre" class="input" placeholder="Caja y Bancos" value="${cuenta?.nombre||''}">
    </div>
    <div class="fin-field" style="grid-column:1/-1">
      <label>Descripción</label>
      <input id="mc-desc" class="input" placeholder="Opcional" value="${cuenta?.descripcion||''}">
    </div>
  </div>`;
  const foot = `
    <button class="fin-btn fin-btn-secondary" onclick="document.getElementById('modal-cuenta').remove()">Cancelar</button>
    <button class="fin-btn fin-btn-primary" onclick="window._glGuardarCuenta('${cuenta?.id||''}')">Guardar</button>`;
  _modal('modal-cuenta', (editar?'Editar':'Nueva')+' Cuenta', body, foot, '440px');

  window._glGuardarCuenta = async (id) => {
    const data = {
      codigo:      el('mc-codigo').value.trim(),
      nombre:      el('mc-nombre').value.trim(),
      tipo:        el('mc-tipo').value,
      descripcion: el('mc-desc').value.trim(),
    };
    if (!data.codigo||!data.nombre) { window.toast('Código y nombre son requeridos', 'error'); return; }
    if (id) await updateDoc(doc(db,'cuentas_contables',id), data);
    else await addDoc(collection(db,'cuentas_contables'), {...data, saldo:0, creadoEn:serverTimestamp()});
    el('modal-cuenta').remove();
  };
}

function _glModalPoliza(poliza, soloVer=false) {
  const editar  = !!poliza && !soloVer;
  const lineas  = poliza?.movimientos || [{cuentaId:'',cargo:0,abono:0}];
  const body = `
    <div class="fin-form-grid cols3" style="margin-bottom:16px">
      <div class="fin-field">
        <label>Tipo</label>
        <select id="mp-tipo" class="input" ${soloVer?'disabled':''}>
          ${TIPOS_POLIZA.map(t=>`<option value="${t}"${poliza?.tipo===t?' selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="fin-field">
        <label>Fecha</label>
        <input type="date" id="mp-fecha" class="input" value="${poliza?.fecha?fmtDateISO(poliza.fecha):hoy()}" ${soloVer?'disabled':''}>
      </div>
      <div class="fin-field">
        <label>Concepto</label>
        <input id="mp-concepto" class="input" placeholder="Concepto" value="${poliza?.concepto||''}" ${soloVer?'disabled':''}>
      </div>
    </div>
    <div class="fin-sec">${_secHead('Movimientos')}</div>
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:6px;margin-bottom:6px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);padding:0 4px">Cuenta</div>
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);padding:0 4px">Cargo</div>
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);padding:0 4px">Abono</div>
      <div></div>
    </div>
    <div id="mp-lineas">${lineas.map((l,i)=>_glLineaPoliza(l,i,soloVer)).join('')}</div>
    ${!soloVer?`<button class="fin-btn fin-btn-secondary fin-btn-sm" style="margin-top:8px" onclick="window._glAgregarLinea()">+ Línea</button>`:''}`;
  const foot = `
    <button class="fin-btn fin-btn-secondary" onclick="document.getElementById('modal-poliza').remove()">Cerrar</button>
    ${!soloVer?`<button class="fin-btn fin-btn-primary" onclick="window._glGuardarPoliza('${poliza?.id||''}')">Guardar</button>`:''}`;
  _modal('modal-poliza', (soloVer?'Ver':editar?'Editar':'Nueva')+' Póliza', body, foot, '560px');

  let numLineas = lineas.length;
  window._glAgregarLinea  = () => el('mp-lineas').insertAdjacentHTML('beforeend', _glLineaPoliza({},numLineas++,false));
  window._glGuardarPoliza = async (id) => {
    const movimientos = [];
    let total = 0;
    document.querySelectorAll('.mp-linea').forEach(row => {
      const cargo = parseFloat(row.querySelector('.mp-cargo').value)||0;
      const abono = parseFloat(row.querySelector('.mp-abono').value)||0;
      movimientos.push({cuentaId:row.querySelector('.mp-cuenta').value, cargo, abono});
      total += cargo;
    });
    const data = {
      tipo:       el('mp-tipo').value,
      fecha:      Timestamp.fromDate(new Date(el('mp-fecha').value + 'T12:00:00')),
      concepto:   el('mp-concepto').value.trim(),
      movimientos, total, usuario: Sesion.alias||Sesion.uid||'',
    };
    if (id) await updateDoc(doc(db,'polizas',id), data);
    else await addDoc(collection(db,'polizas'), {...data, creadoEn:serverTimestamp()});
    el('modal-poliza').remove();
  };
}

function _glLineaPoliza(l, i, disabled) {
  const opts = _cuentasCache.map(c =>
    `<option value="${c.id}"${c.id===l.cuentaId?' selected':''}>${c.codigo} — ${c.nombre}</option>`
  ).join('');
  return `<div class="mp-linea" style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:6px;margin-bottom:4px">
    <select class="input mp-cuenta" style="font-size:12px" ${disabled?'disabled':''}>
      <option value="">— Cuenta —</option>${opts}
    </select>
    <input type="number" class="input mp-cargo" style="font-size:12px" placeholder="Cargo" value="${l.cargo||''}" ${disabled?'disabled':''}>
    <input type="number" class="input mp-abono" style="font-size:12px" placeholder="Abono" value="${l.abono||''}" ${disabled?'disabled':''}>
    ${disabled?'<span></span>':`<button class="fin-btn-icon" style="margin-top:0" title="Eliminar" onclick="this.parentElement.remove()">✕</button>`}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB AP — Cuentas por Pagar
// ══════════════════════════════════════════════════════════════════════════════
function _montarAP() {
  const c = el('fin-content');
  c.innerHTML = `
    <div id="ap-kpis" class="fin-kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="fin-card">
        ${_secHead('Facturas de Proveedores')}
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
          <select id="ap-filtro-estado" onchange="window._apRecargar()" class="input" style="flex:1;font-size:13px">
            <option value="">Todos</option>
            <option value="PENDIENTE">Pendiente</option>
            <option value="PARCIAL">Parcial</option>
            <option value="PAGADA">Pagada</option>
            <option value="VENCIDA">Vencida</option>
          </select>
          <input type="month" id="ap-filtro-mes" value="${hoy().slice(0,7)}"
            onchange="window._apRecargar()" class="input" style="flex:1;font-size:13px">
          <button class="fin-btn fin-btn-primary fin-btn-sm" onclick="window._apNuevaFactura()">+ Factura</button>
        </div>
        <div id="ap-facturas-lista"><div class="fin-loading">Cargando…</div></div>
      </div>
      <div class="fin-card">
        ${_secHead('Calendario de Vencimientos')}
        <div id="ap-calendario"><div class="fin-loading">Cargando…</div></div>
      </div>
    </div>`;

  _apCargarFacturas();
  window._apNuevaFactura = () => _apModalFactura(null);
  window._apRecargar     = () => _apCargarFacturas();
}

function _apCargarFacturas() {
  if (_unsubFacturas) { _unsubFacturas(); _unsubFacturas = null; }
  const estado = el('ap-filtro-estado')?.value||'';
  const mes    = el('ap-filtro-mes')?.value||hoy().slice(0,7);
  const inicio = new Date(mes+'-01');
  const fin    = new Date(inicio.getFullYear(), inicio.getMonth()+1, 0, 23,59,59);

  const q = query(collection(db,'facturas_proveedor'),
    where('fechaEmision','>=',Timestamp.fromDate(inicio)),
    where('fechaEmision','<=',Timestamp.fromDate(fin)),
    orderBy('fechaEmision','desc'));

  const unsub = onSnapshot(q, snap => {
    let facturas = snap.docs.map(d => ({id:d.id,...d.data()}));
    const hoyTs  = Date.now();
    facturas = facturas.map(f => {
      if (f.estado!=='PAGADA') {
        const venc = f.fechaVencimiento?.toDate?.()?.getTime()||0;
        if (venc < hoyTs) f._vencida = true;
      }
      return f;
    });
    if (estado) facturas = facturas.filter(f => estado==='VENCIDA' ? f._vencida : f.estado===estado);

    const total     = facturas.reduce((s,f)=>s+(f.total||0),0);
    const pagado    = facturas.reduce((s,f)=>s+(f.pagado||0),0);
    const pendiente = total - pagado;
    const vencidas  = facturas.filter(f=>f._vencida).reduce((s,f)=>s+(f.total-(f.pagado||0)),0);

    const kpis = el('ap-kpis');
    if (kpis) kpis.innerHTML = [
      ['Total AP', '$'+fmt(total),    '#3b82f6'],
      ['Pagado',   '$'+fmt(pagado),   '#10b981'],
      ['Por pagar','$'+fmt(pendiente),'#f59e0b'],
      ['Vencido',  '$'+fmt(vencidas), '#ef4444'],
    ].map(([l,v,color])=>`<div class="fin-kpi" style="--kpi-color:${color}">
      <div class="fin-kpi-label">${l}</div>
      <div class="fin-kpi-val">${v}</div>
    </div>`).join('');

    // Calendario
    const cal = el('ap-calendario');
    if (cal) {
      const proximas = facturas
        .filter(f => f.estado!=='PAGADA' && f.fechaVencimiento)
        .sort((a,b) => {
          const ta = a.fechaVencimiento?.toDate?.()?.getTime() ?? a.fechaVencimiento?.seconds*1000 ?? 0;
          const tb = b.fechaVencimiento?.toDate?.()?.getTime() ?? b.fechaVencimiento?.seconds*1000 ?? 0;
          return ta - tb;
        })
        .slice(0,10);
      if (!proximas.length) { cal.innerHTML = '<div class="fin-empty">Sin vencimientos próximos</div>'; }
      else cal.innerHTML = proximas.map(f => {
        const dias   = Math.round((f.fechaVencimiento.toDate()-new Date())/86400000);
        const color  = dias<0?'#ef4444':dias<7?'#f59e0b':'#10b981';
        const label  = dias<0?`Vencida ${Math.abs(dias)}d`:`${dias}d`;
        return `<div class="fin-venc-item">
          <div>
            <div style="font-size:13px;font-weight:600">${f.proveedor||'—'}</div>
            <div style="font-size:11px;color:var(--text-muted)">${fmtDate(f.fechaVencimiento)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:13px;font-weight:700">$${fmt(f.total-(f.pagado||0))}</div>
            <div style="font-size:11px;font-weight:600;color:${color}">${label}</div>
          </div>
        </div>`;
      }).join('');
    }

    const lista = el('ap-facturas-lista');
    if (!lista) return;
    if (!facturas.length) { lista.innerHTML = '<div class="fin-empty">Sin facturas en el período</div>'; return; }

    const estadoColor = {PAGADA:'#10b981',PENDIENTE:'#f59e0b',PARCIAL:'#3b82f6'};
    lista.innerHTML = `<div style="overflow-x:auto"><table class="fin-tbl">
      <thead><tr>
        <th>Proveedor</th><th>Vencimiento</th><th class="r">Total</th><th class="r">Pagado</th><th>Estado</th><th></th>
      </tr></thead>
      <tbody>${facturas.map(f => {
        const stColor = f._vencida?'#ef4444':(estadoColor[f.estado]||'#64748b');
        const stLabel = f._vencida?'VENCIDA':f.estado;
        return `<tr>
          <td style="font-weight:500">${f.proveedor||'—'}</td>
          <td style="white-space:nowrap">${fmtDate(f.fechaVencimiento)}</td>
          <td class="r">$${fmt(f.total)}</td>
          <td class="r" style="color:#10b981">$${fmt(f.pagado||0)}</td>
          <td>${_badgeStyle(stLabel, stColor, stColor+'18')}</td>
          <td><div class="fin-acts">
            <button class="fin-btn-icon" title="Pagar" onclick="window._apPagar('${f.id}')">💳</button>
            <button class="fin-btn-icon" title="Eliminar" onclick="window._apDelFact('${f.id}')">🗑️</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
    window._apPagar   = (id) => _apModalPago(facturas.find(f=>f.id===id));
    window._apDelFact = (id) => {
      window.modal('¿Eliminar factura?', async () => {
        await deleteDoc(doc(db,'facturas_proveedor',id));
      });
    };
  }, e => console.error('[finanzas] facturas_proveedor:', e));
  _unsubFacturas = unsub;
  _unsubs.push(unsub);
}

function _apModalFactura(factura) {
  const body = `<div class="fin-form-grid cols2">
    <div class="fin-field" style="grid-column:1/-1"><label>Proveedor</label>
      <input id="ap-prov" class="input" placeholder="Nombre proveedor" value="${factura?.proveedor||''}"></div>
    <div class="fin-field"><label>RFC Proveedor</label>
      <input id="ap-rfc" class="input" placeholder="RFC" value="${factura?.rfc||''}"></div>
    <div class="fin-field"><label>Folio / UUID</label>
      <input id="ap-folio" class="input" placeholder="Folio" value="${factura?.folio||''}"></div>
    <div class="fin-field"><label>Fecha Emisión</label>
      <input type="date" id="ap-emision" class="input" value="${factura?.fechaEmision?fmtDateISO(factura.fechaEmision):hoy()}"></div>
    <div class="fin-field"><label>Fecha Vencimiento</label>
      <input type="date" id="ap-vencimiento" class="input" value="${factura?.fechaVencimiento?fmtDateISO(factura.fechaVencimiento):hoy()}"></div>
    <div class="fin-field"><label>Subtotal</label>
      <input type="number" id="ap-subtotal" class="input" placeholder="0.00" value="${factura?.subtotal||''}"></div>
    <div class="fin-field"><label>IVA</label>
      <input type="number" id="ap-iva" class="input" placeholder="0.00" value="${factura?.iva||''}"></div>
    <div class="fin-field"><label>Retención ISR</label>
      <input type="number" id="ap-ret-isr" class="input" placeholder="0.00" value="${factura?.retIsr||''}"></div>
    <div class="fin-field"><label>Retención IVA</label>
      <input type="number" id="ap-ret-iva" class="input" placeholder="0.00" value="${factura?.retIva||''}"></div>
    <div class="fin-field" style="grid-column:1/-1"><label>Concepto</label>
      <input id="ap-concepto" class="input" placeholder="Descripción" value="${factura?.concepto||''}"></div>
  </div>`;
  const foot = `
    <button class="fin-btn fin-btn-secondary" onclick="document.getElementById('modal-ap').remove()">Cancelar</button>
    <button class="fin-btn fin-btn-primary" onclick="window._apGuardar('${factura?.id||''}')">Guardar</button>`;
  _modal('modal-ap', 'Nueva Factura de Proveedor', body, foot, '520px');

  window._apGuardar = async (id) => {
    const subtotal = parseFloat(el('ap-subtotal').value)||0;
    const iva      = parseFloat(el('ap-iva').value)||0;
    const retIsr   = parseFloat(el('ap-ret-isr').value)||0;
    const retIva   = parseFloat(el('ap-ret-iva').value)||0;
    const total    = subtotal + iva - retIsr - retIva;
    const data     = {
      proveedor: el('ap-prov').value.trim(),
      rfc:       el('ap-rfc').value.trim().toUpperCase(),
      folio:     el('ap-folio').value.trim(),
      fechaEmision:     Timestamp.fromDate(new Date(el('ap-emision').value + 'T12:00:00')),
      fechaVencimiento: Timestamp.fromDate(new Date(el('ap-vencimiento').value + 'T12:00:00')),
      concepto:  el('ap-concepto').value.trim(),
      subtotal, iva, retIsr, retIva, total, estado:'PENDIENTE', pagado:0,
    };
    if (!data.proveedor||!data.total) { window.toast('Proveedor y total son requeridos', 'error'); return; }
    if (id) await updateDoc(doc(db,'facturas_proveedor',id), data);
    else await addDoc(collection(db,'facturas_proveedor'), {...data, creadoEn:serverTimestamp()});
    el('modal-ap').remove();
  };
}

function _apModalPago(factura) {
  if (!factura) return;
  const pendiente = (factura.total||0) - (factura.pagado||0);
  const body = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
      <div class="fin-kpi" style="--kpi-color:#ef4444">
        <div class="fin-kpi-label">Por pagar</div>
        <div class="fin-kpi-val">$${fmt(pendiente)}</div>
      </div>
      <div class="fin-kpi" style="--kpi-color:#10b981">
        <div class="fin-kpi-label">Ya pagado</div>
        <div class="fin-kpi-val">$${fmt(factura.pagado||0)}</div>
      </div>
    </div>
    <div style="font-size:13px;margin-bottom:14px;color:var(--text-muted)">
      Proveedor: <strong style="color:var(--text)">${factura.proveedor}</strong>
    </div>
    <div class="fin-form-grid cols2">
      <div class="fin-field" style="grid-column:1/-1"><label>Monto a pagar</label>
        <input type="number" id="pago-monto" class="input" value="${pendiente}"></div>
      <div class="fin-field"><label>Forma de pago</label>
        <select id="pago-forma" class="input">
          <option>Transferencia</option><option>Cheque</option><option>Efectivo</option>
        </select></div>
      <div class="fin-field"><label>Fecha</label>
        <input type="date" id="pago-fecha" class="input" value="${hoy()}"></div>
    </div>`;
  const foot = `
    <button class="fin-btn fin-btn-secondary" onclick="document.getElementById('modal-pago-ap').remove()">Cancelar</button>
    <button class="fin-btn fin-btn-primary" onclick="window._apConfirmarPago('${factura.id}',${factura.total},${factura.pagado||0})">Confirmar pago</button>`;
  _modal('modal-pago-ap','Registrar Pago', body, foot, '380px');

  window._apConfirmarPago = async (id, total, pagadoPrev) => {
    const monto      = parseFloat(el('pago-monto').value)||0;
    const nuevoPagado = pagadoPrev + monto;
    const estado      = nuevoPagado >= total ? 'PAGADA' : 'PARCIAL';
    await updateDoc(doc(db,'facturas_proveedor',id), {pagado:nuevoPagado, estado});
    el('modal-pago-ap').remove();
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB CONCILIACIÓN BANCARIA
// ══════════════════════════════════════════════════════════════════════════════
function _montarConciliacion() {
  const c = el('fin-content');
  c.innerHTML = `
    <div class="fin-card" style="margin-bottom:16px">
      ${_secHead('Cargar Estado de Cuenta')}
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px">
        Carga el CSV del banco y el sistema concilia automáticamente contra movimientos internos.
      </p>
      <div class="fin-form-grid cols3" style="margin-bottom:14px">
        <div class="fin-field"><label>Banco / Cuenta</label>
          <input id="conc-banco" class="input" placeholder="Banamex ****1234"></div>
        <div class="fin-field"><label>Mes a conciliar</label>
          <input type="month" id="conc-mes" class="input" value="${hoy().slice(0,7)}"></div>
        <div class="fin-field"><label>Saldo inicial banco</label>
          <input type="number" id="conc-saldo-ini" class="input" placeholder="0.00"></div>
      </div>
      <div class="fin-form-grid cols3" style="margin-bottom:14px">
        <div class="fin-field"><label>Col. fecha (1-based)</label>
          <input type="number" id="conc-col-fecha" class="input" value="1"></div>
        <div class="fin-field"><label>Col. descripción</label>
          <input type="number" id="conc-col-desc" class="input" value="2"></div>
        <div class="fin-field"><label>Col. importe</label>
          <input type="number" id="conc-col-monto" class="input" value="3"></div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <label class="fin-btn fin-btn-secondary" style="cursor:pointer">
          📎 Cargar CSV
          <input type="file" accept=".csv,.txt" style="display:none" id="conc-file" onchange="window._concCargarCSV(this)">
        </label>
        <span id="conc-file-nombre" style="font-size:12px;color:var(--text-muted)">Sin archivo seleccionado</span>
      </div>
    </div>
    <div id="conc-resultados"></div>
    <div class="fin-card" style="margin-top:16px">
      ${_secHead('Historial de Conciliaciones')}
      <div id="conc-historial" style="margin-top:4px"><div class="fin-loading">Cargando…</div></div>
    </div>`;

  _concCargarHistorial();
  window._concCargarCSV = (input) => {
    const file = input.files[0];
    if (!file) return;
    el('conc-file-nombre').textContent = file.name;
    const reader = new FileReader();
    reader.onload = e => _concProcesar(e.target.result);
    reader.readAsText(file,'UTF-8');
  };
}

async function _concProcesar(texto) {
  const div = el('conc-resultados');
  div.innerHTML = '<div class="fin-loading">Procesando CSV…</div>';
  const colFecha = parseInt(el('conc-col-fecha').value)-1;
  const colDesc  = parseInt(el('conc-col-desc').value)-1;
  const colMonto = parseInt(el('conc-col-monto').value)-1;
  const mes      = el('conc-mes').value;
  const banco    = el('conc-banco').value.trim()||'Banco';
  const saldoIni = parseFloat(el('conc-saldo-ini').value)||0;

  const primera  = texto.split('\n')[0]||'';
  const delim    = primera.includes(';')?';':primera.includes('\t')?'\t':',';
  const lineas   = texto.split('\n').map(l=>l.trim()).filter(l=>l).slice(1);
  const movsBanco = lineas.map(linea => {
    const cols = linea.split(delim).map(c=>c.replace(/^"|"$/g,'').trim());
    return { fecha:cols[colFecha]||'', descripcion:cols[colDesc]||'',
             monto:parseFloat((cols[colMonto]||'0').replace(/,/g,''))||0 };
  }).filter(m=>m.monto!==0);

  const inicio = new Date(mes+'-01');
  const fin    = new Date(inicio.getFullYear(), inicio.getMonth()+1, 0, 23,59,59);
  const [snapCobranza, snapCaja] = await Promise.all([
    getDocs(query(collection(db,'cobranza'), where('fecha','>=',Timestamp.fromDate(inicio)), where('fecha','<=',Timestamp.fromDate(fin)))),
    getDocs(query(collection(db,'movimientos_caja'), where('fecha','>=',Timestamp.fromDate(inicio)), where('fecha','<=',Timestamp.fromDate(fin)))),
  ]);
  const movsInterno = [
    ...snapCobranza.docs.map(d=>({...d.data(),_col:'cobranza',id:d.id})),
    ...snapCaja.docs.map(d=>({...d.data(),_col:'caja',id:d.id})),
  ];

  const usados = new Set();
  const conciliados=[], sinMatch=[], noEnBanco=[];
  movsBanco.forEach(mb => {
    const match = movsInterno.find((mi,idx) => {
      if (usados.has(idx)) return false;
      const montoOk = Math.abs((mi.monto||mi.importe||0)-Math.abs(mb.monto))<=1;
      const refOk   = mi.referencia && mb.descripcion.toLowerCase().includes(String(mi.referencia).toLowerCase());
      return montoOk||refOk;
    });
    if (match) { usados.add(movsInterno.indexOf(match)); conciliados.push({banco:mb,interno:match}); }
    else sinMatch.push(mb);
  });
  movsInterno.forEach((mi,idx) => { if (!usados.has(idx)) noEnBanco.push(mi); });

  const totalBanco  = movsBanco.reduce((s,m)=>s+m.monto,0);
  const totalConcil = conciliados.reduce((s,m)=>s+m.banco.monto,0);
  const diferencia  = totalBanco - totalConcil;
  const difOk       = Math.abs(diferencia)<1;

  div.innerHTML = `
    ${_kpiBar([
      ['Mov. banco', movsBanco.length, '#3b82f6'],
      ['Conciliados', conciliados.length, '#10b981'],
      ['Sin match', sinMatch.length, '#f59e0b'],
      ['No en banco', noEnBanco.length, '#ef4444'],
    ])}
    <div class="fin-card" style="margin-bottom:12px">
      ${_secHead('Resumen')}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font-size:13px">
        <div>Saldo inicial: <strong>$${fmt(saldoIni)}</strong></div>
        <div>Total banco: <strong>$${fmt(totalBanco)}</strong></div>
        <div>Diferencia: <strong class="${difOk?'fin-diff-ok':'fin-diff-err'}">$${fmt(diferencia)}</strong></div>
      </div>
    </div>
    ${sinMatch.length?`<div class="fin-card" style="margin-bottom:12px">
      ${_secHead('Sin match en sistema ('+sinMatch.length+')')}
      <div style="overflow-x:auto"><table class="fin-tbl">
        <thead><tr><th>Fecha</th><th>Descripción</th><th class="r">Monto</th></tr></thead>
        <tbody>${sinMatch.map(m=>`<tr>
          <td>${m.fecha}</td><td>${m.descripcion}</td>
          <td class="r" style="color:#f59e0b;font-weight:600">$${fmt(m.monto)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`:''}
    ${noEnBanco.length?`<div class="fin-card" style="margin-bottom:12px">
      ${_secHead('En sistema, no en banco ('+noEnBanco.length+')')}
      <div style="overflow-x:auto"><table class="fin-tbl">
        <thead><tr><th>Referencia</th><th>Concepto</th><th class="r">Monto</th><th>Fuente</th></tr></thead>
        <tbody>${noEnBanco.map(m=>`<tr>
          <td>${m.referencia||'—'}</td>
          <td>${m.concepto||m.descripcion||'—'}</td>
          <td class="r" style="color:#ef4444;font-weight:600">$${fmt(m.monto||m.importe)}</td>
          <td>${_badgeStyle(m._col,'#64748b','#f1f5f9')}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`:''}
    <div style="text-align:right;margin-top:4px">
      <button class="fin-btn fin-btn-primary" onclick="window._concGuardar()">💾 Guardar conciliación</button>
    </div>`;

  window._concGuardar = async () => {
    await addDoc(collection(db,'conciliaciones_bancarias'), {
      banco, mes, movsBanco:movsBanco.length, conciliados:conciliados.length,
      sinMatch:sinMatch.length, noEnBanco:noEnBanco.length,
      saldoInicial:saldoIni, totalBanco, diferencia,
      usuario:Sesion.alias||Sesion.uid||'', creadoEn:serverTimestamp(),
    });
    window.toast('Conciliación guardada', 'success');
  };
}

function _concCargarHistorial() {
  const q = query(collection(db,'conciliaciones_bancarias'), orderBy('creadoEn','desc'), limit(20));
  const unsub = onSnapshot(q, snap => {
    const div = el('conc-historial');
    if (!div) return;
    if (snap.empty) { div.innerHTML = '<div class="fin-empty">Sin conciliaciones guardadas</div>'; return; }
    const rows = snap.docs.map(d=>({id:d.id,...d.data()}));
    div.innerHTML = `<div style="overflow-x:auto"><table class="fin-tbl">
      <thead><tr>
        <th>Banco</th><th>Mes</th><th class="r">Mov.</th><th class="r">Conciliados</th>
        <th class="r">Sin match</th><th class="r">Diferencia</th><th>Guardado por</th><th>Registrado</th>
      </tr></thead>
      <tbody>${rows.map(r => {
        const difOk = Math.abs(r.diferencia||0)<1;
        return `<tr>
          <td style="font-weight:500">${r.banco||'—'}</td>
          <td>${r.mes||'—'}</td>
          <td class="r">${r.movsBanco||0}</td>
          <td class="r" style="color:#10b981;font-weight:600">${r.conciliados||0}</td>
          <td class="r" style="color:#f59e0b">${r.sinMatch||0}</td>
          <td class="r"><span class="${difOk?'fin-diff-ok':'fin-diff-err'}">$${fmt(r.diferencia||0)}</span></td>
          <td style="color:var(--text-muted)">${r.usuario||'—'}</td>
          <td style="color:var(--text-muted)">${fmtDate(r.creadoEn)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }, e => console.error('[finanzas] conciliaciones_bancarias:', e));
  _unsubs.push(unsub);
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB ESTADOS FINANCIEROS
// ══════════════════════════════════════════════════════════════════════════════
function _montarEstados() {
  const c = el('fin-content');
  c.innerHTML = `
    <div class="fin-card" style="margin-bottom:16px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <select id="ef-tipo" class="input" style="min-width:200px;font-size:13px" onchange="window._efGenerar()">
          <option value="balance">Balance General</option>
          <option value="resultados">Estado de Resultados</option>
          <option value="flujo">Flujo de Efectivo</option>
        </select>
        <input type="month" id="ef-mes" class="input" style="font-size:13px" value="${hoy().slice(0,7)}" onchange="window._efGenerar()">
        <button class="fin-btn fin-btn-primary" onclick="window._efGenerar()">📊 Generar</button>
      </div>
    </div>
    <div id="ef-contenido"><div class="fin-empty">Selecciona tipo y período, luego presiona Generar.</div></div>`;
  window._efGenerar = () => _efGenerar();
}

async function _efGenerar() {
  const tipo = el('ef-tipo')?.value||'balance';
  const mes  = el('ef-mes')?.value||hoy().slice(0,7);
  const div  = el('ef-contenido');
  if (!div) return;
  div.innerHTML = '<div class="fin-loading">Calculando…</div>';

  const inicio = new Date(mes+'-01');
  const fin    = new Date(inicio.getFullYear(), inicio.getMonth()+1, 0, 23,59,59);
  const [snapCuentas, snapPolizas] = await Promise.all([
    getDocs(query(collection(db,'cuentas_contables'), orderBy('codigo'))),
    getDocs(query(collection(db,'polizas'), where('fecha','>=',Timestamp.fromDate(inicio)), where('fecha','<=',Timestamp.fromDate(fin)))),
  ]);

  const cuentas = Object.fromEntries(snapCuentas.docs.map(d=>[d.id,{id:d.id,...d.data()}]));
  const saldos  = {};
  snapPolizas.docs.forEach(d => {
    (d.data().movimientos||[]).forEach(m => {
      saldos[m.cuentaId] = (saldos[m.cuentaId]||0) + (m.cargo||0) - (m.abono||0);
    });
  });
  const porTipo = (t) => Object.values(cuentas).filter(c=>c.tipo===t).map(c=>({...c, saldoPeriodo:saldos[c.id]||0}));

  if (tipo==='balance') {
    const activos = porTipo('ACTIVO'), pasivos = porTipo('PASIVO'), capital = porTipo('CAPITAL');
    const tA = activos.reduce((s,c)=>s+(c.saldo||0)+c.saldoPeriodo,0);
    const tP = pasivos.reduce((s,c)=>s+(c.saldo||0)+c.saldoPeriodo,0);
    const tC = capital.reduce((s,c)=>s+(c.saldo||0)+c.saldoPeriodo,0);
    div.innerHTML = _efTabla('Balance General', mes, [
      {titulo:'ACTIVOS', rows:activos, total:tA, color:'#3b82f6'},
      {titulo:'PASIVOS', rows:pasivos, total:tP, color:'#ef4444'},
      {titulo:'CAPITAL', rows:capital, total:tC, color:'#8b5cf6'},
    ]);
  } else if (tipo==='resultados') {
    const ingresos = porTipo('INGRESO'), gastos = porTipo('GASTO');
    const tI = ingresos.reduce((s,c)=>s+c.saldoPeriodo,0);
    const tG = gastos.reduce((s,c)=>s+c.saldoPeriodo,0);
    const util = tI - tG;
    div.innerHTML = _efTabla('Estado de Resultados', mes, [
      {titulo:'INGRESOS', rows:ingresos, total:tI, color:'#10b981'},
      {titulo:'GASTOS',   rows:gastos,   total:tG, color:'#ef4444'},
    ]) + `<div class="fin-card" style="margin-top:12px;text-align:center;padding:20px">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);margin-bottom:8px">Utilidad / Pérdida del período</div>
      <div style="font-size:32px;font-weight:800;color:${util>=0?'#10b981':'#ef4444'}">$${fmt(util)}</div>
    </div>`;
  } else {
    const efectivo = porTipo('ACTIVO').filter(c=>c.codigo?.startsWith('1.1'));
    const total    = efectivo.reduce((s,c)=>s+c.saldoPeriodo,0);
    div.innerHTML = `<div class="fin-card">
      ${_secHead('Flujo de Efectivo — '+mes)}
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">Variación neta en cuentas de efectivo y equivalentes (código 1.1.xx)</p>
      <div style="overflow-x:auto"><table class="fin-tbl">
        <thead><tr><th>Cuenta</th><th>Código</th><th class="r">Variación</th></tr></thead>
        <tbody>${efectivo.map(c=>`<tr>
          <td>${c.nombre}</td>
          <td><code style="font-size:11px">${c.codigo}</code></td>
          <td class="r" style="color:${c.saldoPeriodo>=0?'#10b981':'#ef4444'};font-weight:600">$${fmt(c.saldoPeriodo)}</td>
        </tr>`).join('')}
        <tr class="total-row"><td colspan="2">Flujo neto</td>
          <td class="r" style="color:${total>=0?'#10b981':'#ef4444'}">$${fmt(total)}</td></tr>
        </tbody>
      </table></div>
    </div>`;
  }
}

function _efTabla(titulo, mes, secciones) {
  const TIPO_COLORS = {ACTIVOS:'#3b82f6',PASIVOS:'#ef4444',CAPITAL:'#8b5cf6',INGRESOS:'#10b981',GASTOS:'#ef4444'};
  return `<div class="fin-card">
    <div style="margin-bottom:16px">
      <div style="font-size:18px;font-weight:700;margin-bottom:2px">${titulo}</div>
      <div style="font-size:12px;color:var(--text-muted)">Período: ${mes}</div>
    </div>
    ${secciones.map(s=>`
      <div style="margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="width:4px;height:16px;background:${s.color};border-radius:2px;display:inline-block"></span>
          <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${s.color}">${s.titulo}</span>
        </div>
        <div style="overflow-x:auto"><table class="fin-tbl">
          <thead><tr><th>Código</th><th>Cuenta</th><th class="r">Saldo acum.</th><th class="r">Período</th><th class="r">Total</th></tr></thead>
          <tbody>${s.rows.map(c=>`<tr>
            <td><code style="font-size:11px">${c.codigo}</code></td>
            <td>${c.nombre}</td>
            <td class="r">$${fmt(c.saldo||0)}</td>
            <td class="r" style="color:${c.saldoPeriodo>=0?'#10b981':'#ef4444'}">$${fmt(c.saldoPeriodo)}</td>
            <td class="r" style="font-weight:700">$${fmt((c.saldo||0)+c.saldoPeriodo)}</td>
          </tr>`).join('')}
          <tr class="total-row"><td colspan="4">Total ${s.titulo}</td>
            <td class="r" style="color:${s.color}">$${fmt(s.total)}</td></tr>
          </tbody>
        </table></div>
      </div>`).join('')}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB PRESUPUESTO
// ══════════════════════════════════════════════════════════════════════════════
function _montarPresupuesto() {
  const c = el('fin-content');
  c.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <input type="month" id="pres-mes" class="input" style="font-size:13px" value="${hoy().slice(0,7)}" onchange="window._presCargar()">
      <button class="fin-btn fin-btn-primary fin-btn-sm" onclick="window._presNueva()">+ Partida</button>
    </div>
    <div id="pres-kpis" class="fin-kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))"></div>
    <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px">
      <div class="fin-card" id="pres-tabla-wrap"><div class="fin-loading">Cargando…</div></div>
      <div class="fin-card">
        ${_secHead('Tensión de Liquidez')}
        <div id="pres-liquidez"></div>
      </div>
    </div>`;

  _presCargar();
  window._presNueva  = () => _presModal(null);
  window._presCargar = () => _presCargar();
}

function _presCargar() {
  if (_unsubPresupuesto) { _unsubPresupuesto(); _unsubPresupuesto = null; }
  const mes = el('pres-mes')?.value||hoy().slice(0,7);
  const q   = query(collection(db,'presupuestos'), where('mes','==',mes), orderBy('categoria'));
  const unsub = onSnapshot(q,
    snap => _presRenderizar(snap.docs.map(d=>({id:d.id,...d.data()})), mes),
    e => console.error('[finanzas] presupuestos:', e));
  _unsubPresupuesto = unsub;
  _unsubs.push(unsub);
}

function _presRenderizar(partidas, mes) {
  const totalPres = partidas.reduce((s,p)=>s+(p.presupuesto||0),0);
  const totalReal = partidas.reduce((s,p)=>s+(p.real||0),0);
  const variacion = totalReal - totalPres;
  const pct       = totalPres>0 ? (totalReal/totalPres*100) : 0;

  const kpis = el('pres-kpis');
  if (kpis) kpis.innerHTML = [
    ['Presupuesto','$'+fmt(totalPres),'#3b82f6'],
    ['Real',       '$'+fmt(totalReal),'#10b981'],
    ['Variación',  (variacion>=0?'+':'')+'$'+fmt(variacion), variacion<=0?'#10b981':'#ef4444'],
    ['Ejecución',  pct.toFixed(1)+'%', pct>100?'#ef4444':pct>80?'#f59e0b':'#3b82f6'],
  ].map(([l,v,color])=>`<div class="fin-kpi" style="--kpi-color:${color}">
    <div class="fin-kpi-label">${l}</div><div class="fin-kpi-val">${v}</div>
  </div>`).join('');

  const wrap = el('pres-tabla-wrap');
  if (wrap) {
    if (!partidas.length) { wrap.innerHTML = `${_secHead('Presupuesto vs Real — '+mes)}<div class="fin-empty">Sin partidas presupuestales</div>`; }
    else {
      wrap.innerHTML = `${_secHead('Presupuesto vs Real — '+mes)}
        <div style="overflow-x:auto"><table class="fin-tbl">
          <thead><tr>
            <th>Categoría</th><th>Centro Costo</th>
            <th class="r">Presupuesto</th><th class="r">Real</th><th class="r">Var %</th><th></th>
          </tr></thead>
          <tbody>${partidas.map(p => {
            const varPct  = p.presupuesto>0 ? ((p.real||0)-p.presupuesto)/p.presupuesto*100 : 0;
            const barW    = Math.min(100, p.presupuesto>0 ? (p.real||0)/p.presupuesto*100 : 0);
            const barColor = barW>100?'#ef4444':barW>80?'#f59e0b':'#3b82f6';
            return `<tr>
              <td style="font-weight:500">${p.categoria}</td>
              <td style="color:var(--text-muted)">${p.centroCosto||'—'}</td>
              <td class="r">$${fmt(p.presupuesto)}</td>
              <td class="r">
                <div style="font-weight:600">$${fmt(p.real||0)}</div>
                <div class="fin-row-bar"><div class="fin-row-bar-fill" style="width:${barW}%;background:${barColor}"></div></div>
              </td>
              <td class="r" style="font-weight:600;color:${varPct>0?'#ef4444':'#10b981'}">
                ${varPct>0?'+':''}${varPct.toFixed(1)}%
              </td>
              <td><div class="fin-acts">
                <button class="fin-btn-icon" title="Editar" onclick="window._presEditP('${p.id}')">✏️</button>
                <button class="fin-btn-icon" title="Eliminar" onclick="window._presDelP('${p.id}')">🗑️</button>
              </div></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`;
      window._presEditP = (id) => _presModal(partidas.find(p=>p.id===id));
      window._presDelP  = (id) => { window.modal('¿Eliminar partida?', async () => { await deleteDoc(doc(db,'presupuestos',id)); }); };
    }
  }

  const liq = el('pres-liquidez');
  if (liq) {
    const tension  = pct>100?'CRÍTICA':pct>90?'ALTA':pct>75?'MODERADA':'NORMAL';
    const colors   = {CRÍTICA:'#ef4444',ALTA:'#f59e0b',MODERADA:'#3b82f6',NORMAL:'#10b981'};
    const icons    = {CRÍTICA:'🔴',ALTA:'🟡',MODERADA:'🔵',NORMAL:'🟢'};
    const color    = colors[tension];
    liq.innerHTML  = `
      <div style="text-align:center;padding:16px 0">
        <div style="font-size:36px;margin-bottom:8px">${icons[tension]}</div>
        <div style="font-size:18px;font-weight:800;color:${color}">${tension}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Ejecución ${pct.toFixed(1)}% del presupuesto</div>
        ${pct>90?`<div style="margin-top:10px;padding:8px 12px;background:${color}18;border:1px solid ${color}30;border-radius:8px;font-size:12px;color:${color}">
          ⚠️ ${pct>100?'Presupuesto superado. Revisar gastos urgente.':'Cerca del límite presupuestal.'}
        </div>`:''}
      </div>
      <div style="margin-top:4px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:8px">Proyección al cierre</div>
        ${partidas.slice(0,5).map(p => {
          const dia = new Date().getDate();
          const diasMes = new Date(new Date().getFullYear(), new Date().getMonth()+1,0).getDate();
          const proy = p.presupuesto>0 ? (p.real||0)/dia*diasMes : 0;
          const ok   = proy <= p.presupuesto;
          return `<div style="display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid var(--border)">
            <span>${p.categoria}</span>
            <span style="font-weight:600;color:${ok?'#10b981':'#ef4444'}">$${fmt(proy)}</span>
          </div>`;
        }).join('')}
      </div>`;
  }
}

function _presModal(partida) {
  const mes  = el('pres-mes')?.value||hoy().slice(0,7);
  const body = `<div class="fin-form-grid cols2">
    <div class="fin-field"><label>Mes</label>
      <input type="month" id="pm-mes" class="input" value="${partida?.mes||mes}"></div>
    <div class="fin-field"><label>Centro de Costo</label>
      <input id="pm-cc" class="input" placeholder="Opcional" value="${partida?.centroCosto||''}"></div>
    <div class="fin-field" style="grid-column:1/-1"><label>Categoría</label>
      <input id="pm-cat" class="input" placeholder="Ej: Nómina, Marketing…" value="${partida?.categoria||''}"></div>
    <div class="fin-field"><label>Presupuesto ($)</label>
      <input type="number" id="pm-pres" class="input" value="${partida?.presupuesto||''}"></div>
    <div class="fin-field"><label>Real acumulado ($)</label>
      <input type="number" id="pm-real" class="input" value="${partida?.real||''}"></div>
  </div>`;
  const foot = `
    <button class="fin-btn fin-btn-secondary" onclick="document.getElementById('modal-pres').remove()">Cancelar</button>
    <button class="fin-btn fin-btn-primary" onclick="window._presGuardar('${partida?.id||''}')">Guardar</button>`;
  _modal('modal-pres', (partida?'Editar':'Nueva')+' Partida Presupuestal', body, foot, '420px');

  window._presGuardar = async (id) => {
    const data = {
      mes:         el('pm-mes').value,
      categoria:   el('pm-cat').value.trim(),
      centroCosto: el('pm-cc').value.trim(),
      presupuesto: parseFloat(el('pm-pres').value)||0,
      real:        parseFloat(el('pm-real').value)||0,
    };
    if (!data.categoria) { window.toast('Categoría requerida', 'error'); return; }
    if (id) await updateDoc(doc(db,'presupuestos',id), data);
    else await addDoc(collection(db,'presupuestos'), {...data, creadoEn:serverTimestamp()});
    el('modal-pres').remove();
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB CENTROS DE COSTO
// ══════════════════════════════════════════════════════════════════════════════
function _montarCentros() {
  const c = el('fin-content');
  c.innerHTML = `
    <div style="display:grid;grid-template-columns:300px 1fr;gap:16px;margin-bottom:16px">
      <div class="fin-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          ${_secHead('Centros de Costo')}
          <button class="fin-btn fin-btn-primary fin-btn-sm" onclick="window._ccNuevo()">+ CC</button>
        </div>
        <div id="cc-lista"><div class="fin-loading">Cargando…</div></div>
      </div>
      <div class="fin-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          ${_secHead('P&L por Centro de Costo')}
          <input type="month" id="cc-mes" class="input" style="font-size:13px;width:160px" value="${hoy().slice(0,7)}"
            onchange="window._ccCargarPL()">
        </div>
        <div id="cc-pl-contenido"><div class="fin-empty">Selecciona un período.</div></div>
      </div>
    </div>
    <div class="fin-card">
      ${_secHead('Imputar Movimiento a Centro de Costo')}
      <div class="fin-form-grid" style="grid-template-columns:repeat(5,1fr);margin-top:4px">
        <div class="fin-field"><label>Centro de Costo</label>
          <select id="imp-cc" class="input" style="width:100%"><option value="">Seleccionar…</option></select></div>
        <div class="fin-field"><label>Tipo</label>
          <select id="imp-tipo" class="input">
            <option value="INGRESO">Ingreso</option><option value="GASTO">Gasto</option>
          </select></div>
        <div class="fin-field"><label>Concepto</label>
          <input id="imp-concepto" class="input" placeholder="Descripción"></div>
        <div class="fin-field"><label>Monto</label>
          <input type="number" id="imp-monto" class="input" placeholder="0.00"></div>
        <div class="fin-field"><label>Fecha</label>
          <input type="date" id="imp-fecha" class="input" value="${hoy()}"></div>
      </div>
      <div style="margin-top:10px">
        <button class="fin-btn fin-btn-primary" onclick="window._ccImputar()">Registrar movimiento</button>
      </div>
    </div>`;

  _ccCargarLista();
  _ccCargarPL();
  window._ccNuevo    = () => _ccModal(null);
  window._ccCargarPL = () => _ccCargarPL();
  window._ccImputar  = () => _ccImputar();
}

function _ccCargarLista() {
  const q = query(collection(db,'centros_costo'), orderBy('codigo'));
  const unsub = onSnapshot(q, snap => {
    const ccs  = snap.docs.map(d=>({id:d.id,...d.data()}));
    const lista = el('cc-lista');
    if (lista) {
      if (!ccs.length) { lista.innerHTML = '<div class="fin-empty">Sin centros registrados</div>'; }
      else lista.innerHTML = ccs.map(cc=>`
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:13px;font-weight:600">${cc.codigo} — ${cc.nombre}</div>
            <div style="font-size:11px;color:var(--text-muted)">${cc.tipo||''}</div>
          </div>
          <div class="fin-acts">
            <button class="fin-btn-icon" title="Editar" onclick="window._ccEdit('${cc.id}')">✏️</button>
            <button class="fin-btn-icon" title="Eliminar" onclick="window._ccDel('${cc.id}','${cc.nombre.replace(/'/g,"\\'")}')">🗑️</button>
          </div>
        </div>`).join('');
    }
    const sel = el('imp-cc');
    if (sel) sel.innerHTML = '<option value="">Seleccionar…</option>' +
      ccs.map(cc=>`<option value="${cc.id}">${cc.codigo} — ${cc.nombre}</option>`).join('');
    window._ccEdit = (id) => _ccModal(ccs.find(c=>c.id===id));
    window._ccDel  = (id,nombre) => {
      window.modal(`¿Eliminar CC "${nombre}"?`, async () => {
        await deleteDoc(doc(db,'centros_costo',id));
      });
    };
  }, e => console.error('[finanzas] centros_costo:', e));
  _unsubs.push(unsub);
}

async function _ccCargarPL() {
  const mes = el('cc-mes')?.value||hoy().slice(0,7);
  const div = el('cc-pl-contenido');
  if (!div) return;
  div.innerHTML = '<div class="fin-loading">Calculando…</div>';

  const inicio = new Date(mes+'-01');
  const fin    = new Date(inicio.getFullYear(), inicio.getMonth()+1, 0, 23,59,59);
  const [snapCCs, snapMovs] = await Promise.all([
    getDocs(query(collection(db,'centros_costo'), orderBy('codigo'))),
    getDocs(query(collection(db,'movimientos_cc'),
      where('fecha','>=',Timestamp.fromDate(inicio)),
      where('fecha','<=',Timestamp.fromDate(fin)))),
  ]);

  const ccs  = snapCCs.docs.map(d=>({id:d.id,...d.data()}));
  const movs = snapMovs.docs.map(d=>d.data());
  const pl   = {};
  ccs.forEach(cc => { pl[cc.id] = {ingresos:0, gastos:0, nombre:cc.nombre, codigo:cc.codigo}; });
  movs.forEach(m => {
    if (!pl[m.centroId]) return;
    if (m.tipo==='INGRESO') pl[m.centroId].ingresos += m.monto||0;
    else pl[m.centroId].gastos += m.monto||0;
  });

  const rows = Object.values(pl);
  if (!rows.length||!movs.length) { div.innerHTML = '<div class="fin-empty">Sin movimientos en el período</div>'; return; }

  const tI = rows.reduce((s,r)=>s+r.ingresos,0);
  const tG = rows.reduce((s,r)=>s+r.gastos,0);
  const tU = tI - tG;
  div.innerHTML = `<div style="overflow-x:auto"><table class="fin-tbl">
    <thead><tr>
      <th>Código</th><th>Centro de Costo</th>
      <th class="r">Ingresos</th><th class="r">Gastos</th>
      <th class="r">Utilidad</th><th class="r">Margen</th>
    </tr></thead>
    <tbody>
      ${rows.map(r => {
        const util   = r.ingresos - r.gastos;
        const margen = r.ingresos>0 ? util/r.ingresos*100 : 0;
        return `<tr>
          <td><code style="font-size:11px">${r.codigo}</code></td>
          <td style="font-weight:500">${r.nombre}</td>
          <td class="r" style="color:#10b981;font-weight:600">$${fmt(r.ingresos)}</td>
          <td class="r" style="color:#ef4444">$${fmt(r.gastos)}</td>
          <td class="r" style="font-weight:700;color:${util>=0?'#10b981':'#ef4444'}">$${fmt(util)}</td>
          <td class="r" style="color:${margen>=0?'#10b981':'#ef4444'}">${margen.toFixed(1)}%</td>
        </tr>`;
      }).join('')}
      <tr class="total-row">
        <td colspan="2">TOTAL</td>
        <td class="r" style="color:#10b981">$${fmt(tI)}</td>
        <td class="r" style="color:#ef4444">$${fmt(tG)}</td>
        <td class="r" style="color:${tU>=0?'#10b981':'#ef4444'}">$${fmt(tU)}</td>
        <td></td>
      </tr>
    </tbody>
  </table></div>`;
}

async function _ccImputar() {
  const ccId    = el('imp-cc')?.value;
  const tipo    = el('imp-tipo')?.value;
  const concepto = el('imp-concepto')?.value.trim();
  const monto   = parseFloat(el('imp-monto')?.value)||0;
  const fecha   = el('imp-fecha')?.value;
  if (!ccId||!monto||!concepto) { window.toast('Centro, concepto y monto son requeridos', 'error'); return; }
  await addDoc(collection(db,'movimientos_cc'), {
    centroId:ccId, tipo, concepto, monto,
    fecha:Timestamp.fromDate(new Date(fecha + 'T12:00:00')),
    usuario:Sesion.alias||Sesion.uid||'', creadoEn:serverTimestamp(),
  });
  el('imp-concepto').value = '';
  el('imp-monto').value    = '';
  window.toast('Movimiento registrado', 'success');
}

function _ccModal(cc) {
  const TIPOS_CC = ['ZONA','RUTA','INGENIERO','PRODUCTO','PROYECTO','OTRO'];
  const body = `<div class="fin-form-grid cols2">
    <div class="fin-field"><label>Código</label>
      <input id="cc-codigo" class="input" placeholder="CC-01" value="${cc?.codigo||''}"></div>
    <div class="fin-field"><label>Tipo</label>
      <select id="cc-tipo" class="input">
        ${TIPOS_CC.map(t=>`<option value="${t}"${cc?.tipo===t?' selected':''}>${t}</option>`).join('')}
      </select></div>
    <div class="fin-field" style="grid-column:1/-1"><label>Nombre</label>
      <input id="cc-nombre" class="input" placeholder="Zona Norte" value="${cc?.nombre||''}"></div>
    <div class="fin-field" style="grid-column:1/-1"><label>Descripción</label>
      <input id="cc-desc" class="input" placeholder="Opcional" value="${cc?.descripcion||''}"></div>
    <div class="fin-field" style="grid-column:1/-1"><label>Responsable</label>
      <input id="cc-resp" class="input" placeholder="Nombre o ID" value="${cc?.responsable||''}"></div>
  </div>`;
  const foot = `
    <button class="fin-btn fin-btn-secondary" onclick="document.getElementById('modal-cc').remove()">Cancelar</button>
    <button class="fin-btn fin-btn-primary" onclick="window._ccGuardar('${cc?.id||''}')">Guardar</button>`;
  _modal('modal-cc', (cc?'Editar':'Nuevo')+' Centro de Costo', body, foot, '400px');

  window._ccGuardar = async (id) => {
    const data = {
      codigo:      el('cc-codigo').value.trim(),
      nombre:      el('cc-nombre').value.trim(),
      tipo:        el('cc-tipo').value,
      descripcion: el('cc-desc').value.trim(),
      responsable: el('cc-resp').value.trim(),
    };
    if (!data.codigo||!data.nombre) { window.toast('Código y nombre requeridos', 'error'); return; }
    if (id) await updateDoc(doc(db,'centros_costo',id), data);
    else await addDoc(collection(db,'centros_costo'), {...data, creadoEn:serverTimestamp()});
    el('modal-cc').remove();
  };
}
