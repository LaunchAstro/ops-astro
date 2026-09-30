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
// delegation (the agent picked up an Alpha person's approved task). The world
// is tests/web/mp-3-1-isolation-world.tsx; the same crossings through a door
// and the history are tests/web/dock-door-isolation-api.test.tsx.

import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { tokenFor } from '../api/fixture.ts';
import {
  isolationWorld,
  memory,
  plant,
  quiet,
  readsOf,
  serverUrl,
  signedIn,
  type Heard,
} from './mp-3-1-isolation-world.tsx';

const w = isolationWorld('mp_3_1_isolation');
describe.skipIf(serverUrl === undefined)('MP-3-1 isolation', () => {
  it('draws the task for its own reader: the canary is detectable', async () => {
    const storage = memory();
    const session = {
      token: await tokenFor(w.clientOne.presented.subject),
      businessKey: 'alpha',
      email: 'one@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${w.taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(w, session, storage, heard);
    expect(page.find('[data-panel-id="todos"]')?.textContent).toContain(w.canary);
    expect(readsOf(w, heard).map((each) => each.status)).toContain(200);
  });

  it('another client in the same business: the tab restores nothing of the last reader', async () => {
    const storage = memory();
    plant(storage, 'alpha', 'one@example.test', `/task/${w.taskOne}`);
    const heard: Heard[] = [];
    const session = {
      token: await tokenFor(w.clientTwo.presented.subject),
      businessKey: 'alpha',
      email: 'two@example.test',
    };
    const page = await signedIn(w, session, storage, heard);
    expect(page.all('.dpanel')).toHaveLength(0);
    expect(readsOf(w, heard)).toEqual([]);
    expect(page.text()).not.toContain(w.canary);
  });

  it('another client in the same business: a row naming their task is refused by the server', async () => {
    const storage = memory();
    const session = {
      token: await tokenFor(w.clientTwo.presented.subject),
      businessKey: 'alpha',
      email: 'two@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${w.taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(w, session, storage, heard);
    const reads = readsOf(w, heard);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect([403, 404]).toContain(read.status);
    expect(page.text()).not.toContain(w.canary);
    expect(page.find('.dock__n')).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-3-1 isolation', () => {
  it('another business: nothing of Alpha is restored in Bravo, and a planted row is refused', async () => {
    const storage = memory();
    const token = await tokenFor(w.both.presented.subject);
    plant(storage, 'alpha', 'both@example.test', `/task/${w.taskOne}`);
    const heard: Heard[] = [];
    const bravo = { token, businessKey: 'bravo', email: 'both@example.test' };
    const page = await signedIn(w, bravo, storage, heard);
    expect(page.all('.dpanel')).toHaveLength(0);
    expect(readsOf(w, heard)).toEqual([]);

    const planted = memory();
    plant(planted, 'bravo', 'both@example.test', `/task/${w.taskOne}`);
    const heardThere: Heard[] = [];
    const there = await signedIn(w, bravo, planted, heardThere);
    const reads = readsOf(w, heardThere);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.path).toContain('/bravo/');
      expect([403, 404]).toContain(read.status);
    }
    expect(there.text()).not.toContain(w.canary);
  });

  it('another person under a live delegation: the agent reads none of it', async () => {
    const storage = memory();
    const session = {
      token: await tokenFor(w.fixture.agent.subject),
      businessKey: 'alpha',
      email: 'agent@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${w.taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(w, session, storage, heard);
    for (const read of readsOf(w, heard)) expect([401, 403, 404]).toContain(read.status);
    expect(heard.every((each) => each.status !== 200 || !each.body.includes(w.taskOne))).toBe(true);
    expect(page.text()).not.toContain(w.canary);
  });
});

// The platform writes an audit row for every command, reads included (T1i),
// so a panel drawing a screen adds that screen's reads, as the page would.
// What the dock itself does, a press, a close, Escape, Close all, adds no
// audit event and asks the server nothing.
describe.skipIf(serverUrl === undefined)('MP-3-1 isolation', () => {
  it('MP-3-1 no audit: the dock adds no audit event of its own', async () => {
    const events = async (): Promise<readonly Record<string, unknown>[]> =>
      await w.fixture.db.admin.execute<Record<string, unknown>>(
        'select id, command from public.audit_events',
        [],
      );
    const since = async (seen: ReadonlySet<unknown>) =>
      (await events()).filter((row) => !seen.has(row['id'])).map((row) => String(row['command']));
    const storage = memory();
    const session = {
      token: await tokenFor(w.clientOne.presented.subject),
      businessKey: 'alpha',
      email: 'one@example.test',
    };
    plant(storage, 'alpha', session.email, `/task/${w.taskOne}`);
    const heard: Heard[] = [];
    const page = await signedIn(w, session, storage, heard);

    // Opening a panel: only the reads of the screen it draws.
    let seen = new Set((await events()).map((row) => row['id']));
    await act(() => {
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
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await page.click('[data-panel-id="todos"] .dpanel__x');
    await quiet(heard);
    expect(page.all('.dpanel')).toHaveLength(0);
    expect(await since(seen)).toEqual([]);
    expect(heard.length).toBe(asked);
  });
});
