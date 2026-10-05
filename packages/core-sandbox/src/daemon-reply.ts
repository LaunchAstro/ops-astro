// SPDX-License-Identifier: AGPL-3.0-only
//
// Replies from our own pinned daemon (docs/plan/sandbox-contract.md, the
// preamble): parsed with P1's parser and read for the keys a line names,
// each checked as stated; other keys are ignored. `_ping`'s body is exactly
// `OK` and a 204 has no body. Any reply that breaks these rules is
// `internal`, which leaves the launcher unavailable until a new probe passes.

import { fault, type SandboxResult } from './refusal.ts';
import { type Json, parseStrictJson } from './strict-json.ts';

type JsonObject = { readonly [key: string]: Json };
const ID = /^[0-9a-f]{64}$/u;

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: Json | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readObject(body: Uint8Array): SandboxResult<{ value: JsonObject }> {
  const parsed = parseStrictJson(body);
  if (!parsed.ok) return parsed;
  return isObject(parsed.value) ? { ok: true, value: parsed.value } : fault('reply body');
}

export function readPing(status: number, body: Uint8Array): SandboxResult<object> {
  const ok = status === 200 && body.length === 2 && body[0] === 0x4f && body[1] === 0x4b;
  return ok ? { ok: true } : fault('reply body');
}

export function readNoContent(status: number, body: Uint8Array): SandboxResult<object> {
  if (status !== 204) return fault('reply status');
  return body.length === 0 ? { ok: true } : fault('reply body');
}

export function readCreatedId(body: Uint8Array): SandboxResult<{ id: string }> {
  const read = readObject(body);
  if (!read.ok) return read;
  const id = read.value['Id'];
  return typeof id === 'string' && ID.test(id) ? { ok: true, id } : fault('reply body');
}

export function readWaitStatus(body: Uint8Array): SandboxResult<{ statusCode: number }> {
  const read = readObject(body);
  if (!read.ok) return read;
  const code = read.value['StatusCode'];
  return isCount(code) ? { ok: true, statusCode: code } : fault('reply body');
}

export function readOomKilled(body: Uint8Array): SandboxResult<{ oomKilled: boolean }> {
  const read = readObject(body);
  if (!read.ok) return read;
  const state = read.value['State'];
  const killed = isObject(state) ? state['OOMKilled'] : undefined;
  return typeof killed === 'boolean' ? { ok: true, oomKilled: killed } : fault('reply body');
}

export function readContainerIds(body: Uint8Array): SandboxResult<{ ids: readonly string[] }> {
  const parsed = parseStrictJson(body);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return fault('reply body');
  const ids: string[] = [];
  for (const entry of parsed.value as readonly Json[]) {
    const id = isObject(entry) ? entry['Id'] : undefined;
    if (typeof id !== 'string' || !ID.test(id)) return fault('reply body');
    ids.push(id);
  }
  return { ok: true, ids };
}

export function readContainerCount(body: Uint8Array): SandboxResult<{ containers: number }> {
  const read = readObject(body);
  if (!read.ok) return read;
  const count = read.value['Containers'];
  return isCount(count) ? { ok: true, containers: count } : fault('reply body');
}
