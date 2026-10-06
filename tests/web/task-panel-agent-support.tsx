// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel on its Agent side, over a stand-in for the HTTP
// boundary that records each command it is sent: shared by the panel's
// Agent-side cases.

import type { ReactElement } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { json, mount } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';

export const KEY = 'Proj-Verity-Pacing';
export const AGENT = '#panel-perspective-panel-agent';
export const PANE = `${AGENT} [data-section="agent"]`;

const ignore = (): void => {
  /* The case reads nothing from this call. */
};

interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** A refusal a command path answers with, in place of storing. */
interface Refused {
  readonly code: string;
  readonly names?: readonly string[];
}

/**
 * A server answering one task with `over`, recording every command by its
 * path, and refusing each path `refusals` names.
 */
export function serving(
  over: Readonly<Record<string, unknown>>,
  refusals: Readonly<Record<string, Refused>> = {},
  persons: readonly { readonly personId: string; readonly name: string }[] = [],
) {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task(over) }));
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons }));
    // The drawer's planning allowance (AW-04): none to show here.
    if (where.endsWith('/conversation/allowance'))
      return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (where.endsWith('/preference/read'))
      return Promise.resolve(json({ ok: true, preferences: {} }));
    if (where.endsWith('/client/list')) return Promise.resolve(json({ ok: true, clients: [] }));
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (/\/live(\/task\/|\?|$)/u.test(where))
      return Promise.resolve(new Response(null, { status: 404 }));
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    const to = where.slice(where.indexOf('/', where.indexOf('/api/b/') + 7));
    sent.push({ to, body });
    const refused = refusals[to];
    if (refused !== undefined) {
      const { code, names = [] } = refused;
      return Promise.resolve(json({ refused: true, code, names, fixes: [] }, 403));
    }
    return Promise.resolve(json({ ok: true, recordId: 'r', revision: 5 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent,
  };
}

/** The panel on its Agent side, counting the changes it asks the host to count. */
export async function agentSide(client: OperationsClient, element?: ReactElement) {
  let changes = 0;
  const view = await mount(
    <StepUpContext.Provider
      value={() => Promise.resolve({ ok: false, because: 'Not here.' } as const)}
    >
      {element}
      <TaskPanel
        client={client}
        grantKey="alpha:member"
        opening={{ taskKey: KEY, door: 'open', tab: null }}
        onChanged={() => {
          changes += 1;
        }}
        onClose={ignore}
      />
    </StepUpContext.Provider>,
  );
  await tick();
  await view.click('#panel-perspective-tab-agent');
  await tick();
  return { view, changes: () => changes };
}
