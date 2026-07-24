// Encode points into a 3D Tiles 1.0 `pnts` tile with an RTC_CENTER, so the
// GPU-side float32 positions stay small and precise. Cesium's Cesium3DTileset
// transcodes `pnts` to a glTF POINTS primitive and applies point-cloud shading
// (EDL, attenuation) for free — that engine reuse is the whole point of this path.

const MAGIC = 0x73746e70; // 'pnts' little-endian

/**
 * @param ecef   absolute ECEF positions, xyz triples (metres), length n*3
 * @param colors optional RGB triples 0-255, length n*3
 * @param rtc    RTC_CENTER in ECEF (typically the node centroid)
 */
export function encodePnts(
  ecef: Float64Array,
  colors: Uint8Array | undefined,
  rtc: [number, number, number],
): ArrayBuffer {
  const n = ecef.length / 3;

  // Feature-table binary: POSITION (float32 xyz, relative to RTC), then RGB (uint8).
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = ecef[i * 3] - rtc[0];
    positions[i * 3 + 1] = ecef[i * 3 + 1] - rtc[1];
    positions[i * 3 + 2] = ecef[i * 3 + 2] - rtc[2];
  }
  const posBytes = positions.byteLength;
  const rgbBytes = colors ? n * 3 : 0;
  const ftBinaryLength = posBytes + rgbBytes;

  const featureTable: Record<string, unknown> = {
    POINTS_LENGTH: n,
    RTC_CENTER: rtc,
    POSITION: { byteOffset: 0 },
  };
  if (colors) featureTable.RGB = { byteOffset: posBytes };

  // JSON is padded with spaces so the binary body starts 8-byte aligned
  // (28-byte header + JSON length must be a multiple of 8).
  let json = JSON.stringify(featureTable);
  while ((28 + json.length) % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);

  const total = 28 + jsonBytes.length + ftBinaryLength;
  const buffer = new ArrayBuffer(total);
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true); // version
  dv.setUint32(8, total, true); // byteLength
  dv.setUint32(12, jsonBytes.length, true); // featureTableJSONByteLength
  dv.setUint32(16, ftBinaryLength, true); // featureTableBinaryByteLength
  dv.setUint32(20, 0, true); // batchTableJSONByteLength
  dv.setUint32(24, 0, true); // batchTableBinaryByteLength

  u8.set(jsonBytes, 28);
  const binOffset = 28 + jsonBytes.length;
  u8.set(new Uint8Array(positions.buffer), binOffset);
  if (colors) u8.set(colors.subarray(0, rgbBytes), binOffset + posBytes);

  return buffer;
}
