// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: accepts that run at once. Two accepts of one link never
// both reach the login provider: the one that loses sets no password, so the
// person the winner enrolled signs in with the password the page told them
// to use. And the provider calls the accepts make are bounded as the
// catalogue says: no more in flight for one business than the operation's
// concurrency, and no more on the route than its ceiling, whichever business
// they come from. Each accept runs on its own connection, so the race is in
// the server, not queued in one pool.

import { describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  type AcceptResult,
} from '../../packages/core-commands/src/commands/invitation-accept.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { e, invited, lapseClaims, passwordFor, useEnrolWorld } from './c39-t-enrol-world.ts';
import { addressFor, as, c, codeOf, noDatabase, w } from './c39-t-world.ts';

useEnrolWorld();

const UNAVAILABLE = { ok: false, code: 'ENROLMENT_UNAVAILABLE' } as const;
const ENROLLED = { ok: true, state: 'enrolled' } as const;

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** One accept on a connection of its own, closed once it answers. */
async function acceptOwn(token: string, password: string, broker: Broker = w.broker) {
  const database: Database = connect(w.db.appUrl, { source: 'runtime' });
  try {
    return await acceptInvitation(database, [w.alpha, w.bravo], broker, { token, password });
  } finally {
    await database.close();
  }
}

/**
 * A broker whose first provider call waits, after its accept's claim has committed and before
 * the call leaves, until `resume`; `reached` settles when it is waiting.
 */
function pausedBeforeCall(): { broker: Broker; reached: Promise<void>; resume: () => void } {
  let resume!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let first = true;
  const { custody } = w.broker;
  const paused = {
    ...custody,
    dispatch: async (...call: Parameters<typeof custody.dispatch>) => {
      if (first) {
        first = false;
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

/** The POSTs the provider has been sent since `from`. */
const postsSince = (from: number): number =>
  e.users.received.slice(from).filter((one) => one.method === 'POST').length;

/**
 * Start every accept at once with the provider holding its answers, wait until each has either
 * reached the provider or answered (or `capMs` passed), and count the creates in flight then.
 */
async function inFlightAtOnce(
  accepts: readonly (() => Promise<AcceptResult>)[],
  capMs = 400,
): Promise<{ readonly inFlight: number; readonly results: readonly AcceptResult[] }> {
  const from = e.users.received.length;
  const release = e.users.hold();
  let answered = 0;
  const running = accepts.map(async (accept) => {
    try {
      return await accept();
    } finally {
      answered += 1;
    }
  });
  const until = Date.now() + capMs;
  while (postsSince(from) + answered < accepts.length && Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- polling the stand-in, a few milliseconds at a time
    await delay(10);
  }
  const inFlight = postsSince(from);
  release();
  return { inFlight, results: await Promise.all(running) };
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T enrolment races', () => {
  it('C39-T enrolment: of two accepts of one link at once, the one that loses sets no password, so the enrolled person signs in with their own', async () => {
    e.users.mode('accept');
    const address = addressFor('two-at-once');
    const { token } = await invited(c.admin, address);
    const [first, second] = [passwordFor(), passwordFor()];
    let other: Promise<AcceptResult> | undefined;
    // The second accept is let in once the first has reached the provider, before it is answered.
    e.users.beforeNext(async () => {
      other = acceptOwn(token, second);
      await Promise.race([other, delay(300)]);
    });
    const one = await acceptOwn(token, first);
    const two = await (other as Promise<AcceptResult>);
    const results = [one, two];
    const enrolled = results.filter((result) => result.ok && result.state === 'enrolled');
    expect(enrolled, JSON.stringify(results)).toHaveLength(1);
    const winner = one.ok && one.state === 'enrolled' ? first : second;
    const made = String(e.users.users.get(address));
    expect(e.users.passwords.get(made)).toBe(winner);
    expect(results.find((result) => result !== enrolled[0])).toMatchObject({ ok: false });
  }, 30_000);

  it('C39-T enrolment: an accept whose provider call went unanswered keeps its claim, so a second accept asks nothing until it lapses', async () => {
    const address = addressFor('unanswered');
    const { token } = await invited(c.admin, address);
    const [first, second] = [passwordFor(), passwordFor()];
    e.users.mode('made_late');
    expect(await acceptOwn(token, first)).toStrictEqual(UNAVAILABLE);
    e.users.mode('accept');
    const from = e.users.received.length;
    // The lost create may still be applied: a second accept must not set a password meanwhile.
    expect(await acceptOwn(token, second)).toStrictEqual(UNAVAILABLE);
    expect(e.users.received).toHaveLength(from);
    await lapseClaims();
    expect(await acceptOwn(token, second)).toStrictEqual({ ok: true, state: 'enrolled' });
    expect(e.users.passwords.get(String(e.users.users.get(address)))).toBe(second);
  }, 30_000);

  it('C39-T enrolment: a provider that answered with a fault lets the claim go, so the same link enrols at once', async () => {
    const address = addressFor('answered-fault');
    const { token } = await invited(c.admin, address);
    e.users.mode('fault');
    expect(await acceptOwn(token, passwordFor())).toStrictEqual(UNAVAILABLE);
    e.users.mode('accept');
    expect(await acceptOwn(token, passwordFor())).toStrictEqual({ ok: true, state: 'enrolled' });
  }, 30_000);

  it('C39-T enrolment: an accept whose claim lapsed binds nothing once another accept holds the claim', async () => {
    e.users.mode('accept');
    const address = addressFor('lapsed-claim');
    const { id, token } = await invited(c.admin, address);
    const [first, second] = [passwordFor(), passwordFor()];
    // Timeouts long enough that only the claim decides, never a slow answer.
    const patient: Broker = {
      ...w.broker,
      operations: new Map(
        [...w.broker.operations].map(([key, op]) => [key, { ...op, timeoutMs: 5_000 }]),
      ),
    };
    let other: Promise<AcceptResult> | undefined;
    let release: (() => void) | undefined;
    // The first accept's create has reached the provider: its claim lapses, and a second accept
    // claims and reaches the provider too, where it is held until the first has tried to bind.
    e.users.beforeNext(async () => {
      await w.db.admin.execute(
        `update public.invitations set accept_claimed_until = clock_timestamp() - interval '1 second'
          where id = $1`,
        [id],
      );
      release = e.users.hold();
      const from = e.users.received.length;
      other = acceptOwn(token, second, patient);
      for (let wait = 0; e.users.received.length === from && wait < 300; wait += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polling the stand-in
        await delay(10);
      }
    });
    const one = await acceptOwn(token, first, patient);
    release?.();
    const two = await (other as Promise<AcceptResult>);
    expect(one, 'the lapsed claim binds nothing').toMatchObject({ ok: false });
    expect(two).toStrictEqual({ ok: true, state: 'enrolled' });
    expect(e.users.passwords.get(String(e.users.users.get(address)))).toBe(second);
  }, 30_000);

  it('C39-T enrolment: an accept resumed after its claim lapsed and another accept enrolled sets no password (Sol R2 F1)', async () => {
    e.users.mode('accept');
    const address = addressFor('resumed-late');
    const { id, token } = await invited(c.admin, address);
    const [pa, pb] = [passwordFor(), passwordFor()];
    // B claims, then waits before its create leaves; its claim passes its bound meanwhile.
    const paused = pausedBeforeCall();
    const b = acceptOwn(token, pb, paused.broker);
    await paused.reached;
    await w.db.admin.execute(
      `update public.invitations set accept_claimed_until = clock_timestamp() - interval '1 second'
        where id = $1`,
      [id],
    );
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
    await w.db.admin.execute(
      `update public.invitations set accept_claimed_until = clock_timestamp() - interval '1 second'
        where id = $1`,
      [old.id],
    );
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
    e.users.mode('made_late');
    expect(await acceptOwn(token, passwordFor())).toStrictEqual(UNAVAILABLE);
    await lapseClaims();
    e.users.mode('accept');
    const paused = pausedBeforeCall();
    const late = acceptOwn(token, passwordFor(), paused.broker);
    await paused.reached;
    // Its claim passes its bound before the create leaves: no longer counted in the limits.
    await w.db.admin.execute(
      `update public.invitations set accept_claimed_until = clock_timestamp() - interval '1 second'
        where id = $1`,
      [id],
    );
    const from = e.users.received.length;
    paused.resume();
    expect(await late).toStrictEqual(UNAVAILABLE);
    expect(putsSince(from)).toBe(0);
  }, 30_000);

  it('C39-T enrolment: five accepts at once in one business send no more creates than auth.create_user allows in flight', async () => {
    e.users.mode('accept');
    const links = [];
    for (let n = 0; n < 5; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one invitation, then its send, at a time
      links.push(await invited(c.admin, addressFor(`five-${String(n)}`)));
    }
    const { inFlight, results } = await inFlightAtOnce(
      links.map(
        ({ token }) =>
          async () =>
            await acceptOwn(token, passwordFor()),
      ),
    );
    expect(inFlight).toBeGreaterThan(0);
    expect(inFlight).toBeLessThanOrEqual(4);
    expect(results.some((result) => result.ok)).toBe(true);
  }, 60_000);

  it('C39-T enrolment: a route with a ceiling of one admits one create at a time, whichever business asks', async () => {
    e.users.mode('accept');
    const narrow: Broker = {
      ...w.broker,
      routes: w.broker.routes.map((route) => ({ ...route, ceiling: 1 })),
    };
    const alpha = await invited(c.admin, addressFor('ceiling-alpha'));
    const bravo = await invited(c.bravoAdmin, addressFor('ceiling-bravo'), w.bravo);
    const { inFlight, results } = await inFlightAtOnce(
      [alpha, bravo].map(
        ({ token }) =>
          async () =>
            await acceptOwn(token, passwordFor(), narrow),
      ),
    );
    // At most one: another file's accept on the same database may hold the one place.
    expect(inFlight).toBeLessThanOrEqual(1);
    expect(results.filter((result) => result.ok).length).toBeLessThanOrEqual(1);
    expect(results).toContainEqual({ ok: false, code: 'ENROLMENT_UNAVAILABLE' });
  }, 60_000);
});
