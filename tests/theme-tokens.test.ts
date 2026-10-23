import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NowPlaying } from "../components/now-playing";
import { QueueSection } from "../components/queue-section";

const ROOT = dirname(fileURLToPath(import.meta.url));
const GLOBALS = readFileSync(resolve(ROOT, "../app/globals.css"), "utf8");

function emittedCustomProperties(css: string): Set<string> {
  const names = new Set<string>();

  for (const match of css.matchAll(/@property\s+(--[A-Za-z0-9-]+)/g)) {
    names.add(match[1] ?? "");
  }

  for (const block of css.matchAll(/:root\s*\{([^}]+)\}/g)) {
    for (const match of (block[1] ?? "").matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) {
      names.add(match[1] ?? "");
    }
  }

  names.delete("");
  return names;
}

function referencedVars(markup: string): string[] {
  return [...markup.matchAll(/var\((--[A-Za-z0-9-]+)\)/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("hero and skeleton gradients", () => {
  const emitted = emittedCustomProperties(GLOBALS);

  it("emits --bleed and --bleed-2 as real custom properties", () => {
    expect(emitted.has("--bleed")).toBe(true);
    expect(emitted.has("--bleed-2")).toBe(true);
    expect(emitted.has("--color-bleed")).toBe(false);
    expect(emitted.has("--color-bleed-2")).toBe(false);
  });

  it("NowPlaying inline gradient only references emitted bleed properties", () => {
    const markup = renderToStaticMarkup(
      createElement(NowPlaying, {
        track: {
          artists: ["Artista"],
          coverUrl: null,
          id: "track-1",
          title: "Faixa 1",
        },
      }),
    );

    expect(markup).toContain("var(--bleed)");
    expect(markup).toContain("var(--bleed-2)");
    expect(markup).not.toContain("var(--color-bleed)");

    for (const name of referencedVars(markup)) {
      expect(emitted.has(name), name).toBe(true);
    }
  });

  it("queue skeleton inline gradient only references emitted bleed properties", () => {
    const markup = renderToStaticMarkup(
      createElement(QueueSection, {
        state: { data: null, isLoading: true, notice: null },
      }),
    );

    expect(markup).toContain("var(--bleed)");
    expect(markup).toContain("var(--bleed-2)");
    expect(markup).not.toContain("var(--color-bleed)");

    for (const name of referencedVars(markup)) {
      expect(emitted.has(name), name).toBe(true);
    }
  });
});
