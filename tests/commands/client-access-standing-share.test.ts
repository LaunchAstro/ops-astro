// SPDX-License-Identifier: AGPL-3.0-only
//
// Client access (MP-4-10, R45) is on exactly when someone outside the
// membership holds a read share on the task that still stands: the share's
// whole chain is live, as the grant check reads it. A derived share whose
// parent was revoked is a row and no longer authority, so it does not hold
// the tick on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo, WHOLE_BUSINESS } from './fixture.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { outsideHolders } from '../../packages/core-commands/src/reads/tasks.ts';
import {
  admin,
  alpha,
  clientAccessOf,
  SHARE,
  toggle,
  clientB,
  clientPerson,
  db,
  fresh,
  liveHolders,
  outcomeOf,
  readAs,
  reader,
  serverUrl,
  setUp,
  tearDown,
} from './client-access-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** A read share on `task` for `outsider`, derived from the reader's delegable read: returns that parent. */
async function deriveShare(task: string, outsider: { readonly personId: string }): Promise<string> {
  return await db.app.withBusiness(alpha, async (tx) => {
    const delegable = await grantTo(tx, reader, 'read', WHOLE_BUSINESS, true);
    const derived = await issueGrant(tx, [{ kind: 'person', id: reader.personId }], {
      subject: { kind: 'person', id: outsider.personId },
      scope: { kind: 'record', id: task },
      collection: 'task',
      action: 'read',
      parentGrantId: delegable,
      grantedByActorId: reader.actorId,
    });
    if (!derived.ok) throw new Error(`derived share refused ${derived.refusal.code}`);
    return delegable;
  });
}

const revoke = async (grantId: string): Promise<void> => {
  await db.app.withBusiness(alpha, async (tx) => await revokeGrant(tx, grantId));
};

const standingHolders = async (task: string): Promise<readonly string[]> =>
  await db.app.withBusiness(alpha, async (tx) => await outsideHolders(tx, task));

describe.skipIf(serverUrl === undefined)(
  'MP-4-10 client access counts only a standing share',
  () => {
    it('a derived read share whose parent is revoked leaves the tick off and the outsider refused', async () => {
      const task = await fresh(alpha, admin, 'shared under a delegation', null);
      // An outsider standing on another client, so the share below is their only reach here.
      const outsider = await clientPerson(alpha, clientB, admin);
      const parent = await deriveShare(task, outsider);
      expect(await clientAccessOf(admin, task)).toBe(true);
      expect(outcomeOf(await readAs(alpha, outsider, task))).toStrictEqual({ applied: true });

      await revoke(parent);

      // The derived row itself is untouched: only its parent went.
      expect(await liveHolders(task)).toStrictEqual([outsider.personId]);
      expect(await standingHolders(task)).toStrictEqual([]);
      expect(await clientAccessOf(admin, task)).toBe(false);
      expect(outcomeOf(await readAs(alpha, outsider, task))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('turning Client access on past a dead derived share issues one that stands', async () => {
      const task = await fresh(alpha, admin, 'shared again after a delegation lapsed', clientB);
      const outsider = await clientPerson(alpha, clientB, admin);
      await revoke(await deriveShare(task, outsider));
      expect(await clientAccessOf(admin, task)).toBe(false);

      expect(outcomeOf(await toggle(alpha, admin, SHARE, task))).toStrictEqual({ applied: true });
      expect(await standingHolders(task)).toContain(outsider.personId);
      expect(await clientAccessOf(admin, task)).toBe(true);
    });
  },
);
