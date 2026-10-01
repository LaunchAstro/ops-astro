// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-3e carried-archive suites' shared parts (carried-archive.test.ts,
// carried-receipt.test.ts): the modules, a key pair, a made-up dump holding a
// canary, an admitted gate over a record folder of its own, a Docker that
// refuses every call, and one carried archive in a folder of its own.

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';

export type Archive = { takenAt: string; sha256: string; body: Buffer };
export type Receipt = Record<string, unknown>;
type Act = (options: Record<string, unknown>) => Promise<Receipt>;
type DrillModule = {
  restoreDrill: Act;
  drillAsOperator: Act;
  exportArchive: Act;
  recordCarried: Act;
  RECEIPT_FIELDS: readonly string[];
};
export type Held = { archiveId: string; takenAt: string; sha256: string; bytes: number };
type CarriedModule = {
  readCarried: (file: string, into?: string) => Held;
  writeCarried: (file: string, fetchInto: (into: string) => Promise<Held>) => Promise<Held>;
  readCarriedReceipt: (file: string, operator: { personId: string; business: string }) => Receipt;
  digestOf: (body: Buffer) => string;
};

const load = async <T>(path: string): Promise<T> =>
  (await import(
    /* @vite-ignore */
    path
  )) as T;
export const drillModule = async (): Promise<DrillModule> =>
  await load<DrillModule>('../../scripts/ops/restore-drill.mjs');
export const carried = async (): Promise<CarriedModule> =>
  await load<CarriedModule>('../../scripts/ops/carried-archive.mjs');
const seal = async (): Promise<{ sealArchive: (dump: Buffer, publicKey: string) => Buffer }> =>
  await load('../../scripts/ops/archive-seal.mjs');

export const pair = (): { publicKey: string; privateKey: string } =>
  generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
export const keys: { publicKey: string; privateKey: string } = pair();
export const CANARY: string = `canary-${randomBytes(8).toString('hex')}`;
const DUMP = Buffer.from(`-- a made-up dump\ninsert into tasks values ('${CANARY}');\n`);
export const TAKEN = '2026-09-29T02:00:00.000Z';
/** The store's id of the archive the fixture's store hands out. */
export const ARCHIVE_ID: string = randomUUID();
export const scope: { business: string; client: string; person: string } = {
  business: randomUUID(),
  client: randomUUID(),
  person: randomUUID(),
};
/** A refusal message that names no scratch folder or canary. */
export const NAMES_NOTHING: RegExp = /^(?!.*(?:s0-3e-|canary-)).*$/u;

// Made by the file's first hook, so a file whose tests all skip leaves no folder (temp guard).
export const scratch: string = join(tmpdir(), `s0-3e-${randomBytes(6).toString('hex')}`);
beforeAll(() => mkdirSync(scratch, { mode: 0o700 }));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A folder of its own under the suite's scratch folder. */
export const folder = (name: string): string => mkdtempSync(join(scratch, `${name}-`));

/** A gate that admitted `personId`, keeping its record in a folder of its own. */
export const gateOf = (personId: string = randomUUID()): Receipt & { records: string } => ({
  ok: true,
  operator: { personId, business: 'made-up' },
  records: folder('records'),
  recordSignIn: () => Promise.resolve(),
  recordTestedRestore: () => Promise.resolve(new Date().toISOString()),
});

/** A store route that must never be taken. */
export const noStore = (): Promise<string> =>
  Promise.reject(new Error('the carried drill reached for the store'));

/** Docker that refuses every call, and remembers each one. */
export const refusing = (): {
  calls: string[][];
  docker: (args: string[]) => Promise<{ code: number; stdout: string }>;
} => {
  const calls: string[][] = [];
  const docker = (args: string[]): Promise<{ code: number; stdout: string }> => {
    calls.push(args);
    return Promise.resolve({ code: 1, stdout: '' });
  };
  return { calls, docker };
};

export const sealed = async (publicKey: string = keys.publicKey): Promise<Archive> => {
  const body = (await seal()).sealArchive(DUMP, publicKey);
  return { takenAt: TAKEN, sha256: (await carried()).digestOf(body), body };
};

/** A fetch that writes `archive`'s sealed bytes into the file it is handed, as the store's does. */
export const fetchOf =
  (archive: Archive) =>
  (into: string): Promise<Held> => {
    writeFileSync(into, archive.body, { mode: 0o600, flag: 'wx' });
    return Promise.resolve({
      archiveId: ARCHIVE_ID,
      takenAt: archive.takenAt,
      sha256: archive.sha256,
      bytes: archive.body.length,
    });
  };

/** A folder of its own holding one carried archive: `archive.sealed` and its facts. */
export const carriedFile = async (archive?: Archive): Promise<{ dir: string; file: string }> => {
  const dir = folder('carry');
  const file = join(dir, 'archive.sealed');
  await (await carried()).writeCarried(file, fetchOf(archive ?? (await sealed())));
  return { dir, file };
};

/** Every byte under `dir`, as text. */
export const everything = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'))
    .join('\n');
