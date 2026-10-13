// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether the answer streams follows only what custody presents for the
// route's credential, and custody answers the describe and the dispatch from
// the one credential it loaded. A credential filed as `none` under another
// kind than the route names (described for another kind than the route's)
// presents nothing at dispatch too: the answer may stream, no header is sent,
// and nothing a credential could echo exists; the call settles once. The same route over a token of
// that other kind is never streamed, whatever Ollama does.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { brokerSettings, startModelBroker } from '../../apps/api/model-broker.ts';
import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  chatAnswer,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The broker on one local route naming `api_key`, its credential filed as `credential`. */
async function brokerOver(
  origin: string,
  credential: Record<string, unknown>,
): Promise<{ readonly exchange: ConversationExchange; stop(): Promise<void> }> {
  const folder = mkdtempSync(join(tmpdir(), 'ollama-kind-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(credentialsFile, JSON.stringify([credential]), { mode: 0o600 });
  const settings = brokerSettings({
    OPS_AGENT_PROVIDER: 'ollama',
    MODEL_BROKER_CREDENTIALS_FILE: credentialsFile,
    MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'ollama', origin }]),
    MODEL_BROKER_ROUTES: JSON.stringify([
      {
        key: 'm5_ollama',
        reach: 'local',
        provider: 'ollama',
        credentialRef: 'ollama_key',
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
    exchange: broker.answerConversation,
    stop: async () => {
      await broker.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

const BASE = {
  ref: 'ollama_key',
  kind: 'cloud_credential',
  account: 'm5-ollama',
  destination: 'ollama',
};

// oxlint-disable-next-line max-lines-per-function -- one stand-in, two brokers
describe.skipIf(serverUrl === undefined)('a stream follows what custody presents', () => {
  let ollama: StandIn;
  let w: ConversationWorld;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
  }, 60_000);

  afterAll(async () => {
    for (const stop of stops) await stop(); // oxlint-disable-line no-await-in-loop -- in turn
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  /** Streams when asked to, whole otherwise; the credential's header, if any, echoed in two records. */
  function echoing(): void {
    ollama.reply = (model) => {
      const request = ollama.seen.at(-1);
      const echoed = request?.authorization ?? 'none-sent';
      const streamed = (JSON.parse(request?.raw ?? '{}') as { stream?: boolean }).stream === true;
      return streamed
        ? {
            status: 200,
            chunks: streamedLines(model, ['Echo ', echoed.slice(0, 5), echoed.slice(5)]),
          }
        : chatAnswer(model, `Echo ${echoed}`);
    };
  }

  it('none under another kind: streamed, nothing presented, settled once', async () => {
    const broker = await brokerOver(ollama.origin, { ...BASE, scheme: 'none' });
    stops.push(broker.stop);
    const fixture = await createApiFixture('stream_kind_none');
    // The API answers nothing; the case asks each broker's exchange itself.
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
    echoing();
    const before = ollama.seen.length;
    const pieces: string[] = [];
    const opened = await w.as(w.owner, 'conversation.start', { body: 'Kind?' });
    const asked = {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
    const reply = await broker.exchange(
      fixture.db.app,
      fixture.business,
      w.owner.presented,
      asked,
      (text) => pieces.push(text),
    );
    const sent = ollama.seen.slice(before);
    expect(sent.every((seen) => seen.authorization === undefined)).toBe(true);
    expect(JSON.parse(sent.at(-1)?.raw ?? '{}')).toMatchObject({ stream: true });
    expect(pieces.join('')).toBe('Echo none-sent');
    expect(reply).toMatchObject({ answered: true, body: 'Echo none-sent' });
    const rows = await w.fixture.db.admin.execute<{ account: string | null; state: string }>(
      'select account, state from public.model_calls where conversation_id = $1',
      [asked.conversationId],
    );
    expect(rows.map((row) => row.state)).toEqual(['settled']);
  }, 120_000);

  it('a token under another kind: asked whole, no piece, the token never in the reply', async () => {
    const broker = await brokerOver(ollama.origin, {
      ...BASE,
      header: 'authorization',
      value: `kind-token-${String(Date.now())}`,
    });
    stops.push(broker.stop);
    echoing();
    const before = ollama.seen.length;
    const pieces: string[] = [];
    const opened = await w.as(w.owner, 'conversation.start', { body: 'Kind with a token?' });
    const conversationId = String(detail(opened)['conversationId']);
    const reply = await broker.exchange(
      w.fixture.db.app,
      w.fixture.business,
      w.owner.presented,
      { conversationId, messageId: String(detail(opened)['messageId']) },
      (text) => pieces.push(text),
    );
    const sent = ollama.seen.at(-1);
    expect(ollama.seen.length).toBeGreaterThan(before);
    expect(sent?.authorization).toContain('kind-token-');
    expect(JSON.parse(sent?.raw ?? '{}')).toMatchObject({ stream: false });
    expect(pieces).toEqual([]);
    expect(JSON.stringify(reply)).not.toContain('kind-token-');
  }, 120_000);
});
