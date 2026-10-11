// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactElement } from 'react';
import type { StepView } from '../../packages/core-wire/src/index.ts';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TASK_ID } from './task-page-stub.tsx';
import { json, mount } from './perspective-support.tsx';
interface Sent {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Records each command; answers every one as applied. */
export function commands(wait?: (command: string) => Promise<void>) {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const command = at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.');
    sent.push({
      command,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'],
    });
    return (wait?.(command) ?? Promise.resolve()).then(() =>
      json({
        ok: true,
        recordId: 'new',
        revision: 4,
        ...(command === 'task.trash' ? { detail: { batchId: 'batch-one', trashed: 3 } } : {}),
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent };
}

/** The list under a parent that rereads on change: it redraws the server's next steps. */
export async function list(client: OperationsClient, steps: readonly StepView[], next = steps) {
  const counter = { rereads: 0 };
  function Parent(): ReactElement {
    const [shown, setShown] = useState(steps);
    const [open, setOpen] = useState(false);
    return (
      <SubtaskList
        client={client}
        parentId={TASK_ID}
        steps={shown}
        showFinished={open}
        onShowFinished={setOpen}
        onChanged={() => {
          counter.rereads += 1;
          setShown(next);
        }}
      />
    );
  }
  const view = await mount(<Parent />);
  return { view, rereads: () => counter.rereads };
}
