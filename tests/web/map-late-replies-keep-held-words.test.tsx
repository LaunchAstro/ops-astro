// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// A map write's reply, and the reread after it, can land after the reader has
// moved on. Words dropped while a stale save was on its way stay dropped: the
// late refusal offers nothing to save again. And until the reread after a
// write has drawn the server's map, no control sends against the map it
// replaces, nor opens a graduate form over one kept to copy.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import type { Member } from '../commands/fixture.ts';
import { tokenFor } from '../api/fixture.ts';
import { asBrowser } from '../support/sign-in.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { MapScreen } from '../../apps/web/src/screens/Map.tsx';
import { chart, until } from './wayfinder-web.tsx';

const serverUrl = databaseUrlFromEnvironment();

/** A promise and the call that settles it. */
function signal(): { readonly fired: Promise<void>; readonly fire: () => void } {
  let fire: (() => void) | undefined;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire: () => fire?.() };
}

const revisionShown = (page: Mounted) =>
  (page.find('[data-map]') as HTMLElement | null)?.dataset['revision'];

/** The notice a kept draft's conflict draws. */
function expectNoConflict(page: Mounted) {
  expect(page.find('[data-map-conflict]')).toBeNull();
  expect(page.text()).not.toContain('save it again');
}

interface Hold {
  readonly path: string;
  readonly arrived: () => void;
  readonly released: Promise<void>;
}

describe.skipIf(serverUrl === undefined)('A late map reply keeps what the reader holds', () => {
  let w: CliWorld;
  let lead: Member;
  let other: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('maplate', 'maplateweb');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    other = await w.member('other-writer', ['read', 'write']);
  }, 180_000);

  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  /**
   * The map page for `member`. `hold(path)` holds the next reply to `path`
   * after the server has answered it: `arrived` settles when it is held, and
   * `release` delivers it. `sent(path)` counts the requests made to `path` as
   * they go out, whether or not they have been answered.
   */
  async function openHeld(member: Member, mapKey: string) {
    const holds: Hold[] = [];
    const sent: string[] = [];
    const fetch = asBrowser(await tokenFor(member.presented.subject), async (url, init) => {
      // Counted as sent, before its answer: a write still on its way counts.
      sent.push(url);
      const answer = await w.api.fetch(new Request(url, init));
      const at = holds.findIndex((one) => url.endsWith(one.path));
      const held = at === -1 ? undefined : holds.splice(at, 1)[0];
      if (held !== undefined) {
        held.arrived();
        await held.released;
      }
      return answer;
    });
    const client = new OperationsClient({
      origin: 'http://api.test',
      businessKey: w.key,
      signedIn: true,
      fetch,
    });
    const page = await mount(
      <MapScreen client={client} grantKey={member.presented.subject} mapKey={mapKey} />,
    );
    open.push(page);
    await until(page, () => page.find('[data-map-section="destination"]') !== null, 'the map');
    const hold = (path: string) => {
      const arrived = signal();
      const released = signal();
      holds.push({ path, arrived: arrived.fire, released: released.fired });
      return { arrived: arrived.fired, release: released.fire };
    };
    const count = (path: string) => sent.filter((url) => url.endsWith(path)).length;
    return { page, hold, sent: count };
  }

  /** Another writer moves the map on, so the lead's next write is stale; answers the new revision. */
  async function moveOn(m: { readonly map: string }, change: Record<string, unknown>) {
    const at = { recordId: m.map, expectedRevision: await w.revisionOf(m.map) };
    must(await w.as(other, { command: 'map.revise', ...at, ...change }), 'map.revise');
    return String(await w.revisionOf(m.map));
  }

  it('notes cancelled while their stale save is on its way draw no conflict when it lands', async () => {
    const m = await chart(w, lead, 'late notes', [{ ref: 'a', title: 'a', type: 'task' }]);
    const { page, hold } = await openHeld(lead, m.key);
    await page.click('button[data-edit="notes"]');
    await page.type('textarea[name="notes"]', 'discard me');
    const latest = await moveOn(m, { notes: 'elsewhere' });
    const reply = hold('/map/revise');
    await page.click('button[data-save="notes"]');
    await reply.arrived;
    await page.click('[data-map-section="notes"] button[type="button"]');
    reply.release();
    await until(page, () => revisionShown(page) === latest, 'the stale reply and the reread');

    expect(page.find('textarea[name="notes"]')).toBeNull();
    expect(page.text()).not.toContain('discard me');
    expectNoConflict(page);
  });

  it('a graduate form cancelled while its stale graduation is on its way draws no conflict when it lands', async () => {
    const m = await chart(
      w,
      lead,
      'late graduate',
      [{ ref: 'a', title: 'a', type: 'task' }],
      ['late graduate patch'],
    );
    const { page, hold } = await openHeld(lead, m.key);
    await page.click('[role="tab"][id="map-tab-fog"]');
    const patch = (page.find('[data-patch]') as HTMLElement).dataset['patch'] as string;
    await page.click(`button[data-graduate="${patch}"]`);
    await page.type('input[name="ticket-title-0"]', 'cancelled ticket');
    const latest = await moveOn(m, { notes: 'elsewhere' });
    const reply = hold('/map/graduate');
    await page.click('button[data-graduate-save]');
    await reply.arrived;
    await page.click(`[data-patch="${patch}"] form button[type="button"]:not([data-add-ticket])`);
    reply.release();
    await until(page, () => revisionShown(page) === latest, 'the stale reply and the reread');

    expect(page.find('input[name="ticket-title-0"]')).toBeNull();
    expect(page.find('[data-graduate-gone]')).toBeNull();
    expectNoConflict(page);
  });

  it('a line emptied while its stale add is on its way draws no conflict when it lands', async () => {
    const m = await chart(w, lead, 'late add', [{ ref: 'a', title: 'a', type: 'task' }]);
    const { page, hold } = await openHeld(lead, m.key);
    await page.type('input[name="fog"]', 'a line I will empty');
    const latest = await moveOn(m, { notes: 'elsewhere' });
    const reply = hold('/map/revise');
    await page.click('button[data-add="fog"]');
    await reply.arrived;
    await page.type('input[name="fog"]', '');
    reply.release();
    await until(page, () => revisionShown(page) === latest, 'the stale reply and the reread');

    expect((page.find('input[name="fog"]') as HTMLInputElement | null)?.value).toBe('');
    expectNoConflict(page);
  });

  it('opening another patch during the reread after a stale graduation keeps the first form to copy', async () => {
    const m = await chart(
      w,
      lead,
      'reread graduate',
      [{ ref: 'a', title: 'a', type: 'task' }],
      ['patch to be retired', 'patch that stays'],
    );
    const { page, hold } = await openHeld(lead, m.key);
    await page.click('[role="tab"][id="map-tab-fog"]');
    const [first, second] = page
      .all('[data-patch]')
      .map((one) => (one as HTMLElement).dataset['patch'] as string);
    await page.click(`button[data-graduate="${first ?? ''}"]`);
    await page.type('input[name="ticket-title-0"]', 'keep one');
    await page.click('button[data-add-ticket]');
    await page.type('input[name="ticket-title-1"]', 'keep two');
    const latest = await moveOn(m, { retire: [first] });

    const reread = hold('/map/view');
    await page.click('button[data-graduate-save]');
    await reread.arrived;
    // The stale reply has landed; the map drawn is still the one it replaced.
    expect(page.find(`[data-patch="${first ?? ''}"]`)).not.toBeNull();
    await page.click(`button[data-graduate="${second ?? ''}"]`);
    reread.release();
    await until(page, () => revisionShown(page) === latest, 'the reread');

    const gone = page.find('[data-graduate-gone]');
    expect(gone?.textContent ?? 'no form kept').toContain('keep one');
    expect(gone?.textContent ?? 'no form kept').toContain('keep two');
    expect(page.find('input[name="ticket-title-0"]')).toBeNull();
  });

  it('a control pressed during the reread after an applied save sends nothing against the old map', async () => {
    const m = await chart(
      w,
      lead,
      'reread retire',
      [{ ref: 'a', title: 'a', type: 'task' }],
      ['patch left alone'],
    );
    const { page, hold, sent } = await openHeld(lead, m.key);
    const patch = (page.find('[data-retire]') as HTMLElement).dataset['retire'] as string;
    // A line still being typed keeps the map drawn through the reread.
    await page.type('input[name="out-of-scope"]', 'still typing');
    await page.click('button[data-edit="notes"]');
    await page.type('textarea[name="notes"]', 'applied notes');
    const reread = hold('/map/view');
    await page.click('button[data-save="notes"]');
    await reread.arrived;
    const after = String(await w.revisionOf(m.map));
    await page.click(`button[data-retire="${patch}"]`);
    reread.release();
    await until(page, () => revisionShown(page) === after, 'the save and its reread');

    expect(sent('/map/revise')).toBe(1);
    expect(page.find('[data-map-failure]')).toBeNull();
    expect(page.find(`[data-retire="${patch}"]`)).not.toBeNull();
  });
});
