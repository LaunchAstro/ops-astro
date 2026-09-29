// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e: `every_invariant_bites` (split section 3.2, row T4e; ticket T4, the
// owner's C225 rule). Each named invariant of the slice fails when its part is
// removed, and the run lists any that stayed green as a failure.
//
// The full run reverts every part on a scratch branch and reruns its
// invariant against the journey command's own Postgres (`pnpm verify:journey
// --self-test`, evidence on the pull request); that needs a database and
// minutes, so it is not repeated here. This file holds what the run stands on:
// the catalogue names every part before T4e with the split's invariants, each
// part's commits are on this line (red until every part has landed), the
// verdict fails an invariant that stays green, and two mutations that need no
// database run for real on a scratch branch of their own.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PARTS,
  changePinnedMockup,
  classify,
  deleteOneMigration,
  everyInvariantBites,
  openScratch,
  type Ran,
} from './self-test/mutations.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const git = (args: readonly string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** Split section 3.2 in landing order: every part before T4e and its named invariants. */
const SPLIT: readonly (readonly [string, readonly string[]])[] = [
  ['T2a', ['run_progress_read']],
  ['T2b', ['worker_boundary']],
  ['T2c1', ['recheck_inside_dispatch']],
  ['T2c2', ['effect_once_with_receipt']],
  ['T2d', ['settles_at_observed']],
  ['T2e', ['top_up_is_a_persons']],
  ['T2f', ['event_visible_under_2s']],
  ['T2g', ['journey_parity_cli']],
  ['T2h', ['alert_on_transition']],
  ['T3a', ['revision_loop_keeps_settled']],
  ['T3b', ['unknown_stays_unknown']],
  ['T3c', ['write_off_needs_a_person']],
  ['T3d1', ['reconcile_never_repeats']],
  ['T3d2', ['apply_after_api_stops', 'crash_between_apply_and_settle']],
  ['T3e1', ['drop_is_not_cancel']],
  ['T3e2', ['one_report_per_outage']],
  ['T3f', ['expired_lease_money_only']],
  ['T4a', ['fixture_shape']],
  ['T4b1', ['journey_twice_same_facts']],
  ['T4b2', ['no_fallback_in_bundle']],
  ['T4c', ['visual_fails_on_drift']],
  ['T4d', ['bundle_names_the_approval']],
];

const ran = (over: Partial<Ran>): Ran => ({
  applied: true,
  executed: 4,
  red: true,
  detail: '2 of 4 cases failed',
  ...over,
});

describe('every_invariant_bites: the catalogue', () => {
  it('names every part before T4e with the split’s invariants, in landing order', () => {
    expect(PARTS.map((part) => [part.id, part.invariants])).toEqual(SPLIT);
  });

  it('runs each invariant from a test file that exists and names it', () => {
    for (const part of PARTS) {
      const texts = part.files.map((file) => {
        expect(file, part.id).toMatch(/^tests\/.+\.test\.tsx?$/u);
        expect(existsSync(resolve(ROOT, file)), file).toBe(true);
        return readFileSync(resolve(ROOT, file), 'utf8');
      });
      for (const name of part.invariants) {
        expect(
          texts.some((text) => text.includes(name)),
          `${part.id} ${name}`,
        ).toBe(true);
      }
    }
  });

  it('has every part landed: each commit is on this line and changes what a revert removes', () => {
    for (const part of PARTS) {
      expect(part.commits.length, part.id).toBeGreaterThan(0);
      const removed = new Set<string>();
      for (const commit of part.commits) {
        // Throws on a commit that is not an ancestor of this head: that part has not landed.
        git(['merge-base', '--is-ancestor', commit, 'HEAD']);
        for (const path of git(['show', '--no-renames', '--name-only', '--format=', commit])
          .split('\n')
          .filter(Boolean)) {
          const kept =
            part.keep === 'tests' ? path.startsWith('tests/') : part.files.includes(path);
          if (!kept) removed.add(path);
        }
      }
      expect(removed.size, `${part.id} reverts nothing`).toBeGreaterThan(0);
    }
  });
});

describe('every_invariant_bites: the verdict', () => {
  it('passes an invariant its mutation turns red, saying how', () => {
    const line = classify('T4-N4 T2a', ran({}));
    expect(line).toEqual({
      case: 'T4-N4 T2a',
      status: 'pass',
      detail: 'red under its mutation: 2 of 4 cases failed',
    });
  });

  it('fails an invariant that stays green under its mutation, by name', () => {
    const line = classify('T4-N4 T3c', ran({ red: false, detail: '9 cases passed' }));
    expect(line.status).toBe('fail');
    expect(line.detail).toMatch(/stayed green/u);
  });

  it('fails a mutation that changed nothing, and a run in which nothing executed', () => {
    expect(classify('T4-N4 T2b', ran({ applied: false })).status).toBe('fail');
    expect(classify('T4-N4 T2b', ran({ executed: 0, red: false })).status).toBe('fail');
    expect(classify('T4-N4 T2b', ran({ executed: 0 })).status).toBe('fail');
  });

  it('fails the whole run, listing every check that stayed green, and a run with no checks', () => {
    const lines = [
      classify('T4-N1', ran({})),
      classify('T4-N4 T3c', ran({ red: false })),
      classify('T4-N4 T3f', ran({ red: false })),
    ];
    const whole = everyInvariantBites(lines);
    expect(whole.case).toBe('every_invariant_bites');
    expect(whole.status).toBe('fail');
    expect(whole.detail).toContain('T4-N4 T3c');
    expect(whole.detail).toContain('T4-N4 T3f');
    expect(whole.detail).not.toContain('T4-N1');
    expect(everyInvariantBites([]).status).toBe('fail');
    expect(everyInvariantBites([classify('T4-N1', ran({}))]).status).toBe('pass');
  });
});

describe('every_invariant_bites: mutations that need no database, run for real', () => {
  it('T4-N1: deleting the newest migration fails the migration check, naming the file', () => {
    const scratch = openScratch();
    try {
      const line = classify('T4-N1', deleteOneMigration(scratch));
      expect(line.status, line.detail).toBe('pass');
      expect(line.detail).toMatch(/migrations\/\d{4}_[a-z_]+\.sql/u);
    } finally {
      scratch.close();
    }
    expect(existsSync(scratch.dir)).toBe(false);
    expect(git(['branch', '--list', scratch.branch]).trim()).toBe('');
  }, 60_000);

  it('T4-N3: a changed byte under the pinned mockup fails the mockup pin, the unchanged pin passes', () => {
    const scratch = openScratch();
    try {
      const line = classify('T4-N3 pinned mockup', changePinnedMockup(scratch));
      expect(line.status, line.detail).toBe('pass');
      expect(line.detail).toMatch(/pinned mockup changed/u);
    } finally {
      scratch.close();
    }
  }, 60_000);
});
