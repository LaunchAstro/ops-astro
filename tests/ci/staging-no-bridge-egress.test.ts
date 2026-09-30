// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type Staging = {
  services: Record<string, { networks: string[] | Record<string, unknown> }>;
  networks: Record<string, { internal?: boolean }>;
};

it('every staging container has no bridge egress route', () => {
  const path = new URL('../../deploy/staging/compose.json', import.meta.url);
  const staging = JSON.parse(readFileSync(path, 'utf8')) as Staging;
  const outbound = Object.entries(staging.services).flatMap(([service, config]) =>
    (Array.isArray(config.networks) ? config.networks : Object.keys(config.networks))
      .filter((network) => staging.networks[network]?.internal !== true)
      .map((network) => `${service} -> ${network}`),
  );

  // The one way out: egress-out, alone on its network (S0-1 egress allow-list).
  expect(outbound).toEqual(['egress-out -> egress']);
});
