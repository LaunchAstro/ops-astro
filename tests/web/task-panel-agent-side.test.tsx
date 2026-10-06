// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's Agent side (S3, DA-01 to DA-09): the Agent pane the
// task page mounts, mounted here on the panel's own read, so a gate, a stop
// and an unknown effect are answered beside the page through the same
// commands; the head's Ask about this task (DP-09); and the scope stamp's
// way into the access ledger (MP-6-4, F71). The server is a stand-in for the
// HTTP boundary only: what each command does is proven against Postgres in
// `tests/api/mp-6-1-*` and the C54 suites.

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the pane's own tests do */

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAsks } from '../../apps/web/src/assistant/asks.ts';
import type { AskEntry } from '../../apps/web/src/assistant/chats.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import type { RunScope } from '../../packages/ui/src/index.ts';
import { DIGEST, lineage, running, version } from '../surfaces/mp-6-1-agent-fixtures.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';
import { TASK_ID, task, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';
const AGENT = '#panel-perspective-panel-agent';
const PANE = `${AGENT} [data-section="agent"]`;

const ignore = (): void => {
  /* The case reads nothing from this call. */
};

interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** What `run.top_up` answers: accepted, or refused with this code. */
type TopUp = 'ok' | 'STEP_UP_REQUIRED';

/** A server answering one task with `over`, recording every command by its path. */
function serving(over: Readonly<Record<string, unknown>>, topUp: TopUp = 'ok') {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task(over) }));
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
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
    if (to === '/run/top_up' && topUp !== 'ok') {
      return Promise.resolve(json({ refused: true, code: topUp, names: [], fixes: [] }, 403));
    }
    return Promise.resolve(json({ ok: true, recordId: 'r', revision: 5 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent,
  };
}

/** The panel on its Agent side, counting the changes it asks the host to count. */
async function agentSide(client: OperationsClient, element?: ReactElement) {
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

const stop = {
  askId: 'ask-1',
  runId: 'run-1',
  number: 1,
  kind: 'stop',
  ceilingMinor: 400,
  spentMinor: 390,
  currency: 'AUD',
  raisedAt: '2026-10-01T00:00:00Z',
  answer: null,
  awaitingSecond: null,
};

const scope: RunScope = {
  leaseId: 'lease-1',
  acquiredAt: '2026-09-29T09:00:00.000Z',
  delegation: {
    id: 'deleg-1',
    purpose: 'draft_the_reply',
    scope: { kind: 'record', id: TASK_ID },
    collections: ['task'],
    actions: ['read', 'comment'],
    expiresAt: '2026-09-29T10:00:00.000Z',
    state: 'live',
    delegatePersonId: 'p-ada',
    grants: [
      { id: 'grant-business', collection: 'task', action: 'read', scopeKind: 'business' },
      { id: 'grant-record', collection: 'task', action: 'comment', scopeKind: 'record' },
    ],
  },
};

/** A run whose worker was lost after the provider may have acted (C54). */
const unknown = lineage({
  reservations: [
    { ...running, attempt: { id: 'att-1', state: 'liability_unknown', outcome: null } },
  ],
  versions: [
    version({
      gate: {
        id: 'g-1',
        state: 'approved',
        round: 0,
        expiresAt: '2026-10-01T00:00:00.000Z',
        expired: false,
        payloadDigest: DIGEST,
      },
    }),
  ],
});

// eslint-disable-next-line max-lines-per-function -- one panel side, each control on it
describe('S3 the dock panel Agent side', () => {
  it('DA-01 the panel draws the task page’s Agent pane, never a not-connected line', async () => {
    const { view } = await agentSide(serving({ proposals: [lineage()] }).client);
    expect(view.find(`${PANE} [data-agent="pane"]`)).not.toBeNull();
    expect(view.find(`${AGENT} [data-not-connected="agent"]`)).toBeNull();
    // The brief stays on the Agent side, above the pane.
    expect(view.find(`${AGENT} [data-writing="brief"]`)).not.toBeNull();
  });

  it('DA-07 a gate decided in the panel names the exact gate and version it read, then counts a change', async () => {
    const { client, sent } = serving({ proposals: [lineage()] });
    const { view, changes } = await agentSide(client);
    await view.click(`${PANE} [data-gate-action="approve"]`);
    await tick();
    expect(sent.map((call) => call.to)).toStrictEqual(['/task/decide']);
    expect(sent[0]?.body).toMatchObject({ gateId: 'g-1', versionId: 'v-1', decision: 'approve' });
    expect(changes()).toBeGreaterThan(0);
  });

  it('DA-09 a top-up at the panel’s budget stop goes to run.top_up naming the run and stop it read', async () => {
    const proposals = [lineage({ reservations: [running] })];
    const { client, sent } = serving({ proposals, ledger: { envelopes: [], stops: [stop] } });
    const { view } = await agentSide(client);
    await typeInto(view, `${PANE} [data-stop="amount"]`, '5');
    await view.click(`${PANE} [data-stop="top-up"]`);
    await tick();
    expect(sent.map((call) => call.to)).toStrictEqual(['/run/top_up']);
    expect(sent[0]?.body).toMatchObject({ recordId: TASK_ID, runId: 'run-1', askId: 'ask-1' });
  });

  it('DA-09 a money write refused for a second factor asks for the code in the panel', async () => {
    const proposals = [lineage({ reservations: [running] })];
    const over = { proposals, ledger: { envelopes: [], stops: [stop] } };
    const { client } = serving(over, 'STEP_UP_REQUIRED');
    const { view } = await agentSide(client);
    await typeInto(view, `${PANE} [data-stop="amount"]`, '5');
    await view.click(`${PANE} [data-stop="top-up"]`);
    await tick();
    expect(view.find(`${AGENT} [data-step-up="prompt"]`)).not.toBeNull();
  });

  it('MP-6-4 the scope stamp links each grant it draws on into Settings, Access', async () => {
    const proposals = [lineage({ scopes: [scope] })];
    const { view } = await agentSide(serving({ proposals }).client);
    expect(
      view.all(`${PANE} [data-agent="scope-say"] a`).map((link) => link.getAttribute('href')),
    ).toStrictEqual(['/settings/access/', '/settings/access/']);
  });

  it('S3 beside the task page, the two Agent panes repeat no id', async () => {
    const { client } = serving({
      proposals: [unknown],
      ledger: { envelopes: [], stops: [stop] },
    });
    const { view } = await agentSide(
      client,
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey={KEY} />,
    );
    await view.click('[data-tabs="perspective"] [role="tab"]:nth-of-type(2)');
    await tick();
    expect(view.all('[data-write-off="amount"]')).toHaveLength(2);
    expect(view.all('[data-stop="amount"]')).toHaveLength(2);
    const ids = view.all('[id]').map((element) => element.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toStrictEqual([]);
  });
});

/** The drawer's half of the ask seam, under `grantKey`, keeping what it takes. */
function Drawer(props: { readonly grantKey: string; readonly took: AskEntry[] }): null {
  useAsks(props.grantKey, (entry) => {
    props.took.push(entry);
  });
  return null;
}

describe('DP-09 Ask about this task', () => {
  it('DP-09 the head’s Ask drafts the task-scoped question for the panel’s own session', async () => {
    const took: AskEntry[] = [];
    const { client, sent } = serving({ clientSet: true, client: 'client-a' });
    const { view } = await agentSide(client, <Drawer grantKey="alpha:member" took={took} />);
    await view.click('[data-panel-head="ask"]');
    await tick();
    expect(took).toHaveLength(1);
    expect(took[0]?.question).toBe(
      'Where is the task “Budget pacing fix” up to, and what should happen next?',
    );
    expect(took[0]?.scope.task).toMatchObject({ id: TASK_ID, clientId: 'client-a' });
    // Drafted only: the drawer sends nothing until the person does.
    expect(sent).toStrictEqual([]);
  });

  it('DP-09 a drawer under another session takes no ask the panel made', async () => {
    const took: AskEntry[] = [];
    const { client } = serving({});
    const { view } = await agentSide(client, <Drawer grantKey="bravo:member" took={took} />);
    await view.click('[data-panel-head="ask"]');
    await tick();
    expect(took).toStrictEqual([]);
  });
});
