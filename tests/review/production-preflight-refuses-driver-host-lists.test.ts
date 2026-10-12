// SPDX-License-Identifier: AGPL-3.0-only
import dns from 'node:dns';
import { afterEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { productionPreflight } from '../../scripts/ops/deploy.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('production preflight refuses a driver host list beginning with staging before connecting', async () => {
  // Any dial goes to loopback: the lane's own database when one is set, else nothing listening.
  const configured = process.env['DATABASE_ADMIN_URL'];
  const local = new URL(configured ?? 'postgresql://127.0.0.1:5432/postgres');
  if (local.hostname !== '127.0.0.1') throw new Error('Proof requires a loopback database');
  const staging = 'abcdefghijabcdefghij';
  const production = 'zyxwvutsrqzyxwvutsrq';
  const stagingHost = `db.${staging}.supabase.co`;
  const productionHost = `db.${production}.supabase.co`;
  const address = `postgresql://postgres:proof@${stagingHost}:${local.port},${productionHost}:${local.port}@${productionHost}:${local.port}/postgres`;

  // The real driver sees staging first, although WHATWG URL sees production.
  const driver = postgres(address);
  expect(driver.options.host).toStrictEqual([stagingHost, productionHost]);
  await driver.end();
  expect(new URL(address).hostname).toBe(productionHost);

  vi.stubEnv('STAGING_PROJECT_REF', staging);
  vi.stubEnv('PRODUCTION_PROJECT_REF', production);
  vi.stubEnv('DATABASE_ADMIN_URL', address);

  // Route the real driver's DNS requests to the loopback database.
  // Never contact staging, production or another hosted service.
  const dialled: string[] = [];
  vi.spyOn(dns, 'lookup').mockImplementation((...args: unknown[]) => {
    const [hostname, options] = args;
    if (typeof hostname !== 'string' || ![stagingHost, productionHost].includes(hostname))
      throw new Error('Proof attempted an unexpected host');
    dialled.push(hostname);
    const callback = args.at(-1);
    if (typeof callback !== 'function') throw new Error('No DNS callback');
    if (typeof options === 'object' && options !== null && 'all' in options && options.all)
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  });

  const signs = await productionPreflight();
  expect({ signs, dialled }).toMatchObject({ dialled: [] });
  expect(signs.length).toBeGreaterThan(0);
});
