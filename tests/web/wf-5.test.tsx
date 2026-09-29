// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite over one world */
//
// WF-5 (#638), ticket detail: the type-aware task page, mounted over the
// composed API and the real database. Isolation is in
// `wf-5-isolation.test.tsx`; the look (W6, MP-1-7) is held in
// `wf-5-held.test.tsx`.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { browserFor, chart, keyOf, until } from './wayfinder-web.tsx';
import { createCli, type Transport } from '../../apps/cli/client.ts';
import { tokenFor } from '../api/fixture.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import type { Member } from '../commands/fixture.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/index.ts';

/** Every read the surface declares, so a read the page adds needs no edit here. */
const READS: ReadonlySet<string> = new Set(
  COMMAND_SURFACE.filter((declaration) => declaration.kind === 'read').map((d) => d.name),
);

const serverUrl = databaseUrlFromEnvironment();

async function resolve(page: Mounted, answer: string, gist: string): Promise<void> {
  await page.click('button[data-resolve]');
  await page.type('textarea[name="answer"]', answer);
  await page.type('input[name="gist"]', gist);
  await page.click('button[data-resolve-save]');
}

describe.skipIf(serverUrl === undefined)('WF-5 ticket detail', () => {
  let w: CliWorld;
  let owner: Member;
  let teammate: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('wf5web', 'wffiveweb');
    owner = await w.member('owner', ['read', 'write', 'assign', 'comment', 'decide']);
    teammate = await w.member('teammate', ['read', 'write', 'assign', 'comment', 'decide']);
  }, 180_000);

  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  /** A map the owner charted: a grilling ticket g, a task t blocking it, and a build b. */
  const charted = async (title: string) =>
    await chart(w, owner, title, [
      { ref: 't', title: `${title} task`, type: 'task' },
      { ref: 'g', title: `${title} grilling`, type: 'grilling', blockedBy: ['t'] },
      { ref: 'b', title: `${title} build`, type: 'build' },
    ]);

  async function openTicket(member: Member, ticket: string): Promise<Mounted> {
    const client = await browserFor(w.api, member, w.key);
    const page = await mount(
      <TaskDetailScreen
        client={client}
        grantKey={member.presented.subject}
        taskKey={await keyOf(w, ticket)}
      />,
    );
    open.push(page);
    await until(
      page,
      () =>
        page.find('[data-ticket-panel]') !== null ||
        // The task's own refusal; the people list can be denied on its own.
        page.text().includes('not permitted to see this task'),
      'the ticket or its refusal',
    );
    return page;
  }

  const resolved = async (ticket: string): Promise<string | null> => {
    const [row] = await w.db.admin.execute<{ readonly gist: string | null }>(
      `select data ->> 'gist' as gist from public.records where business_id = $1 and id = $2`,
      [w.business, ticket],
    );
    return row?.gist ?? null;
  };

  it("WF-5 owner check: on a grilling ticket Resolve is not offered to a teammate who is not the map's owner, and is to the owner", async () => {
    const { map, tickets } = await charted('owner check');
    const g = tickets['g'] as string;
    const asTeammate = await openTicket(teammate, g);
    expect((asTeammate.find('[data-ticket-panel]') as HTMLElement | null)?.dataset['type']).toBe(
      'grilling',
    );
    expect(asTeammate.find('button[data-resolve]')).toBeNull();
    const asOwner = await openTicket(owner, g);
    expect(asOwner.find('button[data-resolve]')).not.toBeNull();
    // The panel names its map and what blocks the ticket.
    expect(
      asOwner.find(`a[href="/map/${encodeURIComponent(await keyOf(w, map))}"]`),
    ).not.toBeNull();
    expect(asOwner.find(`[data-blocked-by="${String(tickets['t'])}"]`)).not.toBeNull();
    // A build ticket is resolved under task:write: the teammate is offered it.
    const build = await openTicket(teammate, tickets['b'] as string);
    expect(build.find('button[data-resolve]')).not.toBeNull();
  });

  it('WF-5 resolve asks for the answer and a one-line gist', async () => {
    const { tickets } = await charted('resolve form');
    const b = tickets['b'] as string;
    const page = await openTicket(owner, b);
    await page.click('button[data-resolve]');
    expect(page.find('textarea[name="answer"]')).not.toBeNull();
    expect(page.find('input[name="gist"]')?.getAttribute('type')).toBe('text');
    await page.type('textarea[name="answer"]', 'the long answer');
    const save = () => page.find('button[data-resolve-save]') as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    await page.type('input[name="gist"]', 'resolve form gist');
    expect(save().disabled).toBe(false);
    await page.click('button[data-resolve-save]');
    await until(
      page,
      () => page.find('button[data-resolve]') === null && page.find('[data-ticket-panel]') !== null,
      'the reread',
    );
    expect(await resolved(b)).toBe('resolve form gist');
  });

  it('WF-5 the thread is the one comment record; nothing is duplicated', async () => {
    const { tickets } = await charted('thread');
    const t = tickets['t'] as string;
    const posted = await w.as(owner, {
      command: 'task.comment',
      recordId: t,
      expectedRevision: await w.revisionOf(t),
      audience: 'internal',
      body: 'thread canary line',
    });
    expect((posted as { code?: string }).code).toBeUndefined();
    const page = await openTicket(owner, t);
    await until(page, () => page.text().includes('thread canary line'), 'the comment');
    expect(page.text().split('thread canary line').length - 1).toBe(1);
    expect(page.find('[data-ticket-panel]')?.textContent).not.toContain('thread canary line');
  });

  it('WF-5 claim and resolve are written by their commands in the same transaction and audited', async () => {
    const { tickets } = await charted('audited');
    const t = tickets['t'] as string;
    const page = await openTicket(teammate, t);
    const before = (await w.audit()).length;
    await page.click('button[data-claim]');
    await until(
      page,
      () => page.find('[data-ticket-panel]') !== null && page.find('button[data-claim]') === null,
      'the claim',
    );
    await resolve(page, 'audited answer', 'audited gist');
    await until(
      page,
      () => page.find('[data-ticket-panel]') !== null && page.find('button[data-resolve]') === null,
      'the resolve',
    );
    const writes = (await w.audit())
      .slice(before)
      // Every read the page makes writes its own event; only the writes are asked about.
      .filter((l) => !READS.has(l.command))
      .map((l) => [l.command, l.outcome, l.subject]);
    expect(writes).toStrictEqual([
      ['task.claim', 'applied', t],
      ['task.resolve', 'applied', t],
    ]);
    expect(await resolved(t)).toBe('audited gist');
    const report = await w.db.app.withBusiness(w.business, (tx) => verifyAuditChain(tx));
    expect(report.intact).toBe(true);
  });

  it('WF-5 a refusal per key: claiming asks task:assign, resolving asks task:write', async () => {
    const { tickets } = await charted('refused');
    const t = tickets['t'] as string;
    const writer = await w.member('wf5-writer', ['read', 'write']);
    const claimPage = await openTicket(writer, t);
    await claimPage.click('button[data-claim]');
    await until(claimPage, () => claimPage.find('[data-ticket-failure]') !== null, 'the refusal');
    expect(claimPage.find('[data-ticket-failure]')?.textContent).toContain('You need task:assign');

    const reader = await w.member('wf5-reader', ['read']);
    const resolvePage = await openTicket(reader, t);
    await resolve(resolvePage, 'x', 'refused gist');
    await until(
      resolvePage,
      () => resolvePage.find('[data-ticket-failure]') !== null,
      'the refusal',
    );
    expect(resolvePage.find('[data-ticket-failure]')?.textContent).toContain('You need task:write');
    expect(await resolved(t)).toBeNull();
  });

  it('WF-5 claim and resolve are reachable from the CLI with the same result and the same refusal', async () => {
    const { tickets } = await charted('parity');
    const t = tickets['t'] as string;
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
    const at = async () => ({
      operationId: crypto.randomUUID(),
      recordId: t,
      expectedRevision: await w.revisionOf(t),
    });
    const writer = await cliFor(await w.member('wf5-parity-writer', ['read', 'write']));
    const refused = await writer.run('task.claim', await at());
    const page = await openTicket(await w.member('wf5-parity-page', ['read', 'write']), t);
    await page.click('button[data-claim]');
    await until(page, () => page.find('[data-ticket-failure]') !== null, 'the refusal');
    expect(
      page
        .find('[data-ticket-failure]')
        ?.textContent?.startsWith(`${(refused.body as { code: string }).code}.`),
    ).toBe(true);

    const cli = await cliFor(owner);
    expect((await cli.run('task.claim', await at())).status).toBe(200);
    expect(
      (
        await cli.run('task.resolve', {
          ...(await at()),
          answer: 'cli answer',
          gist: 'parity cli gist',
        })
      ).status,
    ).toBe(200);
    const shown = await openTicket(owner, t);
    expect(shown.find('button[data-claim]')).toBeNull();
    expect(shown.find('button[data-resolve]')).toBeNull();
    expect(shown.find('[data-ticket-panel]')?.textContent).toContain('parity cli gist');
  });
});
