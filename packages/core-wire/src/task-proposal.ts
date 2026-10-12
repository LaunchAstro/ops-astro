// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat path's task proposal (designs/chat-path-slice.md, piece 2): an
// agent's reply is text the server keeps and never acts on, and it may end
// with one block naming a task to create, or an edit of the task the chat is
// open on:
//
//   ```task
//   {"action":"create","title":"…","description":"…"}
//   ```
//
// The model never names an id: `edit` always means the chat's own task. Only a
// whole, valid block is read. Any other key, a second block, a block with
// words after it, bad JSON or a value out of range gives no proposal, and the
// body stays exactly as written. Nothing here writes: the person's click on the
// drawn card is the only write (`apps/web/src/assistant/proposals.ts`).

export const PROPOSAL_TITLE_LIMIT = 200;
export const PROPOSAL_DESCRIPTION_LIMIT = 4000;

export type TaskProposal =
  | {
      readonly action: 'create';
      readonly title: string;
      readonly description: string | null;
    }
  | {
      readonly action: 'edit';
      readonly title: string | null;
      readonly description: string | null;
    };

export interface ProposalRead {
  /** The reply's words before the block, or the whole body when there is no proposal. */
  readonly words: string;
  readonly proposal: TaskProposal | null;
}

const OPENING = /^```task[ \t]*$/mu;
/** The one block, closing the reply: its JSON, then only white space. */
const CLOSING = /(?:^|\n)```task[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/u;
const KEYS = new Set(['action', 'title', 'description']);

const characters = (text: string): number => [...text].length;

const titled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && characters(value) <= PROPOSAL_TITLE_LIMIT;

const described = (value: unknown): value is string =>
  typeof value === 'string' && characters(value) <= PROPOSAL_DESCRIPTION_LIMIT;

function parsed(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function proposalOf(value: unknown): TaskProposal | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !KEYS.has(key))) return null;
  const { action, title, description } = fields;
  if (description !== undefined && !described(description)) return null;
  if (title !== undefined && !titled(title)) return null;
  if (action === 'create' && title !== undefined) {
    return { action, title, description: description ?? null };
  }
  if (action === 'edit' && (title !== undefined || description !== undefined)) {
    return { action, title: title ?? null, description: description ?? null };
  }
  return null;
}

/** The reply's words and the proposal its closing block names, or the body as written. */
export function readProposal(body: string): ProposalRead {
  const none = { words: body, proposal: null };
  const closing = CLOSING.exec(body);
  if (closing === null) return none;
  const words = body.slice(0, closing.index);
  // A second block anywhere before the closing one makes neither a proposal.
  if (OPENING.test(words)) return none;
  const proposal = proposalOf(parsed(closing[1] ?? ''));
  return proposal === null ? none : { words: words.trimEnd(), proposal };
}

type ProposedFields = Pick<TaskProposal, 'title' | 'description'>;

const fieldsOf = (proposal: ProposedFields): Record<string, string> => ({
  ...(proposal.title === null ? {} : { title: proposal.title }),
  ...(proposal.description === null ? {} : { description: proposal.description }),
});

/**
 * The click's operation id: the reply's message id, so every click on one
 * reply's card, after a reload too, is one attempt the register replays.
 */
const operationOf = (messageId: string): string => `task-proposal:${messageId}`;

/** What a card's click sends: the operation id, the revision an edit was asked at, the body. */
export interface ProposalWrite<Body> {
  readonly operationId: string;
  readonly body: Body;
}

/** The `task.create` a card's click sends for the reply `messageId`. */
export function proposalCreate(
  proposal: ProposedFields,
  messageId: string,
  conversationId: string | null,
): ProposalWrite<{
  readonly fields: Record<string, string>;
  readonly conversationId: string | null;
}> {
  return {
    operationId: operationOf(messageId),
    body: { fields: fieldsOf(proposal), conversationId },
  };
}

/** The `task.update` a card's click sends for the reply `messageId`, at the revision its question saw. */
export function proposalEdit(
  proposal: ProposedFields,
  messageId: string,
  task: { readonly taskId: string; readonly revision: number },
): ProposalWrite<{ readonly recordId: string; readonly fields: Record<string, string> }> & {
  readonly expectedRevision: number;
} {
  return {
    operationId: operationOf(messageId),
    expectedRevision: task.revision,
    body: { recordId: task.taskId, fields: fieldsOf(proposal) },
  };
}
