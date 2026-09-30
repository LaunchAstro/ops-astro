// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e: `every_invariant_bites` (split section 3.2, row T4e; ticket T4, the
// owner's C225 rule). Each named invariant of the slice fails when its part is
// removed, and the run lists any that stayed green as a failure.
//
// The full run reverts every T2 and T3 part on a scratch branch and reruns its
// invariant, and runs T4a to T4d's planted-mutation cases, against the journey command's own Postgres (`pnpm verify:journey
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
  keeps,
  onOwnCluster,
  openScratch,
} from './self-test/mutations.ts';
import { TOOLING, bites, caught, everyLine, ran } from './self-test/fake-lines.ts';

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
          if (!keeps(part, path)) removed.add(path);
        }
      }
      expect(removed.size, `${part.id} reverts nothing`).toBeGreaterThan(0);
    }
    // Two git calls per commit: on a loaded host they outrun vitest's five seconds.
  }, 60_000);
});

describe('every_invariant_bites: an unwire at the head', () => {
  it('unwires at the head only files the part changed, each call site there exactly once', () => {
    for (const part of PARTS) {
      for (const { file, remove } of part.unwire ?? []) {
        const touched = part.commits.some((commit) =>
          git(['show', '--no-renames', '--name-only', '--format=', commit])
            .split('\n')
            .includes(file),
        );
        expect(touched, `${part.id} never changed ${file}`).toBe(true);
        const text = readFileSync(resolve(ROOT, file), 'utf8');
        if (remove.length > 0) {
          expect(text.split(`${remove.join('\n')}\n`).length - 1, `${part.id} ${file}`).toBe(1);
        }
      }
    }
  });

  // The exact list is proven locally (unwire-dependents-exact.test.mjs); here,
  // each declared dependent's suite, with the test modules it imports, names
  // a symbol the part's own commits added to product code.
  it('declares as dependents only other parts whose suite reaches code the part added', () => {
    const suiteOf = (files: readonly string[]): string => {
      const seen = new Set<string>();
      const todo = files.map((file) => resolve(ROOT, file));
      for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
        if (seen.has(file) || !existsSync(file)) continue;
        seen.add(file);
        for (const [, from = ''] of readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/gu)) {
          const next = resolve(file, '..', from);
          if (next.startsWith(resolve(ROOT, 'tests'))) todo.push(next);
        }
      }
      return [...seen].map((file) => readFileSync(file, 'utf8')).join('\n');
    };
    for (const part of PARTS) {
      const added = part.commits
        .map((commit) => git(['show', '--format=', commit, '--', '.', ':!tests']))
        .join('\n')
        .split('\n')
        .filter((line) => line.startsWith('+'));
      for (const { part: id, reaches, why } of part.dependents ?? []) {
        const dependent = PARTS.find((one) => one.id === id && one.planted === undefined);
        expect(dependent !== undefined && id !== part.id, `${part.id} declares ${id}`).toBe(true);
        expect(why.length, `${part.id} ${id} says why`).toBeGreaterThan(0);
        expect(
          added.some((line) => line.includes(reaches)),
          `${part.id} added ${reaches}`,
        ).toBe(true);
        const suite = suiteOf(dependent?.files ?? []);
        expect(suite.includes(reaches), `${id}'s suite reaches ${reaches}`).toBe(true);
      }
    }
  });
});

describe('every_invariant_bites: the verdict', () => {
  it('passes a part whose named invariant fails under its revert, saying so', () => {
    const line = classify('T4-N4 T2a', bites('T2a'));
    expect(line).toEqual({
      case: 'T4-N4 T2a',
      status: 'pass',
      detail: 'red under its mutation: run_progress_read failed; 2 of 4 cases failed',
    });
  });

  it('fails a part whose invariant did not run, however red its file, and names each silent one', () => {
    const loads = classify('T4-N4 T3d2', ran({ detail: 'the file fails whole', cases: [] }));
    expect(loads.status).toBe('fail');
    expect(loads.detail).toContain('apply_after_api_stops, crash_between_apply_and_settle');
    const half = classify(
      'T4-N4 T3d2',
      ran({ cases: [{ name: 'apply_after_api_stops: F1', passed: false }] }),
    );
    expect(half.status).toBe('fail');
    expect(half.detail).toContain('did not fail: crash_between_apply_and_settle');
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
});

describe('every_invariant_bites: the whole run', () => {
  it('passes the whole run only with every line, and lists what stayed green or is missing', () => {
    expect(everyInvariantBites(everyLine()).status).toBe('pass');
    const lines = everyLine().map((line) =>
      ['T4-N4 T3c reverted', 'T4-N4 T3f reverted'].includes(line.case)
        ? classify(line.case, ran({ red: false }))
        : line,
    );
    const whole = everyInvariantBites(lines);
    expect(whole.case).toBe('every_invariant_bites');
    expect(whole.status).toBe('fail');
    expect(whole.detail).toContain('T4-N4 T3c');
    expect(whole.detail).toContain('T4-N4 T3f');
    expect(whole.detail).not.toContain('T4-N1');
    const short = everyInvariantBites(
      everyLine().filter((line) => !line.case.startsWith('T4-P T4d')),
    );
    expect(short.status).toBe('fail');
    expect(short.detail).toContain('missing: T4-P T4d');
    expect(everyInvariantBites([]).status).toBe('fail');
  });

  it('holds T4-N4 for every T2 and T3 part and T4-P for every T4 part, and no other way round', () => {
    const reverted = everyLine().map((line) =>
      line.case.startsWith('T4-P T4a') ? classify('T4-N4 T4a reverted', bites('T4a')) : line,
    );
    const whole = everyInvariantBites(reverted);
    expect(whole.status).toBe('fail');
    expect(whole.detail).toContain('missing: T4-P T4a');
    const noT3f = everyLine().filter((line) => !line.case.startsWith('T4-N4 T3f'));
    expect(everyInvariantBites(noT3f).detail).toContain('missing: T4-N4 T3f');
  });
});

describe('every_invariant_bites: T4a to T4d, each by its own planted mutation', () => {
  it('names each T4 part’s planted-mutation cases, found in its own file; no T2 or T3 part has one', () => {
    for (const part of PARTS) {
      if (!TOOLING.has(part.id)) {
        expect(part.planted, part.id).toBeUndefined();
        continue;
      }
      expect(part.planted?.length, part.id).toBeGreaterThan(0);
      const texts = part.files.map((file) => readFileSync(resolve(ROOT, file), 'utf8'));
      for (const name of part.planted ?? []) {
        expect(
          texts.some((text) => text.includes(`'${name}'`)),
          `${part.id} ${name}`,
        ).toBe(true);
      }
    }
  });

  it('passes a T4 part when each planted case ran and passed under its named invariant, saying which', () => {
    const line = classify('T4-P T4b2 planted', caught('T4b2'));
    expect(line.status, line.detail).toBe('pass');
    expect(line.detail).toContain('a fixture selector planted in the built script fails');
  });

  it('fails a T4 part whose planted case failed, did not run, or ran outside its invariant', () => {
    expect(classify('T4-P T4c planted', caught('T4c', false)).status).toBe('fail');
    const silent = classify('T4-P T4c planted', ran({ red: false, cases: [] }));
    expect(silent.status).toBe('fail');
    expect(silent.detail).toContain('fails a control shifted by two pixels');
    const planted = (PARTS.find((one) => one.id === 'T4a')?.planted ?? []).map((name) => ({
      name: `another suite ${name}`,
      passed: true,
    }));
    expect(classify('T4-P T4a planted', ran({ red: false, cases: planted })).status).toBe('fail');
    expect(classify('T4-P T4a planted', ran({ red: false, executed: 0 })).status).toBe('fail');
  });
});

describe('every_invariant_bites: the mutations run on the command’s own Postgres only', () => {
  const published = '0.0.0.0:54470\n[::]:54470\n';
  it('accepts this machine’s port the container publishes', () => {
    expect(onOwnCluster('postgres://postgres:x@127.0.0.1:54470/journey', published)).toBe(true);
    expect(onOwnCluster('postgres://postgres:x@localhost:54470/journey', published)).toBe(true);
  });

  it('refuses another port, another host on the same port, and anything malformed', () => {
    for (const url of [
      'postgres://postgres:x@127.0.0.1:54390/postgres',
      'postgres://postgres:x@example.invalid:54470/journey',
      'postgres://postgres:x@127.0.0.1/journey',
      'not a url',
    ]) {
      expect(onOwnCluster(url, published), url).toBe(false);
    }
    const own = 'postgres://postgres:x@127.0.0.1:54470/journey';
    expect(onOwnCluster(own, '')).toBe(false);
    expect(onOwnCluster(own, '0.0.0.0:154470\n')).toBe(false);
    expect(onOwnCluster(own, '0.0.0.0:5447\n')).toBe(false);
    expect(onOwnCluster(own, '10.0.0.9:54470\n')).toBe(false);
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
