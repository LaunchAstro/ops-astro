// SPDX-License-Identifier: AGPL-3.0-only
//
// I1 (docs/plan/sandbox-contract.md, section 3). Stub.

import type { SiteEntry } from './pin-list.ts';
import type { SandboxResult } from './refusal.ts';
import type { SiteRecord } from './site-record.ts';

export type BuildRequest = {
  readonly site: string;
  readonly baseRevision: string;
  readonly path: string;
  readonly content: Uint8Array;
};
export type SiteOf = (id: string) => { record: SiteRecord; entry: SiteEntry } | null;

export function readBuildRequest(
  bytes: Uint8Array,
  siteOf: SiteOf,
): SandboxResult<{ request: BuildRequest; record: SiteRecord; entry: SiteEntry }> {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as BuildRequest & { content: string };
  const site = siteOf(value.site) ?? { record: undefined as never, entry: undefined as never };
  return {
    ok: true,
    request: { ...value, content: new TextEncoder().encode(value.content) },
    ...site,
  };
}
