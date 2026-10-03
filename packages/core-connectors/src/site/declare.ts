// SPDX-License-Identifier: AGPL-3.0-only
//
// What every site operation is declared with: the connector release computed
// from the connector's own bytes, the seam a naturally idempotent read holds,
// the two quota buckets and the two provider hosts. `operations.ts` and
// `operations-binding.ts` both declare through here, one way.

import {
  CREDENTIAL_HOSTS,
  connectorRelease,
  type ConnectorDefinition,
  type OperationDeclaration,
  type OperationRegistration,
} from '../catalogue.ts';

export type Declared = Omit<OperationDeclaration, 'connector_release'>;

export function operation(
  declared: Declared,
  connector: ConnectorDefinition,
): OperationRegistration {
  return {
    declaration: { ...declared, connector_release: connectorRelease(connector) },
    connector,
  };
}

export const NO_SEAM = { read_operation: 'none', reference: 'none' } as const;
export const SOURCE_QUOTA = {
  bucket: 'source_control_rest',
  scope: 'installation',
  cost: 1,
} as const;
export const HOSTING_QUOTA = { bucket: 'hosting_rest', scope: 'installation', cost: 1 } as const;

export const SOURCE_HOST: string = CREDENTIAL_HOSTS.source_control;
export const HOSTING_HOST: string = CREDENTIAL_HOSTS.hosting;
