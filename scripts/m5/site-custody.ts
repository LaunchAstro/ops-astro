// SPDX-License-Identifier: AGPL-3.0-only
//
// The agency site's two credentials in custody on the M5 (#1691; ADR 0028,
// custody is the only holder of credentials). `source_control` is a GitHub
// token for the site's repository and `hosting` a Vercel token for its
// project. Custody sends each only to its own origin, on the catalogued routes
// `siteDestination` derives. The owner's steps are deploy/m5/site-custody.md.
//
//   <password manager> | node scripts/m5/site-custody.ts load \
//     --entry <source_control|hosting> --file <credential file>
//   <password manager> | node scripts/m5/site-custody.ts load-app \
//     --app-id <id> --file <credential file>
//   node scripts/m5/site-custody.ts bind --party <id> \
//     --repository <owner/name> --installation <id> --file <credential file>
//   node scripts/m5/site-custody.ts smoke --file <credential file> [--party <id>]
//
// `load` takes the value on standard input alone, never an argument or a
// setting, adds the entry once to the owner-only file under a lock, and reads
// it back. `load-app` files the GitHub App's private key the same way as the
// `source_control` entry (#1793), and `bind` gives one party its one site
// repository under that App; custody then mints a token per call. `smoke`
// checks the file's kind, owner and mode, and for a named party reads only
// that party's bound repository from it, never a value. It then reads the
// About page's source from that repository (the agency's when no party is
// named) and the production deployment through custody's own process, and
// nothing else. No origin is taken from the command line, so a
// token goes only to its provider. No line any command prints carries a
// value: each names an entry, a repository, an operation or a code.

import { closeSync } from 'node:fs';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import {
  callConnector,
  siteOperation,
  systemResolver,
  type CallDependencies,
  type Resolver,
} from '../../packages/core-connectors/src/index.ts';
import {
  siteCustody,
  siteDestination,
  startCustody,
} from '../../packages/core-custody/src/index.ts';
import { sameRepository } from '../../packages/core-custody/src/app-entry.ts';
import {
  boundRepository,
  changeUnderLock,
  fileOnce,
  openOwnerOnly,
  refOf,
  type Refusal,
} from './site-custody-file.ts';

type Entry = 'source_control' | 'hosting';

const ORIGINS: Readonly<Record<Entry, string>> = {
  source_control: 'https://api.github.com',
  hosting: 'https://api.vercel.com',
};
/** What each token is scoped to: one repository, one project. */
const ACCOUNTS: Readonly<Record<Entry, string>> = {
  source_control: 'agency-astro-astro',
  hosting: 'agency-astro-web',
};
const ABOUT = {
  repository: 'LaunchAstro/agency-astro-astro',
  path: 'src/pages/about.astro',
  ref: 'main',
};
const PROJECT = { project: 'prj_ZP8jeokQCN6SJsyuzkz4ISihdlHm' };

const isEntry = (name: string): name is Entry => Object.hasOwn(ORIGINS, name);

/** Adds one entry to the credential file once and reads it back. */
export function loadSiteEntry(
  file: string,
  entry: string,
  value: string,
): 'loaded' | 'already loaded' | Refusal {
  if (!isEntry(entry)) return 'refused ENTRY_UNKNOWN';
  return fileOnce(file, {
    ref: entry,
    kind: 'api_key',
    account: ACCOUNTS[entry],
    destination: entry,
    header: 'authorization',
    scheme: 'bearer',
    value,
  });
}

/**
 * Files the LaunchAstro GitHub App's private key as the `source_control`
 * entry, with no repository bound yet (#1793). Custody mints with it; it is
 * never sent.
 */
export function loadSiteApp(
  file: string,
  appId: string,
  key: string,
): 'loaded' | 'already loaded' | Refusal {
  return fileOnce(file, {
    ref: 'source_control',
    kind: 'api_key',
    account: `github-app-${appId}`,
    destination: 'source_control',
    header: 'authorization',
    scheme: 'github_app',
    app: { id: appId, bindings: [] },
    value: key,
  });
}

interface AppFiled {
  readonly app: { readonly id: string; readonly bindings: readonly Record<string, unknown>[] };
}

/**
 * Binds one party to its site repository and the App installation on it: a
 * party reaches one repository, and a repository belongs to one party.
 */
export function bindSiteRepository(
  file: string,
  binding: { readonly party: string; readonly repository: string; readonly installation: string },
): 'bound' | 'already bound' | Refusal {
  if (!/^[1-9][0-9]{0,15}$/u.test(binding.installation)) return 'refused CREDENTIAL_MALFORMED';
  const wanted = { ...binding, installation: Number(binding.installation) };
  const outcome = changeUnderLock(file, (entries) => {
    const at = entries.findIndex((one) => refOf(one) === 'source_control');
    const entry = entries[at] as (Record<string, unknown> & Partial<AppFiled>) | undefined;
    if (entry?.['scheme'] !== 'github_app' || entry.app === undefined)
      return 'refused APP_NOT_LOADED';
    const { bindings } = entry.app;
    if (bindings.some((one) => isDeepStrictEqual(one, wanted))) return 'unchanged';
    if (bindings.some((one) => one['party'] === wanted.party)) return 'refused PARTY_ALREADY_BOUND';
    if (bindings.some((one) => sameRepository(String(one['repository']), wanted.repository)))
      return 'refused REPOSITORY_ALREADY_BOUND';
    const filed = { ...entry, app: { ...entry.app, bindings: [...bindings, wanted] } };
    return { entries: entries.with(at, filed), filed };
  });
  return outcome === 'done' ? 'bound' : outcome === 'unchanged' ? 'already bound' : outcome;
}

export interface SmokeOptions {
  /** The party whose bound repository the source read is for: needed once the entry is an App. */
  readonly party?: string;
  /** A test's stand-in origins; the command line never sets them. */
  readonly origins?: Readonly<Record<Entry, string>>;
  readonly resolve?: Resolver;
}

/**
 * Reads the About source, from the party's bound repository when one is named,
 * and the production deployment through custody: ok when both answer.
 */
export async function smokeSite(
  file: string,
  { party, origins = ORIGINS, resolve = systemResolver }: SmokeOptions = {},
): Promise<{ ok: boolean; lines: string[] }> {
  // The file's kind, owner and mode, and a named party's repository: its values are custody's alone.
  const fd = openOwnerOnly(file);
  if (fd === 'absent') return { ok: false, lines: ['refused LOAD_FILE_UNREADABLE'] };
  if (typeof fd === 'string') return { ok: false, lines: [fd] };
  closeSync(fd);
  // An unbound party keeps the agency's repository, and custody refuses it before sending.
  const repository =
    (party === undefined ? undefined : boundRepository(file, party)) ?? ABOUT.repository;
  const custody = await startCustody({
    credentialsFile: file,
    destinations: (['source_control', 'hosting'] as const).map((entry) =>
      siteDestination(entry, origins[entry]),
    ),
  });
  const deps: CallDependencies = {
    // Every call goes by reference to custody; the caller's own transport sends nothing.
    transport: () => Promise.resolve({ kind: 'failed' }),
    resolve,
    credential: (ref) => Promise.resolve({ ref }),
    custody: siteCustody(custody, party),
    record: () => null,
  };
  const read = async (name: string, params: Readonly<Record<string, string>>) => {
    const result = await callConnector(siteOperation(name), params, deps);
    return result.kind === 'ok' ? `${name} ok` : `${name} ${result.kind} ${result.code}`;
  };
  let lines: string[];
  try {
    // One after the other, so the lines read in the order the runbook gives.
    const source = await read('site.source.read', { ...ABOUT, repository });
    lines = [source, await read('site.deployment.current', PROJECT)];
  } finally {
    await custody.stop();
  }
  return { ok: lines.every((line) => line.endsWith(' ok')), lines };
}

/** Each named flag exactly once, and nothing else. */
function flagsOf(args: readonly string[], names: readonly string[]): Record<string, string> | null {
  try {
    const options = Object.fromEntries(
      names.map((name) => [name, { type: 'string', multiple: true } as const]),
    );
    const { values } = parseArgs({ args: [...args], options, strict: true });
    const read = names.map((name) => [name, values[name]] as const);
    if (!read.every(([, given]) => given?.length === 1)) return null;
    return Object.fromEntries(read.map(([name, given]) => [name, given?.[0] ?? '']));
  } catch {
    return null;
  }
}

async function piped(): Promise<string> {
  // A terminal would echo it: the value comes from the password manager alone.
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/u, '');
}

/** The flags each command takes, every one exactly once; `smoke` may also name a party. */
const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  load: ['entry', 'file'],
  'load-app': ['app-id', 'file'],
  bind: ['party', 'repository', 'installation', 'file'],
  smoke: ['file'],
};

const USAGE = [
  'usage: site-custody.ts load --entry <source_control|hosting> --file <path>',
  '  | load-app --app-id <id> --file <path>',
  '  | bind --party <id> --repository <owner/name> --installation <id> --file <path>',
  '  | smoke --file <path> [--party <id>]',
].join('\n');

/** Prints one outcome line: refusals to stderr, and the exit code to match. */
function report(line: string, ok: boolean): void {
  (ok ? console.log : console.error)(line);
  process.exitCode = ok ? 0 : 1;
}

if (import.meta.main) {
  const [command = '', ...rest] = process.argv.slice(2);
  const names = COMMANDS[command];
  const withParty = command === 'smoke' && rest.includes('--party');
  const flags = names && flagsOf(rest, withParty ? [...names, 'party'] : names);
  if (flags === undefined || flags === null) {
    console.error(USAGE);
    process.exit(1);
  }
  const file = flags['file'] ?? '';
  if (command === 'load' || command === 'load-app') {
    const entry = command === 'load' ? (flags['entry'] ?? '') : 'source_control';
    const value = await piped();
    const appId = flags['app-id'] ?? '';
    const outcome =
      command === 'load' ? loadSiteEntry(file, entry, value) : loadSiteApp(file, appId, value);
    const ok = !outcome.startsWith('refused');
    report(`site custody: ${entry} ${ok ? `${outcome} and read back` : outcome}`, ok);
  } else if (command === 'bind') {
    const { party = '', repository = '', installation = '' } = flags;
    const outcome = bindSiteRepository(file, { party, repository, installation });
    const ok = !outcome.startsWith('refused');
    report(`site custody: ${repository} ${ok ? `${outcome} and read back` : outcome}`, ok);
  } else {
    const party = flags['party'];
    const result = await smokeSite(file, party === undefined ? {} : { party }).catch(() => ({
      ok: false,
      lines: ['refused CUSTODY_NOT_STARTED'],
    }));
    for (const line of result.lines) report(`site smoke: ${line}`, result.ok);
  }
}
