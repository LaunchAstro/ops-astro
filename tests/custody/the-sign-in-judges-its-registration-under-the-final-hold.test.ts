// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P2: custody's two sign-in holds. The start hold refuses a token or
// host file the owner must look at and makes the host id once; the final
// hold judges the account and the registration again, from its own locked
// reads, and writes the registration and the token record in that hold.

import { chmodSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { beginSignIn, storeSignIn } from '../../packages/core-custody/src/plan-sign-in.ts';
import {
  HOUR,
  T0,
  committedHex,
  fileBytes,
  seed,
  tempDir,
  tokens,
} from './fixtures/plan-token-world.ts';
import {
  HOST_ID,
  ISSUED,
  hostFile,
  hostRecord,
  seedHost,
  signInTokens,
  storeInChild,
} from './fixtures/sign-in-world.ts';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});
const world = () => {
  const made = tempDir();
  cleanup = made.done;
  return made;
};
const FIRST = { hostId: HOST_ID, clientId: undefined };
const LATER = { hostId: HOST_ID, clientId: ISSUED };

// oxlint-disable-next-line max-lines-per-function -- every row of the start hold
describe('the start hold', () => {
  it('makes the host id once, host-only, and reads it back after', async () => {
    const { file } = world();
    const first = await beginSignIn({ file });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/u);
    expect(first.clientId).toBeUndefined();
    expect(hostRecord(file)).toEqual({ extAgentHostId: first.hostId });
    expect(await beginSignIn({ file })).toEqual({
      ok: true,
      hostId: first.hostId,
      clientId: undefined,
    });
  });

  it('reads a registered host id and its client id for a later sign-in', async () => {
    const { file } = world();
    await seedHost(file, { extAgentHostId: HOST_ID, clientId: ISSUED });
    expect(await beginSignIn({ file })).toEqual({ ok: true, ...LATER });
  });

  it('refuses a token file the owner must look at before anything opens', async () => {
    const { file } = world();
    await seed(file, { state: 'ready', tokens: tokens('old', T0 + HOUR) });
    chmodSync(file, 0o644);
    expect(await beginSignIn({ file })).toEqual({ ok: false, code: 'SIGN_IN_FILE_NEEDS_OWNER' });
    expect(hostRecord(file)).toBeUndefined();
  });

  it.each([
    ['an extra key', { extAgentHostId: HOST_ID, clientId: ISSUED, more: 1 }],
    ['a malformed host id', { extAgentHostId: 'host-1' }],
    [
      'the registration entrypoint as client id',
      { extAgentHostId: HOST_ID, clientId: 'dynamic_agent_client' },
    ],
    ['a null client id', { extAgentHostId: HOST_ID, clientId: null }],
  ])('refuses a host file with %s', async (_, record) => {
    const { file } = world();
    await seedHost(file, record);
    expect(await beginSignIn({ file })).toEqual({
      ok: false,
      code: 'SIGN_IN_HOST_FILE_NEEDS_OWNER',
    });
  });

  it('refuses a host file others can read, and one that is not JSON', async () => {
    const { file } = world();
    await seedHost(file, { extAgentHostId: HOST_ID });
    chmodSync(hostFile(file), 0o644);
    expect(await beginSignIn({ file })).toEqual({
      ok: false,
      code: 'SIGN_IN_HOST_FILE_NEEDS_OWNER',
    });
    chmodSync(hostFile(file), 0o600);
    writeFileSync(hostFile(file), '{"extAgentHostId":');
    expect(await beginSignIn({ file })).toEqual({
      ok: false,
      code: 'SIGN_IN_HOST_FILE_NEEDS_OWNER',
    });
  });
});

// oxlint-disable-next-line max-lines-per-function -- every row of the final hold and its races
describe('the final hold', () => {
  it('a first sign-in on a host-only file registers its client id and writes its pair', async () => {
    const { file } = world();
    await seedHost(file, { extAgentHostId: HOST_ID });
    expect(await storeSignIn({ file }, FIRST, signInTokens('new', T0 + HOUR))).toEqual({
      ok: true,
    });
    expect(hostRecord(file)).toEqual({ extAgentHostId: HOST_ID, clientId: ISSUED });
    expect(JSON.parse(fileBytes(file).toString())).toMatchObject({
      state: 'ready',
      tokens: { clientId: ISSUED },
    });
    expect(committedHex(file)).toBeDefined();
  });

  it('a later sign-in with the registered client id replaces pending and spent of its account', async () => {
    const { file } = world();
    await seedHost(file, { extAgentHostId: HOST_ID, clientId: ISSUED });
    await seed(file, { state: 'spent', subject: 'synthetic-subject-a' });
    expect(await storeSignIn({ file }, LATER, signInTokens('new', T0 + HOUR))).toEqual({
      ok: true,
    });
    await seed(file, { state: 'pending', tokens: signInTokens('new', T0 + HOUR), since: T0 });
    expect(await storeSignIn({ file }, LATER, signInTokens('newer', T0 + HOUR))).toEqual({
      ok: true,
    });
    expect(fileBytes(file).toString()).toContain('synthetic-refresh-newer');
  });

  it.each([
    ['the host file is gone', undefined, FIRST],
    [
      'another host id is recorded',
      { extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000002' },
      FIRST,
    ],
    [
      'another registration finished first',
      { extAgentHostId: HOST_ID, clientId: 'oaiapp_synthetic-other' },
      FIRST,
    ],
    ['a later sign-in finds the registration reset', { extAgentHostId: HOST_ID }, LATER],
  ])('refuses SIGN_IN_REGISTRATION_CHANGED when %s, writing nothing', async (_, host, ask) => {
    const { file } = world();
    if (host !== undefined) await seedHost(file, host);
    await seed(file, { state: 'ready', tokens: signInTokens('old', T0 + HOUR) });
    const before = fileBytes(file);
    const digest = committedHex(file);
    expect(await storeSignIn({ file }, ask, signInTokens('new', T0 + HOUR))).toEqual({
      ok: false,
      code: 'SIGN_IN_REGISTRATION_CHANGED',
    });
    expect(fileBytes(file).equals(before)).toBe(true);
    expect(committedHex(file)).toBe(digest);
    expect(hostRecord(file)).toEqual(host);
  });

  it('refuses another account SIGN_IN_ACCOUNT_CHANGED before the registration, writing nothing', async () => {
    const { file } = world();
    await seedHost(file, { extAgentHostId: HOST_ID });
    await seed(file, { state: 'spent', subject: 'synthetic-subject-a' });
    const before = fileBytes(file);
    expect(
      await storeSignIn({ file }, FIRST, signInTokens('new', T0 + HOUR, 'synthetic-subject-b')),
    ).toEqual({ ok: false, code: 'SIGN_IN_ACCOUNT_CHANGED' });
    expect(fileBytes(file).equals(before)).toBe(true);
    expect(hostRecord(file)).toEqual({ extAgentHostId: HOST_ID });
  });

  it('refuses a token file the owner must look at, and tokens custody cannot read back', async () => {
    const { file } = world();
    await seedHost(file, { extAgentHostId: HOST_ID });
    writeFileSync(file, '{"state":"ready"}', { mode: 0o600 });
    expect(await storeSignIn({ file }, FIRST, signInTokens('new', T0 + HOUR))).toEqual({
      ok: false,
      code: 'SIGN_IN_FILE_NEEDS_OWNER',
    });
    const quoted = { ...signInTokens('new', T0 + HOUR), refreshToken: 'synthetic-"refresh"' };
    expect(await storeSignIn({ file }, FIRST, quoted)).toEqual({
      ok: false,
      code: 'SIGN_IN_TOKENS_UNUSABLE',
    });
    const entry = { ...signInTokens('new', T0 + HOUR), clientId: 'dynamic_agent_client' };
    expect(await storeSignIn({ file }, FIRST, entry)).toEqual({
      ok: false,
      code: 'SIGN_IN_TOKENS_UNUSABLE',
    });
    expect(hostRecord(file)).toEqual({ extAgentHostId: HOST_ID });
  });

  it('two first sign-ins racing in separate processes register once, and the pair matches it', async () => {
    const { file } = world();
    await seedHost(file, { extAgentHostId: HOST_ID });
    const a = { ...signInTokens('a', T0 + HOUR), clientId: 'oaiapp_synthetic-a' };
    const b = { ...signInTokens('b', T0 + HOUR), clientId: 'oaiapp_synthetic-b' };
    const answers = await Promise.all([storeInChild(file, FIRST, a), storeInChild(file, FIRST, b)]);
    expect(answers.map((x) => x.answer).toSorted()).toEqual(['SIGN_IN_REGISTRATION_CHANGED', 'ok']);
    expect(answers.map((x) => x.output)).toEqual(['', '']);
    const winner = answers[0]?.answer === 'ok' ? a : b;
    expect(hostRecord(file)).toEqual({ extAgentHostId: HOST_ID, clientId: winner.clientId });
    expect(JSON.parse(fileBytes(file).toString())).toMatchObject({
      state: 'ready',
      tokens: { clientId: winner.clientId, refreshToken: winner.refreshToken },
    });
  });

  it('two later sign-ins for different accounts in separate processes: exactly one writes', async () => {
    const { file } = world();
    await seedHost(file, { extAgentHostId: HOST_ID, clientId: ISSUED });
    const a = signInTokens('a', T0 + HOUR, 'synthetic-subject-a');
    const b = signInTokens('b', T0 + HOUR, 'synthetic-subject-b');
    const answers = await Promise.all([storeInChild(file, LATER, a), storeInChild(file, LATER, b)]);
    expect(answers.map((x) => x.answer).toSorted()).toEqual(['SIGN_IN_ACCOUNT_CHANGED', 'ok']);
    const winner = answers[0]?.answer === 'ok' ? a : b;
    expect(fileBytes(file).toString()).toContain(winner.refreshToken);
  });
});
