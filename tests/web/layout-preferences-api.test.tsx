// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-2-3, MP-3-2 and MP-3-3: the rail, the dock width and the sheet height are
// keys of MP-2-11's one preference store, through the application against the
// real boundary and a fresh Postgres.
//
// Ada lets go of the rail's grip, folds it, lets go of the dock's grip and of
// the sheet's: each is one `preference.save` of her own row, and her next tab
// draws them. Then the crossings, statuses checked: Ben, another person in the
// same business, signed in to a tab of his own; Bruno, a person in another
// business; and an agent under a live delegation. None of them reads or
// writes Ada's row, and none of Ada's values, nor her stored canary, reaches
// their answers or their page. A save and a read of these keys add no audit
// event (CS-2.2, CS-3.2, CS-3.5).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { tokenFor } from '../api/fixture.ts';
import {
  ada,
  adaToken,
  auditCount,
  ben,
  benToken,
  c,
  call,
  CANARY,
  expectNoCanary,
  fixture,
  read,
  rowsOf,
  save,
  usePreferencesWorld,
} from '../api/preferences-world.ts';
import { memory, quiet, signedIn, type Heard, type World } from './mp-3-1-isolation-world.tsx';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Mounted } from '../surfaces/mount.tsx';

const serverUrl = databaseUrlFromEnvironment();

/** Ada's values: numbers nobody else's page or answer may carry. */
const ADA = {
  'rail.width': 377,
  'rail.collapsed': true,
  'dock.width': 613,
  'dock.sheetHeight': 333,
};

const LEGS = [
  { ticket: 'MP-2-3', key: 'rail.width', mine: 211 },
  { ticket: 'MP-3-2', key: 'dock.width', mine: 402 },
  { ticket: 'MP-3-3', key: 'dock.sheetHeight', mine: 244 },
] as const;

const grip = (page: Mounted, selector: string): HTMLElement => {
  const found = page.all(selector)[0] as HTMLElement;
  found.setPointerCapture = () => {};
  return found;
};

async function dragTo(handle: HTMLElement, axis: 'x' | 'y', from: number, to: number) {
  const at = (type: string, point: number): Event =>
    Object.assign(
      new MouseEvent(type, {
        bubbles: true,
        ...(axis === 'x' ? { clientX: point } : { clientY: point }),
      }),
      { pointerId: 1 },
    );
  await act(() => {
    handle.dispatchEvent(at('pointerdown', from));
    handle.dispatchEvent(at('pointermove', (from + to) / 2));
    handle.dispatchEvent(at('pointerup', to));
  });
}

/** The application signed in as `token`'s person on a tab of its own, at `width`. */
async function tabOf(token: string, email: string, width: number, heard: Heard[]) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const world = { api: c.api } as World;
  return await signedIn(world, { token, businessKey: 'alpha', email }, memory(), heard);
}

async function openTodos(page: Mounted, heard: Heard[]): Promise<void> {
  const tab = page.find('.dock__tab[data-panel="todos"]');
  if (tab?.getAttribute('aria-expanded') === 'true') return;
  await act(() => {
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await quiet(heard);
}

/** The agent's live delegation: an Alpha task approved and picked up, once per file. */
let delegation: Promise<string> | undefined;
const agentCredential = async (): Promise<string> => {
  delegation ??= (async () => {
    const task = await c.createTask("an agent holds this while the layout is Ada's");
    const reservation = await c.approve(await c.propose(task.id, task.revision, 'layout_probe'));
    return String((await c.pickup(reservation))['credential']);
  })();
  return await delegation;
};

const statusesOf = (heard: readonly Heard[], path: string): readonly number[] =>
  heard.filter((each) => each.path.endsWith(path)).map((each) => each.status);

/** Nothing of Ada's shows: her stored canary, and her layout as a width, a grip value or a key. */
function expectNoneOfAdas(text: string): void {
  expect(text).not.toContain(CANARY);
  for (const value of [377, 613, 333]) {
    for (const form of [`${String(value)}px`, `="${String(value)}"`, `:${String(value)}`]) {
      expect(text).not.toContain(form);
    }
  }
}

const rowsAsRecord = async (personId: string): Promise<Record<string, unknown>> =>
  Object.fromEntries((await rowsOf(personId)).map((row) => [row.key, row.value]));

const auditsOf = async (actorId: string, command: string): Promise<number> =>
  await c.count(`select count(*) from public.audit_events where actor_id = $1 and command = $2`, [
    actorId,
    command,
  ]);

async function roundTrip(): Promise<void> {
  const heard: Heard[] = [];
  const wide = await tabOf(adaToken, 'ada@example.test', 1480, heard);
  await dragTo(grip(wide, '.railgrip'), 'x', 224, 377);
  await wide.click('.railfold');
  await openTodos(wide, heard);
  await dragTo(grip(wide, '.dpanel__grip'), 'x', 900, 837);
  await quiet(heard);
  await wide.unmount();
  const sheet = await tabOf(adaToken, 'ada@example.test', 1100, heard);
  await openTodos(sheet, heard);
  await dragTo(grip(sheet, '.dpanel__grip'), 'y', 700, 827);
  await quiet(heard);
  await sheet.unmount();

  // Four saves, one per release or fold, each applied.
  expect(statusesOf(heard, '/preference/save')).toEqual([200, 200, 200, 200]);
  expect(await rowsAsRecord(ada.personId)).toStrictEqual({
    ...ADA,
    'columns.widths': { [CANARY]: 111 },
  });

  // A tab of her own, on another device: the store's answer draws her layout.
  const next = await tabOf(adaToken, 'ada@example.test', 1480, []);
  expect((next.find('.shell') as HTMLElement).dataset['rail']).toBe('collapsed');
  await openTodos(next, []);
  expect(next.find('.dpanel__grip')?.getAttribute('aria-valuenow')).toBe('613');
  await next.unmount();
}

async function benThroughTheApplication(): Promise<void> {
  const heard: Heard[] = [];
  const page = await tabOf(benToken, 'ben@example.test', 1480, heard);
  await openTodos(page, heard);
  expect(statusesOf(heard, '/preference/read').length).toBeGreaterThan(0);
  expect(statusesOf(heard, '/preference/read').every((status) => status === 200)).toBe(true);
  expect((page.find('.shell') as HTMLElement).dataset['rail']).toBe('expanded');
  expect(page.find('.dpanel__grip')?.getAttribute('aria-valuenow')).toBe('550');
  expectNoneOfAdas(document.body.innerHTML);
  await dragTo(grip(page, '.railgrip'), 'x', 224, 260);
  await quiet(heard);
  await page.unmount();
  expect(await rowsOf(ben.personId)).toStrictEqual([{ key: 'rail.width', value: 260 }]);
  expect(await rowsAsRecord(ada.personId)).toMatchObject(ADA);
}

type Leg = (typeof LEGS)[number];

/** Bruno, another business: refused under Alpha's address both ways; his own business's row is his. */
async function brunoCrossing(leg: Leg): Promise<void> {
  const bravo = `bravo${leg.ticket.replaceAll('-', '').toLowerCase()}`;
  const bravoId = await insertBusiness(fixture.db.app, bravo);
  await installSpine(fixture.db.app, bravoId);
  const bruno = await enrol(fixture.db.app, bravoId, 'Bruno Layout');
  await fixture.db.app.withBusiness(bravoId, async (tx) => await grantTo(tx, bruno, 'read'));
  const brunoToken = await tokenFor(bruno.presented.subject);
  for (const answer of [
    await save(leg.key, leg.mine, brunoToken),
    await call('preference.read', {}, brunoToken),
  ]) {
    expect(answer.status).toBe(403);
    expectNoCanary(answer);
    expectNoneOfAdas(JSON.stringify(answer.body));
  }
  const own = await call(
    'preference.save',
    { operationId: randomUUID(), preference: leg.key, value: leg.mine },
    brunoToken,
    { key: bravo },
  );
  expect(own.status).toBe(200);
  expect(await read(brunoToken, bravo)).toStrictEqual({ [leg.key]: leg.mine });
}

/** An agent under a live delegation: neither reads nor saves, not even its principal's row. */
async function agentCrossing(leg: Leg): Promise<void> {
  const credential = await agentCredential();
  const principal = await rowsOf(c.manager.personId);
  for (const answer of [
    await c.asAgent(
      'preference.save',
      { operationId: randomUUID(), preference: leg.key, value: leg.mine },
      credential,
    ),
    await c.asAgent('preference.read', {}, credential),
  ]) {
    expect(answer.status).toBe(403);
    expect(answer.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
    expectNoCanary(answer);
    expectNoneOfAdas(JSON.stringify(answer.body));
  }
  expect(await rowsOf(c.manager.personId)).toStrictEqual(principal);
}

async function ownOnly(leg: Leg): Promise<void> {
  const before = await rowsOf(ada.personId);
  // Ben, the same business, naming Ada: refused, nothing written.
  const aimed = await save(leg.key, leg.mine, benToken, { personId: ada.personId });
  expect(aimed.status).toBe(422);
  expectNoCanary(aimed);
  await brunoCrossing(leg);
  await agentCrossing(leg);
  expect(await rowsOf(ada.personId)).toStrictEqual(before);
}

async function noAudit(leg: Leg): Promise<void> {
  const saves = await auditCount(ada.actorId);
  const reads = await auditsOf(ada.actorId, 'preference.read');
  expect((await save(leg.key, leg.mine, adaToken)).status).toBe(200);
  expect((await read(adaToken))[leg.key]).toBe(leg.mine);
  expect(await auditCount(ada.actorId)).toBe(saves);
  expect(await auditsOf(ada.actorId, 'preference.read')).toBe(reads);
}

async function collapsedTakesABoolean(): Promise<void> {
  const before = await rowsOf(ben.personId);
  for (const value of ['true', 1, null, { collapsed: true }]) {
    // eslint-disable-next-line no-await-in-loop -- each refusal is its own operation
    const refused = await save('rail.collapsed', value, benToken);
    expect(refused.status, JSON.stringify(value)).toBe(422);
  }
  expect(await rowsOf(ben.personId)).toStrictEqual(before);
}

describe.skipIf(serverUrl === undefined)('the layout in the one preference store', () => {
  usePreferencesWorld('layoutpref');
  it(
    "MP-2-3, MP-3-2 and MP-3-3 round trip: what Ada's application lets go is her own row, and her next tab draws it",
    roundTrip,
  );
  it(
    "MP-2-3, MP-3-2 and MP-3-3 own preference only through the application: Ben's tab draws his defaults and saves his own row",
    benThroughTheApplication,
  );
  for (const leg of LEGS) {
    it(`${leg.ticket} own preference only: a write to another person row is refused, and no other business or agent reads or writes it`, async () => {
      await ownOnly(leg);
    });
    it(`${leg.ticket} no audit: a preference save and read add no audit event`, async () => {
      await noAudit(leg);
    });
  }
  it('MP-2-3 rail.collapsed takes true or false and nothing else', collapsedTakesABoolean);
});
