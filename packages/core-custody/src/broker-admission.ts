// SPDX-License-Identifier: AGPL-3.0-only
//
// A send admitted again at custody's handoff (custody.ts, `Admit`): the
// judgement runs in a transaction held open until custody says `started`, so a
// change to what the send rests on that commits after the judgement waits
// until custody has the request, and one that committed before it sends
// nothing (`CUSTODY_NOT_ADMITTED`). The paid chat path (#1508) and owner line
// 72's subscription sends (#1619) take it.
//
// Owner line 72 (ops-astro-roadmap `docs/decisions/execution.md`, 28 September
// and 13 October 2026): a subscription send is judged again at the handoff, so
// a client linked to its task, a client's write on it, or a turn by someone
// else in its conversation, landing after the start, never reaches the seat.

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { eligibleRoutes } from '../../core-connectors/src/index.ts';
import { conversationSource } from './broker-conversation-source.ts';
import type { ConversationCallRequest } from './broker-conversation-types.ts';
import type { ReservedCall } from './broker-reserve.ts';
import { resolveFields } from './broker-sources.ts';
import { lockTask } from './broker-task.ts';
import type { ModelCallRequest } from './broker-types.ts';
import type { Admission, Admit } from './custody.ts';

/** A promise and the one call that settles it. */
export function opened<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
  const box: { settle?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    box.settle = resolve;
  });
  return { promise, settle: (value) => box.settle?.(value) };
}

/**
 * The admission: `open` runs the work in a transaction of its own; `judge`
 * decides in it. Admitted, the transaction stays open; at custody's `started`
 * it answers one statement more before custody sends (`go`). Anything else,
 * including a lock held elsewhere or a transaction lost, admits nothing.
 */
export function admittedBy(
  open: (work: (tx: TenantQuery) => Promise<void>) => Promise<unknown>,
  judge: (tx: TenantQuery) => Promise<boolean>,
): Admit {
  return async () => {
    const verdict = opened<Admission | undefined>();
    const step = opened<boolean>();
    const held = opened<boolean>();
    const admitted: Admission = {
      go: async () => {
        step.settle(true);
        return await held.promise;
      },
      end: () => step.settle(false),
    };
    const lost = (): void => {
      verdict.settle(undefined);
      held.settle(false);
    };
    void open(async (tx) => {
      if (!(await judge(tx))) return;
      verdict.settle(admitted);
      if (!(await step.promise)) return;
      await tx.query('select 1');
      held.settle(true);
    }).then(lost, lost);
    return await verdict.promise;
  };
}

/** The call is still `dispatched`, under its own lock: a swept call is never sent. */
export async function stillDispatched(tx: TenantQuery, callId: string): Promise<boolean> {
  const [call] = await tx.query<{ readonly state: string }>(
    'select state from public.model_calls where business_id = $1 and id = $2 for update',
    [tx.businessId, callId],
  );
  return call?.state === 'dispatched';
}

/**
 * A task run's subscription send: the task held `for share`, then no client,
 * and every field still one the subscription may carry, judged from the rows.
 */
export function taskAdmission(
  database: Database,
  businessId: BusinessId,
  request: ModelCallRequest,
  reserved: ReservedCall,
): Admit {
  return admittedBy(
    async (work) => await database.withBusiness(businessId, work),
    async (tx) => {
      if (!(await stillDispatched(tx, reserved.callId))) return false;
      const task = await lockTask(tx, request.leaseId);
      if (task === undefined || task.clientId !== null) return false;
      const resolved = resolveFields(request.fields, task.source);
      if (!resolved.ok) return false;
      const still = eligibleRoutes(reserved.operation.fields, resolved.fields, [reserved.route]);
      return still.ok;
    },
  );
}

/**
 * A conversation's subscription send: its row, its page task and its owner's
 * membership held `for share`, then the conversation still the owner's own
 * work with no client, judged from the rows.
 */
export function conversationAdmission(
  database: Database,
  businessId: BusinessId,
  request: ConversationCallRequest,
  callId: string,
): Admit {
  return admittedBy(
    async (work) => await database.withBusiness(businessId, work),
    async (tx) => {
      if (!(await stillDispatched(tx, callId))) return false;
      await tx.query(
        'select 1 from public.conversations where business_id = $1 and id = $2 for share',
        [tx.businessId, request.conversation.id],
      );
      await tx.query(
        `select 1 from public.records t join public.conversations c
            on c.business_id = t.business_id and c.scope_record_id = t.id
          where c.business_id = $1 and c.id = $2 for share of t`,
        [tx.businessId, request.conversation.id],
      );
      await tx.query(
        `select 1 from public.memberships m join public.conversations c
            on c.business_id = m.business_id and c.owner_person_id = m.person_id
          where c.business_id = $1 and c.id = $2 and m.active for share of m`,
        [tx.businessId, request.conversation.id],
      );
      const source = await conversationSource(tx, request);
      return source.ownerWork && !source.clientWork;
    },
  );
}

/** A conversation send's judgement at the handoff: a subscription's only (owner line 72). */
export function conversationAdmitFor(
  database: Database,
  businessId: BusinessId,
  request: ConversationCallRequest,
  route: { readonly credentialKind: string },
): ((callId: string) => Admit) | undefined {
  if (route.credentialKind !== 'subscription') return undefined;
  return (callId) => conversationAdmission(database, businessId, request, callId);
}
