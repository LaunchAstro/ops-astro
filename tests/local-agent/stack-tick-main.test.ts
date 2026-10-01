// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the long-lived tick process reads what it ticks for from its
// environment and refuses before it opens anything: outside local, with no
// local-claude broker, or with a business, agent or worker it cannot name.

import { expect, it } from 'vitest';
import { tickSettings } from '../../apps/local-agent/tick-main.ts';

const BUSINESS = '00000000-0000-4000-8000-000000000001';
const WORKER = '00000000-0000-4000-8000-000000000002';

const env = (overrides: Record<string, string | undefined> = {}) => ({
  OPS_ENVIRONMENT: 'local',
  OPS_AGENT_PROVIDER: 'local-claude',
  DATABASE_URL: 'postgres://app@127.0.0.1:1/ops_astro_local',
  OPS_LOCAL_AGENT_BUSINESS_ID: BUSINESS,
  OPS_LOCAL_AGENT_AGENT_SUBJECT: 'agent-local-1',
  OPS_LOCAL_AGENT_WORKER_ACTOR_ID: WORKER,
  ...overrides,
});

it('the tick process reads its business, agent, worker and interval from the environment', () => {
  expect(tickSettings(env({ OPS_LOCAL_AGENT_TICK_SECONDS: '30' }))).toEqual({
    ok: true,
    settings: {
      databaseUrl: 'postgres://app@127.0.0.1:1/ops_astro_local',
      businessId: BUSINESS,
      agent: { provider: 'supabase', subject: 'agent-local-1' },
      workerActorId: WORKER,
      intervalMs: 30_000,
    },
  });
  expect(tickSettings(env())).toMatchObject({ ok: true, settings: { intervalMs: 60_000 } });
});

it.each([
  ['staging', { OPS_ENVIRONMENT: 'staging' }, 'LOCAL_ONLY'],
  ['unset environment', { OPS_ENVIRONMENT: undefined }, 'LOCAL_ONLY'],
  ['api provider', { OPS_AGENT_PROVIDER: 'api' }, 'PROVIDER_NOT_LOCAL'],
  ['no provider', { OPS_AGENT_PROVIDER: undefined }, 'PROVIDER_NOT_LOCAL'],
  ['no database', { DATABASE_URL: undefined }, 'SETTING_MISSING'],
  ['a business that is not an id', { OPS_LOCAL_AGENT_BUSINESS_ID: 'acme' }, 'SETTING_MISSING'],
  ['no agent', { OPS_LOCAL_AGENT_AGENT_SUBJECT: '' }, 'SETTING_MISSING'],
  ['no worker', { OPS_LOCAL_AGENT_WORKER_ACTOR_ID: undefined }, 'SETTING_MISSING'],
  ['an interval under 10 s', { OPS_LOCAL_AGENT_TICK_SECONDS: '5' }, 'SETTING_MISSING'],
])('the tick process refuses with %s', (_, overrides, code) => {
  expect(tickSettings(env(overrides))).toMatchObject({ ok: false, code });
});
