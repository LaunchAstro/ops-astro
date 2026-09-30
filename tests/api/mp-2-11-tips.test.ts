// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11: guided tips in the one preference store. `preference.dismiss_tip`
// merges one dismissal, keyed by page, tip id and text version, into the
// caller's `tips.dismissed` in a single statement, so a dismissal made on one
// device is never lost to one made at the same moment on another. Tips on or
// off is `tips.enabled`, and the reset is a save of `tips.dismissed` as `{}`:
// the only value a save may give it. A rewritten tip (a new text version) is
// shown again. Everything here is the caller's own row and is not audited.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { dismissedTipCount, tipKey, tipShown } from '../../packages/core-wire/src/tips.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { tokenFor, type Answer } from './fixture.ts';
import {
  ada,
  adaToken,
  auditCount,
  ben,
  benToken,
  c,
  call,
  expectNoCanary,
  fixture,
  read,
  rowsOf,
  save,
  usePreferencesWorld,
} from './preferences-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const BOARD = { page: 'agency:projects-board', tip: 'board-rank' } as const;

const dismiss = async (
  tip: Readonly<Record<string, unknown>>,
  token: string,
  options: { readonly key?: string } = {},
): Promise<Answer> =>
  await call('preference.dismiss_tip', { operationId: randomUUID(), ...tip }, token, options);

const dismissals = async (actorId: string): Promise<number> => {
  const [row] = await fixture.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.audit_events
      where actor_id = $1 and command = 'preference.dismiss_tip'`,
    [actorId],
  );
  return Number(row?.n);
};

const dismissedOf = async (token: string): Promise<unknown> =>
  (await read(token))['tips.dismissed'];

describe.skipIf(serverUrl === undefined)('MP-2-11 tips in the one preference store', () => {
  usePreferencesWorld('mp211tips');
  tipStore();
  twoAtOnce();
  tipsOffAndReset();
  perPerson();
  refusals();
  audits();
});

function tipStore(): void {
  it('MP-2-11 tip store: a dismissal keyed by page, tip and version holds on a second device; a rewritten tip shows again', async () => {
    const dismissed = await dismiss({ ...BOARD, version: 2 }, adaToken);
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);

    // A second sign-in of the same person is the second device.
    const laptop = await tokenFor(ada.presented.subject);
    const seen = await read(laptop);
    expect(seen['tips.dismissed']).toStrictEqual({ [tipKey(BOARD.page, BOARD.tip)]: 2 });
    expect(tipShown(seen, { ...BOARD, version: 2 })).toBe(false);
    expect(tipShown(seen, { ...BOARD, version: 3 })).toBe(true);
    expect(tipShown(seen, { ...BOARD, tip: 'board-filter', version: 2 })).toBe(true);
    expect(dismissedTipCount(seen)).toBe(1);

    // Dismissing the rewritten text replaces the version: still one entry.
    expect((await dismiss({ ...BOARD, version: 3 }, laptop)).status).toBe(200);
    expect(await dismissedOf(adaToken)).toStrictEqual({ [tipKey(BOARD.page, BOARD.tip)]: 3 });
  });
}

function twoAtOnce(): void {
  it('MP-2-11 tip store: dismissals made at once on two devices all hold', async () => {
    const phone = await tokenFor(ben.presented.subject);
    const tips = Array.from({ length: 8 }, (_, index) => `tip-${String(index)}`);
    const answers = await Promise.all(
      tips.map(
        async (tip, index) =>
          await dismiss({ page: 'agency:inbox', tip, version: 1 }, index % 2 ? phone : benToken),
      ),
    );
    expect(answers.map((answer) => answer.status)).toStrictEqual(tips.map(() => 200));
    const held = (await dismissedOf(benToken)) as Record<string, unknown>;
    expect(Object.keys(held).toSorted()).toStrictEqual(
      tips.map((tip) => tipKey('agency:inbox', tip)).toSorted(),
    );

    // The same tip dismissed twice at once is one entry.
    const twice = await Promise.all([
      dismiss({ page: 'agency:inbox', tip: 'tip-0', version: 2 }, benToken),
      dismiss({ page: 'agency:inbox', tip: 'tip-0', version: 2 }, phone),
    ]);
    expect(twice.map((answer) => answer.status)).toStrictEqual([200, 200]);
    const after = (await dismissedOf(benToken)) as Record<string, unknown>;
    expect(Object.keys(after)).toHaveLength(8);
    expect(after[tipKey('agency:inbox', 'tip-0')]).toBe(2);
  });
}

function tipsOffAndReset(): void {
  it('MP-2-11 tips off: tips.enabled false hides every tip, dismissed or not', async () => {
    expect((await save('tips.enabled', false, adaToken)).status).toBe(200);
    const seen = await read(adaToken);
    expect(seen['tips.enabled']).toBe(false);
    expect(tipShown(seen, { ...BOARD, version: 9 })).toBe(false);
    expect(tipShown(seen, { page: 'agency:inbox', tip: 'never-dismissed', version: 1 })).toBe(
      false,
    );
    for (const value of ['off', 0, null, { on: false }]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await save('tips.enabled', value, adaToken)).status, String(value)).not.toBe(200);
    }
    expect((await save('tips.enabled', true, adaToken)).status).toBe(200);
    expect(tipShown(await read(adaToken), { ...BOARD, version: 9 })).toBe(true);
  });

  it('MP-2-11 tip reset: saving tips.dismissed as {} brings every tip back; no other value is taken', async () => {
    expect(dismissedTipCount(await read(adaToken))).toBeGreaterThan(0);
    const before = await rowsOf(ada.personId);
    for (const value of [{ [tipKey(BOARD.page, BOARD.tip)]: 1 }, [], 'none', null]) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await save('tips.dismissed', value, adaToken);
      expect(refused.status, JSON.stringify(value)).not.toBe(200);
    }
    expect(await rowsOf(ada.personId)).toStrictEqual(before);

    expect((await save('tips.dismissed', {}, adaToken)).status).toBe(200);
    const seen = await read(adaToken);
    expect(seen['tips.dismissed']).toStrictEqual({});
    expect(dismissedTipCount(seen)).toBe(0);
    expect(tipShown(seen, { ...BOARD, version: 3 })).toBe(true);
  });
}

function perPerson(): void {
  it('MP-2-11 per person: a dismissal and a reset reach the caller alone', async () => {
    expect((await dismiss({ ...BOARD, version: 5 }, adaToken)).status).toBe(200);
    expect((await save('tips.dismissed', {}, benToken)).status).toBe(200);
    expect(await dismissedOf(adaToken)).toStrictEqual({ [tipKey(BOARD.page, BOARD.tip)]: 5 });
    const benSees = await call('preference.read', {}, benToken);
    expect(benSees.body['preferences']).toMatchObject({ 'tips.dismissed': {} });
    expectNoCanary(benSees);

    // Naming another person is refused, and writes nothing.
    const aimed = await dismiss({ ...BOARD, version: 6, personId: ada.personId }, benToken);
    expect(aimed.status).not.toBe(200);
    expect(await dismissedOf(adaToken)).toStrictEqual({ [tipKey(BOARD.page, BOARD.tip)]: 5 });
  });

  it('MP-2-11 isolation: another business and an agent under a live delegation dismiss nothing here', async () => {
    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await installSpine(fixture.db.app, bravo);
    const bruno = await enrol(fixture.db.app, bravo, 'Bruno Tips');
    await fixture.db.app.withBusiness(bravo, async (tx) => await grantTo(tx, bruno, 'read'));
    const brunoToken = await tokenFor(bruno.presented.subject);
    const across = await dismiss({ ...BOARD, version: 7 }, brunoToken);
    expect(across.status).not.toBe(200);
    expectNoCanary(across);
    expect((await dismiss({ ...BOARD, version: 7 }, brunoToken, { key: 'bravo' })).status).toBe(
      200,
    );

    const task = await c.createTask('work an agent holds while its principal dismisses tips');
    const reservationId = await c.approve(await c.propose(task.id, task.revision, 'tip_probe'));
    const credential = String((await c.pickup(reservationId))['credential']);
    const principal = c.manager.personId;
    const before = await rowsOf(principal);
    const asAgent = await c.asAgent(
      'preference.dismiss_tip',
      { operationId: randomUUID(), ...BOARD, version: 1 },
      credential,
    );
    expect(asAgent.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await rowsOf(principal)).toStrictEqual(before);
    expect(await dismissedOf(adaToken)).toStrictEqual({ [tipKey(BOARD.page, BOARD.tip)]: 5 });
  });
}

function refusals(): void {
  it('MP-2-11 tip store: a page, tip or version out of shape is refused and writes nothing', async () => {
    const before = await rowsOf(ada.personId);
    for (const bad of [
      { ...BOARD, page: 'Agency:Board' },
      { ...BOARD, page: 'agency board' },
      { ...BOARD, page: 'agency:board#rank' },
      { ...BOARD, page: '' },
      { ...BOARD, page: `a${'b'.repeat(64)}` },
      { ...BOARD, tip: 'board#rank' },
      { ...BOARD, tip: 'board\trank' },
      { ...BOARD, tip: 'bóard' },
      { ...BOARD, tip: '__proto__' },
      { ...BOARD, version: 0 },
      { ...BOARD, version: -1 },
      { ...BOARD, version: 1.5 },
      { ...BOARD, version: '2' },
      { ...BOARD, version: 1_000_001 },
      { page: BOARD.page, version: 1 },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await dismiss(bad, adaToken);
      expect(refused.status, JSON.stringify(bad)).not.toBe(200);
    }
    expect(await rowsOf(ada.personId)).toStrictEqual(before);
  });

  it('MP-2-11 tip store: a new tip past the store limit is refused; one already held still updates', async () => {
    const full = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [tipKey('agency:filler', `t-${String(index)}`), 1]),
    );
    await fixture.db.admin.execute(
      `update public.person_preferences set value = $2::text::jsonb
        where person_id = $1 and key = 'tips.dismissed'`,
      [ada.personId, JSON.stringify(full)],
    );
    const over = await dismiss({ page: 'agency:filler', tip: 'one-more', version: 1 }, adaToken);
    expect(over.status).not.toBe(200);
    expect(
      (await dismiss({ page: 'agency:filler', tip: 't-0', version: 2 }, adaToken)).status,
    ).toBe(200);
    expect(dismissedTipCount(await read(adaToken))).toBe(500);
  });
}

function audits(): void {
  it('MP-2-11 no audit for preferences: an applied dismissal adds no audit event, a refused one does', async () => {
    const before = await dismissals(ben.actorId);
    const saves = await auditCount(ben.actorId);
    expect((await dismiss({ ...BOARD, version: 1 }, benToken)).status).toBe(200);
    expect(await dismissals(ben.actorId)).toBe(before);
    expect((await dismiss({ ...BOARD, version: 0 }, benToken)).status).not.toBe(200);
    expect(await dismissals(ben.actorId)).toBe(before + 1);
    expect(await auditCount(ben.actorId)).toBe(saves);
  });
}
