// WGS84 geodetic (lon/lat in degrees, height in metres) -> ECEF (metres).
// Cesium-free so it runs in a Service Worker too.
const A = 6378137.0; // semi-major axis
const F = 1 / 298.257223563; // flattening
const E2 = F * (2 - F); // first eccentricity squared
const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

export function geodeticToEcef(lonDeg: number, latDeg: number, h: number): Vec3 {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (n + h) * cosLat * Math.cos(lon),
    (n + h) * cosLat * Math.sin(lon),
    (n * (1 - E2) + h) * sinLat,
  ];
}
