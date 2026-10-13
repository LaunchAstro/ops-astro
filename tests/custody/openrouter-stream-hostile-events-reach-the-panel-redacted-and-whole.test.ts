// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable max-lines-per-function, max-lines -- one custody, a case per hostile stream
//
// OpenRouter's stream as a hostile upstream might write it, decoded by custody
// for a destination that declares `openai_sse`: the key custody presented, in
// every spelling it knows, in the model, finish, usage and error fields (as a
// value and as a field name), after `[DONE]`, at the end of one huge event and
// past the byte limit, and in a 4xx or 5xx body, reaches no piece, no folded
// body and nothing custody writes. The stream cut into transport chunks at
// every byte, with LF or CRLF separators and a payload over several `data:`
// lines, folds to the same content. Every piece is whole text: what the panel
// writes of the pieces, as UTF-8, is the reply kept.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import { openaiSse } from '../../packages/core-custody/src/stream-decode.ts';
import type { StoredCredential } from '../../packages/core-custody/src/credentials.ts';
import {
  event,
  standInOpenRouter,
  type Answer,
  type OpenRouterStandIn,
} from '../api/openrouter-stand-in-fixture.ts';

const KEY = `or-test-${randomUUID()}`;
const MODEL = 'anthropic/claude-haiku-5.5';
const LIMIT = 512 * 1024;

const CREDENTIAL: StoredCredential = {
  ref: 'openrouter',
  kind: 'api_key',
  account: 'agency-astro-openrouter',
  destination: 'openrouter',
  header: 'authorization',
  scheme: 'bearer',
  value: KEY,
};

/** The key's base64 or base64url, the characters only its own bytes decide, at byte offset `at`. */
const stableBase64 = (at: number, url: boolean): string =>
  Buffer.concat([Buffer.alloc(at), Buffer.from(KEY)])
    .toString(url ? 'base64url' : 'base64')
    .slice(Math.ceil((8 * at) / 6), Math.floor((8 * (at + KEY.length)) / 6));

const percent = (upper: boolean): string =>
  [...KEY]
    .map((c) => `%${(c.codePointAt(0) ?? 0).toString(16)}`)
    .map((s) => (upper ? s.toUpperCase() : s))
    .join('');

/** What a leak looks like: the key itself, percent-escaped, or its base64 at any offset. */
const NEEDLES: readonly string[] = [
  KEY,
  percent(false),
  ...[0, 1, 2].flatMap((at) => [stableBase64(at, false), stableBase64(at, true)]),
];
const leaks = (text: string): boolean =>
  NEEDLES.some((needle) => text.toLowerCase().includes(needle.toLowerCase()));

/** The spellings an upstream might echo: plain, percent in either case, base64 and base64url at each offset. */
const SPELLINGS: readonly (readonly [string, string])[] = [
  ['plain', KEY],
  ['percent', percent(false)],
  ['PERCENT', percent(true)],
  ...[0, 1, 2].flatMap((at): [string, string][] => {
    const padded = Buffer.concat([Buffer.alloc(at, 0x41), Buffer.from(KEY), Buffer.from('zz')]);
    return [
      [`base64 at ${String(at)}`, padded.toString('base64')],
      [`base64url at ${String(at)}`, padded.toString('base64url')],
    ];
  }),
];

const USAGE = { prompt_tokens: 1, completion_tokens: 1, cost: 0.000_3 };
const finish = (usage: unknown = USAGE) =>
  event({ model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
const word = (content: string) =>
  event({ model: MODEL, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const DONE = 'data: [DONE]\n\n';

/** The text a browser reads of the pieces the API writes as UTF-8. */
const asWritten = (pieces: readonly string[]): string =>
  Buffer.concat(pieces.map((piece) => Buffer.from(piece, 'utf8'))).toString('utf8');

describe('a hostile OpenRouter stream through custody', () => {
  let openrouter: OpenRouterStandIn;
  let custody: Custody;
  let folder: string;

  beforeAll(async () => {
    openrouter = await standInOpenRouter();
    folder = mkdtempSync(join(tmpdir(), 'hostile-sse-'));
    const credentialsFile = join(folder, 'credentials.json');
    writeFileSync(credentialsFile, JSON.stringify([CREDENTIAL]), { mode: 0o600 });
    custody = await startCustody({
      credentialsFile,
      destinations: [{ key: 'openrouter', origin: openrouter.origin, stream: 'openai_sse' }],
    });
  }, 60_000);

  afterAll(async () => {
    await custody?.stop();
    await openrouter?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  async function ask(answer: Answer) {
    openrouter.answer = () => answer;
    const pieces: string[] = [];
    const outcome = await custody.dispatch(
      'openrouter',
      {
        destination: 'openrouter',
        path: '/api/v1/chat/completions',
        method: 'POST',
        body: '{}',
        timeoutMs: 20_000,
        maxResponseBytes: LIMIT,
      },
      (text) => pieces.push(text),
    );
    return { pieces, outcome };
  }

  async function folded(chunks: readonly string[]) {
    const { pieces, outcome } = await ask({ status: 200, chunks });
    if (outcome.kind !== 'answered' || !outcome.outbound.ok) {
      throw new Error(`not answered: ${JSON.stringify(outcome)}`);
    }
    return { pieces, body: outcome.outbound.body };
  }

  it('the key in the model, finish, usage or error fields, as a value or a name, in every spelling, never leaves', async () => {
    for (const [name, spelling] of SPELLINGS) {
      const streams: readonly (readonly [string, readonly string[]])[] = [
        [
          'model',
          [
            event({ model: `x ${spelling}`, choices: [{ delta: { content: 'hi' } }] }),
            finish(),
            DONE,
          ],
        ],
        [
          'model name',
          [
            event({ model: { [spelling]: spelling }, choices: [{ delta: { content: 'hi' } }] }),
            finish(),
            DONE,
          ],
        ],
        [
          'finish',
          [
            event({
              model: MODEL,
              choices: [{ delta: { content: 'hi' }, finish_reason: spelling }],
            }),
            finish(),
            DONE,
          ],
        ],
        [
          'usage',
          [
            word('hi'),
            finish({
              prompt_tokens: spelling,
              completion_tokens: { [spelling]: 1 },
              cost: spelling,
            }),
            DONE,
          ],
        ],
        [
          'error',
          [
            word('hi'),
            event({ error: { [spelling]: spelling, message: `upstream ${spelling}` } }),
            DONE,
          ],
        ],
        [
          'after [DONE]',
          [
            word('hi'),
            finish(),
            DONE,
            event({
              model: spelling,
              choices: [{ delta: { content: spelling } }],
              usage: { cost: spelling },
            }),
          ],
        ],
      ];
      for (const [field, chunks] of streams) {
        // oxlint-disable-next-line no-await-in-loop -- one answer at a time through one custody
        const { pieces, body } = await folded(chunks);
        expect(leaks(pieces.join('')), `${name} in ${field}`).toBe(false);
        expect(leaks(body), `${name} in ${field}`).toBe(false);
        expect(pieces.join(''), `${name} in ${field}`).toBe(
          (JSON.parse(body) as { content: string }).content,
        );
      }
    }
    expect(leaks(custody.stderr())).toBe(false);
  });

  it('events after [DONE] add no content and no usage', async () => {
    const { pieces, body } = await folded([
      word('Two tasks.'),
      finish(),
      DONE,
      word(' And more.'),
      finish({ prompt_tokens: 1, completion_tokens: 1, cost: 0 }),
    ]);
    expect(pieces.join('')).toBe('Two tasks.');
    expect(JSON.parse(body)).toMatchObject({
      content: 'Two tasks.',
      usage: { cost: 0.000_3 },
      error: null,
    });
  });

  it('cut into transport chunks at every byte, LF or CRLF, one or several data lines, the fold is the same and the key never leaves', () => {
    const words = ['Héllo — ', 'naïve 😀 ', KEY.slice(0, 10), KEY.slice(10), ' ✓ 中文 end'];
    const content = `Héllo — naïve 😀 [redacted] ✓ 中文 end`;
    const payloads = [
      ...words.map((w) => ({
        model: MODEL,
        choices: [{ index: 0, delta: { content: w }, finish_reason: null }],
      })),
      {
        model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 5, cost: 0.000_3 },
      },
    ];
    const layouts: readonly (readonly [string, (p: unknown) => string, string])[] = [
      ['LF', (p) => `data: ${JSON.stringify(p)}\n\n`, '\n'],
      ['CRLF', (p) => `data: ${JSON.stringify(p)}\r\n\r\n`, '\r\n'],
      [
        'data lines',
        (p) =>
          `${JSON.stringify(p, null, 1)
            .split('\n')
            .map((l) => `data: ${l}`)
            .join('\n')}\n\n`,
        '\n',
      ],
      [
        'CRLF data lines',
        (p) =>
          `${JSON.stringify(p, null, 1)
            .split('\n')
            .map((l) => `data:${l}`)
            .join('\r\n')}\r\n\r\n`,
        '\r\n',
      ],
    ];
    for (const [name, write, eol] of layouts) {
      const whole = Buffer.from(
        `: OPENROUTER PROCESSING${eol}${eol}${payloads.map((payload) => write(payload)).join('')}data: [DONE]${eol}${eol}`,
      );
      for (let at = 1; at < whole.length; at += 1) {
        for (const second of [at, at + 1, at + 3]) {
          const cuts = [0, at, Math.min(second, whole.length), whole.length];
          const decoding = openaiSse(CREDENTIAL);
          const pieces: string[] = [];
          for (let i = 0; i + 1 < cuts.length; i += 1) {
            pieces.push(...decoding.push(whole.subarray(cuts[i], cuts[i + 1])));
          }
          const end = decoding.end();
          pieces.push(...end.pieces);
          const body = JSON.parse(end.body) as Record<string, unknown>;
          const where = `${name} cut at ${String(at)}/${String(second)}`;
          expect(leaks(pieces.join('') + end.body), where).toBe(false);
          expect(body, where).toMatchObject({ content, error: null, usage: { cost: 0.000_3 } });
          expect(pieces.join(''), where).toBe(content);
        }
      }
    }
  });

  it('a huge event under the byte limit with the key at its end never leaves; past the limit, nothing answers and no piece leaks', async () => {
    const filler = 'o'.repeat(500_000);
    const under = await folded([word(`${filler}${KEY}`), finish(), DONE]);
    expect(leaks(under.pieces.join('') + under.body)).toBe(false);
    expect((JSON.parse(under.body) as { content: string }).content.endsWith('[redacted]')).toBe(
      true,
    );
    const over = await ask({
      status: 200,
      chunks: [
        ...Array.from({ length: 60 }, (_, at) =>
          word(
            at % 10 === 9
              ? `${'o'.repeat(9_970)}${KEY.slice(0, 20)}`
              : `${KEY.slice(20)}${'o'.repeat(9_970)}`,
          ),
        ),
        finish(),
        DONE,
      ],
    });
    expect(over.pieces.join('').length).toBeGreaterThan(0);
    expect(over.outcome).toMatchObject({
      kind: 'answered',
      outbound: { ok: false, fault: 'too_large' },
    });
    expect(leaks(over.pieces.join(''))).toBe(false);
  });

  it.each([400, 401, 402, 429, 500, 503])(
    'a %d whose body echoes the key: nothing of the body comes back',
    async (status) => {
      const { pieces, outcome } = await ask({
        status,
        body: JSON.stringify({
          error: { code: status, message: `bad key ${KEY}`, metadata: { raw: percent(true) } },
        }),
      });
      expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: false, status } });
      expect(leaks(JSON.stringify(outcome) + pieces.join(''))).toBe(false);
      expect(leaks(custody.stderr())).toBe(false);
    },
  );

  it('every piece is whole text: what the panel writes of the pieces is the reply kept', async () => {
    for (let before = 120; before < 200; before += 1) {
      const first = `${'x'.repeat(before)}😀${'y'.repeat(300 - before)}`;
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time through one custody
      const { pieces, body } = await folded([word(first), word(' end'), finish(), DONE]);
      const content = (JSON.parse(body) as { content: string }).content;
      expect(pieces.join('')).toBe(content);
      expect(asWritten(pieces), `the emoji after ${String(before)} characters`).toBe(content);
    }
  });
});
