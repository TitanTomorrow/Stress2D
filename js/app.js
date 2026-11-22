/* Stress2D application: model editing, solving and result display. */
(function () {
  const S = window.S2D;
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const COLORS = {
    support: css.getPropertyValue('--support').trim() || '#5eead4',
    load: css.getPropertyValue('--load').trim() || '#ffa24c',
    accent: css.getPropertyValue('--accent').trim() || '#4cc2ff',
  };

  const FIELDS = {
    vm: { label: 'Von Mises stress', unit: 'MPa', signed: false },
    s1: { label: 'Max principal σ₁', unit: 'MPa', signed: true },
    s2: { label: 'Min principal σ₂', unit: 'MPa', signed: true },
    tmax: { label: 'Max shear stress', unit: 'MPa', signed: false },
    sx: { label: 'Normal stress σx', unit: 'MPa', signed: true },
    sy: { label: 'Normal stress σy', unit: 'MPa', signed: true },
    txy: { label: 'Shear stress τxy', unit: 'MPa', signed: true },
    umag: { label: 'Displacement |u|', unit: 'mm', signed: false },
    ux: { label: 'Displacement ux', unit: 'mm', signed: true },
    uy: { label: 'Displacement uy', unit: 'mm', signed: true },
  };

  const EDGE_BC = [
    ['free', 'Free', ''], ['fixed', 'Fixed', 'support'], ['fixx', 'Fix X', 'support'],
    ['fixy', 'Fix Y', 'support'], ['force', 'Force', 'load'], ['pressure', 'Pressure', 'load'],
  ];
  const HOLE_BC = [['free', 'Free', ''], ['fixed', 'Fixed', 'support'], ['bearing', 'Pin load', 'load'], ['pressure', 'Pressure', 'load']];

  const state = {
    model: null,
    preset: 'plateHole',
    density: 'medium',
    tool: 'select',
    selection: null, // {kind: 'edge'|'vertex'|'hole', idx}
    hover: null,
    draft: [], // outline points being drawn
    holeDraft: null,
    cursor: null, // world coords
    view: { scale: 1, ox: 0, oy: 0 },
    version: 0,
    mesh: null,
    result: null, // {version, mesh, res}
    display: { field: 'vm', bands: 12, deform: 50, smooth: 'nodal', showMesh: false, showUndeformed: true, showBC: true },
    autoSolve: true,
    defaultHoleR: 10,
    undo: [],
    redo: [],
    drag: null,
    lastP: null,
  };

  // ---------------------------------------------------------------- utilities
  const fmt = (v, sig = 3) => {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(sig - 1);
    return String(+v.toPrecision(sig));
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const bboxSize = () => { const b = S.bounds(state.model.outline); return Math.max(b.w, b.h) || 100; };
  const gridStep = () => {
    const raw = bboxSize() / 40;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  };
  const snap = (v, step) => Math.round(v / step) * step;
  const round = (v) => Math.round(v * 1000) / 1000;

  function toS(x, y) {
    const v = state.view;
    return [v.ox + x * v.scale, v.oy - y * v.scale];
  }
  function toW(sx, sy) {
    const v = state.view;
    return [(sx - v.ox) / v.scale, (v.oy - sy) / v.scale];
  }

  let toastTimer = 0;
  function toast(msg, ms = 4500) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  // ---------------------------------------------------------------- model mutation
  function snapshot() {
    return JSON.stringify({ outline: state.model.outline, edgeBC: state.model.edgeBC, holes: state.model.holes, material: state.model.material });
  }
  function pushUndo() {
    state.undo.push(snapshot());
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
    updateUndoButtons();
  }
  function restore(json) {
    const m = JSON.parse(json);
    Object.assign(state.model, m);
    state.selection = null;
    syncMaterialUI();
    changed();
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
    updateUndoButtons();
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $('undo').disabled = !state.undo.length;
    $('redo').disabled = !state.redo.length;
  }

  let solveTimer = 0;
  /** Call after any change to the model. */
  function changed(opts = {}) {
    state.version++;
    state.mesh = null;
    renderInspector();
    updateSummary();
    draw();
    clearTimeout(solveTimer);
    if (state.autoSolve && !opts.noSolve) solveTimer = setTimeout(() => solve(true), 250);
  }

  function loadPreset(key) {
    const p = S.PRESETS[key].build();
    const mat = state.model ? state.model.material : S.defaultMaterial();
    state.model = { outline: p.outline, edgeBC: p.edgeBC, holes: p.holes, material: mat };
    state.preset = key;
    state.selection = null;
    state.draft = [];
    const b = S.bounds(p.outline);
    state.defaultHoleR = +(Math.min(b.w, b.h) / 8).toPrecision(2);
    fitView();
    changed();
  }

  // ---------------------------------------------------------------- solving
  function currentResult() {
    return state.result && state.result.version === state.version ? state.result : null;
  }

  function getMesh() {
    if (state.mesh && state.mesh.version === state.version && state.mesh.density === state.density) return state.mesh.mesh;
    const h = S.autoMeshSize(state.model, state.density);
    const mesh = S.generateMesh(state.model, h);
    state.mesh = { version: state.version, density: state.density, mesh };
    return mesh;
  }

  function solve(auto) {
    clearTimeout(solveTimer);
    const errs = S.validateModel(state.model);
    if (errs.length) {
      if (!auto) toast(errs[0]);
      renderInspector();
      return;
    }
    $('busy').hidden = false;
    const version = state.version;
    setTimeout(() => {
      try {
        if (version !== state.version) return;
        const mesh = getMesh();
        if (mesh.nodeCount > 30000) throw new Error('The mesh has too many nodes for the browser. Choose a coarser mesh density.');
        const res = S.solve(state.model, mesh);
        let maxU = 0;
        for (const v of res.nodal.umag) if (v > maxU) maxU = v;
        state.result = { version, mesh, res, autoScale: maxU > 0 ? (0.07 * bboxSize()) / maxU : 0 };
      } catch (e) {
        console.error(e);
        state.result = null;
        toast(e.message || String(e), 7000);
      } finally {
        $('busy').hidden = true;
        updateSummary();
        draw();
      }
    }, 16);
  }

  function deformFactor(r) {
    const s = state.display.deform;
    if (!r || s <= 0) return 0;
    return r.autoScale * Math.pow(10, (s - 50) / 25);
  }

  // ---------------------------------------------------------------- view
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function fitView() {
    const r = canvas.getBoundingClientRect();
    const b = S.bounds(state.model.outline);
    const padL = 70, padR = 150, padY = 80;
    const W = Math.max(100, r.width - padL - padR), H = Math.max(100, r.height - 2 * padY);
    const scale = Math.min(W / (b.w || 1), H / (b.h || 1));
    state.view.scale = scale;
    state.view.ox = padL + (W - b.w * scale) / 2 - b.minX * scale;
    state.view.oy = padY + (H + b.h * scale) / 2 + b.minY * scale;
    draw();
  }

  function zoomAt(sx, sy, f) {
    const [wx, wy] = toW(sx, sy);
    state.view.scale *= f;
    state.view.ox = sx - wx * state.view.scale;
    state.view.oy = sy + wy * state.view.scale;
    draw();
  }

  // ---------------------------------------------------------------- drawing
  let drawQueued = false;
  function draw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; paint(); });
  }

  function partPath() {
    const path = new Path2D();
    const o = state.model.outline;
    o.forEach((p, i) => { const [x, y] = toS(p.x, p.y); i ? path.lineTo(x, y) : path.moveTo(x, y); });
    path.closePath();
    for (const h of state.model.holes) {
      const [x, y] = toS(h.x, h.y);
      path.moveTo(x + h.r * state.view.scale, y);
      path.arc(x, y, h.r * state.view.scale, 0, Math.PI * 2);
    }
    return path;
  }

  function paintGrid(w, h) {
    const step = gridStep();
    const px = step * state.view.scale;
    if (px < 9) return;
    const [x0, y1] = toW(0, 0), [x1, y0] = toW(w, h);
    ctx.fillStyle = 'rgba(140,155,175,0.16)';
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step)
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        const [sx, sy] = toS(x, y);
        ctx.fillRect(sx - 0.75, sy - 0.75, 1.5, 1.5);
      }
    // origin axes
    const [ox, oy] = toS(0, 0);
    ctx.strokeStyle = 'rgba(140,155,175,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox, oy); ctx.lineTo(ox + 28, oy);
    ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - 28);
    ctx.stroke();
    ctx.fillStyle = 'rgba(140,155,175,0.7)';
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('x', ox + 31, oy);
    ctx.fillText('y', ox - 3, oy - 35);
  }

  function paint() {
    const r = canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    ctx.clearRect(0, 0, w, h);
    paintGrid(w, h);

    const m = state.model;
    const result = currentResult();
    const legend = $('legend');

    if (result) {
      const { mesh, res } = result;
      const f = deformFactor(result);
      const n = mesh.nodeCount;
      const P = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        const [sx, sy] = toS(mesh.nodes[2 * i] + f * res.u[2 * i], mesh.nodes[2 * i + 1] + f * res.u[2 * i + 1]);
        P[2 * i] = sx; P[2 * i + 1] = sy;
      }
      state.lastP = P;
      const fd = FIELDS[state.display.field];
      const elemMode = state.display.smooth === 'elem' && !state.display.field.startsWith('u');
      const vals = elemMode ? res.elem[state.display.field] : res.nodal[state.display.field];
      let lo = Infinity, hi = -Infinity;
      for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (fd.signed) { const a = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -a; hi = a; }
      if (hi - lo < 1e-12 * (Math.abs(hi) + 1)) { lo -= 0.5; hi += 0.5; }
      const colors = S.bandColors(state.display.bands, fd.signed);
      if (state.display.showUndeformed && f > 0) {
        ctx.strokeStyle = 'rgba(200,210,225,0.35)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.stroke(partPath());
        ctx.setLineDash([]);
      }
      if (elemMode) S.drawElements(ctx, P, mesh.tris, vals, lo, hi, colors);
      else S.drawBands(ctx, P, mesh.tris, vals, lo, hi, colors);
      if (state.display.showMesh) S.drawMeshLines(ctx, P, mesh.tris, 'rgba(10,12,16,0.45)');
      // boundary outline of the deformed shape
      ctx.strokeStyle = 'rgba(10,12,16,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const s of mesh.segs) { ctx.moveTo(P[2 * s.a], P[2 * s.a + 1]); ctx.lineTo(P[2 * s.b], P[2 * s.b + 1]); }
      ctx.stroke();
      paintExtremes(P, res, vals, elemMode, mesh, fd);
      renderLegend(lo, hi, colors, fd);
      legend.hidden = false;
    } else {
      state.lastP = null;
      legend.hidden = true;
      const path = partPath();
      ctx.fillStyle = '#243041';
      ctx.fill(path, 'evenodd');
      if (state.display.showMesh && !S.validateModel(m).some((e) => /outline|Hole/.test(e))) {
        try {
          const mesh = getMesh();
          const P = new Float64Array(2 * mesh.nodeCount);
          for (let i = 0; i < mesh.nodeCount; i++) { const [sx, sy] = toS(mesh.nodes[2 * i], mesh.nodes[2 * i + 1]); P[2 * i] = sx; P[2 * i + 1] = sy; }
          S.drawMeshLines(ctx, P, mesh.tris, 'rgba(150,175,205,0.35)');
        } catch (e) { /* ignore preview errors */ }
      }
      ctx.strokeStyle = '#9fb2c8';
      ctx.lineWidth = 1.5;
      ctx.stroke(path);
    }

    if (state.display.showBC) S.drawBCs(ctx, m, toS, state.view.scale, COLORS);
    paintSelection();
    paintDrafts();
    updateMeshInfo();
  }

  function paintExtremes(P, res, vals, elemMode, mesh, fd) {
    // mark the location of the largest magnitude value of the displayed field
    let best = -1, bv = -Infinity;
    for (let i = 0; i < vals.length; i++) { const a = fd.signed ? Math.abs(vals[i]) : vals[i]; if (a > bv) { bv = a; best = i; } }
    if (best < 0) return;
    let x, y;
    if (elemMode) {
      const t = mesh.tris;
      x = (P[2 * t[3 * best]] + P[2 * t[3 * best + 1]] + P[2 * t[3 * best + 2]]) / 3;
      y = (P[2 * t[3 * best] + 1] + P[2 * t[3 * best + 1] + 1] + P[2 * t[3 * best + 2] + 1]) / 3;
    } else { x = P[2 * best]; y = P[2 * best + 1]; }
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke();
    const label = `max ${fmt(vals[best])} ${fd.unit}`;
    ctx.font = '600 12px ui-sans-serif, system-ui';
    const tw = ctx.measureText(label).width;
    let lx = x + 12, ly = y - 14;
    if (lx + tw + 10 > canvas.clientWidth - 160) lx = x - 12 - tw - 10;
    ctx.fillStyle = 'rgba(15,18,22,0.85)';
    ctx.fillRect(lx, ly - 10, tw + 10, 20);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 5, ly);
    ctx.restore();
  }

  function paintSelection() {
    const m = state.model, sel = state.selection, hov = state.hover;
    const n = m.outline.length;
    const edgeLine = (i, color, width) => {
      const A = m.outline[i], B = m.outline[(i + 1) % n];
      const [ax, ay] = toS(A.x, A.y), [bx, by] = toS(B.x, B.y);
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    };
    const holeRing = (i, color, width) => {
      const h = m.holes[i]; const [x, y] = toS(h.x, h.y);
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.arc(x, y, h.r * state.view.scale, 0, Math.PI * 2); ctx.stroke();
    };
    ctx.save();
    ctx.lineCap = 'round';
    if (state.tool === 'select') {
      if (hov && !(sel && sel.kind === hov.kind && sel.idx === hov.idx)) {
        if (hov.kind === 'edge') edgeLine(hov.idx, 'rgba(76,194,255,0.45)', 6);
        if (hov.kind === 'hole') holeRing(hov.idx, 'rgba(76,194,255,0.45)', 6);
      }
      if (sel && sel.kind === 'edge') edgeLine(sel.idx, COLORS.accent, 3.5);
      if (sel && sel.kind === 'hole') holeRing(sel.idx, COLORS.accent, 3.5);
      // corner handles
      m.outline.forEach((p, i) => {
        const [x, y] = toS(p.x, p.y);
        const on = sel && sel.kind === 'vertex' && sel.idx === i;
        const hv = hov && hov.kind === 'vertex' && hov.idx === i;
        ctx.fillStyle = on ? COLORS.accent : hv ? '#cfe9ff' : '#0f1216';
        ctx.strokeStyle = on || hv ? COLORS.accent : '#9fb2c8';
        ctx.lineWidth = 1.5;
        const s = on || hv ? 5 : 3.5;
        ctx.fillRect(x - s, y - s, 2 * s, 2 * s);
        ctx.strokeRect(x - s, y - s, 2 * s, 2 * s);
      });
    }
    ctx.restore();
  }

  function paintDrafts() {
    ctx.save();
    if (state.tool === 'outline' && state.draft.length) {
      ctx.strokeStyle = COLORS.accent; ctx.fillStyle = COLORS.accent; ctx.lineWidth = 2;
      ctx.beginPath();
      state.draft.forEach((p, i) => { const [x, y] = toS(p.x, p.y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      if (state.cursor) { const [x, y] = toS(state.cursor.x, state.cursor.y); ctx.lineTo(x, y); }
      ctx.stroke();
      state.draft.forEach((p, i) => {
        const [x, y] = toS(p.x, p.y);
        ctx.beginPath(); ctx.arc(x, y, i === 0 ? 6 : 3.5, 0, Math.PI * 2);
        i === 0 ? ctx.stroke() : ctx.fill();
      });
    }
    if ((state.tool === 'outline' || state.tool === 'hole') && state.cursor && !state.holeDraft) {
      const [x, y] = toS(state.cursor.x, state.cursor.y);
      ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke();
      if (state.tool === 'hole') {
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.arc(x, y, state.defaultHoleR * state.view.scale, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (state.holeDraft) {
      const d = state.holeDraft; const [x, y] = toS(d.x, d.y);
      const r = (d.r || state.defaultHoleR) * state.view.scale;
      ctx.fillStyle = 'rgba(76,194,255,0.15)'; ctx.strokeStyle = COLORS.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      S.badge(ctx, x, y - r - 14, `r = ${fmt(d.r || state.defaultHoleR)} mm`, COLORS.accent);
    }
    ctx.restore();
  }

  function renderLegend(lo, hi, colors, fd) {
    const el = $('legend');
    const nb = colors.length;
    const H = Math.min(260, Math.max(140, nb * 16));
    const every = Math.ceil((nb + 1) / 9);
    let ticks = '';
    for (let k = 0; k <= nb; k += every) ticks += `<span style="bottom:${(k / nb) * 100}%">${fmt(lo + ((hi - lo) * k) / nb)}</span>`;
    if (nb % every) ticks += `<span style="bottom:100%">${fmt(hi)}</span>`;
    el.innerHTML = `<div class="title">${fd.label} <small>${fd.unit}</small></div>
      <div class="bar" style="height:${H}px"><div class="swatches">${colors.map((c) => `<div style="background:${c}"></div>`).join('')}</div>
      <div class="ticks">${ticks}</div></div>`;
  }

  function updateMeshInfo() {
    const r = currentResult();
    const h = S.autoMeshSize(state.model, state.density);
    $('meshInfo').textContent = r
      ? `${r.mesh.nodeCount.toLocaleString()} nodes · ${r.mesh.triCount.toLocaleString()} triangles · element size ≈ ${fmt(h)} mm (finer near holes)`
      : `Element size ≈ ${fmt(h)} mm (finer near holes).`;
  }

  // ---------------------------------------------------------------- results panel
  function updateSummary() {
    deformLabel();
    updateHint();
    const el = $('summary');
    const r = currentResult();
    if (!r) {
      const errs = S.validateModel(state.model);
      el.innerHTML = state.result
        ? `<p class="muted">The model has changed. ${state.autoSolve && !errs.length ? 'Re-solving…' : 'Press <b>Solve</b> to update the results.'}</p>`
        : `<p class="muted">${errs.length ? 'Finish setting up the model (see the left panel), then solve.' : 'Ready. Press <b>Solve</b>.'}</p>`;
      return;
    }
    const { res, mesh } = r;
    const max = (a) => { let m = -Infinity, k = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) { m = a[i]; k = i; } return [m, k]; };
    const min = (a) => { let m = Infinity; for (const v of a) if (v < m) m = v; return m; };
    const [vm, k] = max(res.nodal.vm);
    const [umax] = max(res.nodal.umag);
    const [s1] = max(res.nodal.s1);
    const s2 = min(res.nodal.s2);
    const y = state.model.material.yield;
    const sf = y > 0 && vm > 0 ? y / vm : Infinity;
    const cls = sf < 1 ? 'bad' : sf < 1.5 ? 'warn' : '';
    const verdict = sf < 1 ? 'Yields: the peak stress exceeds the yield strength.' : sf < 1.5 ? 'Low margin against yield.' : 'Stays elastic with margin.';
    const Fm = Math.hypot(res.applied.x, res.applied.y);
    const bal = Math.hypot(res.applied.x + res.reaction.x, res.applied.y + res.reaction.y) <= 1e-6 * Math.max(Fm, 1);
    el.innerHTML = `
      <div class="card"><div class="label">Max von Mises stress</div>
        <div class="big"><strong>${fmt(vm)}</strong><span>MPa</span></div>
        <div class="label">at x = ${fmt(mesh.nodes[2 * k])}, y = ${fmt(mesh.nodes[2 * k + 1])} mm</div></div>
      <div class="card sf ${cls}"><div class="label">Safety factor against yield (${fmt(y)} MPa)</div>
        <div class="big"><strong>${isFinite(sf) ? sf.toFixed(2) : '—'}</strong></div>
        <div class="label">${verdict}</div></div>
      <div class="card kv">
        <span>Max displacement</span><span>${fmt(umax)} mm</span>
        <span>Max principal σ₁</span><span>${fmt(s1)} MPa</span>
        <span>Min principal σ₂</span><span>${fmt(s2)} MPa</span>
        <span>Applied load</span><span>${S.fmtForce(Fm)}</span>
        <span>Support reactions</span><span>${bal ? 'balance ✓' : 'check'}</span>
        <span>Mesh</span><span>${mesh.nodeCount.toLocaleString()} nodes</span>
        <span>Solve time</span><span>${res.stats.ms.toFixed(0)} ms</span>
      </div>`;
  }

  // ---------------------------------------------------------------- inspector
  function numInput(id, label, value, unit, step = 'any') {
    return `<label class="row"><span>${label}</span><span class="unit-in"><input type="number" id="${id}" value="${value}" step="${step}" /><em>${unit}</em></span></label>`;
  }

  function renderInspector() {
    const el = $('inspector'), title = $('inspTitle');
    const m = state.model, sel = state.selection;
    const errs = S.validateModel(m);
    const errHtml = errs.length && !sel ? `<div class="errors">${errs.map((e) => `<p>${e}</p>`).join('')}</div>` : '';

    if (!sel) {
      title.textContent = 'Model';
      el.innerHTML = `
        <p class="kicker">${m.outline.length} edges · ${m.holes.length} hole${m.holes.length === 1 ? '' : 's'}</p>
        <ol class="steps">
          <li><b>Shape</b>: pick a part, drag corners, or use <b>Draw outline</b> and <b>Add hole</b>.</li>
          <li><b>Supports</b>: click an edge or hole and set it to Fixed.</li>
          <li><b>Loads</b>: click another edge or hole and add a force or pressure.</li>
          <li><b>Solve</b>, then hover the part to read stresses.</li>
        </ol>${errHtml}`;
      return;
    }

    if (sel.kind === 'edge') {
      const i = sel.idx, bc = m.edgeBC[i];
      title.textContent = `Edge ${i + 1}`;
      const A = m.outline[i], B = m.outline[(i + 1) % m.outline.length];
      el.innerHTML = `
        <p class="kicker">${fmt(S.edgeLength(m, i))} mm long · (${fmt(A.x)}, ${fmt(A.y)}) → (${fmt(B.x)}, ${fmt(B.y)})</p>
        <div class="bc-grid">${EDGE_BC.map(([k, l, kind]) => `<button data-bc="${k}" data-kind="${kind}" class="${bc.type === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${bcFields(bc, 'edge')}
        <div class="btn-row"><button class="btn" id="splitEdge" title="Add a corner in the middle of this edge">Split edge</button></div>`;
      $('splitEdge').onclick = () => splitEdge(i);
    } else if (sel.kind === 'vertex') {
      const i = sel.idx, p = m.outline[i];
      title.textContent = `Corner ${i + 1}`;
      el.innerHTML = `
        ${numInput('vx', 'X', p.x, 'mm')}${numInput('vy', 'Y', p.y, 'mm')}
        <div class="btn-row"><button class="btn danger" id="delVertex" ${m.outline.length <= 3 ? 'disabled' : ''}>Delete corner</button></div>`;
      const apply = () => {
        const x = parseFloat($('vx').value), y = parseFloat($('vy').value);
        if (!isFinite(x) || !isFinite(y)) return;
        const old = { x: p.x, y: p.y };
        pushUndo();
        p.x = x; p.y = y;
        if (!S.isSimplePolygon(m.outline)) { p.x = old.x; p.y = old.y; state.undo.pop(); toast('That position would make the outline cross itself.'); renderInspector(); return; }
        changed();
      };
      $('vx').onchange = apply; $('vy').onchange = apply;
      $('delVertex').onclick = () => deleteVertex(i);
    } else if (sel.kind === 'hole') {
      const i = sel.idx, h = m.holes[i];
      title.textContent = `Hole ${i + 1}`;
      el.innerHTML = `
        ${numInput('hx', 'Centre X', h.x, 'mm')}${numInput('hy', 'Centre Y', h.y, 'mm')}${numInput('hr', 'Radius', h.r, 'mm')}
        <div class="bc-grid" style="margin-top:12px">${HOLE_BC.map(([k, l, kind]) => `<button data-bc="${k}" data-kind="${kind}" class="${h.bc.type === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        ${bcFields(h.bc, 'hole')}
        <div class="btn-row"><button class="btn danger" id="delHole">Delete hole</button></div>`;
      const apply = () => {
        const x = parseFloat($('hx').value), y = parseFloat($('hy').value), r = parseFloat($('hr').value);
        if (![x, y, r].every(isFinite)) return;
        pushUndo();
        Object.assign(h, { x, y, r });
        changed();
      };
      $('hx').onchange = apply; $('hy').onchange = apply; $('hr').onchange = apply;
      $('delHole').onclick = () => deleteHole(i);
    }

    const bc = sel.kind === 'edge' ? m.edgeBC[sel.idx] : sel.kind === 'hole' ? m.holes[sel.idx].bc : null;
    if (!bc) return;
    el.querySelectorAll('.bc-grid button').forEach((b) => {
      b.onclick = () => {
        pushUndo();
        bc.type = b.dataset.bc;
        if ((bc.type === 'force' || bc.type === 'bearing') && !bc.fx && !bc.fy) {
          if (bc.type === 'force') bc.fy = -1000; else bc.fx = 1000;
        }
        if (bc.type === 'pressure' && !bc.p) bc.p = 1;
        changed();
      };
    });
    const bind = (id, key) => {
      const inp = $(id);
      if (!inp) return;
      inp.onchange = () => {
        const v = parseFloat(inp.value);
        if (!isFinite(v)) return;
        pushUndo();
        bc[key] = v;
        changed();
      };
    };
    bind('bcFx', 'fx'); bind('bcFy', 'fy'); bind('bcP', 'p');
    const mag = $('bcMag'), ang = $('bcAng');
    if (mag && ang) {
      const applyPolar = () => {
        const M = parseFloat(mag.value), a = (parseFloat(ang.value) * Math.PI) / 180;
        if (!isFinite(M) || !isFinite(a)) return;
        pushUndo();
        bc.fx = round(M * Math.cos(a)); bc.fy = round(M * Math.sin(a));
        changed();
      };
      mag.onchange = applyPolar; ang.onchange = applyPolar;
    }
  }

  function bcFields(bc, kind) {
    if (bc.type === 'force' || bc.type === 'bearing') {
      const M = Math.hypot(bc.fx, bc.fy), a = (Math.atan2(bc.fy, bc.fx) * 180) / Math.PI;
      return `${numInput('bcFx', 'Force X', bc.fx, 'N')}${numInput('bcFy', 'Force Y', bc.fy, 'N')}
        ${numInput('bcMag', 'or magnitude', +M.toPrecision(6), 'N')}${numInput('bcAng', 'at angle', +a.toFixed(2), '°')}
        <p class="muted">${kind === 'hole' ? 'Total force a pin or bolt pushes on the hole, spread over the loaded side.' : 'Total force, spread evenly along the edge.'} Angle 0° = +X, 90° = +Y.</p>`;
    }
    if (bc.type === 'pressure') {
      return `${numInput('bcP', 'Pressure', bc.p, 'MPa')}
        <p class="muted">Positive pushes onto the surface; negative pulls it.</p>`;
    }
    if (bc.type === 'fixx') return '<p class="muted">Cannot move in X; free to slide in Y.</p>';
    if (bc.type === 'fixy') return '<p class="muted">Cannot move in Y; free to slide in X.</p>';
    if (bc.type === 'fixed') return '<p class="muted">Held in place in X and Y.</p>';
    return '<p class="muted">No support and no load.</p>';
  }

  // ---------------------------------------------------------------- edit operations
  function splitEdge(i) {
    const m = state.model, n = m.outline.length;
    const A = m.outline[i], B = m.outline[(i + 1) % n];
    pushUndo();
    m.outline.splice(i + 1, 0, { x: round((A.x + B.x) / 2), y: round((A.y + B.y) / 2) });
    const bc = m.edgeBC[i];
    if (bc.type === 'force') { bc.fx /= 2; bc.fy /= 2; }
    m.edgeBC.splice(i + 1, 0, clone(bc));
    state.selection = { kind: 'vertex', idx: i + 1 };
    changed();
  }

  function deleteVertex(i) {
    const m = state.model;
    if (m.outline.length <= 3) return;
    const before = snapshot();
    const outline = m.outline.filter((_, k) => k !== i);
    if (!S.isSimplePolygon(outline)) { toast('Removing that corner would make the outline cross itself.'); return; }
    state.undo.push(before); state.redo = []; updateUndoButtons();
    m.outline = outline;
    m.edgeBC.splice(i, 1);
    state.selection = null;
    changed();
  }

  function deleteHole(i) {
    pushUndo();
    state.model.holes.splice(i, 1);
    state.selection = null;
    changed();
  }

  function finishOutline() {
    const pts = state.draft.slice();
    state.draft = [];
    if (pts.length < 3) { toast('An outline needs at least 3 corners.'); draw(); return; }
    if (S.signedArea(pts) < 0) pts.reverse();
    if (!S.isSimplePolygon(pts)) { toast('The outline crosses itself. Try again.'); draw(); return; }
    pushUndo();
    const m = state.model;
    m.outline = pts;
    m.edgeBC = pts.map(() => S.makeBC('free'));
    const kept = m.holes.filter((h) => S.pointInPolygon(h.x, h.y, pts) && S.distToOutline(h.x, h.y, pts) > h.r * 1.02);
    if (kept.length < m.holes.length) toast('Holes outside the new outline were removed.');
    m.holes = kept;
    state.selection = null;
    setTool('select');
    fitView();
    changed();
    toast('Outline created. Click edges to add supports and loads.');
  }

  // ---------------------------------------------------------------- hit testing
  function hitTest(sx, sy) {
    const m = state.model;
    const tol = 8;
    for (let i = 0; i < m.outline.length; i++) {
      const [x, y] = toS(m.outline[i].x, m.outline[i].y);
      if (Math.hypot(sx - x, sy - y) <= tol) return { kind: 'vertex', idx: i };
    }
    for (let i = m.holes.length - 1; i >= 0; i--) {
      const h = m.holes[i]; const [x, y] = toS(h.x, h.y);
      const d = Math.hypot(sx - x, sy - y), r = h.r * state.view.scale;
      if (d <= r + tol) return { kind: 'hole', idx: i };
    }
    let best = null, bd = tol;
    const n = m.outline.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = toS(m.outline[i].x, m.outline[i].y), [bx, by] = toS(m.outline[(i + 1) % n].x, m.outline[(i + 1) % n].y);
      const d = S.distPointSegment(sx, sy, ax, ay, bx, by);
      if (d < bd) { bd = d; best = { kind: 'edge', idx: i }; }
    }
    return best;
  }

  function probeAt(sx, sy) {
    const el = $('probe');
    const r = currentResult();
    const P = state.lastP;
    if (!r || !P || state.tool !== 'select' || state.drag) { el.hidden = true; return; }
    const t = r.mesh.tris;
    for (let e = 0; e < r.mesh.triCount; e++) {
      const a = t[3 * e], b = t[3 * e + 1], c = t[3 * e + 2];
      const x1 = P[2 * a], y1 = P[2 * a + 1], x2 = P[2 * b], y2 = P[2 * b + 1], x3 = P[2 * c], y3 = P[2 * c + 1];
      const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((y2 - y3) * (sx - x3) + (x3 - x2) * (sy - y3)) / det;
      const l2 = ((y3 - y1) * (sx - x3) + (x1 - x3) * (sy - y3)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const elemMode = state.display.smooth === 'elem';
      const val = (k) => {
        if (elemMode && !k.startsWith('u')) return r.res.elem[k][e];
        const v = r.res.nodal[k];
        return l1 * v[a] + l2 * v[b] + l3 * v[c];
      };
      const nd = r.mesh.nodes;
      const wx = l1 * nd[2 * a] + l2 * nd[2 * b] + l3 * nd[2 * c], wy = l1 * nd[2 * a + 1] + l2 * nd[2 * b + 1] + l3 * nd[2 * c + 1];
      const rows = [['vm', 'Von Mises'], ['s1', 'σ₁'], ['s2', 'σ₂'], ['sx', 'σx'], ['sy', 'σy'], ['txy', 'τxy'], ['umag', '|u|']];
      el.innerHTML = `<table>
        <tr><td>Position</td><td>${fmt(wx)}, ${fmt(wy)} mm</td></tr>
        ${rows.map(([k, l]) => `<tr class="${k === state.display.field ? 'hl' : ''}"><td>${l}</td><td>${fmt(val(k))} ${FIELDS[k].unit}</td></tr>`).join('')}
      </table>`;
      el.hidden = false;
      const stage = $('stage').getBoundingClientRect();
      const pw = el.offsetWidth, ph = el.offsetHeight;
      let px = sx + 16, py = sy + 16;
      if (px + pw > stage.width - 8) px = sx - pw - 16;
      if (py + ph > stage.height - 8) py = sy - ph - 16;
      el.style.left = px + 'px'; el.style.top = py + 'px';
      return;
    }
    el.hidden = true;
  }

  function updateHint() {
    const h = $('hint');
    const c = state.cursor;
    const pos = c ? ` · x ${fmt(c.x)}, y ${fmt(c.y)} mm` : '';
    if (state.tool === 'outline')
      h.textContent = (state.draft.length ? 'Click to add corners; click the first corner or press Enter to finish; Esc cancels' : 'Click to place the first corner (snaps to the grid; hold Alt to disable)') + pos;
    else if (state.tool === 'hole') h.textContent = `Click to place a ${fmt(state.defaultHoleR)} mm hole, or drag to set its radius` + pos;
    else h.textContent = currentResult() ? 'Hover to read values · drag empty space to pan · scroll to zoom' : 'Click an edge or hole to set supports and loads · drag corners to reshape';
  }

  // ---------------------------------------------------------------- pointer input
  const evPos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const snapPt = (wx, wy, e) => {
    if (e.altKey) return { x: round(wx), y: round(wy) };
    const g = gridStep();
    return { x: round(snap(wx, g)), y: round(snap(wy, g)) };
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    const [sx, sy] = evPos(e);
    const [wx, wy] = toW(sx, sy);
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) { state.drag = { kind: 'pan', sx, sy, ox: state.view.ox, oy: state.view.oy }; return; }
    if (e.button !== 0) return;

    if (state.tool === 'outline') {
      const p = snapPt(wx, wy, e);
      if (state.draft.length >= 3) {
        const [fx, fy] = toS(state.draft[0].x, state.draft[0].y);
        if (Math.hypot(sx - fx, sy - fy) < 10) { finishOutline(); return; }
      }
      const last = state.draft[state.draft.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) state.draft.push(p);
      draw(); updateHint();
      return;
    }
    if (state.tool === 'hole') {
      const p = snapPt(wx, wy, e);
      state.holeDraft = { x: p.x, y: p.y, r: 0 };
      draw();
      return;
    }
    const hit = hitTest(sx, sy);
    state.selection = hit;
    if (hit && hit.kind === 'vertex') {
      const p = state.model.outline[hit.idx];
      state.drag = { kind: 'vertex', idx: hit.idx, before: snapshot(), orig: { x: p.x, y: p.y }, moved: false };
    } else if (hit && hit.kind === 'hole') {
      const h = state.model.holes[hit.idx];
      state.drag = { kind: 'hole', idx: hit.idx, before: snapshot(), dx: h.x - wx, dy: h.y - wy, orig: { x: h.x, y: h.y }, moved: false, sx, sy };
    } else if (!hit) {
      state.drag = { kind: 'pan', sx, sy, ox: state.view.ox, oy: state.view.oy };
    }
    renderInspector();
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = evPos(e);
    const [wx, wy] = toW(sx, sy);
    const d = state.drag;
    if (state.tool !== 'select') state.cursor = snapPt(wx, wy, e);
    else state.cursor = { x: wx, y: wy };

    if (d && d.kind === 'pan') {
      state.view.ox = d.ox + (sx - d.sx);
      state.view.oy = d.oy + (sy - d.sy);
      draw();
      return;
    }
    if (d && d.kind === 'vertex') {
      const p = snapPt(wx, wy, e);
      const v = state.model.outline[d.idx];
      if (v.x !== p.x || v.y !== p.y) {
        v.x = p.x; v.y = p.y; d.moved = true;
        state.version++;
        draw();
      }
      return;
    }
    if (d && d.kind === 'hole') {
      if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return;
      const p = snapPt(wx + d.dx, wy + d.dy, e);
      const h = state.model.holes[d.idx];
      if (h.x !== p.x || h.y !== p.y) { h.x = p.x; h.y = p.y; d.moved = true; state.version++; draw(); }
      return;
    }
    if (state.holeDraft) {
      const hd = state.holeDraft;
      const r = Math.hypot(wx - hd.x, wy - hd.y);
      const g = gridStep() / 2;
      hd.r = e.altKey ? round(r) : Math.max(0, round(snap(r, g)));
      draw();
      return;
    }
    if (state.tool === 'select') {
      const hov = hitTest(sx, sy);
      const same = (a, b) => (a && b && a.kind === b.kind && a.idx === b.idx) || (!a && !b);
      if (!same(hov, state.hover)) { state.hover = hov; draw(); }
      canvas.style.cursor = hov ? (hov.kind === 'edge' ? 'pointer' : 'move') : 'default';
      probeAt(sx, sy);
    } else {
      canvas.style.cursor = 'crosshair';
      draw();
    }
    updateHint();
  });

  canvas.addEventListener('pointerup', (e) => {
    const d = state.drag;
    state.drag = null;
    if (d && d.kind === 'vertex' && d.moved) {
      if (!S.isSimplePolygon(state.model.outline)) {
        Object.assign(state.model.outline[d.idx], d.orig);
        toast('That would make the outline cross itself, so the corner was put back.');
        changed();
        return;
      }
      state.undo.push(d.before); state.redo = []; updateUndoButtons();
      changed();
      return;
    }
    if (d && d.kind === 'hole' && d.moved) {
      state.undo.push(d.before); state.redo = []; updateUndoButtons();
      changed();
      return;
    }
    if (state.holeDraft) {
      const hd = state.holeDraft;
      state.holeDraft = null;
      const r = hd.r > 0 ? hd.r : state.defaultHoleR;
      const m = state.model;
      const ok = S.pointInPolygon(hd.x, hd.y, m.outline) && S.distToOutline(hd.x, hd.y, m.outline) > r * 1.02 &&
        m.holes.every((h) => Math.hypot(h.x - hd.x, h.y - hd.y) > (h.r + r) * 1.02);
      if (!ok) { toast('A hole must sit fully inside the part without touching an edge or another hole.'); draw(); return; }
      pushUndo();
      if (hd.r > 0) state.defaultHoleR = hd.r;
      m.holes.push({ x: hd.x, y: hd.y, r, bc: S.makeBC('free') });
      state.selection = { kind: 'hole', idx: m.holes.length - 1 };
      setTool('select');
      changed();
    }
  });

  canvas.addEventListener('pointerleave', () => {
    $('probe').hidden = true;
    state.cursor = null;
    if (state.hover) { state.hover = null; draw(); }
    updateHint();
  });

  canvas.addEventListener('dblclick', (e) => {
    if (state.tool === 'outline' && state.draft.length >= 3) {
      e.preventDefault();
      // the double-click's first click already added a point at the same spot
      finishOutline();
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = evPos(e);
    zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (e.key === 'Escape') {
      if (state.draft.length) state.draft = [];
      else if (state.tool !== 'select') setTool('select');
      else state.selection = null;
      renderInspector(); draw(); updateHint();
    } else if (e.key === 'Enter' && state.tool === 'outline') finishOutline();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) {
      if (state.selection.kind === 'vertex') deleteVertex(state.selection.idx);
      else if (state.selection.kind === 'hole') deleteHole(state.selection.idx);
    } else if (e.key === 'f' || e.key === 'F') fitView();
    else if (e.key === 'v' || e.key === 'V') setTool('select');
    else if (e.key === 'o' || e.key === 'O') setTool('outline');
    else if (e.key === 'h' || e.key === 'H') setTool('hole');
  });

  // ---------------------------------------------------------------- toolbar & panels
  function setTool(t) {
    state.tool = t;
    state.draft = [];
    state.holeDraft = null;
    state.hover = null;
    $('probe').hidden = true;
    document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    updateHint();
    draw();
  }
  document.querySelectorAll('#tools button').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  const presetSel = $('preset');
  presetSel.innerHTML = Object.entries(S.PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  presetSel.onchange = () => { pushUndo(); loadPreset(presetSel.value); };

  // material
  const matSel = $('matPreset');
  matSel.innerHTML = Object.entries(S.MATERIALS).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('');
  function syncMaterialUI() {
    const m = state.model.material;
    matSel.value = S.MATERIALS[m.name] ? m.name : 'custom';
    $('matE').value = m.E; $('matNu').value = m.nu; $('matYield').value = m.yield; $('matT').value = m.t;
    document.querySelectorAll('#matMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m.mode));
  }
  matSel.onchange = () => {
    const p = S.MATERIALS[matSel.value];
    pushUndo();
    state.model.material.name = matSel.value;
    if (p.E) Object.assign(state.model.material, { E: p.E, nu: p.nu, yield: p.yield });
    syncMaterialUI();
    changed();
  };
  [['matE', 'E'], ['matNu', 'nu'], ['matYield', 'yield'], ['matT', 't']].forEach(([id, key]) => {
    $(id).onchange = () => {
      const v = parseFloat($(id).value);
      if (!isFinite(v)) { syncMaterialUI(); return; }
      pushUndo();
      state.model.material[key] = v;
      if (key !== 't') state.model.material.name = 'custom';
      syncMaterialUI();
      changed();
    };
  });
  document.querySelectorAll('#matMode button').forEach((b) => (b.onclick = () => {
    pushUndo();
    state.model.material.mode = b.dataset.mode;
    syncMaterialUI();
    changed();
  }));

  $('meshDensity').onchange = () => { state.density = $('meshDensity').value; changed(); };

  // display
  $('field').onchange = () => { state.display.field = $('field').value; draw(); };
  $('bands').oninput = () => { state.display.bands = +$('bands').value; $('bandsVal').textContent = state.display.bands; draw(); };
  function deformLabel() {
    const r = currentResult();
    const f = deformFactor(r);
    $('deformVal').textContent = state.display.deform <= 0 ? 'off' : r ? `×${fmt(f, 2)}` : 'auto';
  }
  $('deform').oninput = () => { state.display.deform = +$('deform').value; deformLabel(); draw(); };
  document.querySelectorAll('#smooth button').forEach((b) => (b.onclick = () => {
    state.display.smooth = b.dataset.smooth;
    document.querySelectorAll('#smooth button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  }));
  $('showMesh').onchange = () => { state.display.showMesh = $('showMesh').checked; draw(); };
  $('showUndeformed').onchange = () => { state.display.showUndeformed = $('showUndeformed').checked; draw(); };
  $('showBC').onchange = () => { state.display.showBC = $('showBC').checked; draw(); };
  $('autoSolve').onchange = () => { state.autoSolve = $('autoSolve').checked; if (state.autoSolve) solve(true); };
  $('solve').onclick = () => solve(false);
  $('undo').onclick = undo;
  $('redo').onclick = redo;
  $('fit').onclick = fitView;
  $('zoomIn').onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); };
  $('zoomOut').onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); };

  // file actions
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  $('save').onclick = () => {
    const data = { app: 'Stress2D', version: 1, model: JSON.parse(snapshot()), density: state.density };
    download('part.stress2d.json', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  };
  $('open').onclick = () => $('openFile').click();
  $('openFile').onchange = async () => {
    const file = $('openFile').files[0];
    $('openFile').value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const m = data.model || data;
      if (!Array.isArray(m.outline) || !Array.isArray(m.edgeBC) || m.outline.length !== m.edgeBC.length) throw new Error('bad file');
      pushUndo();
      state.model = {
        outline: m.outline.map((p) => ({ x: +p.x, y: +p.y })),
        edgeBC: m.edgeBC.map((b) => S.makeBC(b.type, { fx: +b.fx || 0, fy: +b.fy || 0, p: +b.p || 0 })),
        holes: (m.holes || []).map((h) => ({ x: +h.x, y: +h.y, r: +h.r, bc: S.makeBC(h.bc.type, { fx: +h.bc.fx || 0, fy: +h.bc.fy || 0, p: +h.bc.p || 0 }) })),
        material: Object.assign(S.defaultMaterial(), m.material || {}),
      };
      if (data.density) { state.density = data.density; $('meshDensity').value = data.density; }
      state.selection = null;
      syncMaterialUI();
      fitView();
      changed();
    } catch (err) {
      toast('That file is not a Stress2D model.');
    }
  };
  $('png').onclick = () => {
    // composite the canvas with the colour legend
    const dpr = window.devicePixelRatio || 1;
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    const o = out.getContext('2d');
    o.fillStyle = getComputedStyle($('stage')).backgroundColor;
    o.fillRect(0, 0, out.width, out.height);
    o.drawImage(canvas, 0, 0);
    const r = currentResult();
    if (r && !$('legend').hidden) {
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      const fd = FIELDS[state.display.field];
      const swatches = [...$('legend').querySelectorAll('.swatches div')].map((d) => d.style.background);
      const ticks = [...$('legend').querySelectorAll('.ticks span')].map((s) => [parseFloat(s.style.bottom) / 100, s.textContent]);
      const W = canvas.clientWidth, H = Math.min(260, Math.max(140, swatches.length * 16));
      const x0 = W - 120, y0 = 40;
      o.fillStyle = 'rgba(22,26,32,0.9)'; o.fillRect(x0 - 12, y0 - 30, 118, H + 46);
      o.fillStyle = '#e6e9ee'; o.font = '600 12px system-ui'; o.textBaseline = 'alphabetic'; o.textAlign = 'left';
      o.fillText(`${fd.label.replace(' stress', '')} (${fd.unit})`, x0 - 4, y0 - 12);
      const bh = H / swatches.length;
      swatches.forEach((c, k) => { o.fillStyle = c; o.fillRect(x0, y0 + H - (k + 1) * bh, 16, bh + 0.5); });
      o.font = '11px system-ui'; o.fillStyle = '#e6e9ee'; o.textBaseline = 'middle';
      ticks.forEach(([t, s]) => o.fillText(s, x0 + 24, y0 + H - t * H));
    }
    out.toBlob((b) => download('stress2d.png', b), 'image/png');
  };

  // ---------------------------------------------------------------- boot
  new ResizeObserver(resize).observe($('stage'));
  state.model = { material: S.defaultMaterial() };
  loadPreset('plateHole');
  syncMaterialUI();
  updateUndoButtons();
  updateHint();
  resize();
  fitView();
})();
