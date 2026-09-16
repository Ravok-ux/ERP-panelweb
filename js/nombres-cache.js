// nombres-cache.js — Singleton reactivo: alias → nombre real, lista viva de usuarios
import { db } from "./firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const _cache = {};
let _usuariosList = [];
const _subs = new Set();
let _unsubFS = null;

function _iniciarListener() {
  if (_unsubFS) return;
  _unsubFS = onSnapshot(collection(db, "usuarios"), snap => {
    Object.keys(_cache).forEach(k => delete _cache[k]);
    _usuariosList = [];
    snap.forEach(d => {
      const data = d.data();
      const nombre = data.nombre || data.alias;
      if (!nombre) return;
      _cache[d.id.toLowerCase()] = nombre;
      if (data.alias)  _cache[data.alias.toLowerCase()]  = nombre;
      if (data.correo) _cache[data.correo.split('@')[0].toLowerCase()] = nombre;
      if (data.email)  _cache[data.email.split('@')[0].toLowerCase()]  = nombre;
      _usuariosList.push({ uid: d.id, ...data });
    });
    _subs.forEach(cb => { try { cb(_usuariosList); } catch(e) { console.error("[NombresCache] sub:", e); } });
  }, err => console.error("[NombresCache] onSnapshot:", err));
}

// Espera al primer snapshot si el cache aún está vacío
export function cargarNombres() {
  _iniciarListener();
  if (Object.keys(_cache).length > 0) return Promise.resolve(_cache);
  return new Promise(resolve => {
    const unsub = onSnapshot(collection(db, "usuarios"), snap => {
      unsub();
      resolve(_cache);
    }, () => resolve(_cache));
  });
}

export function resolverNombre(alias) {
  if (!alias) return "–";
  return _cache[alias.toLowerCase()] || alias;
}

// Suscripción reactiva — callback recibe lista completa de usuarios cada vez que cambia
// Devuelve función para cancelar la suscripción
export function suscribirCambios(callback) {
  _iniciarListener();
  _subs.add(callback);
  if (_usuariosList.length > 0) {
    try { callback(_usuariosList); } catch(e) {}
  }
  return () => _subs.delete(callback);
}

// Lista filtrada por roles (array) y activo=true
export function getIngenieros(roles = null) {
  const activos = _usuariosList.filter(u => u.activo !== false);
  if (!roles) return activos;
  return activos.filter(u => roles.includes(u.rol));
}
