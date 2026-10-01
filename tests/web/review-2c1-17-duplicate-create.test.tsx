// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-17 red proof: one draft can be created twice. While a Create is
// still in flight the draft's Close stays enabled
// (apps/web/src/screens/task/DraftPanel.tsx), the create's identity lives only
// in the panel's state (`kept.attempt ?? props.client.newOperationId()`), and
// the kept draft is dropped only after the create answers. Close, open a task,
// press New task, and the dock (DockPanel.tsx) draws a fresh draft panel from
// the kept draft with no attempt: a second Create sends a second
// /task/create under a new operationId, and each runs the draft's parts, so
// the time is logged twice. Passes once a Create in flight cannot be
// abandoned into a second one (Close held while busy, the attempt kept with
// the draft, or the draft dropped before the await): one create identity and
// one /time/log.

import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { useDockPanel } from '../../apps/web/src/screens/task/DockPanel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';
import { NEW_ID, NEW_KEY, store, type Sent } from './draft-support.tsx';

afterEach(unmountAll);

/** A server whose top-level /task/create answers only when released; every other path at once. */
function held() {
  const sent: Sent[] = [];
  const waiting: (() => void)[] = [];
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
    if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task() }));
    if (where.endsWith('/tag/list')) return Promise.resolve(json({ ok: true, tags: [] }));
    const to = where.slice(where.search(/\/[a-z]+\/[a-z_]+$/u));
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/task/create' && body['parentId'] === undefined) {
      return new Promise<Response>((resolve) => {
        waiting.push(() => {
          resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
        });
      });
    }
    return Promise.resolve(json({ recordId: NEW_ID, revision: 2, detail: {} }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent,
    release: (): void => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

/** The dock as the application holds it, with a door that opens a task in it. */
function Dock(props: {
  readonly client: OperationsClient;
  readonly storage: Storage;
}): ReactElement {
  const [session] = useState({ businessKey: 'alpha', email: 'ada@example.test' });
  const dock = useDockPanel({
    client: props.client,
    grantKey: 'alpha:member',
    session,
    storage: props.storage,
  });
  return (
    <div>
      <button
        type="button"
        data-host="open"
        onClick={() => {
          dock.host.open('Proj-Verity-Pacing', 'open');
        }}
      >
        open
      </button>
      {dock.panel}
    </div>
  );
}

describe('REVIEW-2C1-17 one draft, one task', () => {
  it('REVIEW-2C1-17: closing a draft mid-Create and creating it again from New task makes a second task and logs its time twice', async () => {
    const { client, sent, release } = held();
    const view = await mount(<Dock client={client} storage={store()} />);
    const newTask = async (): Promise<void> => {
      await view.click('[data-host="open"]');
      await tick();
      await view.click('[data-panel-head="new"]');
      await tick();
      expect(view.find('[data-draft-panel]')).not.toBeNull();
    };

    await newTask();
    await typeInto(view, '#panel-draft-name', 'New brief');
    await typeInto(view, '#panel-draft-time', '30m');
    await view.click('[data-draft="create"]');
    await tick();
    expect(sent.filter((one) => one.to === '/task/create')).toHaveLength(1);

    // Still in flight: Close, open a task, New task, Create.
    await view.click('[data-draft="close"]');
    await tick();
    await newTask();
    await view.click('[data-draft="create"]');
    await tick();

    release();
    for (let settle = 0; settle < 12; settle += 1) {
      // eslint-disable-next-line no-await-in-loop -- the chain is one request at a time
      await tick();
    }
    const creates = sent.filter(
      (one) => one.to === '/task/create' && one.body['parentId'] === undefined,
    );
    const identities = new Set(creates.map((one) => one.body['operationId']));
    expect(identities.size, 'one draft was sent as two creates under two operationIds').toBe(1);
    expect(
      sent.filter((one) => one.to === '/time/log'),
      'the draft’s time was logged once per create',
    ).toHaveLength(1);
  });
});
