// SPDX-License-Identifier: AGPL-3.0-only
//
// PICKUP-REPLAY proof groups 1, 3 and 6, on the mounted agent route.
//
// A pickup commits, its response never reaches the agent, and the agent
// retries the identical operation with no credential (it has none). T3: "a
// lost response replays those identities. Retry cannot mint a second
// lease/delegation/hold." The retry must hand back the same credential and
// the same handles, and only while the rights and the lease behind them are
// still current.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { LOCAL_KEY_FILE } from '../../packages/core-records/src/authority/credential-keys.ts';
import { detailOf, replayWorld, type Approver, type ReplayWorld } from './pickup-replay-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

const HANDLES = [
  'leaseId',
  'fence',
  'delegationId',
  'reservationId',
  'attemptId',
  'taskId',
  'runId',
  'versionId',
  'expiresAt',
  'purposeScope',
] as const;

describe.skipIf(serverUrl === undefined)('a pickup whose response was lost', () => {
  let world: ReplayWorld;
  let approver: Approver;
  const logged: string[] = [];

  beforeAll(async () => {
    world = await replayWorld('prl');
    approver = await world.approver('replay-approver');
  }, 120_000);

  afterAll(async () => {
    await world?.fixture.drop();
  });

  // Every line the process writes while a case runs, for group 6's scan.
  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        logged.push(parts.map((part) => String(part)).join(' '));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replays the same credential and handles, once, and the credential works', async () => {
    const picked = await world.pickUp(approver, 'lost_once');
    const before = await world.counts(picked.taskId);
    expect(before).toStrictEqual({ leases: 1, delegations: 1, reservations: 1, attempts: 1 });

    const again = await world.asAgent('task.pickup', picked.body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const replayed = detailOf(again);
    expect(replayed['credential']).toBe(picked.credential);
    expect(replayed).not.toHaveProperty('credentialNote');
    for (const handle of HANDLES) {
      expect(replayed[handle], handle).toStrictEqual(detailOf(picked.lost)[handle]);
    }
    expect(await world.counts(picked.taskId)).toStrictEqual(before);

    const credential = String(replayed['credential']);
    const leaseId = String(replayed['leaseId']);
    const comment = await world.asAgent(
      'task.comment',
      {
        operationId: randomUUID(),
        recordId: picked.taskId,
        body: 'resumed after a lost response',
        audience: 'internal',
      },
      credential,
    );
    expect(comment.status, JSON.stringify(comment.body)).toBe(200);

    // Group 5, first half: a heartbeat moves the expiry and not the token.
    const expiryBefore = await world.scalar(
      `select expires_at::text as v from public.leases where id = $1`,
      [leaseId],
    );
    const beat = await world.asAgent(
      'task.heartbeat',
      { operationId: randomUUID(), leaseId, fence: 1, leaseSeconds: 1_200 },
      credential,
    );
    expect(beat.status, JSON.stringify(beat.body)).toBe(200);
    expect(
      await world.scalar(`select expires_at::text as v from public.leases where id = $1`, [
        leaseId,
      ]),
    ).not.toBe(expiryBefore);
    const afterBeat = await world.asAgent('task.pickup', picked.body);
    expect(detailOf(afterBeat)['credential']).toBe(picked.credential);

    const handback = await world.asAgent(
      'task.handback',
      { operationId: randomUUID(), leaseId, fence: 1, outcome: 'completed' },
      credential,
    );
    expect(handback.status, JSON.stringify(handback.body)).toBe(200);
    expect(await world.counts(picked.taskId)).toStrictEqual(before);

    // Settled now, so the pickup is no longer resumable and says so.
    const settled = await world.asAgent('task.pickup', picked.body);
    expect(settled.body['code']).toBe('DELEGATION_NOT_LIVE');
    expect(JSON.stringify(settled.body)).not.toContain(picked.credential);
  });

  it('answers concurrent identical retries with one credential and no new rows', async () => {
    const picked = await world.pickUp(approver, 'lost_concurrent');
    const before = await world.counts(picked.taskId);
    const answers = await Promise.all(
      Array.from({ length: 6 }, async () => await world.asAgent('task.pickup', picked.body)),
    );
    for (const answer of answers) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(detailOf(answer)['credential']).toBe(picked.credential);
    }
    expect(await world.counts(picked.taskId)).toStrictEqual(before);
    expect(
      await world.scalar(
        `select count(*)::text as v from public.audit_events
          where operation_id = $1 and outcome = 'replayed'`,
        [picked.body['operationId']],
      ),
    ).toBe('6');
  });

  describe('under changed rights (group 3)', () => {
    const refusedWithout = async (
      picked: { body: Readonly<Record<string, unknown>>; credential: string; taskId: string },
      code: string,
    ): Promise<void> => {
      const before = await world.counts(picked.taskId);
      const answer = await world.asAgent('task.pickup', picked.body);
      expect(answer.body['code'], JSON.stringify(answer.body)).toBe(code);
      expect(JSON.stringify(answer.body)).not.toContain(picked.credential);
      expect(JSON.stringify(answer.body)).not.toContain('leaseId');
      expect(await world.counts(picked.taskId)).toStrictEqual(before);
    };

    it('refuses once the delegating person loses the grant', async () => {
      const own = await world.approver('replay-narrowed');
      const picked = await world.pickUp(own, 'lost_narrowed');
      await world.fixture.db.admin.execute(
        `update public.grants set revoked_at = now() where id = $1`,
        [own.grants['write']],
      );
      await refusedWithout(picked, 'DELEGATION_NARROWED');
    });

    it('refuses once the delegation is revoked', async () => {
      const picked = await world.pickUp(approver, 'lost_revoked');
      await world.fixture.db.admin.execute(
        `update public.delegations set revoked_at = now() where id = $1`,
        [detailOf(picked.lost)['delegationId']],
      );
      await refusedWithout(picked, 'DELEGATION_NOT_LIVE');
    });

    it('refuses once the lease is expired, cancelled or replaced', async () => {
      const picked = await world.pickUp(approver, 'lost_expired');
      await world.fixture.db.admin.execute(
        `update public.leases set state = 'expired', released_at = now() where id = $1`,
        [detailOf(picked.lost)['leaseId']],
      );
      await refusedWithout(picked, 'LEASE_EXPIRED');
    });

    it('refuses once the approved version is superseded', async () => {
      const picked = await world.pickUp(approver, 'lost_superseded');
      await world.fixture.db.admin.execute(
        `update public.proposal_versions set superseded_at = now() where id = $1`,
        [detailOf(picked.lost)['versionId']],
      );
      await refusedWithout(picked, 'RESERVATION_NOT_CLAIMABLE');
    });

    it('discloses and mints nothing to another agent or a changed request', async () => {
      const picked = await world.pickUp(approver, 'lost_foreign');
      const before = await world.counts(picked.taskId);
      const other = await world.otherAgentToken();
      const foreign = await world.asAgent('task.pickup', picked.body, undefined, other);
      expect(foreign.status).not.toBe(200);
      expect(JSON.stringify(foreign.body)).not.toContain(picked.credential);
      expect(JSON.stringify(foreign.body)).not.toContain(String(detailOf(picked.lost)['leaseId']));

      const changed = await world.asAgent('task.pickup', {
        ...picked.body,
        reservationId: randomUUID(),
      });
      expect(changed.body['code']).toBe('OPERATION_ID_REUSED');
      expect(JSON.stringify(changed.body)).not.toContain(picked.credential);

      // Another business key: the same agent at a door that is not its tenant's.
      const wrongBusiness = await world.api.fetch(
        new Request(`http://api.test/api/a/b/no-such-business${pathOf('task.pickup')}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${world.agentToken}`,
          },
          body: JSON.stringify(picked.body),
        }),
      );
      expect(wrongBusiness.status).not.toBe(200);
      expect(await wrongBusiness.text()).not.toContain(picked.credential);
      expect(await world.counts(picked.taskId)).toStrictEqual(before);
    });
  });

  it('never writes the token or the key bytes anywhere it can be read (group 6)', async () => {
    const picked = await world.pickUp(approver, 'lost_scanned');
    await world.asAgent('task.pickup', picked.body);
    const keyring = /^DELEGATION_CREDENTIAL_KEYS=(.*)$/mu.exec(
      readFileSync(LOCAL_KEY_FILE, 'utf8'),
    );
    const keyBytes = (keyring?.[1] ?? '')
      .split(',')
      .map((entry) => entry.slice(entry.indexOf(':') + 1));
    expect(keyBytes.length).toBeGreaterThan(0);

    const dump = async (table: string): Promise<string> =>
      String(
        await world.scalar(
          `select coalesce(string_agg(row_to_json(t)::text, ''), '') as v from public.${table} t`,
          [],
        ),
      );
    const stored = [
      await dump('operations'),
      await dump('delegations'),
      await dump('audit_events'),
      await dump('authentication_attempts'),
      logged.join('\n'),
    ].join('\n');
    for (const secret of [picked.credential, ...keyBytes]) {
      expect(secret.length).toBeGreaterThan(20);
      expect(stored).not.toContain(secret);
    }
    // The register keeps the handles and a null credential, not a sealed copy.
    const result = await world.scalar(
      `select result->'detail'->>'credential' as v from public.operations where operation_id = $1`,
      [picked.body['operationId']],
    );
    expect(result).toBeNull();
    expect(
      await world.scalar(
        `select credential_scheme || ' ' || credential_key_id as v from public.delegations where id = $1`,
        [detailOf(picked.lost)['delegationId']],
      ),
    ).toMatch(/^hmac-sha256-v1 local\/delegation-credential@[0-9a-f]{12}$/u);
  });
});
