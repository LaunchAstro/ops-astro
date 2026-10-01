// SPDX-License-Identifier: AGPL-3.0-only
//
// A surface route's body, read within its limit: moved out of app.ts whole when the main
// merge joined it past the 1000-line limit.

import type { Context } from 'hono';
import { canonicalPayload } from '../../packages/core-digest/src/index.ts';

/** The largest body a surface route reads. Files go by signed link, never through the API. */
export const MAX_BODY_BYTES = 1_048_576;

/**
 * A body that is not an object is refused rather than coerced into one, and
 * so is one over `MAX_BODY_BYTES`.
 *
 * So is one with no canonical form. `JSON.parse` reads a number too large for
 * a double, 1e400, as Infinity, and every entry takes the payload digest
 * before anything else, so that body would fault with nothing recorded.
 * Here it is a malformed body like any other.
 */
export async function readObject(
  context: Context,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const text = await readLimited(context.req.raw, MAX_BODY_BYTES);
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    canonicalPayload(parsed);
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

/**
 * The body as text, or nothing past `limit` bytes: counted as they arrive, so
 * a body with no Content-Length, or a wrong one, stops at the limit.
 */
async function readLimited(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get('content-length')) > limit) return undefined;
  let total = 0;
  const counted = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) controller.error(new RangeError('over the body limit'));
        else controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Response(counted).text();
  } catch {
    return undefined;
  }
}
