// ══════════════════════════════════════════════════════════════
// auth.js — Autenticación Firebase + sesión de usuario web
// ══════════════════════════════════════════════════════════════

import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, deleteDoc, serverTimestamp,
  collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ── Estado de sesión ───────────────────────────────────────────
// _state es privado al módulo; Sesion es inmutable desde fuera
// (Object.freeze bloquea asignación directa en DevTools)
let _state = { uid:"", email:"", alias:"", rol:"", flags:{}, prefs:{} };

export const Sesion = Object.freeze({
  get uid()   { return _state.uid;   },
  get email() { return _state.email; },
  get alias() { return _state.alias; },
  get rol()   { return _state.rol;   },
  get flags() { return _state.flags; },
  get prefs() { return _state.prefs; },
  esSuperAdmin() { return _state.rol === "SUPER_ADMIN"; },
  tieneFlag(f)    { return this.esSuperAdmin() || _state.flags[f] === true; },
  clear() { _state = { uid:"", email:"", alias:"", rol:"", flags:{}, prefs:{} }; }
});

// ── Autenticación ──────────────────────────────────────────────
export const Auth = {

  async login() {
    const email    = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errEl    = document.getElementById("login-error");
    const btnEl    = document.getElementById("login-btn");
    const loadEl   = document.getElementById("login-loading");

    // Validaciones básicas
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return _showLoginError("Ingresa un correo válido.");
    }
    if (!password) {
      return _showLoginError("La contraseña no puede estar vacía.");
    }

    errEl.classList.add("hidden");
    btnEl.classList.add("hidden");
    loadEl.classList.remove("hidden");

    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      await _cargarPerfil(cred.user);
    } catch (e) {
      btnEl.classList.remove("hidden");
      loadEl.classList.add("hidden");
      const msgs = {
        "auth/invalid-credential":      "Correo o contraseña incorrectos.",
        "auth/user-not-found":          "No existe una cuenta con ese correo.",
        "auth/wrong-password":          "Contraseña incorrecta.",
        "auth/too-many-requests":       "Demasiados intentos. Espera unos minutos.",
        "auth/user-disabled":           "Esta cuenta está deshabilitada.",
        "auth/network-request-failed":  "Sin conexión a internet. Revisa tu red.",
        "auth/internal-error":          "Error interno. Intenta de nuevo."
      };
      _showLoginError(msgs[e.code] ?? `Error: ${e.message}`);
    }
  },

  async logout() {
    await signOut(auth);
    Sesion.clear();
    _mostrarLogin();
    window.toast?.("Sesión cerrada", "info");
  },

  // Llamado por app.js al iniciar
  observarSesion(onLogin, onLogout) {
    let primeraVez = true;
    onAuthStateChanged(auth, async user => {
      if (user) {
        try {
          await _cargarPerfil(user);
        } catch (e) {
          console.error("[auth] Error cargando perfil:", e);
          window.manejarErrorFirestore?.(e);
          primeraVez = false;
          onLogout();
          return;
        }
        primeraVez = false;
        onLogin();
      } else {
        if (!primeraVez) {
          // Sesión terminada mientras el usuario estaba activo
          _mostrarModalSesionExpirada();
        }
        primeraVez = false;
        onLogout();
      }
    });
  }
};

// ── Interceptor global de errores Firestore ────────────────────
// Los módulos llaman window.manejarErrorFirestore(err) en sus catch.
// Si el error es de autenticación o permisos, fuerza re-login.
window.manejarErrorFirestore = function(err) {
  const codigo = err?.code ?? "";
  if (codigo === "permission-denied" || codigo === "unauthenticated") {
    signOut(auth).catch(() => {});
    Sesion.clear();
    _mostrarLogin();
    _mostrarModalSesionExpirada();
    return true; // fue manejado
  }
  return false; // error normal, el módulo puede mostrar su toast
};

// Exponer globalmente para onclick inline
window.Auth = Auth;

// ── Inactivity timeout (30 min) ────────────────────────────────
const TIMEOUT_MS = 30 * 60 * 1000;
let _inactivityTimer = null;

function _resetTimer() {
  clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(() => {
    signOut(auth);
    Sesion.clear();
    _mostrarLogin();
    window.toast?.("Sesión cerrada por inactividad", "warning");
  }, TIMEOUT_MS);
}

export function iniciarInactivityTimer() {
  ["mousemove","keydown","pointerdown","scroll"].forEach(ev =>
    document.addEventListener(ev, _resetTimer, { passive: true })
  );
  _resetTimer();
}

export function detenerInactivityTimer() {
  clearTimeout(_inactivityTimer);
  ["mousemove","keydown","pointerdown","scroll"].forEach(ev =>
    document.removeEventListener(ev, _resetTimer)
  );
}

// ── Internos ──────────────────────────────────────────────────
async function _cargarPerfil(user) {
  const ref  = doc(db, "usuarios", user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    // Buscar perfil pre-registrado por email (creado desde el panel de Ingenieros)
    const preSnap = await getDocs(
      query(collection(db, "usuarios"), where("email", "==", user.email))
    );
    if (!preSnap.empty) {
      const preData = preSnap.docs[0].data();
      if (!preData.activo) {
        await signOut(auth);
        _showLoginError("Tu cuenta está desactivada. Contacta al administrador.");
        return;
      }
      // Migrar doc alias→uid para futuros logins y borrar el pre-registro
      await setDoc(ref, { ...preData, uid: user.uid, migradoEn: serverTimestamp() });
      try { await deleteDoc(preSnap.docs[0].ref); } catch (_) {}
      _aplicarSesion(user.uid, user.email, preData);
      return;
    }
    // Sin pre-registro: crear perfil base
    const perfil = {
      email:    user.email,
      alias:    user.email.split("@")[0],
      rol:      "INGENIERO",
      activo:   true,
      prefs:    { theme: "system", density: "normal" },
      flags:    _flagsDefault(),
      creadoEn: serverTimestamp()
    };
    await setDoc(ref, perfil);
    _aplicarSesion(user.uid, user.email, perfil);
  } else {
    const data = snap.data();
    if (!data.activo) {
      await signOut(auth);
      _showLoginError("Tu cuenta está desactivada. Contacta al administrador.");
      return;
    }
    _aplicarSesion(user.uid, user.email, data);
  }
}

function _aplicarSesion(uid, email, data) {
  _state.uid   = uid;
  _state.email = email;
  _state.alias = data.alias || email.split("@")[0];
  _state.rol   = data.rol   || "INGENIERO";
  _state.flags = data.flags || {};
  _state.prefs = data.prefs || {};
}

function _flagsDefault() {
  return {
    PUEDE_EDITAR_PRECIO:      false,
    PUEDE_CANCELAR_PEDIDO:    false,
    PUEDE_VER_CARTERA_GLOBAL: false,
    PUEDE_IMPORTAR_CATALOGO:  false,
    PUEDE_EXPORTAR_BACKUP:    false,
    PUEDE_REGISTRAR_REMISION: true,
    PUEDE_REGISTRAR_ABONO:    true,
    PUEDE_VER_RH:             false
  };
}

function _mostrarModalSesionExpirada() {
  // Evitar duplicados
  if (document.getElementById("modal-sesion-expirada")) return;
  const m = document.createElement("div");
  m.id = "modal-sesion-expirada";
  m.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:20px`;
  m.innerHTML = `
    <div style="background:var(--c-surface,#1a1d27);border:1px solid #EF444455;border-radius:12px;
      padding:28px 32px;max-width:380px;width:100%;text-align:center">
      <div style="font-size:32px;margin-bottom:12px">🔐</div>
      <div style="font-size:15px;font-weight:700;color:#E6EDF3;margin-bottom:8px">Sesión terminada</div>
      <div style="font-size:13px;color:#8B949E;margin-bottom:20px;line-height:1.55">
        Tu sesión ha caducado o fue cerrada desde otro dispositivo.<br>
        Inicia sesión de nuevo para continuar.
      </div>
      <button onclick="document.getElementById('modal-sesion-expirada').remove()"
        style="background:#166534;border:1px solid #16A34A;border-radius:7px;padding:9px 24px;
          font-size:13px;font-weight:700;color:#4ADE80;cursor:pointer;width:100%">
        Ir al inicio de sesión
      </button>
    </div>`;
  document.body.appendChild(m);
}

function _showLoginError(msg) {
  const el = document.getElementById("login-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function _mostrarLogin() {
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("login-password").value = "";
  document.getElementById("login-error").classList.add("hidden");
  document.getElementById("login-btn").classList.remove("hidden");
  document.getElementById("login-loading").classList.add("hidden");
}
