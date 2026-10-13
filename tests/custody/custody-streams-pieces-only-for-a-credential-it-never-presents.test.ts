// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody passes a provider's answer on as it arrives only where it holds no
// secret the provider could echo: a credential filed as `none`, which it
// presents as nothing. Pieces come while the provider is still writing, and
// they join to the whole answer custody gives at the end. A credential with a
// value is answered whole and redacted, with no pieces, as before. The byte
// limit still cuts the read mid-stream, and no piece passes it. A `none`
// credential that carries a value or a header is no credential.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseCredentials,
  startCustody,
  type Custody,
  type OutboundRequest,
} from '../../packages/core-custody/src/index.ts';
import { standInOllama, streamedLines, type StandIn } from '../api/ollama-stand-in-fixture.ts';

const MODEL = 'qwen3.6:27b-mlx';
const CANARY = 'canary-bearer-5d2e9a17c4';
const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];

const NONE = {
  ref: 'ollama_none',
  kind: 'api_key',
  account: 'm5-ollama',
  destination: 'ollama',
  scheme: 'none',
};
const BEARER = {
  ref: 'ollama_bearer',
  kind: 'api_key',
  account: 'm5-ollama',
  destination: 'ollama',
  header: 'authorization',
  value: CANARY,
};

const request = (maxResponseBytes = 64 * 1024): OutboundRequest => ({
  destination: 'ollama',
  path: '/api/chat',
  method: 'POST',
  body: JSON.stringify({ model: MODEL, messages: [], stream: true, think: false }),
  timeoutMs: 20_000,
  maxResponseBytes,
});

// oxlint-disable-next-line max-lines-per-function -- one custody over one stand-in
describe('custody streams pieces only for a credential it never presents', () => {
  let ollama: StandIn;
  let custody: Custody;
  let folder: string;

  beforeAll(async () => {
    ollama = await standInOllama();
    folder = mkdtempSync(join(tmpdir(), 'custody-pieces-'));
    const credentialsFile = join(folder, 'credentials.json');
    writeFileSync(credentialsFile, JSON.stringify([NONE, BEARER]), { mode: 0o600 });
    custody = await startCustody({
      credentialsFile,
      destinations: [{ key: 'ollama', origin: ollama.origin }],
    });
  }, 60_000);

  afterAll(async () => {
    await custody?.stop();
    await ollama?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('none: no credential header, pieces while the provider still writes, joined to the body', async () => {
    const lines = streamedLines(MODEL, WORDS);
    ollama.reply = () => ({ status: 200, chunks: lines, holdAfter: 3 });
    const pieces: string[] = [];
    const answering = custody.dispatch('ollama_none', request(), (text) => pieces.push(text));
    await ollama.midway();
    // The provider has written three lines and is holding: they are here already.
    for (let tries = 0; tries < 200 && pieces.join('') !== lines.slice(0, 3).join(''); tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the pieces in flight
      await sleep(10);
    }
    expect(pieces.join('')).toBe(lines.slice(0, 3).join(''));
    ollama.resume();
    const outcome = await answering;
    expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: true, status: 200 } });
    const body = outcome.kind === 'answered' && outcome.outbound.ok ? outcome.outbound.body : '';
    expect(body).toBe(lines.join(''));
    expect(pieces.join('')).toBe(body);
    expect(ollama.seen.at(-1)?.authorization).toBeUndefined();
  });

  it('a credential with a value: presented, no pieces, the answer whole and redacted', async () => {
    const lines = streamedLines(MODEL, [`echo ${CANARY} `, ...WORDS]);
    ollama.reply = () => ({ status: 200, chunks: lines });
    const pieces: string[] = [];
    const outcome = await custody.dispatch('ollama_bearer', request(), (text) => pieces.push(text));
    expect(pieces).toStrictEqual([]);
    expect(ollama.seen.at(-1)?.authorization).toBe(`Bearer ${CANARY}`);
    expect(outcome.kind).toBe('answered');
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
    expect(custody.stderr()).not.toContain(CANARY);
  });

  it('the byte limit cuts the read mid-stream, and no piece passes it', async () => {
    const lines = streamedLines(
      MODEL,
      Array.from({ length: 200 }, () => 'word '),
    );
    ollama.reply = () => ({ status: 200, chunks: lines });
    const pieces: string[] = [];
    const limit = 1_000;
    const outcome = await custody.dispatch('ollama_none', request(limit), (text) =>
      pieces.push(text),
    );
    expect(outcome).toMatchObject({
      kind: 'answered',
      outbound: { ok: false, fault: 'too_large' },
    });
    expect(Buffer.byteLength(pieces.join(''))).toBeLessThanOrEqual(limit);
  });

  it('an answer that is not 2xx gives no pieces', async () => {
    ollama.reply = () => ({ status: 500, chunks: ['{"error":"canary-ollama-7f3a"}\n'] });
    const pieces: string[] = [];
    const outcome = await custody.dispatch('ollama_none', request(), (text) => pieces.push(text));
    expect(outcome).toMatchObject({ kind: 'answered', outbound: { ok: false, fault: 'status' } });
    expect(pieces).toStrictEqual([]);
  });
});

describe('a none credential carries nothing', () => {
  it('is stored with no value', () => {
    const parsed = parseCredentials([NONE]);
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.ok && parsed.credentials.get('ollama_none')).toMatchObject({ scheme: 'none' });
  });

  it.each([
    ['a value', { ...NONE, value: 'local-token-1234' }],
    ['a header', { ...NONE, header: 'authorization' }],
    ['an empty value', { ...NONE, value: '' }],
  ])('is refused with %s', (_name, entry) => {
    expect(parseCredentials([entry])).toStrictEqual({
      ok: false,
      code: 'CREDENTIAL_MALFORMED',
      at: 0,
    });
  });
});
