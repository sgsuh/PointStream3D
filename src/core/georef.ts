import proj4 from 'proj4';
import { extractHorizontalWkt, verticalMetreFactor } from './wkt';
import { geodeticToEcef, type Vec3 } from './ecef';

export type ToEcefArr = (x: number, y: number, z: number) => Vec3;

/**
 * Reproject source-CRS coordinates to ECEF, returning a plain [x,y,z] array.
 * Cesium-free counterpart of reproject.ts, usable inside a Service Worker.
 */
export function makeToEcefArr(wkt: string | undefined): ToEcefArr {
  if (!wkt) {
    // No CRS info: assume the data is already lon/lat/height.
    return (x, y, z) => geodeticToEcef(x, y, z);
  }
  const toWgs84 = proj4(extractHorizontalWkt(wkt), 'EPSG:4326');
  const zFactor = verticalMetreFactor(wkt);
  return (x, y, z) => {
    const [lon, lat] = toWgs84.forward([x, y]);
    return geodeticToEcef(lon, lat, z * zFactor);
  };
}

/**
 * Ground metres spanned by one source-CRS unit, measured through the actual
 * reprojection at the centre of `cube` ([minx,miny,minz,maxx,maxy,maxz]).
 *
 * COPC `spacing` and the octree cube are in source units, but 3D Tiles
 * `geometricError` is defined in metres — and Cesium uses it for both LOD
 * selection and point-attenuation size, so the unit error shows up twice.
 * Measuring rather than parsing the WKT unit also absorbs projection scale
 * distortion (Web Mercator's scale factor grows as 1/cos(lat)) and covers
 * geographic CRSs, where the "unit" is a degree.
 */
export function metresPerSourceUnit(toEcef: ToEcefArr, cube: number[]): number {
  const cx = (cube[0] + cube[3]) / 2;
  const cy = (cube[1] + cube[4]) / 2;
  const cz = (cube[2] + cube[5]) / 2;
  // A small step relative to the cube keeps the probe inside the projection's
  // valid domain whatever the units are (metres, feet, or degrees).
  const d = Math.max((cube[3] - cube[0]) / 1000, Number.EPSILON);
  const o = toEcef(cx, cy, cz);
  const spanFrom = (p: Vec3) => Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]) / d;
  // Geometric mean of the two horizontal axes: projections may scale them
  // differently, and spacing describes an area-like point density.
  const s = Math.sqrt(spanFrom(toEcef(cx + d, cy, cz)) * spanFrom(toEcef(cx, cy + d, cz)));
  return Number.isFinite(s) && s > 0 ? s : 1;
}
