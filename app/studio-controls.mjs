import { numberValue } from './studio-settings.mjs';
const $ = id => document.getElementById(id);
const range = (id, label, min, max, step, value, unit = '') => `<div class="studio-control"><div><label for="${id}">${label}</label><span>${unit}</span></div><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;
const select = (id, label, options) => `<label class="field">${label}<select id="${id}">${options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>`;
const note = text => `<p class="studio-note">${text}</p>`;
function section(title, content, before) {
  const d = document.createElement('details'); d.className = 'studio-section';
  d.innerHTML = `<summary>${title}<span>＋</span></summary><div class="studio-fields">${content}</div>`;
  before.before(d); return d;
}
export function mountStudioControls() {
  const camera = $('focal').closest('details'), light = $('lightAz').closest('details'), motion = $('anim').closest('details');
  const material = section('Materiali e finiture',
    select('finish', 'Finitura stampata', [['original', 'Da prodotto'], ['custom', 'Personalizzata'], ['matte', 'Opaca'], ['gloss', 'Lucida'], ['soft', 'Soft touch'], ['metal', 'Metallizzata']]) +
    note('La finitura si applica a copertine e superfici stampate. I fogli interni mantengono la carta scelta.') +
    range('finishRough', 'Rugosità', 0, 100, 1, 42, '%') + range('finishCoat', 'Vernice trasparente', 0, 100, 1, 30, '%') +
    range('finishCoatRough', 'Diffusione vernice', 0, 100, 1, 45, '%') + range('finishMetal', 'Metallizzazione', 0, 100, 1, 0, '%') +
    range('finishSheen', 'Effetto vellutato', 0, 100, 1, 0, '%') + range('fiberStrength', 'Rilievo della fibra', 0, 250, 5, 100, '%') +
    range('fiberScale', 'Dimensione della fibra', 25, 300, 5, 100, '%') +
    range('paperCaliper', 'Spessore singolo foglio', 0, .5, .005, 0, 'mm') + note('0 = spessore automatico dalla carta. Il dorso segue il numero e lo spessore dei fogli.') +
    range('paperStiffness', 'Rigidità della carta', 25, 250, 5, 100, '%'), $('cBoard').closest('details'));
  material.open = false;
  camera.querySelector('summary').nextElementSibling.insertAdjacentHTML('beforeend',
    select('cameraView', 'Vista', [['auto', 'Da prodotto'], ['front', 'Frontale'], ['three', 'Tre quarti'], ['top', 'Dall’alto'], ['side', 'Laterale'], ['back', 'Retro']]) +
    range('frameMargin', 'Margine inquadratura', 0, 80, 1, 25, '%') + range('focusOffset', 'Spostamento del fuoco', -300, 300, 1, 0, 'mm') + range('lensBlur', 'Sfocatura obiettivo', 0, 200, 1, 100, '%') + note('Fuoco e sfocatura richiedono «Profondità di campo».'));
  section('Luci di studio avanzate', range('fillPower', 'Luce di riempimento', 0, 300, 1, 0, '%') +
    range('fillAz', 'Direzione riempimento', 0, 360, 1, 285, '°') + range('fillEl', 'Altezza riempimento', 5, 85, 1, 35, '°') +
    `<label class="field">Colore riempimento<input type="color" id="fillColor" value="#dbe8ff" class="color-input"></label>` +
    range('rimPower', 'Controluce', 0, 400, 1, 0, '%') + range('rimAz', 'Direzione controluce', 0, 360, 1, 160, '°') + range('rimEl', 'Altezza controluce', 5, 85, 1, 55, '°') +
    `<label class="field">Colore controluce<input type="color" id="rimColor" value="#fff1db" class="color-input"></label>` +
    range('exposureEV', 'Esposizione', -3, 3, .1, 0, 'EV') + range('envRotation', 'Rotazione ambiente', 0, 360, 1, 0, '°') +
    range('shadowSoft', 'Morbidezza ombre', 5, 200, 5, 100, '%'), light.nextElementSibling);
  motion.querySelector('summary').nextElementSibling.insertAdjacentHTML('beforeend', range('motionAmount', 'Ampiezza movimento', 0, 200, 1, 100, '%') + range('motionPhase', 'Fase iniziale', 0, 100, 1, 0, '%') + `<label class="field">Movimento inverso<input type="checkbox" id="motionReverse"></label>` + note('Ampiezza, fase e direzione agiscono sui movimenti del prodotto e della camera. Lo sfoglio resta indipendente.'));
  $('compose').closest('details').querySelector('summary').nextElementSibling.insertAdjacentHTML('beforeend', range('copySpacing', 'Distanza tra copie', 50, 200, 5, 100, '%'));
  $('format').insertAdjacentHTML('beforeend', '<option value="custom">Personalizzato</option>');
  $('format').closest('label').insertAdjacentHTML('afterend', '<div id="customCanvas" hidden class="studio-dimensions"><label>Larghezza px<input id="canvasW" type="number" min="256" max="2560" step="2" value="1080"></label><label>Altezza px<input id="canvasH" type="number" min="256" max="2560" step="2" value="1440"></label><button type="button" id="applyCanvas" class="studio-apply">Applica dimensioni</button><p class="studio-note">Da 256 a 2560 px per lato, valori pari. PNG fino a 2×.</p></div>');
  section('Guide di composizione', select('guides', 'Sovrapposizione', [['none', 'Nessuna'], ['thirds', 'Regola dei terzi'], ['center', 'Centro'], ['safe', 'Area sicura'], ['both', 'Terzi + area sicura']]) + range('safeMargin', 'Margine area sicura', 2, 20, 1, 8, '%') + note('Le guide sono visibili solo in anteprima e non compaiono negli export.'), camera);
  const overlay = document.createElement('div'); overlay.id = 'studioGuides'; overlay.setAttribute('aria-hidden', 'true'); overlay.innerHTML = '<div class="thirds"></div><div class="safe"></div><div class="center"></div>'; $('canvasWrap').append(overlay);
  $('restart').before(Object.assign(document.createElement('button'), { type: 'button', id: 'undo', textContent: '↶', title: 'Annulla impostazioni (⌘/Ctrl Z)', className: 'history-button' }), Object.assign(document.createElement('button'), { type: 'button', id: 'redo', textContent: '↷', title: 'Ripristina impostazioni (⌘/Ctrl ⇧ Z)', className: 'history-button' }));
  $('undo').setAttribute('aria-label', 'Annulla impostazioni'); $('redo').setAttribute('aria-label', 'Ripristina impostazioni');
  const editors = [];
  for (const slider of document.querySelectorAll('input[type="range"]:not(#timeline)')) {
    const label = document.querySelector(`label[for="${slider.id}"]`);
    const row = document.createElement('div'); row.className = 'precision-row'; slider.before(row); row.append(slider);
    const input = document.createElement('input'); input.type = 'number'; input.className = 'precision-value'; input.setAttribute('aria-label', `${label?.textContent || slider.id}: valore preciso`);
    input.value = slider.value; row.append(input); editors.push([slider, input]);
    let editTimer;
    const commit = () => {
      clearTimeout(editTimer);
      if (input.value === '' || input.validity.badInput) return;
      delete input.dataset.editing;
      slider.value = numberValue(input.value, +slider.min, +slider.max, +(slider.step || 1), +slider.value); input.value = slider.value;
      slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }));
    };
    input.addEventListener('input', e => { input.dataset.editing = 'true'; e.stopPropagation(); clearTimeout(editTimer); editTimer = setTimeout(commit, 350); });
    input.addEventListener('change', e => { e.stopPropagation(); commit(); });
    input.addEventListener('blur', () => { if (input.dataset.editing) { if (!input.value) input.value = slider.value; commit(); } });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); } });
  }
  return () => {
    for (const [s, n] of editors) {
      if (n.min !== s.min) n.min = s.min; if (n.max !== s.max) n.max = s.max;
      if (n.step !== (s.step || '1')) n.step = s.step || '1'; if (n.disabled !== s.disabled) n.disabled = s.disabled;
      if (!n.dataset.editing && document.activeElement !== n && n.value !== s.value) n.value = s.value;
    }
    const mode = $('guides').value; if (overlay.dataset.mode !== mode) overlay.dataset.mode = mode;
    const margin = `${$('safeMargin').value}%`; if (overlay.style.getPropertyValue('--safe-margin') !== margin) overlay.style.setProperty('--safe-margin', margin);
    $('customCanvas').hidden = $('format').value !== 'custom';
  };
}
