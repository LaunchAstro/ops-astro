// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04's shared world: two businesses of one installation in one database,
// each with a decider, an agent and a cap. A plan is proposed through the real
// command path and accepted through the real accept, which is the only thing
// that writes a pin here: nothing is seeded by the admin connection.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import {
  acceptPlan,
  boundPlanOf,
  gateSigningKey,
  type BoundPlan,
  INSTRUCTION_ROOT_VARIABLE,
  type InstructionSource,
  type PlanAcceptRequest,
  type PlanAcceptResult,
} from '../../packages/core-runtime/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { ENTRY, FILES, FRAGMENT, sourceOf } from './aw-02-world.ts';
import {
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  seedSchedules,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

export const noDatabase: boolean = process.env['DATABASE_URL'] === undefined;

/** A plan proposed on a task of its own: the gate the accept decides. */
export interface Proposed {
  readonly taskId: string;
  readonly proposal: Detail;
}

export async function proposed(owner: Schedules, title: string): Promise<Proposed> {
  const taskId = await createTask(owner, title);
  const proposal = await propose(owner, taskId, { maximumMinor: 1_000, purpose: freshPurpose() });
  return { taskId, proposal };
}

/** The accept as `person` would send it for `plan`, the entry and one fragment named. */
export function acceptRequest(
  owner: Schedules,
  plan: Proposed,
  person: Member = owner.decider,
): PlanAcceptRequest {
  const signingKey = gateSigningKey();
  if (signingKey === undefined) throw new Error('no signing key');
  return {
    gateId: String(plan.proposal['gateId']),
    versionId: String(plan.proposal['versionId']),
    decidedByPersonId: person.personId,
    decidedByActorId: person.actorId,
    subjects: [{ kind: 'person', id: person.personId }],
    collection: 'task',
    note: 'accepted in the drawer',
    signingKey,
    capId: owner.capId,
    entryPath: ENTRY,
    paths: [FRAGMENT],
    plan: boundPlan(),
    originConversationId: null,
  };
}

/** `PLAN_TEXT` and `PLAN`, checked and digested as the accept binds them. */
function boundPlan(): BoundPlan {
  const bound = boundPlanOf(PLAN_TEXT, PLAN);
  if ('field' in bound) throw new Error(bound.reason);
  return bound;
}

/** The real accept, in `owner`'s business, one transaction on `database`. */
export async function acceptAs(
  owner: Schedules,
  request: PlanAcceptRequest,
  source: InstructionSource = sourceOf(FILES),
  database: Database = owner.db.app,
): Promise<PlanAcceptResult> {
  return await database.withBusiness(
    owner.business,
    async (tx) => await acceptPlan(tx, request, source),
  );
}

export interface PinRow {
  readonly ref_kind: string;
  readonly path: string;
  readonly content_digest: string;
  readonly content_size: string;
  readonly manifest: readonly { path: string; digest: string; size: number }[];
  readonly manifest_digest: string;
  readonly pinned_by_actor_id: string;
}

/** Every pin on `runId`, as the owner connection sees it. */
export async function pinsOf(owner: Schedules, runId: unknown): Promise<readonly PinRow[]> {
  return await owner.db.admin.execute<PinRow>(
    `select ref_kind, path, content_digest, content_size::text, manifest, manifest_digest,
            pinned_by_actor_id
       from public.run_definition_pins where run_id = $1`,
    [runId],
  );
}

/** The gate's state and how many signed decisions it carries. */
export async function gateOf(
  owner: Schedules,
  gateId: unknown,
): Promise<{ readonly state: string; readonly decisions: string }> {
  const rows = await owner.db.admin.execute<{ state: string; decisions: string }>(
    `select g.state,
            (select count(*) from public.gate_decisions d where d.gate_id = g.id)::text as decisions
       from public.gates g where g.id = $1`,
    [gateId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no gate');
  return row;
}

/** The world's live bindings, filled in by `useAw04World`. */
export const w = {} as { alpha: Schedules; bravo: Schedules };

export function useAw04World(part: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    w.alpha = await openSchedules(part, 1_000_000);
    w.bravo = await seedSchedules(w.alpha.db, `${part}-bravo`, 1_000_000);
  }, 180_000);

  afterAll(async () => {
    if (noDatabase) return;
    await w.alpha.db.drop();
  });
}

/** The accept command's structured plan: two steps, the second after the first. */
export const PLAN: {
  readonly steps: readonly { key: string; title: string; after: readonly string[] }[];
} = {
  steps: [
    { key: 'draft', title: 'Draft the brief', after: [] },
    { key: 'check', title: 'Check it against the notes', after: ['draft'] },
  ],
};

/** The exact words the person approved, the ceiling and the later launch named. */
export const PLAN_TEXT: string =
  'Draft the brief, then check it against the notes. Ceiling: $10.00. ' +
  'Launch happens later, on the task.';

/** A read-only instruction root on disk holding AW-02's two files, set on this process. */
export function useInstructionRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aw04-instructions-'));
  for (const [path, bytes] of FILES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  const previous = process.env[INSTRUCTION_ROOT_VARIABLE];
  process.env[INSTRUCTION_ROOT_VARIABLE] = root;
  afterAll(() => {
    if (previous === undefined) delete process.env[INSTRUCTION_ROOT_VARIABLE];
    else process.env[INSTRUCTION_ROOT_VARIABLE] = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** `task.accept_plan` as the drawer sends it for `plan`. */
export function acceptBody(plan: Proposed, extra: Readonly<Record<string, unknown>> = {}): Body {
  return {
    command: 'task.accept_plan',
    operationId: randomUUID(),
    gateId: plan.proposal['gateId'],
    versionId: plan.proposal['versionId'],
    note: 'accepted in the drawer',
    planText: PLAN_TEXT,
    plan: PLAN,
    entryPath: ENTRY,
    paths: [FRAGMENT],
    ...extra,
  };
}

/** A conversation `who` owns in `owner`'s business, as `conversation.start` leaves one. */
export async function conversationOf(owner: Schedules, who: Member): Promise<string> {
  const id = randomUUID();
  await owner.db.app.withBusiness(owner.business, async (tx) => {
    await tx.query(
      `insert into public.conversations (business_id, id, owner_actor_id, owner_person_id, title)
       values ($1, $2, $3, $4, 'plan chat')`,
      [owner.business, id, who.actorId, who.personId],
    );
  });
  return id;
}

export interface PlanRecordRow {
  readonly id: string;
  readonly decision_id: string;
  readonly run_id: string;
  readonly origin_conversation_id: string | null;
  readonly plan_text: string;
  readonly text_digest: string;
  readonly record: unknown;
  readonly record_digest: string;
}

/** Every plan record bound on `gateId`, as the owner connection sees it. */
export async function planRecordsOf(
  owner: Schedules,
  gateId: unknown,
): Promise<readonly PlanRecordRow[]> {
  return await owner.db.admin.execute<PlanRecordRow>(
    `select id, decision_id, run_id, origin_conversation_id, plan_text, text_digest, record,
            record_digest
       from public.plan_records where gate_id = $1`,
    [gateId],
  );
}
