// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type StagingNetwork = {
  internal?: boolean;
  driver?: string;
  driver_opts?: Record<string, string>;
};

it('the staging bridge has no reachable host gateway', () => {
  const path = new URL('../../deploy/staging/compose.json', import.meta.url);
  const definition = JSON.parse(readFileSync(path, 'utf8')) as {
    networks: { staging: StagingNetwork };
  };
  const network = definition.networks.staging;

  expect(network.internal).toBe(true);
  if (network.driver === undefined || network.driver === 'bridge') {
    expect(network.driver_opts?.['com.docker.network.bridge.gateway_mode_ipv4']).toBe('isolated');
  }
});
