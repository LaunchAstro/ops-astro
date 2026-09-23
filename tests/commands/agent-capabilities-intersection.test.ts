// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's `session.capabilities`, over the real agent route, reports the
// current intersection and nothing wider (root ruling 5, L6 EX-35).
//
// The pairs are what the delegation's purpose carries and the delegating
// person's effective grants still cover on the picked-up task, read on every
// call. A person who keeps `read` and loses `write` to grant expiry leaves an
// agent that is told `read`, not `write`: no lifecycle write happened, so
// nothing but the answer itself can say so.
//
// A capabilities replay answers the rights presented now. The register row
// keeps the first answer, but the protected part of it, the purpose scope, is
// the delegation's, so a replay under another delegation's credential is
// projected again for that delegation rather than handed the first one's scope
// (TRANSACTION-CONTRACT line 11).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { grantTo } from './fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Pair = { readonly collection: string; readonly action: string };

const pairsOf = (body: Record<string, unknown>): string[] =>
  ((body['grants'] as readonly Pair[] | undefined) ?? [])
    .map((pair) => `${pair.collection}:${pair.action}`)
    .toSorted();

describe.skipIf(serverUrl === undefined)('agent session.capabilities is the intersection', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('agcap');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  /** A picked-up task under a purpose of its own. */
  async function pickedUp(title: string): Promise<Record<string, unknown>> {
    const task = await c.createTask(title);
    const reservationId = await c.approve(
      await c.propose(task.id, task.revision, `cap_${randomUUID().slice(0, 8)}`),
    );
    return { ...(await c.pickup(reservationId)), taskId: task.id };
  }

  async function handBack(picked: Record<string, unknown>): Promise<void> {
    const answer = await c.asAgent(
      'task.handback',
      {
        operationId: randomUUID(),
        leaseId: picked['leaseId'],
        fence: picked['fence'],
        outcome: 'completed',
        report: { wrote: 'done' },
      },
      String(picked['credential']),
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  }

  /** The member's live grants for one action, by id. */
  async function liveGrants(action: string): Promise<string[]> {
    const rows = await c.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from public.grants where business_id = $1 and subject_kind = 'person'
        and subject_id = $2 and action = $3 and revoked_at is null
        and (expires_at is null or expires_at > now())`,
      [c.fixture.business, c.manager.personId, action],
    );
    return rows.map((row) => row.id);
  }

  it('reports every pair the purpose carries while the person holds them all', async () => {
    const picked = await pickedUp('an agent with its person fully granted');
    const answer = await c.asAgent(
      'session.capabilities',
      { operationId: randomUUID() },
      String(picked['credential']),
    );
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body['purposeScope']).toStrictEqual({ kind: 'record', id: picked['taskId'] });
    // The pickup's purpose carries read, comment and write on `task`, and the
    // fixture's member holds all three.
    expect(pairsOf(answer.body)).toStrictEqual(['task:comment', 'task:read', 'task:write']);
    await handBack(picked);
  });

  it('reports read and not write once the person’s write grant has expired (CA1)', async () => {
    const picked = await pickedUp('an agent whose person loses write to expiry');
    const writes = await liveGrants('write');
    expect(writes.length).toBeGreaterThan(0);
    // Grant expiry only: no revocation, no delegation or lease lifecycle write.
    await c.fixture.db.admin.execute(
      `update public.grants set granted_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 hour'
        where id = any($1::uuid[])`,
      [writes],
    );
    const answer = await c.asAgent(
      'session.capabilities',
      { operationId: randomUUID() },
      String(picked['credential']),
    );
    // Restored under a new row before any assertion can fail.
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, c.manager, 'write');
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(pairsOf(answer.body)).toStrictEqual(['task:comment', 'task:read']);
    expect(pairsOf(answer.body)).not.toContain('task:write');
    await handBack(picked);
  });

  it('still refuses DELEGATION_NARROWED once the person holds nothing the purpose carries', async () => {
    const picked = await pickedUp('an agent whose person loses everything');
    const held = await c.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from public.grants where business_id = $1 and subject_kind = 'person'
        and subject_id = $2 and revoked_at is null`,
      [c.fixture.business, c.manager.personId],
    );
    // Expired rather than revoked, so no revocation cascade touches the delegation.
    await c.fixture.db.admin.execute(
      `update public.grants set granted_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 hour'
        where id = any($1::uuid[])`,
      [held.map((row) => row.id)],
    );
    const answer = await c.asAgent(
      'session.capabilities',
      { operationId: randomUUID() },
      String(picked['credential']),
    );
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment', 'manage'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, one connection
        await grantTo(tx, c.manager, action);
      }
    });
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('DELEGATION_NARROWED');
    expect(answer.body['grants']).toBeUndefined();
    expect(answer.body['purposeScope']).toBeUndefined();
    await handBack(picked);
  });

  it('never releases delegation A’s scope to a replay under delegation B’s credential (CA2)', async () => {
    const a = await pickedUp('the first delegation an agent asks about');
    const operationId = randomUUID();
    const first = await c.asAgent('session.capabilities', { operationId }, String(a['credential']));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['purposeScope']).toStrictEqual({ kind: 'record', id: a['taskId'] });

    // The same delegation, the same identity: answered as before.
    const same = await c.asAgent('session.capabilities', { operationId }, String(a['credential']));
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    expect(same.body).toStrictEqual(first.body);

    await handBack(a);
    const b = await pickedUp('the second delegation, on another task');
    expect(b['taskId']).not.toBe(a['taskId']);

    const replayed = await c.asAgent(
      'session.capabilities',
      { operationId },
      String(b['credential']),
    );
    expect(JSON.stringify(replayed.body)).not.toContain(String(a['taskId']));
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(replayed.body['purposeScope']).toStrictEqual({ kind: 'record', id: b['taskId'] });

    // A's own credential, settled, answers the refusal and nothing of A.
    const stale = await c.asAgent('session.capabilities', { operationId }, String(a['credential']));
    expect(stale.body['code'], JSON.stringify(stale.body)).toBe('DELEGATION_NOT_LIVE');
    expect(JSON.stringify(stale.body)).not.toContain(String(a['taskId']));

    // Replays are recorded as replays; the register row is the first answer's.
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where operation_id = $1 and outcome = 'replayed'`,
        [operationId],
      ),
    ).toBe(2);
    expect(
      await c.count(`select count(*)::text as n from public.operations where operation_id = $1`, [
        operationId,
      ]),
    ).toBe(1);
    await handBack(b);
  });
});
