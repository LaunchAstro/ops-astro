// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-1 isolation and MP-3-1 no audit, through the application against the
// real boundary and a fresh Postgres.
//
// The dock reads nothing itself: each open panel draws the screen of the view
// it is on, through the signed-in person's own client. What it keeps is the
// tab's copy of the open set and each panel's place, and that copy is the thing
// that could carry one person's view to another. So each crossing plants a
// dock row that names a task another reader may not see, signs the other
// reader into the same tab, and checks that the task's canary title, id and
// count never reach the document, and that every read the dock caused was
// refused by the server, statuses checked.
//
// The crossings: another business (a person holding grants in both, signed
// into Bravo); another client in the same business (two people, each holding a
// read grant on one task alone); and another person's reach under a live
// delegation (the agent picked up an Alpha person's approved task).

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import type { Hono } from 'hono';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import {
  SessionStore,
  dockKey,
  type Session,
  type StorageLike,
} from '../../apps/web/src/session/token.ts';
import { tokenFor, type ApiFixture } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const serverUrl = databaseUrlFromEnvironment();

const REGISTRY: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: { label: 'Settings', ariaLabel: 'Business settings', route: 'agency:settings' },
};

interface Heard {
  readonly path: string;
  readonly body: string;
  readonly status: number;
}

function memory(): StorageLike {
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

const plant = (storage: StorageLike, businessKey: string, who: string, place: string): void => {
  storage.setItem(
    dockKey(businessKey),
    JSON.stringify({ who, open: ['todos'], places: { todos: place } }),
  );
};

describe.skipIf(serverUrl === undefined)('MP-3-1 isolation', () => {
  let controls: Controls;
  let fixture: ApiFixture;
  let api: Hono;
  let clientOne: Member;
  let clientTwo: Member;
  let both: Member;
  let revoked: Member;
  let revokedGrant = '';
  let taskOne = '';
  const canary = `CANARY-${randomUUID()}`;
  const live: Mounted[] = [];

  beforeAll(async () => {
    controls = await createControls('mp_3_1_isolation');
    ({ fixture, api } = controls);
    taskOne = (await controls.createTask(`${canary} client one`)).id;
    const taskTwo = (await controls.createTask('made-up client two task')).id;
    // A live delegation: an Alpha person approves a task and the agent picks it up.
    const delegated = await controls.createTask('made-up delegated task');
    const reservation = await controls.approve(
      await controls.propose(delegated.id, delegated.revision),
    );
    expect(typeof (await controls.pickup(reservation))['credential']).toBe('string');

    clientOne = await enrol(fixture.db.app, fixture.business, 'client-one');
    clientTwo = await enrol(fixture.db.app, fixture.business, 'client-two');
    both = await enrol(fixture.db.app, fixture.business, 'both');
    revoked = await enrol(fixture.db.app, fixture.business, 'revoked');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, clientOne, 'read', { kind: 'record', id: taskOne });
      await grantTo(tx, clientTwo, 'read', { kind: 'record', id: taskTwo });
      await grantTo(tx, both, 'read', { kind: 'record', id: taskOne });
      revokedGrant = await grantTo(tx, revoked, 'read', { kind: 'record', id: taskOne });
    });
    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await installSpine(fixture.db.app, bravo);
    await fixture.db.app.withBusiness(bravo, async (tx) => {
      const there = await enrolIn(tx, both);
      await grantTo(tx, there, 'read');
    });
  }, 120_000);

  afterEach(async () => {
    for (const page of live.splice(0)) {
      // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
      await page.unmount();
    }
  });
  afterAll(async () => await controls?.drop());

  async function signedIn(session: Session, storage: StorageLike, heard: Heard[]) {
    storage.setItem('ops-astro.session', JSON.stringify(session));
    const through = (async (url: string | URL, init?: RequestInit) => {
      inFlight.add(heard);
      const response = await api.fetch(new Request(`http://api.test${String(url)}`, init));
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
        navigate={() => undefined}
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

  const readsOf = (heard: readonly Heard[]): readonly Heard[] =>
    heard.filter((each) => each.body.includes(taskOne));

  it('draws the task for its own reader: the canary is detectable', async () => {
    const storage = memory();
    const session = {
      token: await tokenFor(clientOne.presented.subject),
      businessKey: 'alpha',
      email: 'one@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(session, storage, heard);
    expect(page.find('[data-panel-id="todos"]')?.textContent).toContain(canary);
    expect(readsOf(heard).map((each) => each.status)).toContain(200);
  });

  it('another client in the same business: the tab restores nothing of the last reader', async () => {
    const storage = memory();
    plant(storage, 'alpha', 'one@example.test', `/task/${taskOne}`);
    const heard: Heard[] = [];
    const session = {
      token: await tokenFor(clientTwo.presented.subject),
      businessKey: 'alpha',
      email: 'two@example.test',
    };
    const page = await signedIn(session, storage, heard);
    expect(page.all('.dpanel')).toHaveLength(0);
    expect(readsOf(heard)).toEqual([]);
    expect(page.text()).not.toContain(canary);
  });

  it('another client in the same business: a row naming their task is refused by the server', async () => {
    const storage = memory();
    const session = {
      token: await tokenFor(clientTwo.presented.subject),
      businessKey: 'alpha',
      email: 'two@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(session, storage, heard);
    const reads = readsOf(heard);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect([403, 404]).toContain(read.status);
    expect(page.text()).not.toContain(canary);
    expect(page.find('.dock__n')).toBeNull();
  });

  it('another business: nothing of Alpha is restored in Bravo, and a planted row is refused', async () => {
    const storage = memory();
    const token = await tokenFor(both.presented.subject);
    plant(storage, 'alpha', 'both@example.test', `/task/${taskOne}`);
    const heard: Heard[] = [];
    const bravo = { token, businessKey: 'bravo', email: 'both@example.test' };
    const page = await signedIn(bravo, storage, heard);
    expect(page.all('.dpanel')).toHaveLength(0);
    expect(readsOf(heard)).toEqual([]);

    const planted = memory();
    plant(planted, 'bravo', 'both@example.test', `/task/${taskOne}`);
    const heardThere: Heard[] = [];
    const there = await signedIn(bravo, planted, heardThere);
    const reads = readsOf(heardThere);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.path).toContain('/bravo/');
      expect([403, 404]).toContain(read.status);
    }
    expect(there.text()).not.toContain(canary);
  });

  it('another person under a live delegation: the agent reads none of it', async () => {
    const storage = memory();
    const session = {
      token: await tokenFor(fixture.agent.subject),
      businessKey: 'alpha',
      email: 'agent@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(session, storage, heard);
    for (const read of readsOf(heard)) expect([401, 403, 404]).toContain(read.status);
    expect(heard.every((each) => each.status !== 200 || !each.body.includes(taskOne))).toBe(true);
    expect(page.text()).not.toContain(canary);
  });

  // The platform writes an audit row for every command, reads included (T1i),
  // so a panel drawing a screen adds that screen's reads, as the page would.
  // What the dock itself does, a press, a close, Escape, Close all, adds no
  // audit event and asks the server nothing.
  // MP-3-4 isolation: the same crossings through a programmatic door, a row
  // or badge naming the view it opens. The door is followed; what it names is
  // read under the clicker's own session, and the server refuses it.
  async function throughDoor(
    session: Session,
  ): Promise<{ page: Mounted; reads: readonly Heard[]; heard: readonly Heard[] }> {
    const heard: Heard[] = [];
    const page = await signedIn(session, memory(), heard);
    const door = document.createElement('button');
    door.setAttribute('data-dock-open', 'todos');
    door.setAttribute('data-dock-place', `/task/${taskOne}`);
    (page.find('.content') as HTMLElement).append(door);
    await act(async () => {
      door.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await quiet(heard);
    return { page, reads: readsOf(heard), heard };
  }

  it('MP-3-4 isolation: its own reader follows the door to the canary', async () => {
    const { page, reads } = await throughDoor({
      token: await tokenFor(clientOne.presented.subject),
      businessKey: 'alpha',
      email: 'one@example.test',
    });
    expect(page.find('[data-panel-id="todos"]')?.textContent).toContain(canary);
    expect(reads.map((each) => each.status)).toContain(200);
  });

  it('MP-3-4 isolation: another client, another business and a delegated agent are refused', async () => {
    const sessions: readonly Session[] = [
      {
        token: await tokenFor(clientTwo.presented.subject),
        businessKey: 'alpha',
        email: 'two@example.test',
      },
      {
        token: await tokenFor(both.presented.subject),
        businessKey: 'bravo',
        email: 'both@example.test',
      },
      {
        token: await tokenFor(fixture.agent.subject),
        businessKey: 'alpha',
        email: 'agent@example.test',
      },
    ];
    for (const session of sessions) {
      // eslint-disable-next-line no-await-in-loop -- one mounted application at a time
      const { page, reads, heard } = await throughDoor(session);
      // A person route that does not know the caller ends the session before
      // the door can open anything; otherwise the door opened and was refused.
      if (heard.some((each) => each.status === 401)) {
        expect(page.all('.dpanel'), session.email).toHaveLength(0);
      } else {
        expect(page.all('.dpanel').length, session.email).toBe(1);
        expect(reads.length, session.email).toBeGreaterThan(0);
      }
      for (const read of reads) expect([401, 403, 404], session.email).toContain(read.status);
      expect(page.text(), session.email).not.toContain(canary);
    }
  });

  // MP-3-5 isolation: the dock's history never reopens a record the person
  // can no longer read. A walk back puts the panel on the task again, and the
  // panel reads it again under the session in hand, which the server refuses
  // once the grant is gone. (Another business or person starts a history of
  // its own: tests/web/dock-history-app.test.tsx.)
  it('MP-3-5 isolation: back to a task whose grant was revoked is refused', async () => {
    const storage = memory();
    const session = {
      token: await tokenFor(revoked.presented.subject),
      businessKey: 'alpha',
      email: 'revoked@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(session, storage, heard);
    expect(page.find('[data-panel-id="todos"]')?.textContent).toContain(canary);
    expect(readsOf(heard).map((each) => each.status)).toContain(200);

    const link = document.createElement('a');
    link.setAttribute('href', '/projects/');
    (page.find('[data-panel-id="todos"] .dpanel__body') as HTMLElement).append(link);
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await quiet(heard);
    expect(page.text()).not.toContain(canary);

    const revoke = await controls.asPerson('grant.revoke', { grantId: revokedGrant });
    expect(revoke.status).toBe(200);
    const asked = heard.length;
    await page.click('[data-panel-id="todos"] [data-act="back"]');
    await quiet(heard);
    const again = readsOf(heard.slice(asked));
    expect(again.length).toBeGreaterThan(0);
    for (const read of again) expect([403, 404]).toContain(read.status);
    expect(page.text()).not.toContain(canary);
  });

  it('MP-3-1 no audit: the dock adds no audit event of its own', async () => {
    const events = async (): Promise<readonly Record<string, unknown>[]> =>
      await fixture.db.admin.execute<Record<string, unknown>>(
        'select id, command from public.audit_events',
        [],
      );
    const since = async (seen: ReadonlySet<unknown>) =>
      (await events()).filter((row) => !seen.has(row['id'])).map((row) => String(row['command']));
    const storage = memory();
    const session = {
      token: await tokenFor(clientOne.presented.subject),
      businessKey: 'alpha',
      email: 'one@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(session, storage, heard);

    // Opening a panel: only the reads of the screen it draws.
    let seen = new Set((await events()).map((row) => row['id']));
    await act(async () => {
      (page.find('.dock__tab[data-panel="settings"]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, shiftKey: true }),
      );
    });
    await quiet(heard);
    const opened = await since(seen);
    expect(opened.length).toBeGreaterThan(0);
    for (const command of opened)
      expect(command).toMatch(/^(?:[a-z]+\.read|session\.capabilities)$/u);

    // Everything the dock does on its own: nothing audited, nothing asked.
    seen = new Set((await events()).map((row) => row['id']));
    const asked = heard.length;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.click('[data-panel-id="todos"] .dpanel__x');
    await quiet(heard);
    expect(page.all('.dpanel')).toHaveLength(0);
    expect(await since(seen)).toEqual([]);
    expect(heard.length).toBe(asked);
  });
});

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
async function quiet(heard: readonly Heard[]): Promise<void> {
  let still = 0;
  let last = -1;
  while (still < 10) {
    // eslint-disable-next-line no-await-in-loop -- each round waits for the last
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
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
