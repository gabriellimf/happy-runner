export interface Accent {
  accent: string;
  bleed: string;
  bleed2: string;
}

const MIN_ALPHA = 128;
const MIN_SATURATION = 0.18;
const MIN_LIGHTNESS = 0.1;
const MAX_LIGHTNESS = 0.92;
const HUE_BUCKETS = 12;
const BUCKET_DEGREES = 30;
const MIN_WINNER_WEIGHT_RATIO = 0.04;
const ACCENT_SAT_MIN = 0.5;
const ACCENT_SAT_MAX = 0.8;
const ACCENT_L_MIN = 0.3;
const ACCENT_MIN_Y = 0.3;
const ON_ACCENT_HEX = "#0a0a0b";
const SURFACE_3_HEX = "#26262c";
const ACCENT_ON_SURFACE_MIN = 5.01;
const ON_ACCENT_OVER_ACCENT_MIN = 6.6;
const BLEED_SATURATION = 0.6;
const BLEED_MAX_Y = 0.04;
const BLEED_L_MAX = 0.5;
const BLEED_HUE_SHIFT = 40;
const BLEED_BISECT_STEPS = 32;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

interface Rgb {
  b: number;
  g: number;
  r: number;
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;

  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbToLinear(r) +
    0.7152 * srgbToLinear(g) +
    0.0722 * srgbToLinear(b)
  );
}

function parseHex(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

export function hexRelativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);

  return relativeLuminance(r, g, b);
}

export function contrastRatio(y1: number, y2: number): number {
  const lighter = Math.max(y1, y2);
  const darker = Math.min(y1, y2);

  return (lighter + 0.05) / (darker + 0.05);
}

export function hexContrastRatio(a: string, b: string): number {
  return contrastRatio(hexRelativeLuminance(a), hexRelativeLuminance(b));
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, l, s: 0 };
  }

  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;

  if (max === red) {
    h = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6;
  } else if (max === green) {
    h = ((blue - red) / delta + 2) / 6;
  } else {
    h = ((red - green) / delta + 4) / 6;
  }

  return { h: h * 360, l, s };
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

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360;

  if (s === 0) {
    const channel = Math.round(l * 255);

    return { b: channel, g: channel, r: channel };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hue) * 255),
    b: Math.round(hueToRgb(p, q, hue - 1 / 3) * 255),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (channel: number) =>
    Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function luminanceOfHsl(h: number, s: number, l: number): number {
  const { r, g, b } = hslToRgb(h, s, l);

  return relativeLuminance(r, g, b);
}

function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function clampSaturation(saturation: number): number {
  return Math.min(ACCENT_SAT_MAX, Math.max(ACCENT_SAT_MIN, saturation));
}

function solveAccentLightness(hue: number, saturation: number): number {
  const start = Math.round(ACCENT_L_MIN * 100);

  for (let step = start; step <= 100; step += 1) {
    const lightness = step / 100;
    const hex = rgbToHex(hslToRgb(hue, saturation, lightness));

    if (
      hexRelativeLuminance(hex) >= ACCENT_MIN_Y &&
      hexContrastRatio(ON_ACCENT_HEX, hex) >= ON_ACCENT_OVER_ACCENT_MIN &&
      hexContrastRatio(hex, SURFACE_3_HEX) >= ACCENT_ON_SURFACE_MIN
    ) {
      return lightness;
    }
  }

  return 1;
}

function solveBleedLightness(hue: number): number {
  let lo = 0;
  let hi = BLEED_L_MAX;

  for (let i = 0; i < BLEED_BISECT_STEPS; i += 1) {
    const mid = (lo + hi) / 2;

    if (luminanceOfHsl(hue, BLEED_SATURATION, mid) <= BLEED_MAX_Y) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return lo;
}

export function buildAccent(hue: number, saturation: number): Accent {
  const clampedSat = clampSaturation(saturation);
  const accentHue = wrapHue(hue);
  const bleedHue = wrapHue(accentHue + BLEED_HUE_SHIFT);
  const accentL = solveAccentLightness(accentHue, clampedSat);
  const bleedL = solveBleedLightness(accentHue);
  const bleed2L = solveBleedLightness(bleedHue);

  return {
    accent: rgbToHex(hslToRgb(accentHue, clampedSat, accentL)),
    bleed: rgbToHex(hslToRgb(accentHue, BLEED_SATURATION, bleedL)),
    bleed2: rgbToHex(hslToRgb(bleedHue, BLEED_SATURATION, bleed2L)),
  };
}

function pixelWeight(saturation: number, lightness: number): number {
  return saturation * (1 - Math.abs(2 * lightness - 1));
}

export function pickAccent(pixels: Uint8ClampedArray): Accent | null {
  const pixelCount = Math.floor(pixels.length / 4);

  if (pixelCount === 0) {
    return null;
  }

  const bucketWeight = new Array<number>(HUE_BUCKETS).fill(0);
  const bucketSin = new Array<number>(HUE_BUCKETS).fill(0);
  const bucketCos = new Array<number>(HUE_BUCKETS).fill(0);
  const bucketSat = new Array<number>(HUE_BUCKETS).fill(0);

  for (let i = 0; i < pixelCount; i += 1) {
    const offset = i * 4;
    const alpha = pixels[offset + 3] ?? 0;

    if (alpha < MIN_ALPHA) {
      continue;
    }

    const { h, s, l } = rgbToHsl(
      pixels[offset] ?? 0,
      pixels[offset + 1] ?? 0,
      pixels[offset + 2] ?? 0,
    );

    if (s < MIN_SATURATION || l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) {
      continue;
    }

    const weight = pixelWeight(s, l);
    const bucket = Math.floor(wrapHue(h) / BUCKET_DEGREES) % HUE_BUCKETS;
    const radians = (h * Math.PI) / 180;

    bucketWeight[bucket] += weight;
    bucketSin[bucket] += Math.sin(radians) * weight;
    bucketCos[bucket] += Math.cos(radians) * weight;
    bucketSat[bucket] += s * weight;
  }

  let winner = 0;
  let maxWeight = bucketWeight[0] ?? 0;

  for (let bucket = 1; bucket < HUE_BUCKETS; bucket += 1) {
    const weight = bucketWeight[bucket] ?? 0;

    if (weight > maxWeight) {
      maxWeight = weight;
      winner = bucket;
    }
  }

  if (maxWeight < MIN_WINNER_WEIGHT_RATIO * pixelCount) {
    return null;
  }

  const sinSum = bucketSin[winner] ?? 0;
  const cosSum = bucketCos[winner] ?? 0;
  let hue = (Math.atan2(sinSum, cosSum) * 180) / Math.PI;

  if (hue < 0) {
    hue += 360;
  }

  const satSum = bucketSat[winner] ?? 0;
  const saturation = satSum / maxWeight;

  return buildAccent(hue, saturation);
}
