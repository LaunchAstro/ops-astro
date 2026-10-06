// SPDX-License-Identifier: AGPL-3.0-only
//
// The two seams the panel's Client field stands on (MP-4-8, CS-4.12, DP-19).
//
// **The facts are real.** `realClientFacts` reads the business's clients from
// `client.list` (C32) and takes the task's client and whether it has content
// (S0-5's lock) from `task.read`'s detail, so the field draws no Mock label.
//
// **The duplicate is real too.** "Duplicate without contents" sends through a
// `DuplicateSource`; the panel's own (`realDuplicate`) is `client.mutate` of
// `task.duplicate` with `confirmCarried` passed through. A host may hand the
// panel another (`TaskPanel`'s `duplicate`); a made-up one draws the design
// system's one Mock corner label (`SourceRegion`, MP-1-6) on the form.

import {
  isUnavailable,
  type CallResult,
  type CommandOutcome,
  type OperationsClient,
} from '../../operations/client.ts';
import type {
  ClientListResult,
  InternalTaskDetail as Task,
} from '../../../../../packages/core-wire/src/index.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import { useRead, type UseReadResult } from '../../data/use-read.ts';

/** Where a source's answers come from: `mock` is marked, `real` is not. */
export type SourceProvenance = 'real' | 'mock';

/** One client the task may be put under. */
export interface ClientChoice {
  readonly id: string;
  readonly name: string;
}

/** What the Client field needs to know about the task and the business. */
export interface TaskClientFacts {
  /** The business's clients the reader may put a task under (C32). */
  readonly choices: readonly ClientChoice[];
  /** The client the task is under, by id, or null for none or one the reader cannot see. */
  readonly current: string | null;
  /** The task is under a client the reader's grants do not reach (`clientSet`, no id). */
  readonly unseen: boolean;
  /** True once the task has content: its client is locked (S0-5). */
  readonly hasContent: boolean;
}

export interface ClientFactsSource {
  readonly provenance: SourceProvenance;
  /** A hook: the facts for this task, read the way `useRead` reads. */
  readonly useFacts: (task: Task, grantKey: string) => UseReadResult<TaskClientFacts>;
}

/** What "Duplicate without contents" sends: the chosen client and the shell, as edited. */
export interface DuplicateRequest {
  readonly recordId: string;
  readonly client: string;
  readonly title: string;
  readonly stepNames: readonly string[];
  /** The person confirmed carried text the server warned names the old client. */
  readonly confirmCarried: boolean;
}

/**
 * `task.duplicate`'s answer: the new task's `detail: { taskId, key }` on
 * success; `CARRIED_TEXT_NAMES_CLIENT` naming the carried fields (`title`,
 * `stepNames.<index>`) when unconfirmed carried text names the old client.
 */
export type DuplicateSender = (request: DuplicateRequest) => Promise<CallResult<CommandOutcome>>;

export interface DuplicateSource {
  readonly provenance: SourceProvenance;
  readonly send: DuplicateSender;
}

/** What the panel's host hands the Client field; an absent seam is the real one. */
export interface ClientSeams {
  /** The client list and the content answer; absent, the real ones (`realClientFacts`). */
  readonly clientFacts?: ClientFactsSource | undefined;
  /** "Duplicate without contents"'s sender; absent, the real one (`realDuplicate`). */
  readonly duplicate?: DuplicateSource | undefined;
  /** A duplicate landed: the host opens the new task by its key. */
  readonly onDuplicated?: ((key: string) => void) | undefined;
}

/** The refusal code the carried-text warning arrives under. */
export const CARRIED_TEXT_NAMES_CLIENT = 'CARRIED_TEXT_NAMES_CLIENT';

/** The client list's read state, carrying the task's own facts beside it. */
function withTask(state: ReadState<ClientListResult>, task: Task): ReadState<TaskClientFacts> {
  const facts = (listed: ClientListResult): TaskClientFacts => ({
    choices: listed.clients.map((each) => ({ id: each.clientId, name: each.name })),
    current: task.client,
    unseen: task.clientSet && task.client === null,
    hasContent: task.hasContent,
  });
  switch (state.outcome) {
    case 'loading':
      return { ...state, previous: state.previous === null ? null : facts(state.previous) };
    case 'ready':
    case 'empty':
      return { ...state, value: facts(state.value) };
    default:
      return state;
  }
}

/** An answer with no client list is not drawn as one: the field says it is unavailable. */
function listOrUnavailable(answer: CallResult<ClientListResult>): CallResult<ClientListResult> {
  if (!('ok' in answer) || Array.isArray(answer.value.clients)) return answer;
  return {
    unavailable: true,
    because: 'The API answered with something this screen could not read.',
  };
}

/**
 * The real facts: `client.list`'s clients (those the reader's grants reach),
 * and the task's client and content answer as `task.read` sent them. A client
 * the list does not name is drawn "A client you cannot see".
 */
export function realClientFacts(client: OperationsClient): ClientFactsSource {
  return {
    provenance: 'real',
    useFacts: (task, grantKey) => {
      const { state, reload } = useRead<ClientListResult>({
        grantKey,
        run: async () => listOrUnavailable(await client.read<ClientListResult>('client.list', {})),
        deps: [client],
      });
      return { state: withTask(state, task), reload };
    },
  };
}

/**
 * The panel's own duplicate: `task.duplicate` on the person path, as the form
 * sent it. A send whose answer was lost keeps its `operationId` until one
 * comes back, so an unchanged retry is the same attempt and the server replays
 * the task it made; a changed request is a new attempt.
 */
export function realDuplicate(client: OperationsClient): DuplicateSource {
  const held: Record<string, string | undefined> = {};
  return {
    provenance: 'real',
    send: async (request) => {
      const body = {
        recordId: request.recordId,
        client: request.client,
        title: request.title,
        stepNames: request.stepNames,
        confirmCarried: request.confirmCarried,
      };
      const sent = JSON.stringify(body);
      const operationId = (held[sent] ??= client.newOperationId());
      const result = await client.mutate('task.duplicate', body, { operationId });
      if (!isUnavailable(result)) held[sent] = undefined;
      return result;
    },
  };
}
