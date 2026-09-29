// SPDX-License-Identifier: AGPL-3.0-only
//
// A replay provider, a credential file holding a planted canary key, and
// custody started on them. Each file gets its own; `close` removes all three.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPLAY_COMPOSE,
  replayAdapter,
  startReplayProvider,
  type ReplayProvider,
} from '../../packages/core-connectors/src/index.ts';
import {
  startCustody,
  type Custody,
  type OutboundRequest,
} from '../../packages/core-custody/src/index.ts';

export interface CustodyWorld {
  readonly provider: ReplayProvider;
  readonly custody: Custody;
  /** The planted key: it must never be seen outside custody and the provider. */
  readonly canary: string;
  readonly folder: string;
  request(overrides?: Partial<OutboundRequest>): OutboundRequest;
  writeCredentials(entries: unknown): string;
  close(): Promise<void>;
}

export const plantedKey = (): string => `canary-${randomBytes(18).toString('hex')}`;

export async function openCustodyWorld(): Promise<CustodyWorld> {
  const folder = mkdtempSync(join(tmpdir(), 'aw01-custody-'));
  try {
    return await openIn(folder);
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

async function openIn(folder: string): Promise<CustodyWorld> {
  const provider = await startReplayProvider();
  const canary = plantedKey();
  const writeCredentials = (entries: unknown): string => {
    const file = join(folder, `credentials-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
    return file;
  };
  const credentialsFile = writeCredentials([
    {
      ref: 'replay_key',
      kind: 'api_key',
      account: 'replay-account-1',
      destination: 'replay',
      header: 'authorization',
      value: canary,
    },
  ]);
  const destinations = [{ key: 'replay', origin: provider.origin }];
  const custody = await startCustody({ credentialsFile, destinations }).catch(async (error) => {
    await provider.close();
    throw error;
  });
  const adapted = replayAdapter({ instruction: 'draft a reply', tone: 'plain' });
  return {
    provider,
    custody,
    canary,
    folder,
    writeCredentials,
    request: (overrides = {}) => ({
      destination: REPLAY_COMPOSE.destination,
      path: adapted.path,
      method: adapted.method,
      body: adapted.body,
      timeoutMs: REPLAY_COMPOSE.timeoutMs,
      maxResponseBytes: REPLAY_COMPOSE.maxResponseBytes,
      ...overrides,
    }),
    close: async () => {
      await custody.stop();
      await provider.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
