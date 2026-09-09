// nombres-cache.js — Singleton para resolver alias → nombre real desde usuarios
import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const _cache = {};
let _cargado = false;
let _promesa = null;

export function cargarNombres() {
  if (_cargado) return Promise.resolve(_cache);
  if (_promesa) return _promesa;
  _promesa = getDocs(collection(db, "usuarios")).then(snap => {
    snap.forEach(d => {
      const data = d.data();
      const nombre = data.nombre || data.alias;
      if (!nombre) return;
      _cache[d.id.toLowerCase()] = nombre;
      if (data.alias)  _cache[data.alias.toLowerCase()]  = nombre;
      if (data.correo) _cache[data.correo.split('@')[0].toLowerCase()] = nombre;
      if (data.email)  _cache[data.email.split('@')[0].toLowerCase()]  = nombre;
    });
    _cargado = true;
    return _cache;
  }).catch(() => _cache);
  return _promesa;
}

export function resolverNombre(alias) {
  if (!alias) return "–";
  return _cache[alias.toLowerCase()] || alias;
}
