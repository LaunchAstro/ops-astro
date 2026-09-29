// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e's verdict: when one mutation's run proves its check bites, and when the
// whole run proves every invariant does (`every_invariant_bites`). T4-N4
// reverts every T2 and T3 part (split section 3.2, row T4e); T4a to T4d are
// test tooling, each proven by its own planted-mutation cases (`T4-P`).

import { PARTS, type CaseLine, type Part, type Ran } from './catalogue.ts';

/**
 * For a part's revert (`T4-N4 <part>`), red means the part's own named
 * invariant failed: a sibling case, a file that no longer loads or a hook
 * does not stand in for it. An isolation case that stays green under the
 * revert fails the line by name, since it then proves nothing about the part.
 */
function partVerdict(part: Part, ran: Ran): string | undefined {
  const cases = ran.cases ?? [];
  const silent = part.invariants.filter(
    (name) => !cases.some((one) => !one.passed && one.name.includes(name)),
  );
  if (silent.length > 0) return `its named invariant did not fail: ${silent.join(', ')}`;
  const green = cases.filter((one) => one.passed && /isolation/iu.test(one.name));
  if (green.length > 0) {
    return `an isolation case stayed green: ${green.map((one) => one.name).join('; ')}`;
  }
  return undefined;
}

/**
 * For a T4 part (`T4-P <part>`), test tooling that no revert can prove: its
 * planted-mutation cases plant the fault and assert the failure, so the line
 * is proven when each one ran and passed under the part's named invariant.
 */
function plantedVerdict(part: Part, ran: Ran): string | undefined {
  const caught = (name: string): boolean =>
    (ran.cases ?? []).some(
      (one) =>
        one.passed &&
        one.name.includes(name) &&
        part.invariants.some((invariant) => one.name.includes(invariant)),
    );
  const missed = (part.planted ?? []).filter((name) => !caught(name));
  return missed.length > 0
    ? `its planted mutation was not caught: ${missed.join('; ')}`
    : undefined;
}

/** The line a part must hold: a revert for a T2 or T3 part, its planted cases for a T4 part. */
export const lineOf = (part: Part): string =>
  `${part.planted === undefined ? 'T4-N4' : 'T4-P'} ${part.id}`;

const partOf = (name: string): Part | undefined => {
  const line = /^T4-(?:N4|P) ([A-Za-z0-9]+)\b/u.exec(name);
  const part = PARTS.find((one) => one.id === line?.[1]);
  // A part is held only by its own kind of line: a T4 part's revert holds nothing.
  return part !== undefined && line?.[0] === lineOf(part) ? part : undefined;
};

export function classify(name: string, ran: Ran): CaseLine {
  const fail = (why: string): CaseLine => ({
    case: name,
    status: 'fail',
    detail: `${why} (${ran.detail})`,
  });
  if (!ran.applied) return fail('the mutation changed nothing, so it proves nothing');
  if (ran.executed === 0) return fail('nothing ran under the mutation');
  const part = partOf(name);
  if (part?.planted !== undefined) {
    const missed = plantedVerdict(part, ran);
    if (missed !== undefined) return fail(missed);
    const said = `${part.invariants.join(', ')}: ${part.planted.join('; ')}`;
    return { case: name, status: 'pass', detail: `its planted mutation caught: ${said}` };
  }
  if (!ran.red) return fail('stayed green under its mutation');
  const why = part === undefined ? undefined : partVerdict(part, ran);
  if (why !== undefined) return fail(why);
  const named = part === undefined ? '' : `${part.invariants.join(', ')} failed; `;
  return { case: name, status: 'pass', detail: `red under its mutation: ${named}${ran.detail}` };
}

/** The unmutated control: the same check must be green, with something run, before a red means anything. */
export function control(name: string, ran: Ran): CaseLine {
  const green = ran.executed > 0 && !ran.red;
  return {
    case: name,
    status: green ? 'pass' : 'fail',
    detail: green ? `green unmutated: ${ran.detail}` : `not green unmutated: ${ran.detail}`,
  };
}

/**
 * Every mutation the run must hold a line for: T4-N1, T4-N2, three T4-N3,
 * each T2 and T3 part's T4-N4 and each T4 part's T4-P.
 */
function missingLines(lines: readonly CaseLine[], parts: readonly Part[]): string[] {
  const count = (prefix: RegExp): number => lines.filter((line) => prefix.test(line.case)).length;
  const missing = parts
    .filter((part) => !lines.some((line) => partOf(line.case)?.id === part.id))
    .map((part) => lineOf(part));
  if (count(/^T4-N1\b/u) === 0) missing.unshift('T4-N1');
  if (count(/^T4-N2\b/u) === 0) missing.unshift('T4-N2');
  if (count(/^T4-N3\b/u) < 3) missing.unshift('T4-N3 (three checks)');
  return missing;
}

export function everyInvariantBites(
  lines: readonly CaseLine[],
  parts: readonly Part[] = PARTS,
): CaseLine {
  const short = lines.filter((line) => line.status !== 'pass').map((line) => line.case);
  const missing = missingLines(lines, parts);
  const status = short.length === 0 && missing.length === 0 ? 'pass' : 'fail';
  const said: string[] = [];
  if (missing.length > 0) said.push(`missing: ${missing.join('; ')}`);
  if (short.length > 0) said.push(`not proven: ${short.join('; ')}`);
  const detail =
    status === 'pass'
      ? `${String(lines.length)} checks, each green unmutated and red under its own mutation`
      : said.join('; ');
  return { case: 'every_invariant_bites', status, detail };
}
