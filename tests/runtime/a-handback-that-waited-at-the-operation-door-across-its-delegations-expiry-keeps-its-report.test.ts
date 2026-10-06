// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's handback is admitted while its delegation is live, then waits at
// the operation door (one request per operation id at a time, `envelope.ts`)
// while the delegation's own expiry passes. Resolved after the wait, the
// delegation is no longer live, so the handback is refused
// `DELEGATION_NOT_LIVE`; and the late report it carried is the one an expired
// delegation's handback keeps (`retainLateHandback`). The live and the
// historical resolution must judge the same expiry at the same clock: the
// report is retained once, unaccepted, on the lease and fence it was made
// under, and nothing settles.

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advisoryLock } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a handback across its delegation expiry',
  () => {
    let c: Controls;

    beforeAll(async () => {
      c = await createControls('handbackexpiry');
    }, 180_000);

    afterAll(async () => await c?.drop());

    it('a handback that waited at the operation door across its delegation expiry keeps its report, and settles nothing', async () => {
      const task = await c.createTask('a handback that outlives its delegation');
      const picked = await c.pickup(await c.approve(await c.propose(task.id, task.revision)));
      const leaseId = String(picked['leaseId']);
      const delegationId = String(picked['delegationId']);
      const state = async (): Promise<string> => {
        const [row] = await c.fixture.db.admin.execute<{ readonly state: string }>(
          `select jsonb_build_object(
             'lease', (select to_jsonb(l) from public.leases l where l.id = $1),
             'settled', (select settled_at from public.delegations where id = $2),
             'task', (select to_jsonb(r) - 'updated_at' from public.records r where r.id = $3)
           )::text as state`,
          [leaseId, delegationId, task.id],
        );
        return String(row?.state);
      };
      const before = await state();
      const operationId = randomUUID();
      const body = {
        operationId,
        leaseId,
        fence: Number(picked['fence']),
        outcome: 'completed',
        report: { wrote: 'a draft finished as the delegation ran out' },
      };
      const business = c.fixture.business;
      const identity = createHash('sha256').update(operationId).digest('hex');
      const door = await hold(c.fixture.db.appUrl, business, async (tx) => {
        await advisoryLock(
          tx,
          `operation:${business.toLowerCase()}:${c.fixture.agentActorId}:${identity}`,
        );
      });
      let answering: ReturnType<Controls['asAgent']> | undefined;
      try {
        await c.fixture.db.admin.execute(
          `update public.delegations set expires_at = clock_timestamp() + interval '3 seconds'
            where id = $1`,
          [delegationId],
        );
        answering = c.asAgent('task.handback', body, String(picked['credential']));
        await waitingOn(c.fixture.db.admin, 'advisory', 'pg_advisory_xact_lock');
        // Admitted while the delegation was live: the waiter's transaction began before expiry.
        const [admitted] = await c.fixture.db.admin.execute<{ readonly live: boolean }>(
          `select bool_and(a.xact_start < d.expires_at) as live
             from pg_stat_activity a, public.delegations d
            where d.id = $1 and a.wait_event_type = 'Lock' and a.wait_event = 'advisory'
              and a.datname = current_database()`,
          [delegationId],
        );
        expect(admitted?.live, 'the handback was admitted before its delegation expired').toBe(
          true,
        );
        for (let look = 0; look < 500; look += 1) {
          // oxlint-disable-next-line no-await-in-loop -- polls the clock, one look at a time
          const [past] = await c.fixture.db.admin.execute<{ readonly past: boolean }>(
            'select clock_timestamp() > expires_at as past from public.delegations where id = $1',
            [delegationId],
          );
          if (past?.past === true) break;
          // oxlint-disable-next-line no-await-in-loop -- polls the clock, one look at a time
          await delay(20);
        }
      } finally {
        await door.letGo();
      }
      const answer = await answering;
      const reports = await c.fixture.db.admin.execute<{
        readonly disposition: string;
        readonly refusal_code: string | null;
        readonly fence: string;
        readonly report: unknown;
      }>(
        `select disposition, refusal_code, fence::text as fence, report
           from public.handback_reports where lease_id = $1`,
        [leaseId],
      );
      expect({ status: answer?.status, code: answer?.body['code'], reports }).toEqual({
        status: 401,
        code: 'DELEGATION_NOT_LIVE',
        reports: [
          {
            disposition: 'retained',
            refusal_code: 'DELEGATION_NOT_LIVE',
            fence: String(picked['fence']),
            report: body.report,
          },
        ],
      });
      expect(await state()).toBe(before);
    });
  },
);
