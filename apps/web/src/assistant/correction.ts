// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's one-word site correction, its pure pieces.
//
// **The request door.** A person names the page, the word and its
// replacement in three fields; nothing they type is parsed. The request goes
// through one typed port (`ProposePort`), the sidebar's call to
// `site.source.propose`. That command is not on this build yet, so the drawer
// takes the port from its host and draws no door without one.
//
// **The state.** `live_correction.read` answers the correction's state as the
// request and decide commands name it. The card says it in one of seven
// words, through an explicit table: a state the table does not name is
// `unknown`, never guessed at.
//
// **The refusal.** The port and the decision refuse with a code. The door says it in plain
// words from an explicit table; a code the table does not name gets one
// fixed sentence, so no code reaches the person as it came.

export interface CorrectionAsk {
  /** The page of the site, as the person named it ("About"). */
  readonly page: string;
  readonly word: string;
  readonly replacement: string;
}

/** What the port answers: the correction it asked for, or the code it was refused with. */
export type ProposeAnswer =
  | { readonly ok: true; readonly correctionId: string }
  | { readonly ok: false; readonly code: string };

/** The sidebar's one call to `site.source.propose`. */
export type ProposePort = (ask: CorrectionAsk) => Promise<ProposeAnswer>;

export type CardState =
  | 'requested'
  | 'approved'
  | 'published'
  | 'reverted'
  | 'failed'
  | 'declined'
  | 'cancelled'
  | 'unknown';

const STATES: Readonly<Record<string, CardState>> = {
  requested: 'requested',
  approved: 'approved',
  accepted: 'approved',
  live: 'published',
  reverted: 'reverted',
  failed: 'failed',
  unknown: 'unknown',
  rejected: 'declined',
  cancelled: 'cancelled',
};

/** The card's state for the state `live_correction.read` answered. */
export const cardState = (state: string): CardState =>
  Object.hasOwn(STATES, state) ? (STATES[state] ?? 'unknown') : 'unknown';

export const STATE_WORDS: Readonly<Record<CardState, string>> = {
  requested: 'Requested: waiting for the configured approver.',
  approved: 'Approved. Not published yet.',
  published: 'Published on the site.',
  reverted: 'Reverted: the site reads as it did before.',
  failed: 'Failed: the site was not changed.',
  declined: 'Declined: the site was not changed.',
  // Cancelled after a decision, the publish may already have gone out (correction-receipts.ts).
  cancelled: 'Cancelled. If it was sent before it was cancelled, a person checks the live page.',
  unknown: 'Unknown: whether the site changed is not known. A person will check.',
};

const REFUSALS: Readonly<Record<string, string>> = {
  CHANGE_ENVELOPE_EXCEEDED:
    'Only one word for one word, on one line of one page, can be asked for.',
  FIELD_VALUE_INVALID: 'Name the page, the word and the word it becomes.',
  NOT_FOUND: 'That page, task or correction is not one you can reach here.',
  SCOPE_NOT_GRANTED: 'You do not hold the grant to ask for or decide a change to this site.',
  CORRECTION_PARTY_MISMATCH:
    'That page belongs to another client than the task it was asked under.',
  APPROVER_NOT_CONFIGURED: 'No approver is named for site changes yet. An administrator names one.',
  APPROVER_NOT_CONFIGURED_ONE: 'Only the configured approver decides a site change.',
  SELF_APPROVAL_REFUSED: 'A second person decides a change you asked for.',
  GATE_ALREADY_DECIDED: 'This change is decided already.',
  VERSION_STALE: 'The change moved since it was read. It is read again; decide once more.',
  DELEGATION_NARROWED: 'This agent may no longer ask for site changes.',
  DELEGATION_NOT_LIVE: 'This agent may no longer ask for site changes.',
  DELEGATION_OUT_OF_PURPOSE: 'This agent may not ask for site changes.',
  CONTENT_DRIFTED: 'The page changed since it was read. Ask again.',
  PROPOSAL_INCOMPLETE: 'The change was only partly prepared. Nothing was published.',
  WORD_NOT_FOUND: 'That word is not on that page.',
  UNAVAILABLE:
    'No answer came back, so whether it went through is not known. Look before asking again.',
};

const REFUSED = 'Refused: nothing was sent to the site.';

/** A refusal's code in plain words: the table's, or one fixed sentence. */
export const refusalWords = (code: string): string =>
  Object.hasOwn(REFUSALS, code) ? (REFUSALS[code] ?? REFUSED) : REFUSED;

const isLetter = (char: string | undefined): boolean =>
  char !== undefined && /^[\p{L}\p{N}'’-]$/u.test(char);

/** The text with the first whole `word` replaced, or null where it is not there. */
export function replaced(text: string, word: string, replacement: string): string | null {
  let at = word === '' ? -1 : text.indexOf(word);
  while (at !== -1) {
    if (!isLetter(text[at - 1]) && !isLetter(text[at + word.length])) {
      return `${text.slice(0, at)}${replacement}${text.slice(at + word.length)}`;
    }
    at = text.indexOf(word, at + 1);
  }
  return null;
}
