// SPDX-License-Identifier: AGPL-3.0-only
//
// The session list follows the door: a session it names is one login
// resolution still serves, and one the door refuses is not named. The list
// reads first-serving times; the door reads the token's sign-in time and the
// ending's commit time. Here an ending of the other sessions and a serving of
// another session run on two separate connections and cross, either one dies
// before its commit, an ending is asked again after its answer was lost, and
// a sign-in follows an ending on a provider clock inside the minute the
// verifier allows. Each time the list and the door give the same answer.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveLogin,
  standingOf,
} from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  endOtherSeenSessions,
  listSeenSessions,
} from '../../packages/core-records/src/identity/sessions.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const live = databaseUrlFromEnvironment() !== undefined;
let db: FreshDatabase;
// Two pools of one connection each: the two sides of every race are separate sessions.
let one: Database;
let two: Database;

beforeAll(async () => {
  if (!live) return;
  db = await createFreshDatabase({ part: 'sessionlistrace' });
  one = connect(db.appUrl, { max: 1 });
  two = connect(db.appUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await one?.close();
  await two?.close();
  await db?.drop();
});

const now = () => Math.floor(Date.now() / 1000);

const presented = (subject: string, sessionId: string, signedInAt: number): VerifiedSubject => ({
  provider: 'supabase',
  subject,
  sessionId,
  assurance: { level: 'aal1', signedInAt, factorAt: null },
});

/** A person signed in on `keep` two minutes ago and served on it. */
async function signedIn(name: string) {
  const subject = randomUUID();
  const business = await insertBusiness(db.app, name);
  const person = await db.app.withBusiness(business, async (tx) => {
    const id = await insertPerson(tx, 'Session list reader');
    const actor = await insertActor(tx, id);
    await insertMembership(tx, id);
    await insertMapping(tx, await insertLogin(tx, subject), id, actor);
    return id;
  });
  const keep = randomUUID();
  const served = await db.app.withBusiness(
    business,
    async (tx) => await resolveLogin(tx, presented(subject, keep, now() - 120)),
  );
  expect(served).not.toHaveProperty('refused');
  return { subject, business, person, keep };
}

type World = Awaited<ReturnType<typeof signedIn>>;

/** `work` in a transaction on `database`, held open after it until released. */
function heldOpen(database: Database, business: string, work: (tx: TenantQuery) => Promise<void>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const done = database.withBusiness(business, async (tx) => {
    const [row] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
    await work(tx);
    ready(row?.pid ?? 0);
    await released;
  });
  // Settled by each test; a crashed side rejects here, which the test asserts.
  done.catch(() => null);
  return { pid, done, release };
}

/** The ending of the person's other sessions, kept `keep`, held before its commit. */
const endingHeld = (world: World) =>
  heldOpen(one, world.business, async (tx) => {
    await endOtherSeenSessions(tx, world.person, world.keep, 'end_others', world.subject);
  });

/** What the door says of the session now, recording nothing, and whether the list names it. */
async function doorAndList(world: World, sessionId: string, signedInAt: number) {
  const door = await two.withBusiness(
    world.business,
    async (tx) => await standingOf(tx, presented(world.subject, sessionId, signedInAt), 'required'),
  );
  const listed = await one.withBusiness(
    world.business,
    async (tx) => await listSeenSessions(tx, world.person, world.keep),
  );
  const ids = new Set(listed.map((session) => session.sessionId));
  return {
    served: !('refused' in door),
    listed: ids.has(sessionId),
    keepListed: ids.has(world.keep),
  };
}

/** Resolves within a second, or names the wait: a serving that blocked on the ending. */
async function within<T>(work: Promise<T>): Promise<T | 'waited'> {
  return await Promise.race([work, delay(1000).then(() => 'waited' as const)]);
}

/** The door's answer to a sign-in served on the second connection, or the wait that blocked it. */
const servingOnTwo = (world: World, sessionId: string, signedInAt: number) =>
  within(
    two.withBusiness(
      world.business,
      async (tx) => await resolveLogin(tx, presented(world.subject, sessionId, signedInAt)),
    ),
  );

const refusedAndUnlisted = { served: false, listed: false, keepListed: true };
const servedAndListed = { served: true, listed: true, keepListed: true };

const kill = async (pid: number) => {
  await db.admin.execute('select pg_terminate_backend($1)', [pid]);
};

/** A new pool for one whose connection was killed: the dead one is left, so no late error reaches a later read. */
function reopened(): Database {
  return connect(db.appUrl, { max: 1 });
}

async function endingCrossesServing() {
  const world = await signedIn('ending-crosses-serving');
  const old = randomUUID();
  const signedInAt = now() - 600;
  const ending = endingHeld(world);
  try {
    await ending.pid;
    const serving = await servingOnTwo(world, old, signedInAt);
    expect(serving, 'served before the ending committed').not.toBe('waited');
    expect(serving).not.toHaveProperty('refused');
  } finally {
    ending.release();
  }
  await ending.done;
  expect(await doorAndList(world, old, signedInAt)).toEqual(refusedAndUnlisted);
}

async function endingDies() {
  const world = await signedIn('ending-dies');
  const old = randomUUID();
  const signedInAt = now() - 600;
  const ending = endingHeld(world);
  try {
    const pid = await ending.pid;
    const serving = await servingOnTwo(world, old, signedInAt);
    expect(serving).not.toHaveProperty('refused');
    await kill(pid);
  } finally {
    ending.release();
  }
  await expect(ending.done).rejects.toThrow();
  one = reopened();
  expect(await doorAndList(world, old, signedInAt)).toEqual(servedAndListed);
}

async function servingDies() {
  const world = await signedIn('serving-dies');
  const old = randomUUID();
  const signedInAt = now() - 600;
  const ending = endingHeld(world);
  try {
    await ending.pid;
    const serving = two.withBusiness(world.business, async (tx) => {
      const [row] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
      expect(await resolveLogin(tx, presented(world.subject, old, signedInAt))).not.toHaveProperty(
        'refused',
      );
      await kill(row?.pid ?? 0);
    });
    await expect(serving).rejects.toThrow();
    two = reopened();
  } finally {
    ending.release();
  }
  await ending.done;
  expect(await doorAndList(world, old, signedInAt)).toEqual(refusedAndUnlisted);
}

async function lostAnswers() {
  const world = await signedIn('lost-answers');
  const old = randomUUID();
  const signedInAt = now() - 600;
  const ending = endingHeld(world);
  try {
    await ending.pid;
    const serving = await servingOnTwo(world, old, signedInAt);
    expect(serving).not.toHaveProperty('refused');
  } finally {
    ending.release();
  }
  await ending.done;
  // Both answers were lost: the person ends the other sessions again, from the
  // other connection, and the other tab sends its request again.
  await two.withBusiness(world.business, async (tx) => {
    await endOtherSeenSessions(tx, world.person, world.keep, 'end_others', world.subject);
  });
  const again = await one.withBusiness(
    world.business,
    async (tx) => await resolveLogin(tx, presented(world.subject, old, signedInAt)),
  );
  expect(again).toHaveProperty('code', 'AUTH_SESSION_EXPIRED');
  expect(await doorAndList(world, old, signedInAt)).toEqual(refusedAndUnlisted);
}

async function clockAhead() {
  const world = await signedIn('clock-ahead');
  await one.withBusiness(world.business, async (tx) => {
    await endOtherSeenSessions(tx, world.person, world.keep, 'end_others', world.subject);
  });
  // The ending committed 30 seconds ago.
  await db.admin.execute(
    `update ops.ended_subject_sessions set ended_before = ended_before - interval '30 seconds'
    where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [world.subject],
  );
  // Signed in now on a provider clock 31 seconds ahead, which the verifier
  // serves (up to a minute ahead): its stamp is past the ending's minute.
  const fresh = randomUUID();
  const signedInAt = now() + 31;
  const served = await two.withBusiness(
    world.business,
    async (tx) => await resolveLogin(tx, presented(world.subject, fresh, signedInAt)),
  );
  expect(served, 'the door serves the new sign-in').not.toHaveProperty('refused');
  expect(await doorAndList(world, fresh, signedInAt)).toEqual(servedAndListed);
}

describe.skipIf(!live)(
  'session list agrees with the door when an ending and a serving cross',
  () => {
    it(
      'a session served on another connection while the ending commits is refused after it and not listed',
      endingCrossesServing,
    );
    it(
      'an ending whose connection dies before its commit leaves the session served and listed',
      endingDies,
    );
    it(
      'a serving whose connection dies before its commit, beside an ending, is neither served nor listed',
      servingDies,
    );
    it(
      'an ending and a serving whose answers were lost and are asked again leave the session refused and unlisted',
      lostAnswers,
    );
    it(
      'a session the door serves after an ending, its provider clock ahead inside the minute, is listed',
      clockAhead,
    );
  },
);
