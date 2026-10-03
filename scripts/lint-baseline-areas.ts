// SPDX-License-Identifier: AGPL-3.0-only
// The lint baseline per area. Every lane edited lint-baseline.json, so it is
// split into lint-baseline/<area>.json, one file per area, where a warning's
// area is areaOf(the file it is in). These functions count, read, split and
// join without touching git; scripts/lint-ratchet.mjs does the rest.
//
// A rule recorded at 0 and a rule not recorded are the same count. Splitting
// refuses unless the current warnings equal the single file exactly, because
// a split from looser counts would lose the slack or invent an entry.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { areaOf } from './ci-areas.ts';

export type Rules = Record<string, number>;
export type Areas = Record<string, Rules>;
export type Baseline = { kind: 'areas'; areas: Areas } | { kind: 'total'; rules: Rules };
export interface Diagnostic {
  readonly code: string;
  readonly severity: string;
  readonly filename: string;
}
export interface Rise {
  readonly rule: string;
  readonly n: number;
  readonly was: number;
}
export interface AreaRise extends Rise {
  readonly area: string;
}
export interface AreaFile {
  readonly name: string;
  readonly text: string;
}

export const BASELINE = 'lint-baseline.json';
export const BASELINE_DIR = 'lint-baseline';
const AREA = /^[a-z0-9-]+$/u;

/**
 * A baseline's counts, each a whole number of at least 0. Anything else throws, because a
 * count that is not a number compares false against every warning and so would hide them.
 */
export const parseRules = (text: string, where: string): Rules => {
  let rules: unknown;
  try {
    ({ rules } = JSON.parse(text) as { rules?: unknown });
  } catch {
    throw new Error(`${where} is not JSON.`);
  }
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
    throw new Error(`${where} has no \`rules\` object.`);
  }
  for (const [rule, n] of Object.entries(rules)) {
    if (!Number.isInteger(n) || (n as number) < 0) {
      throw new Error(`${where}: ${rule} is ${JSON.stringify(n)}, not a count.`);
    }
  }
  return rules as Rules;
};

const add = (rules: Rules, rule: string, n: number) => {
  rules[rule] = (rules[rule] ?? 0) + n;
};

/** Warnings per rule, errors left out. */
export const countRules = (diagnostics: readonly Diagnostic[]): Rules => {
  const rules: Rules = {};
  for (const { code, severity } of diagnostics) if (severity === 'warning') add(rules, code, 1);
  return rules;
};

/** Warnings per area per rule, errors left out. */
export const countByArea = (diagnostics: readonly Diagnostic[]): Areas => {
  const areas: Areas = {};
  for (const { code, severity, filename } of diagnostics) {
    if (severity !== 'warning') continue;
    const area = areaOf(filename);
    if (!AREA.test(area)) {
      throw new Error(`${filename}: its area "${area}" cannot name a baseline file.`);
    }
    add((areas[area] ??= {}), code, 1);
  }
  return areas;
};

/** The totals per rule across every area. */
export const joinAreas = (areas: Areas): Rules => {
  const rules: Rules = {};
  for (const counts of Object.values(areas)) {
    for (const [rule, n] of Object.entries(counts)) add(rules, rule, n);
  }
  return rules;
};

/** Each rule whose count in `next` is above its count in `base`. */
export const rises = (next: Rules, base: Rules): Rise[] =>
  Object.entries(next)
    .filter(([rule, n]) => n > (base[rule] ?? 0))
    .map(([rule, n]) => ({ rule, n, was: base[rule] ?? 0 }));

/** True when both hold the same count for every rule. */
export const sameRules = (a: Rules, b: Rules): boolean =>
  rises(a, b).length === 0 && rises(b, a).length === 0;

/** Each area's rules whose count in `next` is above that area's count in `base`. */
export const areaRises = (next: Areas, base: Areas): AreaRise[] =>
  Object.keys(next)
    .toSorted()
    .flatMap((area) =>
      rises(next[area] ?? {}, base[area] ?? {}).map(({ rule, n, was }) => ({ area, rule, n, was })),
    );

/** The single baseline as areas, from the current counts, which must equal it exactly. */
export const splitBaseline = (single: Rules, current: Areas): Areas => {
  const now = joinAreas(current);
  if (!sameRules(now, single)) {
    const rules = [...new Set([...Object.keys(now), ...Object.keys(single)])].toSorted();
    const off = rules
      .filter((rule) => (now[rule] ?? 0) !== (single[rule] ?? 0))
      .map((rule) => `  ${rule}: ${now[rule] ?? 0} now, ${single[rule] ?? 0} in ${BASELINE}`);
    throw new Error(
      `the current warnings do not equal ${BASELINE}, so a split would lose or invent an entry:\n${off.join('\n')}\nrun \`pnpm lint:baseline\` first.`,
    );
  }
  return structuredClone(current);
};

/** The folder's files as areas; a file that is not `<area>.json` throws. */
export const parseAreaFiles = (files: readonly AreaFile[], where: string): Areas => {
  const areas: Areas = {};
  for (const { name, text } of files) {
    if (!name.endsWith('.json')) throw new Error(`${where}/${name} is not a .json file.`);
    const area = name.slice(0, -'.json'.length);
    if (!AREA.test(area)) {
      throw new Error(`${where}/${name}: "${area}" is not an area name ([a-z0-9-]+).`);
    }
    areas[area] = parseRules(text, `${where}/${name}`);
  }
  return areas;
};

/** The baseline under `root`: the folder when it exists, else the single file, else none. */
export const readBaseline = (root: string): Baseline | undefined => {
  const dir = join(root, BASELINE_DIR);
  if (existsSync(dir)) {
    const files = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.isFile() ? entry.name : `${entry.name}/`,
      text: entry.isFile() ? readFileSync(join(dir, entry.name), 'utf8') : '',
    }));
    return { kind: 'areas', areas: parseAreaFiles(files, BASELINE_DIR) };
  }
  const file = join(root, BASELINE);
  if (!existsSync(file)) return undefined;
  return { kind: 'total', rules: parseRules(readFileSync(file, 'utf8'), BASELINE) };
};

/** A baseline file's text, rules sorted, zero counts dropped. */
export const formatRules = (rules: Rules): string => {
  const sorted = Object.entries(rules)
    .filter(([, n]) => n > 0)
    .toSorted(([a], [b]) => a.localeCompare(b));
  return `${JSON.stringify({ rules: Object.fromEntries(sorted) }, null, 2)}\n`;
};
