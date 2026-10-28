// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's claims through the queue (`docs/local/SITE-RUNNER.md`, "The lease"): the
// `site_publish` work a person approved, picked up as the runner's agent
// actor, renewed while followed, and handed back once settled. Each pickup's
// credential is kept in memory for its lease and never written anywhere: a
// restarted runner leaves its old lease to lapse, and the sweep puts the work
// back on the queue. Finding the task's correction grants nothing: every read
// under the lease is checked again by `readCorrectionForRun`.

import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import type { Claim, Claims } from './runner.ts';

/** An agent call's settled answer: a success's detail, a refusal's code, or no usable answer. */
export type Answer =
  | { readonly detail: Readonly<Record<string, unknown>> }
  | { readonly refused: string }
  | { readonly fault: true };

/** One agent call, under the pickup's credential when it acts on a lease. */
export type AgentCall = (
  verb: string,
  body: Readonly<Record<string, unknown>>,
  pickup?: string,
) => Promise<Answer>;

/** The purpose a person's Launch gives the step that puts a correction's task on the queue. */
export const SITE_PURPOSE = 'site_publish';

/** The task's oldest correction the runner can run under its lease, or nothing. */
async function correctionOn(
  db: Database,
  business: BusinessId,
  taskId: string,
): Promise<string | undefined> {
  return await db.withBusiness(business, async (tx) => {
    const [row] = await tx.query<{ readonly id: string }>(
      `select id from public.live_corrections
        where business_id = $1 and task_id = $2 and state in ('approved', 'accepted', 'unknown')
        order by created_at, id limit 1`,
      [tx.businessId, taskId],
    );
    return row?.id;
  });
}

/** What a refusal's code may be when printed: the server's text it came with never is. */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** A refusal's code as it may be printed or reported: `unreadable` when it does not read as one. */
export const printable = (refused: string): string => (CODE.test(refused) ? refused : 'unreadable');

/**
 * A `task.queue` the runner could not read: refused, with its code, or with no
 * usable answer. The pass fails on it, never reading the queue as empty.
 */
export class QueueUnread extends Error {
  /** The refusal's code when it reads as one, `unreadable` when not; none for a fault. */
  readonly code: string | undefined;

  constructor(refused?: string) {
    const code = refused === undefined ? refused : printable(refused);
    super(
      code === undefined ? 'the queue gave no usable answer' : `the queue was refused: ${code}`,
    );
    this.name = code === undefined ? 'QueueFault' : 'QueueRefused';
    this.code = code;
  }
}

/** The queue's work; a refused queue, or one with no list of work, fails the pass. */
function entriesOf(answer: Answer): readonly Readonly<Record<string, unknown>>[] {
  if ('refused' in answer) throw new QueueUnread(answer.refused);
  const queue = 'detail' in answer ? answer.detail['queue'] : undefined;
  if (!Array.isArray(queue)) throw new QueueUnread();
  return queue as readonly Readonly<Record<string, unknown>>[];
}

/** The queue's work as the agent reads it; one it could not read throws `QueueUnread`. */
export async function queueOf(
  call: AgentCall,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  // A call that never answered is a queue with no usable answer too.
  return entriesOf(await call('task.queue', {}).catch(() => ({ fault: true }) as const));
}

type Lease = Omit<Claim, 'correctionId' | 'taskId'>;

/** The lease handed back with its pickup's credential: completed once live, else failed. */
async function handBack(
  call: AgentCall,
  pickups: Map<string, string>,
  lease: Lease,
  outcome: string,
): Promise<void> {
  const pickup = pickups.get(lease.leaseId);
  pickups.delete(lease.leaseId);
  // A lost lease has nothing left to hand back.
  if (pickup === undefined || outcome === 'LEASE_LOST') return;
  const { leaseId, fence } = lease;
  const done = outcome === 'live' ? 'completed' : 'failed';
  const body = { leaseId, fence, outcome: done, report: { correction: outcome } };
  await call('task.handback', body, pickup);
}

/** The claims, and a person task raised on a claim's task: an internal comment under its lease. */
export interface QueueClaims extends Claims {
  readonly raise: (claim: Claim, reason: string) => Promise<void>;
  /** The lease holder the API named in its last pickup answer: the runner's own actor. */
  readonly holder: () => string;
}

export function queueClaims(call: AgentCall, db: Database, business: BusinessId): QueueClaims {
  const pickups = new Map<string, string>();
  let holder = '';
  // A pickup whose answer is lost holds a lease nobody renews: it lapses and the sweep returns it.
  const pick = async (entry: Readonly<Record<string, unknown>>): Promise<Claim | undefined> => {
    const picked = await call('task.pickup', { reservationId: entry['reservationId'] });
    if (!('detail' in picked)) return undefined;
    const lease = {
      leaseId: String(picked.detail['leaseId']),
      fence: Number(picked.detail['fence']),
    };
    pickups.set(lease.leaseId, String(picked.detail['credential']));
    holder = String(picked.detail['holderActorId'] ?? '');
    const taskId = String(entry['taskId']);
    const correctionId = await correctionOn(db, business, taskId);
    if (correctionId !== undefined) return { correctionId, taskId, ...lease };
    await handBack(call, pickups, lease, 'NO_RUNNABLE_CORRECTION');
    return undefined;
  };
  return {
    holder: () => holder,
    async take() {
      const queued = await queueOf(call);
      const claims: Claim[] = [];
      for (const entry of queued.filter((work) => work['purpose'] === SITE_PURPOSE)) {
        // oxlint-disable-next-line no-await-in-loop -- one pickup at a time, each its own lease
        const claim = await pick(entry);
        if (claim !== undefined) claims.push(claim);
      }
      return claims;
    },
    async beat({ leaseId, fence }) {
      const pickup = pickups.get(leaseId);
      if (pickup === undefined) return false;
      return 'detail' in (await call('task.heartbeat', { leaseId, fence }, pickup));
    },
    release: async (claim, outcome) => await handBack(call, pickups, claim, outcome),
    async raise({ leaseId, taskId }, reason) {
      const body = { recordId: taskId, body: `Site runner: ${reason}`, audience: 'internal' };
      await call('task.comment', body, pickups.get(leaseId));
    },
  };
}
