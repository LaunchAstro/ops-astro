// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// MP-14-8: grants, tripwires and the night round on Connections & signal,
// over HTTP against a real database. Each case is named after the acceptance
// line or supporting checklist line it proves (U33, #491).
//
// Grants are real delegations, minted by real pickups on tasks whose client
// is a real client of the business (`clients`, C32). Tripwires and night
// round steps are written by the watching checks and the round itself (the
// agent loops, not built), so the cases seed them as the database owner, as
// the fleet's cases seed connections. Every client name and every row bound
// to client B carries a planted canary, so the isolation and canary cases can
// look for it everywhere it must not be.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { createClient } from '../../packages/core-records/src/index.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import type { ConnectionSignalResult, GrantView } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
const RECORD_CANARY = `record-canary-${randomUUID()}`;
const BRAVO_CANARY = `bravo-canary-${randomUUID()}`;

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

const grantOf = (result: ConnectionSignalResult, id: string): GrantView | undefined =>
  result.leases.find((one) => one.id === id);

/** Text from code points, so no hostile character sits in this file as itself. */
const cp = (...points: readonly number[]): string => String.fromCodePoint(...points);

/** A real client of the transaction's business, by name. */
async function madeClient(
  tx: Parameters<typeof createClient>[0],
  name: string,
  actorId: string,
): Promise<string> {
  const made = await createClient(tx, name, actorId);
  if (!made.ok) throw new Error('mp-14-8: the client was not made');
  return made.value;
}

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('MP-14-8 grants, tripwires and the night round', () => {
  let controls: Controls;
  let admin: Member;
  let clientReader: Member;
  let plain: Member;
  let bravoAdmin: Member;
  let alpha: string;
  let bravo: string;
  let clientA = '';
  let clientB = '';
  let bravoClient = '';
  const clientAName = `Client A ${RECORD_CANARY}`;
  const clientBName = `Client B ${RECORD_CANARY}`;
  const grants: Record<
    'liveA' | 'ranOutB' | 'takenBackFleet' | 'liveB' | 'mapA' | 'ticketA' | 'trashedA',
    string
  > = {
    liveA: '',
    ranOutB: '',
    takenBackFleet: '',
    liveB: randomUUID(),
    mapA: '',
    ticketA: '',
    trashedA: '',
  };
  let liveCredential = '';
  const idleAgent = randomUUID();
  const agentB = randomUUID();
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

  /** Pick a task up for real, with its client set to `client`. */
  async function delegate(purpose: string, client: string | null): Promise<[string, string]> {
    const task = await controls.createTask(purpose);
    // The client is projected from the record's data into its slot.
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
               $11, $7, $8, $9, $10)`,
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
        row['say'] ?? 'what happened',
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
      clientA = await madeClient(tx, clientAName, admin.actorId);
      clientB = await madeClient(tx, clientBName, admin.actorId);
      await grantTo(tx, admin, 'read', whole, false, 'connection');
      await grantTo(tx, clientReader, 'read', { kind: 'party', id: clientA }, false, 'connection');
      await grantTo(tx, plain, 'read', whole, false, 'task');
    });

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
    // A second agent of the business holding nothing: on the business-wide
    // roster, never on a client-scoped reader's.
    await owner(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      alpha,
      idleAgent,
    ]);
    // A second agent holding a live grant for client B only, written as the
    // owner beside the ran-out one: never on a client A reader's roster.
    await owner(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      alpha,
      agentB,
    ]);
    await owner(
      `insert into public.delegations
         (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
          collections, actions, credential_hash, granted_at, expires_at, purpose_scope_kind,
          purpose_scope_id)
       select business_id, $2, $3, delegate_person_id, minted_by_actor_id, 'live_for_b',
              collections, actions, repeat('ab', 32), now(), now() + interval '1 hour',
              purpose_scope_kind, purpose_scope_id
         from public.delegations where id = $1`,
      [grants.ranOutB, grants.liveB, agentB],
    );
    // Client A grants a client-scoped reader is not shown: one on a map, one
    // on that map's ticket, one on a trashed task.
    [grants.mapA] = await delegate('map_for_a', clientA);
    [grants.ticketA] = await delegate('ticket_for_a', clientA);
    [grants.trashedA] = await delegate('trashed_for_a', clientA);
    await owner(
      `update public.records set data = data || '{"type":"map"}'::jsonb
        where id = (select purpose_scope_id from public.delegations where id = $1)`,
      [grants.mapA],
    );
    await owner(
      `update public.records
          set data = data || jsonb_build_object('parent', (
            select purpose_scope_id::text from public.delegations where id = $2))
        where id = (select purpose_scope_id from public.delegations where id = $1)`,
      [grants.ticketA, grants.mapA],
    );
    await owner(
      `update public.records
          set deleted_at = now(), deleted_by_actor_id = $2, trash_batch_id = $3
        where id = (select purpose_scope_id from public.delegations where id = $1)`,
      [grants.trashedA, admin.actorId, randomUUID()],
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
    // A later round that ran for client B only: a client A reader's round is
    // still the 29th's.
    await step(alpha, { on: '2026-09-30', at: '23:00', what: stepB, client: clientB });

    bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
    await db.app.withBusiness(bravo, async (tx) => {
      bravoClient = await madeClient(tx, `Bravo client ${BRAVO_CANARY}`, bravoAdmin.actorId);
      await grantTo(tx, bravoAdmin, 'read', whole, false, 'connection');
    });
    await tripwire(bravo, { what: `Bravo watch ${BRAVO_CANARY}`, client: bravoClient });
    await step(bravo, { at: '23:00', what: `Bravo step ${BRAVO_CANARY}`, client: bravoClient });

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
    expect(live?.purpose).toBe('live_for_a');
    expect(live?.client).toStrictEqual({ id: clientA, label: clientAName });
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
    const order = { live: 0, ran_out: 1, taken_back: 2 } as const;
    const ranks = result.leases.map((one) => order[one.state]);
    expect(ranks).toStrictEqual(ranks.toSorted((a, b) => a - b));
    expect(new Set(ranks)).toStrictEqual(new Set([0, 1, 2]));
    const rows = result.leases;
    expect(result.leaseCounts).toStrictEqual({
      live: rows.filter((one) => one.state === 'live').length,
      ranOut: rows.filter((one) => one.state === 'ran_out').length,
      takenBack: rows.filter((one) => one.state === 'taken_back').length,
      liveExec: rows.filter((one) => one.state === 'live' && one.access === 'exec').length,
    });
  });

  it('MP-14-8 a business-wide reader sees every grant, on a map or a trashed task included', async () => {
    const result = await signal(admin);
    for (const id of [grants.liveB, grants.mapA, grants.ticketA, grants.trashedA]) {
      expect(grantOf(result, id)?.state).toBe('live');
    }
  });

  it('MP-14-8 grant reads count the applied calls made under it, and an unused grant counts none', async () => {
    const result = await signal(admin);
    expect(grantOf(result, grants.liveA)?.redemptions).toBe(1);
    expect(grantOf(result, grants.ranOutB)?.redemptions).toBe(0);
  });

  it('MP-14-8 grants never carry the credential the pickup returned', async () => {
    const text = JSON.stringify(await signal(admin));
    expect(liveCredential.length).toBeGreaterThan(8);
    expect(text).not.toContain(liveCredential);
    expect(text).not.toMatch(/credential/iu);
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

  it.each([
    ['a line break', `Lease died${cp(0x0a)}waiting`],
    ['a line separator', `Lease died${cp(0x2028)}waiting`],
    ['a direction override', `Lease ${cp(0x202e)}died waiting`],
    ['an Arabic letter mark', `Lease${cp(0x061c)} died`],
    ['a zero-width space', `Lease${cp(0x200b)}died`],
    ['a byte order mark', `Lease died${cp(0xfeff)}`],
    ['a soft hyphen', `Lease${cp(0x00ad)}died`],
    ['hidden tag characters', `Lease died${cp(0xe0069, 0xe0067, 0xe006e)} waiting`],
    ['a variation selector', `L${cp(0xfe0f)}ease died`],
    ['a supplementary variation selector', `Lease died${cp(0xe0100)}`],
    ['a leading combining mark', `${cp(0x0301)}Lease died`],
    ['a stack of combining marks', `L${cp(...Array.from({ length: 8 }, () => 0x030d))}ease`],
    ['a format control', `${cp(0x0600)}Lease`],
    ['a leading space', ' Lease died'],
    ['a trailing no-break space', `Lease died${cp(0x00a0)}`],
    ['nothing at all', ''],
  ])(
    'MP-14-8 seeded text: a tripwire or a step holding %s is refused whole',
    async (_why, what) => {
      await expect(tripwire(alpha, { what })).rejects.toThrow(/signal_text_shape/u);
      await expect(step(alpha, { at: '23:30', what: 'ok', say: what })).rejects.toThrow(
        /signal_text_shape/u,
      );
    },
  );

  it('MP-14-8 seeded text: ordinary words with accents, dashes, quotes and signs are kept as written', async () => {
    const what = `Caf${cp(0xe9)}${cp(0x2019)}s quota ${cp(0x2014)} ${cp(0x20ac)}40 ${cp(0x2192)} 80%`;
    await tripwire(alpha, { what });
    const result = await signal(admin);
    expect(result.tripwires.map((one) => one.what)).toContain(what);
  });

  it('MP-14-8 seeded text: a task cite is a task key and a filed item a display id, nothing else', async () => {
    for (const ref of ['/task/T-1', 'T-1?x', 'javascript:alert(1)', 'T-01', 't-1']) {
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      await expect(
        step(alpha, { at: '23:30', what: 'ok', kind: 'task', ref, label: 'x' }),
      ).rejects.toThrow(/night_round_steps_cite_ref_shape/u);
    }
    await expect(step(alpha, { at: '23:30', what: 'ok', ref: 'T-2' })).rejects.toThrow(
      /night_round_steps_cite_whole/u,
    );
    await expect(
      tripwire(alpha, { what: 'ok', fired: 1, filed: 'https://example.test/AT-1' }),
    ).rejects.toThrow(/tripwires_filed_item_shape/u);
  });

  it('MP-14-8 isolation: a tripwire or a step can never name another business client', async () => {
    await expect(tripwire(alpha, { what: 'ok', client: bravoClient })).rejects.toThrow(
      /tripwires_client_fkey/u,
    );
    await expect(step(alpha, { at: '23:30', what: 'ok', client: bravoClient })).rejects.toThrow(
      /night_round_steps_client_fkey/u,
    );
  });

  it('MP-14-8 the night round is the latest round, in time order, with its cites', async () => {
    await owner(`delete from public.night_round_steps where round_on = '2026-09-30'`, []);
    try {
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
    } finally {
      await step(alpha, { on: '2026-09-30', at: '23:00', what: stepB, client: clientB });
    }
  });

  it('MP-14-8 the roster lists the business agents with the live grants the caller sees', async () => {
    const result = await signal(admin);
    const holder = grantOf(result, grants.liveA)?.agentId;
    // live_for_a, map_for_a, ticket_for_a and trashed_for_a: one agent picked all four up.
    expect(result.roster.find((one) => one.agentId === holder)?.liveGrants).toBe(4);
    expect(result.roster.find((one) => one.agentId === idleAgent)?.liveGrants).toBe(0);
    expect(result.roster.find((one) => one.agentId === agentB)?.liveGrants).toBe(1);
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
    expect(answer.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(answer.body['leases']).toBeUndefined();
  });

  it('MP-14-8 isolation: another business never sees or counts these grants, tripwires or steps', async () => {
    const theirs = await signal(bravoAdmin, 'bravo');
    expect(theirs.leases).toStrictEqual([]);
    expect(theirs.leaseCounts).toStrictEqual({ live: 0, ranOut: 0, takenBack: 0, liveExec: 0 });
    expect(theirs.tripwires.map((one) => one.what)).toStrictEqual([`Bravo watch ${BRAVO_CANARY}`]);
    expect(theirs.nightRound?.steps.map((one) => one.what)).toStrictEqual([
      `Bravo step ${BRAVO_CANARY}`,
    ]);
    expect(theirs.roster).toStrictEqual([]);
    const text = JSON.stringify(theirs);
    for (const foreign of [...Object.values(grants), clientA, clientB, idleAgent, RECORD_CANARY]) {
      expect(text).not.toContain(foreign);
    }
    const ours = JSON.stringify(await signal(admin));
    for (const foreign of [bravoClient, BRAVO_CANARY]) expect(ours).not.toContain(foreign);
  });

  it('MP-14-8 isolation: a client-scoped reader sees that client only, in rows, counts and roster', async () => {
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
    expect(result.nightRound?.roundOn).toBe('2026-09-29');
    expect(result.nightRound?.steps.map((one) => one.what)).toStrictEqual(['A fix for A stalled']);
    expect(result.roster).toStrictEqual([
      { agentId: result.leases[0]?.agentId, active: true, liveGrants: 1 },
    ]);
    const text = JSON.stringify(result);
    for (const foreign of [
      clientB,
      clientBName,
      grants.ranOutB,
      grants.takenBackFleet,
      tripwireB,
      stepB,
      idleAgent,
      agentB,
      grants.liveB,
      grants.mapA,
      grants.ticketA,
      grants.trashedA,
      '2026-09-30',
    ]) {
      expect(text).not.toContain(foreign);
    }
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
