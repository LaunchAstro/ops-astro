// SPDX-License-Identifier: AGPL-3.0-only
//
// The two seams the panel's Client field stands on (MP-4-8, CS-4.12, DP-19),
// and the made-up data each gives until its real owner joins.
//
// **What is not on this base.** The business's client list (C32), which client
// the task is under (`task.read` sends `clientSet` only), whether the task has
// content (S0-5's lock) and the `task.duplicate` command are family B's, not
// yet on this base. The field reads them through `ClientFactsSource` and sends
// the duplicate through `DuplicateSource`; each says whether it is `real` or
// `mock`, and a `mock` one draws the design system's one Mock corner label on
// what it fills (`SourceRegion`, MP-1-6). A real source never carries it.
//
// **Wiring the real ones** is one small piece: a `ClientFactsSource` whose
// `useFacts` is a `useRead` of the client list and the task's content answer,
// and a `DuplicateSource` whose `send` is `client.mutate` of `task.duplicate`
// with `confirmCarried` passed through; `DockPanel.tsx` hands both to the panel
// (`TaskPanel`'s `clientFacts` and `duplicate`). Until then the panel uses the
// two `MOCK_…` sources below.

import type { CallResult, CommandOutcome, WireRefusal } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import type { UseReadResult } from '../../data/use-read.ts';

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

/** What the panel's host hands the Client field; each absent one is the made-up one. */
export interface ClientSeams {
  /** The client list and the content answer, made up until wired. */
  readonly clientFacts?: ClientFactsSource | undefined;
  /** "Duplicate without contents"'s sender, made up until wired. */
  readonly duplicate?: DuplicateSource | undefined;
  /** A duplicate landed: the host opens the new task by its key. */
  readonly onDuplicated?: ((key: string) => void) | undefined;
}

/** The refusal code the carried-text warning arrives under. */
export const CARRIED_TEXT_NAMES_CLIENT = 'CARRIED_TEXT_NAMES_CLIENT';

// -- Made-up data, until family B joins. Every use is drawn with the Mock label.

const MOCK_CLIENTS: readonly ClientChoice[] = [
  { id: 'mock-client-harbour', name: 'Harbour Physio' },
  { id: 'mock-client-verity', name: 'Verity Dental' },
  { id: 'mock-client-north', name: 'North Shore Allied Health' },
];

/** Made up: a task "has content" once it has a comment or a step. */
function mockHasContent(task: Task): boolean {
  return task.comments.length > 0 || task.steps.length > 0;
}

export const MOCK_CLIENT_FACTS: ClientFactsSource = {
  provenance: 'mock',
  useFacts: (task, grantKey) => ({
    state: {
      outcome: 'ready',
      value: {
        choices: MOCK_CLIENTS,
        current: task.clientSet ? (MOCK_CLIENTS[0]?.id ?? null) : null,
        hasContent: mockHasContent(task),
      },
      refusal: null,
      because: null,
      grantKey,
    },
    reload: () => {
      /* made up: nothing to read again */
    },
  }),
};

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
