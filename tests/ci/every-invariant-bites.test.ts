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
  CONTROL_LINES,
  MUTATION_LINES,
  PARTS,
  TITLED_CROSSING,
  changePinnedMockup,
  classify,
  control,
  controlOf,
  deleteOneMigration,
  everyInvariantBites,
  keeps,
  lineOf,
  onOwnCluster,
  openScratch,
  type CaseLine,
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
  });
});

/** A part's revert under which its named invariants fail and nothing else is asserted. */
const bites = (id: string): Ran => {
  const part = PARTS.find((one) => one.id === id);
  const names = part?.invariants ?? [];
  return ran({ cases: names.map((name) => ({ name: `${name}: the case`, passed: false })) });
};

/** A T4 part's file run unmutated: each planted-mutation case passed under its named invariant. */
const caught = (id: string, passed = true): Ran => {
  const part = PARTS.find((one) => one.id === id);
  const [invariant] = part?.invariants ?? [];
  return ran({
    red: false,
    detail: '0 of 4 cases failed',
    cases: (part?.planted ?? []).map((name) => ({ name: `${String(invariant)} ${name}`, passed })),
  });
};

/** The split's T4e row: T4-N4 reverts every T2 and T3 part; T4a to T4d are test tooling. */
const TOOLING = new Set(['T4a', 'T4b1', 'T4b2', 'T4c', 'T4d']);

/** One passing line for every control and every mutation the whole run must hold. */
const everyLine = (): CaseLine[] => [
  ...[...CONTROL_LINES, ...PARTS.map(controlOf)].map((name) => control(name, ran({ red: false }))),
  ...MUTATION_LINES.map((name) => classify(name, ran({}))),
  ...PARTS.map((part) =>
    TOOLING.has(part.id)
      ? classify(`${lineOf(part)} planted`, caught(part.id))
      : classify(`${lineOf(part)} reverted`, bites(part.id)),
  ),
];

/** A T2 or T3 part's first declared crossing of `kind`. */
const crossingOf = (id: string, kind: string): string => {
  const part = PARTS.find((one) => one.id === id);
  const found = part?.crossings?.find((one) => one.crosses.includes(kind as never));
  if (found === undefined) throw new Error(`${id} declares no ${kind} crossing`);
  return found.case;
};

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
