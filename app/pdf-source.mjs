// PDF.js 5.6.205 is bundled locally, including fonts, CMaps and image decoders.
// Imported files are parsed in this browser; no upload service is involved.
let library;
const base = new URL('./vendor/pdfjs/', import.meta.url);
async function pdfLibrary() {
  library ||= import('./vendor/pdfjs/build/pdf.mjs');
  const pdfjs = await library;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', base).href;
  return pdfjs;
}

export async function openPdf(file) {
  const pdfjs = await pdfLibrary();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: new URL('cmaps/', base).href, cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', base).href,
    wasmUrl: new URL('wasm/', base).href, isEvalSupported: false });
  // Encrypted files fail with a readable message instead of waiting forever.
  let rejectPassword;
  const password = new Promise((_, reject) => { rejectPassword = reject; });
  task.onPassword = () => rejectPassword(new Error('Password required'));
  let pdf;
  try { pdf = await Promise.race([task.promise, password]); }
  catch (error) { await task.destroy(); throw error; }
  const page = await pdf.getPage(1), viewport = page.getViewport({ scale: 1 });
  return new PdfSource(pdf, file.name, viewport.width, viewport.height);
}

export class PdfSource {
  constructor(pdf, name, width, height) {
    Object.assign(this, { pdf, name, width, height, count: pdf.numPages, cache: new Map(),
      pending: new Map(), wanted: new Set(), queue: Promise.resolve(), disposed: false });
  }

  render(index, longSide = 1600) {
    if (index < 0 || index >= this.count || this.disposed) return Promise.resolve(null);
    if (this.cache.has(index)) return Promise.resolve(this.cache.get(index));
    if (this.pending.has(index)) return this.pending.get(index);
    const job = this.queue.then(async () => {
      if (this.disposed) return null;
      const page = await this.pdf.getPage(index + 1), original = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, longSide / Math.max(original.width, original.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
      page.cleanup();
      if (this.disposed) { canvas.width = canvas.height = 1; return null; }
      this.cache.set(index, canvas);
      return canvas;
    });
    this.pending.set(index, job);
    this.queue = job.catch(() => {});
    job.finally(() => this.pending.delete(index)).catch(() => {});
    return job;
  }

  retain(indices) {
    this.wanted = new Set(indices);
    for (const [index, canvas] of this.cache) if (!this.wanted.has(index)) {
      canvas.width = canvas.height = 1;
      this.cache.delete(index);
    }
  }

  async destroy() {
    this.disposed = true;
    await this.queue;
    this.retain([]);
    await this.pdf.destroy();
  }
}
