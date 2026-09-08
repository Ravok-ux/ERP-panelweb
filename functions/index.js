/**
 * Cloud Functions — N10 ERP
 * Sprint 1: Inventario automático, Kardex, Alertas de stock
 */

const { onDocumentUpdated, onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule }         = require("firebase-functions/v2/scheduler");
const { onRequest }          = require("firebase-functions/v2/https");
const { logger }             = require("firebase-functions");
const { initializeApp }      = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp: FSTimestamp } = require("firebase-admin/firestore");
const { getMessaging }       = require("firebase-admin/messaging");
const { getAuth }            = require("firebase-admin/auth");
const https                  = require("https");
const { defineString }       = require("firebase-functions/params");

initializeApp();
const db = getFirestore();

// ═══════════════════════════════════════════════════════════════
// 1. DESCUENTO AUTOMÁTICO DE STOCK AL ENTREGAR UN PEDIDO
//    Trigger: pedidos/{pedidoId} updated → status cambia a ENTREGADO
// ═══════════════════════════════════════════════════════════════
exports.onPedidoEntregado = onDocumentUpdated(
  { document: "pedidos/{pedidoId}", region: "us-central1" },
  async (event) => {
    const antes  = event.data.before.data();
    const despues = event.data.after.data();

    // Solo actuar cuando el status cambia a ENTREGADO
    if (antes.status === "ENTREGADO" || despues.status !== "ENTREGADO") return;

    const pedidoId  = event.params.pedidoId;
    const items     = despues.items || [];

    if (items.length === 0) {
      logger.info(`[onPedidoEntregado] Pedido ${pedidoId} sin items — nada que descontar`);
      return;
    }

    logger.info(`[onPedidoEntregado] Procesando ${items.length} item(s) del pedido ${pedidoId}`);

    const batch = db.batch();
    const ts    = FieldValue.serverTimestamp();
    const now   = Date.now();

    for (const item of items) {
      const cantidad = Number(item.cantidad) || 0;
      if (cantidad <= 0) continue;

      // Buscar producto por idPretoriano o productoId
      const idPret = item.idPretoriano || item.productoId;
      if (!idPret) continue;

      let prodRef = null;
      // Buscar en colección productos por idPretoriano
      const snap = await db.collection("productos")
        .where("idPretoriano", "==", Number(idPret))
        .limit(1)
        .get();

      if (!snap.empty) {
        prodRef = snap.docs[0].ref;
        const stockActual = snap.docs[0].data().stock || 0;

        batch.update(prodRef, {
          stock: FieldValue.increment(-cantidad),
          updatedAt: ts
        });

        // Escribir movimiento en kardex
        const movRef = db.collection("movimientos_stock").doc();
        batch.set(movRef, {
          tipo:           "SALIDA",
          motivo:         "VENTA",
          productoId:     snap.docs[0].id,
          idPretoriano:   Number(idPret),
          nombreProducto: item.nombreProducto || item.nombre || "–",
          cantidad:       cantidad,
          stockAntes:     stockActual,
          stockDespues:   Math.max(0, stockActual - cantidad),
          pedidoId:       pedidoId,
          folioPedido:    despues.folio || pedidoId,
          clienteId:      despues.clienteId || null,
          ingenieroAlias: despues.ingenieroAlias || "–",
          quienRegistro:  "SISTEMA",
          timestamp:      ts,
          _ts:            now
        });
      } else {
        logger.warn(`[onPedidoEntregado] Producto idPretoriano=${idPret} no encontrado en Firestore`);
      }
    }

    try {
      await batch.commit();
      logger.info(`[onPedidoEntregado] Stock descontado para pedido ${pedidoId}`);
    } catch (err) {
      logger.error(`[onPedidoEntregado] Error batch commit:`, err);
      throw err;
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// 2. ALERTA DE STOCK MÍNIMO
//    Trigger: productos/{prodId} updated → stock cambia
// ═══════════════════════════════════════════════════════════════
exports.onStockCambiado = onDocumentUpdated(
  { document: "productos/{prodId}", region: "us-central1" },
  async (event) => {
    const antes   = event.data.before.data();
    const despues = event.data.after.data();

    const stockNuevo   = despues.stock    ?? 0;
    const stockMinimo  = despues.stockMinimo ?? 0;
    const stockAnterior = antes.stock     ?? 0;

    // Solo actuar si el stock bajó y cruza el umbral mínimo
    if (stockNuevo >= stockMinimo) return;
    if (stockAnterior <= stockMinimo) return; // ya estaba bajo — no duplicar alerta

    const prodId = event.params.prodId;
    const nombre = despues.nombre || despues.codigo || prodId;

    logger.info(`[onStockCambiado] Alerta stock bajo: ${nombre} stock=${stockNuevo} min=${stockMinimo}`);

    try {
      await db.collection("alertas_stock").add({
        productoId:     prodId,
        idPretoriano:   despues.idPretoriano || null,
        codigo:         despues.codigo || "",
        nombreProducto: nombre,
        stockActual:    stockNuevo,
        stockMinimo:    stockMinimo,
        resuelta:       false,
        timestamp:      FieldValue.serverTimestamp(),
        _ts:            Date.now()
      });
    } catch (err) {
      logger.error(`[onStockCambiado] Error escribiendo alerta:`, err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// HELPER: recalcular saldo, semáforo y bloqueo de un cliente
// ═══════════════════════════════════════════════════════════════
async function _actualizarCarteraCliente(clienteId) {
  if (!clienteId) return;

  const configSnap = await db.collection("configuracion").doc("cartera").get();
  const cfg        = configSnap.exists ? configSnap.data() : {};
  const umbrales   = cfg.semaforo || { verde: 15, amarillo: 30, naranja: 60 };
  const bloqueoAuto = cfg.bloqueoAutoActivo !== false;

  const remSnap = await db.collection("remisiones_credito")
    .where("clienteId", "==", clienteId)
    .get();

  const ahora = Date.now();
  let saldoPendiente  = 0;
  let diasMaxVencidos = 0;

  for (const d of remSnap.docs) {
    const r = d.data();
    if (r.status === "LIQUIDADO") continue;
    const monto   = Number(r.montoOriginal || r.monto) || 0;
    const abonado = Number(r.montoAbonado  || r.totalAbonado) || 0;
    saldoPendiente += Math.max(0, monto - abonado);

    const fv = r.fechaVencimiento?.toMillis?.() || Number(r.fechaVencimiento) || 0;
    if (fv > 0 && fv < ahora) {
      diasMaxVencidos = Math.max(diasMaxVencidos, Math.floor((ahora - fv) / 86400000));
    }
  }

  let semaforoColor = "VERDE";
  if (diasMaxVencidos > umbrales.naranja)   semaforoColor = "ROJO";
  else if (diasMaxVencidos > umbrales.amarillo) semaforoColor = "NARANJA";
  else if (diasMaxVencidos > umbrales.verde)    semaforoColor = "AMARILLO";

  const clienteRef  = db.collection("clientes").doc(clienteId);
  const clienteSnap = await clienteRef.get();
  let bloqueado     = bloqueoAuto && semaforoColor === "ROJO";

  if (bloqueado && clienteSnap.exists) {
    const dh = clienteSnap.data().desbloqueoHasta || 0;
    if (dh > ahora) bloqueado = false;
  }

  await clienteRef.set(
    { saldoPendiente, diasMaxVencidos, semaforoColor, bloqueado, cartActualizadoEn: FieldValue.serverTimestamp() },
    { merge: true }
  );
  logger.info(`[cartera] cliente=${clienteId} saldo=${saldoPendiente} dias=${diasMaxVencidos} color=${semaforoColor}`);
}

// ═══════════════════════════════════════════════════════════════
// 4. RECALCULAR CARTERA AL CAMBIAR UNA REMISIÓN
//    Trigger: remisiones_credito/{remisionId} created/updated/deleted
// ═══════════════════════════════════════════════════════════════
exports.recalcularCartera = onDocumentWritten(
  { document: "remisiones_credito/{remisionId}", region: "us-central1" },
  async (event) => {
    const data = event.data?.after?.data() || event.data?.before?.data();
    if (!data?.clienteId) return;
    await _actualizarCarteraCliente(String(data.clienteId));
  }
);

// ═══════════════════════════════════════════════════════════════
// 5. RECALCULAR CARTERA AL AGREGAR UN ABONO
//    Trigger: abonos_remision/{abonoId} created
// ═══════════════════════════════════════════════════════════════
exports.onAbonoAgregado = onDocumentCreated(
  { document: "abonos_remision/{abonoId}", region: "us-central1" },
  async (event) => {
    const abono = event.data?.data();
    if (!abono?.remisionId) return;
    const remSnap = await db.collection("remisiones_credito").doc(abono.remisionId).get();
    if (!remSnap.exists) return;
    await _actualizarCarteraCliente(String(remSnap.data().clienteId));
  }
);

// ═══════════════════════════════════════════════════════════════
// 6. LIMPIAR DESBLOQUEOS VENCIDOS (cada 30 min)
// ═══════════════════════════════════════════════════════════════
exports.limpiarDesbloqueos = onSchedule(
  { schedule: "*/30 * * * *", timeZone: "America/Mazatlan", region: "us-central1" },
  async () => {
    const ahora = Date.now();
    const snap  = await db.collection("clientes")
      .where("desbloqueoHasta", ">", 0)
      .get();
    if (snap.empty) return;
    const batch = db.batch();
    let n = 0;
    snap.docs.forEach(d => {
      if ((d.data().desbloqueoHasta || 0) < ahora) {
        batch.update(d.ref, { desbloqueoHasta: 0, bloqueado: true });
        n++;
      }
    });
    if (n > 0) { await batch.commit(); logger.info(`[limpiarDesbloqueos] ${n} vencidos`); }
  }
);

// ═══════════════════════════════════════════════════════════════
// 7. EXPIRAR COTIZACIONES VENCIDAS (diario 07:00 hora MX)
//    ENVIADA o BORRADOR cuyo venceEn < ahora → EXPIRADA
// ═══════════════════════════════════════════════════════════════
exports.expirarCotizaciones = onSchedule(
  { schedule: "0 13 * * *", timeZone: "America/Mazatlan", region: "us-central1" },
  async () => {
    const ahora = Date.now();
    const snap  = await db.collection("cotizaciones")
      .where("status", "in", ["BORRADOR", "ENVIADA", "APROBADA"])
      .where("venceEn", "<", ahora)
      .where("venceEn", ">", 0)
      .get();

    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { status: "EXPIRADA" }));
    await batch.commit();
    logger.info(`[expirarCotizaciones] ${snap.size} cotizaciones expiradas`);
  }
);

// ═══════════════════════════════════════════════════════════════
// 3. LIMPIEZA DIARIA: marcar alertas de stock como resueltas
//    cuando el stock ya superó el mínimo (cron 08:00 hora MX)
// ═══════════════════════════════════════════════════════════════
exports.resolverAlertasStock = onSchedule(
  { schedule: "0 14 * * *", timeZone: "America/Mazatlan", region: "us-central1" },
  async () => {
    const alertas = await db.collection("alertas_stock")
      .where("resuelta", "==", false)
      .get();

    if (alertas.empty) return;

    const batch = db.batch();
    let resueltas = 0;

    for (const alerta of alertas.docs) {
      const { productoId, stockMinimo } = alerta.data();
      const prodSnap = await db.collection("productos").doc(productoId).get();
      if (!prodSnap.exists) continue;

      const stockActual = prodSnap.data().stock ?? 0;
      if (stockActual > stockMinimo) {
        batch.update(alerta.ref, {
          resuelta:       true,
          fechaResolucion: FieldValue.serverTimestamp()
        });
        resueltas++;
      }
    }

    if (resueltas > 0) {
      await batch.commit();
      logger.info(`[resolverAlertasStock] ${resueltas} alertas resueltas`);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// 8. PROCESAR DEVOLUCIÓN APROBADA
//    Trigger: devoluciones/{devId} updated → status cambia a APROBADA
//    Ajusta inventario (entrada de stock) y cartera (nota de crédito)
// ═══════════════════════════════════════════════════════════════
exports.onDevolucionAprobada = onDocumentUpdated(
  { document: "devoluciones/{devId}", region: "us-central1" },
  async (event) => {
    const antes  = event.data.before.data();
    const despues = event.data.after.data();

    if (antes.status === "APROBADA" || despues.status !== "APROBADA") return;

    const devId = event.params.devId;
    const dev   = despues;
    const ts    = FieldValue.serverTimestamp();
    const now   = Date.now();

    logger.info(`[onDevolucionAprobada] Procesando devolución ${devId} folio=${dev.folio}`);

    const batch = db.batch();

    // 1. Movimiento de kardex: ENTRADA por devolución
    const movRef = db.collection("movimientos_stock").doc();
    batch.set(movRef, {
      tipo:           "ENTRADA",
      motivo:         "DEVOLUCION",
      descripcion:    `Devolución aprobada ${dev.folio || devId}`,
      clienteNombre:  dev.clienteNombre || "—",
      ingenieroAlias: dev.ingenieroAlias || "—",
      folioRef:       dev.folioRef || "—",
      monto:          dev.monto || 0,
      productos:      dev.productos || "—",
      devolucionId:   devId,
      quienRegistro:  dev.aprobadaPor || "SISTEMA",
      timestamp:      ts,
      _ts:            now,
    });

    // 2. Nota de crédito: abono a cartera del cliente si hay clienteId
    if (dev.clienteId) {
      const ncRef = db.collection("notas_credito").doc();
      batch.set(ncRef, {
        clienteId:      dev.clienteId,
        clienteNombre:  dev.clienteNombre || "—",
        monto:          dev.monto || 0,
        concepto:       `Devolución ${dev.folio || devId}`,
        devolucionId:   devId,
        aplicada:       false,
        timestamp:      ts,
        _ts:            now,
        creadaPor:      dev.aprobadaPor || "SISTEMA",
      });
    }

    // 3. Marcar la devolución como PROCESADA
    batch.update(db.collection("devoluciones").doc(devId), {
      status:      "PROCESADA",
      procesadaEn: ts,
    });

    // 4. Notificación web para el ingeniero y admin
    const notifRef = db.collection("notificaciones_web").doc();
    batch.set(notifRef, {
      tipo:          "DEVOLUCION_APROBADA",
      mensaje:       `Devolución ${dev.folio || devId} procesada. Inventario y cartera ajustados.`,
      destinatarios: [dev.ingenieroUid || "TODOS"],
      accion:        { vista: "devoluciones" },
      leida:         false,
      timestamp:     ts,
      _ts:           now,
      creadaPor:     "SISTEMA",
    });

    try {
      await batch.commit();
      logger.info(`[onDevolucionAprobada] Devolución ${devId} procesada OK`);
    } catch (err) {
      logger.error(`[onDevolucionAprobada] Error:`, err);
      throw err;
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// 9. NOTIFICAR COTIZACIÓN NUEVA AL PANEL
//    Trigger: cotizaciones/{cotId} created
// ═══════════════════════════════════════════════════════════════
exports.onCotizacionCreada = onDocumentCreated(
  { document: "cotizaciones/{cotId}", region: "us-central1" },
  async (event) => {
    const cot = event.data.data();
    if (!cot) return;

    await db.collection("notificaciones_web").add({
      tipo:          "COTIZACION_NUEVA",
      mensaje:       `${cot.ingenieroAlias || "—"} creó ${cot.folio || event.params.cotId} para ${cot.clienteNombre || "—"}`,
      destinatarios: ["TODOS"],
      accion:        { vista: "cotizaciones", id: event.params.cotId },
      leida:         false,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           Date.now(),
      creadaPor:     "SISTEMA",
    });

    logger.info(`[onCotizacionCreada] Notificación creada para ${cot.folio}`);
  }
);

// ═══════════════════════════════════════════════════════════════
// 10. NOTIFICAR SOLICITUD DE VISITA
//     Trigger: solicitudes_visita/{solId} created
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// 11. ALERTAS AUTOMÁTICAS DE COBRANZA
//     Cron diario 09:00 Mazatlán — genera notificación por cada cliente
//     cuya deuda vence en X días (configurable en /configuracion/alertas_cobranza)
// ═══════════════════════════════════════════════════════════════
exports.alertasCobranzaDiarias = onSchedule(
  { schedule: "0 15 * * *", timeZone: "America/Mazatlan", region: "us-central1" },
  async () => {
    // Leer configuración de umbrales
    const cfgSnap = await db.collection("configuracion").doc("alertas_cobranza").get();
    const cfg     = cfgSnap.exists ? cfgSnap.data() : {};
    const diasAviso       = Number(cfg.diasAviso       ?? 3);   // aviso previo al vencimiento
    const diasPostVenc    = Number(cfg.diasPostVencimiento ?? 1); // alerta cuando ya venció hace N días
    const activo          = cfg.activo !== false;

    if (!activo) { logger.info("[alertasCobranza] Desactivado por config"); return; }

    const ahora   = Date.now();
    const batch   = db.batch();
    let   creadas = 0;

    // Buscar remisiones próximas a vencer o ya vencidas sin alerta reciente
    const snap = await db.collection("remisiones_credito")
      .where("status", "in", ["ACTIVA", "VENCIDA"])
      .get();

    for (const d of snap.docs) {
      const r  = d.data();
      const fv = r.fechaVencimiento?.toMillis?.() || Number(r.fechaVencimiento) || 0;
      if (!fv) continue;

      const diffDias = (fv - ahora) / 86400000;

      // Próxima a vencer (dentro de diasAviso días)
      const porVencer = diffDias >= 0 && diffDias <= diasAviso;
      // Ya vencida hace >= diasPostVenc días
      const yaVencida = diffDias < 0 && Math.abs(diffDias) >= diasPostVenc;

      if (!porVencer && !yaVencida) continue;

      // Evitar duplicados del mismo día
      const hoy    = new Date(); hoy.setHours(0,0,0,0);
      const notifQ = await db.collection("notificaciones_web")
        .where("tipo", "==", "ALERTA_COBRANZA")
        .where("refId", "==", d.id)
        .where("_ts", ">=", hoy.getTime())
        .limit(1)
        .get();

      if (!notifQ.empty) continue;

      const saldo   = (r.montoOriginal || r.monto || 0) - (r.montoAbonado || r.totalAbonado || 0);
      const cliente = r.clienteNombre || "–";
      const mensaje = porVencer
        ? `⏰ ${cliente} · vence en ${Math.ceil(diffDias)} día(s) · $${saldo.toLocaleString("es-MX", {minimumFractionDigits:2})}`
        : `🔴 ${cliente} · vencida hace ${Math.abs(Math.floor(diffDias))} día(s) · $${saldo.toLocaleString("es-MX", {minimumFractionDigits:2})}`;

      const notifRef = db.collection("notificaciones_web").doc();
      batch.set(notifRef, {
        tipo:          "ALERTA_COBRANZA",
        mensaje,
        refId:         d.id,
        clienteNombre: cliente,
        saldo,
        destinatarios: ["TODOS"],
        accion:        { vista: "cobranza" },
        leida:         false,
        timestamp:     FieldValue.serverTimestamp(),
        _ts:           ahora,
        creadaPor:     "SISTEMA",
      });
      creadas++;
    }

    if (creadas > 0) {
      await batch.commit();
      logger.info(`[alertasCobranza] ${creadas} alertas creadas`);
    } else {
      logger.info("[alertasCobranza] Sin alertas nuevas hoy");
    }
  }
);

exports.onSolicitudVisita = onDocumentCreated(
  { document: "solicitudes_visita/{solId}", region: "us-central1" },
  async (event) => {
    const sol = event.data.data();
    if (!sol) return;

    await db.collection("notificaciones_web").add({
      tipo:          "SOLICITUD_VISITA",
      mensaje:       `${sol.solicitadoPor || "—"} solicitó visita a ${sol.clienteNombre || "—"}`,
      destinatarios: ["TODOS"],
      accion:        { vista: "visitas" },
      leida:         false,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           Date.now(),
      creadaPor:     "SISTEMA",
    });

    logger.info(`[onSolicitudVisita] Notif para solicitud ${event.params.solId}`);
  }
);

// ═══════════════════════════════════════════════════════════════
// FCM: Enviar push notification al crear un doc en notificaciones_web
// ═══════════════════════════════════════════════════════════════
exports.onNotificacionCreada = onDocumentCreated(
  { document: "notificaciones_web/{notifId}", region: "us-central1" },
  async (event) => {
    const notif = event.data.data();
    if (!notif) return;

    const destinatarios = notif.destinatarios || [];
    const titulo = _tituloFCM(notif.tipo);
    const cuerpo = notif.mensaje || "";

    // Recopilar tokens FCM de los destinatarios
    let tokens = [];

    if (destinatarios.includes("TODOS")) {
      const snap = await db.collection("usuarios").where("activo", "==", true).get();
      snap.docs.forEach((d) => tokens.push(...(d.data().fcmTokens || [])));
    } else {
      for (const uid of destinatarios) {
        const snap = await db.collection("usuarios").doc(uid).get();
        if (snap.exists) tokens.push(...(snap.data().fcmTokens || []));
      }
    }

    tokens = [...new Set(tokens)].filter(Boolean);

    if (tokens.length === 0) {
      logger.info("[FCM] Sin tokens FCM registrados — notif solo en app");
      return;
    }

    const accion = notif.accion || {};
    const msg = {
      tokens,
      notification: { title: titulo, body: cuerpo },
      // data payload para onMessageReceived del APK (deep-link)
      data: {
        "accion.vista": accion.vista || "",
        "accion.id":    accion.id   || "",
        "tipo":         notif.tipo  || "",
      },
      android: {
        priority: "high",
        notification: {
          sound:       "default",
          channelId:   "n10_fcm",
          clickAction: "FLUTTER_NOTIFICATION_CLICK",
        },
      },
      webpush: {
        notification: {
          title: titulo,
          body:  cuerpo,
          icon:  "/icons/icon-192.svg",
          badge: "/icons/icon-192.svg",
          data:  accion,
        },
        fcmOptions: { link: "/" },
      },
    };

    const resp = await getMessaging().sendEachForMulticast(msg);
    logger.info(`[FCM] Enviado: ${resp.successCount} ok, ${resp.failureCount} fallo`);

    // Limpiar tokens inválidos de Firestore
    const invalidos = resp.responses
      .map((r, i) => (!r.success &&
        (r.error?.code === "messaging/invalid-registration-token" ||
         r.error?.code === "messaging/registration-token-not-registered"))
        ? tokens[i] : null)
      .filter(Boolean);

    if (invalidos.length > 0) {
      const usersSnap = await db.collection("usuarios").where("activo", "==", true).get();
      const batch = db.batch();
      usersSnap.docs.forEach((d) => {
        const toks  = d.data().fcmTokens || [];
        const clean = toks.filter((t) => !invalidos.includes(t));
        if (clean.length !== toks.length) batch.update(d.ref, { fcmTokens: clean });
      });
      await batch.commit();
      logger.info(`[FCM] ${invalidos.length} token(s) inválido(s) eliminados`);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// REABASTO — Cloud Functions
// ═══════════════════════════════════════════════════════════════

// ── onSolicitudReabasto: nueva solicitud → notif a almacenistas/admins ──
exports.onSolicitudReabasto = onDocumentCreated(
  { document: "solicitudes_reabasto/{solId}", region: "us-central1" },
  async (event) => {
    const sol   = event.data.data();
    const solId = event.params.solId;
    if (!sol) return;

    const tieneProductosSinStock = (sol.items || []).some(i => !i.hayStock);
    const tipo = tieneProductosSinStock ? "REABASTO_SIN_STOCK" : "REABASTO_SOLICITADO";
    const msg  = tieneProductosSinStock
      ? `${sol.ingenieroAlias} solicitó reabasto — hay productos sin stock en almacén`
      : `${sol.ingenieroAlias} solicitó reabasto de ${(sol.items||[]).length} producto(s)`;

    // Notificación en-app para almacenistas y admins
    await db.collection("notificaciones_web").add({
      tipo,
      titulo: "Nueva solicitud de reabasto",
      mensaje: msg,
      destinatarios: ["ROL_ALMACENISTAS"], // Cloud Function resuelve a UIDs reales vía query
      leida: false,
      timestamp: FieldValue.serverTimestamp(),
      _ts: Date.now(),
      datos: { solicitudId: solId, zona: sol.zona || "" },
      creadaPor: "SISTEMA",
    });

    // FCM push directo a almacenistas y admins (sin pasar por notificaciones_web listener)
    const rolesTarget = ["ALMACENISTA", "ADMINISTRADOR", "GERENTE", "SUPER_ADMIN"];
    const usersSnap = await db.collection("usuarios")
      .where("activo", "==", true)
      .get();
    let tokens = [];
    usersSnap.docs.forEach(d => {
      const u = d.data();
      if (rolesTarget.includes(u.rol)) tokens.push(...(u.fcmTokens || []));
    });
    tokens = [...new Set(tokens)].filter(Boolean);

    if (tokens.length > 0) {
      await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title: "📥 Solicitud de reabasto", body: msg },
        data: { tipo, "accion.vista": "reabasto", "accion.id": solId },
        android: { priority: "high", notification: { sound: "default", channelId: "n10_fcm" } },
        webpush: { notification: { icon: "/icons/icon-192.svg" }, fcmOptions: { link: "/" } },
      });
    }
    logger.info(`[onSolicitudReabasto] ${solId} — tipo: ${tipo} — tokens: ${tokens.length}`);
  }
);

// ── onSolicitudSurtida: estado → SURTIDO → notif al ingeniero ───
exports.onSolicitudSurtida = onDocumentUpdated(
  { document: "solicitudes_reabasto/{solId}", region: "us-central1" },
  async (event) => {
    const antes  = event.data.before.data();
    const despues = event.data.after.data();
    if (antes.estado === "SURTIDO" || despues.estado !== "SURTIDO") return;

    const solId = event.params.solId;
    const ingUid = despues.ingenieroUid;
    if (!ingUid) return;

    const msg = `Tu solicitud de reabasto fue surtida. Pasa al almacén a recoger.`;
    await db.collection("notificaciones_web").add({
      tipo: "REABASTO_SURTIDO",
      titulo: "Reabasto listo",
      mensaje: msg,
      destinatarios: [ingUid],
      leida: false,
      timestamp: FieldValue.serverTimestamp(),
      _ts: Date.now(),
      datos: { solicitudId: solId },
      creadaPor: "SISTEMA",
    });

    const ingSnap = await db.collection("usuarios").doc(ingUid).get();
    const tokens  = (ingSnap.data()?.fcmTokens || []).filter(Boolean);
    if (tokens.length > 0) {
      await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title: "📦 Reabasto listo", body: msg },
        data: { tipo: "REABASTO_SURTIDO", "accion.vista": "reabasto", "accion.id": solId },
        android: { priority: "high", notification: { sound: "default", channelId: "n10_fcm" } },
        webpush: { notification: { icon: "/icons/icon-192.svg" }, fcmOptions: { link: "/" } },
      });
    }
    logger.info(`[onSolicitudSurtida] ${solId} notificado a ${ingUid}`);
  }
);

// ── productosEstancados: diario 07:30 MX — busca stock >40 días sin movimiento ──
exports.productosEstancados = onSchedule(
  { schedule: "30 7 * * *", timeZone: "America/Mexico_City", region: "us-central1" },
  async () => {
    const ahora    = Date.now();
    const DIAS_40  = 40 * 24 * 60 * 60 * 1000;
    const limite   = ahora - DIAS_40;

    const snap = await db.collection("stock_ingenieros").get();
    const alertas = [];

    for (const d of snap.docs) {
      const data = d.data();
      const items = data.items || [];
      const estancados = items.filter(i =>
        i.cantidad > 0 && i.ultimoMovimiento && i.ultimoMovimiento < limite
      );
      if (estancados.length === 0) continue;

      alertas.push({
        ingenieroAlias: data.ingenieroAlias || d.id,
        ingenieroUid:   data.ingenieroUid   || d.id,
        estancados,
      });
    }

    if (alertas.length === 0) {
      logger.info("[productosEstancados] Sin productos estancados hoy");
      return;
    }

    // Notificar a almacenistas/admins
    const rolesTarget = ["ALMACENISTA", "ADMINISTRADOR", "GERENTE", "SUPER_ADMIN"];
    const usersSnap = await db.collection("usuarios").where("activo", "==", true).get();
    let tokens = [];
    const destinatarios = [];
    usersSnap.docs.forEach(d => {
      const u = d.data();
      if (rolesTarget.includes(u.rol)) {
        tokens.push(...(u.fcmTokens || []));
        destinatarios.push(d.id);
      }
    });
    tokens = [...new Set(tokens)].filter(Boolean);

    const totalEstancados = alertas.reduce((acc, a) => acc + a.estancados.length, 0);
    const msg = `${totalEstancados} producto(s) en vehículos sin movimiento >40 días`;

    await db.collection("notificaciones_web").add({
      tipo: "PRODUCTO_ESTANCADO",
      titulo: "Stock estancado detectado",
      mensaje: msg,
      destinatarios,
      leida: false,
      timestamp: FieldValue.serverTimestamp(),
      _ts: ahora,
      datos: { alertas: alertas.map(a => ({ alias: a.ingenieroAlias, n: a.estancados.length })) },
      creadaPor: "SISTEMA",
    });

    if (tokens.length > 0) {
      await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title: "🕒 Stock estancado", body: msg },
        data: { tipo: "PRODUCTO_ESTANCADO", "accion.vista": "reabasto" },
        android: { priority: "normal", notification: { sound: "default", channelId: "n10_fcm" } },
        webpush: { notification: { icon: "/icons/icon-192.svg" }, fcmOptions: { link: "/" } },
      });
    }
    logger.info(`[productosEstancados] ${alertas.length} ingeniero(s) con stock estancado`);
  }
);

// ═══════════════════════════════════════════════════════════════
// S9 — OBSERVABILIDAD Y BACKUP
// ═══════════════════════════════════════════════════════════════

// ── S9-A: Health check HTTP ─────────────────────────────────────
// GET https://us-central1-n10-erp.cloudfunctions.net/healthCheck
exports.healthCheck = onRequest(
  { region: "us-central1", cors: ["https://n10-erp.web.app"] },
  async (req, res) => {
    const t0 = Date.now();
    try {
      // Lectura mínima de Firestore para medir latencia
      await db.collection("_system").doc("health").set(
        { lastPing: FSTimestamp.now(), uptime: process.uptime() },
        { merge: true }
      );
      const latenciaMs = Date.now() - t0;

      // Última métrica diaria
      const hoy = new Date().toISOString().slice(0, 10);
      const metSnap = await db.collection("metricas_diarias").doc(hoy).get();
      const metricas = metSnap.exists ? metSnap.data() : null;

      // Último backup
      const backSnap = await db.collection("backups_manifesto")
        .orderBy("_ts", "desc").limit(1).get();
      const ultimoBackup = backSnap.empty ? null : backSnap.docs[0].data();

      res.json({
        status:       "OK",
        timestamp:    new Date().toISOString(),
        latenciaMs,
        metricas,
        ultimoBackup: ultimoBackup ? { fecha: ultimoBackup.fecha, totalDocs: ultimoBackup.totalDocs } : null,
      });
    } catch (e) {
      res.status(500).json({ status: "ERROR", error: e.message, latenciaMs: Date.now() - t0 });
    }
  }
);

// ── S9-B: Métricas diarias (23:55 hora CDMX) ───────────────────
exports.metricasDiarias = onSchedule(
  { schedule: "55 23 * * *", timeZone: "America/Mexico_City", region: "us-central1" },
  async () => {
    const hoy    = new Date();
    const fecha  = hoy.toISOString().slice(0, 10);
    const desdeTs = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 0, 0, 0).getTime();
    const hastaTs = desdeTs + 86_399_999;

    // Contar documentos del día en colecciones clave
    const [pedSnap, visSnap, aboSnap, notSnap, cotSnap] = await Promise.all([
      db.collection("pedidos")
        .where("_ts", ">=", desdeTs).where("_ts", "<=", hastaTs).count().get(),
      db.collection("visitas_programadas")
        .where("status", "==", "COMPLETADA")
        .where("fechaTs", ">=", desdeTs).where("fechaTs", "<=", hastaTs).count().get(),
      db.collection("abonos")
        .where("_ts", ">=", desdeTs).where("_ts", "<=", hastaTs).count().get(),
      db.collection("notificaciones_web")
        .where("_ts", ">=", desdeTs).where("_ts", "<=", hastaTs).count().get(),
      db.collection("cotizaciones")
        .where("_ts", ">=", desdeTs).count().get(),
    ]);

    // Totales acumulados (sin filtro de fecha — snapshot del momento)
    const [cliSnap, usrSnap] = await Promise.all([
      db.collection("clientes").where("activo", "==", true).count().get(),
      db.collection("usuarios").where("activo", "==", true).count().get(),
    ]);

    const metricas = {
      fecha,
      pedidosHoy:         pedSnap.data().count,
      visitasCompletadas: visSnap.data().count,
      abonosHoy:          aboSnap.data().count,
      notificacionesHoy:  notSnap.data().count,
      cotizacionesHoy:    cotSnap.data().count,
      clientesActivos:    cliSnap.data().count,
      usuariosActivos:    usrSnap.data().count,
      generadoEn:         FSTimestamp.now(),
      _ts:                Date.now(),
    };

    await db.collection("metricas_diarias").doc(fecha).set(metricas, { merge: true });
    logger.info(`[metricasDiarias] ${fecha}:`, metricas);
  }
);

// ── S9-C: Backup manifesto diario (02:00 CDMX) ─────────────────
exports.backupManifesto = onSchedule(
  { schedule: "0 2 * * *", timeZone: "America/Mexico_City", region: "us-central1" },
  async () => {
    const fecha = new Date().toISOString().slice(0, 10);

    // Contar documentos de las colecciones críticas → manifesto de integridad
    const colecciones = [
      "clientes", "pedidos", "remisiones", "abonos",
      "cotizaciones", "usuarios", "visitas_programadas",
      "geocercas", "productos", "kardex",
    ];

    const conteos = {};
    let totalDocs = 0;
    await Promise.all(
      colecciones.map(async (col) => {
        try {
          const snap = await db.collection(col).count().get();
          conteos[col] = snap.data().count;
          totalDocs   += conteos[col];
        } catch (_) {
          conteos[col] = -1; // colección no accesible
        }
      })
    );

    const manifesto = {
      fecha,
      conteos,
      totalDocs,
      generadoEn: FSTimestamp.now(),
      _ts:        Date.now(),
    };

    await db.collection("backups_manifesto").doc(fecha).set(manifesto);
    logger.info(`[backupManifesto] ${fecha} — ${totalDocs} docs totales`);
  }
);

// ═══════════════════════════════════════════════════════════════
// S14-A. NOTIFICAR CAMBIO DE STATUS EN PEDIDO
//        Trigger: pedidos/{pedidoId} updated → status cambia
//        Escribe notificaciones_web → onNotificacionCreada envía FCM
// ═══════════════════════════════════════════════════════════════
exports.onPedidoStatusChange = onDocumentUpdated(
  { document: "pedidos/{pedidoId}", region: "us-central1" },
  async (event) => {
    const antes   = event.data.before.data();
    const despues = event.data.after.data();
    const pedidoId = event.params.pedidoId;

    if (antes.status === despues.status) return;

    const STATUS_MSG = {
      CONFIRMADO: "✅ Tu pedido fue confirmado",
      EN_RUTA:    "🚚 Tu pedido salió a ruta",
      ENTREGADO:  "📦 Pedido marcado como entregado",
      FACTURADO:  "🧾 Pedido facturado",
    };

    const nuevoStatus = despues.status;
    const msg = STATUS_MSG[nuevoStatus];
    if (!msg) return; // no notificamos BORRADOR ni otros

    const folio   = despues.folio   || pedidoId;
    const ingUid  = despues.ingenieroUid || null;
    const alias   = despues.ingenieroAlias || "–";
    const cliente = despues.clienteNombre || "–";

    const notif = {
      tipo:          "PEDIDO_STATUS",
      subtipo:       nuevoStatus,
      mensaje:       `${msg} — ${folio} · ${cliente}`,
      destinatarios: ingUid ? [ingUid] : [],
      accion:        { vista: "pedidos", id: pedidoId },
      leida:         false,
      ingenieroAlias: alias,
      folioPedido:   folio,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           Date.now(),
      creadaPor:     "SISTEMA",
    };

    await db.collection("notificaciones_web").add(notif);
    logger.info(`[onPedidoStatusChange] ${folio} → ${nuevoStatus} — uid=${ingUid}`);
  }
);

// ═══════════════════════════════════════════════════════════════
// S14-B. NOTIFICAR DECISIÓN SOBRE SOLICITUD DE VACACIONES
//        Trigger: rh_vacaciones/{vacId} updated → status ≠ PENDIENTE
// ═══════════════════════════════════════════════════════════════
exports.onVacacionDecision = onDocumentUpdated(
  { document: "rh_vacaciones/{vacId}", region: "us-central1" },
  async (event) => {
    const antes   = event.data.before.data();
    const despues = event.data.after.data();

    if (antes.status === despues.status) return;
    if (despues.status === "PENDIENTE")  return;

    const uid  = despues.uid || null;
    if (!uid) return;

    const aprobada = despues.status === "APROBADA";
    const desde    = despues.desde || "–";
    const hasta    = despues.hasta || "–";
    const quien    = aprobada ? (despues.aprobadaPor || "Admin") : (despues.rechazadaPor || "Admin");

    const msg = aprobada
      ? `✅ Tus vacaciones del ${desde} al ${hasta} fueron aprobadas por ${quien}`
      : `❌ Tu solicitud de vacaciones ${desde}–${hasta} fue rechazada. ${despues.motivoRechazo ? "Motivo: " + despues.motivoRechazo : ""}`;

    await db.collection("notificaciones_web").add({
      tipo:          aprobada ? "VACACION_APROBADA" : "VACACION_RECHAZADA",
      mensaje:       msg,
      destinatarios: [uid],
      accion:        { vista: "mi-rh" },
      leida:         false,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           Date.now(),
      creadaPor:     "SISTEMA",
    });

    logger.info(`[onVacacionDecision] uid=${uid} → ${despues.status}`);
  }
);

// ═══════════════════════════════════════════════════════════════
// S14-C. NOTIFICAR DECISIÓN SOBRE SOLICITUD DE ANTICIPO
//        Trigger: rh_anticipos/{antId} updated → status ≠ PENDIENTE
// ═══════════════════════════════════════════════════════════════
exports.onAnticipoDecision = onDocumentUpdated(
  { document: "rh_anticipos/{antId}", region: "us-central1" },
  async (event) => {
    const antes   = event.data.before.data();
    const despues = event.data.after.data();

    if (antes.status === despues.status) return;
    if (despues.status === "PENDIENTE")  return;

    const uid = despues.uid || null;
    if (!uid) return;

    const monto   = (despues.monto || 0).toLocaleString("es-MX", { minimumFractionDigits: 2 });
    const STATUS_MSG = {
      APROBADO:   `✅ Tu anticipo de $${monto} fue aprobado por ${despues.aprobadoPor || "Admin"}`,
      RECHAZADO:  `❌ Tu anticipo de $${monto} fue rechazado. ${despues.motivoRechazo ? "Motivo: " + despues.motivoRechazo : ""}`,
      DESCONTADO: `💰 Tu anticipo de $${monto} fue descontado de tu nómina`,
    };

    const msg = STATUS_MSG[despues.status];
    if (!msg) return;

    await db.collection("notificaciones_web").add({
      tipo:          `ANTICIPO_${despues.status}`,
      mensaje:       msg,
      destinatarios: [uid],
      accion:        { vista: "mi-rh" },
      leida:         false,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           Date.now(),
      creadaPor:     "SISTEMA",
    });

    logger.info(`[onAnticipoDecision] uid=${uid} → ${despues.status} monto=$${monto}`);
  }
);

// S20-A. CLIENTE BLOQUEADO — notificar al ingeniero asignado y a MESA_CONTROL
exports.onClienteActualizado = onDocumentUpdated(
  { document: "clientes/{clienteId}", region: "us-central1" },
  async (event) => {
    const antes   = event.data.before.data();
    const despues = event.data.after.data();

    const bloqueoNuevo  = !antes.bloqueado  && despues.bloqueado;
    const semaforoRojo  = antes.semaforoColor !== "ROJO" && despues.semaforoColor === "ROJO";

    if (!bloqueoNuevo && !semaforoRojo) return;

    const clienteNombre = despues.nombre || "Cliente";
    const ingUid        = despues.ingenieroId || null;

    // Colectar destinatarios: ingeniero asignado + todos los MESA_CONTROL
    const destinatarios = ingUid ? [ingUid] : [];
    try {
      const mesaSnap = await db.collection("usuarios")
        .where("rol", "==", "MESA_CONTROL")
        .where("activo", "==", true)
        .get();
      mesaSnap.docs.forEach(d => {
        if (!destinatarios.includes(d.id)) destinatarios.push(d.id);
      });
    } catch (_) {}

    if (destinatarios.length === 0) return;

    if (bloqueoNuevo) {
      const saldo = (despues.saldoPendiente || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
      await db.collection("notificaciones_web").add({
        tipo:          "CLIENTE_BLOQUEADO",
        mensaje:       `🔒 ${clienteNombre} ha sido bloqueado por cartera vencida · ${saldo}`,
        destinatarios,
        accion:        { vista: "cartera", id: event.params.clienteId },
        leida:         false,
        timestamp:     FieldValue.serverTimestamp(),
        _ts:           Date.now(),
        creadaPor:     "SISTEMA",
      });
      logger.info(`[onClienteActualizado] BLOQUEADO cliente=${clienteNombre} dests=${destinatarios.length}`);
    }

    if (semaforoRojo && !bloqueoNuevo) {
      const dias = despues.diasMaxVencidos || 0;
      await db.collection("notificaciones_web").add({
        tipo:          "SEMAFORO_ROJO",
        mensaje:       `🔴 ${clienteNombre} en semáforo ROJO · ${dias} días vencidos`,
        destinatarios,
        accion:        { vista: "cartera", id: event.params.clienteId },
        leida:         false,
        timestamp:     FieldValue.serverTimestamp(),
        _ts:           Date.now(),
        creadaPor:     "SISTEMA",
      });
      logger.info(`[onClienteActualizado] SEMAFORO_ROJO cliente=${clienteNombre} dests=${destinatarios.length}`);
    }
  }
);

// S20-B. CLIENTE DESBLOQUEADO — notificar al ingeniero que ya puede operar
exports.onClienteDesbloqueado = onDocumentUpdated(
  { document: "clientes/{clienteId}", region: "us-central1" },
  async (event) => {
    const antes   = event.data.before.data();
    const despues = event.data.after.data();

    if (!antes.bloqueado || despues.bloqueado) return;

    const clienteNombre = despues.nombre || "Cliente";
    const ingUid        = despues.ingenieroId || null;
    if (!ingUid) return;

    await db.collection("notificaciones_web").add({
      tipo:          "CLIENTE_DESBLOQUEADO",
      mensaje:       `✅ ${clienteNombre} ha sido desbloqueado · ya puede generar pedidos`,
      destinatarios: [ingUid],
      accion:        { vista: "cartera", id: event.params.clienteId },
      leida:         false,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           Date.now(),
      creadaPor:     "SISTEMA",
    });
    logger.info(`[onClienteDesbloqueado] cliente=${clienteNombre} ing=${ingUid}`);
  }
);

// S17 — Notificar al empleado cuando se registra su pago de nómina
exports.onNominaPagada = onDocumentCreated(
  { document: "rh_nomina/{docId}", region: "us-central1" },
  async (event) => {
    const nomina = event.data.data();
    const uid    = nomina.uid || null;
    if (!uid) return;

    const neto    = (nomina.netoPagado || 0).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
    const periodo = nomina.periodo || "";

    await db.collection("notificaciones_web").add({
      tipo:          "NOMINA_PAGADA",
      mensaje:       `💼 Tu pago de nómina ${neto} ha sido registrado. Período: ${periodo}`,
      destinatarios: [uid],
      accion:        { vista: "mi-rh" },
      leida:         false,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           Date.now(),
      creadaPor:     "SISTEMA",
    });

    logger.info(`[onNominaPagada] uid=${uid} neto=${neto} periodo=${periodo}`);
  }
);

// S24 ── Reporte semanal automático para gerencia (lunes 07:00 CDMX)
exports.reporteSemanalGerente = onSchedule(
  { schedule: "0 7 * * 1", timeZone: "America/Mexico_City", region: "us-central1" },
  async (_context) => {
    const ahora = Date.now();

    // Rango: semana anterior (lun-dom)
    const hoy    = new Date();
    const lunes  = new Date(hoy); lunes.setDate(hoy.getDate() - 7); lunes.setHours(0,0,0,0);
    const domingo = new Date(hoy); domingo.setDate(hoy.getDate() - 1); domingo.setHours(23,59,59,999);
    const tsLunes  = lunes.getTime();
    const tsDomingo = domingo.getTime();
    const fmtMXN = n => n.toLocaleString("es-MX", { style:"currency", currency:"MXN", maximumFractionDigits:0 });
    const semanaStr = `${lunes.toLocaleDateString("es-MX",{day:"numeric",month:"short"})} – ${domingo.toLocaleDateString("es-MX",{day:"numeric",month:"short",year:"numeric"})}`;

    // 1. Pedidos de la semana anterior
    let totalVentas = 0, confirmados = 0, cancelados = 0;
    const ventasPorIng = {}; // alias → monto
    try {
      const pedSnap = await db.collection("pedidos")
        .where("fechaPedido", ">=", tsLunes)
        .where("fechaPedido", "<=", tsDomingo)
        .get();
      pedSnap.docs.forEach(d => {
        const p = d.data();
        if (p.status === "CANCELADO" || p.status === "RECHAZADO") { cancelados++; return; }
        confirmados++;
        totalVentas += p.total || 0;
        const alias = p.ingenieroAlias || "Sin asignar";
        ventasPorIng[alias] = (ventasPorIng[alias] || 0) + (p.total || 0);
      });
    } catch (e) {
      logger.error("[reporteSemanalGerente] Error leyendo pedidos:", e);
      return;
    }

    // 2. Top 3 ingenieros
    const top3 = Object.entries(ventasPorIng)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([alias, monto], i) => `${["🥇","🥈","🥉"][i]} ${alias}: ${fmtMXN(monto)}`)
      .join(" · ");

    const mensaje = `📊 Semana ${semanaStr} · Ventas: ${fmtMXN(totalVentas)} · ✅${confirmados} pedidos · ❌${cancelados} cancel. · ${top3 || "Sin ventas"}`;

    // 3. Destinatarios: GERENTE + SUPER_ADMIN
    const destinatarios = [];
    try {
      const uSnap = await db.collection("usuarios")
        .where("rol", "in", ["GERENTE", "SUPER_ADMIN"])
        .where("activo", "==", true)
        .get();
      uSnap.docs.forEach(d => destinatarios.push(d.id));
    } catch (_) {}

    if (destinatarios.length === 0) { logger.info("[reporteSemanalGerente] Sin gerentes activos."); return; }

    await db.collection("notificaciones_web").add({
      tipo:          "REPORTE_SEMANAL",
      mensaje,
      destinatarios,
      accion:        { vista: "dashboard" },
      leida:         false,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           ahora,
      creadaPor:     "SISTEMA",
    });

    logger.info(`[reporteSemanalGerente] semana=${semanaStr} ventas=${totalVentas} dests=${destinatarios.length}`);
  }
);

// S23 ── Recordatorio semanal de avance en metas de venta (lunes 08:00 y día 15 08:00 hora CDMX)
exports.recordatorioMetas = onSchedule(
  { schedule: "0 8 * * 1", timeZone: "America/Mexico_City", region: "us-central1" },
  async (_context) => {
    const ahora  = Date.now();
    const hoy    = new Date();
    const mesAct = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;

    // 1. Leer todas las metas activas del mes actual
    const metasSnap = await db.collection("metas")
      .where("activa", "==", true)
      .get();

    if (metasSnap.empty) return;

    // 2. Agrupar metas por alias (puede haber varias por ingeniero)
    const metasPorAlias = {};
    metasSnap.docs.forEach(d => {
      const m = { id: d.id, ...d.data() };
      // Solo las del mes actual (fechaInicio dentro del mes activo)
      const fi = typeof m.fechaInicio === "number" ? new Date(m.fechaInicio) : null;
      if (!fi) return;
      const mes = `${fi.getFullYear()}-${String(fi.getMonth() + 1).padStart(2, "0")}`;
      if (mes !== mesAct) return;
      if (!metasPorAlias[m.alias]) metasPorAlias[m.alias] = [];
      metasPorAlias[m.alias].push(m);
    });

    if (Object.keys(metasPorAlias).length === 0) {
      logger.info("[recordatorioMetas] No hay metas activas para este mes.");
      return;
    }

    // 3. Por cada ingeniero con meta, calcular ventas del mes y enviar FCM
    const fmtMXN = n => n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

    for (const [alias, metas] of Object.entries(metasPorAlias)) {
      const totalMeta = metas.reduce((s, m) => s + (m.metaMonto || 0), 0);
      if (totalMeta <= 0) continue;

      // Calcular ventas del mes para este ingeniero
      const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1).getTime();
      let totalVendido = 0;
      try {
        const pedSnap = await db.collection("pedidos")
          .where("ingenieroAlias", "==", alias)
          .where("fechaPedido", ">=", inicioMes)
          .get();
        pedSnap.docs.forEach(d => {
          const p = d.data();
          if (p.status !== "CANCELADO" && p.status !== "RECHAZADO")
            totalVendido += p.total || 0;
        });
      } catch (_) { continue; }

      const pct = Math.min(Math.round((totalVendido / totalMeta) * 100), 100);
      const emoji = pct >= 100 ? "🏆" : pct >= 70 ? "📈" : pct >= 40 ? "⚠️" : "🔴";

      // Buscar uid del ingeniero en colección usuarios
      let uid = null;
      try {
        const uSnap = await db.collection("usuarios")
          .where("alias", "==", alias)
          .where("activo", "==", true)
          .limit(1)
          .get();
        if (!uSnap.empty) uid = uSnap.docs[0].id;
      } catch (_) {}

      if (!uid) continue;

      await db.collection("notificaciones_web").add({
        tipo:          "RECORDATORIO_META",
        mensaje:       `${emoji} Tu avance de venta este mes: ${fmtMXN(totalVendido)} de ${fmtMXN(totalMeta)} (${pct}%)`,
        destinatarios: [uid],
        accion:        { vista: "metas" },
        leida:         false,
        timestamp:     FieldValue.serverTimestamp(),
        _ts:           ahora,
        creadaPor:     "SISTEMA",
      });

      logger.info(`[recordatorioMetas] alias=${alias} pct=${pct}% vendido=${totalVendido} meta=${totalMeta}`);
    }
  }
);

// S22 ── Notificación cuando un ingeniero envía una respuesta de formulario de campo
exports.onFormularioRespondido = onDocumentCreated(
  { document: "respuestas_formulario/{docId}", region: "us-central1" },
  async (event) => {
    const resp         = event.data.data();
    const aliasIng     = resp.alias || resp.ingenieroAlias || "Ingeniero";
    const formulario   = resp.formularioNombre || resp.formularioId || "formulario";
    const clienteNombre = resp.clienteNombre || "";

    // Notificar a todos los MESA_CONTROL activos
    const destinatarios = [];
    try {
      const mesaSnap = await db.collection("usuarios")
        .where("rol", "==", "MESA_CONTROL")
        .where("activo", "==", true)
        .get();
      mesaSnap.docs.forEach(d => destinatarios.push(d.id));
    } catch (_) {}

    if (destinatarios.length === 0) return;

    const msg = clienteNombre
      ? `📋 ${aliasIng} respondió "${formulario}" · cliente: ${clienteNombre}`
      : `📋 ${aliasIng} respondió "${formulario}"`;

    await db.collection("notificaciones_web").add({
      tipo:          "FORMULARIO_RESPONDIDO",
      mensaje:       msg,
      destinatarios,
      accion:        { vista: "formularios" },
      leida:         false,
      timestamp:     FieldValue.serverTimestamp(),
      _ts:           Date.now(),
      creadaPor:     "SISTEMA",
    });

    logger.info(`[onFormularioRespondido] alias=${aliasIng} form="${formulario}" dests=${destinatarios.length}`);
  }
);

// S26 ── Liquidación automática de comisiones al inicio de cada mes
//  Corre el día 1 a las 07:30 MX — después de limpiarDatosAntiguos (06:00)
exports.liquidarComisionesMensual = onSchedule(
  { schedule: "30 7 1 * *", timeZone: "America/Mexico_City", region: "us-central1" },
  async (_ctx) => {
    const hoy    = new Date();
    // Rango: mes anterior completo
    const inicio = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const fin    = new Date(hoy.getFullYear(), hoy.getMonth(),     1);
    const tsIni  = inicio.getTime();
    const tsFin  = fin.getTime();

    const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                   "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
    const periodoLabel = `${MESES[inicio.getMonth()]} ${inicio.getFullYear()}`;

    logger.info(`[liquidarComisiones] Período: ${periodoLabel} (${tsIni}–${tsFin})`);

    // 1. Pedidos ENTREGADO del mes anterior
    let pedidosSnap;
    try {
      pedidosSnap = await db.collection("pedidos")
        .where("status", "==", "ENTREGADO")
        .where("_ts", ">=", tsIni)
        .where("_ts", "<",  tsFin)
        .get();
    } catch (e) {
      logger.error("[liquidarComisiones] Error al leer pedidos:", e.message);
      return;
    }

    // 2. Agrupar ventas por alias de ingeniero
    const ventasPorAlias = {};
    pedidosSnap.docs.forEach(d => {
      const p     = d.data();
      const alias = p.ingenieroAlias || p.alias || "";
      const total = typeof p.total === "number" ? p.total : 0;
      if (!alias || total <= 0) return;
      ventasPorAlias[alias] = (ventasPorAlias[alias] || 0) + total;
    });

    if (Object.keys(ventasPorAlias).length === 0) {
      logger.info("[liquidarComisiones] Sin ventas ENTREGADO en el período.");
      return;
    }

    // 3. Cargar todas las configs de comisión
    const configsSnap = await db.collection("comision_config").get();
    const configs = {};
    configsSnap.docs.forEach(d => { configs[d.id] = d.data(); });

    // 4. Calcular y guardar liquidación por alias
    const batch = db.batch();
    const notificaciones = [];

    for (const [alias, totalVendido] of Object.entries(ventasPorAlias)) {
      const cfg = configs[alias];
      if (!cfg) {
        logger.warn(`[liquidarComisiones] Sin config de comisión para alias="${alias}" — omitido`);
        continue;
      }

      // Aplicar tramos progresivos
      let tramos = [];
      try { tramos = JSON.parse(cfg.tramosJson || "[]"); } catch (_) {}
      tramos.sort((a, b) => a.meta - b.meta);

      let montoComision = 0;
      let volumenRestante = totalVendido;
      let pisoAnterior = 0;

      for (const t of tramos) {
        if (volumenRestante <= 0) break;
        const techo  = t.meta;
        const tramo  = Math.min(volumenRestante, techo - pisoAnterior);
        montoComision += tramo > 0 ? tramo * (t.pct / 100) : 0;
        volumenRestante -= tramo;
        pisoAnterior = techo;
      }
      // Si sigue habiendo volumen más allá del último tramo, aplica el % del último tramo
      if (volumenRestante > 0 && tramos.length > 0) {
        montoComision += volumenRestante * (tramos[tramos.length - 1].pct / 100);
      }

      const salarioBase = cfg.salarioBase || 0;
      const totalPago   = salarioBase + montoComision;

      // Documento de liquidación (id determinístico: alias_YYYY-MM evita duplicados)
      const docId = `${alias}_${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, "0")}`;
      const ref   = db.collection("liquidacion_comision").doc(docId);
      batch.set(ref, {
        aliasIngeniero: alias,
        periodoLabel,
        fechaInicio:   tsIni,
        fechaFin:      tsFin,
        totalVendido,
        salarioBase,
        montoComision,
        totalPago,
        status:        "PENDIENTE",
        creadoPor:     "SISTEMA",
        _ts:           Date.now(),
      }, { merge: false });

      notificaciones.push({ alias, montoComision, totalVendido, salarioBase, totalPago });
    }

    await batch.commit();
    logger.info(`[liquidarComisiones] Liquidaciones guardadas para: ${Object.keys(ventasPorAlias).join(", ")}`);

    // 5. Notificar a cada ingeniero
    for (const { alias, montoComision, totalVendido, salarioBase, totalPago } of notificaciones) {
      try {
        // Buscar uid del ingeniero por alias
        const uSnap = await db.collection("usuarios")
          .where("alias", "==", alias).where("activo", "==", true).limit(1).get();
        if (uSnap.empty) continue;
        const uid = uSnap.docs[0].id;

        const fmt = v => new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN", maximumFractionDigits:0 }).format(v);
        await db.collection("notificaciones_web").add({
          tipo:          "COMISION_LIQUIDADA",
          mensaje:       `💰 Tu comisión de ${periodoLabel}: ventas ${fmt(totalVendido)} · comisión ${fmt(montoComision)} · total ${fmt(totalPago)}`,
          destinatarios: [uid],
          accion:        { vista: "comisiones" },
          leida:         false,
          timestamp:     FieldValue.serverTimestamp(),
          _ts:           Date.now(),
          creadaPor:     "SISTEMA",
        });
      } catch (e) {
        logger.warn(`[liquidarComisiones] No se pudo notificar a ${alias}:`, e.message);
      }
    }

    // 6. Notificar al GERENTE con resumen
    try {
      const gerSnap = await db.collection("usuarios")
        .where("rol", "in", ["GERENTE", "SUPER_ADMIN"])
        .where("activo", "==", true).get();
      const destGer = gerSnap.docs.map(d => d.id);
      if (destGer.length > 0) {
        const totalComisiones = notificaciones.reduce((s, n) => s + n.montoComision, 0);
        const fmt = v => new Intl.NumberFormat("es-MX", { style:"currency", currency:"MXN", maximumFractionDigits:0 }).format(v);
        await db.collection("notificaciones_web").add({
          tipo:          "REPORTE_COMISIONES",
          mensaje:       `📊 Comisiones ${periodoLabel}: ${notificaciones.length} ingenieros · total ${fmt(totalComisiones)}`,
          destinatarios: destGer,
          accion:        { vista: "comisiones" },
          leida:         false,
          timestamp:     FieldValue.serverTimestamp(),
          _ts:           Date.now(),
          creadaPor:     "SISTEMA",
        });
      }
    } catch (e) {
      logger.warn("[liquidarComisiones] No se pudo notificar al gerente:", e.message);
    }
  }
);

// S25 ── Limpieza semanal de datos antiguos (control de costos Firestore)
//  Lunes 06:00 Mexico City — antes que el reporte del gerente (07:00)
exports.limpiarDatosAntiguos = onSchedule(
  { schedule: "0 6 * * 1", timeZone: "America/Mexico_City", region: "us-central1" },
  async (_ctx) => {
    const ahora = Date.now();
    const DIAS_NOTIF   = 30;
    const DIAS_CHAT    = 60;
    const DIAS_FORMS   = 90;
    const MS_NOTIF  = DIAS_NOTIF  * 86_400_000;
    const MS_CHAT   = DIAS_CHAT   * 86_400_000;
    const MS_FORMS  = DIAS_FORMS  * 86_400_000;
    let totalBorrados = 0;

    // Borra en lotes de 400 para no exceder el límite de 500 por batch
    async function borrarLote(snap) {
      if (snap.empty) return 0;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      return snap.size;
    }

    // 1. notificaciones_web leídas con más de 30 días
    try {
      const snap = await db.collection("notificaciones_web")
        .where("leida", "==", true)
        .where("_ts", "<", ahora - MS_NOTIF)
        .limit(400)
        .get();
      totalBorrados += await borrarLote(snap);
    } catch (e) { logger.error("[limpiar] notificaciones_web:", e.message); }

    // 2. mensajes_internos (chat) con más de 60 días
    try {
      const snap = await db.collection("mensajes_internos")
        .where("_ts", "<", ahora - MS_CHAT)
        .limit(400)
        .get();
      totalBorrados += await borrarLote(snap);
    } catch (e) { logger.error("[limpiar] mensajes_internos:", e.message); }

    // 3. respuestas_formulario con más de 90 días
    try {
      const snap = await db.collection("respuestas_formulario")
        .where("_ts", "<", ahora - MS_FORMS)
        .limit(400)
        .get();
      totalBorrados += await borrarLote(snap);
    } catch (e) { logger.error("[limpiar] respuestas_formulario:", e.message); }

    logger.info(`[limpiarDatosAntiguos] Total eliminados: ${totalBorrados}`);
  }
);

// ═══════════════════════════════════════════════════════════════
// CF: onCorteCajaCreado (S32 — Arqueo/Corte de Caja)
//    Trigger: cortes_caja/{corteId} created
//    Notifica a MESA_CONTROL y GERENTE cuando un vendedor envía su corte.
// ═══════════════════════════════════════════════════════════════
exports.onCorteCajaCreado = onDocumentCreated(
  { document: "cortes_caja/{corteId}", region: "us-central1" },
  async (event) => {
    const corte = event.data?.data();
    if (!corte) return;

    const { alias, totalDeclarado, totalSistema, turno } = corte;
    const dif      = (totalDeclarado || 0) - (totalSistema || 0);
    const difStr   = dif >= 0 ? `+$${dif.toFixed(2)}` : `-$${Math.abs(dif).toFixed(2)}`;
    const turnoStr = turno ? ` · Turno: ${turno}` : "";

    const rolesSnap = await db.collection("usuarios")
      .where("rol", "in", ["MESA_CONTROL", "GERENTE"])
      .get();
    const destinatarios = rolesSnap.docs.map(d => d.id);
    if (!destinatarios.length) return;

    await db.collection("notificaciones_web").add({
      tipo:          "CORTE_CAJA",
      mensaje:       `${alias} envió corte de caja${turnoStr} · Declarado: $${(totalDeclarado||0).toFixed(2)} · Diferencia: ${difStr}`,
      destinatarios,
      leido:         false,
      _ts:           Date.now(),
      timestamp:     FieldValue.serverTimestamp(),
    });
  }
);

// ═══════════════════════════════════════════════════════════════
// CF: onPedidoEntregadoPuntos (S31 — Lealtad por producto/categoría)
//    Trigger: pedidos/{pedidoId} updated → status cambia a ENTREGADO
//    Acumula puntos en puntos_cliente usando lealtad_config_producto.
//    Jerarquía: regla de producto > regla de categoría > puntosPorPeso global.
// ═══════════════════════════════════════════════════════════════
exports.onPedidoEntregadoPuntos = onDocumentUpdated(
  { document: "pedidos/{pedidoId}", region: "us-central1" },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (!before || !after) return;
    if (before.status === after.status || after.status !== "ENTREGADO") return;

    const clienteId = after.clienteId || after.cliente_id;
    if (!clienteId) return;

    const productos = after.productos || after.items || [];
    if (!productos.length) return;

    // Cargar todas las reglas de lealtad por producto/categoría
    const reglasSnap = await db.collection("lealtad_config_producto")
      .where("activo", "==", true).get();
    const reglasProducto   = {};
    const reglasCategoria  = {};
    reglasSnap.docs.forEach(d => {
      const r = d.data();
      if (r.tipo === "producto")  reglasProducto[r.refId]  = r.puntosPorPeso || 1;
      if (r.tipo === "categoria") reglasCategoria[r.refId] = r.puntosPorPeso || 1;
    });

    const puntosPorPesoGlobal = 1; // fallback cuando no hay regla

    let totalPuntos = 0;
    for (const item of productos) {
      const subtotal   = (item.precio || 0) * (item.cantidad || 1);
      const prodId     = item.productoId || item.id || "";
      const categoria  = item.categoria || "";
      const ppp = reglasProducto[prodId] ?? reglasCategoria[categoria] ?? puntosPorPesoGlobal;
      totalPuntos += Math.floor(subtotal * ppp);
    }

    if (totalPuntos <= 0) return;

    const pedidoId = event.params.pedidoId;
    const batch    = db.batch();

    // Actualizar saldo en puntos_cliente
    const puntosRef = db.collection("puntos_cliente").doc(clienteId);
    batch.set(puntosRef, { puntos: FieldValue.increment(totalPuntos), clienteId }, { merge: true });

    // Registrar en historial_puntos
    const histRef = db.collection("historial_puntos").doc(`${clienteId}_${pedidoId}`);
    batch.set(histRef, {
      clienteId,
      pedidoId,
      puntos:    totalPuntos,
      motivo:    "PEDIDO_ENTREGADO",
      _ts:       Date.now(),
      timestamp: FieldValue.serverTimestamp(),
    });

    await batch.commit();
    logger.info(`[onPedidoEntregadoPuntos] ${totalPuntos} puntos → cliente ${clienteId}`);
  }
);

// ═══════════════════════════════════════════════════════════════
// CF: onSmsCampanaCreada (S29 — SMS vía SendPulse)
//    Trigger: sms_campanas/{campanaId} created
//    Lee SENDPULSE_CLIENT_ID + SENDPULSE_CLIENT_SECRET del entorno,
//    obtiene Bearer token OAuth2 y envía SMS a todos los destinatarios.
// ═══════════════════════════════════════════════════════════════
exports.onSmsCampanaCreada = onDocumentCreated(
  { document: "sms_campanas/{campanaId}", region: "us-central1", secrets: ["SENDPULSE_CLIENT_ID", "SENDPULSE_CLIENT_SECRET"] },
  async (event) => {
    const campanaRef = event.data.ref;
    const campana    = event.data.data();
    if (!campana || campana.status !== "PENDIENTE") return;

    const clientId     = process.env.SENDPULSE_CLIENT_ID;
    const clientSecret = process.env.SENDPULSE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      logger.error("[onSmsCampanaCreada] Credenciales SendPulse no configuradas.");
      await campanaRef.update({ status: "ERROR", errorMsg: "Credenciales no configuradas" });
      return;
    }

    await campanaRef.update({ status: "PROCESANDO" });

    try {
      // 1. Obtener token OAuth2
      const token = await _sendpulseToken(clientId, clientSecret);

      // 2. Enviar SMS a cada destinatario
      const { destinatarios, mensaje, sender } = campana;
      let enviados = 0;
      let errores  = 0;

      for (const telefono of destinatarios) {
        try {
          // Personalizar {nombre} si el cliente existe en Firestore
          let texto = mensaje;
          const clienteSnap = await db.collection("clientes").where("telefono", "==", telefono).limit(1).get();
          if (!clienteSnap.empty) {
            const nombre = clienteSnap.docs[0].data().nombre || "";
            texto = texto.replace(/\{nombre\}/gi, nombre.split(" ")[0]);
          } else {
            texto = texto.replace(/\{nombre\}/gi, "");
          }

          await _sendpulseSms(token, telefono, texto, sender || "N10ERP");
          enviados++;
        } catch (e) {
          logger.warn(`[SMS] Error enviando a ${telefono}: ${e.message}`);
          errores++;
        }
      }

      await campanaRef.update({ status: "COMPLETADO", enviados, errores, timestamp: FieldValue.serverTimestamp() });
      logger.info(`[onSmsCampanaCreada] Completado: ${enviados} enviados, ${errores} errores`);
    } catch (e) {
      logger.error(`[onSmsCampanaCreada] Error general: ${e.message}`);
      await campanaRef.update({ status: "ERROR", errorMsg: e.message });
    }
  }
);

/** Obtiene Bearer token de SendPulse vía OAuth2 */
function _sendpulseToken(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    const req  = https.request({
      hostname: "api.sendpulse.com",
      path:     "/oauth/access_token",
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => {
        try { const j = JSON.parse(data); j.access_token ? resolve(j.access_token) : reject(new Error(j.message || "token error")); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Envía un SMS vía SendPulse */
function _sendpulseSms(token, phone, text, senderId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sender: senderId, body: text, phones: [`52${phone}`] });
    const req  = https.request({
      hostname: "api.sendpulse.com",
      path:     "/sms/send",
      method:   "POST",
      headers:  { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => {
        res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
// CF: onGastoCreado
//    Trigger: gastos_empleado/{gastoId} created
//    Notifica a MESA_CONTROL cuando un empleado registra un gasto.
//    Notifica al empleado cuando su gasto es aprobado o rechazado.
// ═══════════════════════════════════════════════════════════════
exports.onGastoCreado = onDocumentCreated(
  { document: "gastos_empleado/{gastoId}", region: "us-central1" },
  async (event) => {
    const gasto = event.data?.data();
    if (!gasto) return;

    const { alias, categoria, monto, uid } = gasto;
    const cat = { GASOLINA:"⛽", ALIMENTACION:"🍽️", HOSPEDAJE:"🏨", TRANSPORTE:"🚌", COMUNICACION:"📱", OTRO:"📎" }[categoria] || "📎";
    const montoFmt = `$${(monto || 0).toLocaleString("es-MX", { minimumFractionDigits:2 })}`;

    // Obtener uids de MESA_CONTROL y GERENTE para notificar
    const rolesSnap = await db.collection("usuarios")
      .where("rol", "in", ["MESA_CONTROL", "GERENTE"])
      .get();
    const destinatarios = rolesSnap.docs.map(d => d.id);

    if (destinatarios.length > 0) {
      await db.collection("notificaciones_web").add({
        tipo:           "GASTO_SOLICITADO",
        mensaje:        `${alias} solicitó reembolso ${cat} por ${montoFmt}`,
        destinatarios,
        leido:          false,
        _ts:            Date.now(),
        timestamp:      admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// CF: onGastoActualizado
//    Trigger: gastos_empleado/{gastoId} updated → status cambia
//    Notifica al empleado si fue aprobado o rechazado.
// ═══════════════════════════════════════════════════════════════
exports.onGastoActualizado = onDocumentUpdated(
  { document: "gastos_empleado/{gastoId}", region: "us-central1" },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (!before || !after) return;
    if (before.status === after.status) return; // no cambió

    const { uid, alias, categoria, monto, comentario, status } = after;
    if (status !== "APROBADO" && status !== "RECHAZADO") return;

    const cat = { GASOLINA:"⛽", ALIMENTACION:"🍽️", HOSPEDAJE:"🏨", TRANSPORTE:"🚌", COMUNICACION:"📱", OTRO:"📎" }[categoria] || "📎";
    const montoFmt = `$${(monto || 0).toLocaleString("es-MX", { minimumFractionDigits:2 })}`;
    const tipo    = status === "APROBADO" ? "GASTO_APROBADO" : "GASTO_RECHAZADO";
    const emoji   = status === "APROBADO" ? "✅" : "❌";
    let msg       = `${emoji} Tu gasto ${cat} de ${montoFmt} fue ${status === "APROBADO" ? "aprobado" : "rechazado"}`;
    if (comentario) msg += `. Comentario: ${comentario}`;

    await db.collection("notificaciones_web").add({
      tipo,
      mensaje:        msg,
      destinatarios:  [uid],
      leido:          false,
      _ts:            Date.now(),
      timestamp:      admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);

function _tituloFCM(tipo) {
  const MAP = {
    STOCK_BAJO:           "⚠️ Stock bajo",
    STOCK_CRITICO:        "🔴 Stock crítico",
    CARTERA:              "💰 Alerta de cartera",
    ABONO:                "✅ Abono registrado",
    COTIZACION:           "📋 Cotización",
    COTIZACION_NUEVA:     "📋 Nueva cotización",
    DEVOLUCION:           "↩️ Devolución procesada",
    DEVOLUCION_APROBADA:  "↩️ Devolución aprobada",
    SOLICITUD_VISITA:     "📍 Solicitud de visita",
    COBRANZA:             "💳 Cobranza",
    ALERTA_COBRANZA:      "💳 Alerta de cobranza",
    PEDIDO_STATUS:        "📦 Estado de pedido",
    VACACION_APROBADA:    "✅ Vacaciones aprobadas",
    VACACION_RECHAZADA:   "❌ Vacaciones rechazadas",
    ANTICIPO_APROBADO:    "✅ Anticipo aprobado",
    ANTICIPO_RECHAZADO:   "❌ Anticipo rechazado",
    ANTICIPO_DESCONTADO:  "💰 Anticipo descontado",
    NOMINA_PAGADA:        "💼 Pago de nómina registrado",
    CLIENTE_BLOQUEADO:    "🔒 Cliente bloqueado",
    CLIENTE_DESBLOQUEADO: "✅ Cliente desbloqueado",
    SEMAFORO_ROJO:          "🔴 Semáforo rojo",
    FORMULARIO_RESPONDIDO:  "📋 Formulario respondido",
    RECORDATORIO_META:      "🎯 Avance de tu meta",
    REPORTE_SEMANAL:        "📊 Reporte semanal",
    COMISION_LIQUIDADA:     "💰 Tu comisión está lista",
    REPORTE_COMISIONES:     "📊 Comisiones del mes",
    GASTO_SOLICITADO:       "💸 Nuevo gasto para aprobar",
    GASTO_APROBADO:         "✅ Gasto aprobado",
    GASTO_RECHAZADO:        "❌ Gasto rechazado",
    CORTE_CAJA:             "🏦 Corte de caja recibido",
  };
  return MAP[tipo] || "🔔 N-10 ERP";
}

// ═══════════════════════════════════════════════════════════════
// INTERESES — Motor de cálculo (replica de intereses-engine.js)
// ═══════════════════════════════════════════════════════════════

const MS_DIA              = 86_400_000;
const TASA_SEMANAL_DEF    = 0.01;
const DIAS_GRACIA_DEF     = 14;
const STATUS_UMBRALES     = [
  { max: -61, status: "CRÍTICO"    },
  { max: -43, status: "GRAVE"      },
  { max: -29, status: "MODERADO"   },
  { max: -15, status: "LEVE"       },
  { max:  14, status: "POR_VENCER" },
];

function _calcularRemision(r, hoy = new Date()) {
  const creacion    = r.fechaCreacion instanceof FSTimestamp
    ? r.fechaCreacion.toDate() : new Date(r.fechaCreacion);
  const vencimiento = r.fechaVencimiento instanceof FSTimestamp
    ? r.fechaVencimiento.toDate() : new Date(r.fechaVencimiento);
  const diasGracia  = r.diasGracia  ?? DIAS_GRACIA_DEF;
  const tasaDiaria  = r.tasaDiaria  ?? (TASA_SEMANAL_DEF / 7);

  const diasTranscurridos = Math.floor((hoy - creacion)    / MS_DIA);
  const diasAtraso        = Math.floor((vencimiento - hoy) / MS_DIA);
  const totalAbonado      = r.totalAbonado ?? 0;
  const saldoCapital      = Math.max(0, r.montoOriginal - totalAbonado);

  const interesActivo = r.status !== "PAGADO"
    && diasTranscurridos > diasGracia && saldoCapital > 0;

  const interesGenerado = interesActivo
    ? Math.round(diasTranscurridos * tasaDiaria * r.montoOriginal * 100) / 100 : 0;
  const totalDeuda    = r.montoOriginal + interesGenerado;
  const deudaRestante = Math.max(0, totalDeuda - totalAbonado);
  const interesPorDia = interesActivo
    ? Math.round(tasaDiaria * r.montoOriginal * 100) / 100 : 0;

  let status = "FUTURA";
  if (r.status === "PAGADO") {
    status = "PAGADO";
  } else {
    for (const u of STATUS_UMBRALES) {
      if (diasAtraso <= u.max) { status = u.status; break; }
    }
  }

  return { diasTranscurridos, diasAtraso, saldoCapital, interesActivo,
           interesGenerado, interesPorDia, totalDeuda, deudaRestante, status };
}

// ── Semáforo de cliente ──────────────────────────────────────
function _semaforoCliente(diasMaxAtraso) {
  if (diasMaxAtraso <= 0)  return "VERDE";
  if (diasMaxAtraso <= 14) return "POR_VENCER";
  if (diasMaxAtraso <= 28) return "LEVE";
  if (diasMaxAtraso <= 42) return "MODERADO";
  if (diasMaxAtraso <= 60) return "GRAVE";
  return "CRÍTICO";
}

// ═══════════════════════════════════════════════════════════════
// F1. onRemisionCreada — Congela tasaDiaria al crear una nota
//     Trigger: remisiones_credito/{id} onCreate
//     Propósito: El APK crea la nota sin tasaDiaria; esta función
//     la lee de config_intereses/default y la estampa en el doc.
// ═══════════════════════════════════════════════════════════════
exports.onRemisionCreada = onDocumentCreated(
  { document: "remisiones_credito/{remisionId}", region: "us-central1" },
  async (event) => {
    const data = event.data.data();
    const id   = event.params.remisionId;

    // Si ya tiene tasaDiaria (fue creada desde web con tasa pre-cargada), no tocar
    if (data.tasaDiaria != null) {
      logger.info(`[onRemisionCreada] ${id} ya tiene tasaDiaria=${data.tasaDiaria} — sin cambios`);
      return;
    }

    // Leer configuración global
    let tasaSemanal = TASA_SEMANAL_DEF;
    let diasGracia  = DIAS_GRACIA_DEF;
    try {
      const cfgSnap = await db.doc("config_intereses/default").get();
      if (cfgSnap.exists) {
        tasaSemanal = cfgSnap.data().tasaSemanal ?? TASA_SEMANAL_DEF;
        diasGracia  = cfgSnap.data().diasGracia  ?? DIAS_GRACIA_DEF;
      }
    } catch(e) {
      logger.warn(`[onRemisionCreada] No se pudo leer config_intereses: ${e.message} — usando defaults`);
    }

    const tasaDiaria = tasaSemanal / 7;

    await db.doc(`remisiones_credito/${id}`).update({
      tasaDiaria,
      diasGracia,
      tasaCongeladaEn: FieldValue.serverTimestamp(),
    });

    logger.info(`[onRemisionCreada] ${id} — tasaDiaria=${tasaDiaria.toFixed(8)} diasGracia=${diasGracia} congelados`);
  }
);

// ═══════════════════════════════════════════════════════════════
// F2. actualizarCartera — Recalcula todos los campos derivados
//     Schedule: todos los días a las 02:00 AM México (UTC-6 = 08:00 UTC)
//     Propósito:
//       - El APK lee directamente los campos calculados del doc
//         (interesGenerado, deudaRestante, status, diasAtraso, etc.)
//       - También actualiza saldos agregados en /clientes/{clienteId}
// ═══════════════════════════════════════════════════════════════
exports.actualizarCartera = onSchedule(
  { schedule: "0 8 * * *", timeZone: "America/Mexico_City", region: "us-central1" },
  async () => {
    const hoy = new Date();
    logger.info(`[actualizarCartera] Iniciando recalculo — ${hoy.toISOString()}`);

    // Leer todas las notas activas (no PAGADO/FUTURA)
    const snap = await db.collection("remisiones_credito")
      .where("status", "!=", "PAGADO")
      .get();

    if (snap.empty) {
      logger.info("[actualizarCartera] Sin notas activas — nada que recalcular");
      return;
    }

    const batch      = db.batch();
    const porCliente = {}; // clienteId → { capital, interes, total, diasMaxAtraso }
    let   actualizadas = 0;

    for (const docSnap of snap.docs) {
      const r    = docSnap.data();
      const calc = _calcularRemision(r, hoy);

      batch.update(docSnap.ref, {
        // Campos calculados para que el APK los lea sin lógica extra
        _interesGenerado:    calc.interesGenerado,
        _deudaRestante:      calc.deudaRestante,
        _saldoCapital:       calc.saldoCapital,
        _interesPorDia:      calc.interesPorDia,
        _diasTranscurridos:  calc.diasTranscurridos,
        _diasAtraso:         calc.diasAtraso,
        _totalDeuda:         calc.totalDeuda,
        status:              calc.status,
        _ultimoCalculo:      FieldValue.serverTimestamp(),
      });
      actualizadas++;

      // Acumular por cliente
      if (r.clienteId && calc.status !== "PAGADO") {
        const c = porCliente[r.clienteId] ?? { capital: 0, interes: 0, total: 0, diasMaxAtraso: 0 };
        c.capital         += calc.saldoCapital;
        c.interes         += calc.interesGenerado;
        c.total           += calc.deudaRestante;
        c.diasMaxAtraso    = Math.max(c.diasMaxAtraso, Math.abs(Math.min(0, calc.diasAtraso)));
        porCliente[r.clienteId] = c;
      }
    }

    await batch.commit();
    logger.info(`[actualizarCartera] ${actualizadas} notas recalculadas`);

    // Actualizar saldos agregados en /clientes
    const batchC = db.batch();
    for (const [clienteId, agg] of Object.entries(porCliente)) {
      const ref = db.doc(`clientes/${clienteId}`);
      batchC.update(ref, {
        saldoCapitalTotal:  agg.capital,
        interesTotal:       agg.interes,
        totalAPagarTotal:   agg.total,
        diasMaxAtraso:      agg.diasMaxAtraso,
        semaforoColor:      _semaforoCliente(agg.diasMaxAtraso),
        _carteraActualizada: FieldValue.serverTimestamp(),
      });
    }
    await batchC.commit();
    logger.info(`[actualizarCartera] ${Object.keys(porCliente).length} clientes actualizados`);
  }
);

// ═══════════════════════════════════════════════════════════════
// SPRINT-B. NOTIFICACIONES DE VENCIMIENTO DE INTERESES
//           Cron 09:30 Mazatlán — detecta notas con exactamente
//           15, 29 o 43 días de mora y genera notif + FCM
// ═══════════════════════════════════════════════════════════════
exports.notificarVencimientosIntereses = onSchedule(
  { schedule: "30 15 * * *", timeZone: "America/Mazatlan", region: "us-central1" },
  async () => {
    const HITOS = [15, 29, 43]; // días exactos que disparan alerta
    const ahora = Date.now();
    const hoy   = new Date(ahora);
    hoy.setHours(0, 0, 0, 0);
    const manana = new Date(hoy.getTime() + 86_400_000);

    const snap = await db.collection("remisiones_credito")
      .where("status", "not-in", ["PAGADO"])
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    let creadas = 0;

    for (const d of snap.docs) {
      const r  = d.data();
      const fv = r.fechaVencimiento?.toMillis?.() || Number(r.fechaVencimiento) || 0;
      if (!fv) continue;

      const diasMora = Math.floor((ahora - fv) / 86_400_000);
      if (!HITOS.includes(diasMora)) continue;

      // Evitar duplicar en el mismo día
      const dupQ = await db.collection("notificaciones_web")
        .where("tipo", "==", "VENCIMIENTO_INTERESES")
        .where("refId", "==", d.id)
        .where("_ts", ">=", hoy.getTime())
        .where("_ts", "<",  manana.getTime())
        .limit(1).get();
      if (!dupQ.empty) continue;

      const montoOrig  = r.montoOriginal || 0;
      const tasaDiaria = r.tasaDiaria ?? (0.01 / 7);
      const diasTotal  = Math.floor((ahora - (r.fechaCreacion?.toMillis?.() || Number(r.fechaCreacion))) / 86_400_000);
      const interes    = diasTotal > (r.diasGracia ?? 14)
        ? Math.round(diasTotal * tasaDiaria * montoOrig * 100) / 100 : 0;

      const saldo   = montoOrig - (r.totalAbonado || 0);
      const fmtMXN  = n => n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
      const cliente = r.clienteNombre || "–";
      const folio   = r.folio || d.id;

      const EMOJIS = { 15: "⚠️", 29: "🟠", 43: "🔴" };
      const mensaje = `${EMOJIS[diasMora] || "🔴"} ${cliente} · ${folio} · ${diasMora} días de mora · Capital ${fmtMXN(saldo)} + Interés ${fmtMXN(interes)} = ${fmtMXN(saldo + interes)}`;

      // Destinatarios: ingeniero de la nota + GERENTE
      const destinatarios = [];
      if (r.ingenieroId)   destinatarios.push(r.ingenieroId);
      if (r.ingenieroUid)  destinatarios.push(r.ingenieroUid);
      try {
        const gSnap = await db.collection("usuarios")
          .where("rol", "in", ["GERENTE","SUPER_ADMIN"])
          .where("activo", "==", true)
          .get();
        gSnap.docs.forEach(u => { if (!destinatarios.includes(u.id)) destinatarios.push(u.id); });
      } catch (_) {}

      const notifRef = db.collection("notificaciones_web").doc();
      batch.set(notifRef, {
        tipo:           "VENCIMIENTO_INTERESES",
        subtipo:        `DIA_${diasMora}`,
        mensaje,
        refId:          d.id,
        folio,
        clienteNombre:  cliente,
        diasMora,
        saldo,
        interes,
        destinatarios:  destinatarios.length > 0 ? destinatarios : ["TODOS"],
        accion:         { vista: "remisiones" },
        leida:          false,
        timestamp:      FieldValue.serverTimestamp(),
        _ts:            ahora,
        creadaPor:      "SISTEMA",
      });
      creadas++;
    }

    if (creadas > 0) {
      await batch.commit();
      logger.info(`[notificarVencimientosIntereses] ${creadas} alertas de hito creadas`);
    } else {
      logger.info("[notificarVencimientosIntereses] Sin hitos hoy");
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// ABONO APK → CONCILIACIÓN AUTOMÁTICA EN remisiones_credito
//
// Cuando el APK registra un abono en la colección `abonos`,
// este trigger actualiza montoAbonado en la remisión correspondiente
// y registra el evento en audit_log para trazabilidad completa.
// ═══════════════════════════════════════════════════════════════
exports.onAbonoCreado = onDocumentCreated(
  { document: "abonos/{abonoId}", region: "us-central1" },
  async (event) => {
    const data    = event.data.data();
    const abonoId = event.params.abonoId;

    const remisionId   = data.remisionId;
    const monto        = Number(data.monto) || 0;
    const clienteId    = data.clienteId    || null;
    const quien        = data.quienRegistro || data.alias || "APK";
    const timestamp    = data.timestamp    || Date.now();
    const metodoPago   = data.metodoPago   || "";
    const numeroRecibo = data.numeroRecibo || "";

    if (!remisionId || monto <= 0) {
      logger.warn(`[onAbonoCreado] Abono ${abonoId} inválido — remisionId=${remisionId} monto=${monto}`);
      return;
    }

    logger.info(`[onAbonoCreado] Conciliando abono ${abonoId} → remisión ${remisionId} monto=${monto}`);

    try {
      // Buscar la remisión por número o por id
      let remRef = null;
      const snapPorNumero = await db.collection("remisiones_credito")
        .where("remisionNumero", "==", remisionId)
        .limit(1)
        .get();

      if (!snapPorNumero.empty) {
        remRef = snapPorNumero.docs[0].ref;
      } else {
        // Intentar por doc id directamente
        const directRef = db.collection("remisiones_credito").doc(remisionId);
        const directSnap = await directRef.get();
        if (directSnap.exists) remRef = directRef;
      }

      if (!remRef) {
        logger.warn(`[onAbonoCreado] Remisión ${remisionId} no encontrada en Firestore`);
        return;
      }

      const batch = db.batch();
      const ahora = Date.now();

      // Incrementar montoAbonado en la remisión
      batch.update(remRef, {
        montoAbonado:     FieldValue.increment(monto),
        ultimoAbonoTs:    ahora,
        ultimoAbonoMonto: monto,
        _ts:              ahora,
      });

      // Registrar en audit_log para trazabilidad
      const auditRef = db.collection("audit_log").doc();
      batch.set(auditRef, {
        tipo:          "ABONO_CONCILIADO",
        usuario:       quien,
        descripcion:   `Abono de ${new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(monto)} conciliado desde APK`,
        referencia:    remisionId,
        monto:         monto,
        clienteId:     clienteId,
        metodoPago:    metodoPago,
        numeroRecibo:  numeroRecibo,
        abonoId:       abonoId,
        fuente:        "APK",
        leido:         false,
        _ts:           ahora,
        timestamp:     FieldValue.serverTimestamp(),
      });

      await batch.commit();
      logger.info(`[onAbonoCreado] Abono ${abonoId} conciliado — remisión ${remisionId} += ${monto}`);
    } catch (err) {
      logger.error(`[onAbonoCreado] Error:`, err);
      throw err;
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// PEDIDO AUTORIZADO / RECHAZADO → FCM al vendedor en campo
//
// Cuando el panel web cambia el status de un pedido de
// PENDIENTE_AUTORIZACION a AUTORIZADO o RECHAZADO,
// este trigger envía una notificación push al APK del vendedor.
// ═══════════════════════════════════════════════════════════════
exports.onPedidoDecision = onDocumentUpdated(
  { document: "pedidos/{pedidoId}", region: "us-central1" },
  async (event) => {
    const antes   = event.data.before.data();
    const despues = event.data.after.data();
    const pedidoId = event.params.pedidoId;

    const statusAntes  = antes.status  || "";
    const statusDespues = despues.status || "";

    if (statusAntes !== "PENDIENTE_AUTORIZACION") return;
    if (statusDespues !== "AUTORIZADO" && statusDespues !== "RECHAZADO") return;

    const alias  = despues.ingenieroAlias || despues.vendedorAlias || "";
    const folio  = despues.folio          || pedidoId;
    const total  = despues.total          || 0;
    const fmtTotal = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(total);

    logger.info(`[onPedidoDecision] Pedido ${folio} → ${statusDespues} para alias=${alias}`);

    if (!alias) {
      logger.warn(`[onPedidoDecision] Sin alias — no se puede enviar FCM`);
      return;
    }

    try {
      // Buscar FCM token del vendedor
      const usuariosSnap = await db.collection("usuarios")
        .where("alias", "==", alias)
        .limit(1)
        .get();

      if (usuariosSnap.empty) {
        logger.warn(`[onPedidoDecision] Usuario alias=${alias} no encontrado`);
        return;
      }

      const fcmToken = usuariosSnap.docs[0].data().fcmToken || "";
      if (!fcmToken) {
        logger.warn(`[onPedidoDecision] Sin fcmToken para alias=${alias}`);
        return;
      }

      const esAutorizado = statusDespues === "AUTORIZADO";
      const titulo = esAutorizado ? "✅ Pedido autorizado" : "❌ Pedido rechazado";
      const cuerpo = esAutorizado
        ? `Pedido ${folio} (${fmtTotal}) fue autorizado. Ya puedes proceder con la entrega.`
        : `Pedido ${folio} fue rechazado. Motivo: ${despues.motivoRechazo || "Sin detalle"}`;

      await getMessaging().send({
        token: fcmToken,
        notification: { title: titulo, body: cuerpo },
        data: {
          tipo:     "PEDIDO_DECISION",
          folio:    folio,
          status:   statusDespues,
          pedidoId: pedidoId,
          vista:    "mis_pedidos",
        },
        android: {
          priority: "high",
          notification: { channelId: "alertas_operativas" },
        },
      });

      logger.info(`[onPedidoDecision] FCM enviado a ${alias} — pedido ${folio} ${statusDespues}`);

      // Crear también notificación web para el feed
      await db.collection("notificaciones_web").add({
        tipo:        esAutorizado ? "DESCUENTO_APROBADO" : "PEDIDO_CANCELADO",
        usuario:     despues.autorizadoPor || despues.rechazadoPor || "PANEL",
        descripcion: cuerpo,
        referencia:  folio,
        monto:       total,
        leida:       false,
        _ts:         Date.now(),
        timestamp:   FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.error(`[onPedidoDecision] Error enviando FCM:`, err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// CAMPAÑA ACTIVADA → FCM broadcast a vendedores en campo
//
// Cuando una campaña pasa a activa=true en campanas_promociones,
// notifica a todos los vendedores (INGENIERO / RECUPERADOR) para
// que su APK la descargue en el próximo ciclo de SyncWorker.
// ═══════════════════════════════════════════════════════════════
exports.onCampanaActivada = onDocumentUpdated(
  { document: "campanas_promociones/{campanaId}", region: "us-central1" },
  async (event) => {
    const antes   = event.data.before.data();
    const despues = event.data.after.data();
    const campanaId = event.params.campanaId;

    // Solo actuar cuando pasa de inactiva a activa
    if (antes.activa === true || despues.activa !== true) return;

    const nombre = despues.nombre || campanaId;
    const fechaFin = despues.fechaFin
      ? new Date(despues.fechaFin).toLocaleDateString("es-MX")
      : "–";

    logger.info(`[onCampanaActivada] Campaña "${nombre}" activada — buscando vendedores`);

    try {
      // Obtener tokens FCM de todos los vendedores activos
      const usuariosSnap = await db.collection("usuarios")
        .where("activo", "==", true)
        .where("rol", "in", ["INGENIERO", "RECUPERADOR"])
        .get();

      const tokens = usuariosSnap.docs
        .map(d => d.data().fcmToken)
        .filter(t => !!t);

      if (tokens.length === 0) {
        logger.info(`[onCampanaActivada] Sin tokens FCM disponibles`);
        return;
      }

      // Enviar multicast (máx 500 tokens por llamada)
      const chunks = [];
      for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

      for (const chunk of chunks) {
        await getMessaging().sendEachForMulticast({
          tokens: chunk,
          notification: {
            title: "🎁 Nueva campaña activa",
            body:  `"${nombre}" — válida hasta ${fechaFin}`,
          },
          data: {
            tipo:      "CAMPANA_NUEVA",
            campanaId: campanaId,
            nombre:    nombre,
            vista:     "campanas",
          },
          android: {
            priority: "normal",
            notification: { channelId: "alertas_operativas" },
          },
        });
      }

      logger.info(`[onCampanaActivada] FCM enviado a ${tokens.length} vendedores`);

      // Notificación web para el feed del panel
      await db.collection("notificaciones_web").add({
        tipo:        "CAMPANA_ACTIVADA",
        usuario:     "SISTEMA",
        descripcion: `Campaña "${nombre}" activada — vigente hasta ${fechaFin}`,
        referencia:  campanaId,
        leida:       false,
        _ts:         Date.now(),
        timestamp:   FieldValue.serverTimestamp(),
      });
    } catch (err) {
      logger.error(`[onCampanaActivada] Error:`, err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// AUTH-1. CREAR FIREBASE AUTH + RE-KEYED FIRESTORE DOC
//   Trigger: usuarios/{docId} created
//   Problema: el panel crea usuarios con docId = alias (ej. "Sismastecnicoseis"),
//   pero las Firestore rules hacen get(/usuarios/{request.auth.uid}).
//   Esta función detecta cuando el docId no es un UID de Firebase (28 chars
//   alfanumérico), crea la cuenta Auth, y mueve el documento a usuarios/{uid}.
// ═══════════════════════════════════════════════════════════════
exports.crearUsuarioConAuth = onDocumentCreated(
  { document: "usuarios/{docId}", region: "us-central1" },
  async (event) => {
    const docId = event.params.docId;
    const data  = event.data.data();

    // Si el docId ya parece un UID de Firebase (≥28 chars, solo alfanumérico)
    // es porque ya está bien keyed — no hacer nada.
    const yaEsUid = /^[A-Za-z0-9]{28,}$/.test(docId);
    if (yaEsUid) {
      logger.info(`[crearUsuarioConAuth] ${docId} ya parece UID — omitido`);
      return;
    }

    const correo = data.correo || data.email || null;
    if (!correo) {
      logger.warn(`[crearUsuarioConAuth] Doc ${docId} sin correo — omitido`);
      return;
    }

    logger.info(`[crearUsuarioConAuth] Procesando alias="${docId}" correo="${correo}"`);

    try {
      // 1. Buscar o crear cuenta Firebase Auth
      let uid;
      try {
        const existing = await getAuth().getUserByEmail(correo);
        uid = existing.uid;
        logger.info(`[crearUsuarioConAuth] Auth ya existe uid=${uid}`);
      } catch (notFound) {
        // Crear nueva cuenta sin contraseña (acceso por password-reset)
        const created = await getAuth().createUser({
          email:       correo,
          displayName: data.nombre || docId,
          disabled:    false,
        });
        uid = created.uid;
        logger.info(`[crearUsuarioConAuth] Auth creada uid=${uid}`);
      }

      // 2. Verificar que no exista ya usuarios/{uid} (evitar sobreescribir)
      const uidRef = db.collection("usuarios").doc(uid);
      const uidSnap = await uidRef.get();
      if (!uidSnap.exists) {
        // 3. Crear usuarios/{uid} con todos los campos + alias + uid
        await uidRef.set({
          ...data,
          alias: data.alias || docId,
          uid,
          _migradoDesde: docId,
          _migradoEn:    FieldValue.serverTimestamp(),
        });
        logger.info(`[crearUsuarioConAuth] usuarios/${uid} creado`);
      } else {
        logger.info(`[crearUsuarioConAuth] usuarios/${uid} ya existe — no sobreescribe`);
      }

      // 4. Eliminar el documento original keyed por alias
      await db.collection("usuarios").doc(docId).delete();
      logger.info(`[crearUsuarioConAuth] usuarios/${docId} eliminado`);

      // 5. Enviar email de bienvenida/reset de contraseña
      try {
        const resetLink = await getAuth().generatePasswordResetLink(correo);
        logger.info(`[crearUsuarioConAuth] Reset link generado para ${correo}: ${resetLink}`);
        // Nota: para enviar el email hay que usar un servicio de correo externo
        // (SendGrid, Nodemailer, etc.) o usar Firebase Auth triggers de email.
        // Por ahora registramos el link en Firestore para que el admin lo copie.
        await db.collection("_pendientes_bienvenida").add({
          uid,
          correo,
          resetLink,
          alias:     data.alias || docId,
          nombre:    data.nombre || docId,
          timestamp: FieldValue.serverTimestamp(),
        });
      } catch (emailErr) {
        logger.warn(`[crearUsuarioConAuth] No se pudo generar reset link:`, emailErr.message);
      }

    } catch (err) {
      logger.error(`[crearUsuarioConAuth] Error procesando ${docId}:`, err);
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// AUTH-2. SINCRONIZAR CAMBIOS DE NOMBRE/CORREO AL USUARIO AUTH
//   Trigger: usuarios/{docId} updated
//   Si el docId ya es un UID, actualiza Firebase Auth con los nuevos datos.
// ═══════════════════════════════════════════════════════════════
exports.actualizarUsuarioAuth = onDocumentUpdated(
  { document: "usuarios/{docId}", region: "us-central1" },
  async (event) => {
    const docId  = event.params.docId;
    const antes  = event.data.before.data();
    const despues = event.data.after.data();

    // Solo actuar si el docId es un UID de Firebase
    const esUid = /^[A-Za-z0-9]{28,}$/.test(docId);
    if (!esUid) return;

    const cambioNombre = antes.nombre  !== despues.nombre;
    const cambioActivo = antes.activo  !== despues.activo;
    if (!cambioNombre && !cambioActivo) return;

    try {
      const updates = {};
      if (cambioNombre) updates.displayName = despues.nombre || docId;
      if (cambioActivo) updates.disabled    = despues.activo === false;

      await getAuth().updateUser(docId, updates);
      logger.info(`[actualizarUsuarioAuth] uid=${docId} actualizado`, updates);
    } catch (err) {
      logger.error(`[actualizarUsuarioAuth] Error uid=${docId}:`, err.message);
    }
  }
);
