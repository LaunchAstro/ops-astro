// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one case over one world */
//
// `WF-4 isolation` (#637): the three real crossings for the tickets,
// frontier and fog views and their two writes, statuses checked, canaries
// absent from every page and answer.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from '../cli/api-3-world.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { chart, openMap } from './wayfinder-web.tsx';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const codeOf = (answer: unknown): string => (answer as { code?: string }).code ?? 'applied';

describe.skipIf(serverUrl === undefined)('WF-4 isolation', () => {
  let w: CliWorld;
  let lead: Member;
  const open: Mounted[] = [];

  beforeAll(async () => {
    w = await cliWorld('wf4iso', 'wffouriso');
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

  it('WF-4 isolation', async () => {
    const a = await chart(w, lead, 'canary-wf4-A', [{ ref: 'a', title: 'A one', type: 'task' }]);
    const b = await chart(
      w,
      lead,
      'canary-wf4-B',
      [{ ref: 'b', title: 'canary-wf4-B ticket', type: 'task' }],
      ['canary-wf4-B fog'],
    );
    const bTicket = b.tickets['b'] as string;
    const scopedTo = crypto.randomUUID();
    expect(
      codeOf(await w.as(lead, { command: 'map.scope', ...(await at(b.map)), client: scopedTo })),
    ).toBe('applied');
    const clean = (what: string, text: string) => {
      for (const canary of ['canary-wf4-B', b.map, bTicket])
        expect(text, what).not.toContain(canary);
    };

    // 1. Another business: bravo's person reaches none of alpha's views, and
    // cannot name alpha's ticket as a blocker of its own.
    const bea = await w.outsider('wf4-bea');
    const bravoPage = await openMap(w, open, bea, b.key, `${w.key}-bravo`);
    expect(bravoPage.find('[data-map-refused]')?.textContent).toContain('NOT_FOUND');
    expect(bravoPage.find('[role="tab"]')).toBeNull();
    clean('bravo page', bravoPage.text());
    const own = await w.as(
      bea,
      {
        command: 'map.chart',
        title: 'bravo map',
        destination: 'bravo',
        tickets: [{ ref: 'x', title: 'bravo x', type: 'task' }],
        fog: [],
      },
      w.bravo,
    );
    const bravoTicket = (own as { detail?: { tickets?: Record<string, string> } }).detail
      ?.tickets?.['x'] as string;
    const crossed = await w.as(
      bea,
      {
        command: 'task.set_blocking',
        recordId: bravoTicket,
        expectedRevision: await w.revisionOf(bravoTicket, w.bravo),
        blockedBy: [bTicket],
      },
      w.bravo,
    );
    expect(codeOf(crossed)).toBe('NOT_FOUND');
    clean('bravo blocking', JSON.stringify(crossed));

    // 2. Another client in the same business: a person granted only map A.
    const scoped = await w.member('wf4-scoped-a', ['read', 'write'], { kind: 'record', id: a.map });
    const other = await openMap(w, open, scoped, b.key);
    expect(other.find('[data-map-refused]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(other.find('[role="tab"]')).toBeNull();
    clean('other client page', other.text());
    const patch = (
      (await w.read(lead, { read: 'map.view', recordId: b.map })) as {
        map: { fog: { id: string }[] };
      }
    ).map.fog[0]?.id;
    const graduate = await w.as(scoped, {
      command: 'map.graduate',
      ...(await at(b.map)),
      patchId: patch,
      tickets: [{ title: 'x', type: 'task' }],
    });
    expect(codeOf(graduate)).toBe('SCOPE_NOT_GRANTED');
    const blockAcross = await w.as(scoped, {
      command: 'task.set_blocking',
      ...(await at(a.tickets['a'] as string)),
      blockedBy: [bTicket],
    });
    expect(['NOT_FOUND', 'SCOPE_NOT_GRANTED']).toContain(codeOf(blockAcross));
    clean('other client writes', JSON.stringify([graduate, blockAcross]));

    // 3. A person under a live delegation: the agent reaches no frontier
    // (LEANS-ON SL09 U18, the agent credential narrowed from a person's grants).
    const picked = await w.pickUp(await w.decider('wf4-delegator'), 'frontier agent task');
    const agent = await w.agent(picked.credential);
    const delegated = await agent.run('map', 'frontier', b.map);
    expect(delegated.exit).toBe(1);
    clean('delegated', delegated.out);
  });
});
