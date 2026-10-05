// SPDX-License-Identifier: AGPL-3.0-only
//
// `automation.registry` (C33): Settings ▸ Workflow triggers. Each definition
// with its released versions and the activations pinned to them, so the
// screen shows every automation's mode and pinned version from one read. The
// envelope has checked `settings:read` business-wide; row security keeps every
// statement to the caller's business.

import { listRegistry, type TenantQuery } from '../../../core-records/src/index.ts';
import type { AutomationRegistryResult } from '../../../core-wire/src/index.ts';

export async function readAutomationRegistry(tx: TenantQuery): Promise<AutomationRegistryResult> {
  const { definitions, versions, activations } = await listRegistry(tx);
  return {
    ok: true,
    definitions: definitions.map(({ id, kind, name }) => ({
      id,
      kind,
      name,
      versions: versions
        .filter((version) => version.definitionId === id)
        .map(({ definitionId: _definition, ...version }) => version),
      activations: activations
        .filter((activation) => activation.definitionId === id)
        .map(({ definitionId: _definition, ...activation }) =>
          Object.assign(activation, { approval: null }),
        ),
    })),
  };
}
