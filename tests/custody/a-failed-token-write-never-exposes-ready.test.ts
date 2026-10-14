// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 2 (F1): a token write that did not finish is never acted on.
// The commit point is the SQLite commit of the record's digest, made only
// after the file is durable, and every reader acts on the visible file only
// when its bytes are the committed record. A fault in the writer's process
// leaves the committed `pending`, so a restart and a second holder process
// refuse and send nothing; only the original holder recommits its unwritten
// pair, and it never resends.

import { readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { tokenHolder, type PlanLogKind } from '../../packages/core-custody/src/plan-token.ts';
import { encodeTokenFile, type TokenFile } from '../../packages/core-custody/src/token-file.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import {
  HOUR,
  T0,
  committedHex,
  faultyFs,
  fileBytes,
  holderInChild,
  runChild,
  seed,
  tempDir,
  tokens,
  waitFor,
  type Fault,
} from './fixtures/plan-token-world.ts';

let issuer: Issuer;
const sent: string[] = [];
beforeAll(async () => {
  issuer = await startIssuer();
  issuer.onRequest((form) => {
    sent.push(form.get('refresh_token') ?? '');
  });
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.done();
});

const due: TokenFile = { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) };
const rotated = {
  access_token: 'synthetic-access-new',
  refresh_token: 'synthetic-refresh-new',
  expires_in: 3_600,
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function start(): Promise<{ file: string; dir: string; before: number }> {
  const w = tempDir();
  worlds.push(w);
  await seed(w.file, due);
  issuer.set({ kind: 'json', status: 200, body: rotated });
  sent.length = 0;
  return { file: w.file, dir: w.dir, before: issuer.count() };
}
const holder = (file: string, fault?: Fault, logs: PlanLogKind[] = []) =>
  tokenHolder({
    file,
    tokenUrl: issuer.url,
    now: () => T0,
    log: (kind) => logs.push(kind),
    ...(fault === undefined ? {} : { fs: faultyFs(fault) }),
  });
async function othersRefuse(file: string): Promise<void> {
  for (const other of [
    await holderInChild(file, issuer.url, T0),
    await holderInChild(file, issuer.url, T0),
  ]) {
    expect(other.prepare).toBe('SUBSCRIPTION_SIGN_IN_NEEDED');
    expect(other.present).toBe('SUBSCRIPTION_REFRESH_FAILED');
    expect(other.output).toBe('');
  }
}

it.each(['dir-fsync', 'file-fsync', 'link', 'rename'] as const)(
  'a %s fault on the ready write leaves the exact pending, and a second holder refuses (1 request)',
  async (step) => {
    const { file, before } = await start();
    const first = holder(file, { step, on: 'ready' });
    expect(await first.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
    const pending = fileBytes(file);
    expect(pending.toString('latin1')).toMatch(/^\{"state":"pending"/u);
    expect(committedHex(file)).toBe(sha(pending));
    await othersRefuse(file);
    expect(issuer.count() - before).toBe(1);
    expect(sent).toEqual(['synthetic-refresh-old']);
  },
  20_000,
);

it('a directory fsync fault on the pending write restores ready and sends nothing', async () => {
  const { file, before } = await start();
  const original = fileBytes(file);
  expect(await holder(file, { step: 'dir-fsync', on: 'pending' }).prepare()).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_STORE_FAILED',
  });
  expect(fileBytes(file).equals(original)).toBe(true);
  expect(issuer.count() - before).toBe(0);
});

it.each(['dir-fsync-and-undo', 'digest-busy'] as const)(
  '%s: the visible rotated ready is refused by a restart and a second holder (1 request)',
  async (step) => {
    const { file, before } = await start();
    const logs: PlanLogKind[] = [];
    expect(await holder(file, { step, on: 'ready' }, logs).prepare()).toEqual({
      ok: false,
      code: 'SUBSCRIPTION_STORE_FAILED',
    });
    expect(logs).toContain(
      step === 'digest-busy' ? 'token store unconfirmed' : 'token store exposed',
    );
    expect(fileBytes(file).toString('latin1')).toMatch(
      /^\{"state":"ready".*synthetic-refresh-new/u,
    );
    await othersRefuse(file);
    expect(issuer.count() - before).toBe(1);
  },
  20_000,
);

it('a writer killed after the rename and before the digest leaves a refusal (1 request)', async () => {
  const { file, dir, before } = await start();
  const marker = `${dir}/renamed.marker`;
  const writer = runChild({
    op: 'prepare',
    file,
    tokenUrl: issuer.url.href,
    at: T0,
    fault: { step: 'pause-after-rename', on: 'ready', marker },
  });
  await waitFor(marker);
  writer.child.kill('SIGKILL');
  expect((await writer.exited()).signal).toBe('SIGKILL');
  expect(fileBytes(file).toString('latin1')).toMatch(/^\{"state":"ready".*synthetic-refresh-new/u);
  await othersRefuse(file);
  expect(issuer.count() - before).toBe(1);
}, 20_000);

it('a hand-edited token file, or one restored from an old copy, is refused', async () => {
  const { file, before } = await start();
  const old = fileBytes(file);
  expect(await holder(file).prepare()).toEqual({ ok: true });
  writeFileSync(file, old, { mode: 0o600 });
  expect((await holderInChild(file, issuer.url, T0)).prepare).toBe('SUBSCRIPTION_SIGN_IN_NEEDED');
  const edited = encodeTokenFile({ state: 'ready', tokens: tokens('edited', T0 + HOUR) });
  writeFileSync(file, edited as Buffer, { mode: 0o600 });
  expect((await holderInChild(file, issuer.url, T0)).prepare).toBe('SUBSCRIPTION_SIGN_IN_NEEDED');
  expect(issuer.count() - before).toBe(1);
}, 20_000);

it('leftover .next and .undo files are gone after the next hold', async () => {
  const { file, dir } = await start();
  writeFileSync(`${file}.0123456789abcdef.next`, 'synthetic-leftover', { mode: 0o600 });
  writeFileSync(`${file}.0123456789abcdef.undo`, 'synthetic-leftover', { mode: 0o600 });
  await holder(file).prepare();
  expect(readdirSync(dir).filter((n) => n.endsWith('.next') || n.endsWith('.undo'))).toEqual([]);
});

it('healthy: a rotation is presented by a second holder with no request of its own', async () => {
  const { file, before } = await start();
  const first = holder(file);
  expect(await first.prepare()).toEqual({ ok: true });
  expect(first.present()).toEqual({ ok: true, accessToken: 'synthetic-access-new' });
  const second = await holderInChild(file, issuer.url, T0);
  expect([second.prepare, second.present]).toEqual(['ok', 'ok:synthetic-access-new']);
  expect(issuer.count() - before).toBe(1);
}, 20_000);

it("healthy: the same holder's unwritten pair is recovered at its next prepare and presented (1 request)", async () => {
  const { file, before } = await start();
  const logs: PlanLogKind[] = [];
  const first = holder(file, { step: 'dir-fsync-and-undo', on: 'ready' }, logs);
  expect(await first.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
  expect(await first.prepare()).toEqual({ ok: true });
  expect(logs).toContain('token store recovered');
  expect(first.present()).toEqual({ ok: true, accessToken: 'synthetic-access-new' });
  expect((await holderInChild(file, issuer.url, T0)).present).toBe('ok:synthetic-access-new');
  expect(issuer.count() - before).toBe(1);
}, 20_000);
