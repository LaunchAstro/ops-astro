// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { TaskTimeView } from '../../packages/core-wire/src/index.ts';
import {
  TaskTimerProvider,
  useTimerRead,
  useTimerState,
} from '../../apps/web/src/screens/task/task-timer-context.tsx';
import { TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TASK_ID, found as foundTask } from './task-page-stub.tsx';
import { json, mount } from './perspective-support.tsx';

interface Sent {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Records each command; answers every one as applied. */
function commands(time: TaskTimeView) {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const command = at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    if (command === 'task.read') return Promise.resolve(json(foundTask({ time })));
    sent.push({ command, body });
    return Promise.resolve(
      json({
        ok: true,
        recordId: null,
        revision: null,
        detail: { entryId: 'e-run', startedAt: '2026-09-30T01:00:00.000Z' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent };
}

/** The section under a parent that rereads on change, redrawing the server's next time. */
export async function section(
  time: TaskTimeView,
  next: TaskTimeView = time,
  estimate: number | null = null,
) {
  const { client, sent } = commands(time);
  const counter = { rereads: 0 };
  function Parent(): ReactElement {
    const [shown, setShown] = useState(time);
    const [all, setAll] = useState(false);
    const read = useTimerRead(client, TASK_ID);
    const { state } = useTimerState();
    const last = useRef(state.changed);
    useEffect(() => {
      void read.run();
    }, []);
    useEffect(() => {
      if (last.current === state.changed) return;
      last.current = state.changed;
      counter.rereads += 1;
      setShown(next);
    }, [state.changed]);
    return (
      <TimeLog
        client={client}
        taskId={TASK_ID}
        time={shown}
        estimateMinutes={estimate}
        showAll={all}
        onShowAll={setAll}
        onChanged={() => {
          counter.rereads += 1;
          setShown(next);
        }}
      />
    );
  }
  const view = await mount(
    <TaskTimerProvider client={client} grantKey="time-section">
      <Parent />
    </TaskTimerProvider>,
  );
  return { view, sent, rereads: () => counter.rereads };
}
