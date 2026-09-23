import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { clearCachedUserJwt } from "../src/jwt.ts";
import { streamDevin } from "../src/stream.ts";
import { encodeMessage } from "../src/wire.ts";

const model = {
  id: "test-model",
  name: "Test model",
  api: "devin-local",
  provider: "devin",
  baseUrl: "https://devin.invalid",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262_000,
  maxTokens: 1_000,
};
const user = (content) => ({ role: "user", content, timestamp: 1 });

test("aborting an in-flight stream reports aborted without leaking a rejection", async (t) => {
  clearCachedUserJwt();
  t.after(clearCachedUserJwt);

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  const ac = new AbortController();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "https://devin.invalid/exa.auth_pb.AuthService/GetUserJwt") {
      return new Response(encodeMessage(1, Buffer.from("eyJtest.jwt")));
    }
    assert.equal(url, "https://devin.invalid/exa.api_server_pb.ApiServerService/GetChatMessage");
    // Mirror undici: an aborted fetch errors the response body with signal.reason.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        const onAbort = () => controller.error(options.signal.reason);
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      },
    });
    return new Response(body);
  });

  const stream = streamDevin(model, normalizeContext({ messages: [user("hello")] }), {
    apiKey: "synthetic-test-key",
    env: { DEVIN_API_SERVER_URL: "https://devin.invalid" },
    signal: ac.signal,
  });

  const events = [];
  const consume = (async () => {
    for await (const event of stream) events.push(event);
  })();
  ac.abort();
  await consume;
  // Give any floating rejection a chance to surface.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const last = events.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.reason, "aborted");
  assert.equal((await stream.result()).stopReason, "aborted");
  assert.deepEqual(rejections, []);
});
