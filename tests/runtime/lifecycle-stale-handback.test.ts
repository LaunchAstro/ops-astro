// SPDX-License-Identifier: AGPL-3.0-only
//
// F3 (runtime review at 4757d72): work on a superseded version cannot settle,
// and cannot supersede the newer proposal.
//
// T4, TRANSACTION-CONTRACT line 72: handback re-reads "every parent link,
// active proposal version ... and reservation eligibility after all locks are
// held"; line 78: "Late or superseded lease handback cannot settle work". The
// reviewer's sequence: approve and pick up V1, a person proposes V2 on the
// same lineage, and the V1 holder hands back. Before this suite that handback
// settled, and with a successor it wrote V3 from the stale work and silently
// superseded V2.
//
// Every step goes through the HTTP command entry the product runs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('handback against a superseded version', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('lcstale');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  /** V1 approved and picked up, then V2 proposed on the same lineage by a person. */
  async function supersededWork(purpose: string): Promise<{
    picked: Record<string, unknown>;
    v2: Record<string, unknown>;
    lineageId: string;
  }> {
    const task = await c.createTask(`a task for ${purpose}`);
    const v1 = await c.propose(task.id, task.revision, purpose);
    const reservationId = await c.approve(v1);
    const picked = await c.pickup(reservationId);
    const v2 = await c.asPerson('task.propose', {
      recordId: task.id,
      expectedRevision: task.revision,
      lineageId: v1['lineageId'],
      ...PROPOSAL,
      purpose,
      maximumMinor: 1_000,
    });
    expect(v2.status).toBe(200);
    return { picked, v2: detailOf(v2), lineageId: String(v1['lineageId']) };
  }

  const settledReports = `select count(*)::text as n from public.handback_reports
    where lease_id = $1 and disposition = 'settled'`;
  const retainedReports = `select count(*)::text as n from public.handback_reports
    where lease_id = $1 and disposition = 'retained'`;

  it('retires the old lease and delegation when a person supersedes the version', async () => {
    const work = await supersededWork('supersede_retires');
    expect(
      await c.count(
        `select count(*)::text as n from public.leases l
           join public.delegations d on d.id = l.delegation_id
          where l.id = $1 and l.state <> 'live'
            and (d.revoked_at is not null or d.settled_at is not null)`,
        [work.picked['leaseId']],
      ),
    ).toBe(1);
  });

  it('refuses the ordinary handback, keeps the report unaccepted, and settles nothing', async () => {
    const work = await supersededWork('stale_ordinary');
    const answer = await c.asAgent(
      'task.handback',
      {
        leaseId: work.picked['leaseId'],
        fence: work.picked['fence'],
        outcome: 'completed',
        report: { note: 'done against V1' },
      },
      String(work.picked['credential']),
    );
    expect(answer.status).not.toBe(200);
    expect(['LEASE_NOT_OWNED', 'LEASE_EXPIRED', 'DELEGATION_NOT_LIVE']).toContain(
      answer.body['code'],
    );
    expect(await c.count(settledReports, [work.picked['leaseId']])).toBe(0);
  });

  it('refuses the successor from stale work and leaves V2 the live version', async () => {
    const work = await supersededWork('stale_successor');
    const answer = await c.asAgent(
      'task.handback',
      {
        leaseId: work.picked['leaseId'],
        fence: work.picked['fence'],
        outcome: 'completed',
        report: { note: 'done against V1, proposing more' },
        successor: { ...PROPOSAL, purpose: 'stale_successor', maximumMinor: 100 },
      },
      String(work.picked['credential']),
    );
    // At 4757d72 this answered 500: the stale successor reached the writer.
    expect(['LEASE_NOT_OWNED', 'LEASE_EXPIRED', 'DELEGATION_NOT_LIVE']).toContain(
      answer.body['code'],
    );
    expect(await c.count(settledReports, [work.picked['leaseId']])).toBe(0);
    expect(
      await c.count(
        `select count(*)::text as n from public.proposal_versions
          where lineage_id = $1 and superseded_at is null and id = $2`,
        [work.lineageId, work.v2['versionId']],
      ),
    ).toBe(1);
    expect(
      await c.count(
        `select count(*)::text as n from public.proposal_versions where lineage_id = $1`,
        [work.lineageId],
      ),
    ).toBe(2);
  });

  it('keeps the report as unaccepted evidence when the lease is still live under a superseded version', async () => {
    // The runtime's own recheck, independent of supersession retiring the
    // lease: the lease is put back to live directly, which is the state an
    // interleaving without retirement would leave, and the handback must still
    // refuse on the version rather than settle.
    const work = await supersededWork('stale_live_lease');
    await c.fixture.db.admin.execute(
      `update public.leases set state = 'live', released_at = null where id = $1`,
      [work.picked['leaseId']],
    );
    await c.fixture.db.admin.execute(
      `update public.delegations set revoked_at = null, settled_at = null
        where id = (select delegation_id from public.leases where id = $1)`,
      [work.picked['leaseId']],
    );
    const answer = await c.asAgent(
      'task.handback',
      {
        leaseId: work.picked['leaseId'],
        fence: work.picked['fence'],
        outcome: 'completed',
        report: { note: 'done against V1' },
      },
      String(work.picked['credential']),
    );
    expect(answer.body['code']).toBe('LEASE_NOT_OWNED');
    expect(await c.count(settledReports, [work.picked['leaseId']])).toBe(0);
    expect(await c.count(retainedReports, [work.picked['leaseId']])).toBe(1);
  });
});
