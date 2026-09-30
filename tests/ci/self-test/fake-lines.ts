// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e: made-up results for the verdict's tests (every_invariant_bites): one
// mutation's run, a part's revert that bites, a T4 part's planted cases
// caught, and a whole run with every line it must hold.

import {
  CONTROL_LINES,
  MUTATION_LINES,
  PARTS,
  classify,
  control,
  controlOf,
  lineOf,
  type CaseLine,
  type Ran,
} from './mutations.ts';

export const ran = (over: Partial<Ran>): Ran => ({
  applied: true,
  executed: 4,
  red: true,
  detail: '2 of 4 cases failed',
  ...over,
});

/** A part's revert under which its named invariants fail and nothing else is asserted. */
export const bites = (id: string): Ran => {
  const part = PARTS.find((one) => one.id === id);
  const names = part?.invariants ?? [];
  return ran({ cases: names.map((name) => ({ name: `${name}: the case`, passed: false })) });
};

/** A T4 part's file run unmutated: each planted-mutation case passed under its named invariant. */
export const caught = (id: string, passed = true): Ran => {
  const part = PARTS.find((one) => one.id === id);
  const [invariant] = part?.invariants ?? [];
  return ran({
    red: false,
    detail: '0 of 4 cases failed',
    cases: (part?.planted ?? []).map((name) => ({ name: `${String(invariant)} ${name}`, passed })),
  });
};

/** The split's T4e row: T4-N4 reverts every T2 and T3 part; T4a to T4d are test tooling. */
export const TOOLING: ReadonlySet<string> = new Set(['T4a', 'T4b1', 'T4b2', 'T4c', 'T4d']);

/** One passing line for every control and every mutation the whole run must hold. */
export const everyLine = (): CaseLine[] => [
  ...[...CONTROL_LINES, ...PARTS.map((part) => controlOf(part))].map((name) =>
    control(name, ran({ red: false })),
  ),
  ...MUTATION_LINES.map((name) => classify(name, ran({}))),
  ...PARTS.map((part) =>
    TOOLING.has(part.id)
      ? classify(`${lineOf(part)} planted`, caught(part.id))
      : classify(`${lineOf(part)} reverted`, bites(part.id)),
  ),
];

/** A T2 or T3 part's first declared crossing of `kind`. */
export const crossingOf = (id: string, kind: string): string => {
  const part = PARTS.find((one) => one.id === id);
  const found = part?.crossings?.find((one) => one.crosses.includes(kind as never));
  if (found === undefined) throw new Error(`${id} declares no ${kind} crossing`);
  return found.case;
};
