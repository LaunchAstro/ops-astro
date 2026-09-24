// SPDX-License-Identifier: AGPL-3.0-only
//
// `session.capabilities` counts only effective live grants (root ruling 5).
//
// The person answer is the caller's own currently effective pairs, and a
// member with none is refused `SCOPE_NOT_GRANTED`. "Effective" is
// `effectiveGrants`' word, not the grants table's: a revoked row, an expired
// row, and a delegated row whose parent no longer covers it are all rows in
// `public.grants` and none of them is authority. Each is tried here alone, so
// the existence check cannot be satisfied by one of them, and beside a live
// grant, so the list cannot carry one.
//
// The agent answer after a pickup is limited by the delegation and the
// delegating person's authority as they are now: once either is gone it must
// not assert the powers the intersection no longer holds.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { DELEGATION_HEADER } from '../../packages/core-records/src/commands/surface.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

const expectRefused = (answer: Answer) => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(403);
  expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
  expect(answer.body['grants']).toBeUndefined();
};

const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? answer.body;

describe.skipIf(serverUrl === undefined)(
  'session.capabilities counts effective grants only',
  () => {
    let fixture: ApiFixture;
    let api: Hono;

    const capabilitiesOf = async (member: Member): Promise<Answer> =>
      await post(
        api,
        `/api/b/${BUSINESS_KEY}${pathOf('session.capabilities')}`,
        {},
        authorised(await tokenFor(member.presented.subject)),
      );

    const inAlpha = async <T>(run: Parameters<typeof fixture.db.app.withBusiness<T>>[1]) =>
      await fixture.db.app.withBusiness(fixture.business, run);

    const expire = async (grantId: string) =>
      await fixture.db.admin.execute(
        `update public.grants set granted_at = now() - interval '2 hours',
                                expires_at = now() - interval '1 hour' where id = $1`,
        [grantId],
      );

    beforeAll(async () => {
      fixture = await createApiFixture('boundary_capabilities');
      api = fixture.compose();
    }, 60_000);

    afterAll(async () => await fixture?.drop());

    it('refuses a member whose only grant was revoked', async () => {
      const who = await enrol(fixture.db.app, fixture.business, `revoked-${randomUUID()}`);
      const grant = await inAlpha(async (tx) => await grantTo(tx, who, 'read'));
      expect((await capabilitiesOf(who)).status).toBe(200);
      await inAlpha(async (tx) => await revokeGrant(tx, grant));
      expectRefused(await capabilitiesOf(who));
    });

    it('refuses a member whose only grant has expired', async () => {
      const who = await enrol(fixture.db.app, fixture.business, `expired-${randomUUID()}`);
      const grant = await inAlpha(async (tx) => await grantTo(tx, who, 'read'));
      await expire(grant);
      expectRefused(await capabilitiesOf(who));
    });

    it('refuses a member whose only grant is a delegated one its parent no longer covers', async () => {
      const granter = await enrol(fixture.db.app, fixture.business, `granter-${randomUUID()}`);
      const who = await enrol(fixture.db.app, fixture.business, `delegated-${randomUUID()}`);
      const parent = await inAlpha(
        async (tx) => await grantTo(tx, granter, 'read', WHOLE_BUSINESS, true),
      );
      // The child row, written as `issueGrant` writes a derived grant.
      const child = randomUUID();
      await fixture.db.admin.execute(
        `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, scope_id, collection, action,
          can_delegate, may_permit_delegation, parent_grant_id, granted_by_actor_id)
       values ($1, $2, 'person', $3, 'business', null, 'task', 'read', false, false, $4, $5)`,
        [fixture.business, child, who.personId, parent, granter.actorId],
      );
      expect((await capabilitiesOf(who)).body['grants']).toStrictEqual([
        { collection: 'task', action: 'read' },
      ]);
      await inAlpha(async (tx) => await revokeGrant(tx, parent));
      expectRefused(await capabilitiesOf(who));
    });

    it('refuses a member whose only grant is a child row wider than its parent', async () => {
      const granter = await enrol(fixture.db.app, fixture.business, `narrow-${randomUUID()}`);
      const who = await enrol(fixture.db.app, fixture.business, `wider-${randomUUID()}`);
      const parent = await inAlpha(
        async (tx) => await grantTo(tx, granter, 'read', WHOLE_BUSINESS, true),
      );
      // A row written around `issueGrant`: its parent grants `read`, it claims `write`.
      await fixture.db.admin.execute(
        `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, scope_id, collection, action,
          can_delegate, may_permit_delegation, parent_grant_id, granted_by_actor_id)
       values ($1, $2, 'person', $3, 'business', null, 'task', 'write', false, false, $4, $5)`,
        [fixture.business, randomUUID(), who.personId, parent, granter.actorId],
      );
      expectRefused(await capabilitiesOf(who));
    });

    it('lists only the live pairs beside revoked, expired and uncovered ones', async () => {
      const who = await enrol(fixture.db.app, fixture.business, `mixed-${randomUUID()}`);
      await inAlpha(async (tx) => {
        await grantTo(tx, who, 'read');
        const revoked = await grantTo(tx, who, 'write');
        await revokeGrant(tx, revoked);
      });
      const expired = await inAlpha(async (tx) => await grantTo(tx, who, 'comment'));
      await expire(expired);
      const answer = await capabilitiesOf(who);
      expect(answer.status).toBe(200);
      expect(answer.body['grants']).toStrictEqual([{ collection: 'task', action: 'read' }]);
    });

    describe('the agent after a pickup', () => {
      const agentCall = async (
        name: CommandName,
        body: Record<string, unknown>,
        credential?: string,
      ) =>
        await post(
          api,
          `/api/a/b/${BUSINESS_KEY}${pathOf(name)}`,
          { operationId: randomUUID(), ...body },
          {
            ...authorised(await tokenFor(fixture.agent.subject)),
            ...(credential === undefined ? {} : { [DELEGATION_HEADER]: credential }),
          },
        );

      const personCall = async (name: CommandName, body: Record<string, unknown>) =>
        await post(
          api,
          `/api/b/${BUSINESS_KEY}${pathOf(name)}`,
          { operationId: randomUUID(), ...body },
          authorised(await tokenFor(fixture.member.presented.subject)),
        );

      /** A picked-up task: its id, the delegation and the credential. */
      const pickUp = async () => {
        const created = await personCall('task.create', { fields: { title: 'agent work' } });
        const taskId = String(created.body['recordId']);
        const proposed = await personCall('task.propose', {
          recordId: taskId,
          expectedRevision: Number(created.body['revision']),
          purpose: `draft_${randomUUID().slice(0, 8)}`,
          maximumMinor: 1_000,
          currency: 'AUD',
          payload: { instruction: 'draft' },
          step: { kind: 'compose', payload: {} },
        });
        expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
        const decided = await personCall('task.decide', {
          gateId: detail(proposed)['gateId'],
          versionId: detail(proposed)['versionId'],
          decision: 'approve',
          note: 'so the agent can work',
        });
        expect(decided.status, JSON.stringify(decided.body)).toBe(200);
        const picked = await agentCall('task.pickup', {
          reservationId: detail(decided)['reservationId'],
        });
        expect(picked.status, JSON.stringify(picked.body)).toBe(200);
        return {
          taskId,
          delegationId: String(detail(picked)['delegationId']),
          credential: String(detail(picked)['credential']),
        };
      };

      it('refuses before a pickup and answers only its own purpose after one', async () => {
        const before = await agentCall('session.capabilities', {});
        expect(before.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
        const { taskId, credential } = await pickUp();
        const after = await agentCall('session.capabilities', {}, credential);
        expect(after.status, JSON.stringify(after.body)).toBe(200);
        expect(after.body['purposeScope']).toStrictEqual({ kind: 'record', id: taskId });
        expect(after.body['agentActorId']).toBe(fixture.agentActorId);
        // Its own identity, never the delegating person's grants.
        expect(JSON.stringify(after.body)).not.toContain(fixture.member.personId);
      });

      it('asserts nothing once the delegation is revoked', async () => {
        const { delegationId, credential } = await pickUp();
        // Revoked as `delegation.revoke` records it; who may call that is not this case.
        await fixture.db.admin.execute(
          `update public.delegations set revoked_at = now() where business_id = $1 and id = $2`,
          [fixture.business, delegationId],
        );
        const answer = await agentCall('session.capabilities', {}, credential);
        expect(answer.status).not.toBe(200);
        expect(answer.body['grants']).toBeUndefined();
        expect(answer.body['purposeScope']).toBeUndefined();
      });

      /** A pickup, then every grant of the delegating person revoked. */
      const narrowed = async () => {
        const picked = await pickUp();
        const held = await fixture.db.admin.execute<{ readonly id: string }>(
          `select id from public.grants where business_id = $1 and subject_kind = 'person'
            and subject_id = $2 and revoked_at is null`,
          [fixture.business, fixture.member.personId],
        );
        await inAlpha(async (tx) => {
          for (const row of held) {
            // eslint-disable-next-line no-await-in-loop -- one transaction, one connection
            await revokeGrant(tx, row.id);
          }
        });
        // Restored for the next case, under new rows; the revoked ones stay revoked.
        const restore = async () =>
          await inAlpha(async (tx) => {
            for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
              // eslint-disable-next-line no-await-in-loop -- as the fixture issues them
              await grantTo(tx, fixture.member, action);
            }
          });
        return { ...picked, restore };
      };

      it('loses the powers themselves once the delegating person loses the authority', async () => {
        const { taskId, credential, restore } = await narrowed();
        const read = await agentCall('task.read', { recordId: taskId }, credential);
        await restore();
        expect(read.status, JSON.stringify(read.body)).not.toBe(200);
        expect(read.body['task']).toBeUndefined();
      });

      // RED at 1e8d5d4, and outside this lane's files. `agent-envelope.ts`
      // `authorise` returns before `checkDelegatedAuthority` for
      // `session.capabilities` once the credential resolves, and `serve` answers
      // the delegation's `purposeScope` whatever the delegating person now
      // holds, so the answer still says the agent reaches the task it can no
      // longer read (handback, unfinished 2). `it.fails` records the red; when
      // PICKUP-REPLAY's fix lands it goes red itself and is flipped to `it`.
      it('asserts nothing once the delegating person loses the authority it rests on', async () => {
        const { credential, restore } = await narrowed();
        const answer = await agentCall('session.capabilities', {}, credential);
        await restore();
        expect(answer.status, JSON.stringify(answer.body)).not.toBe(200);
        expect(answer.body['purposeScope']).toBeUndefined();
      });
    });
  },
);
