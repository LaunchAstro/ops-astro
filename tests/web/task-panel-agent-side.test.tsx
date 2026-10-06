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
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { RunScope } from '../../packages/ui/src/index.ts';
import { DIGEST, lineage, running, version } from '../surfaces/mp-6-1-agent-fixtures.tsx';
import { typeInto, unmountAll } from './perspective-support.tsx';
import { AGENT, KEY, PANE, agentSide, serving } from './task-panel-agent-support.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

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
    const { client } = serving(over, { '/run/top_up': { code: 'STEP_UP_REQUIRED' } });
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

  it('DA-07 a second formal round of changes is requested from the panel on the exact gate it read', async () => {
    const gate = { id: 'g-2', state: 'pending', round: 2, expiresAt: null, expired: false };
    const proposals = [
      lineage({
        versions: [version({ versionId: 'v-2', gate: { ...gate, payloadDigest: DIGEST } })],
      }),
    ];
    const { client, sent } = serving({ proposals });
    const { view } = await agentSide(client);
    await view.click(`${PANE} [data-gate-action="request_changes"]`);
    await tick();
    expect(sent.map((call) => [call.to, call.body['decision']])).toStrictEqual([
      ['/task/decide', 'request_changes'],
    ]);
    expect(sent[0]?.body).toMatchObject({ gateId: 'g-2', versionId: 'v-2' });
  });

  it('DA-07 past the rounds of changes, the panel escalates to the person chosen, at the exact gate', async () => {
    const gate = { id: 'g-3', state: 'pending', round: 3, expiresAt: null, expired: false };
    const proposals = [
      lineage({
        versions: [version({ versionId: 'v-3', gate: { ...gate, payloadDigest: DIGEST } })],
      }),
    ];
    const people = [{ personId: 'p-grace', name: 'Grace' }];
    const { client, sent } = serving({ proposals }, {}, people);
    const { view } = await agentSide(client);
    expect(view.find(`${PANE} [data-gate-action="request_changes"]`)).toBeNull();
    await view.choose(`${PANE} [data-gate-escalate="recipient"]`, 'p-grace');
    await view.click(`${PANE} [data-gate-action="escalate"]`);
    await tick();
    expect(sent.map((call) => call.to)).toStrictEqual(['/task/decide']);
    expect(sent[0]?.body).toMatchObject({
      gateId: 'g-3',
      versionId: 'v-3',
      decision: 'escalate',
      recipientPersonId: 'p-grace',
    });
  });

  it('DA-07 a recipient the server refuses leaves the decider’s choice, approve and reject open', async () => {
    const gate = { id: 'g-3', state: 'pending', round: 3, expiresAt: null, expired: false };
    const proposals = [
      lineage({
        versions: [version({ versionId: 'v-3', gate: { ...gate, payloadDigest: DIGEST } })],
      }),
    ];
    const people = [
      { personId: 'p-xavier', name: 'Xavier' },
      { personId: 'p-yara', name: 'Yara' },
    ];
    // Xavier lacks decide across the business: the refusal names the recipient field.
    const refusals = {
      '/task/decide': { code: 'SCOPE_NOT_GRANTED', names: ['recipientPersonId'] },
    };
    const { client, sent } = serving({ proposals }, refusals, people);
    const { view, changes } = await agentSide(client);
    await view.choose(`${PANE} [data-gate-escalate="recipient"]`, 'p-xavier');
    await view.click(`${PANE} [data-gate-action="escalate"]`);
    await tick();
    expect(changes()).toBeGreaterThan(0);
    expect(view.find(`${PANE} [data-agent="refusal"]`)).not.toBeNull();
    expect(view.find(`${PANE} [data-gate="closed"]`)).toBeNull();
    const recipient = view.find(`${PANE} [data-gate-escalate="recipient"]`) as HTMLSelectElement;
    expect(recipient.value).toBe('p-xavier');
    for (const control of ['[data-gate-action="approve"]', '[data-agent="reject"]']) {
      expect((view.find(`${PANE} ${control}`) as HTMLButtonElement | null)?.disabled).toBe(false);
    }
    await view.click(`${PANE} [data-gate-action="approve"]`);
    await tick();
    expect(sent.map((call) => call.body['decision'])).toStrictEqual(['escalate', 'approve']);
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

/** The dock's drawer as it ships, under `grantKey`: what it drafts is in its input. */
const drawer = (client: OperationsClient, grantKey: string): ReactElement => (
  <AssistantView
    client={client}
    grantKey={grantKey}
    route="agency:projects-board"
    here="/projects"
    entry={null}
  />
);

describe('DP-09 Ask about this task', () => {
  it('DP-09 the head’s Ask drafts the task-scoped question in the session’s drawer, and sends nothing', async () => {
    const { client, sent } = serving({ clientSet: true, client: 'client-a' });
    const { view } = await agentSide(client, drawer(client, 'alpha:member'));
    await view.click('[data-panel-head="ask"]');
    await tick();
    expect((view.find('[data-assistant="input"]') as HTMLInputElement | null)?.value).toBe(
      'Where is the task “Budget pacing fix” up to, and what should happen next?',
    );
    expect(view.find('[data-assistant="citation"]')?.textContent).toContain('Ask about this task');
    // Drafted only: the shipped drawer sends nothing until the person does.
    expect(sent).toStrictEqual([]);
  });

  it('DP-09 a drawer under another session takes no ask the panel made', async () => {
    const { client, sent } = serving({});
    const { view } = await agentSide(client, drawer(client, 'bravo:member'));
    await view.click('[data-panel-head="ask"]');
    await tick();
    expect((view.find('[data-assistant="input"]') as HTMLInputElement | null)?.value).toBe('');
    expect(sent).toStrictEqual([]);
  });
});
