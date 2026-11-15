// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs, the agent path (#2519, #2493 piece 3; director's option A, round events
// 2026-11-15T10:37:31Z): the three Docs writes in the agent operation table, spread into
// `AGENT_OPERATIONS` with that table's own closure, kept apart for its line cap.
//
// Each is a `record` row on the task its body names in `taskId` (`subjectTask: 'task'`), so the
// agent reaches it only under a delegation minted for that task, and only one that carries
// `docs:write` itself: a delegation without the `docs` collection is refused
// DELEGATION_EXCLUDES_OPERATION before the delegation check (`agent-authority.ts`). No
// delegation reaches the business: the custody model is unchanged, and the one-task purpose is
// the ceiling it always was.
//
// The agent writes for its delegating person: the Docs store asks that person's `docs:write` at
// business scope once its rows are held (`core-records/src/docs/store.ts`), so the agent never
// holds more than the person, and the delegation is asked again after the last wait
// (`agent-standing.ts`). A task with a client is refused CLIENT_MODEL_USE_OFF before anything
// is written: an agent's note filed from a client's work would carry that client's material into
// the business's own Docs, which every `docs:read` holder reads. The first-client gate shuts
// client-data writes, and a Docs write reached here never holds a client's.
//
// The folder or version row names the task and the delegation (20261115112100), and the applied
// audit event names the task as its subject.

import { delegatingSubjects, isUuid } from '../../../core-records/src/index.ts';
import type { Delegation, DocsWriter, TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandName } from '../../../core-wire/src/index.ts';
import type { AgentCall, AgentRequest, NoOperands } from './agent-call.ts';
import { fileDocsFolderAs, fileDocsPageAs, reviseDocsPageAs } from './docs.ts';
import { invalid } from './operands.ts';
import { isRefused, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type DocsAgentName = Extract<
  CommandName,
  'docs.create_folder' | 'docs.create_page' | 'docs.update_page'
>;

/** A Docs row: checked on the task its body names, and served on that task alone. */
export interface DocsAgentRow {
  readonly authority: 'record';
  readonly subjectTask: 'task';
  readonly replay: 'reauthorise';
  readonly operands: () => NoOperands;
  readonly serve: (
    tx: TenantQuery,
    call: AgentCall,
    operands: NoOperands,
    delegation: Delegation,
    taskId: string | undefined,
  ) => Promise<HandlerOutcome>;
}

const NAME_THE_TASK = refused(
  invalid('taskId', 'Send taskId as the task you work under, the one your delegation names.'),
);

const CLIENT_TASK = refused(
  refuseCommand(
    'CLIENT_MODEL_USE_OFF',
    ['taskId'],
    [
      'This task is a client’s: an agent’s note from it would carry the client’s material into the business’s Docs.',
      'A person files it, with their own words.',
    ],
  ),
);

/** Whether the task holds a client, read under a `for share` hold, so no link lands meanwhile. */
async function holdsClient(tx: TenantQuery, taskId: string): Promise<boolean> {
  const [task] = await tx.query<{ readonly client: string | null }>(
    `select uuid_7 as client from public.records
      where business_id = $1 and id = $2::uuid for share`,
    [tx.businessId, taskId],
  );
  return task === undefined || task.client !== null;
}

/** One Docs write for a writer, over the body the envelope parsed against its surface row. */
type Write = (
  tx: TenantQuery,
  writer: DocsWriter,
  request: AgentRequest,
) => Promise<HandlerOutcome>;
type Of<K extends DocsAgentName> = CommandRequest & { readonly command: K };

const docsRow = (write: Write): DocsAgentRow => ({
  authority: 'record',
  subjectTask: 'task',
  replay: 'reauthorise',
  // Nothing refused before the delegation answers: a body naming no task, or one that is not
  // an identifier, is checked on no task and refused DELEGATION_OUT_OF_PURPOSE, as a foreign
  // and a fabricated one are (`namedTaskId`).
  operands: () => ({}),
  serve: async (tx, { session, request }, _operands, delegation, taskId) => {
    // The check was made on this task (`namedTaskId`), never the body read again.
    if (taskId === undefined || !isUuid(taskId)) return NAME_THE_TASK;
    if (await holdsClient(tx, taskId)) return CLIENT_TASK;
    const writer: DocsWriter = {
      actorId: session.actorId,
      subjects: await delegatingSubjects(tx, delegation),
      agent: { taskId, delegationId: delegation.id },
    };
    const outcome = await write(tx, writer, request);
    return isRefused(outcome) ? outcome : { ...outcome, auditSubjectId: taskId };
  },
});

export const docsAgentRows = <T>(
  close: (typed: DocsAgentRow) => T,
): readonly (readonly [DocsAgentName, T])[] => [
  // The envelope has parsed each body against its surface row before `serve`.
  [
    'docs.create_folder',
    close(
      docsRow(
        async (tx, writer, request) =>
          await fileDocsFolderAs(tx, writer, request as unknown as Of<'docs.create_folder'>),
      ),
    ),
  ],
  [
    'docs.create_page',
    close(
      docsRow(
        async (tx, writer, request) =>
          await fileDocsPageAs(tx, writer, request as unknown as Of<'docs.create_page'>),
      ),
    ),
  ],
  [
    'docs.update_page',
    close(
      docsRow(
        async (tx, writer, request) =>
          await reviseDocsPageAs(tx, writer, request as unknown as Of<'docs.update_page'>),
      ),
    ),
  ],
];
