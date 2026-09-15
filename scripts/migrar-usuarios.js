/**
 * Script de migración de usuarios
 * Normaliza todos los documentos en usuarios/ para que:
 *   1. docId = Firebase Auth UID (detecta y migra alias-keyed si quedan)
 *   2. Campos correo + email sean consistentes
 *   3. activo = true si no está definido (evita que la regla falle)
 *   4. uid = docId explícito
 *
 * Uso: node scripts/migrar-usuarios.js [--dry-run]
 */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const sa = require("../sa.json");

const DRY_RUN = process.argv.includes("--dry-run");

initializeApp({ credential: cert(sa) });
const db   = getFirestore();
const auth = getAuth();

// Un UID de Firebase tiene entre 28 y 36 chars, solo alfanuméricos
const esUID = (id) => /^[A-Za-z0-9]{20,}$/.test(id);

async function main() {
  console.log(`\n🔍 Leyendo colección usuarios/ ...`);
  if (DRY_RUN) console.log("   [DRY-RUN — no se escribe nada]\n");

  const snap = await db.collection("usuarios").get();
  console.log(`   ${snap.size} documentos encontrados\n`);

  const resultados = { ok: 0, migrados: 0, normalizados: 0, sinCorreo: 0, errores: 0 };

  for (const doc of snap.docs) {
    const docId = doc.id;
    const data  = doc.data();

    console.log(`── ${docId.substring(0, 10)}... | alias: ${data.alias || "(sin alias)"} | rol: ${data.rol || "?"}`);

    // ── CASO 1: docId es alias (no UID) → migrar ────────────────
    if (!esUID(docId)) {
      console.log(`   ⚠️  docId no es UID — migrando...`);

      const correo = data.correo || data.email || null;
      if (!correo) {
        console.log(`   ❌ Sin correo — no se puede migrar`);
        resultados.sinCorreo++;
        continue;
      }

      let uid;
      try {
        const u = await auth.getUserByEmail(correo);
        uid = u.uid;
        console.log(`   👤 Auth encontrada: uid=${uid}`);
      } catch (_) {
        try {
          const u = await auth.createUser({
            email:       correo,
            displayName: data.nombre || data.alias || docId,
            disabled:    false,
          });
          uid = u.uid;
          console.log(`   ✅ Auth creada: uid=${uid}`);
        } catch (err) {
          console.log(`   ❌ Error creando Auth: ${err.message}`);
          resultados.errores++;
          continue;
        }
      }

      const newRef = db.collection("usuarios").doc(uid);
      const newSnap = await newRef.get();

      if (!DRY_RUN) {
        if (!newSnap.exists) {
          await newRef.set({
            ...data,
            uid,
            email:  correo,
            correo: correo,
            activo: data.activo !== undefined ? data.activo : true,
            _migradoDesde: docId,
            _migradoEn:    FieldValue.serverTimestamp(),
          });
          console.log(`   ✅ usuarios/${uid} creado`);
        } else {
          console.log(`   ℹ️  usuarios/${uid} ya existe — no sobreescribe`);
        }
        await db.collection("usuarios").doc(docId).delete();
        console.log(`   🗑️  usuarios/${docId} eliminado`);
      } else {
        console.log(`   [DRY] crearía usuarios/${uid}, eliminaría usuarios/${docId}`);
      }

      resultados.migrados++;
      continue;
    }

    // ── CASO 2: docId ya es UID → normalizar campos ──────────────
    const updates = {};

    // Normalizar correo/email
    const emailVal  = data.email  || null;
    const correoVal = data.correo || null;
    const correoFinal = correoVal || emailVal;

    if (!correoFinal) {
      // Intentar obtener email de Firebase Auth
      try {
        const u = await auth.getUser(docId);
        if (u.email) {
          updates.email  = u.email;
          updates.correo = u.email;
          console.log(`   📧 Email obtenido de Auth: ${u.email}`);
        }
      } catch (_) {}
    } else {
      if (!emailVal)  updates.email  = correoFinal;
      if (!correoVal) updates.correo = correoFinal;
    }

    // Asegurar uid explícito
    if (!data.uid) updates.uid = docId;

    // Asegurar activo definido
    if (data.activo === undefined || data.activo === null) {
      updates.activo = true;
      console.log(`   ⚠️  activo no definido → se pondrá true`);
    }

    if (Object.keys(updates).length === 0) {
      console.log(`   ✅ OK — sin cambios`);
      resultados.ok++;
    } else {
      console.log(`   🔧 Actualizando:`, JSON.stringify(updates));
      if (!DRY_RUN) {
        await db.collection("usuarios").doc(docId).update(updates);
        console.log(`   ✅ Actualizado`);
      } else {
        console.log(`   [DRY] se aplicaría update`);
      }
      resultados.normalizados++;
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Resumen:`);
  console.log(`  ✅ Ya correctos:    ${resultados.ok}`);
  console.log(`  🔄 Migrados (alias→uid): ${resultados.migrados}`);
  console.log(`  🔧 Normalizados:    ${resultados.normalizados}`);
  console.log(`  ⚠️  Sin correo:      ${resultados.sinCorreo}`);
  console.log(`  ❌ Errores:         ${resultados.errores}`);
  if (DRY_RUN) console.log(`\n  (Dry-run: nada fue modificado)`);
  console.log();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
