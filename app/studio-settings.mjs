// Shared limits keep project files and typed values within the same bounds as the UI.
export function numberValue(value, min, max, step = 0, fallback = min) {
  const n = typeof value === 'boolean' || value === '' ? NaN : Number(value);
  let v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  if (step > 0) v = min + Math.round((v - min) / step) * step;
  return Number(Math.min(max, Math.max(min, v)).toFixed(6));
}
export function canvasDimensions(width, height, limit = 2560) {
  return [width, height].map(v => numberValue(v, 256, Math.min(2560, limit), 2, 1080));
}
export function amplifyPose(pose, amount) {
  const result = { ...pose }, a = numberValue(amount, 0, 2, 0, 1);
  for (const key of ['yaw', 'pitch', 'roll', 'lift', 'orbit', 'elevation', 'x', 'z']) result[key] = (pose[key] || 0) * a;
  for (const key of ['zoom', 'scale']) result[key] = 1 + ((pose[key] ?? 1) - 1) * a;
  result.zoom = Math.max(0.1, result.zoom); result.scale = Math.max(0.1, result.scale);
  return result;
}
export class SettingsHistory {
  constructor(initial, limit = 60) { this.entries = [JSON.stringify(initial)]; this.index = 0; this.limit = limit; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }
  push(value) {
    const json = JSON.stringify(value);
    if (json === this.entries[this.index]) return false;
    this.entries.splice(this.index + 1); this.entries.push(json);
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1; return true;
  }
  move(direction) {
    this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + direction));
    return JSON.parse(this.entries[this.index]);
  }
}
