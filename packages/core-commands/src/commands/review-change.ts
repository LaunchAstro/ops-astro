// SPDX-License-Identifier: AGPL-3.0-only
//
// C57's change requests (#2016): `review.propose_change` files a client pin as one proposed
// change request, `proposal:write` at the review's holder; `review.decide_change` approves or
// refuses it, `proposal:decide` there. The door asks each key at the holder (`prepare.ts`),
// the review is locked and judged again in the statement, and the key is read once more after
// the last lock wait, so a grant revoked while the write waited keeps nothing. A decision is a
// person's alone: the surface never offers it to an agent, and the handler refuses an agent
// key itself. Neither makes a task (#2117).
//
// Filing a client's pin from an agent is a model reading the client's words, which reaches no
// model while no local one exists (C60, owner line 72): the agent is refused
// CLIENT_MODEL_USE_OFF, before any model is asked and with nothing filed, and a person files
// the pin with their own text through the same command. Refusals carry fixed text only: no
// pin body or request text reaches a refused caller.

import {
  clientPinSource,
  decideChangeRequest,
  fileChangeRequest,
  isUuid,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type {
  ChangeRequestRefusal,
  Covering,
  Delegation,
  TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';
import type { CommandContext } from './context.ts';
import { readTaskSpine } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { lockTask } from './prepare.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { endedRefusal, standsAfterWaits } from './live-correction-standing.ts';
import { refuseUnstorable, unstorableOperands } from './values.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };
type Sent = Readonly<Record<string, unknown>>;

const TEXT_LIMIT = 2000;
const PROPOSAL_COLLECTION = 'proposal';

const REFUSALS: Readonly<Record<ChangeRequestRefusal['code'], CommandRefusal>> = {
  NOT_FOUND: refuseNotFound(),
  CHANGE_REQUEST_ALREADY_FILED: refuseCommand(
    'CHANGE_REQUEST_ALREADY_FILED',
    ['commentId'],
    ['This pin is filed already; decide its change request on the review’s task.'],
  ),
  CHANGE_REQUEST_ALREADY_DECIDED: refuseCommand(
    'CHANGE_REQUEST_ALREADY_DECIDED',
    ['changeRequestId'],
    ['This change request is decided already; a decision is made once.'],
  ),
};

const WAITS_ON_A_LOCAL_MODEL = refuseCommand(
  'CLIENT_MODEL_USE_OFF',
  ['commentId'],
  [
    'This pin is a client’s words, and an agent’s filing would be a model reading them: it waits on a local model.',
    'A person files the change request from the pin meanwhile, with their own words.',
  ],
);

const ONLY_A_PERSON_DECIDES = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['Only a person decides a change request, signed in as themselves.'],
);

const OUT_OF_PURPOSE = refuseCommand(
  'DELEGATION_OUT_OF_PURPOSE',
  ['commentId'],
  ['A delegation reaches only the task it was minted for.'],
);

/** An id left out is the caller's to send; a malformed one names nothing, as a fabricated one. */
const MISSING = (name: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [name], [`Send ${name} as an identifier.`]));

const proposal = (context: CommandContext, action: 'write' | 'decide'): Covering => ({
  subjects: subjectsOf(context.session),
  collection: PROPOSAL_COLLECTION,
  action,
});

const personOf = ({ session }: CommandContext) => ({
  actorId: session.actorId,
  personId: session.personId,
});

/** After the last lock wait: the person's key at the holder, read again. */
async function settled(
  tx: TenantQuery,
  covering: Covering,
  written: { readonly id: string; readonly state: string; readonly partyId: string | null },
): Promise<HandlerOutcome> {
  const stood = await standsAfterWaits(tx, { covering, partyId: written.partyId });
  if (stood !== 'stands') return refused(endedRefusal(stood, false));
  return applied(written.id, null, { changeRequestId: written.id, state: written.state });
}

export async function proposeChange(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'review.propose_change'>,
): Promise<HandlerOutcome> {
  if (typeof request.commentId !== 'string') return MISSING('commentId');
  if (!isUuid(request.commentId)) return refused(refuseNotFound());
  // An agent key of the person's own is still an agent reading the client's words.
  if (context.session.credentialScope !== undefined) return refused(WAITS_ON_A_LOCAL_MODEL);
  const { text } = request;
  if (typeof text !== 'string' || text.trim() === '' || text.length > TEXT_LIMIT) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['text'],
        [`Send text as the change asked for, 1 to ${TEXT_LIMIT} characters.`],
      ),
    );
  }
  const unstorable = unstorableOperands(request, ['text']);
  if (unstorable.length > 0) return refused(refuseUnstorable(unstorable));
  const source = await clientPinSource(tx, request.commentId.toLowerCase());
  if (source === undefined) return refused(refuseNotFound());
  // The task is locked before the review, the order a pin takes.
  const spine = await readTaskSpine(tx);
  if ((await lockTask(tx, spine.taskTypeId, source.taskId)) === undefined) {
    return refused(refuseNotFound());
  }
  const covering = proposal(context, 'write');
  const filed = await fileChangeRequest(tx, source, text, covering, personOf(context));
  if ('code' in filed) return refused(REFUSALS[filed.code]);
  return await settled(tx, covering, filed);
}

export async function decideChange(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'review.decide_change'>,
): Promise<HandlerOutcome> {
  // A person's alone: the door keeps every agent credential off this row, and so does this.
  if (context.session.credentialScope !== undefined) return refused(ONLY_A_PERSON_DECIDES);
  if (typeof request.changeRequestId !== 'string') return MISSING('changeRequestId');
  if (!isUuid(request.changeRequestId)) return refused(refuseNotFound());
  const { decision } = request;
  if (decision !== 'approve' && decision !== 'refuse') {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['decision'], ['Send decision as approve or refuse.']),
    );
  }
  const covering = proposal(context, 'decide');
  const decided = await decideChangeRequest(
    tx,
    request.changeRequestId.toLowerCase(),
    decision,
    covering,
    personOf(context),
  );
  if ('code' in decided) return refused(REFUSALS[decided.code]);
  return await settled(tx, covering, decided);
}

/**
 * `review.propose_change`'s agent row: inside a delegation for the pin's own task the agent is
 * told it waits on a local model, and outside it is refused for the delegation. It files
 * nothing and asks no model either way.
 */
export const PROPOSE_CHANGE: {
  readonly authority: 'record';
  readonly subjectTask: 'record';
  readonly replay: 'reauthorise';
  readonly operands: () => Readonly<Record<string, never>>;
  readonly serve: (
    tx: TenantQuery,
    call: {
      readonly session: { readonly actorId: string };
      readonly declaration: CommandDeclaration;
      readonly request: Sent;
    },
    operands: Readonly<Record<string, never>>,
    delegation: Delegation,
  ) => Promise<HandlerOutcome>;
} = {
  authority: 'record',
  subjectTask: 'record',
  replay: 'reauthorise',
  operands: () => ({}),
  serve: async (tx, call, _operands, delegation) => {
    const commentId = call.request['commentId'];
    if (typeof commentId !== 'string') return MISSING('commentId');
    if (!isUuid(commentId)) return refused(refuseNotFound());
    const source = await clientPinSource(tx, commentId.toLowerCase());
    if (source === undefined) return refused(refuseNotFound());
    if (delegation.purposeScope.id !== source.taskId) return refused(OUT_OF_PURPOSE);
    return refused(WAITS_ON_A_LOCAL_MODEL);
  },
};
