// Colour modes, expressed as 3D Tiles styles.
//
// Styling runs on the GPU from the per-point batch table we encode, so switching
// mode is just swapping `tileset.style` — no tile is refetched, as long as the
// mode's attribute was requested when the cloud was created.

import { Cesium3DTileStyle } from 'cesium';

export type COPCColorMode = 'rgb' | 'classification' | 'intensity' | 'elevation';

/** The per-point attribute each mode needs in the tiles. */
export const COLOR_MODE_ATTRIBUTE = {
  rgb: null,
  classification: 'classification',
  intensity: 'intensity',
  elevation: 'height',
} as const;

/** ASPRS standard classification codes (LAS 1.4, table 17). */
const CLASSIFICATION_COLORS: [number, string][] = [
  [1, '#b0b0b0'], // unclassified
  [2, '#a0724f'], // ground
  [3, '#8fbf6a'], // low vegetation
  [4, '#5da34d'], // medium vegetation
  [5, '#2f7a34'], // high vegetation
  [6, '#e05c4a'], // building
  [7, '#ff2fa0'], // low point (noise)
  [9, '#3a7fd5'], // water
  [10, '#9b6bd0'], // rail
  [11, '#4a4a4a'], // road surface
  [13, '#e8d44d'], // wire — guard
  [14, '#e8a33d'], // wire — conductor
  [15, '#c08a5a'], // transmission tower
  [16, '#d4c26a'], // wire-structure connector
  [17, '#7fd4d4'], // bridge deck
  [18, '#ff2fa0'], // high noise
];

/** Linear interpolation between colour stops, clamped to [0,1]. */
function ramp(value: string, min: number, max: number, stops: string[]): string {
  const span = max - min || 1;
  const t = `clamp((${value} - ${min}) / ${span}, 0.0, 1.0)`;
  // Fold the stop list into nested ternaries, so the ramp is one continuous GPU
  // expression rather than a banded condition list.
  const segments = stops.length - 1;
  const segment = (i: number) =>
    `mix(color('${stops[i]}'), color('${stops[i + 1]}'), clamp((${t} - ${i / segments}) * ${segments}, 0.0, 1.0))`;
  let expression = segment(segments - 1);
  for (let i = segments - 2; i >= 0; i--) {
    expression = `${t} < ${(i + 1) / segments} ? ${segment(i)} : ${expression}`;
  }
  return expression;
}

export interface COPCStyleRanges {
  heightRange?: [number, number] | null;
  intensityRange?: [number, number] | null;
}

/**
 * Build the style for a colour mode, or `undefined` for `rgb` — which needs no
 * style at all, since `pnts` RGB is already the point colour.
 */
export function buildColorStyle(
  mode: COPCColorMode,
  ranges: COPCStyleRanges = {},
): Cesium3DTileStyle | undefined {
  if (mode === 'rgb') return undefined;

  if (mode === 'classification') {
    return new Cesium3DTileStyle({
      color: {
        conditions: [
          ...CLASSIFICATION_COLORS.map(
            ([code, hex]) => [`\${Classification} === ${code}`, `color('${hex}')`] as [string, string],
          ),
          ['true', "color('#d0d0d0')"],
        ],
      },
    });
  }

  if (mode === 'intensity') {
    const [min, max] = ranges.intensityRange ?? [0, 65535];
    return new Cesium3DTileStyle({
      color: ramp('${Intensity}', min, max, ['#101010', '#8a8a8a', '#ffffff']),
    });
  }

  const [min, max] = ranges.heightRange ?? [0, 1];
  return new Cesium3DTileStyle({
    // Blue -> cyan -> green -> yellow -> red, the usual elevation ramp.
    color: ramp('${Height}', min, max, ['#2c50a8', '#25a8b0', '#5fbf4a', '#f2d44a', '#d13d2f']),
  });
}
