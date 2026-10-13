// SPDX-License-Identifier: AGPL-3.0-only
//
// `operations.read` carries the installation's service health and error sink
// link only to the business that operates the installation
// (`ops.installation.operator_business_id`), the rule its security alerts
// follow. Another business whose person holds `operations:read` is shown
// neither, and no health source is asked for it. It goes red if the API adds
// the installation's sections to every business's answer. No database: a
// stand-in pool answers which business operates the installation.

import { expect, it, vi } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import type { HealthSource } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

const OPERATOR = 'business-operator';
const OTHER = 'business-other';
const SINK = { url: 'https://errors.example.test' };

function build() {
  const observe = vi.fn(async () => await Promise.resolve({ ok: true as const, services: [] }));
  const tracing: HealthSource = { observe };
  const database = {
    withBusiness: async (businessId: string, run: (tx: unknown) => Promise<unknown>) =>
      await run({
        businessId,
        query: async () => await Promise.resolve([{ operates: businessId === OPERATOR }]),
      }),
  } as unknown as Database;
  const api = createApi({
    database,
    verify: async () => await Promise.resolve({ provider: 'test', subject: 'holder' }),
    resolveBusiness: async (key) =>
      await Promise.resolve({ operator: OPERATOR, other: OTHER }[key as 'operator']),
    executeRead: (async () => await Promise.resolve({ ok: true, securityAlerts: [] })) as never,
    executeCommand: vi.fn() as never,
    health: { tracing },
    errorSink: SINK,
  });
  return { api, observe };
}

const read = async (api: ReturnType<typeof createApi>, key: string) => {
  const response = await api.fetch(
    new Request(`http://api.test/api/b/${key}/operations/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer stand-in' },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
};

it('another business is shown neither the service health nor the error sink, and asks no source', async () => {
  const { api, observe } = build();
  const answer = await read(api, 'other');
  expect(answer).not.toHaveProperty('serviceHealth');
  expect(answer['errorSink']).toBeNull();
  expect(observe).not.toHaveBeenCalled();
});

it('the operating business is shown both', async () => {
  const { api, observe } = build();
  const answer = await read(api, 'operator');
  expect(answer).toHaveProperty('serviceHealth');
  expect(answer['errorSink']).toEqual(SINK);
  expect(observe).toHaveBeenCalledTimes(1);
});
