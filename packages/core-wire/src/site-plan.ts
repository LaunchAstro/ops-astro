// SPDX-License-Identifier: AGPL-3.0-only
//
// #1988: a site change, played back in the side chat as the task (spec #1995).
// A reply may end with a `site_change` task block naming one of the bound
// pages the model was given (`conversation-context.ts`), the text before and
// after, the client (`internal` until client sites open) and the minutes.
// It reads as a create: the title, the plan as a fixed section of the
// description, the minutes as the task's estimate, so the click is the create
// card's own write and nothing else. The agent working the task reads the
// section back (`sitePlanRequest`) and asks `live_correction.request` on its
// existing shape; the request's own checks stay the fence.

/** A bound page as the model and the card are given it: its site's repository and its address. */
export interface SitePageView {
  readonly repository: string;
  readonly page: string;
}

/** The plan a site change block names, with the repository its page is bound to. */
export interface SitePlan extends SitePageView {
  readonly before: string;
  readonly after: string;
  readonly client: 'internal';
}

/** The phrase bound: one line of at most 200 characters (#1987). */
export const SITE_TEXT_LIMIT = 200;
/** At most this many bound pages are given to the model and the card. */
export const SITE_PAGE_LIMIT = 20;

export const SITE_CHANGE_KEYS: ReadonlySet<string> = new Set([
  'action',
  'title',
  'page',
  'before',
  'after',
  'client',
  'estimate',
]);

/** One line with something to read, within the bound: no control character, tabs and line breaks included. */
const oneLine = (value: unknown): value is string =>
  typeof value === 'string' &&
  /[^\s\p{Cf}]/u.test(value) &&
  !/\p{Cc}/u.test(value) &&
  [...value].length <= SITE_TEXT_LIMIT;

/** The plan a block's fields name, or null when a text is out of bounds or the page is not bound. */
export function sitePlanOf(
  fields: Readonly<Record<string, unknown>>,
  pages: readonly SitePageView[],
): SitePlan | null {
  const { page, before, after, client } = fields;
  if (!oneLine(before) || !oneLine(after) || before === after || client !== 'internal') return null;
  const bound = pages.find((each) => each.page === page);
  return bound === undefined ? null : { ...bound, before, after, client };
}

const isPage = (each: unknown): each is SitePageView =>
  typeof each === 'object' &&
  each !== null &&
  Object.keys(each).length === 2 &&
  typeof (each as Record<string, unknown>)['repository'] === 'string' &&
  typeof (each as Record<string, unknown>)['page'] === 'string';

/** Bound pages as a reply or a read carries them, unchecked: none unless every entry is whole. */
export function sitePagesOf(value: unknown): readonly SitePageView[] {
  return Array.isArray(value) &&
    value.length <= SITE_PAGE_LIMIT &&
    value.every((each) => isPage(each))
    ? value
    : [];
}

const HEAD = 'Site change plan';
const LABELS = ['Site', 'Page', 'Before', 'After', 'Client'] as const;

/** The plan as the task's description: one labelled line each, then the estimate. */
export function planSection(plan: SitePlan, estimate: number): string {
  const values = [plan.repository, plan.page, plan.before, plan.after, plan.client];
  return [
    HEAD,
    ...LABELS.map((label, at) => `${label}: ${values[at] ?? ''}`),
    `Estimate: ${String(estimate)} minutes`,
  ].join('\n');
}

/** The task's plan, when its description is exactly a plan section. */
function readSection(description: string): Omit<SitePlan, 'repository'> | null {
  const lines = description.split('\n');
  if (lines.length !== LABELS.length + 2 || lines[0] !== HEAD) return null;
  const values = LABELS.map((label, at) => {
    const line = lines[at + 1] ?? '';
    return line.startsWith(`${label}: `) ? line.slice(label.length + 2) : undefined;
  });
  const [, page, before, after, client] = values;
  if (!/^Estimate: \d+ minutes$/u.test(lines.at(-1) ?? '')) return null;
  if (page === undefined || !oneLine(before) || !oneLine(after) || client !== 'internal') {
    return null;
  }
  return { page, before, after, client };
}

/**
 * The correction the agent asks for a task holding a plan: the request's own
 * shape, `{ taskId, page, word, replacement }`. Null for any other task.
 */
export function sitePlanRequest(task: {
  readonly id: string;
  readonly description: string | null;
}): {
  readonly taskId: string;
  readonly page: string;
  readonly word: string;
  readonly replacement: string;
} | null {
  const plan = task.description === null ? null : readSection(task.description);
  return plan === null
    ? null
    : { taskId: task.id, page: plan.page, word: plan.before, replacement: plan.after };
}
