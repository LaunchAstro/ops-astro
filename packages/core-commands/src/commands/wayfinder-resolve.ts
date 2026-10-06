// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder's closing commands (WF-2): a ticket resolved with its answer and
// gist, or closed as out of scope onto its map. Each runs inside the envelope
// (see `wayfinder-chart.ts`).

import { OWNER_TYPES, wayfinderFacts, writeComment } from '../../../core-records/src/index.ts';
import type { TenantQuery, WayfinderFacts } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { raiseFrontierDecisions } from './wayfinder-frontier-raise.ts';
import { invalid, notPermitted, textOk, type RequestOf } from './wayfinder.ts';
import { refuseUnlessOwner } from './wayfinder-owner.ts';
import { applyRevision } from './wayfinder-revision.ts';
import { holdSteps, refuseCompletion } from './tasks-state.ts';
import { moveSteps } from './tasks-steps.ts';

const GIST_LIMIT = 200;
const ANSWER_LIMIT = 20_000;

export function completed(context: Pick<CommandContext, 'spine'>, stateId: unknown): boolean {
  return (
    context.spine.states.find((state) => state.id === stateId)?.machineCategory === 'completed'
  );
}

/**
 * Complete a ticket and write what its closing records, in one update, so the
 * revision moves by exactly one as for every other command. A reopened
 * ticket's old `closed_as` goes, and the stamp is the write's own, taken after
 * any wait, so Decisions so far keeps closing order. The state is the
 * installation's first `completed` one, as `task.complete` chooses it, and
 * `task.complete`'s guards and step archive run around it; a ticket an agent
 * holds goes to review through `task.complete` first. `before` runs once the
 * guards have passed, ahead of the ticket's write.
 */
async function completeWith(
  tx: TenantQuery,
  context: CommandContext,
  extra: Readonly<Record<string, string>>,
  before?: () => Promise<void>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('completeWith: the envelope read no target');
  const current = context.spine.states.find((candidate) => candidate.id === target.data['state']);
  if (typeof target.data['agent'] === 'string' && current?.machineCategory !== 'unstarted') {
    return notPermitted(['agent'], ['An agent holds this ticket: complete it for review first.']);
  }
  const state = context.spine.states.find((candidate) => candidate.machineCategory === 'completed');
  if (state === undefined) {
    return refused(
      refuseCommand('NOT_FOUND', ['completed'], ['This installation seeds no completed state.']),
    );
  }
  const guarded = await refuseCompletion(tx, context, target.id);
  if (guarded !== undefined) return guarded;
  const steps = await holdSteps(tx, context, target.id, 'archive');
  if ('refusal' in steps) return steps;
  await before?.();
  const rows = await tx.query<{ readonly revision: string }>(
    `update records
        set data = (data - 'closed_as')
                   || jsonb_build_object('state', $3::text, 'completed_at', clock_timestamp()::text)
                   || $4::jsonb,
            updated_at = now()
      where business_id = $1 and id = $2 and deleted_at is null
      returning revision::text as revision`,
    [tx.businessId, target.id, state.id, extra],
  );
  const written = rows[0];
  if (written === undefined) {
    return refused(refuseCommand('NOT_FOUND', [], ['No live task carries that identifier here.']));
  }
  await moveSteps(tx, steps, 'archive');
  // Completing a ticket can unblock its map's grilling and prototype tickets (WF-2).
  await raiseFrontierDecisions(tx, target.id);
  return applied(target.id, Number(written.revision), { state: state.key, ...extra });
}

/**
 * `ticket resolved (answer, gist)`: the ticket completes and carries its
 * answer and one-line gist, which Decisions so far renders. Research, task and
 * build are the row's `task:write`; grilling and prototype are the map
 * owner's, under `task:decide`.
 */
export async function resolveTicket(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.resolve'>,
): Promise<HandlerOutcome> {
  return await resolveWith(tx, context, request, async (facts) =>
    OWNER_TYPES.has(facts.type)
      ? await refuseUnlessOwner(tx, context, facts, {
          decide: 'Resolving a grilling or prototype ticket needs task:decide.',
          owner: "Only the map's owner resolves a grilling or prototype ticket.",
        })
      : undefined,
  );
}

async function resolveWith(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.resolve'>,
  typeRule: (facts: WayfinderFacts) => Promise<CommandRefusal | undefined>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('resolveTicket: the envelope read no target');
  const facts = await wayfinderFacts(tx, target.id);
  if (facts === undefined) throw new Error('resolveTicket: the locked target is not a task');
  if (facts.type === 'map')
    return notPermitted(['type'], ['A map is not resolved; its tickets are.']);
  if (completed(context, target.data['state'])) {
    return notPermitted(['state'], ['This ticket is resolved already.']);
  }
  const answer = request.answer;
  const gist = request.gist;
  const wrong = [
    ...(typeof answer === 'string' && answer.trim() !== '' && answer.length <= ANSWER_LIMIT
      ? []
      : ['answer']),
    ...(typeof gist === 'string' &&
    gist.trim() !== '' &&
    gist.length <= GIST_LIMIT &&
    !/[\r\n]/u.test(gist)
      ? []
      : ['gist']),
  ];
  if (wrong.length > 0) {
    return invalid(wrong, [
      `The answer, and a one-line gist of up to ${String(GIST_LIMIT)} characters.`,
    ]);
  }
  const refusal = await typeRule(facts);
  if (refusal !== undefined) return refused(refusal);
  const said = (answer as string).trim();
  const outcome = await completeWith(tx, context, { answer: said, gist: (gist as string).trim() });
  if (!('refusal' in outcome)) await postAnswer(tx, context, target.id, said);
  return outcome;
}

/** The answer is also the ticket's resolution comment, on its thread. */
async function postAnswer(
  tx: TenantQuery,
  context: CommandContext,
  taskId: string,
  body: string,
): Promise<void> {
  const commentTypeId = context.spine.taskCommentTypeId;
  if (commentTypeId === undefined) return;
  await writeComment(tx, commentTypeId, {
    taskId,
    authorActorId: context.session.actorId,
    commentType: 'note',
    audience: 'internal',
    body,
    source: context.entryPoint,
  });
}

/**
 * `ticket closed (out of scope)`: the ticket completes as out of scope, and
 * its map gains one Out of scope item linking it, in a new version.
 */
export async function closeOutOfScope(
  tx: TenantQuery,
  context: CommandContext,
  request: RequestOf<'task.close_out_of_scope'>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('closeOutOfScope: the envelope read no target');
  const facts = await wayfinderFacts(tx, target.id);
  if (facts?.mapId === null || facts?.mapId === undefined || facts.mapId === target.id) {
    return notPermitted(['parent'], ['Only a ticket of a map is closed as out of scope.']);
  }
  if (completed(context, target.data['state'])) {
    return notPermitted(['state'], ['This ticket is closed already.']);
  }
  const reason = request.reason;
  if (reason !== undefined && !textOk(reason)) {
    return invalid(['reason'], ['The reason is 1 to 4000 characters, or leave it out.']);
  }
  const title = typeof target.data['title'] === 'string' ? target.data['title'] : 'a ticket';
  const line = typeof reason === 'string' ? `${title}: ${reason.trim()}` : title;
  const mapId = facts.mapId;
  return await completeWith(tx, context, { closed_as: 'out_of_scope' }, async () => {
    await applyRevision(tx, context, mapId, {
      addFog: [],
      addOutOfScope: [{ text: line.slice(0, 4000), ticketId: target.id }],
      retire: [],
    });
  });
}
