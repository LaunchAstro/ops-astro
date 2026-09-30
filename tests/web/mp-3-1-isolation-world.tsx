// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the dock's isolation suites cross, through the application against
// the real boundary and a fresh Postgres: Alpha with two people each holding a
// read grant on one task alone (the canary's and another), a person holding
// grants in Alpha and Bravo, a person whose grant is revoked mid-test, and the
// agent under a live delegation (an Alpha person's approved task picked up).
//
// Each crossing plants a dock row naming the canary task, signs a reader into
// the same tab, and hears every request the page and its panels send with its
// status, so a suite can check what the server refused.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { act } from 'react';
import type { Hono } from 'hono';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore, dockKey, type StorageLike } from '../../apps/web/src/session/token.ts';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import type { ApiFixture } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

export const serverUrl = databaseUrlFromEnvironment();

const REGISTRY: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: { label: 'Settings', ariaLabel: 'Business settings', route: 'agency:settings' },
};

export interface Heard {
  readonly path: string;
  readonly body: string;
  readonly status: number;
}

export function memory(): StorageLike {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

export const plant = (
  storage: StorageLike,
  businessKey: string,
  who: string,
  place: string,
): void => {
  storage.setItem(
    dockKey(businessKey),
    JSON.stringify({ who, open: ['todos'], places: { todos: place } }),
  );
};

/** The people and records a suite crosses between, set once its database is up. */
export interface World {
  readonly canary: string;
  controls: Controls;
  fixture: ApiFixture;
  api: Hono;
  clientOne: Member;
  clientTwo: Member;
  both: Member;
  revoked: Member;
  revokedGrant: string;
  taskOne: string;
}

const live: Mounted[] = [];

/**
 * Builds the world in its own database before the file's tests and drops it
 * after; registered only where a database is configured.
 */
export function isolationWorld(name: string): World {
  const w = { canary: `CANARY-${randomUUID()}` } as World;
  if (serverUrl === undefined) return w;
  beforeAll(async () => {
    await build(w, name);
  }, 120_000);
  afterEach(async () => {
    for (const page of live.splice(0)) {
      // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
      await page.unmount();
    }
  });
  afterAll(async () => await w.controls?.drop());
  return w;
}

async function build(w: World, name: string): Promise<void> {
  w.controls = await createControls(name);
  ({ fixture: w.fixture, api: w.api } = w.controls);
  w.taskOne = (await w.controls.createTask(`${w.canary} client one`)).id;
  const taskTwo = (await w.controls.createTask('made-up client two task')).id;
  // A live delegation: an Alpha person approves a task and the agent picks it up.
  const delegated = await w.controls.createTask('made-up delegated task');
  const reservation = await w.controls.approve(
    await w.controls.propose(delegated.id, delegated.revision),
  );
  expect(typeof (await w.controls.pickup(reservation))['credential']).toBe('string');

  w.clientOne = await enrol(w.fixture.db.app, w.fixture.business, 'client-one');
  w.clientTwo = await enrol(w.fixture.db.app, w.fixture.business, 'client-two');
  w.both = await enrol(w.fixture.db.app, w.fixture.business, 'both');
  w.revoked = await enrol(w.fixture.db.app, w.fixture.business, 'revoked');
  await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
    await grantTo(tx, w.clientOne, 'read', { kind: 'record', id: w.taskOne });
    await grantTo(tx, w.clientTwo, 'read', { kind: 'record', id: taskTwo });
    await grantTo(tx, w.both, 'read', { kind: 'record', id: w.taskOne });
    w.revokedGrant = await grantTo(tx, w.revoked, 'read', { kind: 'record', id: w.taskOne });
  });
  const bravo = await insertBusiness(w.fixture.db.app, 'bravo');
  await installSpine(w.fixture.db.app, bravo);
  await w.fixture.db.app.withBusiness(bravo, async (tx) => {
    const there = await enrolIn(tx, w.both);
    await grantTo(tx, there, 'read');
  });
}

/** A reader as a suite signs them in: the sign-in the browser's cookie carries. */
export interface Reader {
  readonly token: string;
  readonly businessKey: string;
  readonly email: string;
}

/** Signs a reader into the tab holding `storage` and waits until every read is answered and drawn. */
export async function signedIn(
  w: World,
  reader: Reader,
  storage: StorageLike,
  heard: Heard[],
): Promise<Mounted> {
  const sessionId = sessionIdOf(reader.token);
  storage.setItem(
    'ops-astro.session',
    JSON.stringify({ sessionId, businessKey: reader.businessKey, email: reader.email }),
  );
  // The tab holds only the sign-in's id; the browser adds its cookie and nothing else.
  const through = (async (url: string | URL, init?: RequestInit) => {
    inFlight.add(heard);
    const headers = new Headers(init?.headers);
    headers.set('cookie', `${cookieNameFor(sessionId)}=${reader.token}`);
    const response = await w.api.fetch(
      new Request(`http://api.test${String(url)}`, { ...init, headers }),
    );
    inFlight.delete(heard);
    heard.push({
      path: String(url),
      body: typeof init?.body === 'string' ? init.body : '',
      status: response.status,
    });
    return response;
  }) as typeof fetch;
  const page = await mount(
    <App
      path="/settings"
      navigate={() => {}}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={through}
      storage={storage as Storage}
      panels={REGISTRY}
    />,
  );
  live.push(page);
  // Every read the page and its panels start is answered and drawn.
  await quiet(heard);
  return page;
}

/** The requests that named the canary task. */
export const readsOf = (w: World, heard: readonly Heard[]): readonly Heard[] =>
  heard.filter((each) => each.body.includes(w.taskOne));

/**
 * Signs a session in and follows a programmatic door, a row or badge naming
 * the canary task, as the person would click it.
 */
export async function throughDoor(
  w: World,
  reader: Reader,
): Promise<{ page: Mounted; reads: readonly Heard[]; heard: readonly Heard[] }> {
  const heard: Heard[] = [];
  const page = await signedIn(w, reader, memory(), heard);
  const door = document.createElement('button');
  door.dataset['dockOpen'] = 'todos';
  door.dataset['dockPlace'] = `/task/${w.taskOne}`;
  (page.find('.content') as HTMLElement).append(door);
  await act(() => {
    door.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await quiet(heard);
  return { page, reads: readsOf(w, heard), heard };
}

/** How many requests each page has sent and not yet had answered, keyed by its log. */
const pending = new Map<readonly Heard[], number>();
const inFlight = {
  add: (heard: readonly Heard[]): void => {
    pending.set(heard, (pending.get(heard) ?? 0) + 1);
  },
  delete: (heard: readonly Heard[]): void => {
    pending.set(heard, (pending.get(heard) ?? 1) - 1);
  },
};

/**
 * Waits until nothing is in flight and nothing new has been asked for ten
 * rounds: every read answered and drawn, however slow the machine is.
 */
export async function quiet(heard: readonly Heard[]): Promise<void> {
  let still = 0;
  let last = -1;
  while (still < 10) {
    // eslint-disable-next-line no-await-in-loop -- each round waits for the last
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    });
    const settled = (pending.get(heard) ?? 0) === 0 && heard.length === last;
    still = settled ? still + 1 : 0;
    last = heard.length;
  }
}

/** The same person enrolled in another business: a person, actor, membership and mapped login there. */
async function enrolIn(
  tx: Parameters<Parameters<ApiFixture['db']['app']['withBusiness']>[1]>[0],
  member: Member,
): Promise<Member> {
  const { insertActor, insertLogin, insertMapping, insertMembership, insertPerson } =
    await import('../identity/fixture.ts');
  const personId = await insertPerson(tx, 'both-bravo');
  const actorId = await insertActor(tx, personId);
  await insertMembership(tx, personId);
  const loginId = await insertLogin(tx, member.presented.subject);
  await insertMapping(tx, loginId, personId, actorId);
  return { personId, actorId, presented: member.presented };
}
