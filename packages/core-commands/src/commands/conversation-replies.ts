// SPDX-License-Identifier: AGPL-3.0-only
//
// What the conversation exchange hands back beside an applied message
// (`conversation-exchange.ts`): the kept answer, or a refusal in fixed words,
// never the model's or the person's.

/** What the person path hands back beside an applied message: the answer, or why none. */
export type ConversationReply =
  | { readonly answered: true; readonly messageId: string; readonly body: string }
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
};

const UNUSABLE =
  'The model’s answer could not be used, so nothing was kept. Your message is kept; ask again.';

export const refusedWith = (code: string): ConversationReply => ({
  answered: false,
  code,
  words: WORDS[code] ?? UNUSABLE,
});

export interface Kept {
  readonly id: string;
  readonly body: string;
}

export const answered = (reply: Kept): ConversationReply => ({
  answered: true,
  messageId: reply.id,
  body: reply.body,
});
