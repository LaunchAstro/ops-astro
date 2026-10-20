// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat path's task proposal (designs/chat-path-slice.md, piece 2): an
// agent's reply is text the server keeps and never acts on, and it may end
// with one block naming a task to create, or an edit of the task the chat is
// open on:
//
//   ```task
//   {"action":"create","title":"…","description":"…","due":"2026-10-17","estimate":90}
//   ```
//
// `due` is a calendar day and `estimate` whole minutes, both optional; they
// fill the task's Due and Estimate fields rather than its description. The
// model never names an id or an assignee: `edit` always means the chat's own task. Only a
// whole, valid block is read. Any other key, a second block, a block with
// words after it, bad JSON or a value out of range gives no proposal, and the
// body stays exactly as written. Nothing here writes: the person's click on the
// drawn card is the only write (`apps/web/src/assistant/proposals.ts`).
//
// A third action, `site_change` (#1988, `site-plan.ts`), plays back a change
// to one of the bound pages the reader is given, and reads as a create
// carrying the plan.

import {
  planSection,
  SITE_CHANGE_KEYS,
  sitePlanOf,
  type SitePageView,
  type SitePlan,
} from './site-plan.ts';

export const PROPOSAL_TITLE_LIMIT = 200;
export const PROPOSAL_DESCRIPTION_LIMIT = 4000;
/** The task's own estimate bound (`tasks-write.ts`), in whole minutes. */
export const PROPOSAL_ESTIMATE_LIMIT = 1_000_000;

/** The task's Due day and Estimate minutes, where the block names them. */
export interface ProposedPlan {
  readonly due?: string;
  readonly estimate?: number;
}

export type TaskProposal = (
  | {
      readonly action: 'create';
      readonly title: string;
      readonly description: string | null;
      /** A site change's plan (#1988): the description is its section. */
      readonly site?: SitePlan;
    }
  | {
      readonly action: 'edit';
      readonly title: string | null;
      readonly description: string | null;
    }
) &
  ProposedPlan;

export interface ProposalRead {
  /** The reply's words before the block, or the whole body when there is no proposal. */
  readonly words: string;
  readonly proposal: TaskProposal | null;
}

/** Anything a reader would take for a task block's opening: indented, any fence length, tildes or words after. */
const OPENING = /^ {0,3}(?:`{3,}|~{3,})[ \t]*task\b/mu;
/** The one block, closing the reply: its JSON, then only white space. */
const CLOSING = /(?:^|\n)```task[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/u;
const KEYS = new Set(['action', 'title', 'description', 'due', 'estimate']);

const characters = (text: string): number => [...text].length;

/** One line with something to read: no control character, and more than spaces and invisible marks. */
const titled = (value: unknown): value is string =>
  typeof value === 'string' &&
  /[^\s\p{Cf}]/u.test(value) &&
  !/\p{Cc}/u.test(value) &&
  characters(value) <= PROPOSAL_TITLE_LIMIT;

/** Any text a person could write, lines and tabs included, but no NUL, which no text field stores. */
const described = (value: unknown): value is string =>
  typeof value === 'string' &&
  !value.includes('\u0000') &&
  characters(value) <= PROPOSAL_DESCRIPTION_LIMIT;

/** A real calendar day, written `YYYY-MM-DD`. */
function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

const isMinutes = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= PROPOSAL_ESTIMATE_LIMIT;

/** The due day and estimate the block names, each checked; null when either is out of range. */
function planOf(fields: Record<string, unknown>): ProposedPlan | null {
  const { due, estimate } = fields;
  if ((due !== undefined && !isDay(due)) || (estimate !== undefined && !isMinutes(estimate))) {
    return null;
  }
  return { ...(due === undefined ? {} : { due }), ...(estimate === undefined ? {} : { estimate }) };
}

function parsed(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** A whole site change block on a bound page, as the create it asks for. */
function siteChangeOf(
  fields: Record<string, unknown>,
  pages: readonly SitePageView[],
): TaskProposal | null {
  const { title, estimate } = fields;
  if (Object.keys(fields).some((key) => !SITE_CHANGE_KEYS.has(key))) return null;
  if (!titled(title) || !isMinutes(estimate)) return null;
  const site = sitePlanOf(fields, pages);
  if (site === null) return null;
  return { action: 'create', title, description: planSection(site, estimate), estimate, site };
}

function proposalOf(value: unknown, pages: readonly SitePageView[]): TaskProposal | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (fields['action'] === 'site_change') return siteChangeOf(fields, pages);
  if (Object.keys(fields).some((key) => !KEYS.has(key))) return null;
  const { action, title, description } = fields;
  const plan = planOf(fields);
  if (plan === null) return null;
  if (description !== undefined && !described(description)) return null;
  if (title !== undefined && !titled(title)) return null;
  if (action === 'create' && title !== undefined) {
    return { action, title, description: description ?? null, ...plan };
  }
  const named = title !== undefined || description !== undefined || Object.keys(plan).length > 0;
  if (action === 'edit' && named) {
    return { action, title: title ?? null, description: description ?? null, ...plan };
  }
  return null;
}

/**
 * The reply's words and the proposal its closing block names, or the body as
 * written. `pages` are the bound pages the model was given: a site change
 * naming any other is no proposal.
 */
export function readProposal(body: string, pages: readonly SitePageView[] = []): ProposalRead {
  const none = { words: body, proposal: null };
  const closing = CLOSING.exec(body);
  if (closing === null) return none;
  const words = body.slice(0, closing.index);
  // A second block anywhere before the closing one makes neither a proposal.
  if (OPENING.test(words)) return none;
  const proposal = proposalOf(parsed(closing[1] ?? ''), pages);
  return proposal === null ? none : { words: words.trimEnd(), proposal };
}

type ProposedFields = Pick<TaskProposal, 'title' | 'description'> & ProposedPlan;

/** The task fields a proposal sets: its words, and its day and minutes in their own fields. */
const fieldsOf = (proposal: ProposedFields): Record<string, string | number> => ({
  ...(proposal.title === null ? {} : { title: proposal.title }),
  ...(proposal.description === null ? {} : { description: proposal.description }),
  ...(proposal.due === undefined ? {} : { due: proposal.due }),
  ...(proposal.estimate === undefined ? {} : { estimated_minutes: proposal.estimate }),
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
  readonly fields: Record<string, string | number>;
  readonly conversationId: string | null;
}> {
  return {
    operationId: operationOf(messageId),
    body: { fields: fieldsOf(proposal), conversationId },
  };
}

/**
 * The `task.assign` a create's click sends once the task is made, for the
 * reply `messageId`: to `personId`, at the revision the create returned.
 */
export function proposalAssign(
  messageId: string,
  task: { readonly recordId: string; readonly revision: number },
  personId: string,
): ProposalWrite<{
  readonly recordId: string;
  readonly fields: { readonly assignee: string };
}> & {
  readonly expectedRevision: number;
} {
  return {
    operationId: `task-proposal-assign:${messageId}`,
    expectedRevision: task.revision,
    body: { recordId: task.recordId, fields: { assignee: personId } },
  };
}

/** The `task.update` a card's click sends for the reply `messageId`, at the revision its question saw. */
export function proposalEdit(
  proposal: ProposedFields,
  messageId: string,
  task: { readonly taskId: string; readonly revision: number },
): ProposalWrite<{
  readonly recordId: string;
  readonly fields: Record<string, string | number>;
}> & {
  readonly expectedRevision: number;
} {
  return {
    operationId: operationOf(messageId),
    expectedRevision: task.revision,
    body: { recordId: task.taskId, fields: fieldsOf(proposal) },
  };
}
