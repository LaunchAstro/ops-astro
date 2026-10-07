// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations the publish binding and the proposal's composition add to
// the live correction's path:
//
// - `site.source.propose.branch` and `site.source.propose.request`: the two
//   guarded writes `site.source.propose` composes beside its contents write
//   (branch, commit, request; `propose.ts`);
// - `site.request.read`: the human review request's state;
// - `site.deployment.lookup`: the hosting deployment found by the written
//   commit, so the publish answers a deployment id without a promotion.
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
  operation(read('site.request.read', SOURCE_QUOTA, 'site_source'), {
    host: SOURCE_HOST,
    method: 'GET',
    pathTemplate: '/repos/{repository*}/pulls/{number}',
    bodyParams: [],
    responseSchema: { merged: 'boolean', state: 'string' },
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
];
