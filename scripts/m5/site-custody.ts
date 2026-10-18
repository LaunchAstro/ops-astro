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
//   node scripts/m5/site-custody.ts smoke --file <credential file>
//
// `load` takes the value on standard input alone, never an argument or a
// setting, adds the entry once to the owner-only file under a lock, and reads
// it back. `smoke` reads the About page's source and the production
// deployment through custody's own process, and nothing else. No origin is
// taken from the command line, so a token goes only to its provider. No line
// either prints carries a value: each names an entry, an operation or a code.

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { publishSecret } from '../../apps/cli/secret-file.ts';
import {
  callConnector,
  siteOperation,
  systemResolver,
  type CallDependencies,
  type Resolver,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseCredentials,
  siteCustody,
  siteDestination,
  startCustody,
} from '../../packages/core-custody/src/index.ts';

type Entry = 'source_control' | 'hosting';
type Refusal = `refused ${string}`;

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

/**
 * The file's entries, none when it is absent. Refused unless it is a plain
 * file of this user's that no one else can read, opened without following a
 * link, whose list custody would load.
 */
function entriesIn(file: string): unknown[] | Refusal {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    return code === 'ELOOP' ? 'refused LOAD_FILE_NOT_OWNER_ONLY' : 'refused LOAD_FILE_UNREADABLE';
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
      return 'refused LOAD_FILE_NOT_OWNER_ONLY';
    }
    const entries: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    const parsed = parseCredentials(entries);
    return parsed.ok ? (entries as unknown[]) : `refused ${parsed.code}`;
  } catch {
    return 'refused LOAD_FILE_UNREADABLE';
  } finally {
    closeSync(fd);
  }
}

/** Adds one entry to the credential file once and reads it back. */
export function loadSiteEntry(
  file: string,
  entry: string,
  value: string,
): 'loaded' | 'already loaded' | Refusal {
  if (!isEntry(entry)) return 'refused ENTRY_UNKNOWN';
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let held: number;
  try {
    held = openSync(lock, 'wx', 0o600);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === 'EEXIST' ? 'refused LOAD_IN_PROGRESS' : 'refused LOAD_FILE_UNREADABLE';
  }
  try {
    const entries = entriesIn(file);
    if (typeof entries === 'string') return entries;
    const filed = {
      ref: entry,
      kind: 'api_key',
      account: ACCOUNTS[entry],
      destination: entry,
      header: 'authorization',
      scheme: 'bearer',
      value,
    };
    const loaded = entries.find((one) => (one as { ref?: unknown }).ref === entry);
    if (loaded !== undefined) {
      return isDeepStrictEqual(loaded, filed) ? 'already loaded' : 'refused ENTRY_ALREADY_LOADED';
    }
    const next = parseCredentials([...entries, filed]);
    if (!next.ok) return `refused ${next.code}`;
    publishSecret(file, JSON.stringify([...entries, filed]));
    const back = entriesIn(file);
    const readBack = typeof back !== 'string' && back.some((one) => isDeepStrictEqual(one, filed));
    return readBack ? 'loaded' : 'refused LOAD_NOT_READ_BACK';
  } finally {
    closeSync(held);
    rmSync(lock, { force: true });
  }
}

export interface SmokeOptions {
  /** A test's stand-in origins; the command line never sets them. */
  readonly origins?: Readonly<Record<Entry, string>>;
  readonly resolve?: Resolver;
}

/** Reads the About source and the production deployment through custody: ok when both answer. */
export async function smokeSite(
  file: string,
  { origins = ORIGINS, resolve = systemResolver }: SmokeOptions = {},
): Promise<{ ok: boolean; lines: string[] }> {
  const entries = entriesIn(file);
  if (typeof entries === 'string') return { ok: false, lines: [entries] };
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
    custody: siteCustody(custody),
    record: () => null,
  };
  const read = async (name: string, params: Readonly<Record<string, string>>) => {
    const result = await callConnector(siteOperation(name), params, deps);
    return result.kind === 'ok' ? `${name} ok` : `${name} ${result.kind} ${result.code}`;
  };
  let lines: string[];
  try {
    // One after the other, so the lines read in the order the runbook gives.
    const source = await read('site.source.read', ABOUT);
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

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = flagsOf(rest, command === 'load' ? ['entry', 'file'] : ['file']);
  if (flags === null || (command !== 'load' && command !== 'smoke')) {
    console.error(
      'usage: site-custody.ts load --entry <source_control|hosting> --file <path> | smoke --file <path>',
    );
    process.exit(1);
  }
  const file = flags['file'] ?? '';
  if (command === 'load') {
    const entry = flags['entry'] ?? '';
    const outcome = loadSiteEntry(file, entry, await piped());
    const ok = !outcome.startsWith('refused');
    (ok ? console.log : console.error)(
      `site custody: ${entry} ${ok ? `${outcome} and read back` : outcome}`,
    );
    process.exitCode = ok ? 0 : 1;
  } else {
    const result = await smokeSite(file).catch(() => ({
      ok: false,
      lines: ['refused CUSTODY_NOT_STARTED'],
    }));
    for (const line of result.lines)
      (result.ok ? console.log : console.error)(`site smoke: ${line}`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
