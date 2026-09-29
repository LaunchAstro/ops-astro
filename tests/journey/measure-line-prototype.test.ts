// SPDX-License-Identifier: AGPL-3.0-only
//
// #180 static analysis (semgrep insecure-object-assign): the journey command
// read its run's `journey-measure` line with `Object.assign` from the parsed
// JSON, so a `__proto__` key on that line set the measures' prototype. The
// line is another process's output: only the run's own measure (`seedMs`, a
// finite number) is taken, into a record with no prototype, and every other
// key is dropped.

import { afterEach, describe, expect, it } from 'vitest';
import { emptyMeasures, takeMeasure } from '../../scripts/local/journey-measure.ts';

const HOSTILE = [
  '{"seedMs":12,"__proto__":{"polluted":"yes","migrateMs":1,"journeyRan":true}}',
  '{"seedMs":12,"constructor":{"prototype":{"polluted":"yes"}}}',
  '{"seedMs":12,"prototype":{"polluted":"yes"}}',
];

afterEach(() => {
  // A failing case must not leave the pollution behind for the next one.
  delete (Object.prototype as Record<string, unknown>)['polluted'];
});

describe('a journey-measure line hands the command only the run own measure', () => {
  for (const line of HOSTILE) {
    it(`changes no prototype and drops the key: ${line}`, () => {
      const before = Object.getOwnPropertyNames(Object.prototype).toSorted();
      const measures = emptyMeasures();
      takeMeasure(measures, line);
      expect(Object.getPrototypeOf(measures)).toBeNull();
      expect(Object.getOwnPropertyNames(Object.prototype).toSorted()).toEqual(before);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.keys(measures)).toEqual(['seedMs']);
      expect(measures.seedMs).toBe(12);
      expect(measures.migrateMs).toBeUndefined();
      expect(measures.journeyRan).toBeUndefined();
    });
  }

  it('takes the run own measure and nothing the command sets itself', () => {
    const measures = emptyMeasures();
    measures.migrateMs = 900;
    takeMeasure(measures, '{"seedMs":1500,"migrateMs":1,"journeyRan":true,"other":2}');
    expect({ ...measures }).toEqual({ migrateMs: 900, seedMs: 1500 });
  });

  it('drops a measure that is not a finite number', () => {
    for (const line of ['{"seedMs":"12"}', '{"seedMs":null}', '[12]', '12', 'null']) {
      const measures = emptyMeasures();
      takeMeasure(measures, line);
      expect(Object.keys(measures)).toEqual([]);
    }
  });
});
