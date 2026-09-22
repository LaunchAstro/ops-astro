// SPDX-License-Identifier: AGPL-3.0-only
//
// The drawn state corpus: every state a first-slice surface may print.
//
// Taken from the pinned mockup rather than invented (specification 13.2, and
// [ui-reference CONTRACT.md:97]): eight run states in title case, eleven step
// states in lower case, five tones and no sixth, three node kinds derived and
// never stored, two gate presentation states and six read outcomes. Every
// literal below is quoted from `assets/taskrun.js:47` and
// `assets/taskgraph.js:89` at revision 7066bad.
//
// **This is the vocabulary a surface DRAWS, not the vocabulary the database
// stores.** The runtime T1i landed keeps eight lower-case machine run states
// and six step states (`migrations/0008_runtime.sql:99` and `:215`); the
// mockup draws a different eight and a different eleven, because one is a
// state machine and the other is a reading. `project.ts` is the seam between
// them, and it is the only place the two vocabularies meet.

/**
 * Five tones and no sixth. A sixth is a change to the design system, not a
 * slice decision ([ui-reference CONTRACT.md:105]).
 */
export type Tone = 'wait' | 'run' | 'gate' | 'done' | 'bad';

export const TONES: readonly Tone[] = ['wait', 'run', 'gate', 'done', 'bad'];

/** The mockup's eight, title case, verbatim (`assets/taskrun.js:49`). */
export type PinnedRunState =
  | 'Queued'
  | 'Triage'
  | 'Executing'
  | 'Staged'
  | 'Awaiting approval'
  | 'Live'
  | 'Rolled back'
  | 'Failed';

export const PINNED_RUN_TONE: Readonly<Record<PinnedRunState, Tone>> = {
  Queued: 'wait',
  Triage: 'wait',
  Executing: 'run',
  Staged: 'run',
  'Awaiting approval': 'gate',
  Live: 'done',
  'Rolled back': 'bad',
  Failed: 'bad',
};

export const PINNED_RUN_STATES: readonly PinnedRunState[] = [
  'Queued',
  'Triage',
  'Executing',
  'Staged',
  'Awaiting approval',
  'Live',
  'Rolled back',
  'Failed',
];

/**
 * The mockup's eleven, lower case, verbatim (`assets/taskgraph.js:95`).
 *
 * **The pinned mockup carries two tone tables for these and they disagree.**
 * `assets/taskgraph.js:95` has eleven keys with `blocked: 'gate'`;
 * `assets/taskrun.js:56` has nine, missing `rejected` and `invalidated`, and
 * has `blocked: 'wait'`. The contract names the graph's table as the corpus
 * ("eleven step states ... `assets/taskgraph.js`, `JOB_WORD`"), so the graph's
 * is the one table here and the divergence is recorded in `DECISIONS.tsv`
 * rather than averaged.
 */
export type PinnedStepState =
  | 'pending'
  | 'running'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'refused'
  | 'superseded'
  | 'waiting'
  | 'approved'
  | 'rejected'
  | 'invalidated';

export const PINNED_STEP_TONE: Readonly<Record<PinnedStepState, Tone>> = {
  pending: 'wait',
  running: 'run',
  done: 'done',
  blocked: 'gate',
  failed: 'bad',
  refused: 'bad',
  superseded: 'wait',
  waiting: 'gate',
  approved: 'done',
  rejected: 'bad',
  invalidated: 'wait',
};

export const PINNED_STEP_WORD: Readonly<Record<PinnedStepState, string>> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
  refused: 'Refused',
  superseded: 'Superseded',
  waiting: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
  invalidated: 'Invalidated',
};

export const PINNED_STEP_STATES: readonly PinnedStepState[] = [
  'pending',
  'running',
  'done',
  'blocked',
  'failed',
  'refused',
  'superseded',
  'waiting',
  'approved',
  'rejected',
  'invalidated',
];

/**
 * Three node kinds, derived and never stored (`assets/taskgraph.js:110`).
 * `terminal` is out-degree over the dependency records, so it is a fact about
 * the graph rather than a flag somebody remembered to set.
 */
export type NodeKind = 'gate' | 'terminal' | 'job';

export const NODE_KINDS: readonly NodeKind[] = ['gate', 'terminal', 'job'];

/**
 * Two gate presentation states. Staleness is derived by comparing the
 * artefact's current version to the bound one, never read from a stored field,
 * because a stored field is free to disagree with the artefact
 * (`assets/taskgraph.js:497`).
 */
export type GatePresentation = 'armed' | 'stale';

export const GATE_PRESENTATIONS: readonly GatePresentation[] = ['armed', 'stale'];

/**
 * Six read outcomes. **This is the one place the slice is more explicit than
 * either source** (specification 13.2): the legacy converges failed, denied
 * and no-run reads onto one empty not-reporting record, and the pinned mockup
 * has no read at all — every accessor is a synchronous filter over seeded
 * arrays, so it has no `loading` and no `denied`.
 */
export type ReadOutcome = 'loading' | 'no-run' | 'denied' | 'unavailable' | 'stale' | 'ready';

export const READ_OUTCOMES: readonly ReadOutcome[] = [
  'loading',
  'no-run',
  'denied',
  'unavailable',
  'stale',
  'ready',
];

/**
 * Three absence voices, and they must stay distinct.
 *
 * `no-rows` says there is nothing here; `input-wrong` says this input is
 * wrong; `not-built` says the product has not built this yet. The third has no
 * mockup idiom at all — the string `in-dev` does not occur anywhere in the
 * pinned mockup, because it ships populated demonstration data — so it is
 * adopted from the Hub's `.in-dev` with its own acceptance rather than as an
 * inherited authority ([ui-reference CONTRACT.md:176]).
 */
export type AbsenceVoice = 'no-rows' | 'input-wrong' | 'not-built';

export const ABSENCE_VOICES: readonly AbsenceVoice[] = ['no-rows', 'input-wrong', 'not-built'];
