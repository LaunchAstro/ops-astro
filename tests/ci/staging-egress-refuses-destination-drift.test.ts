// SPDX-License-Identifier: AGPL-3.0-only
// An egress setting must not substitute another host for the staged API.

import { expect, it } from 'vitest';

const modulePath = '../../scripts/ops/egress.mjs';
const { allowList } = (await import(
  /* @vite-ignore */
  modulePath
)) as { allowList: (env: Record<string, string>) => [string, number][] };

it('staging egress refuses an API destination that differs from the worker API URL', () => {
  const configured = {
    STAGING_WEB_URL: 'https://api.example.test',
    OPS_EGRESS_API_HOST: 'elsewhere.example.test',
    OPS_EGRESS_POOLER_HOST: 'aws-0-ap-southeast-2.pooler.supabase.com',
    OPS_EGRESS_POOLER_PORT: '6543',
    OPS_EGRESS_HEARTBEAT_HOST: 'heartbeat.example.test',
    OPS_EGRESS_SINK_HOST: 'sink.example.test',
  };

  expect(allowList(configured)).not.toContainEqual(['elsewhere.example.test', 443]);
});
