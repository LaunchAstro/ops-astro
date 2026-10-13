// SPDX-License-Identifier: AGPL-3.0-only
//
// One custody process answering two streamed requests at the same moment:
// each request's pieces reach only its own caller, and join to its own body.
// A `none` entry in any odd shape (a null header or value, the scheme in
// another case, a replay kind, no account) is no credential; one with an
// unknown extra key is stored with nothing to present, and presents nothing.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseCredentials,
  startCustody,
  type Custody,
  type CustodyOutcome,
  type OutboundRequest,
} from '../../packages/core-custody/src/index.ts';
import { standInOllama, streamedLines, type StandIn } from '../api/ollama-stand-in-fixture.ts';

const MODEL = 'qwen3.6:27b-mlx';
const ALPHA = ['Alpha ', 'has ', 'two ', 'tasks ', 'due.'];
const BETA = ['Beta ', 'owes ', 'three ', 'invoices ', 'now.'];

const NONE = {
  ref: 'ollama_none',
  kind: 'api_key',
  account: 'm5-ollama',
  destination: 'ollama',
  scheme: 'none',
};

const request = (): OutboundRequest => ({
  destination: 'ollama',
  path: '/api/chat',
  method: 'POST',
  body: JSON.stringify({ model: MODEL, messages: [], stream: true, think: false }),
  timeoutMs: 20_000,
  maxResponseBytes: 64 * 1024,
});

// oxlint-disable-next-line max-lines-per-function -- one custody over one stand-in
const bodyOf = (outcome: CustodyOutcome): string =>
  outcome.kind === 'answered' && outcome.outbound.ok ? outcome.outbound.body : '';

// oxlint-disable-next-line max-lines-per-function -- one custody over one stand-in
describe('custody pieces stay with their own request', () => {
  let ollama: StandIn;
  let custody: Custody;
  let folder: string;

  beforeAll(async () => {
    ollama = await standInOllama();
    folder = mkdtempSync(join(tmpdir(), 'custody-own-pieces-'));
    const credentialsFile = join(folder, 'credentials.json');
    writeFileSync(
      credentialsFile,
      JSON.stringify([NONE, { ...NONE, ref: 'ollama_extra', token: 'canary-extra-91b2' }]),
      { mode: 0o600 },
    );
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

  it('two dispatches at once: each caller gets only its own pieces', async () => {
    let next = 0;
    const answers = [streamedLines(MODEL, ALPHA), streamedLines(MODEL, BETA)];
    ollama.reply = () => {
      const chunks = answers[next] ?? [];
      next += 1;
      return { status: 200, chunks, holdAfter: 2 };
    };
    const before = ollama.seen.length;
    const one: string[] = [];
    const two: string[] = [];
    const first = custody.dispatch('ollama_none', request(), (text) => one.push(text));
    await ollama.arrived(before + 1);
    const second = custody.dispatch('ollama_none', request(), (text) => two.push(text));
    await ollama.arrived(before + 2);
    ollama.resume();
    const [a, b] = await Promise.all([first, second]);
    expect(one.join('')).toBe(answers[0]?.join(''));
    expect(two.join('')).toBe(answers[1]?.join(''));
    expect(bodyOf(a)).toBe(one.join(''));
    expect(bodyOf(b)).toBe(two.join(''));
    expect(one.join('')).not.toContain('Beta');
    expect(two.join('')).not.toContain('Alpha');
  });

  it('an extra key on a none entry is never presented', async () => {
    ollama.reply = () => ({ status: 200, chunks: streamedLines(MODEL, ['Hi.']) });
    await custody.dispatch('ollama_extra', request());
    const seen = ollama.seen.at(-1);
    expect(seen?.authorization).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain('canary-extra-91b2');
  });
});

describe('a none entry in an odd shape', () => {
  it.each([
    ['a null header', { ...NONE, header: null }],
    ['a null value', { ...NONE, value: null }],
    ['the scheme in capitals', { ...NONE, scheme: 'NONE' }],
    ['the scheme capitalised', { ...NONE, scheme: 'None' }],
    ['a replay kind', { ...NONE, kind: 'replay', account: null }],
    ['no account', { ...NONE, account: null }],
    ['an empty account', { ...NONE, account: '' }],
    ['an x-api-key header', { ...NONE, header: 'x-api-key' }],
  ])('is refused with %s', (_name, entry) => {
    expect(parseCredentials([entry])).toStrictEqual({
      ok: false,
      code: 'CREDENTIAL_MALFORMED',
      at: 0,
    });
  });

  it('a subscription kind is not storable at all', () => {
    expect(parseCredentials([{ ...NONE, kind: 'subscription' }])).toStrictEqual({
      ok: false,
      code: 'CREDENTIAL_NOT_STORABLE',
      at: 0,
    });
  });

  it('a duplicate ref after a none entry is refused', () => {
    expect(parseCredentials([NONE, NONE])).toStrictEqual({
      ok: false,
      code: 'CREDENTIAL_MALFORMED',
      at: 1,
    });
  });

  it('an unknown extra key is stored with nothing to present', () => {
    const parsed = parseCredentials([{ ...NONE, token: 'canary-extra-91b2' }]);
    expect(parsed.ok).toBe(true);
    const stored = parsed.ok ? parsed.credentials.get('ollama_none') : undefined;
    expect(stored).toMatchObject({ scheme: 'none', value: '' });
    expect(JSON.stringify(stored)).not.toContain('canary-extra-91b2');
  });
});
