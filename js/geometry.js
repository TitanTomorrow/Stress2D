/* Geometry helpers, model validation and preset parts.
 * Units throughout the app: mm, N, MPa (N/mm^2).
 * A model's outline is a simple polygon stored counter-clockwise; edge i runs
 * from outline[i] to outline[(i+1) % n]. Holes are circles.
 */
(function (root) {
  const S = root.S2D || (root.S2D = {});

  function signedArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function distPointSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function orient(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  // True if segments ab and cd cross or touch (excluding shared endpoints handled by caller).
  function segmentsIntersect(a, b, c, d) {
    const d1 = orient(c.x, c.y, d.x, d.y, a.x, a.y);
    const d2 = orient(c.x, c.y, d.x, d.y, b.x, b.y);
    const d3 = orient(a.x, a.y, b.x, b.y, c.x, c.y);
    const d4 = orient(a.x, a.y, b.x, b.y, d.x, d.y);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    const on = (p, q, r) =>
      Math.min(p.x, q.x) - 1e-12 <= r.x && r.x <= Math.max(p.x, q.x) + 1e-12 &&
      Math.min(p.y, q.y) - 1e-12 <= r.y && r.y <= Math.max(p.y, q.y) + 1e-12;
    if (d1 === 0 && on(c, d, a)) return true;
    if (d2 === 0 && on(c, d, b)) return true;
    if (d3 === 0 && on(a, b, c)) return true;
    if (d4 === 0 && on(a, b, d)) return true;
    return false;
  }

  function isSimplePolygon(pts) {
    const n = pts.length;
    if (n < 3) return false;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return false;
      for (let j = i + 1; j < n; j++) {
        // skip adjacent edges
        if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
        const c = pts[j], d = pts[(j + 1) % n];
        if (segmentsIntersect(a, b, c, d)) return false;
      }
    }
    return Math.abs(signedArea(pts)) > 1e-9;
  }

  function distToOutline(x, y, pts) {
    let d = Infinity;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      d = Math.min(d, distPointSegment(x, y, a.x, a.y, b.x, b.y));
    }
    return d;
  }

  function insideDomain(x, y, model) {
    if (!pointInPolygon(x, y, model.outline)) return false;
    for (const h of model.holes) if (Math.hypot(x - h.x, y - h.y) < h.r) return false;
    return true;
  }

  function bounds(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function edgeLength(model, i) {
    const n = model.outline.length, a = model.outline[i], b = model.outline[(i + 1) % n];
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  // Returns a list of human-readable problems ([] when the model can be solved).
  function validateModel(model) {
    const errs = [];
    const pts = model.outline;
    if (pts.length < 3) {
      errs.push('The outline needs at least 3 corners.');
      return errs;
    }
    if (!isSimplePolygon(pts)) errs.push('The outline crosses itself. Move a corner so no edges overlap.');
    model.holes.forEach((h, k) => {
      if (!(h.r > 0)) errs.push(`Hole ${k + 1} needs a positive radius.`);
      else if (!pointInPolygon(h.x, h.y, pts) || distToOutline(h.x, h.y, pts) <= h.r * 1.02)
        errs.push(`Hole ${k + 1} is outside the part or touches its edge.`);
      model.holes.forEach((g, m) => {
        if (m > k && Math.hypot(h.x - g.x, h.y - g.y) <= (h.r + g.r) * 1.02)
          errs.push(`Holes ${k + 1} and ${m + 1} overlap.`);
      });
    });
    const m = model.material;
    if (!(m.E > 0)) errs.push("Young's modulus must be positive.");
    if (!(m.nu >= 0 && m.nu < 0.5)) errs.push("Poisson's ratio must be between 0 and 0.5.");
    if (!(m.t > 0)) errs.push('Thickness must be positive.');

    let fx = false, fy = false, loaded = false;
    for (const bc of model.edgeBC.concat(model.holes.map((h) => h.bc))) {
      if (bc.type === 'fixed') fx = fy = true;
      if (bc.type === 'fixx') fx = true;
      if (bc.type === 'fixy') fy = true;
      if ((bc.type === 'force' || bc.type === 'bearing') && (bc.fx || bc.fy)) loaded = true;
      if (bc.type === 'pressure' && bc.p) loaded = true;
    }
    if (!fx || !fy) errs.push('The part is not held in place. Select an edge or hole and set it to Fixed (or add supports in both X and Y).');
    if (!loaded) errs.push('There is no load. Select an edge or hole and apply a force or pressure.');
    return errs;
  }

  const bc = (type, extra) => Object.assign({ type, fx: 0, fy: 0, p: 0 }, extra || {});

  function rect(x0, y0, w, h) {
    return [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }];
  }

  const defaultMaterial = () => ({ name: 'steel', E: 200000, nu: 0.3, yield: 250, t: 10, mode: 'stress' });

  const PRESETS = {
    plateHole: {
      label: 'Plate with hole (tension)',
      build() {
        const outline = rect(0, 0, 200, 100);
        return {
          outline,
          edgeBC: [bc('free'), bc('force', { fx: 20000 }), bc('free'), bc('fixed')],
          holes: [{ x: 100, y: 50, r: 15, bc: bc('free') }],
        };
      },
    },
    cantilever: {
      label: 'Cantilever beam',
      build() {
        return {
          outline: rect(0, 0, 300, 40),
          edgeBC: [bc('free'), bc('force', { fy: -2000 }), bc('free'), bc('fixed')],
          holes: [],
        };
      },
    },
    lbracket: {
      label: 'L-bracket',
      build() {
        const outline = [
          { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 110 }, { x: 160, y: 110 },
          { x: 160, y: 150 }, { x: 0, y: 150 },
        ];
        return {
          outline,
          edgeBC: [bc('fixed'), bc('free'), bc('free'), bc('force', { fy: -3000 }), bc('free'), bc('free')],
          holes: [],
        };
      },
    },
    lug: {
      label: 'Bolted lug',
      build() {
        // Rectangular shank with a rounded (polygonal) head and a pin hole.
        const outline = [{ x: 0, y: 0 }, { x: 80, y: 0 }];
        const cx = 80, cy = 40, R = 40, n = 12;
        for (let k = 1; k < n; k++) {
          const a = -Math.PI / 2 + (Math.PI * k) / n;
          outline.push({ x: +(cx + R * Math.cos(a)).toFixed(3), y: +(cy + R * Math.sin(a)).toFixed(3) });
        }
        outline.push({ x: 80, y: 80 }, { x: 0, y: 80 });
        const edgeBC = outline.map(() => bc('free'));
        edgeBC[edgeBC.length - 1] = bc('fixed');
        return { outline, edgeBC, holes: [{ x: 80, y: 40, r: 16, bc: bc('bearing', { fx: 15000 }) }] };
      },
    },
    notched: {
      label: 'Notched bar',
      build() {
        const outline = [
          { x: 0, y: 0 }, { x: 90, y: 0 }, { x: 100, y: 15 }, { x: 110, y: 0 }, { x: 200, y: 0 },
          { x: 200, y: 60 }, { x: 110, y: 60 }, { x: 100, y: 45 }, { x: 90, y: 60 }, { x: 0, y: 60 },
        ];
        const edgeBC = outline.map(() => bc('free'));
        edgeBC[4] = bc('force', { fx: 15000 });
        edgeBC[9] = bc('fixed');
        return { outline, edgeBC, holes: [] };
      },
    },
    blank: {
      label: 'Blank rectangle',
      build() {
        return { outline: rect(0, 0, 150, 80), edgeBC: [bc('free'), bc('free'), bc('free'), bc('free')], holes: [] };
      },
    },
  };

  const MATERIALS = {
    steel: { label: 'Structural steel', E: 200000, nu: 0.3, yield: 250 },
    stainless: { label: 'Stainless steel 304', E: 193000, nu: 0.29, yield: 215 },
    aluminum: { label: 'Aluminium 6061-T6', E: 68900, nu: 0.33, yield: 276 },
    titanium: { label: 'Titanium Ti-6Al-4V', E: 113800, nu: 0.342, yield: 880 },
    brass: { label: 'Brass C360', E: 97000, nu: 0.31, yield: 310 },
    abs: { label: 'ABS plastic', E: 2300, nu: 0.35, yield: 40 },
    custom: { label: 'Custom…' },
  };

  Object.assign(S, {
    signedArea, pointInPolygon, distPointSegment, segmentsIntersect, isSimplePolygon,
    distToOutline, insideDomain, bounds, edgeLength, validateModel, makeBC: bc, defaultMaterial,
    PRESETS, MATERIALS,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
