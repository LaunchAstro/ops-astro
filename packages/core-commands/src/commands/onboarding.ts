// SPDX-License-Identifier: AGPL-3.0-only
//
// New client onboarding (C41-A, CS-15.2 and CS-15.4). `onboarding.start` lays
// a template version out as tasks on a client (`record-create.ts` makes one),
// each in its phase and marked agent-run, needs a person, or waits on the
// client, and records the onboarding and its steps in one transaction.
// `onboarding.step_result` writes a step's result onto its own task as a
// system comment and moves the onboarding on: a done step opens the steps
// waiting on it, and a second failure stops the onboarding, says so and
// withdraws its steps' open moves. A person or client-wait step that opens
// raises an inbox item to whoever owns its move, closed with the step. The
// result waits on its onboarding's lock after the envelope asked its
// authority, so that authority is asked again once the lock is held.
//
// Nothing here runs, sends or spends: the agent step's run and gate, and the
// client email's draft and send, are held by name in
// `tests/onboarding/c41-a-held.test.ts`. Every refusal comes before the first
// write, or is the claim that writes nothing (a second start), and none echoes
// a value the caller sent.

import {
  checkAuthority,
  claimOnboarding,
  closeStep,
  closeStepMove,
  deriveSource,
  failStep,
  insertStepTask,
  insertSteps,
  isClientHere,
  isUuid,
  lockStepOfTask,
  ONBOARDING_TEMPLATES,
  raiseStepMoves,
  stepTaskTitle,
  subjectsOf,
  writeComment,
  type EntryPoint,
  type OnboardingTemplate,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { grantsStillHold, type StillHolds } from './onboarding-authority.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { textOf } from './record-create.ts';
import { applied, refused, type HandlerOutcome, type Refused } from './outcome.ts';

const FIXES: Readonly<Record<string, string>> = {
  templateKey: `Send templateKey as one of: ${Object.keys(ONBOARDING_TEMPLATES).join(', ')}.`,
  recordId: 'Send recordId as the id of the step’s task.',
  outcome: 'Send outcome as done or failed.',
  result: 'Send result as what the step found or did, 1 to 2000 characters.',
};

const invalidRefusal = (field: string): CommandRefusal =>
  refuseCommand('FIELD_VALUE_INVALID', [field], [FIXES[field] ?? '']);

const invalid = (field: string): HandlerOutcome => refused(invalidRefusal(field));

const notPermitted = (state: string, fix: string): HandlerOutcome =>
  refused(refuseCommand('TRANSITION_NOT_PERMITTED', [`state=${state}`], [fix]));

async function holdsTaskWrite(tx: TenantQuery, session: Session): Promise<boolean> {
  const held = await checkAuthority(tx, subjectsOf(session), {
    collection: 'task',
    action: 'write',
    scope: { kind: 'business', id: null },
  });
  return held.ok;
}

/**
 * The template the start names, or the refusal that stops it, each before
 * anything is written.
 */
async function checkStart(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly clientId: string; readonly templateKey?: unknown },
): Promise<OnboardingTemplate | HandlerOutcome> {
  const template =
    typeof request.templateKey === 'string' &&
    Object.hasOwn(ONBOARDING_TEMPLATES, request.templateKey)
      ? ONBOARDING_TEMPLATES[request.templateKey]
      : undefined;
  if (template === undefined) return invalid('templateKey');
  // Another business's client is not in this transaction's rows (RLS), so it
  // answers exactly as a fabricated or malformed identifier does.
  if (!isUuid(request.clientId) || !(await isClientHere(tx, request.clientId))) {
    return refused(refuseNotFound());
  }
  if (!(await holdsTaskWrite(tx, context.session))) {
    return refused(
      refuseCommand(
        'SCOPE_NOT_GRANTED',
        ['task:write'],
        ['Starting an onboarding lays out tasks: ask for task:write across the business.'],
      ),
    );
  }
  return template;
}

export async function startOnboarding(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly clientId: string; readonly templateKey?: unknown },
): Promise<HandlerOutcome> {
  const template = await checkStart(tx, context, request);
  if (!('steps' in template)) return template;
  const clientId = request.clientId.toLowerCase();
  const onboardingId = await claimOnboarding(tx, {
    clientId,
    templateKey: template.key,
    templateVersion: template.version,
    startedBy: context.session.actorId,
  });
  if (onboardingId === undefined) {
    return notPermitted('started', 'This client is already onboarding; open its tasks instead.');
  }
  const laid = [];
  for (const step of template.steps) {
    // One at a time: each task ranks after the one laid out before it.
    // oxlint-disable-next-line no-await-in-loop
    const taskId = await insertStepTask(tx, {
      taskTypeId: context.spine.taskTypeId,
      stateId: context.spine.states.find((one) => one.machineCategory === 'unstarted')?.id,
      source: deriveSource('person', context.entryPoint),
      clientId,
      title: stepTaskTitle(step),
    });
    laid.push({ ...step, taskId });
  }
  const steps = await insertSteps(tx, onboardingId, laid);
  const ready = steps.filter((one) => one.state === 'ready').map((one) => one.key);
  await raiseStepMoves(tx, onboardingId, ready);
  return applied(clientId, null, {
    onboardingId,
    templateKey: template.key,
    templateVersion: template.version,
    steps: steps.map((one) => ({
      key: one.key,
      phase: one.phase,
      kind: one.kind,
      taskId: one.taskId,
      dependsOn: one.dependsOn,
      state: one.state,
    })),
  });
}

const STEP_FIXES: Readonly<Record<string, string>> = {
  blocked: 'Close the steps this one waits on first.',
  done: 'This step is already closed; its result is on its task.',
  stopped: 'This step stopped the onboarding; a person restarts it.',
};

const NOT_RUNNING = 'This onboarding is not running; a person restarts it.';
const AGENT_FIX = 'An agent records agent steps; a person records this step’s result.';
const AGENT_ONLY = refuseCommand('DELEGATION_EXCLUDES_OPERATION', ['kind'], [AGENT_FIX]);

const STOPPED_REPORT =
  'Onboarding stopped after two failed attempts at this step. Nothing further runs until a person restarts it.';

/** The outcome and the text, or the refusal, before any lock is taken. */
function parseResult(
  request: { readonly recordId: string; readonly outcome?: unknown; readonly result?: unknown },
  commentTypeId: string | undefined,
):
  | { readonly outcome: 'done' | 'failed'; readonly text: string; readonly commentTypeId: string }
  | Refused {
  // Absent is a body missing its field; present and not ours is a record
  // that is not there, answered as a fabricated one is.
  if (typeof request.recordId !== 'string') return refused(invalidRefusal('recordId'));
  if (!isUuid(request.recordId)) return refused(refuseNotFound());
  const outcome = request.outcome;
  if (outcome !== 'done' && outcome !== 'failed') return refused(invalidRefusal('outcome'));
  const text = textOf(request.result, 2000);
  if (text === null) return refused(invalidRefusal('result'));
  if (commentTypeId === undefined) {
    return refused(
      refuseCommand(
        'DEPENDENCY_NOT_LANDED',
        ['task_comment'],
        ['This business has no comment record type installed, so a task cannot hold a result.'],
      ),
    );
  }
  return { outcome, text, commentTypeId };
}

/**
 * A step's result, onto its own task, after the caller's `task:write` on it
 * (the envelope's, the delegation's), asked again under the onboarding's lock
 * (`stillHolds`). An agent, delegated or by its API-2 credential, records
 * agent steps only; the rest are a person's (ORCH79).
 */
export async function writeStepResult(
  tx: TenantQuery,
  author: {
    readonly actorId: string;
    readonly actorKind: 'person' | 'agent';
    readonly entryPoint: EntryPoint;
    readonly commentTypeId: string | undefined;
    readonly stillHolds: StillHolds;
  },
  request: { readonly recordId: string; readonly outcome?: unknown; readonly result?: unknown },
): Promise<HandlerOutcome> {
  const parsed = parseResult(request, author.commentTypeId);
  if ('refusal' in parsed) return parsed;
  const { outcome, text, commentTypeId } = parsed;
  const found = await lockStepOfTask(tx, request.recordId.toLowerCase());
  if (found === undefined) return refused(refuseNotFound());
  const lost = await author.stillHolds({ clientId: found.clientId, taskId: found.step.taskId });
  if (lost !== undefined) return refused(lost);
  if (author.actorKind === 'agent' && found.step.kind !== 'agent') return refused(AGENT_ONLY);
  if (found.onboardingState !== 'running') return notPermitted(found.onboardingState, NOT_RUNNING);
  if (found.step.state !== 'ready') {
    return notPermitted(found.step.state, STEP_FIXES[found.step.state] ?? '');
  }
  const comment = {
    taskId: found.step.taskId,
    authorActorId: author.actorId,
    commentType: 'system' as const,
    audience: 'internal' as const,
    source: deriveSource(author.actorKind, author.entryPoint),
  };
  await writeComment(tx, commentTypeId, { ...comment, body: text });
  let stopped = false;
  let opened: readonly string[] = [];
  if (outcome === 'done') {
    opened = await closeStep(tx, found.step, found.siblings);
    await closeStepMove(tx, found.step, author.actorId);
    await raiseStepMoves(tx, found.step.onboardingId, opened);
  } else {
    stopped = await failStep(tx, found.step);
    if (stopped) await writeComment(tx, commentTypeId, { ...comment, body: STOPPED_REPORT });
  }
  return applied(found.step.taskId, null, {
    step: found.step.key,
    outcome,
    opened,
    stopped,
  });
}

export async function recordStepResult(
  tx: TenantQuery,
  context: CommandContext,
  request: { readonly recordId: string; readonly outcome?: unknown; readonly result?: unknown },
): Promise<HandlerOutcome> {
  return await writeStepResult(
    tx,
    {
      actorId: context.session.actorId,
      actorKind: context.session.credentialScope === undefined ? 'person' : 'agent',
      entryPoint: context.entryPoint,
      commentTypeId: context.spine.taskCommentTypeId,
      stillHolds: await grantsStillHold(tx, context.session),
    },
    request,
  );
}
