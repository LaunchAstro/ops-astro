// SPDX-License-Identifier: AGPL-3.0-only
//
// What a request through egress (`egress.ts`) answers, and how its answer is
// read: within its byte limit, counted off the stream, the read stopping at
// the limit rather than after it. A redirect is answered, never followed. A
// caller may take each chunk of a successful answer as it is read
// (`OnChunk`); an error body is only ever read whole. A successful answer
// keeps its media type, and a site answer is cut to its route's declared
// fields here (`keptOf`), read as the guarded call reads them.

import { isUtf8 } from 'node:buffer';

/** What is read of a response: its status, its body as it streams, and a way to stop it. */
export interface Answering extends AsyncIterable<unknown> {
  readonly statusCode?: number | undefined;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
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
  | 'network';

export type Outbound =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: string;
      /** The answer's `content-type`, lower-cased, with no parameters. */
      readonly mediaType?: string;
      /** Set when the body's bytes were not valid UTF-8, so `body` holds replacements. */
      readonly notUtf8?: true;
    }
  | { readonly ok: false; readonly fault: OutboundFault; readonly status: number | null };

/** Each chunk of a 2xx answer as it is read, within the limit, before the whole is answered. */
export type OnChunk = (chunk: Buffer) => void;

async function readBounded(
  response: Answering,
  limit: number,
  onChunk?: OnChunk,
): Promise<
  { readonly ok: true; readonly text: string; readonly utf8: boolean } | { readonly ok: false }
> {
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
  const bytes = Buffer.concat(parts);
  return { ok: true, text: bytes.toString('utf8'), utf8: isUtf8(bytes) };
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
  const type = response.headers?.['content-type'];
  const mediaType = typeof type === 'string' ? type.split(';')[0]?.trim().toLowerCase() : '';
  return {
    ok: true,
    status,
    body: read.text,
    ...(mediaType ? { mediaType } : {}),
    ...(read.utf8 ? {} : { notUtf8: true as const }),
  };
}

/** A declared field's type, as the connector catalogue names it. */
export type FieldKind = 'string' | 'number' | 'boolean';
export type Fields = Readonly<Record<string, FieldKind>>;

/**
 * A dotted field of a parsed answer: own properties only, and a list read
 * only by a numeric index (`deployments.0.uid`), as the guarded call's
 * `readField` reads it. Custody keeps its own copy: it loads no connector code.
 */
export function fieldAt(body: unknown, dotted: string): unknown {
  let value: unknown = body;
  for (const part of dotted.split('.')) {
    if (Array.isArray(value)) {
      value = /^(?:0|[1-9][0-9]{0,5})$/u.test(part)
        ? (value as unknown[])[Number(part)]
        : undefined;
      continue;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    value = Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
  }
  return value;
}

/** An own field, as the parse sets it: a `__proto__` key is a field like any other. */
const put = (into: object, key: string, value: unknown): void => {
  Object.defineProperty(into, key, { value, writable: true, enumerable: true, configurable: true });
};

/**
 * What the caller may keep of a JSON answer: each declared field, of its
 * declared type, as text (`values`) and rebuilt as the only fields of the body
 * passed back. Undefined when the answer is not JSON, by its media type or its
 * parse, or does not fill every field.
 */
export function keptOf(
  outcome: Extract<Outbound, { ok: true }>,
  fields: Fields,
): { readonly body: string; readonly values: readonly string[] } | undefined {
  if (outcome.mediaType !== 'application/json' || outcome.notUtf8 === true) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.body);
  } catch {
    return undefined;
  }
  const kept = {};
  const values: string[] = [];
  for (const [dotted, kind] of Object.entries(fields)) {
    const value = fieldAt(parsed, dotted);
    // oxlint-disable-next-line valid-typeof -- `kind` is the declared type's own name
    if (typeof value !== kind) return undefined;
    values.push(typeof value === 'string' ? value : JSON.stringify(value));
    const parts = dotted.split('.');
    let into: Record<string, unknown> = kept;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(into, part)) put(into, part, {});
      into = into[part] as Record<string, unknown>;
    }
    put(into, parts.at(-1) ?? '', value);
  }
  return { body: JSON.stringify(kept), values };
}
