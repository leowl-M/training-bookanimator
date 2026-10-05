import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberValue, canvasDimensions, amplifyPose, SettingsHistory } from '../studio-settings.mjs';
import { presentationPose } from '../animation-presets.mjs';
test('typed dimensions are finite, even and bounded for rendering and export', () => {
  assert.deepEqual(canvasDimensions(1081, 1441), [1082, 1442]);
  assert.deepEqual(canvasDimensions(-20, Infinity), [256, 1080]);
  assert.deepEqual(canvasDimensions(9999, 9999, 2048), [2048, 2048]);
  assert.equal(numberValue('invalid', 0, .5, .005, .15), .15);
  assert.equal(numberValue(.203, 0, .5, .005), .205);
});
test('history supports undo/redo, branches, bounds and immutable snapshots', () => {
  const first = { finish: 'matte' }, h = new SettingsHistory(first, 3);
  first.finish = 'changed'; h.push({ finish: 'gloss' }); h.push({ finish: 'metal' });
  assert.deepEqual(h.move(-1), { finish: 'gloss' }); assert.equal(h.canRedo, true);
  h.push({ finish: 'soft' }); assert.equal(h.canRedo, false);
  assert.deepEqual(h.move(-1), { finish: 'gloss' }); assert.deepEqual(h.move(-1), { finish: 'matte' });
  assert.equal(h.canUndo, false); assert.deepEqual(h.move(-1), { finish: 'matte' });
});
test('zero amplitude gives neutral pose and extreme amplitudes never invert the model', () => {
  for (const mode of ['drop', 'pop', 'dolly', 'spiralcam', 'turntable']) {
    for (const t of [-8, -3, 0, 2, 8, 12]) {
      const pose = presentationPose(mode, t, 8);
      const neutral = amplifyPose(pose, 0);
      assert.equal(neutral.zoom, 1); assert.equal(neutral.scale, 1);
      assert.equal(Math.abs(neutral.yaw), 0); assert.equal(Math.abs(neutral.lift), 0);
      const strong = amplifyPose(pose, 2);
      assert.ok(Object.values(strong).every(Number.isFinite));
      assert.ok(strong.zoom > 0 && strong.scale > 0);
    }
  }
});
