// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Scope } from '../../packages/ui/src/surfaces/agent/scope.tsx';
import { scopeStamp } from '../../packages/ui/src/state/agent-scope.ts';
import { tokenStory, type TaskLedger } from '../../packages/ui/src/state/token-ledger.ts';
import type { RunLineage } from '../../packages/ui/src/state/run-projection.ts';
import { createControls, PROPOSAL, type Controls } from '../api/controls-fixture.ts';

let controls: Controls;
let taskId: string;
let leaseId: string;
let fence: number;
let credential: string;

const metadata = {
  skills: ['Reply drafting'],
  dataSource: { label: 'Client brief', href: 'https://example.test/brief' },
};

async function readTask(): Promise<{ proposals: readonly RunLineage[]; ledger: TaskLedger }> {
  const read = await controls.asPerson('task.read', { recordId: taskId });
  expect(read.status).toBe(200);
  return read.body['task'] as { proposals: readonly RunLineage[]; ledger: TaskLedger };
}

beforeAll(async () => {
  controls = await createControls('ow075_sol_agent');
  const task = await controls.createTask('Sol scope and evidence proof');
  taskId = task.id;
  const proposed = await controls.asPerson('task.propose', {
    recordId: taskId,
    expectedRevision: task.revision,
    ...PROPOSAL,
    payload: { ...PROPOSAL.payload, ...metadata },
  });
  expect(proposed.status).toBe(200);
  const proposal = proposed.body['detail'] as Record<string, unknown>;
  const reservation = await controls.approve(proposal);
  const pickup = await controls.pickup(reservation, 600);
  leaseId = String(pickup['leaseId']);
  fence = Number(pickup['fence']);
  credential = String(pickup['credential']);
}, 180_000);

afterAll(async () => await controls?.drop());

/** The markup's text: tags stripped until none is left, so a tag split by another never survives. */
function textOf(html: string): string {
  let text = html;
  for (let last = ''; last !== text;) {
    last = text;
    text = text.replaceAll(/<[^>]*>/gu, '');
  }
  return text;
}

// Sol OW-075.1 criterion correctness, retitled by what it proves; its body is Sol's.
it('token metadata survives the real evidence renderer', async () => {
  const task = await readTask();
  const evidence = task.proposals[0]?.versions[0]?.evidence?.body;
  expect(evidence).toMatchObject({ payload: metadata });
  const story = tokenStory(task.ledger, task.proposals);
  expect(story.kind).toBe('tracked');
  if (story.kind !== 'tracked') throw new Error('Expected the approved envelope');
  expect({ skills: story.skills, dataSource: story.dataSource }).toStrictEqual({
    skills: [{ name: 'Reply drafting' }],
    dataSource: metadata.dataSource,
  });
});

// Sol OW-075.2 criterion correctness, retitled by what it proves; its body is Sol's.
it('a successor is never labelled pinned at its predecessor lease', async () => {
  const before = await readTask();
  const old = before.proposals[0]?.versions[0];
  const acquiredAt = before.proposals[0]?.scopes?.[0]?.acquiredAt;
  expect(old).toBeDefined();
  expect(acquiredAt).toBeDefined();
  const back = await controls.asAgent(
    'task.handback',
    {
      leaseId,
      fence,
      outcome: 'completed',
      report: { wrote: 'new reviewed output' },
      successor: { ...PROPOSAL, payload: { instruction: 'a different context after pickup' } },
    },
    credential,
  );
  expect(back.status).toBe(200);
  const after = await readTask();
  const lineage = after.proposals[0];
  const head = lineage?.versions[0];
  expect(head?.version).toBe(2);
  expect(head?.payloadDigest).not.toBe(old?.payloadDigest);
  expect(lineage?.scopes).toHaveLength(1);
  expect(lineage?.scopes?.[0]?.acquiredAt).toBe(acquiredAt);
  const binding = await controls.fixture.db.admin.execute<{ version_id: string }>(
    `select r.version_id from public.leases l
       join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
      where l.id = $1`,
    [leaseId],
  );
  expect(binding[0]?.version_id).toBe(old?.versionId);
  if (head === undefined) throw new Error('Expected successor version');
  const html = renderToStaticMarkup(
    createElement(Scope, {
      stamp: scopeStamp(lineage),
      head,
      nameOf: () => 'a person',
      ledgerHref: null,
    }),
  );
  const text = textOf(html);
  expect(text).not.toContain(
    `Context snapshot v2 ${head.payloadDigest.slice(0, 12)} · pinned ${String(acquiredAt)}`,
  );
});
