// SPDX-License-Identifier: AGPL-3.0-only
//
// Security review 2b2, finding 3: an agent credential's subject carries the
// keys its person ticked (`within`, API-2). The subject reads that do not go
// through `effectiveGrants` must honour it too, so a credential that ticked
// only `task:write` reaches nothing a `task:read` or client list would show.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changesSince,
  clientsReached,
  grantFingerprint,
  heldScopes,
} from '../../packages/core-records/src/index.ts';
import type { Subject } from '../../packages/core-records/src/authority/grants.ts';
import { holdCoveringGrants } from '../../packages/core-runtime/src/recovery/classifier.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World, type Party } from '../runtime/cq-8-world.ts';
import { changeKit, ids, tasksOf } from './c4-change-support.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('api/credential-within-reads: DATABASE_URL is unset.');

let s: Schedules;
let alpha: Party;
const { touch, pointAfter } = changeKit(() => s);

/** The member as an agent credential that ticked only these keys. */
const within = (keys: readonly string[]): Subject[] => [
  { kind: 'person', id: alpha.member.personId, within: keys },
];
const whole = (): Subject[] => [{ kind: 'person', id: alpha.member.personId }];

/** within: heldScopes answers no scope for a key the credential did not tick */
async function heldScopesHonoursWithin(): Promise<void> {
  const request = { collection: 'task', action: 'read' } as const;
  const [ticked, unticked] = await s.db.app.withBusiness(alpha.id, async (tx) => [
    await heldScopes(tx, within(['task:read']), request),
    await heldScopes(tx, within(['task:write']), request),
  ]);
  expect(ticked).toEqual([{ kind: 'business', id: null }]);
  expect(unticked).toEqual([]);
}

/** within: changesSince returns no task to a credential that did not tick task:read */
async function changesSinceHonoursWithin(): Promise<void> {
  const [one] = tasksOf(alpha);
  await touch(alpha.id, [one]);
  const point = String(BigInt(await pointAfter(one)) - 1n);
  const read = async (subjects: Subject[]) =>
    await s.db.app.withBusiness(alpha.id, async (tx) => await changesSince(tx, subjects, point));
  const ticked = await read(within(['task:read']));
  const unticked = await read(within(['task:write']));
  if (ticked === 'POINT_INVALID' || unticked === 'POINT_INVALID') throw new Error('point');
  expect(ids(ticked)).toContain(one);
  expect(ids(unticked)).toEqual([]);
}

/** within: clientsReached refuses a credential's subject, which names no key for it */
async function clientsReachedHonoursWithin(): Promise<void> {
  const [plain, credential] = await s.db.app.withBusiness(alpha.id, async (tx) => [
    await clientsReached(tx, whole()),
    await clientsReached(tx, within(['task:read', 'task:write', 'task:share'])),
  ]);
  expect(plain).not.toBeNull();
  expect(credential).toBeNull();
}

/** within: grantFingerprint covers only the ticked keys' grants */
async function fingerprintHonoursWithin(): Promise<void> {
  const [all, readOnly, none, nobody] = await s.db.app.withBusiness(alpha.id, async (tx) => [
    await grantFingerprint(tx, whole()),
    await grantFingerprint(tx, within(['task:read'])),
    await grantFingerprint(tx, within([])),
    await grantFingerprint(tx, []),
  ]);
  expect(readOnly).not.toBe(all);
  expect(none).toBe(nobody);
}

/** Whether the member's grant of this task action can be locked from another connection now. */
async function grantFree(action: string): Promise<boolean> {
  try {
    await s.db.admin.execute(
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = $3
        for update nowait`,
      [alpha.id, alpha.member.personId, action],
    );
    return true;
  } catch {
    return false;
  }
}

/** within: holdCoveringGrants holds only the ticked keys' grants */
async function holdCoveringHonoursWithin(): Promise<void> {
  const seen = await s.db.app.withBusiness(alpha.id, async (tx) => {
    await holdCoveringGrants(tx, within(['task:read']), 'task');
    return { read: await grantFree('read'), write: await grantFree('write') };
  });
  expect(seen).toEqual({ read: false, write: true });
}

describe.skipIf(serverUrl === undefined)(
  'within honoured by subject reads outside effectiveGrants',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      s = await openSchedules('cwr', 1_000_000);
      alpha = await cq8World(s).party(`cwr-${randomUUID().slice(0, 8)}`);
    }, 180_000);
    afterAll(async () => {
      await s?.db.drop();
    });
    it(
      'within: heldScopes answers no scope for a key the credential did not tick',
      heldScopesHonoursWithin,
    );
    it(
      'within: changesSince returns no task to a credential that did not tick task:read',
      changesSinceHonoursWithin,
    );
    it(
      "within: clientsReached refuses a credential's subject, which names no key for it",
      clientsReachedHonoursWithin,
    );
    it("within: grantFingerprint covers only the ticked keys' grants", fingerprintHonoursWithin);
    it("within: holdCoveringGrants holds only the ticked keys' grants", holdCoveringHonoursWithin);
  },
);
