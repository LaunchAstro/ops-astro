// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-11: small simplifications and the accepted clean-up list (product issue 59).
//
// One case per supporting checklist line. The static cases read the tree; the
// database cases show the comment and control paths, and the installer's
// visibility step, keep every business, client and person to their own rows.

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as commands from '../../packages/core-commands/src/index.ts';
import { refuseNotFound } from '../../packages/core-commands/src/commands/refusal.ts';
import { writeTaskComment } from '../../packages/core-commands/src/commands/tasks-comment.ts';
import type { TaskRow } from '../../packages/core-commands/src/commands/context.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import { configuredCredentialKeys } from '../../packages/core-records/src/authority/credential-keys.ts';
import type { BusinessId, TenantQuery } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { COMMAND_SURFACE, declarationOf } from '../../packages/core-wire/src/surface.ts';
import { usage } from '../../apps/cli/client.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from './fixture.ts';

const ROOTS = ['apps', 'packages', 'scripts', 'tests'];

const sources = (): string[] =>
  ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(?:m?js|tsx?)$/u.test(file) && !file.includes('node_modules'))
      .map((file) => `${root}/${file}`),
  );

/**
 * The hand-written `KEY=value` readers this ticket replaced: a pattern built
 * from a setting name, a literal `^NAME=(.+)$`, a `.env` file read directly,
 * and a split at the first `=`.
 */
const HAND_READERS = [
  /RegExp\(`\^\$\{\w+\}=/u,
  /\/\^[A-Z_]+=\(\.[+*]\)\$\//u,
  /readFileSync\([^)]*\.env\b/u,
  /indexOf\('='\)/u,
];
const handReaders = (text: string): boolean => HAND_READERS.some((pattern) => pattern.test(text));

const carrying = (key: string): string[] =>
  COMMAND_SURFACE.filter((command) => key in command).map((command) => command.name);
const scratch = (): string => mkdtempSync(join(tmpdir(), 'cq11-'));
const read = (file: string): string => readFileSync(`packages/${file}`, 'utf8');

describe('CQ-11 the tree', () => {
  it('CQ-11 one env-file reader: exactly one remains, and it uses util.parseEnv', () => {
    const found = sources().filter(
      (file) => file !== 'tests/commands/cq-11.test.ts' && handReaders(readFileSync(file, 'utf8')),
    );
    expect(found).toStrictEqual([]);
    const helper = read('core-records/src/env-file.ts');
    expect(helper).toContain("import { parseEnv } from 'node:util';");
    expect(helper).toContain('parseEnv(text)');
    // The scan is not blind: each reader it replaced is still seen.
    for (const planted of [
      'new RegExp(`^${name}=(.+)$`, "u")',
      '/^GOTRUE_URL=(.+)$/u.exec(line)',
      "readFileSync(`${root}.local/db.env`, 'utf8')",
      "const at = trimmed.indexOf('=');",
    ]) {
      expect(handReaders(planted), planted).toBe(true);
    }
  });

  it('CQ-11 one env-file reader: comments, blanks and space are dropped, a missing file is empty', () => {
    const dir = scratch();
    try {
      const file = join(dir, 'local.env');
      writeFileSync(file, '# a comment\n\nDATABASE_URL=pg://a@h/d\n  GOTRUE_URL = http://x \n');
      expect(readEnvFile(file)).toStrictEqual({
        DATABASE_URL: 'pg://a@h/d',
        GOTRUE_URL: 'http://x',
      });
      expect(readEnvFile(join(dir, 'absent.env'))).toStrictEqual({});
      expect(() => readEnvFile(join(dir, 'absent.env'), { required: true })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CQ-11 contractNine and the empty custody directory are gone, and ARCHITECTURE.md says when it is created', () => {
    expect(carrying('contractNine')).toStrictEqual([]);
    expect(existsSync('packages/core-custody')).toBe(false);
    const architecture = readFileSync('ARCHITECTURE.md', 'utf8');
    const custody = architecture.split('\n').find((line) => line.includes('packages/core-custody'));
    expect(custody).toContain('The package is created by the ticket that builds it.');
    // C80 created the provider-operations package; its row now says what it holds.
    expect(existsSync('packages/core-connectors/src/index.ts')).toBe(true);
    const connectors = architecture
      .split('\n')
      .find((line) => line.includes('packages/core-connectors'));
    expect(connectors).toContain('(C80)');
  });

  it('CQ-11 landed, waitingOn and pending.ts are gone, and so is the CLI suffix they fed', () => {
    expect(existsSync('packages/core-commands/src/commands/pending.ts')).toBe(false);
    expect([...carrying('landed'), ...carrying('waitingOn')]).toStrictEqual([]);
    expect(usage()).toStrictEqual(COMMAND_SURFACE.map((command) => command.name));
    expect(read('core-commands/src/commands/tasks-comment.ts')).not.toContain('refuseUnlanded');
  });

  it('CQ-11 the live refusal: a comment on a business with no comment type still refuses, plainly', async () => {
    const target = { id: randomUUID(), revision: 1, deleted_at: null } as unknown as TaskRow;
    // Refused before any statement, so no query is made.
    const tx = { query: vi.fn(), execute: vi.fn() } as unknown as TenantQuery;
    const answer = await writeTaskComment(
      tx,
      {
        commentTypeId: undefined,
        declaration: declarationOf('task.comment'),
        target,
        authorActorId: randomUUID(),
        entryPoint: 'api',
        audiences: new Set(['internal', 'client']),
      },
      'a body',
      'internal',
      undefined,
    );
    expect(answer).toStrictEqual({
      refusal: {
        refused: true,
        code: 'DEPENDENCY_NOT_LANDED',
        names: ['task.comment', 'task_comment'],
        fixes: [
          'This business has no comment record type installed, so it cannot hold a comment.',
          'It is not a permission problem and retrying will not change it.',
        ],
      },
    });
    expect(tx.query).not.toHaveBeenCalled();
  });

  it('CQ-11 issue 59: the not-found names, the installer’s visibility step and typed handback operands', () => {
    // The not-found refusal takes its names, the same bytes as the hand spread.
    const spread = { ...refuseNotFound(), names: ['lineageId'] };
    expect(refuseNotFound(['lineageId'])).toStrictEqual(spread);
    expect(read('core-commands/src/commands/tasks-controls.ts')).not.toContain(
      '...refuseNotFound()',
    );
    // The visibility step is the installer's own, with one declared default.
    expect(existsSync('packages/core-records/src/tasks/reconcile-visibility.ts')).toBe(false);
    const install = read('core-records/src/tasks/install.ts');
    expect(install.match(/visibilityClass \?\? 'internal'/gu)).toHaveLength(1);
    // The handback operands carry the lease and the actual, typed.
    const operations = read('core-commands/src/commands/agent-operations.ts');
    expect(operations).not.toContain("request['actualMinor'] as");
    expect(operations).toContain('leaseId: operands.leaseId');
  });

  it('CQ-11 canary: a planted canary secret in the key and environment files reaches no environment, log, error or answer', () => {
    const dir = scratch();
    const canary = randomBytes(32).toString('base64url');
    const before = JSON.stringify(process.env);
    const lines: unknown[] = [];
    const push = (...parts: unknown[]) => lines.push(...parts) > 0;
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(push),
    );
    try {
      const envFile = join(dir, 'gate.env');
      writeFileSync(envFile, `GATE_SIGNING_KEY_ID=cq11@1\nGATE_SIGNING_SECRET=${canary}\n`);
      const gate = readEnvFile(envFile);
      expect(gate['GATE_SIGNING_SECRET']).toBe(canary);
      // A key file whose active id names no key in its keyring: refused, by name.
      const keyFile = join(dir, 'delegation.env');
      writeFileSync(
        keyFile,
        `DELEGATION_CREDENTIAL_KEY_ID=cq11@missing\nDELEGATION_CREDENTIAL_KEYS=cq11@1:${canary}\n`,
      );
      const decision = configuredCredentialKeys({ DELEGATION_CREDENTIAL_KEY_FILE: keyFile });
      expect(decision.ok).toBe(false);
      let thrown = '';
      try {
        readEnvFile(join(dir, 'absent.env'), { required: true });
      } catch (cause) {
        thrown = String(cause);
      }
      expect(thrown).not.toBe('');
      const seen = [JSON.stringify(decision), thrown, lines.map(String).join('\n')];
      expect(seen.join('\n')).not.toContain(canary);
      expect(JSON.stringify(process.env)).toBe(before);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const serverUrl = databaseUrlFromEnvironment();
type Command = Parameters<typeof commands.executeCommand>[4];
type Read = Parameters<typeof commands.executeRead>[3];
type Task = { readonly id: string; readonly title: string; readonly client: Member };
type Party = { readonly id: BusinessId; readonly member: Member; readonly tasks: Task[] };

describe.skipIf(serverUrl === undefined)('CQ-11 through the command entry', () => {
  let db: FreshDatabase;
  let bravo: Party;
  let charlie: Party;

  const command = async (business: BusinessId, who: Member, body: object) =>
    await commands.executeCommand(db.app, business, who.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as Command);

  /** A business whose member holds one grant of each kind it uses, and two clients one share each. */
  async function party(key: string): Promise<Party> {
    const id = (await insertBusiness(db.app, key)) as BusinessId;
    await installSpine(db.app, id);
    const member = await enrol(db.app, id, `${key}-member`);
    await db.app.withBusiness(id, async (tx) => {
      for (const action of ['write', 'read', 'share', 'comment'] as const) {
        await grantTo(tx, member, action); // eslint-disable-line no-await-in-loop
      }
    });
    const tasks: Task[] = [];
    for (const n of [1, 2]) {
      const title = `cq11-${key}-${String(n)}-${randomUUID()}`;
      // eslint-disable-next-line no-await-in-loop
      const made = await command(id, member, { command: 'task.create', fields: { title } });
      if (commands.isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
      const recordId = String(made.recordId);
      // eslint-disable-next-line no-await-in-loop
      const shared = await shareWithClient(db.app, id, member, recordId);
      tasks.push({ id: recordId, title, client: shared });
    }
    return { id, member, tasks };
  }

  /** The two paths this ticket changed: a comment, and a control naming a lineage. */
  const reach = async (business: BusinessId, taskId: string, who: Member, body: string) =>
    JSON.stringify(
      await Promise.all([
        command(business, who, {
          command: 'task.comment',
          recordId: taskId,
          expectedRevision: 1,
          body,
          audience: 'client',
        }),
        command(business, who, {
          command: 'task.cancel',
          recordId: taskId,
          lineageId: randomUUID(),
          reason: body,
        }),
      ]),
    ).replaceAll(taskId, 'ID');

  /** A read as `who`, with the record it names written out as `ID`. */
  const ask = async (business: BusinessId, who: Member, body: { read: string; recordId: string }) =>
    JSON.stringify(
      await commands.executeRead(db.app, business, who.presented, body as Read),
    ).replaceAll(body.recordId, 'ID');

  const comments = async (business: BusinessId) =>
    await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.records r
         join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
        where r.business_id = $1 and t.key = 'task_comment'`,
      [business],
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'cq11' });
    bravo = await party('bravo');
    charlie = await party('charlie');
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('CQ-11 isolation: two businesses, two clients, one grant each; no comment or control reaches another', async () => {
    const before = [await comments(bravo.id), await comments(charlie.id)];
    for (const p of [bravo, charlie]) {
      const [one, two] = p.tasks as [Task, Task];
      const ghost = randomUUID();
      // Person to person: a member holding no grant is answered as for a made-up id.
      const stranger = await enrol(db.app, p.id, `stranger-${randomUUID()}`); // eslint-disable-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      const [theirs, nobody] = await Promise.all([
        reach(p.id, one.id, stranger, 'p2p'),
        reach(p.id, ghost, stranger, 'p2p'),
      ]);
      expect(theirs).toBe(nobody);
      expect(theirs).not.toContain(one.title);
      // Client to client: the client of task one aims at task two.
      // eslint-disable-next-line no-await-in-loop
      const [other, none] = await Promise.all([
        reach(p.id, two.id, one.client, 'c2c'),
        reach(p.id, ghost, one.client, 'c2c'),
      ]);
      expect(other).toBe(none);
      expect(other).not.toContain(two.title);
    }
    // Business to business: each member aims at the other business's tasks
    // under its own business, and is answered as for a made-up id.
    for (const from of [bravo, charlie]) {
      const to = from === bravo ? charlie : bravo;
      for (const task of to.tasks) {
        // eslint-disable-next-line no-await-in-loop
        const [across, made] = await Promise.all([
          reach(from.id, task.id, from.member, 'b2b'),
          reach(from.id, randomUUID(), from.member, 'b2b'),
        ]);
        expect(across).toBe(made);
        expect(across).not.toContain(task.title);
      }
    }
    expect([await comments(bravo.id), await comments(charlie.id)]).toStrictEqual(before);
  });

  it('CQ-11 isolation: the installer brings one business’s title and state forward and leaves the other’s alone', async () => {
    const classes = async (business: BusinessId) =>
      (
        await db.admin.execute<{ readonly visibility_class: string }>(
          `select f.visibility_class from public.field_defs f
             join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
            where f.business_id = $1 and t.key = 'task' and f.key in ('title', 'state')`,
          [business],
        )
      ).map((row) => row.visibility_class);
    for (const business of [bravo.id, charlie.id]) {
      // eslint-disable-next-line no-await-in-loop
      await db.admin.execute(
        `update public.field_defs set visibility_class = 'internal'
          where business_id = $1 and key in ('title', 'state') and origin = 'core'`,
        [business],
      );
    }
    const [mine, theirs] = bravo.tasks as [Task, Task];
    const [elsewhere] = charlie.tasks as [Task];
    /** `task.read` by a client, aimed at `task`. */
    const asClient = async (business: BusinessId, who: Member, task: { id: string }) =>
      await ask(business, who, { read: 'task.read', recordId: task.id });
    // Before: a business installed ahead of I09 shows its client no title.
    expect(await asClient(bravo.id, mine.client, mine)).not.toContain(mine.title);
    await installSpine(db.app, bravo.id);
    expect(await classes(bravo.id)).toStrictEqual(['shared', 'shared']);
    expect(await classes(charlie.id)).toStrictEqual(['internal', 'internal']);
    // After: the client reads its own task's title through the shared view.
    expect(await asClient(bravo.id, mine.client, mine)).toContain(mine.title);
    // Another client's task and another business's are answered as a made-up id.
    // Each client aims at the other's task, and at another business's tasks.
    const probes = [theirs, ...charlie.tasks].map((task) => [mine.client, task] as const);
    for (const [who, task] of [...probes, [theirs.client, mine] as const]) {
      // eslint-disable-next-line no-await-in-loop
      const [across, ghost] = await Promise.all([
        asClient(bravo.id, who, task),
        asClient(bravo.id, who, { id: randomUUID() }),
      ]);
      expect(across).toBe(ghost);
      expect(across).not.toContain(task.title);
    }
    // The other business is untouched until its own install brings it forward.
    expect(await asClient(charlie.id, elsewhere.client, elsewhere)).not.toContain(elsewhere.title);
    await installSpine(db.app, charlie.id);
    expect(await classes(charlie.id)).toStrictEqual(['shared', 'shared']);
    expect(await asClient(charlie.id, elsewhere.client, elsewhere)).toContain(elsewhere.title);
  });

  it('CQ-11 canary: planted record content and a canary secret reach no answer, trace or audit payload', async () => {
    const canary = `GATE_SIGNING_SECRET=cq11-canary-${randomUUID()}`;
    // Stored as a task's content in bravo, and read back by its own member.
    const made = await command(bravo.id, bravo.member, {
      command: 'task.create',
      fields: { title: canary },
    });
    if (commands.isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    const planted = String(made.recordId);
    const own = await ask(bravo.id, bravo.member, { read: 'task.read', recordId: planted });
    expect(own).toContain(canary);
    // Then reached for across each boundary: another business's member, a
    // client it was never shared with, and the comment and control paths.
    const [client] = bravo.tasks as [Task];
    const answers = [
      await ask(charlie.id, charlie.member, { read: 'task.read', recordId: planted }),
      await ask(bravo.id, client.client, { read: 'task.read', recordId: planted }),
      await reach(charlie.id, planted, charlie.member, 'b2b'),
      await reach(bravo.id, planted, client.client, 'c2c'),
    ];
    const audit = await db.admin.execute<{ readonly row: string }>(
      'select to_jsonb(a)::text as row from public.audit_events a',
    );
    const traces = JSON.stringify(db.app.log.entries);
    expect(JSON.stringify([answers, audit, traces])).not.toContain(canary);
  });
});
