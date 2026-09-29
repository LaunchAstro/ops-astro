// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// WF-3 (#636), the map view: the screen mounted over the composed API and the
// real database, so every read and edit it makes goes through the route, the
// envelope and the audit chain a person's browser reaches. The look (W4, the
// width-and-theme harness MP-1-7) and an agent's edit as a reviewable change
// are held in `wf-3-held.test.tsx`.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import { must } from '../wayfinder/world.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { browserFor, until } from './wayfinder-web.tsx';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { tokenFor } from '../api/fixture.ts';
import { MapScreen } from '../../apps/web/src/screens/Map.tsx';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

async function editNotes(mounted: Mounted, text: string): Promise<void> {
  await mounted.click('button[data-edit="notes"]');
  await mounted.type('textarea[name="notes"]', text);
  await mounted.click('button[data-save="notes"]');
}

const operationId = (): string => crypto.randomUUID();

describe.skipIf(serverUrl === undefined)('WF-3 the map view', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('wf3web', 'wfthreeweb');
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

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  /** A map with every section filled: a resolved ticket, fog, notes and an out-of-scope close. */
  async function fullMap(title: string) {
    const charted = await w.as(lead, {
      command: 'map.chart',
      title,
      destination: `${title} destination`,
      tickets: [
        { ref: 'a', title: `${title} settled`, type: 'research' },
        { ref: 'b', title: `${title} dropped`, type: 'task' },
      ],
      fog: [`${title} fog line`],
    });
    const map = must(charted, 'chart').id;
    const tickets = (charted as { detail?: { tickets?: Record<string, string> } }).detail
      ?.tickets as Record<string, string>;
    const a = tickets['a'] as string;
    must(
      await w.as(lead, { command: 'map.revise', ...(await at(map)), notes: `${title} notes` }),
      'notes',
    );
    must(
      await w.as(lead, {
        command: 'task.resolve',
        ...(await at(a)),
        answer: 'yes',
        gist: `${title} gist`,
      }),
      'resolve',
    );
    must(
      await w.as(lead, {
        command: 'task.close_out_of_scope',
        ...(await at(tickets['b'] as string)),
        reason: `${title} later`,
      }),
      'out of scope',
    );
    const [row] = await w.db.admin.execute<{ readonly key: string }>(
      `select txt_1 as key from public.records where business_id = $1 and id = $2`,
      [w.business, map],
    );
    const [ticket] = await w.db.admin.execute<{ readonly key: string }>(
      `select txt_1 as key from public.records where business_id = $1 and id = $2`,
      [w.business, a],
    );
    return { map, key: row?.key as string, settled: a, settledKey: ticket?.key as string };
  }

  async function openMap(member: Member, mapKey: string, businessKey = w.key): Promise<Mounted> {
    const client = await browserFor(w.api, member, businessKey);
    const mounted = await mount(
      <MapScreen client={client} grantKey={member.presented.subject} mapKey={mapKey} />,
    );
    open.push(mounted);
    await until(
      mounted,
      () =>
        mounted.find('[data-map-section="destination"]') !== null ||
        mounted.find('[data-map-refused]') !== null,
      'the map or its refusal',
    );
    return mounted;
  }

  it('WF-3 owner check: a map shows its destination, notes, decisions, fog and out-of-scope sections; editing the notes adds the new version to its history', async () => {
    const { key } = await fullMap('owner check');
    const page = await openMap(lead, key);
    const section = (name: string) => page.find(`[data-map-section="${name}"]`)?.textContent ?? '';
    expect(section('destination')).toContain('owner check destination');
    expect(section('notes')).toContain('owner check notes');
    expect(section('decisions')).toContain('owner check gist');
    expect(section('fog')).toContain('owner check fog line');
    expect(section('out-of-scope')).toContain('owner check later');
    const before = page.all('[data-map-section="history"] [data-version]').length;

    await editNotes(page, 'owner check notes, second pass');
    await until(
      page,
      () =>
        page.find('textarea[name="notes"]') === null && section('notes').includes('second pass'),
      'the new notes, read back',
    );
    const versions = page.all('[data-map-section="history"] [data-version]');
    expect(versions.length).toBe(before + 1);
    expect(
      page.find(`[data-map-section="history"] [data-version="${String(before + 1)}"]`),
    ).not.toBeNull();
  });

  it('WF-3 each Decisions so far line links its ticket', async () => {
    const { key, settled, settledKey } = await fullMap('linked');
    const page = await openMap(lead, key);
    // The resolved ticket and the one closed out of scope are both decisions.
    const lines = page.all('[data-map-section="decisions"] li');
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line.querySelector('a')).not.toBeNull();
    const link = page.find(`[data-map-section="decisions"] li[data-ticket="${settled}"] a`);
    expect(link?.getAttribute('href')).toBe(`/task/${encodeURIComponent(settledKey)}`);
    expect(link?.textContent).toContain('linked gist');
  });

  it('WF-3 the edit writes map revised in the same transaction and joins the audit chain; opening the map writes its one read event', async () => {
    const { map, key } = await fullMap('audited');
    const before = (await w.audit()).length;
    const page = await openMap(lead, key);
    await editNotes(page, 'audited notes, edited');
    await until(
      page,
      () =>
        page.find('textarea[name="notes"]') === null &&
        page.text().includes('audited notes, edited'),
      'the edit, read back',
    );
    const lines = (await w.audit()).slice(before).map((l) => [l.command, l.outcome, l.subject]);
    // Opened, edited, read again: one read event each, and the edit's own event.
    expect(lines).toStrictEqual([
      ['map.view', 'applied', map],
      ['map.revise', 'applied', map],
      ['map.view', 'applied', map],
    ]);
    const [latest] = await w.db.admin.execute<{ readonly version: number }>(
      `select max(version)::int as version from public.map_versions where business_id = $1 and map_id = $2`,
      [w.business, map],
    );
    expect(
      page.find(`[data-map-section="history"] [data-version="${String(latest?.version)}"]`),
    ).not.toBeNull();
    const report = await w.db.app.withBusiness(w.business, (tx) => verifyAuditChain(tx));
    expect(report.intact).toBe(true);
  });

  it('WF-3 a refusal per key: editing the map asks task:write', async () => {
    const { map, key } = await fullMap('refused edit');
    const reader = await w.member('wf3-reader', ['read']);
    const page = await openMap(reader, key);
    const version = await w.revisionOf(map);
    await editNotes(page, 'refused edit, attempted');
    await until(page, () => page.find('[data-map-failure]') !== null, 'the refusal');
    expect(page.find('[data-map-failure]')?.textContent).toContain('task:write');
    expect(await w.revisionOf(map)).toBe(version);
    // The attempt stays in the editor to copy; the stored notes are unchanged.
    expect((page.find('textarea[name="notes"]') as HTMLTextAreaElement).value).toBe(
      'refused edit, attempted',
    );
    const stored = (await w.read(lead, { read: 'map.view', recordId: map })) as {
      map: { notes: { text: string } | null };
    };
    expect(stored.map.notes?.text).toBe('refused edit notes');
  });

  it('WF-3 the notes edit is reachable from the CLI with the same result and the same refusal', async () => {
    const { map, key } = await fullMap('parity');
    const reader = await w.member('wf3-parity-reader', ['read']);
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

    // The same refusal: the CLI gets the code the page shows, and the page
    // names the key the edit needs.
    const refusedCli = await (
      await cliFor(reader)
    ).run('map.revise', { operationId: operationId(), ...(await at(map)), notes: 'x' });
    const page = await openMap(reader, key);
    await editNotes(page, 'x');
    await until(page, () => page.find('[data-map-failure]') !== null, 'the refusal');
    const refusal = refusedCli.body as { readonly code: string };
    expect(refusedCli.status).not.toBe(200);
    const shown = page.find('[data-map-failure]')?.textContent ?? '';
    expect(shown.startsWith(`${refusal.code}.`), shown).toBe(true);
    expect(shown).toContain('You need task:write');

    // The same result: a CLI edit is a numbered version the page shows.
    const edited = await (
      await cliFor(lead)
    ).run('map.revise', {
      operationId: operationId(),
      ...(await at(map)),
      notes: 'parity via cli',
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const reopened = await openMap(lead, key);
    expect(reopened.find('[data-map-section="notes"]')?.textContent).toContain('parity via cli');
    const [latest] = await w.db.admin.execute<{ readonly version: number }>(
      `select max(version)::int as version from public.map_versions where business_id = $1 and map_id = $2`,
      [w.business, map],
    );
    expect(
      reopened.find(`[data-map-section="history"] [data-version="${String(latest?.version)}"]`),
    ).not.toBeNull();
  });

  it('WF-3 isolation', async () => {
    const { map: mapA } = await fullMap('canary-wf3-A');
    const { map: mapB, key: keyB, settled } = await fullMap('canary-wf3-B');
    must(
      await w.as(lead, { command: 'map.scope', ...(await at(mapB)), client: crypto.randomUUID() }),
      'scope',
    );
    const clean = (what: string, text: string) => {
      for (const canary of ['canary-wf3-B', mapB, settled])
        expect(text, what).not.toContain(canary);
    };

    // 1. Another business: bravo's person asks for alpha's map by key.
    const bea = await openMap(await w.outsider('wf3-bea'), keyB, `${w.key}-bravo`);
    expect(bea.find('[data-map-refused]')?.textContent).toContain('NOT_FOUND');
    expect(bea.find('[data-map-section]')).toBeNull();
    clean('bravo', bea.text());

    // 2. Another client in the same business: a person granted only map A.
    const scoped = await w.member('wf3-scoped-a', ['read', 'write'], { kind: 'record', id: mapA });
    const other = await openMap(scoped, keyB);
    expect(other.find('[data-map-refused]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(other.find('[data-map-section]')).toBeNull();
    clean('other client', other.text());
    const version = await w.revisionOf(mapB);
    const edit = await w.as(scoped, {
      command: 'map.revise',
      ...(await at(mapB)),
      notes: 'crossed',
    });
    expect((edit as { code?: string }).code).toBe('SCOPE_NOT_GRANTED');
    expect(await w.revisionOf(mapB)).toBe(version);

    // 3. A person under a live delegation: the agent reaches no map view
    // (LEANS-ON SL09 U18, the agent credential narrowed from a person's grants).
    const picked = await w.pickUp(await w.decider('wf3-delegator'), 'map view agent task');
    const agent = await w.agent(picked.credential);
    const delegated = await agent.run('map', 'view', mapB);
    expect(delegated.exit).toBe(1);
    clean('delegated', delegated.out);
  });
});
