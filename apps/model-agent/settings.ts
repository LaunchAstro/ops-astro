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
const TEXTS =
  'gotrueUrl email password realtimeUrl carryKey ollamaOrigin credentialsFile credentialRef';

/** Ollama's address, only when it is this machine's loopback by plain HTTP at the root. */
function loopback(origin: string): boolean {
  const url = URL.parse(origin);
  return (
    url?.protocol === 'http:' &&
    ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    url.origin === origin
  );
}

/** The first problem with the settings, naming a field and never a value. */
function problemIn(shape: Record<string, unknown>): string | undefined {
  const text = (field: string): string | undefined =>
    typeof shape[field] === 'string' ? (shape[field] as string) : undefined;
  const id = ['business', 'agent'].find((field) => !UUID.test(text(field) ?? ''));
  if (id !== undefined) return `${id} is not a lower-case uuid`;
  const missing = TEXTS.split(' ').find((field) => !text(field));
  if (missing !== undefined || text('providerKey') === undefined) {
    return `${missing ?? 'providerKey'} is missing`;
  }
  const next = shape['carryKeyNext'];
  if (next !== undefined && typeof next !== 'string') return 'carryKeyNext is malformed';
  if (!parseCarryKeys(text('carryKey'), next).ok) return 'the carry key is malformed';
  if (!loopback(text('ollamaOrigin') ?? '')) return "ollamaOrigin is not this machine's loopback";
  return undefined;
}

/** The settings, or the first problem with them. */
export function parseAgentSettings(
  text: string,
):
  | { readonly ok: true; readonly settings: AgentSettings }
  | { readonly ok: false; readonly problem: string } {
  let shape: unknown;
  try {
    shape = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'the settings are not JSON' };
  }
  if (typeof shape !== 'object' || shape === null) return { ok: false, problem: 'no settings' };
  const problem = problemIn(shape as Record<string, unknown>);
  return problem === undefined
    ? { ok: true, settings: shape as AgentSettings }
    : { ok: false, problem };
}
