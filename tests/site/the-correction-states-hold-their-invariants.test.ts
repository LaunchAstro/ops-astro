// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693, gap 3: the locate's state contract, held by the storage, and the
// decision's guard order. A request is `locating` with no pins; the pins move
// once, together, as it becomes `requested`; `unlocated` and `superseded`
// carry their fixed code; the schedule moves only forward while waiting. A
// decision refuses a correction with no version (`VERSION_NOT_READY`) before
// it says it is decided, then a stale version, then a check older than 60 s
// (`VERSION_UNVERIFIED`), and the row's revision never moves on a refusal.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { c80World, pinFromBefore, type C80World } from './c80-world.ts';
import { TEST_PIN } from './located.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Correction states: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('states');
}, 120_000);

/** A request through the door, `locating`, as the server stores it. */
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

const admin = async (sql: string, parameters: readonly unknown[] = []) =>
  await w.world.db.admin.execute(sql, parameters);

/** A write past the trigger, for a seed the storage would refuse to move to. */
const forced = async (sql: string, parameters: readonly unknown[] = []) =>
  await admin(
    `with replica as (select set_config('session_replication_role', 'replica', true))
     ${sql}`,
    parameters,
  );

const rowOf = async (id: string) =>
  (
    await w.world.db.admin.execute<{ readonly state: string; readonly revision: number }>(
      'select state, revision from public.live_corrections where id = $1',
      [id],
    )
  )[0];

const decide = async (id: string, versionId: string) =>
  await w.as(w.ben, {
    command: 'live_correction.decide',
    correctionId: id,
    versionId,
    decision: 'approve',
  });

const PINS = `pre_image_digest = '${TEST_PIN.preImageDigest}', base_revision = '${TEST_PIN.baseRevision}',
  version_id = gen_random_uuid(), version_digest = '${TEST_PIN.versionDigest}'`;

describe.skipIf(serverUrl === undefined)('the correction states hold their invariants', () => {
  it('cancels a locating correction with nothing pinned', async () => {
    const id = await locating();
    await admin(`update public.live_corrections set state = 'cancelled' where id = $1`, [id]);
    expect((await rowOf(id))?.state).toBe('cancelled');
  });
});

describe.skipIf(serverUrl === undefined)('the correction states hold their invariants', () => {
  it.each([
    ['approved with no pins', `set state = 'approved'`],
    ['unlocated with no code', `set state = 'unlocated', located_at = now()`],
    ['a pin with no located_at', `set ${PINS}, state = 'requested'`],
    [
      'a pin that also changes the word',
      `set ${PINS}, state = 'requested', located_at = now(), word = 'cheerful'`,
    ],
    [
      'a pin with a revision not hex',
      `set ${PINS}, base_revision = 'rev-1', state = 'requested', located_at = now()`,
    ],
    [
      'a pin with a digest not sha256',
      `set ${PINS}, pre_image_digest = 'sha256:pre', state = 'requested', located_at = now()`,
    ],
    ['pins left locating', `set ${PINS}, located_at = now()`],
    [
      'superseded straight from locating',
      `set state = 'superseded', locate_code = 'CONTENT_DRIFTED'`,
    ],
    [
      'a code outside the list',
      `set state = 'unlocated', located_at = now(), locate_code = 'WHATEVER'`,
    ],
  ])('refuses %s', async (_name, update) => {
    const id = await locating();
    await expect(
      admin(`update public.live_corrections ${update} where id = $1`, [id]),
    ).rejects.toThrow();
    expect((await rowOf(id))?.state).toBe('locating');
  });
});

describe.skipIf(serverUrl === undefined)('the correction states hold their invariants', () => {
  it('keeps a pin once set, and moves the check only forward', async () => {
    const id = await locating();
    await pinFromBefore(w.world.db.admin, id);
    await expect(
      admin(`update public.live_corrections set base_revision = $2 where id = $1`, [
        id,
        'ab'.repeat(20),
      ]),
    ).rejects.toThrow(/keeps what it pinned/u);
    await expect(
      admin(
        `update public.live_corrections set verified_at = verified_at - interval '1 minute' where id = $1`,
        [id],
      ),
    ).rejects.toThrow(/keeps when it was checked/u);
  });
});

describe.skipIf(serverUrl === undefined)('the correction states hold their invariants', () => {
  it('decides in the stated order, leaving the revision unchanged on each refusal', async () => {
    const notReady = await locating();
    const ready = await rowOf(notReady);
    expect(codeOf(await decide(notReady, notReady))).toBe('VERSION_NOT_READY');
    expect(await rowOf(notReady)).toStrictEqual(ready);

    const stale = await locating();
    const { versionId } = await pinFromBefore(w.world.db.admin, stale);
    const before = await rowOf(stale);
    expect(codeOf(await decide(stale, stale))).toBe('VERSION_STALE');
    expect(await rowOf(stale)).toStrictEqual(before);

    await forced(
      `update public.live_corrections set verified_at = clock_timestamp() - interval '61 seconds' from replica where id = $1`,
      [stale],
    );
    expect(codeOf(await decide(stale, versionId))).toBe('VERSION_UNVERIFIED');
    expect(await rowOf(stale)).toStrictEqual(before);

    await forced(
      `update public.live_corrections set verified_at = clock_timestamp() from replica where id = $1`,
      [stale],
    );
    expect(codeOf(await decide(stale, versionId))).toBe('not-a-refusal');
    const decided = await rowOf(stale);
    expect(codeOf(await decide(stale, stale))).toBe('GATE_ALREADY_DECIDED');
    expect(await rowOf(stale)).toStrictEqual(decided);
  });
});
