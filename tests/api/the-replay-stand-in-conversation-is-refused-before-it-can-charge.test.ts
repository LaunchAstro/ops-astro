// SPDX-License-Identifier: AGPL-3.0-only
//
// #1508, option B, on the install the API's composition root configures
// with the replay stand-in (`OPS_AGENT_PROVIDER` unset): the stand-in prices
// every answer (`replayCostMinor`), so its conversation operation is priced,
// and the conversation seam refuses it before anything is written or sent.
// Sol's round 1 on #1523 (criterion 1): declared at zero while still priced, a
// normal answer incurred 100 minor units after dispatch with nothing reserved.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brokerSettings, startModelBroker } from '../../apps/api/model-broker.ts';
import {
  CONVERSATION_ANSWER,
  startReplayProvider,
  type ReplayProvider,
} from '../../packages/core-connectors/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the replay stand-in on the conversation seam', () => {
  let provider: ReplayProvider;
  let folder: string;
  let stopBroker: () => Promise<void>;
  let w: ConversationWorld;

  beforeAll(async () => {
    provider = await startReplayProvider();
    folder = mkdtempSync(join(tmpdir(), 'replay-priced-'));
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
    stopBroker = broker.stop;
    const fixture = await createApiFixture('replay_priced_conversation');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.answerConversation) });
  }, 180_000);

  afterAll(async () => {
    await stopBroker?.();
    await provider?.close();
    await w?.drop();
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  });

  it('declares the priced maximum its price can reach', () => {
    expect(CONVERSATION_ANSWER.maximumMinor).toBeGreaterThan(0);
  });

  it('refuses a person’s message before any call row or send, keeping the message', async () => {
    const before = provider.seen.length;
    const opened = await w.as(w.owner, 'conversation.start', { body: 'What is due today?' });
    expect(opened.status).toBe(200);
    expect((opened.body as Record<string, unknown>)['reply']).toMatchObject({
      answered: false,
      code: 'BUDGET_UNAVAILABLE',
    });
    expect(provider.seen.length - before).toBe(0);
    expect(
      await w.count(
        'select count(*)::text as n from public.model_calls where conversation_id is not null',
        [],
      ),
    ).toBe(0);
    expect(
      await w.count(
        "select count(*)::text as n from public.conversation_messages where role = 'person'",
        [],
      ),
    ).toBe(1);
  });
});
