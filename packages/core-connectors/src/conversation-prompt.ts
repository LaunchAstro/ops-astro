// SPDX-License-Identifier: AGPL-3.0-only
//
// What the agent in the side panel is told before the person's words, for a
// provider whose adapter writes the whole chat (Ollama). The reply is text the
// server keeps and never acts on. It may end with one task block, which the
// panel draws as a card; only the person's click on that card sends
// `task.create` or `task.update`. An edit means the task the chat is open on,
// or, in a chat on no task, one this chat created, which the person picks on
// the card (#1666). The model is never shown, and never names, a task id.
// The field also carries the bound site pages the caller may ask a correction
// on (#1988), each by repository and address, so a site change the model
// plays back names one of them; given none, it is told none is set up.

/** The info string of the fenced block the panel reads as a task proposal. */
export const TASK_BLOCK_FENCE = '```task';

/** What the chat is on, as the `page` field says (`conversation-context.ts`): never an id. */
export type PromptPage =
  | { readonly kind: 'none' }
  | { readonly kind: 'task'; readonly title: string }
  | { readonly kind: 'created' };

/** The `page` field read: a task's title (`{ task, title }`, never its id), tasks this chat created (`{ created: true }`), or none. */
export function promptPage(page: string | undefined): PromptPage {
  if (page === undefined || page === '') return { kind: 'none' };
  try {
    const { title, created } = JSON.parse(page) as Record<string, unknown>;
    if (typeof title === 'string' && title !== '') return { kind: 'task', title };
    return created === true ? { kind: 'created' } : { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

/** A bound page as the `page` field carries it: its site's repository and its address. */
export interface PromptSite {
  readonly repository: string;
  readonly page: string;
}

const isSite = (value: unknown): value is PromptSite => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    Object.keys(fields).length === 2 &&
    typeof fields['repository'] === 'string' &&
    typeof fields['page'] === 'string'
  );
};

/** The `page` field's bound pages; none unless every entry is whole. */
export function promptSites(page: string | undefined): readonly PromptSite[] {
  if (page === undefined || page === '') return [];
  try {
    const { sites } = JSON.parse(page) as Record<string, unknown>;
    return Array.isArray(sites) && sites.every((each) => isSite(each)) ? sites : [];
  } catch {
    return [];
  }
}

/** What an edit means for each kind of page; on none, the model offers only a create. */
const EDITS: Readonly<Record<PromptPage['kind'], { readonly ask: string; readonly use: string }>> =
  {
    task: {
      ask: ', or to change the task they have open',
      use: ', or "edit" to change the task the person has open, giving only the keys to change',
    },
    created: {
      ask: ', or to change a task this chat created',
      use: ', or "edit" to change a task this chat created, giving only the keys to change. The person chooses which task on the card, so never name or guess the task; if you cannot tell what to change, ask',
    },
    none: { ask: '', use: '' },
  };

const instructions = (kind: PromptPage['kind']): string =>
  [
    'You are the assistant in Ops Astro, the team’s work app. Answer the person briefly and plainly, in Australian English.',
    'Most messages are conversation: answer them in words, with no task block. Do not offer or suggest a task unless the person asks for one.',
    `You cannot create, change or set up anything yourself, and you must never say or suggest that you have, or that you will: you only propose. If they mention something to do, you may ask whether they want a task for it. Only when the person plainly asks you to create a task${EDITS[kind].ask}, say in one short sentence that here is a task for them to create, then end your reply with one block in exactly this form, and nothing after it:`,
    `${TASK_BLOCK_FENCE}\n{"action":"create","title":"Short task title","description":"What needs doing"}\n\`\`\``,
    `Use "create" for a new task${EDITS[kind].use}. Two keys are optional: "due", the date it is due as YYYY-MM-DD (never put the date in the description), and "estimate", the work it needs in whole minutes. The title is at most 200 characters and the description at most 4,000. Write at most one block. Nothing happens until the person clicks the button under it.`,
  ].join('\n\n');

const SITE_BLOCK = `${TASK_BLOCK_FENCE}\n{"action":"site_change","title":"Short task title","page":"Page address","before":"The text now","after":"The text it becomes","client":"internal","estimate":15}\n\`\`\``;

/** What the model is told of site changes: the bound pages and the block, or that none is set up. */
function siteWords(sites: readonly PromptSite[]): string {
  if (sites.length === 0) {
    return 'No site page is set up for changes here, so if the person asks for one, say the page is not set up.';
  }
  return [
    'When the person plainly asks to change the text on one of the site pages below, first say back in words the site and its repository, the page address, the text before and after, who it is for (internal) and a rough time, then end your reply with one block in exactly this form, and nothing after it:',
    SITE_BLOCK,
    'Use only a page from this list, written exactly as it is; if the page they mean is not listed, say the page is not set up and write no block. "before" and "after" are each one line of at most 200 characters, and "estimate" is the work in whole minutes. The pages, each as repository: page address:',
    sites.map((site) => `- ${site.repository}: ${site.page}`).join('\n'),
  ].join('\n\n');
}

/** Today on this machine's clock, as YYYY-MM-DD, so a due date the model writes lands in the right year. */
const today = (now: Date): string => now.toLocaleDateString('en-CA');

function pageLine(page: PromptPage): string {
  if (page.kind === 'task') return `The person has this task open: ${JSON.stringify(page.title)}.`;
  if (page.kind === 'created') {
    return 'The person has no task open. This chat has created tasks the person can change from here.';
  }
  return 'The person has no task open.';
}

/** The system message: the instructions for what the chat is on, the site pages, today's date, then that page. */
export function conversationInstructions(
  page: PromptPage,
  sites: readonly PromptSite[] = [],
  now: Date = new Date(),
): string {
  return `${instructions(page.kind)}\n\n${siteWords(sites)}\n\nToday is ${today(now)}. ${pageLine(page)}`;
}
