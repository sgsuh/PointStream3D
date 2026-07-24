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
