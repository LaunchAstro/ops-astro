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
  OPS_LOCAL_AGENT_HOME: '/var/empty/la1-agent',
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
      gate: { home: '/var/empty/la1-agent', capUsd: 10, capConfigured: false, usageFile: null },
    },
  });
  expect(tickSettings(env())).toMatchObject({ ok: true, settings: { intervalMs: 60_000 } });
});

it("the tick process reads the runner's cap and seat the way the runner does", () => {
  expect(
    tickSettings(
      env({
        OPS_LOCAL_AGENT_CAP_USD: '7.50',
        OPS_LOCAL_AGENT_SEAT: 'hey',
        OPS_LOCAL_AGENT_SEAT_USAGE_FILE: '/var/empty/usage.json',
      }),
    ),
  ).toMatchObject({
    ok: true,
    settings: {
      gate: {
        home: '/var/empty/la1-agent',
        capUsd: 7.5,
        seat: 'hey',
        usageFile: '/var/empty/usage.json',
      },
    },
  });
});

it.each([
  'postgres://app@127.0.0.1:54390/ops_astro_local',
  'postgres://app@localhost:54390/ops_astro_local',
  'postgres://app@[::1]:54390/ops_astro_local',
])('the tick process takes a database on this machine: %s (review 2 M5)', (url) => {
  expect(tickSettings(env({ DATABASE_URL: url }))).toMatchObject({ ok: true });
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
  ['a runner folder that is not absolute', { OPS_LOCAL_AGENT_HOME: 'agent' }, 'SETTING_MISSING'],
  ['a cap that is not dollars', { OPS_LOCAL_AGENT_CAP_USD: 'ten' }, 'SETTING_MISSING'],
  ['a cap of nothing', { OPS_LOCAL_AGENT_CAP_USD: '0' }, 'SETTING_MISSING'],
  [
    'a database on another machine (review 2 M5)',
    { DATABASE_URL: 'postgres://db.example.com:5432/ops_astro' },
    'DATABASE_NOT_LOCAL',
  ],
  [
    'a database host that only starts with a loopback name (review 2 M5)',
    { DATABASE_URL: 'postgres://127.0.0.1.example.com:5432/ops_astro' },
    'DATABASE_NOT_LOCAL',
  ],
  ['a database address that is not a URL', { DATABASE_URL: 'not a url' }, 'DATABASE_NOT_LOCAL'],
])('the tick process refuses with %s', (_, overrides, code) => {
  expect(tickSettings(env(overrides))).toMatchObject({ ok: false, code });
});
