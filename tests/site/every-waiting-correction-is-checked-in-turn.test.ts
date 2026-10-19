// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693 on a real database: the site runner checks every waiting correction
// in turn. A pass takes 20 at most, never-checked first, then oldest, and reads
// the head once and each due path once, however many share it. A provider
// that fails backs a correction off 30 s, 60 s, then 120 s, and the next good
// read stamps it and clears the count; a `locating` one is never put off past
// 120 s after its request, when a failure settles it `unlocated
// SITE_UNREACHABLE`. A failing path leaves a healthy one checked each pass.
// The storage keeps the schedule forward only, and only while waiting.
/* eslint-disable max-lines-per-function -- each case keeps its passes and their schedule in one place */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { codeOf } from '../commands/agent-fixture.ts';
import { contentDigest } from '../../packages/core-connectors/src/index.ts';
import { ABOUT, BEFORE, PAGE } from './c80-world.ts';
import { ASTRO_FILE, ASTRO_PAGE } from './c80-sites.ts';
import { serverUrl, w } from './c80-register-world.ts';
import { pinAsRunner } from './located.ts';
import {
  dueNow,
  locateOnce,
  noneWaiting,
  requestOn,
  requestedAgo,
  rowOf,
  sourceDouble,
} from './locate-world.ts';
import { useRunnerWorld } from './site-runner-world.ts';

useRunnerWorld();

const ASTRO = readFileSync(new URL('fixtures/agency-about/about.astro', import.meta.url), 'utf8');

/** Requested and pinned on `file`'s bytes, as the runner pins them; never checked since. */
async function waiting(page: string, file: string): Promise<string> {
  const words = page === PAGE ? undefined : ({ word: 'alongside', replacement: 'beside' } as const);
  const id = await requestOn(page, words);
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await pinAsRunner(tx, id, { preImageDigest: contentDigest(file) });
  });
  return id;
}

const verifiedOf = async (ids: readonly string[]): Promise<(string | null)[]> =>
  await Promise.all(ids.map(async (id) => (await rowOf(id)).verified_at));
const nextOf = async (ids: readonly string[]): Promise<(number | null)[]> =>
  await Promise.all(ids.map(async (id) => (await rowOf(id)).next_in));

beforeEach(async () => {
  if (serverUrl !== undefined) await noneWaiting();
});

describe.skipIf(serverUrl === undefined)('every waiting correction is checked in turn', () => {
  it('takes 20 a pass, the never-checked first, with one head and one file read each pass', async () => {
    const ids: string[] = [];
    for (let at = 0; at < 25; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- requested one after another, oldest first
      ids.push(await waiting(PAGE, BEFORE));
    }
    const oldest = ids.slice(0, 20);
    const newest = ids.slice(20);
    const double = sourceDouble({ [ABOUT]: BEFORE });

    // A stamp writes nothing worth a line.
    expect(await locateOnce(double)).toEqual([]);
    expect(double.requests).toHaveLength(2);
    for (const next of await nextOf(oldest)) expect(next).toBeGreaterThan(10);
    expect(await nextOf(newest)).toEqual([null, null, null, null, null]);

    // Every one due again: the five never checked go first, then the oldest fifteen.
    await dueNow(...oldest);
    const before = await verifiedOf(ids);
    expect(await locateOnce(double)).toEqual([]);
    expect(double.requests).toHaveLength(4);
    const after = await verifiedOf(ids);
    const stamped = ids.filter((_id, at) => after[at] !== before[at]);
    expect(stamped).toEqual([...oldest.slice(0, 15), ...newest]);
  });

  it('backs a failing check off 30 s, 60 s, then 120 s, and the next good read stamps it', async () => {
    const id = await waiting(PAGE, BEFORE);
    const double = sourceDouble({ [ABOUT]: BEFORE });
    double.failing.add('head');
    for (const [failures, seconds] of [
      [1, 30],
      [2, 60],
      [3, 120],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one pass after another
      await dueNow(id);
      // oxlint-disable-next-line no-await-in-loop
      expect(await locateOnce(double)).toEqual([{ correctionId: id, outcome: 'CHECK_FAILED' }]);
      // oxlint-disable-next-line no-await-in-loop
      const row = await rowOf(id);
      expect(row.check_failures).toBe(failures);
      expect(row.next_in).toBeGreaterThan(seconds - 5);
      expect(row.next_in).toBeLessThanOrEqual(seconds);
    }
    double.failing.clear();
    await dueNow(id);
    const { verified_at: before } = await rowOf(id);
    expect(await locateOnce(double)).toEqual([]);
    const row = await rowOf(id);
    expect(row).toMatchObject({ state: 'requested', check_failures: 0 });
    expect(row.verified_at).not.toBe(before);
    expect(row.next_in).toBeGreaterThan(10);
  });

  it('settles a locating correction unlocated SITE_UNREACHABLE at 120 s, and never puts it off past then', async () => {
    const id = await requestOn(PAGE);
    const double = sourceDouble({ [ABOUT]: BEFORE });
    double.failing.add(ABOUT);
    expect(await locateOnce(double)).toEqual([{ correctionId: id, outcome: 'CHECK_FAILED' }]);
    expect(await rowOf(id)).toMatchObject({ state: 'locating', check_failures: 1 });

    // Requested 100 s ago: the next try is at 120 s after the request, not 60 s from now.
    await requestedAgo(id, 100);
    await dueNow(id);
    expect(await locateOnce(double)).toEqual([{ correctionId: id, outcome: 'CHECK_FAILED' }]);
    const capped = await rowOf(id);
    expect(capped.next_in).toBeGreaterThan(15);
    expect(capped.next_in).toBeLessThanOrEqual(20);

    await requestedAgo(id, 121);
    await dueNow(id);
    expect(await locateOnce(double)).toEqual([{ correctionId: id, outcome: 'SITE_UNREACHABLE' }]);
    expect(await rowOf(id)).toMatchObject({
      state: 'unlocated',
      locate_code: 'SITE_UNREACHABLE',
      version_id: null,
    });
  });

  it('checks a healthy path each pass while another path fails', async () => {
    const about = await waiting(PAGE, BEFORE);
    const astro = await waiting(ASTRO_PAGE, ASTRO);
    const double = sourceDouble({ [ABOUT]: BEFORE, [ASTRO_FILE]: ASTRO });
    double.failing.add(ASTRO_FILE);
    for (const pass of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- one pass after another
      await dueNow(about, astro);
      // oxlint-disable-next-line no-await-in-loop
      const { verified_at: before } = await rowOf(about);
      // oxlint-disable-next-line no-await-in-loop
      expect(await locateOnce(double)).toEqual([{ correctionId: astro, outcome: 'CHECK_FAILED' }]);
      // One head read and one read of each path, every pass.
      expect(double.requests).toHaveLength(3 * pass);
      // oxlint-disable-next-line no-await-in-loop
      const healthy = await rowOf(about);
      expect(healthy.check_failures).toBe(0);
      expect(healthy.verified_at).not.toBe(before);
      // oxlint-disable-next-line no-await-in-loop
      expect((await rowOf(astro)).check_failures).toBe(pass);
    }
  });

  it('refuses a schedule moved backwards, or any change to it once a correction is approved', async () => {
    const id = await waiting(PAGE, BEFORE);
    expect(await locateOnce(sourceDouble({ [ABOUT]: BEFORE }))).toEqual([]);
    const move = async (set: string) =>
      await w.world.db.admin.execute(`update public.live_corrections set ${set} where id = $1`, [
        id,
      ]);
    await expect(move(`next_check_at = next_check_at - interval '5 seconds'`)).rejects.toThrow(
      /checks forward only while waiting/u,
    );
    const { version_id: versionId } = await rowOf(id);
    expect(codeOf(await w.approve(w.ben, id, String(versionId)))).toBe('not-a-refusal');
    await expect(move('check_failures = check_failures + 1')).rejects.toThrow(
      /checks forward only while waiting/u,
    );
    await expect(move(`next_check_at = next_check_at + interval '5 seconds'`)).rejects.toThrow(
      /checks forward only while waiting/u,
    );
    expect(await w.stateOf(id)).toBe('approved');
  });
});
