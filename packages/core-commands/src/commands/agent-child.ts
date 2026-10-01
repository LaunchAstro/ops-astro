// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11's two agent operations, the operands, serves and replays their rows
// in `agent-operations.ts` are built from:
//
//   run.delegate_child   the parent's holder hands part of its work to a
//                        helper on its own lease, at its own fence. The parent
//                        is the delegation `authorise` resolved from the
//                        caller's credential (`run:write` on the lease's task),
//                        never one the body names; the runtime binds it to the
//                        lease under the locks (`delegateChild`).
//   run.child_handback   the helper hands its work back on its own child
//                        credential, which the runtime binds to the helper's
//                        own login (`handBackChild`). No grant is asked: a
//                        revoked or run-out child still hands back its partial
//                        work, and a handback grants nothing.
//
// Neither answer's credential reaches the register (`agent-applied.ts`): the
// hand-over's replay derives the child's credential again, as a pickup's does.

import {
  digestOf,
  isUuid,
  resolveDelegation,
  DERIVED_SCHEME,
} from '../../../core-records/src/index.ts';
import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import {
  delegateChild,
  delegationCredentialKeys,
  handBackChild,
  type ChildHandback,
  type ChildPickup,
} from '../../../core-runtime/src/index.ts';
import type { AgentCall, AgentRequest } from './agent-call.ts';
import { refused, type HandlerOutcome, type Refused } from './outcome.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type { CommandHandle } from './register-store.ts';
import { MAXIMUM_LEASE_SECONDS } from './tasks-pickup.ts';

export interface DelegateChildOperands {
  readonly leaseId: string;
  readonly fence: number;
  readonly helperActorId: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly actions: readonly ChildAction[];
  readonly expiresInSeconds: number;
}

type ChildAction = 'read' | 'comment' | 'write' | 'assign' | 'share' | 'manage' | 'decide';

/**
 * `decide` is read here so the mint refuses it by name
 * (`DELEGATION_EXCLUDES_DECISION`); anything outside the grant model is the
 * body's fault.
 */
const ACTIONS: ReadonlySet<string> = new Set([
  'read',
  'comment',
  'write',
  'assign',
  'share',
  'manage',
  'decide',
]);

/** The delegation row's own key shape (0008 `delegations_purpose_shape`). */
const KEY = /^[a-z][a-z0-9_]{0,62}$/u;

const invalid = (field: string, fix: string, value: unknown): Refused =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], [fix]), { [field]: value });

const keys = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === 'string' && KEY.test(item));

/**
 * The hand-over's body by its JSON types, before any authority is read. A
 * lease id that is not a string names no lease and is answered as one that
 * does not exist, as the handback's is.
 */
export function delegateChildOperands(request: AgentRequest): DelegateChildOperands | Refused {
  const { fence, helperActorId, purpose, collections, actions, expiresInSeconds } = request;
  if (typeof fence !== 'number' || !Number.isSafeInteger(fence)) {
    return invalid('fence', 'Send the fence the pickup handed you.', fence);
  }
  if (!isUuid(helperActorId)) {
    return invalid('helperActorId', 'Name the helper agent by its actor id.', helperActorId);
  }
  if (typeof purpose !== 'string' || !KEY.test(purpose)) {
    return invalid('purpose', 'A purpose is a short key: lower case, digits, _.', purpose);
  }
  if (!keys(collections)) {
    return invalid('collections', 'Name one or more collections, each a short key.', collections);
  }
  if (!Array.isArray(actions) || actions.length === 0 || !actions.every((a) => ACTIONS.has(a))) {
    return invalid('actions', 'Name one or more actions of the grant model.', actions);
  }
  if (
    typeof expiresInSeconds !== 'number' ||
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds <= 0 ||
    expiresInSeconds > MAXIMUM_LEASE_SECONDS
  ) {
    return invalid(
      'expiresInSeconds',
      `Send whole seconds, 1 to ${String(MAXIMUM_LEASE_SECONDS)}; the lease's end caps it.`,
      expiresInSeconds,
    );
  }
  return {
    leaseId: typeof request['leaseId'] === 'string' ? request['leaseId'] : '',
    fence,
    helperActorId: helperActorId.toLowerCase(),
    purpose,
    collections,
    actions: actions as readonly ChildAction[],
    expiresInSeconds,
  };
}

const NOT_A_HELPER = 'Name another agent of this business as the helper.';

export async function serveDelegateChild(
  tx: TenantQuery,
  _call: AgentCall,
  operands: DelegateChildOperands,
  parent: Delegation,
): Promise<HandlerOutcome> {
  // An agent of this business, or the same answer for anything else: a
  // person's id and a made-up one are one refusal, and neither reaches the
  // mint's foreign key.
  const helper = await tx.query(
    `select 1 from public.actors where business_id = $1 and id = $2 and kind = 'agent'`,
    [tx.businessId, operands.helperActorId],
  );
  if (helper.length === 0) return invalid('helperActorId', NOT_A_HELPER, operands.helperActorId);
  const handed = await delegateChild(tx, parent, {
    leaseId: operands.leaseId,
    fence: operands.fence,
    child: {
      agentActorId: operands.helperActorId,
      purpose: operands.purpose,
      collections: operands.collections,
      // `decide` never passes the mint, which refuses it by name first.
      actions: operands.actions as never,
      expiresAt: new Date(Date.now() + operands.expiresInSeconds * 1000),
    },
  });
  if (!handed.ok) return refused(handed.refusal);
  return { recordId: null, revision: null, detail: onTheWire(handed.value) };
}

/** The pickup as the register and the wire hold it: dates as ISO text, as a replay reads them. */
function onTheWire(pickup: ChildPickup): Readonly<Record<string, unknown>> {
  return {
    ...pickup,
    actorScope: { ...pickup.actorScope, expiresAt: pickup.actorScope.expiresAt.toISOString() },
  };
}

/**
 * The handback's body by its JSON types; whether the outcome is one and the
 * refusal registered is `handBackChild`'s, which asks before anything else.
 * Wrapped: parsed operands never carry a `refusal` key (`isOperandRefusal`),
 * and a partial handback's does.
 */
export function childHandbackOperands(
  request: AgentRequest,
): { readonly handback: ChildHandback } | Refused {
  const { outcome, refusal } = request;
  if (outcome === 'completed' && refusal === undefined) return { handback: { outcome } };
  if (outcome === 'partial' && typeof refusal === 'string') {
    return { handback: { outcome, refusal: refusal as never } };
  }
  return refused(
    refuseCommand(
      'COMMAND_BODY_INVALID',
      ['outcome', 'refusal'],
      ['Hand back completed work, or partial work naming the refusal that stopped it.'],
    ),
  );
}

export async function serveChildHandback(
  tx: TenantQuery,
  { session }: AgentCall,
  { handback }: { readonly handback: ChildHandback },
  credential: string,
): Promise<HandlerOutcome> {
  const back = await handBackChild(tx, { agentActorId: session.actorId, credential }, handback);
  if (!back.ok) return refused(back.refusal);
  return { recordId: null, revision: null, detail: { ...back.value, outcome: handback.outcome } };
}

const REPLAY_FIXES: readonly string[] = [
  'The helper this hand-over named has handed back, dropped or been withdrawn.',
  'Hand the work to a helper again with a new operation id.',
];

/**
 * A hand-over's replay, once `authorise` has passed the parent again as a
 * fresh call would. The child the receipt names is still live, still this
 * parent's, and its credential is derived again under its pinned key and
 * compared with the digest stored at mint. A settled, withdrawn or run-out
 * child releases nothing; a missing key or a mismatch is a closed failure.
 */
export async function replayChildPickup(
  tx: TenantQuery,
  { session, credential }: AgentCall,
  stored: CommandHandle,
): Promise<CommandHandle | CommandRefusal> {
  const parent =
    credential === undefined ? undefined : await resolveDelegation(tx, session.actorId, credential);
  const named = stored.detail['childDelegationId'];
  if (parent?.ok !== true || !isUuid(named)) return notLive();
  const found = await tx.query<{
    readonly agent_actor_id: string;
    readonly credential_hash: string;
    readonly credential_scheme: string;
    readonly credential_key_id: string | null;
  }>(
    `select agent_actor_id, credential_hash, credential_scheme, credential_key_id
       from public.delegations
      where business_id = $1 and id = $2 and parent_delegation_id = $3
        and settled_at is null and revoked_at is null and expires_at > now()`,
    [tx.businessId, named, parent.value.id],
  );
  const child = found[0];
  if (child === undefined) return notLive();
  const held = delegationCredentialKeys();
  const derived =
    child.credential_scheme !== DERIVED_SCHEME || child.credential_key_id === null || !held.ok
      ? undefined
      : held.keys.derive(child.credential_key_id, {
          businessId: tx.businessId,
          agentActorId: child.agent_actor_id,
          delegationId: named,
        });
  if (derived === undefined || digestOf(derived) !== child.credential_hash) {
    return refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      ['run.delegate_child', 'delegation credential integrity'],
      [
        "The helper's credential cannot be derived again as it was issued.",
        'Nothing was reissued. Restore the key this delegation was minted under.',
      ],
    );
  }
  return { ...stored, detail: { ...stored.detail, credential: derived } };
}

const notLive = (): CommandRefusal => refuseCommand('DELEGATION_NOT_LIVE', [], REPLAY_FIXES);

/**
 * A handback's replay: released only to the helper that made it, presenting
 * the same child credential. The child is settled by then, so no live check
 * could answer it; the receipt holds nothing the helper was not already told.
 */
export async function replayChildHandback(
  tx: TenantQuery,
  { session, credential, request }: AgentCall,
  stored: CommandHandle,
): Promise<CommandRefusal | undefined> {
  if (credential === undefined || credential === '') {
    return refuseCommand(
      'DELEGATION_EXCLUDES_OPERATION',
      [request.command],
      ['Present the credential your hand-over gave you.'],
    );
  }
  const named = stored.detail['childDelegationId'];
  const own = isUuid(named)
    ? await tx.query(
        `select 1 from public.delegations
          where business_id = $1 and id = $2 and agent_actor_id = $3 and credential_hash = $4
            and parent_delegation_id is not null`,
        [tx.businessId, named, session.actorId, digestOf(credential)],
      )
    : [];
  return own.length === 0 ? notLive() : undefined;
}
