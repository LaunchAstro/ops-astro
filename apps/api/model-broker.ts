// SPDX-License-Identifier: AGPL-3.0-only
//
// The credential broker, as the API's composition root configures it (AW-01).

import type { BrokerRoute, CustodyConfig } from '../../packages/core-custody/src/index.ts';

export const MODEL_BROKER_SETTINGS = [
  'MODEL_BROKER_CREDENTIALS_FILE',
  'MODEL_BROKER_DESTINATIONS',
  'MODEL_BROKER_ROUTES',
  'MODEL_BROKER_INSTALLATION',
] as const;

export type BrokerSettings =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'configured';
      readonly custody: CustodyConfig;
      readonly routes: readonly BrokerRoute[];
      readonly installation: string;
    }
  | { readonly kind: 'invalid'; readonly problem: string };

export function brokerSettings(
  _environment: Readonly<Record<string, string | undefined>>,
): BrokerSettings {
  throw new Error('model broker settings: not built');
}
