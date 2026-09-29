// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: the carried archive, the restore drill's clean-host leg (recovery
// contract D-3). On the machine that runs staging, `restore-drill.mjs --export`
// writes the newest sealed backup the store hands out, with the store's
// recorded digest, into one file; on a host with no route to the store,
// `restore-drill.mjs --drill --archive <file>` restores it with the operator's
// own copy of the key. The receipt's side is carried-receipt.test.ts; the
// store's, tests/db/backup-carried-drill.test.ts.
//
// `S0-3 carried archive`: the export writes only the sealed bytes and the
// store's recorded digest, never the key and never over a file; a carried file
// is checked against that digest before anything is opened, so a tampered one
// fails at `fetch`, a foreign one fails at `open`, and a malformed or linked
// one is refused; no plaintext is written anywhere.
//
// Runs anywhere: the store is a stand-in reach and Docker a stand-in that
// refuses to start, so the drill stops right after the archive is opened.

import { readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANARY,
  NAMES_NOTHING,
  TAKEN,
  carried,
  carriedFile,
  drillModule,
  everything,
  folder,
  gateOf,
  keys,
  noStore,
  pair,
  refusing,
  scope,
  sealed,
} from './carried-archive.fixture.ts';

describe('S0-3 carried archive', () => {
  exportCases();
  openCases();
  plaintextCases();
  refusalCases();
});

/** The store's answer to the export's read: the row as `fetchLatest` asks for it. */
const rowOf = (archive: { takenAt: string; sha256: string; body: Buffer }): string =>
  JSON.stringify({
    takenAt: archive.takenAt,
    sha256: archive.sha256,
    body: archive.body.toString('hex'),
  });

function exportCases() {
  it('the export writes only the sealed bytes and the recorded digest, mode 600, never over a file', async () => {
    const archive = await sealed();
    const dir = folder('export');
    const file = join(dir, 'archive.sealed');
    const gate = gateOf();
    const { exportArchive } = await drillModule();
    const reach = (): Promise<string> => Promise.resolve(rowOf(archive));
    const receipt = await exportArchive({ gate, storeUrl: 'store', file, reach });
    expect(receipt).toMatchObject({ action: 'archive exported', archiveTakenAt: TAKEN });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    expect(Object.keys(written).toSorted()).toStrictEqual(['body', 'format', 'sha256', 'takenAt']);
    expect(Buffer.from(written['body']!, 'base64').equals(archive.body)).toBe(true);
    expect(written['sha256']).toBe(archive.sha256);
    for (const text of [everything(dir), JSON.stringify(receipt), everything(gate.records)]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toMatch(/PRIVATE KEY/u);
    }
    expect(JSON.stringify(receipt)).not.toContain(archive.sha256);
    expect(JSON.stringify(receipt)).not.toContain(dir);
    // Never over a file: the second export is refused and the first stays whole.
    const before = readFileSync(file);
    await expect(exportArchive({ gate, storeUrl: 'store', file, reach })).rejects.toThrow(
      NAMES_NOTHING,
    );
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('the export refuses an archive that does not match the digest the store recorded, and writes nothing', async () => {
    const archive = { ...(await sealed()), sha256: '0'.repeat(64) };
    const dir = folder('export');
    const gate = gateOf();
    const reach = (): Promise<string> => Promise.resolve(rowOf(archive));
    const { exportArchive } = await drillModule();
    await expect(
      exportArchive({ gate, storeUrl: 'store', file: join(dir, 'a'), reach }),
    ).rejects.toThrow(NAMES_NOTHING);
    expect(readdirSync(dir)).toStrictEqual([]);
    expect(readdirSync(gate.records)).toStrictEqual([]);
  });
}

function openCases() {
  it('a tampered carried archive fails at fetch, before anything is opened or started', async () => {
    const { file } = await carriedFile();
    const held = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    const body = Buffer.from(held['body']!, 'base64');
    body.writeUInt8(body.readUInt8(body.length - 1) ^ 1, body.length - 1);
    writeFileSync(file, JSON.stringify({ ...held, body: body.toString('base64') }));
    const fake = refusing();
    const { restoreDrill } = await drillModule();
    const { readCarried } = await carried();
    const fetchArchive = (): { takenAt: string; body: Buffer } => readCarried(file);
    const result = await restoreDrill({
      fetchArchive,
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
    const fetchArchive = (): { takenAt: string; body: Buffer } => readCarried(file);
    const result = await restoreDrill({
      fetchArchive,
      privateKey: keys.privateKey,
      scope,
      docker: fake.docker,
    });
    expect(result).toMatchObject({ outcome: 'failed', stage: 'open' });
    expect(fake.calls).toStrictEqual([]);
  });
}

function plaintextCases() {
  it('no plaintext is written: the carried drill leaves only the sealed file and its receipt line', async () => {
    const { dir, file } = await carriedFile();
    const gate = gateOf();
    const { drillAsOperator, restoreDrill } = await drillModule();
    const fake = refusing();
    const receipt = await drillAsOperator({
      gate,
      archiveFile: file,
      privateKey: keys.privateKey,
      scope,
      drill: async (options: Record<string, unknown>) =>
        await restoreDrill({ ...options, docker: fake.docker }),
      reach: noStore,
    });
    // It opened the archive, so the dump existed in memory; Docker refused to start.
    expect(receipt).toMatchObject({ outcome: 'failed', stage: 'start' });
    expect(readdirSync(dir)).toStrictEqual(['archive.sealed']);
    expect(readdirSync(gate.records)).toStrictEqual(['deployments.jsonl']);
    for (const text of [everything(dir), everything(gate.records), JSON.stringify(receipt)]) {
      expect(text).not.toContain(CANARY);
    }
  });
}

function refusalCases() {
  it('a malformed, linked or foreign-shaped carried file is refused, naming nothing of it', async () => {
    const { file } = await carriedFile();
    const good = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    const hostile: Record<string, string> = {
      'not JSON': 'archive',
      'an array': JSON.stringify([good]),
      'an extra field': JSON.stringify({ ...good, key: CANARY }),
      'a missing field': JSON.stringify({ ...good, sha256: undefined }),
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
      const bad = join(folder('bad'), 'archive.sealed');
      writeFileSync(bad, text);
      expect(() => readCarried(bad), what).toThrow(NAMES_NOTHING);
    }
    const link = join(folder('link'), 'archive.sealed');
    symlinkSync(file, link);
    expect(() => readCarried(link), 'a link').toThrow(NAMES_NOTHING);
    expect(() => readCarried(join(folder('none'), 'none')), 'no file').toThrow(NAMES_NOTHING);
  });
}
