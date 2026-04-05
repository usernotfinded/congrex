import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  readResponseTextCapped,
  ResponseBodyTooLargeError,
} from "../src/http.js";

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();

  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }));
}

test("readResponseTextCapped returns the full body when under the limit", async () => {
  const response = responseFromChunks(["hello ", "world"]);

  assert.equal(await readResponseTextCapped(response, 64), "hello world");
});

test("readResponseTextCapped throws a friendly error when the response exceeds the limit", async () => {
  const response = responseFromChunks(["1234", "5678"]);

  await assert.rejects(
    () => readResponseTextCapped(response, 6),
    (error: unknown) => {
      assert.ok(error instanceof ResponseBodyTooLargeError);
      assert.match(error.message, /safety limit/i);
      return true;
    },
  );
});

test("readResponseTextCapped enforces the limit by UTF-8 byte length", async () => {
  const response = responseFromChunks(["ééé"]);

  await assert.rejects(
    () => readResponseTextCapped(response, 5),
    ResponseBodyTooLargeError,
  );
});

test("MAX_PROVIDER_RESPONSE_BYTES stays at a reasonable hard cap", () => {
  assert.equal(MAX_PROVIDER_RESPONSE_BYTES, 2 * 1024 * 1024);
});
