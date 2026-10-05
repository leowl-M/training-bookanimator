const test = require('node:test');
const assert = require('node:assert/strict');
const layout = import('../pdf-layout.mjs');

test('portrait output is 1080 by 1440 and odd PDFs add a blank reverse', async () => {
  const { CANVAS, interiorLayout } = await layout;
  assert.deepEqual(CANVAS, { width: 1080, height: 1440 });
  const book = interiorLayout(5, 150/25.4*72, 210/25.4*72);
  assert.equal(book.sheets, 3);
  assert.ok(Math.abs(book.width - 150) < 1e-10);
  assert.equal(interiorLayout(100, 400, 600).sheets, 50);
  assert.throws(() => interiorLayout(2001, 400, 600), /2000/);
});

test('flat covers map the left back, central spine and right front without overlap', async () => {
  const { coverRegions, detectCoverMode } = await layout;
  const regions = coverRegions(3080, 2100, 150, 210, 8);
  assert.deepEqual(regions.back, { x: 0, y: 0, width: 1500, height: 2100 });
  assert.deepEqual(regions.spine, { x: 1500, y: 0, width: 80, height: 2100 });
  assert.deepEqual(regions.front, { x: 1580, y: 0, width: 1500, height: 2100 });
  assert.equal(regions.spineMismatch, false);
  assert.equal(detectCoverMode(1, 308, 210, 150, 210), 'spread');
  assert.equal(detectCoverMode(2, 150, 210, 150, 210), 'separate');
  assert.equal(detectCoverMode(1, 150, 210, 150, 210), 'front');
});

test('bleed is removed and a mismatched format does not silently distort the cover', async () => {
  const { coverRegions } = await layout;
  const regions = coverRegions(3140, 2160, 150, 210, 5, 3);
  assert.deepEqual(regions.front, { x: 1610, y: 30, width: 1500, height: 2100 });
  assert.equal(regions.printedSpine, 8);
  assert.equal(regions.spineMismatch, true);
  assert.throws(() => coverRegions(1500, 2100, 150, 210, 5), /formato/);
});

test('exposed PDF pages include both sides and the next pages in either direction', async () => {
  const { exposedPages } = await layout;
  assert.deepEqual(exposedPages(1, 0, 3), [0, 1, 2, 3, 4, 5]);
  const pages = exposedPages(49, 48, 50);
  assert.ok(pages.includes(96) && pages.includes(97) && pages.includes(98) && pages.includes(99));
  assert.ok(!pages.includes(0));
});

test('PDF rasterization queues work and releases pages outside the visible window', async () => {
  const { PdfSource } = await import('../pdf-source.mjs');
  global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
  let rendering = 0, maximum = 0, destroyed = false;
  const pdf = { numPages: 100, destroy: async () => { destroyed = true; }, getPage: async () => ({
    getViewport: ({scale}) => ({ width: 400*scale, height: 600*scale }), cleanup() {},
    render: () => ({ promise: new Promise(resolve => {
      maximum = Math.max(maximum, ++rendering);
      setTimeout(() => { rendering--; resolve(); }, 1);
    }) }),
  }) };
  const source = new PdfSource(pdf, 'test.pdf', 400, 600);
  const [first, second] = await Promise.all([source.render(0), source.render(1)]);
  assert.equal(maximum, 1);
  assert.equal(await source.render(0), first);
  source.retain([1]);
  assert.equal(first.width, 1);
  assert.equal(source.cache.size, 1);
  assert.ok(second.height > 1000);
  await source.destroy();
  assert.equal(source.cache.size, 0);
  assert.equal(destroyed, true);
});

test('animation poses repeat cleanly and do not drift when paused', async () => {
  const { presentationPose } = await import('../animation-presets.mjs');
  for (const mode of ['open', 'cover', 'spin', 'orbit', 'float', 'both']) {
    assert.deepEqual(presentationPose(mode, 3), presentationPose(mode, 3));
    const start = presentationPose(mode, 0), end = presentationPose(mode, 8);
    for (const key of Object.keys(start)) assert.ok(Math.abs(start[key] - end[key]) < 1e-10 || key === 'yaw' && mode === 'spin');
  }
  assert.ok(presentationPose('float', 6).lift > 0);
});
