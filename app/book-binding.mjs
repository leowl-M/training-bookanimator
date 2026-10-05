const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function bookDimensions({ kind, sheets, paperThickness, boardThickness }) {
  const count = clamp(Math.floor(sheets) || 0, 0, 1000);
  const board = kind === 'hardcover' ? Math.max(boardThickness, 0.005)
    : kind === 'magazine' || kind === 'singer' ? 0.002 : 0.0035;
  const stock = count * paperThickness;
  return { count, board, stock, depth: 2 * board + stock };
}

// The case unfolds around the back hinge. Every sheet has its own attachment
// along the binding, and its two resting surfaces follow the corresponding pile.
// spiral: the sheets turn freely around the rings, so the block does not arch.
export function bindingPose({ kind, width, depth, board, stock, paperThickness, angles, maxAngle, spineShape = 'round' }) {
  const count = angles.length - 1;
  const coverAngle = clamp(angles[0] || 0, 0, maxAngle);
  const beta = coverAngle / 2;
  const normal = { x: -Math.cos(beta), z: -Math.sin(beta) };
  const back = { x: -width / 2, z: -depth / 2 + board };
  const front = { x: back.x - stock * Math.sin(beta), z: back.z + stock * Math.cos(beta) };
  const opened = maxAngle > 1e-6 ? coverAngle / maxAngle : 0;
  const leftMass = count ? angles.slice(1).reduce((sum, a) => sum + clamp(a / Math.max(maxAngle, 1e-6), 0, 1), 0) / count : 0;
  const balance = 4 * leftMass * (1 - leftMass);
  const arch = stock * opened * (kind === 'hardcover' ? 0.07 : kind === 'spiral' ? 0 : 0.15) * balance;
  const gutterWidth = Math.max(stock * 2.5, 0.025);
  const clearance = 0.0004;
  const leftNormal = { x: -Math.sin(maxAngle), z: Math.cos(maxAngle) };
  const pages = [];
  for (let i = 0; i < count; i++) {
    const f = (count - i - 0.5) / count;
    const bow = arch * Math.sin(Math.PI * f);
    const pin = { x: back.x + (front.x - back.x) * f + normal.x * bow,
      z: back.z + (front.z - back.z) * f + normal.z * bow };
    const rightHeight = (count - i - 0.5) * paperThickness;
    const leftHeight = (i + 0.5) * paperThickness;
    const distanceToLeft = (pin.x - front.x) * leftNormal.x + (pin.z - front.z) * leftNormal.z;
    pages.push({ pin, gutterWidth,
      gutter: Math.max(0, back.z + rightHeight + clearance * opened - pin.z),
      leftGutter: Math.max(0, distanceToLeft + leftHeight + clearance),
      rightSupport: { pivot: back, angle: 0, clearance, side: 1 },
      leftSupport: { pivot: front, angle: maxAngle, clearance, side: -1 },
    });
  }
  // At rest the outer case covers the paper attachments. Its arch changes with
  // both opening and mass distribution; the ends continue to meet the boards.
  // A square back stays almost flat; an exposed sewn spine follows the block alone.
  const caseArch = kind === 'hardcover'
    ? (spineShape === 'flat' ? depth * 0.02 + arch * 0.5 : depth * (0.18 * (1 - opened) + 0.025 * opened) + arch)
    : kind === 'exposed' ? stock * 0.01 + arch : stock * 0.025 + arch;
  const outerBack = { x: back.x, z: back.z - board };
  const outerFront = { x: front.x - Math.sin(coverAngle) * board, z: front.z + Math.cos(coverAngle) * board };
  return { back, front, outerBack, outerFront, normal, beta, opened, arch, caseArch, pages };
}

export function aboveSupport(x, z, support, halfThickness = 0) {
  const c = Math.cos(support.angle), s = Math.sin(support.angle);
  const dx = x - support.pivot.x, dz = z - support.pivot.z;
  const along = dx * c + dz * s;
  // The glued strip may touch the case. Outside it, the full sheet thickness
  // remains on the interior side, so its printed face cannot emerge underneath.
  if (along <= 0.002) return { x, z };
  const nx = -s, nz = c;
  const side = support.side;
  const signed = side * (dx * nx + dz * nz);
  const needed = halfThickness + support.clearance;
  const correction = Math.max(0, needed - signed);
  return { x: x + side * nx * correction, z: z + side * nz * correction };
}
