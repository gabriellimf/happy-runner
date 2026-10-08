import { describe, expect, it } from "vitest";

import { readJsonBody } from "../lib/request-body";

describe("readJsonBody", () => {
  it("decodes and parses an under-limit body delivered in multiple chunks", async () => {
    const expected = { uri: "spotify:track:0123456789012345678901" };
    const text = JSON.stringify(expected);
    const encodedChunks = [
      new TextEncoder().encode(text.slice(0, 12)),
      new TextEncoder().encode(text.slice(12, 28)),
      new TextEncoder().encode(text.slice(28)),
    ];
    let chunkIndex = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = encodedChunks[chunkIndex];

          if (!chunk) {
            controller.close();
            return;
          }

          controller.enqueue(chunk);
          chunkIndex += 1;
        },
      },
      { highWaterMark: 0 },
    );
    const requestInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      body,
      duplex: "half",
    };
    const request = new Request("http://localhost/api/queue", requestInit);

    await expect(readJsonBody(request, 1_024)).resolves.toEqual(expected);
    expect(chunkIndex).toBe(encodedChunks.length);
  });
});
