// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationsClient } from './operations/client.ts';
import type { StorageLike } from './screens/settings/use-settings.ts';

export const APPEARANCE_KEY = 'ops-astro.appearance';

export function useStoredAppearance(
  _client: OperationsClient,
  _grantKey: string | null,
  _storage: StorageLike | null,
): void {}
