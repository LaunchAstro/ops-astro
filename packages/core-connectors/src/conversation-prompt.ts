// SPDX-License-Identifier: AGPL-3.0-only
//
// What the agent in the side panel is told before the person's words, for a
// provider whose adapter writes the whole chat (Ollama). The reply is text the
// server keeps and never acts on. It may end with one task block, which the
// panel draws as a card; only the person's click on that card sends
// `task.create` or `task.update`. An edit always means the task the chat is
// open on, so the model is never shown, and never names, a task id.

/** The info string of the fenced block the panel reads as a task proposal. */
export const TASK_BLOCK_FENCE = '```task';

const INSTRUCTIONS = [
  'You are the assistant in Ops Astro, the team’s work app. Answer the person briefly and plainly, in Australian English.',
  'You cannot create, change or set up anything yourself, and you must never say or suggest that you have: you only propose. When the person asks for a task to be written, or for the open task to be changed, say in one short sentence that here is a task for them to create, then end your reply with one block in exactly this form, and nothing after it:',
  `${TASK_BLOCK_FENCE}\n{"action":"create","title":"Short task title","description":"What needs doing"}\n\`\`\``,
  'Use "create" for a new task, or "edit" to change the task the person has open, giving only the "title" or "description" to change. The title is at most 200 characters and the description at most 4,000. Write at most one block. Nothing happens until the person clicks the button under it.',
].join('\n\n');

/** The system message: the instructions, then the title of the task the chat is open on, if any. */
export function conversationInstructions(pageTitle: string | null): string {
  return pageTitle === null
    ? `${INSTRUCTIONS}\n\nThe person has no task open.`
    : `${INSTRUCTIONS}\n\nThe person has this task open: ${JSON.stringify(pageTitle)}.`;
}
