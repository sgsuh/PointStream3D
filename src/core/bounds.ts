// Bounding volumes for the generated 3D Tiles.
//
// A COPC octree node's extent is a *cube* — equal in X, Y and Z — while real
// LiDAR is usually a thin slab (autzen: 3426 x 4656 x 209 source units, so the
// cube over-covers the data by ~30x in volume). Handing Cesium that cube hurts
// twice: frustum culling keeps tiles whose points are nowhere near the view, and
// screen-space error is computed from the distance to the bounding volume — a
// volume the camera is *inside* yields distance 0 and therefore infinite SSE,
// forcing maximum refinement. So we clamp each node to the file's real extent
// and emit an oriented box rather than a sphere.

import type { ToEcefArr } from './georef';

// WGS84 axes, matching ecef.ts.
const A = 6378137.0;
const B = 6356752.314245179;

type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Intersect a node cube with the file's actual data extent, both as
 * [minx,miny,minz,maxx,maxy,maxz] in the source CRS.
 *
 * Nodes near the edge of the octree cube can end up with no overlap in a given
 * axis; there we keep the node's own extent rather than emitting an inverted
 * box, and any exactly-flat axis is given a sliver so the volume stays valid.
 */
export function clampToData(cube: number[], dataMin: number[], dataMax: number[]): number[] {
  const out = cube.slice();
  for (let i = 0; i < 3; i++) {
    const lo = Math.max(cube[i], dataMin[i]);
    const hi = Math.min(cube[i + 3], dataMax[i]);
    if (hi > lo) {
      out[i] = lo;
      out[i + 3] = hi;
    }
    if (out[i + 3] <= out[i]) {
      const eps = Math.max((cube[i + 3] - cube[i]) * 1e-6, Number.MIN_VALUE);
      const mid = (out[i] + out[i + 3]) / 2;
      out[i] = mid - eps;
      out[i + 3] = mid + eps;
    }
  }
  return out;
}

/**
 * Build a 3D Tiles oriented `box` — [center, xHalfAxis, yHalfAxis, zHalfAxis],
 * 12 numbers in ECEF — that tightly encloses a source-CRS AABB.
 *
 * The AABB is axis-aligned on the map grid, which is a rotated, slightly curved
 * frame once projected to ECEF, so we measure the corners in the local
 * east/north/up basis and take the extent along each axis.
 */
export function orientedBox(aabb: number[], toEcef: ToEcefArr): number[] {
  const c = toEcef((aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2);

  // East/north/up at the centre. `up` is the geodetic surface normal; (-y, x, 0)
  // is exactly perpendicular to it, so the basis is orthonormal by construction.
  const up = normalize([c[0] / (A * A), c[1] / (A * A), c[2] / (B * B)]);
  const horiz = Math.hypot(c[0], c[1]);
  const east: Vec3 = horiz > 1e-9 ? [-c[1] / horiz, c[0] / horiz, 0] : [1, 0, 0];
  const north = cross(up, east);
  const axes: Vec3[] = [east, north, up];

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const x of [aabb[0], aabb[3]]) {
    for (const y of [aabb[1], aabb[4]]) {
      for (const z of [aabb[2], aabb[5]]) {
        const p = toEcef(x, y, z);
        const v: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        for (let k = 0; k < 3; k++) {
          const t = dot(v, axes[k]);
          if (t < lo[k]) lo[k] = t;
          if (t > hi[k]) hi[k] = t;
        }
      }
    }
  }

  // The corners sit on a curved surface, so the middle of the tile bulges above
  // the plane through them. Negligible for a small tile, ~200 m for a 100 km
  // one — enough to clip content if ignored.
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  hi[2] += (span * span) / (8 * A);

  const box = new Array<number>(12);
  box[0] = c[0];
  box[1] = c[1];
  box[2] = c[2];
  for (let k = 0; k < 3; k++) {
    const half = (hi[k] - lo[k]) / 2;
    const offset = (hi[k] + lo[k]) / 2; // corners need not straddle the centre
    for (let i = 0; i < 3; i++) {
      box[i] += axes[k][i] * offset;
      box[3 + k * 3 + i] = axes[k][i] * half;
    }
  }
  return box;
}
