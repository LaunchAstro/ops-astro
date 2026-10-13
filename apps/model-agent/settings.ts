// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's settings, one JSON file on the owner's machine, readable
// by its owner only (`docs/local/model-agent.md`): the business and agent it
// carries for, its own agent login, the project's Realtime address, the carry
// key (and the next one during a rotation), custody's credential file and
// reference for Ollama, and Ollama's address. Ollama is reached on this
// machine's loopback only, by plain HTTP at its root: any other address is
// refused at start, so a call never leaves the machine for a model.

import { parseCarryKeys } from '../../packages/core-custody/src/agent.ts';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TEXTS = [
  'gotrueUrl',
  'email',
  'password',
  'realtimeUrl',
  'carryKey',
  'ollamaOrigin',
  'credentialsFile',
  'credentialRef',
] as const;
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

/** Ollama's address, only when it is this machine's loopback by plain HTTP at the root. */
function loopback(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && url.origin === origin;
}

/** The settings, or the first problem with them, naming a field and never a value. */
export function parseAgentSettings(
  text: string,
):
  | { readonly ok: true; readonly settings: AgentSettings }
  | { readonly ok: false; readonly problem: string } {
  let shape: Record<string, unknown>;
  try {
    shape = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, problem: 'the settings are not JSON' };
  }
  if (typeof shape !== 'object' || shape === null) return { ok: false, problem: 'no settings' };
  for (const field of ['business', 'agent'] as const) {
    const value = shape[field];
    if (typeof value !== 'string' || !UUID.test(value)) {
      return { ok: false, problem: `${field} is not a lower-case uuid` };
    }
  }
  for (const field of TEXTS) {
    if (typeof shape[field] !== 'string' || shape[field] === '') {
      return { ok: false, problem: `${field} is missing` };
    }
  }
  if (typeof shape['providerKey'] !== 'string')
    return { ok: false, problem: 'providerKey is missing' };
  const next = shape['carryKeyNext'];
  if (next !== undefined && typeof next !== 'string')
    return { ok: false, problem: 'carryKeyNext is malformed' };
  if (!parseCarryKeys(shape['carryKey'] as string, next).ok) {
    return { ok: false, problem: 'the carry key is malformed' };
  }
  if (!loopback(shape['ollamaOrigin'] as string)) {
    return { ok: false, problem: "ollamaOrigin is not this machine's loopback" };
  }
  return { ok: true, settings: shape as unknown as AgentSettings };
}
