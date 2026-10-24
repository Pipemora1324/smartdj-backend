// Prioridad de las peticiones del público en AutoDJ (lógica pura, sin base de datos). Ver DECISIONES_DJ.md.
// Toda petición válida entra a la cola; aquí solo se decide el ORDEN y el MOMENTO:
// 1. Orden de llegada (primero en pedir, primero en sonar).
// 2. Ajuste suave: dentro de una ventana de las maxDeferral+1 más antiguas se elige la de mejor puntaje
//    (posición de llegada, votos, prioridad del dueño y transición con la pista anterior).
// 3. Límite de aplazamiento: una petición que ya fue adelantada maxDeferral veces suena antes que cualquier otra.
// 4. Equilibrio: con muchas pendientes, después de cada balanceEvery peticiones seguidas va una pista de la IA.
import { tagsForGenre } from './catalog-logic.js';

export const DEFAULT_RULES = { maxDeferral: 3, balanceEvery: 4 };
// Pesos del puntaje: un puesto de llegada vale 1. Dos votos ≈ adelantar un puesto; una transición perfecta frente a
// un choque brusco de género y energía también vale un puesto y medio, así que el ajuste nunca es grande.
export const WEIGHTS = { vote: 1, owner: 1, smooth: 1.5 };
// Duración supuesta de una pista sin dato, para la espera estimada.
export const DEFAULT_TRACK_SECONDS = 180;

const family = (genre) =>
  tagsForGenre(genre)[0] ??
  (String(genre || '')
    .trim()
    .toLowerCase() ||
    null);

// Qué tan suave es pasar de prev a next (0 choque brusco … 1 transición natural). Sin datos es neutro (0,5).
export const transitionFit = (prev, next) => {
  if (!prev || !next) return 0.5;
  const a = family(prev.genre);
  const b = family(next.genre);
  const genreFit = !a || !b ? 0.5 : a === b ? 1 : 0;
  const ea = Number(prev.energy) || 0;
  const eb = Number(next.energy) || 0;
  const energyFit = ea && eb ? Math.max(0, 1 - Math.abs(ea - eb) / 4) : 0.5;
  return 0.6 * genreFit + 0.4 * energyFit;
};

const byArrival = (a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a.id).localeCompare(String(b.id));

// Ordena las peticiones listas para sonar. requests: [{ id, createdAt, votes, passed, ownerPriority, genre, energy }].
// prev: la pista que sonará justo antes (la siguiente de la cola o la actual).
export const planRequestOrder = (requests, { prev = null, maxDeferral = DEFAULT_RULES.maxDeferral, weights = WEIGHTS } = {}) => {
  const remaining = [...requests].sort(byArrival);
  const jumps = new Map(remaining.map((r) => [r.id, 0]));
  const deferred = (r) => (Number(r.passed) || 0) + jumps.get(r.id);
  const ordered = [];
  let last = prev;
  while (remaining.length) {
    let pickIndex = remaining.findIndex((r) => deferred(r) >= maxDeferral);
    if (pickIndex < 0) {
      const window = remaining.slice(0, maxDeferral + 1);
      const score = (r, rank) =>
        -rank +
        weights.vote * Math.log2(Math.max(1, Number(r.votes) || 1)) +
        weights.owner * (Number(r.ownerPriority) || 0) +
        weights.smooth * transitionFit(last, r);
      pickIndex = window.reduce((best, r, rank) => (score(r, rank) > score(window[best], best) ? rank : best), 0);
    }
    const [pick] = remaining.splice(pickIndex, 1);
    // Las que llegaron antes y quedan esperando fueron adelantadas una vez más.
    for (let i = 0; i < pickIndex; i += 1) jumps.set(remaining[i].id, jumps.get(remaining[i].id) + 1);
    ordered.push(pick);
    last = pick;
  }
  return ordered;
};

// Une las peticiones ordenadas con las pistas de la IA. Con más de balanceEvery peticiones, después de cada
// balanceEvery seguidas va una pista de la IA (si hay); el resto de las pistas de la IA va al final.
export const layoutQueue = (requestIds, otherIds, { balanceEvery = DEFAULT_RULES.balanceEvery } = {}) => {
  const others = [...otherIds];
  const balance = requestIds.length > balanceEvery;
  const result = [];
  requestIds.forEach((id, index) => {
    result.push(id);
    const runEnds = (index + 1) % balanceEvery === 0 && index < requestIds.length - 1;
    if (balance && runEnds && others.length) result.push(others.shift());
  });
  return [...result, ...others];
};

// Cuántas pistas de la IA debe haber en la cola: las del equilibrio y las que faltan para el mínimo, y siempre
// al menos una al final para que la emisora nunca se quede sin qué sonar.
export const aiTracksNeeded = (requestCount, { minQueue, balanceEvery = DEFAULT_RULES.balanceEvery }) => {
  const balanceSlots = requestCount > balanceEvery ? Math.floor((requestCount - 1) / balanceEvery) : 0;
  return Math.max(1, minQueue - requestCount, balanceSlots + 1);
};

// Segundos que faltan para que empiece cada pista de la cola (y su puesto, desde 1).
// current: { remainingSeconds } de la que suena; items: filas en orden con transition_at_seconds o duration_seconds.
export const queueEta = (items, { remainingSeconds = 0 } = {}) => {
  let elapsed = Math.max(0, Number(remainingSeconds) || 0);
  return items.map((item, index) => {
    const eta = { position: index + 1, etaSeconds: Math.round(elapsed) };
    elapsed += Number(item.transition_at_seconds) || Number(item.duration_seconds) || DEFAULT_TRACK_SECONDS;
    return eta;
  });
};

// Lo que falta de la pista actual (hasta su punto de transición), según el estado del reproductor.
export const remainingOfCurrent = (state, position) => {
  if (!state?.track) return 0;
  const end = Number(state.current_meta?.transitionAtSeconds) || Number(state.track.duration_seconds) || DEFAULT_TRACK_SECONDS;
  return Math.max(0, end - (Number(position) || 0));
};

// Identidad de una canción pedida (para duplicados y bloqueos): proveedor e id externo.
export const songKeyOf = (provider, externalId) => (provider && externalId ? `${provider}:${externalId}`.slice(0, 80) : null);

// Votos que sube una petición repetida: 1 por persona, sin pasar de un tope razonable.
export const MAX_VOTES = 999;

// Fallos al reproducir una petición: el primero se reintenta; con el segundo queda "No se pudo reproducir".
export const MAX_PLAY_FAILURES = 2;
