// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's S2494-1 on #2494: a time note saved with Enter while an earlier save
// is still out sends nothing, so it must not take that save's held operation
// id either. When the earlier answer is then lost after the server stored it,
// its words sent again go under its own id, and the server replays what it
// stored.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import { mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const ENTRY = {
  id: 'a',
  startedAt: '2026-09-30T01:00:00.000Z',
  endedAt: '2026-09-30T02:00:00.000Z',
  minutes: 60,
  note: 'Original',
  adHoc: false,
  source: 'log',
} as const;

const BOX = 'input[data-time-note-edit]';

/** A fetch whose first note save is stored, then its answer lost when `lose` is called. */
function firstAnswerLost() {
  const sent: { readonly note: unknown; readonly id: unknown }[] = [];
  let loseFirst: (() => void) | undefined;
  const fetch = ((_url: string, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    sent.push({ note: body['note'], id: body['operationId'] });
    if (sent.length === 1) {
      // Stored by the server, then the answer is lost.
      return new Promise<Response>((_resolve, reject) => {
        loseFirst = () => {
          reject(new TypeError('Failed to fetch'));
        };
      });
    }
    return Promise.resolve(
      new Response(JSON.stringify({ recordId: 'a', revision: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const lose = (): void => loseFirst?.();
  return { sent, lose, fetch };
}

it('an Enter ignored while a note save is out keeps that save’s id for its retry', async () => {
  const { sent, lose, fetch } = firstAnswerLost();
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const view = await mount(
    <TimeLog
      client={client}
      taskId="task"
      time={{ entries: [ENTRY], running: null, totalMinutes: 60 }}
      estimateMinutes={null}
      showAll={false}
      onShowAll={() => {}}
      onChanged={() => {}}
    />,
  );
  await view.click('[data-time-note="a"]');
  await typeInto(view, BOX, 'First note');
  await press(view, BOX, 'Enter');
  await tick();
  await typeInto(view, BOX, 'Second note');
  await press(view, BOX, 'Enter');
  await tick();
  expect(sent, 'the Enter while busy sends nothing').toHaveLength(1);
  await typeInto(view, BOX, 'First note');
  await act(async () => {
    lose();
    await Promise.resolve();
  });
  await tick();
  await press(view, BOX, 'Enter');
  await tick();
  expect(sent.map((one) => one.note)).toStrictEqual(['First note', 'First note']);
  expect(sent[1]?.id, 'the lost save goes again under its own id').toBe(sent[0]?.id);
});
