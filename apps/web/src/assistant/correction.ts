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
// **The refusal.** The port refuses with a code. The door says it in plain
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
  'requested' | 'approved' | 'published' | 'reverted' | 'failed' | 'declined' | 'unknown';

const STATES: Readonly<Record<string, CardState>> = {
  requested: 'requested',
  approved: 'approved',
  accepted: 'approved',
  live: 'published',
  reverted: 'reverted',
  failed: 'failed',
  unknown: 'unknown',
  rejected: 'declined',
  cancelled: 'declined',
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
  unknown: 'Unknown: whether the site changed is not known. A person will check.',
};

const REFUSALS: Readonly<Record<string, string>> = {
  CHANGE_ENVELOPE_EXCEEDED:
    'Only one word for one word, on one line of one page, can be asked for.',
  FIELD_VALUE_INVALID: 'Name the page, the word and the word it becomes.',
  NOT_FOUND: 'That page is not one this site can change.',
  SCOPE_NOT_GRANTED: 'You do not hold the grant to ask for a change to this site.',
  APPROVER_NOT_CONFIGURED: 'No approver is named for site changes yet. An administrator names one.',
  CONTENT_DRIFTED: 'The page changed since it was read. Ask again.',
  PROPOSAL_INCOMPLETE: 'The change was only partly prepared. Nothing was published.',
  DELEGATION_OUT_OF_PURPOSE: 'This agent may not ask for site changes.',
};

const NOT_ASKED = 'The change was not asked for. Nothing was sent to the site.';

/** The refusal in plain words: the table's, or one fixed sentence. */
export const refusalWords = (code: string): string =>
  Object.hasOwn(REFUSALS, code) ? (REFUSALS[code] ?? NOT_ASKED) : NOT_ASKED;
