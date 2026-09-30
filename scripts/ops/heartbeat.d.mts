// SPDX-License-Identifier: AGPL-3.0-only
// Types for heartbeat.mjs, which the worker (TypeScript) imports.

export declare const UNREACHABLE: RegExp;

export declare function ping(
  address: string | undefined,
  get?: typeof fetch,
): Promise<'sent' | 'failed' | 'refused' | 'not set'>;
