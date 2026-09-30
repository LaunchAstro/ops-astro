// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04's shared world: two businesses of one installation in one database,
// each with a decider, an agent and a cap. A plan is proposed through the real
// command path and accepted through the real accept, which is the only thing
// that writes a pin here: nothing is seeded by the admin connection.

import { afterAll, beforeAll } from 'vitest';
import {
  acceptPlan,
  gateSigningKey,
  type InstructionSource,
  type PlanAcceptRequest,
  type PlanAcceptResult,
} from '../../packages/core-runtime/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { ENTRY, FILES, FRAGMENT, sourceOf } from './aw-02-world.ts';
import {
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  seedSchedules,
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
  };
}

/** The real accept, in `owner`'s business, one transaction. */
export async function acceptAs(
  owner: Schedules,
  request: PlanAcceptRequest,
  source: InstructionSource = sourceOf(FILES),
): Promise<PlanAcceptResult> {
  return await owner.db.app.withBusiness(
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
