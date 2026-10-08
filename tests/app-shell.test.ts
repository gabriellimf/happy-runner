import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import HomePage from "../app/page";
import RootLayout, { metadata, viewport } from "../app/layout";

vi.mock("../app/globals.css", () => ({}));

describe("app shell", () => {
  it("renders a pt-BR page with mobile viewport settings", () => {
    const markup = renderToStaticMarkup(
      createElement(RootLayout, null, createElement(HomePage)),
    );

    expect(markup).toContain('<html lang="pt-BR">');
    expect(markup).toContain('aria-label="Página inicial"');
    expect(metadata.title).toBe("Happy Runner");
    expect(viewport).toMatchObject({
      initialScale: 1,
      width: "device-width",
      viewportFit: "cover",
    });
  });
});
