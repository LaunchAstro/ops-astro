// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one case over one world */
//
// `WF-5 isolation` (#638): the three real crossings for the ticket page and
// its two writes, statuses checked, canaries absent from every page and
// answer.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { browserFor, chart, keyOf, until } from './wayfinder-web.tsx';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const codeOf = (answer: unknown): string => (answer as { code?: string }).code ?? 'applied';

describe.skipIf(serverUrl === undefined)('WF-5 isolation', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('wf5iso', 'wffiveiso');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
  }, 180_000);

  afterEach(async () => {
    for (const mounted of open.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop
      await mounted.unmount();
    }
  });

  afterAll(async () => await w?.drop());

  async function openTicket(member: Member, key: string, businessKey = w.key) {
    const client = await browserFor(w.api, member, businessKey);
    const page = await mount(
      <TaskDetailScreen client={client} grantKey={member.presented.subject} taskKey={key} />,
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

  const at = async (id: string) => ({ recordId: id, expectedRevision: await w.revisionOf(id) });

  it('WF-5 isolation', async () => {
    const a = await chart(w, lead, 'A map', [{ ref: 'a', title: 'A one', type: 'task' }]);
    const b = await chart(w, lead, 'canary-wf5-B', [
      { ref: 'x', title: 'canary-wf5-B blocker', type: 'task' },
      { ref: 'b', title: 'canary-wf5-B ticket', type: 'task', blockedBy: ['x'] },
    ]);
    const bTicket = b.tickets['b'] as string;
    const bKey = await keyOf(w, bTicket);
    expect(
      codeOf(
        await w.as(lead, {
          command: 'map.scope',
          ...(await at(b.map)),
          client: crypto.randomUUID(),
        }),
      ),
    ).toBe('applied');
    const clean = (what: string, text: string) => {
      for (const canary of ['canary-wf5-B', b.map, bTicket, b.tickets['x'] as string]) {
        expect(text, what).not.toContain(canary);
      }
    };

    // 1. Another business: bravo's person asks for alpha's ticket by key.
    const bea = await w.outsider('wf5-bea');
    const bravo = await openTicket(bea, bKey, `${w.key}-bravo`);
    expect(bravo.find('[data-outcome="denied"]')?.textContent).toContain('NOT_FOUND');
    expect(bravo.find('[data-ticket-panel]')).toBeNull();
    clean('bravo page', bravo.text());

    // 2. Another client in the same business: a person granted only map A
    // neither sees B's ticket nor claims or resolves it.
    const scoped = await w.member('wf5-scoped-a', ['read', 'write', 'assign'], {
      kind: 'record',
      id: a.map,
    });
    const other = await openTicket(scoped, bKey);
    expect(other.find('[data-outcome="denied"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(other.find('[data-ticket-panel]')).toBeNull();
    clean('other client page', other.text());
    const claim = await w.as(scoped, { command: 'task.claim', ...(await at(bTicket)) });
    const resolve = await w.as(scoped, {
      command: 'task.resolve',
      ...(await at(bTicket)),
      answer: 'x',
      gist: 'x',
    });
    expect(codeOf(claim)).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(resolve)).toBe('SCOPE_NOT_GRANTED');
    clean('other client writes', JSON.stringify([claim, resolve]));

    // 3. A person under a live delegation: the agent reaches no ticket bundle
    // (LEANS-ON SL09 U18, the agent credential narrowed from a person's grants).
    const picked = await w.pickUp(await w.decider('wf5-delegator'), 'ticket agent task');
    const agent = await w.agent(picked.credential);
    const delegated = await agent.run('task', 'context', bTicket);
    expect(delegated.exit).toBe(1);
    clean('delegated', delegated.out);
  });
});
