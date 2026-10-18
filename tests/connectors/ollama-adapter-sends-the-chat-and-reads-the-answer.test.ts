// SPDX-License-Identifier: AGPL-3.0-only
//
// The Ollama provider (the chat path's local model on the M5): the adapter
// turns the conversation operation's fields into one `/api/chat` request for
// the model it is handed, the answer reader keeps the model's words and its
// token counts and refuses anything else, and every answer costs nothing.

import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ANSWER,
  catalogue,
  OLLAMA_CONVERSATION,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  ollamaCostMinor,
  readOllamaAnswer,
  TASK_BLOCK_FENCE,
} from '../../packages/core-connectors/src/index.ts';

interface ChatBody {
  readonly model: string;
  readonly stream: boolean;
  readonly think: boolean;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

const bodyOf = (fields: Readonly<Record<string, string>>, model?: string): ChatBody =>
  JSON.parse(ollamaAdapter(fields, 'call-1', model).body) as ChatBody;

const ANSWER = {
  model: 'gemma4:31b-mlx',
  created_at: '2026-10-12T16:00:00Z',
  message: { role: 'assistant', content: 'Two tasks are due today.' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 212,
  eval_count: 9,
};

describe('the Ollama adapter', () => {
  it('posts one non-streamed chat to /api/chat for the model it is handed', () => {
    const built = ollamaAdapter({ message: 'What is due?' }, 'call-1', 'gemma4:31b-mlx');
    expect(built).toMatchObject({ path: '/api/chat', method: 'POST' });
    const body = bodyOf({ message: 'What is due?' }, 'gemma4:31b-mlx');
    expect(body).toMatchObject({ model: 'gemma4:31b-mlx', stream: false, think: false });
    expect(bodyOf({ message: 'What is due?' }).model).toBe(OLLAMA_DEFAULT_MODEL);
  });

  it('sends the instructions first, the earlier turns in order, and the person last', () => {
    const earlier = JSON.stringify([
      { role: 'person', body: 'Hello' },
      { role: 'agent', body: 'Hi, how can I help?' },
    ]);
    const page = JSON.stringify({
      task: 'b1d0f3a2-0000-4000-8000-000000000001',
      title: 'Launch plan',
    });
    const { messages } = bodyOf({ page, earlier, message: 'Add a task for the brief' });
    expect(messages.map((message) => message.role)).toStrictEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages.slice(1).map((message) => message.content)).toStrictEqual([
      'Hello',
      'Hi, how can I help?',
      'Add a task for the brief',
    ]);
    const [system] = messages;
    // The task block the panel draws as a card, and the page's title, never its id.
    expect(system?.content).toContain(TASK_BLOCK_FENCE);
    expect(system?.content).toContain('Launch plan');
    expect(system?.content).not.toContain('b1d0f3a2');
  });

  it('keeps earlier words it cannot read as turns out of the request', () => {
    const { messages } = bodyOf({ earlier: 'not json', message: 'Hi' });
    expect(messages.map((message) => message.role)).toStrictEqual(['system', 'user']);
    expect(JSON.stringify(messages)).not.toContain('not json');
  });
});

describe('the agent’s instructions', () => {
  it('tells the model it only proposes, and never to say it has done anything', () => {
    const [system] = bodyOf({ message: 'Make a task' }).messages;
    expect(system?.content).toContain('you must never say or suggest that you have');
    expect(system?.content).toContain('Nothing happens until the person clicks');
  });

  it('tells the model to chat by default and propose a task only when asked for one', () => {
    const [system] = bodyOf({ message: 'How is the week looking?' }).messages;
    expect(system?.content).toContain(
      'Most messages are conversation: answer them in words, with no task block.',
    );
    expect(system?.content).toContain(
      'Only when the person plainly asks you to create a task, or to change the task they have open,',
    );
  });

  it('tells the model today’s date, so a due date lands in the right year', () => {
    const [system] = bodyOf({ message: 'Make a task' }).messages;
    expect(system?.content).toContain(`Today is ${new Date().toLocaleDateString('en-CA')}.`);
  });

  it('names the optional due date and estimate keys the card reads', () => {
    const [system] = bodyOf({ message: 'Make a task' }).messages;
    expect(system?.content).toContain('"due", the date it is due as YYYY-MM-DD');
    expect(system?.content).toContain('"estimate", the work it needs in whole minutes');
  });
});

describe('the Ollama answer reader', () => {
  it('reads the words, the model and the token counts', () => {
    expect(readOllamaAnswer(ANSWER)).toStrictEqual({
      text: 'Two tasks are due today.',
      model: 'gemma4:31b-mlx',
      usage: { inputUnits: 212, outputUnits: 9 },
      providerCode: null,
    });
  });

  it('drops a thinking block the model wrote before its answer', () => {
    const thought = {
      ...ANSWER,
      message: { role: 'assistant', content: '<think>hmm</think>\n\nDone.' },
    };
    expect(readOllamaAnswer(thought)?.text).toBe('Done.');
  });

  it('refuses an answer that is not a finished chat message', () => {
    const malformed: readonly unknown[] = [
      null,
      'Two tasks',
      [],
      { ...ANSWER, message: undefined },
      { ...ANSWER, message: { role: 'assistant', content: 7 } },
      { ...ANSWER, message: { role: 'assistant', content: '   ' } },
      { ...ANSWER, message: { role: 'assistant', content: '<think>only thinking</think>' } },
      { ...ANSWER, done: false },
      { ...ANSWER, prompt_eval_count: -1 },
      { ...ANSWER, eval_count: 1.5 },
      { ...ANSWER, model: 'a model with spaces' },
    ];
    for (const body of malformed)
      expect(readOllamaAnswer(body), JSON.stringify(body)).toBeUndefined();
  });

  it('prices every answer at nothing', () => {
    const read = readOllamaAnswer(ANSWER);
    if (read === undefined) throw new Error('unread');
    expect(ollamaCostMinor(read)).toBe(0);
  });
});

describe('the Ollama conversation operation', () => {
  it('is the conversation operation, on the Ollama provider, and registers', () => {
    expect(OLLAMA_CONVERSATION).toMatchObject({
      key: CONVERSATION_ANSWER.key,
      provider: OLLAMA_PROVIDER,
      destination: 'ollama',
      fields: CONVERSATION_ANSWER.fields,
      billed: false,
      concurrency: 1,
    });
    expect(catalogue([OLLAMA_CONVERSATION]).get(CONVERSATION_ANSWER.key)?.provider).toBe(
      OLLAMA_PROVIDER,
    );
  });
});
