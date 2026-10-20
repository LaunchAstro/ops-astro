// SPDX-License-Identifier: AGPL-3.0-only
//
// The hosted side of a task's carried call (#1703, #1620 P5): a carried
// deployment answers `model.call` through the carriage, and nothing the
// hosted entries load at run time reaches the code that holds, reads,
// refreshes or signs in the owner's plan token, which runs only in custody's
// process on the M5. Custody's process is forked by path, so the file a
// deployment names it by is no import of it.

import { describe, expect, it } from 'vitest';
import { carriedAnswers } from '../../apps/api/model-carriage.ts';
import { carrierSettings } from '../../apps/api/model-carrier.ts';
import { importGraph } from '../support/import-graph.ts';

const HOSTED = ['apps/api/function.ts', 'apps/api/server.ts'];

/** The plan token's code: its store, lock, refresh, holder and sign-in, and custody's process. */
const PLAN_TOKEN = [
  'packages/core-custody/src/token-file.ts',
  'packages/core-custody/src/token-lock.ts',
  'packages/core-custody/src/token-refresh.ts',
  'packages/core-custody/src/plan-token.ts',
  'packages/core-custody/src/plan-token-production.ts',
  'packages/core-custody/src/plan-sign-in.ts',
  'packages/core-custody/src/custody-plan.ts',
  'packages/core-custody/src/custody-main.ts',
  'apps/model-agent/chatgpt-sign-in.ts',
];

const AGENT = '0b6f3f0e-6d7e-4f60-9a3c-2f1e8a7c5d41';
const OWNER = '6c1f0d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f';

const CARRIED = {
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CARRIER: JSON.stringify({ agent: AGENT, people: [OWNER] }),
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
  MODEL_BROKER_CARRY_KEY: Buffer.alloc(32, 7).toString('base64url'),
  SUPABASE_REALTIME_URL: 'wss://project.example/realtime/v1',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_made_up',
};

describe('the hosted side of a carried task call', () => {
  it('reaches none of the plan token code from either hosted entry', () => {
    for (const entry of HOSTED) {
      const { files } = importGraph(entry);
      expect(PLAN_TOKEN.filter((file) => files.has(file))).toEqual([]);
    }
  });

  it("answers a carried deployment's model.call through the carriage", () => {
    const carried = carrierSettings(CARRIED);
    if (carried.kind !== 'carried') throw new Error(`refused: ${JSON.stringify(carried)}`);
    const answers = carriedAnswers(CARRIED, carried);
    expect(typeof answers.executeModelCall).toBe('function');
  });
});
