// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// A refusal on the map page is about the write that drew it: a missing key on
// one ticket leaves the person's writes on another ticket open, and a refusal
// that is not about a key (a blocking cycle) never tells a writer to get one.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { grantTo, type Member } from '../commands/fixture.ts';
import { must } from '../wayfinder/world.ts';
import { chart, openMap, until } from './wayfinder-web.tsx';

const serverUrl = databaseUrlFromEnvironment();

const tab = async (page: Mounted, view: string): Promise<void> => {
  await page.click(`[role="tab"][id="map-tab-${view}"]`);
};

const blockButton = (page: Mounted, ticket: string) =>
  page.find(`button[data-block="${ticket}"]`) as HTMLButtonElement | null;

describe.skipIf(serverUrl === undefined)('A map refusal stays with its write', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('maprefuse', 'maprefuseweb');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
  }, 180_000);

  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  it('a ticket the person may not write refuses its blocking, and the ticket they may write still takes theirs', async () => {
    const m = await chart(w, lead, 'two grants', [
      { ref: 'a', title: 'two grants a', type: 'task' },
      { ref: 'b', title: 'two grants b', type: 'task' },
      { ref: 'c', title: 'two grants c', type: 'task' },
    ]);
    const [a, b, c] = [m.tickets['a'], m.tickets['b'], m.tickets['c']] as [string, string, string];
    const person = await w.member('writes-a-only', ['read']);
    await w.db.app.withBusiness(w.business, async (tx) => {
      await grantTo(tx, person, 'write', { kind: 'record', id: a });
    });

    const page = await openMap(w, open, person, m.key);
    await tab(page, 'tickets');
    await page.choose(`select[name="block-${b}"]`, c);
    await page.click(`button[data-block="${b}"]`);
    await until(
      page,
      () => page.find('[data-map-failure]')?.textContent?.includes('SCOPE_NOT_GRANTED') === true,
      'the refusal on b',
    );
    expect(page.find('[data-map-failure]')?.textContent).toContain('You need task:write');
    // The refused ticket is not asked again.
    expect(blockButton(page, b)?.disabled).toBe(true);

    await page.choose(`select[name="block-${a}"]`, c);
    expect(blockButton(page, a)?.disabled).toBe(false);
    await page.click(`button[data-block="${a}"]`);
    await until(
      page,
      () => page.find(`[data-ticket-row="${a}"] [data-blocked-by="${c}"]`) !== null,
      'a blocked by c',
    );
    expect(page.find('[data-map-failure]')).toBeNull();

    // The same write, sent directly under the same person, applies too.
    const direct = await w.as(person, {
      command: 'task.set_blocking',
      recordId: a,
      expectedRevision: await w.revisionOf(a),
      blockedBy: [],
    });
    expect(must(direct, 'task.set_blocking').id).toBe(a);
  });

  it('a blocking that would close a cycle is refused without telling a writer they need a key', async () => {
    const m = await chart(w, lead, 'cycle', [
      { ref: 'a', title: 'cycle a', type: 'task' },
      { ref: 'b', title: 'cycle b', type: 'task', blockedBy: ['a'] },
    ]);
    const [a, b] = [m.tickets['a'], m.tickets['b']] as [string, string];
    const page = await openMap(w, open, lead, m.key);
    await tab(page, 'tickets');
    await page.choose(`select[name="block-${a}"]`, b);
    await page.click(`button[data-block="${a}"]`);
    await until(page, () => page.find('[data-map-failure]') !== null, 'the refusal');
    const shown = page.find('[data-map-failure]')?.textContent ?? '';
    expect(shown).toContain('TRANSITION_NOT_PERMITTED');
    expect(shown).toContain('a cycle');
    expect(shown).not.toContain('You need');
  });
});
