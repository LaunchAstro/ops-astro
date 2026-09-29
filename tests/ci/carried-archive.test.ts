// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the carried archive, the restore drill's clean-host leg (recovery
// contract D-3). On the machine that runs staging, `restore-drill.mjs --export`
// writes the newest sealed backup the store hands out, with the store's
// recorded digest, into one file; on a host with no route to the store,
// `restore-drill.mjs --drill --archive <file>` restores it with the operator's
// own copy of the key, and its receipt is printed and kept; brought back,
// `--record` puts that receipt in the store (tests/db/backup-carried-drill.test.ts).
//
// `S0-3 carried archive`: the export writes only the sealed bytes and the
// store's recorded digest, never the key and never over a file; a carried file
// is checked against that digest before anything is opened, so a tampered one
// fails at `fetch`, a foreign one fails at `open`, and a malformed or linked one
// is refused; no plaintext is written anywhere; and the carried drill never
// reaches for the store.
//
// Runs anywhere: the store is a stand-in reach and Docker a stand-in that
// refuses to start, so the drill stops right after the archive is opened.

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

type Archive = { takenAt: string; sha256: string; body: Buffer };
type Receipt = Record<string, unknown>;
type DrillModule = {
  restoreDrill: (options: Record<string, unknown>) => Promise<Receipt>;
  drillAsOperator: (options: Record<string, unknown>) => Promise<Receipt>;
  exportArchive: (options: Record<string, unknown>) => Promise<Receipt>;
  RECEIPT_FIELDS: readonly string[];
};
type CarriedModule = {
  readCarried: (file: string) => { takenAt: string; body: Buffer };
  writeCarried: (file: string, archive: Archive) => void;
  readCarriedReceipt: (file: string, operator: string) => Receipt;
  digestOf: (body: Buffer) => string;
};

const load = async <T>(path: string): Promise<T> => (await import(/* @vite-ignore */ path)) as T;
const drillModule = async (): Promise<DrillModule> =>
  await load<DrillModule>('../../scripts/ops/restore-drill.mjs');
const carried = async (): Promise<CarriedModule> =>
  await load<CarriedModule>('../../scripts/ops/carried-archive.mjs');
const seal = async (): Promise<{ sealArchive: (dump: Buffer, publicKey: string) => Buffer }> =>
  await load('../../scripts/ops/archive-seal.mjs');

const pair = (): { publicKey: string; privateKey: string } =>
  generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
const keys = pair();
const CANARY = `canary-${randomBytes(8).toString('hex')}`;
const DUMP = Buffer.from(`-- a made-up dump\ninsert into tasks values ('${CANARY}');\n`);
const TAKEN = '2026-09-29T02:00:00.000Z';
const scope = { business: randomUUID(), client: randomUUID(), person: randomUUID() };
const scratch = mkdtempSync(join(tmpdir(), 's0-3e-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Docker that refuses every call, and remembers each one. */
const refusing = (): {
  calls: string[][];
  docker: () => Promise<{ code: number; stdout: string }>;
} => {
  const calls: string[][] = [];
  return {
    calls,
    docker: async (...args: unknown[]) => (
      calls.push(args[0] as string[]),
      { code: 1, stdout: '' }
    ),
  };
};

const sealed = async (publicKey = keys.publicKey): Promise<Archive> => {
  const body = (await seal()).sealArchive(DUMP, publicKey);
  return { takenAt: TAKEN, sha256: (await carried()).digestOf(body), body };
};

/** A folder of its own holding one carried archive. */
const carriedFile = async (archive?: Archive): Promise<{ dir: string; file: string }> => {
  const dir = mkdtempSync(join(scratch, 'carry-'));
  const file = join(dir, 'archive.sealed');
  (await carried()).writeCarried(file, archive ?? (await sealed()));
  return { dir, file };
};

/** Every byte under `dir`, as text. */
const everything = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'))
    .join('\n');

describe('S0-3 carried archive', () => {
  it('the export writes only the sealed bytes and the recorded digest, mode 600, and never over a file', async () => {
    const archive = await sealed();
    const row = JSON.stringify({
      takenAt: archive.takenAt,
      sha256: archive.sha256,
      body: archive.body.toString('hex'),
    });
    const dir = mkdtempSync(join(scratch, 'export-'));
    const file = join(dir, 'archive.sealed');
    const records = mkdtempSync(join(scratch, 'records-'));
    const gate = {
      ok: true,
      operator: { personId: randomUUID(), business: 'made-up' },
      records,
      recordSignIn: async () => {},
    };
    const receipt = await (
      await drillModule()
    ).exportArchive({ gate, storeUrl: 'store', file, reach: async () => row });
    expect(receipt).toMatchObject({ action: 'archive exported', archiveTakenAt: TAKEN });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    expect(Object.keys(written).toSorted()).toStrictEqual(['body', 'format', 'sha256', 'takenAt']);
    expect(Buffer.from(written['body']!, 'base64').equals(archive.body)).toBe(true);
    expect(written['sha256']).toBe(archive.sha256);
    for (const text of [everything(dir), JSON.stringify(receipt), everything(records)]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toMatch(/PRIVATE KEY/u);
    }
    expect(JSON.stringify(receipt)).not.toContain(archive.sha256);
    expect(JSON.stringify(receipt)).not.toContain(dir);
    // Never over a file: the second export is refused and the first stays whole.
    const before = readFileSync(file);
    await expect(
      (await drillModule()).exportArchive({
        gate,
        storeUrl: 'store',
        file,
        reach: async () => row,
      }),
    ).rejects.toThrow(/^(?!.*s0-3e-).*$/u);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('the export refuses an archive that does not match the digest the store recorded, and writes nothing', async () => {
    const archive = await sealed();
    const row = JSON.stringify({
      takenAt: TAKEN,
      sha256: '0'.repeat(64),
      body: archive.body.toString('hex'),
    });
    const dir = mkdtempSync(join(scratch, 'export-'));
    const records = mkdtempSync(join(scratch, 'records-'));
    const gate = {
      ok: true,
      operator: { personId: randomUUID(), business: 'made-up' },
      records,
      recordSignIn: async () => {},
    };
    await expect(
      (await drillModule()).exportArchive({
        gate,
        storeUrl: 'store',
        file: join(dir, 'a'),
        reach: async () => row,
      }),
    ).rejects.toThrow();
    expect(readdirSync(dir)).toStrictEqual([]);
    expect(readdirSync(records)).toStrictEqual([]);
  });

  it('a tampered carried archive fails at fetch, before anything is opened or started', async () => {
    const { file } = await carriedFile();
    const held = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    const body = Buffer.from(held['body']!, 'base64');
    body.writeUInt8(body.readUInt8(body.length - 1) ^ 1, body.length - 1);
    writeFileSync(file, JSON.stringify({ ...held, body: body.toString('base64') }));
    const fake = refusing();
    const { restoreDrill } = await drillModule();
    const { readCarried } = await carried();
    const result = await restoreDrill({
      fetchArchive: () => readCarried(file),
      privateKey: keys.privateKey,
      scope,
      docker: fake.docker,
    });
    expect(result).toMatchObject({ outcome: 'failed', stage: 'fetch' });
    expect(Object.keys(result['timings'] as object)).toStrictEqual(['fetch']);
    expect(fake.calls).toStrictEqual([]);
  });

  it('a foreign archive, sealed to another key, fails at open and starts nothing', async () => {
    const { file } = await carriedFile(await sealed(pair().publicKey));
    const fake = refusing();
    const { restoreDrill } = await drillModule();
    const { readCarried } = await carried();
    const result = await restoreDrill({
      fetchArchive: () => readCarried(file),
      privateKey: keys.privateKey,
      scope,
      docker: fake.docker,
    });
    expect(result).toMatchObject({ outcome: 'failed', stage: 'open' });
    expect(fake.calls).toStrictEqual([]);
  });

  it('a malformed, linked or foreign-shaped carried file is refused, naming nothing of it', async () => {
    const { file } = await carriedFile();
    const good = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    const hostile: Record<string, string> = {
      'not JSON': 'archive',
      'an array': JSON.stringify([good]),
      'an extra field': JSON.stringify({ ...good, key: CANARY }),
      'a missing field': JSON.stringify({
        format: good['format'],
        takenAt: TAKEN,
        body: good['body'],
      }),
      'a prototype key': `{"__proto__":{"x":1},${JSON.stringify(good).slice(1)}`,
      'another format': JSON.stringify({ ...good, format: 'ops-astro-sealed-archive/2' }),
      'an upper-case digest': JSON.stringify({ ...good, sha256: good['sha256']!.toUpperCase() }),
      'a short digest': JSON.stringify({ ...good, sha256: good['sha256']!.slice(2) }),
      'a body that is not base64': JSON.stringify({
        ...good,
        body: `${good['body']!.slice(4)}*A==`,
      }),
      'a time that is not a time': JSON.stringify({ ...good, takenAt: 'yesterday' }),
      'two archives': `${JSON.stringify(good)}\n${JSON.stringify(good)}`,
    };
    const { readCarried } = await carried();
    for (const [what, text] of Object.entries(hostile)) {
      const bad = join(mkdtempSync(join(scratch, 'bad-')), 'archive.sealed');
      writeFileSync(bad, text);
      expect(() => readCarried(bad), what).toThrow(/^(?!.*(?:s0-3e-|canary-)).*$/u);
    }
    const link = join(mkdtempSync(join(scratch, 'link-')), 'archive.sealed');
    symlinkSync(file, link);
    expect(() => readCarried(link), 'a link').toThrow(/^(?!.*s0-3e-).*$/u);
    expect(() => readCarried(join(scratch, 'none')), 'no file').toThrow(/^(?!.*s0-3e-).*$/u);
  });

  it('no plaintext is written: the carried drill leaves only the sealed file and its receipt line', async () => {
    const { dir, file } = await carriedFile();
    const records = mkdtempSync(join(scratch, 'records-'));
    const gate = {
      ok: true,
      operator: { personId: randomUUID(), business: 'made-up' },
      records,
      recordSignIn: async () => {},
    };
    const { drillAsOperator, restoreDrill } = await drillModule();
    const fake = refusing();
    const receipt = await drillAsOperator({
      gate,
      archiveFile: file,
      privateKey: keys.privateKey,
      scope,
      drill: async (options: Record<string, unknown>) =>
        await restoreDrill({ ...options, docker: fake.docker }),
      reach: async () => {
        throw new Error('the carried drill reached for the store');
      },
    });
    // It opened the archive, so the dump existed in memory; Docker refused to start.
    expect(receipt).toMatchObject({ outcome: 'failed', stage: 'start' });
    expect(readdirSync(dir)).toStrictEqual(['archive.sealed']);
    expect(readdirSync(records)).toStrictEqual(['deployments.jsonl']);
    for (const text of [everything(dir), everything(records), JSON.stringify(receipt)]) {
      expect(text).not.toContain(CANARY);
    }
  });

  it('the carried receipt is printed and kept, says it ran on a carried archive, and names no last tested restore', async () => {
    const { file } = await carriedFile();
    const records = mkdtempSync(join(scratch, 'records-'));
    const operator = randomUUID();
    const gate = {
      ok: true,
      operator: { personId: operator, business: 'made-up' },
      records,
      recordSignIn: async () => {},
    };
    const { drillAsOperator, RECEIPT_FIELDS } = await drillModule();
    const receipt = await drillAsOperator({
      gate,
      archiveFile: file,
      privateKey: keys.privateKey,
      scope,
      drill: async () => ({
        event: 'restore drill',
        at: new Date().toISOString(),
        outcome: 'passed',
        target: 'throwaway container',
        productionMajor: 17,
        sourceMajor: 17,
        targetMajor: 17,
        archiveTakenAt: TAKEN,
        tables: 12,
        readAs: 'ops_astro_app',
        timings: { fetch: 1 },
      }),
      reach: async () => {
        throw new Error('the carried drill reached for the store');
      },
    });
    expect(Object.keys(receipt).toSorted()).toStrictEqual([...RECEIPT_FIELDS].toSorted());
    expect(receipt).toMatchObject({
      outcome: 'passed',
      ranOn: 'carried archive',
      lastTestedRestore: null,
      operator,
    });
    const kept = readFileSync(join(records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(kept.map((line) => JSON.parse(line) as Receipt)).toStrictEqual([receipt]);
    // The kept line is what --record takes back on the machine that runs staging.
    const line = join(mkdtempSync(join(scratch, 'receipt-')), 'receipt.json');
    writeFileSync(line, `${kept[0]}\n`);
    expect((await carried()).readCarriedReceipt(line, operator)).toStrictEqual(receipt);
  });

  it('a carried receipt is refused unless it is one whole carried receipt of the operator who brings it', async () => {
    const operator = randomUUID();
    const { RECEIPT_FIELDS } = await drillModule();
    const good: Receipt = Object.fromEntries(RECEIPT_FIELDS.map((field) => [field, null]));
    Object.assign(good, {
      action: 'restore drill recorded',
      outcome: 'passed',
      at: TAKEN,
      target: 'throwaway container',
      productionMajor: 17,
      sourceMajor: 17,
      targetMajor: 17,
      archiveTakenAt: TAKEN,
      tables: 12,
      readAs: 'ops_astro_app',
      timings: { fetch: 1 },
      business: 'made-up',
      operator,
      ranOn: 'carried archive',
    });
    const { readCarriedReceipt } = await carried();
    const at = (text: string): string => {
      const file = join(mkdtempSync(join(scratch, 'receipt-')), 'receipt.json');
      writeFileSync(file, text);
      return file;
    };
    expect(readCarriedReceipt(at(JSON.stringify(good)), operator)).toStrictEqual(good);
    const hostile: Record<string, string> = {
      'another person': JSON.stringify({ ...good, operator: randomUUID() }),
      'a drill that ran on staging': JSON.stringify({ ...good, ranOn: 'staging machine' }),
      'a receipt already recorded': JSON.stringify({ ...good, lastTestedRestore: TAKEN }),
      'another action': JSON.stringify({ ...good, action: 'archive exported' }),
      'an extra field': JSON.stringify({ ...good, note: CANARY }),
      'a missing field': JSON.stringify({ ...good, tables: undefined }),
      'a prototype key': `{"__proto__":{"outcome":"passed"},${JSON.stringify(good).slice(1)}`,
      'a major that is not a number': JSON.stringify({ ...good, sourceMajor: '17' }),
      'an outcome of its own': JSON.stringify({ ...good, outcome: 'maybe' }),
      'two receipts': `${JSON.stringify(good)}\n${JSON.stringify(good)}`,
      'not JSON': 'passed',
    };
    for (const [what, text] of Object.entries(hostile)) {
      expect(() => readCarriedReceipt(at(text), operator), what).toThrow(
        /^(?!.*(?:s0-3e-|canary-)).*$/u,
      );
    }
  });
});
