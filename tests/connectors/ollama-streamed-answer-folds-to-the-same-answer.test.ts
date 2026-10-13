// SPDX-License-Identifier: AGPL-3.0-only
//
// Ollama streams its chat as NDJSON: one JSON object per line, each with a
// piece of the reply's words, the last one `done` with the counts. The fold
// turns the whole body back into the one answer a non-streamed chat gives, so
// the answer reader reads the same `ModelAnswer` either way, and a line it
// cannot read gives no answer at all. The piece reader turns the same body,
// however its bytes are split, into display texts only: whole lines, the
// reply's words, and a leading thinking block never shown.

import { describe, expect, it } from 'vitest';
import {
  catalogue,
  foldOllamaStream,
  OLLAMA_CONVERSATION,
  ollamaAdapter,
  ollamaPieces,
  readOllamaAnswer,
} from '../../packages/core-connectors/src/index.ts';

const MODEL = 'qwen3.6:27b-mlx';

const line = (content: string): string =>
  `${JSON.stringify({ model: MODEL, message: { role: 'assistant', content }, done: false })}\n`;

const last = (content = ''): string =>
  `${JSON.stringify({
    model: MODEL,
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 212,
    eval_count: 9,
  })}\n`;

const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today', ' ✓.'];
const STREAMED = [...WORDS.map((word) => line(word)), last()].join('');
const WHOLE = {
  model: MODEL,
  message: { role: 'assistant', content: WORDS.join('') },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 212,
  eval_count: 9,
};

const THOUGHT = 'The person wants a list; secret-thinking-7c1 says check the board first.';
const THINKING = [
  line('<th'),
  line('ink>'),
  line(THOUGHT),
  line('</thi'),
  line('nk>\n\n'),
  ...WORDS.map((word) => line(word)),
  last(),
].join('');

const folded = (body: string): unknown => {
  const text = foldOllamaStream(body);
  return text === undefined ? undefined : JSON.parse(text);
};

/** Every display text the reader gives for `body`, fed in the chunks `cut` makes. */
function shown(body: string, cut: (bytes: Uint8Array) => readonly Uint8Array[]): string[] {
  const reader = ollamaPieces();
  return cut(new TextEncoder().encode(body)).flatMap((chunk) => reader.push(chunk));
}

const byByte = (bytes: Uint8Array): Uint8Array[] =>
  Array.from(bytes, (_byte, at) => bytes.slice(at, at + 1));
const whole = (bytes: Uint8Array): Uint8Array[] => [bytes];

describe('the Ollama adapter streams', () => {
  it('asks for a streamed chat with thinking off', () => {
    const body = JSON.parse(ollamaAdapter({ message: 'What is due?' }).body) as unknown;
    expect(body).toMatchObject({ stream: true, think: false });
  });

  it('declares the fold and the piece reader, and the catalogue takes it', () => {
    expect(OLLAMA_CONVERSATION.fold).toBe(foldOllamaStream);
    expect(OLLAMA_CONVERSATION.pieces).toBe(ollamaPieces);
    expect(catalogue([OLLAMA_CONVERSATION]).get(OLLAMA_CONVERSATION.key)?.fold).toBe(
      foldOllamaStream,
    );
  });

  it('refuses a declaration whose fold or piece reader is not a function', () => {
    expect(() => catalogue([{ ...OLLAMA_CONVERSATION, fold: 'yes' as never }])).toThrow(/fold/u);
    expect(() => catalogue([{ ...OLLAMA_CONVERSATION, pieces: {} as never }])).toThrow(/pieces/u);
  });
});

describe('the fold', () => {
  it('reads the same answer from a streamed body as from the whole one', () => {
    const streamed = readOllamaAnswer(folded(STREAMED));
    expect(streamed).toStrictEqual(readOllamaAnswer(WHOLE));
    expect(streamed?.text).toBe('Two tasks are due today ✓.');
    expect(streamed?.usage).toStrictEqual({ inputUnits: 212, outputUnits: 9 });
  });

  it('reads a whole answer given as its one line', () => {
    expect(readOllamaAnswer(folded(JSON.stringify(WHOLE)))).toStrictEqual(readOllamaAnswer(WHOLE));
  });

  it('keeps the thinking out of the settled answer, as the whole one does', () => {
    expect(readOllamaAnswer(folded(THINKING))?.text).toBe('Two tasks are due today ✓.');
  });

  it.each([
    ['a line that is not JSON', `${line('Two ')}{"model":\n${last()}`],
    ['a line that is not an object', `${line('Two ')}[1]\n${last()}`],
    ['a piece whose words are not text', `${line('Two ').replace('"Two "', '7')}${last()}`],
    ['no last line', WORDS.map((word) => line(word)).join('')],
    ['a line after the last', `${last()}${line('more')}`],
    ['nothing', ''],
  ])('gives no answer for %s', (_name, body) => {
    expect(readOllamaAnswer(folded(body))).toBeUndefined();
  });
});

describe('the piece reader', () => {
  it('gives exactly the answer’s words, however the bytes are split', () => {
    const answer = readOllamaAnswer(folded(STREAMED))?.text;
    expect(shown(STREAMED, byByte).join('')).toBe(answer);
    expect(shown(STREAMED, whole).join('')).toBe(answer);
    // Split inside every multi-byte character and line alike: the same words, nothing else.
    expect(shown(STREAMED, byByte)).not.toContain('�');
  });

  it('never shows a leading thinking block, split anywhere, and then shows the answer', () => {
    for (const cut of [byByte, whole]) {
      const texts = shown(THINKING, cut);
      expect(texts.join('')).toBe('Two tasks are due today ✓.');
      expect(texts.join('')).not.toContain('secret-thinking-7c1');
      expect(texts.join('')).not.toContain('<think>');
    }
  });

  it('shows a reply that only mentions thinking later on', () => {
    const body = [line('I would '), line('<think> twice.'), last()].join('');
    expect(shown(body, byByte).join('')).toBe('I would <think> twice.');
  });

  it('shows nothing of a thinking block that never closes', () => {
    const body = [line('<think>'), line(THOUGHT), last()].join('');
    expect(shown(body, byByte).join('')).toBe('');
  });

  it('shows nothing from a line that is not a reply piece', () => {
    const body = `{"error":"canary-ollama-7f3a"}\n${line('Hi')}not json\n${last()}`;
    expect(shown(body, byByte).join('')).toBe('Hi');
  });
});
