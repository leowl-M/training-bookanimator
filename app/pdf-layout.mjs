export const CANVAS = Object.freeze({ width: 1080, height: 1440 });
export const MAX_SHEETS = 1000;

export function interiorLayout(pages, widthPoints, heightPoints) {
  if (pages < 1 || pages > MAX_SHEETS * 2) throw new Error(`Il PDF deve contenere da 1 a ${MAX_SHEETS * 2} pagine.`);
  return { sheets: Math.ceil(pages / 2), width: widthPoints * 25.4 / 72, height: heightPoints * 25.4 / 72 };
}

// A flat cover is read from left to right: back, spine, front.
// Physical page height keeps the split accurate even when the printed spine
// differs from the simulated stock thickness.
export function coverRegions(width, height, pageWidth, pageHeight, spine, bleed = 0) {
  const inset = Math.max(0, bleed * height / (pageHeight + 2 * bleed));
  const h = height - 2 * inset, w = width - 2 * inset;
  const panel = h * pageWidth / pageHeight;
  const middle = w - 2 * panel;
  if (middle < -h * 0.02 || middle > panel * 0.8) {
    throw new Error('La stesa non corrisponde al formato del libro. Controlla larghezza, altezza e abbondanza.');
  }
  // Small differences in PDF point rounding must never crop a negative spine.
  const panelWidth = Math.min(panel, w / 2), spineWidth = Math.max(0, middle);
  return {
    back: { x: inset, y: inset, width: panelWidth, height: h },
    front: { x: width - inset - panelWidth, y: inset, width: panelWidth, height: h },
    spine: spineWidth > 0.5 ? { x: inset + panelWidth, y: inset, width: spineWidth, height: h } : null,
    printedSpine: spineWidth * pageHeight / h,
    spineMismatch: spineWidth > 0.5 && Math.abs(spineWidth * pageHeight / h - spine) > 1,
  };
}

export function detectCoverMode(pages, width, height, pageWidth, pageHeight) {
  if (pages > 1) return 'separate';
  return width / height > pageWidth / pageHeight * 1.7 ? 'spread' : 'front';
}

// Both exposed sides, plus the next sheets in either direction. An odd last
// page has a genuinely blank reverse rather than a repeated placeholder.
export function exposedPages(firstRight, lastLeft, sheets, ahead = 2) {
  const result = new Set();
  for (const center of [firstRight, lastLeft]) for (let i = center - ahead; i <= center + ahead; i++) {
    if (i >= 1 && i <= sheets) { result.add((i - 1) * 2); result.add((i - 1) * 2 + 1); }
  }
  return [...result];
}
