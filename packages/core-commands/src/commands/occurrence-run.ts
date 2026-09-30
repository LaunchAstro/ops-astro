// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 J: an automation occurrence's run, the worker's system write after
// C52-A's dispatch recheck (ORCH36 ruling, option B; migration 0203). Never a
// command: no API route, command-line verb or agent operation reaches it, and
// the run row goes in through `ops_astro_occurrence`, the one role 0203 lets
// write an origin. docs/local/RUNTIME.md, "An automation occurrence's run",
// has the design.

import { createHash, randomUUID } from 'node:crypto';
import {
  advisoryLock,
  deriveSource,
  isRecordsRefusal,
  nextTaskKey,
  planTaskPlacement,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuse, type RuntimeResult } from '../../../core-runtime/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { readTaskSpine } from './context.ts';

export type ApprovalState = 'standing' | 'revoked' | 'ended' | 'superseded';

/** The facts C52-A reads for one occurrence, under the activation's lock. */
export interface OccurrenceAuthority {
  readonly approvalId: string;
  readonly approvalState: ApprovalState;
  readonly approverActorId: string;
  readonly definitionId: string;
  readonly definitionVersionId: string;
  readonly versionState: 'released' | 'revoked';
  readonly contentDigest: string;
  readonly contentSize: number;
  /** The definition's own client, or none for the business's own work. */
  readonly clientId: string | null;
  readonly title: string;
}

export type ReadOccurrenceAuthority = (
  tx: TenantQuery,
  occurrenceId: string,
) => Promise<OccurrenceAuthority | undefined>;

export interface OccurrenceRunRequest {
  readonly occurrenceId: string;
  readonly workerActorId: string;
}

export interface OccurrenceRun {
  readonly runId: string;
  readonly taskId: string;
  readonly replayed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const TITLE_LIMIT = 500;

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function unknownOccurrence(): RuntimeResult<never> {
  return refuse(
    'OCCURRENCE_UNKNOWN',
    'no occurrence by that id is waiting for a run in this business',
    'Only an occurrence C33 recorded and C52-A dispatched starts a run.',
  );
}

function workerRequired(): RuntimeResult<never> {
  return refuse(
    'WORKER_REQUIRED',
    "an occurrence's run is written by an active worker of this business",
    'A person or an agent never starts it; the worker does, after the dispatch recheck.',
  );
}

/** The definition facts, whole and well formed, or why not. */
function checkAuthority(authority: OccurrenceAuthority): RuntimeResult<OccurrenceAuthority> {
  const whole =
    isUuid(authority.approvalId) &&
    isUuid(authority.definitionId) &&
    isUuid(authority.definitionVersionId) &&
    DIGEST.test(authority.contentDigest) &&
    Number.isSafeInteger(authority.contentSize) &&
    authority.contentSize >= 0 &&
    (authority.clientId === null || isUuid(authority.clientId)) &&
    authority.title.trim().length > 0 &&
    authority.title.length <= TITLE_LIMIT;
  if (!whole) {
    return refuse(
      'DEFINITION_UNAVAILABLE',
      "the occurrence's definition version is not whole: its id, digest, size, client or title is malformed",
      'Nothing is resolved by name; release the version again through C33.',
    );
  }
  if (authority.approvalState !== 'standing' || !isUuid(authority.approverActorId)) {
    return refuse(
      'APPROVAL_NOT_STANDING',
      "the occurrence's standing approval was revoked, ended or superseded",
      'A person approves the activation again on its pinned version before it runs.',
    );
  }
  if (authority.versionState !== 'released') {
    return refuse(
      'DEFINITION_REVOKED',
      'the definition version the activation pins was revoked',
      'Repoint the activation to a released version, and approve it again.',
    );
  }
  return { ok: true, value: authority };
}

/** Whether the actor is one of this business's, of the kind asked for (a worker only while active). */
async function isActor(
  tx: TenantQuery,
  actorId: string,
  kind: 'worker' | 'person',
): Promise<boolean> {
  if (!isUuid(actorId)) return false;
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.actors
      where business_id = $1 and id = $2 and kind = $3 and (active or kind <> 'worker')`,
    [tx.businessId, actorId, kind],
  );
  return rows.length === 1;
}

async function existingRun(
  tx: TenantQuery,
  occurrenceId: string,
): Promise<OccurrenceRun | undefined> {
  const rows = await tx.query<{ readonly id: string; readonly task_id: string }>(
    `select id, task_id from public.planned_runs
      where business_id = $1 and origin_occurrence_id = $2`,
    [tx.businessId, occurrenceId],
  );
  const found = rows[0];
  return found === undefined
    ? undefined
    : { runId: found.id, taskId: found.task_id, replayed: true };
}

async function writeTask(tx: TenantQuery, authority: OccurrenceAuthority): Promise<string> {
  const spine = await readTaskSpine(tx);
  const placement = await planTaskPlacement(tx, spine.taskTypeId, {
    parentId: null,
    board: null,
    boardSection: null,
    suppliedKeys: ['title'],
  });
  if (isRecordsRefusal(placement)) {
    throw new Error(`startOccurrenceRun: a top-level task was not placed (${placement.code})`);
  }
  const state = spine.states.find((row) => row.machineCategory === 'unstarted')?.id;
  const id = randomUUID();
  const data: Record<string, unknown> = {
    title: authority.title,
    key: await nextTaskKey(tx, spine.taskTypeId),
    source: deriveSource('system', 'automation'),
    intake_state: 'accepted',
    board_rank: placement.boardRank,
    ...(state === undefined ? {} : { state }),
    ...(authority.clientId === null ? {} : { client: authority.clientId.toLowerCase() }),
  };
  await tx.query(
    `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
    [tx.businessId, id, spine.taskTypeId, data],
  );
  return id;
}

/** The run row, through the one role the database lets write an origin. */
async function writeRun(
  tx: TenantQuery,
  run: { readonly id: string; readonly taskId: string; readonly occurrenceId: string },
  authority: OccurrenceAuthority,
): Promise<void> {
  await tx.query(`select set_config('role', 'ops_astro_occurrence', true)`);
  await tx.query(
    `insert into public.planned_runs
       (business_id, id, task_id, origin_occurrence_id, origin_definition_id,
        origin_approved_by_actor_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      tx.businessId,
      run.id,
      run.taskId,
      run.occurrenceId,
      authority.definitionId,
      authority.approverActorId,
    ],
  );
  await tx.query(`select set_config('role', 'none', true)`);
}

async function writePin(
  tx: TenantQuery,
  runId: string,
  authority: OccurrenceAuthority,
  workerActorId: string,
): Promise<void> {
  const manifest = [
    {
      definitionVersionId: authority.definitionVersionId,
      digest: authority.contentDigest,
      size: authority.contentSize,
    },
  ];
  await tx.query(
    `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, content_digest, content_size, definition_version_id,
        manifest, manifest_digest, pinned_by_actor_id)
     values ($1, $2, 'definition_version', $3, $4, $5, $6::text::jsonb, $7, $8)`,
    [
      tx.businessId,
      runId,
      authority.contentDigest,
      authority.contentSize,
      authority.definitionVersionId,
      JSON.stringify(manifest),
      sha256(JSON.stringify(manifest)),
      workerActorId,
    ],
  );
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** One `occurrence.run_start` event by the worker, naming every fact the run carries. */
async function auditStart(
  tx: TenantQuery,
  run: {
    readonly occurrenceId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly workerActorId: string;
  },
  authority: OccurrenceAuthority,
): Promise<void> {
  await writeAuditEvent(tx, {
    actorId: run.workerActorId,
    command: 'occurrence.run_start',
    outcome: 'applied',
    subjectRecordId: run.taskId,
    payloadDigest: sha256(
      JSON.stringify({
        occurrenceId: run.occurrenceId,
        runId: run.runId,
        taskId: run.taskId,
        definitionId: authority.definitionId,
        definitionVersionId: authority.definitionVersionId,
        approvalId: authority.approvalId,
        approverActorId: authority.approverActorId,
      }),
    ),
  });
}

/**
 * Starts the one run an occurrence asks for, or answers the run it already
 * has. Refuses before any write: a malformed or unknown occurrence, a caller
 * that is not an active worker of this business, and an approval or version
 * that no longer stands.
 */
export async function startOccurrenceRun(
  tx: TenantQuery,
  request: OccurrenceRunRequest,
  readAuthority: ReadOccurrenceAuthority,
): Promise<RuntimeResult<OccurrenceRun>> {
  if (!isUuid(request.occurrenceId)) return unknownOccurrence();
  const occurrenceId = request.occurrenceId.toLowerCase();
  if (!(await isActor(tx, request.workerActorId, 'worker'))) return workerRequired();
  const workerActorId = request.workerActorId.toLowerCase();
  // Held to commit: a second start of this occurrence waits here and then
  // answers the first run.
  await advisoryLock(tx, `occurrence_run:${tx.businessId}:${occurrenceId}`);
  const earlier = await existingRun(tx, occurrenceId);
  if (earlier !== undefined) return { ok: true, value: earlier };

  const read = await readAuthority(tx, occurrenceId);
  if (read === undefined) return unknownOccurrence();
  const checked = checkAuthority(read);
  if (!checked.ok) return checked;
  const authority = checked.value;
  if (!(await isActor(tx, authority.approverActorId, 'person'))) {
    return refuse(
      'APPROVAL_NOT_STANDING',
      "the occurrence's standing approval names no person of this business",
      'A person approves the activation again on its pinned version before it runs.',
    );
  }

  const taskId = await writeTask(tx, authority);
  const runId = randomUUID();
  await writeRun(tx, { id: runId, taskId, occurrenceId }, authority);
  await writePin(tx, runId, authority, workerActorId);
  await auditStart(tx, { occurrenceId, runId, taskId, workerActorId }, authority);
  return { ok: true, value: { runId, taskId, replayed: false } };
}
