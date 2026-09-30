// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation's surfaces: one command sent as one caller through the app's
// client, the CLI and the API (or as the agent through the CLI and the agent
// route), every answer recorded with its record values labelled, and the
// check that names any other client, business or person an answer carries.

import { randomUUID } from 'node:crypto';
import type { CatalogueRow } from '../../packages/core-wire/src/index.ts';
import { createCli } from '../../apps/cli/client.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { tokenFor } from './fixture.ts';
import type { Member } from '../commands/fixture.ts';
import { agentToken, delegation, label, through, type Name } from './api-1-isolation-world.ts';

export interface Heard {
  readonly status: number;
  readonly code: unknown;
  /** The whole answer, each known record id and title replaced by its label. */
  readonly body: unknown;
}

/** Every task, title, lease, reservation, business or person any answer names, refusals included, but the caller's own. */
export function foreign(heard: readonly Heard[], own: Name | null): string[] {
  const named = heard
    .flatMap((one) =>
      Array.from(
        JSON.stringify(one.body).matchAll(
          /<(client1|client2|bravo|other) (?:task|title|lease|reservation|business|person)>/gu,
        ),
      ),
    )
    .map((match) => match[1] as string);
  return [...new Set(named)].filter((name) => name !== own);
}

/** Refused by the body's shape is not refused by a grant or delegation: these prove nothing. */
export const SHAPE: string[] = [
  'COMMAND_BODY_INVALID',
  'FIELD_VALUE_INVALID',
  'OPERATION_ID_REQUIRED',
];

/** One answer as text with its keys sorted: the CLI re-serialises what it heard. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).toSorted(([a], [b]) => a.localeCompare(b)))
      : field,
  );

/** One command through the app's client, the CLI and the API, as one caller. */
export async function threeWays(
  row: CatalogueRow,
  member: Member,
  businessKey: string,
  body: Record<string, unknown>,
): Promise<Heard[]> {
  const token = await tokenFor(member.presented.subject);
  const heard: Heard[] = [];
  const recording = (async (url: string | URL, init?: RequestInit) => {
    const response = await through(url, init);
    const parsed = (await response
      .clone()
      .json()
      .catch(() => ({}))) as { code?: unknown } | null;
    heard.push({ status: response.status, code: parsed?.code, body: label(parsed) });
    return response;
  }) as typeof fetch;
  const app = new OperationsClient({ origin: '', businessKey, token, fetch: recording });
  const operationId = randomUUID();
  await (row.kind === 'read'
    ? app.read(row.command as never, body)
    : app.mutate(row.command as never, body, { operationId, expectedRevision: 1 }));
  const payload = row.kind === 'read' ? body : { ...body, operationId, expectedRevision: 1 };
  const cli = createCli({
    businessKey,
    credential: token,
    transport: async (path, sent, credential) =>
      await recording(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: sent,
      }),
  });
  await cli.run(row.command, payload);
  await recording(row.api.person.replace(':businessKey', businessKey), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  return heard;
}

/** One command as the agent under its delegation, through the CLI and the API's agent route. */
export async function asAgent(
  row: CatalogueRow,
  businessKey: string,
  body: Record<string, unknown>,
): Promise<Heard[]> {
  const heard: Heard[] = [];
  const recording = async (path: string, init: RequestInit) => {
    const response = await through(path, init);
    const parsed = (await response
      .clone()
      .json()
      .catch(() => ({}))) as { code?: unknown } | null;
    heard.push({ status: response.status, code: parsed?.code, body: label(parsed) });
    return response;
  };
  // The agent prefix takes an operation id on every call, reads included.
  const payload = {
    ...body,
    operationId: randomUUID(),
    ...(row.kind === 'write' && 'recordId' in body ? { expectedRevision: 1 } : {}),
  };
  const cli = createCli({
    businessKey,
    credential: agentToken,
    entry: 'agent',
    delegation,
    transport: async (path, sent, credential, held) =>
      await recording(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
          ...(held === undefined ? {} : { 'x-agent-delegation': held }),
        },
        body: sent,
      }),
  });
  await cli.run(row.command, payload);
  await recording(String(row.api.agent).replace(':businessKey', businessKey), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${agentToken}`,
      'x-agent-delegation': delegation,
    },
    body: JSON.stringify(payload),
  });
  return heard;
}
