// ============================================================
// CONTROL NUTRICIONAL — lógica de la aplicación
// ============================================================

const STORAGE_KEYS = {
  profiles: 'dietapp:profiles',
  catalog: 'dietapp:ingredientsCatalog',
  meals: 'dietapp:meals',
  logs: 'dietapp:logs',
  ui: 'dietapp:ui',
  version: 'dietapp:dataVersion'
};

// ---------- Almacenamiento ----------
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('Error leyendo', key, e);
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('Error guardando', key, e);
    return false;
  }
}

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

let state = {
  profiles: loadJSON(STORAGE_KEYS.profiles, JSON.parse(JSON.stringify(DEFAULT_PROFILES))),
  ingredientsCatalog: loadJSON(STORAGE_KEYS.catalog, JSON.parse(JSON.stringify(DEFAULT_INGREDIENTS_CATALOG))),
  meals: loadJSON(STORAGE_KEYS.meals, JSON.parse(JSON.stringify(DEFAULT_MEALS))),
  logs: loadJSON(STORAGE_KEYS.logs, {}),
  ui: loadJSON(STORAGE_KEYS.ui, { activeProfile: 'miguel', activeTab: 'hoy', activeDate: todayISO(), calMonth: todayISO().slice(0,7) })
};
// migración suave: perfiles/UI guardados antes de añadir campos nuevos
for (const p of Object.values(state.profiles)) {
  if (!p.goal) p.goal = 'perder_grasa';
  if (!p.hiddenMealIds) p.hiddenMealIds = [];
    if (!p.extraMealSlots) p.extraMealSlots = [];
}
if (!state.ui.calMonth) state.ui.calMonth = todayISO().slice(0, 7);
if (!state.ui.activeTab) state.ui.activeTab = 'hoy';

// ---------- Migración a la versión actual (un solo perfil + platos tal cual del Excel) ----------
// Se ejecuta una sola vez por dispositivo (y se sube a la nube). Después puedes editar o borrar platos con normalidad.
function runMigration() {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // 1) solo Miguel
  const miguel = state.profiles.miguel || clone(DEFAULT_PROFILES.miguel);
  if (!miguel.mealTargets) miguel.mealTargets = clone(OFFICIAL_MEAL_TARGETS);
  miguel.hiddenMealIds = [];
  state.profiles = { miguel };
  state.ui.activeProfile = 'miguel';
  // 2) platos oficiales = Excel; se conservan los platos propios (source 'custom')
  const custom = (state.meals || []).filter(m => m.source === 'custom');
  state.meals = [...clone(DEFAULT_MEALS), ...custom];
}
let needsCloudPush = false;
if (loadJSON(STORAGE_KEYS.version, 0) < DATA_VERSION) {
  runMigration();
  saveJSON(STORAGE_KEYS.profiles, state.profiles);
  saveJSON(STORAGE_KEYS.meals, state.meals);
  saveJSON(STORAGE_KEYS.ui, state.ui);
  saveJSON(STORAGE_KEYS.version, DATA_VERSION);
  needsCloudPush = true;
}
// por si algún dato antiguo apuntaba a un perfil que ya no existe
if (!state.profiles[state.ui.activeProfile]) state.ui.activeProfile = 'miguel';

function persistProfiles() { saveJSON(STORAGE_KEYS.profiles, state.profiles); pushToCloud(() => ({ profiles: JSON.stringify(state.profiles) })); }
function persistCatalog() { saveJSON(STORAGE_KEYS.catalog, state.ingredientsCatalog); pushToCloud(() => ({ ingredientsCatalog: JSON.stringify(state.ingredientsCatalog) })); }
function persistMeals() { saveJSON(STORAGE_KEYS.meals, state.meals); pushToCloud(() => ({ meals: JSON.stringify(state.meals) })); }
function persistLogs() { saveJSON(STORAGE_KEYS.logs, state.logs); pushToCloud(() => ({ logs: JSON.stringify(state.logs) })); }
function persistUI() { saveJSON(STORAGE_KEYS.ui, state.ui); } // la navegación no se sincroniza entre dispositivos a propósito

function pushAllToCloud() {
  pushToCloud(() => ({
    profiles: JSON.stringify(state.profiles), ingredientsCatalog: JSON.stringify(state.ingredientsCatalog),
    meals: JSON.stringify(state.meals), dataVersion: DATA_VERSION,
    // si este dispositivo no tiene registros todavía, no se sube un "vacío" que borraría los de la nube
    ...(Object.keys(state.logs).length ? { logs: JSON.stringify(state.logs) } : {})
  }));
}

function applyRemoteChange(data) {
  // sin datos en la nube, o anteriores a esta versión (con Marta y platos viejos): subimos los actuales
  if (!data || (data.dataVersion || 0) < DATA_VERSION) { pushAllToCloud(); applyPendingExercise(); return; }
  if (data.profiles) state.profiles = JSON.parse(data.profiles);
  if (data.ingredientsCatalog) state.ingredientsCatalog = JSON.parse(data.ingredientsCatalog);
  if (data.meals) state.meals = JSON.parse(data.meals);
  if (data.logs) state.logs = JSON.parse(data.logs);
  for (const p of Object.values(state.profiles)) {
    if (!p.goal) p.goal = 'perder_grasa';
    if (!p.hiddenMealIds) p.hiddenMealIds = [];
    if (!p.extraMealSlots) p.extraMealSlots = [];
  }
  if (!state.profiles[state.ui.activeProfile]) state.ui.activeProfile = 'miguel';
  saveJSON(STORAGE_KEYS.profiles, state.profiles);
  saveJSON(STORAGE_KEYS.catalog, state.ingredientsCatalog);
  saveJSON(STORAGE_KEYS.meals, state.meals);
  saveJSON(STORAGE_KEYS.logs, state.logs);
  saveJSON(STORAGE_KEYS.version, DATA_VERSION);
  render();
  applyPendingExercise();
}

// ---------- Ejercicio desde un enlace (Atajo de iOS con las calorías del Apple Watch) ----------
// Uso:  https://TU-WEB/?ejercicio=650            (hoy)
//       https://TU-WEB/?ejercicio=650&fecha=2026-11-20
let pendingExercise = null;
(function readExerciseFromURL() {
  try {
    const params = new URLSearchParams(location.search);
    if (!params.has('ejercicio')) return;
    const kcal = Math.round(Number(String(params.get('ejercicio')).replace(',', '.')));
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(params.get('fecha') || '') ? params.get('fecha') : todayISO();
    if (kcal >= 0 && kcal < 10000) pendingExercise = { kcal, fecha };
    history.replaceState(null, '', location.pathname); // limpia la URL para no repetirlo al recargar
  } catch (e) { console.error(e); }
})();
function applyPendingExercise() {
  if (!pendingExercise) return;
  const { kcal, fecha } = pendingExercise;
  pendingExercise = null;
  getDayLog('miguel', fecha, state.profiles.miguel).ejercicio = kcal;
  persistLogs();
  state.ui.activeDate = fecha; persistUI();
  render();
  alertModal('Ejercicio guardado', `${kcal} kcal de ejercicio apuntadas para ${friendlyDateLabel(fecha).toLowerCase()}.`);
}

// ---------- Utilidades ----------
function round1(n) { return Math.round(n * 10) / 10; }
function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const r = Math.round(n * 10) / 10;
  return (Number.isInteger(r) ? r.toString() : r.toFixed(1));
}
function uid(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 9); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ---------- Cálculo metabólico ----------
const JOB_FACTORS = { sedentario: 1.20, ligero: 1.30, moderado: 1.40, intenso: 1.55 };
const JOB_LABELS = {
  sedentario: 'Sedentario (oficina / estudio, se mueve poco)',
  ligero: 'Movimiento ligero (de pie, camina algo)',
  moderado: 'Físico moderado (se mueve bastante, no agotador)',
  intenso: 'Físico intenso / muy exigente'
};
const EXERCISE_BUMP = {
  0: { baja: 0, moderada: 0, alta: 0 },
  1: { baja: 0.03, moderada: 0.045, alta: 0.06 },
  2: { baja: 0.05, moderada: 0.075, alta: 0.10 },
  3: { baja: 0.08, moderada: 0.10, alta: 0.13 },
  4: { baja: 0.10, moderada: 0.13, alta: 0.16 },
  5: { baja: 0.13, moderada: 0.16, alta: 0.20 },
  6: { baja: 0.15, moderada: 0.19, alta: 0.23 },
  7: { baja: 0.17, moderada: 0.22, alta: 0.27 }
};
const EXERCISE_LABELS = { fuerza: 'Entrenamiento de fuerza', cardio: 'Cardio', mixto: 'Mixto (fuerza + cardio)', otro: 'Otro / deporte de equipo' };

function calcBMR(personal) {
  const { sex, weightKg, heightCm, age } = personal;
  if (!sex || !weightKg || !heightCm || !age) return null;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'M' ? base + 5 : base - 161;
}
function calcActivityMultiplier(personal) {
  if (!personal.jobActivity) return null;
  const jobFactor = JOB_FACTORS[personal.jobActivity] ?? 1.2;
  const days = personal.exerciseDays ?? 0;
  const intensity = personal.exerciseIntensity || 'moderada';
  const bumpRow = EXERCISE_BUMP[clamp(days, 0, 7)] || EXERCISE_BUMP[0];
  return jobFactor + (bumpRow[intensity] ?? 0);
}
function calcMaintenance(personal) {
  const bmr = calcBMR(personal);
  const mult = calcActivityMultiplier(personal);
  if (bmr === null || mult === null) return null;
  return bmr * mult;
}
function calcSuggestedTarget(profile) {
  const maint = calcMaintenance(profile.personal);
  if (maint === null) return null;
  const kcal = maint + (profile.deficitKcal || 0);
  const weight = profile.personal.weightKg || 0;
  const prot = round1((profile.proteinPerKg || 1.8) * weight);
  const fat = round1((profile.fatPerKg || 0.85) * weight);
  let carb = (kcal - prot * 4 - fat * 9) / 4;
  if (carb < 0) carb = 0;
  return { kcal: round1(kcal), prot, carb: round1(carb), fat, maintenance: round1(maint) };
}
function getEffectiveTarget(profile) { return profile.manualTarget || calcSuggestedTarget(profile); }
// Objetivo de un día concreto: las kcal de ejercicio (Apple Watch o a mano) se suman a las calorías del día
function dayTargetFor(profile, dayLog) {
  const t = getEffectiveTarget(profile);
  if (!t) return t;
  return { ...t, kcal: t.kcal + ((dayLog && dayLog.ejercicio) || 0) };
}

const MEAL_KEYS = ['almuerzo', 'comida', 'merienda', 'cena'];
const MEAL_TAG_LABELS = { almuerzo: 'Almuerzo', comida: 'Comida', merienda: 'Merienda', cena: 'Cena' };

function scaleMealTargetsProportionally(oldMealTargets, oldTotal, newTotal) {
  const next = {};
  for (const mk of MEAL_KEYS) {
    const cur = oldMealTargets[mk] || { kcal: 0, prot: 0, carb: 0, fat: 0 };
    next[mk] = {
      kcal: oldTotal.kcal ? round1(cur.kcal * (newTotal.kcal / oldTotal.kcal)) : cur.kcal,
      prot: oldTotal.prot ? round1(cur.prot * (newTotal.prot / oldTotal.prot)) : cur.prot,
      carb: oldTotal.carb ? round1(cur.carb * (newTotal.carb / oldTotal.carb)) : cur.carb,
      fat: oldTotal.fat ? round1(cur.fat * (newTotal.fat / oldTotal.fat)) : cur.fat
    };
  }
  return next;
}
function sumMealTargets(mealTargets) {
  const total = { kcal: 0, prot: 0, carb: 0, fat: 0 };
  for (const mk of MEAL_KEYS) {
    const t = mealTargets && mealTargets[mk];
    if (!t) continue;
    total.kcal += t.kcal; total.prot += t.prot; total.carb += t.carb; total.fat += t.fat;
  }
  return total;
}

// ---------- Biblioteca combinada (oficial + comidas propias) ----------
// ---------- Catálogo de ingredientes + platos ----------
function findIngredient(id) { return state.ingredientsCatalog.find(i => i.id === id); }
function ingredientRate(ing) {
  // devuelve los macros de esa cantidad de ingrediente (ya con qty aplicado, sin escalar aún por ración)
  const cat = findIngredient(ing.ingredientId);
  if (!cat) return { kcal: 0, prot: 0, carb: 0, fat: 0 };
  const mult = cat.basis === 'perUnit' ? ing.qty : ing.qty / 100;
  return { kcal: cat.kcal * mult, prot: cat.prot * mult, carb: cat.carb * mult, fat: cat.fat * mult };
}
function mealTotals(meal) {
  const total = { kcal: 0, prot: 0, carb: 0, fat: 0 };
  if (meal.ingredients && meal.ingredients.length) {
    meal.ingredients.forEach(ing => {
      const m = ingredientRate(ing);
      total.kcal += m.kcal; total.prot += m.prot; total.carb += m.carb; total.fat += m.fat;
    });
  } else if (meal.kcal !== undefined) {
    total.kcal = meal.kcal; total.prot = meal.prot; total.carb = meal.carb; total.fat = meal.fat;
  }
  return total;
}
function findMealOption(id) { return state.meals.find(m => m.id === id); }
function optionsForMeal(mealKey, profile) {
  const hidden = (profile && profile.hiddenMealIds) || [];
  if (!MEAL_KEYS.includes(mealKey)) {
    // comida extra: se puede elegir cualquier plato de la biblioteca
    return state.meals.filter(m => !hidden.includes(m.id));
  }
  return state.meals.filter(m => m.mealTypes.includes(mealKey) && !hidden.includes(m.id));
}
function foodsForMeal(mealKey) {
  return state.ingredientsCatalog.filter(f => f.mealTypes && f.mealTypes.includes(mealKey));
}


// ---------- Entradas del día ----------
function logKey(profileId, date) { return profileId + '|' + date; }
function getDayLog(profileId, date, profile) {
  const key = logKey(profileId, date);
  if (!state.logs[key]) state.logs[key] = { almuerzo: [], comida: [], merienda: [], cena: [], bebidas: [] };
  if (!state.logs[key].bebidas) state.logs[key].bebidas = [];
  if (profile && profile.extraMealSlots) {
    profile.extraMealSlots.forEach(s => { if (!state.logs[key][s.id]) state.logs[key][s.id] = []; });
  }
  return state.logs[key];
}
const LOG_BUCKETS = ['almuerzo', 'comida', 'merienda', 'cena', 'bebidas'];

function entryMacros(entry) {
  if (entry.type === 'preset' || entry.type === 'custommeal' || entry.type === 'meal') {
    const opt = findMealOption(entry.refId);
    if (!opt) return { kcal: 0, prot: 0, carb: 0, fat: 0 };
    if (opt.ingredients && opt.ingredients.length) {
      const pcts = entry.ingredientPcts || opt.ingredients.map(() => 100);
      const total = { kcal: 0, prot: 0, carb: 0, fat: 0 };
      opt.ingredients.forEach((ing, i) => {
        const base = ingredientRate(ing);
        const f = (pcts[i] ?? 100) / 100;
        total.kcal += base.kcal * f; total.prot += base.prot * f;
        total.carb += base.carb * f; total.fat += base.fat * f;
      });
      return total;
    }
    const base = mealTotals(opt);
    const f = (entry.scalePct ?? 100) / 100;
    return { kcal: base.kcal * f, prot: base.prot * f, carb: base.carb * f, fat: base.fat * f };
  }
  if (entry.type === 'custom') {
    const food = findIngredient(entry.foodId);
    if (!food) return { kcal: 0, prot: 0, carb: 0, fat: 0 };
    const mult = food.basis === 'perUnit' ? entry.grams : entry.grams / 100;
    return { kcal: food.kcal * mult, prot: food.prot * mult, carb: food.carb * mult, fat: food.fat * mult };
  }
  if (entry.type === 'drink') {
    const g = entry.ml / 100;
    return { kcal: entry.kcal100 * g, prot: (entry.prot100 || 0) * g, carb: (entry.carb100 || 0) * g, fat: (entry.fat100 || 0) * g };
  }
  if (entry.type === 'freeform') {
    return { kcal: entry.kcal || 0, prot: entry.prot || 0, carb: entry.carb || 0, fat: entry.fat || 0 };
  }
  return { kcal: 0, prot: 0, carb: 0, fat: 0 };
}
function sumEntries(entries) {
  const total = { kcal: 0, prot: 0, carb: 0, fat: 0 };
  for (const e of entries) {
    const m = entryMacros(e);
    total.kcal += m.kcal; total.prot += m.prot; total.carb += m.carb; total.fat += m.fat;
  }
  return total;
}
function dayTotals(dayLog, profile) {
  const total = { kcal: 0, prot: 0, carb: 0, fat: 0 };
  const buckets = profile && profile.extraMealSlots ? [...LOG_BUCKETS, ...profile.extraMealSlots.map(s => s.id)] : LOG_BUCKETS;
  for (const bucket of buckets) {
    const t = sumEntries(dayLog[bucket] || []);
    total.kcal += t.kcal; total.prot += t.prot; total.carb += t.carb; total.fat += t.fat;
  }
  return total;
}

// ============================================================
// UI helpers
// ============================================================
const root = document.getElementById('app');
function activeProfile() { return state.profiles[state.ui.activeProfile]; }

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') { if (v) e.setAttribute(k, ''); }
    else e.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c === null || c === undefined) return;
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  });
  return e;
}
function selectEl(options, currentValue, onChange, placeholder) {
  // options: [{value, label}]
  const s = el('select', { onchange: (e) => onChange(e.target.value) });
  if (placeholder) s.appendChild(el('option', { value: '' }, placeholder));
  options.forEach(o => s.appendChild(el('option', { value: o.value }, o.label)));
  s.value = currentValue || '';
  return s;
}
function field(label, inputEl) {
  return el('label', { class: 'field' }, [el('span', { class: 'field-label' }, label), inputEl]);
}
function numberInput(value, onChange, step = 1, min, max) {
  const attrs = { type: 'number', value: value === null || value === undefined ? '' : value, step: String(step) };
  if (min !== undefined) attrs.min = String(min);
  if (max !== undefined) attrs.max = String(max);
  attrs.onchange = (e) => onChange(e.target.value === '' ? null : Number(e.target.value));
  return el('input', attrs);
}

// ---------- Modal ----------
let modalRoot = null;
function closeModal() {
  if (modalRoot) { modalRoot.remove(); modalRoot = null; }
}
function openModal(title, bodyBuilder, opts = {}) {
  closeModal();
  const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay && !opts.persistent) closeModal(); } });
  const box = el('div', { class: 'modal-box' + (opts.noHeader ? ' modal-box-plain' : '') });
  if (opts.noHeader) {
    if (!opts.persistent) box.appendChild(el('button', { class: 'modal-close modal-close-floating', onclick: closeModal }, '✕'));
  } else {
    box.appendChild(el('div', { class: 'modal-head' }, [
      el('h3', {}, title),
      opts.persistent ? null : el('button', { class: 'modal-close', onclick: closeModal }, '✕')
    ]));
  }
  const body = el('div', { class: 'modal-body' });
  bodyBuilder(body, closeModal);
  box.appendChild(body);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  modalRoot = overlay;
}
function alertModal(title, message, tone) {
  openModal(title, (body) => {
    body.appendChild(el('p', { class: 'modal-msg' + (tone ? ' tone-' + tone : '') }, message));
    body.appendChild(el('button', { class: 'btn-primary', onclick: closeModal }, 'Entendido'));
  });
}

// ============================================================
// RENDER
// ============================================================
const SECTIONS = [
  { key: 'hoy', label: 'Hoy', icon: '📊' },
  { key: 'perfil', label: 'Perfil', icon: '⚖️' },
  { key: 'calendario', label: 'Calendario', icon: '📅' },
  { key: 'alimentos', label: 'Alimentos', icon: '🥬' },
  { key: 'comidas', label: 'Comidas', icon: '🍔' }
];
const AVATARS = { miguel: './avatar-miguel.png' };

function goTo(key) { state.ui.activeTab = key; persistUI(); render(); }

function render() {
  root.innerHTML = '';
  root.appendChild(renderHeader());
  root.appendChild(renderBubbleNav());
  const tab = state.ui.activeTab;
  if (tab === 'hoy' || tab === 'home') root.appendChild(renderHoy());
  else if (tab === 'perfil') root.appendChild(renderPerfil());
  else if (tab === 'calendario') root.appendChild(renderCalendario());
  else if (tab === 'alimentos') root.appendChild(renderAlimentos());
  else if (tab === 'comidas') root.appendChild(renderComidas());
  renderRacionesFab();
}

function renderRacionesFab() {
  let fab = document.getElementById('raciones-fab');
  if (!fab) {
    fab = el('button', { id: 'raciones-fab', class: 'fab', 'aria-label': 'Calculadora de raciones familiares', onclick: openRacionesModal }, '🍲');
    document.body.appendChild(fab);
  }
}
function openRacionesModal() {
  openModal('Raciones para ollas y comidas familiares', (body) => {
    buildRacionesContent(body);
  });
}

function renderHeader() {
  const header = el('header', { class: 'app-header' });
  header.appendChild(el('div', { class: 'title-row' }, [
    el('div', { class: 'title-left' }, [
      el('h1', { onclick: () => goTo('hoy'), style: 'cursor:pointer' }, [el('span', {}, 'K-Cal'), el('br'), el('span', {}, 'Culadora')]),
      el('span', { id: 'sync-badge', class: 'sync-badge' })
    ])
  ]));
  return header;
}

function renderBubbleNav() {
  const row = el('div', { class: 'bubble-row' });
  const profile = activeProfile();
  row.appendChild(el('div', { class: 'bubble profile-bubble' }, [
    el('div', { class: 'bubble-circle profile-circle' }, el('img', { src: AVATARS[profile.id], alt: profile.name, class: 'avatar-img' })),
    el('div', { class: 'bubble-label' }, profile.name)
  ]));
  const activeKey = state.ui.activeTab === 'home' ? 'hoy' : state.ui.activeTab;
  const others = SECTIONS.filter(s => s.key !== activeKey);
  others.forEach(s => {
    row.appendChild(el('button', { class: 'bubble', onclick: () => goTo(s.key) }, [
      el('div', { class: 'bubble-circle' }, s.icon),
      el('div', { class: 'bubble-label' }, s.label)
    ]));
  });
  return row;
}

// ---------------- TAB: HOY ----------------
function friendlyDateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0,0,0,0);
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === 0) return 'Hoy';
  if (diffDays === -1) return 'Ayer';
  if (diffDays === 1) return 'Mañana';
  const dow = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][target.getDay()];
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return `${dow}, ${d} de ${months[m - 1]}`;
}

function renderHoy() {
  const profile = activeProfile();
  const wrap = el('div', { class: 'view view-hoy' });

  const dateInput = el('input', {
    type: 'date', value: state.ui.activeDate, class: 'date-input-hidden',
    onchange: (e) => { state.ui.activeDate = e.target.value; persistUI(); render(); }
  });
  const dateRow = el('div', { class: 'date-row' }, [
    el('button', { class: 'btn-icon', onclick: () => shiftDate(-1) }, '‹'),
    el('button', {
      class: 'date-label', onclick: () => { if (dateInput.showPicker) dateInput.showPicker(); else dateInput.focus(); }
    }, [friendlyDateLabel(state.ui.activeDate), ' 📅']),
    dateInput,
    el('button', { class: 'btn-icon', onclick: () => shiftDate(1) }, '›')
  ]);
  wrap.appendChild(dateRow);

  if (!getEffectiveTarget(profile)) {
    wrap.appendChild(el('div', { class: 'empty-note' }, [
      el('p', {}, `Todavía no hay un objetivo diario definido para ${profile.name}.`),
      el('button', { class: 'btn-primary', onclick: () => { state.ui.activeTab = 'perfil'; persistUI(); render(); } }, 'Ir a Perfil y objetivo')
    ]));
    return wrap;
  }

  const dayLog = getDayLog(profile.id, state.ui.activeDate, profile);
  const totals = dayTotals(dayLog, profile);
  const target = dayTargetFor(profile, dayLog);

  wrap.appendChild(renderProgressRings(totals, target));
  wrap.appendChild(renderCounterBoard(totals, target));
  wrap.appendChild(renderExerciseCard(dayLog, target));
  for (const mk of MEAL_KEYS) wrap.appendChild(renderMealSection(profile, mk, dayLog));
  profile.extraMealSlots.forEach(slot => wrap.appendChild(renderMealSection(profile, slot.id, dayLog, slot.name)));
  wrap.appendChild(renderAddMealSlotCard(profile));
  wrap.appendChild(renderBebidasSection(profile, dayLog));

  return wrap;
}

function renderExerciseCard(dayLog, target) {
  const input = numberInput(dayLog.ejercicio || 0, v => { dayLog.ejercicio = v && v > 0 ? v : 0; persistLogs(); render(); }, 10, 0);
  return el('div', { class: 'calc-box exercise-card' }, [
    el('strong', {}, '🔥 Ejercicio de hoy'),
    field('Calorías activas quemadas (kcal)', input),
    el('p', { class: 'note' }, dayLog.ejercicio
      ? `Sumadas a tu objetivo: hoy puedes comer ${fmt(target.kcal)} kcal.`
      : 'Se suman a tu objetivo de calorías del día. Pon las "calorías activas" del Apple Watch.')
  ]);
}

function shiftDate(delta) {
  const [y, m, d] = state.ui.activeDate.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d); // hora local, sin pasar por UTC
  dateObj.setDate(dateObj.getDate() + delta);
  const yy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getDate()).padStart(2, '0');
  state.ui.activeDate = `${yy}-${mm}-${dd}`;
  persistUI(); render();
}

function renderProgressRings(totals, target) {
  const wrap = el('div', { class: 'rings-wrap' });
  const rings = [
    { cur: totals.kcal, goal: target.kcal, color: 'var(--accent-strong)' },
    { cur: totals.prot, goal: target.prot, color: '#4FA9C9' },
    { cur: totals.carb, goal: target.carb, color: '#E0B84F' },
    { cur: totals.fat, goal: target.fat, color: '#9B7FE0' }
  ];
  const size = 200, cx = 100, cy = 100, gap = 16, baseR = 88;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'rings-svg');
  rings.forEach((r, i) => {
    const radius = baseR - i * gap;
    const circumference = 2 * Math.PI * radius;
    const frac = r.goal > 0 ? Math.min(r.cur / r.goal, 1) : 0;
    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('cx', cx); track.setAttribute('cy', cy); track.setAttribute('r', radius);
    track.setAttribute('class', 'ring-track');
    svg.appendChild(track);
    const bar = document.createElementNS(svgNS, 'circle');
    bar.setAttribute('cx', cx); bar.setAttribute('cy', cy); bar.setAttribute('r', radius);
    bar.setAttribute('class', 'ring-bar');
    bar.setAttribute('stroke', r.color);
    bar.setAttribute('stroke-dasharray', `${circumference}`);
    bar.setAttribute('stroke-dashoffset', `${circumference * (1 - frac)}`);
    svg.appendChild(bar);
  });
  wrap.appendChild(svg);
  const centerLabel = el('div', { class: 'rings-center' }, [
    el('div', { class: 'rings-center-num mono' }, fmt(totals.kcal)),
    el('div', { class: 'rings-center-sub' }, `de ${fmt(target.kcal)} kcal`)
  ]);
  wrap.appendChild(centerLabel);
  const legend = el('div', { class: 'rings-legend' }, [
    el('span', { style: 'color:var(--accent-strong)' }, '● Kcal'),
    el('span', { style: 'color:#4FA9C9' }, '● Proteína'),
    el('span', { style: 'color:#E0B84F' }, '● Carbos'),
    el('span', { style: 'color:#9B7FE0' }, '● Grasas')
  ]);
  const col = el('div', { class: 'rings-row' }, [wrap, legend]);
  return col;
}

function renderCounterBoard(totals, target) {
  const board = el('div', { class: 'counter-board' });
  const rows = [['Calorías', totals.kcal, target.kcal, 'kcal'], ['Proteína', totals.prot, target.prot, 'g'],
    ['Carbohidratos', totals.carb, target.carb, 'g'], ['Grasas', totals.fat, target.fat, 'g']];
  for (const [label, cur, goal, unit] of rows) {
    const pct = goal > 0 ? Math.min(cur / goal, 1.35) : 0;
    const over = cur > goal;
    const remaining = goal - cur;
    board.appendChild(el('div', { class: 'scale-row' }, [
      el('div', { class: 'scale-label' }, label),
      el('div', { class: 'scale-bar' }, [el('div', { class: 'scale-fill' + (over ? ' over' : ''), style: `width:${Math.min(pct, 1) * 100}%` })]),
      el('div', { class: 'scale-numbers' }, [
        el('span', { class: 'mono' }, `${fmt(cur)} / ${fmt(goal)} ${unit}`),
        el('span', { class: 'scale-remaining' + (remaining < 0 ? ' neg' : '') }, remaining >= 0 ? `quedan ${fmt(remaining)}` : `+${fmt(Math.abs(remaining))} de más`)
      ])
    ]));
  }
  return board;
}

// ---------- Avisos ----------
function checkWarnings(profile, mealKey, dayLogBefore, dayLogAfter) {
  const target = dayTargetFor(profile, dayLogAfter);
  if (!target) return;
  const before = dayTotals(dayLogBefore, profile);
  const after = dayTotals(dayLogAfter, profile);

  const justCrossedKcal = before.kcal <= target.kcal && after.kcal > target.kcal;
  const justCrossedFat = before.fat <= target.fat && after.fat > target.fat;
  if (justCrossedKcal) {
    alertModal('Te has pasado de calorías', `Con esto llevas ${fmt(after.kcal)} kcal, ${fmt(after.kcal - target.kcal)} kcal por encima de tu objetivo de ${fmt(target.kcal)} kcal.`, 'over');
  } else if (justCrossedFat) {
    alertModal('Te has pasado de grasas', `Con esto llevas ${fmt(after.fat)} g de grasa, ${fmt(after.fat - target.fat)} g por encima de tu objetivo de ${fmt(target.fat)} g.`, 'over');
  } else if (mealKey === 'cena' && after.prot < target.prot) {
    const gap = round1(target.prot - after.prot);
    alertModal('Te faltan proteínas hoy', `Después de la cena te quedan ${fmt(gap)} g de proteína por debajo de tu objetivo. Un batido de proteína, un yogur proteico o un par de claras te ayudarían a cerrarlo.`, 'warn');
  }
}

function pieSlicePath(cx, cy, r, startAngle, endAngle) {
  const toXY = (ang) => { const a = (ang - 90) * Math.PI / 180; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
  const start = toXY(endAngle), end = toXY(startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
}
function renderMealPie(totals) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const kcalP = totals.prot * 4, kcalC = totals.carb * 4, kcalF = totals.fat * 9;
  const total = kcalP + kcalC + kcalF;
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'meal-pie');
  if (total <= 0) {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', 44);
    c.setAttribute('class', 'pie-empty');
    svg.appendChild(c);
    return svg;
  }
  const slices = [[kcalP, '#4FA9C9'], [kcalC, '#E0B84F'], [kcalF, '#9B7FE0']];
  let angle = 0;
  slices.forEach(([val, color]) => {
    if (val <= 0) return;
    const sweep = (val / total) * 360;
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', pieSlicePath(50, 50, 44, angle, angle + sweep));
    path.setAttribute('fill', color);
    svg.appendChild(path);
    angle += sweep;
  });
  return svg;
}

function mealLabelFor(profile, mealKey) {
  if (MEAL_TAG_LABELS[mealKey]) return MEAL_TAG_LABELS[mealKey];
  const slot = profile.extraMealSlots.find(s => s.id === mealKey);
  return slot ? slot.name : mealKey;
}

function renderMealSection(profile, mealKey, dayLog) {
  const mealLabel = mealLabelFor(profile, mealKey);
  const entries = dayLog[mealKey] || [];
  const subtotal = sumEntries(entries);

  const outer = el('div', { class: 'notebook-outer' });
  outer.appendChild(el('div', { class: 'notebook-backing' }));
  outer.appendChild(el('div', { class: 'notebook-ribbon' }));
  const page = el('div', { class: 'notebook-page meal-compact', onclick: () => openMealDetailModal(profile, mealKey) }, [
    el('div', { class: 'meal-compact-info' }, [
      el('h3', {}, mealLabel),
      el('span', { class: 'meal-sub mono' }, `${fmt(subtotal.kcal)} kcal registradas`)
    ]),
    entries.length ? renderMealPie(subtotal) : el('div', { class: 'meal-compact-pie' })
  ]);
  page.querySelector('svg')?.classList.add('meal-compact-pie');
  outer.appendChild(page);
  return outer;
}

function renderAddMealSlotCard(profile) {
  const outer = el('div', { class: 'notebook-outer' });
  outer.appendChild(el('div', { class: 'notebook-backing' }));
  outer.appendChild(el('div', { class: 'notebook-ribbon' }));
  const page = el('div', {
    class: 'notebook-page add-meal-slot',
    onclick: () => {
      const name = prompt('¿Cómo se llama esta comida? (p. ej. Desayuno, Recena)', '') || 'Comida extra';
      const id = 'extra-' + uid('slot');
      profile.extraMealSlots.push({ id, name });
      persistProfiles(); render();
    }
  }, ['+ ', 'Añadir otra comida']);
  outer.appendChild(page);
  return outer;
}

function openMealDetailModal(profile, mealKey) {
  const mealLabel = mealLabelFor(profile, mealKey);
  const isExtra = !MEAL_KEYS.includes(mealKey);
  openModal(null, (body) => {
    body.classList.add('meal-modal-body');
    function refresh() {
      body.innerHTML = '';
      const dayLog = getDayLog(profile.id, state.ui.activeDate, profile);
      const mealTarget = profile.mealTargets && profile.mealTargets[mealKey];
      const entries = dayLog[mealKey] || [];
      const outer = el('div', { class: 'notebook-outer' });
      outer.appendChild(el('div', { class: 'notebook-backing' }));
      outer.appendChild(el('div', { class: 'notebook-ribbon' }));
      const page = el('div', { class: 'notebook-page' });
      page.appendChild(el('h2', {}, mealLabel));
      if (mealTarget) {
        page.appendChild(el('p', { class: 'meal-target-note' },
          `Objetivo: ${fmt(mealTarget.kcal)} kcal · ${fmt(mealTarget.prot)}P ${fmt(mealTarget.carb)}C ${fmt(mealTarget.fat)}G`));
      }
      if (isExtra) {
        page.appendChild(el('button', {
          class: 'link-btn', onclick: () => {
            if (!confirm(`¿Quitar "${mealLabel}" de tus comidas?`)) return;
            profile.extraMealSlots = profile.extraMealSlots.filter(s => s.id !== mealKey);
            persistProfiles(); closeModal(); render();
          }
        }, 'quitar esta comida extra'));
      }
      const list = el('div', { class: 'entry-list' });
      entries.forEach((entry, idx) => list.appendChild(renderEntryRow(profile, mealKey, entry, idx, refresh)));
      page.appendChild(list);
      page.appendChild(renderAddEntryControls(profile, mealKey, refresh));
      outer.appendChild(page);
      body.appendChild(outer);
    }
    refresh();
  }, { noHeader: true });
}

function addEntry(profile, mealKey, entry, onDone) {
  const before = JSON.parse(JSON.stringify(getDayLog(profile.id, state.ui.activeDate)));
  getDayLog(profile.id, state.ui.activeDate)[mealKey].push(entry);
  persistLogs();
  render();
  if (onDone) onDone();
  checkWarnings(profile, mealKey, before, getDayLog(profile.id, state.ui.activeDate));
}

function renderEntryRow(profile, mealKey, entry, idx, onChange) {
  const m = entryMacros(entry);
  let title = '';
  let entryLines = '';
  let editBtn = null;
  const notify = () => { persistLogs(); render(); if (onChange) onChange(); };
  if (entry.type === 'preset' || entry.type === 'custommeal' || entry.type === 'meal') {
    const opt = findMealOption(entry.refId);
    title = opt ? opt.name : '(opción eliminada)';
    entryLines = opt && opt.lines ? opt.lines.join(' · ') : '';
    editBtn = el('button', { class: 'link-btn', onclick: () => openRationModal(profile, mealKey, entry, idx, () => openMealDetailModal(profile, mealKey)) }, 'ajustar ración');
  } else if (entry.type === 'custom') {
    const food = findIngredient(entry.foodId);
    title = food ? food.name : '(alimento eliminado)';
    const unit = food && food.basis === 'perUnit' ? 'ud' : 'g';
    editBtn = el('span', { class: 'entry-scale' }, [
      el('input', {
        type: 'number', min: '0.5', step: unit === 'ud' ? '0.5' : '1', value: entry.grams, class: 'scale-input',
        onchange: (e) => { entry.grams = Number(e.target.value) || 0; notify(); }
      }), ' ' + unit
    ]);
  } else if (entry.type === 'drink') {
    title = entry.name;
    editBtn = el('span', { class: 'entry-scale' }, [
      el('input', {
        type: 'number', min: '1', step: '10', value: entry.ml, class: 'scale-input',
        onchange: (e) => { entry.ml = Number(e.target.value) || 0; notify(); }
      }), ' ml'
    ]);
  } else {
    title = entry.name || 'Entrada libre';
  }

  return el('div', { class: 'entry-row' }, [
    el('div', { class: 'entry-main' }, [el('div', { class: 'entry-title' }, title), editBtn]),
    entryLines ? el('div', { class: 'entry-lines' }, entryLines) : null,
    el('div', { class: 'entry-macros mono' }, `${fmt(m.kcal)} kcal · ${fmt(m.prot)}P ${fmt(m.carb)}C ${fmt(m.fat)}G`),
    el('button', {
      class: 'btn-remove', 'aria-label': 'Eliminar',
      onclick: () => { getDayLog(profile.id, state.ui.activeDate)[mealKey].splice(idx, 1); notify(); }
    }, '✕')
  ]);
}

// ---------- Popup de ración por ingrediente ----------
function openRationModal(profile, mealKey, existingEntry, existingIdx, returnTo) {
  const isEdit = !!existingEntry;
  openModal(isEdit ? 'Ajustar ración' : `Elegir ${MEAL_TAG_LABELS[mealKey].toLowerCase()}`, (body, close) => {
    let selectedId = isEdit ? existingEntry.refId : null;
    const optionsList = optionsForMeal(mealKey, profile);

    const pickerWrap = el('div', {});
    body.appendChild(pickerWrap);

    function renderPicker() {
      pickerWrap.innerHTML = '';
      if (!isEdit) {
        const sel = selectEl(optionsList.map(o => ({ value: o.id, label: `${o.name} — ${fmt(mealTotals(o).kcal)} kcal` })), selectedId, (v) => { selectedId = v; renderDetail(); }, 'Elegir plato…');
        pickerWrap.appendChild(sel);
      }
      pickerWrap.appendChild(detailBox);
    }
    const detailBox = el('div', { class: 'ration-detail' });

    let pcts = [];
    function renderDetail() {
      detailBox.innerHTML = '';
      const opt = findMealOption(selectedId);
      if (!opt) return;
      if (isEdit) pcts = existingEntry.ingredientPcts ? [...existingEntry.ingredientPcts] : (opt.ingredients || []).map(() => 100);
      else pcts = (opt.ingredients || []).map(() => 100);

      if (opt.lines && opt.lines.length) detailBox.appendChild(el('p', { class: 'note' }, opt.lines.join(' · ')));
      if (opt.ingredients && opt.ingredients.length) {
        detailBox.appendChild(el('p', { class: 'note' }, 'Ajusta cuánto has comido de cada ingrediente (100% = ración completa).'));
        const previewBox = el('div', { class: 'ration-preview mono' });
        function updatePreview() {
          let t = { kcal: 0, prot: 0, carb: 0, fat: 0 };
          opt.ingredients.forEach((ing, i) => {
            const base = ingredientRate(ing);
            const f = pcts[i] / 100;
            t.kcal += base.kcal * f; t.prot += base.prot * f; t.carb += base.carb * f; t.fat += base.fat * f;
          });
          previewBox.textContent = `Total: ${fmt(t.kcal)} kcal · ${fmt(t.prot)}P ${fmt(t.carb)}C ${fmt(t.fat)}G`;
        }
        opt.ingredients.forEach((ing, i) => {
          const cat = findIngredient(ing.ingredientId);
          const pctLabel = el('span', { class: 'mono ing-pct' }, pcts[i] + '%');
          const range = el('input', {
            type: 'range', min: '0', max: '150', step: '5', value: pcts[i], class: 'ing-range',
            oninput: (e) => { pcts[i] = Number(e.target.value); pctLabel.textContent = pcts[i] + '%'; updatePreview(); }
          });
          detailBox.appendChild(el('div', { class: 'ing-row' }, [
            el('div', { class: 'ing-name' }, cat ? cat.name : '(ingrediente eliminado)'),
            range, pctLabel
          ]));
        });
        updatePreview();
        detailBox.appendChild(previewBox);
      } else {
        detailBox.appendChild(el('p', { class: 'note' }, 'Este plato no tiene desglose por ingrediente: ajusta el % de la ración completa.'));
        const pctInput = numberInput(isEdit ? (existingEntry.scalePct ?? 100) : 100, () => {}, 5, 0, 300);
        pctInput.id = 'flat-pct-input';
        detailBox.appendChild(field('% de la ración', pctInput));
      }

      const saveBtn = el('button', {
        class: 'btn-primary', onclick: () => {
          const opt2 = findMealOption(selectedId);
          const newEntry = { type: 'meal', refId: selectedId };
          if (opt2.ingredients && opt2.ingredients.length) {
            newEntry.ingredientPcts = pcts;
          } else {
            const flatInput = document.getElementById('flat-pct-input');
            newEntry.scalePct = flatInput ? (Number(flatInput.value) || 100) : 100;
          }
          if (isEdit) {
            Object.assign(existingEntry, newEntry);
            persistLogs(); render();
            if (returnTo) returnTo(); else close();
          } else {
            close();
            addEntry(profile, mealKey, newEntry, returnTo);
          }
        }
      }, isEdit ? 'Guardar cambios' : 'Añadir');
      detailBox.appendChild(saveBtn);
    }

    renderPicker();
    if (isEdit) renderDetail();
  });
}

function renderAddEntryControls(profile, mealKey, onChange) {
  const wrap = el('div', { class: 'add-controls' });

  const options = optionsForMeal(mealKey, profile);
  const groups = [];
  options.forEach(opt => {
    const g = opt.group || '';
    let grp = groups.find(x => x.name === g);
    if (!grp) { grp = { name: g, items: [] }; groups.push(grp); }
    grp.items.push(opt);
  });
  groups.forEach(grp => {
    if (grp.name) wrap.appendChild(el('h4', { class: 'dish-group-title' }, grp.name));
    const carousel = el('div', { class: 'dish-carousel' });
    grp.items.forEach(opt => {
      const t = mealTotals(opt);
      carousel.appendChild(el('button', {
        class: 'dish-card',
        onclick: () => addEntry(profile, mealKey, { type: 'meal', refId: opt.id, scalePct: 100 }, onChange)
      }, [
        el('div', { class: 'dish-card-icon' }, opt.icon || '🍽️'),
        el('div', { class: 'dish-card-name' }, opt.name),
        opt.lines && opt.lines.length ? el('div', { class: 'dish-card-lines' }, opt.lines.map(l => el('div', {}, l))) : null,
        opt.note ? el('div', { class: 'dish-card-note' }, opt.note) : null,
        el('div', { class: 'dish-card-kcal mono' }, `${fmt(t.kcal)} kcal`),
        el('div', { class: 'dish-card-macros mono' }, `${fmt(t.prot)}P ${fmt(t.carb)}C ${fmt(t.fat)}G`)
      ]));
    });
    wrap.appendChild(carousel);
  });
  if (mealKey === 'comida') wrap.appendChild(el('p', { class: 'note carousel-hint' }, 'En la comida: un primero + un segundo + el pan (60 g, 150 kcal).'));
  wrap.appendChild(el('p', { class: 'note carousel-hint' }, 'Toca un plato para añadirlo entero; luego puedes "ajustar ración" si no te lo has comido completo.'));

  const foods = foodsForMeal(mealKey);
  if (foods.length > 0) {
    const foodSelect = selectEl(foods.map(f => ({ value: f.id, label: `${f.name} (${fmt(f.kcal)} kcal/${f.basis === 'perUnit' ? 'ud' : '100g'})` })), '', () => {}, 'Añadir un alimento tuyo…');
    foodSelect.className = 'select-food';
    const gramsInput = el('input', { type: 'number', placeholder: 'g', min: '0.5', class: 'grams-input', value: '100' });
    const addFoodBtn = el('button', {
      class: 'btn-secondary',
      onclick: () => {
        if (!foodSelect.value) return;
        const grams = Number(gramsInput.value) || 0;
        if (grams <= 0) return;
        addEntry(profile, mealKey, { type: 'custom', foodId: foodSelect.value, grams }, onChange);
      }
    }, 'Añadir');
    wrap.appendChild(el('div', { class: 'add-row' }, [foodSelect, gramsInput, addFoodBtn]));
  }

  const freeBtn = el('button', {
    class: 'link-btn',
    onclick: () => {
      const name = prompt('¿Qué has comido?');
      if (!name) return;
      const kcal = Number(prompt('Calorías (kcal):', '0')) || 0;
      const prot = Number(prompt('Proteína (g):', '0')) || 0;
      const carb = Number(prompt('Carbohidratos (g):', '0')) || 0;
      const fat = Number(prompt('Grasas (g):', '0')) || 0;
      addEntry(profile, mealKey, { type: 'freeform', name, kcal, prot, carb, fat }, onChange);
    }
  }, '+ entrada libre (algo que no está en la lista)');
  wrap.appendChild(el('button', { class: 'btn-secondary photo-add-btn', onclick: () => openPhotoAddModal(profile, mealKey, onChange) }, '📷 Foto de la etiqueta → añadir'));
  wrap.appendChild(freeBtn);
  return wrap;
}

// Foto de la tabla nutricional -> se lee y se añade directamente a la comida (solo hay que decir cuántos gramos)
function openPhotoAddModal(profile, mealKey, onChange) {
  openScanModal((vals) => {
    openModal('Añadir desde la foto', (body, close) => {
      const nameIn = el('input', { type: 'text', value: vals.name || '', placeholder: 'Nombre del producto' });
      const gramsIn = el('input', { type: 'number', value: '100', min: '1', step: '1' });
      const kcalIn = numberInput(vals.kcal ?? '', () => update());
      const protIn = numberInput(vals.prot ?? '', () => update());
      const carbIn = numberInput(vals.carb ?? '', () => update());
      const fatIn = numberInput(vals.fat ?? '', () => update());
      const preview = el('p', { class: 'ration-preview mono' });
      function scaled() {
        const f = (Number(gramsIn.value) || 0) / 100;
        return { kcal: round1((Number(kcalIn.value) || 0) * f), prot: round1((Number(protIn.value) || 0) * f),
                 carb: round1((Number(carbIn.value) || 0) * f), fat: round1((Number(fatIn.value) || 0) * f) };
      }
      function update() { const t = scaled(); preview.textContent = `Te comes: ${fmt(t.kcal)} kcal · ${fmt(t.prot)}P ${fmt(t.carb)}C ${fmt(t.fat)}G`; }
      gramsIn.addEventListener('input', update);
      body.appendChild(el('p', { class: 'note' }, 'Revisa los valores por 100 g (la lectura de la foto puede fallar) e indica cuántos gramos te vas a comer.'));
      body.appendChild(field('Producto', nameIn));
      body.appendChild(el('div', { class: 'form-grid' }, [field('Kcal /100g', kcalIn), field('Proteína', protIn), field('Carbohidratos', carbIn), field('Grasas', fatIn)]));
      body.appendChild(field('Gramos que te comes', gramsIn));
      body.appendChild(preview);
      update();
      body.appendChild(el('button', {
        class: 'btn-primary', onclick: () => {
          const t = scaled();
          if (!t.kcal && !t.prot && !t.carb && !t.fat) { alertModal('Faltan datos', 'Rellena al menos las calorías por 100 g.'); return; }
          const g = Number(gramsIn.value) || 0;
          close();
          addEntry(profile, mealKey, { type: 'freeform', name: `${(nameIn.value || 'Producto').trim()} (${fmt(g)} g)`, ...t }, onChange);
        }
      }, 'Añadir a ' + mealLabelFor(profile, mealKey).toLowerCase()));
    });
  });
}

// ---------- Bebidas ----------
const DRINK_ICONS = {
  cerveza: '🍺', radler: '🍺', cocacola: '🥤', cocacola_zero: '🥤', kas_naranja: '🥤', kas_naranja_zero: '🥤',
  fanta_naranja: '🧃', fanta_limon: '🧃', sprite: '🥤', tonica: '🥤', aquarius: '🧃',
  leche_entera: '🥛', leche_desnatada: '🥛', cafe_solo: '☕', cafe_con_leche: '☕', zumo_naranja: '🧃'
};
const DRINK_DEFAULT_ML = { cerveza: 330, radler: 330, cafe_solo: 60, cafe_con_leche: 200 };

function renderBebidasSection(profile, dayLog) {
  const entries = dayLog.bebidas || [];
  const subtotal = sumEntries(entries);
  const section = el('section', { class: 'meal-section paper-card' });
  section.appendChild(el('div', { class: 'paper-ribbon' }));
  section.appendChild(el('div', { class: 'meal-head-paper' }, [
    el('div', {}, [el('h3', {}, 'Bebidas'), el('span', { class: 'meal-sub mono' }, `${fmt(subtotal.kcal)} kcal`)])
  ]));
  const list = el('div', { class: 'entry-list' });
  entries.forEach((entry, idx) => {
    const m = entryMacros(entry);
    list.appendChild(el('div', { class: 'entry-row' }, [
      el('div', { class: 'entry-main' }, [el('div', { class: 'entry-title' }, entry.name), el('span', { class: 'entry-scale' }, [
        el('input', { type: 'number', min: '1', step: '10', value: entry.ml, class: 'scale-input', onchange: (e) => { entry.ml = Number(e.target.value) || 0; persistLogs(); render(); } }), ' ml'
      ])]),
      el('div', { class: 'entry-macros mono' }, `${fmt(m.kcal)} kcal · ${fmt(m.prot)}P ${fmt(m.carb)}C ${fmt(m.fat)}G`),
      el('button', { class: 'btn-remove', onclick: () => { dayLog.bebidas.splice(idx, 1); persistLogs(); render(); } }, '✕')
    ]));
  });
  section.appendChild(list);

  const grid = el('div', { class: 'drink-grid' });
  DRINKS.forEach(d => {
    grid.appendChild(el('button', {
      class: 'drink-icon-btn', title: d.name,
      onclick: () => {
        const ml = DRINK_DEFAULT_ML[d.id] || 250;
        dayLog.bebidas.push({ type: 'drink', name: d.name, ml, kcal100: d.kcal100, prot100: d.prot100, carb100: d.carb100, fat100: d.fat100 });
        persistLogs(); render();
      }
    }, [el('div', { class: 'drink-icon' }, DRINK_ICONS[d.id] || '🥤'), el('div', { class: 'drink-icon-label' }, d.name)]));
  });
  section.appendChild(grid);
  const wrap = el('div', { class: 'add-controls' });

  wrap.appendChild(el('button', { class: 'link-btn', onclick: () => openCalimochoModal(profile, dayLog) }, '+ calimocho / cubata (mezcla a tu gusto)'));
  section.appendChild(wrap);
  return section;
}

function openCalimochoModal(profile, dayLog) {
  openModal('Calimocho / cubata', (body, close) => {
    const alcSelect = selectEl(ALCOHOL_BASES.map(a => ({ value: a.id, label: a.name })), ALCOHOL_BASES[0].id, () => {});
    const alcMl = el('input', { type: 'number', value: '100', min: '0', class: 'grams-input' });
    const mixSelect = selectEl(MIXER_BASES.map(m => ({ value: m.id, label: m.name })), MIXER_BASES[0].id, () => {});
    const mixMl = el('input', { type: 'number', value: '100', min: '0', class: 'grams-input' });
    body.appendChild(field('Alcohol', alcSelect));
    body.appendChild(field('Cantidad de alcohol (ml)', alcMl));
    body.appendChild(field('Mezclador', mixSelect));
    body.appendChild(field('Cantidad de mezclador (ml)', mixMl));
    body.appendChild(el('p', { class: 'note' }, 'Los valores son medias orientativas: el grado alcohólico y el azúcar exacto varían según la marca.'));
    body.appendChild(el('button', {
      class: 'btn-primary', onclick: () => {
        const alc = ALCOHOL_BASES.find(a => a.id === alcSelect.value);
        const mix = MIXER_BASES.find(m => m.id === mixSelect.value);
        const aMl = Number(alcMl.value) || 0, mMl = Number(mixMl.value) || 0;
        const totalMl = aMl + mMl;
        if (totalMl <= 0) { close(); return; }
        const kcal = alc.kcal100 * aMl / 100 + mix.kcal100 * mMl / 100;
        const carb = alc.carb100 * aMl / 100 + mix.carb100 * mMl / 100;
        dayLog.bebidas.push({
          type: 'drink', name: `${alc.name} con ${mix.name} (${aMl}+${mMl} ml)`, ml: totalMl,
          kcal100: round1(kcal / totalMl * 100), prot100: 0, carb100: round1(carb / totalMl * 100), fat100: 0
        });
        persistLogs(); render(); close();
      }
    }, 'Añadir a bebidas'));
  });
}

// ---------------- TAB: PERFIL ----------------
function renderPerfil() {
  const profile = activeProfile();
  const wrap = el('div', { class: 'view view-perfil' });
  wrap.appendChild(el('h2', {}, `Datos de ${profile.name}`));

  const p = profile.personal;
  const form = el('div', { class: 'form-grid' });
  form.appendChild(field('Edad (años)', numberInput(p.age, v => { p.age = v; persistProfiles(); render(); })));
  form.appendChild(field('Sexo', selectEl([{ value: 'M', label: 'Hombre' }, { value: 'F', label: 'Mujer' }], p.sex, v => { p.sex = v; persistProfiles(); render(); }, 'Selecciona…')));
  form.appendChild(field('Peso (kg)', numberInput(p.weightKg, v => { p.weightKg = v; persistProfiles(); render(); }, 0.1)));
  form.appendChild(field('Altura (cm)', numberInput(p.heightCm, v => { p.heightCm = v; persistProfiles(); render(); })));
  form.appendChild(field('Tipo de trabajo', selectEl(Object.entries(JOB_LABELS).map(([k, l]) => ({ value: k, label: l })), p.jobActivity, v => { p.jobActivity = v; persistProfiles(); render(); }, 'Selecciona…')));
  form.appendChild(field('Tipo de ejercicio', selectEl(Object.entries(EXERCISE_LABELS).map(([k, l]) => ({ value: k, label: l })), p.exerciseType, v => { p.exerciseType = v; persistProfiles(); render(); }, 'Selecciona…')));
  form.appendChild(field('Días de ejercicio / semana', numberInput(p.exerciseDays, v => { p.exerciseDays = v; persistProfiles(); render(); }, 1, 0, 7)));
  form.appendChild(field('Intensidad del ejercicio', selectEl([{ value: 'baja', label: 'Baja' }, { value: 'moderada', label: 'Moderada' }, { value: 'alta', label: 'Alta' }], p.exerciseIntensity || 'moderada', v => { p.exerciseIntensity = v; persistProfiles(); render(); })));
  wrap.appendChild(form);

  // Objetivo físico (goal) — ajusta déficit/proteína/grasa por defecto
  wrap.appendChild(el('h3', {}, '¿Qué buscas ahora mismo?'));
  const goalSelect = selectEl(Object.entries(GOAL_PRESETS).map(([k, g]) => ({ value: k, label: g.label })), profile.goal, (v) => {
    profile.goal = v;
    const preset = GOAL_PRESETS[v];
    profile.deficitKcal = preset.deficitKcal;
    profile.proteinPerKg = preset.proteinPerKg;
    profile.fatPerKg = preset.fatPerKg;
    persistProfiles(); render();
  });
  wrap.appendChild(field('Objetivo físico', goalSelect));
  wrap.appendChild(el('p', { class: 'note' }, 'Al elegir uno se rellenan el déficit/superávit y los gramos de proteína y grasa por defecto — puedes ajustarlos a mano justo debajo.'));

  const maint = calcMaintenance(p);
  const suggested = calcSuggestedTarget(profile);
  const calcBox = el('div', { class: 'calc-box' });
  if (maint) {
    calcBox.appendChild(el('p', {}, [el('strong', {}, 'Mantenimiento estimado: '), `${fmt(maint)} kcal/día `, el('span', { class: 'note' }, '(fórmula de Mifflin-St Jeor, ±10% orientativo)')]));
    calcBox.appendChild(field('Déficit / superávit (kcal, negativo = déficit)', numberInput(profile.deficitKcal, v => { profile.deficitKcal = v; persistProfiles(); render(); }, 50)));
    calcBox.appendChild(field('Proteína objetivo (g / kg de peso)', numberInput(profile.proteinPerKg, v => { profile.proteinPerKg = v; persistProfiles(); render(); }, 0.05, 0.5, 3)));
    calcBox.appendChild(field('Grasa objetivo (g / kg de peso)', numberInput(profile.fatPerKg, v => { profile.fatPerKg = v; persistProfiles(); render(); }, 0.05, 0.3, 2)));
    if (suggested) {
      calcBox.appendChild(el('div', { class: 'suggested-target' }, [
        el('p', {}, [el('strong', {}, 'Objetivo calculado: '), `${fmt(suggested.kcal)} kcal · ${fmt(suggested.prot)}g proteína · ${fmt(suggested.carb)}g carbohidratos · ${fmt(suggested.fat)}g grasas`]),
        el('button', { class: 'btn-primary', onclick: () => applyNewTarget(profile, { kcal: suggested.kcal, prot: suggested.prot, carb: suggested.carb, fat: suggested.fat }) }, 'Aplicar como objetivo y recalcular raciones')
      ]));
    }
  } else {
    calcBox.appendChild(el('p', { class: 'note' }, 'Completa edad, sexo, peso y altura para calcular el mantenimiento.'));
  }
  wrap.appendChild(calcBox);

  wrap.appendChild(el('h3', {}, 'Objetivo diario'));
  const manualBox = el('div', { class: 'manual-target-box' });
  const mt = profile.manualTarget || { kcal: '', prot: '', carb: '', fat: '' };
  const kcalIn = numberInput(mt.kcal, () => {});
  const protIn = numberInput(mt.prot, () => {});
  const carbIn = numberInput(mt.carb, () => {});
  const fatIn = numberInput(mt.fat, () => {});
  manualBox.appendChild(el('div', { class: 'form-grid' }, [field('Calorías (kcal)', kcalIn), field('Proteína (g)', protIn), field('Carbohidratos (g)', carbIn), field('Grasas (g)', fatIn)]));
  manualBox.appendChild(el('button', {
    class: 'btn-secondary',
    onclick: () => applyNewTarget(profile, { kcal: Number(kcalIn.value) || 0, prot: Number(protIn.value) || 0, carb: Number(carbIn.value) || 0, fat: Number(fatIn.value) || 0 })
  }, 'Guardar este objetivo y recalcular raciones'));
  wrap.appendChild(manualBox);

  wrap.appendChild(el('h3', {}, 'Reparto por comida'));
  if (profile.mealTargets) {
    const table = el('table', { class: 'meal-target-table' });
    table.appendChild(el('tr', {}, ['Comida', 'Kcal', 'Prot (g)', 'Carb (g)', 'Grasa (g)'].map(h => el('th', {}, h))));
    for (const mk of MEAL_KEYS) {
      const t = profile.mealTargets[mk];
      table.appendChild(el('tr', {}, [
        el('td', {}, MEAL_TAG_LABELS[mk]),
        el('td', {}, numberInput(t.kcal, v => { t.kcal = v; persistProfiles(); render(); })),
        el('td', {}, numberInput(t.prot, v => { t.prot = v; persistProfiles(); render(); })),
        el('td', {}, numberInput(t.carb, v => { t.carb = v; persistProfiles(); render(); })),
        el('td', {}, numberInput(t.fat, v => { t.fat = v; persistProfiles(); render(); }))
      ]));
    }
    wrap.appendChild(table);
    const totals = sumMealTargets(profile.mealTargets);
    wrap.appendChild(el('p', { class: 'note' }, `Suma del reparto: ${fmt(totals.kcal)} kcal · ${fmt(totals.prot)}P / ${fmt(totals.carb)}C / ${fmt(totals.fat)}G`));
  } else {
    wrap.appendChild(el('p', { class: 'note' }, 'Define primero un objetivo diario arriba para repartirlo entre las comidas.'));
  }
  wrap.appendChild(renderVersionFooter());
  return wrap;
}

function applyNewTarget(profile, newTotal) {
  const oldTotal = profile.mealTargets ? sumMealTargets(profile.mealTargets) : null;
  profile.manualTarget = newTotal;
  if (profile.mealTargets && oldTotal && (oldTotal.kcal || oldTotal.prot || oldTotal.carb || oldTotal.fat)) {
    profile.mealTargets = scaleMealTargetsProportionally(profile.mealTargets, oldTotal, newTotal);
  } else {
    const shares = { almuerzo: 0.25, comida: 0.35, merienda: 0.15, cena: 0.25 };
    profile.mealTargets = {};
    for (const mk of MEAL_KEYS) {
      profile.mealTargets[mk] = { kcal: round1(newTotal.kcal * shares[mk]), prot: round1(newTotal.prot * shares[mk]), carb: round1(newTotal.carb * shares[mk]), fat: round1(newTotal.fat * shares[mk]) };
    }
  }
  persistProfiles(); render();
}

// ---------------- TAB: CALENDARIO ----------------
function renderCalendario() {
  const profile = activeProfile();
  const wrap = el('div', { class: 'view view-calendario' });
  wrap.appendChild(el('h2', {}, `Calendario de ${profile.name}`));

  const target = getEffectiveTarget(profile);
  if (!target) {
    wrap.appendChild(el('p', { class: 'note' }, 'Define un objetivo diario en "Perfil y objetivo" para ver el calendario.'));
    return wrap;
  }

  const [yearStr, monthStr] = state.ui.calMonth.split('-');
  const year = Number(yearStr), month = Number(monthStr); // month 1-12
  const monthNames = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

  const nav = el('div', { class: 'date-row' }, [
    el('button', { class: 'btn-icon', onclick: () => shiftMonth(-1) }, '‹'),
    el('div', { class: 'cal-month-label' }, `${monthNames[month - 1]} ${year}`),
    el('button', { class: 'btn-icon', onclick: () => shiftMonth(1) }, '›')
  ]);
  wrap.appendChild(nav);

  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  let startWeekday = firstDay.getDay(); // 0=domingo
  startWeekday = (startWeekday + 6) % 7; // lunes=0

  const grid = el('div', { class: 'cal-grid' });
  ['L','M','X','J','V','S','D'].forEach(d => grid.appendChild(el('div', { class: 'cal-dow' }, d)));
  for (let i = 0; i < startWeekday; i++) grid.appendChild(el('div', { class: 'cal-cell empty' }));

  let monthDelta = 0;
  let loggedDays = 0;
  const weeks = {}; // weekIndex -> { firstDay, lastDay, loggedDays, actual, target }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const key = logKey(profile.id, dateStr);
    const dayLog = state.logs[key];
    const weekIndex = Math.floor((startWeekday + day - 1) / 7);
    if (!weeks[weekIndex]) weeks[weekIndex] = { firstDay: day, lastDay: day, loggedDays: 0, actual: { kcal: 0, prot: 0, carb: 0, fat: 0 }, target: { kcal: 0, prot: 0, carb: 0, fat: 0 } };
    weeks[weekIndex].lastDay = day;

    let cls = 'cal-cell';
    if (dayLog) {
      const t = dayTotals(dayLog, profile);
      const hasEntries = [...LOG_BUCKETS, ...profile.extraMealSlots.map(s => s.id)].some(b => (dayLog[b] || []).length > 0);
      if (hasEntries) {
        loggedDays++;
        const dayTargetKcal = target.kcal + (dayLog.ejercicio || 0);
        const delta = dayTargetKcal - t.kcal; // positivo = déficit
        monthDelta += delta;
        if (delta > 100) cls += ' cal-green';
        else if (delta < -100) cls += ' cal-red';
        else cls += ' cal-yellow';
        const w = weeks[weekIndex];
        w.loggedDays++;
        w.actual.kcal += t.kcal; w.actual.prot += t.prot; w.actual.carb += t.carb; w.actual.fat += t.fat;
        w.target.kcal += dayTargetKcal; w.target.prot += target.prot; w.target.carb += target.carb; w.target.fat += target.fat;
      }
    }
    if (dateStr === todayISO()) cls += ' cal-today';
    grid.appendChild(el('div', {
      class: cls, onclick: () => { state.ui.activeDate = dateStr; state.ui.activeTab = 'hoy'; persistUI(); render(); }
    }, String(day)));
  }
  wrap.appendChild(grid);

  wrap.appendChild(el('div', { class: 'cal-legend' }, [
    el('span', { class: 'legend-dot cal-green' }), 'déficit', el('span', { class: 'legend-dot cal-yellow' }), 'neutro (±100 kcal)',
    el('span', { class: 'legend-dot cal-red' }), 'superávit'
  ]));

  const summaryBox = el('div', { class: 'calc-box' });
  if (loggedDays > 0) {
    const estimatedKg = monthDelta / 7700;
    summaryBox.appendChild(el('p', {}, [el('strong', {}, `${loggedDays} días registrados este mes. `),
      `Balance acumulado: ${monthDelta >= 0 ? 'déficit' : 'superávit'} de ${fmt(Math.abs(monthDelta))} kcal.`]));
    summaryBox.appendChild(el('p', {}, [el('strong', {}, 'Estimación de peso: '),
      `${estimatedKg >= 0 ? 'pérdida' : 'ganancia'} aproximada de ${fmt(Math.abs(estimatedKg))} kg `,
      el('span', { class: 'note' }, '(usando ~7700 kcal por kg de grasa — es una estimación orientativa, el peso real también se mueve por agua, digestión y otros factores).')]));
  } else {
    summaryBox.appendChild(el('p', { class: 'note' }, 'Todavía no hay días registrados este mes.'));
  }
  wrap.appendChild(summaryBox);

  wrap.appendChild(el('h3', {}, 'Resumen semanal'));
  const weekIndexes = Object.keys(weeks).map(Number).sort((a, b) => a - b);
  const anyWeekLogged = weekIndexes.some(wi => weeks[wi].loggedDays > 0);
  if (!anyWeekLogged) {
    wrap.appendChild(el('p', { class: 'note' }, 'Todavía no hay semanas con días registrados este mes.'));
  } else {
    weekIndexes.forEach(wi => {
      const w = weeks[wi];
      if (w.loggedDays === 0) return;
      const weekBox = el('div', { class: 'week-box' });
      weekBox.appendChild(el('p', { class: 'week-range' }, [
        el('strong', {}, `Semana del ${w.firstDay} al ${w.lastDay}`), ` — ${w.loggedDays} día${w.loggedDays === 1 ? '' : 's'} registrado${w.loggedDays === 1 ? '' : 's'}`
      ]));
      weekBox.appendChild(renderCounterBoard(w.actual, w.target));
      wrap.appendChild(weekBox);
    });
  }
  return wrap;
}
function shiftMonth(delta) {
  const [y, m] = state.ui.calMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.ui.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  persistUI(); render();
}

// ---------------- CALCULADORA: RACIONES FAMILIARES (botón flotante) ----------------
function buildRacionesContent(wrap) {
  wrap.appendChild(el('p', { class: 'note' }, 'Cuando se cocina una olla grande para toda la familia, esta calculadora saca cuánto te corresponde ya cocinado, a partir del peso en crudo que te toca.'));

  const totalCrudo = el('input', { type: 'number', min: '0', placeholder: 'p. ej. 1200' });
  const totalCocido = el('input', { type: 'number', min: '0', placeholder: 'p. ej. 1500' });
  const gramosCrudos = el('input', { type: 'number', min: '0', placeholder: 'p. ej. 200' });
  const resultado = el('div', { class: 'racion-resultado' });

  function calcular() {
    const tc = Number(totalCrudo.value), tco = Number(totalCocido.value), gc = Number(gramosCrudos.value);
    if (!tc || !tco || !gc) { resultado.textContent = ''; return; }
    const factor = tco / tc;
    const racionCocida = gc * factor;
    resultado.innerHTML = '';
    resultado.appendChild(el('p', { class: 'racion-highlight' }, `Te tocan ${fmt(racionCocida)} g ya cocinados de la olla.`));
    resultado.appendChild(el('p', { class: 'note' }, `Factor de cocción: ${fmt(factor)}× (por cada 100 g en crudo, salen ${fmt(factor * 100)} g cocidos).`));
  }
  [totalCrudo, totalCocido, gramosCrudos].forEach(i => i.addEventListener('input', calcular));

  wrap.appendChild(el('div', { class: 'form-grid' }, [
    field('Peso total en crudo echado a la olla (g)', totalCrudo),
    field('Peso total ya cocinado de la olla (g)', totalCocido),
    field('Gramos en crudo que te corresponden a ti (g)', gramosCrudos)
  ]));
  wrap.appendChild(resultado);
  wrap.appendChild(el('div', { class: 'tips-box' }, [
    el('h3', {}, 'Recordatorios'),
    el('p', {}, 'El aceite u otras grasas añadidas no se "cocinan" ni cambian de peso: repártelo aparte, proporcional a tu ración, sin aplicar el factor de cocción.'),
    el('p', {}, 'Las verduras libres (lechuga, pepino, calabacín, champiñones…) no hace falta pesarlas con tanta precisión: son bajas en calorías y puedes servirte con generosidad.')
  ]));
}

// ---------------- TAB: MIS ALIMENTOS ----------------

function mealTypeCheckboxes(selected) {
  const wrap = el('div', { class: 'meal-tag-checks' });
  const state_ = { selected: [...selected] };
  MEAL_KEYS.forEach(mk => {
    const id = 'chk-' + mk + '-' + Math.random().toString(36).slice(2,6);
    const checked = state_.selected.includes(mk);
    const cb = el('input', { type: 'checkbox', id, checked: checked });
    cb.addEventListener('change', () => {
      if (cb.checked) { if (!state_.selected.includes(mk)) state_.selected.push(mk); }
      else { state_.selected = state_.selected.filter(x => x !== mk); }
    });
    wrap.appendChild(el('label', { class: 'meal-tag-check', for: id }, [cb, MEAL_TAG_LABELS[mk]]));
  });
  wrap.getSelected = () => state_.selected;
  return wrap;
}

// ---------------- TAB: ALIMENTOS (catálogo unificado) ----------------
const FOOD_CATEGORIES = ['Proteínas', 'Carbohidratos', 'Grasas', 'Verduras', 'Frutas', 'Lácteos', 'Otros'];

function renderAlimentos() {
  const wrap = el('div', { class: 'view view-alimentos' });
  wrap.appendChild(el('h2', {}, 'Alimentos'));

  let filter = 'todos'; // 'todos' | 'mios'
  let query = '';
  const filterRow = el('div', { class: 'subtab-row' });
  const searchInput = el('input', { type: 'text', placeholder: '🔍 Buscar alimento…', class: 'search-input' });
  const addRowBox = el('div', {});
  const tableBox = el('div', {});

  function renderFilterButtons() {
    filterRow.innerHTML = '';
    filterRow.appendChild(el('button', { class: 'subtab' + (filter === 'todos' ? ' active' : ''), onclick: () => { filter = 'todos'; renderFilterButtons(); renderTable(); } }, 'Todos'));
    filterRow.appendChild(el('button', { class: 'subtab' + (filter === 'mios' ? ' active' : ''), onclick: () => { filter = 'mios'; renderFilterButtons(); renderTable(); } }, 'Los míos'));
  }

  function matchesQuery(f) { return !query || f.name.toLowerCase().includes(query.toLowerCase()); }

  function renderTable() {
    tableBox.innerHTML = '';
    const items = state.ingredientsCatalog.filter(f => (filter === 'todos' || f.source === 'custom') && matchesQuery(f))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    if (!items.length) {
      tableBox.appendChild(el('p', { class: 'note' }, 'No hay alimentos que coincidan.'));
      return;
    }
    const table = el('table', { class: 'data-table' });
    table.appendChild(el('tr', {}, ['Nombre', 'Categoría', 'Kcal', 'Prot', 'Carb', 'Grasa', ''].map(h => el('th', {}, h))));
    items.forEach(food => table.appendChild(renderFoodRow(food)));
    tableBox.appendChild(table);
  }

  function renderFoodRow(food) {
    let editing = false;
    const row = el('tr', {});
    function draw() {
      row.innerHTML = '';
      const unit = food.basis === 'perUnit' ? '/ud' : '/100g';
      if (!editing) {
        row.appendChild(el('td', {}, food.name));
        row.appendChild(el('td', {}, food.category || 'Otros'));
        row.appendChild(el('td', { class: 'mono' }, fmt(food.kcal)));
        row.appendChild(el('td', { class: 'mono' }, fmt(food.prot)));
        row.appendChild(el('td', { class: 'mono' }, fmt(food.carb)));
        row.appendChild(el('td', { class: 'mono' }, fmt(food.fat)));
        row.appendChild(el('td', { class: 'table-actions' }, [
          el('button', { class: 'link-btn', onclick: () => { editing = true; draw(); } }, '✎'),
          el('button', {
            class: 'btn-remove', onclick: () => {
              if (!confirm(`¿Eliminar "${food.name}"? Los platos que lo usen se quedarán sin ese ingrediente.`)) return;
              state.ingredientsCatalog = state.ingredientsCatalog.filter(f => f.id !== food.id);
              persistCatalog(); renderTable();
            }
          }, '✕')
        ]));
      } else {
        const nameIn = el('input', { type: 'text', value: food.name, class: 'table-input' });
        const catSel = selectEl(FOOD_CATEGORIES.map(c => ({ value: c, label: c })), food.category || 'Otros', () => {});
        const kcalIn = el('input', { type: 'number', value: food.kcal, class: 'table-input-num' });
        const protIn = el('input', { type: 'number', value: food.prot, class: 'table-input-num' });
        const carbIn = el('input', { type: 'number', value: food.carb, class: 'table-input-num' });
        const fatIn = el('input', { type: 'number', value: food.fat, class: 'table-input-num' });
        row.appendChild(el('td', {}, nameIn));
        row.appendChild(el('td', {}, catSel));
        row.appendChild(el('td', {}, kcalIn));
        row.appendChild(el('td', {}, protIn));
        row.appendChild(el('td', {}, carbIn));
        row.appendChild(el('td', {}, fatIn));
        row.appendChild(el('td', { class: 'table-actions' }, [
          el('button', {
            class: 'link-btn', onclick: () => {
              if (!nameIn.value.trim()) return;
              Object.assign(food, {
                name: nameIn.value.trim(), category: catSel.value,
                kcal: Number(kcalIn.value) || 0, prot: Number(protIn.value) || 0, carb: Number(carbIn.value) || 0, fat: Number(fatIn.value) || 0
              });
              persistCatalog(); editing = false; draw();
            }
          }, '✓'),
          el('button', { class: 'link-btn', onclick: () => { editing = false; draw(); } }, '✕')
        ]));
      }
    }
    draw();
    return row;
  }

  searchInput.addEventListener('input', (e) => { query = e.target.value; renderTable(); });
  wrap.appendChild(searchInput);
  renderFilterButtons();
  wrap.appendChild(filterRow);
  wrap.appendChild(addRowBox);
  addRowBox.appendChild(renderAddFoodForm(() => renderTable()));
  wrap.appendChild(tableBox);
  renderTable();
  return wrap;
}

// ---------- Escaneo de etiquetas (OCR gratuito, local) ----------
function parseNutritionText(text) {
  const lines = text.split('\n').map(l => l.toLowerCase().trim()).filter(Boolean);
  const result = { kcal: null, prot: null, carb: null, fat: null };
  function firstNumber(s) {
    const m = s.match(/(\d+[.,]?\d*)/);
    if (!m) return null;
    return parseFloat(m[1].replace(',', '.'));
  }
  for (const line of lines) {
    if (result.kcal === null && (line.includes('kcal') || line.includes('energ')) && !line.includes('kj')) {
      const n = firstNumber(line);
      if (n !== null && n < 3000) result.kcal = n;
    }
    if (result.prot === null && (line.includes('proteín') || line.includes('proteina'))) {
      const n = firstNumber(line);
      if (n !== null) result.prot = n;
    }
    if (result.carb === null && (line.includes('hidratos') || line.includes('carbohidratos') || line.includes('carbono')) && !line.includes('azúcar') && !line.includes('azucar')) {
      const n = firstNumber(line);
      if (n !== null) result.carb = n;
    }
    if (result.fat === null && line.includes('gras') && !line.includes('satura')) {
      const n = firstNumber(line);
      if (n !== null) result.fat = n;
    }
  }
  return result;
}

function guessProductName(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  if (!lines.length) return '';
  // primera línea "normal" (con letras, no solo números/símbolos)
  const candidate = lines.find(l => /[a-zA-ZÀ-ÿ]{3,}/.test(l)) || lines[0];
  return candidate.slice(0, 60);
}

function openScanModal(onExtracted) {
  openModal('Escanear etiqueta', (body, close) => {
    if (typeof Tesseract === 'undefined') {
      body.appendChild(el('p', { class: 'modal-msg tone-warn' }, 'No se ha podido cargar el lector de texto (revisa tu conexión a internet) — puedes rellenar los datos a mano.'));
      body.appendChild(el('button', { class: 'btn-secondary', onclick: close }, 'Cerrar'));
      return;
    }
    body.appendChild(el('p', { class: 'note' }, 'Haz una foto de la tabla de macros del envase (cuanto más recta y con buena luz, mejor). Si quieres, añade también una foto del envase para intentar sacar el nombre.'));

    const nameFileIn = el('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    const macrosFileIn = el('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    const statusBox = el('p', { class: 'note mono' });
    const previewBox = el('div', {});

    body.appendChild(field('Foto del envase (opcional, para el nombre)', nameFileIn));
    body.appendChild(field('Foto de la tabla de macros', macrosFileIn));
    const goBtn = el('button', { class: 'btn-primary', onclick: runScan }, 'Analizar fotos');
    body.appendChild(goBtn);
    body.appendChild(statusBox);
    body.appendChild(previewBox);

    async function runScan() {
      if (!macrosFileIn.files[0]) { statusBox.textContent = 'Falta la foto de la tabla de macros.'; return; }
      goBtn.disabled = true;
      previewBox.innerHTML = '';
      try {
        let productName = '';
        if (nameFileIn.files[0]) {
          statusBox.textContent = 'Leyendo el envase…';
          const r1 = await Tesseract.recognize(nameFileIn.files[0], 'spa');
          productName = guessProductName(r1.data.text);
        }
        statusBox.textContent = 'Leyendo la tabla de macros…';
        const r2 = await Tesseract.recognize(macrosFileIn.files[0], 'spa');
        const vals = parseNutritionText(r2.data.text);
        statusBox.textContent = '';

        const kcalIn = numberInput(vals.kcal, () => {});
        const protIn = numberInput(vals.prot, () => {});
        const carbIn = numberInput(vals.carb, () => {});
        const fatIn = numberInput(vals.fat, () => {});
        const nameIn = el('input', { type: 'text', value: productName });
        previewBox.appendChild(el('p', { class: 'note' }, 'Revisa estos valores antes de usarlos — la lectura automática puede fallar:'));
        previewBox.appendChild(field('Nombre', nameIn));
        previewBox.appendChild(el('div', { class: 'form-grid' }, [field('Kcal /100g', kcalIn), field('Proteína', protIn), field('Carbohidratos', carbIn), field('Grasas', fatIn)]));
        previewBox.appendChild(el('button', {
          class: 'btn-primary', onclick: () => {
            close();
            onExtracted({ name: nameIn.value, kcal: kcalIn.value, prot: protIn.value, carb: carbIn.value, fat: fatIn.value });
          }
        }, 'Usar estos valores'));
      } catch (e) {
        console.error(e);
        statusBox.textContent = 'No se ha podido leer la imagen. Prueba con más luz o más cerca, o rellena a mano.';
      }
      goBtn.disabled = false;
    }
  });
}

function renderAddFoodForm(onAdded) {
  const box = el('div', { class: 'add-food-box' });
  const nameIn = el('input', { type: 'text', placeholder: 'Nombre', class: 'table-input' });
  const catSel = selectEl(FOOD_CATEGORIES.map(c => ({ value: c, label: c })), 'Otros', () => {});
  const basisSel = selectEl([{ value: 'per100g', label: '/100g' }, { value: 'perUnit', label: '/ud' }], 'per100g', () => {});
  const kcalIn = el('input', { type: 'number', placeholder: 'Kcal', class: 'table-input-num' });
  const protIn = el('input', { type: 'number', placeholder: 'Prot', class: 'table-input-num' });
  const carbIn = el('input', { type: 'number', placeholder: 'Carb', class: 'table-input-num' });
  const fatIn = el('input', { type: 'number', placeholder: 'Grasa', class: 'table-input-num' });

  function reset() { nameIn.value = ''; kcalIn.value = ''; protIn.value = ''; carbIn.value = ''; fatIn.value = ''; }

  const scanBtn = el('button', {
    class: 'btn-secondary', type: 'button',
    onclick: () => openScanModal((vals) => {
      if (vals.name) nameIn.value = vals.name;
      if (vals.kcal != null) kcalIn.value = vals.kcal;
      if (vals.prot != null) protIn.value = vals.prot;
      if (vals.carb != null) carbIn.value = vals.carb;
      if (vals.fat != null) fatIn.value = vals.fat;
    })
  }, '📷 Escanear etiqueta');

  const addBtn = el('button', {
    class: 'btn-primary', type: 'button',
    onclick: () => {
      if (!nameIn.value.trim()) return;
      state.ingredientsCatalog.push({
        id: uid('ing'), source: 'custom', name: nameIn.value.trim(), category: catSel.value, basis: basisSel.value,
        kcal: Number(kcalIn.value) || 0, prot: Number(protIn.value) || 0, carb: Number(carbIn.value) || 0, fat: Number(fatIn.value) || 0,
        mealTypes: []
      });
      persistCatalog(); reset(); onAdded();
    }
  }, '+ Añadir');

  box.appendChild(el('div', { class: 'add-food-row' }, [nameIn, catSel, basisSel, kcalIn, protIn, carbIn, fatIn, addBtn, scanBtn]));
  return box;
}

// ---------------- TAB: MIS COMIDAS (platos oficiales + propios, editables) ----------------
function renderComidas() {
  const profile = activeProfile();
  const wrap = el('div', { class: 'view view-comidas' });
  wrap.appendChild(el('h2', {}, 'Mis comidas'));
  wrap.appendChild(el('p', { class: 'note' }, 'Los platos salen del Excel de la dieta. Si hay alguno que no quieres ver, "ocultar" (🚫) lo quita de las listas sin borrarlo.'));

  let query = '';
  let mealFilter = 'todas';
  const searchInput = el('input', { type: 'text', placeholder: '🔍 Buscar plato…', class: 'search-input' });
  const filterRow = el('div', { class: 'subtab-row' });
  const tableBox = el('div', {});

  function renderFilterButtons() {
    filterRow.innerHTML = '';
    filterRow.appendChild(el('button', { class: 'subtab' + (mealFilter === 'todas' ? ' active' : ''), onclick: () => { mealFilter = 'todas'; renderFilterButtons(); renderTable(); } }, 'Todas'));
    MEAL_KEYS.forEach(mk => filterRow.appendChild(el('button', { class: 'subtab' + (mealFilter === mk ? ' active' : ''), onclick: () => { mealFilter = mk; renderFilterButtons(); renderTable(); } }, MEAL_TAG_LABELS[mk])));
  }

  function renderTable() {
    tableBox.innerHTML = '';
    const dishes = state.meals.filter(m =>
      (mealFilter === 'todas' || m.mealTypes.includes(mealFilter)) &&
      (!query || m.name.toLowerCase().includes(query.toLowerCase()))
    ); // mismo orden que el Excel
    if (!dishes.length) {
      tableBox.appendChild(el('p', { class: 'note' }, 'No hay platos que coincidan.'));
      return;
    }
    const table = el('table', { class: 'data-table' });
    table.appendChild(el('tr', {}, ['Plato', 'Para', 'Kcal', 'Prot', 'Carb', 'Grasa', ''].map(h => el('th', {}, h))));
    dishes.forEach(meal => table.appendChild(renderDishRow(meal)));
    tableBox.appendChild(table);
  }

  function renderDishRow(meal) {
    const hidden = profile.hiddenMealIds.includes(meal.id);
    const t = mealTotals(meal);
    const row = el('tr', { class: hidden ? 'row-hidden' : '' });
    row.appendChild(el('td', {}, [
      `${meal.icon || '🍽️'} ${meal.name}`,
      meal.lines && meal.lines.length ? el('div', { class: 'note dish-row-lines' }, meal.lines.join(' · ')) : null
    ]));
    row.appendChild(el('td', { class: 'note' }, meal.mealTypes.map(mk => MEAL_TAG_LABELS[mk] || mk).join(', ') + (meal.group ? ' · ' + meal.group : '')));
    row.appendChild(el('td', { class: 'mono' }, fmt(t.kcal)));
    row.appendChild(el('td', { class: 'mono' }, fmt(t.prot)));
    row.appendChild(el('td', { class: 'mono' }, fmt(t.carb)));
    row.appendChild(el('td', { class: 'mono' }, fmt(t.fat)));
    row.appendChild(el('td', { class: 'table-actions' }, [
      el('button', { class: 'link-btn', onclick: () => openEditMealModal(meal, renderTable) }, '✎'),
      el('button', {
        class: 'link-btn', title: hidden ? 'Mostrar' : 'Ocultar para ti', onclick: () => {
          if (hidden) profile.hiddenMealIds = profile.hiddenMealIds.filter(id => id !== meal.id);
          else profile.hiddenMealIds.push(meal.id);
          persistProfiles(); renderTable();
        }
      }, hidden ? '👁️' : '🚫'),
      el('button', {
        class: 'btn-remove', onclick: () => {
          if (!confirm(`¿Borrar "${meal.name}" para siempre? Esta acción no se puede deshacer.`)) return;
          state.meals = state.meals.filter(m => m.id !== meal.id);
          persistMeals(); renderTable();
        }
      }, '✕')
    ]));
    return row;
  }

  searchInput.addEventListener('input', (e) => { query = e.target.value; renderTable(); });
  wrap.appendChild(searchInput);
  renderFilterButtons();
  wrap.appendChild(filterRow);
  wrap.appendChild(el('button', { class: 'btn-primary', onclick: () => openEditMealModal(null, renderTable) }, '+ añadir plato nuevo'));
  wrap.appendChild(tableBox);
  renderTable();
  return wrap;
}

function openEditMealModal(meal, onSaved) {
  const isEdit = !!meal;
  const ICON_CHOICES = ['🍽️','🍗','🦃','🥩','🥓','🌭','🍔','🍕','🐟','🦐','🦑','🥚','🍳','🧀','🥛','🥣','🍝','🍚','🥔','🍞','🥪','🌯','🥞','🧆','🥟','🥦','🥗','🍅','🫑','🥕','🌽','🥜','🍎','🍌','🍊','🍇','🍓','🍑','🍒','🍍','🍪','🍩','🍫','🍦','🍰','☕','🥤','🍹','🍺','🐰','🐦'];
  let selectedIcon = isEdit ? (meal.icon || '🍽️') : '🍽️';
  let ingredients = isEdit ? JSON.parse(JSON.stringify(meal.ingredients || [])) : [];
  let useIngredients = ingredients.length > 0;

  openModal(isEdit ? 'Editar plato' : 'Nuevo plato', (body, close) => {
    const nameIn = el('input', { type: 'text', value: isEdit ? meal.name : '', placeholder: 'Nombre del plato' });
    const tagsBox = mealTypeCheckboxes(isEdit ? meal.mealTypes : []);
    body.appendChild(field('Nombre del plato', nameIn));
    const linesIn = el('textarea', { rows: '4', placeholder: 'Qué lleva (una línea por ingrediente)' });
    linesIn.value = isEdit && meal.lines ? meal.lines.join('\n') : '';
    body.appendChild(field('Qué lleva', linesIn));
    body.appendChild(field('¿Para qué comidas?', tagsBox));

    // Icono: colapsado por defecto para no estorbar
    let iconOpen = false;
    const iconToggle = el('button', { class: 'link-btn', type: 'button' }, `Icono: ${selectedIcon} (cambiar)`);
    const iconRow = el('div', { class: 'icon-picker-row', style: 'display:none' });
    ICON_CHOICES.forEach(ic => {
      iconRow.appendChild(el('button', {
        class: 'icon-choice' + (ic === selectedIcon ? ' active' : ''), type: 'button',
        onclick: () => { selectedIcon = ic; iconToggle.textContent = `Icono: ${selectedIcon} (cambiar)`; Array.from(iconRow.children).forEach(c => c.classList.remove('active')); }
      }, ic));
    });
    iconToggle.addEventListener('click', () => { iconOpen = !iconOpen; iconRow.style.display = iconOpen ? 'flex' : 'none'; });
    body.appendChild(iconToggle);
    body.appendChild(iconRow);

    const kcalIn = el('input', { type: 'number', placeholder: 'Kcal', value: isEdit ? meal.kcal ?? '' : '' });
    const protIn = el('input', { type: 'number', placeholder: 'Proteína (g)', value: isEdit ? meal.prot ?? '' : '' });
    const carbIn = el('input', { type: 'number', placeholder: 'Carbohidratos (g)', value: isEdit ? meal.carb ?? '' : '' });
    const fatIn = el('input', { type: 'number', placeholder: 'Grasas (g)', value: isEdit ? meal.fat ?? '' : '' });
    const totalsGrid = el('div', { class: 'form-grid' }, [field('Kcal', kcalIn), field('Proteína (g)', protIn), field('Carbohidratos (g)', carbIn), field('Grasas (g)', fatIn)]);
    body.appendChild(el('h3', {}, 'Macros totales del plato'));
    body.appendChild(totalsGrid);

    const ingSection = el('div', {});
    const ingListBox = el('div', { class: 'ing-edit-list' });
    const totalBox = el('p', { class: 'note mono' });
    function refreshIngList() {
      ingListBox.innerHTML = '';
      ingredients.forEach((ing, i) => {
        const cat = findIngredient(ing.ingredientId);
        const m = ingredientRate(ing);
        ingListBox.appendChild(el('div', { class: 'ing-edit-row' }, [
          el('span', {}, `${cat ? cat.name : '?'} — ${fmt(ing.qty)} ${cat && cat.basis === 'perUnit' ? 'ud' : 'g'} (${fmt(m.kcal)} kcal)`),
          el('button', { class: 'btn-remove', onclick: () => { ingredients.splice(i, 1); refreshIngList(); } }, '✕')
        ]));
      });
      const t = { kcal: 0, prot: 0, carb: 0, fat: 0 };
      ingredients.forEach(ing => { const m = ingredientRate(ing); t.kcal += m.kcal; t.prot += m.prot; t.carb += m.carb; t.fat += m.fat; });
      totalBox.textContent = ingredients.length ? `Total calculado: ${fmt(t.kcal)} kcal · ${fmt(t.prot)}P ${fmt(t.carb)}C ${fmt(t.fat)}G` : '';
      kcalIn.disabled = protIn.disabled = carbIn.disabled = fatIn.disabled = ingredients.length > 0;
      if (ingredients.length > 0) { kcalIn.value = round1(t.kcal); protIn.value = round1(t.prot); carbIn.value = round1(t.carb); fatIn.value = round1(t.fat); }
    }
    const catalogSorted = state.ingredientsCatalog.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const ingSelect = selectEl(catalogSorted.map(c => ({ value: c.id, label: `${c.name} (${c.basis === 'perUnit' ? 'por ud' : 'por 100g'})` })), '', () => {}, 'Elegir ingrediente…');
    const qtyIn = el('input', { type: 'number', placeholder: 'cantidad', min: '0.5', value: '100' });
    ingSection.appendChild(el('div', { class: 'add-row' }, [ingSelect, qtyIn, el('button', {
      class: 'btn-secondary', type: 'button', onclick: () => {
        if (!ingSelect.value) return;
        const qty = Number(qtyIn.value) || 0;
        if (qty <= 0) return;
        ingredients.push({ ingredientId: ingSelect.value, qty, basis: findIngredient(ingSelect.value).basis });
        refreshIngList();
      }
    }, '+ añadir')]));
    ingSection.appendChild(ingListBox);
    ingSection.appendChild(totalBox);
    ingSection.style.display = useIngredients ? 'block' : 'none';

    const ingToggle = el('button', { class: 'link-btn', type: 'button' },
      useIngredients ? 'usar un total directo en vez de ingredientes' : '¿Prefieres desglosarlo por ingrediente? (opcional, para poder ajustar ración)');
    ingToggle.addEventListener('click', () => {
      useIngredients = !useIngredients;
      ingSection.style.display = useIngredients ? 'block' : 'none';
      kcalIn.disabled = protIn.disabled = carbIn.disabled = fatIn.disabled = useIngredients && ingredients.length > 0;
      ingToggle.textContent = useIngredients ? 'usar un total directo en vez de ingredientes' : '¿Prefieres desglosarlo por ingrediente? (opcional, para poder ajustar ración)';
    });
    body.appendChild(ingToggle);
    body.appendChild(ingSection);
    refreshIngList();

    body.appendChild(el('button', {
      class: 'btn-primary', onclick: () => {
        if (!nameIn.value.trim()) return;
        const mealTypes = tagsBox.getSelected();
        if (!mealTypes.length) { alertModal('Falta la comida', 'Marca al menos una comida para saber dónde debe aparecer este plato.'); return; }
        const finalIngredients = useIngredients ? ingredients : [];
        const data = {
          name: nameIn.value.trim(), icon: selectedIcon, mealTypes, ingredients: finalIngredients,
          lines: linesIn.value.split('\n').map(l => l.trim()).filter(Boolean),
          kcal: Number(kcalIn.value) || 0, prot: Number(protIn.value) || 0, carb: Number(carbIn.value) || 0, fat: Number(fatIn.value) || 0
        };
        if (isEdit) { Object.assign(meal, data); persistMeals(); }
        else { state.meals.push({ id: uid('meal'), source: 'custom', ...data }); persistMeals(); }
        close();
        if (onSaved) onSaved(); else render();
      }
    }, isEdit ? 'Guardar cambios' : 'Guardar plato'));
  });
}

// ---------------- Actualizaciones de la app ----------------
async function fetchLatestVersion() {
  const r = await fetch('./version.js?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const m = (await r.text()).match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error('sin versión');
  return m[1];
}
async function updateAppNow() {
  try {
    if ('serviceWorker' in navigator) (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
    if (window.caches) (await caches.keys()).forEach(k => caches.delete(k));
  } catch (e) { console.warn(e); }
  location.reload();
}
function showUpdateBanner(newVersion) {
  if (document.getElementById('update-banner')) return;
  const bar = el('div', { id: 'update-banner', class: 'update-banner' }, [
    el('span', {}, `🆕 Hay una versión nueva (${newVersion})`),
    el('button', { class: 'btn-primary', onclick: updateAppNow }, 'Actualizar')
  ]);
  document.body.appendChild(bar);
}
async function checkForUpdate(manual) {
  try {
    const latest = await fetchLatestVersion();
    if (latest !== APP_VERSION) { showUpdateBanner(latest); return; }
    if (manual) alertModal('Todo al día', `Ya tienes la última versión (${APP_VERSION}).`);
  } catch (e) {
    if (manual) alertModal('No se pudo comprobar', 'Revisa tu conexión a internet e inténtalo de nuevo.', 'warn');
  }
}
function renderVersionFooter() {
  return el('div', { class: 'version-footer' }, [
    el('span', { class: 'note' }, `Versión ${APP_VERSION} · `),
    el('button', { class: 'link-btn', onclick: () => checkForUpdate(true) }, 'Buscar actualización'),
    el('span', { class: 'note' }, ' · '),
    el('button', { class: 'link-btn', onclick: updateAppNow }, 'Forzar recarga')
  ]);
}
checkForUpdate(false);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(false); });
setInterval(() => checkForUpdate(false), 30 * 60 * 1000);

// ---------------- Registro del Service Worker ----------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(err => console.warn('SW no registrado:', err));
  });
}

render();
if (typeof initSync === 'function') initSync(applyRemoteChange);
if (typeof syncEnabled === 'undefined' || !syncEnabled) applyPendingExercise();
else setTimeout(applyPendingExercise, 5000); // si la nube tarda o no hay conexión, se guarda en local igualmente
