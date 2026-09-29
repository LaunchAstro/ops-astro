// SPDX-License-Identifier: AGPL-3.0-only
//
// Langfuse's health, read for the operations view (C34).

import type { HealthSource } from '../../../packages/core-commands/src/index.ts';

export interface LangfuseHealthOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export function createLangfuseHealth(_options: LangfuseHealthOptions): HealthSource {
  return {
    async observe() {
      throw new Error('C34: not built');
    },
  };
}
