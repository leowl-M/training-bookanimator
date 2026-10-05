const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const moduleSource = readFileSync(new URL('../script.js', `file://${__filename}`), 'utf8');
new vm.Script(moduleSource.replace(/^import .*;$/gm, ''));
const physics = moduleSource.slice(moduleSource.indexOf('const SEG ='), moduleSource.indexOf('// ============================================================ prodotti'));
const motion = moduleSource.slice(moduleSource.indexOf('let timers = [], simTime'), moduleSource.indexOf('const clock = new THREE.Clock'));
function setup() {
  const context = vm.createContext({
    clamp: (x, a, b) => Math.max(a, Math.min(b, x)),
    rng: seed => () => (seed = seed * 16807 % 2147483647) / 2147483647,
    leaves: [], hinges: [], scrubIndex: 1,
    $: id => ({ value: id === 'angle' ? 170 : id === 'action' ? 'flip' : id === 'anim' ? 'none' : 0 }),
  });
  vm.runInContext(physics + '\nthis.Leaf = Leaf; this.SEG = SEG; this.ROWS = ROWS; this.STEP = STEP; this.HAND = HAND;', context);
  vm.runInContext(motion, context);
  return context;
}
const max = 170 * Math.PI / 180;
function sheet(ctx, stiff = 1000, length = 1.47) {
  const leaf = new ctx.Leaf(length, false, stiff);
  Object.assign(leaf, { max, gutter: 0.057, leftGutter: 0.066, gutterWidth: 0.1425 });
  return leaf;
}
function turn(leaf, time, left, duration) {
  leaf.left = left;
  leaf.hand = { t0: time, from: leaf.angle, duration, dir: left ? 1 : -1, twist: 0.13 };
}
function finiteAndInextensible(ctx, leaf) {
  for (let k = 1; k <= ctx.SEG; k++) {
    assert.ok(Number.isFinite(leaf.x[k]) && Number.isFinite(leaf.z[k]));
    assert.ok(Math.abs(Math.hypot(leaf.x[k] - leaf.x[k - 1], leaf.z[k] - leaf.z[k - 1]) - leaf.L / ctx.SEG) < 1e-12);
  }
  assert.ok(leaf.angle >= 0 && leaf.angle <= max);
}

test('all paper types keep their length through repeated forward and reverse turns', () => {
  const ctx = setup();
  for (const stiff of [700, 850, 1000, 1400, 6000]) for (const length of [0.1, 1.47, 4.2]) {
    const leaf = sheet(ctx, stiff, length);
    let time = 0;
    for (let cycle = 0; cycle < 8; cycle++) {
      turn(leaf, time, cycle % 2 === 0, ctx.HAND);
      for (let tick = 0; tick < 300; tick++) {
        time += ctx.STEP;
        leaf.step(ctx.STEP, time, max);
        finiteAndInextensible(ctx, leaf);
      }
      assert.ok(Math.abs(leaf.angle - (leaf.left ? max : 0)) < 1e-5);
      assert.ok(Math.abs(leaf.bend) < 0.0001 && Math.abs(leaf.tw) < 0.0001);
    }
  }
});

test('every height row keeps its arc length with corner twist and a pinned spine', () => {
  const ctx = setup(), leaf = sheet(ctx);
  leaf.angle = max * 0.5; leaf.bend = 0.9; leaf.tw = 0.13;
  for (let row = 0; row <= ctx.ROWS; row++) {
    const x = new Float64Array(ctx.SEG + 1), z = new Float64Array(ctx.SEG + 1);
    leaf.curve(row / ctx.ROWS - 0.5, x, z);
    assert.equal(x[0], 0); assert.equal(z[0], 0);
    finiteAndInextensible(ctx, { ...leaf, x, z });
    for (let k = 2; k < ctx.SEG; k++) {
      const a = Math.atan2(z[k] - z[k - 1], x[k] - x[k - 1]);
      const b = Math.atan2(z[k + 1] - z[k], x[k + 1] - x[k]);
      assert.ok(Math.abs(a - b) < 0.03, 'continuous curvature without a sharp crease');
    }
  }
});

test('settled sheets stay settled and a reversal mid-turn stays finite', () => {
  const ctx = setup(), leaf = sheet(ctx);
  turn(leaf, 0, true, ctx.HAND);
  for (let k = 1; k <= 60; k++) leaf.step(ctx.STEP, k * ctx.STEP, max);
  turn(leaf, 0.5, false, ctx.HAND);
  for (let k = 61; k <= 480; k++) { leaf.step(ctx.STEP, k * ctx.STEP, max); finiteAndInextensible(ctx, leaf); }
  const initial = Array.from(leaf.x);
  for (let k = 481; k <= 2400; k++) leaf.step(ctx.STEP, k * ctx.STEP, max);
  assert.deepEqual(Array.from(leaf.x), initial);
  assert.equal(leaf.angle, 0);
});

test('damping is stable at 30, 60 and 120 Hz', () => {
  const ctx = setup(), angles = [];
  for (const hz of [30, 60, 120]) {
    const leaf = sheet(ctx); leaf.left = true;
    for (let tick = 1; tick <= hz; tick++) leaf.step(1 / hz, tick / hz, max);
    angles.push(leaf.angle);
  }
  assert.ok(Math.max(...angles) - Math.min(...angles) < 1e-10);
});

test('a full 40-sheet cycle preserves page order and returns to a closed book', () => {
  const ctx = setup(), cover = new ctx.Leaf(1.5, true, 6000);
  cover.max = max;
  ctx.leaves = [cover, ...Array.from({ length: 40 }, () => sheet(ctx))];
  vm.runInContext('bookCycle()', ctx);
  let sawOpen = false;
  for (let tick = 0; tick < 18000; tick++) {
    vm.runInContext('stepAll(STEP)', ctx);
    for (let i = 1; i < ctx.leaves.length; i++) {
      assert.ok(ctx.leaves[i - 1].angle + 0.0001 >= ctx.leaves[i].angle, 'the cover and preceding sheet must clear the next sheet');
      assert.ok(Number.isFinite(ctx.leaves[i].x[ctx.SEG]));
    }
    if (ctx.leaves.every(l => l.angle > max - 0.001)) sawOpen = true;
    if (sawOpen && ctx.leaves.every(l => l.angle < 0.001)) return;
  }
  assert.fail('cycle never completed');
});

test('starting animation from an open book completes closing before reopening', () => {
  const ctx = setup();
  ctx.leaves = [new ctx.Leaf(1.5, true, 6000), sheet(ctx), sheet(ctx)];
  ctx.leaves.forEach(l => { l.max = max; l.left = true; l.flat(max); });
  vm.runInContext('startAnimation()', ctx);
  let closed = false, reopened = false;
  for (let tick = 0; tick < 1000; tick++) {
    vm.runInContext('stepAll(STEP)', ctx);
    if (ctx.leaves.every(l => l.angle < 0.001)) closed = true;
    if (closed && ctx.leaves[0].angle > 0.1) reopened = true;
  }
  assert.ok(closed && reopened);
});

test('fast riffle and middle-spread cycles keep every sheet behind the one before it', () => {
  for (const cycle of ['riffleCycle()', 'middleCycle()']) {
    const ctx = setup(), cover = new ctx.Leaf(1.5, true, 6000);
    cover.max = max;
    ctx.leaves = [cover, ...Array.from({ length: 30 }, () => sheet(ctx))];
    vm.runInContext(cycle, ctx);
    let moved = false;
    for (let tick = 0; tick < 12000; tick++) {
      vm.runInContext('stepAll(STEP)', ctx);
      for (let i = 1; i < ctx.leaves.length; i++)
        assert.ok(ctx.leaves[i - 1].angle + 0.0001 >= ctx.leaves[i].angle, `${cycle}: sheet ${i} overtook sheet ${i - 1}`);
      if (ctx.leaves[1].angle > max - 0.001) moved = true;
    }
    assert.ok(moved, `${cycle} never turned the first sheet`);
  }
});
