// ══════════════════════════════════════════════════════════════
// mapa.js — Mapa en vivo con Google Maps + pins de ingenieros
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import { estaEnJornadaHoy } from "./app.js";
import {
  collection, onSnapshot, query, orderBy, limit,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _map       = null;
let _markers   = {};
let _unsubs    = [];
let _mapsReady = false;
let _autoFitDone = false;  // sólo auto-centrar una vez al primer snapshot
let _nombres   = {};       // alias → nombre completo, cargado desde usuarios

// ── Replay state ──────────────────────────────────────────────
let _replay = {
  puntos:      [],   // [{lat, lng, ts}] ordenados
  idx:         0,
  timer:       null,
  polyline:    null, // Google Maps Polyline trazada
  replayPin:   null, // Marker animado
  trail:       [],   // coordenadas ya recorridas
  velocidad:   150,  // ms entre puntos
  alias:       null
};

const _FMT_FECHA = d => d.toISOString().slice(0, 10); // "YYYY-MM-DD"

export const MapaModule = {
  mount(container) {
    container.innerHTML = _html();
    _escucharFeedMapa();
    _escucharKPIsMapa();
    _initMap();
    return () => this.destroy();
  },

  destroy() {
    MapaReplay?.cerrar?.();
    _unsubs.forEach(fn => fn && fn());
    _unsubs = [];
    _markers = {};
    _map = null;
    _autoFitDone = false;
  }
};

// ── HTML ──────────────────────────────────────────────────────
function _html() {
  return `
  <div class="map-container">

    <!-- Mapa -->
    <div id="map-canvas" style="flex:1;position:relative;background:#1C2128">
      <div id="map-el" style="width:100%;height:100%"></div>

      <!-- KPI tiles flotantes -->
      <div class="map-tiles">
        <div class="map-tile" id="mt-vendido">
          <div class="mt-lbl">VENDIDO HOY</div>
          <div class="mt-val" id="mt-v-val">–</div>
          <div class="mt-sub" id="mt-v-sub">–</div>
        </div>
        <div class="map-tile" id="mt-cobrado">
          <div class="mt-lbl">COBRADO HOY</div>
          <div class="mt-val" id="mt-c-val">–</div>
          <div class="mt-sub" id="mt-c-sub">–</div>
        </div>
        <div class="map-tile">
          <div class="mt-lbl">EN CAMPO</div>
          <div class="mt-val" id="mt-campo-val">–</div>
          <div class="mt-sub" id="mt-campo-sub" style="color:#8B949E">–</div>
        </div>
      </div>

      <!-- Status bar -->
      <div class="map-statusbar" id="map-status">
        <span id="ms-activos">– activos</span>
        <span id="ms-gps">🛰 GPS –</span>
        <div style="flex:1"></div>
        <span id="ms-sync">–</span>
      </div>

      <!-- Buscador de ingenieros en mapa -->
      <div style="position:absolute;top:12px;right:12px;z-index:5;display:flex;align-items:center;gap:6px">
        <input id="mapa-search" type="text" placeholder="🔍 Buscar ingeniero..."
          oninput="MapaBuscador.filtrar(this.value)"
          style="height:34px;padding:0 12px;border-radius:8px;border:1px solid #30363D;
            background:rgba(13,17,23,.88);color:#E6EDF3;font-size:12px;width:190px;
            backdrop-filter:blur(4px);outline:none;"
          onfocus="this.style.borderColor='#4ADE80'"
          onblur="this.style.borderColor='#30363D'">
        <button id="mapa-search-clear" onclick="MapaBuscador.limpiar()"
          title="Limpiar búsqueda"
          style="display:none;height:34px;padding:0 10px;border-radius:8px;border:1px solid #30363D;
            background:rgba(13,17,23,.88);color:#6B7280;font-size:12px;cursor:pointer;">✕</button>
      </div>

      <!-- Botón Mi ubicación -->
      <button id="btn-mi-ubicacion" title="Mi ubicación" style="
        position:absolute;top:12px;right:12px;z-index:5;
        width:36px;height:36px;border-radius:8px;
        background:rgba(13,17,23,.85);border:1px solid #30363D;
        color:#4ADE80;font-size:16px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        backdrop-filter:blur(4px);transition:background .15s;
      " onmouseover="this.style.background='rgba(74,222,128,.15)'"
        onmouseout="this.style.background='rgba(13,17,23,.85)'"
        onclick="MapaMiUbicacion.centrar()">📍</button>

      <!-- Panel Replay de Ruta -->
      <div id="replay-panel" style="
        position:absolute;bottom:0;left:0;right:0;
        background:rgba(13,17,23,.94);border-top:1px solid #30363D;
        padding:10px 14px;display:none;z-index:10;
        backdrop-filter:blur(6px)">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <!-- Título y alias -->
          <div style="font-size:11px;font-weight:700;color:#4ADE80;white-space:nowrap">
            ▶ REPLAY RUTA
          </div>
          <select id="rp-alias" onchange="MapaReplay.cambiarAlias()"
            style="font-size:11px;padding:4px 8px;border-radius:5px;
              border:1px solid #30363D;background:#161B22;color:#E6EDF3;cursor:pointer">
            <option value="">— Ingeniero —</option>
          </select>
          <input id="rp-fecha" type="date" onchange="MapaReplay.cambiarFecha()"
            style="font-size:11px;padding:4px 8px;border-radius:5px;
              border:1px solid #30363D;background:#161B22;color:#E6EDF3;cursor:pointer">
          <!-- Controles -->
          <div style="display:flex;gap:6px;align-items:center">
            <button onclick="MapaReplay.play()"  id="rp-btn-play"
              title="Reproducir" style="font-size:13px;width:28px;height:28px;border-radius:5px;border:1px solid rgba(74,222,128,.4);background:rgba(74,222,128,.1);color:#4ADE80;cursor:pointer">▶</button>
            <button onclick="MapaReplay.pause()" id="rp-btn-pause"
              title="Pausar" style="font-size:13px;width:28px;height:28px;border-radius:5px;border:1px solid rgba(251,191,36,.4);background:rgba(251,191,36,.1);color:#FBBF24;cursor:pointer">⏸</button>
            <button onclick="MapaReplay.stop()"  id="rp-btn-stop"
              title="Detener" style="font-size:13px;width:28px;height:28px;border-radius:5px;border:1px solid rgba(248,113,113,.4);background:rgba(248,113,113,.1);color:#F87171;cursor:pointer">⏹</button>
          </div>
          <!-- Velocidad -->
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:10px;color:#6B7280">Velocidad</span>
            <input id="rp-vel" type="range" min="30" max="600" step="30" value="150"
              oninput="MapaReplay.setVelocidad(this.value)"
              style="width:80px;cursor:pointer">
            <span id="rp-vel-lbl" style="font-size:10px;color:#9CA3AF;width:36px">150ms</span>
          </div>
          <!-- Progreso -->
          <div style="flex:1;min-width:100px">
            <div style="height:3px;background:#21262D;border-radius:2px;overflow:hidden">
              <div id="rp-progress" style="height:100%;background:#4ADE80;width:0%;transition:width .1s linear"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:3px">
              <span id="rp-idx-lbl" style="font-size:9px;color:#6B7280">0 / 0 puntos</span>
              <span id="rp-time-lbl" style="font-size:9px;color:#6B7280">–</span>
            </div>
          </div>
          <!-- Cerrar -->
          <button onclick="MapaReplay.cerrar()"
            style="font-size:11px;background:transparent;border:none;color:#6B7280;cursor:pointer;padding:2px 6px">✕</button>
        </div>
      </div>
    </div>

    <!-- Feed panel derecho -->
    <div class="map-feed-panel">
      <div class="map-feed-hdr">
        <div class="map-feed-title">
          <span class="live-dot"></span> Feed en vivo
        </div>
        <button onclick="MapaReplay.abrir()"
            title="Replay de ruta"
            style="font-size:10px;background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.3);
              color:#4ADE80;border-radius:5px;padding:2px 8px;cursor:pointer;font-weight:700">
            ▶ Replay
          </button>
      </div>
      <div class="map-feed-body" id="mapa-feed"></div>
    </div>

  </div>`;
}

// ── Google Maps ────────────────────────────────────────────────
function _initMap() {
  const key = window.N10_MAPS_KEY;

  if (!key || key.startsWith("%%")) {
    // Sin clave: mostrar grid simulado
    document.getElementById("map-el").innerHTML = `
      <div style="width:100%;height:100%;background:#1C2128;position:relative;overflow:hidden">
        <div style="width:100%;height:100%;
          background-image:linear-gradient(rgba(48,54,61,.5) 1px,transparent 1px),
            linear-gradient(90deg,rgba(48,54,61,.5) 1px,transparent 1px);
          background-size:32px 32px;"></div>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
          <div style="background:rgba(15,20,28,.88);border:1px solid rgba(74,222,128,.2);border-radius:10px;
            padding:16px 24px;text-align:center;color:#8B949E;font-size:12px">
            <div style="font-size:24px;margin-bottom:8px">🗺</div>
            <div style="font-weight:700;color:#E6EDF3;margin-bottom:4px">Mapa no disponible</div>
            <div>Agrega <code>MAPS_API_KEY</code> en GitHub Secrets</div>
          </div>
        </div>
      </div>`;
    _escucharUbicacionesMapa(null);
    return;
  }

  if (window.google?.maps) {
    _crearMapa();
    return;
  }

  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&callback=__n10MapReady`;
  script.async = true;
  window.__n10MapReady = () => { _mapsReady = true; _crearMapa(); };
  document.head.appendChild(script);
}

function _crearMapa() {
  const mapEl = document.getElementById("map-el");
  if (!mapEl) return;

  _map = new google.maps.Map(mapEl, {
    center: { lat: 20.5, lng: -103.4 }, // Centro México — se reemplaza al cargar marcadores
    zoom:   6,
    mapTypeId: "roadmap",
    styles: _mapStyles(),
    disableDefaultUI: false,
    zoomControl: true,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false
  });

  // Cargar nombres reales desde usuarios para mostrar en tooltip
  getDocs(collection(db, "usuarios")).then(snap => {
    snap.forEach(d => {
      const data = d.data();
      if (!data.nombre) return;
      _nombres[d.id.toLowerCase()] = data.nombre;
      if (data.alias) _nombres[data.alias.toLowerCase()] = data.nombre;
    });
  }).catch(() => {});

  _escucharUbicacionesMapa(_map);
}

// ── Listeners Firestore ────────────────────────────────────────

function _escucharUbicacionesMapa(map) {
  const unsub = onSnapshot(collection(db, "ubicaciones"), snap => {
    let enCampo = 0;

    snap.forEach(d => {
      const u   = d.data();
      const id  = d.id;
      const lat = parseFloat(u.lat);
      const lng = parseFloat(u.lng);

      if (!lat || !lng) return;
      const enJornada = estaEnJornadaHoy(u);
      if (enJornada) enCampo++;

      if (map) {
        // Google Maps marker
        const pos = { lat, lng };
        if (_markers[id]) {
          _markers[id].setPosition(pos);
          _markers[id].setTitle(u.alias || id);
        } else {
          _markers[id] = new google.maps.Marker({
            position: pos, map,
            title: u.alias || id,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: enJornada ? "#4ADE80" : "#F87171",
              fillOpacity: enJornada ? 1 : 0.75,
              strokeColor: "#fff",
              strokeWeight: 2
            }
          });

          // Tooltip on hover
          const _hoverIW = new google.maps.InfoWindow({ disableAutoPan: true });
          _markers[id].addListener("mouseover", () => {
            const ts = u.timestamp?.toDate?.() ?? (typeof u.timestamp === "number" ? new Date(u.timestamp) : null);
            const hace = ts ? _tiempoRelativo(ts) : "–";
            const enJ = estaEnJornadaHoy(u);
            const nombreMostrar = _nombres[id.toLowerCase()] || _nombres[(u.alias||'').toLowerCase()] || u.alias || id;
            _hoverIW.setContent(
              `<div style="font-family:sans-serif;font-size:12px;padding:4px 6px;line-height:1.6">
                <strong>${nombreMostrar}</strong><br>
                <span style="color:${enJ ? "#22C55E" : "#F87171"}">
                  ${enJ ? "● En campo" : "○ Sin jornada"}</span><br>
                <span style="color:#6B7280">Última pos: ${hace}</span>
              </div>`
            );
            _hoverIW.open(map, _markers[id]);
          });
          _markers[id].addListener("mouseout", () => _hoverIW.close());

          // Click: InfoWindow con más detalle
          _markers[id].addListener("click", () => {
            const enJ = estaEnJornadaHoy(u);
            const nombreMostrar = _nombres[id.toLowerCase()] || _nombres[(u.alias||'').toLowerCase()] || u.alias || id;
            new google.maps.InfoWindow({
              content: `<div style="font-family:sans-serif;padding:4px">
                <strong>${nombreMostrar}</strong><br>
                ${enJ ? "● En campo" : "○ Sin jornada"}<br>
                ${u.lat?.slice(0,8)}, ${u.lng?.slice(0,8)}
              </div>`
            }).open(map, _markers[id]);
          });
        }
      } else {
        // Mapa simulado: actualizar pin DOM (si existiese lógica)
      }

      // Actualizar icono según estado de jornada
      if (map && _markers[id]) {
        _markers[id].setIcon({
          path: google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: enJornada ? "#4ADE80" : "#F87171",
          fillOpacity: enJornada ? 1 : 0.75,
          strokeColor: "#fff",
          strokeWeight: 2
        });
      }
    });

    // Auto-centrar al primer snapshot con marcadores reales
    if (!_autoFitDone && map && Object.keys(_markers).length > 0) {
      _autoFitDone = true;
      const bounds = new google.maps.LatLngBounds();
      // Prioridad: ingenieros en jornada activa hoy; fallback: todos los marcadores
      const enJornadaIds = snap.docs
        .filter(d => estaEnJornadaHoy(d.data()) && parseFloat(d.data().lat) && parseFloat(d.data().lng))
        .map(d => d.id);
      const idsParaBounds = enJornadaIds.length > 0 ? enJornadaIds : Object.keys(_markers);
      idsParaBounds.forEach(id => {
        if (_markers[id]) bounds.extend(_markers[id].getPosition());
      });
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { top: 60, right: 20, bottom: 40, left: 20 });
        // No acercar demasiado si es un solo marcador
        const listener = google.maps.event.addListenerOnce(map, "idle", () => {
          if (map.getZoom() > 14) map.setZoom(14);
        });
      }
    }

    // Status
    _setText("ms-activos", `${enCampo} activos`);
    _setText("ms-sync",     "Actualizado: " + new Date().toLocaleTimeString("es-MX", { hour:"2-digit", minute:"2-digit", second:"2-digit" }));
    _setText("mt-campo-val", String(enCampo));
    _setText("mt-campo-sub", enCampo > 0 ? "En jornada" : "Sin ingenieros activos");

    // GPS status
    const gpsEl = document.getElementById("ms-gps");
    if (gpsEl) gpsEl.textContent = `🛰 GPS ${enCampo > 0 ? "activo" : "inactivo"}`;

  }, err => {
    console.error("[Mapa:ubicaciones]", err);
    window.toast?.("Error al cargar ubicaciones de ingenieros.", "error");
  });

  _unsubs.push(unsub);
}

function _escucharKPIsMapa() {
  const unsub = onSnapshot(
    collection(db, "pedidos"),
    snap => {
      let vendido = 0;
      const hoy = _inicioDia();
      snap.forEach(d => {
        const p = d.data();
        if (p.timestamp?.toDate?.() >= hoy) vendido += p.total || 0;
      });
      _setText("mt-v-val", _fmt(vendido));
      _setText("mt-v-sub", "Actualizado hoy");
    },
    err => {
      console.error("[Mapa:kpis]", err);
      window.toast?.("Error al cargar KPIs del mapa.", "error");
    }
  );
  _unsubs.push(unsub);
}

function _escucharFeedMapa() {
  const feedQ = query(
    collection(db, "log_actividades"),
    orderBy("timestamp", "desc"),
    limit(15)
  );

  const unsub = onSnapshot(feedQ, snap => {
    const el = document.getElementById("mapa-feed");
    if (!el) return;

    if (snap.empty) {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:#8B949E;font-size:11px">Sin actividad reciente</div>`;
      return;
    }

    const colors = {
      PEDIDO_CONFIRMADO:"#4ADE80", ABONO_REGISTRADO:"#60A5FA",
      REMISION_CREADA:"#C084FC",   JORNADA_INICIO:"#FBBF24",
      PEDIDO_ENTREGADO:"#4ADE80",  VISITA_REGISTRADA:"#60A5FA",
      PEDIDO_CANCELADO:"#F87171"
    };
    const icons = {
      PEDIDO_CONFIRMADO:"🛒", ABONO_REGISTRADO:"💳", REMISION_CREADA:"📄",
      JORNADA_INICIO:"🚀",    PEDIDO_ENTREGADO:"✅", VISITA_REGISTRADA:"📍",
      PEDIDO_CANCELADO:"❌",   JORNADA_FIN:"🏁"
    };

    el.innerHTML = snap.docs.map(d => {
      const a   = d.data();
      const c   = colors[a.tipo] || "#6B7280";
      const ico = icons[a.tipo]  || "•";
      const ts  = _tiempoRelativo(a.timestamp?.toDate?.() || new Date());
      return `
        <div class="mev" style="border-color:${c}">
          <div style="font-size:13px;flex-shrink:0">${ico}</div>
          <div>
            <div class="mev-who">${a.alias || "–"}</div>
            <div class="mev-what">${_resumen(a)}</div>
            <div class="mev-ts">${ts}</div>
          </div>
        </div>`;
    }).join("");
  }, err => {
    console.error("[Mapa:feed]", err);
    window.toast?.("Error al cargar el feed del mapa.", "error");
  });

  _unsubs.push(unsub);
}

// ── Helpers ───────────────────────────────────────────────────
function _setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}
function _fmt(n) {
  if (n >= 1000000) return "$" + (n/1000000).toFixed(1)+"M";
  if (n >= 1000)    return "$" + (n/1000).toFixed(1)+"k";
  return "$" + n.toLocaleString("es-MX");
}
function _inicioDia() {
  const d = new Date(); d.setHours(0,0,0,0); return d;
}
function _tiempoRelativo(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)   return "Hace " + diff + "s";
  if (diff < 3600) return "Hace " + Math.floor(diff/60) + " min";
  return "Hace " + Math.floor(diff/3600) + "h";
}
function _resumen(a) {
  switch(a.tipo) {
    case "PEDIDO_CONFIRMADO": return `${a.folio || "–"} · ${_fmt(a.total || 0)}`;
    case "ABONO_REGISTRADO":  return `Abono ${_fmt(a.monto || 0)}`;
    case "REMISION_CREADA":   return `Remisión ${_fmt(a.total || 0)}`;
    case "JORNADA_INICIO":    return `Inició — ${a.zona || "–"}`;
    case "PEDIDO_ENTREGADO":  return `Entregó ${a.folio || "–"}`;
    case "VISITA_REGISTRADA": return `Visita: ${a.cliente || "–"}`;
    default: return a.descripcion || a.tipo || "–";
  }
}

// ── Replay de Ruta ────────────────────────────────────────────
window.MapaReplay = {

  // Abre el panel y puebla el selector de ingenieros con los aliases activos
  abrir() {
    const panel = document.getElementById("replay-panel");
    if (!panel) return;
    panel.style.display = "block";

    // Poblar select con ingenieros conocidos (aliases de _markers + ubicaciones)
    const sel = document.getElementById("rp-alias");
    if (!sel) return;
    const aliases = Object.keys(_markers).filter(Boolean);
    // Si no hay markers cargados aún, tomar del snapshot de ubicaciones
    const opts = aliases.length
      ? aliases
      : [...document.querySelectorAll(".mev-who")].map(el => el.textContent).filter(Boolean);
    const uniq = [...new Set(opts)].sort();
    sel.innerHTML = `<option value="">— Ingeniero —</option>` +
      uniq.map(a => `<option value="${a}">${a}</option>`).join("");

    // Fecha por defecto: hoy
    const hoy = _FMT_FECHA(new Date());
    const fechaEl = document.getElementById("rp-fecha");
    if (fechaEl && !fechaEl.value) fechaEl.value = hoy;
  },

  cerrar() {
    this.stop();
    const panel = document.getElementById("replay-panel");
    if (panel) panel.style.display = "none";
    _limpiarReplay();
  },

  cambiarAlias() { this.stop(); _limpiarReplay(); },
  cambiarFecha() { this.stop(); _limpiarReplay(); },

  setVelocidad(val) {
    _replay.velocidad = parseInt(val) || 150;
    const lbl = document.getElementById("rp-vel-lbl");
    if (lbl) lbl.textContent = val + "ms";
    // Si está corriendo, reinicia el timer con nueva velocidad
    if (_replay.timer) { this.pause(); this.play(); }
  },

  async play() {
    const alias = document.getElementById("rp-alias")?.value;
    const fecha = document.getElementById("rp-fecha")?.value;
    if (!alias || !fecha) {
      window.toast?.("Selecciona un ingeniero y una fecha.", "warning");
      return;
    }

    // Si no hay puntos cargados aún, los carga
    if (_replay.puntos.length === 0 || _replay.alias !== alias) {
      window.toast?.("Cargando ruta…", "info");
      await _cargarPuntos(alias, fecha);
      if (_replay.puntos.length === 0) {
        window.toast?.(`Sin puntos GPS para ${alias} el ${fecha}`, "warning");
        return;
      }
      window.toast?.(`${_replay.puntos.length} puntos cargados`, "success");
    }

    // Si llegó al final, reinicia
    if (_replay.idx >= _replay.puntos.length) _replay.idx = 0;

    if (_replay.timer) return; // ya corriendo
    _replay.timer = setInterval(() => _tick(), _replay.velocidad);
  },

  pause() {
    if (_replay.timer) { clearInterval(_replay.timer); _replay.timer = null; }
  },

  stop() {
    this.pause();
    _replay.idx = 0;
    _actualizarUI();
    _limpiarTrail();
  }
};

async function _cargarPuntos(alias, fecha) {
  _replay.alias  = alias;
  _replay.puntos = [];
  _replay.idx    = 0;
  _limpiarTrail();

  try {
    const ref  = collection(db, "rutas", alias, "dias", fecha, "puntos");
    const snap = await getDocs(query(ref, orderBy("ts", "asc")));
    _replay.puntos = snap.docs.map(d => ({
      lat: parseFloat(d.data().lat),
      lng: parseFloat(d.data().lng),
      ts:  d.data().ts
    })).filter(p => !isNaN(p.lat) && !isNaN(p.lng));
  } catch (e) {
    console.error("[Replay]", e);
  }
  _actualizarUI();
}

function _tick() {
  const { puntos, idx } = _replay;
  if (!puntos.length) return;
  if (idx >= puntos.length) { MapaReplay.pause(); return; }

  const p = puntos[idx];
  const pos = _map ? { lat: p.lat, lng: p.lng } : null;

  if (_map) {
    // Mover o crear el marker del replay
    if (!_replay.replayPin) {
      _replay.replayPin = new google.maps.Marker({
        position: pos, map: _map,
        title: _replay.alias,
        zIndex: 100,
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 5,
          fillColor: "#FBBF24",
          fillOpacity: 1,
          strokeColor: "#0D1117",
          strokeWeight: 2,
          rotation: _bearing(puntos, idx)
        }
      });
    } else {
      _replay.replayPin.setPosition(pos);
      const icon = _replay.replayPin.getIcon();
      _replay.replayPin.setIcon({ ...icon, rotation: _bearing(puntos, idx) });
    }

    // Acumular polyline del recorrido
    _replay.trail.push(pos);
    if (_replay.polyline) {
      _replay.polyline.setPath(_replay.trail);
    } else {
      _replay.polyline = new google.maps.Polyline({
        path: _replay.trail,
        map: _map,
        strokeColor: "#FBBF24",
        strokeOpacity: .7,
        strokeWeight: 3,
        geodesic: true
      });
    }

    // Centrar mapa suavemente en el pin
    if (idx % 5 === 0) _map.panTo(pos);
  }

  _replay.idx++;
  _actualizarUI();
}

function _bearing(puntos, idx) {
  if (idx === 0) return 0;
  const a = puntos[idx - 1];
  const b = puntos[idx];
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function _actualizarUI() {
  const { puntos, idx } = _replay;
  const total = puntos.length;
  const pct   = total > 0 ? Math.round((idx / total) * 100) : 0;

  const prog = document.getElementById("rp-progress");
  const idxL = document.getElementById("rp-idx-lbl");
  const timeL = document.getElementById("rp-time-lbl");
  if (prog) prog.style.width = pct + "%";
  if (idxL) idxL.textContent = `${idx} / ${total} puntos`;
  if (timeL && total > 0 && idx > 0) {
    const ts = puntos[Math.min(idx, total - 1)].ts;
    if (ts) timeL.textContent = new Date(ts).toLocaleTimeString("es-MX",
      { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } else if (timeL) {
    timeL.textContent = "–";
  }
}

function _limpiarTrail() {
  if (_replay.polyline)  { _replay.polyline.setMap(null);  _replay.polyline  = null; }
  if (_replay.replayPin) { _replay.replayPin.setMap(null); _replay.replayPin = null; }
  _replay.trail = [];
}

function _limpiarReplay() {
  _limpiarTrail();
  _replay.puntos = [];
  _replay.idx    = 0;
  _actualizarUI();
}

// ── Mi ubicación ──────────────────────────────────────────────
const _RADIO_KM = 5;

function _distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

window.MapaMiUbicacion = {
  _miPin: null,
  _circulo: null,
  _highlights: [],

  centrar() {
    if (!_map) { window.toast?.("El mapa no está listo aún.", "error"); return; }
    if (!navigator.geolocation) { window.toast?.("Tu navegador no soporta geolocalización.", "error"); return; }

    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lng } = pos.coords;

        // Pin de MI posición
        if (this._miPin) this._miPin.setMap(null);
        this._miPin = new google.maps.Marker({
          position: { lat, lng },
          map: _map,
          title: "Mi posición",
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: "#3B82F6",
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 2.5
          },
          zIndex: 999
        });

        // Círculo de 5 km
        if (this._circulo) this._circulo.setMap(null);
        this._circulo = new google.maps.Circle({
          map: _map,
          center: { lat, lng },
          radius: _RADIO_KM * 1000,
          strokeColor: "#3B82F6",
          strokeOpacity: 0.5,
          strokeWeight: 1.5,
          fillColor: "#3B82F6",
          fillOpacity: 0.06
        });

        // Centrar mapa
        _map.panTo({ lat, lng });
        _map.setZoom(13);

        // Comparar con ingenieros en _markers
        let cercanos = 0;
        Object.entries(_markers).forEach(([alias, marker]) => {
          const mPos = marker.getPosition?.();
          if (!mPos) return;
          const dist = _distanciaKm(lat, lng, mPos.lat(), mPos.lng());
          if (dist <= _RADIO_KM) {
            cercanos++;
            // Resaltar con animación bounce
            marker.setAnimation?.(google.maps.Animation.BOUNCE);
            this._highlights.push(marker);
            setTimeout(() => marker.setAnimation?.(null), 2100);
          }
        });

        const msg = cercanos === 0
          ? `Sin ingenieros en ${_RADIO_KM} km de tu posición.`
          : `${cercanos} ingeniero${cercanos > 1 ? "s" : ""} a menos de ${_RADIO_KM} km de ti.`;
        window.toast?.(msg, cercanos > 0 ? "success" : "info");
      },
      err => {
        if (err.code !== 1) {
          const msgs = {
            2: "No se pudo determinar tu posición.",
            3: "Tiempo agotado. Intenta de nuevo."
          };
          window.toast?.(msgs[err.code] || "Error de geolocalización.", "error");
        }
        // código 1 = permiso denegado por el navegador/SO — no mostrar toast
      },
      { timeout: 12000, maximumAge: 60000, enableHighAccuracy: false }
    );
  }
};

// ── Buscador de ingenieros en el mapa ─────────────────────────
window.MapaBuscador = {
  filtrar(query) {
    const q = (query || "").trim().toLowerCase();
    const clearBtn = document.getElementById("mapa-search-clear");
    if (clearBtn) clearBtn.style.display = q ? "block" : "none";

    Object.keys(_markers).forEach(id => {
      const marker = _markers[id];
      if (!marker) return;
      const titulo = (marker.getTitle() || id).toLowerCase();
      const visible = !q || titulo.includes(q);
      marker.setVisible(visible);
    });

    // Si hay exactamente un resultado visible, centrar en él
    if (q) {
      const visibles = Object.keys(_markers).filter(id => {
        const m = _markers[id];
        return m && m.getVisible() && (m.getTitle() || id).toLowerCase().includes(q);
      });
      if (visibles.length === 1 && _map && _markers[visibles[0]]) {
        _map.panTo(_markers[visibles[0]].getPosition());
        if (_map.getZoom() < 12) _map.setZoom(13);
      } else if (visibles.length > 1 && _map) {
        const bounds = new google.maps.LatLngBounds();
        visibles.forEach(id => bounds.extend(_markers[id].getPosition()));
        _map.fitBounds(bounds, 60);
      }
    } else {
      // Sin búsqueda: mostrar todos
      Object.keys(_markers).forEach(id => _markers[id]?.setVisible(true));
    }
  },

  limpiar() {
    const inp = document.getElementById("mapa-search");
    if (inp) { inp.value = ""; this.filtrar(""); }
  }
};

// ── Dark map style para Google Maps ───────────────────────────
function _mapStyles() {
  return [
    { elementType:"geometry", stylers:[{ color:"#1C2128" }] },
    { elementType:"labels.text.fill", stylers:[{ color:"#8B949E" }] },
    { elementType:"labels.text.stroke", stylers:[{ color:"#0D1117" }] },
    { featureType:"road", elementType:"geometry", stylers:[{ color:"#21262D" }] },
    { featureType:"road.highway", elementType:"geometry", stylers:[{ color:"#30363D" }] },
    { featureType:"water", elementType:"geometry", stylers:[{ color:"#0D1117" }] },
    { featureType:"poi", stylers:[{ visibility:"off" }] },
    { featureType:"transit", stylers:[{ visibility:"off" }] },
    { featureType:"administrative", elementType:"geometry", stylers:[{ color:"#30363D" }] }
  ];
}
