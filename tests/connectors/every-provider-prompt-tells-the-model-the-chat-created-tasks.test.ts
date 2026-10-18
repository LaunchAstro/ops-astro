// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666: in a chat opened on no task that has created tasks, the `page` field
// says so (`{"created":true}`), and every provider whose adapter writes the
// whole chat (Ollama, OpenRouter) tells the model an edit changes a task this
// chat created, which the person picks on the card. The model is never told
// which, nor any task's id or title. A chat on a task keeps its open-task
// words; a chat on neither is offered a create only.

import { describe, expect, it } from 'vitest';
import {
  conversationInstructions,
  ollamaAdapter,
  openrouterRequest,
  promptPage,
} from '../../packages/core-connectors/src/index.ts';

const CREATED = JSON.stringify({ created: true });
const TASK_ID = '5c0ffee0-0000-4000-8000-000000000001';

/** The system message each provider sends for these fields. */
function systems(fields: Readonly<Record<string, string>>): readonly string[] {
  return [ollamaAdapter(fields).body, openrouterRequest(fields).body].map((body) => {
    const { messages } = JSON.parse(body) as { messages: { role: string; content: string }[] };
    return messages.find((message) => message.role === 'system')?.content ?? '';
  });
}

describe('every provider’s prompt for a chat that created tasks', () => {
  it('both providers tell the model the chat created tasks the person picks on the card, and never says a task is open', () => {
    for (const system of systems({ page: CREATED, message: 'Make that Friday' })) {
      expect(system).toContain('This chat has created tasks the person can change from here.');
      expect(system).toContain('"edit" to change a task this chat created');
      expect(system).toContain(
        'The person chooses which task on the card, so never name or guess the task',
      );
      expect(system).not.toContain('has open');
    }
  });

  it('a chat on a task keeps its open-task words, word for word, in both providers', () => {
    const page = JSON.stringify({ task: TASK_ID, title: 'Spring brief' });
    for (const system of systems({ page, message: 'Rename it' })) {
      expect(system).toBe(conversationInstructions({ kind: 'task', title: 'Spring brief' }));
      expect(system).toContain('or to change the task they have open');
      expect(system).toContain('The person has this task open: "Spring brief".');
      expect(system).not.toContain(TASK_ID);
      expect(system).not.toContain('created');
    }
  });

  it('a chat on no task that created none is offered a create only', () => {
    for (const system of systems({ message: 'Anything due?' })) {
      expect(system).toContain('The person has no task open.');
      expect(system).not.toContain('"edit"');
      expect(system).not.toContain('created');
    }
  });

  it('the page field reads a title, a created flag or nothing, and anything else as nothing', () => {
    expect(promptPage(CREATED)).toStrictEqual({ kind: 'created' });
    expect(promptPage(JSON.stringify({ task: TASK_ID, title: 'A' }))).toStrictEqual({
      kind: 'task',
      title: 'A',
    });
    for (const odd of [undefined, '', '{', '{"created":"yes"}', '{"created":1}', '[]', 'null']) {
      expect(promptPage(odd)).toStrictEqual({ kind: 'none' });
    }
  });
});
