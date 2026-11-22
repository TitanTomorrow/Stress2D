/* Linear-elastic finite element solver for 2D parts.
 * Element: 3-node constant-strain triangle (CST), plane stress or plane strain.
 * Equations are numbered with Reverse Cuthill-McKee ordering and solved with a
 * skyline (profile) Cholesky factorisation, a direct solver well suited to 2D meshes.
 */
(function (root) {
  const S = root.S2D || (root.S2D = {});

  function elasticity(mat) {
    const { E, nu } = mat;
    if (mat.mode === 'strain') {
      const c = E / ((1 + nu) * (1 - 2 * nu));
      return [c * (1 - nu), c * nu, c * (1 - 2 * nu) / 2];
    }
    const c = E / (1 - nu * nu);
    return [c, c * nu, c * (1 - nu) / 2];
  }

  // Reverse Cuthill-McKee ordering of the node graph (reduces the matrix profile).
  function rcm(n, adj) {
    const order = [];
    const placed = new Uint8Array(n);
    const mark = new Int32Array(n).fill(-1);
    let stamp = 0;
    const deg = (i) => adj[i].length;

    function bfsLevels(start) {
      stamp++;
      let level = [start], last = level, depth = 0;
      mark[start] = stamp;
      while (level.length) {
        last = level;
        const next = [];
        for (const v of level)
          for (const w of adj[v]) if (!placed[w] && mark[w] !== stamp) { mark[w] = stamp; next.push(w); }
        level = next;
        if (next.length) depth++;
      }
      return { last, depth };
    }

    for (let seed = 0; seed < n; seed++) {
      if (placed[seed]) continue;
      // pseudo-peripheral start node
      let start = seed, depth = -1;
      for (let it = 0; it < 4; it++) {
        const r = bfsLevels(start);
        if (r.depth <= depth) break;
        depth = r.depth;
        start = r.last.reduce((a, b) => (deg(b) < deg(a) ? b : a));
      }
      const queue = [start];
      placed[start] = 1;
      for (let q = 0; q < queue.length; q++) {
        const v = queue[q];
        order.push(v);
        const nb = adj[v].filter((w) => !placed[w]).sort((a, b) => deg(a) - deg(b));
        for (const w of nb) { placed[w] = 1; queue.push(w); }
      }
    }
    return order.reverse();
  }

  /** Solve the model on the given mesh. Throws Error with a readable message on failure. */
  function solve(model, mesh) {
    const t0 = performance.now();
    const { nodes, tris, segs } = mesh;
    const n = mesh.nodeCount, ne = mesh.triCount;
    const mat = model.material, th = mat.t;
    const [d11, d12, d33] = elasticity(mat);

    // ---- supports
    const fixX = new Uint8Array(n), fixY = new Uint8Array(n);
    const bcOf = (s) => (s.kind === 'edge' ? model.edgeBC[s.idx] : model.holes[s.idx].bc);
    for (const s of segs) {
      const t = bcOf(s).type;
      for (const v of [s.a, s.b]) {
        if (t === 'fixed' || t === 'fixx') fixX[v] = 1;
        if (t === 'fixed' || t === 'fixy') fixY[v] = 1;
      }
    }

    // ---- loads
    const F = new Float64Array(2 * n);
    const segGeom = (s) => {
      const ax = nodes[2 * s.a], ay = nodes[2 * s.a + 1], bx = nodes[2 * s.b], by = nodes[2 * s.b + 1];
      return { ax, ay, bx, by, L: Math.hypot(bx - ax, by - ay), mx: (ax + bx) / 2, my: (ay + by) / 2 };
    };
    const addSegForce = (s, fx, fy) => {
      F[2 * s.a] += fx / 2; F[2 * s.a + 1] += fy / 2;
      F[2 * s.b] += fx / 2; F[2 * s.b + 1] += fy / 2;
    };
    // group segments by owner
    const groups = new Map();
    for (const s of segs) {
      const k = s.kind + s.idx;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const list of groups.values()) {
      const s0 = list[0], bc = bcOf(s0);
      const geo = list.map(segGeom);
      const totalL = geo.reduce((a, g) => a + g.L, 0);
      if (bc.type === 'force') {
        geo.forEach((g, i) => addSegForce(list[i], (bc.fx * g.L) / totalL, (bc.fy * g.L) / totalL));
      } else if (bc.type === 'pressure' && bc.p) {
        // positive pressure pushes onto the surface (compressive)
        geo.forEach((g, i) => {
          let nx, ny;
          if (s0.kind === 'edge') { nx = (g.by - g.ay) / g.L; ny = -(g.bx - g.ax) / g.L; }
          else {
            const hl = model.holes[s0.idx], d = Math.hypot(hl.x - g.mx, hl.y - g.my);
            nx = (hl.x - g.mx) / d; ny = (hl.y - g.my) / d;
          }
          addSegForce(list[i], -bc.p * th * g.L * nx, -bc.p * th * g.L * ny);
        });
      } else if (bc.type === 'bearing' && (bc.fx || bc.fy)) {
        // pin bearing load: cosine-distributed radial pressure on the loaded half of the hole
        const hl = model.holes[s0.idx];
        const Fm = Math.hypot(bc.fx, bc.fy), dx = bc.fx / Fm, dy = bc.fy / Fm;
        const parts = geo.map((g) => {
          const d = Math.hypot(g.mx - hl.x, g.my - hl.y), rx = (g.mx - hl.x) / d, ry = (g.my - hl.y) / d;
          const w = Math.max(0, rx * dx + ry * dy) * g.L;
          return { w, rx, ry };
        });
        const along = parts.reduce((a, p) => a + p.w * (p.rx * dx + p.ry * dy), 0);
        const k = Fm / along;
        parts.forEach((p, i) => addSegForce(list[i], k * p.w * p.rx, k * p.w * p.ry));
      }
    }

    // ---- node adjacency and equation numbering
    const adjSets = Array.from({ length: n }, () => new Set());
    for (let e = 0; e < ne; e++) {
      const a = tris[3 * e], b = tris[3 * e + 1], c = tris[3 * e + 2];
      adjSets[a].add(b).add(c); adjSets[b].add(a).add(c); adjSets[c].add(a).add(b);
    }
    const adj = adjSets.map((s) => Array.from(s));
    const order = rcm(n, adj);
    const eq = new Int32Array(2 * n).fill(-1);
    let neq = 0;
    for (const v of order) {
      if (!fixX[v]) eq[2 * v] = neq++;
      if (!fixY[v]) eq[2 * v + 1] = neq++;
    }
    if (neq === 0) throw new Error('Every node is fixed, so nothing can deform.');

    // ---- skyline profile
    const first = new Int32Array(neq);
    for (let j = 0; j < neq; j++) first[j] = j;
    const ed = new Int32Array(6);
    for (let e = 0; e < ne; e++) {
      let m = Infinity;
      for (let k = 0; k < 3; k++) {
        const v = tris[3 * e + k];
        ed[2 * k] = eq[2 * v]; ed[2 * k + 1] = eq[2 * v + 1];
      }
      for (let k = 0; k < 6; k++) if (ed[k] >= 0 && ed[k] < m) m = ed[k];
      for (let k = 0; k < 6; k++) if (ed[k] >= 0 && m < first[ed[k]]) first[ed[k]] = m;
    }
    const start = new Float64Array(neq + 1);
    for (let j = 0; j < neq; j++) start[j + 1] = start[j] + (j - first[j] + 1);
    const size = start[neq];
    if (size > 8e7) throw new Error('The mesh is too fine for the in-browser solver. Use a coarser mesh.');
    const K = new Float64Array(size);
    const diagIdx = (j) => start[j + 1] - 1;

    // ---- element matrices
    const elemB = new Float64Array(ne * 7); // b1 b2 b3 c1 c2 c3 area
    const ke = new Float64Array(36);
    for (let e = 0; e < ne; e++) {
      const a = tris[3 * e], b = tris[3 * e + 1], c = tris[3 * e + 2];
      const x1 = nodes[2 * a], y1 = nodes[2 * a + 1], x2 = nodes[2 * b], y2 = nodes[2 * b + 1], x3 = nodes[2 * c], y3 = nodes[2 * c + 1];
      const A = 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
      const bb = [y2 - y3, y3 - y1, y1 - y2], cc = [x3 - x2, x1 - x3, x2 - x1];
      elemB.set([bb[0], bb[1], bb[2], cc[0], cc[1], cc[2], A], e * 7);
      const f = th / (4 * A);
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          const bi = bb[i], ci = cc[i], bj = bb[j], cj = cc[j];
          ke[(2 * i) * 6 + 2 * j] = f * (d11 * bi * bj + d33 * ci * cj);
          ke[(2 * i) * 6 + 2 * j + 1] = f * (d12 * bi * cj + d33 * ci * bj);
          ke[(2 * i + 1) * 6 + 2 * j] = f * (d12 * ci * bj + d33 * bi * cj);
          ke[(2 * i + 1) * 6 + 2 * j + 1] = f * (d11 * ci * cj + d33 * bi * bj);
        }
      for (let k = 0; k < 3; k++) {
        const v = tris[3 * e + k];
        ed[2 * k] = eq[2 * v]; ed[2 * k + 1] = eq[2 * v + 1];
      }
      for (let p = 0; p < 6; p++) {
        const i = ed[p];
        if (i < 0) continue;
        for (let q = 0; q < 6; q++) {
          const j = ed[q];
          if (j < i) continue;
          K[start[j] + i - first[j]] += ke[p * 6 + q];
        }
      }
    }

    // ---- skyline Cholesky K = U^T U (U stored column-wise in place of K)
    let maxDiag = 0;
    for (let j = 0; j < neq; j++) maxDiag = Math.max(maxDiag, K[diagIdx(j)]);
    for (let j = 0; j < neq; j++) {
      const fj = first[j], sj = start[j];
      for (let i = fj; i <= j; i++) {
        const fi = first[i], si = start[i];
        const k0 = fi > fj ? fi : fj;
        let s = K[sj + i - fj];
        for (let k = k0; k < i; k++) s -= K[si + k - fi] * K[sj + k - fj];
        if (i < j) K[sj + i - fj] = s / K[si + i - fi];
        else {
          if (!(s > maxDiag * 1e-11)) {
            throw new Error('The part can still move or spin freely (it is under-constrained). Add more supports, e.g. fix a whole edge.');
          }
          K[sj + j - fj] = Math.sqrt(s);
        }
      }
    }

    // ---- forward / back substitution
    const y = new Float64Array(neq);
    for (let d = 0; d < 2 * n; d++) if (eq[d] >= 0) y[eq[d]] = F[d];
    for (let j = 0; j < neq; j++) {
      const fj = first[j], sj = start[j];
      let s = y[j];
      for (let k = fj; k < j; k++) s -= K[sj + k - fj] * y[k];
      y[j] = s / K[sj + j - fj];
    }
    for (let j = neq - 1; j >= 0; j--) {
      const fj = first[j], sj = start[j];
      const xj = (y[j] /= K[sj + j - fj]);
      for (let k = fj; k < j; k++) y[k] -= K[sj + k - fj] * xj;
    }
    const u = new Float64Array(2 * n);
    for (let d = 0; d < 2 * n; d++) if (eq[d] >= 0) u[d] = y[eq[d]];

    // ---- element stresses, reactions, nodal averaging
    const esx = new Float64Array(ne), esy = new Float64Array(ne), etxy = new Float64Array(ne);
    const Fint = new Float64Array(2 * n);
    const acc = new Float64Array(n * 3), wsum = new Float64Array(n);
    const nu = mat.nu, strain = mat.mode === 'strain';
    for (let e = 0; e < ne; e++) {
      const o = e * 7, A = elemB[o + 6];
      const v = [tris[3 * e], tris[3 * e + 1], tris[3 * e + 2]];
      let ex = 0, ey = 0, gxy = 0;
      for (let k = 0; k < 3; k++) {
        const ux = u[2 * v[k]], uy = u[2 * v[k] + 1];
        ex += elemB[o + k] * ux;
        ey += elemB[o + 3 + k] * uy;
        gxy += elemB[o + 3 + k] * ux + elemB[o + k] * uy;
      }
      ex /= 2 * A; ey /= 2 * A; gxy /= 2 * A;
      const sx = d11 * ex + d12 * ey, sy = d12 * ex + d11 * ey, txy = d33 * gxy;
      esx[e] = sx; esy[e] = sy; etxy[e] = txy;
      for (let k = 0; k < 3; k++) {
        const bk = elemB[o + k], ck = elemB[o + 3 + k];
        Fint[2 * v[k]] += (th / 2) * (bk * sx + ck * txy);
        Fint[2 * v[k] + 1] += (th / 2) * (ck * sy + bk * txy);
        acc[3 * v[k]] += A * sx; acc[3 * v[k] + 1] += A * sy; acc[3 * v[k] + 2] += A * txy;
        wsum[v[k]] += A;
      }
    }
    let Rx = 0, Ry = 0, Fx = 0, Fy = 0;
    for (let v = 0; v < n; v++) {
      if (fixX[v]) Rx += Fint[2 * v] - F[2 * v];
      if (fixY[v]) Ry += Fint[2 * v + 1] - F[2 * v + 1];
      Fx += F[2 * v]; Fy += F[2 * v + 1];
    }

    const derived = (sx, sy, txy) => {
      const sz = strain ? nu * (sx + sy) : 0;
      const c = (sx + sy) / 2, r = Math.hypot((sx - sy) / 2, txy);
      const vm = Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * txy * txy);
      const s1 = c + r, s2 = c - r;
      const tresca = Math.max(s1, s2, sz) - Math.min(s1, s2, sz);
      return { vm, s1, s2, tresca, tmax: tresca / 2 };
    };
    const field = () => ({ sx: new Float64Array(n), sy: new Float64Array(n), txy: new Float64Array(n), vm: new Float64Array(n), s1: new Float64Array(n), s2: new Float64Array(n), tmax: new Float64Array(n), umag: new Float64Array(n), ux: new Float64Array(n), uy: new Float64Array(n) });
    // ---- patch recovery: least-squares linear fit of element-centroid stresses around
    // each node, evaluated at the node. Recovers peak stresses at free edges far better
    // than plain averaging of constant-strain elements.
    const nodeElems = Array.from({ length: n }, () => []);
    const cen = new Float64Array(2 * ne);
    for (let e = 0; e < ne; e++) {
      for (let k = 0; k < 3; k++) {
        const v = tris[3 * e + k];
        nodeElems[v].push(e);
        cen[2 * e] += nodes[2 * v] / 3; cen[2 * e + 1] += nodes[2 * v + 1] / 3;
      }
    }
    const hs = mesh.h || 1;
    const recovered = (v) => {
      let patch = nodeElems[v];
      if (patch.length < 4) {
        const set = new Set(patch);
        for (const e of nodeElems[v]) for (let k = 0; k < 3; k++) for (const e2 of nodeElems[tris[3 * e + k]]) set.add(e2);
        patch = Array.from(set);
      }
      if (patch.length < 3) return null;
      let m00 = 0, m01 = 0, m02 = 0, m11 = 0, m12 = 0, m22 = 0;
      const r = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (const e of patch) {
        const px = (cen[2 * e] - nodes[2 * v]) / hs, py = (cen[2 * e + 1] - nodes[2 * v + 1]) / hs;
        m00 += 1; m01 += px; m02 += py; m11 += px * px; m12 += px * py; m22 += py * py;
        const vals = [esx[e], esy[e], etxy[e]];
        for (let c = 0; c < 3; c++) { r[3 * c] += vals[c]; r[3 * c + 1] += px * vals[c]; r[3 * c + 2] += py * vals[c]; }
      }
      // a0 of the 3x3 system M a = r via Cramer's rule
      const det = m00 * (m11 * m22 - m12 * m12) - m01 * (m01 * m22 - m12 * m02) + m02 * (m01 * m12 - m11 * m02);
      if (!(Math.abs(det) > 1e-6 * patch.length ** 3)) return null;
      const out = [];
      for (let c = 0; c < 3; c++) {
        const r0 = r[3 * c], r1 = r[3 * c + 1], r2 = r[3 * c + 2];
        out.push((r0 * (m11 * m22 - m12 * m12) - m01 * (r1 * m22 - m12 * r2) + m02 * (r1 * m12 - m11 * r2)) / det);
      }
      return out;
    };

    const nodal = field();
    for (let v = 0; v < n; v++) {
      const w = wsum[v] || 1;
      let sx = acc[3 * v] / w, sy = acc[3 * v + 1] / w, txy = acc[3 * v + 2] / w;
      const rv = recovered(v);
      if (rv) [sx, sy, txy] = rv;
      const d = derived(sx, sy, txy);
      nodal.sx[v] = sx; nodal.sy[v] = sy; nodal.txy[v] = txy;
      nodal.vm[v] = d.vm; nodal.s1[v] = d.s1; nodal.s2[v] = d.s2; nodal.tmax[v] = d.tmax;
      nodal.ux[v] = u[2 * v]; nodal.uy[v] = u[2 * v + 1];
      nodal.umag[v] = Math.hypot(u[2 * v], u[2 * v + 1]);
    }
    const elem = { sx: esx, sy: esy, txy: etxy, vm: new Float64Array(ne), s1: new Float64Array(ne), s2: new Float64Array(ne), tmax: new Float64Array(ne), umag: new Float64Array(ne), ux: new Float64Array(ne), uy: new Float64Array(ne) };
    for (let e = 0; e < ne; e++) {
      const d = derived(esx[e], esy[e], etxy[e]);
      elem.vm[e] = d.vm; elem.s1[e] = d.s1; elem.s2[e] = d.s2; elem.tmax[e] = d.tmax;
      for (const k of ['umag', 'ux', 'uy'])
        elem[k][e] = (nodal[k][tris[3 * e]] + nodal[k][tris[3 * e + 1]] + nodal[k][tris[3 * e + 2]]) / 3;
    }

    return {
      u, nodal, elem,
      reaction: { x: Rx, y: Ry }, applied: { x: Fx, y: Fy },
      stats: { nodes: n, elements: ne, equations: neq, profile: size, ms: performance.now() - t0 },
    };
  }

  Object.assign(S, { solve, rcm, elasticity });
})(typeof globalThis !== 'undefined' ? globalThis : window);
