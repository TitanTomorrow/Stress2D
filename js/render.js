/* Canvas drawing helpers: colour maps, banded contour plots, support and load symbols. */
(function (root) {
  const S = root.S2D || (root.S2D = {});

  const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

  // Turbo colour map (polynomial approximation) for magnitude fields.
  function turbo(t) {
    const x = clamp01(t);
    const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
    const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
    const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
    return [r, g, b].map((v) => Math.round(255 * clamp01(v)));
  }

  // Blue - grey - red diverging map for signed fields (compression / tension).
  const DIV = [
    [0, [49, 84, 196]], [0.2, [88, 139, 232]], [0.4, [168, 194, 238]], [0.5, [214, 214, 214]],
    [0.6, [240, 182, 158]], [0.8, [226, 107, 78]], [1, [178, 24, 43]],
  ];
  function diverging(t) {
    const x = clamp01(t);
    for (let i = 1; i < DIV.length; i++) {
      if (x <= DIV[i][0]) {
        const [t0, c0] = DIV[i - 1], [t1, c1] = DIV[i];
        const f = (x - t0) / (t1 - t0);
        return c0.map((c, k) => Math.round(c + f * (c1[k] - c)));
      }
    }
    return DIV[DIV.length - 1][1];
  }

  function bandColors(nb, signed) {
    const cmap = signed ? diverging : turbo;
    const out = [];
    for (let k = 0; k < nb; k++) {
      const [r, g, b] = cmap((k + 0.5) / nb);
      out.push(`rgb(${r},${g},${b})`);
    }
    return out;
  }

  // Clip polygon [[x,y,v],...] to v >= level (above) or v <= level (below).
  function clip(poly, level, above) {
    const out = [];
    const inside = (p) => (above ? p[2] >= level : p[2] <= level);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (level - a[2]) / (b[2] - a[2]);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), level]);
      }
    }
    return out;
  }

  function addPoly(path, poly) {
    path.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) path.lineTo(poly[i][0], poly[i][1]);
    path.closePath();
  }

  /** Banded contour of a nodal field. P = screen coords [x0,y0,x1,y1,...]. */
  function drawBands(ctx, P, tris, val, lo, hi, colors) {
    const nb = colors.length;
    const paths = colors.map(() => new Path2D());
    const span = hi - lo || 1;
    const dv = span / nb;
    const band = (v) => { const k = Math.floor((v - lo) / dv); return k < 0 ? 0 : k >= nb ? nb - 1 : k; };
    for (let e = 0; e < tris.length; e += 3) {
      const a = tris[e], b = tris[e + 1], c = tris[e + 2];
      const va = val[a], vb = val[b], vc = val[c];
      const ka = band(va), kb = band(vb), kc = band(vc);
      const kmin = Math.min(ka, kb, kc), kmax = Math.max(ka, kb, kc);
      if (kmin === kmax) {
        const p = paths[kmin];
        p.moveTo(P[2 * a], P[2 * a + 1]); p.lineTo(P[2 * b], P[2 * b + 1]); p.lineTo(P[2 * c], P[2 * c + 1]); p.closePath();
        continue;
      }
      const poly = [[P[2 * a], P[2 * a + 1], va], [P[2 * b], P[2 * b + 1], vb], [P[2 * c], P[2 * c + 1], vc]];
      for (let k = kmin; k <= kmax; k++) {
        let q = poly;
        if (k > kmin) q = clip(q, lo + k * dv, true);
        if (k < kmax && q.length) q = clip(q, lo + (k + 1) * dv, false);
        if (q.length >= 3) addPoly(paths[k], q);
      }
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.7;
    for (let k = 0; k < nb; k++) {
      ctx.fillStyle = colors[k];
      ctx.strokeStyle = colors[k];
      ctx.fill(paths[k]);
      ctx.stroke(paths[k]);
    }
  }

  /** One flat colour per element. */
  function drawElements(ctx, P, tris, eval_, lo, hi, colors) {
    const nb = colors.length;
    const paths = colors.map(() => new Path2D());
    const span = hi - lo || 1;
    for (let e = 0, i = 0; e < tris.length; e += 3, i++) {
      let k = Math.floor(((eval_[i] - lo) / span) * nb);
      k = k < 0 ? 0 : k >= nb ? nb - 1 : k;
      const a = tris[e], b = tris[e + 1], c = tris[e + 2];
      const p = paths[k];
      p.moveTo(P[2 * a], P[2 * a + 1]); p.lineTo(P[2 * b], P[2 * b + 1]); p.lineTo(P[2 * c], P[2 * c + 1]); p.closePath();
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.7;
    for (let k = 0; k < nb; k++) {
      ctx.fillStyle = colors[k];
      ctx.strokeStyle = colors[k];
      ctx.fill(paths[k]);
      ctx.stroke(paths[k]);
    }
  }

  function drawMeshLines(ctx, P, tris, color) {
    const path = new Path2D();
    for (let e = 0; e < tris.length; e += 3) {
      const a = tris[e], b = tris[e + 1], c = tris[e + 2];
      path.moveTo(P[2 * a], P[2 * a + 1]); path.lineTo(P[2 * b], P[2 * b + 1]); path.lineTo(P[2 * c], P[2 * c + 1]); path.closePath();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.stroke(path);
  }

  function arrow(ctx, x1, y1, x2, y2, head = 7) {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
    if (L < 1) return;
    const ux = dx / L, uy = dy / L;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 - ux * head * 0.8, y2 - uy * head * 0.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - ux * head - uy * head * 0.45, y2 - uy * head + ux * head * 0.45);
    ctx.lineTo(x2 - ux * head + uy * head * 0.45, y2 - uy * head - ux * head * 0.45);
    ctx.closePath();
    ctx.fill();
  }

  function badge(ctx, x, y, text, color) {
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12, hgt = 18;
    ctx.fillStyle = 'rgba(15,18,22,0.85)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - hgt / 2, w, hgt, 9);
    else ctx.rect(x - w / 2, y - hgt / 2, w, hgt);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }

  function fmtForce(f) {
    const a = Math.abs(f);
    if (a >= 1e6) return +(f / 1e6).toPrecision(3) + ' MN';
    if (a >= 1e3) return +(f / 1e3).toPrecision(3) + ' kN';
    return +f.toPrecision(3) + ' N';
  }

  const BC_LABEL = { fixed: 'Fixed', fixx: 'Fix X', fixy: 'Fix Y' };

  /** Supports and loads on edges and holes. toS(x, y) -> [sx, sy]; scale = px per mm. */
  function drawBCs(ctx, model, toS, scale, colors) {
    const sup = colors.support, load = colors.load;
    const n = model.outline.length;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const bc = model.edgeBC[i];
      if (!bc || bc.type === 'free') continue;
      const A = model.outline[i], B = model.outline[(i + 1) % n];
      const [ax, ay] = toS(A.x, A.y), [bx, by] = toS(B.x, B.y);
      const L = Math.hypot(bx - ax, by - ay);
      if (L < 2) continue;
      const tx = (bx - ax) / L, ty = (by - ay) / L;
      // outward normal in screen space (outline is CCW in world, y flipped on screen)
      const nx = -ty, ny = tx;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (bc.type === 'fixed' || bc.type === 'fixx' || bc.type === 'fixy') {
        ctx.strokeStyle = sup; ctx.fillStyle = sup;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.lineWidth = 1.2;
        if (bc.type === 'fixed') {
          ctx.beginPath();
          for (let s = 4; s < L; s += 9) {
            const px = ax + tx * s, py = ay + ty * s;
            ctx.moveTo(px, py);
            ctx.lineTo(px + nx * 9 - tx * 6, py + ny * 9 - ty * 6);
          }
          ctx.stroke();
        } else {
          ctx.beginPath();
          for (let s = 8; s < L - 4; s += 16) {
            const px = ax + tx * s + nx * 4.5, py = ay + ty * s + ny * 4.5;
            ctx.moveTo(px + 3.5, py);
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
          }
          ctx.moveTo(ax + nx * 9.5, ay + ny * 9.5);
          ctx.lineTo(bx + nx * 9.5, by + ny * 9.5);
          ctx.stroke();
        }
        badge(ctx, mx + nx * 26, my + ny * 26, BC_LABEL[bc.type], sup);
      } else if (bc.type === 'force' && (bc.fx || bc.fy)) {
        const Fm = Math.hypot(bc.fx, bc.fy);
        const dx = bc.fx / Fm, dy = -bc.fy / Fm;
        const out = dx * nx + dy * ny >= 0;
        const count = Math.max(2, Math.min(9, Math.floor(L / 34)));
        ctx.strokeStyle = load; ctx.fillStyle = load; ctx.lineWidth = 1.8;
        for (let k = 0; k < count; k++) {
          const s = ((k + 0.5) / count) * L;
          const px = ax + tx * s, py = ay + ty * s;
          if (out) arrow(ctx, px + dx * 2, py + dy * 2, px + dx * 30, py + dy * 30);
          else arrow(ctx, px - dx * 32, py - dy * 32, px - dx * 2, py - dy * 2);
        }
        const off = out ? 46 : -46;
        badge(ctx, mx + dx * off + nx * 6, my + dy * off + ny * 6, fmtForce(Fm), load);
      } else if (bc.type === 'pressure' && bc.p) {
        const count = Math.max(2, Math.min(12, Math.floor(L / 24)));
        ctx.strokeStyle = load; ctx.fillStyle = load; ctx.lineWidth = 1.5;
        for (let k = 0; k < count; k++) {
          const s = ((k + 0.5) / count) * L;
          const px = ax + tx * s, py = ay + ty * s;
          if (bc.p > 0) arrow(ctx, px + nx * 24, py + ny * 24, px + nx * 2, py + ny * 2, 6);
          else arrow(ctx, px + nx * 2, py + ny * 2, px + nx * 24, py + ny * 24, 6);
        }
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(ax + nx * 24, ay + ny * 24); ctx.lineTo(bx + nx * 24, by + ny * 24); ctx.stroke();
        badge(ctx, mx + nx * 40, my + ny * 40, +bc.p.toPrecision(3) + ' MPa', load);
      }
    }

    for (const hl of model.holes) {
      const bc = hl.bc;
      if (!bc || bc.type === 'free') continue;
      const [cx, cy] = toS(hl.x, hl.y), r = hl.r * scale;
      if (bc.type === 'fixed') {
        ctx.strokeStyle = sup; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1.2;
        const m = Math.max(8, Math.min(40, Math.floor((2 * Math.PI * r) / 9)));
        ctx.beginPath();
        for (let k = 0; k < m; k++) {
          const a = (2 * Math.PI * k) / m, ca = Math.cos(a), sa = Math.sin(a);
          const px = cx + ca * r, py = cy + sa * r;
          ctx.moveTo(px, py);
          ctx.lineTo(px - ca * Math.min(8, r * 0.5) + sa * 5, py - sa * Math.min(8, r * 0.5) - ca * 5);
        }
        ctx.stroke();
        badge(ctx, cx, cy, 'Fixed', sup);
      } else if (bc.type === 'bearing' && (bc.fx || bc.fy)) {
        const Fm = Math.hypot(bc.fx, bc.fy), dx = bc.fx / Fm, dy = -bc.fy / Fm;
        ctx.strokeStyle = load; ctx.fillStyle = load; ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 2.2;
        const len = Math.max(36, r * 1.6);
        arrow(ctx, cx, cy, cx + dx * len, cy + dy * len, 9);
        badge(ctx, cx - dx * 22, cy - dy * 22 - (Math.abs(dx) > 0.7 ? 0 : 0), fmtForce(Fm), load);
      } else if (bc.type === 'pressure' && bc.p) {
        ctx.strokeStyle = load; ctx.fillStyle = load; ctx.lineWidth = 1.4;
        const m = Math.max(6, Math.min(16, Math.floor((2 * Math.PI * r) / 22)));
        const inner = Math.max(r * 0.35, r - 22);
        for (let k = 0; k < m; k++) {
          const a = (2 * Math.PI * k) / m, ca = Math.cos(a), sa = Math.sin(a);
          if (bc.p > 0) arrow(ctx, cx + ca * inner, cy + sa * inner, cx + ca * (r - 2), cy + sa * (r - 2), 5);
          else arrow(ctx, cx + ca * (r - 2), cy + sa * (r - 2), cx + ca * inner, cy + sa * inner, 5);
        }
        badge(ctx, cx, cy, +bc.p.toPrecision(3) + ' MPa', load);
      }
    }
    ctx.restore();
  }

  Object.assign(S, { turbo, diverging, bandColors, drawBands, drawElements, drawMeshLines, drawBCs, arrow, badge, fmtForce });
})(typeof globalThis !== 'undefined' ? globalThis : window);
