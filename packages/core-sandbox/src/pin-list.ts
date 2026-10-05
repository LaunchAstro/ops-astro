// SPDX-License-Identifier: AGPL-3.0-only
//
// The pin list (docs/plan/sandbox-contract.md, terms and B8). Stub.

import { type SandboxResult } from './refusal.ts';

export type SiteEntry = {
  readonly lockfile: string;
  readonly image: string;
  readonly attempt: number;
  readonly commit: string;
  readonly env: readonly string[];
};
export type BaseEntry = { readonly image: string; readonly env: readonly string[] };
export type PinList = {
  readonly probe: string;
  readonly base: ReadonlyMap<string, BaseEntry>;
  readonly sites: ReadonlyMap<string, SiteEntry>;
};

export function readPinList(bytes: Uint8Array): SandboxResult<{ pins: PinList }> {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as {
    probe: { image: string };
    base: Record<string, BaseEntry>;
    sites: Record<string, SiteEntry>;
  };
  return {
    ok: true,
    pins: {
      probe: value.probe?.image,
      base: new Map(Object.entries(value.base ?? {})),
      sites: new Map(Object.entries(value.sites ?? {})),
    },
  };
}
