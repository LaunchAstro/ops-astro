// SPDX-License-Identifier: AGPL-3.0-only
//
// One site runner pass in a process of its own, for the restart case in
// site-runner-host.test.ts: its own database connection, its own custody over
// the served providers, the claim it is handed as JSON on argv, and the pass's
// outcome printed as JSON. The parent then ends it and runs the next pass.

import { connect, type BusinessId } from '../../packages/core-records/src/index.ts';
import { createSiteRunner, type Claim } from '../../apps/site-runner/runner.ts';
import type { ConfiguredSite } from '../../apps/site-runner/configured.ts';
import { custodyOver, sitesOver, type Served } from './site-runner-servers.ts';

interface Handed {
  readonly appUrl: string;
  readonly business: BusinessId;
  readonly actorId: string;
  readonly site: ConfiguredSite;
  readonly claim: Claim;
  readonly served: Pick<Served, 'origins' | 'credentialsFile'>;
}

const handed = JSON.parse(process.argv[2] ?? '{}') as Handed;
const db = connect(handed.appUrl);
const custody = await custodyOver({
  ...handed.served,
  authorizations: [],
  close: () => Promise.resolve(),
});
const raised: string[] = [];
let taken = false;
const runner = createSiteRunner({
  db,
  business: handed.business,
  site: handed.site,
  actorId: handed.actorId,
  claims: {
    take: () => Promise.resolve(taken ? [] : ((taken = true), [handed.claim])),
    beat: () => Promise.resolve(true),
    release: () => Promise.resolve(),
  },
  sites: sitesOver(custody, handed.served.origins, Date.now, handed.site),
  raiseTask: (_claim, reason) => {
    raised.push(reason);
    return Promise.resolve();
  },
  now: Date.now,
});
const passed = await runner.pass();
process.stdout.write(`${JSON.stringify({ passed, raised })}\n`);
await custody.stop();
await db.close();
