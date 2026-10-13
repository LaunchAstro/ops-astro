// SPDX-License-Identifier: AGPL-3.0-only
// The backup store's healthcheck signs in as the store's own admin role. With
// no `-U`, `pg_isready` asks for a role named after the container user, and
// Postgres logs `FATAL: role "postgres" does not exist` on every probe.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Service = {
  environment?: Record<string, string>;
  healthcheck?: { test?: string[] };
};
type Definition = { services: Record<string, Service> };

const definition = (environment: string): Definition =>
  JSON.parse(
    readFileSync(new URL(`../../deploy/${environment}/compose.json`, import.meta.url), 'utf8'),
  ) as Definition;

// `${NAME}` or `${NAME:?message}` -> NAME; anything else (a literal role) -> undefined.
const placeholder = (value: string | undefined): string | undefined =>
  /^\$\{(?<name>[A-Z0-9_]+)(?::\?[^}]*)?\}$/u.exec(value ?? '')?.groups?.['name'];

describe.each(['production', 'staging'])('the %s backup store healthcheck', (environment) => {
  const backups = definition(environment).services['backups']!;
  const test = backups.healthcheck?.test ?? [];

  it('runs pg_isready as an exec-form command', () => {
    expect(test.slice(0, 2)).toEqual(['CMD', 'pg_isready']);
  });

  it("names the store's own admin role, from the variable its environment already uses", () => {
    const own = placeholder(backups.environment?.['POSTGRES_USER']);
    expect(own, 'POSTGRES_USER comes from a deploy variable').toMatch(/_BACKUPS_ADMIN_USER$/u);
    const flag = test.indexOf('-U');
    expect(flag, 'pg_isready is given -U').toBeGreaterThan(1);
    expect(placeholder(test[flag + 1])).toBe(own);
  });
});
