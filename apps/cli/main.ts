#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one process entry, read top to bottom */
//
// The runnable command line: `pnpm cli <operation> [flags]`, or `ops-astro`
// through a link on PATH (docs/local/CLI.md, "Installing").
//
// A process around `client.ts` and nothing more. It reads its configuration
// from flags and the environment, posts one operation to the API over HTTP and
// prints what came back. It never opens the database, never mints or signs a
// token and never names an actor: the bearer is whatever the identity provider
// issued, and the server resolves it to a login and a business, or refuses.
//
// Credentials stay off the command line and off stdout. The bearer comes from
// `OPS_ASTRO_TOKEN` or the file `login` writes; the delegation credential from
// `OPS_ASTRO_DELEGATION` or the file a successful agent `task.pickup` writes
// (a `run.delegate_child` saves the helper's beside it).
// A pickup's answer is printed with the credential replaced by where it was
// saved, so a terminal log or a shell history never holds it.

import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { signIn } from '../web/src/session/sign-in.ts';
import { withProviderKey } from '../web/src/session/provider-key.ts';
import {
  accepts,
  createCli,
  httpTransport,
  isRefusal,
  isWrite,
  shownAddress,
  statusWatched,
  unknownVerb,
  unredirected,
  usage,
  type CliAnswer,
} from './client.ts';
import { handoffOf } from '../../packages/core-wire/src/index.ts';
import { DEFAULT_WEB, handOff, handoffHelp } from './handoff.ts';
import {
  createVerbCli,
  operationBody as body,
  prepare,
  takesValue,
  UsageError,
  VERB_TABLE,
  verbHelp,
} from './verbs.ts';
import { stepUp } from './second-factor.ts';
import {
  beginSave,
  CredentialsBusy,
  readOptional,
  removeIfHolds,
  saveUnlessSignedOut,
  signOut,
} from './credentials.ts';
import { presetOf, signInAddress, type Preset } from './presets.ts';

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
const VALUED = new Set(['json', 'body-file', 'business', 'api', 'email', 'gotrue', 'web', 'env']);
const SWITCHES = new Set(['help', 'agent', 'second-factor']);

const REPLAY = 'send it again with this operationId to replay';

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

/** Where one run talks to and keeps its credentials: a preset's, or the hand-set and default ones. */
interface Connection {
  readonly preset: Preset | undefined;
  readonly api: string;
  readonly web: string;
  readonly tokenFile: string;
  readonly delegationFile: string;
}

/**
 * The run's connection. Under a preset each credential file name gets the
 * preset's name appended, so a bearer signed in for one origin is never read
 * for another's (`designs/on-cli-rules.md`).
 */
export function connectionOf(flags: Parsed['flags'], env: Environment): Connection {
  let preset: Preset | undefined;
  try {
    preset = presetOf(flags, env);
  } catch (cause) {
    throw new UsageError((cause as Error).message);
  }
  const suffix = preset === undefined ? '' : `.${preset.name}`;
  const api = preset?.origin ?? text(flags, 'api') ?? env['OPS_ASTRO_API_URL'] ?? DEFAULTS.api;
  return {
    preset,
    api: api.replace(/\/$/u, ''),
    web: preset?.origin ?? text(flags, 'web') ?? env['OPS_ASTRO_WEB_URL'] ?? DEFAULT_WEB,
    tokenFile: `${env['OPS_ASTRO_TOKEN_FILE'] ?? DEFAULTS.tokenFile}${suffix}`,
    delegationFile: `${env['OPS_ASTRO_DELEGATION_FILE'] ?? DEFAULTS.delegationFile}${suffix}`,
  };
}

/** The business named by `--business` or `OPS_ASTRO_BUSINESS`, or a refusal. */
function businessOf(flags: Parsed['flags'], env: Environment): string {
  const businessKey = text(flags, 'business') ?? env['OPS_ASTRO_BUSINESS'];
  if (businessKey === undefined || businessKey === '') {
    throw new UsageError('name the business with --business or OPS_ASTRO_BUSINESS');
  }
  return businessKey;
}

/**
 * The bearer and, for an agent, the delegation, each hidden from every line
 * printed after it is read. Under a preset only its own files are read: a
 * hand-set one beside it was refused (`presetOf`), and no other file stands
 * in for a missing one. Without a preset the environment comes before the
 * files ("Manual mode", docs/local/CLI.md).
 */
function credentialsOf(connection: Connection, env: Environment, agent: boolean, io: Shown) {
  const { preset, tokenFile, delegationFile } = connection;
  const hand = (name: string): string | undefined => (preset === undefined ? env[name] : undefined);
  const credential = hand('OPS_ASTRO_TOKEN') ?? readOptional(tokenFile);
  if (credential === undefined || credential === '') {
    throw new UsageError(
      preset === undefined
        ? 'no bearer: set OPS_ASTRO_TOKEN or run `login` first'
        : `no bearer: run \`login --env ${preset.name}\` first`,
    );
  }
  io.hide(credential);
  const delegation = agent
    ? (hand('OPS_ASTRO_DELEGATION') ?? readOptional(delegationFile))
    : undefined;
  io.hide(delegation);
  return { credential, delegation };
}

/**
 * A credential can be saved to `file`, checked before the request that issues
 * it is sent: a pickup that commits with nowhere to keep its credential leaves
 * a lease the agent cannot reach until its delegation expires.
 */
function assertWritable(file: string, what: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    accessSync(dirname(file), constants.W_OK);
    if (existsSync(file)) accessSync(file, constants.W_OK);
  } catch (cause) {
    throw new UsageError(`cannot save ${what} to ${file}: ${(cause as Error).message}`);
  }
}

const HELP = [
  'usage: ops-astro <operation> [--json <object> | --body-file <path>] [--business <key>]',
  '         [--api <url>] [--agent]',
  '       ops-astro <visual operation> [--json <object>] [--web <app origin>]',
  '       ops-astro <operation> --env sandbox|production   (the hosted app: its API,',
  '         pages and sign-in, in place of --api, --gotrue and --web; also login and logout)',
  '       ops-astro login --email <address> [--gotrue <url>]   (password from',
  '         OPS_ASTRO_PASSWORD, the first line of piped stdin,',
  '         or a prompt with echo off at a terminal)',
  '       ops-astro login --email <address> --second-factor   (then the authenticator',
  '         code: the next stdin line, or a hidden prompt)',
  '       ops-astro logout',
  '       (from a checkout without the link, pnpm cli in place of ops-astro)',
  '',
  'environment: OPS_ASTRO_ENV, OPS_ASTRO_API_URL, OPS_ASTRO_BUSINESS, OPS_ASTRO_TOKEN, OPS_ASTRO_TOKEN_FILE,',
  '             OPS_ASTRO_GOTRUE_URL, SUPABASE_PUBLISHABLE_KEY, OPS_ASTRO_AGENT=1,',
  '             OPS_ASTRO_DELEGATION, OPS_ASTRO_DELEGATION_FILE, OPS_ASTRO_WEB_URL',
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

/**
 * A hand-over's helper credential (AW-11) and the child delegation that names
 * its file. A child id that is not a uuid is not a file name, and the
 * credential is still never printed.
 */
function helperCredential(
  answer: CliAnswer,
): { readonly credential: string; readonly child: string } | undefined {
  const credential = pickedUpCredential(answer);
  if (credential === undefined) return undefined;
  const child = (answer.body as { detail: { childDelegationId?: unknown } }).detail
    .childDelegationId;
  const named = typeof child === 'string' && /^[0-9a-f-]{36}$/u.test(child) ? child : 'unnamed';
  return { credential, child: named };
}

function redact(answer: CliAnswer, where: string): unknown {
  const shown = answer.body as { detail: Record<string, unknown> };
  return { ...shown, detail: { ...shown.detail, credential: `(saved to ${where})` } };
}

interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Piped stdin whole, or at a terminal one answer typed after `label` with echo off. */
  readonly stdin: (label?: string) => Promise<string>;
}

/** An `Io` that prints no credential it has been told of. */
interface Shown extends Io {
  readonly hide: (value: string | undefined) => void;
}

/**
 * `io` with each credential this run sent replaced by `(redacted)` in every
 * line, on stdout and stderr: an echoed body, a refusal's fixes, a fault's
 * text. Only the exact value is caught, not an encoded copy; the server's rule
 * against echoing a credential stays the first guard.
 */
function scrubbed(io: Io): Shown {
  const hidden: string[] = [];
  const scrub = (line: string): string =>
    hidden.reduce((said, value) => said.replaceAll(value, '(redacted)'), line);
  return {
    out: (line) => io.out(scrub(line)),
    err: (line) => io.err(scrub(line)),
    stdin: io.stdin,
    hide: (value) => {
      if (value === undefined || value === '') return;
      hidden.push(value);
      // The longer first, so one value inside another is never half shown.
      hidden.sort((one, other) => other.length - one.length);
    },
  };
}

/**
 * The password, and with `--second-factor` the authenticator code, both read
 * before anything is sent: from piped stdin's lines in that order (the code
 * first when OPS_ASTRO_PASSWORD gives the password), or from two hidden
 * prompts. The code never comes from a flag or the environment.
 */
async function secretsOf(env: Environment, io: Io, withCode: boolean) {
  const given = env['OPS_ASTRO_PASSWORD'];
  const typed = given === undefined || given === '' ? (await io.stdin('password')).split('\n') : [];
  const password = (given === undefined || given === '' ? typed[0] : given) ?? '';
  if (password === '') throw new UsageError('login needs a password on stdin');
  if (!withCode) return { password, code: undefined };
  const code =
    (typed[1] ?? '').trim() || ((await io.stdin('authenticator code')).split('\n')[0] ?? '').trim();
  if (code === '')
    throw new UsageError('login --second-factor needs the authenticator code on stdin');
  return { password, code };
}

/**
 * A refused sign-in in the command line's own words. The service's own text
 * can echo what was sent, the password or the key, so it is never printed.
 */
function loginFailure(status: number | undefined, service: string, keyless: boolean): string {
  const at = `the sign-in service at ${service}`;
  if (status === undefined) return `${at} did not answer`;
  if (keyless && status === 401) return `${at} needs SUPABASE_PUBLISHABLE_KEY`;
  if (status === 400 || status === 401) return 'the email or password was not accepted';
  if (status >= 200 && status < 300) return `${at} gave no token`;
  return `${at} refused (HTTP ${String(status)})`;
}

/** The sign-in service and its key: the preset's app names them, as it does for the web. */
async function signInOf(
  parsed: Parsed,
  env: Environment,
  preset: Preset | undefined,
): Promise<{ readonly issuer: string; readonly key: string | undefined } | undefined> {
  if (preset !== undefined) return await signInAddress(preset.origin);
  return {
    issuer: text(parsed.flags, 'gotrue') ?? env['OPS_ASTRO_GOTRUE_URL'] ?? DEFAULTS.gotrue,
    key: env['SUPABASE_PUBLISHABLE_KEY'],
  };
}

/** Where `--second-factor` sends its code: the run's own API, under the business named. */
function stepUpRoute(
  parsed: Parsed,
  env: Environment,
  connection: Connection,
  code: string | undefined,
): { readonly businessKey: string; readonly transport: ReturnType<typeof httpTransport> } {
  const businessKey = text(parsed.flags, 'business') ?? env['OPS_ASTRO_BUSINESS'] ?? '';
  if (code !== undefined && businessKey === '') {
    throw new UsageError(
      'login --second-factor needs the business: --business or OPS_ASTRO_BUSINESS',
    );
  }
  return { businessKey, transport: httpTransport(connection.api) };
}

async function login(parsed: Parsed, env: Environment, io: Io, connection: Connection) {
  const email = text(parsed.flags, 'email') ?? env['OPS_ASTRO_EMAIL'];
  if (email === undefined || email === '') throw new UsageError('login needs --email');
  const { password, code } = await secretsOf(env, io, parsed.flags['second-factor'] === true);
  const { preset, tokenFile } = connection;
  const route = stepUpRoute(parsed, env, connection, code);
  assertWritable(tokenFile, 'the login token');
  const epoch = beginSave(tokenFile);
  const address = await signInOf(parsed, env, preset);
  if (address === undefined) {
    io.err(`login: could not read the sign-in address from ${preset?.origin ?? ''}`);
    return EXIT.refused;
  }
  const { issuer: gotrueUrl, key } = address;
  // The web sign-in's own function: the same password grant, the same endpoint,
  // and the hosted service's publishable key, added to calls under it only.
  const watched = statusWatched(withProviderKey(unredirected, gotrueUrl, key));
  const result = await signIn({ gotrueUrl, email, password, fetch: watched.send });
  if (!result.ok) {
    const keyless = preset === undefined && key === undefined;
    io.err(`login: ${loginFailure(watched.status(), shownAddress(gotrueUrl), keyless)}`);
    return EXIT.refused;
  }
  let token = result.token;
  if (code !== undefined) {
    // The password-only token goes no further than this step: never saved or printed.
    const stepped = await stepUp(route, token, code);
    if (!stepped.ok) {
      io.err(`login: the authenticator code was not accepted: ${stepped.because}`);
      return EXIT.refused;
    }
    token = stepped.token;
  }
  try {
    if (!saveUnlessSignedOut(tokenFile, epoch, tokenFile, token)) {
      io.err('login: signed out while signing in; nothing saved');
      return EXIT.refused;
    }
  } catch (cause) {
    // The token is never printed; signing in again issues another.
    io.err(
      `cli: login succeeded but its token could not be saved to ${tokenFile}: ` +
        (cause as Error).message,
    );
    return EXIT.fault;
  }
  io.out(JSON.stringify({ ok: true, saved: tokenFile }));
  return EXIT.ok;
}

/** `help`, or two words naming a row of the agent CLI's verb table (API-3). */
export function isVerbLine(argv: readonly string[]): boolean {
  const [group, verb] = argv;
  return group === 'help' || VERB_TABLE.some((row) => row.verb === `${group ?? ''} ${verb ?? ''}`);
}

/**
 * A verb line's connection flags, in both forms and never empty; everything
 * else is the verb's. A verb flag's value goes to the verb with it, whatever it
 * looks like, so `--description --env=production` is a description and never
 * chooses the connection.
 */
const CONNECTION_FLAGS = new Set(['api', 'gotrue', 'web', 'env', 'business']);

function connectionFlags(argv: readonly string[]): {
  readonly flags: Parsed['flags'];
  readonly rest: readonly string[];
} {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at] as string;
    const [name = '', inline] = argument.startsWith('--') ? argument.slice(2).split(/=(.*)/su) : [];
    if (name === 'agent') flags['agent'] = true;
    else if (CONNECTION_FLAGS.has(name)) {
      const value = inline ?? argv[(at += 1)];
      if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else {
      rest.push(argument);
      const value = argv[at + 1];
      if (inline === undefined && takesValue(name) && value !== undefined) {
        rest.push(value);
        at += 1;
      }
    }
  }
  return { flags, rest };
}

/**
 * A verb line (`pnpm cli task get <id>`). Everything that can be refused
 * without a credential is refused first: the connection flags, the verb line
 * itself (`prepare`), the preset and the business. Only then are the bearer
 * and the delegation read, and the request sent.
 */
async function verbLine(argv: readonly string[], env: Environment, io: Shown): Promise<number> {
  let send: () => ReturnType<ReturnType<typeof createVerbCli>['send']>;
  try {
    const { flags, rest } = connectionFlags(argv);
    if (rest[0] === 'help') {
      io.out(verbHelp());
      return EXIT.ok;
    }
    const agent = flags['agent'] === true || env['OPS_ASTRO_AGENT'] === '1';
    const prepared = prepare(rest, agent);
    if (!('row' in prepared)) {
      (prepared.exit === EXIT.usage ? io.err : io.out)(prepared.out);
      return prepared.exit;
    }
    const connection = connectionOf(flags, env);
    const businessKey = businessOf(flags, env);
    const { credential, delegation } = credentialsOf(connection, env, agent, io);
    const cli = createVerbCli({
      transport: httpTransport(connection.api),
      businessKey: encodeURIComponent(businessKey),
      credential,
      entry: agent ? 'agent' : 'person',
      ...(delegation === undefined ? {} : { delegation }),
      address: shownAddress(connection.api),
    });
    send = async () => await cli.send(prepared);
  } catch (cause) {
    if (!(cause instanceof UsageError || cause instanceof CredentialsBusy)) throw cause;
    io.err(`cli: ${cause.message}`);
    return EXIT.usage;
  }
  const answer = await send();
  const said = answer.exit === EXIT.transport ? `cli: ${answer.out}` : answer.out;
  (answer.exit === EXIT.usage || answer.exit === EXIT.transport ? io.err : io.out)(said);
  return answer.exit;
}

// eslint-disable-next-line max-lines-per-function, max-statements -- one entry, read top to bottom
export async function main(argv: readonly string[], env: Environment, given: Io): Promise<number> {
  const io = scrubbed(given);
  if (isVerbLine(argv)) return await verbLine(argv, env, io);
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (cause) {
    io.err(`cli: ${(cause as Error).message}`);
    return EXIT.usage;
  }
  const [verb, ...extra] = parsed.positional;
  if (verb === undefined || parsed.flags['help'] === true) {
    for (const line of [...HELP, ...usage().map((name) => `  ${name}`), ...handoffHelp()]) {
      io.out(line);
    }
    return EXIT.ok;
  }

  try {
    if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0] as string}`);
    if (verb === 'login') return await login(parsed, env, io, connectionOf(parsed.flags, env));
    if (verb === 'logout') {
      const { tokenFile, delegationFile } = connectionOf(parsed.flags, env);
      let failed: readonly string[];
      try {
        failed = signOut(tokenFile, [tokenFile, delegationFile]);
      } catch (cause) {
        if (cause instanceof CredentialsBusy) throw cause;
        failed = [`${tokenFile}: ${(cause as Error).message}`];
      }
      for (const one of failed) io.err(`cli: logout could not remove ${one}`);
      if (failed.length > 0) return EXIT.fault;
      io.out(JSON.stringify({ ok: true }));
      return EXIT.ok;
    }
    // AW-09: a visual operation's answer is the app's page, and nothing is sent.
    const handoff = handoffOf(verb);
    if (handoff !== undefined) {
      const { web } = connectionOf(parsed.flags, env);
      const handed = handOff(handoff, body(parsed.flags), web);
      io.out(handed.line);
      return handed.exit;
    }
    if (!accepts(verb)) {
      // Answered here, before any configuration is read or any request sent.
      io.out(JSON.stringify(unknownVerb(verb).body));
      return EXIT.usage;
    }

    const payload = body(parsed.flags);
    const connection = connectionOf(parsed.flags, env);
    const { api, tokenFile, delegationFile } = connection;
    const businessKey = businessOf(parsed.flags, env);
    const agent = parsed.flags['agent'] === true || env['OPS_ASTRO_AGENT'] === '1';
    const { credential, delegation } = credentialsOf(connection, env, agent, io);
    const saves = agent && (verb === 'task.pickup' || verb === 'run.delegate_child');
    if (saves) assertWritable(delegationFile, `${verb}'s credential`);
    // A logout that completes while this waits for its answer wins (`credentials.ts`).
    const epoch = saves ? beginSave(tokenFile) : '';
    // A write replays by its operation id. One is supplied when the caller did
    // not bring one; a caller retrying a write passes its own to get the replay.
    // A person's read carries none: it has nothing to replay, and the registry's
    // `kind` is what says which is which. The agent prefix is the exception: its
    // envelope refuses any call without one, reads included
    // (`packages/core-commands/src/commands/agent-envelope.ts`).
    // The id the command line chose is the caller's only way to replay a write
    // whose answer never arrived, so a transport failure or a fault names it.
    const generated =
      (isWrite(verb) || agent) && !('operationId' in payload) ? randomUUID() : undefined;
    const request = generated === undefined ? payload : { operationId: generated, ...payload };
    const replayHint = (): void => {
      if (generated === undefined) return;
      io.err(`cli: operationId ${generated}; ${REPLAY}`);
    };

    const cli = createCli({
      businessKey: encodeURIComponent(businessKey),
      credential,
      entry: agent ? 'agent' : 'person',
      ...(delegation === undefined ? {} : { delegation }),
      transport: httpTransport(api),
    });

    let answer: CliAnswer;
    try {
      answer = await cli.run(verb, request);
    } catch {
      // Never the failure's own text: it can carry the request, and the
      // request carries the bearer and the delegation (T2 canary token).
      io.err(`cli: no answer from ${shownAddress(api)}`);
      replayHint();
      return EXIT.transport;
    }
    const ok = answer.status >= 200 && answer.status < 300 && answer.body !== undefined;
    const picked = agent && verb === 'task.pickup' && ok ? pickedUpCredential(answer) : undefined;
    if (picked !== undefined) {
      try {
        if (!saveUnlessSignedOut(tokenFile, epoch, delegationFile, picked)) {
          io.err('cli: signed out while picking up; nothing saved');
          io.err(`cli: operationId ${String(request['operationId'])}; ${REPLAY}`);
          return EXIT.fault;
        }
      } catch (cause) {
        // The claim committed and only this machine failed, so this is not a
        // refusal. The credential is never printed; a replay returns it.
        io.err(
          `cli: pickup applied but its credential could not be saved to ${delegationFile}: ` +
            (cause as Error).message,
        );
        io.err(`cli: operationId ${String(request['operationId'])}; ${REPLAY}`);
        return EXIT.fault;
      }
      io.out(JSON.stringify(redact(answer, delegationFile)));
      return EXIT.ok;
    }
    // AW-11: the helper's credential, saved beside the parent's and never printed.
    const handed =
      agent && verb === 'run.delegate_child' && ok ? helperCredential(answer) : undefined;
    if (handed !== undefined) {
      const file = `${delegationFile}.child-${handed.child}`;
      try {
        if (!saveUnlessSignedOut(tokenFile, epoch, file, handed.credential)) {
          io.err('cli: signed out while handing over; nothing saved');
          io.err(`cli: operationId ${String(request['operationId'])}; ${REPLAY}`);
          return EXIT.fault;
        }
      } catch (cause) {
        io.err(
          `cli: hand-over applied but its helper's credential could not be saved to ${file}: ` +
            (cause as Error).message,
        );
        io.err(`cli: operationId ${String(request['operationId'])}; ${REPLAY}`);
        return EXIT.fault;
      }
      io.out(JSON.stringify(redact(answer, file)));
      return EXIT.ok;
    }
    // Only the credential this handback was sent with is over: an older one
    // replayed from the environment leaves a newer saved credential alone.
    const spent = agent && verb === 'task.handback' && ok ? delegation : undefined;
    io.out(answer.body === undefined ? (answer.text ?? '') : JSON.stringify(answer.body));
    if (spent !== undefined) {
      try {
        // Compared and removed under the lock a pickup saves under.
        removeIfHolds(tokenFile, delegationFile, spent);
      } catch (cause) {
        // The handback committed; a replay with its id removes the file.
        io.err(
          `cli: handback applied but its spent credential could not be removed from ` +
            `${delegationFile}: ${(cause as Error).message}`,
        );
        io.err(`cli: operationId ${String(request['operationId'])}; ${REPLAY}`);
        return EXIT.fault;
      }
    }
    if (ok) return EXIT.ok;
    if (isRefusal(answer)) return EXIT.refused;
    replayHint();
    return EXIT.fault;
  } catch (cause) {
    if (!(cause instanceof UsageError || cause instanceof CredentialsBusy)) throw cause;
    io.err(`cli: ${cause.message}`);
    return EXIT.usage;
  }
}

/**
 * A terminal is asked for the password with echo off, so it never shows on the
 * screen; the answer ends at Enter. Ctrl-C or Ctrl-D before Enter gives
 * nothing, and `login` then refuses with exit 2.
 */
async function promptHidden(input: NodeJS.ReadStream, label: string): Promise<string> {
  // Echo goes off before the prompt shows, so nothing typed after it is echoed.
  input.setRawMode(true);
  input.setEncoding('utf8');
  process.stderr.write(`${label}: `);
  try {
    return await new Promise<string>((resolve) => {
      let typed = '';
      const onData = (chunk: string): void => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n' || char === '\u0003' || char === '\u0004') {
            input.off('data', onData);
            resolve(char === '\r' || char === '\n' ? typed : '');
            return;
          }
          typed = char === '\u007F' || char === '\b' ? typed.slice(0, -1) : typed + char;
        }
      };
      input.on('data', onData);
      input.once('end', () => resolve(''));
      // An earlier prompt left the terminal paused; a new listener alone does not take it up again.
      input.resume();
    });
  } finally {
    input.setRawMode(false);
    input.pause();
    process.stderr.write('\n');
  }
}

async function readStdin(label = 'password'): Promise<string> {
  if (process.stdin.isTTY) return await promptHidden(process.stdin, label);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The process entry: `main`, with a throw nothing else expected answered by
 * one fixed line and exit 4. The error's text and stack never print: they can
 * carry what the command line was handling.
 */
export async function run(argv: readonly string[], env: Environment, io: Io): Promise<number> {
  try {
    return await main(argv, env, io);
  } catch {
    io.err('cli: internal fault');
    return EXIT.fault;
  }
}

// The entry point by real path, so a link to it, or a checkout reached through one, still runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  process.exitCode = await run(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    stdin: readStdin,
  });
}
