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
import {
  COMMAND_EFFECTS,
  COMMAND_SURFACE,
  pathOf,
  type CommandName,
} from '../../packages/core-wire/src/index.ts';
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

const NO_EFFECT = { writes: [], intake: [], outside: [], access: false };

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
// Closing a panel shrinks the tab's live follow: the stream reopens with the
// topics left and each resyncs (C4), so a screen still drawn reads again.
// Those are the app's own reads, each asked by the client and each with no
// effect. What the dock itself does adds no audit event and asks nothing:
// once the last panel is closed, Escape on the empty dock is silent.
const auditIds = async (): Promise<ReadonlySet<unknown>> =>
  new Set(
    (
      await w.fixture.db.admin.execute<Record<string, unknown>>(
        'select id from public.audit_events',
        [],
      )
    ).map((row) => row['id']),
  );

const auditedSince = async (seen: ReadonlySet<unknown>): Promise<readonly string[]> =>
  (
    await w.fixture.db.admin.execute<Record<string, unknown>>(
      'select id, command from public.audit_events',
      [],
    )
  )
    .filter((row) => !seen.has(row['id']))
    .map((row) => String(row['command']));

const escape = async (): Promise<void> =>
  await act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

const timesIn = (list: readonly string[], one: string): number =>
  list.filter((each) => each === one).length;

/** The command a client request named, by the catalogue's own path. */
const commandAt = (path: string) =>
  COMMAND_SURFACE.find((each) => path.endsWith(pathOf(each.name)));

/**
 * One step of the dock, both ways round. Every audit event it led to is a read
 * by the catalogue's own effects (task.execution is one whose name does not
 * end in .read: no write, intake, egress or access), asked by the client at
 * its path no fewer times than it was audited. Every request it led to is the
 * live stream reopening with the topics left, or such a read: audited in the
 * step, or one the surface declares unaudited (a person's own preferences,
 * CS-2.8).
 */
async function step(heard: readonly Heard[], doing: () => Promise<void>) {
  const seen = await auditIds();
  const asked = heard.length;
  await doing();
  await quiet(heard);
  const audited = await auditedSince(seen);
  const paths = heard.slice(asked).map((each) => each.path.split('?')[0] ?? '');
  const named = paths.map((path) => commandAt(path)?.name ?? path);
  for (const command of new Set(audited)) {
    expect([command, COMMAND_EFFECTS[command as CommandName]]).toEqual([command, NO_EFFECT]);
    const counts = [timesIn(audited, command), timesIn(named, command)];
    expect([command, counts[0]! <= counts[1]!], `${command} audited, asked: ${counts}`).toEqual([
      command,
      true,
    ]);
  }
  for (const path of paths) {
    if (path.endsWith('/live')) continue;
    const command = commandAt(path);
    expect([path, command !== undefined && COMMAND_EFFECTS[command.name]]).toEqual([
      path,
      NO_EFFECT,
    ]);
    expect([path, audited.includes(command!.name) || !command!.audited]).toEqual([path, true]);
  }
  return audited;
}

describe.skipIf(serverUrl === undefined)('MP-3-1 isolation', () => {
  it('MP-3-1 no audit: the dock adds no audit event of its own', async () => {
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
    const opened = await step(heard, async () => {
      await act(() => {
        (page.find('.dock__tab[data-panel="settings"]') as HTMLElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true, shiftKey: true }),
        );
      });
    });
    expect(opened.length).toBeGreaterThan(0);

    const settingsTab = async () => {
      await act(() => {
        (page.find('.dock__tab[data-panel="settings"]') as HTMLElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true, shiftKey: true }),
        );
      });
    };
    // Escape closes Settings; the to-dos panel still drawn may read again.
    await step(heard, escape);
    expect(page.all('.dpanel')).toHaveLength(1);
    // Its X closes Settings again once reopened, and Close all the last panel.
    await step(heard, settingsTab);
    await step(heard, async () => await page.click('[data-panel-id="settings"] .dpanel__x'));
    expect(page.all('.dpanel')).toHaveLength(1);
    await step(heard, async () => await page.click('.dock__closeall'));
    expect(page.all('.dpanel')).toHaveLength(0);

    // The dock on its own, nothing left to close: nothing audited, nothing asked.
    const seen = await auditIds();
    const asked = heard.length;
    await escape();
    await quiet(heard);
    expect(await auditedSince(seen)).toEqual([]);
    expect(heard.length).toBe(asked);
  });
});
