const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bookDimensions, bindingPose, aboveSupport } = require('../book-binding.mjs');

function make(kind, sheets, angle = Math.PI, turned = 0) {
  const spec = bookDimensions({ kind, sheets, paperThickness: 0.0011, boardThickness: 0.025 });
  return { ...spec, kind, width: 1.5, paperThickness: 0.0011, maxAngle: angle,
    angles: [angle, ...Array.from({ length: sheets }, (_, i) => i < turned ? angle : 0)] };
}

test('hardcover and paperback stock and spine shrink with the number of sheets', () => {
  for (const kind of ['hardcover', 'paperback']) {
    const one = make(kind, 1), two = make(kind, 2), forty = make(kind, 40);
    assert.ok(one.depth < two.depth && two.depth < forty.depth);
    assert.ok(Math.abs((two.depth - 2 * two.board) - 2 * (one.depth - 2 * one.board)) < 1e-12);
    assert.equal(one.stock, one.paperThickness);
    assert.equal(forty.stock, 40 * forty.paperThickness);
  }
});

test('opening moves the spine and front hinge while the back stays attached', () => {
  for (const kind of ['hardcover', 'paperback']) for (const count of [0, 1, 2, 6, 40]) {
    const opts = make(kind, count);
    const closed = bindingPose({ ...opts, angles: Array(count + 1).fill(0) });
    const open = bindingPose(opts);
    assert.deepEqual(closed.back, open.back);
    assert.ok(Math.abs(closed.front.x - closed.back.x) < 1e-12);
    assert.ok(Math.abs(open.front.z - open.back.z) < 1e-12);
    assert.ok(Math.abs(open.front.x - (open.back.x - opts.stock)) < 1e-12);
    assert.ok(Math.abs(closed.front.z - (closed.back.z + opts.stock)) < 1e-12);
    assert.ok(Number.isFinite(open.caseArch));
  }
});

test('binding curvature responds to the distribution of sheets in both directions', () => {
  for (const kind of ['hardcover', 'paperback']) {
    const right = bindingPose(make(kind, 6, Math.PI, 0));
    const middle = bindingPose(make(kind, 6, Math.PI, 3));
    const left = bindingPose(make(kind, 6, Math.PI, 6));
    assert.ok(middle.arch > right.arch);
    assert.ok(middle.caseArch > right.caseArch);
    assert.equal(left.arch, right.arch);
    assert.deepEqual(right.front, middle.front);
    assert.deepEqual(left.front, middle.front);
  }
});

test('one and two turned sheets remain inside the left cover with full thickness', () => {
  for (const kind of ['hardcover', 'paperback', 'magazine']) for (const count of [1, 2, 6, 40]) {
    for (const angle of [Math.PI * 0.5, Math.PI * 170 / 180, Math.PI]) {
      const opts = make(kind, count, angle, count), pose = bindingPose(opts);
      for (const page of pose.pages) for (const along of [0.01, 0.1, 1.0]) {
        const c = Math.cos(angle), s = Math.sin(angle), nx = -s, nz = c;
        // Deliberately put a neutral sheet axis inside the cover to check collision recovery.
        const x = pose.front.x + c * along + nx * 0.01;
        const z = pose.front.z + s * along + nz * 0.01;
        const half = opts.paperThickness / 2;
        const safe = aboveSupport(x, z, page.leftSupport, half);
        for (const face of [-half, half]) {
          const px = safe.x + nx * face, pz = safe.z + nz * face;
          const distance = -((px - pose.front.x) * nx + (pz - pose.front.z) * nz);
          assert.ok(distance >= page.leftSupport.clearance - 1e-12, 'neither printed face may emerge under the cover');
        }
      }
    }
  }
});

test('the right pile remains above the back cover and sheet order follows both stacks', () => {
  for (const count of [1, 2, 40]) {
    const opts = make('paperback', count), pose = bindingPose(opts);
    for (let i = 0; i < count; i++) {
      const page = pose.pages[i];
      const targetRight = page.pin.z + page.gutter;
      const nx = -Math.sin(opts.maxAngle), nz = Math.cos(opts.maxAngle);
      const rootDistance = (page.pin.x - pose.front.x) * nx + (page.pin.z - pose.front.z) * nz;
      const targetLeft = -rootDistance + page.leftGutter;
      assert.ok(Math.abs(targetRight - (pose.back.z + (count - i - 0.5) * opts.paperThickness + page.rightSupport.clearance)) < 1e-12);
      assert.ok(Math.abs(targetLeft - ((i + 0.5) * opts.paperThickness + page.leftSupport.clearance)) < 1e-12);
      if (i > 0) assert.ok(pose.pages[i - 1].gutter > page.gutter);
    }
  }
});

// Run the actual vertex deformation as well as the binding model. The mesh facade
// only stores attributes; all positions come from the production Leaf code.
test('deformed left-page faces stay separated and above the cover with one or two sheets', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const html = fs.readFileSync(require('node:path').join(__dirname, '../script.js'), 'utf8');
  const physics = html.slice(html.indexOf('const SEG ='), html.indexOf('// ============================================================ prodotti'));
  const ctx = vm.createContext({ clamp: (x, a, b) => Math.max(a, Math.min(b, x)), rng: () => () => 0.5, aboveSupport });
  vm.runInContext(physics + '\nthis.Leaf = Leaf; this.SEG = SEG;', ctx);
  for (const kind of ['hardcover', 'paperback']) for (const count of [1, 2]) for (const angle of [Math.PI * 170 / 180, Math.PI]) {
    const opts = make(kind, count, angle, count), pose = bindingPose(opts);
    for (const page of pose.pages) {
      const leaf = new ctx.Leaf(1.47, false, 1000);
      leaf.max = angle; leaf.flat(angle);
      Object.assign(leaf, page, { pageThickness: opts.paperThickness / 2 });
      leaf.meshes = [{ position: page.pin }];
      const x = [], y = [], z = [], stored = [];
      for (const face of [-1, 1]) for (let j = 0; j <= ctx.SEG; j++) {
        x.push(j * leaf.L / ctx.SEG); y.push(0); z.push(face * opts.paperThickness / 2);
      }
      leaf.geos = [{
        userData: { rest: { x, y, z } },
        attributes: { position: { setXYZ: (i, px, py, pz) => stored[i] = { x: px, y: py, z: pz } }, normal: {} },
        computeVertexNormals() {}, computeBoundingSphere() {}, computeBoundingBox() {},
      }];
      leaf.deform();
      const nx = -Math.sin(angle), nz = Math.cos(angle);
      for (let j = 0; j <= ctx.SEG; j++) {
        const a = stored[j], b = stored[j + ctx.SEG + 1];
        assert.ok(Math.abs(Math.hypot(a.x - b.x, a.z - b.z) - opts.paperThickness) < 1e-12, 'collision must translate both faces together');
        for (const point of [a, b]) {
          const dx = point.x + page.pin.x - pose.front.x, dz = point.z + page.pin.z - pose.front.z;
          const along = dx * Math.cos(angle) + dz * Math.sin(angle);
          if (along > 0.002) assert.ok(-(dx * nx + dz * nz) >= page.leftSupport.clearance - 1e-12, 'printed face must remain on the interior side');
        }
      }
    }
  }
});
