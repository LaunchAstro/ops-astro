// SPDX-License-Identifier: AGPL-3.0-only
//
// What the agent in the side panel is told before the person's words, for a
// provider whose adapter writes the whole chat (Ollama). The reply is text the
// server keeps and never acts on. It may end with one task block, which the
// panel draws as a card; only the person's click on that card sends
// `task.create` or `task.update`. An edit means the task the chat is open on,
// or, in a chat on no task, one this chat created, which the person picks on
// the card (#1666). The model is never shown, and never names, a task id.

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

/** Today on this machine's clock, as YYYY-MM-DD, so a due date the model writes lands in the right year. */
const today = (now: Date): string => now.toLocaleDateString('en-CA');

function pageLine(page: PromptPage): string {
  if (page.kind === 'task') return `The person has this task open: ${JSON.stringify(page.title)}.`;
  if (page.kind === 'created') {
    return 'The person has no task open. This chat has created tasks the person can change from here.';
  }
  return 'The person has no task open.';
}

/** The system message: the instructions for what the chat is on, today's date, then that page. */
export function conversationInstructions(page: PromptPage, now: Date = new Date()): string {
  return `${instructions(page.kind)}\n\nToday is ${today(now)}. ${pageLine(page)}`;
}
