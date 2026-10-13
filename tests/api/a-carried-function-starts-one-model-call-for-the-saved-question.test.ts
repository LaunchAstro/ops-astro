// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment's function, configured as hosted (a carrier, its
// route, the carry key, the Realtime address and the publishable key),
// starts the broker's one model call for a signed-in person's saved
// question. Disposable databases only.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { createApiFixture, tokenFor, ISSUER, authorised } from './fixture.ts';
import { conversationWorld, detail } from './aw-03-fixture.ts';
import { personPath } from './controls-fixture.ts';
import { serveTestKeySet } from '../support/sign-in.ts';
import { Client, loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

// oxlint-disable-next-line max-lines-per-function -- the function's whole configuration, then one request
it('a configured carried function starts a model call for the saved question', async () => {
  vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
  const fixture = await createApiFixture('carried_function_call');
  const world = await conversationWorld({ fixture, api: fixture.compose() });
  const keySet = await serveTestKeySet();
  const lookup = await loginIn(fixture.db, 'ops_astro_lookup', 'carriedfn');
  try {
    const keyId = 'test/carriedfn@1';
    const handle = createFunctionHandler({
      ...fixture.environment,
      DATABASE_URL: fixture.db.appUrl,
      DATABASE_LOOKUP_URL: lookup.url,
      GOTRUE_URL: ISSUER,
      SUPABASE_KEY_SET_URL: keySet.url,
      SERVED_HOST: 'ops.example.test',
      DELEGATION_CREDENTIAL_KEY_ID: keyId,
      DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
      OPS_AGENT_PROVIDER: 'ollama',
      MODEL_BROKER_INSTALLATION: 'here',
      MODEL_BROKER_CARRY_KEY: randomBytes(32).toString('base64url'),
      SUPABASE_REALTIME_URL: 'wss://realtime.example.test/realtime/v1',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
      MODEL_BROKER_CARRIER: JSON.stringify({
        agent: fixture.agentActorId,
        people: [world.owner.personId],
      }),
      MODEL_BROKER_ROUTES: JSON.stringify([
        {
          key: 'm5_ollama',
          reach: 'local',
          provider: 'ollama',
          credentialRef: 'ollama_none',
          credentialKind: 'api_key',
          installation: 'here',
          ceiling: 1,
        },
      ]),
    });
    const response = await handle(
      new Request(`https://ops.example.test${personPath('conversation.start')}`, {
        method: 'POST',
        headers: {
          host: 'ops.example.test',
          'content-type': 'application/json',
          ...authorised(await tokenFor(world.owner.presented.subject)),
        },
        body: JSON.stringify({ operationId: randomUUID(), body: 'What is due today?' }),
      }),
    );
    const answer = { status: response.status, body: await response.json() };
    const conversationId = String(detail(answer)['conversationId']);
    const [saved] = await fixture.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.conversation_messages
         where conversation_id = $1 and role = 'person'`,
      [conversationId],
    );
    expect(saved?.n, 'Control: the signed-in person saved the question').toBe(1);
    const calls = await fixture.db.admin.execute(
      'select id from public.model_calls where conversation_id = $1',
      [conversationId],
    );
    expect(
      calls,
      'The carried function saved the question but never started its broker call',
    ).toHaveLength(1);
  } finally {
    await keySet.close();
    await world.drop();
    const cleanup = new Client(databaseUrlFromEnvironment() ?? '');
    await cleanup.query(`drop role if exists "${lookup.name}"`).finally(() => cleanup.end());
    vi.unstubAllEnvs();
  }
}, 180_000);
