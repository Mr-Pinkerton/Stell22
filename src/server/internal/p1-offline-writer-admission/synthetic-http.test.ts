import { describe, expect, it } from "vitest";
import type { Admission } from "@/server/internal/p1-offline-writer-admission/contract";
import {
  startInProcessQueue,
  startSyntheticApp,
  startSyntheticProxy,
  writeAfterDelayWithRecheck,
  writeAfterDelayWithoutRecheck,
} from "@/server/internal/p1-offline-writer-admission/synthetic-http";

async function post(port: number, channel = "http-direct"): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  return response.status;
}

describe("synthetic admission http", () => {
  it("rejects new writes on the direct path and the proxy after both controls close", async () => {
    const admission: Admission = { app: "open", proxy: "open" };
    const writes: string[] = [];
    const app = await startSyntheticApp(admission, async (channel) => {
      writes.push(channel);
    });
    const proxy = await startSyntheticProxy(admission, app.port);
    try {
      expect(await post(app.port, "http-direct")).toBe(200);
      expect(await post(proxy.port)).toBe(200);
      expect(writes).toEqual(["http-direct", "http-proxy"]);
      admission.proxy = "closed";
      expect(await post(proxy.port)).toBe(503);
      expect(await post(app.port, "http-direct")).toBe(200);
      admission.app = "closed";
      expect(await post(app.port, "http-direct")).toBe(503);
      expect(await post(proxy.port)).toBe(503);
      expect(writes).toEqual(["http-direct", "http-proxy", "http-direct"]);
    } finally {
      await proxy.close();
      await app.close();
    }
  });

  it("stops the in-process queue and distinguishes a passed check from a recheck", async () => {
    const admission: Admission = { app: "open", proxy: "open" };
    const writes: string[] = [];
    const queue = startInProcessQueue(admission, async (channel) => {
      writes.push(channel);
    }, 20);
    await new Promise((resolve) => setTimeout(resolve, 70));
    const started = queue.started();
    queue.stop();
    const pastPromise = writeAfterDelayWithoutRecheck(admission, async (channel) => {
      writes.push(channel);
    }, 40);
    admission.app = "closed";
    const past = await pastPromise;
    const recheck = await writeAfterDelayWithRecheck(admission, async (channel) => {
      writes.push(channel);
    }, 20);
    expect(started).toBeGreaterThan(0);
    expect(past).toBe("committed");
    expect(recheck).toBe("skipped");
    expect(writes).toContain("bg-past-check");
    expect(writes).not.toContain("bg-recheck");
    expect(queue.failure()).toBeUndefined();
  });
});
