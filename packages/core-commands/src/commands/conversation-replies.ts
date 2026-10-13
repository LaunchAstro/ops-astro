// SPDX-License-Identifier: AGPL-3.0-only
//
// What the conversation exchange hands back beside an applied message
// (`conversation-exchange.ts`): the kept answer, or a refusal in fixed words,
// never the model's or the person's.

import type { Cite } from './conversation-context.ts';

/** What the person path hands back beside an applied message: the answer, or why none. */
export type ConversationReply =
  | {
      readonly answered: true;
      readonly messageId: string;
      readonly body: string;
      /** The records the call read, by the product's own address. */
      readonly cites: readonly Cite[];
    }
  | { readonly answered: false; readonly code: string; readonly words: string };

const OFF =
  'Models are off for this material until a local model is available, so nothing was sent. ' +
  'Your message is kept.';

const WORDS: Readonly<Record<string, string>> = {
  LOCAL_MODEL_REQUIRED: OFF,
  CLIENT_MODEL_USE_OFF: OFF,
  RATE_LIMITED: 'The model is busy, so nothing was sent. Your message is kept; ask again shortly.',
  MODEL_NOT_OFFERED:
    'The model chosen for this conversation is not offered for it now, so nothing was sent. ' +
    'Your message is kept; choose another model.',
  BUDGET_UNAVAILABLE:
    'The chat sends only to models that cost nothing per message, so nothing was sent. ' +
    'Your message is kept; choose another model.',
  LOCAL_PLAN_LIMIT:
    'The ChatGPT plan is at its usage limit, so there is no answer. ' +
    'Your message is kept; ask again once the plan resets.',
  GPT_SIGNED_OUT:
    'GPT is not signed in to the ChatGPT plan, so nothing was sent. ' +
    'Your message is kept; choose another model, or have GPT signed in again.',
  GPT_WEEK_RESERVED:
    'GPT’s weekly allowance is nearly used, so nothing was sent. ' +
    'Your message is kept; choose another model.',
  GPT_USAGE_UNKNOWN:
    'The ChatGPT plan did not confirm GPT may be used now, so nothing was sent. ' +
    'Your message is kept; ask again shortly, or choose another model.',
  MODEL_MACHINE_AWAY:
    'The machine that runs this model is not answering, so nothing was sent. ' +
    'Your message is kept; ask again shortly.',
  MODEL_MACHINE_BUSY:
    'The machine that runs this model is busy with other work, so nothing was sent. ' +
    'Your message is kept; ask again shortly.',
  CARRIAGE_UNAVAILABLE:
    'The model could not be reached, so nothing was sent. Your message is kept; ask again.',
  AUTHORITY_BUSY:
    'Your access was being changed at that moment, so nothing was sent. ' +
    'Your message is kept; ask again.',
  SEND_LAPSED:
    'The model was not reached in time, so nothing was sent. Your message is kept; ask again.',
  ANSWER_ENDED:
    'The answer to this message ended and nothing was kept. Send your message again to ask again.',
  STILL_ANSWERING: 'The answer to this message is still on its way.',
  DECISION_STALE:
    'The answer did not finish, so nothing was kept. Your message is kept; ask again.',
};

/** Release reasons told in their own words; any other reads as a release. */
const OWN_WORDS: ReadonlySet<string> = new Set([
  'LOCAL_PLAN_LIMIT',
  'GPT_SIGNED_OUT',
  'GPT_WEEK_RESERVED',
  'GPT_USAGE_UNKNOWN',
  'MODEL_MACHINE_AWAY',
  'MODEL_MACHINE_BUSY',
  'CARRIAGE_UNAVAILABLE',
  'AUTHORITY_BUSY',
  'SEND_LAPSED',
]);

const UNUSABLE =
  'The model’s answer could not be used, so nothing was kept. Your message is kept; ask again.';

export const refusedWith = (code: string): ConversationReply => ({
  answered: false,
  code,
  words: WORDS[code] ?? UNUSABLE,
});

/**
 * A released call: a reason with words of its own says what happened (the
 * plan at its limit says to wait for the reset, not to ask again now); any
 * other reads as a release.
 */
export const releasedWith = (reason: string): ConversationReply =>
  refusedWith(OWN_WORDS.has(reason) ? reason : 'CALL_RELEASED');

export interface Kept {
  readonly id: string;
  readonly body: string;
}

export const answered = (reply: Kept, cites: readonly Cite[]): ConversationReply => ({
  answered: true,
  messageId: reply.id,
  body: reply.body,
  cites,
});
