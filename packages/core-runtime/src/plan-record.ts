// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the structured plan record a plan accept binds (U4).
//
// The record is what AW-06's graph projects: the plan's steps by key, each
// naming the steps it comes after. It is checked before anything is written,
// and a record that fails is refused whole, never repaired:
//
//   vocabulary   the record holds `steps` and nothing else; a step holds
//                `key`, `title` and `after` and nothing else; a key is a
//                lower-case slug, a title plain words.
//   references   every `after` names a key of this plan. A name that is no
//                key here (another plan's step, a record id) is refused.
//   duplicates   two steps with one key, or one step naming a key twice.
//   cycles       a step that comes, however indirectly, after itself.
//
// The words and the record are each bound by SHA-256: the words as sent, the
// record over its canonical form, so key order never changes its digest.

import { createHash } from 'node:crypto';
import { payloadDigest } from '../../core-digest/src/index.ts';

export interface PlanStep {
  readonly key: string;
  readonly title: string;
  readonly after: readonly string[];
}

export interface PlanRecord {
  readonly steps: readonly PlanStep[];
}

/** The words and the record, checked, with the digest of each. */
export interface BoundPlan {
  readonly text: string;
  readonly textDigest: string;
  readonly record: PlanRecord;
  readonly recordDigest: string;
}

export const PLAN_TEXT_LIMIT = 20_000;
const KEY = /^[a-z][a-z0-9_-]{0,62}$/u;
const TITLE_LIMIT = 200;
const STEP_LIMIT = 100;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const onlyKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);

function stepOf(value: unknown): PlanStep | string {
  if (!isObject(value) || !onlyKeys(value, ['key', 'title', 'after'])) {
    return 'a step holds key, title and after, and nothing else';
  }
  const { key, title, after } = value;
  if (typeof key !== 'string' || !KEY.test(key)) return 'a step key is a lower-case slug';
  if (typeof title !== 'string' || title.trim() === '' || title.length > TITLE_LIMIT) {
    return `a step title is 1 to ${String(TITLE_LIMIT)} characters of words`;
  }
  if (!Array.isArray(after) || !after.every((name) => typeof name === 'string')) {
    return 'after is a list of step keys';
  }
  if (new Set(after).size !== after.length) return 'a step names each earlier step once';
  return { key, title, after: after as string[] };
}

/** The first step key found on a cycle, or undefined when the steps form none. */
function cycleIn(steps: readonly PlanStep[]): string | undefined {
  const afterOf = new Map(steps.map((step) => [step.key, step.after]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (key: string): boolean => {
    if (done.has(key)) return false;
    if (visiting.has(key)) return true;
    visiting.add(key);
    const looped = (afterOf.get(key) ?? []).some((name) => visit(name));
    visiting.delete(key);
    done.add(key);
    return looped;
  };
  return steps.find((step) => visit(step.key))?.key;
}

/** The checked record, or the one reason it is refused. */
export function planRecordOf(value: unknown): PlanRecord | string {
  if (!isObject(value) || !onlyKeys(value, ['steps'])) {
    return 'the plan holds steps and nothing else';
  }
  const { steps } = value;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > STEP_LIMIT) {
    return `the plan has 1 to ${String(STEP_LIMIT)} steps`;
  }
  const checked: PlanStep[] = [];
  for (const candidate of steps) {
    const step = stepOf(candidate);
    if (typeof step === 'string') return step;
    checked.push(step);
  }
  const keys = new Set(checked.map((step) => step.key));
  if (keys.size !== checked.length) return 'two steps share one key';
  if (checked.some((step) => step.after.some((name) => !keys.has(name)))) {
    return 'a step comes after a step this plan does not have';
  }
  if (cycleIn(checked) !== undefined) return 'a step comes after itself';
  return { steps: checked };
}

/** Which of the two a refusal names, and why. */
export interface PlanRefusal {
  readonly field: 'planText' | 'plan';
  readonly reason: string;
}

/** The words and the record bound together, or the one that is refused and why. */
export function boundPlanOf(text: unknown, record: unknown): BoundPlan | PlanRefusal {
  if (typeof text !== 'string' || text.trim() === '' || text.length > PLAN_TEXT_LIMIT) {
    return {
      field: 'planText',
      reason: `the plan's words are 1 to ${String(PLAN_TEXT_LIMIT)} characters`,
    };
  }
  const checked = planRecordOf(record);
  if (typeof checked === 'string') return { field: 'plan', reason: checked };
  return {
    text,
    textDigest: createHash('sha256').update(text, 'utf8').digest('hex'),
    record: checked,
    recordDigest: payloadDigest(checked),
  };
}
