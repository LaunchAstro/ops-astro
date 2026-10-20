// SPDX-License-Identifier: AGPL-3.0-only
//
// The install the API's composition root configures with `OPS_AGENT_PROVIDER`
// unset: its own broker (`startModelBroker`) over the replay stand-in on
// loopback, behind one local route. The stand-in prices every answer, so this
// install's conversation operation keeps its priced maximum, and the
// conversation seam refuses it (#1508, option B). The race cases on that
// refusal share it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokerSettings, startModelBroker } from '../../apps/api/model-broker.ts';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import {
  startReplayProvider,
  type ReplayProvider,
} from '../../packages/core-connectors/src/index.ts';

export interface PricedInstall {
  readonly provider: ReplayProvider;
  readonly exchange: ConversationExchange;
  stop(): Promise<void>;
}

export async function pricedReplayInstall(): Promise<PricedInstall> {
  const provider = await startReplayProvider();
  const folder = mkdtempSync(join(tmpdir(), 'replay-priced-race-'));
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
        value: `replay-${String(Date.now())}`,
      },
    ]),
    { mode: 0o600 },
  );
  const settings = brokerSettings({
    MODEL_BROKER_CREDENTIALS_FILE: credentialsFile,
    MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'replay', origin: provider.origin }]),
    MODEL_BROKER_ROUTES: JSON.stringify([
      {
        key: 'on_premises',
        reach: 'local',
        provider: 'replay',
        credentialRef: 'replay_key',
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: 4,
      },
    ]),
    MODEL_BROKER_INSTALLATION: 'here',
  });
  if (settings.kind !== 'configured') throw new Error(`broker ${settings.kind}`);
  const broker = await startModelBroker(settings);
  return {
    provider,
    exchange: broker.answerConversation,
    stop: async () => {
      await broker.stop();
      await provider.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
