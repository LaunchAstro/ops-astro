// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder's closing commands (WF-2): a ticket resolved with its answer and
// gist, or closed as out of scope onto its map. Each runs inside the envelope
// (see `wayfinder-chart.ts`).

import { OWNER_TYPES, wayfinderFacts } from '../../../core-records/src/index.ts';
import type { TenantQuery, WayfinderFacts } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { invalid, notPermitted, refuseUnlessOwner, textOk, type RequestOf } from './wayfinder.ts';
import { applyRevision } from './wayfinder-revision.ts';

const GIST_LIMIT = 200;
const ANSWER_LIMIT = 20_000;
const AGENT_RESEARCH_ONLY =
  'A run resolves a research ticket; a task or build ticket closes by its run.';

/** What a closing command reads from its context: the spine and the locked ticket. */
type Closing = Pick<CommandContext, 'spine' | 'target'>;

export function completed(context: Closing, stateId: unknown): boolean {
  return (
    context.spine.states.find((state) => state.id === stateId)?.machineCategory === 'completed'
  );
}

/**
 * Complete a ticket and write what its closing records, in one update, so the
 * revision moves by exactly one as for every other command. The state is the
 * installation's first `completed` one, as `task.complete` chooses it.
 */
async function completeWith(
  tx: TenantQuery,
  context: Closing,
  extra: Readonly<Record<string, string>>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('completeWith: the envelope read no target');
  const state = context.spine.states.find((candidate) => candidate.machineCategory === 'completed');
  if (state === undefined) {
    return refused(
      refuseCommand('NOT_FOUND', ['completed'], ['This installation seeds no completed state.']),
    );
  }
  const rows = await tx.query<{ readonly revision: string }>(
    `update records
        set data = data || jsonb_build_object('state', $3::text, 'completed_at', now()::text)
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

/**
 * The same, by the run's agent on the ticket its delegation is minted for
 * (WF-7). The delegation has already held the call to that ticket and to
 * `task:write` on the person's live grant. Only a research ticket: a task or
 * build ticket closes through its own run, and a grilling or prototype ticket
 * needs `task:decide`, which no agent holds.
 */
export async function resolveTicketAsAgent(
  tx: TenantQuery,
  context: Closing,
  request: RequestOf<'task.resolve'>,
): Promise<HandlerOutcome> {
  return await resolveWith(tx, context, request, (facts) =>
    Promise.resolve(
      facts.type === 'research'
        ? undefined
        : OWNER_TYPES.has(facts.type)
          ? refuseCommand(
              'DELEGATION_EXCLUDES_DECISION',
              ['task:decide'],
              ["A grilling or prototype ticket is resolved by the map's owner, not an agent."],
            )
          : refuseCommand('DELEGATION_OUT_OF_PURPOSE', ['type'], [AGENT_RESEARCH_ONLY]),
    ),
  );
}

async function resolveWith(
  tx: TenantQuery,
  context: Closing,
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
  return await completeWith(tx, context, {
    answer: (answer as string).trim(),
    gist: (gist as string).trim(),
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
  const reason = request.reason;
  if (reason !== undefined && !textOk(reason)) {
    return invalid(['reason'], ['The reason is 1 to 4000 characters, or leave it out.']);
  }
  const title = typeof target.data['title'] === 'string' ? target.data['title'] : 'a ticket';
  const line = typeof reason === 'string' ? `${title}: ${reason.trim()}` : title;
  await applyRevision(tx, context, facts.mapId, {
    addFog: [],
    addOutOfScope: [{ text: line.slice(0, 4000), ticketId: target.id }],
    retire: [],
  });
  return await completeWith(tx, context, { closed_as: 'out_of_scope' });
}
