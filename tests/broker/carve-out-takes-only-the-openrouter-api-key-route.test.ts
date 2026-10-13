// SPDX-License-Identifier: AGPL-3.0-only
//
// A paid call leaves only by OpenRouter's own route: cloud, an API key, and
// this installation's. A cloud route of another provider, an OpenRouter route
// of another installation, and one filed as a subscription are each refused
// before any row or request; the route as configured is the control.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrokerRoute } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld, scopeOf, type PricedWorld } from './priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const routed =
  (change: (route: BrokerRoute) => BrokerRoute) => (broker: PricedWorld['broker']) => ({
    ...broker,
    routes: broker.routes.map((route) => (route.provider === 'openrouter' ? change(route) : route)),
  });

describe.skipIf(serverUrl === undefined)(
  'the carve-out takes only the OpenRouter API key route',
  () => {
    let p: PricedWorld;

    beforeAll(async () => {
      p = await pricedWorld('priced_route_only');
    }, 180_000);

    afterAll(async () => {
      await p?.stop();
    });

    it.each([
      [
        'a cloud route of another provider',
        (route: BrokerRoute) => ({ ...route, provider: 'replay' }),
        'LOCAL_MODEL_REQUIRED',
      ],
      [
        'an OpenRouter route of another installation',
        (route: BrokerRoute) => ({ ...route, installation: 'elsewhere' }),
        'LOCAL_MODEL_REQUIRED',
      ],
      [
        'an OpenRouter route filed as a subscription',
        (route: BrokerRoute) => ({ ...route, credentialKind: 'subscription' as const }),
        'LOCAL_MODEL_REQUIRED',
      ],
      // A local route takes no paid call: the unpriced seam's refusal of a priced one.
      [
        'an OpenRouter route marked local',
        (route: BrokerRoute) => ({ ...route, reach: 'local' as const }),
        'BUDGET_UNAVAILABLE',
      ],
    ])('%s: refused, no row, no request', async (_name, change, code) => {
      const asked = await p.question('What is due today?');
      const sent = p.openrouter.received.length;
      const result = await p.direct(scopeOf(p, asked), undefined, routed(change));
      expect(result).toMatchObject({ ok: false, code });
      expect(await p.calls(asked.conversationId)).toHaveLength(0);
      expect(p.openrouter.received.length).toBe(sent);
    });

    it('control: the configured route holds and sends once', async () => {
      const asked = await p.question('What is due today?');
      const sent = p.openrouter.received.length;
      expect(await p.direct(scopeOf(p, asked))).toMatchObject({ ok: true });
      expect(p.openrouter.received.length).toBe(sent + 1);
    });
  },
);
