// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's bootstrap, before it connects: it acts on production's project
// alone, so it refuses an admin address on staging's project or on any other,
// and one that does not require TLS, naming the setting and never its value.
// The owner comes from the operator's arguments, the sign-in's id among them.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bootstrapInput, OWNER_GRANTS } from '../../scripts/ops/production-bootstrap.ts';
import {
  adminAddress,
  COMMAND,
  OWNER_SET,
  ownerArgs,
  PRODUCTION,
  projectRef,
  seedAdminGrants,
  SETTINGS,
  STAGING,
} from './production-bootstrap.fixture.ts';

function refusalOf(settings: Record<string, string | undefined>, args: string[]): string {
  const input = bootstrapInput(settings, args);
  return 'refusal' in input ? input.refusal : '';
}

it('takes the owner from its arguments on production’s project', () => {
  const subject = randomUUID();
  expect(bootstrapInput(SETTINGS, ownerArgs(subject))).toStrictEqual({
    owner: {
      businessKey: 'harbour-joinery',
      businessName: 'Harbour Joinery',
      ownerName: 'Robin Harbour',
      ownerSubject: subject,
    },
  });
});

it('refuses an admin address on staging’s project', () => {
  const settings = { ...SETTINGS, DATABASE_ADMIN_URL: adminAddress(STAGING) };
  expect(refusalOf(settings, ownerArgs())).toBe("DATABASE_ADMIN_URL reaches staging's project");
});

it('refuses an admin address on any project but production’s', () => {
  const settings = { ...SETTINGS, DATABASE_ADMIN_URL: adminAddress(projectRef()) };
  expect(refusalOf(settings, ownerArgs())).toBe("DATABASE_ADMIN_URL is not production's project");
});

it('refuses without staging’s project reference to refuse', () => {
  const settings = { ...SETTINGS, STAGING_PROJECT_REF: undefined };
  expect(refusalOf(settings, ownerArgs())).toBe('STAGING_PROJECT_REF is not set');
});

it('refuses an admin address that does not require TLS', () => {
  const settings = { ...SETTINGS, DATABASE_ADMIN_URL: adminAddress(PRODUCTION, '') };
  expect(refusalOf(settings, ownerArgs())).toMatch(/does not require TLS/u);
});

it('refuses an owner subject that is not a sign-in id, or a missing owner fact', () => {
  expect(refusalOf(SETTINGS, ownerArgs('robin@example.com'))).toBe(
    '--owner-subject is not a sign-in id',
  );
  expect(refusalOf(SETTINGS, ownerArgs().slice(0, 6))).toBe('--owner-subject is not set');
  expect(refusalOf(SETTINGS, [...ownerArgs(), '--seed'])).toMatch(/^name the business/u);
});

it('the owner holds the local seed’s admin grants and operations:manage, nothing else', () => {
  expect(seedAdminGrants().length).toBeGreaterThan(20);
  expect(OWNER_GRANTS).toStrictEqual(OWNER_SET);
});

it('the command refuses staging’s project and prints no value', () => {
  const result = spawnSync(process.execPath, [COMMAND, ...ownerArgs()], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      ...SETTINGS,
      DATABASE_ADMIN_URL: adminAddress(STAGING),
    },
  });
  const printed = `${result.stdout}${result.stderr}`;
  expect(result.status).toBe(1);
  expect(printed).toContain("refused: DATABASE_ADMIN_URL reaches staging's project");
  expect(printed).not.toContain(STAGING);
  expect(printed).not.toContain(PRODUCTION);
});
