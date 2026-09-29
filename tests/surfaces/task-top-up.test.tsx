// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T2e, the top-up control on the task page: the app's leg of
// `top_up_is_a_persons`. The page draws the task's envelope as `task.read`
// carried it, and the control sends `budget.top_up` with the figure the person
// was looking at, so a top-up is always of the envelope that was on the
// screen. A first approval above the band says a second person is needed; a
// refusal is quoted as the server said it; every outcome reads the task again.
// A task read carrying no envelope offers no control.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK_ID = '44444444-4444-4444-8444-444444444444';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Options {
  readonly envelope?: boolean;
  readonly answer?: 'applied' | 'awaiting' | 'refused';
  readonly reloadWait?: Promise<void>;
}

function server(options: Options = {}) {
  const envelope = {
    id: 'env-1',
    maximumMinor: 250_000,
    heldMinor: 0,
    actualMinor: 180_000,
    currency: 'AUD',
  };
  const task: Record<string, unknown> = {
    id: TASK_ID,
    key: 'TSK-41',
    title: 'A task with an approved plan',
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
    ...(options.envelope === false ? {} : { envelope }),
  };
  const reads: number[] = [];
  const sent: Record<string, unknown>[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) {
      reads.push(reads.length + 1);
      if (reads.length > 1) await options.reloadWait;
      return json({ ok: true, task });
    }
    if (at.endsWith('/budget/top_up')) {
      sent.push(body);
      if (options.answer === 'refused') {
        return json(
          {
            refused: true,
            code: 'FOUR_EYES_REQUIRED',
            names: [],
            fixes: ['A second person holding budget permission approves this top-up.'],
          },
          409,
        );
      }
      if (options.answer === 'awaiting') {
        return json({
          recordId: TASK_ID,
          revision: null,
          detail: { state: 'awaiting_second_approver', amountMinor: body['amountMinor'] },
        });
      }
      envelope.maximumMinor += Number(body['amountMinor']);
      return json({ recordId: TASK_ID, revision: null, detail: { state: 'applied' } });
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
  return { client, reads, sent };
}

const screenFor = (client: OperationsClient) => (
  <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-41" />
);

describe('the top-up control on the task page', () => {
  it('draws the envelope and tops up the figure on the screen', async () => {
    const { client, reads, sent } = server();
    const page = await mount(screenFor(client));
    await tick();

    const line = page.find('[data-top-up="envelope"]')?.textContent ?? '';
    expect(line).toContain('2,500.00');
    expect(line).toContain('1,800.00');

    await page.type('#top-up-amount', '10');
    await page.click('[data-top-up="submit"]');
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      recordId: TASK_ID,
      amountMinor: 1_000,
      fromMaximumMinor: 250_000,
    });
    expect(reads.length).toBeGreaterThan(1);
    expect(page.find('[data-top-up="envelope"]')?.textContent).toContain('2,510.00');
    await page.unmount();
  });

  it('says a second approver is needed when the first approval is above the band', async () => {
    const { client } = server({ answer: 'awaiting' });
    const page = await mount(screenFor(client));
    await tick();
    await page.type('#top-up-amount', '600');
    await page.click('[data-top-up="submit"]');
    await tick();
    expect(page.find('[data-top-up="awaiting"]')?.textContent).toContain('second');
    await page.unmount();
  });

  it('Sol proof, criterion 2: a pending second approval remains visible after the task reread', async () => {
    let finishReload!: () => void;
    const reloadWait = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    const { client, reads } = server({ answer: 'awaiting', reloadWait });
    const page = await mount(screenFor(client));
    await tick();
    await page.type('#top-up-amount', '600');
    await page.click('[data-top-up="submit"]');
    await tick();
    expect(reads.length).toBeGreaterThan(1);
    finishReload();
    await tick();
    expect(page.find('[data-top-up="awaiting"]')?.textContent ?? '').toContain('second');
    await page.unmount();
  });

  it('quotes a refusal as the server said it', async () => {
    const { client } = server({ answer: 'refused' });
    const page = await mount(screenFor(client));
    await tick();
    await page.type('#top-up-amount', '600');
    await page.click('[data-top-up="submit"]');
    await tick();
    expect(page.find('[data-top-up="refusal"]')?.textContent).toContain(
      'A second person holding budget permission approves this top-up.',
    );
    await page.unmount();
  });

  it('offers no control when the read carried no envelope', async () => {
    const { client } = server({ envelope: false });
    const page = await mount(screenFor(client));
    await tick();
    expect(page.find('[data-top-up="submit"]')).toBeNull();
    await page.unmount();
  });
});
