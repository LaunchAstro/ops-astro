// SPDX-License-Identifier: AGPL-3.0-only
//
// The two seams the panel's Client field stands on (MP-4-8, CS-4.12, DP-19).
//
// **The facts are real.** `realClientFacts` reads the business's clients from
// `client.list` (C32) and takes the task's client and whether it has content
// (S0-5's lock) from `task.read`'s detail, so the field draws no Mock label.
//
// **The duplicate is made up** until `task.duplicate` joins this branch: the
// form sends through `DuplicateSource`, and `MOCK_DUPLICATE` draws the design
// system's one Mock corner label (`SourceRegion`, MP-1-6) on the form. Wiring
// it is a `DuplicateSource` whose `send` is `client.mutate` of
// `task.duplicate` with `confirmCarried` passed through, handed to the panel
// (`TaskPanel`'s `duplicate`).

import type {
  CallResult,
  CommandOutcome,
  OperationsClient,
  WireRefusal,
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
  /** The client the task is under, by id, or null for none. */
  readonly current: string | null;
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

/** What the panel's host hands the Client field; an absent duplicate is the made-up one. */
export interface ClientSeams {
  /** The client list and the content answer; absent, the real ones (`realClientFacts`). */
  readonly clientFacts?: ClientFactsSource | undefined;
  /** "Duplicate without contents"'s sender, made up until wired. */
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

// -- Made-up data. Every use is drawn with the Mock label.

/** The made-up duplicate's old client, whose name its warning looks for. */
const MOCK_CLIENTS: readonly ClientChoice[] = [
  { id: 'mock-client-harbour', name: 'Harbour Physio' },
  { id: 'mock-client-verity', name: 'Verity Dental' },
  { id: 'mock-client-north', name: 'North Shore Allied Health' },
];

/** Made up: warns on the first made-up client's name, as the server will on the old client's. */
export const MOCK_DUPLICATE: DuplicateSource = {
  provenance: 'mock',
  send: (request) => {
    const name = (MOCK_CLIENTS[0]?.name ?? '').toLowerCase();
    const carried = [
      ['title', request.title],
      ...request.stepNames.map((text, index) => [`stepNames.${index}`, text]),
    ].filter(([, text]) => text?.toLowerCase().includes(name));
    if (!request.confirmCarried && carried.length > 0) {
      const code: string = CARRIED_TEXT_NAMES_CLIENT;
      const refusal = {
        refused: true,
        code,
        names: carried.map(([field]) => field ?? ''),
        fixes: ['Carried text names the old task’s client. Edit it out, or confirm it.'],
      };
      return Promise.resolve(refusal as WireRefusal);
    }
    return Promise.resolve({
      ok: true,
      value: {
        recordId: 'mock-task-duplicate',
        revision: 1,
        detail: { taskId: 'mock-task-duplicate', key: 'MOCK-DUPLICATE' },
      },
    });
  },
};
