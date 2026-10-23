"use client";

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

import type { Accent } from "../lib/cover-accent";
import { pickAccent } from "../lib/cover-accent";

const CACHE_LIMIT = 24;
const SAMPLE_SIZE = 24;
const SAMPLE_TIMEOUT_MS = 4_000;

export type CoverAccentStyle = CSSProperties & {
  "--accent": string;
  "--bleed": string;
  "--bleed-2": string;
};

const cache = new Map<string, Accent | null>();
let lastStyle: CoverAccentStyle | undefined;

function isHttpsUrl(value: string | null): value is string {
  if (value === null) {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function cacheSet(url: string, value: Accent | null) {
  if (cache.has(url)) {
    cache.delete(url);
  }

  cache.set(url, value);

  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;

    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
}

function toStyle(accent: Accent): CoverAccentStyle {
  return {
    "--accent": accent.accent,
    "--bleed": accent.bleed,
    "--bleed-2": accent.bleed2,
  };
}

type SampleResult =
  | { ok: true; accent: Accent | null }
  | { ok: false };

function sampleImage(img: HTMLImageElement): SampleResult {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    if (!ctx) {
      return { ok: false };
    }

    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    return {
      ok: true,
      accent: pickAccent(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data),
    };
  } catch {
    return { ok: false };
  }
}

export function useCoverAccent(coverUrl: string | null): {
  style: CoverAccentStyle | undefined;
} {
  const httpsUrl = isHttpsUrl(coverUrl) ? coverUrl : null;
  const [, setRevision] = useState(0);

  useEffect(() => {
    if (!httpsUrl) {
      return;
    }

    const cached = cache.get(httpsUrl);

    if (cached !== undefined) {
      lastStyle = cached ? toStyle(cached) : undefined;
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";

    const abandon = () => {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    };

    const timeoutId = window.setTimeout(() => {
      abandon();
    }, SAMPLE_TIMEOUT_MS);

    img.onload = () => {
      window.clearTimeout(timeoutId);

      const sampled = sampleImage(img);

      if (!sampled.ok) {
        return;
      }

      cacheSet(httpsUrl, sampled.accent);
      lastStyle = sampled.accent ? toStyle(sampled.accent) : undefined;

      if (!cancelled) {
        setRevision((value) => value + 1);
      }
    };

    img.onerror = () => {
      window.clearTimeout(timeoutId);
    };

    img.src = httpsUrl;

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      abandon();
    };
  }, [httpsUrl]);

  if (!httpsUrl) {
    return { style: undefined };
  }

  const cached = cache.get(httpsUrl);

  if (cached !== undefined) {
    return { style: cached ? toStyle(cached) : undefined };
  }

  return { style: lastStyle };
}
