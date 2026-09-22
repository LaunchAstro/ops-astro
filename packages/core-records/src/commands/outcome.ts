// SPDX-License-Identifier: AGPL-3.0-only
//
// What a handler hands back to the envelope.
//
// A refusal is a value here rather than an exception, all the way down: the
// envelope has to be able to roll the handler's writes back and then record
// the refusal, and an exception would have taken the transaction with it. The
// two shapes are separate types rather than one union with a flag so that a
// handler cannot return a half-filled result and have it read as applied.

import type { CommandRefusal } from './refusal.ts';

export interface Applied {
  /** The record the command touched, or null where it touched no single one. */
  readonly recordId: string | null;
  /** The revision the caller may write against next. */
  readonly revision: number | null;
  /** What the command did, in values a client can read. Never the record. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface Refused {
  readonly refusal: CommandRefusal;
  /**
   * The keys and values an attempt carried that it was not allowed to carry.
   * They go to the audit event and never to the response (T1-N4). Only the
   * offending keys: this is not a place to keep the payload.
   */
  readonly attempted?: Readonly<Record<string, unknown>>;
}

export type HandlerOutcome = Applied | Refused;

export function applied(
  recordId: string | null,
  revision: number | null,
  detail: Readonly<Record<string, unknown>> = {},
): Applied {
  return { recordId, revision, detail };
}

export function refused(
  refusal: CommandRefusal,
  attempted?: Readonly<Record<string, unknown>>,
): Refused {
  return attempted === undefined ? { refusal } : { refusal, attempted };
}

export function isRefused(outcome: HandlerOutcome): outcome is Refused {
  return 'refusal' in outcome;
}
