import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Cover } from "../components/cover";
import { NextList } from "../components/next-list";
import { NowPlaying } from "../components/now-playing";
import { SearchForm } from "../components/search-form";
import { StatusMessage } from "../components/status-message";
import { SuggestionList } from "../components/suggestion-list";
import type { QueueTrack } from "../lib/spotify-responses";
import type { Track } from "../lib/spotify-responses";

function queueTrack(index: number): QueueTrack {
  return {
    artists: ["Artista A", "Artista B", "Artista C"],
    coverUrl: null,
    id: `track-${index}`,
    title: `Faixa ${index}`,
  };
}

function searchTrack(index: number): Track {
  return {
    artists: [`Artista ${index}`],
    coverUrl: null,
    durationMs: 180_000,
    id: `search-track-${index}`,
    title: `Sugestão ${index}`,
    uri: "spotify:track:1234567890123456789012",
  };
}

describe("presentational components", () => {
  it.each([
    ["https://user:pw@a/b", false],
    ["https://a/b", true],
    ["http://a/b", false],
    ["javascript:alert(1)", false],
  ] as const)("renders a cover for the allowed URL %s", (coverUrl, isAllowed) => {
    const markup = renderToStaticMarkup(
      createElement(Cover, { coverUrl, size: "small" }),
    );

    expect(markup.includes("<img")).toBe(isAllowed);

    if (isAllowed) {
      expect(markup).toContain('referrerPolicy="no-referrer"');
      expect(markup).toContain('loading="lazy"');
    } else {
      expect(markup).toContain("bg-zinc-800");
    }
  });

  it("uses truncation classes for long track names and artist lists", () => {
    const longTrack = {
      ...queueTrack(1),
      artists: Array.from({ length: 8 }, (_, index) => `Artista ${index}`),
      title: "Música ".repeat(20),
    };
    const markup = renderToStaticMarkup(
      createElement(NowPlaying, { track: longTrack }),
    );

    expect(markup).toContain("line-clamp-2");
    expect(markup).toContain("truncate");
  });

  it("renders search errors in the assertive live region only", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusMessage, {
        message: { kind: "error", text: "Algo deu errado, tente de novo" },
      }),
    );

    expect(markup).toContain('class="sr-only" id="search-status"');
    expect(markup).toContain('id="search-alert" role="alert"');
    expect(markup).toContain("Algo deu errado, tente de novo");
  });

  it("renders the short-query hint in normal and warning styles", () => {
    const hintMarkup = renderToStaticMarkup(
      createElement(StatusMessage, {
        message: { kind: "hint", text: "Digite pelo menos 4 letras" },
      }),
    );
    const warningMarkup = renderToStaticMarkup(
      createElement(StatusMessage, {
        message: { kind: "warning", text: "Digite pelo menos 4 letras" },
      }),
    );

    expect(hintMarkup).toContain('class="text-sm text-zinc-400"');
    expect(warningMarkup).toContain('class="text-sm text-amber-300"');
  });

  it("shows three search skeletons when loading without previous rows", () => {
    const markup = renderToStaticMarkup(
      createElement(SuggestionList, {
        activeTrackId: null,
        isAdding: false,
        items: [],
        onSelect: () => {},
        phase: "loading",
        query: "abba",
        resultQuery: null,
      }),
    );

    expect(markup.match(/motion-safe:animate-pulse/g)).toHaveLength(3);
  });

  it("keeps previous search rows without skeletons while loading", () => {
    const markup = renderToStaticMarkup(
      createElement(SuggestionList, {
        activeTrackId: null,
        isAdding: false,
        items: [searchTrack(1)],
        onSelect: () => {},
        phase: "loading",
        query: "queen",
        resultQuery: "abba",
      }),
    );

    expect(markup).toContain("Sugestão 1");
    expect(markup).not.toContain("motion-safe:animate-pulse");
  });

  it("badges suggestions that are already in the queue", () => {
    const markup = renderToStaticMarkup(
      createElement(SuggestionList, {
        activeTrackId: null,
        inQueue: {
          "search-track-1": "exact",
          "search-track-2": "version",
        },
        isAdding: false,
        items: [searchTrack(1), searchTrack(2), searchTrack(3)],
        onSelect: () => {},
        phase: "results",
        query: "abba",
        resultQuery: "abba",
      }),
    );

    expect(markup.match(/Já na fila/g)).toHaveLength(1);
    expect(markup.match(/Versão na fila/g)).toHaveLength(1);
  });

  it("shows no badge when inQueue is absent", () => {
    const markup = renderToStaticMarkup(
      createElement(SuggestionList, {
        activeTrackId: null,
        isAdding: false,
        items: [searchTrack(1)],
        onSelect: () => {},
        phase: "results",
        query: "abba",
        resultQuery: "abba",
      }),
    );

    expect(markup).not.toContain("na fila");
  });

  it("uses the shorter search placeholder", () => {
    const markup = renderToStaticMarkup(
      createElement(SearchForm, {
        isAdding: false,
        isDisabled: true,
        inputRef: () => {},
        onSubmit: () => {},
        onTextChange: () => {},
        text: "",
      }),
    );

    expect(markup).toContain('placeholder="Música ou artista"');
  });

  it("renders every next-queue item without an overflow cap", () => {
    const tracks = Array.from({ length: 20 }, (_, index) => queueTrack(index));
    const markup = renderToStaticMarkup(
      createElement(NextList, { tracks }),
    );

    expect(markup).toContain("Faixa 0");
    expect(markup).toContain("Faixa 19");
    expect(markup.match(/<li/g)).toHaveLength(20);
    expect(markup).not.toContain("na fila");
  });
});
