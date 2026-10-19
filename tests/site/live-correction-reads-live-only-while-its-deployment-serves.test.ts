// SPDX-License-Identifier: AGPL-3.0-only
//
// A correction reads live, or reverted, only while the written commit's deployment is the one
// serving the bound page: the project's current production deployment, read before and after
// the page capture, and the page's host assigned to it, read with each. Ready on production
// is not enough. Anything else is unknown with a person task, never live and never sent again.
// The providers are the double behind the guarded call's transport; nothing leaves the process.

import { describe, expect, it } from 'vitest';
import { json, line, type Provider } from './c80-site-provider.ts';
import { bound } from './c80-site-ports-bound.ts';
import { approved, publish, revert, serverUrl, useRegisterWorld, w } from './c80-register-world.ts';

useRegisterWorld();

/** Every write: the publish's advance, then any revert's contents write. */
const writes = (site: Provider) => site.sent.filter((sent) => sent.method !== 'GET');

describe.skipIf(serverUrl === undefined)(
  'a correction reads live only while its deployment serves the page',
  () => {
    it('reads the production deployment and the host’s alias before and after the capture', async () => {
      const id = await approved();
      const { site, ports } = await bound(id);
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'live' });
      const lookup = site.sent.findIndex((sent) => sent.target.startsWith('/v6/deployments'));
      expect(site.sent.slice(lookup + 1).map((sent) => line(sent))).toEqual([
        'GET /v13/deployments/dpl_merged',
        'GET /v9/projects/prj_site',
        'GET /v4/aliases/agency.example?projectId=prj_site',
        'GET /v13/deployments/dpl_merged',
        'GET /v9/projects/prj_site',
        'GET /v4/aliases/agency.example?projectId=prj_site',
        // Live: the review request read once, to name one left open.
        'GET /repos/agency/site/pulls/17',
      ]);
    });

    it('is unknown with a person task when another commit is the production deployment', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id);
      site.state.production = 'dpl_other';
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(raised).toEqual(['DEPLOYMENT_NOT_SERVING']);
      expect(writes(site)).toHaveLength(1);
      // Observed again, it is never sent again.
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(writes(site)).toHaveLength(1);
      expect(await w.stateOf(id)).toBe('unknown');
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'a correction whose deployment does not serve the page is unknown',
  () => {
    it('is unknown when another commit is promoted during the capture', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id, {
        onCapture: (double) => {
          if (double.state.newest !== undefined) double.state.production = 'dpl_other';
        },
      });
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(raised).toEqual(['DEPLOYMENT_NOT_SERVING']);
      expect(writes(site)).toHaveLength(1);
    });

    it("is unknown when the page's host is not one of the project's production domains", async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id);
      site.state.domains = ['client-b.example'];
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(raised).toEqual(['DEPLOYMENT_NOT_SERVING']);
    });

    it('is unknown when the production deployment cannot be read', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id);
      site.state.answers['GET api.vercel.com /v9/projects/'] = json({ error: 'down' }, 500);
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'unknown' });
      expect(raised).toEqual(['DEPLOYMENT_NOT_SERVING']);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'a revert reads reverted only while its deployment serves the page',
  () => {
    it('keeps the page live when another commit is promoted during the revert capture', async () => {
      const id = await approved();
      const { site, ports, raised } = await bound(id, {
        onCapture: (double) => {
          if (double.state.newest === 'dpl_reverted') double.state.production = 'dpl_merged';
        },
      });
      expect(await publish(id, ports())).toMatchObject({ kind: 'recorded', state: 'live' });
      expect(await revert(id, ports())).toMatchObject({ kind: 'recorded', state: 'live' });
      expect(raised).toEqual(['DEPLOYMENT_NOT_SERVING']);
      expect(writes(site)).toHaveLength(2);
    });
  },
);
