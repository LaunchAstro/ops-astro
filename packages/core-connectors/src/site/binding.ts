// SPDX-License-Identifier: AGPL-3.0-only
//
// The publish binding: the runner's provider ports for one correction's
// proposal, each a catalogued operation through the one guarded call
// (`callConnector`), nothing added to what the connector definition sends.
// Nothing here holds a credential: the call borrows one per request.
//
// - The source is the site file on the default branch, decoded as UTF-8 from
//   canonical base64 only.
// - The publish is the merge of the proposal's request at the head it was
//   proposed at (`sha`), so a branch moved since is refused by the provider,
//   never merged. Only the version the proposal's bytes are is merged: any
//   other approved version is `PROPOSAL_SUPERSEDED`, with nothing sent. The
//   merge carries no idempotency parameter: a second merge of the same
//   request answers `not_mergeable`, and that answer is read back by the
//   request's merge state. Merged already (another worker's, under a lease
//   that lapsed) is `unknown`, never `failed`; still unmerged is the
//   nothing-happened refusal it says it is.
// - The deployment is found by the merged commit, a bounded number of tries
//   while the hosting provider creates it. Not found, or found for another
//   commit, is `unknown`: the merge happened.
// - The revert writes the pre-image back on the default branch, only over the
//   published change and at the blob just read, and finds its deployment the
//   same way.
//
// A publish or revert for any seam but the proposal's branch sends nothing.
//
// A binding is made only by `siteBindingFor`, from the correction's own
// party's site: the one place a party is mapped to its pages and their source
// files (#989 criterion 2). A correction of another party, or on a page or
// file the site does not hold spelt exactly, binds to nothing.

import { callConnector, type CallDependencies, type ProviderResult } from '../call.ts';
import { siteOperation } from './operations.ts';
import type { Published } from './publish.ts';

/** One party's site: its providers, and each catalogued page with its source file. */
export interface PartySite {
  readonly partyId: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly project: string;
  readonly pages: readonly { readonly pageUrl: string; readonly path: string }[];
}

/** One correction's proposal on its party's providers. */
export interface SiteBinding {
  readonly partyId: string;
  readonly repository: string;
  readonly path: string;
  readonly defaultBranch: string;
  /** The hosting project the default branch deploys to. */
  readonly project: string;
  /** The correction's catalogued page. */
  readonly pageUrl: string;
  /**
   * The branch is the correction's seam; the head is the commit the request
   * was opened at; the version digest is the version whose bytes it proposed.
   */
  readonly proposal: {
    readonly branch: string;
    readonly request: string;
    readonly head: string;
    readonly versionDigest: string;
  };
  readonly change: { readonly before: string; readonly after: string };
}

export interface BindingDependencies extends CallDependencies {
  /** Between deployment lookups; the binding never sleeps on its own clock. */
  readonly wait: (ms: number) => Promise<void>;
}

/** The stored correction a binding is made from and checked against. */
export interface BoundCorrection {
  readonly partyId: string;
  readonly pageUrl: string;
  readonly targetPath: string;
  readonly seam: string;
}

export type MadeBinding =
  | { readonly ok: true; readonly binding: SiteBinding }
  | { readonly ok: false; readonly code: 'PARTY_SITE_MISMATCH' | 'PAGE_OUTSIDE_PARTY_SITE' };

/**
 * The correction's binding on its own party's site, or the refusal: another
 * party's site, or a page and file the site does not hold as one pair, byte
 * for byte (no other spelling is read as the same page).
 */
export function siteBindingFor(
  site: PartySite,
  correction: BoundCorrection,
  made: Pick<SiteBinding, 'change'> & {
    readonly proposal: Omit<SiteBinding['proposal'], 'branch'>;
  },
): MadeBinding {
  if (correction.partyId !== site.partyId) return { ok: false, code: 'PARTY_SITE_MISMATCH' };
  const held = site.pages.some(
    (page) => page.pageUrl === correction.pageUrl && page.path === correction.targetPath,
  );
  if (!held) return { ok: false, code: 'PAGE_OUTSIDE_PARTY_SITE' };
  const { partyId, repository, defaultBranch, project } = site;
  return {
    ok: true,
    binding: {
      partyId,
      repository,
      path: correction.targetPath,
      defaultBranch,
      project,
      pageUrl: correction.pageUrl,
      proposal: { branch: correction.seam, ...made.proposal },
      change: made.change,
    },
  };
}

/** The refusal of a correction this binding was not made from, or nothing. */
export function bindingRefuses(
  binding: SiteBinding,
  correction: BoundCorrection,
): string | undefined {
  const same =
    correction.partyId === binding.partyId &&
    correction.pageUrl === binding.pageUrl &&
    correction.targetPath === binding.path &&
    correction.seam === binding.proposal.branch;
  return same ? undefined : 'BINDING_NOT_THIS_CORRECTION';
}

const LOOKUP_ATTEMPTS = 6;
const LOOKUP_WAIT_MS = 5_000;

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

/**
 * The text a provider's base64 encodes, line breaks aside, or undefined
 * unless it is the canonical encoding of valid UTF-8: decoding and encoding
 * again must give back exactly what was sent.
 */
function decoded(base64: string): string | undefined {
  const joined = base64.split('\n').join('');
  const bytes = Buffer.from(joined, 'base64');
  if (bytes.toString('base64') !== joined) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
  input: { readonly seam: string; readonly versionDigest: string },
  deps: BindingDependencies,
): Promise<ProviderResult<Published>> {
  if (input.seam !== binding.proposal.branch) return stop('refused', 'SEAM_MISMATCH', deps);
  if (input.versionDigest !== binding.proposal.versionDigest)
    return stop('refused', 'PROPOSAL_SUPERSEDED', deps);
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
