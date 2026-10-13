// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's settings: inert until its code lands.

export interface AgentSettings {
  readonly business: string;
  readonly agent: string;
  readonly gotrueUrl: string;
  readonly email: string;
  readonly password: string;
  readonly providerKey: string;
  readonly realtimeUrl: string;
  readonly carryKey: string;
  readonly carryKeyNext?: string;
  readonly ollamaOrigin: string;
  readonly credentialsFile: string;
  readonly credentialRef: string;
}

export function parseAgentSettings(
  text: string,
):
  | { readonly ok: true; readonly settings: AgentSettings }
  | { readonly ok: false; readonly problem: string } {
  return { ok: true, settings: JSON.parse(text) as AgentSettings };
}
