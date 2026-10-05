// SPDX-License-Identifier: AGPL-3.0-only
//
// I6 (docs/plan/sandbox-contract.md, section 3): the site record. Stub.

import { type SandboxResult } from './refusal.ts';

export type SiteRecord = {
  readonly buildCommand: readonly string[];
  readonly outputDirectory: 'dist';
  readonly nodeVersion: string;
  readonly buildEnv: readonly (readonly [string, string])[];
  readonly scopes: readonly string[];
  readonly contentDirectories: readonly string[];
  readonly contentExtensions: readonly string[];
  readonly buildFormat: 'directory' | 'file' | 'preserve';
  readonly trailingSlash: 'always' | 'never' | 'ignore';
  readonly output: 'static';
};

export function readSiteRecord(bytes: Uint8Array): SandboxResult<{ record: SiteRecord }> {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Omit<SiteRecord, 'buildEnv'> & {
    buildEnv?: Record<string, string>;
  };
  return { ok: true, record: { ...value, buildEnv: Object.entries(value.buildEnv ?? {}) } };
}
