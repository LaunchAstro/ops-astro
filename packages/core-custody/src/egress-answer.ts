// SPDX-License-Identifier: AGPL-3.0-only
//
// What a request through egress (`egress.ts`) answers, and how its answer is
// read: within its byte limit, counted off the stream, the read stopping at
// the limit rather than after it. A redirect is answered, never followed. A
// caller may take each chunk of a successful answer as it is read
// (`OnChunk`); an error body is only ever read whole.

/** What is read of a response: its status, its body as it streams, and a way to stop it. */
export interface Answering extends AsyncIterable<unknown> {
  readonly statusCode?: number | undefined;
  destroy(): void;
}

export type OutboundFault =
  | 'unlisted'
  | 'bad_path'
  | 'forbidden'
  | 'redirect'
  | 'timeout'
  | 'too_large'
  | 'status'
  | 'network'
  /** A gated send's deadline passed before the write: nothing was written. */
  | 'lapsed';

export type Outbound =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly fault: OutboundFault; readonly status: number | null };

/** Each chunk of a 2xx answer as it is read, within the limit, before the whole is answered. */
export type OnChunk = (chunk: Buffer) => void;

async function readBounded(
  response: Answering,
  limit: number,
  onChunk?: OnChunk,
): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false }> {
  const parts: Buffer[] = [];
  let size = 0;
  // One chunk at a time: the count must stop the read, not follow it.
  for await (const chunk of response) {
    const part = chunk as Buffer;
    size += part.byteLength;
    if (size > limit) {
      response.destroy();
      return { ok: false };
    }
    parts.push(part);
    onChunk?.(part);
  }
  return { ok: true, text: Buffer.concat(parts).toString('utf8') };
}

/** A response read within its limit. A redirect is answered, never followed. */
export async function answerOf(
  response: Answering,
  limit: number,
  failed: (status: number | null) => Outbound,
  onChunk?: OnChunk,
): Promise<Outbound> {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    response.destroy();
    return { ok: false, fault: 'redirect', status };
  }
  let read: Awaited<ReturnType<typeof readBounded>>;
  try {
    // Only an answer that succeeded is passed on as it comes; an error body is read whole.
    read = await readBounded(response, limit, status >= 200 && status < 300 ? onChunk : undefined);
  } catch {
    return failed(status);
  }
  if (!read.ok) return { ok: false, fault: 'too_large', status };
  if (status < 200 || status >= 300) return { ok: false, fault: 'status', status };
  return { ok: true, status, body: read.text };
}
