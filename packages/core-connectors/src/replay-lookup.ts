// SPDX-License-Identifier: AGPL-3.0-only
//
// The replay provider's lookup, adapter half (AW-10): how the reconciliation
// pass asks whether one operation began, and how its answer is read. Like the
// call itself, the request has no origin and no credential; custody adds both
// and bounds the answer. The answer is only ever a code: the broker counts it
// as proof that nothing happened only when the operation declared that code
// at registration (`nothingHappened`), and anything else proves nothing.

import type { AdapterRequest } from './operation.ts';

/** How the stand-in answers a lookup (AW-10): honestly, or one of the hostile answers. */
export type ReplayLookupMode =
  'honest' | 'malformed' | 'oversized' | 'redirect' | 'slow' | 'claims_success' | 'unreachable';

/** Where the stand-in answers whether it began one operation. */
export const REPLAY_LOOKUP_PATH = '/v1/operations/lookup';

/** The code that proves nothing happened; replay.ts declares the same (`REPLAY_NOTHING_HAPPENED`). */
const NOT_BEGUN_CODE = 'rejected_before_processing';

/** The lookup request for one operation, named by the id the call carried. */
export function replayLookup(operationId: string): AdapterRequest {
  return {
    path: REPLAY_LOOKUP_PATH,
    method: 'POST',
    body: JSON.stringify({ operation_id: operationId }),
  };
}

/** A code of the lookup's shape: short, plain, and nothing else. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;

/** The lookup's schema: exactly `{ code }`, or nothing. Extra fields make it malformed. */
export function readReplayLookup(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  const code = (body as Record<string, unknown>)['code'];
  if (keys.length !== 1 || typeof code !== 'string' || !CODE.test(code)) return undefined;
  return code;
}

/** The operation id a request to the stand-in names, or null. */
export function operationOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed['operation_id'] === 'string' ? parsed['operation_id'] : null;
  } catch {
    return null;
  }
}

/** What the stand-in knows of one operation: begun, refused unbegun, or not yet received. */
export type LookupState = 'begun' | 'refused' | 'unseen';

/** The honest code for each state; an unseen call may still arrive, so it proves nothing. */
const HONEST: Readonly<Record<LookupState, string>> = {
  begun: 'completed',
  refused: NOT_BEGUN_CODE,
  unseen: 'not_yet_received',
};

/** The stand-in's lookup body for the honest answer and the false claim; others it answers itself. */
export function lookupBody(mode: ReplayLookupMode, state: LookupState): unknown {
  if (mode === 'honest') return { code: HONEST[state] };
  // Claims nothing happened in its own word, never the declared code.
  if (mode === 'claims_success') return { code: 'not_found' };
  return undefined;
}
