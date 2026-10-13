// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable max-lines-per-function -- one custody, a schedule per way a key can be split
//
// Custody presents a key to a destination that declares OpenRouter's stream
// format, and decodes the stream itself: a key the answer echoes, split
// across two or three events' content at any offset, in plain, `\u`-escaped,
// percent-escaped or base64 spelling, across transport chunks and between
// comment lines, or inside an error event, reaches no piece and no folded
// body. The pieces joined are the folded content. A destination that declares
// no stream format gets no pieces, and its answer is redacted whole.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import {
  event,
  sse,
  standInOpenRouter,
  type OpenRouterStandIn,
} from '../api/openrouter-stand-in-fixture.ts';

const KEY = `or-test-${randomUUID()}`;
const MODEL = 'anthropic/claude-haiku-5.5';

/** The key as an answer's text might echo it: plainly, percent-escaped and in base64. */
const SPELLINGS: readonly (readonly [string, string])[] = [
  ['plain', KEY],
  ['percent-escaped', [...KEY].map((c) => `%${(c.codePointAt(0) ?? 0).toString(16)}`).join('')],
  ['base64', Buffer.from(KEY).toString('base64')],
];

const leaks = (text: string): boolean =>
  text.includes(KEY) ||
  SPELLINGS.some(([, spelling]) => text.toLowerCase().includes(spelling.toLowerCase()));

/** A content delta whose JSON escapes every character of its text (`\u0061`): decoded, it is the text. */
const escapedEvent = (text: string): string =>
  `data: {"model":"${MODEL}","choices":[{"index":0,"delta":{"content":"${[...text]
    .map((c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`)
    .join('')}"},"finish_reason":null}]}\n\n`;

describe('a key split across server-sent events', () => {
  let openrouter: OpenRouterStandIn;
  let custody: Custody;
  let folder: string;

  beforeAll(async () => {
    openrouter = await standInOpenRouter();
    folder = mkdtempSync(join(tmpdir(), 'split-key-'));
    const credentialsFile = join(folder, 'credentials.json');
    const entry = (ref: string, destination: string) => ({
      ref,
      kind: 'api_key',
      account: 'agency-astro-openrouter',
      destination,
      header: 'authorization',
      scheme: 'bearer',
      value: KEY,
    });
    writeFileSync(
      credentialsFile,
      JSON.stringify([entry('openrouter', 'openrouter'), entry('plain_key', 'plain')]),
      { mode: 0o600 },
    );
    custody = await startCustody({
      credentialsFile,
      destinations: [
        { key: 'openrouter', origin: openrouter.origin, stream: 'openai_sse' },
        { key: 'plain', origin: openrouter.origin },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await custody?.stop();
    await openrouter?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  async function ask(chunks: readonly string[], ref = 'openrouter', destination = 'openrouter') {
    openrouter.answer = () => ({ status: 200, chunks });
    const pieces: string[] = [];
    const outcome = await custody.dispatch(
      ref,
      {
        destination,
        path: '/api/v1/chat/completions',
        method: 'POST',
        body: '{}',
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1024,
      },
      (text) => pieces.push(text),
    );
    if (outcome.kind !== 'answered' || !outcome.outbound.ok)
      throw new Error(`not answered: ${outcome.kind}`);
    return { pieces, body: outcome.outbound.body };
  }

  it('the key at every split offset over two and three events, in each spelling, never leaves', async () => {
    for (const [name, spelling] of SPELLINGS) {
      for (let cut = 1; cut < spelling.length; cut += 1) {
        const third = Math.min(spelling.length - 1, cut + 3);
        const splits = [
          ['Before ', spelling.slice(0, cut), `${spelling.slice(cut)} after.`],
          [
            'Before ',
            spelling.slice(0, cut),
            spelling.slice(cut, third),
            `${spelling.slice(third)} after.`,
          ],
        ];
        for (const words of splits) {
          // oxlint-disable-next-line no-await-in-loop -- one answer at a time through one custody
          const { pieces, body } = await ask(sse(MODEL, words));
          const folded = JSON.parse(body) as { content: string; error: unknown };
          expect(leaks(pieces.join('')), `${name} at ${String(cut)}`).toBe(false);
          expect(leaks(body), `${name} at ${String(cut)}`).toBe(false);
          expect(pieces.join('')).toBe(folded.content);
          expect(folded.content).toContain('[redacted]');
          expect(folded.error).toBeNull();
        }
      }
    }
  });

  it("escaped in the events' JSON, at every split offset, it never leaves", async () => {
    for (let cut = 1; cut < KEY.length; cut += 1) {
      const [head, ...rest] = sse(MODEL, []);
      const chunks = [
        head ?? '',
        escapedEvent(`Key ${KEY.slice(0, cut)}`),
        escapedEvent(`${KEY.slice(cut)} end`),
        ...rest,
      ];
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time through one custody
      const { pieces, body } = await ask(chunks);
      expect(leaks(pieces.join('')), String(cut)).toBe(false);
      expect(leaks(body), String(cut)).toBe(false);
      expect(JSON.parse(body)).toMatchObject({ content: 'Key [redacted] end' });
    }
  });

  it('split across transport chunks and between comment lines, it never leaves', async () => {
    const whole = sse(MODEL, ['Your key is ', KEY.slice(0, 9), KEY.slice(9), '.']).join(
      ': keep-alive\n\n',
    );
    const chunks: string[] = [];
    for (let at = 0; at < whole.length; at += 7) chunks.push(whole.slice(at, at + 7));
    const { pieces, body } = await ask(chunks);
    expect(leaks(pieces.join(''))).toBe(false);
    expect(leaks(body)).toBe(false);
    expect(JSON.parse(body)).toMatchObject({ content: 'Your key is [redacted].', error: null });
  });

  it("in an error event's message, it never leaves and the body says error", async () => {
    const { pieces, body } = await ask([
      event({ model: MODEL, choices: [{ delta: { content: 'Hi' } }] }),
      event({ error: { code: 502, message: `upstream echoed ${KEY}` } }),
      'data: [DONE]\n\n',
    ]);
    expect(leaks(pieces.join('') + body)).toBe(false);
    expect((JSON.parse(body) as { error: unknown }).error).toMatchObject({ code: 502 });
  });

  it('a payload that is not JSON, or a cut before [DONE], folds to a malformed stream', async () => {
    const broken = await ask(['data: {not json\n\n', 'data: [DONE]\n\n']);
    expect(JSON.parse(broken.body)).toMatchObject({ error: 'stream_malformed' });
    const cut = await ask(sse(MODEL, ['Half']).slice(0, 2));
    expect(JSON.parse(cut.body)).toMatchObject({ error: 'stream_malformed' });
  });

  it('a destination that declares no stream format gets no pieces, and its answer is redacted whole', async () => {
    const { pieces, body } = await ask(sse(MODEL, ['Key: ', KEY]), 'plain_key', 'plain');
    expect(pieces).toStrictEqual([]);
    expect(leaks(body)).toBe(false);
  });
});
