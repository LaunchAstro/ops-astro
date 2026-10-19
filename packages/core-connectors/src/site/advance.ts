// SPDX-License-Identifier: AGPL-3.0-only
//
// The publish (`site.source.advance`, #1986): the default branch advanced to
// the proposal's head, its one commit on the approved base. It is sent only while the file is the pre-image, the
// branch's protection refuses any rewind or deletion of it (administrators
// included), its head is the approved base, and the review request's head is
// still the proposal's (`REQUEST_HEAD_MOVED` otherwise); the provider applies a
// fast-forward only. So the branch moves from the approved base to the base
// and the approved file, or not at all, and the review request closes as
// merged. It counts only once the branch's head reads as the proposal's.
// The deployment is found by that commit, as `binding.ts` finds the revert's.

import type { CallDependencies, ProviderResult, ProviderValue } from '../call.ts';
import {
  call,
  deploymentOf,
  ok,
  readSiteSource,
  stop,
  type BindingDependencies,
  type SiteBinding,
} from './binding.ts';
import { checkEnvelope } from './envelope.ts';
import type { Published, PublishPorts } from './publish.ts';
import type { ReadBack } from './reconcile.ts';
import { contentDigest, versionDigestOf } from './version.ts';

/** `site.source.head`: the default branch's head commit now. */
async function headOf(
  binding: SiteBinding,
  deps: CallDependencies,
): Promise<ProviderResult<string>> {
  const { repository, defaultBranch: branch } = binding;
  const read = await call('site.source.head', { repository, branch }, deps);
  return read.kind === 'ok' ? ok(String(read.value['object.sha'])) : read;
}

/** `site.source.protection`: whether nobody, administrators included, can rewind or delete the default branch. */
async function rewindRefused(binding: SiteBinding, deps: CallDependencies): Promise<boolean> {
  const { repository, defaultBranch: branch } = binding;
  const read = await call('site.source.protection', { repository, branch }, deps);
  return (
    read.kind === 'ok' &&
    read.value['allow_force_pushes.enabled'] === false &&
    read.value['allow_deletions.enabled'] === false &&
    read.value['enforce_admins.enabled'] === true
  );
}

/**
 * The advance read back by the default branch's head: landed at the proposal's head; absent at
 * the approved base, which a protected branch cannot have left through the head and come back to;
 * anything else, or no answer, unknown.
 */
export async function readAdvanced(
  binding: SiteBinding,
  deps: CallDependencies,
): Promise<ReadBack<Published>> {
  const head = await headOf(binding, deps);
  if (head.kind !== 'ok') return { state: 'unknown' };
  if (head.value === binding.proposal.head)
    return { state: 'landed', value: { revision: head.value, liveUrl: binding.pageUrl } };
  return head.value === binding.baseRevision ? { state: 'absent' } : { state: 'unknown' };
}

/** `site.request.read`: the review request's fields, or none when it cannot be read. */
async function readRequest(
  binding: SiteBinding,
  deps: CallDependencies,
): Promise<ProviderValue | undefined> {
  const { repository, proposal } = binding;
  const read = await call('site.request.read', { repository, number: proposal.request }, deps);
  return read.kind === 'ok' ? read.value : undefined;
}

/** Whether the review request reads merged at the proposal's head, so none is left open. */
export async function requestClosed(
  binding: SiteBinding,
  deps: CallDependencies,
): Promise<boolean> {
  const read = await readRequest(binding, deps);
  return read?.['merged'] === true && read['head.sha'] === binding.proposal.head;
}

/** `site.source.advance`: the default branch moved from the approved base to the proposal's head, then its deployment. */
export async function mergeAndFind(
  binding: SiteBinding,
  input: Omit<Parameters<PublishPorts['publish']>[0], 'dispatchToken'>,
  deps: BindingDependencies,
): Promise<ProviderResult<Published>> {
  if (input.seam !== binding.proposal.branch) return stop('refused', 'SEAM_MISMATCH', deps);
  const [file] = input.change.files;
  if (
    input.versionDigest !== binding.proposal.versionDigest ||
    versionDigestOf(input) !== input.versionDigest ||
    input.baseRevision !== binding.baseRevision ||
    input.pageUrl !== binding.pageUrl ||
    input.target.path !== binding.path ||
    !checkEnvelope(input.change, input.target).ok ||
    file === undefined ||
    file.before !== binding.change.before ||
    file.after !== binding.change.after ||
    contentDigest(file.before) !== input.preImageDigest
  ) {
    return stop('refused', 'PROPOSAL_SUPERSEDED', deps);
  }
  const current = await readSiteSource(binding, deps);
  if (current.kind !== 'ok') return current;
  if (current.value.content !== file.before) return stop('refused', 'CONTENT_DRIFTED', deps);
  if (!(await rewindRefused(binding, deps))) return stop('refused', 'ANCESTRY_NOT_ENFORCED', deps);
  const head = await headOf(binding, deps);
  if (head.kind !== 'ok') return head;
  if (head.value !== binding.baseRevision) return stop('refused', 'BASE_MOVED', deps);
  // A request whose head moved, or that cannot be read, is not the one the person accepted.
  if ((await readRequest(binding, deps))?.['head.sha'] !== binding.proposal.head)
    return stop('refused', 'REQUEST_HEAD_MOVED', deps);
  const { repository, defaultBranch: branch } = binding;
  const advanced = await call(
    'site.source.advance',
    { repository, branch, sha: binding.proposal.head },
    deps,
  );
  if (advanced.kind !== 'ok') return advanced;
  const back = await readAdvanced(binding, deps);
  if (back.state !== 'landed') return stop('unknown', 'ADVANCE_NOT_CONFIRMED', deps);
  const { revision } = back.value;
  const deployed = await deploymentOf(binding, revision, deps);
  if (deployed.kind !== 'ok') return deployed;
  // None found yet is not published yet: accepted, its deployment looked up again when observed.
  const deploymentId = deployed.value === undefined ? {} : { deploymentId: deployed.value };
  return ok({ revision, ...deploymentId, liveUrl: binding.pageUrl });
}
