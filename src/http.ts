export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

function formatByteLimit(bytes: number): string {
  const mib = 1024 * 1024;
  const kib = 1024;

  if (bytes >= mib && bytes % mib === 0) {
    return `${bytes / mib} MiB`;
  }

  if (bytes >= kib && bytes % kib === 0) {
    return `${bytes / kib} KiB`;
  }

  return `${bytes} bytes`;
}

export class ResponseBodyTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Provider response exceeded the ${formatByteLimit(limitBytes)} safety limit.`);
    this.name = "ResponseBodyTooLargeError";
    this.limitBytes = limitBytes;
  }
}

export async function readResponseTextCapped(
  response: Response,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best effort only — the request is already failing safely.
        }
        throw new ResponseBodyTooLargeError(maxBytes);
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}
