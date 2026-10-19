// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2017) audit readback: the shepherd's raise is recorded under the worker's actor with the
// review's task as its subject, a person's approval under that person's actor, and both join the
// business's audit chain, each hash recomputed from its row and linked to the one before.

import { describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import {
  approved,
  inSide,
  noDatabase,
  on,
  raisedScene,
  useShepherdWorld,
  w,
} from './shepherd-world.ts';

useShepherdWorld('c57audit');

describe.skipIf(noDatabase)(
  "C57 the shepherd's raise and approval read back from the audit chain",
  () => {
    it('C57 audit readback: the raise and the approval are audited under their actors and the chain verifies', async () => {
      const { scene, raised } = await raisedScene();
      await approved('alpha', raised);
      const rows = await w.db.admin.execute<{
        readonly command: string;
        readonly actor: string;
        readonly subject: string | null;
        readonly outcome: string;
        readonly hash: string;
      }>(
        `select command, actor_id::text as actor, subject_record_id::text as subject, outcome, hash
         from public.audit_events
        where business_id = $1 and command like 'review.shepherd%'
        order by seq`,
        [on('alpha').business],
      );
      expect(
        rows.map(({ command, actor, subject, outcome }) => ({ command, actor, subject, outcome })),
      ).toStrictEqual([
        {
          command: 'review.shepherd_raise',
          actor: w.worker.alpha,
          subject: scene.task,
          outcome: 'applied',
        },
        {
          command: 'review.shepherd_approve',
          actor: on('alpha').decider.actorId,
          subject: null,
          outcome: 'applied',
        },
      ]);
      for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{64}$/u);
      // The worker that raised it is a worker, the approver a person.
      const kinds = await w.db.admin.execute<{ readonly id: string; readonly kind: string }>(
        'select id::text as id, kind from public.actors where id = any($1::uuid[]) order by kind',
        [[w.worker.alpha, on('alpha').decider.actorId]],
      );
      expect(kinds.map((row) => row.kind)).toStrictEqual(['person', 'worker']);
      const chain = await inSide('alpha', async (tx) => await verifyAuditChain(tx));
      expect(chain.firstBreak).toBeUndefined();
      expect(chain.intact).toBe(true);
      expect(chain.length).toBeGreaterThanOrEqual(2);
    });
  },
);
