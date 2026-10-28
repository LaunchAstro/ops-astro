// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's settings, one JSON file on the owner's machine, readable
// by its owner only (`docs/local/model-agent.md`): the business and agent it
// carries for, its own agent login, the project's Realtime address, the carry
// key (and the next one during a rotation), custody's credential file and
// reference for Ollama, and Ollama's address. Ollama is reached on this
// machine's loopback only, by plain HTTP at its root: any other address is
// refused at start, so a call never leaves the machine for a model. The paid
// chat's settings are optional and go together: custody's credential
// reference for OpenRouter, and OpenRouter's address, which must be exactly
// `https://openrouter.ai`. The owner's ChatGPT plan's settings (#1620 P4) are
// optional and go together too: the plan's token file, by its absolute path,
// and the two addresses its custody reaches, exactly `https://api.openai.com`
// and `https://auth.openai.com`. Hermes Agent's settings (#2270) are optional
// and go together: custody's credential reference for its key, and its address,
// which must be exactly `http://127.0.0.1:8642`, this machine's loopback.

import { isAbsolute } from 'node:path';
import {
  CHATGPT_PLAN_ISSUER,
  CHATGPT_PLAN_ORIGIN,
} from '../../packages/core-connectors/src/index.ts';
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
  /** Custody's reference for OpenRouter's key; absent, no paid chat is sent. */
  readonly openrouterCredentialRef?: string;
  readonly openrouterOrigin?: string;
  /** The owner's ChatGPT plan's token file; absent, with the two below, no plan call is sent. */
  readonly planTokenFile?: string;
  readonly planOrigin?: string;
  readonly planIssuer?: string;
  /** Custody's reference for Hermes Agent's key; absent, with its address, no Hermes call is sent. */
  readonly hermesCredentialRef?: string;
  readonly hermesOrigin?: string;
}

/** OpenRouter's one address. */
export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
/** Hermes Agent's one address: its API server on this machine's loopback. */
export const HERMES_ORIGIN = 'http://127.0.0.1:8642';

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
  return paidProblemIn(shape) ?? planProblemIn(shape) ?? hermesProblemIn(shape);
}

/** Hermes Agent's two settings: both or neither, the address exactly its loopback one. */
function hermesProblemIn(shape: Record<string, unknown>): string | undefined {
  const { hermesCredentialRef: ref, hermesOrigin: origin } = shape;
  if (ref === undefined && origin === undefined) return undefined;
  if (typeof ref !== 'string' || ref === '') return 'hermesCredentialRef is missing';
  return origin === HERMES_ORIGIN ? undefined : `hermesOrigin is not ${HERMES_ORIGIN}`;
}

/** The paid chat's two settings: both or neither, the address exactly OpenRouter's. */
function paidProblemIn(shape: Record<string, unknown>): string | undefined {
  const { openrouterCredentialRef: ref, openrouterOrigin: origin } = shape;
  if (ref === undefined && origin === undefined) return undefined;
  if (typeof ref !== 'string' || ref === '') return 'openrouterCredentialRef is missing';
  return origin === OPENROUTER_ORIGIN ? undefined : `openrouterOrigin is not ${OPENROUTER_ORIGIN}`;
}

/** The plan's three settings: all or none, the token file absolute, each address exact. */
function planProblemIn(shape: Record<string, unknown>): string | undefined {
  const { planTokenFile: file, planOrigin: origin, planIssuer: issuer } = shape;
  if (file === undefined && origin === undefined && issuer === undefined) return undefined;
  if (typeof file !== 'string' || !isAbsolute(file)) return 'planTokenFile is not an absolute path';
  if (origin !== CHATGPT_PLAN_ORIGIN) return 'planOrigin is not the Responses address';
  return issuer === CHATGPT_PLAN_ISSUER ? undefined : "planIssuer is not the plan's issuer";
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
