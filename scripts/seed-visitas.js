const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const sa = require("C:/Users/sisma/Documents/N10-Dashboard/sa.json");

initializeApp({ credential: cert(sa) });
const db = getFirestore();

const visitas = [
  { alias:"sismastecnicoseis", cliente:"Agropecuaria Sánchez",  clienteId:101, tipo:"SEGUIMIENTO", dist:45,   sosp:false, ts: new Date("2026-09-02T09:15:00") },
  { alias:"sismastecnicoseis", cliente:"Grupo Agro Del Norte",  clienteId:102, tipo:"PROSPECCIÓN", dist:12,   sosp:false, ts: new Date("2026-09-03T11:30:00") },
  { alias:"sismastecnicoseis", cliente:"Finca La Esperanza",    clienteId:103, tipo:"COBRANZA",    dist:890,  sosp:true,  ts: new Date("2026-09-05T14:00:00") },
  { alias:"sismastecnicoseis", cliente:"Rancho El Roble",       clienteId:104, tipo:"SEGUIMIENTO", dist:78,   sosp:false, ts: new Date("2026-09-08T10:00:00") },
  { alias:"sismastecnicoseis", cliente:"Agropecuaria Sánchez",  clienteId:101, tipo:"VENTA",       dist:33,   sosp:false, ts: new Date("2026-09-10T09:45:00") },
  { alias:"mayra.rosas",       cliente:"Campo Verde SA",        clienteId:201, tipo:"PROSPECCIÓN", dist:55,   sosp:false, ts: new Date("2026-09-01T08:30:00") },
  { alias:"mayra.rosas",       cliente:"Finca El Cedro",        clienteId:202, tipo:"SEGUIMIENTO", dist:102,  sosp:false, ts: new Date("2026-09-04T13:00:00") },
  { alias:"mayra.rosas",       cliente:"Agro Sur",              clienteId:203, tipo:"COBRANZA",    dist:18,   sosp:false, ts: new Date("2026-09-09T11:15:00") },
  { alias:"mayra.rosas",       cliente:"Grupo Agro Del Norte",  clienteId:102, tipo:"VENTA",       dist:3450, sosp:true,  ts: new Date("2026-09-11T15:00:00") },
];

async function main() {
  const batch = db.batch();
  for (const v of visitas) {
    const docId = `${v.alias}_${v.ts.getTime()}_TEST`;
    const ref = db.collection("visitas").doc(docId);
    batch.set(ref, {
      clienteId:        v.clienteId,
      clienteNombre:    v.cliente,
      aliasVendedor:    v.alias,
      ingeniero:        v.alias,
      tipo:             v.tipo,
      nota:             "",
      distanciaMetros:  v.dist,
      latVisita:        18.333,
      lonVisita:        -99.556,
      timestamp:        Timestamp.fromDate(v.ts),
      fecha:            Timestamp.fromDate(v.ts),
      estadoVisita:     "COMPLETADA",
      fueraDeGeocerca:  v.sosp,
      geocercaViolada:  v.sosp,
      flagSospechosa:   v.sosp,
      pasoEvaluacionOk: !v.sosp,
      _origen:          "test",
    });
  }
  await batch.commit();
  console.log(`✓ ${visitas.length} visitas de prueba insertadas`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
