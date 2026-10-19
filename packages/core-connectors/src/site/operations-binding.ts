// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations the publish binding and the proposal's composition add to
// the live correction's path:
//
// - `site.source.propose.branch` and `site.source.propose.request`: the two
//   guarded writes `site.source.propose` composes beside its contents write
//   (branch, commit, request; `propose.ts`);
// - `site.source.advance`: the publish, the default branch moved to the
//   proposal's head as a fast-forward (no `force` is declared, so none is ever
//   sent): the provider applies it only from an ancestor of the head, and the
//   binding sends it only while the branch is the approved base (`binding.ts`);
// - `site.source.protection`: the default branch's protection, read before the
//   advance, so the base the fast-forward is pinned to cannot be rewound;
// - `site.request.read`: the review request, read once the advance is live, so
//   one left open is named (the provider closes it as merged once its head is
//   on its base);
// - `site.source.head`: the default branch's head commit, the revision a
//   locate pins and every later check reads the file at (#1693);
// - `site.deployment.lookup`: the hosting deployment found by the written
//   commit, so the publish answers a deployment id without a promotion;
// - `site.deployment.current` and `site.deployment.alias`: the project's
//   production deployment now, and the deployment the page's host is
//   assigned to, so live needs the written commit's deployment serving the
//   bound page (`serving.ts`).
//
// Declarations are an adapter author's claims, evidenced against the real
// repository and project at the walk-through like the first six.

import type { OperationRegistration } from '../catalogue.ts';
import {
  HOSTING_HOST,
  HOSTING_QUOTA,
  NO_SEAM,
  SOURCE_HOST,
  SOURCE_QUOTA,
  operation,
} from './declare.ts';

const BRANCH_SEAM = {
  read_operation: 'site.source.read',
  reference: 'branch name, named before dispatch',
} as const;

const proposalWrite = (name: string, proof: string) =>
  ({
    operation_name: name,
    effect_class: 'reversible',
    reversibility_strategy: 'R1',
    acknowledgement_semantics: 'accepted',
    reconcile_mode: 'reconcilable',
    reconcile_seam: BRANCH_SEAM,
    nothing_happened_proof: [proof],
    credential_tier: 'T2',
    trust_class: 'isolated_connector',
    quota_class: SOURCE_QUOTA,
    data_flow_labels: ['site_source'],
  }) as const;

const read = (name: string, quota: typeof SOURCE_QUOTA | typeof HOSTING_QUOTA, label: string) =>
  ({
    operation_name: name,
    effect_class: 'transitory',
    reversibility_strategy: 'R1',
    acknowledgement_semantics: 'completed',
    reconcile_mode: 'naturally_idempotent',
    reconcile_seam: NO_SEAM,
    nothing_happened_proof: [],
    credential_tier: 'T2',
    trust_class: 'isolated_connector',
    quota_class: quota,
    data_flow_labels: [label],
  }) as const;

const LIMITS = { redirects: 'none', maxResponseBytes: 65_536, timeoutMs: 10_000 } as const;

export const BINDING_OPERATIONS: readonly OperationRegistration[] = [
  operation(proposalWrite('site.source.propose.branch', 'branch_exists'), {
    host: SOURCE_HOST,
    method: 'POST',
    pathTemplate: '/repos/{repository*}/git/refs',
    bodyParams: ['ref', 'sha'],
    responseSchema: { ref: 'string', 'object.sha': 'string' },
    refusalProofs: { '422': 'branch_exists' },
    credential: 'source_control',
    ...LIMITS,
  }),
  operation(proposalWrite('site.source.propose.request', 'request_refused'), {
    host: SOURCE_HOST,
    method: 'POST',
    pathTemplate: '/repos/{repository*}/pulls',
    bodyParams: ['title', 'head', 'base'],
    responseSchema: { number: 'number' },
    refusalProofs: { '422': 'request_refused' },
    credential: 'source_control',
    ...LIMITS,
  }),
  operation(
    {
      operation_name: 'site.source.advance',
      effect_class: 'reversible',
      reversibility_strategy: 'R2',
      acknowledgement_semantics: 'accepted',
      reconcile_mode: 'reconcilable',
      reconcile_seam: {
        read_operation: 'site.source.head',
        reference: 'default branch head, held before dispatch',
      },
      nothing_happened_proof: ['not_fast_forward', 'ref_missing'],
      credential_tier: 'T2',
      trust_class: 'isolated_connector',
      quota_class: SOURCE_QUOTA,
      data_flow_labels: ['site_source'],
    },
    {
      host: SOURCE_HOST,
      method: 'PATCH',
      pathTemplate: '/repos/{repository*}/git/refs/heads/{branch}',
      bodyParams: ['sha'],
      responseSchema: { 'object.sha': 'string', ref: 'string' },
      refusalProofs: { '404': 'ref_missing', '422': 'not_fast_forward' },
      credential: 'source_control',
      ...LIMITS,
    },
  ),
  operation(read('site.source.protection', SOURCE_QUOTA, 'site_source'), {
    host: SOURCE_HOST,
    method: 'GET',
    pathTemplate: '/repos/{repository*}/branches/{branch}/protection',
    bodyParams: [],
    responseSchema: {
      'allow_force_pushes.enabled': 'boolean',
      'allow_deletions.enabled': 'boolean',
      'enforce_admins.enabled': 'boolean',
    },
    refusalProofs: {},
    credential: 'source_control',
    ...LIMITS,
  }),
  operation(read('site.request.read', SOURCE_QUOTA, 'site_source'), {
    host: SOURCE_HOST,
    method: 'GET',
    pathTemplate: '/repos/{repository*}/pulls/{number}',
    bodyParams: [],
    responseSchema: { merged: 'boolean', 'head.sha': 'string' },
    refusalProofs: {},
    credential: 'source_control',
    ...LIMITS,
  }),
  operation(read('site.source.head', SOURCE_QUOTA, 'site_source'), {
    host: SOURCE_HOST,
    method: 'GET',
    pathTemplate: '/repos/{repository*}/git/ref/heads/{branch}',
    bodyParams: [],
    responseSchema: { 'object.sha': 'string' },
    refusalProofs: {},
    credential: 'source_control',
    ...LIMITS,
  }),
  operation(read('site.deployment.lookup', HOSTING_QUOTA, 'deployment_state'), {
    host: HOSTING_HOST,
    method: 'GET',
    pathTemplate: '/v6/deployments?projectId={project}&sha={sha}&target=production&limit=1',
    bodyParams: [],
    responseSchema: {
      'deployments.0.uid': 'string',
      'deployments.0.meta.githubCommitSha': 'string',
    },
    refusalProofs: {},
    credential: 'hosting',
    ...LIMITS,
  }),
  operation(read('site.deployment.current', HOSTING_QUOTA, 'deployment_state'), {
    host: HOSTING_HOST,
    method: 'GET',
    pathTemplate: '/v9/projects/{project}',
    bodyParams: [],
    responseSchema: { id: 'string', 'targets.production.id': 'string' },
    refusalProofs: {},
    credential: 'hosting',
    ...LIMITS,
    // The project answer carries its settings and latest deployments beside the target.
    maxResponseBytes: 1_048_576,
  }),
  operation(read('site.deployment.alias', HOSTING_QUOTA, 'deployment_state'), {
    host: HOSTING_HOST,
    method: 'GET',
    pathTemplate: '/v4/aliases/{host}?projectId={project}',
    bodyParams: [],
    responseSchema: { alias: 'string', deploymentId: 'string', projectId: 'string' },
    refusalProofs: {},
    credential: 'hosting',
    ...LIMITS,
  }),
];
