// SPDX-License-Identifier: AGPL-3.0-only
//
// C32 (CS-2.15): the client record, and grants given and revoked on Settings ▸
// Access. A client is a row of its business (`client.create`, the tracked
// action `record created (client)` under `record:write`); a grant names a
// person of the business, a key from the catalogue and either the whole
// business or one client (`access.grant` and `access.revoke`, the tracked
// action `grant changed` under `access:manage`, never an agent's). The
// person's preview on `access.read` is the grant check's own walk, so a
// teammate given one client sees that client and nothing else, and
// `client.list` answers the clients a caller's live grants reach, filtered
// inside the query.
//
// Ada is alpha's owner and holds every key the surface declares; Mia holds the
// task keys at business scope and nothing else; Noah holds nothing; Tia is a
// teammate enrolled here with no grant. Bea is bravo's, holding `access:manage`
// and `record:write` there. A client person of alpha stands on a share, and
// the agent acts under a live delegation from Ada. Every name below is made up.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkAuthority } from '../../packages/core-records/src/authority/grants.ts';
import { grantAccess, revokeAccess } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { tokenFor } from '../acceptance/cast.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import {
  agentPath,
  bearer,
  call,
  personPath,
  serverUrl,
  type Answer,
} from '../acceptance/world.ts';
import {
  enrol,
  grantTo,
  shareWithClient,
  WHOLE_BUSINESS,
  type Member,
} from '../commands/fixture.ts';

const CANARY = 'CANARY-c32-client-record-7d13a0';

if (serverUrl === undefined) {
  console.warn('authority/c32-clients-and-grants: DATABASE_URL is unset, so nothing below ran.');
}

/** A world caller as the fixture's member, which carries the same ids. */
const member = (caller: unknown) => caller as Member;

const detailOf = (answer: Answer) => (answer.body['detail'] ?? {}) as Record<string, unknown>;

const outcome = (answer: Answer) => ({ status: answer.status, code: answer.code });

describe.skipIf(serverUrl === undefined)(
  'C32 the client record and grants on Settings ▸ Access',
  () => {
    let harness: Harness;
    let tia: Member;
    let tiaToken: string;
    let clientToken: string;
    let credential: string;

    const as = async (
      path: string,
      body: Readonly<Record<string, unknown>>,
      token = harness.world.ada.token,
      businessKey = 'alpha',
    ) => await call(harness.world.api, personPath(businessKey, path), body, bearer(token));

    const createClient = async (name: string, token = harness.world.ada.token, key = 'alpha') => {
      const answer = await as('/client/create', { operationId: randomUUID(), name }, token, key);
      expect(outcome(answer), `create ${name}`).toEqual({ status: 200, code: 'ok' });
      return String(detailOf(answer)['clientId']);
    };

    const give = async (
      body: Readonly<Record<string, unknown>>,
      token = harness.world.ada.token,
      key = 'alpha',
    ) => await as('/access/grant', { operationId: randomUUID(), ...body }, token, key);

    const revoke = async (grantId: unknown, token = harness.world.ada.token, key = 'alpha') =>
      await as('/access/revoke', { operationId: randomUUID(), grantId }, token, key);

    const listClients = async (token: string, key = 'alpha') =>
      await as('/client/list', {}, token, key);

    const previewOf = async (personId: string) => {
      const answer = await as('/access/read', {});
      expect(answer.status, 'access.read').toBe(200);
      const team = answer.body['team'] as readonly { personId: string; permissions: unknown[] }[];
      return {
        permissions: team.find((person) => person.personId === personId)?.permissions,
        clientRecords: answer.body['clientRecords'],
      };
    };

    /** Every grant and client row of a business, to show a refusal wrote nothing. */
    const rowsOf = async (businessId: string) =>
      await harness.world.db.app.withBusiness(
        businessId,
        async (tx) =>
          await tx.query<{ readonly row: string }>(
            `select to_jsonb(g)::text as row from public.grants g
           union all select to_jsonb(c)::text from public.clients c
           order by 1`,
          ),
      );

    beforeAll(async () => {
      harness = await createHarness('c32_clients');
      const { world } = harness;
      tia = await enrol(world.db.app, world.alpha, 'tia');
      tiaToken = await tokenFor(tia.presented.subject);
      await world.db.app.withBusiness(world.bravo, async (tx) => {
        await grantTo(tx, member(world.bea), 'manage', WHOLE_BUSINESS, false, 'access');
        await grantTo(tx, member(world.bea), 'write', WHOLE_BUSINESS, false, 'record');
      });
      const client = await shareWithClient(
        world.db.app,
        world.alpha,
        member(world.ada),
        harness.alphaTask.id,
      );
      clientToken = await tokenFor(client.presented.subject);

      const { decided } = await harness.approvedReservation();
      expect(decided.code, 'the decision a pickup needs').toBe('ok');
      const reservationId = (decided.body['detail'] as Record<string, unknown>)['reservationId'];
      const picked = await harness.asAgent('task.pickup', { reservationId });
      expect(picked.code, 'the pickup').toBe('ok');
      credential = String((picked.body['detail'] as Record<string, unknown>)['credential']);
    }, 120_000);

    afterAll(async () => {
      await harness?.close();
    });

    it('C32 grant changed: a teammate given one client sees that client only in their preview, and the change and its revocation are recorded and audited', async () => {
      const one = await createClient(`Harbour Physio ${randomUUID().slice(0, 6)}`);
      const other = await createClient(`Ridge Dental ${randomUUID().slice(0, 6)}`);
      expect((await previewOf(tia.personId)).permissions).toEqual([]);

      const given = await give({
        personId: tia.personId,
        collection: 'task',
        action: 'read',
        clientId: one,
      });
      expect(outcome(given)).toEqual({ status: 200, code: 'ok' });
      const grantId = String(detailOf(given)['grantId']);

      const preview = await previewOf(tia.personId);
      expect(preview.permissions).toEqual([
        { collection: 'task', action: 'read', scope: { kind: 'party', id: one } },
      ]);
      expect(preview.clientRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clientId: one }),
          expect.objectContaining({ clientId: other }),
        ]),
      );

      // The preview is what the grant check grants: that client, not the other,
      // and not the whole business.
      const asked = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
        const subjects = [{ kind: 'person' as const, id: tia.personId }];
        const on = async (kind: 'party' | 'business', id: string | null) =>
          (
            await checkAuthority(tx, subjects, {
              collection: 'task',
              action: 'read',
              scope: { kind, id },
            })
          ).ok;
        return [await on('party', one), await on('party', other), await on('business', null)];
      });
      expect(asked).toEqual([true, false, false]);

      // Tia's own list of clients is the one she was given.
      const listed = await listClients(tiaToken);
      expect(listed.status).toBe(200);
      expect(listed.body['clients']).toEqual([
        { clientId: one, name: expect.stringContaining('Harbour Physio') },
      ]);

      // The same grant given again is the same grant.
      const again = await give({
        personId: tia.personId,
        collection: 'task',
        action: 'read',
        clientId: one,
      });
      expect(detailOf(again)['grantId']).toBe(grantId);

      const revoked = await revoke(grantId);
      expect(outcome(revoked)).toEqual({ status: 200, code: 'ok' });
      expect((await previewOf(tia.personId)).permissions).toEqual([]);
      expect(outcome(await listClients(tiaToken))).toEqual({
        status: 403,
        code: 'SCOPE_NOT_GRANTED',
      });
      expect(outcome(await revoke(grantId))).toEqual({ status: 404, code: 'NOT_FOUND' });

      // Each change is its tracked action, audited in alpha against Ada, with a
      // digest and no body; the grant row keeps who gave it and when it ended.
      const stored = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => ({
        audited: await tx.query<{ readonly command: string; readonly n: number }>(
          `select command, count(*)::int as n from public.audit_events
            where actor_id = $1 and outcome = 'applied'
              and command in ('client.create', 'access.grant', 'access.revoke')
            group by command order by command`,
          [harness.world.ada.actorId],
        ),
        grant: await tx.query<{
          readonly by: string;
          readonly ended: boolean;
          readonly scope: string;
        }>(
          `select granted_by_actor_id::text as by, revoked_at is not null as ended,
                  scope_kind || ':' || scope_id as scope
             from public.grants where id = $1`,
          [grantId],
        ),
      }));
      expect(stored.audited).toEqual(
        expect.arrayContaining([
          { command: 'access.grant', n: expect.any(Number) },
          { command: 'access.revoke', n: 1 },
          { command: 'client.create', n: expect.any(Number) },
        ]),
      );
      expect(stored.grant).toEqual([
        { by: harness.world.ada.actorId, ended: true, scope: `party:${one}` },
      ]);
    });

    it('C32 grant changed: the whole business is a grant with no client, and malformed, unknown or self-scoped input is refused by name with nothing written', async () => {
      const whole = await give({ personId: tia.personId, collection: 'report', action: 'read' });
      expect(outcome(whole)).toEqual({ status: 200, code: 'ok' });
      expect((await previewOf(tia.personId)).permissions).toEqual([
        { collection: 'report', action: 'read', scope: { kind: 'business', id: null } },
      ]);
      expect(outcome(await revoke(detailOf(whole)['grantId']))).toEqual({
        status: 200,
        code: 'ok',
      });

      const before = await rowsOf(harness.world.alpha);
      const base = { personId: tia.personId, collection: 'task', action: 'read' };
      const cases: readonly (readonly [
        Readonly<Record<string, unknown>>,
        string,
        number,
        string,
      ])[] = [
        [{ ...base, collection: 'tasks' }, 'collection', 422, 'FIELD_VALUE_INVALID'],
        [{ ...base, collection: 'TASK' }, 'collection', 422, 'FIELD_VALUE_INVALID'],
        [{ ...base, collection: ' task' }, 'collection', 422, 'FIELD_VALUE_INVALID'],
        [{ ...base, collection: 7 }, 'collection', 422, 'FIELD_VALUE_INVALID'],
        [{ ...base, action: 'own' }, 'action', 422, 'FIELD_VALUE_INVALID'],
        [{ ...base, action: undefined }, 'action', 422, 'FIELD_VALUE_INVALID'],
        // A key the catalogue does not hold: nothing checks `export:manage`.
        [{ ...base, collection: 'export', action: 'manage' }, 'action', 422, 'FIELD_VALUE_INVALID'],
        // Self-scoped keys every person holds on their own account are never granted.
        [
          { ...base, collection: 'account', action: 'write' },
          'collection',
          422,
          'FIELD_VALUE_INVALID',
        ],
        [
          { ...base, collection: 'preference', action: 'write' },
          'collection',
          422,
          'FIELD_VALUE_INVALID',
        ],
        [
          { ...base, collection: 'credential', action: 'write' },
          'collection',
          422,
          'FIELD_VALUE_INVALID',
        ],
        [{ ...base, personId: 'not-an-id' }, 'personId', 422, 'FIELD_VALUE_INVALID'],
        [{ ...base, clientId: 'not-an-id' }, 'clientId', 422, 'FIELD_VALUE_INVALID'],
        [{ ...base, personId: randomUUID() }, 'personId', 404, 'NOT_FOUND'],
        [{ ...base, clientId: randomUUID() }, 'clientId', 404, 'NOT_FOUND'],
        // Noah's person is a member; the orphan's login has no membership.
        [{ ...base, personId: harness.world.orphan.personId }, 'personId', 404, 'NOT_FOUND'],
      ];
      for (const [body, field, status, code] of cases) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await give(body);
        expect(outcome(answer), field).toEqual({ status, code });
        expect(JSON.stringify(answer.body), field).toContain(field);
      }
      const undeclared = await give({ ...base, scope: 'business' });
      expect(outcome(undeclared)).toEqual({ status: 400, code: 'COMMAND_BODY_INVALID' });

      for (const name of [
        '',
        '   ',
        'x'.repeat(201),
        7,
        `nul \u0000 ${CANARY}`,
        `lone \uD800 ${CANARY}`,
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await as('/client/create', { operationId: randomUUID(), name });
        expect(outcome(answer), String(name)).toEqual({ status: 422, code: 'FIELD_VALUE_INVALID' });
        expect(JSON.stringify(answer.body)).not.toContain(CANARY);
      }
      expect(await rowsOf(harness.world.alpha)).toEqual(before);

      // One name per business, in any letter case.
      const taken = `Coastal Vets ${randomUUID().slice(0, 6)}`;
      await createClient(taken);
      const twice = await as('/client/create', {
        operationId: randomUUID(),
        name: taken.toUpperCase(),
      });
      expect(outcome(twice)).toEqual({ status: 409, code: 'CLIENT_NAME_TAKEN' });
    });

    it('C32 grant changed: the last business-wide holder of access:manage is never revoked, so the business always has someone to change access', async () => {
      const held = await harness.world.db.app.withBusiness(
        harness.world.alpha,
        async (tx) =>
          await tx.query<{ readonly id: string }>(
            `select id from public.grants
            where subject_kind = 'person' and subject_id = $1 and collection = 'access'
              and action = 'manage' and scope_kind = 'business' and revoked_at is null`,
            [harness.world.ada.personId],
          ),
      );
      expect(held).toHaveLength(1);
      const last = await revoke(held[0]?.id);
      expect(outcome(last)).toEqual({ status: 409, code: 'ACCESS_LAST_MANAGER' });

      // With a second holder, the first may go, and then the second is the last.
      const second = await give({ personId: tia.personId, collection: 'access', action: 'manage' });
      expect(outcome(second)).toEqual({ status: 200, code: 'ok' });
      expect(outcome(await revoke(held[0]?.id))).toEqual({ status: 200, code: 'ok' });
      expect(outcome(await revoke(detailOf(second)['grantId'], tiaToken))).toEqual({
        status: 409,
        code: 'ACCESS_LAST_MANAGER',
      });
      // Ada's key back, then Tia's gone, as the rest of the file expects.
      const back = await give(
        { personId: harness.world.ada.personId, collection: 'access', action: 'manage' },
        tiaToken,
      );
      expect(outcome(back)).toEqual({ status: 200, code: 'ok' });
      expect(outcome(await revoke(detailOf(second)['grantId']))).toEqual({
        status: 200,
        code: 'ok',
      });
    });

    it('C32 grants at once: two of the same grant given at once make one row, and two last managers revoked at once leave one', async () => {
      const clientId = await createClient(`Parallel Pilates ${randomUUID().slice(0, 6)}`);
      const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
      const grant = {
        personId: tia.personId,
        collection: 'task',
        action: 'comment' as const,
        clientId,
      };
      const actorId = harness.world.ada.actorId as string;
      try {
        const both = await Promise.all(
          [0, 1].map(
            async () =>
              await wide.withBusiness(harness.world.alpha, async (tx) => {
                const given = await grantAccess(tx, grant, actorId);
                await tx.query('select pg_sleep(0.2)');
                return given;
              }),
          ),
        );
        expect(both.map((given) => given.ok)).toEqual([true, true]);
        const rows = await harness.world.db.app.withBusiness(
          harness.world.alpha,
          async (tx) =>
            await tx.query<{ readonly n: number }>(
              `select count(*)::int as n from public.grants
              where subject_id = $1 and collection = 'task' and action = 'comment'
                and scope_id = $2 and revoked_at is null`,
              [tia.personId, clientId],
            ),
        );
        expect(rows[0]?.n).toBe(1);
      } finally {
        await wide.close();
      }

      // Two managers, each revoking the other's key at once, on two connections
      // that truly overlap: one revocation applies, the other is the last.
      const second = await give({ personId: tia.personId, collection: 'access', action: 'manage' });
      const managers = await harness.world.db.app.withBusiness(
        harness.world.alpha,
        async (tx) =>
          await tx.query<{ readonly id: string; readonly person: string }>(
            `select id, subject_id::text as person from public.grants
            where collection = 'access' and action = 'manage' and scope_kind = 'business'
              and revoked_at is null order by granted_at`,
          ),
      );
      expect(managers).toHaveLength(2);
      const pair = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
      let codes: string[];
      try {
        codes = await Promise.all(
          managers.map(
            async (held) =>
              await pair.withBusiness(harness.world.alpha, async (tx) => {
                const ended = await revokeAccess(tx, held.id);
                await tx.query('select pg_sleep(0.2)');
                return ended.ok ? 'ok' : ended.refusal.code;
              }),
          ),
        );
      } finally {
        await pair.close();
      }
      expect(codes.toSorted()).toEqual(['ACCESS_LAST_MANAGER', 'ok']);
      const left = await harness.world.db.app.withBusiness(
        harness.world.alpha,
        async (tx) =>
          await tx.query<{ readonly person: string }>(
            `select subject_id::text as person from public.grants
            where collection = 'access' and action = 'manage' and scope_kind = 'business'
              and revoked_at is null`,
          ),
      );
      expect(left).toHaveLength(1);
      // Leave Ada holding it, and Tia not, for the cases after this one.
      if (left[0]?.person !== harness.world.ada.personId) {
        const back = await give(
          { personId: harness.world.ada.personId, collection: 'access', action: 'manage' },
          tiaToken,
        );
        expect(back.code).toBe('ok');
        expect((await revoke(detailOf(second)['grantId'])).code).toBe('ok');
      }
    });

    it('C32 refusal access:manage: a task holder, a member with nothing and a client are refused grants and revocations, and record:write guards a new client, with nothing written', async () => {
      const clientId = await createClient(`Refusal Clinic ${randomUUID().slice(0, 6)}`);
      const given = await give({
        personId: tia.personId,
        collection: 'task',
        action: 'read',
        clientId,
      });
      const grantId = detailOf(given)['grantId'];
      const before = await rowsOf(harness.world.alpha);
      for (const token of [harness.world.mia.token, harness.world.noah.token, clientToken]) {
        const answers = [
          // oxlint-disable-next-line no-await-in-loop
          await give(
            { personId: tia.personId, collection: 'task', action: 'write', clientId },
            token,
          ),
          // oxlint-disable-next-line no-await-in-loop
          await revoke(grantId, token),
          // oxlint-disable-next-line no-await-in-loop
          await as('/access/read', {}, token),
        ];
        for (const answer of answers) {
          expect(outcome(answer)).toEqual({ status: 403, code: 'SCOPE_NOT_GRANTED' });
        }
      }
      for (const token of [harness.world.noah.token, clientToken]) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await as(
          '/client/create',
          { operationId: randomUUID(), name: 'Nope' },
          token,
        );
        expect(outcome(answer)).toEqual({ status: 403, code: 'SCOPE_NOT_GRANTED' });
      }
      expect(await rowsOf(harness.world.alpha)).toEqual(before);
      expect((await revoke(grantId)).code).toBe('ok');
    });

    it("C32 isolation: another business, another client and a delegated agent never read, list, count or change another's clients or grants", async () => {
      const alphaOne = await createClient(`Alpha One ${randomUUID().slice(0, 6)}`);
      const alphaTwo = await createClient(`Alpha Two ${randomUUID().slice(0, 6)}`);
      const bravoName = `Bravo Only ${randomUUID().slice(0, 6)}`;
      const bravoClient = await createClient(bravoName, harness.world.bea.token, 'bravo');
      const alphaBefore = await rowsOf(harness.world.alpha);
      const bravoBefore = await rowsOf(harness.world.bravo);

      // Another business. Bea on bravo cannot name alpha's person, client or
      // grant, and each is the same NOT_FOUND as a made-up one.
      const tiaGrant = await give({
        personId: tia.personId,
        collection: 'task',
        action: 'read',
        clientId: alphaOne,
      });
      const tiaGrantId = detailOf(tiaGrant)['grantId'];
      const alphaAfterGrant = await rowsOf(harness.world.alpha);
      const beaAcross = [
        await give(
          { personId: tia.personId, collection: 'task', action: 'read' },
          harness.world.bea.token,
          'bravo',
        ),
        await give(
          {
            personId: harness.world.bea.personId,
            collection: 'task',
            action: 'read',
            clientId: alphaOne,
          },
          harness.world.bea.token,
          'bravo',
        ),
        await revoke(tiaGrantId, harness.world.bea.token, 'bravo'),
      ];
      expect(beaAcross.map(outcome)).toEqual([
        { status: 404, code: 'NOT_FOUND' },
        { status: 404, code: 'NOT_FOUND' },
        { status: 404, code: 'NOT_FOUND' },
      ]);
      const beaList = await listClients(harness.world.bea.token, 'bravo');
      expect(beaList.body['clients']).toEqual([{ clientId: bravoClient, name: bravoName }]);
      // Bea on alpha's prefix is no member of alpha.
      const onAlpha = await give(
        { personId: tia.personId, collection: 'task', action: 'read' },
        harness.world.bea.token,
      );
      expect(outcome(onAlpha)).toEqual({ status: 403, code: 'AUTH_NO_MEMBERSHIP' });
      // Alpha cannot give access to bravo's client.
      const bravoFromAlpha = await give({
        personId: tia.personId,
        collection: 'task',
        action: 'read',
        clientId: bravoClient,
      });
      expect(outcome(bravoFromAlpha)).toEqual({ status: 404, code: 'NOT_FOUND' });
      const alphaAccess = await as('/access/read', {});
      expect(JSON.stringify(alphaAccess.body)).not.toContain(bravoClient);
      expect(JSON.stringify(alphaAccess.body)).not.toContain(bravoName);

      // Another client in the same business: Tia holds alphaOne and is never
      // shown, told the count of, or given alphaTwo.
      const tiaList = await listClients(tiaToken);
      expect(tiaList.body['clients']).toEqual([
        { clientId: alphaOne, name: expect.stringContaining('Alpha One') },
      ]);
      expect(JSON.stringify(tiaList.body)).not.toContain(alphaTwo);
      // A client person on a share holds no grant, so lists nothing.
      const clientList = await listClients(clientToken);
      expect(outcome(clientList)).toEqual({ status: 403, code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(clientList.body)).not.toContain(alphaOne);

      // Another person under a live delegation: the agent acting for Ada, who
      // holds access:manage and record:write, is refused all four.
      for (const [path, body] of [
        ['/access/grant', { personId: tia.personId, collection: 'task', action: 'read' }],
        ['/access/revoke', { grantId: tiaGrantId }],
        ['/client/create', { name: 'Agent Made' }],
        ['/client/list', {}],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const agent = await call(
          harness.world.api,
          agentPath('alpha', path),
          path === '/client/list' ? body : { operationId: randomUUID(), ...body },
          { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
        );
        expect(outcome(agent), path).toEqual({
          status: 403,
          code: 'DELEGATION_EXCLUDES_OPERATION',
        });
      }

      expect(await rowsOf(harness.world.alpha)).toEqual(alphaAfterGrant);
      expect(await rowsOf(harness.world.bravo)).toEqual(bravoBefore);
      expect(alphaAfterGrant.length).toBe(alphaBefore.length + 1);
      expect((await revoke(tiaGrantId)).code).toBe('ok');
    });

    it('C32 canary: a client name carrying a planted secret reaches no log, audit row, operation row or refusal, and another business never sees it', async () => {
      const logged: string[] = [];
      const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(capture),
      );
      let clientId = '';
      try {
        clientId = await createClient(`Clinic ${CANARY}`);
        const given = await give({
          personId: tia.personId,
          collection: 'task',
          action: 'read',
          clientId,
        });
        const answers = [
          await as('/client/create', { operationId: randomUUID(), name: `Clinic ${CANARY}` }),
          await as(
            '/client/create',
            { operationId: randomUUID(), name: `Clinic ${CANARY}` },
            harness.world.noah.token,
          ),
          await give({ personId: randomUUID(), collection: 'task', action: 'read', clientId }),
          await give({ personId: tia.personId, collection: CANARY, action: 'read', clientId }),
          await revoke(randomUUID()),
          await listClients(harness.world.noah.token),
          await listClients(clientToken),
        ];
        for (const answer of answers) {
          expect(answer.status).toBeGreaterThanOrEqual(400);
          expect(JSON.stringify(answer.body)).not.toContain(CANARY);
        }
        expect(
          JSON.stringify((await listClients(harness.world.bea.token, 'bravo')).body),
        ).not.toContain(CANARY);
        expect((await revoke(detailOf(given)['grantId'])).code).toBe('ok');
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(logged.join('\n')).not.toContain(CANARY);

      const stored = await harness.world.db.app.withBusiness(
        harness.world.alpha,
        async (tx) =>
          await tx.query<{ readonly row: string }>(
            `select to_jsonb(e)::text as row from public.audit_events e
            where command in ('client.create', 'client.list', 'access.grant', 'access.revoke')
           union all
           select to_jsonb(o)::text from public.operations o
            where command in ('client.create', 'access.grant', 'access.revoke')`,
          ),
      );
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.map((found) => found.row).join('\n')).not.toContain(CANARY);
    });

    it("C32 client link: a task names a client of its own business, and another business's client or a made-up one is NOT_FOUND with nothing written", async () => {
      const own = await createClient(`Linked Clinic ${randomUUID().slice(0, 6)}`);
      const bravoClient = await createClient(
        `Bravo Linked ${randomUUID().slice(0, 6)}`,
        harness.world.bea.token,
        'bravo',
      );
      const task = await harness.freshTask('a task with a client');
      const setParty = async (client: string, expectedRevision: number) =>
        await harness.asPerson('task.set_party', {
          operationId: randomUUID(),
          recordId: task.id,
          expectedRevision,
          fields: { client },
        });
      const linked = await setParty(own, task.revision);
      expect(outcome(linked)).toEqual({ status: 200, code: 'ok' });
      const revision = Number(detailOf(linked)['revision'] ?? linked.body['revision']);
      for (const foreign of [bravoClient, randomUUID()]) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await setParty(foreign, revision);
        expect(outcome(answer)).toEqual({ status: 404, code: 'NOT_FOUND' });
        expect(answer.body['names']).toEqual(['client']);
      }
      const stored = await harness.world.db.app.withBusiness(
        harness.world.alpha,
        async (tx) =>
          await tx.query<{ readonly client: string }>(
            'select uuid_7::text as client from public.records where id = $1',
            [task.id],
          ),
      );
      expect(stored).toEqual([{ client: own }]);
    });
  },
);
