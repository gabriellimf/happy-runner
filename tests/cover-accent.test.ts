import { describe, expect, it } from "vitest";

import type { Accent } from "../lib/cover-accent";
import {
  buildAccent,
  hexContrastRatio,
  hexRelativeLuminance,
  pickAccent,
} from "../lib/cover-accent";

const SATURATIONS = [0.5, 0.6, 0.7, 0.8];
const MID_SATURATIONS = [0.55, 0.63, 0.79];
const FRACTIONAL_HUES = [0.5, 12.7, 179.2, 240.25, 359.4];
const HEX = /^#[0-9a-f]{6}$/;
const SURFACE_3 = "#26262c";
const ON_ACCENT = "#0a0a0b";
const INK = "#f4f4f5";
const INK_2 = "#b4b4be";
const ZINC_400 = "#a1a1aa";
const FALLBACK_BLEED = "#2b1b6b";

function fillRgba(
  r: number,
  g: number,
  b: number,
  a = 255,
  count = 576,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4);

  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = a;
  }

  return data;
}

function hueToRgb(p: number, q: number, t: number): number {
  let tone = t;

  if (tone < 0) {
    tone += 1;
  }

  if (tone > 1) {
    tone -= 1;
  }

  if (tone < 1 / 6) {
    return p + (q - p) * 6 * tone;
  }

  if (tone < 1 / 2) {
    return q;
  }

  if (tone < 2 / 3) {
    return p + (q - p) * (2 / 3 - tone) * 6;
  }

  return p;
}

function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;

  if (s === 0) {
    const channel = Math.round(l * 255);
    return [channel, channel, channel];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return [
    Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, hue) * 255),
    Math.round(hueToRgb(p, q, hue - 1 / 3) * 255),
  ];
}

function fillHues(hues: number[], s = 0.8, l = 0.5): Uint8ClampedArray {
  const data = new Uint8ClampedArray(hues.length * 4);

  for (let i = 0; i < hues.length; i += 1) {
    const [r, g, b] = hslRgb(hues[i] ?? 0, s, l);
    const offset = i * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  }

  return data;
}

function expectValidHex(value: string, label: string) {
  expect(value, label).toMatch(HEX);
  expect(value, label).not.toContain("nan");
}

function expectAccentHex(result: Accent, label: string) {
  expectValidHex(result.accent, `${label} accent`);
  expectValidHex(result.bleed, `${label} bleed`);
  expectValidHex(result.bleed2, `${label} bleed2`);
}

function expectAccentContrast(result: Accent, label: string) {
  expectAccentHex(result, label);
  expect(
    hexContrastRatio(result.accent, SURFACE_3),
    `${label} accent on surface-3`,
  ).toBeGreaterThanOrEqual(5.01);
  expect(
    hexContrastRatio(ON_ACCENT, result.accent),
    `${label} on-accent over accent`,
  ).toBeGreaterThanOrEqual(6.6);
  expect(
    hexContrastRatio(INK, result.bleed),
    `${label} ink over bleed`,
  ).toBeGreaterThanOrEqual(10.61);
  expect(
    hexContrastRatio(INK_2, result.bleed),
    `${label} ink-2 over bleed`,
  ).toBeGreaterThanOrEqual(5.67);
  expect(
    hexContrastRatio(ZINC_400, result.bleed),
    `${label} zinc-400 over bleed`,
  ).toBeGreaterThanOrEqual(4.55);
}

describe("buildAccent contrast sweep", () => {
  it("keeps accent relative luminance at least 0.30 for every hue and clamped sat", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      for (const sat of SATURATIONS) {
        const { accent } = buildAccent(hue, sat);
        const y = hexRelativeLuminance(accent);

        expect(y, `accent Y at hue ${hue} sat ${sat}`).toBeGreaterThanOrEqual(
          0.3,
        );
      }
    }
  });

  it("keeps bleed relative luminance at most 0.040 for every hue", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      const { bleed, bleed2 } = buildAccent(hue, 0.6);

      expect(
        hexRelativeLuminance(bleed),
        `bleed Y at hue ${hue}`,
      ).toBeLessThanOrEqual(0.04);
      expect(
        hexRelativeLuminance(bleed2),
        `bleed-2 Y at hue ${hue}`,
      ).toBeLessThanOrEqual(0.04);
    }
  });

  it("meets plan contrast ratios for every hue, sat, and the fallback bleed", () => {
    for (let hue = 0; hue < 360; hue += 1) {
      for (const sat of SATURATIONS) {
      expectAccentContrast(buildAccent(hue, sat), `hue ${hue} sat ${sat}`);
      }
    }

    expect(hexRelativeLuminance(FALLBACK_BLEED)).toBeLessThanOrEqual(0.04);
    expect(hexContrastRatio(INK, FALLBACK_BLEED)).toBeGreaterThanOrEqual(10.61);
    expect(hexContrastRatio(INK_2, FALLBACK_BLEED)).toBeGreaterThanOrEqual(5.67);
    expect(hexContrastRatio(ZINC_400, FALLBACK_BLEED)).toBeGreaterThanOrEqual(
      4.55,
    );
  });

  it("meets contrast for non-integer hues and saturations between the clamps", () => {
    for (const hue of FRACTIONAL_HUES) {
      for (const sat of MID_SATURATIONS) {
      expectAccentContrast(buildAccent(hue, sat), `hue ${hue} sat ${sat}`);
      }
    }
  });
});

describe("pickAccent", () => {
  it("returns null for grey and low-saturation covers", () => {
    expect(pickAccent(fillRgba(128, 128, 128))).toBeNull();
    expect(pickAccent(fillRgba(18, 18, 20))).toBeNull();
    expect(pickAccent(fillRgba(240, 240, 242))).toBeNull();
    expect(pickAccent(fillRgba(140, 138, 136))).toBeNull();
  });

  it("returns null when colourful pixels are below 4% weight", () => {
    const data = fillRgba(128, 128, 128);

    for (let i = 0; i < 16; i += 1) {
      const offset = i * 4;
      data[offset] = 255;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }

    expect(pickAccent(data)).toBeNull();
  });

  it("returns null when alpha is below 128", () => {
    expect(pickAccent(fillRgba(255, 0, 0, 127))).toBeNull();
  });

  it("returns null for an empty pixel array", () => {
    expect(pickAccent(new Uint8ClampedArray())).toBeNull();
  });

  it("returns an accent that meets luminance bounds for a saturated cover", () => {
    const result = pickAccent(fillRgba(255, 0, 0));

    expect(result).not.toBeNull();

    if (result === null) {
      return;
    }

    expectAccentContrast(result, "saturated red");
    expect(hexRelativeLuminance(result.accent)).toBeGreaterThanOrEqual(0.3);
    expect(hexRelativeLuminance(result.bleed)).toBeLessThanOrEqual(0.04);
    expect(hexRelativeLuminance(result.bleed2)).toBeLessThanOrEqual(0.04);
  });

  it("returns a valid accent for a 1x1 colourful image", () => {
    const result = pickAccent(fillRgba(255, 0, 0, 255, 1));

    expect(result).not.toBeNull();

    if (result === null) {
      return;
    }

    expectAccentContrast(result, "1x1 red");
  });

  it("wraps hue when pixels cluster at 350 and 10 degrees", () => {
    const hues = [
      ...Array.from({ length: 288 }, () => 350),
      ...Array.from({ length: 288 }, () => 10),
    ];
    const result = pickAccent(fillHues(hues));

    expect(result).not.toBeNull();

    if (result === null) {
      return;
    }

    expectAccentContrast(result, "hue wrap 350/10");
  });
});
