// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 8 (F3, P1 half): a sign-in judges the file under the same
// held lock as its commit, with `signInVerdict`, so two sign-ins with
// different subjects cannot both write.

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { signInVerdict, tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import {
  commitTokenFile,
  readTokenFileLocked,
  type TokenFile,
} from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import {
  HOUR,
  T0,
  fileBytes,
  runChild,
  seed,
  tempDir,
  tokens,
  sleep,
} from './fixtures/plan-token-world.ts';

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  issuer.onRequest(() => {});
  for (const w of worlds.splice(0)) w.done();
});
const world = () => {
  const w = tempDir();
  worlds.push(w);
  return w;
};
const a = tokens('a', T0 + HOUR, 'synthetic-subject-a');

it('every row of the verdict table', () => {
  expect(signInVerdict({ state: 'absent' }, 'synthetic-subject-a')).toBe('write');
  for (const onDisk of [
    { state: 'ready', tokens: a },
    { state: 'pending', tokens: a, since: T0 },
    { state: 'spent', subject: 'synthetic-subject-a' },
  ] as const) {
    expect(signInVerdict(onDisk, 'synthetic-subject-a')).toBe('write');
    expect(signInVerdict(onDisk, 'synthetic-subject-b')).toBe('SIGN_IN_OTHER_ACCOUNT');
  }
  for (const code of [
    'SUBSCRIPTION_TOKEN_FILE_OPEN',
    'SUBSCRIPTION_SIGN_IN_NEEDED',
    'SUBSCRIPTION_STORE_FAILED',
  ] as const) {
    expect(signInVerdict({ state: 'refused', code }, 'synthetic-subject-a')).toBe(
      'SIGN_IN_FILE_NEEDS_OWNER',
    );
  }
});

it('two child sign-ins with different subjects against an absent file: exactly one writes', async () => {
  const { file } = world();
  const records: TokenFile[] = [
    { state: 'ready', tokens: a },
    { state: 'ready', tokens: tokens('b', T0 + HOUR, 'synthetic-subject-b') },
  ];
  const runs = records.map((record) => runChild({ op: 'signin', file, record, holdMs: 150 }));
  const answers = await Promise.all(runs.map((run) => run.next()));
  await Promise.all(runs.map((run) => run.exited()));
  const writers = answers.filter((m) => m['verdict'] === 'write');
  expect(writers).toHaveLength(1);
  expect(writers[0]!['outcome']).toBe('durable');
  expect(answers.filter((m) => m['verdict'] === 'SIGN_IN_OTHER_ACCOUNT')).toHaveLength(1);
  const winner = records[answers.indexOf(writers[0]!)]!;
  expect(winner.state === 'ready' && fileBytes(file).toString('latin1')).toContain(
    winner.state === 'ready' ? winner.tokens.accessToken : '',
  );
}, 20_000);

it('a sign-in waits out a 20 s refresh and then commits', async () => {
  const { file } = world();
  await seed(file, { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) });
  let at = T0;
  let signIn: Promise<unknown> | undefined;
  issuer.set({
    kind: 'json',
    status: 200,
    body: {
      access_token: 'synthetic-access-new',
      refresh_token: 'synthetic-refresh-new',
      expires_in: 3_600,
    },
  });
  issuer.onRequest(async () => {
    at += 20_000;
    signIn = withTokenLock(file, { deadlineAt: Date.now() + 45_000 }, (held) => {
      const verdict = signInVerdict(readTokenFileLocked(held, file), 'synthetic-subject-a');
      return Promise.resolve([
        verdict,
        commitTokenFile(held, file, { state: 'ready', tokens: tokens('signed', T0 + HOUR) }),
      ]);
    });
    await sleep(150);
  });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => at });
  expect(await holder.prepare()).toEqual({ ok: true });
  expect(await signIn).toEqual({ held: true, value: ['write', 'durable'] });
  expect(fileBytes(file).toString('latin1')).toContain('synthetic-access-signed');
});

it('healthy: the same subject replaces pending and spent, and a holder then prepares and presents', async () => {
  for (const before of [
    { state: 'pending', tokens: a, since: T0 },
    { state: 'spent', subject: 'synthetic-subject-a' },
  ] as const) {
    const { file } = world();
    // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
    await seed(file, before);
    // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
    const out = await withTokenLock(file, { deadlineAt: Date.now() + 2_000 }, (held) => {
      const verdict = signInVerdict(readTokenFileLocked(held, file), 'synthetic-subject-a');
      return Promise.resolve([
        verdict,
        commitTokenFile(held, file, { state: 'ready', tokens: tokens('signed', T0 + HOUR) }),
      ]);
    });
    expect(out).toEqual({ held: true, value: ['write', 'durable'] });
    const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
    // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
    expect(await holder.prepare()).toEqual({ ok: true });
    expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-signed' });
  }
});
