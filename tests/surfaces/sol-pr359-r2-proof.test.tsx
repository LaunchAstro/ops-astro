// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { Component, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { RunProgress } from '../../apps/web/src/views/run-progress.tsx';
import { madeUpAnswer } from '../visual/made-up-api.ts';
import { EXECUTION } from '../visual/made-up-data.ts';
import { DETAIL } from '../visual/made-up-rows.ts';
import { mount } from './mount.tsx';
import { gate, mountMap, run, step, tick } from './mp-6-3-fixture.tsx';

it('Sol proof, criterion 2: client to client on the task page never commits the preceding execution map', async () => {
  const destination = { ...DETAIL, key: 'T-2', client: 'c-meridian' };
  expect(DETAIL.client).toBe('c-harbour');
  expect(destination.client).not.toBe(DETAIL.client);
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input, init) => {
      const path = new URL(String(input), 'http://made.up').pathname;
      if (path.endsWith('/task/read') && String(init?.body).includes(destination.key))
        return new Promise<Response>(() => {});
      const answer = madeUpAnswer(path);
      return Promise.resolve(
        answer !== undefined && 'json' in answer
          ? Response.json(answer.json, { status: answer.status })
          : new Response(null, { status: 503 }),
      );
    },
  });
  const commits: { readonly taskKey: string; readonly hasMap: boolean }[] = [];
  function Host({ taskKey }: { readonly taskKey: string }): ReactElement {
    const host = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      commits.push({
        taskKey,
        hasMap:
          host.current !== null &&
          host.current.querySelector('[data-execution-map="bound"]') !== null,
      });
    });
    return (
      <div ref={host}>
        <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey={taskKey} />
      </div>
    );
  }
  const page = await mount(<Host taskKey="T-1" />);
  try {
    await tick();
    expect(page.find('[data-execution-map="bound"]')).not.toBeNull();
    await page.render(<Host taskKey={destination.key} />);
    expect(commits.filter((commit) => commit.taskKey === 'T-2' && commit.hasMap)).toEqual([]);
    expect(page.find('[data-execution-map]')).toBeNull();
  } finally {
    await page.unmount();
  }
});

it('Sol proof, criterion 5: a newer superseded run cannot satisfy dependencies using an older approved gate', async () => {
  const page = await mountMap(
    {
      plan: 'bound',
      steps: [step('draft', [], ['r-1']), step('review', [], ['r-2']), step('send', ['draft'])],
      nodes: [run('r-1', 'superseded'), run('r-2', 'not_started')],
    },
    [gate('r-1', 'approved')],
  );
  try {
    expect(page.find('[data-tg-node="draft"] .spill')?.textContent).toBe('Superseded');
    expect(page.find('[data-tg-node="send"] [data-map="dependency"]')?.textContent).toBe(
      'Waiting on draft',
    );
    expect(page.all('.tg__edge--wait')).toHaveLength(1);
    expect(page.find('[data-tg-node="draft"] .tg__nout')?.textContent).not.toBe('OUT Done');
  } finally {
    await page.unmount();
  }
});

class Boundary extends Component<{ readonly children: ReactNode }, { readonly crashed: boolean }> {
  override state = { crashed: false };
  static getDerivedStateFromError(): { readonly crashed: boolean } {
    return { crashed: true };
  }
  override render(): ReactNode {
    return this.state.crashed ? <p data-crashed="">Render failed</p> : this.props.children;
  }
}

it('Sol proof, criterion correctness: a malformed successful execution graph remains a section error', async () => {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () =>
      Promise.resolve(
        Response.json({
          ok: true,
          execution: {
            ...EXECUTION.execution,
            outcome: 'no-run',
            runs: [],
            events: [],
            graph: { plan: 'unbound' },
          },
        }),
      ),
  });
  const page = await mount(
    <Boundary>
      <RunProgress client={client} grantKey="alpha:ada" taskKey="T-1" readOf={1} />
    </Boundary>,
  );
  try {
    await tick();
    expect(page.find('[data-crashed]')).toBeNull();
    expect(page.find('[data-run="unavailable"] .banner--bad')).not.toBeNull();
  } finally {
    await page.unmount();
  }
});
