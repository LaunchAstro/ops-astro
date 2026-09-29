// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keys } from './carried-archive.fixture.ts';

type Backup = {
  runBackup: (options: Record<string, unknown>) => Promise<{ outcome: string }>;
};

describe('S0-3e restore challenge race', () => {
  it('Sol proof, criterion 13: concurrent backups bind each stored challenge to the dump they actually took', async () => {
    const path = '../../scripts/ops/backup.mjs';
    const { runBackup } = (await import(
      /* @vite-ignore */
      path
    )) as Backup;
    let sourceChallenge = '';
    let dumpedByFirst = '';
    const signals: { firstWrote?: () => void; releaseFirst?: () => void } = {};
    const wrote = new Promise<void>((resolve) => {
      signals.firstWrote = resolve;
    });
    const released = new Promise<void>((resolve) => {
      signals.releaseFirst = resolve;
    });
    const uploads = new Map<string, string>();
    const reach = async (name: string, script: string | AsyncIterable<string>): Promise<string> => {
      let sent = '';
      if (typeof script === 'string') sent = script;
      else for await (const part of script) sent += part;
      uploads.set(name, sent);
      return '';
    };
    const first = runBackup({
      challenge: (value: string) => {
        sourceChallenge = value;
        signals.firstWrote?.();
        return Promise.resolve();
      },
      dump: async () => {
        await released;
        dumpedByFirst = sourceChallenge;
        return Buffer.from(`restore challenge ${dumpedByFirst}\n`);
      },
      storeUrl: 'first',
      publicKey: keys.publicKey,
      reach,
      send: () => Promise.resolve('sent'),
    });
    await wrote;
    const second = runBackup({
      challenge: (value: string) => {
        sourceChallenge = value;
        signals.releaseFirst?.();
        return Promise.resolve();
      },
      dump: () => Promise.resolve(Buffer.from(`restore challenge ${sourceChallenge}\n`)),
      storeUrl: 'second',
      publicKey: keys.publicKey,
      reach,
      send: () => Promise.resolve('sent'),
    });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.outcome).toBe('recorded');
    expect(secondResult.outcome).toBe('recorded');
    const storedHash = /complete_archive\(\d+, '[0-9a-f]{64}', '([0-9a-f]{64})'\)/u.exec(
      uploads.get('first') ?? '',
    )?.[1];
    expect(storedHash).toBe(createHash('sha256').update(dumpedByFirst).digest('hex'));
  });
});
