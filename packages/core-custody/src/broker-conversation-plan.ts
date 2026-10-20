// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's typed message on his ChatGPT plan (#2175, money rule P4). The
// plan carries only work the owner started (`carry-rule.ts`), and in the side
// chat that is his own typed words in his own conversation: his own session,
// no delegation, every person turn sent written by him, and the page and each
// task an earlier exchange sent his own work (owner line 72, `ownersOwn`: he
// created it while holding the owner role, it has no client, and no agent or
// client wrote it). Only then are the fields owner work, which lets free text
// take a subscription's cloud route (`data-class.ts`).
//
// Before the call is written, and again at a carried call's offer and send
// (`carriage-origin.ts`), the broker judges it under its locks: each task held
// `for share` and read after its wait, then the caller's own owner membership
// held `for share`, so a role ended or a task written meanwhile commits first
// and is seen, or waits. Like `carry-rule.ts`, nothing here is a background
// path: one call per typed message, asked only by the exchange.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { eligibleRoutes, type ModelOperation } from '../../core-connectors/src/index.ts';
import { readPage } from './broker-task.ts';
import { ownersOwn } from './broker-sources.ts';
import { carriesOnPlan, mayCarry } from './carry-rule.ts';
import type {
  Broker,
  BrokerRefusal,
  BrokerRoute,
  ClaimedField,
  ModelCaller,
  ResolvedField,
} from './broker-types.ts';

/** What the exchange read of the asked message, for the plan's judgement (#2175). */
export interface PlanAsk {
  /** Who wrote each person turn sent: the asked message and the earlier ones. */
  readonly authors: readonly string[];
  /** The page task the request carries, or null. */
  readonly page: string | null;
  /** The tasks the earlier exchanges sent may carry (#1666). */
  readonly sources: readonly string[];
}

/** The fields the side chat sends; `message` always among them. */
const TYPED: ReadonlySet<string> = new Set(['page', 'earlier', 'message']);

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The caller's own typed words: only the chat's fields, each person turn theirs. */
function ownTyped(fields: readonly ClaimedField[], caller: ModelCaller, plan: PlanAsk): boolean {
  const names = new Set(fields.map((field) => field.name));
  return (
    names.size === fields.length &&
    names.has('message') &&
    [...names].every((name) => TYPED.has(name)) &&
    plan.authors.length > 0 &&
    plan.authors.every((author) => sameId(author, caller.actorId))
  );
}

/**
 * The plan's route for the caller's own typed message, with its fields as
 * owner work, or why not. The page and the earlier tasks are judged under the
 * locks (`planHolds`); a field anyone else wrote stays `outside`, which no
 * cloud route takes.
 */
export function planRoute(
  operation: ModelOperation,
  claimed: readonly ClaimedField[],
  caller: ModelCaller,
  broker: Broker,
  plan: PlanAsk | undefined,
):
  | {
      readonly ok: true;
      readonly route: BrokerRoute;
      readonly fields: readonly ResolvedField[];
    }
  | { readonly ok: false; readonly code: BrokerRefusal } {
  const route = broker.routes.find(
    (one) => carriesOnPlan(one) && one.provider === operation.provider,
  );
  if (route === undefined || plan === undefined) return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  const own = ownTyped(claimed, caller, plan);
  const fields = own
    ? claimed.map((field) => ({
        name: field.name,
        source: 'business_internal' as const,
        value: field.value,
        ownerWork: true,
      }))
    : claimed.map((field) => ({
        name: field.name,
        source: field.source === 'business_internal' ? ('outside' as const) : field.source,
        value: field.value,
      }));
  if (!eligibleRoutes(operation.fields, fields, [route]).ok) {
    return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  }
  const carry = mayCarry(route.credentialKind, {
    unattended: false,
    sessionPersonId: caller.attendedByPersonId,
    workForPersonId: caller.attendedByPersonId,
    tenantInstallation: broker.installation,
    credentialInstallation: route.installation,
    planRoute: true,
    ownerStarted: own,
  });
  return carry.ok ? { ok: true, route, fields } : { ok: false, code: carry.code };
}

/**
 * The plan's standing again, under its locks, in the transaction that writes
 * or sends the call: each task held `for share` in id order and read after the
 * wait (a statement that waits keeps its earlier view of the operations), then
 * the person's open owner membership held `for share`, its row read again once
 * any change to it commits. Undefined when it stands.
 */
export async function planHolds(
  tx: TenantQuery,
  personId: string | null,
  plan: Pick<PlanAsk, 'page' | 'sources'>,
): Promise<BrokerRefusal | undefined> {
  const tasks = [...new Set([plan.page, ...plan.sources].filter((id) => id !== null))].toSorted();
  for (const task of tasks) {
    // oxlint-disable-next-line no-await-in-loop -- one lock after another, in order
    await tx.query('select 1 from public.records where business_id = $1 and id = $2 for share', [
      tx.businessId,
      task,
    ]);
    // oxlint-disable-next-line no-await-in-loop -- read after its own lock's wait
    const read = await readPage(tx, task);
    if (read === undefined || read.clientId !== null || !ownersOwn(read.source)) {
      return 'LOCAL_MODEL_REQUIRED';
    }
  }
  const owner = await tx.query(
    `select 1 from public.memberships
      where business_id = $1 and person_id = $2 and role_key = 'owner'
        and active and ended_at is null
      for share`,
    [tx.businessId, personId],
  );
  return owner.length > 0 ? undefined : 'SUBSCRIPTION_NOT_OWNER_STARTED';
}
