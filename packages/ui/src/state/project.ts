// SPDX-License-Identifier: AGPL-3.0-only
//
// The seam between the vocabulary the runtime stores and the vocabulary a
// surface draws, and the only place the two meet.
//
// **They are not the same eight and not the same eleven.** `runs.state` holds
// eight lower-case machine states and `steps.state` holds six
// (`migrations/0008_runtime.sql:99`, `:215`); the pinned mockup draws eight
// title-case run words and eleven lower-case step words (specification 13.2).
// One is a state machine and the other is a reading, so a projection is
// required rather than optional, and writing it as a lookup with a total
// fallback is what carries the unknown-state rule.
//
// Three properties this module is written to have.
//
// It is **total**. Every string in produces a drawn state out. A projection
// that can return nothing is a projection that draws nothing, which is the
// silent-drop the rule forbids.
//
// It **says where each word came from**. `reference` is `pinned` when the
// mockup drew the word, `new_behaviour` when the slice draws it and the
// mockup has no drawing for it, and `unknown` when nothing recognised the
// state and the raw string is being printed. A surface stamps that on the
// element, so a reader can tell a ported word from a new one from a fallback
// without reading this file.
//
// It **does not collapse a distinction the database keeps**. `observed` and
// `settled` are different steps, and `cancelled` and
// `cancelled_may_have_completed` are different runs, on the owner's own
// instruction ([C16-5]). Mapping either pair onto one word would destroy in
// the reading exactly what the migration's constraints exist to preserve.

import {
  PINNED_RUN_STATES,
  PINNED_RUN_TONE,
  PINNED_STEP_STATES,
  PINNED_STEP_TONE,
  PINNED_STEP_WORD,
  type Tone,
} from './corpus.ts';

/** Where a drawn word came from. Stamped on the element, not inferred. */
export type StateReference = 'pinned' | 'new_behaviour' | 'unknown';

export interface DrawnState {
  /** The word a person reads. Never empty. */
  readonly word: string;
  readonly tone: Tone;
  readonly reference: StateReference;
}

/** What a stored run looks like to a reading. Two fields, because a bare
 * `waiting` is not a state on a screen — the reason is the state. */
export interface StoredRun {
  readonly state: string;
  readonly waitReason: string | null;
}

interface DrawnEntry {
  readonly word: string;
  readonly tone: Tone;
  readonly reference: StateReference;
}

const pinned = (word: string, tone: Tone): DrawnEntry => ({ word, tone, reference: 'pinned' });
const drawn = (word: string, tone: Tone): DrawnEntry => ({
  word,
  tone,
  reference: 'new_behaviour',
});

/**
 * Stored run state to drawn word.
 *
 * `Staged` and `Rolled back` are two of the mockup's eight and are absent from
 * the right-hand side deliberately: the runtime spells the first as a wait on
 * approval, and the second needs a reversal T1 does not have. `unreachedRunWords`
 * reports both rather than letting the gap go unnoticed.
 */
const RUN_STATE: Readonly<Record<string, DrawnEntry>> = {
  requested: pinned('Queued', 'wait'),
  claimed: pinned('Triage', 'wait'),
  running: pinned('Executing', 'run'),
  settled: pinned('Live', 'done'),
  failed: pinned('Failed', 'bad'),
  // A person's stop. It never becomes a drop ([execution-owner CONTRACT.md:322]).
  cancelled: drawn('Cancelled', 'wait'),
  // And the one the reconciliation check could not resolve. Kept apart from the
  // line above because "we stopped because we could not prove nothing happened"
  // is a different root cause from "a person decided to stop this".
  cancelled_may_have_completed: drawn('Cancelled — may have completed', 'bad'),
};

/**
 * A wait names the fact it waits on, so the reason is what gets drawn.
 *
 * The three `dropped_*` reasons are three words and never one. Nathan's
 * instruction is that a provider outage must not be conflated with somebody
 * manually cancelling a job ([C16-5]), and a single word for three causes is
 * that conflation in the one place a person actually looks.
 */
const WAIT_REASON: Readonly<Record<string, DrawnEntry>> = {
  needs_approval: pinned('Awaiting approval', 'gate'),
  needs_input: drawn('Awaiting input', 'gate'),
  waiting_budget: drawn('Awaiting budget', 'gate'),
  awaiting_dependency: drawn('Awaiting a dependency', 'wait'),
  dropped_provider_unavailable: drawn('Dropped — the provider did not answer', 'bad'),
  dropped_connection_lost: drawn('Dropped — the connection was lost', 'bad'),
  dropped_worker_lost: drawn('Dropped — our worker was lost', 'bad'),
};

/**
 * Stored step state to drawn word.
 *
 * Six stored states, and only three of them have a mockup word. `observed` is
 * drawn apart from `settled` because the gap between them is precisely the
 * runtime case this slice exists to prove — a crash after apply and before
 * settle shows an unsettled state — and a reading that says "Done" for both
 * hides it. `unplanned` is a step that was observed and never planned, which
 * specification 14.4 requires be shown rather than reconciled away.
 */
const STEP_STATE: Readonly<Record<string, DrawnEntry>> = {
  planned: pinned('Pending', PINNED_STEP_TONE.pending),
  dispatched: pinned('Running', PINNED_STEP_TONE.running),
  settled: pinned('Done', PINNED_STEP_TONE.done),
  observed: drawn('Observed, not settled', 'run'),
  unknown: drawn('Outcome unknown', 'bad'),
  unplanned: drawn('Unplanned — it ran and the plan did not contain it', 'bad'),
};

/**
 * The unknown-state rule, in one place.
 *
 * An unrecognised state still prints, as its own raw string at the waiting
 * tone. A state the contract grew and this table has not caught up with must
 * be visible, not silently dropped — the difference between a gap and a silent
 * wrong answer. Only the total absence of a state reads `Unknown`, because
 * "there is no state" and "there is a state I do not know" are different facts
 * (`assets/taskgraph.js:107`).
 */
function fallback(state: string): DrawnState {
  const raw = state.trim();
  return raw === ''
    ? { word: 'Unknown', tone: 'wait', reference: 'unknown' }
    : { word: raw, tone: 'wait', reference: 'unknown' };
}

export function drawRunState(run: StoredRun): DrawnState {
  if (run.state === 'waiting') {
    const reason = run.waitReason;
    const drawnReason = reason === null ? undefined : WAIT_REASON[reason];
    if (drawnReason !== undefined) return drawnReason;
    // A wait whose reason this table does not know is still a wait, and the
    // reason is the more informative half, so the reason is what prints.
    return fallback(reason ?? 'waiting');
  }
  return RUN_STATE[run.state] ?? fallback(run.state);
}

export function drawStepState(state: string): DrawnState {
  return STEP_STATE[state] ?? fallback(state);
}

/** A word the mockup drew that this projection reads straight through. */
export function drawPinnedRunWord(word: string): DrawnState {
  const tone = PINNED_RUN_TONE[word as keyof typeof PINNED_RUN_TONE];
  return tone === undefined ? fallback(word) : { word, tone, reference: 'pinned' };
}

export function drawPinnedStepWord(state: string): DrawnState {
  const tone = PINNED_STEP_TONE[state as keyof typeof PINNED_STEP_TONE];
  const word = PINNED_STEP_WORD[state as keyof typeof PINNED_STEP_WORD];
  return tone === undefined || word === undefined
    ? fallback(state)
    : { word, tone, reference: 'pinned' };
}

/**
 * The words a run capability can draw: the mockup's eight plus every word this
 * projection mints. This is what the capability map's `states` field is checked
 * against, so a word added above and not registered fails the map's stale
 * state-set check rather than passing quietly.
 */
export const DRAWN_RUN_VOCABULARY: readonly string[] = [
  ...PINNED_RUN_STATES,
  ...Object.values(RUN_STATE)
    .concat(Object.values(WAIT_REASON))
    .map((entry) => entry.word)
    .filter((word) => !(PINNED_RUN_STATES as readonly string[]).includes(word)),
];

export const DRAWN_STEP_VOCABULARY: readonly string[] = [
  ...PINNED_STEP_STATES,
  ...Object.values(STEP_STATE)
    .filter((entry) => entry.reference === 'new_behaviour')
    .map((entry) => entry.word),
];

/**
 * The pinned words no stored state can reach.
 *
 * Reported rather than hidden: a corpus that lists a word nothing can produce
 * is a corpus that has stopped describing the product, and finding that out
 * from a test beats finding it out from a screen nobody could make appear.
 */
export function unreachedRunWords(): ReadonlySet<string> {
  const reached = new Set(
    Object.values(RUN_STATE)
      .concat(Object.values(WAIT_REASON))
      .map((entry) => entry.word),
  );
  return new Set(PINNED_RUN_STATES.filter((word) => !reached.has(word)));
}
