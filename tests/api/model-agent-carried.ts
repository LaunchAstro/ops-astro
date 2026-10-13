// SPDX-License-Identifier: AGPL-3.0-only
//
// The real model agent in a carried world (`carried-world.ts`) in place of
// its stand-in: the agent on the world's hub with the agent's own login, and
// custody's real process holding Ollama's credential filed as `none`, sending
// to the world's stand-in Ollama, and, in a world with the outside provider
// on, a made-up OpenRouter bearer key for the stand-in OpenRouter, whose
// stream custody decodes. A case can wrap custody as the agent sees it, to
// hold or pause the hand-over.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCustody } from '../../packages/core-custody/src/agent.ts';
import { agentCustody } from '../../apps/model-agent/main.ts';
import {
  startModelAgent,
  type AgentCustody,
  type ModelAgent,
} from '../../apps/model-agent/carrier.ts';
import { hubCarriage } from '../support/hub-carriage.ts';
import type { CarriedWorld } from './carried-world.ts';
import { tokenFor } from './fixture.ts';

/** The made-up key the agent's custody presents to the stand-in OpenRouter. */
export const AGENT_BEARER: string = `or-test-${crypto.randomUUID()}`;

export interface CarriedAgent {
  readonly agent: ModelAgent;
  stop(): Promise<void>;
}

// oxlint-disable-next-line max-lines-per-function -- the agent, its custody and its credentials in one place
export async function withModelAgent(
  world: CarriedWorld,
  wrap: (custody: AgentCustody) => AgentCustody = (custody) => custody,
): Promise<CarriedAgent> {
  // The stand-in hears no more offers; the real agent takes them.
  world.agent.mode = 'silent';
  const folder = mkdtempSync(join(tmpdir(), 'carried-agent-'));
  const credentialsFile = join(folder, 'credentials.json');
  const none = { ref: 'ollama_key', kind: 'api_key', account: 'm5-ollama', destination: 'ollama' };
  const bearer = {
    ref: 'openrouter',
    kind: 'api_key',
    account: 'agency-astro-openrouter',
    destination: 'openrouter',
    header: 'authorization',
    scheme: 'bearer',
    value: AGENT_BEARER,
  };
  const { openrouter } = world;
  const entries = [{ ...none, scheme: 'none' }, ...(openrouter === undefined ? [] : [bearer])];
  writeFileSync(credentialsFile, JSON.stringify(entries), { mode: 0o600 });
  const custody = await startCustody({
    credentialsFile,
    destinations: [
      { key: 'ollama', origin: world.ollama.origin },
      ...(openrouter === undefined
        ? []
        : [{ key: 'openrouter', origin: openrouter.origin, stream: 'openai_sse' as const }]),
    ],
  });
  const { fixture } = world.w;
  const token = await tokenFor(fixture.agent.subject);
  const agent = await startModelAgent({
    carriage: hubCarriage(world.hub),
    keys: world.keys,
    key: world.key,
    business: fixture.business,
    agent: fixture.agentActorId,
    token: async () => await Promise.resolve(token),
    // Each request under its own destination's credential, as the agent's process maps them.
    custody: wrap(
      agentCustody(
        {
          credentialRef: 'ollama_key',
          ...(openrouter === undefined ? {} : { openrouterCredentialRef: 'openrouter' }),
        },
        custody,
      ),
    ),
  });
  if ('because' in agent) throw new Error(`the model agent did not start: ${agent.because}`);
  return {
    agent,
    stop: async () => {
      await agent.stop();
      await custody.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
