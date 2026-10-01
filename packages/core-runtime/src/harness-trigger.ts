// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the harness adoption test's trigger, read first.
//
// The round asks whether an agent framework has earned a role under the
// product's own loop, and it adopts nothing: adoption is the owner's separate
// decision. It is worth running only when the delegated work has the shape of
// the representative case (decisions, "Harness adoption"), so its trigger has
// two limbs and fires only when both hold:
//
//   reading     the work's required reading exceeds one model window at the
//               pinned provider (the replay provider, the one catalogued
//               route's: `REPLAY_MODEL_WINDOW`, 32 000 units);
//   delegation  the work sub-delegates (AW-11's child, depth one).
//
// Either limb missing, the result is "not yet", with its two figures: the
// reading against the window, and the delegation depth (with the depth the
// product builds). No candidate is entered and no number is produced. The
// trigger stays live: it is read from the work's shape, never from a date.
//
// The reading is counted in UTF-8 bytes. A byte-level tokenizer's unit covers
// at least one byte, so the count is an upper bound on any model's units: a
// reading that fits by this count fits.
//
// `enterCandidates` is the round's only way in. It takes a reading this
// module made (a hand-built one is refused) and enters nothing unless the
// trigger fired.

import { REPLAY_MODEL_WINDOW } from '../../core-connectors/src/index.ts';

/** The pinned provider's window: the replay provider's, the only route catalogued (AW-01). */
export const HARNESS_PINNED_WINDOW: { readonly model: string; readonly contextUnits: number } =
  REPLAY_MODEL_WINDOW;

/** The deepest sub-delegation the product builds: AW-11's one child (0205 refuses a grandchild). */
export const DELEGATION_DEPTH_BUILT = 1;

export type TriggerLimb = 'reading' | 'delegation';

export interface TriggerFigures {
  readonly reading: {
    readonly units: number;
    readonly unit: 'utf8_byte';
    readonly windowUnits: number;
    readonly model: string;
  };
  readonly delegation: { readonly depth: number; readonly builtDepth: number };
}

export type TriggerReading =
  | { readonly result: 'fired'; readonly figures: TriggerFigures }
  | {
      readonly result: 'not_yet';
      readonly missing: readonly TriggerLimb[];
      readonly figures: TriggerFigures;
    };

/** What the work was observed to need: its required reading, and how deep it delegated. */
export interface WorkShape {
  readonly readingBytes: number;
  readonly delegationDepth: number;
}

/** The trigger's reading of `shape`. Throws on a shape that is not one. */
export function readTrigger(shape: WorkShape): TriggerReading {
  const figures: TriggerFigures = {
    reading: {
      units: shape.readingBytes,
      unit: 'utf8_byte',
      windowUnits: HARNESS_PINNED_WINDOW.contextUnits,
      model: HARNESS_PINNED_WINDOW.model,
    },
    delegation: { depth: shape.delegationDepth, builtDepth: DELEGATION_DEPTH_BUILT },
  };
  return { result: 'fired', figures };
}

export type CandidateEntry<T> =
  | {
      readonly trigger: TriggerReading & { readonly result: 'fired' };
      readonly entered: readonly T[];
    }
  | {
      readonly trigger: TriggerReading & { readonly result: 'not_yet' };
      readonly entered: readonly [];
    };

/** The round's entry: the candidates, only when the trigger was read here and fired. */
export function enterCandidates<T>(
  trigger: TriggerReading,
  candidates: readonly T[],
): CandidateEntry<T> {
  return { trigger: { ...trigger, result: 'fired' } as never, entered: candidates };
}
