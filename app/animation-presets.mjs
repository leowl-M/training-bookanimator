const TAU = Math.PI * 2;
const ease = u => { u = Math.min(1, Math.max(0, u)); return u * u * u * (10 + u * (-15 + 6 * u)); };

// Presets that move the camera rather than the product: OrbitControls stays off.
export const CAMERA_MODES = ['orbit', 'both', 'push', 'rise', 'hero', 'topdown', 'dolly', 'reveal', 'handheld', 'orbit360', 'showcase', 'tiltcam', 'turntable', 'spiralcam', 'kenburns'];

// Height of a dropped object with damped bounces; t in seconds, h0 in product sizes.
export function bounce(t, h0 = 0.6, fall = 0.45, restitution = 0.32) {
  if (t < 0) return h0;
  if (t < fall) return h0 * (1 - (t / fall) ** 2);
  t -= fall;
  const g = 2 * h0 / fall ** 2;
  let v = g * fall * restitution;
  for (let i = 0; i < 8; i++) {
    const flight = 2 * v / g;
    if (t < flight) return v * t - 0.5 * g * t * t;
    t -= flight; v *= restitution;
  }
  return 0;
}

const pingPong = u => u < 0.5 ? 2 * u : 2 - 2 * u;
const hash = k => { const x = Math.sin(k * 12.9898) * 43758.5453; return 2 * (x - Math.floor(x)) - 1; };
// tremolio di una camera tenuta a mano: somma di sinusoidi non commensurabili, liscia e senza ripetizioni evidenti
const wobble = (t, seed) => Math.sin(1.31 * t + seed) + 0.6 * Math.sin(2.87 * t + 2 * seed) + 0.3 * Math.sin(6.13 * t + 3 * seed);
// da 0 a 1 con easing mentre u va da from a to
const segment = (u, from, to) => ease((u - from) / (to - from));

// Two half turns separated by holds: front, back, front again.
function flipTurn(u) {
  if (u < 0.15) return 0;
  if (u < 0.45) return 0.5 * ease((u - 0.15) / 0.3);
  if (u < 0.65) return 0.5;
  if (u < 0.95) return 0.5 + 0.5 * ease((u - 0.65) / 0.3);
  return 1;
}

// Motion is sampled from a clock, rather than accumulated into transforms.
// A pause freezes the exact composition and a restart is reproducible.
// lift is in product sizes, elevation in radians above the fitted view, zoom multiplies the lens.
export function presentationPose(mode, time, duration = 8, { flat = false } = {}) {
  const length = Math.max(1, duration), phase = TAU * time / length;
  const u = ((time / length) % 1 + 1) % 1;
  // x, z: traslazione in dimensioni del prodotto (l'inquadratura non la segue); scale: dimensione del prodotto
  const pose = { yaw: 0, pitch: 0, roll: 0, lift: 0, orbit: 0, zoom: 1, elevation: 0, x: 0, z: 0, scale: 1 };
  if (mode === 'spin') pose.yaw = phase;
  if (mode === 'orbit') pose.orbit = 0.5 * Math.sin(phase);
  if (mode === 'float') {
    pose.lift = 0.16 + 0.035 * Math.sin(phase);
    pose.yaw = 0.24 * Math.sin(phase);
    pose.pitch = 0.07 * Math.sin(phase);
    pose.roll = 0.06 * Math.cos(phase);
  }
  if (mode === 'both') { pose.yaw = 0.13 * Math.sin(phase); pose.orbit = 0.22 * Math.sin(phase); }
  if (mode === 'push') { pose.zoom = 0.94 + 0.2 * (0.5 - 0.5 * Math.cos(phase)); pose.orbit = 0.1 * Math.sin(phase); }
  if (mode === 'rise') { pose.elevation = 0.6 * (0.5 + 0.5 * Math.cos(phase)); pose.orbit = 0.16 * Math.sin(phase); }
  if (mode === 'hero') { pose.elevation = -0.5; pose.orbit = 0.32 * Math.sin(phase); pose.zoom = 1.06; }
  if (mode === 'topdown') { pose.elevation = 1.2; pose.yaw = phase; }
  if (mode === 'swing') pose.yaw = 0.42 * Math.sin(phase);
  if (mode === 'flip') {
    const k = flipTurn(u), angle = TAU * k, hop = Math.sin(Math.PI * ((k * 2) % 1));
    // A flat product turns over like a pancake: lifted by half its width so no edge enters the table.
    if (flat) { pose.roll = angle; pose.lift = 0.52 * Math.abs(Math.sin(angle)) + 0.05 * hop; }
    else { pose.yaw = angle; pose.lift = 0.03 * hop; }
  }
  if (mode === 'drop') {
    // Drop, bounce and settle; then it is picked up again before the next drop.
    const t = u * length, h0 = 0.6;
    const height = u < 0.75 ? bounce(t) : h0 * ease((u - 0.75) / 0.25);
    pose.lift = height;
    pose.pitch = 0.16 * height / h0;
    pose.yaw = 0.25 * height / h0;
  }
  if (mode === 'dolly') { pose.orbit = -0.55 + 1.1 * ease(pingPong(u)); pose.elevation = 0.05; pose.zoom = 1.06; }
  if (mode === 'reveal') {
    // dal dettaglio al prodotto intero, poi resta
    const k = segment(u, 0, 0.55);
    pose.zoom = 1 + 1.6 * (1 - k); pose.orbit = 0.3 * (1 - k); pose.elevation = -0.12 * (1 - k);
  }
  if (mode === 'whip') pose.yaw = TAU * (segment(u, 0.1, 0.3) + segment(u, 0.6, 0.8));
  if (mode === 'tumble') {
    pose.lift = 0.6 + 0.04 * Math.sin(2 * phase);
    pose.yaw = phase; pose.pitch = 0.45 * Math.sin(phase); pose.roll = 0.3 * Math.sin(2 * phase + 1);
  }
  if (mode === 'handheld') {
    pose.orbit = 0.025 * wobble(time, 1); pose.elevation = 0.018 * wobble(time, 2); pose.zoom = 1.02 + 0.012 * wobble(time, 3);
  }
  if (mode === 'orbit360') pose.orbit = phase;
  if (mode === 'slide') {
    // entra da sinistra, si ferma, esce a destra: fuori quadro all'inizio e alla fine, il ciclo è continuo
    const enter = segment(u, 0, 0.25), leave = segment(u, 0.75, 1);
    pose.x = -2.2 * (1 - enter) + 2.2 * leave;
    pose.yaw = 0.5 * (1 - enter) - 0.5 * leave;
  }
  if (mode === 'stopmotion') {
    // 6 pose al secondo, un giro per ciclo, piccoli spostamenti come se fosse mosso a mano
    const step = Math.floor(time * 6), steps = Math.max(1, Math.round(length * 6));
    pose.yaw = TAU * step / steps + 0.04 * hash(step);
    pose.x = 0.012 * hash(step + 7); pose.z = 0.012 * hash(step + 13);
  }
  if (mode === 'pop') {
    // compare con un rimbalzo elastico, resta, scompare
    const t = u / 0.22;
    pose.scale = u < 0.22 ? 1 - Math.exp(-5 * t) * Math.cos(9 * t) : u < 0.85 ? 1 : 1 - segment(u, 0.85, 1);
    pose.yaw = 0.35 * (1 - Math.min(1, t));
  }
  // 360° da piatto girevole: il prodotto gira, la camera sale e scende appena
  if (mode === 'turntable') { pose.yaw = phase; pose.elevation = 0.12 + 0.08 * Math.sin(phase); pose.zoom = 1.03; }
  // tilt: il prodotto si inclina avanti e indietro; steso sul tavolo si solleva quanto serve a non toccarlo
  if (mode === 'tilt') {
    pose.pitch = 0.35 * Math.sin(phase); pose.yaw = 0.12 * Math.sin(phase / 2);
    if (flat) pose.lift = 0.5 * Math.abs(Math.sin(pose.pitch)) + 0.03;
  }
  if (mode === 'tiltcam') { pose.elevation = 0.45 * Math.sin(phase); pose.zoom = 1.04; }
  // capriola: un giro completo su sé stesso. Steso ruota come una frittella, in piedi in avanti
  if (mode === 'roll360') {
    const angle = TAU * ease(u);
    if (flat) { pose.roll = angle; pose.lift = 0.52 * Math.abs(Math.sin(angle)) + 0.03; }
    else pose.pitch = angle;
  }
  // spirale: la camera gira di mezzo giro scendendo dall'alto e avvicinandosi
  if (mode === 'spiralcam') { const k = ease(u); pose.orbit = Math.PI * k - Math.PI / 4; pose.elevation = 0.55 * (1 - k); pose.zoom = 1 + 0.18 * k; }
  // Ken Burns: avvicinamento lento e costante con un leggero scorrimento
  if (mode === 'kenburns') { pose.zoom = 1 + 0.16 * u; pose.orbit = 0.16 * (u - 0.5); }
  if (mode === 'showcase') {
    // sequenza per video: rivelazione, giro rapido, salita della camera con avvicinamento
    if (u < 0.3) { const k = segment(u, 0, 0.3); pose.zoom = 1 + 1.4 * (1 - k); pose.orbit = 0.3 * (1 - k); }
    else if (u < 0.55) pose.yaw = TAU * segment(u, 0.3, 0.55);
    else { const k = segment(u, 0.55, 1); pose.elevation = 0.45 * k; pose.orbit = 0.4 * k; pose.zoom = 1 + 0.12 * k; }
  }
  return pose;
}
