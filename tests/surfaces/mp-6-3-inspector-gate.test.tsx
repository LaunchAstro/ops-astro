// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { useLayoutEffect, useRef } from 'react';
import { expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { ExecutionMap } from '../../packages/ui/src/index.ts';
import { madeUpAnswer } from '../visual/made-up-api.ts';
import { EXECUTION } from '../visual/made-up-data.ts';
import { mount } from './mount.tsx';
import { gate, mountMap, run, step, tick } from './mp-6-3-fixture.tsx';

const graph = (condition: string, outcome: string | null) => ({
  plan: 'bound' as const,
  steps: [step('draft', [], ['r-1']), step('send', ['draft'])],
  nodes: [run('r-1', condition, { outcome })],
});

const privateExecution = {
  ...EXECUTION,
  execution: {
    ...EXECUTION.execution,
    graph: {
      ...EXECUTION.execution.graph,
      steps: [step('private-step', [], ['private-run'])],
      nodes: [
        run('private-run', 'in_progress', {
          fault: 'Client A private fault',
          heldMinor: 12345,
        }),
      ],
    },
  },
};

it('the inspector stops arming an older pending gate when a newer execution read completes the run', async () => {
  const gates = [gate('r-1', 'pending', 3)];
  const page = await mountMap(graph('not_started', null), gates);
  try {
    expect(page.find('[data-map="detail"] .gate--armed')).not.toBeNull();
    // task.read's gate snapshot is unchanged; task.execution finishes later.
    await page.render(<ExecutionMap graph={graph('settled', 'completed')} gates={gates} />);
    expect(page.find('[data-tg-node="draft"] .spill')?.textContent).toBe('Done');
    expect(page.find('[data-map="detail"] [data-map-fact="Runs"]')?.textContent).toContain(
      'settled, completed',
    );
    expect(page.find('[data-map="detail"] .gate--armed')).toBeNull();
  } finally {
    await page.unmount();
  }
});

it('client to client task-page navigation never commits the preceding client inspector under the new task', async () => {
  let pending = false;
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = new URL(String(input), 'http://made.up').pathname;
    if (pending) return await new Promise<Response>(() => {});
    if (path.endsWith('/task/execution')) return Response.json(privateExecution);
    const answer = madeUpAnswer(path);
    return answer !== undefined && 'json' in answer
      ? Response.json(answer.json, { status: answer.status })
      : new Response(null, { status: 503 });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const committed: { readonly taskKey: string; readonly inspector: string }[] = [];
  function Page(props: { readonly taskKey: string }) {
    const host = useRef<HTMLDivElement>(null);
    // Observe the actual committed DOM before passive useRead effects reset it.
    useLayoutEffect(() => {
      committed.push({
        taskKey: props.taskKey,
        inspector: host.current?.querySelector('[data-map="detail"]')?.textContent ?? '',
      });
    });
    return (
      <div ref={host}>
        <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey={props.taskKey} />
      </div>
    );
  }
  const page = await mount(<Page taskKey="T-1" />);
  try {
    await tick();
    expect(page.find('[data-map="detail"]')?.textContent).toContain('Client A private fault');
    pending = true;
    await page.render(<Page taskKey="CLIENT-B-TASK" />);
    expect(committed.filter((one) => one.taskKey === 'CLIENT-B-TASK')).not.toHaveLength(0);
    expect(
      committed.filter((one) => one.taskKey === 'CLIENT-B-TASK').map((one) => one.inspector),
    ).not.toEqual(expect.arrayContaining([expect.stringContaining('Client A private fault')]));
  } finally {
    await page.unmount();
  }
});
