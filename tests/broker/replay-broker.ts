// SPDX-License-Identifier: AGPL-3.0-only
//
// A deployment's credential broker for a test world: the replay provider on
// loopback and custody's own process, started through the server's own
// `brokerSettings` and `startModelBroker` (`apps/api/model-broker.ts`), so a
// world that mounts it runs the wiring the server listens with.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokerSettings, startModelBroker } from '../../apps/api/model-broker.ts';
import type { ModelCallExecutor } from '../../packages/core-commands/src/index.ts';
import {
  startReplayProvider,
  type ReplayProvider,
} from '../../packages/core-connectors/src/index.ts';

export interface ReplayBroker {
  readonly executor: ModelCallExecutor;
  readonly provider: ReplayProvider;
  close(): Promise<void>;
}

/** The one route: the replay provider, carried by an API key of this installation. */
const REPLAY_ROUTE = {
  key: 'replay',
  reach: 'cloud',
  provider: 'replay',
  credentialRef: 'replay_key',
  credentialKind: 'api_key',
  installation: 'here',
};

export async function openReplayBroker(): Promise<ReplayBroker> {
  const folder = mkdtempSync(join(tmpdir(), 'aw01-broker-'));
  const provider = await startReplayProvider();
  try {
    const credentialsFile = join(folder, 'credentials.json');
    writeFileSync(
      credentialsFile,
      JSON.stringify([
        {
          ref: 'replay_key',
          kind: 'api_key',
          account: 'replay-account-1',
          destination: 'replay',
          header: 'authorization',
          value: `replay-${folder.length}-${Date.now()}`,
        },
      ]),
      { mode: 0o600 },
    );
    const settings = brokerSettings({
      MODEL_BROKER_CREDENTIALS_FILE: credentialsFile,
      MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'replay', origin: provider.origin }]),
      MODEL_BROKER_ROUTES: JSON.stringify([REPLAY_ROUTE]),
      MODEL_BROKER_INSTALLATION: 'here',
    });
    if (settings.kind !== 'configured') throw new Error(`replay broker: ${settings.kind}`);
    const started = await startModelBroker(settings);
    return {
      executor: started.executor,
      provider,
      close: async () => {
        await started.stop();
        await provider.close();
        rmSync(folder, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await provider.close();
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}
