// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's approval gate (#859, addendum 2 item 3), on the product's own gate.
// Two things need the owner's yes: raising the local cap (to USD 30, the
// owner's named ceiling) and any model other than Haiku. There is no second
// gate kind. When the local agent's call is refused for either, the agent
// hands its work back failed with a successor proposal of purpose
// `local_agent_approval`; that proposal's pending gate raises the ordinary
// decision item in the owner's inbox (INB-1b). While one is open for the same
// need, a refused piece of work is handed back with no successor, so the
// owner is asked once.
//
// The owner's yes approves the proposal, which makes it queued work like any
// other. `applyApprovals` is the agent doing that work: it picks it up, writes
// exactly what the item named into OPS_LOCAL_AGENT_HOME/approvals.json, and
// hands it back completed, with no model call. A no rejects the gate and
// nothing is queued, so nothing is written. Run `applyApprovals` before the
// tick's task pass, so the approval's own work is never sent to the model.
//
// Both refuse unless OPS_ENVIRONMENT is exactly `local`, before any read.
// The open-need check and the handback are not one transaction: the local
// tick runs one piece of work at a time, so two raises never race there.

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeAgentCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import type {
  BusinessId,
  Database,
  VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { queue, type QueueEntry } from '../../packages/core-runtime/src/index.ts';
import { DEFAULT_MODEL, MODEL_NAME } from './gate.ts';
import { readApprovals } from './settings.ts';
import { localOnly, type Environment, type Refused } from './tick.ts';

export const APPROVAL_PURPOSE = 'local_agent_approval';

/** The cap a raise asks for: the owner's own next step (addendum 2), never more. */
export const RAISED_CAP_USD = 30;

export type Need =
  | { readonly kind: 'cap'; readonly capUsd: number }
  | { readonly kind: 'model'; readonly model: string };

export type NeedCode = 'LOCAL_CAP_REACHED' | 'LOCAL_MODEL_NOT_APPROVED';

/** What a refusal asks the owner for. */
export function needOf(code: NeedCode, model: string): Need {
  return code === 'LOCAL_CAP_REACHED'
    ? { kind: 'cap', capUsd: RAISED_CAP_USD }
    : { kind: 'model', model };
}

export interface ApprovalOptions {
  readonly environment: Environment;
  readonly database: Database;
  readonly businessId: BusinessId;
  /** The agent's own login, as the tick holds it. */
  readonly agent: VerifiedSubject;
  /** OPS_LOCAL_AGENT_HOME: where the runner reads approvals.json. */
  readonly home: string;
  /** The successor's currency; the business's cap currency. */
  readonly currency?: string;
}

/** The lease the refused work is held under, as its pickup returned it. */
export interface HeldLease {
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

export type Raised =
  | { readonly ok: true; readonly raised: boolean }
  | Refused
  | { readonly ok: false; readonly code: string };

export type Applied = { readonly ok: true; readonly applied: readonly Need[] } | Refused;

const askOf = (need: Need): string =>
  need.kind === 'cap'
    ? `Raise the local agent's cap to USD ${String(need.capUsd)}`
    : `Let the local agent run on ${need.model}`;

/** A stored need, read strictly: a cap no higher than the named ceiling, or a model by name. */
function readNeed(payload: unknown): Need | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const need = (payload as Record<string, unknown>)['localAgentApproval'];
  if (need === null || typeof need !== 'object') return undefined;
  const shape = need as Record<string, unknown>;
  const { capUsd, model } = shape;
  if (shape['kind'] === 'cap' && typeof capUsd === 'number') {
    return Number.isFinite(capUsd) && capUsd > 0 && capUsd <= RAISED_CAP_USD
      ? { kind: 'cap', capUsd }
      : undefined;
  }
  if (shape['kind'] === 'model' && typeof model === 'string') {
    return MODEL_NAME.test(model) && model !== DEFAULT_MODEL ? { kind: 'model', model } : undefined;
  }
  return undefined;
}

const sameNeed = (a: Need, b: Need): boolean =>
  a.kind === 'cap' && b.kind === 'cap'
    ? a.capUsd === b.capUsd
    : a.kind === 'model' && b.kind === 'model' && a.model === b.model;

/** The needs whose approval gate is still pending in this business. */
async function openNeeds(options: ApprovalOptions): Promise<readonly Need[]> {
  const rows = await options.database.withBusiness(
    options.businessId,
    async (tx) =>
      await tx.query<{ readonly payload: unknown }>(
        `select v.payload
         from public.gates g
         join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
        where g.business_id = $1 and g.state = 'pending' and v.purpose = $2`,
        [tx.businessId, APPROVAL_PURPOSE],
      ),
  );
  return rows.map((row) => readNeed(row.payload)).filter((need) => need !== undefined);
}

/**
 * Hand refused work back, asking the owner through a successor proposal unless
 * the same ask is already open.
 */
export async function raiseApproval(
  options: ApprovalOptions,
  lease: HeldLease,
  need: Need,
): Promise<Raised> {
  const refused = localOnly(options.environment);
  if (refused !== undefined) return refused;
  const raised = !(await openNeeds(options)).some((open) => sameNeed(open, need));
  const ask = askOf(need);
  const successor = {
    purpose: APPROVAL_PURPOSE,
    maximumMinor: 1,
    currency: options.currency ?? 'AUD',
    payload: { localAgentApproval: need, ask },
    step: { kind: APPROVAL_PURPOSE, payload: {} },
  };
  const handedBack = await executeAgentCommand(
    options.database,
    options.businessId,
    options.agent,
    lease.credential,
    {
      command: 'task.handback',
      operationId: randomUUID(),
      leaseId: lease.leaseId,
      fence: lease.fence,
      outcome: 'failed',
      report: { summary: `needs the owner's yes: ${ask}` },
      actualMinor: null,
      ...(raised ? { successor } : {}),
    } as never,
  );
  if (isCommandRefusal(handedBack)) return { ok: false, code: handedBack.code };
  return { ok: true, raised };
}

/** approvals.json with the need added, written whole and renamed into place. */
function writeApproval(home: string, need: Need): void {
  const current = readApprovals(home);
  const models =
    need.kind === 'model' && !current.models.includes(need.model)
      ? [...current.models, need.model]
      : [...current.models];
  const capUsd = need.kind === 'cap' ? need.capUsd : current.capUsd;
  const next = capUsd === null ? { models } : { capUsd, models };
  mkdirSync(home, { recursive: true });
  const file = join(home, 'approvals.json');
  const staged = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(staged, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  renameSync(staged, file);
}

/** The agent doing one approved approval: pick it up, write it, hand it back. */
async function applyOne(options: ApprovalOptions, entry: QueueEntry): Promise<Need | undefined> {
  const { database, businessId, agent } = options;
  const picked = await executeAgentCommand(database, businessId, agent, undefined, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: entry.reservationId,
    leaseSeconds: 120,
  } as never);
  if (isCommandRefusal(picked)) return undefined;
  const [row] = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly payload: unknown }>(
        `select payload from public.proposal_versions where business_id = $1 and id = $2`,
        [tx.businessId, entry.versionId],
      ),
  );
  const need = readNeed(row?.payload);
  if (need !== undefined) writeApproval(options.home, need);
  await executeAgentCommand(database, businessId, agent, String(picked.detail['credential']), {
    command: 'task.handback',
    operationId: randomUUID(),
    leaseId: picked.detail['leaseId'],
    fence: picked.detail['fence'],
    outcome: need === undefined ? 'failed' : 'completed',
    report: {
      summary: need === undefined ? 'the approval named nothing usable' : 'approval recorded',
    },
    actualMinor: null,
  } as never);
  return need;
}

/** One pass: every approved local-agent approval written once, in order. */
export async function applyApprovals(options: ApprovalOptions): Promise<Applied> {
  const refused = localOnly(options.environment);
  if (refused !== undefined) return refused;
  const entries = await options.database.withBusiness(
    options.businessId,
    async (tx) => await queue(tx),
  );
  const applied: Need[] = [];
  for (const entry of entries.filter((queued) => queued.purpose === APPROVAL_PURPOSE)) {
    // Sequential: each writes approvals.json in turn.
    // eslint-disable-next-line no-await-in-loop
    const need = await applyOne(options, entry);
    if (need !== undefined) applied.push(need);
  }
  return { ok: true, applied };
}
