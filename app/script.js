import * as THREE from 'three';
import { bookDimensions, bindingPose, aboveSupport } from './book-binding.mjs';
import { CANVAS, interiorLayout, coverRegions, detectCoverMode, exposedPages } from './pdf-layout.mjs';
import { openPdf } from './pdf-source.mjs';
import { presentationPose, CAMERA_MODES } from './animation-presets.mjs';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

import { mountStudioControls } from './studio-controls.mjs?v=4';
import { numberValue, canvasDimensions, amplifyPose, SettingsHistory } from './studio-settings.mjs';
const syncStudioControls = mountStudioControls();

const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const icons = () => window.lucide?.createIcons(); // il CDN può mancare: i bottoni restano col testo
// Bottone con icona Lucide + testo: textContent cancellerebbe l'icona
const setLabel = (id, icon, text) => { $(id).innerHTML = `<i data-lucide="${icon}" class="w-4 h-4"></i>${text}`; icons(); };
icons();

let _toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// sidebar mobile (lo script è un modulo: il DOM è già pronto)
function closePanels() {
  for (const id of ['sidebar', 'sidebarRight']) $(id).classList.remove('open');
  $('sidebarOverlay').classList.remove('active');
}
function openPanel(id) {
  const wasOpen = $(id).classList.contains('open');
  closePanels();
  if (!wasOpen) { $(id).classList.add('open'); $('sidebarOverlay').classList.add('active'); }
}
on('menuToggle', 'click', () => openPanel('sidebar'));
on('sceneToggle', 'click', () => openPanel('sidebarRight'));
on('menuClose', 'click', closePanels);
on('sceneClose', 'click', closePanels);
on('sidebarOverlay', 'click', closePanels);
$('form').addEventListener('submit', e => e.preventDefault());

// valori degli slider: si aggiornano anche quando il JS cambia il valore
const SLIDERS = { speed: v => (+v).toFixed(1) + '×', angle: v => v + '°', turned: v => v, scrub: v => v + '%',
  subjX: v => v + '%', subjY: v => v + '%', subjRot: v => v + '°', subjScale: v => v + '%',
  focal: v => v + ' mm', lightAz: v => v + '°', lightEl: v => v + '°', lightPow: v => v + '%', envPow: v => v + '%',
  shadowPow: v => v + '%', wind: v => v + '%', lightTemp: v => v + ' K', vignette: v => v + '%', grain: v => v + '%' };
function syncSliderValues() {
  syncStudioControls();
  for (const [id, format] of Object.entries(SLIDERS)) {
    const text = String(format($(id).value)), span = $('val' + id[0].toUpperCase() + id.slice(1));
    if (span.textContent !== text) span.textContent = text;
  }
}
const mm = 0.01; // 1 unità scena = 100 mm
const view = $('view');
const clamp = THREE.MathUtils.clamp;
const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

// ============================================================ ombre morbide (PCSS)
// Le ombre vere sono nette dove l'oggetto tocca e si allargano allontanandosi: si cercano i "bloccanti"
// attorno al punto, se ne stima la distanza e si sfuma con un raggio proporzionale.
// Le costanti sono in frazioni della shadow map, che fit() scala sul prodotto: valgono per ogni formato.
THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment
  .replace('\tvec2 texture2DDistribution(', `
	#define PCSS_N 24
	#define PCSS_SEARCH 0.02
	#ifndef PCSS_SCALE
	#define PCSS_SCALE 0.3
	#endif
	#define PCSS_MIN 0.0006
	vec2 pcssDisk( int i, float rot ) { // spirale di Vogel: campioni uniformi, ruotati per pixel
		float r = sqrt( ( float( i ) + 0.5 ) / float( PCSS_N ) ), a = float( i ) * 2.39996323 + rot;
		return r * vec2( cos( a ), sin( a ) );
	}
	float PCSS( sampler2D map, vec4 c ) {
		float rot = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
		// pendenza della superficie nella shadow map: ogni campione si confronta con la profondità che la
		// superficie ha lì, non nel centro. Senza, un foglio inclinato rispetto alla luce si fa ombra da solo
		vec3 ddx = dFdx( c.xyz ), ddy = dFdy( c.xyz );
		float det = ddx.x * ddy.y - ddx.y * ddy.x;
		vec2 slope = abs( det ) > 1e-14 ? vec2( ddy.y * ddx.z - ddx.y * ddy.z, ddx.x * ddy.z - ddy.x * ddx.z ) / det : vec2( 0.0 );
		slope = clamp( slope, -1.0, 1.0 );
		float sum = 0.0, n = 0.0;
		for ( int i = 0; i < PCSS_N; i ++ ) {
			vec2 o = pcssDisk( i, rot ) * PCSS_SEARCH;
			float d = unpackRGBAToDepth( texture2D( map, c.xy + o ) );
			if ( d < c.z + dot( slope, o ) - 0.0005 ) { sum += d; n += 1.0; }
		}
		if ( n == 0.0 ) return 1.0;
		float pen = clamp( ( c.z - sum / n ) * PCSS_SCALE, PCSS_MIN, PCSS_SEARCH );
		float lit = 0.0;
		for ( int i = 0; i < PCSS_N; i ++ ) {
			vec2 o = pcssDisk( i, rot ) * pen;
			lit += step( c.z + dot( slope, o ) - 0.0005, unpackRGBAToDepth( texture2D( map, c.xy + o ) ) );
		}
		return lit / float( PCSS_N );
	}
	vec2 texture2DDistribution(`)
  .replace('if ( frustumTest ) {\n\t\t#if defined( SHADOWMAP_TYPE_PCF )\n',
           'if ( frustumTest ) {\n\t\t\treturn mix( 1.0, PCSS( shadowMap, shadowCoord ), shadowIntensity );\n\t\t#if defined( SHADOWMAP_TYPE_PCF )\n');
if (!THREE.ShaderChunk.shadowmap_pars_fragment.includes('PCSS( shadowMap')) console.warn('PCSS non applicato: ombre standard');

// ============================================================ scena
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); // buffer serve per toDataURL
renderer.setPixelRatio(1);
renderer.setSize(CANVAS.width, CANVAS.height, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NeutralToneMapping; // pensato per i prodotti: non sposta i colori delle stampe
$('canvasWrap').append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color($('cBg').value);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; // subito, finché non arriva la foto di studio
scene.environmentIntensity = 0.75;
// luce da foto di uno studio vero (Poly Haven, CC0): riflessi credibili su patinate e plastificati
new RGBELoader().load('https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_09_1k.hdr', hdr => {
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  scene.environmentIntensity = +$('envPow').value / 100;
  renderDirty = true;
  hdr.dispose();
}, undefined, () => console.warn('HDRI non raggiungibile: resta la luce di studio generata'));

const camera = new THREE.PerspectiveCamera(32, CANVAS.width / CANVAS.height, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
let fittedCamera = null;
let renderDirty = true, shadowDirty = true;
let frameOnce = false;
controls.addEventListener('change', () => renderDirty = true);
controls.addEventListener('start', () => { $('autoFrame').checked = false; });
renderer.shadowMap.autoUpdate = false;

const fillLight = new THREE.DirectionalLight(0xdbe8ff, 0), rimLight = new THREE.DirectionalLight(0xfff1db, 0);
scene.add(fillLight, rimLight);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.16 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// post-processing: occlusione ambientale (pieghe, dorso, tra le pagine) e profondità di campo
// 4 campioni MSAA: senza, i bordi sottili delle pagine diventano tratteggiati
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, 1, 1);
composer.addPass(gtao);
// il pavimento invisibile resta fuori dall'occlusione: lontano dietro ai bordi crea aloni tratteggiati
// (il "peso" sul tavolo lo danno già ombra di contatto e ombra del sole)
const gtaoRender = gtao.render.bind(gtao);
const aoHidden = new Set(); // superfici trasparenti (vetro): niente occlusione ambientale
gtao.render = (...a) => {
  ground.visible = cs.plane.visible = false;
  // anche lo sfondo a texture resta fuori: finirebbe nei buffer di normali e profondità
  const goboOn = gobo.visible, background = scene.background;
  aoHidden.forEach(m => m.visible = false); gobo.visible = false; scene.background = null;
  gtaoRender(...a);
  aoHidden.forEach(m => m.visible = true); gobo.visible = goboOn; scene.background = background;
  ground.visible = cs.plane.visible = true;
};
const bokeh = new BokehPass(scene, camera, { focus: 5, aperture: 0.002, maxblur: 0.006 });
bokeh.enabled = false;
const bokehRender = bokeh.render.bind(bokeh);
bokeh.render = (...a) => {
  const goboOn = gobo.visible, background = scene.background;
  gobo.visible = false; scene.background = null; bokehRender(...a); gobo.visible = goboOn; scene.background = background;
};
composer.addPass(bokeh);
composer.addPass(new OutputPass()); // tone mapping e sRGB alla fine della catena
// effetti di ripresa sull'immagine finale: vignettatura e grana (cambia a ogni fotogramma, deterministica)
const finish = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0 }, grain: { value: 0 }, frame: { value: 0 }, aspect: { value: 0.75 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float vignette, grain, frame, aspect; varying vec2 vUv;
    float hash( vec2 p ) { p = fract( p * vec2( 443.897, 441.423 ) ); p += dot( p, p.yx + 19.19 ); return fract( ( p.x + p.y ) * p.x ); }
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      vec2 d = ( vUv - 0.5 ) * vec2( aspect, 1.0 );
      c.rgb *= 1.0 - vignette * smoothstep( 0.2, 0.75, length( d ) );
      c.rgb += ( hash( floor( gl_FragCoord.xy ) + frame * 17.0 ) - 0.5 ) * grain * 0.14;
      gl_FragColor = c;
    }`,
});
composer.addPass(finish);

composer.setPixelRatio(1);
composer.setSize(CANVAS.width, CANVAS.height);
// formati di uscita: il rendering e gli export usano sempre questi pixel, la finestra scala solo l'anteprima
const FORMATS = { '3:4': [1080, 1440], '4:5': [1080, 1350], '1:1': [1080, 1080], '9:16': [1080, 1920], '16:9': [1920, 1080] };
const canvasSize = { width: CANVAS.width, height: CANVAS.height };
const dims = () => `${canvasSize.width} × ${canvasSize.height}`;
function resizeFrame() {
  const { clientWidth: w, clientHeight: h } = $('stage');
  $('canvasWrap').style.width = Math.max(1, Math.min(w - 32, (h - 32) * canvasSize.width / canvasSize.height)) + 'px';
}
function setCanvasFormat(key) {
  const [w, h] = key === 'custom' ? canvasDimensions($('canvasW').value, $('canvasH').value, renderer.capabilities.maxTextureSize / 2) : (FORMATS[key] || FORMATS['3:4']);
  if (key === 'custom') { $('canvasW').value = w; $('canvasH').value = h; }
  Object.assign(canvasSize, { width: w, height: h });
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  $('canvasWrap').style.aspectRatio = `${w} / ${h}`;
  $('canvasCaption').textContent = `CANVAS ${dims()} · ${key}`;
  $('exportTitle').textContent = `Export · ${dims()}`;
  resizeFrame();
}
new ResizeObserver(resizeFrame).observe($('stage'));

// --- ombra di contatto: profondità vista da sotto, sfocata. Dà il "peso" sul tavolo che l'ombra del sole non dà
const cs = { res: 1024, blur: 2 };
cs.rt = new THREE.WebGLRenderTarget(cs.res, cs.res);
cs.rtBlur = new THREE.WebGLRenderTarget(cs.res, cs.res);
cs.rt.texture.generateMipmaps = cs.rtBlur.texture.generateMipmaps = false;
const csGeo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
cs.plane = new THREE.Mesh(csGeo, new THREE.MeshBasicMaterial({ map: cs.rt.texture, transparent: true, opacity: 0.75, depthWrite: false }));
cs.plane.renderOrder = 1;
cs.plane.position.y = 0.0005;
cs.blurPlane = new THREE.Mesh(csGeo);
cs.blurPlane.visible = false;
cs.cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 0.3);
cs.cam.rotation.x = Math.PI / 2;
scene.add(cs.plane, cs.blurPlane, cs.cam);
cs.depth = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
cs.depth.onBeforeCompile = s => {
  s.fragmentShader = s.fragmentShader.replace(
    'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
    'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * 1.4 );');
};
cs.depth.depthTest = cs.depth.depthWrite = false;
cs.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
cs.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
cs.hBlur.depthTest = cs.vBlur.depthTest = false;

function blurShadow(amount) {
  cs.blurPlane.visible = true;
  cs.blurPlane.material = cs.hBlur;
  cs.hBlur.uniforms.tDiffuse.value = cs.rt.texture;
  cs.hBlur.uniforms.h.value = amount / 256;
  renderer.setRenderTarget(cs.rtBlur);
  renderer.render(cs.blurPlane, cs.cam);
  cs.blurPlane.material = cs.vBlur;
  cs.vBlur.uniforms.tDiffuse.value = cs.rtBlur.texture;
  cs.vBlur.uniforms.v.value = amount / 256;
  renderer.setRenderTarget(cs.rt);
  renderer.render(cs.blurPlane, cs.cam);
  cs.blurPlane.visible = false;
}

function renderContactShadow() {
  const bg = scene.background, alpha = renderer.getClearAlpha();
  scene.background = null;
  cs.plane.visible = ground.visible = false;
  scene.overrideMaterial = cs.depth;
  renderer.setClearAlpha(0);
  renderer.setRenderTarget(cs.rt);
  renderer.clear();
  renderer.render(scene, cs.cam);
  scene.overrideMaterial = null;
  blurShadow(cs.blur);
  blurShadow(cs.blur * 0.4);
  renderer.setRenderTarget(null);
  renderer.setClearAlpha(alpha);
  cs.plane.visible = ground.visible = true;
  scene.background = bg;
}

// inquadra camera, luce e ombre sulla dimensione del prodotto
let lastFit = null, lightSize = 1;
// temperatura di colore in kelvin -> RGB (approssimazione di Tanner Helland)
function kelvin(k) {
  const t = k / 100, c = v => clamp(v, 0, 255) / 255;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return new THREE.Color(c(r), c(g), c(b));
}

// Ombre proiettate (gobo): un piano traforato tra sole e prodotto. Non scrive colore né profondità,
// quindi la camera non lo vede; proietta ombra con il materiale di profondità della shadow map.
// Resta fuori dai passaggi che usano un materiale sostitutivo (occlusione, profondità di campo).
const goboTextures = {};
function goboTexture(kind) {
  if (goboTextures[kind]) return goboTextures[kind];
  const N = 1024, [c, g] = canvas2d(N, N), r = rng(21);
  g.fillStyle = '#000'; g.fillRect(0, 0, N, N); // nero = passa la luce
  g.fillStyle = '#fff';                         // bianco = blocca la luce
  if (kind === 'blinds') { g.translate(N / 2, N / 2); g.rotate(-0.22); g.translate(-N, -N); for (let y = 0; y < 2 * N; y += 46) g.fillRect(0, y, 2 * N, 30); }
  if (kind === 'window') {
    g.fillRect(0, 0, N, N);
    for (const [x, y] of [[0.18, 0.12], [0.52, 0.12], [0.18, 0.52], [0.52, 0.52]]) g.clearRect(x * N, y * N, 0.3 * N, 0.36 * N);
  }
  if (kind === 'leaves') for (let branch = 0; branch < 14; branch++) {
    let x = r() * N, y = r() * N, a = r() * 6.283;
    for (let i = 0; i < 16; i++) {
      x += Math.cos(a) * 26; y += Math.sin(a) * 26; a += (r() - 0.5) * 0.7;
      g.save(); g.translate(x, y); g.rotate(a + (i % 2 ? 0.9 : -0.9));
      g.beginPath(); g.ellipse(18, 0, 26, 10, 0, 0, Math.PI * 2); g.fill(); g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  return goboTextures[kind] = t;
}
const gobo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, alphaTest: 0.5, colorWrite: false, depthWrite: false }));
gobo.castShadow = true;
gobo.visible = false;
scene.add(gobo);
function placeGobo(time = 0) {
  const kind = $('gobo').value;
  gobo.visible = kind !== 'none';
  if (!gobo.visible) return;
  if (gobo.material.alphaMap !== goboTexture(kind)) { gobo.material.alphaMap = goboTexture(kind); gobo.material.needsUpdate = true; }
  const size = lightSize, drift = $('goboMove').checked ? Math.sin(time * 0.35) * size * 0.25 : 0;
  gobo.position.copy(sun.position).setLength(size * 1.3);
  gobo.lookAt(sun.position);
  gobo.translateX(drift);
  gobo.rotateZ($('goboMove').checked ? Math.sin(time * 0.21) * 0.06 : 0);
  gobo.scale.setScalar(size * 3.2);
}

// superfici d'appoggio: texture disegnate al volo, ripetute in proporzione al prodotto
const surfaceTextures = {};
function surfaceTexture(kind) {
  if (surfaceTextures[kind]) return surfaceTextures[kind];
  const N = 1024, [c, g] = canvas2d(N, N), r = rng(31);
  const base = { wood: '#9c7552', concrete: '#b7b3ad', linen: '#d8d0c2', marble: '#ece8e2', paper: '#ebe5da' }[kind];
  g.fillStyle = base; g.fillRect(0, 0, N, N);
  if (kind === 'wood') for (let plank = 0; plank < 4; plank++) {
    const x0 = plank * N / 4, tone = (r() - 0.5) * 30;
    g.fillStyle = `rgba(${tone > 0 ? 255 : 0},${tone > 0 ? 220 : 0},${tone > 0 ? 180 : 0},${Math.abs(tone) / 255})`; g.fillRect(x0, 0, N / 4, N);
    for (let i = 0; i < 90; i++) {
      const x = x0 + r() * N / 4, w = 0.5 + r() * 2.5;
      g.strokeStyle = r() < 0.6 ? 'rgba(70,45,25,0.22)' : 'rgba(230,200,160,0.18)'; g.lineWidth = w;
      g.beginPath(); g.moveTo(x, 0);
      for (let y = 0; y <= N; y += 32) g.lineTo(x + Math.sin(y * 0.01 + i) * 4 * r(), y);
      g.stroke();
    }
    g.fillStyle = 'rgba(40,25,15,0.55)'; g.fillRect(x0, 0, 2, N); // fuga tra le assi
  }
  if (kind === 'concrete') for (let i = 0; i < 26000; i++) {
    const v = r() < 0.5 ? 0 : 255, size = r() < 0.97 ? 1 + r() * 2 : 4 + r() * 6;
    g.fillStyle = `rgba(${v},${v},${v},${0.03 + r() * 0.08})`; g.beginPath(); g.arc(r() * N, r() * N, size, 0, 6.283); g.fill();
  }
  if (kind === 'linen') for (let i = 0; i < N; i += 3) {
    g.fillStyle = `rgba(90,75,55,${0.04 + r() * 0.08})`; g.fillRect(0, i, N, 1.2); g.fillRect(i, 0, 1.2, N);
  }
  if (kind === 'marble') for (let i = 0; i < 18; i++) {
    let x = r() * N, y = r() * N, a = r() * 6.283;
    g.strokeStyle = `rgba(120,115,110,${0.08 + r() * 0.2})`; g.lineWidth = 0.6 + r() * 2.2;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 60; k++) { a += (r() - 0.5) * 0.5; x += Math.cos(a) * 18; y += Math.sin(a) * 18; g.lineTo(x, y); }
    g.stroke();
  }
  if (kind === 'paper') for (let i = 0; i < 4000; i++) {
    g.strokeStyle = `rgba(120,105,85,${0.05 + r() * 0.08})`; g.lineWidth = 0.5;
    const x = r() * N, y = r() * N, a = r() * 6.283; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9); g.stroke();
  }
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return surfaceTextures[kind] = t;
}
const shadowOnly = ground.material;
const SURFACE_LOOK = { wood: [0.55, 0.25], concrete: [0.9, 0.5], linen: [0.95, 0.6], marble: [0.22, 0.12], paper: [0.92, 0.35] };
let surfaceMaterial = null;
function applySurface() {
  const kind = $('surface').value;
  if (kind === 'none') { ground.material = shadowOnly; scene.fog = null; }
  else {
    surfaceMaterial?.dispose();
    const map = surfaceTexture(kind), tile = lightSize * 1.6;
    map.repeat.set(200 / tile, 200 / tile);
    const [roughness, bump] = SURFACE_LOOK[kind];
    surfaceMaterial = ground.material = new THREE.MeshStandardMaterial({ map, roughness,
      normalMap: fiberBase.normal, normalScale: new THREE.Vector2(bump, bump) });
    if (shadowSoftness) surfaceMaterial.defines = { PCSS_SCALE: shadowSoftness };
    // l'orizzonte del tavolo sfuma nel colore di fondo
    scene.fog = new THREE.Fog($('cBg').value, lightSize * 8, lightSize * 22);
  }
  renderDirty = shadowDirty = true;
}

// sfondo: tinta unita, sfumato radiale o fondale da studio (chiaro in alto, più scuro in basso)
let backgroundTexture = null;
function applyBackground() {
  const mode = $('bgMode').value, color = new THREE.Color($('cBg').value);
  backgroundTexture?.dispose(); backgroundTexture = null;
  if (mode === 'solid') scene.background = color;
  else {
    const [c, g] = canvas2d(512, 512), dark = '#' + color.clone().multiplyScalar(0.62).getHexString(), light = '#' + color.clone().lerp(new THREE.Color('#ffffff'), 0.25).getHexString();
    const gradient = mode === 'radial' ? g.createRadialGradient(256, 230, 20, 256, 256, 380) : g.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, light); gradient.addColorStop(mode === 'radial' ? 0.45 : 0.55, $('cBg').value); gradient.addColorStop(1, dark);
    g.fillStyle = gradient; g.fillRect(0, 0, 512, 512);
    scene.background = backgroundTexture = toTexture(c);
  }
  if (scene.fog) scene.fog.color.set($('cBg').value);
  renderDirty = true;
}

// luci pronte: direzione, altezza, intensità, ambiente, ombra, temperatura, ombra proiettata
const LIGHTS = {
  studio:   { lightAz: 34, lightEl: 48, lightPow: 160, envPow: 90, shadowPow: 60, lightTemp: 5600, gobo: 'none' },
  window:   { lightAz: 300, lightEl: 30, lightPow: 260, envPow: 55, shadowPow: 85, lightTemp: 5200, gobo: 'window' },
  blinds:   { lightAz: 70, lightEl: 35, lightPow: 240, envPow: 60, shadowPow: 80, lightTemp: 4800, gobo: 'blinds' },
  garden:   { lightAz: 20, lightEl: 55, lightPow: 220, envPow: 70, shadowPow: 75, lightTemp: 5800, gobo: 'leaves' },
  sunset:   { lightAz: 260, lightEl: 14, lightPow: 230, envPow: 45, shadowPow: 90, lightTemp: 3000, gobo: 'none' },
  noon:     { lightAz: 10, lightEl: 80, lightPow: 200, envPow: 100, shadowPow: 70, lightTemp: 6200, gobo: 'none' },
  dramatic: { lightAz: 110, lightEl: 22, lightPow: 300, envPow: 15, shadowPow: 100, lightTemp: 4500, gobo: 'none' },
};
function applyLightPreset(name) {
  for (const [id, value] of Object.entries(LIGHTS[name] || {})) $(id).value = value;
  placeSun();
}

// Con un'ombra proiettata la penombra segue la luce del sole (stretta), non quella da studio:
// altrimenti il motivo, lontano dalle superfici, si sfuma fino a sparire. Il define entra nella chiave del programma.
let shadowSoftness = null;
function applyShadowSoftness(force = false) {
  const scale = (($('gobo').value === 'none' ? 0.3 : 0.025) * +$('shadowSoft').value / 100).toFixed(5);
  if (scale === shadowSoftness && !force) return;
  shadowSoftness = scale;
  scene.traverse(o => {
    if (!o.isMesh || !o.receiveShadow) return;
    for (const m of [o.material].flat()) {
      if (scale) m.defines = { ...m.defines, PCSS_SCALE: scale }; else if (m.defines) delete m.defines.PCSS_SCALE;
      m.needsUpdate = true;
    }
  });
}

// sole da direzione e altezza scelte, a distanza proporzionata al prodotto
function placeSun(size = lightSize) {
  lightSize = size;
  const az = THREE.MathUtils.degToRad(+$('lightAz').value), el = THREE.MathUtils.degToRad(+$('lightEl').value), r = size * 3.2;
  sun.position.set(r * Math.cos(el) * Math.sin(az), r * Math.sin(el), r * Math.cos(el) * Math.cos(az));
  sun.intensity = +$('lightPow').value / 100;
  sun.color.copy(kelvin(+$('lightTemp').value));
  scene.environmentIntensity = +$('envPow').value / 100;
  scene.environmentRotation.y = THREE.MathUtils.degToRad(+$('envRotation').value);
  renderer.toneMappingExposure = 2 ** +$('exposureEV').value;
  for (const [light, prefix] of [[fillLight, 'fill'], [rimLight, 'rim']]) {
    const a = THREE.MathUtils.degToRad(+$(`${prefix}Az`).value), e = THREE.MathUtils.degToRad(+$(`${prefix}El`).value);
    light.position.set(r * Math.cos(e) * Math.sin(a), r * Math.sin(e), r * Math.cos(e) * Math.cos(a));
    light.intensity = +$(`${prefix}Power`).value / 100; light.color.set($(`${prefix}Color`).value);
  }
  const shadow = +$('shadowPow').value / 100;
  shadowOnly.opacity = 0.27 * shadow;
  cs.plane.material.opacity = 1.25 * shadow;
  // con un'ombra proiettata il campo delle ombre si allarga: il motivo non deve finire nel quadro
  const s = size * ($('gobo').value === 'none' ? 1.5 : 3.5);
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: size * 0.5, far: size * 8 });
  sun.shadow.camera.updateProjectionMatrix();
  placeGobo(typeof simTime === 'undefined' ? 0 : simTime);
  applySurface();
  applyShadowSoftness();
  shadowDirty = renderDirty = true;
}
// obiettivo in mm (formato 24 × 36): angolo di campo verticale
const applyFocal = () => { camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(12 / +$('focal').value)); camera.updateProjectionMatrix(); };

function fit(width, H, book = false) {
  lastFit = [width, H, book];
  applyFocal();
  const size = Math.max(width, H);
  controls.target.set(0, book ? width * 0.2 : H / 2, 0);
  // distanza perché altezza e larghezza entrino nell'angolo di campo, con margine
  const fov = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const views = { front: [0, 0, 1], three: [.8, .65, 1], top: [0, 1, .001], side: [1, 0, .001], back: [0, 0, -1] };
  const direction = new THREE.Vector3(...(views[$('cameraView').value] || (book ? [0.2, 1.3, 1.1] : [0.45, 0.3, 1]))).normalize();
  let dist = Math.max(H, width / camera.aspect) / (2 * fov) * 1.3;
  if (book) {
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    // Inquadra anche il foglio sollevato: la pagina non deve uscire dal quadro a metà giro.
    dist = 0;
    for (const x of [-width / 2, width / 2]) for (const y of [0, width / 2]) for (const z of [-H / 2, H / 2]) {
      const point = new THREE.Vector3(x, y, z).sub(controls.target);
      const near = point.dot(direction);
      dist = Math.max(dist, near + Math.abs(point.dot(up)) / fov, near + Math.abs(point.dot(right)) / (fov * camera.aspect));
    }
    dist *= 1.12;
  }
  camera.position.copy(controls.target).addScaledVector(direction, dist);
  // ingombro del libro aperto con il foglio sollevato: l'animazione parte già inquadrata così
  fitBox = book ? new THREE.Box3(new THREE.Vector3(-width / 2, 0, -H / 2), new THREE.Vector3(width / 2, width * 0.375, H / 2)) : null;
  fittedCamera = { position: camera.position.clone(), target: controls.target.clone() };
  camera.near = size * 0.02;
  camera.far = size * 50;
  camera.updateProjectionMatrix();
  placeSun(size);
  sun.shadow.normalBias = size * 0.00025;
  sun.shadow.bias = -0.00005;
  gtao.updateGtaoMaterial({ radius: size * 0.025, thickness: size * 0.007, distanceExponent: 2, scale: 0.75 });
  gtao.updatePdMaterial({ radius: 6, rings: 2, samples: 16 });
  const c = size * 2.2;
  cs.plane.scale.set(c, -1, c); // y = -1: il piano guarda in su e l'immagine non è specchiata
  Object.assign(cs.cam, { left: -c / 2, right: c / 2, top: c / 2, bottom: -c / 2, far: size * 0.12 });
  cs.cam.updateProjectionMatrix();
}

const productBounds = new THREE.Box3(), envelope = new THREE.Box3(), meshBox = new THREE.Box3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
let fitBox = null;
const productSize = () => Math.max(+$('w').value, +$('h').value) * mm;
function resetEnvelope() {
  envelope.makeEmpty();
  if (fitBox && leaves.length && animated()) envelope.copy(fitBox).applyMatrix4(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(+$('subjRot').value)));
}

// Ingombro del prodotto per l'inquadratura. I fogli in volo non contano: la camera segue il libro,
// non ogni pagina sollevata. A libro aperto resta uno spazio fisso sopra per il foglio che gira.
function subjectBounds() {
  root.updateMatrixWorld(true);
  productBounds.makeEmpty();
  root.traverse(o => {
    if (!o.isMesh || !o.visible || o.isInstancedMesh) return;
    const leaf = o.userData.leaf;
    if (leaf && leaf.angle > 0.01 && leaf.angle < leaf.max - 0.01) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    productBounds.union(meshBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
  });
  if (leaves.length && leaves[0].angle > 0.01 && !productBounds.isEmpty())
    productBounds.max.y = Math.max(productBounds.max.y, root.position.y + leaves[Math.min(1, leaves.length - 1)].L * 0.75);
  return productBounds;
}

// direzione di ripresa: giro attorno al prodotto (orbit) e altezza (elevation) del preset
function orbitView(offset, pose) {
  const length = offset.length(), dir = offset.clone().normalize().applyAxisAngle(Y_AXIS, pose.orbit);
  const elevation = clamp(Math.asin(clamp(dir.y, -1, 1)) + pose.elevation, 0, Math.PI / 2 - 0.001);
  const horizontal = Math.hypot(dir.x, dir.z) || 1;
  return dir.set(dir.x / horizontal * Math.cos(elevation), Math.sin(elevation), dir.z / horizontal * Math.cos(elevation)).multiplyScalar(length);
}

function frameProduct(dt = 0, pose = lastPose) {
  if (!root || !fittedCamera) return false;
  const current = subjectBounds();
  if (current.isEmpty()) return false;
  // in animazione l'inquadratura copre tutto il movimento visto finora: si allarga una volta, poi resta ferma
  // la traslazione del preset (entrata laterale, stop-motion) non sposta la camera: il prodotto entra nel quadro
  current.translate(new THREE.Vector3(-pose.x, 0, -pose.z).multiplyScalar(productSize()));
  const box = $('anim').value === 'none' && !animated() ? current : envelope.union(current);
  const target = box.getCenter(new THREE.Vector3());
  const direction = orbitView(fittedCamera.position.clone().sub(fittedCamera.target), pose).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right);
  const fov = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  let distance = 0;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const point = new THREE.Vector3(x, y, z).sub(target), near = point.dot(direction);
        distance = Math.max(distance, near + Math.abs(point.dot(up)) / fov, near + Math.abs(point.dot(right)) / (fov * camera.aspect));
      }
  const destination = target.clone().addScaledVector(direction, distance * (1 + +$('frameMargin').value / 100));
  const blend = dt ? 1 - Math.exp(-3 * dt) : 1;
  const changed = camera.position.distanceTo(destination) + controls.target.distanceTo(target) > 0.00001;
  if (changed) {
    camera.position.lerp(destination, blend); controls.target.lerp(target, blend);
    camera.lookAt(controls.target); renderDirty = true;
  }
  return changed;
}

// ============================================================ texture
const maxAniso = renderer.capabilities.getMaxAnisotropy();
function toTexture(src) {
  const t = src instanceof HTMLCanvasElement ? new THREE.CanvasTexture(src) : new THREE.Texture(src);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  t.needsUpdate = true;
  return t;
}
const mirror = t => { t.repeat.x = -1; t.offset.x = 1; return t; }; // il retro si guarda da dietro
const canvas2d = (w, h) => {
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) });
  return [c, c.getContext('2d')];
};
const rng = seed => () => (seed = seed * 16807 % 2147483647) / 2147483647;

// impaginato finto: righe di testo grigie, così i segnaposto sembrano pagine vere
function drawText(g, x, y, w, h, seed, verso = false) {
  const r = rng(seed), left = x + w * (verso ? 0.1 : 0.14), right = x + w * (verso ? 0.86 : 0.9);
  g.fillStyle = '#a7a196';
  let yy = y + h * 0.1;
  if (r() < 0.6) { g.fillRect(left, yy, (right - left) * (0.4 + r() * 0.3), h * 0.022); yy += h * 0.06; }
  while (yy < y + h * 0.86) {
    const lines = 3 + (r() * 7 | 0);
    for (let i = 0; i < lines && yy < y + h * 0.86; i++) {
      g.fillRect(left, yy, (right - left) * (i === lines - 1 ? 0.25 + r() * 0.5 : 1), h * 0.0065);
      yy += h * 0.017;
    }
    yy += h * 0.013;
  }
}

function textPage(seed, verso) {
  const [c, g] = canvas2d(1024, 1448);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const left = verso ? 108 : 138, right = verso ? 866 : 916;
  g.fillStyle = '#37332e';
  g.font = '20px Georgia, serif';
  g.fillText('IL TEMPO DELLE COSE', left, 104);
  g.fillStyle = '#9e978c';
  g.fillRect(left, 125, right - left, 1);
  const paragraphs = [
    'La luce attraversava la stanza lentamente, lasciando sulla carta una traccia sottile. Ogni pagina conservava il ritmo di un gesto, il silenzio di una pausa e il piacere di tornare a leggere.',
    'Un libro prende forma anche nelle piccole cose: il margine intorno alle parole, una curva vicino alla rilegatura, il bordo di un foglio che si solleva. Dettagli semplici che insieme diventano una presenza.',
    'Fuori, il giorno continuava. Dentro, il tempo sembrava seguire un passo diverso. Bastava voltare una pagina per trovare un nuovo inizio, una prospettiva inattesa, un pensiero da portare con sé.',
  ];
  g.fillStyle = '#4d4740';
  g.font = '27px Georgia, serif';
  let y = 206;
  for (let para = 0; para < 6; para++) {
    let line = '';
    for (const word of paragraphs[(para + seed) % paragraphs.length].split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (g.measureText(next).width > right - left && line) { g.fillText(line, left, y); y += 39; line = word; }
      else line = next;
    }
    if (line) { g.fillText(line, left, y); y += 64; }
    if (y > 1250) break;
  }
  g.font = '23px Georgia, serif';
  g.textAlign = 'center';
  g.fillText(String(seed), c.width / 2, 1378);
  const t = toTexture(c);
  return verso ? mirror(t) : t;
}

function coverArt(title, sub = 'Nome Autore', aspect = 512 / 724) {
  const W = 512, H = Math.round(W / aspect), [c, g] = canvas2d(W, H), k = Math.min(1, H / 724);
  g.fillStyle = '#d9ccb4';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#8a3a2a';
  g.fillRect(0, H * 0.64, W, H * 0.05);
  g.fillStyle = '#2d2620';
  g.textAlign = 'center';
  g.font = `700 ${Math.round(64 * k)}px Georgia, serif`;
  g.fillText(title, W / 2, H * 0.3);
  g.font = `${Math.round(28 * k)}px Georgia, serif`;
  g.fillText(sub, W / 2, H * 0.3 + 56 * k);
  return toTexture(c);
}

function backArt() {
  const [c, g] = canvas2d(512, 724);
  g.fillStyle = '#d9ccb4';
  g.fillRect(0, 0, 512, 724);
  drawText(g, 0, 0, 512, 500, 7);
  g.fillStyle = '#fff';
  g.fillRect(330, 610, 130, 70);
  g.fillStyle = '#222';
  for (let x = 340; x < 450; x += 3 + (x * 7 % 4)) g.fillRect(x, 618, 1 + (x % 3), 54); // codice a barre finto
  return toTexture(c);
}

function spineArt() {
  const [c, g] = canvas2d(96, 724);
  g.fillStyle = '#d9ccb4';
  g.fillRect(0, 0, 96, 724);
  g.translate(48, 362);
  g.rotate(Math.PI / 2);
  g.fillStyle = '#2d2620';
  g.font = '700 40px Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Titolo', 0, 0);
  return toTexture(c);
}

// foglio intero per pieghevoli e biglietti: ante impaginate e righe di piega tratteggiate
function sheetArt(widths, H, label, cross = false) {
  const total = widths.reduce((a, b) => a + b), s = Math.min(2048, 600 * widths.length) / total;
  const [c, g] = canvas2d(total * s, H * s);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  let x = 0;
  widths.forEach((w, i) => {
    drawText(g, x, 0, w * s, c.height, 11 + i * 13 + label.length);
    g.fillStyle = '#6b6357';
    g.font = `600 ${Math.round(c.height * 0.035)}px system-ui`;
    g.fillText(`${label} ${i + 1}`, x + w * s * 0.14, c.height * 0.94);
    if (i) {
      g.setLineDash([10, 8]);
      g.strokeStyle = '#c9c3b8';
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke();
    }
    x += w * s;
  });
  if (cross) {
    g.setLineDash([10, 8]);
    g.strokeStyle = '#c9c3b8';
    g.beginPath(); g.moveTo(0, c.height / 2); g.lineTo(c.width, c.height / 2); g.stroke();
  }
  return toTexture(c);
}

// righe dei fogli sul taglio del blocco
function stripes(vertical) {
  const [c, g] = vertical ? canvas2d(4, 512) : canvas2d(512, 4), r = rng(3);
  for (let i = 0; i < 256; i++) {
    const v = 205 + r() * 50 | 0;
    g.fillStyle = `rgb(${v},${v},${v})`;
    vertical ? g.fillRect(0, i * 2, 4, 2) : g.fillRect(i * 2, 0, 2, 4);
  }
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// fibra della carta: rilievo casuale + fibre corte, convertito in normal map e mappa di ruvidità.
// Si ripete ogni ~40 mm sul foglio (vedi fiberFor)
function fiberMaps() {
  const N = 512, [hc, hg] = canvas2d(N, N), r = rng(9);
  hg.fillStyle = '#808080';
  hg.fillRect(0, 0, N, N);
  for (let i = 0; i < 9000; i++) { // grana fine
    const v = 128 + (r() - 0.5) * 60 | 0;
    hg.fillStyle = `rgba(${v},${v},${v},0.35)`;
    hg.fillRect(r() * N, r() * N, 2 + r() * 3, 2 + r() * 3);
  }
  hg.lineCap = 'round';
  for (let i = 0; i < 1400; i++) { // fibre
    const x = r() * N, y = r() * N, a = r() * Math.PI, l = 6 + r() * 22, v = r() < 0.5 ? 200 : 60;
    hg.strokeStyle = `rgba(${v},${v},${v},0.25)`;
    hg.lineWidth = 0.6 + r();
    hg.beginPath(); hg.moveTo(x, y); hg.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); hg.stroke();
  }
  const hgt = hg.getImageData(0, 0, N, N).data, h = (x, y) => hgt[(((y + N) % N) * N + (x + N) % N) * 4] / 255;
  const [nc, ng] = canvas2d(N, N), [rc, rg] = canvas2d(N, N), nd = ng.createImageData(N, N), rd = rg.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (h(x + 1, y) - h(x - 1, y)) * 2, dy = (h(x, y + 1) - h(x, y - 1)) * 2, l = Math.hypot(dx, dy, 1), i = (y * N + x) * 4;
    nd.data[i] = (-dx / l * 0.5 + 0.5) * 255; nd.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; nd.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; nd.data[i + 3] = 255;
    const g = 205 + h(x, y) * 50; // le fibre in rilievo sono un po' più ruvide
    rd.data[i] = rd.data[i + 1] = rd.data[i + 2] = g; rd.data[i + 3] = 255;
  }
  ng.putImageData(nd, 0, 0); rg.putImageData(rd, 0, 0);
  const wrap = t => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; return t; };
  return { normal: wrap(new THREE.CanvasTexture(nc)), rough: wrap(new THREE.CanvasTexture(rc)) };
}
const fiberBase = fiberMaps();
let fiber = fiberBase;

// trasparenza della carta: la stampa del lato opposto si intravede, specchiata, più o meno a seconda della carta.
// other = texture dell'altro lato; la sua trasformazione uv viene riportata nello spazio uv di questo lato
function seeThrough(m, other, k) {
  if (!other || !m.map || !k) return m;
  m.map.updateMatrix();
  other.updateMatrix();
  const xf = other.matrix.clone().multiply(m.map.matrix.clone().invert());
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { backMap: { value: other }, backXf: { value: xf }, showThrough: { value: k } });
    sh.fragmentShader = 'uniform sampler2D backMap;\nuniform mat3 backXf;\nuniform float showThrough;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      vec3 seen = texture2D( backMap, ( backXf * vec3( vMapUv, 1.0 ) ).xy ).rgb;
      diffuseColor.rgb *= 1.0 - showThrough * ( 1.0 - dot( seen, vec3( 0.299, 0.587, 0.114 ) ) );`);
  };
  m.customProgramCacheKey = () => 'seeThrough';
  return m;
}

const tex = {
  front: null, back: null, spine: null, // immagini caricate dall'utente
  inner: [],                             // foglio i: fronte = inner[2i], retro = inner[2i+1]
};
const stock = {
  cover: coverArt('Titolo'), back: backArt(), spine: spineArt(),
  flyer: coverArt('Flyer', 'Evento · 2026'), poster: coverArt('Poster', 'Mostra · 2026'),
  recto: [textPage(1, false), textPage(2, false)], verso: [textPage(3, true), textPage(4, true)],
  edgeU: stripes(false), edgeV: stripes(true),
};
const lazy = make => { let value; return () => value ||= make(); };
Object.assign(stock, {
  vinylFront: lazy(() => coverArt('Album', 'Artista · LP', 1)),
  vinylBack: lazy(backArt),
  rollup: lazy(() => coverArt('Roll-up', 'Fiera · 2026', 850 / 2000)),
  grooves: lazy(grooveNormal),
  wood: lazy(woodGrain),
});

// solchi del vinile: inclinazione radiale, più marcata tra un brano e l'altro. Dà i riflessi ad anello
function grooveNormal() {
  const N = 1024, [c, g] = canvas2d(N, N), data = g.createImageData(N, N), r = rng(5);
  const gaps = [0.52, 0.63, 0.75, 0.86], jitter = Array.from({ length: 64 }, () => r() * 6.283);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x + 0.5 - N / 2, dy = y + 0.5 - N / 2, d = Math.hypot(dx, dy) || 1, rr = d / (N / 2), i = (y * N + x) * 4;
    let slope = 0;
    if (rr > 0.35 && rr < 0.985) {
      const a = Math.atan2(dy, dx);
      slope = 0.16 * Math.sin(rr * 6.283 * 150 + jitter[(a / 6.283 * 64 + 64) % 64 | 0] * 0.15);
      for (const gap of gaps) slope += 0.5 * Math.exp(-(((rr - gap) / 0.004) ** 2)) * Math.sign(rr - gap);
    }
    const nx = -slope * dx / d, ny = slope * dy / d, l = Math.hypot(nx, ny, 1);
    data.data[i] = (nx / l * 0.5 + 0.5) * 255; data.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
    data.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; data.data[i + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = maxAniso;
  return t;
}

// dorso cucito a vista: una segnatura ogni 8 fogli, punti di filo alle stazioni di cucitura, colla tra le segnature
function sewnSpine(sheets, H) {
  const [c, g] = canvas2d(256, 1024), signatures = Math.max(1, Math.ceil(sheets / 8)), band = 256 / signatures;
  g.fillStyle = '#efe9dd'; g.fillRect(0, 0, 256, 1024);
  const thread = $('cThread').value, stations = 6;
  for (let i = 0; i < signatures; i++) {
    const x = i * band;
    g.fillStyle = 'rgba(70,60,45,0.35)'; g.fillRect(x, 0, Math.max(1, band * 0.08), 1024); // piega della segnatura
    g.fillStyle = `rgba(255,255,255,${0.15 + 0.1 * (i % 2)})`; g.fillRect(x + band * 0.1, 0, band * 0.8, 1024);
    g.fillStyle = thread;
    for (let k = 0; k < stations; k++) {
      const y = 1024 * (0.08 + 0.84 * k / (stations - 1));
      g.fillRect(x + band * 0.5 - 1.5, y - 22, 3, 44); // punto lungo la segnatura
    }
  }
  g.strokeStyle = thread; g.lineWidth = 2;
  for (let k = 0; k < stations; k++) { // il filo passa da una segnatura all'altra
    const y = 1024 * (0.08 + 0.84 * k / (stations - 1)) + 18;
    g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
  }
  return mat({ map: keep(toTexture(c)), roughness: 0.9 });
}

// Rilegatura giapponese: quattro fori a 12 mm dal dorso, il filo passa tra i fori, gira attorno al dorso
// e attorno a testa e piede. Disegnato sopra la grafica di copertina, retro e dorso.
function stabStitch(texture, side, widthMM, heightMM) {
  const img = texture.image, w = img?.width || 512, h = img?.height || 724, [c, g] = canvas2d(w, h);
  if (img) g.drawImage(img, 0, 0, w, h);
  const k = side === 'spine' ? h / heightMM : w / widthMM, lw = Math.max(2, 0.9 * k);
  const ys = [0.12, 0.37, 0.63, 0.88].map(f => f * h);
  g.lineCap = 'round'; g.strokeStyle = $('cThread').value; g.lineWidth = lw;
  const thread = (x0, y0, x1, y1) => {
    g.save(); g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = lw; g.shadowOffsetY = lw * 0.3;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.restore();
  };
  if (side === 'spine') for (const y of ys) thread(0, y, w, y);
  else {
    const edge = side === 'front' ? 0 : w, x = side === 'front' ? 12 * k : w - 12 * k;
    g.fillStyle = 'rgba(30,25,20,0.6)';
    for (const y of ys) { g.beginPath(); g.arc(x, y, lw * 1.1, 0, Math.PI * 2); g.fill(); }
    thread(x, 0, x, h);
    for (const y of ys) thread(x, y, edge, y);
  }
  return keep(toTexture(c));
}

// venatura del legno per i listelli del poster
function woodGrain() {
  const [c, g] = canvas2d(1024, 64), r = rng(11);
  g.fillStyle = '#b48a5e'; g.fillRect(0, 0, 1024, 64);
  for (let i = 0; i < 70; i++) {
    const y = r() * 64, v = r() < 0.5 ? 'rgba(120,80,45,0.25)' : 'rgba(225,190,150,0.2)';
    g.strokeStyle = v; g.lineWidth = 0.5 + r() * 1.5;
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= 1024; x += 64) g.lineTo(x, y + Math.sin(x * 0.004 + i) * 3 * r());
    g.stroke();
  }
  return toTexture(c);
}

const [blankCanvas, blankContext] = canvas2d(4, 4);
blankContext.fillStyle = '#fff'; blankContext.fillRect(0, 0, 4, 4);
stock.blank = toTexture(blankCanvas);
let innerPdfSource = null, coverPdfSource = null, coverPending = null;
let innerImport = 0, coverImport = 0, coverRevision = 0;
let pdfWanted = new Set(), pdfWaiting = new Map(), pdfPageError = false;
let coverBusy = false, innerBusy = false;
const status = (id, message, error = false) => {
  $(id).textContent = message;
  $(id).dataset.error = error;
};
const pdfError = error => /password|destroyed|Password/i.test(error?.message + error?.name)
  ? 'Questo PDF è protetto. Carica una copia senza password.'
  : 'Non riesco a leggere il PDF. Verifica che sia valido e riprova.';

function cropTexture(canvas, region) {
  const [crop, context] = canvas2d(Math.max(1, region.width), region.height);
  context.drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, crop.width, crop.height);
  return toTexture(crop);
}

function neutralCover(front) {
  const [canvas, context] = canvas2d(8, 8);
  context.drawImage(front.image, 0, 0, 1, 1, 0, 0, 8, 8);
  return toTexture(canvas);
}

async function applyCoverPdf(source = coverPending || coverPdfSource) {
  if (!source) return;
  const revision = ++coverRevision;
  coverBusy = true;
  $('coverPdf').disabled = true;
  status('coverStatus', 'Preparo la copertina…');
  const staged = {};
  try {
    const mode = $('coverMode').value === 'auto'
      ? detectCoverMode(source.count, source.width, source.height, +$('w').value, +$('h').value)
      : $('coverMode').value;
    let note = '', description = mode === 'spread' ? 'stesa separata' : 'fronte';
    if (mode === 'spread') {
      const canvas = await source.render(0, 3600);
      const regions = coverRegions(canvas.width, canvas.height, +$('w').value, +$('h').value, +$('t').value, +$('coverBleed').value);
      for (const key of ['front', 'back', 'spine']) if (regions[key]) staged[key] = cropTexture(canvas, regions[key]);
      if (regions.spineMismatch) note = ` Dorso stampato ${regions.printedSpine.toFixed(1)} mm, adattato allo spessore del libro.`;
    } else {
      const count = mode === 'front' ? 1 : Math.min(source.count, 3);
      description = ['fronte', 'fronte e retro', 'fronte, retro e dorso'][count - 1];
      for (let i = 0; i < count; i++) {
        const canvas = await source.render(i, 2200), bleed = +$('coverBleed').value;
        const inset = bleed * canvas.height / (+$('h').value + 2 * bleed);
        staged[['front', 'back', 'spine'][i]] = cropTexture(canvas, { x: inset, y: inset,
          width: Math.max(1, canvas.width - 2 * inset), height: Math.max(1, canvas.height - 2 * inset) });
      }
      if (source.count > count) note = ` Utilizzate le prime ${count} pagine.`;
    }
    // An absent printed side is neutral, never a fictional title or back cover.
    if (!staged.back) staged.back = neutralCover(staged.front);
    if (!staged.spine) staged.spine = neutralCover(staged.front);
    if (revision !== coverRevision) { Object.values(staged).forEach(t => t.dispose()); return; }
    for (const key of ['front', 'back', 'spine']) { tex[key]?.dispose(); tex[key] = staged[key] || null; }
    status('coverStatus', `${source.name} · ${description}.${note}`);
    build(true);
  } catch (error) {
    Object.values(staged).forEach(t => t.dispose());
    if (revision === coverRevision) status('coverStatus', error.message?.startsWith('La stesa') ? error.message : pdfError(error), true);
    throw error;
  } finally {
    if (revision === coverRevision) { coverBusy = false; $('coverPdf').disabled = false; }
  }
}

$('coverPdf').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  const generation = ++coverImport;
  let source;
  coverBusy = true; e.target.disabled = true;
  status('coverStatus', 'Leggo il PDF della copertina…');
  try {
    source = await openPdf(file);
    if (generation !== coverImport) { await source.destroy(); return; }
    coverPending = source;
    await applyCoverPdf(source);
    const previous = coverPdfSource;
    coverPdfSource = source;
    await previous?.destroy();
  } catch (error) { await source?.destroy(); status('coverStatus', error.message?.startsWith('La stesa') ? error.message : pdfError(error), true); }
  finally {
    if (coverPending === source) coverPending = null;
    if (generation === coverImport) { coverBusy = false; e.target.disabled = false; }
  }
};
for (const id of ['coverMode', 'coverBleed']) $(id).onchange = () => applyCoverPdf().catch(() => {});

$('innerPdf').onchange = async e => {
  const file = e.target.files[0];
  if (!file) return;
  const generation = ++innerImport;
  let source;
  innerBusy = true; e.target.disabled = true;
  status('innerStatus', 'Leggo e preparo le prime pagine…');
  try {
    source = await openPdf(file);
    const layout = interiorLayout(source.count, source.width, source.height);
    const first = await Promise.all(Array.from({ length: Math.min(source.count, 6) }, (_, i) => source.render(i)));
    if (generation !== innerImport) { await source.destroy(); return; }
    const previous = innerPdfSource;
    tex.inner.forEach(t => t?.dispose());
    tex.inner = first.map(c => toTexture(c));
    innerPdfSource = source;
    pdfWaiting.clear(); pdfPageError = false;
    $('sheets').value = layout.sheets;
    $('sheets').readOnly = true;
    $('w').value = layout.width.toFixed(1); $('h').value = layout.height.toFixed(1);
    $('turned').value = 0;
    status('innerStatus', `${file.name} · ${source.count} pagine · ${layout.sheets} fogli · ${layout.width.toFixed(1)} × ${layout.height.toFixed(1)} mm${source.count % 2 ? ' · ultimo retro bianco' : ''}`);
    build(true);
    if (coverPdfSource) await applyCoverPdf().catch(() => {});
    await previous?.destroy();
  } catch (error) { await source?.destroy(); status('innerStatus', error.message?.startsWith('Il PDF deve') ? error.message : pdfError(error), true); }
  finally { if (generation === innerImport) { innerBusy = false; e.target.disabled = false; } }
};

function applyPdfTextures() {
  if (!innerPdfSource) return;
  leaves.slice(1).forEach((leaf, i) => {
    const materials = leaf.meshes[0].material;
    for (let face = 0; face < 2; face++) {
      const map = tex.inner[2 * i + face] || stock.blank;
      if (materials[4 + face].map !== map) { materials[4 + face].map = map; materials[4 + face].needsUpdate = true; renderDirty = true; }
    }
  });
}

function syncPdfPages() {
  const source = innerPdfSource;
  if (!source || !leaves.length) return;
  const wanted = exposedPages(Math.max(1, leaves.findIndex(l => !l.left)), leaves.findLastIndex(l => l.left), leaves.length - 1);
  leaves.forEach((leaf, i) => {
    if (i && (leaf.hand || leaf.grab || leaf.angle > .01 && leaf.angle < maxAngle() - .01)) wanted.push((i - 1) * 2, (i - 1) * 2 + 1);
  });
  pdfWanted = new Set(wanted.filter(i => i < source.count));
  for (const index of Object.keys(tex.inner).map(Number)) if (!pdfWanted.has(index)) {
    tex.inner[index]?.dispose(); delete tex.inner[index];
  }
  applyPdfTextures();
  // Render ahead of the exposed spread. Only a small window lives in memory.
  for (const index of pdfWanted) if (!tex.inner[index] && !pdfWaiting.has(index)) {
    const job = source.render(index).then(canvas => {
      if (canvas && source === innerPdfSource && pdfWanted.has(index)) {
        tex.inner[index] = toTexture(canvas); applyPdfTextures();
      }
    }).catch(() => {
      if (source === innerPdfSource && !pdfPageError) {
        pdfPageError = true; status('innerStatus', 'Una pagina del PDF non è leggibile. Ripara il file e ricaricalo.', true);
      }
    }).finally(() => { if (pdfWaiting.get(index) === job) pdfWaiting.delete(index); });
    pdfWaiting.set(index, job);
  }
  source.retain([...pdfWanted, ...pdfWaiting.keys()]);
}

const loadImage = async file => {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} non è un'immagine.`);
  const img = new Image();
  const url = URL.createObjectURL(file);
  try { img.src = url; await img.decode(); return img; }
  finally { URL.revokeObjectURL(url); }
};

for (const key of ['front', 'back', 'spine']) {
  $(key).onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    let img;
    try { img = await loadImage(file); }
    catch (error) { e.target.value = ''; return toast(error.message.endsWith('immagine.') ? error.message : 'Immagine non leggibile.'); }
    tex[key]?.dispose();
    tex[key] = toTexture(img);
    if (key === 'front') { // la copertina detta le proporzioni: altezza fissa, larghezza dal rapporto immagine
      const p = $('product').value;
      const across = p === 'card' || p === 'crossfold' ? 2 : p === 'leaflet' ? ($('fold').value === 'gate' ? 2 : +$('panels').value) : 1;
      $('w').value = Math.round($('h').value * img.width / img.height / across);
    }
    build();
  };
}

$('inner').onchange = async e => {
  const files = [...e.target.files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) return;
  let images;
  try { images = await Promise.all(files.map(loadImage)); }
  catch (error) {
    e.target.value = '';
    return status('innerStatus', error.message.endsWith('immagine.') ? error.message : 'Una delle immagini non è leggibile.', true);
  }
  const staged = images.map((img, i) => i % 2 ? mirror(toTexture(img)) : toTexture(img));
  ++innerImport; // un PDF interno ancora in lettura viene abbandonato: sblocca input ed export
  innerBusy = false; $('innerPdf').disabled = false;
  const previous = innerPdfSource;
  innerPdfSource = null; pdfWaiting.clear(); $('sheets').readOnly = false;
  tex.inner.forEach(t => t.dispose());
  tex.inner = staged;
  $('sheets').value = Math.ceil(files.length / 2);
  status('innerStatus', `${files.length} immagini caricate.`);
  build();
  await previous?.destroy();
};

// ============================================================ carta che si piega
// Un foglio conserva la lunghezza: integriamo una tangente continua lungo l'arco.
// La mano guida lo sfoglio; molle smorzate fanno seguire curvatura e torsione senza
// le instabilità di una catena libera. È un modello di animazione, non un FEM.
const SEG = 48, ROWS = 16, STEP = 1 / 120;
const HAND = 1.35;
const TWIST = 0.13;
const polar = (x, z) => Math.atan2(z, x);
const ease = u => { u = clamp(u, 0, 1); return u * u * u * (10 + u * (-15 + 6 * u)); };

// Soluzione esatta della molla critica: stessa risposta a qualunque frame rate.
function damp(value, velocity, target, frequency, dt) {
  const delta = value - target, j = velocity + frequency * delta, e = Math.exp(-frequency * dt);
  return [target + (delta + j * dt) * e, (velocity - frequency * j * dt) * e];
}

class Leaf {
  constructor(length, rigid, stiff = 1000) {
    Object.assign(this, { L: length, rigid, kb: stiff, left: false, angle: 0, vel: 0,
      hand: null, grab: null, geos: [], meshes: [], oz: 0, H: 1, tg: 1,
      tw: 0, twv: 0, bend: 0, bendv: 0, rand: rng(7),
      gutter: 0, leftGutter: 0, gutterWidth: 0.1, rightLayer: 0, leftLayer: 0,
      restOffset: 0, max: Math.PI, dirty: true, pageThickness: 0, rightSupport: null, leftSupport: null });
    for (const k of ['phi', 'om']) this[k] = new Float64Array(SEG);
    for (const k of ['x', 'z', 'tx', 'tz', 'ang']) this[k] = new Float64Array(SEG + 1);
    this.rowX = new Float64Array((ROWS + 1) * (SEG + 1));
    this.rowZ = new Float64Array((ROWS + 1) * (SEG + 1));
    this.flat(0);
  }

  flat(a) {
    this.angle = a;
    this.vel = 0;
    this.phi.fill(a);
    this.om.fill(0);
    const ds = this.L / SEG;
    for (let k = 0; k <= SEG; k++) {
      this.x[k] = Math.cos(a) * ds * k;
      this.z[k] = Math.sin(a) * ds * k;
      this.ang[k] = a;
    }
    this.dirty = true;
  }

  tip() { return this.angle; }

  attach(geo, mats, parent, pivot) {
    if (!geo.userData.rest) {
      const p = geo.attributes.position;
      geo.userData.rest = {
        x: Float32Array.from({ length: p.count }, (_, v) => p.getX(v)),
        y: Float32Array.from({ length: p.count }, (_, v) => p.getY(v)),
        z: Float32Array.from({ length: p.count }, (_, v) => p.getZ(v)),
        nx: Float32Array.from({ length: p.count }, (_, v) => geo.attributes.normal.getX(v)),
        ny: Float32Array.from({ length: p.count }, (_, v) => geo.attributes.normal.getY(v)),
        nz: Float32Array.from({ length: p.count }, (_, v) => geo.attributes.normal.getZ(v)),
      };
      geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
      geo.attributes.normal.setUsage(THREE.DynamicDrawUsage);
      this.geos.push(geo);
    }
    const m = new THREE.Mesh(geo, mats);
    m.position.set(pivot.x, 0, pivot.z);
    m.castShadow = m.receiveShadow = true;
    m.userData.leaf = this;
    parent.add(m);
    this.meshes.push(m);
  }

  step(dt, time, max) {
    const oldAngle = this.angle, oldBend = this.bend, oldTwist = this.tw, oldMax = this.max;
    this.max = max;
    let target = this.grab ? clamp(this.grab.angle, 0, max) : this.left ? max : 0;
    let direction = Math.sign(target - this.angle) || (this.left ? 1 : -1);
    let twist = 0;
    if (this.hand && !this.grab) {
      const u = (time - this.hand.t0) / this.hand.duration;
      direction = this.hand.dir;
      const destination = this.left ? max : 0;
      target = this.hand.from + (destination - this.hand.from) * ease(u);
      twist = direction * this.hand.twist;
      if (u >= 1) this.hand = null;
    } else if (this.grab) twist = this.grab.twist || 0;
    [this.angle, this.vel] = damp(this.angle, this.vel, target, this.rigid ? 11 : 23, dt);
    this.angle = clamp(this.angle, 0, max);
    const progress = max > 1e-6 ? this.angle / max : 0;
    const lift = Math.sin(Math.PI * progress);
    const flexibility = this.rigid ? 0 : clamp((1000 / Math.max(100, this.kb)) ** 0.3, 0.35, 1.2);
    // Un'unica curva larga: il bordo esterno precede il dorso, senza pieghe a fisarmonica.
    const bendTarget = direction * 0.9 * flexibility * lift;
    [this.bend, this.bendv] = damp(this.bend, this.bendv, bendTarget, 14, dt);
    [this.tw, this.twv] = damp(this.tw, this.twv, twist * this.tg * lift, 16, dt);
    if (lift < 0.00005 && Math.abs(this.vel) < 0.0001) {
      this.angle = target; this.vel = 0; this.bend = this.bendv = this.tw = this.twv = 0;
    }
    if (Math.abs(this.angle - oldAngle) + Math.abs(this.bend - oldBend) + Math.abs(this.tw - oldTwist) + Math.abs(max - oldMax) > 1e-8) this.dirty = true;
    this.curve(0, this.x, this.z);
    for (let k = 0; k < SEG; k++) {
      this.phi[k] = Math.atan2(this.z[k + 1] - this.z[k], this.x[k + 1] - this.x[k]);
      this.om[k] = this.vel;
      this.ang[k + 1] = polar(this.x[k + 1], this.z[k + 1]);
    }
  }

  curve(height, xs, zs, offset = 0) {
    const ds = this.L / SEG, progress = this.max > 1e-6 ? this.angle / this.max : 0;
    const rest = (1 - Math.sin(Math.PI * progress)) ** 2;
    let x = 0, z = 0;
    xs[offset] = x; zs[offset] = z;
    for (let k = 0; k < SEG; k++) {
      const u = (k + 0.5) / SEG, distance = u * this.L;
      const gutterSlope = Math.exp(-distance / this.gutterWidth) / this.gutterWidth;
      const support = this.rigid ? 0 :
        ((1 - progress) * Math.atan(this.gutter * gutterSlope) - progress * Math.atan(this.leftGutter * gutterSlope)) * rest;
      const a = this.angle + support + this.bend * (u - 0.42) + this.tw * height * u * u;
      x += ds * Math.cos(a); z += ds * Math.sin(a);
      xs[offset + k + 1] = x; zs[offset + k + 1] = z;
    }
  }

  deform() {
    if (!this.dirty) return;
    this.dirty = false;
    const ds = this.L / SEG, progress = this.max > 1e-6 ? this.angle / this.max : 0;
    this.curve(0, this.x, this.z);
    for (let row = 0; row <= ROWS; row++) this.curve(row / ROWS - 0.5, this.rowX, this.rowZ, row * (SEG + 1));
    for (const geo of this.geos) {
      const rest = geo.userData.rest, pos = geo.attributes.position, normal = geo.attributes.normal;
      for (let v = 0; v < rest.x.length; v++) {
        const u = clamp(rest.x[v] / ds, 0, SEG), k = Math.min(Math.floor(u), SEG - 1), f = u - k;
        const row = clamp((rest.y[v] / this.H + 0.5) * ROWS, 0, ROWS);
        const r0 = Math.min(Math.floor(row), ROWS - 1), ry = row - r0;
        const sample = (arr, node) => arr[r0 * (SEG + 1) + node] * (1 - ry) + arr[(r0 + 1) * (SEG + 1) + node] * ry;
        const x0 = sample(this.rowX, k), z0 = sample(this.rowZ, k);
        const x1 = sample(this.rowX, k + 1), z1 = sample(this.rowZ, k + 1);
        let dx = x1 - x0, dz = z1 - z0;
        const length = Math.hypot(dx, dz) || 1; dx /= length; dz /= length;
        // Spessore vero, con separazione tra fogli che si annulla nel punto di rilegatura.
        const layer = ((1 - progress) * this.rightLayer - progress * this.leftLayer) * (1 - Math.exp(-rest.x[v] / this.gutterWidth));
        const thickness = rest.z[v] + this.restOffset + layer;
        let px = x0 + (x1 - x0) * f - thickness * dz;
        let pz = z0 + (z1 - z0) * f + thickness * dx;
        const support = progress < 0.08 ? this.rightSupport : progress > 0.92 ? this.leftSupport : null;
        if (support) {
          // Collisione nello spazio del libro, su entrambe le facce e su tutta la pagina.
          // La faccia stampata deve restare sopra l'interno della copertina anche a 180°.
          const pivot = this.meshes[0].position;
          const neutralX = px + pivot.x + rest.z[v] * dz;
          const neutralZ = pz + pivot.z - rest.z[v] * dx;
          const safe = aboveSupport(neutralX, neutralZ, support, this.pageThickness);
          px += safe.x - neutralX; pz += safe.z - neutralZ;
        }
        pos.setXYZ(v, px, rest.y[v], pz);
        if (this.rigid) normal.setXYZ(v, rest.nx[v] * dx - rest.nz[v] * dz, rest.ny[v], rest.nx[v] * dz + rest.nz[v] * dx);
      }
      pos.needsUpdate = true;
      if (this.rigid) normal.needsUpdate = true;
      else geo.computeVertexNormals();
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
    }
  }

  setDetail(high) {
    const shape = this.pageShape;
    if (!shape || shape.high === high) return;
    shape.high = high;
    const geo = new THREE.BoxGeometry(shape.width, shape.height, shape.thickness, high ? SEG : 12, high ? ROWS : 2, 1)
      .translate(shape.width / 2, 0, 0);
    const p = geo.attributes.position, n = geo.attributes.normal;
    geo.userData.rest = {
      x: Float32Array.from({ length: p.count }, (_, v) => p.getX(v)),
      y: Float32Array.from({ length: p.count }, (_, v) => p.getY(v)),
      z: Float32Array.from({ length: p.count }, (_, v) => p.getZ(v)),
      nx: Float32Array.from({ length: p.count }, (_, v) => n.getX(v)),
      ny: Float32Array.from({ length: p.count }, (_, v) => n.getY(v)),
      nz: Float32Array.from({ length: p.count }, (_, v) => n.getZ(v)),
    };
    p.setUsage(THREE.DynamicDrawUsage); n.setUsage(THREE.DynamicDrawUsage);
    this.geos[0].dispose(); this.geos[0] = geo; this.meshes[0].geometry = geo;
    this.dirty = true;
  }
}

// ============================================================ prodotti
const PRODUCTS = {
  hardcover: { w: 150, h: 210, t: 24, sheets: 6, angle: 170, paper: 'bulky' },
  paperback: { w: 130, h: 200, t: 16, sheets: 6, angle: 170, paper: 'offset' },
  magazine:  { w: 210, h: 280, sheets: 6, angle: 176, paper: 'gloss' },
  spiral:    { w: 148, h: 210, sheets: 8, angle: 178, paper: 'offset' },
  exposed:   { w: 150, h: 210, sheets: 12, angle: 178, paper: 'offset' }, // si apre piatta
  singer:    { w: 148, h: 210, sheets: 4, angle: 176, paper: 'offset' },
  flyer:     { w: 148, h: 210, paper: 'silk' },
  poster:    { w: 420, h: 594, paper: 'silk' },
  leaflet:   { w: 99, h: 210, angle: 165, paper: 'gloss' }, // la carta piegata non torna mai piatta del tutto
  card:      { w: 105, h: 148, angle: 115, paper: 'offset' },
  crossfold: { w: 105, h: 148, angle: 172, paper: 'silk' }, // A4 piegato due volte
  vinyl:     { w: 314, h: 314, paper: 'silk' },
  rollup:    { w: 850, h: 2000, paper: 'silk' },
  flag:      { w: 900, h: 600, paper: 'silk' },
  bcard:     { w: 85, h: 55, paper: 'bulky' },
  envelope:  { w: 220, h: 110, paper: 'offset' }, // DL
  box:       { w: 160, h: 90, depth: 120, paper: 'silk' },
  bag:       { w: 320, h: 400, depth: 120, paper: 'offset' },
  japanese:  { w: 148, h: 210, sheets: 10, angle: 150, paper: 'offset' }, // i punti sul piatto limitano l'apertura
};
const BOOKS = ['hardcover', 'paperback', 'magazine', 'spiral', 'exposed', 'singer', 'japanese'];
// stesi sul tavolo: costruiti nel piano x-y come i libri, poi ruotati
const FLAT = [...BOOKS, 'bcard', 'envelope'];
const isFlat = kind => FLAT.includes(kind);
// t: spessore mm; stiff: rigidità a flessione (vedi Leaf): sotto ~500 il foglio non si regge e si affloscia
// bump: rilievo della fibra; see: quanto si vede la stampa dell'altro lato
const PAPERS = {
  gloss:  { t: 0.09, rough: 0.32, coat: 0.35, stiff: 700, bump: 0.045, see: 0.05 },
  silk:   { t: 0.10, rough: 0.64, coat: 0.08, stiff: 850, bump: 0.08, see: 0.07 },
  offset: { t: 0.11, rough: 0.88, coat: 0, stiff: 1000, bump: 0.16, see: 0.12 },
  bulky:  { t: 0.15, rough: 0.94, coat: 0, stiff: 1400, bump: 0.2, see: 0.09 },
};
const CARD = 6000; // cartoncino delle copertine morbide
const LABELS = {
  front: { flyer: 'Fronte', poster: 'Fronte', leaflet: 'Esterno', card: 'Esterno', crossfold: 'Esterno', rollup: 'Grafica', flag: 'Grafica', envelope: 'Fronte (indirizzo)' },
  back: { leaflet: 'Interno', card: 'Interno', crossfold: 'Interno', envelope: 'Retro (lembo)' },
  spine: { vinyl: 'Etichetta del disco' },
  w: { leaflet: 'Larghezza anta', card: 'Larghezza anta', crossfold: 'Larghezza anta' },
};

let root, body, leaves = [], hinges = [], generated = [], paper;
let closedCopy = null, stackLift = 0; // composizioni: copia ferma del prodotto, e di quanto la pila alza il principale
let binding = null;
let scrubIndex = 1;
let shift = 0; // libri: quanto scorre il corpo verso destra da aperto, per tenere la doppia pagina al centro
let centers = null; // pieghevoli: centro da chiuso e da aperto, in coordinate del foglio steso
let pivotX = 0, pivotZ = 0; // cerniera delle pagine: piano su cui si trascinano i fogli

const mat = opts => new THREE.MeshPhysicalMaterial({ roughness: 0.6, ...opts });
// tint: i segnaposto sono bianchi e prendono il colore carta; le immagini dell'utente restano fedeli
const tagSurface = (material, type) => { material.userData.studioSurface = type; material.userData.baseNormal = material.normalScale.clone(); material.userData.baseFinish = { roughness: material.roughness, clearcoat: material.clearcoat, clearcoatRoughness: material.clearcoatRoughness, metalness: material.metalness, sheen: material.sheen }; return material; };
const paperMat = (map, side = THREE.FrontSide, tint = true, other = null) => tagSurface(seeThrough(mat({
  map, side, color: tint ? $('cPaper').value : '#fff',
  roughness: paper.rough, clearcoat: paper.coat, clearcoatRoughness: 0.35,
  specularIntensity: 0.35, sheen: paper.coat ? 0 : 0.12, sheenColor: new THREE.Color('#eee9df'), sheenRoughness: 0.9,
  normalMap: fiber.normal, normalScale: new THREE.Vector2(paper.bump, paper.bump), roughnessMap: fiber.rough,
}), other, paper.see), 'paper');
// copertine plastificate: la fibra si sente appena sotto il film
const coverMat = (map, opts) => tagSurface(mat({ map, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.45,
  normalMap: fiber.normal, normalScale: new THREE.Vector2(0.08, 0.08), roughnessMap: fiber.rough, ...opts }), 'cover');
// fibra in scala: una ripetizione ogni ~40 mm, qualunque sia il formato
function fiberFor(widthMM, heightMM) {
  const n = keep(fiberBase.normal.clone()), r = keep(fiberBase.rough.clone());
  for (const t of [n, r]) { t.repeat.set(widthMM / 40, heightMM / 40); t.needsUpdate = true; }
  return { normal: n, rough: r };
}
const keep = t => (generated.push(t), t); // texture create per questo build: si liberano al prossimo

const FINISHES = {
  matte: [88, 0, 65, 0, 8], gloss: [18, 100, 12, 0, 0],
  soft: [95, 0, 80, 0, 65], metal: [28, 40, 20, 85, 0],
};
function applyMaterials() {
  if (!root) return;
  const seen = new Set(), custom = $('finish').value !== 'original';
  root.traverse(o => {
    if (!o.isMesh) return;
    for (const m of [o.material].flat()) {
      if (seen.has(m) || !m.userData.studioSurface) continue;
      seen.add(m);
      const oldCoat = m.clearcoat > 0, oldSheen = m.sheen > 0;
      // Flat print products use paper materials; book interiors retain their stock.
      const printed = m.userData.studioSurface === 'cover' || (!BOOKS.includes($('product').value) && m.map);
      if (custom && printed) {
        m.roughness = +$('finishRough').value / 100; m.clearcoat = +$('finishCoat').value / 100;
        m.clearcoatRoughness = +$('finishCoatRough').value / 100;
        m.metalness = +$('finishMetal').value / 100; m.sheen = +$('finishSheen').value / 100;
        m.sheenColor.set('#eee9df');
      } else Object.assign(m, m.userData.baseFinish);
      m.normalScale.copy(m.userData.baseNormal).multiplyScalar(+$('fiberStrength').value / 100);
      if (oldCoat !== (m.clearcoat > 0) || oldSheen !== (m.sheen > 0)) m.needsUpdate = true;
    }
  });
  if (fiber) for (const t of [fiber.normal, fiber.rough]) t.repeat.set(+$('w').value / 40, +$('h').value / 40).multiplyScalar(100 / +$('fiberScale').value);
  renderDirty = true;
}

function build(refit = false) {
  renderDirty = shadowDirty = true;
  timers = [];
  resumePlayback();
  if (root) {
    scene.remove(root);
    root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); [o.material].flat().forEach(m => m.dispose()); } });
  }
  generated.forEach(t => t.dispose());
  generated = [];
  leaves = [];
  hinges = [];
  binding = null;
  paper = { ...PAPERS[$('paper').value] };
  if (+$('paperCaliper').value > 0) paper.t = +$('paperCaliper').value;
  paper.stiff *= +$('paperStiffness').value / 100;
  fiber = fiberFor(+$('w').value, +$('h').value);
  root = new THREE.Group(); // gira (piatto rotante)
  body = new THREE.Group(); // il prodotto vero e proprio
  root.add(body);
  shift = 0;
  centers = null;
  movers = []; clothes = [];
  aoHidden.clear();
  resetEnvelope();
  closedCopy = null; stackLift = 0;
  const kind = $('product').value;
  const W = Math.max(+$('w').value, 10) * mm, H = Math.max(+$('h').value, 10) * mm;
  const width = BOOKS.includes(kind) ? buildBook(kind, W, H)
    : kind === 'crossfold' ? buildCross(W, H)
    : kind === 'vinyl' ? buildVinyl(W, H)
    : kind === 'rollup' ? buildRollup(W, H)
    : kind === 'flag' ? buildFlag(W, H)
    : kind === 'bcard' ? buildBusinessCard(W, H)
    : kind === 'envelope' ? buildEnvelope(W, H)
    : kind === 'box' ? buildBox(W, H)
    : kind === 'bag' ? buildBag(W, H)
    : buildFolded(kind, W, H);
  if (!BOOKS.includes(kind) && $('compose').value !== 'single') closedCopy = closedSnapshot(kind);
  if (isFlat(kind)) body.rotation.x = -Math.PI / 2; // appoggiato sul tavolo: lo sfoglio si solleva contro la gravità
  const spread = compose(kind, width, H);
  if (isFlat(kind)) {
    root.position.y = Math.max(body.userData.depth / 2, -(binding?.spine?.mesh.geometry.boundingBox?.min.z ?? 0)) + 0.001 + stackLift;
  } else root.position.y = H / 2 + (body.userData.lift || 0);
  root.userData.baseY = root.position.y;
  scene.add(root);
  applyMaterials();
  if (refit) fit(width * spread, body.userData.fitHeight || H, isFlat(kind));
  if (shadowSoftness) applyShadowSoftness(true);
  startAnimation();
}

function buildBook(kind, W, H) {
  const hard = kind === 'hardcover', mag = kind === 'magazine' || kind === 'singer', pt = paper.t * mm;
  const spec = bookDimensions({ kind, sheets: +$('sheets').value,
    paperThickness: pt, boardThickness: +$('board').value * mm });
  const { count: n, board: b, stock: stockDepth, depth: T } = spec;
  $('t').value = (T / mm).toFixed(2);
  body.userData.depth = T;
  const o = hard ? 3 * mm : 0.4 * mm, PW = W - o, PH = H - 2 * o;
  shift = (W + stockDepth) / 2;
  $('turned').max = n + 1;
  scrubIndex = clamp(scrubIndex, 1, Math.max(1, n));
  $('scrub').disabled = n === 0;
  $('scrubLeaf').textContent = n ? `Sfoglio · foglio ${scrubIndex} di ${n}` : 'Nessun foglio';

  const edge = hard ? mat({ color: $('cBoard').value, roughness: 0.8 }) : paperMat(null);
  const stitched = (texture, side) => kind === 'japanese' ? stabStitch(texture, side, W / mm, H / mm) : texture;
  const endpaper = paperMat(null);
  const add = (geo, mats, x, y, z) => {
    const mesh = new THREE.Mesh(geo, mats);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    body.add(mesh);
    return mesh;
  };
  const board = () => hard ? new RoundedBoxGeometry(W, H, b, 2, Math.min(0.6 * mm, b / 3))
    : new THREE.BoxGeometry(W, H, b, SEG, ROWS, 1);
  const pageTex = i => tex.inner[i] || (innerPdfSource || tex.inner.length ? stock.blank : (i % 2 ? stock.verso : stock.recto)[(i >> 1) % 2]);
  const pageMat = i => paperMat(pageTex(i), THREE.FrontSide, !innerPdfSource && !tex.inner[i], innerPdfSource ? null : pageTex(i ^ 1));

  add(board(), [edge, edge, edge, edge, mag ? pageMat(2 * n) : endpaper,
    coverMat(stitched(tex.back || stock.back, 'back'))], 0, 0, -T / 2 + b / 2);
  const cover = new Leaf(W, hard, CARD);
  Object.assign(cover, { H, tg: hard ? 0 : 0.25, max: maxAngle() });
  cover.attach(board().translate(W / 2, 0, b / 2),
    [edge, edge, edge, edge, coverMat(stitched(tex.front || stock.cover, 'front')), endpaper], body, { x: -W / 2, z: T / 2 - b });
  leaves.push(cover);

  const cutEdge = mat({ color: $('cPaper').value, roughness: 0.96, specularIntensity: 0.2 });
  for (let i = 0; i < n; i++) {
    const high = n <= 40 || i < 4;
    const geo = new THREE.BoxGeometry(PW, PH, pt, high ? SEG : 12, high ? ROWS : 2, 1).translate(PW / 2, 0, 0);
    const leaf = new Leaf(PW, false, paper.stiff);
    Object.assign(leaf, { H: PH, rand: rng(i + 7), max: maxAngle(), pageThickness: pt / 2 });
    let verso = pageTex(2 * i + 1);
    if (!innerPdfSource) {
      verso = keep(verso.clone());
      verso.repeat.x *= -1; verso.offset.x = 1 - verso.offset.x; verso.needsUpdate = true;
    }
    leaf.attach(geo, [cutEdge, cutEdge, cutEdge, cutEdge, pageMat(2 * i),
      paperMat(verso, THREE.FrontSide, !innerPdfSource && !tex.inner[2 * i + 1], innerPdfSource ? null : pageTex(2 * i))], body, { x: -W / 2, z: 0 });
    if (n > 40) leaf.pageShape = { width: PW, height: PH, thickness: pt, high };
    leaves.push(leaf);
  }

  binding = { kind, width: W, height: H, depth: T, board: b, stock: stockDepth, paperThickness: pt, spine: null,
    spineShape: $('spineShape').value };
  // le parti in binding.staples seguono il centro del dorso mentre il libro si apre
  if (kind === 'exposed') binding.spine = buildCaseSpine(H, 0.3 * mm, sewnSpine(n, H), endpaper);
  else if (kind === 'spiral') {
    // wire-o: coppie di anelli ogni 8,47 mm (passo 3:1), attorno al bordo forato dei fogli
    const pitch = 8.47 * mm, count = Math.max(2, Math.floor((PH - 10 * mm) / pitch)), radius = T / 2 + 2.2 * mm;
    const rings = new THREE.InstancedMesh(new THREE.TorusGeometry(radius, 0.55 * mm, 8, 40).rotateX(Math.PI / 2),
      mat({ color: $('cWire').value, metalness: 0.9, roughness: 0.32 }), count * 2);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) for (let k = 0; k < 2; k++)
      rings.setMatrixAt(i * 2 + k, m.makeTranslation(0, (i - (count - 1) / 2) * pitch + (k - 0.5) * 1.8 * mm, 0));
    rings.castShadow = rings.receiveShadow = true;
    body.add(rings);
    binding.staples = [rings];
    body.userData.depth = T + 4.4 * mm; // gli anelli sporgono sotto il libro
  } else if (!mag) binding.spine = buildCaseSpine(H, hard ? Math.min(b * 0.35, 0.8 * mm) : b,
    coverMat(stitched(tex.spine || stock.spine, 'spine')), hard ? edge : endpaper);
  else if (kind === 'singer') {
    // cucitura a macchina lungo la piega: punti di filo da 4 mm
    const thread = mat({ color: $('cThread').value, roughness: 0.85 }), stitch = 7 * mm, count = Math.floor((H - 16 * mm) / stitch);
    binding.staples = Array.from({ length: count }, (_, i) =>
      add(new THREE.BoxGeometry(0.6 * mm, 4 * mm, 0.6 * mm), thread, -W / 2, (i - (count - 1) / 2) * stitch, 0));
  } else {
    const steel = mat({ color: '#c9cdd2', metalness: 1, roughness: 0.3 });
    binding.staples = [H / 4, -H / 4].map(y => add(new THREE.BoxGeometry(0.7 * mm, 14 * mm, 0.7 * mm), steel, -W / 2, y, 0));
  }
  if ($('compose').value !== 'single') {
    leaves.forEach(leaf => { leaf.left = false; leaf.flat(0); leaf.step(STEP, 0, maxAngle()); });
    updateBookBinding(); leaves.forEach(l => l.deform());
    closedCopy = snapshot(body);
  }
  const open = clamp(+$('turned').value, 0, n + 1);
  leaves.forEach((leaf, i) => {
    leaf.left = i < open;
    leaf.flat(leaf.left ? maxAngle() : 0);
    leaf.step(STEP, 0, maxAngle());
  });
  updateBookBinding();
  return 2 * W + T;
}

function buildCaseSpine(H, wall, outer, inner) {
  const segments = 32, geo = new THREE.BufferGeometry();
  const positions = new Float32Array((segments + 1) * 4 * 3), uv = new Float32Array((segments + 1) * 4 * 2);
  const faces = [[], [], []];
  const quad = (bucket, a, b, c, d) => faces[bucket].push(a, b, c, a, c, d);
  for (let j = 0; j <= segments; j++) for (let v = 0; v < 4; v++) {
    uv[(j * 4 + v) * 2] = j / segments;
    uv[(j * 4 + v) * 2 + 1] = v % 2 ? 0 : 1;
  }
  for (let j = 0; j < segments; j++) {
    const a = j * 4, b = a + 4;
    quad(0, a, a + 1, b + 1, b);
    quad(1, a + 2, b + 2, b + 3, a + 3);
    quad(2, a, b, b + 2, a + 2);
    quad(2, a + 1, a + 3, b + 3, b + 1);
  }
  quad(2, 0, 2, 3, 1);
  const e = segments * 4;
  quad(2, e, e + 1, e + 3, e + 2);
  let start = 0;
  const indices = [];
  faces.forEach((face, i) => { geo.addGroup(start, face.length, i); indices.push(...face); start += face.length; });
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(indices);
  const mesh = new THREE.Mesh(geo, [outer, inner, inner]);
  mesh.castShadow = mesh.receiveShadow = true;
  body.add(mesh);
  return { mesh, segments, wall, H, lastPose: '' };
}

function updateBookBinding() {
  if (!binding) return;
  const pose = bindingPose({ ...binding, angles: leaves.map(l => l.angle), maxAngle: maxAngle() });
  binding.pose = pose;
  leaves[0].meshes.forEach(mesh => mesh.position.set(pose.front.x, 0, pose.front.z));
  pose.pages.forEach((page, i) => {
    const leaf = leaves[i + 1];
    const moved = Math.abs(leaf.gutter - page.gutter) + Math.abs(leaf.leftGutter - page.leftGutter)
      + Math.abs(leaf.meshes[0].position.x - page.pin.x) + Math.abs(leaf.meshes[0].position.z - page.pin.z);
    Object.assign(leaf, { gutter: page.gutter, leftGutter: page.leftGutter, gutterWidth: page.gutterWidth,
      rightSupport: page.rightSupport, leftSupport: page.leftSupport });
    leaf.meshes.forEach(mesh => mesh.position.set(page.pin.x, 0, page.pin.z));
    if (moved > 1e-9) leaf.dirty = true;
  });
  pivotX = pose.pages[0]?.pin.x ?? pose.front.x;
  pivotZ = pose.pages[0]?.pin.z ?? pose.front.z;
  if (binding.staples) binding.staples.forEach(mesh => {
    mesh.position.x = (pose.back.x + pose.front.x) / 2;
    mesh.position.z = (pose.back.z + pose.front.z) / 2;
    mesh.rotation.y = -pose.beta;
  });
  if (!binding.spine) return;
  const spine = binding.spine;
  const key = [pose.outerFront.x, pose.outerFront.z, pose.caseArch].map(v => v.toFixed(9)).join(',');
  if (key === spine.lastPose) return;
  spine.lastPose = key;
  const geo = spine.mesh.geometry, pos = geo.attributes.position;
  const dx = pose.outerFront.x - pose.outerBack.x, dz = pose.outerFront.z - pose.outerBack.z;
  const span = Math.hypot(dx, dz) || 1;
  const nx = -dz / span, nz = dx / span;
  for (let j = 0; j <= spine.segments; j++) {
    const f = j / spine.segments, bow = Math.sin(Math.PI * f) * pose.caseArch;
    const x = pose.outerBack.x + dx * f + nx * bow, z = pose.outerBack.z + dz * f + nz * bow;
    for (let v = 0; v < 4; v++) {
      const inset = v >= 2 ? -spine.wall : 0;
      pos.setXYZ(j * 4 + v, x + nx * inset, v % 2 ? -spine.H / 2 : spine.H / 2, z + nz * inset);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals(); geo.computeBoundingSphere(); geo.computeBoundingBox();
  root.position.y = root.userData.baseY = Math.max(binding.depth / 2, -geo.boundingBox.min.z) + 0.001 + stackLift;
}

function buildFolded(kind, W, H) {
  const h = paper.t * mm; // distanza tra ante piegate = spessore carta
  const fold = $('fold').value, p = clamp(Math.floor(+$('panels').value) || 2, 2, 8);
  let widths = [W], rootI = 0, signs = [], offs = [], order = [];
  if (kind === 'card') { widths = [W, W]; rootI = 1; signs = [1]; offs = [h]; order = [0]; }
  if (kind === 'leaflet' && fold === 'zigzag') {
    widths = Array(p).fill(W);
    signs = widths.slice(1).map((_, k) => k % 2 ? -1 : 1);
    offs = signs.map(() => h);
    order = signs.map((_, k) => p - 2 - k); // si apre dall'anta in cima alla pila
  }
  if (kind === 'leaflet' && fold === 'roll') { // le ante interne sono più corte, se no non entrano
    widths = Array.from({ length: p }, (_, k) => k < 2 ? W : W - (k - 1) * 2 * mm);
    signs = widths.slice(1).map(() => 1);
    offs = signs.map((_, k) => h * (p - 1 - k)); // la prima anta avvolge tutte le altre
    order = signs.map((_, k) => k);
  }
  if (kind === 'leaflet' && fold === 'gate') { // due ante a metà che si chiudono sul centro
    widths = [W / 2 - mm, W, W / 2 - mm];
    rootI = 1; signs = [1, 1]; offs = [h, h]; order = [0, 0];
  }
  const total = widths.reduce((a, b) => a + b);
  const sheet = ['flyer', 'poster'].includes(kind);
  const front = tex.front || (sheet ? stock[kind] : keep(sheetArt(widths, H, 'Esterno')));
  const back = tex.back || keep(sheetArt(widths, H, sheet ? 'Retro' : 'Interno'));
  const [plusZ, minusZ] = sheet ? [front, back] : [back, front]; // +z guarda la camera quando è aperto
  const [plusUser, minusUser] = sheet ? [tex.front, tex.back] : [tex.back, tex.front];
  const starts = widths.map((_, k) => widths.slice(0, k).reduce((a, b) => a + b, 0));
  const slice = (t, k, mirrored) => {
    const c = keep(t.clone()), a = starts[k] / total, w = widths[k] / total;
    c.repeat.x = mirrored ? -w : w;
    c.offset.x = mirrored ? 1 - a : a;
    c.needsUpdate = true;
    return c;
  };
  const panel = (k, dir, parent) => {
    const g = new THREE.PlaneGeometry(widths[k], H).translate(dir * widths[k] / 2, 0, 0);
    const plus = slice(plusZ, k, false), minus = slice(minusZ, k, true);
    for (const m of [new THREE.Mesh(g, paperMat(plus, THREE.FrontSide, !plusUser, minus)),
                     new THREE.Mesh(g, paperMat(minus, THREE.BackSide, !minusUser, plus))]) {
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
    }
  };
  // catena di ante: ogni cerniera ruota il gruppo dell'anta successiva. La cerniera sta a spessore-carta
  // dalla superficie, così piegando a 180° l'anta finisce parallela sopra la precedente, senza compenetrarla
  const start = animated() ? Math.PI : Math.PI - maxAngle();
  const groups = [];
  groups[rootI] = new THREE.Group();
  body.add(groups[rootI]);
  // chiuso: centrato sull'anta che resta ferma; aperto: centrato sul foglio (biglietto: sulla piega)
  centers = { root: starts[rootI], closed: starts[rootI] + widths[rootI] / 2, open: kind === 'card' ? starts[rootI] : total / 2, group: groups[rootI] };
  panel(rootI, 1, groups[rootI]);
  const joint = (k, from, to, dir) => { // cerniera k: l'anta "to" si attacca all'anta "from", già posata
    const hinge = new THREE.Group(), inner = new THREE.Group();
    const edgeX = dir > 0 ? widths[from] : from === rootI ? 0 : -widths[from];
    hinge.position.set(edgeX, 0, signs[k] * offs[k]);
    inner.position.z = -signs[k] * offs[k];
    hinge.add(inner);
    groups[from].add(hinge);
    groups[to] = inner;
    panel(to, dir, inner);
    hinges.push({ g: hinge, axis: 'y', rot: -dir * signs[k], angle: start, vel: 0, open: !animated(), order: order[k] });
  };
  for (let k = rootI; k < widths.length - 1; k++) joint(k, k, k + 1, 1);
  for (let k = rootI - 1; k >= 0; k--) joint(k, k + 1, k, -1);
  if (kind === 'poster') addPosterMount(W, H);
  return sheet ? W : total;
}

const part = (geo, material, x = 0, y = 0, z = 0, parent = body) => {
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
};
// cilindro sottile da a a b (corde, fili)
function rod(a, b, radius, material) {
  const dir = b.clone().sub(a), mesh = part(new THREE.CylinderGeometry(radius, radius, dir.length(), 8), material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(Y_AXIS, dir.normalize());
  return mesh;
}

// ============================================================ prodotti speciali
// Piega a croce: il foglio si piega a metà in orizzontale, poi di nuovo in verticale.
// Si apre al contrario: prima la piega verticale, poi le due orizzontali insieme.
function buildCross(W, H) {
  const h = paper.t * mm;
  const front = tex.front || keep(sheetArt([W, W], 2 * H, 'Esterno', true));
  const back = tex.back || keep(sheetArt([W, W], 2 * H, 'Interno', true));
  const slice = (t, col, row, mirrored) => {
    const c = keep(t.clone());
    c.repeat.set(mirrored ? -0.5 : 0.5, 0.5);
    c.offset.set(mirrored ? 1 - col * 0.5 : col * 0.5, row * 0.5);
    c.needsUpdate = true;
    return c;
  };
  const panel = (col, row, parent, dx, dy) => {
    const g = new THREE.PlaneGeometry(W, H, 8, 8).translate(dx, dy, 0);
    const plus = slice(back, col, row, false), minus = slice(front, col, row, true);
    part(g, paperMat(plus, THREE.FrontSide, !tex.back, minus), 0, 0, 0, parent);
    part(g, paperMat(minus, THREE.BackSide, !tex.front, plus), 0, 0, 0, parent);
  };
  const start = animated() ? Math.PI : Math.PI - maxAngle();
  // la cerniera sta a spessore-carta dalla superficie: chiusi, i quattro quarti restano su strati distinti
  const hinge = (parent, axis, y, offset, order) => {
    const g = new THREE.Group(), inner = new THREE.Group();
    g.position.set(0, y, offset); inner.position.z = -offset;
    g.add(inner); parent.add(g);
    hinges.push({ g, axis, rot: 1, angle: start, vel: 0, open: !animated(), order });
    return inner;
  };
  const base = new THREE.Group();
  body.add(base);
  panel(1, 0, base, W / 2, 0);                                // quarto in basso a destra: resta fermo
  panel(1, 1, hinge(base, 'x', H / 2, h, 1), W / 2, H / 2);
  const left = hinge(base, 'y', 0, 2.5 * h, 0);               // la metà sinistra porta già due strati
  panel(0, 0, left, -W / 2, 0);
  panel(0, 1, hinge(left, 'x', H / 2, h, 1), -W / 2, H / 2);
  centers = { root: 0, closed: W / 2, open: 0, group: base };
  return 2 * W;
}

// Vinile: copertina rigida e disco che scivola fuori di lato
function buildVinyl(W, H) {
  const r = Math.min(W, H) * 0.48;
  const edge = mat({ color: $('cPaper').value, roughness: 0.85 });
  part(new RoundedBoxGeometry(W, H, 3.2 * mm, 2, 0.5 * mm), [edge, edge, edge, edge,
    coverMat(tex.front || stock.vinylFront()), coverMat(tex.back || stock.vinylBack())]);
  // superficie del disco: nero con etichetta al centro (immagine "Etichetta" se caricata)
  const N = 1024, [c, g] = canvas2d(N, N);
  g.fillStyle = '#0c0c0d'; g.fillRect(0, 0, N, N);
  g.save(); g.beginPath(); g.arc(N / 2, N / 2, N * 0.165, 0, Math.PI * 2); g.clip();
  if (tex.spine?.image) g.drawImage(tex.spine.image, N * 0.335, N * 0.335, N * 0.33, N * 0.33);
  else {
    g.fillStyle = '#8a3a2a'; g.fillRect(0, 0, N, N);
    g.fillStyle = '#efe6d6'; g.textAlign = 'center'; g.font = '700 34px Georgia, serif';
    g.fillText('LATO A', N / 2, N * 0.43); g.font = '22px Georgia, serif'; g.fillText('33⅓ giri', N / 2, N * 0.6);
  }
  g.restore();
  g.fillStyle = '#d8d8d8'; g.beginPath(); g.arc(N / 2, N / 2, N * 0.009, 0, Math.PI * 2); g.fill(); // foro centrale
  const label = keep(toTexture(c));
  const face = mat({ map: label, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.18,
    normalMap: stock.grooves(), normalScale: new THREE.Vector2(0.7, 0.7) });
  const rim = mat({ color: '#0c0c0d', roughness: 0.4 });
  const disc = part(new THREE.CylinderGeometry(r, r, 1.4 * mm, 160).rotateX(Math.PI / 2), [rim, face, face]);
  mover(v => { disc.position.x = v * W * 0.62; disc.rotation.z = -v * 0.5; renderDirty = true; }, 2.2);
  return W * 1.7;
}

// Roll-up: cassetta in alluminio, asta, grafica che si srotola verso l'alto
function buildRollup(W, H) {
  const floor = -H / 2, alu = mat({ color: '#c9ccd0', metalness: 1, roughness: 0.32 });
  const plastic = mat({ color: '#2b2b2d', roughness: 0.55 });
  const ch = 85 * mm, cd = 95 * mm, foot = 10 * mm, slot = floor + foot + ch;
  part(new RoundedBoxGeometry(W + 30 * mm, ch, cd, 3, 12 * mm), alu, 0, floor + foot + ch / 2, 0);
  for (const side of [-1, 1]) {
    part(new RoundedBoxGeometry(16 * mm, ch + 2 * mm, cd + 2 * mm, 2, 5 * mm), plastic, side * (W / 2 + 22 * mm), floor + foot + ch / 2, 0);
    part(new THREE.BoxGeometry(24 * mm, foot, 380 * mm), plastic, side * (W / 2 - 60 * mm), floor + foot / 2, 0);
  }
  part(new THREE.BoxGeometry(W, 1.5 * mm, 5 * mm), plastic, 0, slot, 0);
  rod(new THREE.Vector3(0, slot, -cd / 2 + 14 * mm), new THREE.Vector3(0, slot + H, -cd / 2 + 14 * mm), 8 * mm, alu);
  const art = keep((tex.front || stock.rollup()).clone());
  art.needsUpdate = true;
  const film = part(new THREE.PlaneGeometry(W, H).translate(0, H / 2, 0),
    coverMat(art, { roughness: 0.5, clearcoat: 0.12, side: THREE.FrontSide }), 0, slot, 0);
  const filmBack = part(film.geometry, mat({ color: '#d4d6d8', roughness: 0.5, side: THREE.BackSide }), 0, slot, 0);
  const rail = part(new THREE.BoxGeometry(W + 6 * mm, 22 * mm, 12 * mm), alu, 0, slot, 0);
  // la grafica esce dall'alto dell'immagine: si vede la parte già srotolata
  mover(v => {
    const k = Math.max(v, 0.001);
    film.scale.y = filmBack.scale.y = k;
    art.repeat.y = k; art.offset.y = 1 - k;
    rail.position.y = slot + k * H + 11 * mm;
    renderDirty = true;
  }, 1.6);
  return W * 1.3;
}

// Bandiera: tessuto su asta con base. Il vento è un'onda che corre dall'asta verso il bordo libero,
// più ampia lontano dall'asta; con poco vento il tessuto cade un po'. Stampa passante: il retro è specchiato.
function buildFlag(W, H) {
  const floor = -H / 2, poleH = H * 3.2, top = floor + poleH, r = 12 * mm;
  const alu = mat({ color: '#c9ccd0', metalness: 1, roughness: 0.3 }), dark = mat({ color: '#2b2b2d', roughness: 0.5 });
  rod(new THREE.Vector3(0, floor, 0), new THREE.Vector3(0, top, 0), r, alu);
  part(new THREE.SphereGeometry(25 * mm, 24, 16), alu, 0, top + 20 * mm, 0);
  part(new THREE.CylinderGeometry(180 * mm, 200 * mm, 30 * mm, 48), dark, 0, floor + 15 * mm, 0);
  const art = tex.front || keep(coverArt('Bandiera', 'Evento · 2026', W / H));
  const geo = new THREE.PlaneGeometry(W, H, 48, 28).translate(W / 2, 0, 0);
  const cloth = new THREE.MeshPhysicalMaterial({ map: art, side: THREE.DoubleSide, roughness: 0.82,
    sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color('#ffffff'),
    normalMap: fiber.normal, normalScale: new THREE.Vector2(0.15, 0.15) });
  const flag = part(geo, cloth, r, top - H / 2 - 40 * mm, 0);
  const pos = geo.attributes.position, rx = Float32Array.from({ length: pos.count }, (_, v) => pos.getX(v)),
    ry = Float32Array.from({ length: pos.count }, (_, v) => pos.getY(v));
  pos.setUsage(THREE.DynamicDrawUsage);
  const wave = t => {
    const wind = +$('wind').value / 100;
    for (let v = 0; v < pos.count; v++) {
      const u = rx[v] / W, y = ry[v] / H, amp = H * (0.02 + 0.1 * wind) * u ** 1.15;
      const phase = 6.283 * rx[v] / (W * 0.6) - t * (1.5 + 3.5 * wind) + y * 0.9;
      const z = amp * (Math.sin(phase) + 0.35 * Math.sin(2.3 * phase + 1.7 + y * 2.2));
      const droop = (1 - wind) ** 2 * 0.18 * H * u * u;
      pos.setXYZ(v, rx[v] * (1 - 0.07 * (0.3 + wind) * u), ry[v] - droop, z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals(); geo.computeBoundingSphere(); geo.computeBoundingBox();
  };
  wave(1.3);
  clothes.push(wave);
  flag.userData.cloth = true;
  body.userData.fitHeight = poleH;
  return W * 1.2;
}

// ============================================================ cartoleria e packaging
// Biglietto da visita: cartoncino spesso, steso. Animato si gira e mostra il retro.
function buildBusinessCard(W, H) {
  const t = 0.42 * mm, edge = mat({ color: $('cPaper').value, roughness: 0.9 }), card = new THREE.Group();
  body.add(card);
  const front = tex.front || keep(coverArt('Nome Cognome', 'Ruolo · Studio', W / H));
  const back = tex.back || keep(logoArt(W / H));
  part(new RoundedBoxGeometry(W, H, t, 2, 0.12 * mm), [edge, edge, edge, edge,
    paperMat(front, THREE.FrontSide, !tex.front), paperMat(back, THREE.FrontSide, !tex.back)], 0, 0, 0, card);
  // giro attorno al lato lungo, sollevandosi quanto serve a non toccare il tavolo
  mover(v => { card.rotation.x = Math.PI * v; card.position.z = Math.sin(Math.PI * v) * H * 0.55; renderDirty = true; }, 2.6, 0, false);
  body.userData.depth = t;
  return W;
}

function logoArt(aspect) {
  const W = 512, H = Math.round(W / aspect), [c, g] = canvas2d(W, H);
  g.fillStyle = '#2d2620'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#d9ccb4'; g.lineWidth = 6; g.beginPath(); g.arc(W / 2, H / 2 - 14, H * 0.16, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#d9ccb4'; g.textAlign = 'center'; g.font = `600 ${Math.round(H * 0.09)}px Georgia, serif`; g.fillText('STUDIO', W / 2, H * 0.82);
  return toTexture(c);
}

// Busta con lettera: due pannelli con la lettera in mezzo. Il lembo si alza, poi la lettera esce.
function buildEnvelope(W, H) {
  const t = 0.3 * mm, gap = 0.5 * mm, edge = mat({ color: $('cPaper').value, roughness: 0.9 });
  const [backCanvas, backG] = canvas2d(1024, Math.round(1024 * H / W));
  backG.fillStyle = '#fff'; backG.fillRect(0, 0, backCanvas.width, backCanvas.height);
  backG.strokeStyle = 'rgba(120,110,95,0.35)'; backG.lineWidth = 2; // pieghe dei lembi laterali e inferiore
  backG.beginPath(); backG.moveTo(0, backCanvas.height); backG.lineTo(backCanvas.width * 0.42, backCanvas.height * 0.45);
  backG.lineTo(backCanvas.width * 0.58, backCanvas.height * 0.45); backG.lineTo(backCanvas.width, backCanvas.height); backG.stroke();
  const back = tex.back || keep(toTexture(backCanvas));
  const [frontCanvas, frontG] = canvas2d(1024, Math.round(1024 * H / W));
  frontG.fillStyle = '#fff'; frontG.fillRect(0, 0, frontCanvas.width, frontCanvas.height);
  drawText(frontG, frontCanvas.width * 0.5, frontCanvas.height * 0.45, frontCanvas.width * 0.45, frontCanvas.height * 0.5, 5);
  const front = tex.front || keep(toTexture(frontCanvas));
  part(new THREE.BoxGeometry(W, H, t), [edge, edge, edge, edge, paperMat(null), paperMat(front, THREE.FrontSide, !tex.front)], 0, 0, -gap);
  part(new THREE.BoxGeometry(W, H, t), [edge, edge, edge, edge, paperMat(back, THREE.FrontSide, !tex.back), paperMat(null)], 0, 0, gap);
  // lembo: trapezio incernierato sul bordo alto; fuori carta, dentro la fodera stampata
  const shape = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(W * 0.07, -H * 0.55), new THREE.Vector2(-W * 0.07, -H * 0.55)]);
  const flapGeo = new THREE.ShapeGeometry(shape), hinge = new THREE.Group();
  hinge.position.set(0, H / 2, gap + t / 2 + 0.15 * mm);
  body.add(hinge);
  const liner = keep(linerArt());
  part(flapGeo, paperMat(null), 0, 0, 0, hinge);
  part(flapGeo, mat({ map: liner, roughness: 0.8, side: THREE.BackSide }), 0, 0, 0, hinge);
  const letter = new THREE.Group(), lw = W - 14 * mm, lh = H - 10 * mm;
  const [letterCanvas, letterG] = canvas2d(1024, Math.round(1024 * lh / lw));
  letterG.fillStyle = '#fff'; letterG.fillRect(0, 0, letterCanvas.width, letterCanvas.height);
  drawText(letterG, 0, 0, letterCanvas.width, letterCanvas.height, 9);
  const letterArt = tex.inner[0] || keep(toTexture(letterCanvas));
  // la lettera esce dalla bocca e si appoggia sopra il lembo aperto: la parte fuori sale di poco più del lembo
  const letterGeo = new THREE.PlaneGeometry(lw, lh, 1, 32), lpos = letterGeo.attributes.position;
  const restY = Float32Array.from({ length: lpos.count }, (_, i) => lpos.getY(i)), lift = hinge.position.z + 0.35 * mm;
  lpos.setUsage(THREE.DynamicDrawUsage);
  part(letterGeo, paperMat(letterArt, THREE.FrontSide, !tex.inner[0]), 0, 0, 0, letter);
  part(letterGeo, paperMat(null, THREE.BackSide), 0, 0, 0, letter);
  body.add(letter);
  mover(v => { hinge.rotation.x = -Math.PI * v; renderDirty = true; }, 2.4, 0);
  mover(v => {
    letter.position.y = v * H * 0.62;
    for (let i = 0; i < lpos.count; i++) {
      const out = clamp((letter.position.y + restY[i] - H / 2 + 1 * mm) / (4 * mm), 0, 1);
      lpos.setZ(i, out * out * (3 - 2 * out) * lift);
    }
    lpos.needsUpdate = true; letterGeo.computeVertexNormals(); letterGeo.computeBoundingSphere();
    renderDirty = true;
  }, 1.8, 1);
  body.userData.depth = 2 * gap + 2 * t;
  return W;
}

function linerArt() {
  const [c, g] = canvas2d(256, 256);
  g.fillStyle = '#8a3a2a'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#d9ccb4';
  for (let y = 0; y < 256; y += 32) for (let x = (y / 32) % 2 * 16; x < 256; x += 32) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3);
  return t;
}

// pareti di cartone: fuori la grafica, dentro il retro del cartoncino
function carton(W, H, D, outer, floor) {
  const th = 0.8 * mm, e = mat({ color: $('cPaper').value, roughness: 0.85 }), inner = paperMat(null);
  part(new THREE.BoxGeometry(W, H, th), [e, e, e, e, outer.front, inner], 0, floor + H / 2, D / 2 - th / 2);
  part(new THREE.BoxGeometry(W, H, th), [e, e, e, e, inner, outer.back], 0, floor + H / 2, -D / 2 + th / 2);
  part(new THREE.BoxGeometry(th, H, D - 2 * th), [inner, outer.side, e, e, e, e], -W / 2 + th / 2, floor + H / 2, 0);
  part(new THREE.BoxGeometry(th, H, D - 2 * th), [outer.side, inner, e, e, e, e], W / 2 - th / 2, floor + H / 2, 0);
  part(new THREE.BoxGeometry(W, th, D), [e, e, inner, outer.side, e, e], 0, floor + th / 2, 0);
  return { th, e, inner };
}
const cartonFaces = front => ({
  front: coverMat(front), back: coverMat(tex.back || front),
  side: coverMat(keep(neutralCover(front))),
});

// Scatola con coperchio incernierato sul retro e linguetta che entra davanti. Animata: unboxing.
function buildBox(W, H) {
  const D = Math.max(10, +$('depth').value) * mm, floor = -H / 2;
  const front = tex.front || keep(coverArt('Prodotto', 'Edizione limitata', W / H));
  const faces = cartonFaces(front), { th, e, inner } = carton(W, H, D, faces, floor);
  const lid = new THREE.Group();
  lid.position.set(0, floor + H, -D / 2);
  body.add(lid);
  const top = tex.front ? faces.side : coverMat(keep(logoArt(W / D)));
  part(new THREE.BoxGeometry(W, th, D), [e, e, top, inner, e, e], 0, th / 2, D / 2, lid);
  part(new THREE.BoxGeometry(W - 2 * mm, 18 * mm, th), [e, e, e, e, inner, inner], 0, -9 * mm + th, D - th * 1.5, lid);
  mover(v => { lid.rotation.x = -1.95 * v; renderDirty = true; }, 1.8, 0, false);
  return W * 1.15;
}

// Shopper: scatola aperta in alto, manici in carta ritorta che si alzano
function buildBag(W, H) {
  const D = Math.max(10, +$('depth').value) * mm, floor = -H / 2;
  const front = tex.front || keep(coverArt('Shopper', 'Collezione 2026', W / H));
  const { th } = carton(W, H, D, cartonFaces(front), floor);
  const rope = mat({ color: '#b8946a', roughness: 0.9, normalMap: fiber.normal, normalScale: new THREE.Vector2(0.6, 0.6) });
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group(), z = side * (D / 2 - th - 2.5 * mm), base = floor + H - 25 * mm;
    pivot.position.set(0, base, z);
    body.add(pivot);
    const curve = new THREE.CatmullRomCurve3([[-0.18, 0], [-0.17, 0.12], [-0.1, 0.22], [0, 0.25], [0.1, 0.22], [0.17, 0.12], [0.18, 0]]
      .map(([x, y]) => new THREE.Vector3(x * W, y * H, 0)));
    part(new THREE.TubeGeometry(curve, 48, 2.5 * mm, 8), rope, 0, 0, 0, pivot);
    // a riposo i manici ricadono verso l'esterno; animati si alzano
    mover(v => { pivot.rotation.x = side * (1 - v) * 1.35; renderDirty = true; }, 2.2, 0);
  }
  return W * 1.15;
}

// supporti del poster: listelli in legno con corda, cornice con vetro, clip
function addPosterMount(W, H) {
  const mount = $('mount').value;
  if (mount === 'hanger') {
    const wood = mat({ map: stock.wood(), roughness: 0.62, normalMap: fiber.normal, normalScale: new THREE.Vector2(0.25, 0.25) });
    for (const y of [H / 2 - 10 * mm, -H / 2 + 10 * mm]) part(new RoundedBoxGeometry(W + 8 * mm, 20 * mm, 9 * mm, 2, 2 * mm), wood, 0, y, 0);
    const cord = mat({ color: '#3b342d', roughness: 0.9 }), top = new THREE.Vector3(0, H / 2 + 0.22 * W, -1 * mm);
    for (const side of [-1, 1]) rod(new THREE.Vector3(side * (W / 2 - 18 * mm), H / 2, -1 * mm), top, 0.7 * mm, cord);
  }
  if (mount === 'frame') {
    const fw = 20 * mm, black = mat({ color: '#151515', roughness: 0.42, clearcoat: 0.25 });
    for (const y of [-1, 1]) part(new RoundedBoxGeometry(W + 2 * fw, fw, 28 * mm, 2, 1.5 * mm), black, 0, y * (H + fw) / 2, -10 * mm);
    for (const x of [-1, 1]) part(new RoundedBoxGeometry(fw, H, 28 * mm, 2, 1.5 * mm), black, x * (W + fw) / 2, 0, -10 * mm);
    part(new THREE.BoxGeometry(W, H, 3 * mm), mat({ color: '#8c8174', roughness: 0.9 }), 0, 0, -2.5 * mm); // pannello di fondo
    const glass = part(new THREE.PlaneGeometry(W, H), new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.03,
      transparent: true, opacity: 0.1, specularIntensity: 1, depthWrite: false }), 0, 0, 3 * mm);
    glass.castShadow = false;
    aoHidden.add(glass);
    body.userData.lift = fw; // la cornice poggia sul tavolo
  }
  if (mount === 'clips') {
    const clip = mat({ color: '#18181a', metalness: 0.6, roughness: 0.35 }), wire = mat({ color: '#c9ccd0', metalness: 1, roughness: 0.25 });
    for (const side of [-1, 1]) {
      const x = side * (W / 2 - 40 * mm);
      part(new RoundedBoxGeometry(32 * mm, 16 * mm, 9 * mm, 2, 2 * mm), clip, x, H / 2 - 5 * mm, 0);
      for (const z of [-1, 1]) for (const dx of [-1, 1])
        rod(new THREE.Vector3(x + dx * 11 * mm, H / 2 + 2 * mm, z * 4 * mm), new THREE.Vector3(x + dx * 6 * mm, H / 2 + 26 * mm, z * 1 * mm), 0.8 * mm, wire);
    }
  }
}

// ============================================================ composizioni
// Copia ferma e chiusa del prodotto: geometrie proprie, materiali condivisi
function snapshot(object) {
  const copy = object.isInstancedMesh ? new THREE.InstancedMesh(object.geometry.clone(), object.material, object.count)
    : object.isMesh ? new THREE.Mesh(object.geometry.clone(), object.material) : new THREE.Group();
  if (object.isInstancedMesh) copy.instanceMatrix.copy(object.instanceMatrix);
  copy.position.copy(object.position); copy.quaternion.copy(object.quaternion); copy.scale.copy(object.scale);
  Object.assign(copy, { visible: object.visible, castShadow: object.castShadow, receiveShadow: object.receiveShadow, renderOrder: object.renderOrder });
  for (const child of object.children) copy.add(snapshot(child));
  return copy;
}

function closedSnapshot(kind) {
  hinges.forEach(g => g.g.rotation[g.axis] = g.rot * Math.PI);
  if (centers) centers.group.position.x = centers.root - centers.closed;
  movers.forEach(m => m.apply(kind === 'rollup' ? 1 : 0)); // un roll-up si espone montato
  const copy = snapshot(body);
  movers.forEach(m => m.apply(m.value));
  return copy;
}

// Dispone le copie attorno al prodotto principale. Ritorna di quanto si allarga la scena.
function compose(kind, span, H) {
  const mode = $('compose').value;
  if (mode === 'single' || !closedCopy) return 1;
  const flat = isFlat(kind);
  closedCopy.quaternion.copy(body.quaternion);
  closedCopy.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(closedCopy).getSize(new THREE.Vector3());
  const w = size.x, t = flat ? size.y : size.z, d = flat ? size.z : size.y, gap = 0.1 * w;
  const side = span / 2 + gap + w / 2;
  const places = [];
  if (mode === 'pair') places.push({ x: -side, z: flat ? -0.1 * d : -0.35 * w, yaw: flat ? 0.1 : 0.35 });
  if (mode === 'row') places.push({ x: -side }, { x: side });
  if (mode === 'back') places.push({ x: -side, z: flat ? 0 : -0.3 * w, yaw: flat ? -0.06 : 0.3, back: true });
  const depth = flat ? d + gap : 0.7 * w; // passo in profondità
  if (mode === 'grid') places.push({ x: -side }, { x: flat ? 0 : -side / 2, z: -depth }, { x: flat ? -side : side / 2, z: -depth });
  if (mode === 'scatter') for (const [x, z, yaw] of [[-1.15, -0.55, 0.22], [1.15, -0.6, -0.2], [-1.05, 0.7, -0.14], [1.1, 0.75, 0.25]])
    places.push({ x: x * (side + 0.1 * w), z: z * (flat ? d : w), yaw: flat ? yaw : yaw * 1.5 });
  if (mode === 'arc') for (const a of [Math.PI, Math.PI - 0.75, Math.PI + 0.75, Math.PI - 1.5, Math.PI + 1.5]) {
    // copie disposte ad arco dietro al principale, rivolte verso l'esterno
    const radius = span / 2 + gap + Math.max(w, flat ? d : 0) * 0.75;
    places.push({ x: radius * Math.sin(a), z: radius * Math.cos(a), yaw: flat ? a + Math.PI : a + Math.PI });
  }
  if (mode === 'cascade') for (let k = 1; k <= 3; k++) {
    // a scalare: ogni copia un po' più indietro e di lato; stese sul tavolo si sovrappongono come carte
    places.push(flat ? { x: -0.3 * w * k, y: -k * (t + 0.4 * mm), z: -0.25 * d * k } : { x: -0.35 * w * k, z: -0.2 * w * k });
  }
  if (mode === 'tower') for (let k = 1; k <= 6; k++) {
    const jitter = Math.sin(k * 2.3) * 0.06;
    places.push(flat ? { x: 0.025 * w * Math.sin(k * 1.7), y: -k * (t + 0.4 * mm), z: 0.02 * d * Math.cos(k * 2.1), yaw: jitter }
      : { x: -0.08 * w * k, z: -k * (t + 0.02 * w), yaw: jitter });
  }
  if (mode === 'stack' || mode === 'fan') for (let k = 1; k <= 3; k++) {
    const turn = mode === 'fan' ? 0.2 * k : 0.045 * k * (k % 2 ? 1 : -1);
    if (flat) {
      // una sopra l'altra; il ventaglio ruota attorno all'angolo del dorso in basso
      const pivot = mode === 'fan' ? new THREE.Vector3(-w / 2, 0, d / 2) : new THREE.Vector3(0.03 * w * k, 0, 0);
      const center = pivot.clone().sub(pivot.clone().applyAxisAngle(Y_AXIS, turn));
      places.push({ x: center.x + (mode === 'stack' ? 0.03 * w * k : 0), y: -k * (t + 0.4 * mm), z: center.z, yaw: turn });
    } else if (mode === 'fan') {
      // in piedi, a ventaglio nel piano del foglio, attorno all'angolo in basso a sinistra
      const pivot = new THREE.Vector3(-w / 2, -H / 2, 0), center = pivot.clone().sub(pivot.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), turn));
      places.push({ x: center.x, y: center.y, z: -k * (t + 4 * mm), roll: turn });
    } else places.push({ x: -0.14 * w * k, z: -k * (t + 0.03 * w), yaw: 0.04 * k });
  }
  for (const place of places) {
    place.x = (place.x || 0) * +$('copySpacing').value / 100;
    place.z = (place.z || 0) * +$('copySpacing').value / 100;
    const holder = new THREE.Group(), copy = places.length === 1 ? closedCopy : snapshot(closedCopy);
    holder.position.set(place.x || 0, place.y || 0, place.z || 0);
    holder.rotation.set(0, place.yaw || 0, place.roll || 0);
    if (place.back) flat ? holder.rotateZ(Math.PI) : holder.rotateY(Math.PI);
    holder.add(copy);
    root.add(holder);
  }
  if (flat) stackLift = -Math.min(0, ...places.map(p => p.y || 0)); // la copia più bassa poggia sul tavolo, il principale sopra
  if (!closedCopy.parent) closedCopy.traverse(o => o.isMesh && o.geometry.dispose()); // usata solo come stampo
  const extent = Math.max(span / 2, ...places.map(p => Math.abs(p.x || 0) + w / 2 + Math.abs(p.z || 0) * 0.3));
  return Math.max(1.15, 2 * extent / span);
}

// ============================================================ animazione
let timers = [], simTime = 0, movers = [], clothes = []; // clothes: tessuti mossi dal vento, campionati da simTime
// parte mobile: value va da 0 (chiuso) a 1 (aperto); apply posa le mesh
function mover(apply, frequency = 3, order = 0, staticOpen = true) {
  const m = { value: 0, vel: 0, open: false, order, moved: true, apply, staticOpen,
    step(h) {
      const before = m.value;
      [m.value, m.vel] = damp(m.value, m.vel, m.open ? 1 : 0, frequency, h);
      if (Math.abs(m.value - before) > 1e-7) { m.moved = true; apply(m.value); }
    },
    reset(value = 0) { m.value = value; m.vel = 0; m.moved = true; apply(value); } };
  m.reset(animated() || !staticOpen ? 0 : 1); // fermo: nella posa scelta dal prodotto, senza animarsi
  movers.push(m);
  return m;
}
const later = (d, fn) => timers.push({ t: simTime + d, fn });
const STAGGER = HAND + 0.3; // lascia terminare l'appoggio prima di sollevare il foglio successivo
let presetTime = 0;
// Sfoglio (azione del prodotto) e movimento (preset di camera/prodotto) si combinano liberamente
const animated = () => $('action').value !== 'static';
const maxAngle = () => clamp(+$('angle').value, 0, 180) * Math.PI / 180;

function turn(i, toLeft, pace = 1) {
  const leaf = leaves[i];
  if (!leaf || (leaf.left === toLeft && !leaf.hand)) return;
  leaf.left = toLeft;
  if (i > 0) {
    scrubIndex = i;
    $('scrubLeaf').textContent = `Sfoglio · foglio ${i} di ${leaves.length - 1}`;
  }
  if (leaf.rigid) return; // la molla porta il cartone dal suo lato
  const r = leaf.rand;
  leaf.hand = { t0: simTime, from: leaf.angle, duration: HAND * (0.97 + 0.06 * r()) / pace,
    dir: toLeft ? 1 : -1, twist: TWIST * (0.85 + 0.3 * r()) };
}

// porta il libro alla doppia pagina c (0 = chiuso), un foglio alla volta
function turnTo(c) {
  timers = [];
  let d = 0;
  leaves.forEach((l, i) => { if (i < c && !l.left) { later(d, () => turn(i, true)); d += STAGGER; } });
  for (let i = leaves.length - 1; i >= 0; i--) if (i >= c && leaves[i].left) { later(d, () => turn(i, false)); d += STAGGER; }
  return d;
}

function bookCycle() {
  let t = 0.6;
  leaves.forEach((_, i) => { later(t, () => turn(i, true)); t += STAGGER; });
  t += HAND + 2.2;
  for (let i = leaves.length - 1; i >= 0; i--) { later(t, () => turn(i, false)); t += STAGGER; }
  later(t + HAND + 1.4, bookCycle);
}

function foldCycle() {
  const parts = [...hinges, ...movers];
  if (!parts.length) return;
  const steps = Math.max(...parts.map(h => h.order)) + 1;
  parts.forEach(h => later(0.6 + h.order * 0.45, () => h.open = true));
  const back = 0.6 + steps * 0.45 + 2.4;
  parts.forEach(h => later(back + (steps - 1 - h.order) * 0.45, () => h.open = false));
  later(back + steps * 0.45 + 1.6, foldCycle);
}

// sfoglio rapido, come col pollice: la copertina si apre con calma, poi i fogli corrono
const RIFFLE = 2.4, RIFFLE_GAP = 0.1;
function riffleCycle() {
  let t = 0.6;
  later(t, () => turn(0, true)); t += 1.3;
  for (let i = 1; i < leaves.length; i++) { later(t, () => turn(i, true, RIFFLE)); t += RIFFLE_GAP; }
  t += HAND / RIFFLE + 1.6;
  for (let i = leaves.length - 1; i >= 1; i--) { later(t, () => turn(i, false, RIFFLE)); t += RIFFLE_GAP; }
  t += HAND / RIFFLE + 0.4;
  later(t, () => turn(0, false));
  later(t + 2.6, riffleCycle);
}

// apre a metà libro (in fretta), poi una pagina avanti e indietro con calma
function middleCycle(first = true) {
  const mid = Math.max(1, Math.ceil((leaves.length - 1) / 2));
  let t = 0.4;
  if (first) {
    later(t, () => turn(0, true)); t += 1.3;
    for (let i = 1; i < mid; i++) { later(t, () => turn(i, true, RIFFLE)); t += RIFFLE_GAP; }
    t += 1.2;
  }
  const page = Math.min(mid, leaves.length - 1);
  later(t, () => turn(page, true)); t += HAND + 1.6;
  later(t, () => turn(page, false)); t += HAND + 1.6;
  later(t, () => middleCycle(false));
}

function coverCycle() {
  later(0.6, () => turn(0, true));
  later(3.8, () => turn(0, false));
  later(7.4, coverCycle);
}

// riparte il movimento (preset) senza toccare lo sfoglio
function startMotion() {
  presetTime = 0;
  if (typeof root === 'undefined' || !root) return;
  root.rotation.set(0, 0, 0);
  lastPose = presentationPose('none', 0);
  resetEnvelope();
  if (($('anim').value !== 'none' || animated()) && fittedCamera) { camera.position.copy(fittedCamera.position); controls.target.copy(fittedCamera.target); controls.update(); }
}

function startAnimation() {
  if (typeof renderDirty !== 'undefined') renderDirty = shadowDirty = true;
  timers = [];
  leaves.forEach(l => l.hand = null);
  startMotion();
  if (animated()) {
    const cycle = { cover: coverCycle, riffle: riffleCycle, middle: middleCycle }[$('action').value] || bookCycle;
    if (leaves.length) { const closing = turnTo(0); later(closing + 0.4, () => cycle()); }
    else { [...hinges, ...movers].forEach(h => h.open = false); later(0.3, foldCycle); }
  } else {
    if (leaves.length) turnTo(+$('turned').value);
    hinges.forEach(h => h.open = true);
    movers.forEach(m => m.open = m.staticOpen);
  }
}

function restartAnimation() {
  releasePage();
  simTime = presetTime = acc = 0;
  resumePlayback();
  const initial = animated() ? 0 : +$('turned').value;
  leaves.forEach((leaf, i) => { leaf.hand = leaf.grab = null; leaf.left = i < initial; leaf.flat(leaf.left ? maxAngle() : 0); });
  hinges.forEach(h => { h.open = false; h.angle = Math.PI; h.vel = 0; });
  movers.forEach(m => { m.open = false; m.reset(0); });
  startAnimation();
}

function stepAll(h) {
  simTime += h;
  const due = timers.filter(x => x.t <= simTime);
  timers = timers.filter(x => x.t > simTime);
  due.forEach(x => x.fn());
  const max = maxAngle();
  leaves.forEach(l => l.step(h, simTime, max));
  movers.forEach(m => m.step(h));
  for (const g of hinges) { // pieghe della carta: molla quasi critica, si assestano senza rimbalzare
    const target = g.open ? Math.PI - max : Math.PI;
    g.vel += (45 * (target - g.angle) - 11 * g.vel) * h;
    g.angle += g.vel * h;
  }
}

const clock = new THREE.Clock();
let acc = 0, drag = null;
const app = window.app = { paused: false, advance: s => { for (let i = 0; i < s / STEP; i++) stepAll(STEP); }, leaves: () => leaves, camera, scene, gtao, renderer }; // per i test

let lastPose = presentationPose('none', 0), exporting = false;
const PRODUCT_MOTION = ['spin', 'float', 'both', 'swing', 'flip', 'drop', 'topdown', 'whip', 'tumble', 'slide', 'stopmotion', 'pop', 'showcase', 'turntable', 'tilt', 'roll360'];

// Lente: scala e posizione del soggetto nel quadro (spostamento ottico, la prospettiva non cambia)
const lens = {};
function applyLens(zoomFactor) {
  const { width, height } = canvasSize;
  const zoom = +$('subjScale').value / 100 * zoomFactor;
  const x = -$('subjX').value / 100 * width, y = +$('subjY').value / 100 * height;
  if (lens.zoom === zoom && lens.x === x && lens.y === y && lens.width === width && lens.height === height) return;
  Object.assign(lens, { zoom, x, y, width, height });
  camera.zoom = zoom;
  camera.setViewOffset(width, height, x, y, width, height);
  renderDirty = true;
}

function tick(dt, render = true) {
  if (!app.paused) {
    presetTime += dt;
    acc += dt;
    for (let i = 0; acc >= STEP && i < 30; i++) { stepAll(STEP); acc -= STEP; }
  }
  syncPdfPages();
  const max = maxAngle();
  const firstRight = Math.max(1, leaves.findIndex(l => !l.left)), lastLeft = leaves.findLastIndex(l => l.left);
  leaves.forEach((leaf, i) => leaf.setDetail(Boolean(leaf.hand || leaf.grab || leaf.angle > .01 && leaf.angle < max - .01
    || Math.abs(i - firstRight) <= 2 || Math.abs(i - lastLeft) <= 2)));
  root.position.y = root.userData.baseY;
  updateBookBinding();
  if (leaves.some(l => l.dirty) || hinges.some(g => Math.abs(g.g.rotation[g.axis] - g.rot * g.angle) > 1e-6) || movers.some(m => m.moved)) renderDirty = shadowDirty = true;
  movers.forEach(m => m.moved = false);
  if (clothes.length && !app.paused) { clothes.forEach(c => c(simTime)); renderDirty = shadowDirty = true; }
  if (gobo.visible && $('goboMove').checked && !app.paused) { placeGobo(simTime); renderDirty = shadowDirty = true; }
  leaves.forEach(l => l.deform());
  if (leaves.length) body.position.x = shift * clamp(leaves[0].tip() / Math.max(max, 1e-6), 0, 1);
  if (centers) {
    const open = hinges.length ? hinges.reduce((a, g) => a + 1 - g.angle / Math.PI, 0) / hinges.length : 1;
    centers.group.position.x = centers.root - (centers.closed + (centers.open - centers.closed) * clamp(open, 0, 1));
  }
  hinges.forEach(g => g.g.rotation[g.axis] = g.rot * g.angle);
  if (!animated() && !drag && document.activeElement !== $('turned')) $('turned').value = leaves.filter(l => l.left).length;
  const mode = $('anim').value, cameraMode = CAMERA_MODES.includes(mode);
  if (!cameraMode) controls.update();
  // con "Ferma" la posa resta quella dell'ultimo istante: il prodotto rimane dov'era
  if (mode !== 'none' && !app.paused) lastPose = amplifyPose(presentationPose(mode, ($('motionReverse').checked ? -presetTime : presetTime) + +$('motionPhase').value / 100 * +$('secs').value, +$('secs').value, { flat: isFlat($('product').value) }), +$('motionAmount').value / 100);
  const pose = lastPose;
  root.rotation.set(pose.pitch, pose.yaw + THREE.MathUtils.degToRad(+$('subjRot').value), pose.roll);
  root.position.y += pose.lift * productSize();
  root.position.x = pose.x * productSize(); root.position.z = pose.z * productSize();
  root.scale.setScalar(Math.max(pose.scale, 1e-3));
  if (!$('autoFrame').checked && cameraMode && fittedCamera) {
    camera.position.copy(fittedCamera.target).add(orbitView(fittedCamera.position.clone().sub(fittedCamera.target), pose));
    camera.lookAt(fittedCamera.target);
  }
  if (mode !== 'none' && !app.paused) { renderDirty = true; if (PRODUCT_MOTION.includes(mode)) shadowDirty = true; }
  controls.enabled = !cameraMode;
  if ($('autoFrame').checked && !drag && (!app.paused || frameOnce)) frameProduct(frameOnce ? 0 : Math.min(dt || STEP, .1), pose);
  frameOnce = false;
  applyLens(pose.zoom);
  syncTimeline();
  syncSliderValues();
  if (render && renderDirty) draw();
}

app.tick = tick; // per i test: fotogrammi deterministici

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1) * +$('speed').value;
  if (!exporting) tick(dt);
});

function draw() {
  renderDirty = false;
  if (shadowDirty) { renderContactShadow(); renderer.shadowMap.needsUpdate = true; shadowDirty = false; }
  const playing = !app.paused && ($('anim').value !== 'none' || animated());
  gtao.enabled = $('quality').value === 'high' && !($('fastPreview').checked && playing && !exporting);
  finish.uniforms.vignette.value = +$('vignette').value / 100;
  finish.uniforms.grain.value = +$('grain').value / 100;
  finish.uniforms.frame.value = Math.floor(simTime * 30);
  finish.uniforms.aspect.value = canvasSize.width / canvasSize.height;
  finish.enabled = finish.uniforms.vignette.value > 0 || finish.uniforms.grain.value > 0;
  bokeh.enabled = $('dof').checked;
  bokeh.uniforms.aperture.value = 0.002 * +$('lensBlur').value / 100;
  bokeh.uniforms.focus.value = Math.max(0.01, camera.position.distanceTo(controls.target) + +$('focusOffset').value * mm); // a fuoco sul prodotto
  composer.render();
}

// ============================================================ sfoglio col mouse
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(), hit = new THREE.Vector3();
const pickable = () => leaves.flatMap(l => l.meshes);

function aim(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ndc, camera);
}

// x del puntatore sul piano della cerniera (coordinate libro), relativa alla cerniera; null se il piano è di taglio
function pageX(e, leaf = drag?.leaf) {
  aim(e);
  plane.setFromNormalAndCoplanarPoint(
    new THREE.Vector3(0, 0, 1).transformDirection(body.matrixWorld),
    body.localToWorld(new THREE.Vector3(0, 0, leaf?.meshes[0].position.z ?? pivotZ)));
  return ray.ray.intersectPlane(plane, hit) ? body.worldToLocal(hit).x - (leaf?.meshes[0].position.x ?? pivotX) : null;
}

// capture sul contenitore: arriva prima di OrbitControls, che sta sul canvas
$('stage').addEventListener('pointerdown', e => {
  if (e.button !== 0 || !e.isPrimary) return;
  aim(e);
  const h = ray.intersectObjects(pickable())[0];
  if (!h) return;
  e.stopPropagation(); // niente orbita mentre si sfoglia
  resumePlayback();
  if (animated()) $('action').value = 'static'; // prendi il controllo: il libro resta dov'era
  $('anim').value = 'none';
  timers = [];
  leaves.forEach(l => l.hand = null);
  // si afferra sempre il foglio in cima alla pila del lato toccato
  const i = h.object.userData.leaf.left ? leaves.findLastIndex(l => l.left) : leaves.findIndex(l => !l.left);
  const leaf = leaves[i];
  if (!leaf) return;
  const p = body.worldToLocal(h.point.clone());
  const r = clamp(Math.hypot(p.x - leaf.meshes[0].position.x, p.z - leaf.meshes[0].position.z), leaf.L * 0.25, leaf.L);
  const vg = clamp(p.y / (leaf.H / 2), -1, 1); // -1 angolo in basso, +1 angolo in alto
  drag = { leaf, r, vg, x0: pageX(e, leaf), a0: leaf.angle };
  renderer.domElement.style.cursor = 'grabbing';
}, true);

addEventListener('pointermove', e => {
  if (!drag) {
    if (e.target !== renderer.domElement) return;
    aim(e);
    renderer.domElement.style.cursor = ray.intersectObjects(pickable()).length ? 'grab' : '';
    return;
  }
  const x = pageX(e);
  if (x === null || drag.x0 === null) return;
  // trascinare per due raggi = mezzo giro; il punto preso si avvicina al dorso mentre sale, come dal vero
  const a = clamp(drag.a0 + (drag.x0 - x) / (2 * drag.r) * Math.PI, 0, maxAngle());
  // la fila presa guida, il resto del foglio segue torcendosi; da piatto (sin = 0) non c'è torsione
  drag.leaf.grab = { angle: a, twist: -Math.sign(a - drag.a0) * drag.vg * TWIST * Math.sin(a) };
});

function releasePage() {
  if (!drag) return;
  const { leaf } = drag;
  leaf.grab = null; // la direzione e l'inerzia del gesto scelgono il lato di appoggio
  leaf.left = leaf.angle + leaf.vel * 0.08 > maxAngle() / 2;
  drag = null;
  renderer.domElement.style.cursor = '';
}
addEventListener('pointerup', releasePage);
addEventListener('pointercancel', releasePage);
addEventListener('blur', releasePage);

// ============================================================ interfaccia
function applyProduct(useDefaults = true) {
  const kind = $('product').value, d = PRODUCTS[kind];
  if (useDefaults) {
    for (const id of ['w', 'h', 't', 'sheets', 'angle', 'paper', 'depth']) {
      if (innerPdfSource && ['w', 'h', 'sheets'].includes(id)) continue;
      if (d[id] !== undefined) $(id).value = d[id];
    }
    $('turned').value = 0;
  }
  document.querySelectorAll('[data-for]').forEach(el => el.hidden = !el.dataset.for.split(' ').includes(kind));
  $('lFront').textContent = LABELS.front[kind] || 'Copertina';
  $('lBack').textContent = LABELS.back[kind] || 'Retro';
  $('lW').textContent = LABELS.w[kind] || 'Larghezza';
  $('lSpine').textContent = LABELS.spine[kind] || 'Dorso';
  build(true);
}

function manualPage(dir) {
  resumePlayback();
  $('action').value = 'static';
  timers = [];
  leaves.forEach(l => l.hand = null);
  const index = dir > 0 ? leaves.findIndex(l => !l.left) : leaves.findLastIndex(l => l.left);
  if (index >= 0) turn(index, dir > 0);
}
$('prevPage').onclick = () => manualPage(-1);
$('nextPage').onclick = () => manualPage(1);
$('scrub').oninput = () => {
  $('action').value = 'static';
  timers = [];
  if (leaves.length < 2) return;
  // Ispeziona il foglio scelto dallo sfoglio corrente, conservando l'ordine delle due pile.
  const phase = +$('scrub').value / 100;
  const current = clamp(scrubIndex, 1, leaves.length - 1);
  leaves.forEach((leaf, i) => {
    leaf.hand = leaf.grab = null;
    leaf.left = i < current || (i === current && phase > 0.5);
    leaf.flat(i < current ? maxAngle() : i === current ? phase * maxAngle() : 0);
    leaf.bend = i === current ? 0.9 * (1000 / paper.stiff) ** 0.3 * Math.sin(Math.PI * phase) : 0;
    leaf.tw = i === current ? TWIST * Math.sin(Math.PI * phase) : 0;
    leaf.step(STEP, simTime, maxAngle());
  });
  setPaused(true);
  frameOnce = true;
};
function setPaused(paused) {
  app.paused = paused;
  if ($('pause').dataset.paused !== String(paused)) {
    $('pause').dataset.paused = paused;
    setLabel('pause', paused ? 'play' : 'pause', '');
    $('pause').setAttribute('aria-label', paused ? 'Riprendi' : 'Pausa');
    $('pause').title = paused ? 'Riprendi (Spazio)' : 'Pausa (Spazio)';
  }
}
function resumePlayback() { setPaused(false); }
$('anim').addEventListener('change', resumePlayback);
$('turned').addEventListener('input', resumePlayback);
$('product').onchange = () => applyProduct();
$('anim').onchange = startMotion;
$('action').onchange = () => {
  resumePlayback();
  if (!animated()) $('turned').value = leaves.filter(l => l.left).length;
  startAnimation();
};
$('restart').onclick = restartAnimation;
$('pause').onclick = () => setPaused(!app.paused);
$('form').addEventListener('input', e => {
  renderDirty = true;
  if (e.target.classList.contains('rb')) build(['w', 'h', 'compose', 'mount'].includes(e.target.id));
  if (e.target.id.startsWith('subj')) { resetEnvelope(); shadowDirty = true; }
  if (['lightAz', 'lightEl', 'lightPow', 'envPow', 'shadowPow', 'lightTemp', 'gobo', 'goboMove'].includes(e.target.id)) {
    if (e.target.id !== 'goboMove') $('lightPreset').value = 'custom';
    placeSun();
  }
  if (e.target.id === 'lightPreset') applyLightPreset(e.target.value);
  if (e.target.id === 'surface') applySurface();
  if (['bgMode', 'cBg'].includes(e.target.id)) applyBackground();
  if (e.target.id === 'focal') { applyFocal(); frameOnce = true; }
  if (e.target.id === 'wind') shadowDirty = true;
  if (e.target.id === 'turned') {
    if (animated()) { $('action').value = 'static'; leaves.forEach(l => l.hand = null); }
    turnTo(+e.target.value);
  }
  if (e.target.id === 'angle') { resumePlayback(); leaves.forEach(l => l.dirty = true); }
});
// Re-cut the print when the final page format changes; thickness alone adapts
// the printed spine to the geometry without altering the artwork's cut.
for (const id of ['w', 'h']) $(id).addEventListener('change', () => applyCoverPdf().catch(() => {}));

// Advanced controls update the live scene without restarting material or light previews.
$('form').addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'finish') {
    const values = FINISHES[e.target.value];
    if (values) ['finishRough', 'finishCoat', 'finishCoatRough', 'finishMetal', 'finishSheen'].forEach((key, i) => $(key).value = values[i]);
  } else if (id.startsWith('finish')) $('finish').value = 'custom';
  if (id.startsWith('finish') || id.startsWith('fiber')) applyMaterials();
  if (/^(fill|rim)/.test(id) || ['exposureEV', 'envRotation', 'shadowSoft'].includes(id)) placeSun();
  if (id === 'frameMargin') { resetEnvelope(); frameOnce = true; }
  if (id === 'cameraView') { fit(...lastFit); $('autoFrame').checked = true; frameOnce = true; }
  if (id.startsWith('motion')) { resetEnvelope(); lastPose = presentationPose('none', 0); resumePlayback(); }
});
$('form').addEventListener('change', e => {
  if (['paperCaliper', 'paperStiffness', 'copySpacing'].includes(e.target.id)) build(true);

});

// ============================================================ export
let lastExportUrl = null;
const download = (href, name) => {
  if (lastExportUrl?.startsWith('blob:')) URL.revokeObjectURL(lastExportUrl);
  lastExportUrl = href;
  Object.assign($('lastExport'), { href, download: name, textContent: `Scarica ${name}`, hidden: false });
  $('lastExport').click();
};

$('png').onclick = async () => {
  if (coverBusy || innerBusy) return status('exportStatus', 'Attendi che il caricamento dei PDF sia completato.', true);
  const bg = scene.background, paused = app.paused;
  app.paused = true; $('png').disabled = true;
  try {
    syncPdfPages(); await Promise.all(pdfWaiting.values());
    if ($('transparent').checked) scene.background = null;
    const k = +$('pngScale').value, { width, height } = canvasSize;
    if (k !== 1) { renderer.setSize(width * k, height * k, false); composer.setSize(width * k, height * k); shadowDirty = true; }
    draw();
    const name = k === 1 ? exportName('png') : exportName('png').replace(`${width}x${height}`, `${width * k}x${height * k}`);
    download(renderer.domElement.toDataURL('image/png'), name);
    status('exportStatus', `PNG pronto · ${width * k} × ${height * k}.`); toast('Immagine salvata');
  } catch { status('exportStatus', 'Non riesco a salvare il PNG. Riprova.', true); }
  finally {
    scene.background = bg; app.paused = paused; $('png').disabled = false;
    renderer.setSize(canvasSize.width, canvasSize.height, false); composer.setSize(canvasSize.width, canvasSize.height);
    draw();
  }
};

const exportName = ext => `${$('product').value}-${canvasSize.width}x${canvasSize.height}.${ext}`;

// Video deterministico: ogni fotogramma avanza la simulazione di 1/30 s esatti e aspetta le pagine PDF,
// poi va all'encoder H.264 del browser. Durata e fluidità non dipendono dalla potenza del computer.
async function encodeVideo(seconds, progress, stopped, fps = 30, bitrate = 16e6) {
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const { width, height } = canvasSize;
  let config = null;
  // livello 4.2 per i 60 fps, poi 4.0
  for (const codec of [...(width * height > 2073600 ? ['avc1.640034', 'avc1.640033'] : []), 'avc1.64002a', 'avc1.640028', 'avc1.4d0028', 'avc1.420028']) {
    const candidate = { codec, width, height, bitrate, framerate: fps };
    if ((await VideoEncoder.isConfigSupported(candidate).catch(() => ({}))).supported) { config = candidate; break; }
  }
  if (!config) return null;
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
  encoder.configure(config);
  const total = Math.round(seconds * fps), speed = +$('speed').value;
  let frames = 0;
  try {
    // motion blur: otturatore a 180°, il fotogramma è la media di k istanti nella sua prima metà
    const k = +$('mblur').value, step = speed / fps, [accum, blend] = k > 1 ? canvas2d(width, height) : [];
    for (; frames < total && !stopped(); frames++) {
      if (frames) tick(k > 1 ? step / 2 : step, false);
      syncPdfPages(); await Promise.all(pdfWaiting.values()); // ogni pagina esposta è pronta prima del fotogramma
      let source = renderer.domElement;
      if (k > 1) {
        for (let i = 0; i < k; i++) {
          if (i || frames) tick(step / 2 / k, false);
          draw();
          blend.globalAlpha = 1 / (i + 1);
          blend.drawImage(renderer.domElement, 0, 0, width, height);
        }
        source = accum;
      } else draw();
      const frame = new VideoFrame(source, { timestamp: Math.round(frames * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: frames % fps === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4 && !failure) await new Promise(r => setTimeout(r, 0));
      if (failure) throw failure;
      if (frames % 6 === 0) { progress(frames / fps); await new Promise(r => setTimeout(r, 0)); }
    }
    await encoder.flush();
  } finally { if (encoder.state !== 'closed') encoder.close(); }
  if (failure) throw failure;
  if (!frames) return null;
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

// Registrazione in tempo reale: solo per i browser senza WebCodecs
async function recordRealtime(seconds, done) {
  const type = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.420028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find(t => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('Nessun formato video compatibile con questo browser.');
  app.paused = true;
  syncPdfPages(); await Promise.all(pdfWaiting.values());
  frameOnce = true; tick(0);
  const stream = renderer.domElement.captureStream(+$('fps').value);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: +$('bitrate').value * 1e6 }), chunks = [];
  let failed = false;
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.onerror = () => { failed = true; };
  rec.onstop = () => {
    stream.getTracks().forEach(track => track.stop());
    clearTimeout(timer);
    done(failed || !chunks.length ? null : new Blob(chunks, { type: rec.mimeType }), type.startsWith('video/mp4') ? 'mp4' : 'webm');
  };
  rec.start(250); app.paused = false;
  const timer = setTimeout(() => rec.state === 'recording' && rec.stop(), seconds * 1000);
  return () => rec.state === 'recording' && rec.stop();
}

let recording = null;
function recUi(active) {
  setLabel('rec', active ? 'square' : 'video', active ? 'Ferma e salva' : 'Registra video');
  setLabel('tbRec', active ? 'square' : 'video', '');
  $('tbRec').classList.toggle('recording', active);
  $('tbRec').title = active ? 'Ferma e salva (V)' : 'Registra video (V)';
}
$('rec').onclick = async () => {
  if (recording) return recording();
  if (coverBusy || innerBusy) return status('exportStatus', 'Attendi che il caricamento dei PDF sia completato.', true);
  const offline = 'VideoEncoder' in window && 'VideoFrame' in window;
  if (!offline && (!window.MediaRecorder || !renderer.domElement.captureStream)) return status('exportStatus', 'Questo browser non supporta la registrazione video.', true);
  const disabled = [...$('form').querySelectorAll('input, select, button')].map(el => [el, el.disabled]);
  disabled.forEach(([el]) => el.disabled = !['rec', 'tbRec'].includes(el.id));
  const seconds = clamp(+$('secs').value || 8, 1, 60);
  const restore = () => {
    exporting = false;
    disabled.forEach(([el, wasDisabled]) => el.disabled = wasDisabled);
    recUi(false); recording = null;
  };
  const finish = (blob, ext) => {
    if (blob) {
      download(URL.createObjectURL(blob), exportName(ext));
      status('exportStatus', `Video pronto · ${dims()}.`); toast('Video salvato');
    } else status('exportStatus', 'Registrazione interrotta. Riprova.', true);
    restore();
  };
  recUi(true);
  restartAnimation();
  try {
    if (offline) {
      let stop = false;
      recording = () => { stop = true; };
      exporting = true;
      frameOnce = true; tick(0, false);
      const fps = +$('fps').value;
      const blob = await encodeVideo(seconds, t => status('exportStatus', `Video · ${t.toFixed(1)} / ${seconds} s · ${dims()} · ${fps} fps`), () => stop, fps, +$('bitrate').value * 1e6);
      if (blob || stop) return finish(blob, 'mp4');
      exporting = false; // nessun codec H.264: si passa alla registrazione in tempo reale
    }
    const started = performance.now();
    const progress = setInterval(() => status('exportStatus', `Registrazione · ${Math.min(seconds, (performance.now() - started) / 1000).toFixed(0)} / ${seconds} s · ${dims()}`), 500);
    recording = await recordRealtime(seconds, (blob, ext) => { clearInterval(progress); finish(blob, ext); });
  } catch (error) {
    restore();
    status('exportStatus', error.message?.startsWith('Nessun formato') ? error.message : 'Non riesco a creare il video. Riprova.', true);
  }
};

on('applyCanvas', 'click', () => { setCanvasFormat('custom'); resetEnvelope(); frameOnce = renderDirty = true; autosave(); commitSettings(); toast(`Canvas ${dims()}`); });
on('format', 'change', () => { setCanvasFormat($('format').value); build(true); });
on('subjReset', 'click', () => {
  for (const [id, value] of [['subjX', 0], ['subjY', 0], ['subjRot', 0], ['subjScale', 100]]) $(id).value = value;
  resetEnvelope(); renderDirty = shadowDirty = true;
});

// ============================================================ animazioni pronte
// Combinazioni già pronte di sfoglio, movimento e durata. Un clic e si riparte dall'inizio.
const PRESETS = [
  { name: '360° prodotto', icon: 'rotate-3d', action: 'static', anim: 'turntable', secs: 8 },
  { name: '360° camera', icon: 'orbit', action: 'static', anim: 'orbit360', secs: 10 },
  { name: 'Tilt', icon: 'move-vertical', action: 'static', anim: 'tilt', secs: 6 },
  { name: 'Tilt camera', icon: 'video', action: 'static', anim: 'tiltcam', secs: 6 },
  { name: 'Rotazione', icon: 'refresh-cw', action: 'static', anim: 'spin', secs: 8 },
  { name: 'Capriola', icon: 'repeat', action: 'static', anim: 'roll360', secs: 4 },
  { name: 'Sfoglio classico', icon: 'book-open', action: 'flip', anim: 'none', secs: 12 },
  { name: 'Sfoglio + 360°', icon: 'book-open-check', action: 'flip', anim: 'turntable', secs: 12 },
  { name: 'Sfoglio rapido', icon: 'zap', action: 'riffle', anim: 'push', secs: 6 },
  { name: 'Fronte e retro', icon: 'flip-horizontal-2', action: 'static', anim: 'flip', secs: 6 },
  { name: 'Entrata', icon: 'log-in', action: 'static', anim: 'slide', secs: 6 },
  { name: 'Pop', icon: 'sparkles', action: 'static', anim: 'pop', secs: 4 },
  { name: 'Caduta', icon: 'arrow-down-to-line', action: 'static', anim: 'drop', secs: 5 },
  { name: 'Volteggio', icon: 'wind', action: 'static', anim: 'tumble', secs: 8 },
  { name: 'Sequenza social', icon: 'clapperboard', action: 'middle', anim: 'showcase', secs: 10 },
  { name: 'Camera a mano', icon: 'hand', action: 'middle', anim: 'handheld', secs: 8 },
  { name: 'Unboxing', icon: 'package-open', action: 'flip', anim: 'push', secs: 8 },
  { name: 'Spirale camera', icon: 'tornado', action: 'static', anim: 'spiralcam', secs: 8 },
  { name: 'Ken Burns', icon: 'scan-search', action: 'static', anim: 'kenburns', secs: 8 },
  { name: 'Luce che passa', icon: 'sun', action: 'static', anim: 'none', secs: 10, extra: { lightPreset: 'garden', goboMove: true } },
  { name: 'Veneziana', icon: 'blinds', action: 'static', anim: 'kenburns', secs: 8, extra: { lightPreset: 'blinds', goboMove: false } },
  { name: 'Cinematico', icon: 'film', action: 'middle', anim: 'dolly', secs: 10, extra: { vignette: 35, grain: 25, mblur: 4 } },
];
function markPreset() {
  for (const button of $('presetGrid').children) {
    const preset = PRESETS[+button.dataset.preset];
    const active = preset.action === $('action').value && preset.anim === $('anim').value && +$('secs').value === preset.secs &&
      Object.entries(preset.extra || {}).every(([id, value]) => $(id).type === 'checkbox' ? $(id).checked === value : $(id).value === String(value));
    button.classList.toggle('preset-active', active);
    button.setAttribute('aria-pressed', active);
  }
}
$('presetGrid').innerHTML = PRESETS.map((preset, i) =>
  `<button type="button" class="preset" data-preset="${i}" aria-pressed="false"><i data-lucide="${preset.icon}" class="w-4 h-4"></i><span>${preset.name}</span></button>`).join('');
icons();
$('presetGrid').addEventListener('click', e => {
  const button = e.target.closest('[data-preset]');
  if (!button) return;
  const preset = PRESETS[+button.dataset.preset];
  $('action').value = preset.action; $('anim').value = preset.anim; $('secs').value = preset.secs;
  for (const [id, value] of Object.entries(preset.extra || {})) {
    if ($(id).type === 'checkbox') $(id).checked = value; else $(id).value = value;
    if (id === 'lightPreset') applyLightPreset(value);
  }
  placeSun();
  if (!animated() && leaves.length && +$('turned').value === 0) $('turned').value = Math.min(2, leaves.length); // fermo ma aperto: si vede l'interno
  restartAnimation();
  markPreset();
  autosave();
});
for (const id of ['action', 'anim', 'secs', 'lightPreset', 'goboMove', 'vignette', 'grain', 'mblur']) $(id).addEventListener('change', markPreset);

// ============================================================ timeline, scorciatoie, progetto
// Il tempo della timeline è quello del video: la simulazione avanza di velocità / fps a fotogramma,
// esattamente come nell'export. Cercare un istante = ripartire e simulare fino a lì.
const videoSeconds = () => clamp(+$('secs').value || 8, 1, 60);
const videoTime = () => presetTime / Math.max(+$('speed').value, 0.01);
let seeking = 0;
function syncTimeline() {
  const total = videoSeconds(), t = videoTime() % total;
  const text = `${t.toFixed(1)} / ${total.toFixed(1)} s`;
  if ($('timeReadout').textContent !== text) $('timeReadout').textContent = text;
  if (!seeking && document.activeElement !== $('timeline')) $('timeline').value = Math.round(t / total * 1000);
}
function seek(t) {
  const fps = 30, speed = +$('speed').value;
  restartAnimation();
  frameOnce = true; tick(0, false);
  for (let i = 0; i < Math.round(t * fps); i++) tick(speed / fps, false);
  setPaused(true);
  renderDirty = true;
}
on('timeline', 'input', () => {
  if (seeking) return;
  seeking = requestAnimationFrame(() => { seek(+$('timeline').value / 1000 * videoSeconds()); seeking = 0; });
});
const stepFrame = dir => seek(Math.max(0, videoTime() + dir / 30));

function reframe() {
  $('autoFrame').checked = true;
  resetEnvelope();
  if (fittedCamera) { camera.position.copy(fittedCamera.position); controls.target.copy(fittedCamera.target); }
  frameOnce = renderDirty = true;
}
on('reframe', 'click', reframe);
on('tbFrame', 'click', reframe);
on('tbPng', 'click', () => $('png').click());
on('tbRec', 'click', () => $('rec').click());

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches?.('input, select, textarea')) return;
  if (e.key === ' ' && e.target.matches?.('button, summary')) return;
  const keys = { ' ': () => setPaused(!app.paused), r: restartAnimation, f: reframe, p: () => $('png').click(), v: () => $('rec').click(),
    ArrowLeft: () => manualPage(-1), ArrowRight: () => manualPage(1), '[': () => stepFrame(-1), ']': () => stepFrame(1) };
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!keys[key] || (recording && key !== 'v')) return;
  e.preventDefault();
  keys[key]();
});

// impostazioni: tutti i controlli con id, tranne file e timeline. Restano nel browser e si salvano su file
const SAVE_KEY = 'book-animator-settings-v1';
function settings() {
  const values = {};
  for (const el of $('form').querySelectorAll('input[id], select[id]')) {
    if (el.type === 'file' || el.id === 'timeline' || el.readOnly) continue;
    values[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  if ($('format').value === 'custom') { values.canvasW = String(canvasSize.width); values.canvasH = String(canvasSize.height); }
  return values;
}
function applySettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Progetto non valido');
  for (const el of $('form').querySelectorAll('input[id], select[id]')) {
    if (el.type === 'file' || el.id === 'timeline' || el.readOnly || !Object.hasOwn(values, el.id)) continue;
    const value = values[el.id];
    if (el.tagName === 'SELECT') { if ([...el.options].some(o => o.value === value)) el.value = value; }
    else if (el.type === 'checkbox') { if (typeof value === 'boolean') el.checked = value; }
    else if (el.type === 'color') { if (/^#[0-9a-f]{6}$/i.test(value)) el.value = value; }
    else if (['range', 'number'].includes(el.type)) el.value = numberValue(value, el.min === '' ? -1e4 : +el.min, el.max === '' ? 1e4 : +el.max, +(el.step || 1), +el.value);
  }
  const turned = +$('turned').value;
  setCanvasFormat($('format').value);
  applyBackground();
  applyProduct(false);
  $('turned').value = turned; if (!animated()) turnTo(+$('turned').value);
  markPreset(); syncStudioControls();
}
let saveTimer;
const autosave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(settings())); } catch {} }, 400); };
$('form').addEventListener('input', autosave);
$('form').addEventListener('change', autosave);
on('saveProject', 'click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(settings(), null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: `progetto-${$('product').value}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Progetto salvato');
});
on('loadProject', 'change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    if (!/json/.test(file.type) && !file.name.endsWith('.json')) throw new Error();
    applySettings(JSON.parse(await file.text()));
    autosave();
    commitSettings(); toast('Progetto caricato');
  } catch { toast('File di progetto non valido'); }
});
on('resetAll', 'click', () => {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
  location.reload();
});

applyBackground();
let saved = null;
try { saved = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch {}
if (saved && typeof saved === 'object' && !Array.isArray(saved)) applySettings(saved);
else { setCanvasFormat($('format').value); applyProduct(); }
markPreset();

// Settings history excludes uploaded assets and transient animation time.
const history = new SettingsHistory(settings());
function historyButtons() { $('undo').disabled = !history.canUndo; $('redo').disabled = !history.canRedo; }
function commitSettings() { history.push(settings()); historyButtons(); }
function travelHistory(direction) {
  if (recording || exporting) return;
  applySettings(history.move(direction)); autosave(); historyButtons();
  toast(direction < 0 ? 'Impostazioni annullate' : 'Impostazioni ripristinate');
}
on('undo', 'click', () => travelHistory(-1)); on('redo', 'click', () => travelHistory(1));
$('form').addEventListener('change', e => { if (e.target.id !== 'timeline' && e.target.type !== 'file') queueMicrotask(commitSettings); });
for (const id of ['presetGrid', 'subjReset', 'reframe', 'tbFrame']) on(id, 'click', () => queueMicrotask(commitSettings));
historyButtons();
document.addEventListener('keydown', e => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.target.matches?.('input, textarea, select') || recording) return;
  if (e.key.toLowerCase() === 'z') { e.preventDefault(); travelHistory(e.shiftKey ? 1 : -1); }
});
