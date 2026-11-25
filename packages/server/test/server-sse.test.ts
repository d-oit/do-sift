/** SSE backpressure valve (issue #158, plan 064, SBK-01): once the socket buffer fills, further source cards are dropped and counted instead of buffering without bound; terminal events still attempt a write. */
import { describe, expect, it, vi } from "vitest";
import { createSseSink } from "../src/server-http.js";

function fakeResponse(writeImpl: (chunk: string) => boolean) {
  return {
    destroyed: false,
    writableEnded: false,
    write: vi.fn(writeImpl),
    id: "http-test-1",
  };
}

describe("createSseSink (issue #158)", () => {
  it("delivers while the buffer drains and reports zero drops", () => {
    const res = fakeResponse(() => true);
    const sink = createSseSink(
      res as never,
      "http-test-1",
      () => !res.destroyed && !res.writableEnded,
      () => false,
    );
    sink.pushSource({ url: "https://a.test/page" });
    sink.pushTerminal("done", { hits: 1 });
    expect(sink.droppedSources).toBe(0);
    expect(res.write).toHaveBeenCalledTimes(2);
  });

  it("drops and counts sources after saturation but still writes terminal events", () => {
    const res = fakeResponse(() => false);
    const sink = createSseSink(
      res as never,
      "http-test-1",
      () => !res.destroyed && !res.writableEnded,
      () => false,
    );
    sink.pushSource({ url: "https://a.test/page" });
    sink.pushSource({ url: "https://b.test/page" });
    sink.pushSource({ url: "https://c.test/page" });
    expect(sink.droppedSources).toBe(3);
    expect(res.write).toHaveBeenCalledTimes(1);
    sink.pushTerminal("done", { hits: 3 });
    expect(res.write).toHaveBeenCalledTimes(2);
  });

  it("skips silently when the stream is gone without counting drops", () => {
    const res = fakeResponse(() => true);
    res.destroyed = true;
    const sink = createSseSink(
      res as never,
      "http-test-1",
      () => !res.destroyed && !res.writableEnded,
      () => false,
    );
    sink.pushSource({ url: "https://a.test/page" });
    expect(sink.droppedSources).toBe(0);
    expect(res.write).not.toHaveBeenCalled();
  });
});
