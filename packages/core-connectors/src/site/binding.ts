// SPDX-License-Identifier: AGPL-3.0-only
//
// The publish binding: the runner's provider ports for one correction's
// proposal, each a catalogued operation through the one guarded call
// (`callConnector`), nothing added to what the connector definition sends.
//
// - The source is the site file on the default branch, decoded as UTF-8.
// - The publish is the merge of the proposal's request at the head it was
//   proposed at (`sha`), so a branch moved since is refused by the provider,
//   never merged. The merge carries no idempotency parameter: a second merge
//   of the same request answers `not_mergeable`, and that answer is read back
//   by the request's merge state. Merged already (another worker's, under a
//   lease that lapsed) is `unknown`, never `failed`; still unmerged is the
//   nothing-happened refusal it says it is.
// - The deployment is found by the merged commit, a bounded number of tries
//   while the hosting provider creates it. Not found, or found for another
//   commit, is `unknown`: the merge happened.
// - The revert writes the pre-image back on the default branch, only over the
//   published change and at the blob just read, and finds its deployment the
//   same way.
//
// A publish or revert for any seam but the proposal's branch sends nothing.

import { callConnector, type CallDependencies, type ProviderResult } from '../call.ts';
import { siteOperation } from './operations.ts';
import type { Published } from './publish.ts';

/** One correction's proposal on its providers. */
export interface SiteBinding {
  readonly repository: string;
  readonly path: string;
  readonly defaultBranch: string;
  /** The hosting project the default branch deploys to. */
  readonly project: string;
  /** The correction's catalogued page. */
  readonly pageUrl: string;
  /** The branch is the correction's seam; the head is the commit the request was opened at. */
  readonly proposal: { readonly branch: string; readonly request: string; readonly head: string };
  readonly change: { readonly before: string; readonly after: string };
}

export interface BindingDependencies extends CallDependencies {
  /** Between deployment lookups; the binding never sleeps on its own clock. */
  readonly wait: (ms: number) => Promise<void>;
}

export const LOOKUP_ATTEMPTS = 6;
export const LOOKUP_WAIT_MS = 5_000;

type Deployed = { readonly revision: string; readonly deploymentId: string };
type Refused = Extract<ProviderResult<never>, { readonly kind: 'refused' }>;

const call = async (
  name: string,
  params: Readonly<Record<string, string>>,
  deps: CallDependencies,
) => await callConnector(siteOperation(name), params, deps);

function stop(kind: 'refused' | 'unknown', code: string, deps: CallDependencies) {
  deps.record(code);
  return { kind, code } as const;
}

const ok = <T>(value: T) => ({ kind: 'ok', value }) as const;

function decoded(base64: string): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(base64, 'base64'));
  } catch {
    return undefined;
  }
}

/** `site.source.read`: the site file on the default branch, its blob as the revision. */
export async function readSiteSource(
  binding: SiteBinding,
  deps: CallDependencies,
): Promise<ProviderResult<{ content: string; revision: string }>> {
  const read = await call(
    'site.source.read',
    { repository: binding.repository, path: binding.path },
    deps,
  );
  if (read.kind !== 'ok') return read;
  const content =
    read.value['encoding'] === 'base64' ? decoded(String(read.value['content'])) : undefined;
  if (content === undefined) return stop('refused', 'PROVIDER_RESPONSE_MALFORMED', deps);
  return ok({ content, revision: String(read.value['sha']) });
}

/** `site.deployment.lookup` by commit, tried until found or the attempts run out. */
async function deploymentOf(
  binding: SiteBinding,
  commit: string,
  deps: BindingDependencies,
  attempt = 1,
): Promise<ProviderResult<Deployed>> {
  const found = await call(
    'site.deployment.lookup',
    { project: binding.project, sha: commit },
    deps,
  );
  if (found.kind === 'ok') {
    if (found.value['deployments.0.meta.githubCommitSha'] !== commit)
      return stop('unknown', 'DEPLOYMENT_COMMIT_MISMATCH', deps);
    return ok({ revision: commit, deploymentId: String(found.value['deployments.0.uid']) });
  }
  if (attempt >= LOOKUP_ATTEMPTS) return stop('unknown', 'DEPLOYMENT_NOT_FOUND', deps);
  await deps.wait(LOOKUP_WAIT_MS);
  return await deploymentOf(binding, commit, deps, attempt + 1);
}

/** `site.request.read` after `not_mergeable`: merged already is unknown, never failed. */
async function mergeState(
  binding: SiteBinding,
  refusal: Refused,
  deps: CallDependencies,
): Promise<ProviderResult<never>> {
  const state = await call(
    'site.request.read',
    { repository: binding.repository, number: binding.proposal.request },
    deps,
  );
  if (state.kind !== 'ok') return stop('unknown', 'MERGE_STATE_UNREAD', deps);
  if (state.value['merged'] !== false) return stop('unknown', 'REQUEST_ALREADY_MERGED', deps);
  return refusal;
}

/** `site.publish`: the merge at the proposed head, then its deployment by the merged commit. */
export async function mergeAndFind(
  binding: SiteBinding,
  input: { readonly seam: string },
  deps: BindingDependencies,
): Promise<ProviderResult<Published>> {
  if (input.seam !== binding.proposal.branch) return stop('refused', 'SEAM_MISMATCH', deps);
  const { repository, proposal } = binding;
  const merged = await call(
    'site.publish',
    { repository, number: proposal.request, sha: proposal.head },
    deps,
  );
  if (merged.kind === 'refused' && merged.proof === 'not_mergeable')
    return await mergeState(binding, merged, deps);
  if (merged.kind !== 'ok') return merged;
  if (merged.value['merged'] !== true) return stop('unknown', 'MERGE_NOT_CONFIRMED', deps);
  const deployed = await deploymentOf(binding, String(merged.value['sha']), deps);
  if (deployed.kind !== 'ok') return deployed;
  return ok({ ...deployed.value, liveUrl: binding.pageUrl });
}

/** `site.deployment.read`: served is ready on production; the revision is its commit. */
export async function readServed(
  deploymentId: string,
  deps: CallDependencies,
): Promise<ProviderResult<{ revision: string; served: boolean }>> {
  const read = await call('site.deployment.read', { deployment: deploymentId }, deps);
  if (read.kind !== 'ok') return read;
  return ok({
    revision: String(read.value['meta.githubCommitSha']),
    served: read.value['readyState'] === 'READY' && read.value['target'] === 'production',
  });
}

/** `site.source.revert`: the pre-image back over the published change, then its deployment. */
export async function revertForward(
  binding: SiteBinding,
  input: { readonly seam: string },
  deps: BindingDependencies,
): Promise<ProviderResult<Deployed>> {
  if (input.seam !== binding.proposal.branch) return stop('refused', 'SEAM_MISMATCH', deps);
  const current = await readSiteSource(binding, deps);
  if (current.kind !== 'ok') return current;
  if (current.value.content !== binding.change.after)
    return stop('refused', 'CONTENT_DRIFTED', deps);
  const written = await call(
    'site.source.revert',
    {
      repository: binding.repository,
      path: binding.path,
      message: `Revert live correction ${binding.proposal.branch}`,
      content: Buffer.from(binding.change.before, 'utf8').toString('base64'),
      sha: current.value.revision,
      branch: binding.defaultBranch,
    },
    deps,
  );
  if (written.kind !== 'ok') return written;
  return await deploymentOf(binding, String(written.value['commit.sha']), deps);
}
