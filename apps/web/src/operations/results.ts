// SPDX-License-Identifier: AGPL-3.0-only
//
// What a call through the typed client (`client.ts`) comes back as: an outcome,
// the server's refusal, or no answer at all. Moved whole from that file, which
// re-exports each, to keep it under the line limit.

import type { CommandRefusal, PlanOffer } from '../../../../packages/core-wire/src/index.ts';

/** What a mutation returns when it worked: a durable handle and a new revision. */
export interface CommandOutcome {
  readonly recordId: string;
  readonly revision: number;
  /**
   * Whatever the operation has to say about what it did, in its own words.
   *
   * It is the envelope's third field (`commands/outcome.ts`) and the API passes it through
   * unchanged. `task.comment` puts the new comment's identifier in it; the two settings commands
   * put the key and the value the row now holds, which is the only thing in this build that tells
   * a caller what a setting was set to — there is no settings read. Optional, because most
   * operations have nothing to add beyond the handle and the revision.
   */
  readonly detail?: Readonly<Record<string, unknown>>;
  /**
   * AW-03: the agent's answer beside a message the person just kept, or why
   * there is none, where the deployment answers conversations. Absent, the
   * message is kept and nothing answers it.
   */
  readonly reply?: ConversationReply;
}

export type ConversationReply =
  | {
      readonly answered: true;
      readonly messageId: string;
      readonly body: string;
      /** AW-04: the plan version a planning reply composed, drawn as a card. */
      readonly plan?: PlanOffer;
    }
  | { readonly answered: false; readonly code: string; readonly words: string };

/**
 * A refusal as it arrives over HTTP: the server's one refusal shape, taken
 * type-only through the wire contract, so the browser declares no second one.
 * `isWireRefusal` still checks the flag and the code on the parsed body before
 * anything reads it. `code` is what code branches on; `names` and `fixes` are
 * what a person reads, and this module never rewrites either (checklist B7, N3).
 */
export type WireRefusal = CommandRefusal;

/** The transport did not produce an answer at all. Not a refusal: an absence. */
export interface Unavailable {
  readonly unavailable: true;
  /** Why, in words, for the reader. Never a stand-in for a server's refusal. */
  readonly because: string;
}

export type CallResult<T> = { readonly ok: true; readonly value: T } | WireRefusal | Unavailable;

export function isRefusal<T>(result: CallResult<T>): result is WireRefusal {
  return 'refused' in result;
}

export function isUnavailable<T>(result: CallResult<T>): result is Unavailable {
  return 'unavailable' in result;
}

/** What `account/factor/verify` answers: only the access token is read, once, to trade it. */
export interface FactorVerified {
  readonly accessToken?: unknown;
}

/**
 * What `account/factor/enrol` answers (`IssuedFactor`): the secret goes to the person once. It
 * is drawn and dropped, and never stored, logged or put in an error.
 */
export interface IssuedFactor {
  readonly factorId: string;
  readonly qrCode: string;
  readonly secret: string;
  readonly uri: string;
}

/** What `account/factor/remove` answers. */
export interface FactorRemoved {
  readonly removed: true;
}
