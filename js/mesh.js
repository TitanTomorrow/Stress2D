/* Triangle mesh generation.
 * 1. Boundary nodes along every outline edge and around every hole (finer near holes).
 * 2. Graded rings of nodes around holes, then a hexagonal lattice for the interior.
 * 3. Bowyer-Watson Delaunay triangulation; triangles outside the part are discarded.
 * Interior nodes are kept clear of each boundary segment's diametral circle, so the
 * boundary segments survive as triangle edges and the inside/outside test is exact.
 */
(function (root) {
  const S = root.S2D || (root.S2D = {});

  // Small deterministic PRNG so the same model always gives the same mesh.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function delaunay(X, Y) {
    const n = X.length;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (X[i] < minX) minX = X[i];
      if (X[i] > maxX) maxX = X[i];
      if (Y[i] < minY) minY = Y[i];
      if (Y[i] > maxY) maxY = Y[i];
    }
    const d = Math.max(maxX - minX, maxY - minY) || 1;
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    const PX = new Float64Array(n + 3), PY = new Float64Array(n + 3);
    PX.set(X); PY.set(Y);
    PX[n] = mx - 20 * d; PY[n] = my - 10 * d;
    PX[n + 1] = mx + 20 * d; PY[n + 1] = my - 10 * d;
    PX[n + 2] = mx; PY[n + 2] = my + 20 * d;

    const TA = [], TB = [], TC = [], CX = [], CY = [], R2 = [];
    function addTri(a, b, c) {
      const ax = PX[a], ay = PY[a];
      const bx = PX[b] - ax, by = PY[b] - ay, cx = PX[c] - ax, cy = PY[c] - ay;
      const dd = 2 * (bx * cy - by * cx);
      const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
      const ux = (cy * b2 - by * c2) / dd, uy = (bx * c2 - cx * b2) / dd;
      TA.push(a); TB.push(b); TC.push(c);
      CX.push(ax + ux); CY.push(ay + uy); R2.push(ux * ux + uy * uy);
    }
    addTri(n, n + 1, n + 2);

    const N = n + 3;
    const edges = new Map();
    for (let p = 0; p < n; p++) {
      const px = PX[p], py = PY[p];
      edges.clear();
      for (let i = 0; i < TA.length; ) {
        const dx = px - CX[i], dy = py - CY[i];
        if (dx * dx + dy * dy < R2[i]) {
          const a = TA[i], b = TB[i], c = TC[i];
          for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const key = u < v ? u * N + v : v * N + u;
            if (edges.has(key)) edges.delete(key);
            else edges.set(key, [u, v]);
          }
          const last = TA.length - 1;
          TA[i] = TA[last]; TB[i] = TB[last]; TC[i] = TC[last];
          CX[i] = CX[last]; CY[i] = CY[last]; R2[i] = R2[last];
          TA.pop(); TB.pop(); TC.pop(); CX.pop(); CY.pop(); R2.pop();
        } else i++;
      }
      for (const [u, v] of edges.values()) addTri(u, v, p);
    }
    const tris = [];
    for (let i = 0; i < TA.length; i++) {
      if (TA[i] >= n || TB[i] >= n || TC[i] >= n) continue;
      tris.push(TA[i], TB[i], TC[i]);
    }
    return tris;
  }

  /** Builds the mesh. h = target element size (mm). */
  function generateMesh(model, h) {
    const rand = rng(12345);
    const X = [], Y = [];
    const segs = []; // {a, b, kind: 'edge'|'hole', idx}
    const outline = model.outline, nv = outline.length;

    // ---- hole boundary spacing (finer than h so the stress concentration is resolved)
    const holeInfo = model.holes.map((hl) => {
      const circ = 2 * Math.PI * hl.r;
      const n0 = Math.max(48, Math.ceil(circ / (0.35 * h)));
      return { n0, s0: circ / n0 };
    });

    const distToHoles = (x, y) => {
      let d = Infinity;
      for (const hl of model.holes) d = Math.min(d, Math.abs(Math.hypot(x - hl.x, y - hl.y) - hl.r));
      return d;
    };

    // ---- outline nodes: corners first, then subdivided edges (refined near holes)
    for (const p of outline) { X.push(p.x); Y.push(p.y); }
    for (let i = 0; i < nv; i++) {
      const a = outline[i], b = outline[(i + 1) % nv];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const m = Math.max(1, Math.round(L / h));
      let ts = [];
      for (let k = 0; k <= m; k++) ts.push(k / m);
      // split segments that are long compared with their distance to a hole
      for (let pass = 0; pass < 8; pass++) {
        const next = [ts[0]];
        let changed = false;
        for (let k = 1; k < ts.length; k++) {
          const t0 = ts[k - 1], t1 = ts[k], tm = (t0 + t1) / 2;
          const len = (t1 - t0) * L;
          const dh = distToHoles(a.x + tm * (b.x - a.x), a.y + tm * (b.y - a.y));
          const minLen = holeInfo.length ? Math.min(...holeInfo.map((q) => q.s0)) : h;
          if (len > 1.2 * dh && len > 1.5 * minLen) { next.push(tm); changed = true; }
          next.push(t1);
        }
        ts = next;
        if (!changed) break;
      }
      let prev = i;
      for (let k = 1; k < ts.length - 1; k++) {
        // tiny jitter along the edge breaks exact co-circular point sets
        const step = Math.min(ts[k] - ts[k - 1], ts[k + 1] - ts[k]);
        const t = ts[k] + (rand() - 0.5) * 0.02 * step;
        X.push(a.x + t * (b.x - a.x)); Y.push(a.y + t * (b.y - a.y));
        const idx = X.length - 1;
        segs.push({ a: prev, b: idx, kind: 'edge', idx: i });
        prev = idx;
      }
      segs.push({ a: prev, b: (i + 1) % nv, kind: 'edge', idx: i });
    }

    // ---- hole boundary nodes
    model.holes.forEach((hl, k) => {
      const { n0 } = holeInfo[k];
      const first = X.length;
      for (let j = 0; j < n0; j++) {
        const ang = (2 * Math.PI * (j + (rand() - 0.5) * 0.02)) / n0;
        X.push(hl.x + hl.r * Math.cos(ang)); Y.push(hl.y + hl.r * Math.sin(ang));
      }
      for (let j = 0; j < n0; j++) segs.push({ a: first + j, b: first + ((j + 1) % n0), kind: 'hole', idx: k });
    });

    const nBoundary = X.length;
    const segLen = segs.map((s) => Math.hypot(X[s.b] - X[s.a], Y[s.b] - Y[s.a]));

    // ---- spatial hash for minimum-spacing checks
    const cell = h;
    const grid = new Map();
    const key = (ix, iy) => ix * 1048576 + iy;
    const insertHash = (i) => {
      const k = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell));
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(i);
    };
    for (let i = 0; i < nBoundary; i++) insertHash(i);
    const tooClose = (x, y, r) => {
      const ix = Math.floor(x / cell), iy = Math.floor(y / cell);
      const r2 = r * r;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get(key(ix + dx, iy + dy));
          if (!arr) continue;
          for (const j of arr) {
            const ex = X[j] - x, ey = Y[j] - y;
            if (ex * ex + ey * ey < r2) return true;
          }
        }
      return false;
    };
    const clearOfBoundary = (x, y) => {
      for (let s = 0; s < segs.length; s++) {
        const sg = segs[s];
        if (S.distPointSegment(x, y, X[sg.a], Y[sg.a], X[sg.b], Y[sg.b]) < 0.55 * segLen[s]) return false;
      }
      return true;
    };
    const tryAdd = (x, y, spacing) => {
      if (!S.insideDomain(x, y, model)) return;
      if (tooClose(x, y, 0.6 * spacing)) return;
      if (!clearOfBoundary(x, y)) return;
      X.push(x); Y.push(y);
      insertHash(X.length - 1);
    };

    // ---- graded rings around holes
    const zones = [];
    model.holes.forEach((hl, k) => {
      let s = holeInfo[k].s0, R = hl.r, ring = 0;
      while (s < 0.95 * h) {
        s = Math.min(h, s * 1.2);
        R += 0.87 * s;
        const nr = Math.max(6, Math.round((2 * Math.PI * R) / s));
        const phase = ring % 2 ? Math.PI / nr : 0;
        for (let j = 0; j < nr; j++) {
          const ang = phase + (2 * Math.PI * j) / nr + (rand() - 0.5) * 0.01;
          tryAdd(hl.x + R * Math.cos(ang), hl.y + R * Math.sin(ang), s);
        }
        ring++;
      }
      zones.push({ x: hl.x, y: hl.y, R: R + 0.45 * h });
    });

    // ---- hexagonal interior lattice
    const bb = S.bounds(outline);
    const dyRow = (h * Math.sqrt(3)) / 2;
    for (let r = 0, y = bb.minY + dyRow / 2; y < bb.maxY; r++, y += dyRow) {
      for (let x = bb.minX + (r % 2 ? h / 2 : 0); x < bb.maxX + h; x += h) {
        let inZone = false;
        for (const z of zones) if (Math.hypot(x - z.x, y - z.y) < z.R) { inZone = true; break; }
        if (inZone) continue;
        tryAdd(x + (rand() - 0.5) * 0.04 * h, y + (rand() - 0.5) * 0.04 * h, h);
      }
    }

    // ---- triangulate and keep triangles inside the part
    const raw = delaunay(X, Y);
    const kept = [];
    for (let i = 0; i < raw.length; i += 3) {
      let a = raw[i], b = raw[i + 1], c = raw[i + 2];
      const cx = (X[a] + X[b] + X[c]) / 3, cy = (Y[a] + Y[b] + Y[c]) / 3;
      if (!S.insideDomain(cx, cy, model)) continue;
      const area = (X[b] - X[a]) * (Y[c] - Y[a]) - (X[c] - X[a]) * (Y[b] - Y[a]);
      if (Math.abs(area) < 1e-12 * h * h) continue;
      if (area < 0) { const t = b; b = c; c = t; }
      kept.push(a, b, c);
    }

    // ---- drop nodes no triangle uses and renumber
    const map = new Int32Array(X.length).fill(-1);
    let nn = 0;
    for (const v of kept) if (map[v] < 0) map[v] = nn++;
    const nodes = new Float64Array(2 * nn);
    for (let i = 0; i < X.length; i++) if (map[i] >= 0) { nodes[2 * map[i]] = X[i]; nodes[2 * map[i] + 1] = Y[i]; }
    const tris = Int32Array.from(kept, (v) => map[v]);
    const outSegs = segs
      .filter((s) => map[s.a] >= 0 && map[s.b] >= 0)
      .map((s) => ({ a: map[s.a], b: map[s.b], kind: s.kind, idx: s.idx }));

    return { nodes, tris, segs: outSegs, nodeCount: nn, triCount: tris.length / 3, h };
  }

  function autoMeshSize(model, density) {
    const bb = S.bounds(model.outline);
    const L = Math.max(bb.w, bb.h);
    const div = { coarse: 25, medium: 45, fine: 75, veryfine: 110 }[density] || 45;
    // keep thin parts resolved through their thickness too
    const h = Math.min(L / div, (Math.min(bb.w, bb.h) || L) / 6);
    return +h.toPrecision(2);
  }

  Object.assign(S, { generateMesh, delaunay, autoMeshSize });
})(typeof globalThis !== 'undefined' ? globalThis : window);
