// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1: who may call what, as the catalogue answers it. The catalogue replaces
// discovery, an agent never holds decide, share or manage, and a person-only
// or two-part authority survives on every row and surface; the planted cases
// drop one and show the real check fails.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  buildCatalogue,
  checkParity,
  profileOf,
  reachableBy,
  type Profile,
} from '../../packages/core-wire/src/index.ts';
import type { CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
// @ts-expect-error -- a plain script with no declaration file
import { realSurfaces } from '../../scripts/command-parity.mjs';
import { edit, real } from './api-1-catalogue-support.ts';

/** Grants held business-wide. */
const wide = (...keys: string[]) =>
  keys.map((key) => ({ key, scope: { kind: 'business' as const, id: null } }));

/** `task.duplicate` as MP-4-8 will declare it: person only, two-part authority. */
const DUPLICATE: CommandDeclaration = {
  ...(COMMAND_SURFACE.find((one) => one.name === 'task.create') as CommandDeclaration),
  name: 'task.duplicate' as CommandDeclaration['name'],
  authority: ['task:read', 'task:write'],
  agent: 'never',
};

describe('API-1 command catalogue', () => {
  replacesDiscovery();
  agentDecideAndPersonOnly();
});

function replacesDiscovery(): void {
  it('API-1 replaces discovery: the catalogue answers who may call what, through which surface', () => {
    const rows = buildCatalogue([]);
    const writer = reachableBy(rows, {
      kind: 'person',
      grants: wide('task:read', 'task:write'),
    });
    expect(writer.map((one) => one.command)).toContain('task.update');
    expect(writer.map((one) => one.command)).not.toContain('task.assign');
    const agent = reachableBy(rows, {
      kind: 'agent',
      grants: wide('task:read', 'task:write', 'task:comment', 'task:decide'),
    });
    expect(agent.map((one) => one.command)).toContain('task.handback');
    expect(agent.map((one) => one.command)).not.toContain('task.decide');
    // An agent writes its own task's fields under a delegation (MP-4-7, MP-4-8),
    // and never trashes a task.
    expect(agent.map((one) => one.command)).toContain('task.update');
    expect(agent.map((one) => one.command)).not.toContain('task.trash');
    const withUi = reachableBy(real().rows, { kind: 'person', grants: wide('task:write') });
    expect(withUi.find((one) => one.command === 'task.start')?.surfaces).toEqual([
      'app',
      'API',
      'CLI',
    ]);
    expect(withUi.find((one) => one.command === 'task.rank')?.surfaces).toEqual(['API', 'CLI']);
    const onOneTask = reachableBy(rows, {
      kind: 'person',
      grants: [{ key: 'task:write', scope: { kind: 'record', id: 'one-task' } }],
    }).map((one) => one.command);
    expect(onOneTask).toContain('task.update');
    expect(onOneTask).not.toContain('task.create');
    const decisions = readFileSync('docs/current-decisions.md', 'utf8');
    expect(decisions).toContain('packages/core-wire/src/catalogue.ts');
    expect(decisions).toContain('capability-map discovery answered');
    expect(decisions).toContain('replaced by the catalogue, not ported');
  });
}

function agentDecideAndPersonOnly(): void {
  it('API-1 no agent decide: an agent-eligible command holding decide, share or manage fails', () => {
    for (const row of real().rows) {
      if (row.authority.some((key) => /:(decide|share|manage)$/u.test(key))) {
        expect(row.personOnly, row.command).toBe(true);
        expect(row.api.agent, row.command).toBeNull();
      }
    }
    const rows = edit(buildCatalogue([]), 'task.decide', { personOnly: false });
    expect(checkParity(rows, realSurfaces([]))).toContain(
      'task.decide is agent-eligible and holds task:decide',
    );
  });

  it('API-1 person-only and two-part authority: a row or surface dropping the marker or a part fails', () => {
    const declarations = [...COMMAND_SURFACE, DUPLICATE];
    const rows = buildCatalogue([], declarations);
    const duplicate = rows.find((row) => (row.command as string) === 'task.duplicate');
    expect(duplicate?.personOnly).toBe(true);
    expect(duplicate?.authority).toEqual(['task:read', 'task:write']);
    expect(duplicate?.api.agent).toBeNull();
    const reach = new Map([
      ...(realSurfaces([]).api as Map<string, Profile>),
      ['task.duplicate', profileOf(DUPLICATE)],
    ]);
    const surfaces = { ...realSurfaces([]), api: reach, agent: reach, cli: reach, web: reach };
    expect(checkParity(rows, surfaces, declarations)).toEqual([]);
    const dropMarker = edit(rows, 'task.duplicate', { personOnly: false });
    expect(checkParity(dropMarker, surfaces, declarations)).toContain(
      'catalogue row task.duplicate drops the person-only marker and admits an agent',
    );
    const cli = new Map(reach).set('task.duplicate', {
      ...profileOf(DUPLICATE),
      authority: ['task:write'],
    });
    expect(checkParity(rows, { ...surfaces, cli }, declarations)).toEqual([
      'CLI task.duplicate skips the grant check task:read the app makes',
    ]);
    const api = new Map(reach).set('task.duplicate', {
      ...profileOf(DUPLICATE),
      personOnly: false,
    });
    expect(checkParity(rows, { ...surfaces, api }, declarations)).toEqual([
      'API task.duplicate drops the person-only marker and admits an agent',
    ]);
  });
}
