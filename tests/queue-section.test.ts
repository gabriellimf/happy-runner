import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QueueSection } from "../components/queue-section";
import type { QueueState } from "../lib/client/queue-machine";
import type { QueueTrack } from "../lib/spotify-responses";

function track(index: number): QueueTrack {
  return {
    artists: ["Artista"],
    coverUrl: null,
    id: `track-${index}`,
    title: `Faixa ${index}`,
  };
}

function renderQueue(state: QueueState): string {
  return renderToStaticMarkup(createElement(QueueSection, { state }));
}

describe("QueueSection states", () => {
  it("renders the queue skeleton while loading without data", () => {
    const markup = renderQueue({
      data: null,
      isLoading: true,
      notice: null,
    });

    expect(markup).toContain("Carregando fila...");
    expect(markup).toContain("aria-hidden");
    expect(markup).toContain("var(--bleed)");
    expect(markup).not.toContain("Tocando agora");
  });

  it("renders an empty next-up copy when a track is playing", () => {
    const markup = renderQueue({
      data: { nowPlaying: track(0), next: [] },
      isLoading: false,
      notice: null,
    });

    expect(markup).toContain("Tocando agora");
    expect(markup).toContain("Faixa 0");
    expect(markup).toContain("Nenhuma música na fila");
    expect(markup).not.toContain("Nada tocando agora");
  });

  it("renders the nothing-playing copy and hides next-up", () => {
    const markup = renderQueue({
      data: { nowPlaying: null, next: [] },
      isLoading: false,
      notice: null,
    });

    expect(markup).toContain("Nada tocando agora");
    expect(markup).toContain("Abra o Spotify no celular e toque uma música");
    expect(markup).not.toContain("Nenhuma música na fila");
  });

  it("renders the offline notice with last data", () => {
    const markup = renderQueue({
      data: { nowPlaying: track(0), next: [track(1)] },
      isLoading: false,
      notice: "offline",
    });

    expect(markup).toContain("Sem conexão. Mostrando a última fila");
    expect(markup).toContain("Faixa 0");
    expect(markup).toContain("Faixa 1");
  });

  it("renders the offline notice without data", () => {
    const markup = renderQueue({
      data: null,
      isLoading: false,
      notice: "offline",
    });

    expect(markup).toContain("Sem conexão");
    expect(markup).not.toContain("Mostrando a última fila");
    expect(markup).not.toContain("Tocando agora");
  });

  it("renders the rate-limited notice", () => {
    const markup = renderQueue({
      data: { nowPlaying: track(0), next: [] },
      isLoading: false,
      notice: "rate-limited",
    });

    expect(markup).toContain("Muita gente pedindo, atualizando em instantes");
    expect(markup).toContain("Faixa 0");
  });
});
