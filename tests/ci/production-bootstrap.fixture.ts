// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's bootstrap suites' shared settings (production-bootstrap.test.ts
// and production-bootstrap-refusals.test.ts): two made-up project references,
// an admin address on the Sydney pooler, the owner's arguments, and the local
// seed's admin grants read from its own table.

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const COMMAND: string = new URL(
  '../../scripts/ops/production-bootstrap.mjs',
  import.meta.url,
).pathname;
export const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';

export function projectRef(): string {
  return Array.from(randomBytes(20), (byte) => String.fromCodePoint(97 + (byte % 26))).join('');
}

export const PRODUCTION: string = projectRef();
export const STAGING: string = projectRef();

export function adminAddress(project: string, query = '?sslmode=require'): string {
  return `postgresql://postgres.${project}:pw@${POOLER}:5432/postgres${query}`;
}

export const SETTINGS: {
  readonly PRODUCTION_PROJECT_REF: string;
  readonly STAGING_PROJECT_REF: string;
  readonly DATABASE_ADMIN_URL: string;
} = {
  PRODUCTION_PROJECT_REF: PRODUCTION,
  STAGING_PROJECT_REF: STAGING,
  DATABASE_ADMIN_URL: adminAddress(PRODUCTION),
};

export function ownerArgs(subject: string = randomUUID()): string[] {
  return [
    '--business-key',
    'harbour-joinery',
    '--business-name',
    'Harbour Joinery',
    '--owner-name',
    'Robin Harbour',
    '--owner-subject',
    subject,
  ];
}

/** The local seed's admin grants, read from its own table, in its order. */
export function seedAdminGrants(): string[][] {
  const seed = readFileSync(new URL('../../scripts/local-seed.mjs', import.meta.url), 'utf8');
  const table = seed.slice(seed.indexOf('  admin: ['), seed.indexOf('  member: ['));
  return [...table.matchAll(/\['([a-z_]+)', '([a-z_]+)'\]/gu)].map((m) => [m[1]!, m[2]!]);
}

/** What the owner holds: the seed's admin grants, then the operator's one. */
export const OWNER_SET: string[][] = [...seedAdminGrants(), ['operations', 'manage']];
