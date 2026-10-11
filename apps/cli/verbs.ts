// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent CLI's verbs (API-3, CS-15.18): one row per verb onto its owning command, posted
// once; the CLI holds no rule of its own and a refusal is the server's (docs/local/CLI.md).

import { randomUUID } from 'node:crypto';
import { createCli, isRefusal, type CliOptions } from './client.ts';
import { pageText, refusalLine, select, text, writeLine } from './render.ts';
import { COMMAND_SURFACE, type CommandName } from '../../packages/core-wire/src/index.ts';

export interface VerbAnswer {
  readonly exit: number;
  readonly out: string;
}

type Flags = Readonly<Record<string, string | true>>;
type Body = Record<string, unknown>;

export interface VerbRow {
  readonly verb: string;
  readonly command: CommandName;
  /** The words after the verb, as the help shows them. */
  readonly usage: string;
  readonly body: (id: string | undefined, flags: Flags) => Body;
}

const EXIT = { ok: 0, refused: 1, usage: 2, transport: 3, fault: 4 } as const;
const REPLAY = '; send the same line with --operation <that id> to replay';
const DETAILS = new Set(['brief', 'standard', 'full']);
const SWITCHES = new Set(['json']);

class UsageError extends Error {}

const need = (flags: Flags, name: string): string => {
  const value = flags[name];
  if (typeof value !== 'string' || value === '') throw new UsageError(`--${name} is needed`);
  return value;
};
const maybe = (flags: Flags, name: string): string | undefined =>
  typeof flags[name] === 'string' ? flags[name] : undefined;
const target = (id: string | undefined): string => {
  if (id === undefined) throw new UsageError('name the task by its id');
  return id;
};
const revision = (flags: Flags): number => {
  const value = Number(need(flags, 'revision'));
  if (!Number.isInteger(value)) throw new UsageError('--revision is a whole number');
  return value;
};
const detail = (flags: Flags, fallback = 'standard'): string => {
  const value = maybe(flags, 'detail') ?? fallback;
  if (!DETAILS.has(value)) throw new UsageError('--detail is brief, standard or full');
  return value;
};
const revised = (id: string | undefined, flags: Flags): Body => ({
  recordId: target(id),
  expectedRevision: revision(flags),
});
const optional = (key: string, value: string | undefined): Body =>
  value === undefined ? {} : { [key]: value };
const fields = (flags: Flags): Body => ({
  ...optional('title', maybe(flags, 'title')),
  ...optional('description', maybe(flags, 'description')),
});

export const VERB_TABLE: readonly VerbRow[] = [
  {
    verb: 'task get',
    command: 'task.read',
    usage: '<id> [--detail brief|standard|full] [--history-event <id>] [--fields a,b] [--json]',
    // One history entry is looked up in the full detail, which carries the history.
    body: (id, flags) => {
      const event = maybe(flags, 'history-event');
      return {
        recordId: target(id),
        detail: detail(flags, event === undefined ? 'standard' : 'full'),
        ...optional('historyEventId', event),
      };
    },
  },
  {
    verb: 'task list',
    command: 'task.board',
    usage:
      '[--board <id> | --mode aggregate] [--person <id>] [--client <id>] [--limit n] [--page <next>] [--detail ...] [--fields a,b] [--json]',
    body: (_id, flags) => {
      const limit = maybe(flags, 'limit');
      const mode = maybe(flags, 'mode');
      return {
        ...(mode === undefined
          ? { board: maybe(flags, 'board') ?? null }
          : { mode, ...optional('board', maybe(flags, 'board')) }),
        ...optional('person', maybe(flags, 'person')),
        ...optional('client', maybe(flags, 'client')),
        detail: detail(flags),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...optional('page', maybe(flags, 'page')),
      };
    },
  },
  {
    verb: 'task create',
    command: 'task.create',
    usage: '--title <t> [--description <d>] [--parent <id>] [--board <id>] [--type <type>]',
    body: (_id, flags) => ({
      fields: { ...fields(flags), title: need(flags, 'title') },
      ...optional('parentId', maybe(flags, 'parent')),
      ...optional('board', maybe(flags, 'board')),
      ...optional('taskType', maybe(flags, 'type')),
    }),
  },
  {
    verb: 'task update',
    command: 'task.update',
    usage: '<id> --revision n [--title <t>] [--description <d>]',
    body: (id, flags) => ({ ...revised(id, flags), fields: fields(flags) }),
  },
  {
    verb: 'task comment',
    command: 'task.comment',
    usage: '<id> --revision n --text <t> [--audience internal|client]',
    body: (id, flags) => ({
      ...revised(id, flags),
      body: need(flags, 'text'),
      audience: maybe(flags, 'audience') ?? 'internal',
    }),
  },
  {
    verb: 'map view',
    command: 'map.view',
    usage: '<id> [--fields a,b] [--json]',
    body: (id) => ({ recordId: target(id) }),
  },
  {
    verb: 'map frontier',
    command: 'map.frontier',
    usage: '<id> [--fields a,b] [--json]',
    body: (id) => ({ recordId: target(id) }),
  },
];

/** The whole help, as an agent loads it: one line per verb. */
export function verbHelp(): string {
  return [
    'pnpm cli <verb> [args]. Writes print "ok <command> <id> r<revision>"; pass that revision',
    'to the next write. Refusals print one line; exit 0 ok, 1 refused, 2 usage, 3 no answer, 4 fault.',
    'No answer or a fault prints the operationId; send the same line with --operation <id> to replay.',
    ...VERB_TABLE.map((row) => `  ${row.verb} ${row.usage}`),
  ].join('\n');
}

function parse(argv: readonly string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at] as string;
    if (!argument.startsWith('--')) words.push(argument);
    else if (SWITCHES.has(argument.slice(2))) flags[argument.slice(2)] = true;
    else {
      const value = argv[(at += 1)];
      if (value === undefined) throw new UsageError(`${argument} needs a value`);
      flags[argument.slice(2)] = value;
    }
  }
  return { words, flags };
}

const isWrite = (command: CommandName): boolean =>
  COMMAND_SURFACE.some((row) => row.name === command && row.kind === 'write');
const keyOf = (command: CommandName): string => {
  const row = COMMAND_SURFACE.find((one) => one.name === command);
  return row === undefined ? '' : `${row.collection}:${row.action}`;
};

/** The agent prefix's read answer (`detail` under its handle) flattened as the person prefix answers. */
function unwrap(body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const inner = body['detail'];
  return typeof inner === 'object' && inner !== null && 'command' in body
    ? (inner as Readonly<Record<string, unknown>>)
    : body;
}

function shape(row: VerbRow, answered: Readonly<Record<string, unknown>>, flags: Flags): string {
  const body = isWrite(row.command) ? answered : unwrap(answered);
  const picked = maybe(flags, 'fields')?.split(',');
  const asJson = flags['json'] === true;
  if (isWrite(row.command)) return asJson ? JSON.stringify(body) : writeLine(row.command, body);
  if (Array.isArray(body['page'])) {
    const items = (body['page'] as Readonly<Record<string, unknown>>[]).map((item) =>
      select(item, picked),
    );
    const next = typeof body['next'] === 'string' ? body['next'] : null;
    return asJson
      ? JSON.stringify({ items, ...(next === null ? {} : { next }) })
      : pageText(items, next);
  }
  const { ok: _ok, detail: _detail, ...rest } = body;
  const inner = Object.values(rest).length === 1 ? Object.values(rest)[0] : rest;
  const view = select(inner as Readonly<Record<string, unknown>>, picked);
  return asJson ? JSON.stringify(view) : text(view);
}

/** One id per intent: a write or agent call carries `--operation`'s to replay, or a new one. */
function operationOf(row: VerbRow, flags: Flags, agent: boolean): Body {
  const given = maybe(flags, 'operation');
  if (isWrite(row.command) || agent) return { operationId: given ?? randomUUID() };
  if (given !== undefined) throw new UsageError('--operation is for writes');
  return {};
}

export function createVerbCli(options: CliOptions & { readonly address?: string }): {
  readonly run: (argv: readonly string[]) => Promise<VerbAnswer>;
} {
  const cli = createCli(options);
  const agent = options.entry === 'agent';
  return {
    run: async (argv) => {
      let row: VerbRow | undefined;
      let request: Body;
      let flags: Flags;
      try {
        const parsed = parse(argv);
        flags = parsed.flags;
        const [group = 'help', verb, id, ...extra] = parsed.words;
        if (group === 'help') return { exit: EXIT.ok, out: verbHelp() };
        row = VERB_TABLE.find((one) => one.verb === `${group} ${verb ?? ''}`);
        if (row === undefined) throw new UsageError(`no verb ${group} ${verb ?? ''}; run help`);
        if (extra.length > 0) throw new UsageError(`unexpected ${extra[0] as string}`);
        request = { ...operationOf(row, flags, agent), ...row.body(id, flags) };
      } catch (cause) {
        if (!(cause instanceof UsageError)) throw cause;
        return { exit: EXIT.usage, out: `usage: ${cause.message}` };
      }
      // The caller's only way to replay a write whose answer never arrived.
      const { operationId } = request;
      const replay = typeof operationId === 'string' ? `\noperationId ${operationId}${REPLAY}` : '';
      let answer;
      try {
        answer = await cli.run(row.command, request);
      } catch {
        // Never the failure's own text: it can carry a secret (T2 canary token).
        return {
          exit: EXIT.transport,
          out: `no answer from ${options.address ?? 'the API'}${replay}`,
        };
      }
      const body = (answer.body ?? {}) as Readonly<Record<string, unknown>>;
      if (isRefusal(answer))
        return { exit: EXIT.refused, out: refusalLine(body, keyOf(row.command)) };
      if (answer.status < 200 || answer.status >= 300 || answer.body === undefined) {
        return { exit: EXIT.fault, out: `fault ${String(answer.status)}${replay}` };
      }
      return { exit: EXIT.ok, out: shape(row, body, flags) };
    },
  };
}
