// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e, REV185B2: every_invariant_bites holds each control and each mutation
// by its own name, and a part's revert by the crossings it declares in
// parts.json, whatever a case's title says.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MUTATION_LINES,
  PARTS,
  TITLED_CROSSING,
  classify,
  everyInvariantBites,
} from './self-test/mutations.ts';
import { crossingOf, everyLine, ran } from './self-test/fake-lines.ts';

const ROOT = resolve(import.meta.dirname, '../..');

describe('every_invariant_bites: the catalogue declares each crossing', () => {
  it('declares each T2 and T3 part’s crossings: each a case in its files, none titled as one left out', () => {
    const titled = /\b(?:it|test)(?:\.\w+)?\(\s*(['"])((?:(?!\1).)+)\1/gu;
    for (const part of PARTS.filter((one) => one.planted === undefined)) {
      const texts = part.files.map((file) => readFileSync(resolve(ROOT, file), 'utf8'));
      const titles = texts.flatMap((text) => [...text.matchAll(titled)].map((one) => one[2]));
      const declared = (part.crossings ?? []).map((one) => one.case);
      for (const one of part.crossings ?? []) {
        expect(titles, `${part.id} declares a case its files lack`).toContain(one.case);
        expect(one.crosses.length, `${part.id} ${one.case}`).toBeGreaterThan(0);
      }
      for (const title of titles.filter((one) => TITLED_CROSSING.test(String(one)))) {
        expect(declared, `${part.id} leaves a crossing undeclared`).toContain(title);
      }
    }
    expect(crossingOf('T3b', 'client')).toBe(crossingOf('T3b', 'person'));
    expect(PARTS.filter((one) => one.planted !== undefined && one.crossings !== undefined)).toEqual(
      [],
    );
  });
});

describe('every_invariant_bites: a revert fails by its declared crossing', () => {
  it('fails a revert whose declared crossing stayed green, naming it and what it crosses, whatever its title', () => {
    const client = crossingOf('T3f', 'client');
    const green = classify(
      'T4-N4 T3f reverted',
      ran({
        cases: [
          { name: 'expired_lease_money_only: the case', passed: false },
          { name: `T3f ${client}`, passed: true },
        ],
      }),
    );
    expect(green.status).toBe('fail');
    expect(green.detail).toContain(`a declared crossing stayed green: T3f ${client} (client)`);
    const red = classify(
      'T4-N4 T3f reverted',
      ran({
        cases: [
          { name: 'expired_lease_money_only: the case', passed: false },
          { name: `T3f ${client}`, passed: false },
          { name: 'T3f an isolation-free structural check', passed: true },
        ],
      }),
    );
    expect(red.status, red.detail).toBe('pass');
  });
});

describe('every_invariant_bites: every line by its own name', () => {
  it('holds each mutation and each unmutated control by its own name: a copy stands in for none', () => {
    const first = MUTATION_LINES.find((name) => name.startsWith('T4-N3'));
    const copies = everyLine().map((line) =>
      line.case.startsWith('T4-N3') ? classify(String(first), ran({})) : line,
    );
    const copied = everyInvariantBites(copies);
    expect(copied.status).toBe('fail');
    expect(copied.detail).toContain('T4-N3 a duplicate route id fails the typecheck');
    expect(copied.detail).toContain('T4-N3 a changed pinned-mockup byte fails the mockup pin');
    const proofs = 'control: T3d2 apply_after_api_stops, crash_between_apply_and_settle';
    for (const name of ['control: the typecheck', proofs]) {
      const without = everyInvariantBites(everyLine().filter((line) => line.case !== name));
      expect(without.status, name).toBe('fail');
      expect(without.detail).toContain(`missing: ${name}`);
    }
  });
});
