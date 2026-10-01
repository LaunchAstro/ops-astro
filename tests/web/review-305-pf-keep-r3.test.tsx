// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// review/305-pf-keep security review, round 3. S1 in the panel: a due date
// picker opened before a colleague's change sends the day at the revision it
// opened at. S2: a draft part whose answer never came is not reported as
// missing; Create stops there and the next Create sends that part again under
// its own id, so the server replays it. S3: typing on after an own save sends
// the next save at the revision the save answered, not a stale one.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { DescriptionField } from '../../apps/web/src/screens/task/Writing.tsx';
import { TASK_ID, task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';
import { NEW_ID, NEW_KEY, create, draft, store, type Sent } from './draft-support.tsx';
import { blur, field, settleWrites } from './writing-support.tsx';

afterEach(unmountAll);

const ignore = (): void => {
  /* unread */
};

/** The panel's task at revision 4, then at 5 after a colleague's change; every update recorded. */
function panelServer() {
  let reads = 0;
  const updates: Record<string, unknown>[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (/\/live(\/task\/|\?|$)/u.test(where)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    // The panel's Project field (SL08) reads the Projects board.
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (where.endsWith('/task/read')) {
      reads += 1;
      const answer = task({ revision: reads === 1 ? 4 : 5 });
      return Promise.resolve(json({ ok: true, task: answer }));
    }
    if (where.endsWith('/task/update')) {
      updates.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
      );
    }
    return Promise.resolve(json({ recordId: 'r', revision: 6 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    updates,
  };
}

const Panel = (props: { readonly client: OperationsClient; readonly changes: number }) => (
  <TaskPanel
    client={props.client}
    grantKey="alpha:member"
    opening={{ taskKey: 'Proj-Verity-Pacing', door: 'open', tab: null }}
    changes={props.changes}
    onChanged={ignore}
    onClose={ignore}
  />
);

/** The task and its subtask land; the first time.log gets no answer, the next one does. */
function draftServer() {
  const sent: Sent[] = [];
  let logs = 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/task/create' && body['parentId'] === undefined) {
      return Promise.resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
    }
    if (to === '/time/log') {
      logs += 1;
      if (logs === 1) return Promise.reject(new TypeError('network down'));
    }
    return Promise.resolve(json({ recordId: 's-1', revision: 2, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent: (to: string, parent = false): Sent[] =>
      sent.filter((one) => one.to === to && (one.body['parentId'] !== undefined) === parent),
  };
}

describe('the panel due date', () => {
  it('S1: a panel due date picked in a picker opened before a colleague changed the task is sent at the revision it opened at', async () => {
    const { client, updates } = panelServer();
    const view = await mount(<Panel client={client} changes={0} />);
    await tick();
    await view.click('[data-panel-field="due"]');
    await view.render(<Panel client={client} changes={1} />);
    await tick();
    expect((view.find('[data-task]') as HTMLElement | null)?.dataset['revision']).toBe('5');
    const day = view.all('[data-date-picker] [data-day]')[10];
    expect(day).toBeDefined();
    await view.click(
      `[data-date-picker] [data-day="${(day as HTMLElement | null)?.dataset['day'] ?? ''}"]`,
    );
    await tick();
    expect(updates).toHaveLength(1);
    expect(
      updates[0]?.['expectedRevision'],
      "the day was sent at the re-read's revision, over the colleague's change",
    ).toBe(4);
  });
});

describe('Create parts and own saves', () => {
  it('S2: a part with no answer is sent again under its own id by the next Create, never reported missing', async () => {
    const api = draftServer();
    const opened = await draft({ client: api.client, storage: store() });
    await typeInto(opened.view, '#panel-draft-name', 'New brief');
    await typeInto(opened.view, '#panel-draft-time', '30m');
    await create(opened.view);
    expect(opened.view.find('[data-draft-missed]'), 'the time was reported not added').toBeNull();
    expect(opened.outcome.created).toBeNull();
    await create(opened.view);
    const logs = api.sent('/time/log').map((one) => one.body['operationId']);
    expect(logs).toHaveLength(2);
    expect(logs[1], 'the second Create logged the time under a new id').toBe(logs[0]);
    expect(opened.outcome.created).toBe(NEW_KEY);
  });

  it('S3: typing on after an own save sends the next save at the revision the save answered', async () => {
    const { sent, client, onSaved } = field();
    const at = 'textarea[data-writing="description"]';
    const view = await mount(
      <DescriptionField
        client={client}
        recordId={TASK_ID}
        revision={4}
        value="old"
        onSaved={onSaved}
      />,
    );
    await typeInto(view, at, 'First.');
    await blur(view, at);
    await settleWrites();
    await typeInto(view, at, 'First. Second.');
    await blur(view, at);
    await settleWrites();
    expect(sent.map((one) => one['expectedRevision'])).toStrictEqual([4, 5]);
  });
});
