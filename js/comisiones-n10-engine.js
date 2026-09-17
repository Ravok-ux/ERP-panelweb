// ══════════════════════════════════════════════════════════════
// comisiones-n10-engine.js — Motor de comisiones N10 (retroactivo plano)
//
// Esquema: al cruzar un tramo, la tarifa aplica a TODOS los litros
// del mes, no solo a los del tramo incremental.
//
// Tramos vigentes (fuente: Calculadora comisiones.xlsx):
//   1–250 L  → $5/L
//   251–300 L → $10/L
//   301–499 L → $15/L
//   500+ L    → $20/L
// ══════════════════════════════════════════════════════════════

import { db } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, runTransaction, serverTimestamp, collection, addDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Tabulador hardcoded (se puede mover a Firestore si cambia) ──
export const TRAMOS_N10 = [
  { n: 1, desde: 1,   hasta: 250,      rate: 5  },
  { n: 2, desde: 251, hasta: 300,      rate: 10 },
  { n: 3, desde: 301, hasta: 499,      rate: 15 },
  { n: 4, desde: 500, hasta: Infinity, rate: 20 },
];

// Meta mensual para % de avance (tramo "Meta" del Excel = 301 L)
export const META_LITROS_DEFAULT = 301;

/**
 * Calcula comisión retroactiva plana dado el total de litros del mes.
 * @param {number} litros - Total litros acumulados en el mes
 * @returns {{ comision: number, tramo: number, rate: number }}
 */
export function calcComisionN10(litros) {
  if (litros <= 0) return { comision: 0, tramo: 0, rate: 0 };
  const t = TRAMOS_N10.find(t => litros <= t.hasta) ?? TRAMOS_N10.at(-1);
  return { comision: litros * t.rate, tramo: t.n, rate: t.rate };
}

/**
 * Calcula cuántos litros faltan para el siguiente tramo.
 * @param {number} litros
 * @returns {{ siguiente: number|null, faltan: number|null, tramoSig: number|null }}
 */
export function proximoTramo(litros) {
  const umbrales = [250, 300, 499]; // 500+ ya es T4 (top tramo), no hay siguiente
  for (const u of umbrales) {
    if (litros < u) return { siguiente: u, faltan: u - litros, tramoSig: TRAMOS_N10.find(t => t.desde > u - 1)?.n ?? null };
    if (litros === u) return { siguiente: u + 1, faltan: 1, tramoSig: TRAMOS_N10.find(t => t.desde === u + 1)?.n ?? null };
  }
  return { siguiente: null, faltan: null, tramoSig: null };
}

/**
 * Registra litros N10 vendidos y recalcula comisión mensual del ingeniero.
 * Usa transacción Firestore para garantizar consistencia.
 *
 * @param {object} params
 * @param {string} params.uid          - UID del ingeniero
 * @param {string} params.alias        - Alias visible del ingeniero
 * @param {number} params.litros       - Litros N10 de esta venta
 * @param {string} params.ventaId      - ID del pedido/remision
 * @param {string} params.cliente      - Nombre del cliente
 * @param {Date}   params.fecha        - Fecha de la venta
 * @returns {Promise<{ comisionAnterior: number, comisionNueva: number, litrosNuevos: number, tramo: number }>}
 */
export async function registrarVentaN10({ uid, alias, litros, ventaId, cliente, fecha = new Date() }) {
  if (!uid || litros <= 0) throw new Error("uid y litros requeridos");

  const mesKey = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
  const docId  = `${uid}_${mesKey}`;
  const ref    = doc(db, "comisiones_n10", docId);

  let result = {};

  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    const prev = snap.exists() ? snap.data() : { litros: 0, comision: 0, ventas: [] };

    const litrosNuevos = (prev.litros ?? 0) + litros;
    const { comision, tramo, rate } = calcComisionN10(litrosNuevos);

    const ventasArr = Array.isArray(prev.ventas) ? prev.ventas : [];
    ventasArr.push({
      ventaId,
      litros,
      cliente: cliente ?? "—",
      fecha: fecha.toISOString(),
    });

    tx.set(ref, {
      uid,
      alias,
      mes_key: mesKey,
      litros:  litrosNuevos,
      comision,
      tramo,
      rate,
      ventas:  ventasArr,
      updated_at: serverTimestamp(),
    }, { merge: false });

    result = {
      comisionAnterior: prev.comision ?? 0,
      comisionNueva:    comision,
      litrosNuevos,
      tramo,
    };
  });

  return result;
}

/**
 * Revierte litros de una venta cancelada.
 * @param {object} params
 * @param {string} params.uid
 * @param {number} params.litros      - Litros a restar (positivo)
 * @param {string} params.ventaId     - ID a eliminar del array
 * @param {Date}   params.fecha       - Fecha original de la venta
 */
export async function revertirVentaN10({ uid, litros, ventaId, fecha = new Date() }) {
  if (!uid || litros <= 0) return;
  const mesKey = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
  const ref    = doc(db, "comisiones_n10", `${uid}_${mesKey}`);

  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const prev = snap.data();
    const litrosNuevos = Math.max(0, (prev.litros ?? 0) - litros);
    const { comision, tramo, rate } = calcComisionN10(litrosNuevos);
    const ventas = (prev.ventas ?? []).filter(v => v.ventaId !== ventaId);
    tx.set(ref, { ...prev, litros: litrosNuevos, comision, tramo, rate, ventas, updated_at: serverTimestamp() });
  });
}
