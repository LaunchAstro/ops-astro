// SPDX-License-Identifier: AGPL-3.0-only
//
// The OpenAPI document the security pass's authenticated API scan reads
// (ticket S0-5 item 7). ZAP's API scan needs a definition to know the routes,
// and the API has no hand-kept one: every route is `POST /api/b/<business>`
// plus the command's path, derived from COMMAND_SURFACE (`docs/local/API.md`,
// "Routes"). So this derives the document from the same table, with each
// command's operands typed, and a command added later is scanned the day it
// lands. The person prefix only: the agent prefix needs an agent credential,
// which the scan login is not. The decisions are here; `api-definition.mjs`
// writes the file.

import {
  COMMAND_SURFACE,
  NEEDS_NO_EXPECTED_REVISION,
  pathOf,
  PREFIX,
  type CommandDeclaration,
  type Operand,
} from '../../packages/core-wire/src/surface.ts';

export class DefinitionRefused extends Error {}

export interface Schema {
  readonly type?: string;
  readonly format?: string;
  readonly nullable?: boolean;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
}

interface Post {
  readonly operationId: string;
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
  readonly requestBody: {
    readonly required: true;
    readonly content: { readonly 'application/json': { readonly schema: Schema } };
  };
  readonly responses: Readonly<Record<string, { readonly description: string }>>;
}

export interface ApiDefinition {
  readonly openapi: '3.0.3';
  readonly info: { readonly title: string; readonly version: string };
  readonly servers: readonly { readonly url: string }[];
  readonly paths: Readonly<Record<string, { readonly post?: Post; readonly get?: unknown }>>;
  readonly components: { readonly securitySchemes: Readonly<Record<string, unknown>> };
}

/** This machine, and Docker's name for it from inside the ZAP container. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
  'host.docker.internal',
]);
const BUSINESS_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/u;

const KIND_SCHEMA: Readonly<Record<string, Schema>> = {
  id: { type: 'string', format: 'uuid' },
  text: { type: 'string' },
  count: { type: 'number' },
  flag: { type: 'boolean' },
  map: { type: 'object' },
  any: {},
};

/** The scan's target: an origin only, https unless it is this machine. */
function origin(target: string): string {
  const url = URL.parse(target);
  if (url === null) throw new DefinitionRefused('the target is not an address');
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !local)
    throw new DefinitionRefused('the target must be https (plain http only on this machine)');
  if (url.username !== '' || url.password !== '')
    throw new DefinitionRefused('the target carries a login');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new DefinitionRefused('the target is an origin only: no path, query or fragment');
  return url.origin;
}

function operandSchema(operand: Operand): { schema: Schema; required: boolean } {
  const kind = operand.replaceAll(/\?|\|null/gu, '');
  const base = KIND_SCHEMA[kind];
  if (base === undefined) throw new DefinitionRefused(`an operand kind is unknown: ${kind}`);
  const schema = operand.endsWith('|null') ? { ...base, nullable: true } : base;
  return { schema, required: !operand.includes('?') };
}

function bodyOf(command: CommandDeclaration): Schema {
  if (command.kind === 'read') return { type: 'object' };
  const properties: Record<string, Schema> = { operationId: KIND_SCHEMA['id'] ?? {} };
  const required = ['operationId'];
  if (command.targetsExistingRecord && !NEEDS_NO_EXPECTED_REVISION.has(command.name)) {
    properties['expectedRevision'] = { type: 'integer' };
    required.push('expectedRevision');
  }
  for (const [name, operand] of Object.entries(command.operands ?? {})) {
    const typed = operandSchema(operand);
    properties[name] = typed.schema;
    if (typed.required) required.push(name);
  }
  return { type: 'object', properties, required };
}

function postOf(command: CommandDeclaration): Post {
  return {
    operationId: command.name,
    security: [{ bearer: [] }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: bodyOf(command) } },
    },
    responses: { default: { description: 'the outcome or a refusal' } },
  };
}

/** The document for one target and one business, from the command surface. */
export function apiDefinition(
  target: string,
  businessKey: string,
  surface: readonly CommandDeclaration[] = COMMAND_SURFACE,
): ApiDefinition {
  const url = origin(target);
  if (!BUSINESS_KEY.test(businessKey))
    throw new DefinitionRefused('the business key is not a business key');
  const paths: Record<string, { post?: Post; get?: unknown }> = {
    '/api/health': { get: { responses: { default: { description: 'health' } } } },
  };
  for (const command of surface)
    paths[`${PREFIX.person}${businessKey}${pathOf(command.name)}`] = { post: postOf(command) };
  return {
    openapi: '3.0.3',
    info: { title: 'Ops Astro person API (generated for the security pass)', version: '0' },
    servers: [{ url }],
    paths,
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
  };
}
