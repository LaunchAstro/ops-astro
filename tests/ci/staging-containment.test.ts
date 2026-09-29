// SPDX-License-Identifier: AGPL-3.0-only
// S0-1b: staging's containment and its resource limits.
//
// Two halves. The table half reads deploy/staging/compose.json: one row per
// refusal and per limit, and each row is proved to go red when its key is
// removed, so no row passes vacuously. The live half brings the definition up
// under a throwaway project name beside a stand-in production database, then
// from inside staging tries every target the ticket names and saturates every
// limit, checking the stand-in's health after each. It needs Docker: skipped
// on a machine without it, and failing in CI, where Docker is always present.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CANARY = 'canary-5b19e2d7c4-production-secret';
const DEFINITION = new URL('../../deploy/staging/compose.json', import.meta.url).pathname;

type Service = {
  image?: string;
  user?: string;
  entrypoint?: string[];
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  tmpfs?: string[];
  networks?: string[];
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  cpus?: string;
  mem_limit?: string;
  memswap_limit?: string;
  pids_limit?: number;
  logging?: { driver?: string; options?: Record<string, string> };
  [key: string]: unknown;
};
type Definition = {
  services: Record<string, Service>;
  networks: Record<
    string,
    {
      name: string;
      internal?: boolean;
      enable_ipv6?: boolean;
      driver_opts?: Record<string, string>;
    }
  >;
  volumes: Record<string, { name: string; driver_opts?: Record<string, string> }>;
  [key: string]: unknown;
};
const load = (): Definition => JSON.parse(readFileSync(DEFINITION, 'utf8')) as Definition;

const bytes = (size: string): number => {
  const match = /^(?<n>\d+(?:\.\d+)?)(?<unit>[kmg]?)b?$/iu.exec(size.trim());
  if (!match) return Number.NaN;
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    match.groups!['unit']!.toLowerCase()
  ];
  return Number(match.groups!['n']) * scale!;
};
const sizeOption = (options: string): number => {
  const size = /(?:^|,)size=(?<size>[^,]+)/u.exec(options)?.groups?.['size'];
  return size === undefined ? Number.NaN : bytes(size);
};

/** Every place a service can write, with the bound on it (NaN when unbounded). */
const writable = (def: Definition, service: Service): [string, number][] => [
  ...(service.tmpfs ?? []).map((entry): [string, number] => {
    const [path, options = ''] = entry.split(/:(.*)/su);
    return [`tmpfs ${path}`, sizeOption(options)];
  }),
  // A read-only mount (the database's certificate) is not a place to write.
  ...(service.volumes ?? [])
    .filter((entry) => !entry.endsWith(':ro'))
    .map((entry): [string, number] => {
      const source = entry.split(':')[0]!;
      const volume = def.volumes?.[source];
      const tmpfs = volume?.driver_opts?.['type'] === 'tmpfs';
      return [`volume ${source}`, tmpfs ? sizeOption(volume.driver_opts?.['o'] ?? '') : Number.NaN];
    }),
];

type Row = {
  name: string;
  /** Problems found; empty when the row holds. */
  check: (def: Definition) => string[];
  /** Removes what the row guards, to prove the row notices. */
  remove: (def: Definition) => void;
};
const each = (def: Definition, names: string[], test: (s: Service, n: string) => string | null) =>
  names.flatMap((name) => {
    const problem = test(def.services[name]!, name);
    return problem === null ? [] : [`${name}: ${problem}`];
  });
const all = (def: Definition) => Object.keys(def.services);

// ---- S0-1 containment: the refusals ------------------------------------------

const REFUSALS: Row[] = [
  {
    name: 'no route out of the staging network: host, metadata, private addresses, internet',
    check: (def) => (def.networks['staging']?.internal === true ? [] : ['staging is not internal']),
    remove: (def) => delete def.networks['staging']!.internal,
  },
  {
    name: "the host's bridge address: no gateway on the staging network",
    check: (def) =>
      Object.entries(def.networks).flatMap(([name, network]) =>
        network.driver_opts?.['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated'
          ? []
          : [`${name}: gateway mode not isolated`],
      ),
    remove: (def) => delete def.networks['staging']!.driver_opts,
  },
  {
    name: "the host's IPv6 bridge address: IPv6 off on the staging network",
    check: (def) =>
      Object.entries(def.networks).flatMap(([name, network]) =>
        network.enable_ipv6 === false ? [] : [`${name}: IPv6 not disabled`],
      ),
    remove: (def) => delete def.networks['staging']!.enable_ipv6,
  },
  {
    name: 'every service on internal networks alone: no bridge route out',
    check: (def) =>
      each(def, all(def), (s) => {
        const out = (s.networks ?? []).filter((n) => def.networks[n]?.internal !== true);
        return (s.networks ?? []).length > 0 && out.length === 0
          ? null
          : `networks ${String(s.networks)}`;
      }),
    remove: (def) => {
      def.networks['outside'] = { name: 'ops-astro-staging-outside' };
      def.services['auth']!.networks!.push('outside');
    },
  },
  {
    name: 'no port published: staging is reached through its own network, never the machine',
    check: (def) => each(def, all(def), (s) => (s.ports === undefined ? null : 'publishes a port')),
    remove: (def) => {
      def.services['db']!.ports = ['127.0.0.1:${STAGING_DB_PORT:?x}:5432'];
    },
  },
  {
    name: "production's sockets and files: named staging volumes only, no bind mount",
    check: (def) =>
      each(def, all(def), (s) =>
        (s.volumes ?? []).every((v) => /^ops-astro-staging-[a-z-]+:\/[^:]*(?::ro)?$/u.test(v))
          ? null
          : `volumes ${String(s.volumes)}`,
      ),
    remove: (def) => {
      def.services['auth']!.volumes = ['/var/run/docker.sock:/var/run/docker.sock'];
    },
  },
  {
    name: "production's credentials: no env file, secret or config read from the machine",
    check: (def) => [
      ...each(
        def,
        all(def),
        (s) => ['env_file', 'secrets', 'configs'].find((key) => s[key] !== undefined) ?? null,
      ),
      ...(['secrets', 'configs'] as const).filter((key) => def[key] !== undefined),
    ],
    remove: (def) => {
      def.services['auth']!['env_file'] = ['.env'];
    },
  },
  {
    name: 'the container host: no host network, namespace, device, capability or host name',
    check: (def) =>
      each(def, all(def), (s) => {
        const keys = ['network_mode', 'pid', 'ipc', 'userns_mode', 'privileged', 'devices'];
        return [...keys, 'cap_add', 'extra_hosts', 'volumes_from'].find((k) => k in s) ?? null;
      }),
    remove: (def) => {
      def.services['db']!['extra_hosts'] = ['host.docker.internal:host-gateway'];
    },
  },
  {
    name: 'no privilege: every capability dropped, no new privileges, read-only root',
    check: (def) =>
      each(def, all(def), (s) => {
        if (JSON.stringify(s.cap_drop) !== '["ALL"]') return 'cap_drop';
        if (!s.security_opt?.includes('no-new-privileges:true')) return 'no-new-privileges';
        return s.read_only === true ? null : 'read_only';
      }),
    remove: (def) => delete def.services['auth']!.cap_drop,
  },
];

// ---- S0-1 resource limits ------------------------------------------------------

const LIMITS: Row[] = [
  {
    name: 'CPU',
    check: (def) =>
      each(def, all(def), (s) => (Number(s.cpus) > 0 && Number(s.cpus) <= 2 ? null : 'cpus')),
    remove: (def) => delete def.services['auth']!.cpus,
  },
  {
    name: 'memory, with no swap beyond it',
    check: (def) =>
      each(def, all(def), (s) =>
        bytes(s.mem_limit ?? '') > 0 && s.memswap_limit === s.mem_limit ? null : 'mem_limit',
      ),
    remove: (def) => delete def.services['db']!.memswap_limit,
  },
  {
    name: 'process count',
    check: (def) =>
      each(def, all(def), (s) =>
        Number.isInteger(s.pids_limit) && s.pids_limit! > 0 && s.pids_limit! <= 500 ? null : 'pids',
      ),
    remove: (def) => delete def.services['auth']!.pids_limit,
  },
  {
    name: 'disk: read-only root, every writable place a sized tmpfs inside the memory limit',
    check: (def) =>
      each(def, all(def), (s) => {
        if (s.read_only !== true) return 'root is writable';
        const places = writable(def, s);
        const unbounded = places.find(([, size]) => !(size > 0));
        if (unbounded) return `${unbounded[0]} has no size`;
        const total = places.reduce((sum, [, size]) => sum + size, 0);
        return total < bytes(s.mem_limit ?? '') ? null : 'writable places exceed memory';
      }),
    remove: (def) => delete def.volumes['ops-astro-staging-pgdata']!.driver_opts,
  },
  {
    name: 'log size',
    check: (def) =>
      each(def, all(def), (s) => {
        const options = s.logging?.options ?? {};
        return s.logging?.driver === 'json-file' &&
          bytes(options['max-size'] ?? '') > 0 &&
          Number(options['max-file']) > 0
          ? null
          : 'logging';
      }),
    remove: (def) => delete def.services['db']!.logging!.options!['max-size'],
  },
];

describe.each([
  ['S0-1 containment', REFUSALS],
  ['S0-1 resource limits', LIMITS],
])('%s', (_title, rows) => {
  it.each(rows.map((row) => [row.name, row] as const))('%s', (_name, row) => {
    expect(row.check(load())).toEqual([]);
    const without = load();
    row.remove(without);
    expect(row.check(without), 'the row must notice its own removal').not.toEqual([]);
  });
});

// The one exception to the disk row is the backup store's data (S0-3,
// ORCH25-SL01-STORE): it must outlive a restart, so it is bounded by the store
// itself (`S0-3 store bounded`). Any other persistent or unsized place fails.
it('S0-1 resource limits: the backup store’s volume is the only persistent place', () => {
  const disk = LIMITS.find((row) => row.name.startsWith('disk:'))!;
  expect(load().services['backups'], 'the store is a service of staging').toBeDefined();
  expect(disk.check(load())).toEqual([]);
  const store = 'ops-astro-staging-backups-data';
  const mutations: [string, (def: Definition) => void][] = [
    [
      'staging’s database made persistent',
      (def) => {
        delete def.volumes['ops-astro-staging-pgdata']!.driver_opts;
      },
    ],
    [
      'the store’s volume on another service',
      (def) => {
        def.services['auth']!.volumes = [`${store}:/var/lib/postgresql/data`];
      },
    ],
    [
      'the store’s volume at another path',
      (def) => {
        def.services['backups']!.volumes = [`${store}:/var/lib/other`];
      },
    ],
    [
      'a second persistent volume on the store',
      (def) => {
        def.volumes['ops-astro-staging-extra'] = { name: 'ops-astro-staging-extra' };
        def.services['backups']!.volumes!.push('ops-astro-staging-extra:/extra');
      },
    ],
    [
      'another volume in the store’s place',
      (def) => {
        def.volumes['ops-astro-staging-backups-data2'] = {
          name: 'ops-astro-staging-backups-data2',
        };
        def.services['backups']!.volumes = def.services['backups']!.volumes!.map((v) =>
          v.replace(`${store}:`, 'ops-astro-staging-backups-data2:'),
        );
      },
    ],
    [
      'the store’s volume bound to a folder on the machine',
      (def) => {
        def.volumes[store]!.driver_opts = { type: 'none', o: 'bind', device: '/srv/backups' };
      },
    ],
    [
      'the store’s volume named as another',
      (def) => {
        def.volumes[store]!.name = 'ops-astro-staging-pgdata';
      },
    ],
    [
      'an unsized tmpfs on the store',
      (def) => {
        def.services['backups']!.tmpfs!.push('/scratch');
      },
    ],
    [
      'a writable root on the store',
      (def) => {
        def.services['backups']!.read_only = false;
      },
    ],
  ];
  for (const [what, mutate] of mutations) {
    const def = load();
    mutate(def);
    expect(disk.check(def), what).not.toEqual([]);
  }
});

// ---- the live half ---------------------------------------------------------------

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const live = dockerUp || process.env['CI'] ? describe : describe.skip;

const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', env, timeout: 180_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() };
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
/** Postgres answers an SSLRequest with one byte, `N` or `S`: proof a database is there. */
const postgresAnswers = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.setTimeout(5_000, () => (socket.destroy(), resolve(false)));
    socket.on('error', () => resolve(false));
    socket.on('connect', () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
    socket.on('data', (data) => (socket.destroy(), resolve(/^[NS]/u.test(data.toString()))));
  });

/** Waits, a second at a time, until a database answers on the port. */
const settle = async (port: number, tries: number): Promise<void> => {
  if (tries === 0 || (await postgresAnswers(port))) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 1_000);
  });
  await settle(port, tries - 1);
};

// eslint-disable-next-line max-lines-per-function -- one live stack, the checks that share it
live('S0-1 containment and resource limits, live', () => {
  const project = `s01b-${process.pid}`;
  const scratch = mkdtempSync(join(tmpdir(), 's0-1b-'));
  const override = join(scratch, 'override.json');
  const prod = `${project}-production`;
  const names = (suffix: string) => `${project}-${suffix}`;
  let env: NodeJS.ProcessEnv = process.env;
  let prodPort = 0;
  const compose = (args: string[]) =>
    docker(['compose', '-p', project, '-f', DEFINITION, '-f', override, ...args], env);
  const inStaging = (script: string) => docker(['exec', `${project}-db`, 'sh', '-c', script]);
  const productionGreen = async () => {
    expect(docker(['exec', prod, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status).toBe(
      0,
    );
    expect(await postgresAnswers(prodPort)).toBe(true);
  };

  beforeAll(async () => {
    prodPort = await freePort();
    env = {
      ...process.env,
      STAGING_DB_ADMIN_USER: 'probe',
      STAGING_DB_ADMIN_PASSWORD: 'probe-only',
      STAGING_BACKUPS_ADMIN_USER: 'probe',
      STAGING_BACKUPS_ADMIN_PASSWORD: 'probe-only',
      STAGING_AUTH_URL: 'http://127.0.0.1',
      STAGING_SITE_URL: 'http://127.0.0.1',
      STAGING_AUTH_DATABASE_URL: 'postgres://unused',
      STAGING_JWT_SECRET: 'unused',
    };
    writeFileSync(
      override,
      JSON.stringify({
        services: Object.fromEntries(
          Object.keys(load().services).map((s) => [s, { container_name: names(s) }]),
        ),
        networks: { staging: { name: names('staging') } },
        volumes: {
          'ops-astro-staging-pgdata': { name: names('pgdata') },
          'ops-astro-staging-backups-data': { name: names('backups-data') },
          'ops-astro-staging-tls': { name: names('tls') },
        },
      }),
    );
    // The stand-in production service: the same image, none of staging's limits,
    // on an ordinary network and a loopback port, the way a live service runs.
    // Its password is a canary that must never be found inside staging.
    const image = load().services['db']!.image!;
    expect(docker(['network', 'create', prod]).status).toBe(0);
    const started = docker([
      'run',
      '-d',
      '--name',
      prod,
      '--network',
      prod,
      '-p',
      `127.0.0.1:${prodPort}:5432`,
      '-e',
      `POSTGRES_PASSWORD=${CANARY}`,
      '--health-cmd',
      'pg_isready -h 127.0.0.1 -U postgres',
      '--health-interval',
      '1s',
      image,
    ]);
    expect(started.status, started.out).toBe(0);
    // The database serves TLS only; the runbook provisions its certificate, and
    // this run gives it a throwaway one in its own volume.
    const tls = join(scratch, 'tls');
    mkdirSync(tls);
    const made = spawnSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-subj',
      '/CN=staging-db',
      '-days',
      '1',
      '-keyout',
      join(tls, 'server.key'),
      '-out',
      join(tls, 'server.crt'),
    ]);
    expect(made.status).toBe(0);
    const filled = docker([
      'run',
      '--rm',
      '-v',
      `${names('tls')}:/tls`,
      '-v',
      `${tls}:/src:ro`,
      image,
      'sh',
      '-c',
      'cp /src/server.crt /src/server.key /tls/ && chown 70:70 /tls/* && chmod 600 /tls/server.key',
    ]);
    expect(filled.status, filled.out).toBe(0);
    const up = compose(['up', '-d', '--wait', 'db']);
    expect(up.status, up.out).toBe(0);
    await settle(prodPort, 60);
    await productionGreen();
  }, 300_000);

  afterAll(() => {
    compose(['down', '-v', '--timeout', '1']);
    docker(['rm', '-f', '-v', prod]);
    docker(['network', 'rm', prod, names('dual')]);
    rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  it("the way in is staging's own network, never a port on the machine", () => {
    // The runbook's seed and migrate steps run as one-off containers here.
    const image = load().services['db']!.image!;
    const reach = docker([
      'run',
      '--rm',
      '--network',
      names('staging'),
      image,
      'pg_isready',
      '-h',
      'db',
    ]);
    expect(reach.status, reach.out).toBe(0);
    expect(docker(['port', names('db')]).out).toBe('');
  });

  it('every service, as Docker creates it, carries its confinement and limits', () => {
    const create = compose(['create', 'auth']);
    expect(create.status, create.out).toBe(0);
    const format =
      '{{json .HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{.HostConfig.NanoCpus}} ' +
      '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} ' +
      '{{json .HostConfig.SecurityOpt}} {{range $n, $_ := .NetworkSettings.Networks}}{{$n}}{{end}}';
    for (const [name, s] of Object.entries(load().services)) {
      const memory = bytes(s.mem_limit!);
      expect(docker(['inspect', names(name), '--format', format]).out, name).toBe(
        `true ["ALL"] ${Number(s.cpus) * 1e9} ${memory} ${memory} ${s.pids_limit} ` +
          `["no-new-privileges:true"] ${names('staging')}`,
      );
    }
    const format2 =
      '{{.Internal}} {{index .Options "com.docker.network.bridge.gateway_mode_ipv4"}} {{.EnableIPv6}}';
    const internal = docker(['network', 'inspect', names('staging'), '--format', format2]);
    expect(internal.out).toBe('true isolated false');
  });

  it('S0-1 containment: from inside staging, each target is refused', async () => {
    // A service of the machine itself, listening on every address it has.
    const listener = createServer((socket) => socket.end()).listen(0, '::');
    await new Promise<void>((resolve) => {
      listener.once('listening', () => resolve());
    });
    const hostPort = (listener.address() as { port: number }).port;
    const prodIp = docker([
      'inspect',
      prod,
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    ]).out;
    const ipam = (network: string) =>
      (
        JSON.parse(
          docker(['network', 'inspect', network, '--format', '{{json .IPAM.Config}}']).out,
        ) as { Subnet: string; Gateway?: string }[]
      )[0]!;
    const gateway = ipam(prod).Gateway!;
    // Staging's bridge has no gateway: the address one would take is probed anyway.
    expect(ipam(names('staging')).Gateway ?? '').toBe('');
    const bridge = ipam(names('staging')).Subnet.replace(/\.0\/\d+$/u, '.1');
    // The host's IPv6 bridge address, as an ordinary dual-stack bridge gives it.
    const dual = docker(['network', 'create', '--ipv6', names('dual')]);
    expect(dual.status, dual.out).toBe(0);
    const v6 = (
      JSON.parse(
        docker(['network', 'inspect', names('dual'), '--format', '{{json .IPAM.Config}}']).out,
      ) as { Subnet: string; Gateway?: string }[]
    ).find((config) => config.Subnet.includes(':'))!.Gateway!;
    // Staging itself holds no IPv6 address but loopback, so it has no IPv6 route at all.
    expect(inStaging("awk '{print $6}' /proc/net/if_inet6 2>/dev/null | sort -u").out).toMatch(
      /^(?:lo)?$/u,
    );
    const targets: [string, string][] = [
      ["production's socket", `${prodIp}:5432`],
      ["production's port on the host", `host.docker.internal:${prodPort}`],
      ['the container host', `${gateway}:${hostPort}`],
      ["the host's address on staging's own bridge", `${bridge}:${hostPort}`],
      ["the host's IPv6 bridge address", `${v6}:${hostPort}`],
      ['the metadata address', '169.254.169.254:80'],
      ['a private address, 10/8', '10.0.0.1:80'],
      ['a private address, 172.16/12', '172.16.0.1:80'],
      ['a private address, 192.168/16', '192.168.1.1:80'],
      ['the internet', '1.1.1.1:443'],
    ];
    const probe = (where: string[], target: string) => {
      const at = target.lastIndexOf(':');
      const [host, port] = [target.slice(0, at), target.slice(at + 1)];
      return docker([...where, 'nc', '-z', '-w', '2', host, port]).status;
    };
    // The probe can see a reachable target: from production's own network it
    // reaches production. Only then does a refusal from staging mean anything.
    expect(
      probe(['run', '--rm', '--network', prod, load().services['db']!.image!], `${prodIp}:5432`),
    ).toBe(0);
    // On Linux the machine's listener is reachable through an ordinary bridge's
    // gateway, so the same address refused from staging means something.
    if (process.platform === 'linux')
      expect(
        probe(
          ['run', '--rm', '--network', prod, load().services['db']!.image!],
          `${gateway}:${hostPort}`,
        ),
      ).toBe(0);
    if (process.platform === 'linux')
      expect(
        probe(
          ['run', '--rm', '--network', names('dual'), load().services['db']!.image!],
          `${v6}:${hostPort}`,
        ),
        'control: the IPv6 host address is reachable from a dual-stack bridge',
      ).toBe(0);
    for (const [what, target] of targets)
      expect(probe(['exec', `${project}-db`], target), `${what} (${target})`).not.toBe(0);
    expect(inStaging('test -e /var/run/docker.sock').status, 'docker socket').not.toBe(0);
    expect(inStaging('touch /escape').out).toMatch(/Read-only file system/u);

    // Production's files and credentials: a planted file on the machine and the
    // stand-in's password are nowhere inside staging, on disk or in a process.
    writeFileSync(join(scratch, 'production.env'), `PASSWORD=${CANARY}\n`);
    const search = inStaging(
      `grep -rsl '${CANARY}' /etc /home /mnt /opt /root /run /srv /tmp /usr/local /var /proc/[0-9]*/environ 2>/dev/null; echo searched`,
    );
    expect(search.out).toBe('searched');
    // The same search inside production finds it, so the search is not blind.
    const control = docker(['exec', prod, 'sh', '-c', `grep -sl '${CANARY}' /proc/self/environ`]);
    expect(control.out).toBe('/proc/self/environ');
    listener.close();
  }, 120_000);

  it('S0-1 resource limits: saturating each inside staging leaves production green', async () => {
    const db = load().services['db']!;
    const cgroup = (file: string) => inStaging(`cat /sys/fs/cgroup/${file}`).out;

    // CPU: every core spun for five seconds; the quota holds it to the limit.
    expect(cgroup('cpu.max')).toBe(`${Number(db.cpus) * 100_000} 100000`);
    inStaging('for i in 1 2 3 4 5 6 7 8; do timeout 5 sh -c "while :; do :; done" & done; wait');
    await productionGreen();

    // Memory: a hog past the limit is killed; staging's database survives it.
    expect(Number(cgroup('memory.max'))).toBe(bytes(db.mem_limit!));
    const hog = inStaging(
      `head -c ${bytes(db.mem_limit!) + 256 * 1024 ** 2} /dev/zero | tail > /dev/null; echo $?`,
    );
    expect(hog.out).toMatch(/137|Killed/u);
    expect(docker(['exec', `${project}-db`, 'pg_isready', '-h', '127.0.0.1']).status).toBe(0);
    await productionGreen();

    // Process count: forks stop at the limit.
    const forks = inStaging(
      'i=0; while [ $i -lt 1000 ]; do sleep 3 & i=$((i+1)); read n < /sys/fs/cgroup/pids.current; [ "$n" -ge ' +
        `${db.pids_limit} ] && break; done; echo "$n"; wait`,
    );
    expect(Number(forks.out.split('\n').at(-1))).toBe(db.pids_limit);
    await productionGreen();

    // Disk: the database's own space fills and stops at its size.
    const volume = load().volumes['ops-astro-staging-pgdata']!;
    const fill = inStaging(
      'dd if=/dev/zero of=/var/lib/postgresql/data/fill bs=1M count=4096; rm -f /var/lib/postgresql/data/fill',
    );
    expect(fill.out).toMatch(/No space left on device/u);
    const written = Number(/(\d+) bytes/u.exec(fill.out)?.[1]);
    expect(written).toBeLessThanOrEqual(sizeOption(volume.driver_opts!['o']!));
    await productionGreen();

    // Log size: a flood through the main process's output is rotated away.
    const { 'max-size': maxSize, 'max-file': maxFile } = db.logging!.options!;
    const cap = bytes(maxSize!) * Number(maxFile);
    inStaging(
      `head -c ${cap + 16 * 1024 ** 2} /dev/zero | tr '\\0' x | fold -w 200 > /proc/1/fd/1`,
    );
    const kept = spawnSync('sh', ['-c', `docker logs ${project}-db 2>&1 | wc -c`], {
      encoding: 'utf8',
    });
    expect(Number(kept.stdout.trim())).toBeLessThanOrEqual(cap);
    await productionGreen();

    // Staging itself rode every limit out: no container of it was restarted.
    for (const service of ['db'])
      expect(docker(['inspect', names(service), '--format', '{{.RestartCount}}']).out).toBe('0');
  }, 240_000);
});
