// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03's exchange, the models its cases talk to. `localModel` is custody's
// real process and the replay provider on loopback behind the one route the
// conversation seam takes, a local one, priced at nothing (a local model
// costs no money per call). `answer` swaps the operation's answer reader, so a
// case can hand the exchange an answer no replay mode makes. `composedWith`
// mounts an exchange through the server's own `composeApi`.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { brokerSettings } from '../../apps/api/model-broker.ts';
import { composeApi } from '../../apps/api/server.ts';
import {
  conversationExchange,
  type ConversationExchange,
} from '../../packages/core-commands/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  catalogue,
  CONVERSATION_ANSWER,
  replayAdapter,
  startReplayProvider,
  type ModelOperationDeclaration,
  type ReplayProvider,
} from '../../packages/core-connectors/src/index.ts';
import { startCustody } from '../../packages/core-custody/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { ISSUER, SECRET, type ApiFixture } from './fixture.ts';

export interface LocalModel {
  readonly exchange: ConversationExchange;
  readonly provider: ReplayProvider;
  close(): Promise<void>;
}

const LOCAL_ROUTE = {
  key: 'on_premises',
  reach: 'local',
  provider: 'replay',
  credentialRef: 'replay_key',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 1_000,
};

export async function localModel(
  answer?: ModelOperationDeclaration['answer'],
): Promise<LocalModel> {
  const folder = mkdtempSync(join(tmpdir(), 'aw03-exchange-'));
  const provider = await startReplayProvider();
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
    MODEL_BROKER_ROUTES: JSON.stringify([LOCAL_ROUTE]),
    MODEL_BROKER_INSTALLATION: 'here',
  });
  if (settings.kind !== 'configured') throw new Error(`local model: ${settings.kind}`);
  const custody = await startCustody(settings.custody);
  const exchange = conversationExchange({
    custody,
    operations: catalogue([
      answer === undefined ? CONVERSATION_ANSWER : { ...CONVERSATION_ANSWER, answer },
    ]),
    providers: new Map([['replay', { build: replayAdapter, price: () => 0 }]]),
    routes: settings.routes,
    installation: settings.installation,
  });
  return {
    exchange,
    provider,
    close: async () => {
      await custody.stop();
      await provider.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

/** The server's composition root over the fixture's database, the exchange mounted. */
export const composedWith = (fixture: ApiFixture, answerConversation: ConversationExchange): Hono =>
  composeApi({
    keys: runtimeKeys({ ...fixture.environment }),
    database: fixture.db.app,
    admin: fixture.db.admin,
    secret: SECRET,
    issuer: ISSUER,
    executeRead,
    answerConversation,
  }).app;
