// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P2: a sign-in whose store fails at any step of the commit answers
// SIGN_IN_STORE_FAILED and leaves no copy of the new tokens in the token
// directory, visible or transient, once its own hold ends. A holder then
// presents only what was committed before.

import * as nodeFs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { signIn } from '../../apps/model-agent/chatgpt-sign-in.ts';
import { storeSignIn } from '../../packages/core-custody/src/plan-sign-in.ts';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import type { TokenFs } from '../../packages/core-custody/src/token-file.ts';
import {
  HOUR,
  T0,
  faultyFs,
  seed,
  tempDir,
  type FaultStep,
} from '../custody/fixtures/plan-token-world.ts';
import {
  HOST_ID,
  ISSUED,
  browser,
  filesHolding,
  hostRecord,
  seedHost,
  signInTokens,
  startSignInIssuer,
} from '../custody/fixtures/sign-in-world.ts';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});
async function world(prior: boolean) {
  const made = tempDir();
  cleanup = made.done;
  await seedHost(made.file, { extAgentHostId: HOST_ID, clientId: ISSUED });
  if (prior) await seed(made.file, { state: 'ready', tokens: signInTokens('old', T0 + HOUR) });
  return made;
}
const LATER = { hostId: HOST_ID, clientId: ISSUED };
const NEW = signInTokens('new', T0 + 2 * HOUR);

async function presented(file: string): Promise<string> {
  const holder = tokenHolder({
    file,
    tokenUrl: new URL('http://127.0.0.1:9/token'),
    now: () => T0,
  });
  const prepared = await holder.prepare();
  if (!prepared.ok) return prepared.code;
  const answer = holder.present();
  return answer.ok ? answer.accessToken : answer.code;
}

// oxlint-disable-next-line max-lines-per-function -- every commit step a store can fail at
describe('a failed sign-in store', () => {
  const steps: [FaultStep, boolean, string][] = [
    ['file-fsync', true, 'synthetic-access-old'],
    ['file-fsync', false, 'SUBSCRIPTION_SIGN_IN_NEEDED'],
    ['link', true, 'synthetic-access-old'],
    ['rename', true, 'synthetic-access-old'],
    ['rename', false, 'SUBSCRIPTION_SIGN_IN_NEEDED'],
    ['dir-fsync', true, 'synthetic-access-old'],
    ['dir-fsync', false, 'SUBSCRIPTION_SIGN_IN_NEEDED'],
    ['dir-fsync-and-undo', true, 'SUBSCRIPTION_SIGN_IN_NEEDED'],
    ['digest-busy', true, 'SUBSCRIPTION_SIGN_IN_NEEDED'],
  ];
  it.each(steps)('at %s (prior pair: %s) leaves no new token copy', async (step, prior, after) => {
    const { file, dir } = await world(prior);
    const answer = await storeSignIn({ file, fs: faultyFs({ step, on: 'ready' }) }, LATER, NEW);
    expect(answer).toEqual({ ok: false, code: 'SIGN_IN_STORE_FAILED' });
    expect(filesHolding(dir, 'synthetic-refresh-new')).toEqual([]);
    expect(filesHolding(dir, 'synthetic-access-new')).toEqual([]);
    expect(nodeFs.readdirSync(dir).filter((n) => /\.(?:next|undo)$/u.test(n))).toEqual([]);
    expect(await presented(file)).toBe(after);
  });

  it('a failed registration write stores no tokens either', async () => {
    const { file, dir } = tempDir();
    cleanup = () => nodeFs.rmSync(dir, { recursive: true, force: true });
    await seedHost(file, { extAgentHostId: HOST_ID });
    const failing: Partial<TokenFs> = {
      renameSync: (from, to) => {
        if (String(to).endsWith('chatgpt-host.json')) throw new Error('injected fault');
        nodeFs.renameSync(from, to);
      },
    };
    const answer = await storeSignIn(
      { file, fs: failing },
      { hostId: HOST_ID, clientId: undefined },
      NEW,
    );
    expect(answer).toEqual({ ok: false, code: 'SIGN_IN_STORE_FAILED' });
    expect(hostRecord(file)).toEqual({ extAgentHostId: HOST_ID });
    expect(filesHolding(dir, 'synthetic-access')).toEqual([]);
  });

  it('through the whole sign-in: SIGN_IN_STORE_FAILED, nothing said but its name, no copy left', async () => {
    const { file, dir } = await world(false);
    const issuer = await startSignInIssuer();
    try {
      const b = browser(issuer, (a) => ({
        code: 'synthetic-code',
        state: a.searchParams.get('state') ?? '',
      }));
      const answer = await signIn({
        issuer: issuer.origin,
        tokenFile: file,
        port: 0,
        timeoutMs: 10_000,
        say: b.say,
        fs: faultyFs({ step: 'dir-fsync-and-undo', on: 'ready' }),
      });
      expect(answer).toEqual({ ok: false, code: 'SIGN_IN_STORE_FAILED' });
      expect(filesHolding(dir, 'synthetic-access')).toEqual([]);
      expect(filesHolding(dir, 'synthetic-refresh')).toEqual([]);
      expect(b.lines.join('\n')).not.toMatch(/synthetic-(?:access|refresh|code)/u);
    } finally {
      await issuer.close();
    }
  });
});
