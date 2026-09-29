// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T2h on the task page: the alerts `task.read` carries are drawn, each in the
// words for its transition, newest first as the read ordered them. An answer
// with no `alerts` key draws no section; an empty list says there are none.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from '../surfaces/mount.tsx';

const TASK_ID = '44444444-4444-4444-8444-444444444444';

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let n = 0; n < 3; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function page(extra: Record<string, unknown>) {
  const task = {
    id: TASK_ID,
    key: 'TSK-4',
    title: 'Alerted task',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 3,
    history: [],
    comments: [],
    proposals: [],
    ...extra,
  };
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return (
    <TaskDetailScreen
      client={new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch })}
      grantKey="alpha:member"
      taskKey={TASK_ID}
    />
  );
}

const alert = (kind: string, waitingReason: string | null, id: string) => ({
  id,
  taskId: TASK_ID,
  kind,
  waitingReason,
  causeId: '55555555-5555-4555-8555-555555555555',
  raisedAt: '2026-09-29T04:00:00.000Z',
});

describe('alerts on the task page', () => {
  it('draws each alert in the words for its transition', async () => {
    const shown = await mount(
      page({
        alerts: [
          alert('awaiting_person', 'liability_unknown', 'a4'),
          alert('awaiting_person', 'needs_approval', 'a3'),
          alert('cancelled', null, 'a2'),
          alert('settled', null, 'a1'),
        ],
      }),
    );
    await tick();

    const rows = shown.all('[data-alert-kind]');
    expect(rows.map((row) => (row as HTMLElement).dataset['alertKind'])).toStrictEqual([
      'awaiting_person',
      'awaiting_person',
      'cancelled',
      'settled',
    ]);
    expect(rows[0]?.textContent).toContain('A person records this attempt’s outcome');
    expect(rows[1]?.textContent).toContain('A person decides the next version');
    expect(rows[2]?.textContent).toContain('Cancelled');
    expect(rows[3]?.textContent).toContain('Settled');
    await shown.unmount();
  });

  it('says there are none for an empty list, and draws no section when the read carried none', async () => {
    const empty = await mount(page({ alerts: [] }));
    await tick();
    expect(empty.find('[data-alerts="none"]')).not.toBeNull();
    await empty.unmount();

    const absent = await mount(page({}));
    await tick();
    expect(absent.find('[data-alerts]')).toBeNull();
    await absent.unmount();
  });
});
