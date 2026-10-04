// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3's shared fixture: a bound plan, its runs' observed layers and their
// gates, drawn either through the task page's real wiring (`task.execution`
// and `task.read` answered from the made-up set) or as the map alone.

import { act } from 'react';
import {
  ExecutionMap,
  type MapGate,
  type MapGraph,
  type MapNode,
} from '../../packages/ui/src/index.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { madeUpAnswer } from '../visual/made-up-api.ts';
import { EXECUTION } from '../visual/made-up-data.ts';
import { mount, type Mounted } from './mount.tsx';

export const tick = async (): Promise<void> => {
  await act(async () => {
    for (let n = 0; n < 4; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- let each read settle in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

export const run = (
  nodeId: string,
  condition: string,
  over: Partial<MapNode['observed']> = {},
): MapNode => ({
  nodeId,
  condition,
  planned: null,
  observed: {
    condition,
    runState: 'planned',
    whoseMove: null,
    outcome: null,
    fault: null,
    lease: null,
    effectObserved: false,
    heldMinor: null,
    spentMinor: null,
    currency: 'AUD',
    ...over,
  },
});

export const step = (key: string, after: readonly string[], runIds: readonly string[] = []) => ({
  key,
  title: `The ${key} step`,
  after,
  runIds,
});

export const gate = (runId: string, state: string, version = 1): MapGate => ({
  runId,
  state,
  version,
  digest: `sha256:${'7c41e8f9a2d6b391'.repeat(4)}`,
});

export async function mountMap(graph: MapGraph, gates: readonly MapGate[] = []): Promise<Mounted> {
  return await mount(<ExecutionMap graph={graph} gates={gates} />);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The task page on the made-up T-1, its execution answered with `graph` (the harness's by default). */
export async function openPage(graph: unknown = EXECUTION.execution.graph): Promise<Mounted> {
  const answer = (at: string): Response => {
    const path = new URL(at, 'http://made.up').pathname;
    if (path.endsWith('/task/execution')) {
      return json({ ok: true, execution: { ...EXECUTION.execution, graph } });
    }
    const made = madeUpAnswer(path);
    if (made === undefined || 'pending' in made)
      return json({ refused: true, code: 'NOT_FOUND' }, 404);
    return json(made.json, made.status);
  };
  const fetch = ((url: string | URL) =>
    Promise.resolve(answer(String(url)))) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  const page = await mount(<TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="T-1" />);
  await tick();
  return page;
}
