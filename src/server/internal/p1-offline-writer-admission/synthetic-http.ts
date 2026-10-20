/**
 * Synthetic HTTP writer and proxy for the disposable admission proof.
 * This is not a Server Action and it is not Caddy.
 */

import http from "node:http";
import type { Admission } from "@/server/internal/p1-offline-writer-admission/contract";

export type WriteFn = (channel: string) => Promise<void>;

export type Listener = {
  port: number;
  close: () => Promise<void>;
};

const CHANNEL = /^[a-z0-9-]{1,32}$/;

export async function startSyntheticApp(admission: Admission, write: WriteFn): Promise<Listener> {
  const server = http.createServer((request, response) => {
    void handleApp(request, response, admission, write);
  });
  return listen(server);
}

export async function startSyntheticProxy(admission: Admission, upstreamPort: number): Promise<Listener> {
  const server = http.createServer((request, response) => {
    request.resume();
    if (admission.proxy !== "open") {
      send(response, 503, { rejected: true, layer: "proxy" });
      return;
    }
    const body = JSON.stringify({ channel: "http-proxy" });
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        path: "/write",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, { "content-type": "application/json" });
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      send(response, 502, { rejected: true, layer: "proxy-upstream" });
    });
    upstream.end(body);
  });
  return listen(server);
}

export function startInProcessQueue(admission: Admission, write: WriteFn, intervalMs: number): {
  stop: () => void;
  rejected: () => number;
  started: () => number;
  failure: () => Error | undefined;
} {
  let rejected = 0;
  let started = 0;
  let failure: Error | undefined;
  const timer = setInterval(() => {
    if (admission.app !== "open") {
      rejected += 1;
      return;
    }
    started += 1;
    void write("bg-interval").catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error("queue write failed");
    });
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    rejected: () => rejected,
    started: () => started,
    failure: () => failure,
  };
}

export async function writeAfterDelayWithoutRecheck(
  admission: Admission,
  write: WriteFn,
  delayMs: number,
): Promise<"committed" | "skipped"> {
  if (admission.app !== "open") return "skipped";
  await sleep(delayMs);
  await write("bg-past-check");
  return "committed";
}

export async function writeAfterDelayWithRecheck(
  admission: Admission,
  write: WriteFn,
  delayMs: number,
): Promise<"committed" | "skipped"> {
  await sleep(delayMs);
  if (admission.app !== "open") return "skipped";
  await write("bg-recheck");
  return "committed";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function handleApp(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  admission: Admission,
  write: WriteFn,
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/write") {
    send(response, 404, { rejected: true, layer: "app" });
    return;
  }
  if (admission.app !== "open") {
    request.resume();
    send(response, 503, { rejected: true, layer: "app" });
    return;
  }
  const raw = await readBody(request);
  let channel = "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "channel" in parsed && typeof parsed.channel === "string") {
      channel = parsed.channel;
    }
  } catch {
    send(response, 400, { rejected: true, layer: "app" });
    return;
  }
  if (!CHANNEL.test(channel)) {
    send(response, 400, { rejected: true, layer: "app" });
    return;
  }
  try {
    await write(channel);
  } catch {
    send(response, 500, { rejected: true, layer: "app-write" });
    return;
  }
  send(response, 200, { rejected: false, layer: "app", channel });
}

function listen(server: http.Server): Promise<Listener> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
        reject(new Error("synthetic listener was not bound to 127.0.0.1"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 1024) request.destroy();
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
