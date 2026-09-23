// SPDX-License-Identifier: AGPL-3.0-only
//
// N3-N5: what the server refuses when the request does not come from a control.
//
// N3 sends a protected field to the operation that does not own it, N4 sends a
// field the server writes for itself, and N5 replays an operation id and then
// edits against a revision that has moved on. All three go through
// `records/submit.ts` or the client in the page, with the signed-in person's
// own session: this is what the application's own code can be made to ask,
// not a hand-rolled request.

import { TASK_SPINE } from '../../packages/core-records/src/tasks/spine.ts';
import { inOrder, record, serverRevision, shot, throughClient, throughSubmit } from './harness.mjs';

const PROTECTED = [
  ['state', { state: '00000000-0000-0000-0000-000000000000' }],
  ['assignee', { assignee: null }],
  ['stage', { stage: 'delivery' }],
  ['parent', { parent: null }],
  ['intake_state', { intake_state: 'accepted' }],
];

const SYSTEM = [
  ['source', { source: 'agent' }],
  ['key', { key: 'T-0' }],
  ['completed_at', { completed_at: '2020-01-01T00:00:00.000Z' }],
];

/**
 * The exact refusal a protected field earns on `task.update`, derived from the
 * spine as `tests/acceptance/protected-fields.test.ts` derives it (ledger D03):
 * an operation-owned field is `TRANSITION_PROTECTED` naming `key=owning
 * operations`, `source` is `SOURCE_SPOOFED`, any other derived field is
 * `FIELD_NOT_WRITABLE` naming the key. A bare `refused` is not the claim.
 */
function refusalFor(key) {
  const field = TASK_SPINE.find((one) => one.key === key);
  if (key === 'source') return { code: 'SOURCE_SPOOFED', names: ['source'] };
  if (field?.writeMode === 'system') return { code: 'FIELD_NOT_WRITABLE', names: [key] };
  return { code: 'TRANSITION_PROTECTED', names: [`${key}=${field.owningOperations.join(' ')}`] };
}

const exactly = (refusal, key) =>
  refusal.refused === true &&
  refusal.code === refusalFor(key).code &&
  JSON.stringify(refusal.names) === JSON.stringify(refusalFor(key).names);

export async function casesN3toN5(run) {
  await protectedFields(run);
  await systemFields(run);
  await replayAndRevision(run);
}

async function protectedFields(run) {
  const { page, state } = run;
  await inOrder(PROTECTED, async ([field, fields]) => {
    const was = await serverRevision(page, state.taskId);
    const refusal = await throughSubmit(page, {
      request: { command: 'task.update', recordId: state.taskId, expectedRevision: was, fields },
    });
    const after = await serverRevision(page, state.taskId);
    record({
      case: `N3 protected ${field}`,
      action: `records/submit.ts sent ${field} to task.update`,
      observed: `${refusal.code ?? JSON.stringify(refusal)} naming ${JSON.stringify(refusal.names ?? [])}, revision still ${after}`,
      ok: exactly(refusal, field) && after === was,
      shot: field === 'state' ? await shot(page, 'N3-state-refused') : undefined,
    });
  });

  const ordinary = await throughSubmit(page, {
    request: {
      command: 'task.update',
      recordId: state.taskId,
      expectedRevision: await serverRevision(page, state.taskId),
      fields: { description: 'the positive control alongside the refusals' },
    },
  });
  record({
    case: 'N3 ordinary edit still applies',
    action: 'records/submit.ts sent description to task.update',
    observed:
      ordinary.ok === true
        ? `applied at revision ${ordinary.value.revision}`
        : JSON.stringify(ordinary),
    ok: ordinary.ok === true,
    shot: await shot(page, 'N3-ordinary-applies'),
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-task]');
}

async function systemFields(run) {
  const { page, state } = run;
  await inOrder(SYSTEM, async ([field, fields]) => {
    const was = await serverRevision(page, state.taskId);
    const refusal = await throughSubmit(page, {
      request: { command: 'task.update', recordId: state.taskId, expectedRevision: was, fields },
    });
    const echoed = JSON.stringify(refusal).includes(String(Object.values(fields)[0]));
    const after = await serverRevision(page, state.taskId);
    record({
      case: `N4 system field ${field}`,
      action: `records/submit.ts sent ${field} to task.update`,
      observed: `${refusal.code ?? JSON.stringify(refusal)} naming ${JSON.stringify(refusal.names ?? [])}; attempted value echoed back: ${echoed}; revision still ${after}`,
      ok: exactly(refusal, field) && !echoed && after === was,
      shot: field === 'source' ? await shot(page, 'N4-source-spoofed') : undefined,
    });
  });
}

async function replayAndRevision(run) {
  const { page, state } = run;
  const base = await serverRevision(page, state.taskId);
  const identity = crypto.randomUUID();
  const body = { recordId: state.taskId, fields: { priority: 4 } };
  const first = await throughClient(page, {
    name: 'task.update',
    body,
    options: { expectedRevision: base, operationId: identity },
  });
  const replay = await throughClient(page, {
    name: 'task.update',
    body,
    options: { expectedRevision: base, operationId: identity },
  });
  const changed = await throughClient(page, {
    name: 'task.update',
    body: { recordId: state.taskId, fields: { priority: 9 } },
    options: { expectedRevision: base, operationId: identity },
  });
  const stale = await throughClient(page, {
    name: 'task.update',
    body: { recordId: state.taskId, fields: { priority: 5 } },
    options: { expectedRevision: base },
  });
  record({
    case: 'N5 replay and revision',
    action: 'the same operationId twice, then a changed payload, then an old expectedRevision',
    observed: `first ${JSON.stringify(first.result.value ?? first.result.code)}, replay ${JSON.stringify(replay.result.value ?? replay.result.code)}, changed ${changed.result.code}, stale ${stale.result.code}`,
    ok:
      first.result.ok === true &&
      replay.result.ok === true &&
      replay.result.value.revision === first.result.value.revision &&
      changed.result.code === 'OPERATION_ID_REUSED' &&
      stale.result.code === 'VERSION_STALE',
    shot: await shot(page, 'N5-replay-and-stale'),
  });
}
