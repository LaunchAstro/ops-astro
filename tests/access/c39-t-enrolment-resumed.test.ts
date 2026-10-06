// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: an accept paused between its claim and its provider call,
// then resumed (Sol R2 F1 and F7, SEC-P3A-5 L2 and I2). Whatever happened
// meanwhile, its claim lapsing, another accept enrolling, its invitation
// revoked and replaced, it sets no password over the enrolled person's and
// none outside the limits its claim no longer counts in. Each accept runs on
// its own connection, so the race is in the server, not queued in one pool.

import { describe, expect, it } from 'vitest';
import { acceptInvitation } from '../../packages/core-commands/src/commands/invitation-accept.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { e, invited, lapseClaims, passwordFor, useEnrolWorld } from './c39-t-enrol-world.ts';
import { addressFor, as, c, codeOf, noDatabase, w } from './c39-t-world.ts';

useEnrolWorld();

const UNAVAILABLE = { ok: false, code: 'ENROLMENT_UNAVAILABLE' } as const;
const ENROLLED = { ok: true, state: 'enrolled' } as const;

/** One accept on a connection of its own, closed once it answers. */
async function acceptOwn(
  token: string,
  password: string,
  broker: Broker = w.broker,
  wrap: (database: Database) => Database = (database) => database,
) {
  const database: Database = connect(w.db.appUrl, { source: 'runtime' });
  try {
    return await acceptInvitation(wrap(database), [w.alpha, w.bravo], broker, { token, password });
  } finally {
    await database.close();
  }
}

/** A login an earlier accept stranded for the token's address, its claim lapsed. */
async function strand(token: string): Promise<void> {
  e.users.mode('made_late');
  expect(await acceptOwn(token, passwordFor())).toStrictEqual(UNAVAILABLE);
  await lapseClaims();
  e.users.mode('accept');
}

/** Once the invitation's claim has passed its committed end on the database's own clock. */
async function lapsedOnItsOwn(invitationId: string): Promise<void> {
  for (let wait = 0; wait < 300; wait += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling the database's clock
    const [row] = await w.db.admin.execute<{ lapsed: boolean }>(
      'select accept_claimed_until <= clock_timestamp() as lapsed from public.invitations where id = $1',
      [invitationId],
    );
    if (row?.lapsed === true) return;
    // oxlint-disable-next-line no-await-in-loop -- a tenth of a second at a time
    await delay(100);
  }
  throw new Error('the claim never lapsed');
}

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The database, its `nth` transaction held open after its work, before it commits, until `commit`. */
function heldBeforeCommit(nth: number) {
  let commit!: () => void;
  const gate = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let calls = 0;
  const wrap = (database: Database): Database => ({
    log: database.log,
    close: async () => await database.close(),
    withBusiness: async (business, run) =>
      await database.withBusiness(business, async (tx) => {
        calls += 1;
        const mine = calls === nth;
        const result = await run(tx);
        if (mine) await gate;
        return result;
      }),
  });
  return { wrap, commit };
}

/** The broker over a route of ceiling one, with these timeouts (ms) for create and update. */
function narrowed(createMs: number, updateMs: number): Broker {
  const timeouts: Record<string, number> = {
    'auth.create_user': createMs,
    'auth.update_user': updateMs,
  };
  return {
    ...w.broker,
    routes: w.broker.routes.map((route) => ({ ...route, ceiling: 1 })),
    operations: new Map(
      [...w.broker.operations].map(([key, op]) => [
        key,
        { ...op, timeoutMs: timeouts[key] ?? op.timeoutMs },
      ]),
    ),
  };
}

/** An invitation's claim past its bound, as a stalled accept's would be. */
async function lapse(invitationId: string): Promise<void> {
  await w.db.admin.execute(
    `update public.invitations set accept_claimed_until = clock_timestamp() - interval '1 second'
      where id = $1`,
    [invitationId],
  );
}

/**
 * A broker whose `nth` provider call waits, after the claim or renewal before it has committed
 * and before the call leaves for custody, until `resume`; `reached` settles when it is waiting.
 */
function pausedBeforeCall(nth = 1): { broker: Broker; reached: Promise<void>; resume: () => void } {
  let resume!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let calls = 0;
  const { custody } = w.broker;
  const paused = {
    ...custody,
    dispatch: async (...call: Parameters<typeof custody.dispatch>) => {
      calls += 1;
      if (calls === nth) {
        reach();
        await gate;
      }
      return await custody.dispatch(...call);
    },
  };
  return { broker: { ...w.broker, custody: paused }, reached, resume };
}

/** The PUTs the provider has been sent since `from`. */
const putsSince = (from: number): number =>
  e.users.received.slice(from).filter((one) => one.method === 'PUT').length;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T enrolment resumed accepts', () => {
  it('C39-T enrolment: an accept resumed after its claim lapsed and another accept enrolled sets no password (Sol R2 F1)', async () => {
    e.users.mode('accept');
    const address = addressFor('resumed-late');
    const { id, token } = await invited(c.admin, address);
    const [pa, pb] = [passwordFor(), passwordFor()];
    // B claims, then waits before its create leaves; its claim passes its bound meanwhile.
    const paused = pausedBeforeCall();
    const b = acceptOwn(token, pb, paused.broker);
    await paused.reached;
    await lapse(id);
    expect(await acceptOwn(token, pa)).toStrictEqual(ENROLLED);
    const from = e.users.received.length;
    paused.resume();
    expect(await b, 'the superseded accept enrols nothing').toMatchObject({ ok: false });
    expect(putsSince(from), 'the superseded accept sets no password').toBe(0);
    expect(e.users.passwords.get(String(e.users.users.get(address)))).toBe(pa);
  }, 30_000);

  it('C39-T enrolment: a paused accept of a revoked invitation changes no password once its replacement enrols (Sol R2 F7)', async () => {
    e.users.mode('accept');
    const address = addressFor('revoked-replaced');
    const old = await invited(c.admin, address);
    const [p1, p2] = [passwordFor(), passwordFor()];
    const paused = pausedBeforeCall();
    const first = acceptOwn(old.token, p1, paused.broker);
    await paused.reached;
    expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: old.id }))).toBe(
      'applied',
    );
    const fresh = await invited(c.admin, address);
    const asked = e.users.received.length;
    const early = await acceptOwn(fresh.token, p2);
    const askedEarly = e.users.received.length - asked;
    paused.resume();
    expect(await first).toMatchObject({ ok: false });
    const enrolled = early.ok ? early : await acceptOwn(fresh.token, p2);
    expect(enrolled).toStrictEqual(ENROLLED);
    expect(e.users.passwords.get(String(e.users.users.get(address)))).toBe(p2);
    // The login the two invitations share was the old accept's to claim: the new one asked nothing.
    expect(early).toStrictEqual(UNAVAILABLE);
    expect(askedEarly).toBe(0);
  }, 30_000);

  it('C39-T enrolment: a paused accept whose claim lapsed, its invitation revoked and replaced, changes no password once the replacement enrols (SEC-P3A-5 I2)', async () => {
    e.users.mode('accept');
    const address = addressFor('lapsed-revoked');
    const old = await invited(c.admin, address);
    const [p1, p2] = [passwordFor(), passwordFor()];
    const paused = pausedBeforeCall();
    const first = acceptOwn(old.token, p1, paused.broker);
    await paused.reached;
    expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: old.id }))).toBe(
      'applied',
    );
    await lapse(old.id);
    const fresh = await invited(c.admin, address);
    expect(await acceptOwn(fresh.token, p2)).toStrictEqual(ENROLLED);
    const from = e.users.received.length;
    paused.resume();
    expect(await first).toMatchObject({ ok: false });
    expect(putsSince(from), 'the revoked accept sets no password').toBe(0);
    expect(e.users.passwords.get(String(e.users.users.get(address)))).toBe(p2);
  }, 30_000);

  it('C39-T enrolment: an accept whose claim lapsed, though no other accept took it, sets no password outside the limits (SEC-P3A-5 L2)', async () => {
    const address = addressFor('lapsed-untaken');
    const { id, token } = await invited(c.admin, address);
    // A login an earlier accept stranded, so the next accept's create is refused and it updates.
    await strand(token);
    const paused = pausedBeforeCall();
    const late = acceptOwn(token, passwordFor(), paused.broker);
    await paused.reached;
    // Its claim passes its bound before the create leaves: no longer counted in the limits.
    await lapse(id);
    const from = e.users.received.length;
    paused.resume();
    expect(await late).toStrictEqual(UNAVAILABLE);
    expect(putsSince(from)).toBe(0);
  }, 30_000);

  it('C39-T enrolment: an adoption paused after its renewal, resumed once the renewed claim lapsed and another accept enrolled, sets no password (Sol R3 F1)', async () => {
    const address = addressFor('renewed-late');
    const { id, token } = await invited(c.admin, address);
    await strand(token);
    const [pa, pb] = [passwordFor(), passwordFor()];
    // B's create is refused (the stranded login), its renewal commits, and its update waits.
    const paused = pausedBeforeCall(2);
    const b = acceptOwn(token, pb, paused.broker);
    await paused.reached;
    await lapsedOnItsOwn(id);
    expect(await acceptOwn(token, pa)).toStrictEqual(ENROLLED);
    const from = e.users.received.length;
    paused.resume();
    expect(await b, 'the superseded accept enrols nothing').toMatchObject({ ok: false });
    expect(putsSince(from), 'the superseded accept sets no password').toBe(0);
    expect(e.users.passwords.get(String(e.users.users.get(address)))).toBe(pa);
  }, 30_000);

  it('C39-T enrolment: a renewal still uncommitted past the committed end of its claim lets no other accept take its place on a route of one (Sol R3 F8)', async () => {
    const stranded = await invited(c.admin, addressFor('renewal-held'));
    await strand(stranded.token);
    const other = await invited(c.bravoAdmin, addressFor('renewal-held-bravo'), w.bravo);
    // A's create answers after 7 s (its claim runs 8 + 1 + 5 = 14 s), so its renewal, the fourth
    // transaction (two to find the token, the claim, the renewal), extends past that end; the
    // renewal is then held before it commits while that end passes.
    const broker = narrowed(8000, 1000);
    const held = heldBeforeCommit(4);
    e.users.beforeNext(async () => await delay(7000));
    const a = acceptOwn(stranded.token, passwordFor(), broker, held.wrap);
    await delay(7500);
    await lapsedOnItsOwn(stranded.id);
    const release = e.users.hold();
    const from = e.users.received.length;
    const b = acceptOwn(other.token, passwordFor(), broker);
    await delay(700);
    held.commit();
    await delay(500);
    const inFlight = e.users.received.slice(from).map((one) => one.method);
    release();
    const [, second] = await Promise.all([a, b]);
    expect(inFlight, 'calls in flight on a route of one').toStrictEqual(['PUT']);
    expect(second, 'the other business waits for the place').toStrictEqual(UNAVAILABLE);
  }, 40_000);
});
