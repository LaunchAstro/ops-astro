// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-7 on the screens: a task with no title is drawn as a placeholder on the
// board and on the task page, and the propose form offers the task cap's own
// currency, read from the server, rather than a list of its own.

import { describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { mount, settle } from './mount.tsx';

const TASK_ID = '77777777-7777-4777-8777-777777777777';

function task(fields: { readonly title: string | null; readonly capCurrency?: string | null }) {
  return {
    id: TASK_ID,
    key: 'TSK-7',
    title: fields.title,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 3,
    description: null,
    history: [],
    comments: [],
    proposals: [],
    ...(fields.capCurrency === undefined ? {} : { capCurrency: fields.capCurrency }),
  };
}

function client(detail: ReturnType<typeof task>) {
  const proposed: Record<string, unknown>[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    // The inbox the board screen mounts (INB-1g), answered empty.
    if (at.endsWith('/inbox/read')) return Response.json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return Response.json({ ok: true, owed: 0 });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (at.endsWith('/task/board')) return Response.json({ ok: true, tasks: [detail] });
    if (at.endsWith('/person/list')) return Response.json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return Response.json({ ok: true, task: detail });
    if (at.endsWith('/task/propose')) {
      proposed.push(body);
      return Response.json({ recordId: TASK_ID, revision: 3, detail: { versionId: 'v-1' } });
    }
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  const operations = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-7',
  });
  return { operations, proposed };
}

describe('CQ-7 untitled placeholder', () => {
  it('draws a task with no title as "Untitled task" on the board', async () => {
    const { operations } = client(task({ title: null }));
    const view = await mount(<Projects client={operations} grantKey="alpha:ada" />);
    await settle();
    expect(view.text()).toContain('Untitled task');
    await view.unmount();
  });

  it('heads the task page of a task with no title "Untitled task"', async () => {
    const { operations } = client(task({ title: null, capCurrency: 'AUD' }));
    const view = await mount(
      <TaskDetailScreen client={operations} grantKey="alpha:ada" taskKey="TSK-7" />,
    );
    await settle();
    expect(view.find('.tpr__title')?.textContent).toBe('Untitled task');
    await view.unmount();
  });

  it('keeps a titled task as it was', async () => {
    const { operations } = client(task({ title: 'Send the renewal quote', capCurrency: 'AUD' }));
    const view = await mount(
      <TaskDetailScreen client={operations} grantKey="alpha:ada" taskKey="TSK-7" />,
    );
    await settle();
    expect(view.find('.tpr__title')?.textContent).toBe('Send the renewal quote');
    await view.unmount();
  });
});

describe('CQ-7 cap currency: the propose form', () => {
  it("offers the task cap's currency and proposes in it", async () => {
    const { operations, proposed } = client(task({ title: 'Quote', capCurrency: 'NZD' }));
    const view = await mount(
      <TaskDetailScreen client={operations} grantKey="alpha:ada" taskKey="TSK-7" />,
    );
    await settle();
    const offered = view.all('#propose-currency option').map((option) => option.textContent);
    expect(offered).toEqual(['NZD']);

    await view.type('#propose-purpose', 'client_renewal_quote');
    await view.type('#propose-maximum', '12.50');
    await view.click('[data-propose="submit"]');
    await settle();
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ currency: 'NZD', maximumMinor: 1250 });
    await view.unmount();
  });

  it('offers no currency, and does not propose, when the business has no cap', async () => {
    const { operations, proposed } = client(task({ title: 'Quote', capCurrency: null }));
    const view = await mount(
      <TaskDetailScreen client={operations} grantKey="alpha:ada" taskKey="TSK-7" />,
    );
    await settle();
    expect(view.all('#propose-currency option')).toHaveLength(0);
    expect(view.find('[data-propose="no-cap"]')).not.toBeNull();
    expect((view.find('[data-propose="submit"]') as HTMLButtonElement).disabled).toBe(true);
    await view.click('[data-propose="submit"]');
    await settle();
    expect(proposed).toHaveLength(0);
    await view.unmount();
  });
});
