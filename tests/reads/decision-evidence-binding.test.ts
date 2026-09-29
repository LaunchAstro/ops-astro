// SPDX-License-Identifier: AGPL-3.0-only
//
// R2-THERMO-17: a decision's signed evidence digest is the only signed
// carrier of the ceiling and currency it approved (`evidence.ts`, `bound`), so
// the proposal read ties that digest to the version, evidence pack and gate
// binding it shows. Three tamperings that left the chain intact used to read
// as verified:
//
// - (a) the owner rewrites the evidence pack's body under its old digest;
// - (b) the owner rewrites the version's `maximum_minor` with its triggers off;
// - (c) a superseded version with a larger ceiling and its own consistent
//   pack is added to the lineage and the decided gate moved onto it. The
//   application role could do this alone until 0030, which now refuses it at
//   storage; the read check is proved with the owner making the same move.
//
// Each must be the named fault, over HTTP and on the direct read. A clean
// decision and a request-changes-then-approve history must still read clean:
// the decision on the first version stays bound to that version after a
// later one supersedes it.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-commands/src/reads/proposals.ts';
import { DecisionIntegrityError } from '../../packages/core-commands/src/reads/verified-decisions.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';
import { moveDecidedGate } from './decided-gate-move.ts';

type Decision = 'approve' | 'reject' | 'request_changes';

interface Proposed {
  readonly gateId: string;
  readonly versionId: string;
  readonly lineageId: string;
}

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

async function revisionOf(world: World, recordId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, recordId],
  );
  return Number(rows[0]?.revision ?? '0');
}

async function createTask(world: World): Promise<string> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a bound decision ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  return String(created.body['recordId']);
}

async function propose(world: World, taskId: string, lineageId?: string): Promise<Proposed> {
  const proposed = await asAda(world, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
    ...(lineageId === undefined ? {} : { lineageId }),
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;
  return {
    gateId: String(detail['gateId']),
    versionId: String(detail['versionId']),
    lineageId: String(detail['lineageId']),
  };
}

async function decide(world: World, on: Proposed, decision: Decision): Promise<void> {
  const answer = await asAda(world, '/task/decide', {
    operationId: randomUUID(),
    gateId: on.gateId,
    versionId: on.versionId,
    decision,
    note: `${decision} as proposed`,
  });
  expect(answer.code, 'decide').toBe('ok');
}

async function readTask(world: World, taskId: string) {
  return await asAda(world, '/task/read', { operationId: randomUUID(), recordId: taskId });
}

function decisionsOf(answer: { readonly body: Record<string, unknown> }) {
  const task = answer.body['task'] as Record<string, unknown>;
  const proposals = task['proposals'] as readonly {
    readonly decisions: readonly Record<string, unknown>[];
  }[];
  return proposals.flatMap((proposal) => proposal.decisions);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (cause) {
    return cause;
  }
}

async function expectIntegrityFault(world: World, taskId: string, where: RegExp) {
  const answer = await readTask(world, taskId);
  expect(answer.status, 'a fault, under 500').toBe(500);
  expect(answer.body['code']).toBe('DECISION_INTEGRITY');
  expect(answer.body['task']).toBeUndefined();

  const failure = await rejectionOf(
    world.db.app.withBusiness(world.alpha, async (tx) => await readTaskProposals(tx, taskId)),
  );
  expect(failure).toBeInstanceOf(DecisionIntegrityError);
  expect((failure as Error).message).toMatch(where);
}

if (serverUrl === undefined) {
  console.warn('reads/final-r2-fr2-runtime-integrity: DATABASE_URL is unset, so nothing ran.');
}

describe.skipIf(serverUrl === undefined)('a decision is bound to what the read shows', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it('reads a clean approval', async () => {
    world = await createWorld('r2fr2');
    const taskId = await createTask(world);
    await decide(world, await propose(world, taskId), 'approve');
    const answer = await readTask(world, taskId);
    expect(answer.status).toBe(200);
    expect(decisionsOf(answer)).toHaveLength(1);
  }, 60_000);

  it('reads a request-changes-then-approve history across two versions', async () => {
    world = await createWorld('r2fr2');
    const taskId = await createTask(world);
    const first = await propose(world, taskId);
    await decide(world, first, 'request_changes');
    const second = await propose(world, taskId, first.lineageId);
    expect(second.lineageId).toBe(first.lineageId);
    expect(second.versionId).not.toBe(first.versionId);
    await decide(world, second, 'approve');

    const answer = await readTask(world, taskId);
    expect(answer.status).toBe(200);
    expect(decisionsOf(answer).map((row) => row['decision'])).toStrictEqual([
      'request_changes',
      'approve',
    ]);
  }, 60_000);

  it('(a) fails a read whose evidence pack body was rewritten under its old digest', async () => {
    world = await createWorld('r2fr2');
    const taskId = await createTask(world);
    const on = await propose(world, taskId);
    await decide(world, on, 'approve');
    await world.db.admin.execute(
      `update public.evidence_packs
          set rendered = jsonb_set(rendered, '{bound,maximumMinor}', '50')
        where business_id = $1 and version_id = $2`,
      [world.alpha, on.versionId],
    );
    await expectIntegrityFault(world, taskId, /seq 1: evidence pack .* its own digest/u);
  }, 60_000);

  it("(b) fails a read whose version's maximum_minor was rewritten", async () => {
    world = await createWorld('r2fr2');
    const taskId = await createTask(world);
    const on = await propose(world, taskId);
    await decide(world, on, 'approve');
    await world.db.admin.execute('alter table public.proposal_versions disable trigger all');
    try {
      await world.db.admin.execute(
        `update public.proposal_versions set maximum_minor = 50
          where business_id = $1 and id = $2`,
        [world.alpha, on.versionId],
      );
    } finally {
      await world.db.admin.execute('alter table public.proposal_versions enable trigger all');
    }
    await expectIntegrityFault(world, taskId, /seq 1: version .* maximum_minor is not/u);
  }, 60_000);

  // Since 0030 storage refuses (c) as the application role
  // (`gates_version_fixed_once_decided`), so the app-role case asserts that
  // refusal, and the read check is proved with the same move made by the
  // owner with the gate's triggers off, as (b) does for the version.
  it('(c) refuses the application role moving a decided gate to another version, at storage', async () => {
    world = await createWorld('r2fr2');
    const taskId = await createTask(world);
    const on = await propose(world, taskId);
    await decide(world, on, 'approve');
    const current = world;

    const failure = await rejectionOf(
      current.db.app.withBusiness(current.alpha, async (tx) => {
        await moveDecidedGate(current, on, async (text, parameters) => {
          await tx.query(text, [...parameters]);
        });
      }),
    );
    expect(failure).toMatchObject({
      code: '23514',
      constraint_name: 'gates_version_fixed_once_decided',
    });
    const answer = await readTask(current, taskId);
    expect(answer.status).toBe(200);
    expect(decisionsOf(answer)).toHaveLength(1);
  }, 60_000);

  it('(c) fails a read whose decided gate the owner moved, with its triggers off, to another version', async () => {
    world = await createWorld('r2fr2');
    const taskId = await createTask(world);
    const on = await propose(world, taskId);
    await decide(world, on, 'approve');
    const current = world;

    await current.db.admin.execute('alter table public.gates disable trigger all');
    try {
      await moveDecidedGate(current, on, async (text, parameters) => {
        await current.db.admin.execute(text, [...parameters]);
      });
    } finally {
      await current.db.admin.execute('alter table public.gates enable trigger all');
    }

    await expectIntegrityFault(current, taskId, /seq 1: gate .* is bound to version/u);
  }, 60_000);
});
