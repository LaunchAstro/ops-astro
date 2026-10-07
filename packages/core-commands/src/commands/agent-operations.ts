// SPDX-License-Identifier: AGPL-3.0-only
//
// Each agent operation as one row: where its task comes from, which authority
// check it answers to, the operands it reads, what it does, how its replay is
// released and what it keeps when refused. The agent entry
// (`agent-envelope.ts`) runs every row through the same pipeline, so adding an
// operation is adding a row here rather than a branch in each step of it.

import { checkDelegatedAuthority, resolveDelegation } from '../../../core-records/src/index.ts';
import type { TenantQuery, AgentSession, Delegation } from '../../../core-records/src/index.ts';
import { readQueue } from '../reads/queue.ts';
import { READ_CATALOGUE } from '../reads/catalogue.ts';
import { READ_BODY_FIXES, ReadIntegrityFault } from '../reads/dispatch.ts';
import { DecisionIntegrityError } from '../reads/verified-decisions.ts';
import { readTaskDetail } from '../reads/tasks.ts';
import { blockersFor, isRefusal, parsePaging, taskAt } from '../reads/detail.ts';
import { businessKeyOf, type AgentCapabilities } from '../reads/capabilities.ts';
import type { Capability } from '../../../core-wire/src/index.ts';
import { readTaskSpine } from './context.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { CORRECTION_REQUEST } from './live-correction-agent.ts';
import { invalid, isFieldMap } from './operands.ts';
import type { CommandName } from '../../../core-wire/src/index.ts';
import { handbackLease } from './tasks-handback.ts';
import { pickupReservation } from './tasks-pickup.ts';
import { heartbeatLease } from './tasks-lease.ts';
import { handbackOperands, leaseSecondsOperand, pickupOperands } from './agent-operands.ts';
import { dispatchLease } from './tasks-dispatch.ts';
import { observeLease } from './tasks-observe.ts';
import { checkLease } from './tasks-check.ts';
import { reviseRunState } from './run-state.ts';
import { holdCoveringGrants, MAXIMUM_RENEWAL_SECONDS } from '../../../core-runtime/src/index.ts';
import { agentClaimant } from './tasks-claimant.ts';
import { writeStepResult } from './onboarding.ts';
import { delegationStillHolds } from './onboarding-authority.ts';
import { AGENT_AUDIENCES, writeTaskComment } from './tasks-comment.ts';
import { proposeFor, type ProposeFields } from './tasks-propose.ts';
import { deleteTaskComment, editTaskComment, type CommentChange } from './tasks-comment-edit.ts';
import { setScores } from './tasks-scores.ts';
import { setAdHoc } from './tasks-adhoc.ts';
import { setCategory } from './tasks-category.ts';
import { assignTaskAsAgent, updateTaskAsAgent } from './tasks-write.ts';
import { refused, type HandlerOutcome, type Refused } from './outcome.ts';
import {
  claimedSystemFields,
  expectedRevisionOf,
  irrelevantIdentifiers,
  lockTask,
  REVISION_FIXES,
  SYSTEM_OWNED_FIXES,
} from './prepare.ts';
import { retainLateHandback } from './agent-late-handback.ts';
import { modelCallOperands, type ModelCallOperands } from './model-call-operands.ts';
import {
  childHandbackOperands,
  delegateChildOperands,
  serveChildHandback,
  serveDelegateChild,
} from './agent-child.ts';
import type { AgentCall, AgentRequest, LeaseOperands, NoOperands } from './agent-call.ts';

/** What every kind of agent operation carries, over its own operands `O`. */
interface AgentOperationRow<O extends object> {
  /**
   * The identifier fields a read takes, from its person row (`READ_CATALOGUE`),
   * so the two entries refuse the same stray field in the same words. Any
   * other is refused before the operands. Absent on a
   * command, whose identifiers its own operands and handler read.
   */
  readonly identifiers?: readonly string[];
  /** The operands read before any authority, after the system-owned fields. */
  readonly operands: (request: AgentRequest) => O | Refused;
  /** How a stored success is released on replay (`agent-replay.ts`). */
  readonly replay:
    | 'reauthorise'
    | 'correctionRequest'
    | 'pickup'
    | 'serveAgain'
    | 'settledHandback'
    | 'childPickup'
    | 'childHandback';
  /** What an authority refusal keeps, when the operation keeps anything. */
  readonly onRefused?: (
    tx: TenantQuery,
    call: AgentCall,
    operands: O,
    refusal: CommandRefusal,
  ) => Promise<void>;
}

/**
 * One agent operation over its own operands `O`, by the check `authorise`
 * (`agent-authority.ts`) asks, so a row says whether it runs under a
 * delegation and nothing has to find out again:
 *
 * - `beforePickup`, the pair an agent login reaches holding nothing, served
 *   under no delegation;
 * - `purpose`, `read` on the delegation's own purpose record;
 * - `record`, the operation's own collection and action on the task the call
 *   is about, found where `subjectTask` says, and served on that task;
 * - `decision`, the runtime's `decideAsAgent`, which always refuses, so it has
 * no `serve` at all;
 * - `helper`, AW-11's handback: the presented child credential itself, which
 *   the runtime binds to the helper's own login, under no resolved delegation;
 * - `business`, the operation's own key over the whole business, which a
 *   delegation bounded to one task never reaches (`checkDelegatedAuthority`
 *   refuses it `DELEGATION_OUT_OF_PURPOSE`), so it has no `serve` either.
 */
export type TypedOperation<O extends object> =
  | (AgentOperationRow<O> & {
      readonly authority: 'beforePickup';
      readonly serve: (tx: TenantQuery, call: AgentCall, operands: O) => Promise<HandlerOutcome>;
    })
  | (AgentOperationRow<O> & {
      readonly authority: 'purpose';
      readonly serve: (
        tx: TenantQuery,
        call: AgentCall,
        operands: O,
        delegation: Delegation,
      ) => Promise<HandlerOutcome>;
    })
  | (AgentOperationRow<O> & {
      readonly authority: 'record';
      /** Where the check finds its task: the lease the body names, or the record. */
      readonly subjectTask: 'lease' | 'record';
      /**
       * Under the delegation, on the task the check was made on, or
       * `undefined` when the call named none and the check fell back to the
       * delegation's own scope. Never the body read again.
       */
      readonly serve: (
        tx: TenantQuery,
        call: AgentCall,
        operands: O,
        delegation: Delegation,
        taskId: string | undefined,
      ) => Promise<HandlerOutcome>;
    })
  | (AgentOperationRow<O> & { readonly authority: 'decision' })
  | (AgentOperationRow<O> & {
      readonly authority: 'helper';
      readonly serve: (
        tx: TenantQuery,
        call: AgentCall,
        operands: O,
        credential: string,
      ) => Promise<HandlerOutcome>;
    })
  | (AgentOperationRow<O> & { readonly authority: 'business' });

/**
 * A row, with its operands type closed over.
 *
 * The table holds rows of different operand types, so what it keeps is the
 * row behind `open`: a step that takes the row runs generic over its `O`,
 * and the operands a row's parser returned reach that row's `serve` and
 * `onRefused` typed, with nothing invented for a field the parser already
 * guaranteed. The same closure trick `authorise` uses for `run`.
 */
export interface AgentOperation {
  readonly authority: TypedOperation<object>['authority'];
  readonly replay: AgentOperationRow<object>['replay'];
  readonly identifiers?: readonly string[];
  open<R>(use: <O extends object>(row: TypedOperation<O>) => R): R;
}

function row<O extends object>(typed: TypedOperation<O>): AgentOperation {
  return {
    authority: typed.authority,
    replay: typed.replay,
    ...(typed.identifiers === undefined ? {} : { identifiers: typed.identifiers }),
    open: (use) => use(typed),
  };
}

/** Whether a row's parser refused: parsed operands never carry a `refusal`. */
export function isOperandRefusal<O extends object>(parsed: O | Refused): parsed is Refused {
  return 'refusal' in parsed;
}

/** The operands of a row that reads none beyond its identifiers. */
const NONE = (): NoOperands => ({});

/**
 * A `recordId` that is present and not a string, refused before any authority
 * in the words the person prefix answers the same body with (`refusal`).
 *
 * `String(["<sibling>"])` is the sibling's id: checking the agent's own task
 * for a non-string while `serve` acted on the id the value prints as would let
 * an agent comment on and read a sibling task. Absent stays absent: it is
 * checked on the
 * delegation's own task and names nothing to serve.
 */
function recordIdOperand(
  refusal: (request: AgentRequest) => CommandRefusal | undefined,
): (request: AgentRequest) => NoOperands | Refused {
  return (request) => {
    if (!('recordId' in request) || typeof request['recordId'] === 'string') return {};
    return refused(refusal(request) ?? refuseNotFound());
  };
}

/**
 * The request's system-owned fields refused, then its operands read.
 *
 * Neither tells the caller anything about the business, so both come before
 * any authority is read.
 */
export async function parseOperands<O extends object>(
  tx: TenantQuery,
  request: AgentRequest,
  operation: TypedOperation<O>,
): Promise<O | Refused> {
  // The envelope's own list and every installed `write_mode = 'system'` field
  // key, read from `field_defs`, the same classifier the person and read
  // routes use (root ruling 1).
  const claimed = await claimedSystemFields(tx, request);
  if (claimed !== undefined) {
    return refused(
      refuseCommand('FIELD_NOT_WRITABLE', claimed.keys, SYSTEM_OWNED_FIXES),
      claimed.values,
    );
  }
  // A target the read does not take, next and before any lookup, as the
  // person read path refuses it (`reads/dispatch.ts`): one answer for an own,
  // a foreign and a fabricated id.
  const irrelevant =
    operation.identifiers === undefined
      ? []
      : irrelevantIdentifiers(request, operation.identifiers);
  if (irrelevant.length > 0) {
    return refused(refuseCommand('COMMAND_BODY_INVALID', irrelevant, READ_BODY_FIXES));
  }
  return operation.operands(request);
}

/**
 * What an agent may do under the delegation its credential resolved to, right
 * now. `authorise` has resolved it and checked its purpose is still reached.
 *
 * The pairs are the intersection root ruling 5 names: each collection and
 * action the delegation's purpose carries, kept only while the delegating
 * person's effective grants still cover it on the purpose record
 * (`checkDelegatedAuthority`, the same check a call makes). So a person who
 * keeps `read` and loses `write` to expiry leaves an agent told `read` and
 * not `write`, with no lifecycle write needed to say so. The pre-pickup pair
 * (`BEFORE_PICKUP`) is not a grant and is not in this list: it is what an
 * agent login reaches holding nothing, and it is refused this read.
 */
export async function capabilitiesOf(
  tx: TenantQuery,
  session: AgentSession,
  held: Delegation,
): Promise<AgentCapabilities> {
  const grants: Capability[] = [];
  for (const collection of held.collections) {
    for (const action of held.actions) {
      // Sequential: one transaction, one connection.
      // oxlint-disable-next-line no-await-in-loop
      const reach = await checkDelegatedAuthority(tx, held, {
        collection,
        action,
        scope: held.purposeScope,
      });
      if (reach.ok) grants.push({ collection, action });
    }
  }
  return {
    agentActorId: session.actorId,
    businessKey: await businessKeyOf(tx),
    purposeScope: held.purposeScope,
    grants,
  };
}

/** The person entry's answer for a task that is not there (`refuseNotFound`), word for word. */
const NOT_FOUND = (): Refused => refused(refuseNotFound());

async function serveComment(
  tx: TenantQuery,
  { session, request, declaration }: AgentCall,
  _operands: NoOperands,
  delegation: Delegation,
  taskId: string | undefined,
) {
  // The agent's own picked-up task: `authorise` has already held the
  // delegation's purpose scope to this record and its `comment` action to
  // the delegating person's live grant. The task is locked by the person
  // path's own `lockTask`, the same statement and filter, and the
  // comment commits with its own identity. `internal` only: a note to the
  // team, never text a client reads without a person having written it.
  if (taskId === undefined) return NOT_FOUND();
  const spine = await readTaskSpine(tx);
  const task = await lockTask(tx, spine.taskTypeId, taskId);
  if (task === undefined) return NOT_FOUND();
  return await writeTaskComment(
    tx,
    {
      commentTypeId: spine.taskCommentTypeId,
      declaration,
      target: task,
      authorActorId: session.actorId,
      entryPoint: 'api',
      audiences: AGENT_AUDIENCES,
      operationId: String(request['operationId']),
      delegationId: delegation.id,
      onBehalfOfPersonId: delegation.delegatePersonId,
    },
    request['body'],
    request['audience'],
    request['commentType'],
    request['parentId'],
    request['mentions'],
  );
}

/**
 * A proposal on the agent's own task (T2b). `authorise` has held the purpose
 * scope to this record and `task:write` to the delegating person's live grant.
 * The proposal is the agent's, by its own actor; the runtime's check under its
 * locks asks the delegating person's grants, the ceiling the delegation
 * narrows, never a grant of the agent's, which holds none. The task is only
 * read here: the runtime locks it in its own order, after cap and envelope.
 */
async function servePropose(
  tx: TenantQuery,
  { session, request, declaration }: AgentCall,
  _operands: NoOperands,
  delegation: Delegation,
  taskId: string | undefined,
) {
  if (taskId === undefined) return NOT_FOUND();
  const spine = await readTaskSpine(tx);
  const target = await lockTask(tx, spine.taskTypeId, taskId, { forUpdate: false });
  if (target === undefined) return NOT_FOUND();
  const fields = { ...request, expectedRevision: expectedRevisionOf(request) };
  return await proposeFor(
    tx,
    {
      target,
      collection: declaration.collection,
      taskTypeId: spine.taskTypeId,
      actorId: session.actorId,
      subjects: [{ kind: 'person', id: delegation.delegatePersonId }],
    },
    fields as unknown as ProposeFields,
  );
}

/**
 * An agent's edit or delete of its own comment on its own task (MP-4-5,
 * CS-4.34). The task is locked as `serveComment` locks it; the comment is
 * read through it and must be the agent's own actor's, written for the person
 * this delegation acts for (`tasks-comment-edit.ts`, OW-036.1). Once the
 * comment is locked, the delegation and the delegating person's covering
 * grant are asked again (`askedAgain`): a revocation that committed while the
 * change waited on a lock refuses it, and one that has not waits for it.
 */
const serveCommentChange =
  (
    change: (
      tx: TenantQuery,
      on: CommentChange,
      request: AgentCall['request'],
    ) => ReturnType<typeof editTaskComment>,
  ): ((
    tx: TenantQuery,
    call: AgentCall,
    operands: NoOperands,
    delegation: Delegation,
    taskId: string | undefined,
  ) => ReturnType<typeof editTaskComment>) =>
  async (tx, call, _operands, delegation, taskId) => {
    if (taskId === undefined) return NOT_FOUND();
    // The delegating person's grants, and the chain each was delegated under,
    // held `for share` before the task, as pickup holds them: a `grant.revoke`
    // takes its row `for update` first, so it either commits before this
    // change and the check refuses, or waits for it. A helper stands on its
    // parent's person, the same person.
    const person = { kind: 'person', id: delegation.delegatePersonId } as const;
    await holdCoveringGrants(tx, [person], call.declaration.collection);
    const spine = await readTaskSpine(tx);
    const task = await lockTask(tx, spine.taskTypeId, taskId);
    if (task === undefined) return NOT_FOUND();
    return await change(
      tx,
      {
        commentTypeId: spine.taskCommentTypeId,
        declaration: call.declaration,
        target: task,
        actorId: call.session.actorId,
        onBehalfOfPersonId: delegation.delegatePersonId,
        stillAuthorised: async () => await askedAgain(tx, call, delegation, task),
      },
      call.request,
    );
  };

/**
 * The agent entry's authority asked again once the comment is locked, as
 * `authorise` asked it. The delegation and, for a helper, its parent are held
 * `for share` first, after the task (the global order's delegation class): a
 * `delegation.revoke` writes the row, so one that has not committed waits for
 * the change. A helper has no lease of its own and revoking it takes no task
 * lock, so nothing else orders that revocation with this change. A delegation
 * the locked task names as its agent is left to the task lock: revoking it
 * clears that agent (`revokeDelegation`), so it waits on the task anyway, and
 * having written its own row first it would deadlock against a hold here.
 */
async function askedAgain(
  tx: TenantQuery,
  { session, declaration, credential }: AgentCall,
  delegation: Delegation,
  task: { readonly id: string; readonly data: Readonly<Record<string, unknown>> },
): Promise<CommandRefusal | undefined> {
  const agent = typeof task.data['agent'] === 'string' ? task.data['agent'].toLowerCase() : null;
  const chain = [delegation.id, delegation.parentDelegationId].filter(
    (id): id is string => id !== null && id.toLowerCase() !== agent,
  );
  await tx.query(
    `select id from public.delegations
      where business_id = $1 and id = any($2::uuid[])
      order by id
      for share`,
    [tx.businessId, chain],
  );
  const again = await resolveDelegation(tx, session.actorId, credential ?? '');
  if (!again.ok) return again.refusal;
  const decision = await checkDelegatedAuthority(tx, again.value, {
    collection: declaration.collection,
    action: declaration.action,
    scope: { kind: 'record', id: task.id },
  });
  return decision.ok ? undefined : decision.refusal;
}

/**
 * A field write an agent makes on its own task: the three marks
 * (`task.set_scores`), the Ad hoc mark (`task.set_adhoc`), the category
 * (`task.set_category`), its fields of `task.update` (MP-4-7, MP-4-8,
 * MP-4-12) and the assignee (`task.assign`, MP-4-8). One entry, so the five
 * refuse a stale write, a missing task and a malformed body alike.
 */
const serveOwnedWrite =
  (
    write: typeof setScores,
    example: string,
  ): ((
    tx: TenantQuery,
    call: AgentCall,
    operands: NoOperands,
    delegation: Delegation,
    taskId: string | undefined,
  ) => ReturnType<typeof setScores>) =>
  async (tx, { request }, _operands, delegation, taskId) => {
    // `authorise` has held the delegation to this task and its `write` action
    // to the delegating person's live grant. The lock and the revision are the
    // person envelope's (`prepareCommand`), so the two entries refuse a stale
    // write in the same words. `fields` is read here, after authority, so an
    // agent holding nothing is told that before it is told about its body.
    if (taskId === undefined) return NOT_FOUND();
    const spine = await readTaskSpine(tx);
    const target = await lockTask(tx, spine.taskTypeId, taskId);
    if (target === undefined) return NOT_FOUND();
    if (expectedRevisionOf(request) !== target.revision) {
      return refused(
        refuseCommand('VERSION_STALE', [`revision=${target.revision}`], REVISION_FIXES),
      );
    }
    const fields = request['fields'];
    if (!isFieldMap(fields)) {
      return refused(
        invalid('fields', `Send fields as an object of fields to values, such as ${example}.`),
      );
    }
    // The agent writes for its delegating person, so an assignment raises no
    // item to them (INB-1), as their own write would not.
    const session = { personId: delegation.delegatePersonId };
    return await write(tx, { spine, target, session }, fields);
  };

async function serveHeartbeat(
  tx: TenantQuery,
  { session, request }: AgentCall,
  operands: LeaseOperands,
  delegation: Delegation,
) {
  // The delegation `authorise` resolved for this call. The runtime locks it
  // and asks again whether it is live before renewing (`heartbeat`).
  return await heartbeatLease(
    tx,
    {
      leaseId: request['leaseId'],
      fence: request['fence'],
      ...(operands.leaseSeconds === undefined ? {} : { leaseSeconds: operands.leaseSeconds }),
      ...('providerStarting' in request ? { providerStarting: request['providerStarting'] } : {}),
    },
    agentClaimant(session.actorId),
    delegation.id,
  );
}

/**
 * Every operation an agent may reach, in the order `AGENT_SURFACE` lists them.
 * `task.decide` is here to be refused by name (`decideAsAgent`), never served.
 */
/**
 * `model.call`, over the serve its entry supplies. The broker's executor
 * (`model-call.ts`) serves it with the reservation; this table serves it
 * where the deployment configured no broker, and says so.
 */
export function modelCallRow(
  serve: (
    tx: TenantQuery,
    call: AgentCall,
    operands: ModelCallOperands,
    delegation: Delegation,
  ) => Promise<HandlerOutcome>,
): AgentOperation {
  return row({
    authority: 'record',
    subjectTask: 'lease',
    replay: 'reauthorise',
    operands: modelCallOperands,
    // The lease's task was checked under the delegation; the broker checks
    // the lease, the delegation and the reservation again under their locks.
    serve: async (tx, call, operands, delegation) => await serve(tx, call, operands, delegation),
  });
}

const NO_BROKER_FIXES: readonly string[] = [
  'This deployment has no credential broker configured, so it makes no model call.',
];

export const AGENT_OPERATIONS: ReadonlyMap<CommandName, AgentOperation> = new Map<
  CommandName,
  AgentOperation
>([
  [
    'task.queue',
    row({
      authority: 'beforePickup',
      // Served again on replay: the stored queue may predate a delegation that
      // now narrows it (#169).
      replay: 'serveAgain',
      identifiers: READ_CATALOGUE['task.queue'].identifiers,
      operands: NONE,
      serve: async (tx, { session }) => ({
        recordId: null,
        revision: null,
        detail: { queue: await readQueue(tx, session.actorId) },
      }),
    }),
  ],
  [
    'task.pickup',
    row({
      authority: 'beforePickup',
      replay: 'pickup',
      operands: pickupOperands,
      serve: async (tx, { session, declaration }, operands) =>
        await pickupReservation(tx, declaration.collection, session.actorId, operands),
    }),
  ],
  [
    'task.handback',
    row({
      authority: 'record',
      subjectTask: 'lease',
      replay: 'settledHandback',
      operands: handbackOperands,
      onRefused: retainLateHandback,
      serve: async (tx, { session, request }, operands) =>
        await handbackLease(
          tx,
          {
            leaseId: operands.leaseId,
            fence: operands.fence,
            outcome: operands.outcome,
            ...(operands.actualMinor === undefined ? {} : { actualMinor: operands.actualMinor }),
            ...(operands.report === undefined ? {} : { report: operands.report }),
            // The successor, untouched and unread. Whether the body is a shape
            // at all is `handbackLease`'s question, and a key checked here would
            // be a key checked twice; a key dropped here would be the silence
            // D06 refuses. What this entry point contributes is the half the
            // body may not carry: the agent actor below, never `proposedByActorId`.
            ...('successor' in request ? { successor: request['successor'] } : {}),
          },
          session.actorId,
        ),
    }),
  ],
  [
    'task.heartbeat',
    row({
      authority: 'record',
      subjectTask: 'lease',
      replay: 'reauthorise',
      operands: leaseSecondsOperand(MAXIMUM_RENEWAL_SECONDS),
      serve: serveHeartbeat,
    }),
  ],
  [
    'task.dispatch',
    row({
      authority: 'record',
      subjectTask: 'lease',
      replay: 'reauthorise',
      operands: NONE,
      // The delegation `authorise` resolved; the runtime locks it and rechecks it.
      serve: async (tx, { session, request, declaration }, _operands, delegation) =>
        await dispatchLease(
          tx,
          { leaseId: request['leaseId'], fence: request['fence'] },
          {
            actorId: session.actorId,
            delegationId: delegation.id,
            collection: declaration.collection,
          },
        ),
    }),
  ],
  [
    'task.observe',
    row({
      authority: 'record',
      subjectTask: 'lease',
      replay: 'reauthorise',
      operands: NONE,
      serve: async (tx, { session, request, declaration }, _operands, delegation) =>
        await observeLease(
          tx,
          {
            leaseId: request['leaseId'],
            fence: request['fence'],
            attemptId: request['attemptId'],
            usage: request['usage'],
            outcome: request['outcome'],
            receiptLink: request['receiptLink'],
          },
          {
            actorId: session.actorId,
            delegationId: delegation.id,
            collection: declaration.collection,
          },
        ),
    }),
  ],
  [
    'task.check',
    row({
      authority: 'record',
      subjectTask: 'lease',
      replay: 'reauthorise',
      operands: NONE,
      serve: async (tx, { session, request }, _operands, delegation) =>
        await checkLease(
          tx,
          {
            leaseId: request['leaseId'],
            fence: request['fence'],
            name: request['name'],
            outcome: request['outcome'],
            note: request['note'],
          },
          agentClaimant(session.actorId),
          delegation.id,
        ),
    }),
  ],
  [
    'task.read',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      identifiers: READ_CATALOGUE['task.read'].identifiers,
      // The person read's rules: both prefixes refuse a non-string id, then a level, size or page.
      operands: (request) => {
        const id = recordIdOperand(() => {
          const read = READ_CATALOGUE['task.read'].parse(request);
          return read.ok ? undefined : read.refusal;
        })(request);
        const paging = parsePaging(request as unknown as Readonly<Record<string, unknown>>);
        return isOperandRefusal(id) || !isRefusal(paging) ? id : refused(paging);
      },
      serve: async (tx, call, _operands, _delegation, taskId) => {
        if (taskId === undefined) return NOT_FOUND();
        const spine = await readTaskSpine(tx);
        const paging = parsePaging(call.request as unknown as Readonly<Record<string, unknown>>);
        const level = isRefusal(paging) ? undefined : paging.detail;
        let task: Awaited<ReturnType<typeof readTaskDetail>>;
        try {
          task = await readTaskDetail(
            tx,
            spine.taskTypeId,
            taskId,
            {
              commentTypeId: spine.taskCommentTypeId,
              // An agent is never an internal reader. It is a delegate working one
              // task, not a member of the business, so it is shown what an external
              // reader is shown — the client comments in the fields the catalogue
              // marks `shared` — and internal notes are absent from its answer
              // rather than hidden in it (I09).
              internal: false,
            },
            // An agent works one task under its delegation, so the pool its
            // rank is worked out in is that task and no other.
            { kind: 'task' },
            // An agent is sent no one's time: the time on a task is its people's.
            null,
          );
        } catch (cause) {
          // Decisions that do not verify are the fault the person read answers
          // (`runRead`), not a retryable one: the same body on both prefixes.
          if (cause instanceof DecisionIntegrityError) throw new ReadIntegrityFault(cause);
          throw cause;
        }
        if (task === undefined) return NOT_FOUND();
        if (level === undefined)
          return { recordId: task.id, revision: task.revision, detail: { task } };
        // Its delegation reaches this task alone, so every blocker is withheld by count.
        const view = taskAt(level, task, await blockersFor(tx, [], task.id));
        return { recordId: task.id, revision: task.revision, detail: { detail: level, view } };
      },
    }),
  ],
  [
    'task.comment',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      // The person command path answers a non-string record id as a missing
      // record (`prepare.ts`, `lockTask`), so this one does too.
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveComment,
    }),
  ],
  [
    'task.propose',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: servePropose,
    }),
  ],
  [
    // C41-A: an agent step's result goes on its delegated task only (purpose scope and the person's `task:write`).
    'onboarding.step_result',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: async (tx, { session, request }, _operands, delegation, taskId) => {
        if (taskId === undefined) return NOT_FOUND();
        const spine = await readTaskSpine(tx);
        return await writeStepResult(
          tx,
          {
            actorId: session.actorId,
            actorKind: 'agent',
            entryPoint: 'api',
            commentTypeId: spine.taskCommentTypeId,
            stillHolds: await delegationStillHolds(tx, delegation),
            onBehalfOfPersonId: delegation.delegatePersonId,
          },
          { recordId: taskId, outcome: request['outcome'], result: request['result'] },
        );
      },
    }),
  ],
  [
    'task.edit_comment',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveCommentChange(
        async (tx, on, request) =>
          await editTaskComment(
            tx,
            on,
            request['commentId'],
            request['body'],
            request['expectedEditedAt'],
          ),
      ),
    }),
  ],
  [
    'task.delete_comment',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveCommentChange(
        async (tx, on, request) => await deleteTaskComment(tx, on, request['commentId']),
      ),
    }),
  ],
  [
    'task.update',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveOwnedWrite(updateTaskAsAgent, '{ agent_brief }'),
    }),
  ],
  [
    'task.assign',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveOwnedWrite(assignTaskAsAgent, '{ assignee }'),
    }),
  ],
  [
    'task.set_scores',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveOwnedWrite(setScores, '{ impact }'),
    }),
  ],
  [
    'task.set_adhoc',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveOwnedWrite(setAdHoc, '{ ad_hoc }'),
    }),
  ],
  [
    'task.set_category',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveOwnedWrite(setCategory, '{ category }'),
    }),
  ],
  [
    'task.decide',
    row({
      authority: 'decision',
      replay: 'reauthorise',
      operands: NONE,
    }),
  ],
  // An agent credential adds a task (API-2, `credential-envelope.ts`); a
  // pickup's delegation is one task, and a new one is outside it.
  [
    'task.create',
    row({
      authority: 'business',
      replay: 'reauthorise',
      operands: NONE,
    }),
  ],
  ['live_correction.request', row(CORRECTION_REQUEST)],
  [
    'model.call',
    modelCallRow(() =>
      Promise.resolve(
        refused(refuseCommand('DEPENDENCY_NOT_LANDED', ['model.call'], NO_BROKER_FIXES)),
      ),
    ),
  ],
  [
    'run.revise_state',
    row({
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      operands: recordIdOperand(() => refuseNotFound()),
      // The task checked under the delegation (`run:write`, which the mint
      // grants only where the person holds it); the agent is the recorded actor.
      serve: async (
        tx,
        { session, request, declaration, credential },
        _operands,
        _delegation,
        taskId,
      ) => {
        if (credential === undefined)
          throw new Error('agent run state: served without a credential');
        const spine = await readTaskSpine(tx);
        return await reviseRunState(
          tx,
          spine.taskTypeId,
          { taskId: taskId ?? request['recordId'], runId: request['runId'] },
          {
            expectedVersion: request['expectedVersion'],
            knowledge: request['knowledge'],
            unknowns: request['unknowns'],
          },
          {
            id: session.actorId,
            // The delegation resolved again, not the one read before the wait:
            // one revoked or expired while this waited for the run refuses the
            // write (#443).
            askAgain: async (task) => {
              const again = await resolveDelegation(tx, session.actorId, credential);
              if (!again.ok) return refused(again.refusal);
              const still = await checkDelegatedAuthority(tx, again.value, {
                collection: declaration.collection,
                action: declaration.action,
                scope: { kind: 'record', id: task },
              });
              return still.ok ? undefined : refused(still.refusal);
            },
          },
        );
      },
    }),
  ],
  [
    'run.delegate_child',
    row({
      authority: 'record',
      subjectTask: 'lease',
      replay: 'childPickup',
      operands: delegateChildOperands,
      // The parent is the delegation `authorise` resolved for this call.
      serve: async (tx, call, operands, delegation) =>
        await serveDelegateChild(tx, call, operands, delegation),
    }),
  ],
  [
    'run.child_handback',
    row({
      authority: 'helper',
      replay: 'childHandback',
      operands: childHandbackOperands,
      serve: serveChildHandback,
    }),
  ],
  [
    'session.capabilities',
    row({
      authority: 'purpose',
      replay: 'serveAgain',
      identifiers: READ_CATALOGUE['session.capabilities'].identifiers,
      operands: NONE,
      // An agent holds no grants of its own -- `identity/agent-login.ts`
      // confers nothing at all -- so this is not the person answer with a
      // different subject in it. What the agent has is a purpose, and the
      // pairs reported are that purpose as the delegating person's grants
      // still cover it on the picked-up task, read now (`capabilitiesOf`).
      serve: async (tx, { session }, _operands, delegation) => ({
        recordId: null,
        revision: null,
        detail: { ...(await capabilitiesOf(tx, session, delegation)) },
      }),
    }),
  ],
]);
