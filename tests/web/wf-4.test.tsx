// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// WF-4 (#637): the tickets, frontier and fog views and moving between the
// four, mounted over the composed API and the real database. Isolation is in
// `wf-4-isolation.test.tsx`; the look (W4, W5, MP-1-7) is held in
// `wf-4-held.test.tsx`.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { chart, keyOf, openMap, until } from './wayfinder-web.tsx';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { tokenFor } from '../api/fixture.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Viewed {
  readonly map: {
    readonly revision: number;
    readonly fog: readonly { readonly id: string; readonly text: string }[];
    readonly tickets: readonly { readonly id: string; readonly title: string | null }[];
  };
}

const tab = async (page: Mounted, view: string): Promise<void> => {
  // By attribute: jsdom resolves `#id` document-wide first.
  await page.click(`[role="tab"][id="map-tab-${view}"]`);
};

const ids = (page: Mounted, selector: string): string[] =>
  page.all(selector).map((one) => (one as HTMLElement).dataset['ticket'] ?? '');

describe.skipIf(serverUrl === undefined)('WF-4 the tickets, frontier and fog views', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('wf4web', 'wffourweb');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
  }, 180_000);

  // Each case's pages go with it, so no two pages share the document; one at
  // a time, since overlapping act() calls leave the next render unflushed.
  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  const view = async (map: string): Promise<Viewed['map']> =>
    ((await w.read(lead, { read: 'map.view', recordId: map })) as Viewed).map;
  const frontierOf = async (map: string): Promise<string[]> =>
    (
      (await w.read(lead, { read: 'map.frontier', recordId: map })) as {
        frontier: readonly { id: string }[];
      }
    ).frontier.map((one) => one.id);

  /** A map with one fog patch and a blocked pair: a blocks b. */
  const fogged = async (title: string) =>
    await chart(
      w,
      lead,
      title,
      [
        { ref: 'a', title: `${title} first`, type: 'research' },
        { ref: 'b', title: `${title} second`, type: 'task', blockedBy: ['a'] },
      ],
      [`${title} patch`],
    );

  /** Graduate the map's one patch into two tickets through the fog view. */
  async function graduate(page: Mounted, patchId: string, titles: readonly [string, string]) {
    await tab(page, 'fog');
    await page.click(`button[data-graduate="${patchId}"]`);
    await page.type('input[name="ticket-title-0"]', titles[0]);
    await page.click('button[data-add-ticket]');
    await page.type('input[name="ticket-title-1"]', titles[1]);
    await page.choose('select[name="ticket-type-1"]', 'build');
    await page.click('button[data-graduate-save]');
  }

  /** In the tickets view, block `ticket` by `blocker`. */
  async function block(page: Mounted, ticket: string, blocker: string) {
    await tab(page, 'tickets');
    await page.choose(`select[name="block-${ticket}"]`, blocker);
    await page.click(`button[data-block="${ticket}"]`);
  }

  it('WF-4 owner check: graduate a fog patch into two tickets and block one by the other; the unblocked ticket joins the frontier and the patch leaves the fog', async () => {
    const { map, key } = await fogged('owner check');
    const patch = (await view(map)).fog[0]?.id as string;
    const page = await openMap(w, open, lead, key);

    await graduate(page, patch, ['owner check new one', 'owner check new two']);
    await until(
      page,
      () =>
        page.find('[data-map-section="fog-view"]') !== null &&
        page.find(`[data-patch="${patch}"]`) === null,
      'the patch to leave',
    );
    const made = (await view(map)).tickets.filter((t) => t.title?.startsWith('owner check new'));
    const [one, two] = [made[0]?.id as string, made[1]?.id as string];

    await block(page, two, one);
    await until(
      page,
      () => page.find(`[data-ticket-row="${two}"] [data-blocked-by="${one}"]`) !== null,
      'the blocking link',
    );
    await tab(page, 'frontier');
    await until(page, () => page.find('[data-map-section="frontier"]') !== null, 'the frontier');
    const shown = ids(page, '[data-map-section="frontier"] [data-ticket]');
    expect(shown).toContain(one);
    expect(shown).not.toContain(two);
    await tab(page, 'fog');
    expect(page.find(`[data-patch="${patch}"]`)).toBeNull();
  });

  it('WF-4 the frontier view shows the same tickets as the frontier read model, in the same order', async () => {
    const { map, key } = await chart(w, lead, 'ordered', [
      { ref: 'a', title: 'ordered a', type: 'research' },
      { ref: 'b', title: 'ordered b', type: 'build' },
      { ref: 'c', title: 'ordered c', type: 'task', blockedBy: ['a'] },
      { ref: 'd', title: 'ordered d', type: 'grilling' },
    ]);
    const page = await openMap(w, open, lead, key);
    await tab(page, 'frontier');
    await until(page, () => page.find('[data-map-section="frontier"]') !== null, 'the frontier');
    expect(ids(page, '[data-map-section="frontier"] [data-ticket]')).toStrictEqual(
      await frontierOf(map),
    );
  });

  it('WF-4 moving between the four views keeps the map and its filters', async () => {
    const { map, key, tickets } = await chart(w, lead, 'filtered', [
      { ref: 'r', title: 'filtered research', type: 'research' },
      { ref: 'b', title: 'filtered build', type: 'build' },
    ]);
    const page = await openMap(w, open, lead, key);
    await tab(page, 'tickets');
    await page.choose('select[name="filter-type"]', 'research');
    await page.type('input[name="filter-text"]', 'filtered');
    const rows = () =>
      page.all('[data-ticket-row]').map((r) => (r as HTMLElement).dataset['ticketRow']);
    expect(rows()).toStrictEqual([tickets['r']]);

    for (const next of ['frontier', 'fog', 'map', 'tickets']) {
      // oxlint-disable-next-line no-await-in-loop
      await tab(page, next);
      expect((page.find('[data-map]') as HTMLElement | null)?.dataset['map']).toBe(map);
      expect((page.find('select[name="filter-type"]') as HTMLSelectElement).value).toBe('research');
      expect((page.find('input[name="filter-text"]') as HTMLInputElement).value).toBe('filtered');
    }
    expect(rows()).toStrictEqual([tickets['r']]);
    await tab(page, 'frontier');
    await until(page, () => page.find('[data-map-section="frontier"]') !== null, 'the frontier');
    expect(ids(page, '[data-map-section="frontier"] [data-ticket]')).toStrictEqual([tickets['r']]);
  });

  it('WF-4 each change is written by its command in the same transaction and audited', async () => {
    const { map, key } = await fogged('audited');
    const patch = (await view(map)).fog[0]?.id as string;
    const page = await openMap(w, open, lead, key);
    const before = (await w.audit()).length;
    await graduate(page, patch, ['audited new one', 'audited new two']);
    await until(
      page,
      () =>
        page.find('[data-map-section="fog-view"]') !== null &&
        page.find(`[data-patch="${patch}"]`) === null,
      'the graduation',
    );
    const made = (await view(map)).tickets.filter((t) => t.title?.startsWith('audited new'));
    const [one, two] = [made[0]?.id as string, made[1]?.id as string];
    await block(page, two, one);
    await until(page, () => page.find(`[data-blocked-by="${one}"]`) !== null, 'the link');

    const writes = (await w.audit())
      .slice(before)
      .filter((l) => l.command !== 'map.view' && l.command !== 'map.frontier')
      .map((l) => [l.command, l.outcome, l.subject]);
    expect(writes).toStrictEqual([
      ['map.graduate', 'applied', map],
      ['task.set_blocking', 'applied', two],
    ]);
    const [link] = await w.db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from public.record_links
        where business_id = $1 and link_type = 'blocks' and from_record_id = $2 and to_record_id = $3`,
      [w.business, one, two],
    );
    expect(link?.n).toBe(1);
    const report = await w.db.app.withBusiness(w.business, (tx) => verifyAuditChain(tx));
    expect(report.intact).toBe(true);
  });

  it('WF-4 a refusal per key: graduating and blocking ask task:write', async () => {
    const { map, key, tickets } = await fogged('refused');
    const patch = (await view(map)).fog[0]?.id as string;
    const reader = await w.member('wf4-reader', ['read']);
    const page = await openMap(w, open, reader, key);
    await graduate(page, patch, ['refused one', 'refused two']);
    await until(page, () => page.find('[data-map-failure]') !== null, 'the refusal');
    expect(page.find('[data-map-failure]')?.textContent).toContain('You need task:write');
    expect((await view(map)).fog.map((f) => f.id)).toStrictEqual([patch]);

    const again = await openMap(w, open, reader, key);
    await block(again, tickets['a'] as string, tickets['b'] as string);
    await until(again, () => again.find('[data-map-failure]') !== null, 'the refusal');
    expect(again.find('[data-map-failure]')?.textContent).toContain('You need task:write');
    expect(await frontierOf(map)).toStrictEqual([tickets['a']]);
  });

  it('WF-4 graduating and blocking are reachable from the CLI with the same result and the same refusal', async () => {
    const { map, tickets } = await fogged('parity');
    const patch = (await view(map)).fog[0]?.id as string;
    const cliFor = async (member: Member) => {
      const transport: Transport = async (path, body, bearer) =>
        await w.api.fetch(
          new Request(`http://api.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
            body,
          }),
        );
      return createCli({
        transport,
        businessKey: w.key,
        credential: await tokenFor(member.presented.subject),
      });
    };
    const at = async (id: string) => ({
      operationId: crypto.randomUUID(),
      recordId: id,
      expectedRevision: await w.revisionOf(id),
    });
    const reader = await cliFor(await w.member('wf4-parity-reader', ['read']));
    const refused = await reader.run('map.graduate', {
      ...(await at(map)),
      patchId: patch,
      tickets: [{ title: 'x', type: 'task' }],
    });
    expect((refused.body as { code: string }).code).toBe('SCOPE_NOT_GRANTED');

    const cli = await cliFor(lead);
    const graduated = await cli.run('map.graduate', {
      ...(await at(map)),
      patchId: patch,
      tickets: [{ title: 'parity cli ticket', type: 'task' }],
    });
    expect(graduated.status, JSON.stringify(graduated.body)).toBe(200);
    const made = (await view(map)).tickets.find((t) => t.title === 'parity cli ticket')?.id;
    const blocked = await cli.run('task.set_blocking', {
      ...(await at(made as string)),
      blockedBy: [tickets['a']],
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    // The page shows what the CLI did: the patch gone, the new ticket blocked.
    const page = await openMap(w, open, lead, await keyOf(w, map));
    await tab(page, 'tickets');
    expect(
      page.find(`[data-ticket-row="${String(made)}"] [data-blocked-by="${String(tickets['a'])}"]`),
    ).not.toBeNull();
    await tab(page, 'fog');
    expect(page.find(`[data-patch="${patch}"]`)).toBeNull();
  });
});
