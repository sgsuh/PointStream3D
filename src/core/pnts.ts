// Encode points into a 3D Tiles 1.0 `pnts` tile with an RTC_CENTER, so the
// GPU-side float32 positions stay small and precise. Cesium's Cesium3DTileset
// transcodes `pnts` to a glTF POINTS primitive and applies point-cloud shading
// (EDL, attenuation) for free — that engine reuse is the whole point of this path.
//
// Optional per-point properties ride along in the Batch Table. With no BATCH_ID
// in the feature table, a `pnts` Batch Table is indexed by point, which is
// exactly what Cesium's styling language reads as `${Intensity}` and friends.

const MAGIC = 0x73746e70; // 'pnts' little-endian

/** Typed arrays we emit as batch-table properties, one value per point. */
export type BatchArray = Float32Array | Uint16Array | Uint8Array;

const COMPONENT_TYPE = new Map<Function, string>([
  [Float32Array, 'FLOAT'],
  [Uint16Array, 'UNSIGNED_SHORT'],
  [Uint8Array, 'UNSIGNED_BYTE'],
]);

/** Pad `length` up to the next multiple of 8. */
const align8 = (length: number) => (length + 7) & ~7;

/**
 * @param ecef   absolute ECEF positions, xyz triples (metres), length n*3
 * @param colors optional RGB triples 0-255, length n*3
 * @param rtc    RTC_CENTER in ECEF (typically the node centroid)
 * @param batch  optional per-point properties, each of length n
 */
export function encodePnts(
  ecef: Float64Array,
  colors: Uint8Array | undefined,
  rtc: [number, number, number],
  batch?: Record<string, BatchArray>,
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

  const featureTable: Record<string, unknown> = {
    POINTS_LENGTH: n,
    RTC_CENTER: rtc,
    POSITION: { byteOffset: 0 },
  };
  if (colors) featureTable.RGB = { byteOffset: posBytes };

  // Lay the batch-table properties out widest-first so every byteOffset stays a
  // multiple of its own component size — a Uint16Array view on an odd offset
  // would throw.
  const entries = Object.entries(batch ?? {})
    .filter(([, a]) => a.length > 0)
    .sort((a, b) => b[1].BYTES_PER_ELEMENT - a[1].BYTES_PER_ELEMENT);
  const batchTable: Record<string, unknown> = {};
  const placed: { array: BatchArray; byteOffset: number }[] = [];
  let batchBinaryLength = 0;
  for (const [name, array] of entries) {
    const componentType = COMPONENT_TYPE.get(array.constructor);
    if (!componentType) throw new Error(`Unsupported batch-table array for "${name}"`);
    batchTable[name] = { byteOffset: batchBinaryLength, componentType, type: 'SCALAR' };
    placed.push({ array, byteOffset: batchBinaryLength });
    batchBinaryLength += array.byteLength;
  }

  // Both binary bodies must start 8-byte aligned from the start of the tile, so
  // pad the JSON that precedes each of them with spaces.
  const encoder = new TextEncoder();
  const padJson = (value: Record<string, unknown>, startOffset: number): Uint8Array => {
    let json = JSON.stringify(value);
    while ((startOffset + json.length) % 8 !== 0) json += ' ';
    return encoder.encode(json);
  };

  const featureJson = padJson(featureTable, 28);
  const featureBinaryLength = align8(posBytes + rgbBytes);
  const batchJson = placed.length
    ? padJson(batchTable, 28 + featureJson.length + featureBinaryLength)
    : new Uint8Array(0);

  const featureBinaryStart = 28 + featureJson.length;
  const batchJsonStart = featureBinaryStart + featureBinaryLength;
  const batchBinaryStart = batchJsonStart + batchJson.length;
  const total = align8(batchBinaryStart + batchBinaryLength);

  const buffer = new ArrayBuffer(total);
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 1, true); // version
  dv.setUint32(8, total, true); // byteLength
  dv.setUint32(12, featureJson.length, true); // featureTableJSONByteLength
  dv.setUint32(16, featureBinaryLength, true); // featureTableBinaryByteLength
  dv.setUint32(20, batchJson.length, true); // batchTableJSONByteLength
  dv.setUint32(24, batchBinaryLength, true); // batchTableBinaryByteLength

  u8.set(featureJson, 28);
  u8.set(new Uint8Array(positions.buffer), featureBinaryStart);
  if (colors) u8.set(colors.subarray(0, rgbBytes), featureBinaryStart + posBytes);
  if (batchJson.length) u8.set(batchJson, batchJsonStart);
  for (const { array, byteOffset } of placed) {
    u8.set(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      batchBinaryStart + byteOffset,
    );
  }

  return buffer;
}
