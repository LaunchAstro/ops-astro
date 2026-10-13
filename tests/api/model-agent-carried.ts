// SPDX-License-Identifier: AGPL-3.0-only
//
// The real model agent in a carried world (`carried-world.ts`) in place of
// its stand-in: the agent on the world's hub with the agent's own login, and
// custody's real process holding Ollama's credential filed as `none`, sending
// to the world's stand-in Ollama. A case can wrap custody as the agent sees
// it, to hold or pause the hand-over.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCustody } from '../../packages/core-custody/src/agent.ts';
import {
  startModelAgent,
  type AgentCustody,
  type ModelAgent,
} from '../../apps/model-agent/carrier.ts';
import { hubCarriage } from '../support/hub-carriage.ts';
import type { CarriedWorld } from './carried-world.ts';
import { tokenFor } from './fixture.ts';

export interface CarriedAgent {
  readonly agent: ModelAgent;
  stop(): Promise<void>;
}

export async function withModelAgent(
  world: CarriedWorld,
  wrap: (custody: AgentCustody) => AgentCustody = (custody) => custody,
): Promise<CarriedAgent> {
  // The stand-in hears no more offers; the real agent takes them.
  world.agent.mode = 'silent';
  const folder = mkdtempSync(join(tmpdir(), 'carried-agent-'));
  const credentialsFile = join(folder, 'credentials.json');
  const none = { ref: 'ollama_key', kind: 'api_key', account: 'm5-ollama', destination: 'ollama' };
  writeFileSync(credentialsFile, JSON.stringify([{ ...none, scheme: 'none' }]), { mode: 0o600 });
  const custody = await startCustody({
    credentialsFile,
    destinations: [{ key: 'ollama', origin: world.ollama.origin }],
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
    custody: wrap({
      dispatch: async (request, gate, onPiece) =>
        await custody.dispatchBefore('ollama_key', request, gate, onPiece),
    }),
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
