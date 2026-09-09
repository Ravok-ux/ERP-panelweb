// ══════════════════════════════════════════════════════════════
// intereses-engine.js — Motor de intereses por remisión de crédito
//
// Reglas del negocio:
//   - 14 días naturales de gracia desde fechaCreacion (sin interés)
//   - Después del día 14, si no está liquidada: interés retroactivo desde día 1
//   - Tasa: tasaSemanal/7 por día (congelada al crear la nota)
//   - Base: siempre sobre montoOriginal, sin importar abonos
//   - Abonos reducen totalDeuda (capital + interés acumulado)
//   - PAGADO cuando deudaRestante ≤ 0 en la fecha del último abono
// ══════════════════════════════════════════════════════════════

const MS_DIA          = 86_400_000;
export const DIAS_GRACIA_DEFAULT  = 14;
export const TASA_SEMANAL_DEFAULT = 0.01; // 1% semanal

// ── Status thresholds (diasAtraso = Vencimiento - Hoy, negativo = vencido) ──
export const STATUS_UMBRALES = [
  { max: -61, status: "CRÍTICO"   },
  { max: -43, status: "GRAVE"     },
  { max: -29, status: "MODERADO"  },
  { max: -15, status: "LEVE"      },
  { max:  14, status: "POR_VENCER"},
];

// Colores tomados del Excel MACRO_CARTERA_N10_v22 (hoja INICIO, leyenda)
export const STATUS_COLOR = {
  CRÍTICO:    { bg: "#C0504D", text: "#FFFFFF", badge: "#C0504D" },
  GRAVE:      { bg: "#F79646", text: "#FFFFFF", badge: "#F79646" },
  MODERADO:   { bg: "#8DB4E2", text: "#1A3A5C", badge: "#8DB4E2" },
  LEVE:       { bg: "#FFFF99", text: "#5A4A00", badge: "#D4AC00" },
  POR_VENCER: { bg: "#92D050", text: "#2A4A00", badge: "#5A9020" },
  PAGADO:     { bg: "#F0FDF4", text: "#15803D", badge: "#22C55E" },
  FUTURA:     { bg: "#F9FAFB", text: "#6B7280", badge: "#9CA3AF" },
};

/**
 * Calcula todos los campos derivados de una remisión en una fecha dada.
 * @param {object} r - Documento de remision_credito
 * @param {Date}   hoy - Fecha de referencia (default: new Date())
 * @returns {object} Campos calculados
 */
export function calcularRemision(r, hoy = new Date()) {
  const creacion    = r.fechaCreacion?.toDate?.() ?? new Date(r.fechaCreacion);
  const vencimiento = r.fechaVencimiento?.toDate?.() ?? new Date(r.fechaVencimiento);
  const diasGracia  = r.diasGracia ?? DIAS_GRACIA_DEFAULT;
  const tasaDiaria  = r.tasaDiaria ?? (TASA_SEMANAL_DEFAULT / 7);

  const diasTranscurridos = Math.floor((hoy - creacion) / MS_DIA);
  const diasAtraso        = Math.floor((vencimiento - hoy) / MS_DIA); // negativo = vencido

  const totalAbonado  = r.totalAbonado ?? 0;
  const saldoCapital  = Math.max(0, r.montoOriginal - totalAbonado);

  // Interés activo solo después del periodo de gracia y con saldo pendiente
  const interesActivo = r.status !== "PAGADO"
    && diasTranscurridos > diasGracia
    && saldoCapital > 0;

  // Interés sobre monto ORIGINAL (nunca sobre saldo)
  const interesGenerado   = interesActivo
    ? Math.round(diasTranscurridos * tasaDiaria * r.montoOriginal * 100) / 100 : 0;

  // Métrica secundaria: interés si se calculara sobre el saldo restante
  const interesSobreSaldo = interesActivo
    ? Math.round(saldoCapital * tasaDiaria * diasTranscurridos * 100) / 100 : 0;

  const totalDeuda    = r.montoOriginal + interesGenerado;
  const deudaRestante = Math.max(0, totalDeuda - totalAbonado);
  const masInteresDiario = r.montoOriginal + interesGenerado; // = totalDeuda

  // Interés diario actual (acumulación de hoy)
  const interesPorDia = interesActivo
    ? Math.round(tasaDiaria * r.montoOriginal * 100) / 100 : 0;

  // Status
  let status = "POR_VENCER"; // default: no vencida aún (diasAtraso > 14)
  if (r.status === "PAGADO") {
    status = "PAGADO";
  } else {
    for (const u of STATUS_UMBRALES) {
      if (diasAtraso <= u.max) { status = u.status; break; }
    }
  }

  return {
    diasTranscurridos,
    diasAtraso,
    saldoCapital,
    interesActivo,
    interesGenerado,
    interesSobreSaldo,
    interesPorDia,
    totalDeuda,
    deudaRestante,
    masInteresDiario,
    status,
  };
}

/**
 * Prepara el payload para registrar un abono.
 * Detecta si el abono liquida la nota (deudaRestante → 0).
 *
 * @param {object} remision - Documento actual de remision_credito
 * @param {object} abono    - { monto: number, recibo: string, fecha?: Date }
 * @returns {{ update: object, liquidada: boolean }}
 */
export function calcularAbono(remision, { monto, recibo, fecha = new Date() }) {
  const nuevoTotal = (remision.totalAbonado ?? 0) + monto;
  const { interesGenerado, deudaRestante } = calcularRemision(
    { ...remision, totalAbonado: nuevoTotal }, fecha
  );
  const liquidada = deudaRestante <= 0;

  return {
    liquidada,
    update: {
      totalAbonado: nuevoTotal,
      abonos: [...(remision.abonos ?? []), {
        fecha:  fecha.toISOString(),
        monto,
        recibo: recibo ?? "",
      }],
      ...(liquidada ? {
        status:            "PAGADO",
        fechaLiquidacion:  fecha.toISOString(),
        interesAlLiquidar: interesGenerado,
      } : {}),
    },
  };
}

/**
 * Calcula el semáforo de un cliente basado en su nota más vencida.
 * @param {number} diasMaxAtraso - Mayor |diasAtraso| entre notas activas
 * @returns {string} Color del semáforo
 */
export function calcularSemaforoCliente(diasMaxAtraso) {
  if (diasMaxAtraso <= 0)  return "VERDE";
  if (diasMaxAtraso <= 14) return "POR_VENCER";
  if (diasMaxAtraso <= 28) return "LEVE";
  if (diasMaxAtraso <= 42) return "MODERADO";
  if (diasMaxAtraso <= 60) return "GRAVE";
  return "CRÍTICO";
}

/**
 * Agrega campos calculados a un array de remisiones.
 * @param {Array}  remisiones
 * @param {Date}   hoy
 * @returns {Array} remisiones con campos calculados mezclados
 */
export function enriquecerRemisiones(remisiones, hoy = new Date()) {
  return remisiones.map(r => ({ ...r, ...calcularRemision(r, hoy) }));
}

/**
 * Resumen agregado de un conjunto de remisiones (para KPIs de cartera).
 * @param {Array} remisiones - Ya enriquecidas con calcularRemision
 * @returns {object} Totales
 */
export function resumenCartera(remisiones) {
  const activas  = remisiones.filter(r => r.status !== "PAGADO");
  const criticas = remisiones.filter(r => r.status === "CRÍTICO");
  const vencidas = remisiones.filter(r => ["CRÍTICO","GRAVE","MODERADO","LEVE"].includes(r.status));

  return {
    totalNotas:         remisiones.length,
    notasActivas:       activas.length,
    notasVencidas:      vencidas.length,
    notasCriticas:      criticas.length,
    saldoCapitalTotal:  activas.reduce((s, r) => s + r.saldoCapital, 0),
    interesTotal:       activas.reduce((s, r) => s + r.interesGenerado, 0),
    totalAPagarTotal:   activas.reduce((s, r) => s + r.deudaRestante, 0),
    diasMaxAtraso:      activas.reduce((m, r) => Math.max(m, Math.abs(Math.min(0, r.diasAtraso))), 0),
  };
}
