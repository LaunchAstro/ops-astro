// SPDX-License-Identifier: AGPL-3.0-only
//
// #2063 (#1693 design v3, the guard order's steps 1, 3 and 4, and proof (e)):
// Astra's review is recorded only on the version a person may Launch. A
// correction with no version (`locating`, `unlocated`, `superseded`) refuses
// `VERSION_NOT_READY` before it says it is decided; a digest that is not the
// row's own refuses `VERSION_STALE`; a version whose page the runner has not
// checked in the last 60 s, by the clock read after the row's lock wait,
// refuses `VERSION_UNVERIFIED`. A refused review stores nothing and moves no
// revision, so it can never be the review a single operator's first
// self-approval rests on (R5).

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { C80World } from './c80-world.ts';
import { pinFromBefore } from './c80-world.ts';
import { TEST_PIN } from './located.ts';
import {
  REVIEW,
  decide,
  eveRequests,
  heldIn,
  recordReview,
  setMode,
  soloWorld,
  waitedFor,
} from './single-operator-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Checked reviews: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await soloWorld('reviewed');
}, 120_000);

/** Ava's request on alpha's task, as the door stores it: `locating`. */
async function locating(): Promise<string> {
  const answer = await w.asRaw(w.ava, {
    command: 'live_correction.request',
    taskId: w.taskA,
    page: 'About',
    word: 'friendly',
    replacement: 'welcoming',
  });
  if (isCommandRefusal(answer)) throw new Error(`request refused ${answer.code}`);
  return String(answer.detail['correctionId']);
}

/** A request pinned and checked now, as the runner would. */
async function pinned(): Promise<{
  readonly id: string;
  readonly versionId: string;
  readonly digest: string;
}> {
  const id = await locating();
  const { versionId, versionDigest } = await pinFromBefore(w.world.db.admin, id);
  return { id, versionId, digest: versionDigest };
}

const admin = async (sql: string, parameters: readonly unknown[] = []) =>
  await w.world.db.admin.execute(sql, parameters);

/** The last check moved to `seconds` ago, past the trigger that lets it move only forward. */
const checkedAgo = async (id: string, seconds: number) =>
  await admin(
    `with replica as (select set_config('session_replication_role', 'replica', true))
     update public.live_corrections
        set verified_at = clock_timestamp() - make_interval(secs => $2) from replica
      where id = $1`,
    [id, seconds],
  );

/** Ben, alpha's approver, records Astra's approving review. */
const review = async (id: string, versionDigest: string) =>
  await w.as(w.ben, {
    command: 'live_correction.record_review',
    correctionId: id,
    versionDigest,
    verdict: 'approve',
    review: REVIEW,
  });

/** What a refusal must leave as it was: the row's state and revision, and its reviews. */
const footprint = async (id: string) =>
  (
    await w.world.db.admin.execute<{
      readonly state: string;
      readonly revision: number;
      readonly reviews: string;
    }>(
      `select c.state, c.revision,
              (select count(*)::text from public.live_correction_reviews r
                where r.correction_id = c.id) as reviews
         from public.live_corrections c where c.id = $1`,
      [id],
    )
  )[0];

const pause = async (ms: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe.skipIf(serverUrl === undefined)('a review is recorded only on a checked version', () => {
  it('refuses a review of a correction with no version before saying it is decided', async () => {
    const waiting = await locating();
    const unlocated = await locating();
    await admin(
      `update public.live_corrections
          set state = 'unlocated', locate_code = 'WORD_NOT_FOUND', located_at = clock_timestamp()
        where id = $1`,
      [unlocated],
    );
    const drifted = await pinned();
    await admin(
      `update public.live_corrections
          set state = 'superseded', locate_code = 'CONTENT_DRIFTED', revision = revision + 1
        where id = $1`,
      [drifted.id],
    );
    for (const [id, digest] of [
      [waiting, TEST_PIN.versionDigest],
      [unlocated, TEST_PIN.versionDigest],
      [drifted.id, drifted.digest],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one correction after another
      const before = await footprint(id);
      // oxlint-disable-next-line no-await-in-loop -- one correction after another
      expect(codeOf(await review(id, digest))).toBe('VERSION_NOT_READY');
      // oxlint-disable-next-line no-await-in-loop -- one correction after another
      expect(await footprint(id)).toStrictEqual(before);
    }
  });
});

describe.skipIf(serverUrl === undefined)('a review is recorded only on a checked version', () => {
  it("refuses another correction's digest as stale before it asks whether the page was checked", async () => {
    const other = await pinned();
    const asked = await pinned();
    expect(other.digest).not.toBe(asked.digest);
    await checkedAgo(asked.id, 61);
    const before = await footprint(asked.id);
    expect(codeOf(await review(asked.id, other.digest))).toBe('VERSION_STALE');
    expect(await footprint(asked.id)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('a review is recorded only on a checked version', () => {
  it('refuses a review of a version never checked, or checked over 60 s ago, storing nothing', async () => {
    const never = await locating();
    const digest = `sha256:${'ef'.repeat(32)}`;
    await admin(
      `update public.live_corrections
          set pre_image_digest = $2, base_revision = $3, version_id = gen_random_uuid(),
              version_digest = $4, located_at = clock_timestamp(), state = 'requested'
        where id = $1`,
      [never, TEST_PIN.preImageDigest, TEST_PIN.baseRevision, digest],
    );
    const unchecked = await footprint(never);
    expect(codeOf(await review(never, digest))).toBe('VERSION_UNVERIFIED');
    expect(await footprint(never)).toStrictEqual(unchecked);

    const aged = await pinned();
    await checkedAgo(aged.id, 61);
    const before = await footprint(aged.id);
    expect(codeOf(await review(aged.id, aged.digest))).toBe('VERSION_UNVERIFIED');
    expect(await footprint(aged.id)).toStrictEqual(before);

    await checkedAgo(aged.id, 0);
    expect(codeOf(await review(aged.id, aged.digest))).toBe('not-a-refusal');
    expect((await footprint(aged.id))?.reviews).toBe('1');
  });
});

describe.skipIf(serverUrl === undefined)('a review is recorded only on a checked version', () => {
  it("reads the check's age after the row's lock wait, not before it", async () => {
    const asked = await pinned();
    await checkedAgo(asked.id, 58);
    const holding = heldIn(w, w.world.business, async (tx) => {
      await tx.query(
        'select id from public.live_corrections where business_id = $1 and id = $2 for update',
        [tx.businessId, asked.id],
      );
    });
    await holding.ready;
    const answer = review(asked.id, asked.digest);
    try {
      // The locking read opens with the grants prefix; the table name lies past the 1 kB of
      // statement text pg_stat_activity keeps.
      expect(await waitedFor(w, /with recursive effective as/u)).toBe(true);
      await pause(3_000);
    } finally {
      holding.release();
      await holding.done;
    }
    expect(codeOf(await answer)).toBe('VERSION_UNVERIFIED');
    expect((await footprint(asked.id))?.reviews).toBe('0');
  });
});

describe.skipIf(serverUrl === undefined)('a review is recorded only on a checked version', () => {
  it("leaves a single operator's first self-approval unreviewed when her review was refused", async () => {
    expect(codeOf(await setMode(w, w.beta, w.eve, true))).toBe('not-a-refusal');
    const asked = await eveRequests(w);
    await checkedAgo(asked.id, 61);
    expect(codeOf(await recordReview(w, asked.id, asked.digest))).toBe('VERSION_UNVERIFIED');
    await checkedAgo(asked.id, 0);
    expect(codeOf(await decide(w, asked))).toBe('ASTRA_REVIEW_MISSING');

    expect(codeOf(await recordReview(w, asked.id, asked.digest))).toBe('not-a-refusal');
    const approved = await decide(w, asked);
    expect(codeOf(approved)).toBe('not-a-refusal');
    expect(detailOf(approved)['singleOperatorSelfApproval']).toBe(true);
  });
});

describe.skipIf(serverUrl === undefined)('a review is recorded only on a checked version', () => {
  it("refuses a superseded version's review, and an earlier correction's digest on the one asked again (proof e)", async () => {
    const earlier = await pinned();
    const launched = await w.as(w.ben, {
      command: 'live_correction.decide',
      correctionId: earlier.id,
      versionId: earlier.versionId,
      decision: 'approve',
    });
    expect(codeOf(launched)).toBe('not-a-refusal');

    const first = await pinned();
    await admin(
      `update public.live_corrections
          set state = 'superseded', locate_code = 'CONTENT_DRIFTED', revision = revision + 1
        where id = $1`,
      [first.id],
    );
    const superseded = await footprint(first.id);
    expect(codeOf(await review(first.id, first.digest))).toBe('VERSION_NOT_READY');
    expect(await footprint(first.id)).toStrictEqual(superseded);

    const again = await pinned();
    const before = await footprint(again.id);
    expect(codeOf(await review(again.id, first.digest))).toBe('VERSION_STALE');
    expect(codeOf(await review(again.id, earlier.digest))).toBe('VERSION_STALE');
    expect(await footprint(again.id)).toStrictEqual(before);
    expect(codeOf(await review(again.id, again.digest))).toBe('not-a-refusal');
  });
});
