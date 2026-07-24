import proj4 from 'proj4';
import { Cartesian3 } from 'cesium';
import { extractHorizontalWkt, verticalMetreFactor } from './wkt';

export type ToEcef = (x: number, y: number, z: number) => Cartesian3;

/**
 * Build a reprojection function from the COPC source CRS (WKT) to Cesium ECEF.
 * copc.js exposes the CRS only as a WKT string and does no reprojection itself,
 * so this is entirely on us — the single biggest step for globe integration.
 */
export function makeToEcef(wkt: string | undefined): ToEcef {
  if (!wkt) {
    // No CRS info: assume the data is already lon/lat/height in degrees/metres.
    return (x, y, z) => Cartesian3.fromDegrees(x, y, z);
  }
  const toWgs84 = proj4(extractHorizontalWkt(wkt), 'EPSG:4326');
  const zFactor = verticalMetreFactor(wkt);
  return (x, y, z) => {
    const [lon, lat] = toWgs84.forward([x, y]);
    return Cartesian3.fromDegrees(lon, lat, z * zFactor);
  };
}
