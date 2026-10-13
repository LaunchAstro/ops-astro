// SPDX-License-Identifier: AGPL-3.0-only
//
// The serving check: a correction reads live, or reverted, only while the
// written commit's deployment is the one serving the bound page. Ready on
// production is not that: another commit may be promoted around ours, and the
// page's host may not be one of the project's production domains. So the
// deployment counts as served only while it is also the project's production
// deployment now (`site.deployment.current`) and the page's host is assigned
// to it (`site.deployment.alias`, read once per run). The observe path reads
// it before and after the page capture. A read that fails, or answers another
// deployment, is unknown: never live, and nothing is sent again for it.

import { callConnector, type CallDependencies, type ProviderResult } from '../call.ts';
import { siteOperation } from './operations.ts';

export type Served = { readonly revision: string; readonly served: boolean };
type ReadDeployment = (deploymentId: string) => Promise<ProviderResult<Served>>;

const call = async (
  name: string,
  params: Readonly<Record<string, string>>,
  deps: CallDependencies,
) => await callConnector(siteOperation(name), params, deps);

/** `site.deployment.read`: served is ready on production; the revision is its commit. */
export async function readServed(
  deploymentId: string,
  deps: CallDependencies,
): Promise<ProviderResult<Served>> {
  const read = await call('site.deployment.read', { deployment: deploymentId }, deps);
  if (read.kind !== 'ok') return read;
  return {
    kind: 'ok',
    value: {
      revision: String(read.value['meta.githubCommitSha']),
      served: read.value['readyState'] === 'READY' && read.value['target'] === 'production',
    },
  };
}

/**
 * Each observation's deployment read for the bound page: served only while the deployment is also the
 * project's production deployment now and the page's host is assigned to it; else unknown.
 */
export function readServing(
  site: { readonly project: string; readonly pageUrl: string },
  deps: CallDependencies,
): ReadDeployment {
  const { project } = site;
  const host = URL.parse(site.pageUrl)?.hostname ?? '';
  // Each observation reads the alias afresh: the ports outlive one run, and a host
  // reassigned or a read that failed must not answer for a later observation.
  return async (deploymentId) => {
    const deployment = await readServed(deploymentId, deps);
    if (deployment.kind !== 'ok' || !deployment.value.served) return deployment;
    const current = await call('site.deployment.current', { project }, deps);
    const alias = await call('site.deployment.alias', { host, project }, deps);
    const serving =
      current.kind === 'ok' &&
      current.value['id'] === project &&
      current.value['targets.production.id'] === deploymentId &&
      alias.kind === 'ok' &&
      alias.value['alias'] === host &&
      alias.value['projectId'] === project &&
      alias.value['deploymentId'] === deploymentId;
    if (serving) return deployment;
    deps.record('DEPLOYMENT_NOT_SERVING');
    return { kind: 'unknown', code: 'DEPLOYMENT_NOT_SERVING' };
  };
}

/**
 * The page captured between two deployment reads, each served at this revision: `pending`
 * while the first finds it not served yet, `unserved` when either is unknown or the second
 * finds it no longer served (another deployment promoted while the page was read).
 */
export async function whileServed<T extends object>(
  read: ReadDeployment,
  deployed: { readonly deploymentId: string; readonly revision: string },
  capture: () => Promise<T>,
): Promise<T | 'pending' | 'unserved'> {
  const served = async () => {
    const answer = await read(deployed.deploymentId);
    if (answer.kind === 'unknown') return 'unserved';
    const ok = answer.kind === 'ok' && answer.value.served;
    return ok && answer.value.revision === deployed.revision ? 'served' : 'pending';
  };
  const before = await served();
  if (before !== 'served') return before;
  const captured = await capture();
  return (await served()) === 'served' ? captured : 'unserved';
}
