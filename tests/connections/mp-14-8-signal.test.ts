// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// MP-14-8: grants, tripwires and the night round on Connections & signal,
// over HTTP against a real database. Each case is named after the acceptance
// line or supporting checklist line it proves (U33, #491).
//
// Grants are real delegations, minted by real pickups. Tripwires and night
// round steps are written by the watching checks and the round itself (the
// agent loops, not built), so the cases seed them as the database owner, as
// the fleet's cases seed connections. Every client label and every row bound
// to client B carries a planted canary, so the isolation and canary cases can
// look for it everywhere it must not be.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import type { ConnectionSignalResult, GrantView } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
const RECORD_CANARY = `record-canary-${randomUUID()}`;
const BRAVO_CANARY = `bravo-canary-${randomUUID()}`;

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

const grantOf = (result: ConnectionSignalResult, id: string): GrantView | undefined =>
  result.leases.find((one) => one.id === id);

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-8 grants, tripwires and the night round', () => {
  let controls: Controls;
  let admin: Member;
  let clientReader: Member;
  let plain: Member;
  let bravoAdmin: Member;
  let alpha: string;
  const clientA = randomUUID();
  const clientB = randomUUID();
  const clientALabel = `Client A ${RECORD_CANARY}`;
  const clientBLabel = `Client B ${RECORD_CANARY}`;
  const grants: Record<'liveA' | 'ranOutB' | 'takenBackFleet', string> = {
    liveA: '',
    ranOutB: '',
    takenBackFleet: '',
  };
  let liveCredential = '';
  const tripwireB = `Client B watch ${RECORD_CANARY}`;
  const stepB = `Client B step ${RECORD_CANARY}`;
  const answers: Answer[] = [];
  const output: string[] = [];

  const signal = async (who: Member, business = 'alpha'): Promise<ConnectionSignalResult> => {
    const answer = await post(
      controls.api,
      path(business, 'connection.signal'),
      { operationId: randomUUID() },
      authorised(await tokenFor(who.presented.subject)),
    );
    answers.push(answer);
    expect(answer.status).toBe(200);
    return answer.body as unknown as ConnectionSignalResult;
  };

  const owner = async (sql: string, params: readonly unknown[]): Promise<void> => {
    await controls.fixture.db.admin.execute(sql, params);
  };

  /** Pick a task up for real, with its party link set to `client`. */
  async function delegate(purpose: string, client: string | null): Promise<[string, string]> {
    const task = await controls.createTask(purpose);
    // The party link is projected from the record's data into its slot.
    const set = await controls.fixture.db.admin.execute<{ readonly revision: string }>(
      `update public.records set data = data || jsonb_build_object('client', $2::text)
        where id = $1 and $2::text is not null returning revision`,
      [task.id, client],
    );
    const revision = set[0] === undefined ? task.revision : Number(set[0].revision);
    const proposal = await controls.propose(task.id, revision, purpose);
    const picked = await controls.pickup(await controls.approve(proposal));
    const rows = await controls.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from public.delegations where purpose_scope_id = $1`,
      [task.id],
    );
    return [String(rows[0]?.id), String(picked['credential'])];
  }

  async function tripwire(business: string, row: Readonly<Record<string, unknown>>): Promise<void> {
    await owner(
      `insert into public.tripwires
         (business_id, id, what, rule, watching, state, blocked_reason, fired_count,
          last_fired_at, filed_item, filed_nothing, client_id)
       values ($1, $2, $3, 'fires when a lease dies waiting', 'every lease', $4, $5, $6,
               case when $6::int > 0 then now() - interval '3 hours' end, $7, $8, $9)`,
      [
        business,
        randomUUID(),
        row['what'],
        row['state'] ?? 'armed',
        row['blocked'] ?? null,
        row['fired'] ?? 0,
        row['filed'] ?? null,
        row['nothing'] ?? null,
        row['client'] ?? null,
      ],
    );
  }

  async function step(business: string, row: Readonly<Record<string, unknown>>): Promise<void> {
    await owner(
      `insert into public.night_round_steps
         (business_id, id, round_on, at, tone, what, who, say, cite_kind, cite_ref, cite_label,
          client_id)
       values ($1, $2, $3::date, $3::date - interval '1 day' + $4::interval, $5, $6, 'night.reader',
               'what happened', $7, $8, $9, $10)`,
      [
        business,
        randomUUID(),
        row['on'] ?? '2026-09-29',
        row['at'],
        row['tone'] ?? 'plain',
        row['what'],
        row['kind'] ?? null,
        row['ref'] ?? null,
        row['label'] ?? null,
        row['client'] ?? null,
      ],
    );
  }

  // eslint-disable-next-line max-lines-per-function -- the world, built in one place
  beforeAll(async () => {
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        output.push(String(chunk));
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }

    controls = await createControls('mp148');
    const { db, business } = controls.fixture;
    alpha = business;
    admin = controls.manager;
    clientReader = await enrol(db.app, business, 'clientreader');
    plain = await enrol(db.app, business, 'plain');
    const whole = { kind: 'business', id: null } as const;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'read', whole, false, 'connection');
      await grantTo(tx, clientReader, 'read', { kind: 'party', id: clientA }, false, 'connection');
      await grantTo(tx, plain, 'read', whole, false, 'task');
    });

    // The client labels the grants draw come from the connection records.
    const connection = randomUUID();
    await owner(
      `insert into public.connections (business_id, id, connector_key, label, status)
       values ($1, $2, 'seeded', 'A source', 'active')`,
      [alpha, connection],
    );
    for (const [id, label] of [
      [clientA, clientALabel],
      [clientB, clientBLabel],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- two rows in order
      await owner(
        `insert into public.connection_clients (business_id, connection_id, client_id, client_label)
         values ($1, $2, $3, $4)`,
        [alpha, connection, id, label],
      );
    }

    [grants.liveA, liveCredential] = await delegate('live_for_a', clientA);
    [grants.ranOutB] = await delegate('ran_out_for_b', clientB);
    [grants.takenBackFleet] = await delegate('taken_back_fleet', null);
    await owner(
      `update public.delegations
          set granted_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
        where id = $1`,
      [grants.ranOutB],
    );
    await owner(
      `update public.delegations
          set revoked_at = now(), revocation_cause = 'delegation_revoked' where id = $1`,
      [grants.takenBackFleet],
    );

    await tripwire(alpha, { what: 'Lease died waiting', fired: 2, filed: 'AT-10' });
    await tripwire(alpha, { what: 'Quota near its ceiling', client: clientA });
    await tripwire(alpha, {
      what: 'Agent reached past its grant',
      state: 'cannot_be_armed',
      blocked: 'the broker does not record what a lease reached',
    });
    await tripwire(alpha, {
      what: tripwireB,
      fired: 1,
      nothing: 'already queued',
      client: clientB,
    });

    await step(alpha, { on: '2026-09-28', at: '23:00', what: 'An older round opened' });
    await step(alpha, { at: '23:00', what: 'The window opened' });
    await step(alpha, {
      at: '23:05',
      what: 'The fleet lease was taken',
      kind: 'grants',
      label: 'GR-1',
    });
    await step(alpha, {
      at: '26:20',
      tone: 'bad',
      what: 'A fix for A stalled',
      kind: 'task',
      ref: 'T-1',
      label: 'The brief',
      client: clientA,
    });
    await step(alpha, { at: '27:10', tone: 'watch', what: stepB, client: clientB });
    await step(alpha, { at: '32:10', what: 'The brief was handed over' });

    const other = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, other);
    bravoAdmin = await enrol(db.app, other, 'bravoadmin');
    await db.app.withBusiness(other, async (tx) => {
      await grantTo(tx, bravoAdmin, 'read', whole, false, 'connection');
    });
    await tripwire(other, { what: `Bravo watch ${BRAVO_CANARY}` });
    await step(other, { at: '23:00', what: `Bravo step ${BRAVO_CANARY}` });

    // One redemption under the live grant: the agent reads its own task.
    const task = await controls.fixture.db.admin.execute<{ readonly id: string }>(
      `select purpose_scope_id as id from public.delegations where id = $1`,
      [grants.liveA],
    );
    const read = await controls.asAgent('task.read', { recordId: task[0]?.id }, liveCredential);
    expect(read.status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await controls?.drop();
  });

  it('MP-14-8 owner check: who holds what access shows, and each filed tripwire names what it filed', async () => {
    const result = await signal(admin);
    const live = grantOf(result, grants.liveA);
    expect(live?.state).toBe('live');
    expect(live?.agentId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(live?.purpose).toBeTruthy();
    expect(live?.client).toStrictEqual({ id: clientA, label: clientALabel });
    expect(Date.parse(live?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    const filed = result.tripwires.find((one) => one.what === 'Lease died waiting');
    expect([filed?.firedCount, filed?.filedItem]).toStrictEqual([2, 'AT-10']);
  });

  it('MP-14-8 grants fall in Live, Ran out and Taken back, with the cause and the counts from the rows', async () => {
    const result = await signal(admin);
    expect(grantOf(result, grants.ranOutB)?.state).toBe('ran_out');
    const taken = grantOf(result, grants.takenBackFleet);
    expect([taken?.state, taken?.revocationCause, taken?.client]).toStrictEqual([
      'taken_back',
      'delegation_revoked',
      null,
    ]);
    expect(result.leases.map((one) => one.state)).toStrictEqual(['live', 'ran_out', 'taken_back']);
    const rows = result.leases;
    expect(result.leaseCounts).toStrictEqual({
      live: rows.filter((one) => one.state === 'live').length,
      ranOut: rows.filter((one) => one.state === 'ran_out').length,
      takenBack: rows.filter((one) => one.state === 'taken_back').length,
      liveExec: rows.filter((one) => one.state === 'live' && one.access === 'exec').length,
    });
  });

  it('MP-14-8 grant reads count the applied calls made under it, and an unused grant counts none', async () => {
    const result = await signal(admin);
    expect(grantOf(result, grants.liveA)?.redemptions).toBe(1);
    expect(grantOf(result, grants.ranOutB)?.redemptions).toBe(0);
  });

  it('MP-14-8 tripwires: an unarmable check names why and carries no firing history', async () => {
    const result = await signal(admin);
    const dead = result.tripwires.find((one) => one.state === 'cannot_be_armed');
    expect(dead?.blockedReason).toBe('the broker does not record what a lease reached');
    expect([dead?.firedCount, dead?.lastFiredAt, dead?.filedItem]).toStrictEqual([0, null, null]);
    expect(result.tripwireCounts).toStrictEqual({
      armed: result.tripwires.filter((one) => one.state === 'armed').length,
      cannotBeArmed: 1,
    });
    await expect(
      owner(
        `insert into public.tripwires (business_id, id, what, rule, watching, state, blocked_reason,
                                       fired_count, last_fired_at)
         values ($1, $2, 'x', 'y', 'z', 'cannot_be_armed', 'no data', 1, now())`,
        [alpha, randomUUID()],
      ),
    ).rejects.toThrow(/tripwires_unarmed_never_fired/u);
  });

  it('MP-14-8 the night round is the latest round, in time order, with its cites', async () => {
    const round = (await signal(admin)).nightRound;
    expect(round?.roundOn).toBe('2026-09-29');
    expect(round?.steps.map((one) => one.what)).toStrictEqual([
      'The window opened',
      'The fleet lease was taken',
      'A fix for A stalled',
      stepB,
      'The brief was handed over',
    ]);
    expect(round?.notClean).toBe(1);
    expect(round?.steps[1]?.cite).toStrictEqual({ kind: 'grants', ref: null, label: 'GR-1' });
    expect(round?.steps[2]?.cite).toStrictEqual({ kind: 'task', ref: 'T-1', label: 'The brief' });
    expect(round?.steps[0]?.cite).toBeNull();
  });

  it('MP-14-8 the roster lists the agents with the live grants the caller sees', async () => {
    const result = await signal(admin);
    const holder = grantOf(result, grants.liveA)?.agentId;
    expect(result.roster.find((one) => one.agentId === holder)?.liveGrants).toBe(1);
  });

  it('MP-14-8 the read writes nothing beyond its own operation row', async () => {
    const count = async (): Promise<number> =>
      await controls.count(`select count(*) as n from public.audit_events where actor_id = $1`, [
        admin.actorId,
      ]);
    const before = await count();
    await signal(admin);
    expect(await count()).toBe(before + 1);
  });

  it('MP-14-8 refusal connection:read: a member without it is refused and shown nothing', async () => {
    const answer = await post(
      controls.api,
      path('alpha', 'connection.signal'),
      { operationId: randomUUID() },
      authorised(await tokenFor(plain.presented.subject)),
    );
    answers.push(answer);
    expect(answer.status).toBe(403);
    expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(answer.body['leases']).toBeUndefined();
  });

  it('MP-14-8 isolation: an agent under a live delegation reads none of it', async () => {
    const answer = await controls.asAgent('connection.signal', {}, liveCredential);
    answers.push(answer);
    expect(answer.status).toBe(403);
    expect(String(answer.body['code'])).toMatch(/^(DELEGATION_|AUTH_)/u);
    expect(answer.body['leases']).toBeUndefined();
  });

  it('MP-14-8 isolation: another business never sees or counts these grants, tripwires or steps', async () => {
    const theirs = await signal(bravoAdmin, 'bravo');
    expect(theirs.leases).toStrictEqual([]);
    expect(theirs.tripwires.map((one) => one.what)).toStrictEqual([`Bravo watch ${BRAVO_CANARY}`]);
    expect(theirs.nightRound?.steps.map((one) => one.what)).toStrictEqual([
      `Bravo step ${BRAVO_CANARY}`,
    ]);
    const text = JSON.stringify(theirs);
    for (const id of Object.values(grants)) expect(text).not.toContain(id);
    expect(text).not.toContain(RECORD_CANARY);
    expect(JSON.stringify(await signal(admin))).not.toContain(BRAVO_CANARY);
  });

  it('MP-14-8 isolation: a client-scoped reader sees that client only, in rows and counts', async () => {
    const result = await signal(clientReader);
    expect(result.leases.map((one) => one.id)).toStrictEqual([grants.liveA]);
    expect(result.leaseCounts).toStrictEqual({
      live: 1,
      ranOut: 0,
      takenBack: 0,
      liveExec: result.leases.filter((one) => one.access === 'exec').length,
    });
    expect(result.tripwires.map((one) => one.what)).toStrictEqual(['Quota near its ceiling']);
    expect(result.tripwireCounts).toStrictEqual({ armed: 1, cannotBeArmed: 0 });
    expect(result.nightRound?.steps.map((one) => one.what)).toStrictEqual(['A fix for A stalled']);
    const text = JSON.stringify(result);
    for (const foreign of [
      clientB,
      clientBLabel,
      grants.ranOutB,
      grants.takenBackFleet,
      tripwireB,
      stepB,
    ]) {
      expect(text).not.toContain(foreign);
    }
    expect(result.roster.reduce((sum, one) => sum + one.liveGrants, 0)).toBe(1);
  });

  it('MP-14-8 parity: the sections are one read on connection:read, person only, and add no action', () => {
    const row = COMMAND_SURFACE.find((one) => one.name === 'connection.signal');
    expect([row?.collection, row?.action, row?.agent]).toStrictEqual([
      'connection',
      'read',
      'never',
    ]);
  });

  it('MP-14-8 canary: planted record content never reaches output, refusals or the audit chain', async () => {
    for (const answer of answers) {
      if (answer.status !== 200) expect(JSON.stringify(answer.body)).not.toContain(RECORD_CANARY);
    }
    const printed = output.join('\n');
    for (const canary of [RECORD_CANARY, BRAVO_CANARY]) expect(printed).not.toContain(canary);
    const audit = await controls.fixture.db.admin.execute<{ readonly dump: string | null }>(
      `select string_agg(t::text, E'\\n') as dump from public.audit_events t`,
    );
    for (const canary of [RECORD_CANARY, BRAVO_CANARY]) {
      expect(audit[0]?.dump ?? '').not.toContain(canary);
    }
  });
});
