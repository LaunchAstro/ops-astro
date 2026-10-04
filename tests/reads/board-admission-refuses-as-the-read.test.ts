// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #415: Sol's OW-041 admission proof (titles named by behaviour,
// bodies unchanged; R/sol/proofs/OW-041-4126931d1.patch). The live channel's
// recheck must refuse what the read itself refuses.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admitReads, executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { timeWorld, type TimeWorld } from '../commands/time-world.ts';
import { grantTo } from '../commands/fixture.ts';
import { serverUrl } from '../acceptance/world.ts';

describe.skipIf(serverUrl === undefined)(
  'board admission refuses what the board read refuses',
  () => {
    let w: TimeWorld;
    beforeAll(async () => {
      w = await timeWorld('solow041admit');
    }, 180_000);
    afterAll(async () => {
      await w?.db.drop();
    });

    it('admission refuses a board after its person loses the read grant', async () => {
      const request = { read: 'task.board', board: null } as const;
      const grant = await w.db.app.withBusiness(
        w.alpha,
        async (tx) => await grantTo(tx, w.clientA, 'read'),
      );
      const before = await executeRead(w.db.app, w.alpha, w.clientA.presented, request);
      expect(isCommandRefusal(before)).toBe(false);
      await w.db.app.withBusiness(w.alpha, async (tx) => {
        await tx.query(
          'update public.grants set revoked_at = greatest(now(), granted_at) where id = $1',
          [grant],
        );
      });
      const read = await executeRead(w.db.app, w.alpha, w.clientA.presented, request);
      expect(isCommandRefusal(read) && read.code).toBe('SCOPE_NOT_GRANTED');
      const admissions = await admitReads(
        w.db.app,
        w.alpha,
        w.clientA.presented,
        [request],
        'recheck',
      );
      if (isCommandRefusal(admissions)) throw new Error('the person must retain membership');
      expect(
        admissions[0],
        'admission must refuse the same read executeRead refuses',
      ).toMatchObject({
        refused: true,
        code: 'SCOPE_NOT_GRANTED',
      });
    });

    it('admission refuses a foreign board just as the read does', async () => {
      const foreign = await w.fresh(w.bravo, w.bravoOwner, 'foreign board');
      const request = { read: 'task.board', board: foreign } as const;
      const read = await executeRead(w.db.app, w.alpha, w.ada.presented, request);
      expect(isCommandRefusal(read) && read.code).toBe('NOT_FOUND');
      const admissions = await admitReads(w.db.app, w.alpha, w.ada.presented, [request], 'door');
      if (isCommandRefusal(admissions)) throw new Error('the person must retain membership');
      expect(admissions[0], 'admission must refuse the foreign board').toMatchObject({
        refused: true,
        code: 'NOT_FOUND',
      });
    });
  },
);
