// SPDX-License-Identifier: AGPL-3.0-only
//
// The catalogued operations of the live correction. Publish writes one
// approved file atomically on the default branch, using its pre-image blob
// as the precondition. The request remains the human review screen. The
// deployment is found by the written commit and is never promoted.

import {
  registerOperation,
  type ConnectorDefinition,
  type OperationDeclaration,
  type OperationRegistration,
  type Registered,
} from '../catalogue.ts';
import {
  HOSTING_HOST,
  HOSTING_QUOTA,
  NO_SEAM,
  SOURCE_HOST,
  SOURCE_QUOTA,
  operation,
} from './declare.ts';
import { BINDING_OPERATIONS } from './operations-binding.ts';

/** Hosts a connector call may reach. The capture's own pages are the fence's, not these. */
export const CONNECTOR_HOSTS: readonly string[] = [SOURCE_HOST, HOSTING_HOST];

const contents = (method: 'GET' | 'PUT'): ConnectorDefinition => ({
  host: SOURCE_HOST,
  method,
  pathTemplate: '/repos/{repository*}/contents/{path*}',
  bodyParams: method === 'GET' ? ['ref'] : ['message', 'content', 'sha', 'branch'],
  redirects: 'none',
  responseSchema:
    method === 'GET'
      ? { sha: 'string', content: 'string', encoding: 'string' }
      : { 'content.sha': 'string', 'commit.sha': 'string' },
  refusalProofs: method === 'GET' ? {} : { '409': 'sha_mismatch', '422': 'sha_mismatch' },
  maxResponseBytes: 262_144,
  timeoutMs: 10_000,
  credential: 'source_control',
});

export const SITE_OPERATIONS: readonly OperationRegistration[] = [
  operation(
    {
      operation_name: 'site.source.read',
      effect_class: 'transitory',
      reversibility_strategy: 'R1',
      acknowledgement_semantics: 'completed',
      reconcile_mode: 'naturally_idempotent',
      reconcile_seam: NO_SEAM,
      nothing_happened_proof: [],
      credential_tier: 'T2',
      trust_class: 'isolated_connector',
      quota_class: SOURCE_QUOTA,
      data_flow_labels: ['site_source'],
    },
    contents('GET'),
  ),
  operation(
    {
      operation_name: 'site.source.propose',
      effect_class: 'reversible',
      reversibility_strategy: 'R1',
      acknowledgement_semantics: 'accepted',
      reconcile_mode: 'reconcilable',
      reconcile_seam: {
        read_operation: 'site.source.read',
        reference: 'branch name, named before dispatch',
      },
      nothing_happened_proof: ['sha_mismatch'],
      credential_tier: 'T2',
      trust_class: 'isolated_connector',
      quota_class: SOURCE_QUOTA,
      data_flow_labels: ['site_source'],
    },
    contents('PUT'),
  ),
  operation(
    {
      operation_name: 'site.publish',
      effect_class: 'reversible',
      reversibility_strategy: 'R2',
      acknowledgement_semantics: 'accepted',
      reconcile_mode: 'reconcilable',
      reconcile_seam: {
        read_operation: 'site.source.read',
        reference: 'bound file on the default branch, held before dispatch',
      },
      nothing_happened_proof: ['sha_mismatch'],
      credential_tier: 'T2',
      trust_class: 'isolated_connector',
      quota_class: SOURCE_QUOTA,
      data_flow_labels: ['site_source'],
    },
    contents('PUT'),
  ),
  operation(
    {
      operation_name: 'site.source.revert',
      effect_class: 'reversible',
      reversibility_strategy: 'R1',
      acknowledgement_semantics: 'accepted',
      reconcile_mode: 'reconcilable',
      reconcile_seam: {
        read_operation: 'site.source.read',
        reference: 'default branch head, read before dispatch',
      },
      nothing_happened_proof: ['sha_mismatch'],
      credential_tier: 'T2',
      trust_class: 'isolated_connector',
      quota_class: SOURCE_QUOTA,
      data_flow_labels: ['site_source'],
    },
    contents('PUT'),
  ),
  operation(
    {
      operation_name: 'site.deployment.read',
      effect_class: 'transitory',
      reversibility_strategy: 'R1',
      acknowledgement_semantics: 'landed',
      reconcile_mode: 'naturally_idempotent',
      reconcile_seam: NO_SEAM,
      nothing_happened_proof: [],
      credential_tier: 'T2',
      trust_class: 'isolated_connector',
      quota_class: HOSTING_QUOTA,
      data_flow_labels: ['deployment_state'],
    },
    {
      host: HOSTING_HOST,
      method: 'GET',
      pathTemplate: '/v13/deployments/{deployment}',
      bodyParams: [],
      redirects: 'none',
      responseSchema: {
        id: 'string',
        readyState: 'string',
        target: 'string',
        'meta.githubCommitSha': 'string',
      },
      refusalProofs: {},
      maxResponseBytes: 65_536,
      timeoutMs: 10_000,
      credential: 'hosting',
    },
  ),
  operation(
    {
      operation_name: 'site.capture',
      effect_class: 'transitory',
      reversibility_strategy: 'R1',
      acknowledgement_semantics: 'completed',
      reconcile_mode: 'naturally_idempotent',
      reconcile_seam: NO_SEAM,
      nothing_happened_proof: [],
      credential_tier: 'none',
      trust_class: 'isolated_connector',
      quota_class: { bucket: 'capture_pool', scope: 'installation', cost: 1 },
      data_flow_labels: ['public_page'],
    },
    {
      host: 'catalogued-pages',
      method: 'GET',
      pathTemplate: '/{page*}',
      bodyParams: [],
      redirects: 'none',
      responseSchema: {},
      refusalProofs: {},
      maxResponseBytes: 2_097_152,
      timeoutMs: 10_000,
      credential: 'none',
    },
  ),
  ...BINDING_OPERATIONS,
];

/** Names that belong on this path. Anything else offered beside them is a design error (D21-1). */
const ON_PATH = new Set(SITE_OPERATIONS.map((entry) => entry.declaration.operation_name));

/** Registers every operation, refusing the whole catalogue on the first refusal. */
export function siteCatalogue(
  candidates: readonly unknown[] = SITE_OPERATIONS,
): Registered<readonly OperationDeclaration[]> {
  const registered: OperationDeclaration[] = [];
  for (const candidate of candidates) {
    const result = registerOperation(candidate);
    if (!result.ok) return result;
    const name = result.value.operation_name;
    if (!ON_PATH.has(name)) return { ok: false, code: 'OPERATION_NOT_ON_PATH', fields: [name] };
    if (registered.some((entry) => entry.operation_name === name)) {
      return { ok: false, code: 'OPERATION_ALREADY_REGISTERED', fields: [name] };
    }
    registered.push(result.value);
  }
  return { ok: true, value: registered };
}

export function siteOperation(name: string): OperationRegistration {
  const found = SITE_OPERATIONS.find((entry) => entry.declaration.operation_name === name);
  if (found === undefined) throw new Error(`site operation not catalogued: ${name}`);
  return found;
}
