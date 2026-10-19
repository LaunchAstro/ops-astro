// SPDX-License-Identifier: AGPL-3.0-only
//
// The publish binding: the runner's provider ports for one correction's
// proposal, each a catalogued operation through the one guarded call
// (`callConnector`), nothing added to what the connector definition sends.
// Nothing here holds a credential: the call borrows one per request.
//
// - The source is the site file on the default branch, decoded as UTF-8 from
//   canonical base64 only.
// - Publish is the advance (`advance.ts`): the default branch moved to the
//   proposal's head from the approved base, a fast-forward only.
// - The deployment is found by that commit, a bounded number of tries.
//   Found for another commit is unknown after the advance; not found yet is not
//   published yet, accepted without it and looked up again when observed.
// - The revert writes the pre-image back on the default branch, only over the
//   published change and at the blob just read, and finds its deployment the
//   same way.
//
// A publish or revert for any seam but the proposal's branch sends nothing.
//
// A binding is made only by `siteBindingFor`, from the correction's own
// party's site: the one place a party is mapped to its pages and their source
// files (#989 criterion 2). A correction of another party, or on a page or
// file the site does not hold spelt exactly, binds to nothing; nor do bytes
// that are not the version the proposal names, so a revert writes back only
// the approved pre-image.

import {
  callConnector,
  type CallDependencies,
  type ConnectorResult,
  type ProviderResult,
} from '../call.ts';
import { siteOperation } from './operations.ts';
import { findDeployment } from './serving.ts';
import { versionDigestOf, type VersionPin } from './version.ts';

export { findDeployment, readServed } from './serving.ts';

/**
 * One party's site, or the business's own (party null, R6): its providers, and each catalogued
 * page with its source file.
 */
export interface PartySite {
  readonly partyId: string | null;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly project: string;
  readonly pages: readonly { readonly pageUrl: string; readonly path: string }[];
}

/** One correction's proposal on its party's providers. */
export interface SiteBinding {
  readonly partyId: string | null;
  readonly repository: string;
  readonly path: string;
  readonly defaultBranch: string;
  /** The hosting project the default branch deploys to. */
  readonly project: string;
  /** The correction's catalogued page. */
  readonly pageUrl: string;
  /** The default branch's head the pre-image was pinned at: the one commit the publish advances from. */
  readonly baseRevision: string;
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
  readonly partyId: string | null;
  readonly pageUrl: string;
  readonly targetPath: string;
  readonly seam: string;
}

export type MadeBinding =
  | { readonly ok: true; readonly binding: SiteBinding }
  | { readonly ok: false; readonly code: SiteRefusal };

type SiteRefusal = 'PARTY_SITE_MISMATCH' | 'PAGE_OUTSIDE_PARTY_SITE' | 'PROPOSAL_SUPERSEDED';

/**
 * Another party's site, or a page and file the site does not hold as one
 * pair, byte for byte (no other spelling is read as the same page); else nothing.
 */
export function partySiteRefuses(
  site: PartySite,
  correction: BoundCorrection,
): SiteRefusal | undefined {
  if (correction.partyId !== site.partyId) return 'PARTY_SITE_MISMATCH';
  const held = site.pages.some(
    (page) => page.pageUrl === correction.pageUrl && page.path === correction.targetPath,
  );
  return held ? undefined : 'PAGE_OUTSIDE_PARTY_SITE';
}

/**
 * The correction's binding on its own party's site, or `partySiteRefuses`'s refusal. The change is
 * the bytes of the version the proposal names, rebuilt with that version's pin, or nothing binds.
 */
export function siteBindingFor(
  site: PartySite,
  correction: BoundCorrection,
  made: Pick<SiteBinding, 'change'> & {
    readonly proposal: Omit<SiteBinding['proposal'], 'branch'>;
    readonly version: Omit<VersionPin, 'change'>;
  },
): MadeBinding {
  const code = partySiteRefuses(site, correction);
  if (code !== undefined) return { ok: false, code };
  const files = [{ path: correction.targetPath, ...made.change }];
  if (versionDigestOf({ ...made.version, change: { files } }) !== made.proposal.versionDigest)
    return { ok: false, code: 'PROPOSAL_SUPERSEDED' };
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
      baseRevision: made.version.baseRevision,
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

/** One catalogued site operation through the guarded call. */
export const call = async (
  name: string,
  params: Readonly<Record<string, string>>,
  deps: CallDependencies,
): Promise<ConnectorResult> => await callConnector(siteOperation(name), params, deps);

/** A refusal or unknown, its code recorded for the receipt. */
export function stop<K extends 'refused' | 'unknown'>(
  kind: K,
  code: string,
  deps: CallDependencies,
): { readonly kind: K; readonly code: string } {
  deps.record(code);
  return { kind, code };
}

export const ok = <T>(value: T): { readonly kind: 'ok'; readonly value: T } => ({
  kind: 'ok',
  value,
});

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
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
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
    { repository: binding.repository, path: binding.path, ref: binding.defaultBranch },
    deps,
  );
  if (read.kind !== 'ok') return read;
  const content =
    read.value['encoding'] === 'base64' ? decoded(String(read.value['content'])) : undefined;
  if (content === undefined) return stop('refused', 'PROVIDER_RESPONSE_MALFORMED', deps);
  return ok({ content, revision: String(read.value['sha']) });
}

/** `findDeployment`, tried until found or the attempts run out. */
export async function deploymentOf(
  binding: SiteBinding,
  commit: string,
  deps: BindingDependencies,
  attempt = 1,
): Promise<ProviderResult<string | undefined>> {
  const found = await findDeployment(binding, commit, deps);
  if (found.kind !== 'ok' || found.value !== undefined || attempt >= LOOKUP_ATTEMPTS) return found;
  await deps.wait(LOOKUP_WAIT_MS);
  return await deploymentOf(binding, commit, deps, attempt + 1);
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
  const revision = String(written.value['commit.sha']);
  const deployed = await deploymentOf(binding, revision, deps);
  if (deployed.kind !== 'ok') return deployed;
  if (deployed.value === undefined) return stop('unknown', 'DEPLOYMENT_NOT_FOUND', deps);
  return ok({ revision, deploymentId: deployed.value });
}
