// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from 'vitest';
import type { ProjectRow } from '../../packages/ui/src/index.ts';
import { ReviewOverview } from '../../apps/web/src/screens/projects/ReviewOverview.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TASK_ID, task, tick } from './task-page-stub.tsx';
import { gated, json, mount, open, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);
const row: ProjectRow = {
  id: TASK_ID,
  key: 'Proj-Verity-Pacing',
  name: 'Budget pacing fix',
  rank: { number: null, calc: '' },
  starred: false,
  client: 'Example Client',
  assignee: null,
  due: '2026-10-28',
  completed: false,
  stage: null,
  status: 'Awaiting approval',
  statusPosition: 1,
  waitReason: null,
  category: 'Paid ads',
  awaitingDecision: true,
  estimate: { kind: 'time', minutes: 60 },
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
};
const snapshot = {
  ok: true as const,
  tasks: [],
  withheld: 0,
  changedAt: null,
  viewer: 'viewer',
  owed: 0,
};
function reader(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = (url) => {
    calls.push(String(url));
    return Promise.resolve(json(body, status));
  };
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    calls,
  };
}

it('shows admitted data and opens existing doors without an approval write', async () => {
  const { client, calls } = reader({
    ok: true,
    task: task({
      description: 'Enquiries are falling.',
      proposals: [open('draft')],
      client: 'client-a',
    }),
  });
  const doors: string[] = [];
  const view = await mount(
    <ReviewOverview
      rows={[row]}
      client={client}
      grantKey="alpha:member"
      changes={0}
      snapshot={snapshot}
      taskPanel={{
        changes: 0,
        open: (key, door, tab) => doors.push(`${key}:${door}${tab === undefined ? '' : `:${tab}`}`),
      }}
    />,
  );
  await tick();
  expect(view.text()).toContain('1 waiting on you. 1 proposed.');
  expect(view.text()).toContain('Enquiries are falling.');
  expect(view.text()).toContain('Est 1h');
  expect(view.find('.rq__lead a')?.getAttribute('href')).toContain('client=client-a');
  await view.click('.rec__respond button:nth-child(1)');
  await view.click('.rec__respond button:nth-child(2)');
  await view.click('.rec__respond button:nth-child(3)');
  expect(doors).toEqual([
    'Proj-Verity-Pacing:agent',
    'Proj-Verity-Pacing:reply:all',
    'Proj-Verity-Pacing:agent',
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/\/task\/read$/u);
});

it('does not count an expired gate as proposed or offer approval', async () => {
  const { client } = reader({
    ok: true,
    task: task({ proposals: [gated('stale', { state: 'pending', expired: true })] }),
  });
  const view = await mount(
    <ReviewOverview
      rows={[row]}
      client={client}
      grantKey="alpha:member"
      changes={0}
      snapshot={snapshot}
      taskPanel={undefined}
    />,
  );
  await tick();
  expect(view.text()).not.toContain('1 proposed');
  expect(view.text()).toContain('no longer has an open decision');
  expect(view.find('.rec__respond button')?.hasAttribute('disabled')).toBe(true);
});

it('withdraws prior details when a new grant refuses the read', async () => {
  const first = reader({
    ok: true,
    task: task({ description: 'Private description', proposals: [open('draft')] }),
  });
  const denied = reader(
    { refused: true, code: 'NOT_FOUND', names: ['task'], fixes: ['check the address'] },
    404,
  );
  const view = await mount(
    <ReviewOverview
      rows={[row]}
      client={first.client}
      grantKey="alpha:member"
      changes={0}
      snapshot={snapshot}
      taskPanel={undefined}
    />,
  );
  await tick();
  expect(view.text()).toContain('Private description');
  await view.render(
    <ReviewOverview
      rows={[row]}
      client={denied.client}
      grantKey="beta:member"
      changes={0}
      snapshot={snapshot}
      taskPanel={undefined}
    />,
  );
  expect(view.text()).not.toContain('Private description');
  await tick();
  expect(view.find('[role="alert"]')).not.toBeNull();
  expect(view.find('.rec__respond button')?.hasAttribute('disabled')).toBe(true);
  expect(view.text()).not.toContain('1 proposed');
});

it('refreshes the overview on a new board read even when the task revision is unchanged', async () => {
  const proposal = open('copy');
  const staged = {
    ...proposal,
    versions: proposal.versions.map((version) =>
      Object.assign({}, version, {
        evidence: {
          digest: 'digest',
          body: { staged: { kind: 'diff', where: 'Hero', was: 'Before', will: 'After' } },
        },
      }),
    ),
  };
  let current = task({ description: 'First description', proposals: [staged] });
  const fetch: typeof globalThis.fetch = () => Promise.resolve(json({ ok: true, task: current }));
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const view = await mount(
    <ReviewOverview
      rows={[row]}
      client={client}
      grantKey="alpha:member"
      changes={0}
      snapshot={snapshot}
      taskPanel={undefined}
    />,
  );
  await tick();
  expect(view.text()).toContain('1 built and staged');
  current = task({ description: 'Updated description', proposals: [] });
  await view.render(
    <ReviewOverview
      rows={[row]}
      client={client}
      grantKey="alpha:member"
      changes={0}
      snapshot={{ ...snapshot }}
      taskPanel={undefined}
    />,
  );
  await tick();
  expect(view.text()).toContain('Updated description');
  expect(view.text()).not.toContain('First description');
  expect(view.text()).not.toContain('1 built and staged');
});
