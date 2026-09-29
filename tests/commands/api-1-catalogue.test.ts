// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1: the command catalogue and the parity check. Each case is named after
// the ticket's line it proves. The planted cases hand the real check a
// changed input, a stateful button with no CLI verb, a surface that drops a
// grant, and show it fails; the real tree passes the same check.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  VIEW_ONLY_EXEMPT,
  buildCatalogue,
  checkParity,
  profileOf,
  reachableBy,
  renderReport,
  type CatalogueRow,
  type Profile,
} from '../../packages/core-wire/src/index.ts';
import type { CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
// @ts-expect-error -- a plain script with no declaration file
import { realSurfaces, run, scanUses } from '../../scripts/command-parity.mjs';

const WEB = join(import.meta.dirname, '..', '..', 'apps', 'web', 'src');
const NAMESPACES = new Set(COMMAND_SURFACE.map((one) => one.name.split('.')[0] as string));

function webFiles(): Map<string, string> {
  return new Map(
    readdirSync(WEB, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(WEB.length + 1), readFileSync(path, 'utf8')];
      }),
  );
}

interface Run {
  readonly rows: CatalogueRow[];
  readonly failures: string[];
}
const real = (): Run => run() as Run;

/** The real surfaces with one command's profile on one of them replaced. */
function planted(surface: 'api' | 'cli' | 'web', name: string, change: Partial<Profile>) {
  const surfaces = realSurfaces([]);
  const reach = new Map(surfaces[surface] as Map<string, Profile>);
  reach.set(name, { ...(reach.get(name) as Profile), ...change });
  return { ...surfaces, [surface]: reach };
}

/** Grants held business-wide. */
const wide = (...keys: string[]) =>
  keys.map((key) => ({ key, scope: { kind: 'business' as const, id: null } }));

/** The catalogue with one row changed by hand. */
function edit(
  rows: readonly CatalogueRow[],
  name: string,
  change: Partial<CatalogueRow>,
): CatalogueRow[] {
  return rows.map((row) =>
    (row.command as string) === name ? Object.assign({}, row, change) : row,
  );
}

/** `task.duplicate` as MP-4-8 will declare it: person only, two-part authority. */
const DUPLICATE: CommandDeclaration = {
  ...(COMMAND_SURFACE.find((one) => one.name === 'task.create') as CommandDeclaration),
  name: 'task.duplicate' as CommandDeclaration['name'],
  authority: ['task:read', 'task:write'],
  agent: 'never',
};

describe('API-1 command catalogue', () => {
  it('API-1 catalogue matches code: one generated row per owning command, none extra', () => {
    const { rows, failures } = real();
    expect(failures).toEqual([]);
    expect(rows.map((row) => row.command)).toEqual(COMMAND_SURFACE.map((one) => one.name));
    const handlers = readFileSync('packages/core-commands/src/commands/handlers.ts', 'utf8');
    for (const row of rows.filter((one) => one.kind === 'write')) {
      expect(handlers).toContain(`'${row.command}':`);
    }
    for (const row of rows) {
      expect(row.permissionKey).toMatch(
        /^[a-z]+:(read|comment|write|assign|decide|share|manage)$/u,
      );
      expect(row.cli).toBe(row.command);
      expect(row.api.person).toMatch(/^\/api\/b\/:businessKey\//u);
      expect(row.dataEffects).toBeNull();
    }
    const party = rows.find((row) => row.command === 'task.set_party');
    expect(party?.rule).toContain('CLIENT_LOCKED (409)');
    // A hand edit to a row is a row that no longer matches the code.
    const edited = edit(rows, 'task.update', { authority: [] });
    expect(checkParity(edited, realSurfaces([]))).toContain(
      'catalogue row task.update skips the grant check task:write the app makes',
    );
  });

  it('API-1 planted parity failure: a stateful button with no CLI command fails the check', () => {
    const files = webFiles();
    const detail = files.get('screens/TaskDetail.tsx') as string;
    files.set('screens/TaskDetail.tsx', `${detail}\nconst planted = 'task.nudge';\n`);
    const uses = scanUses(files, NAMESPACES);
    const failures = checkParity(buildCatalogue(uses), realSurfaces(uses));
    expect(failures).toContain(
      'the app action task.nudge at agency:task-detail (screens/TaskDetail.tsx) has no CLI verb',
    );
    expect(failures).toContain(
      'the app action task.nudge at agency:task-detail (screens/TaskDetail.tsx) has no API endpoint',
    );
    // The CLI losing a verb the app and the API keep: one surface can do what another cannot.
    const surfaces = realSurfaces([]);
    const cli = new Map(surfaces.cli as Map<string, Profile>);
    cli.delete('task.assign');
    expect(checkParity(buildCatalogue([]), { ...surfaces, cli })).toEqual([
      'task.assign has no CLI equivalent',
    ]);
  });

  it('API-1 grant skip caught: a CLI verb or API endpoint that skips a grant the app checks fails', () => {
    const rows = buildCatalogue([]);
    expect(checkParity(rows, planted('cli', 'task.update', { authority: [] }))).toEqual([
      'CLI task.update skips the grant check task:write the app makes',
    ]);
    expect(checkParity(rows, planted('api', 'task.read', { authorisedOn: 'business' }))).toEqual([
      'API task.read asks at business scope where the app asks at record',
    ]);
    expect(checkParity(rows, planted('cli', 'task.set_party', { rule: '' }))).toEqual([
      `CLI task.set_party passes the hold the app keeps: ${profileOf(COMMAND_SURFACE.find((one) => one.name === 'task.set_party') as CommandDeclaration).rule}`,
    ]);
  });

  it('API-1 exempt list: view-only actions are exempt with a reason, and nothing that writes a record is', () => {
    expect(VIEW_ONLY_EXEMPT.length).toBeGreaterThan(0);
    for (const exempt of VIEW_ONLY_EXEMPT) {
      expect(exempt.reason).not.toBe('');
      expect(COMMAND_SURFACE.some((one) => one.name === exempt.action)).toBe(false);
    }
    const surfaces = {
      ...realSurfaces([]),
      exempt: [{ action: 'task.update', reason: 'planted' }],
    };
    expect(checkParity(buildCatalogue([]), surfaces)).toEqual([
      'task.update reads or writes a record and cannot be exempt',
    ]);
  });

  it('API-1 covers merged tickets: every command the app calls today is in the catalogue with its route', () => {
    const { rows } = real();
    const called = new Set<string>();
    // The app's client lists every verb it may send; that is the web surface, not an action.
    for (const [file, text] of webFiles()) {
      if (file === 'operations/client.ts') continue;
      for (const match of text.matchAll(/'([a-z]+\.[a-z_]+)'/gu)) {
        if (NAMESPACES.has((match[1] as string).split('.')[0] as string))
          called.add(match[1] as string);
      }
    }
    for (const command of called) {
      const row = rows.find((one) => one.command === command);
      expect(row, command).toBeDefined();
      expect(row?.ui.length, command).toBeGreaterThan(0);
    }
    const ui = (name: string) => rows.find((row) => row.command === name)?.ui ?? [];
    expect(ui('task.create')).toEqual(['agency:projects-board (screens/Projects.tsx)']);
    expect(ui('task.start')).toEqual(['agency:task-detail (screens/task/Lifecycle.tsx)']);
    expect(ui('settings.set_client_sign_off')).toEqual([
      'agency:settings (screens/settings/use-settings.ts)',
    ]);
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('node scripts/command-parity.mjs --check');
    const required = readFileSync('.github/required-checks.json', 'utf8');
    expect(required).toContain('"command parity"');
  });

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
    expect(agent.map((one) => one.command)).not.toContain('task.update');
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
    const surfaces = { ...realSurfaces([]), api: reach, cli: reach, web: reach };
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

  it('API-1 catalogue canary: the catalogue and report carry no secret, record data or machine path', () => {
    const { rows, failures } = real();
    const text = `${JSON.stringify(rows)}\n${renderReport(rows, failures)}`;
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\|\/private\/|\/tmp\//u);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu);
    expect(text).not.toMatch(/eyJ[\w-]{10,}|bearer\s+\S|@[a-z0-9-]+\.[a-z]{2,}/iu);
    expect(text).not.toMatch(/TSK-\d|alpha|bravo/iu);
    for (const row of rows) for (const place of row.ui) expect(place).not.toMatch(/^\//u);
    expect(renderReport(rows, failures)).toContain('None is missing.');
  });
});
