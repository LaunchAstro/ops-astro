// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up values for the staging worker unit's settings, so the live suites can
// bring deploy/staging/compose.json up (Compose refuses an unset placeholder).

export const WORKER_UNIT: Readonly<Record<string, string>> = {
  STAGING_WEB_URL: 'https://staging.example.test',
  STAGING_WORKER_BUSINESS: 'unused',
  STAGING_WORKER_TOKEN: 'unused',
  STAGING_WORKER_DELEGATION: 'unused',
  STAGING_WORKER_HEARTBEAT_URL: 'https://heartbeat.example.test/w',
  STAGING_FORWARDER_DATABASE_URL: 'postgres://unused',
  STAGING_ERROR_SINK_DSN: 'https://unused@example.test/1',
  STAGING_RELEASE: '0123456789ab',
  STAGING_FORWARDER_HEARTBEAT_URL: 'https://heartbeat.example.test/f',
  STAGING_SINK_HEARTBEAT_URL: 'https://heartbeat.example.test/s',
  STAGING_EGRESS_API_HOST: 'api.example.test',
  STAGING_EGRESS_POOLER_HOST: 'pooler.example.test',
  STAGING_EGRESS_POOLER_PORT: '6543',
  STAGING_EGRESS_HEARTBEAT_HOST: 'beat.example.test',
  STAGING_EGRESS_SINK_HOST: 'sink.example.test',
};
