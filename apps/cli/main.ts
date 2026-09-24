// SPDX-License-Identifier: AGPL-3.0-only
//
// The runnable command line: `pnpm cli <operation> [flags]`.
//
// A process around `client.ts` and nothing more. It reads its configuration
// from flags and the environment, posts one operation to the API over HTTP and
// prints what came back. It never opens the database, never mints or signs a
// token and never names an actor: the bearer is whatever the identity provider
// issued, and the server resolves it to a login and a business, or refuses.
//
// Credentials stay off the command line and off stdout. The bearer comes from
// `OPS_ASTRO_TOKEN` or the file `login` writes; the delegation credential from
// `OPS_ASTRO_DELEGATION` or the file a successful agent `task.pickup` writes.
// A pickup's answer is printed with the credential replaced by where it was
// saved, so a terminal log or a shell history never holds it.

import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { signIn } from '../web/src/session/sign-in.ts';
import {
  DELEGATION_HEADER,
  accepts,
  createCli,
  isRefusal,
  isWrite,
  unknownVerb,
  usage,
  type CliAnswer,
} from './client.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Exit codes, as `docs/local/CLI.md` lists them. `fault` is an answer that is
 * neither a success nor a refusal: a 5xx, or any non-2xx or non-JSON answer
 * without the `refused` flag.
 */
export const EXIT = { ok: 0, refused: 1, usage: 2, transport: 3, fault: 4 } as const;

const DEFAULTS = {
  api: 'http://127.0.0.1:8790',
  gotrue: 'http://127.0.0.1:54391',
  tokenFile: join(ROOT, '.local', 'cli-token'),
  delegationFile: join(ROOT, '.local', 'cli-delegation'),
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

interface Parsed {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

/** Flags that take a value; every other `--name` is a switch. */
const VALUED = new Set(['json', 'body-file', 'business', 'api', 'email', 'gotrue']);
const SWITCHES = new Set(['help', 'agent']);

class UsageError extends Error {}

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at] as string;
    if (argument === '-h') {
      flags['help'] = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const [name = '', inline] = argument.slice(2).split(/=(.*)/su);
    if (SWITCHES.has(name)) flags[name] = true;
    else if (VALUED.has(name)) {
      const value = inline ?? argv[(at += 1)];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else throw new UsageError(`unknown flag --${name}`);
  }
  return { positional, flags };
}

function text(flags: Parsed['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function readOptional(file: string): string | undefined {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Written readable by the owner only, as a credential file should be. */
function writeSecret(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function body(flags: Parsed['flags']): Record<string, unknown> {
  const inline = text(flags, 'json');
  const file = text(flags, 'body-file');
  if (inline !== undefined && file !== undefined) {
    throw new UsageError('pass --json or --body-file, not both');
  }
  let source = '{}';
  if (inline !== undefined) source = inline;
  else if (file !== undefined) {
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      throw new UsageError(`cannot read --body-file ${file}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new UsageError('the body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError('the body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const HELP = [
  'usage: pnpm cli <operation> [--json <object> | --body-file <path>] [--business <key>]',
  '                               [--api <url>] [--agent]',
  '       pnpm cli login --email <address> [--gotrue <url>]   (password from',
  '                               OPS_ASTRO_PASSWORD or the first line of stdin)',
  '       pnpm cli logout',
  '',
  'environment: OPS_ASTRO_API_URL, OPS_ASTRO_BUSINESS, OPS_ASTRO_TOKEN, OPS_ASTRO_TOKEN_FILE,',
  '             OPS_ASTRO_GOTRUE_URL, OPS_ASTRO_AGENT=1, OPS_ASTRO_DELEGATION,',
  '             OPS_ASTRO_DELEGATION_FILE',
  'exit codes:  0 answered, 1 refused, 2 usage (no request sent), 3 transport failure,',
  '             4 fault (an answer that is neither a success nor a refusal)',
  '',
  'operations:',
];

/** The answer's credential, if this is a pickup that returned one. */
function pickedUpCredential(answer: CliAnswer): string | undefined {
  const detail = (answer.body as { detail?: { credential?: unknown } } | null)?.detail;
  return typeof detail?.credential === 'string' ? detail.credential : undefined;
}

function redact(answer: CliAnswer, where: string): unknown {
  const shown = answer.body as { detail: Record<string, unknown> };
  return { ...shown, detail: { ...shown.detail, credential: `(saved to ${where})` } };
}

interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly stdin: () => Promise<string>;
}

async function login(parsed: Parsed, env: Environment, io: Io, tokenFile: string) {
  const email = text(parsed.flags, 'email') ?? env['OPS_ASTRO_EMAIL'];
  if (email === undefined || email === '') throw new UsageError('login needs --email');
  const password = env['OPS_ASTRO_PASSWORD'] ?? (await io.stdin()).split('\n')[0] ?? '';
  if (password === '') throw new UsageError('login needs a password on stdin');
  const gotrueUrl = text(parsed.flags, 'gotrue') ?? env['OPS_ASTRO_GOTRUE_URL'] ?? DEFAULTS.gotrue;
  // The web sign-in's own function: the same password grant, the same endpoint.
  const result = await signIn({ gotrueUrl, email, password, fetch: globalThis.fetch });
  if (!result.ok) {
    io.err(`login: ${result.because}`);
    return EXIT.refused;
  }
  writeSecret(tokenFile, result.token);
  io.out(JSON.stringify({ ok: true, saved: tokenFile }));
  return EXIT.ok;
}

// eslint-disable-next-line max-lines-per-function, max-statements -- one entry, read top to bottom
export async function main(argv: readonly string[], env: Environment, io: Io): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (cause) {
    io.err(`cli: ${(cause as Error).message}`);
    return EXIT.usage;
  }
  const [verb, ...extra] = parsed.positional;
  if (verb === undefined || parsed.flags['help'] === true) {
    for (const line of [...HELP, ...usage().map((name) => `  ${name}`)]) io.out(line);
    return EXIT.ok;
  }
  const tokenFile = env['OPS_ASTRO_TOKEN_FILE'] ?? DEFAULTS.tokenFile;
  const delegationFile = env['OPS_ASTRO_DELEGATION_FILE'] ?? DEFAULTS.delegationFile;

  try {
    if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0] as string}`);
    if (verb === 'login') return await login(parsed, env, io, tokenFile);
    if (verb === 'logout') {
      rmSync(tokenFile, { force: true });
      rmSync(delegationFile, { force: true });
      io.out(JSON.stringify({ ok: true }));
      return EXIT.ok;
    }
    if (!accepts(verb)) {
      // Answered here, before any configuration is read or any request sent.
      io.out(JSON.stringify(unknownVerb(verb).body));
      return EXIT.usage;
    }

    const payload = body(parsed.flags);
    const businessKey = text(parsed.flags, 'business') ?? env['OPS_ASTRO_BUSINESS'];
    if (businessKey === undefined || businessKey === '') {
      throw new UsageError('name the business with --business or OPS_ASTRO_BUSINESS');
    }
    const credential = env['OPS_ASTRO_TOKEN'] ?? readOptional(tokenFile);
    if (credential === undefined || credential === '') {
      throw new UsageError('no bearer: set OPS_ASTRO_TOKEN or run `login` first');
    }
    const agent = parsed.flags['agent'] === true || env['OPS_ASTRO_AGENT'] === '1';
    const delegation = agent
      ? (env['OPS_ASTRO_DELEGATION'] ?? readOptional(delegationFile))
      : undefined;
    const api = (text(parsed.flags, 'api') ?? env['OPS_ASTRO_API_URL'] ?? DEFAULTS.api).replace(
      /\/$/u,
      '',
    );
    // A write replays by its operation id. One is supplied when the caller did
    // not bring one; a caller retrying a write passes its own to get the replay.
    // A person's read carries none: it has nothing to replay, and the registry's
    // `kind` is what says which is which. The agent prefix is the exception: its
    // envelope refuses any call without one, reads included
    // (`packages/core-records/src/commands/agent-envelope.ts`).
    const request = isWrite(verb) || agent ? { operationId: randomUUID(), ...payload } : payload;

    const cli = createCli({
      businessKey: encodeURIComponent(businessKey),
      credential,
      entry: agent ? 'agent' : 'person',
      ...(delegation === undefined ? {} : { delegation }),
      transport: async (path, sent, bearer, held) =>
        await fetch(`${api}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${bearer}`,
            ...(held === undefined ? {} : { [DELEGATION_HEADER]: held }),
          },
          body: sent,
        }),
    });

    let answer: CliAnswer;
    try {
      answer = await cli.run(verb, request);
    } catch (cause) {
      io.err(`cli: no answer from ${api}: ${(cause as Error).message}`);
      return EXIT.transport;
    }
    const ok = answer.status >= 200 && answer.status < 300 && answer.body !== undefined;
    const picked = agent && verb === 'task.pickup' && ok ? pickedUpCredential(answer) : undefined;
    if (picked !== undefined) {
      writeSecret(delegationFile, picked);
      io.out(JSON.stringify(redact(answer, delegationFile)));
      return EXIT.ok;
    }
    if (agent && verb === 'task.handback' && ok) rmSync(delegationFile, { force: true });
    io.out(answer.body === undefined ? (answer.text ?? '') : JSON.stringify(answer.body));
    if (ok) return EXIT.ok;
    return isRefusal(answer) ? EXIT.refused : EXIT.fault;
  } catch (cause) {
    if (!(cause instanceof UsageError)) throw cause;
    io.err(`cli: ${cause.message}`);
    return EXIT.usage;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    stdin: readStdin,
  });
}
