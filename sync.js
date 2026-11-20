// ============================================================
// SINCRONIZACIÓN EN LA NUBE (Firestore) — opcional
// ============================================================
// Si firebase-config.js no está relleno todavía, la app sigue funcionando
// exactamente igual que antes, solo que sin compartir datos entre dispositivos.

let syncEnabled = false;
let syncDb = null;
let syncDocRef = null;
let applyingRemote = false;
const deviceTag = 'dev-' + Math.random().toString(36).slice(2, 10);
let pushTimer = null;

function isFirebaseConfigured() {
  return typeof FIREBASE_CONFIG !== 'undefined' && FIREBASE_CONFIG.apiKey && !FIREBASE_CONFIG.apiKey.startsWith('PEGA_AQUI');
}

function setSyncBadge(status) {
  const badge = document.getElementById('sync-badge');
  if (!badge) return;
  const labels = {
    off: '',
    ok: '☁️ Sincronizado',
    syncing: '🔄 Sincronizando…',
    error: '⚠️ Sin conexión a la nube',
    unconfigured: ''
  };
  badge.textContent = labels[status] || '';
}

function initSync(onRemoteChange) {
  if (!isFirebaseConfigured()) { setSyncBadge('unconfigured'); return; }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    syncDb = firebase.firestore();
    syncDocRef = syncDb.collection(SYNC_DOC_PATH.collection).doc(SYNC_DOC_PATH.doc);
    syncEnabled = true;
    setSyncBadge('syncing');
    syncDocRef.onSnapshot((snap) => {
      if (!snap.exists) { setSyncBadge('ok'); onRemoteChange(null); return; }
      const data = snap.data();
      if (data._lastWriterTag === deviceTag) { setSyncBadge('ok'); return; }
      applyingRemote = true;
      onRemoteChange(data);
      applyingRemote = false;
      setSyncBadge('ok');
    }, (err) => {
      console.error('Error de sincronización:', err);
      setSyncBadge('error');
    });
  } catch (e) {
    console.error('No se pudo iniciar la sincronización:', e);
    setSyncBadge('error');
  }
}

// getPayloadFn debe devolver un objeto con SOLO los campos que han cambiado,
// p.ej. { profiles: JSON.stringify(state.profiles) }
function pushToCloud(getPayloadFn) {
  if (!syncEnabled || applyingRemote) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const payload = getPayloadFn();
    setSyncBadge('syncing');
    syncDocRef.set({ ...payload, _lastWriterTag: deviceTag, _updatedAt: Date.now() }, { merge: true })
      .then(() => setSyncBadge('ok'))
      .catch((e) => { console.error('Error guardando en la nube:', e); setSyncBadge('error'); });
  }, 700);
}
