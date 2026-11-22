# Stress2D

A browser app that calculates and shows stress in a flat (2D) part with linear-elastic finite element analysis.
It has no dependencies and no build step: open `index.html` in a browser, or serve the folder.

## Using it

1. **Shape**: pick a preset part, drag corners, or use **Draw outline** (click corners; click the first corner or press Enter to close) and **Add hole** (click, or drag to set the radius). Select a corner or hole to type exact coordinates; **Split edge** adds a corner.
2. **Supports**: click an edge or hole and choose *Fixed*, *Fix X* or *Fix Y*.
3. **Loads**: click an edge and add a *Force* (total N, spread along the edge) or *Pressure* (MPa). On a hole, *Pin load* models a bolt or pin bearing on one side.
4. **Material**: pick a preset or enter E, ν, yield strength and thickness, then choose plane stress (thin plate) or plane strain (thick body).
5. **Solve**. With Auto-solve on, it re-solves after every change. Hover the part to read stresses at any point.

Units: mm, N, MPa. Shortcuts: `V` select, `O` draw outline, `H` add hole, `F` fit view, `Del` delete, `Ctrl+Z` / `Ctrl+Y` undo and redo, scroll to zoom, right-drag or drag empty space to pan.

## How it works

| File | Role |
|---|---|
| `js/geometry.js` | Polygon helpers, model validation, preset parts and materials |
| `js/mesh.js` | Mesh generator: boundary nodes with refinement near holes, graded rings, a hex lattice, Delaunay triangulation |
| `js/fem.js` | Constant-strain triangle stiffness, RCM reordering, skyline Cholesky solver, stress recovery (least-squares patch fit) |
| `js/render.js` | Colour maps, banded contour plotting, support and load symbols |
| `js/app.js` | UI state, editing tools, undo, results panel, save, open and PNG export |

Checks against hand calculations: uniform tension is exact, cantilever tip deflection converges to within about 1% of beam theory with shear, plate-with-hole peak stress is within about 3% of Peterson's chart on a fine mesh, and support reactions always balance the applied loads.

## Limits

- Linear elastic, small deflection, isotropic material, no contact or buckling.
- Stresses at sharp inside corners and at the ends of fixed edges are theoretical singularities: they keep growing as the mesh is refined. Judge the part away from those points, or add a fillet (split the edges near the corner and move the new corners to round it off).
