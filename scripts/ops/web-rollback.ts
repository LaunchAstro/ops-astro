// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's web rollback (#2299), `web-deploy.mjs --rollback <deployment>
// --production`: production back on a deployment its web deploy recorded,
// by Vercel's instant rollback (`vercel rollback`, vercel-cli.ts), under the
// operator's held grant. It asks for no build: the deployment Vercel already
// holds keeps the settings it was made with. A fresh deploy of the old version
// would read today's, which can be ahead of it (a route its API refuses), and
// with staging off it would need a release record the old version may lack.
// Vercel must read the deployment back ready on production first, since it
// answers a rollback to any other by building a new one with today's settings.
// `rollback recorded` is written only once Vercel's rollback finished; Vercel
// then gives later deployments no domain until one is promoted, which
// production's next deploy does (`deployWeb`).

import { type Authorised, heldFor } from './authorised-act.ts';
import { recordedProduction } from './deployment-record.ts';
import { rollBack } from './vercel-cli.ts';
import { settingProblems } from './version-checks.ts';
import { inFolder, refused, type Unrecorded } from './web-deploy.ts';

type Environment = Readonly<Record<string, string | undefined>>;

/** Production's rollback, recorded as `rollback recorded` (#2299). */
export interface WebRollbackRecord {
  readonly action: 'rollback recorded';
  readonly environment: 'production';
  readonly version: string;
  readonly deployment: string;
}

/** Production back on `deployment`, recorded, or why not: no release or staging record is asked. */
export async function rollBackWeb(
  deployment: string,
  options: { env: Environment; records: string; authorised: Authorised },
): Promise<Unrecorded | { kind: 'deployed'; record: WebRollbackRecord }> {
  const settings = settingProblems(options.env);
  if (settings.length > 0) return refused(settings.join('; '));
  const recorded = recordedProduction(options.records, deployment);
  if ('why' in recorded) return refused(recorded.why);
  const { version } = recorded;
  return await inFolder(async (folder) => {
    const answer = await heldFor(options.authorised, () => {
      const unrecorded = rollBack(folder, options.env, deployment);
      if (unrecorded !== undefined) return unrecorded;
      const record = {
        action: 'rollback recorded',
        environment: 'production',
        version,
        deployment,
      } as const;
      return { kind: 'deployed', record } as const;
    });
    return 'refused' in answer ? refused(answer.refused) : answer.ran;
  });
}
