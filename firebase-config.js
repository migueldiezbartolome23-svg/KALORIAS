// ============================================================
// CONFIGURACIÓN DE LA NUBE (Firebase)
// ============================================================
// Sigue las instrucciones que te ha dado Claude para crear tu proyecto
// gratuito en https://console.firebase.google.com, y pega aquí los datos
// que te enseña la consola en "Configuración del proyecto" > tu app web.
//
// Mientras dejes esto con los valores de ejemplo ("PEGA_AQUI..."), la
// aplicación sigue funcionando con total normalidad, solo que guardando
// los datos únicamente en este dispositivo (como hasta ahora).

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDb1wmnTODReODkVvx8VdaD0H5XcbBinPM",
  authDomain: "kcalculadora.firebaseapp.com",
  projectId: "kcalculadora",
  storageBucket: "kcalculadora.firebasestorage.app",
  messagingSenderId: "1001997721318",
  appId: "1:1001997721318:web:345d725f4b23f7eb97e527"
};

// No hace falta tocar esto: es simplemente el "cajón" compartido dentro
// de tu proyecto donde Miguel guarda y lee los mismos datos.
const SYNC_DOC_PATH = { collection: 'kcalculadora-hogar', doc: 'compartido' };
