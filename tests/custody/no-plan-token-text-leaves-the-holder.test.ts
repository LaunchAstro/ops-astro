// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 9: no planted token text leaves the holder. Every log line is
// a closed `PlanLogKind`, every answer a closed code, and no thrown error, child
// stdout or child stderr holds any 4-character substring of a planted token.

import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { tokenHolder, type PlanLogKind } from '../../packages/core-custody/src/plan-token.ts';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import {
  HOUR,
  T0,
  holderInChild,
  runChild,
  seed,
  tempDir,
  type FaultStep,
} from './fixtures/plan-token-world.ts';

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.done();
});
const world = () => {
  const w = tempDir();
  worlds.push(w);
  return w;
};

const planted = {
  clientId: 'synthetic-client-Qv7Kp2Zx',
  accessToken: 'synthetic-access-Hm4Rt8Lw',
  refreshToken: 'synthetic-refresh-Bn3Yc6Df',
  subject: 'synthetic-subject-Jz5Ug1Es',
};
const rotatedRefresh = 'synthetic-refresh-Wq9Xo2Ka';
const KINDS: readonly PlanLogKind[] = [
  'token refreshed',
  'token rotated only',
  'token refresh not sent',
  'token refresh refused: sign in again',
  'token refresh unresolved: sign in again',
  'token store failed',
  'token store exposed',
  'token store unconfirmed',
  'token store recovered',
];
const CODES = [
  'SUBSCRIPTION_SIGN_IN_NEEDED',
  'SUBSCRIPTION_REFRESH_FAILED',
  'SUBSCRIPTION_STORE_FAILED',
  'SUBSCRIPTION_TOKEN_FILE_OPEN',
];
const fragments = [...Object.values(planted), rotatedRefresh].flatMap((value) => {
  const secret = value.replace(/^synthetic-(client|access|refresh|subject)-/u, '');
  return Array.from({ length: secret.length - 3 }, (_, i) => secret.slice(i, i + 4));
});
// Counts only, so a failure message never repeats a planted fragment.
const clean = (text: string) => {
  expect(fragments.filter((fragment) => text.includes(fragment)).length).toBe(0);
};
const due = () => ({ state: 'ready' as const, tokens: { ...planted, expiresAt: T0 + 4 * 60_000 } });

it('a malformed 200 that quotes the refresh token logs kinds only and leaks nothing', async () => {
  const { file } = world();
  await seed(file, due());
  issuer.set({
    kind: 'raw',
    status: 200,
    bytes: Buffer.from(`{"error": "${planted.refreshToken} ${rotatedRefresh}`),
  });
  const logs: string[] = [];
  const holder = tokenHolder({
    file,
    tokenUrl: issuer.url,
    now: () => T0,
    log: (k) => logs.push(k),
  });
  const out = await holder.prepare();
  expect(out.ok === false && CODES).toContain(out.ok ? '' : out.code);
  for (const line of logs) expect(KINDS).toContain(line);
  clean(JSON.stringify([out, logs, holder.present()]));
});

it('a malformed token file and every injected file fault answer closed codes, with clean child output', async () => {
  const malformed = world();
  writeFileSync(
    malformed.file,
    `{"state":"ready","tokens":{"accessToken":"${planted.accessToken}"`,
    { mode: 0o600 },
  );
  const read = await holderInChild(malformed.file, issuer.url, T0);
  expect(CODES).toContain(read.prepare);
  clean(read.output + JSON.stringify(read));
  const steps: FaultStep[] = [
    'file-fsync',
    'link',
    'rename',
    'dir-fsync',
    'dir-fsync-and-undo',
    'digest-busy',
  ];
  for (const step of steps) {
    for (const on of ['pending', 'ready'] as const) {
      const { file } = world();
      // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
      await seed(file, due());
      issuer.set({
        kind: 'json',
        status: 200,
        body: {
          access_token: 'synthetic-access-Pp0Mm9Nn',
          refresh_token: rotatedRefresh,
          expires_in: 3_600,
        },
      });
      // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
      const child = await holderInChild(file, issuer.url, T0, { step, on });
      expect(CODES).toContain(child.prepare);
      for (const line of child.logs) expect(KINDS).toContain(line);
      clean(child.output + JSON.stringify(child));
    }
  }
}, 60_000);

it('a lock refusal leaks nothing', async () => {
  const { file } = world();
  await seed(file, due());
  const blocker = runChild({
    op: 'hold',
    file,
    id: 'b',
    log: `${file}.holds`,
    ms: -1,
    deadlineMs: 5_000,
  });
  await blocker.next();
  let at = T0;
  const ticking = setInterval(() => (at += 10_000), 20);
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => at });
  const out = await holder.prepare();
  clearInterval(ticking);
  blocker.child.send('release');
  const end = await blocker.exited();
  expect(out.ok).toBe(false);
  clean(JSON.stringify(out) + end.output);
}, 20_000);

it('healthy: secrets() lists exactly the held values', async () => {
  const { file } = world();
  await seed(file, { state: 'ready', tokens: { ...planted, expiresAt: T0 + HOUR } });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
  expect(holder.secrets()).toEqual([]);
  expect(await holder.prepare()).toEqual({ ok: true });
  expect([...holder.secrets()].toSorted()).toEqual(
    [planted.accessToken, planted.refreshToken].toSorted(),
  );
  const out = await withTokenLock(file, { deadlineAt: Date.now() + 1_000 }, () =>
    Promise.resolve('held'),
  );
  expect(out).toEqual({ held: true, value: 'held' });
});
