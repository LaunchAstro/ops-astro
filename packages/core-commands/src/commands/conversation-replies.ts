// SPDX-License-Identifier: AGPL-3.0-only
//
// What the conversation exchange hands back beside an applied message
// (`conversation-exchange.ts`): the kept answer, or a refusal in fixed words,
// never the model's or the person's.

import type { ConversationTargetsView, SitePageView } from '../../../core-wire/src/index.ts';
import type { Cite } from './conversation-context.ts';

/** What the person path hands back beside an applied message: the answer, or why none. */
export type ConversationReply =
  | {
      readonly answered: true;
      readonly messageId: string;
      readonly body: string;
      /** The records the call read, by the product's own address. */
      readonly cites: readonly Cite[];
      /** The tasks an edit it proposes may apply to, kept with it (#1666), as the caller may have them. */
      readonly targets?: ConversationTargetsView;
      /** The bound pages the call gave the model (#1988), which a site change card may name. */
      readonly sitePages?: readonly SitePageView[];
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
    'This model is not open to paid replies here, so nothing was sent. ' +
    'Your message is kept; choose another model.',
  PROMPT_TOO_LARGE:
    'This conversation is too long for the paid model, so nothing was sent or charged. ' +
    'Your message is kept; start a new conversation or choose another model.',
  CUSTODY_NOT_ADMITTED:
    'Your access or this conversation changed as the answer was being sent, so nothing was ' +
    'sent or charged. Your message is kept; ask again.',
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
  SUBSCRIPTION_SIGN_IN_NEEDED:
    'The ChatGPT plan needs the owner to sign in again, so nothing was sent. ' +
    'Your message is kept; choose another model, or ask the owner to sign in.',
  SUBSCRIPTION_REFRESH_FAILED:
    'The ChatGPT plan’s sign-in could not be renewed in time, so nothing was sent. ' +
    'Your message is kept; ask again shortly, or choose another model.',
  SUBSCRIPTION_STORE_FAILED:
    'The ChatGPT plan’s sign-in could not be kept safely, so nothing was sent. ' +
    'Your message is kept; choose another model.',
  SUBSCRIPTION_TOKEN_FILE_OPEN:
    'The ChatGPT plan’s sign-in is open to other users on its machine, so it was not used ' +
    'and nothing was sent. Your message is kept; choose another model.',
  SUBSCRIPTION_NOT_OWNER_STARTED:
    'The ChatGPT plan answers only work the owner started, so nothing was sent. ' +
    'Your message is kept; choose another model.',
  SUBSCRIPTION_OTHER_TENANT:
    'The ChatGPT plan belongs to another installation, so nothing was sent. ' +
    'Your message is kept; choose another model.',
};

/** Release reasons told in their own words; any other reads as a release. */
const OWN_WORDS: ReadonlySet<string> = new Set([
  'LOCAL_MODEL_REQUIRED',
  'LOCAL_PLAN_LIMIT',
  'GPT_SIGNED_OUT',
  'GPT_WEEK_RESERVED',
  'GPT_USAGE_UNKNOWN',
  'MODEL_MACHINE_AWAY',
  'MODEL_MACHINE_BUSY',
  'CARRIAGE_UNAVAILABLE',
  'AUTHORITY_BUSY',
  'SEND_LAPSED',
  'CUSTODY_NOT_ADMITTED',
  'SUBSCRIPTION_SIGN_IN_NEEDED',
  'SUBSCRIPTION_REFRESH_FAILED',
  'SUBSCRIPTION_STORE_FAILED',
  'SUBSCRIPTION_TOKEN_FILE_OPEN',
  'SUBSCRIPTION_NOT_OWNER_STARTED',
  'SUBSCRIPTION_OTHER_TENANT',
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

/** After the plan's call went out: no answer kept, nothing retried, the message kept. */
const PLAN_HELD: Readonly<Record<string, string>> = {
  SUBSCRIPTION_PLAN_ALLOWANCE:
    'The ChatGPT plan has reached its usage allowance, so no answer was kept and nothing was ' +
    'retried. Your message is kept; ask again once the plan resets.',
  SUBSCRIPTION_PLAN_UNAVAILABLE:
    'ChatGPT is unavailable just now, so no answer was kept and nothing was retried. ' +
    'Your message is kept; ask again shortly.',
  SUBSCRIPTION_NOT_ELIGIBLE:
    'The ChatGPT plan refused this account or model, so no answer was kept and nothing was ' +
    'retried. Your message is kept; choose another model.',
  SUBSCRIPTION_UNSUPPORTED_CAPABILITY:
    'The ChatGPT plan does not support what this message asked of it, so no answer was kept ' +
    'and nothing was retried. Your message is kept; choose another model.',
  SUBSCRIPTION_SIGN_IN_NEEDED:
    'The ChatGPT plan needs the owner to sign in again, so no answer was kept and nothing was ' +
    'retried. Your message is kept; choose another model, or ask the owner to sign in.',
  SUBSCRIPTION_ANSWER_WITHHELD:
    'The ChatGPT plan’s call did not end in a clean answer, so no answer was kept and nothing ' +
    'was retried. Your message is kept; ask again.',
};

/** What the plan answered, as a named result. */
const heldCode = (providerCode: string | null): string => {
  if (providerCode === 'http_429') return 'SUBSCRIPTION_PLAN_ALLOWANCE';
  if (providerCode !== null && /^http_5\d\d$/u.test(providerCode)) {
    return 'SUBSCRIPTION_PLAN_UNAVAILABLE';
  }
  if (providerCode === 'http_403') return 'SUBSCRIPTION_NOT_ELIGIBLE';
  if (providerCode === 'http_400') return 'SUBSCRIPTION_UNSUPPORTED_CAPABILITY';
  if (providerCode === 'http_401') return 'SUBSCRIPTION_SIGN_IN_NEEDED';
  return 'SUBSCRIPTION_ANSWER_WITHHELD';
};

/**
 * A call on the ChatGPT plan held unknown after its write, told by what the
 * plan answered (`providerCode`, such as `http_429`, or null): the call went
 * out, so the words say no answer was kept and nothing was retried, never
 * that nothing was sent.
 */
export const planHeldWith = (providerCode: string | null): ConversationReply => {
  const code = heldCode(providerCode);
  return { answered: false, code, words: PLAN_HELD[code] ?? UNUSABLE };
};

/** Whole AUD cents as the panel shows money: `AUD 12.34`. */
const aud = (minor: number): string =>
  `AUD ${String(Math.trunc(minor / 100))}.${String(minor % 100).padStart(2, '0')}`;

/** A paid reply past what the AI chat budget has left (#1508). */
export const budgetWith = (leftMinor: number | undefined): ConversationReply =>
  leftMinor === undefined
    ? refusedWith('BUDGET_UNAVAILABLE')
    : {
        answered: false,
        code: 'BUDGET_UNAVAILABLE',
        words:
          `The AI chat budget has ${aud(leftMinor)} left, not enough for this reply, so nothing ` +
          'was sent. Your message is kept; choose a free model, or ask an owner to raise the budget.',
      };

/** A paid reply whose cost is not known: its most stays set aside (#1508). */
export const heldWith = (heldMinor: number): ConversationReply => ({
  answered: false,
  code: 'LIABILITY_UNKNOWN',
  words:
    `This reply's cost is not known yet. ${aud(heldMinor)} stays set aside until an owner ` +
    'records what happened. Nothing was kept; send your message again to ask again.',
});

export interface Kept {
  readonly id: string;
  readonly body: string;
  readonly targets?: ConversationTargetsView;
}

/** A kept reply as handed back; a fresh call's answer carries the pages it gave the model. */
export const answered = (
  reply: Kept,
  cites: readonly Cite[],
  sitePages: readonly SitePageView[] = [],
): ConversationReply => ({
  answered: true,
  messageId: reply.id,
  body: reply.body,
  cites,
  ...(reply.targets === undefined ? {} : { targets: reply.targets }),
  ...(sitePages.length === 0 ? {} : { sitePages }),
});
