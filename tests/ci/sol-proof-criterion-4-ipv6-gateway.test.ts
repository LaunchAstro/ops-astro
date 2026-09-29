// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type StagingNetwork = {
  enable_ipv6?: boolean;
  driver_opts?: Record<string, string>;
};

it('Sol proof, criterion 4: staging has no IPv6 host gateway under daemon defaults', () => {
  const path = new URL('../../deploy/staging/compose.json', import.meta.url);
  const definition = JSON.parse(readFileSync(path, 'utf8')) as {
    networks: { staging: StagingNetwork };
  };
  const network = definition.networks.staging;

  expect(
    network.enable_ipv6 === false ||
      network.driver_opts?.['com.docker.network.bridge.gateway_mode_ipv6'] === 'isolated',
  ).toBe(true);
});
