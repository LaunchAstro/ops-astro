// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, everyInvariantBites, type Scratch } from './self-test/mutations.ts';
import { summarise, type VitestReport } from './self-test/vitest-report.ts';

const root = resolve(import.meta.dirname, '../..');
const file = 'tests/runtime/run-progress-read.test.ts';
const scratch: Scratch = {
  dir: root,
  branch: '',
  base: '',
  git: () => '',
  reset: () => {},
  commit: () => '',
  close: () => {},
};

function report(results: VitestReport['testResults'][number]['assertionResults']): VitestReport {
  return {
    testResults: [
      { name: resolve(root, file), status: 'failed', message: '', assertionResults: results },
    ],
  };
}

describe('every_invariant_bites: each part held to its own invariant', () => {
  it('the whole run rejects a missing part even when one mutation goes red', () => {
    const one = classify('T4-N1', {
      applied: true,
      executed: 1,
      red: true,
      detail: 'migration check failed',
    });
    expect(everyInvariantBites([one]).status).toBe('fail');
  });

  it('a sibling failure cannot stand in for the named invariant', () => {
    const ran = summarise(
      scratch,
      report([
        { status: 'passed', fullName: 'run_progress_read: reads ordered events' },
        { status: 'failed', fullName: 'unrelated setup expectation' },
      ]),
      [file],
    );
    expect(classify('T4-N4 T2a: run_progress_read', ran).status).toBe('fail');
  });

  it('a revert with a green isolation case fails by name', () => {
    const ran = summarise(
      scratch,
      report([
        { status: 'failed', fullName: 'run_progress_read: reads ordered events' },
        {
          status: 'passed',
          fullName: 'T2 isolation crosses two clients with one grant each in both businesses',
        },
      ]),
      [file],
    );
    const verdict = classify('T4-N4 T2a: run_progress_read', ran);
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).toContain('T2 isolation crosses two clients');
  });
});
