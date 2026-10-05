# Sandbox launcher contract (draft, not approved)

Status: **draft for approval**. Drafted 5 October 2026 under
[ADR 0048](../adr/0048-sandbox-launcher-contract-drafted-reviewed-not-built.md),
revised the same day after four adversarial reviews and Sol's first round.
In round 2 the envelope's comparison, publish and host fidelity were split
into their own design piece (O4, section 12). Nothing here is built.
Nathan approves the final version after the adversarial findings are
resolved, and only then may implementation start. Until then untrusted
package installation and headless execution stay unavailable, with no
unsandboxed fallback.

Each numbered line is a rule the implementation must keep and a test must
prove (section 13). A line that cannot be proven is a refusal, not a warning.
Every grammar here is closed: what it does not name is refused. A JSON
reply from our own pinned daemon is parsed with P1's parser (duplicate keys
refused, at most 1 MiB, depth at most 32) and read for the keys a line
names, each checked as stated; its other keys are ignored. `_ping`'s body
is exactly `OK`, a 204 has no body, and the attach stream is read only as
Docker's multiplexed frames of stream 1 or 2. A daemon reply that breaks
these rules is `internal` and leaves the launcher `unavailable` until a new
probe passes (F3). The bytes a run writes inside those frames are that
run's output, judged by its class's grammar alone: O1 for S1, O2 for S2,
and for S0 F1's probe result for the probe run, or for a crossing run only
the observation F1 names. Stdout past its class's output cap is refused;
stderr past 64 KiB is discarded, never refused. For S1 and S2 a refusal is
that run's `output refused` (R1), and the launcher's availability stays as
it was. For S0, an outcome other than the one F1 names for that run is a
failed probe (F3); the `output` crossing's size-cap refusal is its pass.

Terms, each used in one sense only:

- **site record**: Ops Astro's record of one client site (section 3, I6);
- **pin**: the site record's toolchain entry in `docs/supply-chain-pins.md`
  (lockfile digest, base and entrypoint digests per platform, image id,
  and, while one is being made, the site commit F2 builds);
- **pin list**: the file the socket proxy reads the pins from, one entry per
  site (a **site entry**) with its lockfile digest, its image id for S1
  only (empty while a pin is being made, B8), its pin-making attempt
  number, while one is being made the site commit F2 builds, and its S1
  `Env` list (B3), plus one entry for the probe image (S0
  only) and one per platform for the base-plus-entrypoint image (S2 only,
  with the one S2 `Env` list); written only by the deploy of a reviewed
  change;
- **image store**: the Docker daemon's images;
- **package registry**: an npm registry;
- **tool registry**: Ops Astro's list of tools and their availability.

## 1. Scope, first user and trust

The launcher runs code we do not trust in a container and hands back only
bytes. Its first user is the site change envelope (issue #972): to decide
whether an automated edit to a client's live Astro site is one word of body
copy, the envelope needs the site built with its pinned toolchain. This
contract covers running that build and handing back its bytes. How the
envelope compares outputs, binds a verdict to what ships and publishes is a
separate design piece (O4).

Building a site runs the site's code: its `astro.config.mjs`, integrations
(for the template site `@astrojs/sitemap`, `@astrojs/mdx`,
`@astrojs/partytown`, `astro-icon`, `astro-compress`), Vite plugins such as
`@tailwindcss/vite`, and native modules such as `sharp`.

- **T1. Containment** treats all of that code as hostile.
- **T2. The pins.** Hostile code inside a run can always write any output
  it likes, so an output is only as trustworthy as the toolchain that built
  it: the toolchain must be one a person approved, a pin changes only
  through a reviewed change, and the launcher never writes one. What a
  caller may conclude from an output, and how far it trusts the site's own
  code, is that caller's design (O4).
- **T3.** Agent tools that run arbitrary code, headless browsers and any other
  user are out of scope. Each needs its own amendment and its own approval.

## 2. Run classes

The launcher knows exactly three run classes. Any other request is refused.

- **S0. `probe`**: our fixed probe image by digest and its fixed command,
  with the create body of the class it probes (section 8, appendix).
- **S1. `site.build`**: build one site tree with its pinned image. The
  container command is fixed: the launcher's entrypoint (its own pinned
  layer, B8) first checks that its environment is exactly B3 and exits
  refused if not, then reads the input tar from stdin into `/work`, runs the
  site record's build command with its stdout sent to stderr, and writes a
  tar of `dist/` to the original stdout. No site code runs before that
  check. Used by F2 and by the launcher's caller (O4).
- **S2. `site.prepare`**: install one site's dependencies, offline, into the
  layer its image is assembled from (B8). Runs only on the request of a
  reviewed pin change (T2), never on a `site.build` request. It receives
  only
  `package.json`, `package-lock.json`, the package tarballs (E2) and an npm
  configuration the launcher writes; never the site tree or any
  configuration file from it. Its `package.json` and `package-lock.json`
  must hash to the site entry's lockfile digest (I4), or the run is refused
  `pin mismatch`. Anything given to it is
  treated as public. It
  runs in the base-plus-entrypoint image (no `node_modules` layer), whose id
  is pinned per platform.

No run class has network access (section 5).

## 3. Accepted and refused inputs

The launcher reads every request as a JSON body parsed with a real parser,
with an exact key set per run class and each value checked against an
allow-list. Unknown keys, unknown values and extra fields are refused.

- **I1. `site.build` accepts only:** a site id with a site record and a pin; a
  `baseRevision` (40 hex characters); and one changed file: its path and its
  new content (at most 64 KiB of UTF-8). The path must exist at
  `baseRevision` as a regular file and must match the site record's content
  allow-list: `src/pages/`, `src/content/` or `src/components/`, extension
  `.astro`, `.md` or `.mdx`. A path that any package manager, Astro, Vite,
  git, CI or the host reads as configuration is never on that list.
- **I2. The launcher assembles the input tree itself**, in memory, from the
  site repository's git objects at `baseRevision`, through the credential
  broker's read operation. It reads tree objects, never an archive endpoint;
  a truncated listing is a refusal; each blob's bytes must hash to its git
  object id. The credential never enters a sandbox; only bytes do.
- **I3. The tree is refused** when it holds:
  - more than 20,000 entries or 50 MB;
  - any entry other than a regular file or a directory (no symlink, no
    submodule);
  - a name outside O1's character set plus `[` and `]` (for dynamic routes
    such as `[slug].astro`), a name that is not NFC, or two names equal
    after ASCII case folding;
  - an entry named `node_modules`, `dist`, `.astro`, `.vercel` or `.netlify`
    at any depth;
  - a `.gitattributes`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`,
    `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`,
    `pnpm-workspace.yaml` or `.pnpmfile.cjs` anywhere.
- **I4. The pin is refused** unless the digest of `package.json` and
  `package-lock.json` together, in the tree as built, equals the pin's. Since
  I1 never accepts either file as the changed path, an edited tree carries
  the same pair as `baseRevision`. A `site.build` request for a site whose
  pin has no image id yet (a pin being made, B8) is refused with `no pin`.
- **I5. The lockfile grammar.** `site.prepare` accepts only
  `package-lock.json` with `lockfileVersion` 3 and a `package.json` with no
  `packageManager` field. Every non-root package entry has a `sha512`
  `integrity` and a `resolved` URL of exactly one of two forms. `<name>` is
  the entry's key after its last `node_modules/` and follows npm's name
  grammar; `<version>` is the entry's own `version`; `<base>` is `<name>`
  without its scope. An entry carrying a `name` field (an alias) is refused.
  - `https://registry.npmjs.org/<name>/-/<base>-<version>.tgz`;
  - `https://npm.pkg.github.com/download/<name>/<version>/<40 hex>`, with
    `<name>` under a scope the site record lists.

  Any other form, a `link` entry, a missing or weaker integrity, or any other
  host is a refusal.

- **I6. The site record** holds the build command, the output directory
  (`dist`), the Node version, the build environment variables and their
  values, the private package scopes and the content allow-list, and,
  held for the caller (O4), `build.format`, `trailingSlash` and `output`.
  It changes only
  through a reviewed change. No build variable whose value is a secret is
  ever recorded; a site whose build needs one is refused.

## 4. Isolation

Every run is one new container under gVisor (`runsc`), removed when the run
ends, whatever the outcome.

- **B1. Runtime.** `runsc` at the version and hash pinned in
  `docs/supply-chain-pins.md`, installed at a path that contains its sha256
  (`/opt/runsc/<sha256>/runsc`) on a read-only filesystem, which a VM boot
  check hashes before the daemon starts. It is registered with the daemon by
  that path and a pinned argument list: `--network=sandbox`, no host Unix
  socket or FIFO access, no flag override, no host-backed overlay, no debug
  log, and a named platform. Before every run the launcher reads the runtime entry
  through `GET /info` and refuses when the path or arguments differ from the
  pin.
- **B2. Network.** Network mode `none` for every run class: loopback only.
- **B3. Environment**, exact per class, including what Docker and the base
  image add:
  - S1: `PATH`, `HOME=/tmp/home`, `HOSTNAME=sandbox`, `NODE_ENV=production`,
    `ASTRO_TELEMETRY_DISABLED=1`, the base image's own variables with the
    values its pinned config gives (written out in the pin), and the site
    record's build environment variables with the values the record gives;
    where the record names a variable listed before it, the value here
    wins;
  - S2: `PATH`, `HOME=/tmp/home`, `HOSTNAME=sandbox`,
    `ASTRO_TELEMETRY_DISABLED=1`, the base image's own variables and the
    npm user configuration the launcher writes (offline, `ignore-scripts`,
    cache path); no site variables, which S2's install command (E2) does
    not read;
  - S0: as the class it probes.
  - No env file, no mounted credential, no Docker socket.
- **B4. Host writes.** A read-only root filesystem; no bind mount, `Mounts`
  entry or volume, named or anonymous; the assembled image declares no
  `VOLUME`. The only writable places are `tmpfs` mounts at fixed paths
  (`/work`, `/tmp`) with `nosuid,nodev` and a size inside the memory limit,
  and Docker's `/dev/shm` at the appendix's fixed `ShmSize`. The mounts
  Docker inserts (`/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`) are
  read-only. The log driver is `none`: output leaves only through attach.
  Vite's and Astro's caches land in `/work/node_modules/` (tmpfs), because
  the installed packages sit at `/node_modules` (B8).
- **B5. Privileges.** A fixed non-root uid and gid, every capability dropped,
  `no-new-privileges`, no devices, no host namespace (pid, ipc, uts,
  network, user, cgroup).
- **B6. Caps per run:**

  | Class | Wall            | Memory (no swap) | CPU | Processes | Input  | Output | stderr kept |
  | ----- | --------------- | ---------------- | --- | --------- | ------ | ------ | ----------- |
  | S1    | 120 s           | 1 GiB            | 1   | 256       | 50 MB  | 50 MB  | 64 KiB      |
  | S2    | 600 s           | 4 GiB            | 1   | 256       | 600 MB | 1 GB   | 64 KiB      |
  | S0    | as probed class | as probed class  | 1   | 256       | 1 MB   | 1 MB   | 64 KiB      |

  MB and GB are decimal (10^6 and 10^9 bytes); KiB, MiB and GiB are
  binary. The socket proxy enforces the wall clock from its own durable
  record, not only the launcher (P6).

- **B7. Machine share.** One sandbox at a time, a queue of at most four and a
  queue wait of at most 300 s. Every sandbox runs with `OomScoreAdj` 1000.
- **B8. Images.** No image is built by the daemon. The launcher assembles each
  site image itself as an image archive, bottom to top:
  - the Node base image's pinned layers in their pinned order, and its
    config, from an archive that arrives through the reviewed pin change and
    is checked against its pinned per-platform digests at every assembly;
  - one `node_modules` layer, unpacked at `/node_modules` only, which the
    launcher writes from S2's output under O2's rules;
  - the launcher's entrypoint layer (pinned) on top, so nothing below can
    shadow it.

  The assembled config sets no `Entrypoint`, `Cmd`, `Volumes`,
  `Healthcheck`, `OnBuild` or `StopSignal` of its own. The VM's daemon uses
  the classic overlay2 image store, and the image id is the sha256 of the
  image config, which the launcher computes. Making a pin: for a site whose
  lockfile digest is pinned, S2, the assembly and F2 run on the production
  sandbox VM through the proxy. The first commit of a pin change sets the
  lockfile digest, empties the entry's image id, raises its attempt
  number and names the site commit (40 hex) F2 builds. The proxy records the
  id it computed itself for that not-yet-pinned image and admits it for
  F2's three S1 creates only (P3). No `site.build` request can use it,
  because one needs the pin's image id (I4). The launcher writes a
  pin-making report (the candidate id and F2's three output digests) for
  the reviewer, and the reviewed second commit copies the id into the pin;
  the launcher never writes the pin. The proxy keeps, durably beside the
  candidate record, the id it accepted for each site entry, with that
  entry's lockfile digest and attempt number. On every read of the pin
  list, at start included, a site entry's id that differs from its accepted
  id is accepted only when it equals the proxy's candidate for that entry
  and attempt, the candidate's lockfile digest equals the entry's deployed
  digest, and that candidate recorded all three of F2's creates, each of
  whose waits returned exit code 0 before its deadline; otherwise the
  entry has no image id. A deploy that changes the entry's id, lockfile
  digest or attempt number clears the accepted id, an emptied id included.
  The probe and base-plus-entrypoint entries are not made by F2: their ids
  are taken as deployed, and P5 checks their loads against their own layer
  lists. The load (P5) must
  report the same id. Site images are removed when their pin is replaced,
  and at most 50 are kept.

- **B9. Placement.** Sandboxes run in a dedicated Linux VM on the production
  machine that runs no live service, shares no host folder, holds no
  credential, and has its own Docker daemon with automatic updates off.
  - The daemon listens on no TCP port. Its socket reaches the machine only
    as one path readable by the proxy's own uid alone (mode 0600), never
    mounted into the launcher or any other unit. The proxy runs as a uid no
    other process on the machine uses.
  - While in production use the VM exposes no ssh, shell or other
    management path.
  - The daemon's default runtime is `runsc`, and its `daemon.json` is pinned
    by hash and checked at VM boot.
  - The VM has no network interface beyond the channel that carries the
    daemon socket to the proxy, or one whose filter sits outside the VM (the
    VM tool's network filter or the machine's packet filter), which nothing
    inside the VM can change.

  A placement beside live services needs its own amendment and approval.

## 5. Egress

- **E1.** No run class has network access (B2). There is no egress relay and
  no network for sandboxes.
- **E2.** Package tarballs reach `site.prepare` without network. The
  credential broker's fetch operation, never the launcher, fetches each
  lockfile entry's `resolved` URL (I5) from its fixed host. For
  `npm.pkg.github.com` it fetches only names under the site record's
  scopes, follows a redirect only to a fixed list of hosts, and never sends
  the credential on a redirect. The launcher checks each tarball's `sha512`
  and hands the tarballs in on stdin as an npm cache. It never unpacks one,
  and it keeps question 2's single internal network and no other. S2 runs
  `npm ci --offline --ignore-scripts --include=dev`, so no lifecycle script
  runs.
- **E3.** A site that needs a lifecycle script to build is refused.
  (`npm ci --ignore-scripts` is already the site engine's install rule, and
  the template site builds that way, sharp included.)

## 6. Socket-proxy operations

The launcher never holds the Docker socket. It talks to a socket proxy of
ours over a Unix socket that only the launcher can reach. The proxy reads each
request as a closed grammar and forwards only what it re-serialises from the
checked values, never the bytes it received.

- **P1. Request form.** A fixed API version prefix (`/v1.NN/`); the path
  rebuilt from the matched pattern; the query rebuilt from the named
  parameters; the body rebuilt from the checked value. Refused: any other
  version or none, percent-encoding or dot segments in the path, a query
  parameter not named below, duplicate JSON keys at any depth, a key that
  differs only in case, `Transfer-Encoding`, any header other than `Host`,
  `Content-Type`, `Content-Length` and (on attach) `Connection` and
  `Upgrade`, a body on an operation named without one, and a second request
  on one connection (except the attach stream).
- **P2. Health.** `GET /_ping`, `GET /version` and `GET /info`, no query.
- **P3. Create.** `POST /containers/create` with no query, and a body
  structurally equal to its class's fixed body in the appendix, with exactly
  one slot filled: `Image`, which must be `sha256:` plus 64 hex characters
  and name one of exactly two things:
  - an image the pin list holds for that class;
  - for the S1 body only, the candidate: the id the proxy computed at a P5
    candidate load for a pin-list entry that has a lockfile digest and no
    image id yet (B8). Its create is compared with that entry's S1 body.

  The candidate record (entry, attempt number, the entry's lockfile digest
  at the load, id, creates left) is durable, separate from the container record, and never cleared by a
  sweep. An entry has at most one open candidate, bound to its attempt
  number. The record also counts the creates recorded for each candidate;
  ending an admission sets creates left to 0 and leaves that count alone.
  For each counted create it also holds the wait's `StatusCode` and
  whether the wait returned before the deadline.
  A load admits it for exactly three S1 creates, F2's, each counted in the
  same durable write that records the container's id, so a create the
  daemon made but the proxy never recorded does not count. A second load
  for that entry and attempt is refused. A deploy that changes the entry
  ends the admission, so a failed F2 needs a new first commit, which
  raises the attempt number. An ended or superseded candidate stays in the
  record with no creates left until its image is deleted. A fourth create, a create of the candidate with any
  other class's body, and a create of a candidate whose entry a deploy has
  changed are refused.

  The proxy takes one create at a time, from its count check until the
  returned id is durable in its record. Before each create its record must
  be empty and `GET /info` must report zero containers. A record that is
  not empty refuses the create (B7: one sandbox at a time); a count that
  differs from the record refuses it and starts a sweep (P6). Any other
  difference from the fixed body, a missing key, or a key added with the
  daemon's default value, is a refusal.

- **P4. Run.** For a container whose full 64-hex id the proxy recorded
  durably from its own create, and nothing else (names and prefixes are
  refused):
  - `POST /containers/{id}/attach` with exactly
    `stream=1&stdin=1&stdout=1&stderr=1`, before start;
  - `POST /containers/{id}/start`, `POST /containers/{id}/wait` and
    `POST /containers/{id}/kill`, each with no query and no body (kill is
    SIGKILL); of `wait`'s reply only `StatusCode` is read;
  - `GET /containers/{id}/json`, no query, of which only `State.OOMKilled`
    is read;
  - `DELETE /containers/{id}?force=1`.

  The proxy deletes a recorded container itself, whatever its state, when
  the launcher has not deleted it within 30 s of the later of its wait
  returning and its attach stream ending, within 30 s of the launcher
  closing that container's attach connection in both directions before its
  wait has returned (the half-close that ends stdin under `StdinOnce` is not
  a close), or
  at the latest 30 s after its deadline (P6). A launcher crash at any point leaves nothing behind.

- **P5. Images.** `POST /images/load?quiet=1` only for an image in the pin
  list, and `POST /images/load?quiet=1&site=<site id>` only for the
  candidate of the pin-list entry it names, one with a lockfile digest and
  no image id. `<site id>` is from `[a-z0-9-]{1,64}`, equals a pin-list key
  byte for byte, and is never percent-encoded; the proxy strips `site`
  before it forwards. Either load only after the proxy has parsed
  the archive itself and rebuilt it with exactly `manifest.json`, the config
  blob and the layer files (a `repositories`, `index.json`, `oci-layout` or
  any other member is refused): its manifest names exactly B8's layers in
  order; the base and entrypoint layers equal their pinned digests byte for
  byte; the `node_modules` layer passes O2's grammar, re-checked by the
  proxy; there are no `RepoTags`; and the image id the proxy computes is in
  the pin list, or is a pin being made (B8). `GET /images/{id}/json` and
  `DELETE /images/{id}` (no query) for site images in the pin list, removed
  from it by the last deploy, or held in the candidate record (P3), never
  the base image. The probe image and the base-plus-entrypoint image load
  only in the plain form, with their own pinned layer lists in place of
  B8's.
- **P6. Deadline and sweep.** The proxy measures every recorded container's
  wall clock from its durable create record, so a container never started
  has a deadline too. At that deadline it kills the container, whatever the
  launcher does; a kill refused because the container is not running counts
  as landed. It force-deletes every recorded container, whatever its state,
  at the latest 30 s after that deadline, and a `wall` crossing's container
  (F1) not before. An id leaves the record only when
  its delete returns success or "no such container"; a delete of a
  recorded container that fails otherwise starts a sweep. The sweep does
  not depend on the record, since
  the daemon can hold a container the proxy never recorded (a crash between
  the daemon's create and the durable record). On start, before it takes a
  request, and whenever P3's count check fails, the proxy sweeps:
  - `GET /containers/json?all=1`, read with a real JSON parser as an array of
    objects of which only `Id` is read, each exactly 64 lowercase hex
    characters;
  - `DELETE /containers/{id}?force=1` for every listed id, recorded or not,
    because nothing else creates containers on this daemon (B9);
  - the same list again, which must be empty, and `GET /info` must report
    zero containers.

  Only then is the record cleared and a request taken. In a sweep, a delete
  answered "no such container" counts as removed. A malformed list, any
  other refused delete or a second list that is not empty leaves the
  launcher `unavailable`, and the proxy repeats the sweep every 30 s until
  one passes. A run whose container a sweep
  removes is refused `unavailable`. A sweep clears the container record
  only; the candidate record stays (P3). The list, and a delete of an id the
  record does not hold, are allowed in the sweep only; P4 still refuses
  both on any launcher request.

- **P7.** Everything else is refused: `/build`, `/session`, exec, commit,
  archive copy in or out, image pull, push or export, plugins, networks,
  volumes, swarm, events, system prune.

## 7. Output

Output is untrusted bytes, read as a closed grammar in memory and never
extracted to disk.

- **O1. `site.build` output** is one ustar stream:
  - type `0` (file) or `5` (directory) only; no PAX (`x`, `g`), GNU (`L`,
    `K`, `S`) or any other type;
  - magic `ustar\0` and version `00`; name plus prefix at most 255 bytes;
    octal size fields only, and 0 for a directory; every header checksum
    verified; exactly two zero blocks at the end and no byte after them;
  - every file's parent directory has its own earlier entry;
  - every name canonical (no leading `./`, no empty or `.` or `..` segment,
    no trailing `/` on a file), matching `^dist(/[A-Za-z0-9._~@+-]+)*$`, NFC,
    and unique after ASCII case folding;
  - at most 5,000 entries; the size cap counted on stream bytes;
  - mode, owner and time fields ignored.
- **O2. `site.prepare` output** follows O1 with root `node_modules`, up to
  200,000 entries and 1 GB. A symlink (type `2`) is accepted only when its
  link name is at most 100 bytes, relative, and, resolved against its
  parent's real path (after every earlier symlink), stays inside
  `node_modules/`; an entry whose path passes through a symlink entry is a
  refusal. A name segment beginning `.wh.` is refused. The launcher writes
  the image layer anew from the accepted entries: a file is 0755 when its
  header's owner-execute bit is set and 0644 otherwise, directories 0755,
  owner 0:0, a fixed time, no extended attributes.
- **O3. Exit.** Success needs exit code 0 within every B6 cap, with
  `State.OOMKilled` false. R1 reports `memory` only when `OOMKilled` is true;
  any other failure to finish is `non-zero exit` or `deadline`. stderr is kept for a person and never read into a
  decision.
- **O4. Use of the output.** The launcher hands its caller the checked O1
  stream and its digest, and nothing else. It has no operation that
  commits, deploys or publishes, and holds no credential that could. How
  the envelope compares two outputs, binds a verdict to what ships, and
  what the host may do after that, is the envelope publish design: a
  separate piece, split from this contract in round 2, that Nathan approves
  on its own (section 12, question 5). Until it is approved, no launcher
  output feeds any publish: the publish flow takes no launcher output as
  an input, and every publish needs a person's approving decision
  (`APPROVAL_MISSING` otherwise), as it does today (D1, D2). The digest,
  which the launcher computes, is the sha256 of every entry in byte order
  of name, each written as its type byte as in the ustar header (ASCII `0`
  or `5`), the name's length (8
  bytes, big-endian), the name, and for a file its size (8 bytes,
  big-endian) and its bytes, so O1's ignored mode, owner and time fields do
  not change it.

## 8. Preflight

- **F1. Probe.** At start and after any F3 difference, the launcher runs S0
  once per run class with that class's create body (the appendix gives the
  differences). Every 15 minutes it probes S1 only, without the wall-clock
  crossing; S2's probe also runs before each S2 run, as its in-run probe
  and its `memory` and `output` crossings, without `wall`. The probe proves
  from
  inside each limit it can observe, by crossing it:
  - the kernel is gVisor's, and the only interface is loopback;
  - no address answers: a public address, the metadata address, the VM's and
    the machine's addresses, Docker's host gateway, the LAN, the proxy, and
    IPv6;
  - the root filesystem refuses a write, the complete writable set is
    `/work`, `/tmp` and `/dev/shm`, and the probe fills each to ENOSPC at
    its size and frees it before the next;
  - the environment is exactly B3, and effective capabilities are zero;
  - a fork past 256 is refused.

  The probe writes one JSON object to stdout, parsed with P1's parser, with
  exactly the boolean keys `kernel`, `interfaces`, `addresses`, `rootfs`,
  `writable`, `env`, `caps` and `fork`, every one true, and passes only with
  exit code 0 and `OOMKilled` false. The three crossings that end or refuse
  the run itself are proved from outside, each by its own S0 run with a
  fixed crossing argument (appendix), and pass only on the launcher's own
  observation:
  - `memory`: the probe allocates the probed class's memory limit plus
    64 MiB once, then exits 0; it passes only when `OOMKilled` is true;
  - `wall`: the probe sleeps without end; it passes only when the
    launcher's one wait, sent once after start, returns no earlier than the
    deadline and within 30 s after it, with `StatusCode` 137, and a
    `GET /containers/{id}/json` sent after that wait has returned then
    reads `OOMKilled` false; a dropped wait connection fails it. Until that
    read, or the end of that 30 s with no wait reply (a failed crossing),
    the launcher sends no delete and keeps that container's attach
    connection open (a half-close of stdin is not a close, P4), and P6
    deletes that container no earlier than 30 s after its deadline, so no
    delete reaches it inside the window and only P6's deadline kill can end
    it there with a passing reply;
  - `output`: the probe writes the smallest valid O1 stream longer than
    S0's output cap; it passes only when every earlier byte passed O1 and the
    refusal is for the size cap.

  In the three crossing runs the launcher sends no kill. For `wall` the
  deadline is P6's, and the launcher measures it from its own create
  request. Any other outcome of those runs, a probe-result object on stdout
  from them included, fails the probe. The `output` crossing proves S0's
  cap only; S1's and S2's output caps are proved by B6's crossing
  (section 13).

  Outside the probe, the VM's boot check and a machine-side check at deploy
  and after any F3 difference (never the launcher; F3 reads their last
  result) prove that from the VM, the machine, the LAN and a public address
  do not answer, and that on the machine neither the launcher's uid nor the
  machine's main user can open the daemon socket.

- **F2. Reproducibility**, a precondition for recording a pin, not a safety
  control: three S1 runs the launcher makes itself, with no changed file,
  on the tree at the commit the pin change's first commit names, assembled
  by I2 and refused under I3, and refused unless its `package.json` and
  `package-lock.json` digest equals the entry's (I4). It passes only when
  the three output digests (O4) are equal. It is repeated
  whenever the base, the entrypoint layer or the lockfile changes.
- **F3. Drift.** Before every run, `GET /version` and `GET /info` (engine,
  kernel, runtimes with their hash-bearing paths and arguments, image store)
  must equal those at the last passed probe. Any difference, or a failed probe, marks the launcher
  unavailable until a new probe passes.

## 9. Failure

- **R1.** Every failure is a refusal with a named reason: unavailable,
  preflight failed, drift, unknown site, no pin, pin mismatch, input refused,
  lockfile refused, fetch failed, integrity mismatch, image load failed,
  proxy refused, queue full, deadline, memory, process limit, output refused,
  non-zero exit. Any other failure is the
  refusal `internal`, and a caller that gets no well-formed answer treats it
  as `unavailable`.
- **R2.** The launcher never retries a run. Every container is removed in every case,
  including after a launcher, proxy or daemon restart (P6).
- **R3.** A caller maps a refusal to its own outcome; for the envelope that
  is `CHANGE_ENVELOPE_EXCEEDED` with the reason, so the edit goes to a
  person (O4).

## 10. Degraded behaviour

- **D1.** The tool registry reports availability per run class with the
  reason. Agent tools that run arbitrary code and headless execution stay
  `unavailable` whatever the launcher's state (T3). The registry also
  holds the envelope's automatic publish, reported `unavailable` with the
  reason `publish design not approved`; nothing in this contract makes it
  available (O4).
- **D2.** There is no fallback: no build outside gVisor, no output built
  anywhere else (CI artefacts, host previews) standing in for the
  launcher's, and the envelope's static checks alone never approve an
  automatic publish.

## 11. Where it runs

| Place                            | Runs                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Production machine, sandbox VM   | The socket proxy's daemon and the sandboxes (B9)                                        |
| Production machine, outside it   | The launcher and the socket proxy, as their own unit (question 2)                       |
| CI (existing GitHub-hosted runs) | `runsc` installed in the job; the section 13 suite on our fixtures; never a client site |
| A developer's macOS laptop       | Nothing sandboxed; the grammar corpus only; sandbox tests report absent                 |

The launcher reports a run class available only after the section 13 suite
has passed on the production sandbox VM, and again after any F3 difference.
On the production VM the suite runs the crossings reachable through the
proxy. The harness-only crossings (a create straight on the daemon) run in
CI and at VM build, before production use, against the same pinned runsc
and `daemon.json`. An
F3 difference in engine, runtime or kernel needs a VM rebuild, with the
harness-only crossings run again before production use. No paid service
and no new hosted runner.

Expected refusals, safe but frequent: sites over the size caps, sites
whose build is not reproducible (F2), and every site whose lockfile changed
until its new pin is reviewed.

## 12. Open questions for approval

1. **The sandbox VM (B9).** The production machine is an arm64 Mac. Which free
   VM tool hosts the sandbox VM, and whether gVisor's platform runs there
   (systrap, or KVM if nested virtualisation is available), is unverified. If
   neither works, the launcher stays unavailable.
2. **The launcher's unit.** Staging's rule is that no service mounts a path
   from the machine. The proxy needs the sandbox VM's Docker socket and the
   launcher needs the proxy's. This contract keeps both as their own unit:
   the proxy on a Unix socket only, on no network; the launcher on one
   internal network shared with the production worker and nothing else,
   with a read-only root, no secrets, every capability dropped and limits
   sized for a 1 GB output. Staging gets its own launcher or none. It asks
   for that exception by name.
3. **The site engine's settled rules.** The site-engine specification says
   Ops Astro never calls a site-side command and never builds a site, so it
   needs no package token (SPEC 5.7 and section 10, item 6). This contract
   builds the site, and `site.prepare` fetches private packages with that
   token through the credential broker. Approving this contract amends
   those two rules; refusing it keeps them and leaves #972 without a build.
4. **Unverified mechanisms.** Whether GitHub Packages downloads redirect and
   to which hosts (E2), how runsc backs `/dev/shm`, and whether Docker sets
   `State.OOMKilled` for a runsc sandbox its memory limit kills (F1, O3).
   Each is settled by a
   crossing test before the line that needs it may pass; until then that
   line refuses.
5. **The split (new in round 2).** The envelope's comparison, publish
   binding and host fidelity are a separate design piece, and #972 waits on
   it. Approving this contract approves running site builds in the sandbox,
   and nothing that publishes. The host and its settings, the publish flow
   and the client branch protection, and a deploy credential as a custody
   item are that piece's questions, asked when it is drafted. Its direction
   is set: for an automatic publish the host never builds the site, and
   what ships is exactly the output that was compared.

## 13. Proof before merge of the implementation

Every numbered line is in at least one of these two lists:

- Crossings, in a real `runsc` container or VM: T1, B1-B9, E1-E3, P3's
  container record, P4's proxy delete, P6, F1, F2. A real network attempt, a
  real write, a real secret probe, a real cap, a real load.
- Corpus fixtures, one per refusal clause: T2's pin rule, T3, S0-S2, I1-I6,
  P1-P5, P7, O1-O4, F3, R1-R3, D1-D2.
- Each test fails with its guarding clause removed, and the pull request
  lists that red under "Undo-red".
- Named proofs for the round-2 clauses, each with its Undo-red:
  - O4 and D1 (corpus): the launcher's interface offers no commit, deploy
    or publish operation and its replies carry no credential or host field;
    the publish job takes no launcher output and refuses without a
    person's approving decision; the tool registry reports the envelope's
    automatic publish `unavailable`. Two outputs that differ only in tar
    mode, owner or time have the same digest. Undo-red: add a publish
    operation or a credential field and the interface test fails; add a
    launcher-output input to the publish job and the publish test fails;
    report the registry entry available and the registry test fails; hash
    the stream instead and the digest test fails.
  - P6's sweep (crossing, real daemon): the CI harness creates a container
    straight on the daemon with the fixed S1 body and never starts it (the
    container a crash between create and record leaves), once before the
    proxy starts with an empty record and once while it runs. Each is
    swept (the second at the next create, for the count) and the next valid
    create passes. A list reply with a malformed `Id`, a second list that is
    not empty, or `/info` above zero leaves the launcher `unavailable`.
    Undo-red: sweep the record only and the next create is refused for the
    count. A delete answered "no such container", in a sweep and for a
    recorded id, counts as removed; any other answer keeps the id in the
    record. A failed sweep repeats every 30 s until one passes. Undo-red:
    drop the record rule and an id leaves the record on a failed delete;
    drop the repeat and the launcher stays `unavailable` after the daemon
    recovers; treat "no such container" as a failure and the id stays in
    the record and every later create is refused.
  - P3 and P4's recorded container (crossing): the launcher is killed
    between create and start, again after start while the build exits by
    itself, and again mid-run. Each time a new create is refused while the
    record holds the container, the proxy deletes it (by 30 s after the
    launcher closes its attach connection in both directions, at the
    latest 30 s after its
    deadline),
    and the next create then passes. A sweep whose delete is answered with
    a conflict repeats until it passes. Undo-red: allow a non-empty record
    and the second create runs beside the first; key the delete on wait or
    a successful kill and the next create is refused for ever. A deadline
    delete answered 500 starts a sweep and the next create passes;
    Undo-red: no sweep, and every later create is refused.
  - P3's candidate (corpus): a pin-list entry with a lockfile digest and no
    image id, and its candidate C loaded. Three S1 creates of C pass; the
    fourth is refused, and so are a second load of C, a create of C with
    the S2 body, a create of C after a deploy changes that entry, and a
    create of an unpinned image that is not the candidate. The candidate
    record survives a proxy restart. A `site.build` request for that site
    is refused `no pin`, and a create of C with another site's S1 body is refused. A candidate load whose `site` names an entry with an image
    id, or another entry's open candidate, is refused, and a second
    candidate's create is compared with its own entry's body. After a
    failed F2, a commit that raises the attempt number lets a new load
    pass. Undo-red: remove the candidate clause and F2's first create is
    refused; remove the count or the reload rule and a fourth create
    passes; remove the attempt number and the reload after a failed F2 is
    refused. A create the daemon made but the proxy never recorded leaves
    the creates-left count unchanged; a superseded candidate's image can be
    deleted. A deployed pin-list id that is not the proxy's candidate for
    that entry and attempt, or one with creates left, is treated as no
    image id, and so is a deployed C with fewer than three recorded
    creates, after a proxy restart too. Undo-red: count at the create
    request, refuse the superseded delete, take the deployed id as is,
    accept on creates left 0, or forget the accepted id on restart, and its
    case fails. After a commit that raises the attempt number, a deploy of
    the old accepted id is treated as no image id; a C whose third run was
    killed is not accepted; C accepted, its image deleted, the proxy
    restarted and C reloaded in the plain form gives an S1 create of C that
    passes. Undo-red: drop the clear on a changed or emptied id, or count
    a killed run, and its case fails. A deploy that changes only the entry's
    lockfile digest, same attempt and same C, leaves the entry with no
    image id. Undo-red: drop the candidate's digest from the acceptance
    rule and C is accepted under the new digest.
  - F1's outside crossings (crossing): a healthy installation passes the
    probe, with `memory`, `wall` and `output` judged by `OOMKilled`, the
    deadline kill and O1's cap refusal; with the memory limit, the deadline
    or the output cap removed, its crossing fails the probe; a crossing run
    that writes an all-true stdout result still fails; a wall run whose
    probe exits at 1 s fails, a deadline set at twice B6's wall fails, a
    memory limit raised by 128 MiB fails, and an output run of non-ustar
    bytes fails; an in-run result with a missing or extra key, or with a
    non-zero exit, leaves the launcher `unavailable`. An `output` crossing
    refused at S0's cap passes and leaves the launcher available; one
    refused for a bad name fails. With the launcher's kill in place and
    P6's deadline removed, the wall crossing fails. In every wall run the
    proxy receives from the launcher one wait, and no delete and no attach
    close for that container before the launcher's
    `GET /containers/{id}/json`, which comes after the wait reply, or, when
    no wait reply has come by 30 s after the deadline the launcher measures
    from its create request (F1), before then; P6's
    delete of it is sent no earlier than 30 s after its deadline; a wall
    run whose wait connection drops fails. An S2 request whose
    pair hashes to another digest is refused `pin mismatch`. Undo-red: take
    the in-run result for those three, or "the run ended", any OOM or any
    refusal for a pass; treat every S0 refusal as a failed probe; let the
    launcher kill in the wall run, or delete, close its attach or wait
    again before its read, or read `OOMKilled` before its wait returns; let
    P6 delete a wall run's container before 30 s after its deadline; or
    drop S2's digest check; and its case
    fails.
  - The output rule (corpus): a build whose correctly framed stdout holds
    `dist/bad name.html`, or stdout past the S1 cap, is refused
    `output refused`, and the next valid build of another site passes with
    no new probe; a build whose stderr passes 64 KiB is not refused; a frame of stream 0
    leaves the launcher `unavailable`. Undo-red: treat an O1 refusal as a
    daemon fault and the next build is refused `unavailable`.
  - O4's credential (corpus): the launcher unit's environment and mounts
    hold no secret. Undo-red: give it one and the case fails.
  - P1's daemon replies, P4's half-close and the pin list's probe and S2
    entries (corpus and crossing): a daemon reply with a duplicate key, over
    1 MiB or deeper than 32 leaves the launcher `unavailable`; a 90 s build
    whose launcher half-closes stdin at once completes; an S0 create with
    the probe image passes and an S1 create with it is refused; an S2
    create with the base-plus-entrypoint image and B3's S2 `Env` passes,
    and one carrying a site variable is refused; an S2 or S0 create with a
    pinned site image, and an S1 create with the base-plus-entrypoint
    image, are refused. After a proxy restart the probe and S2 creates still
    pass. A `_ping` body other than `OK`, a 204 with a body, a frame of
    stream 0, or a probe result with an extra or missing key leaves the
    launcher `unavailable`, and the next passing probe makes it available.
    Two outputs whose names and bytes would collide without the length
    fields have different digests. Undo-red: drop each rule, or read the
    probe's stdout as free text, and its case fails.
  - F2 (crossing): three builds of a tree whose lockfile digest is not the
    entry's are refused; three equal builds pass. Undo-red: skip the
    lockfile check and the wrong tree passes.
  - I4, B3 and B8 (corpus): a `site.build` request for a site whose pin has
    no image id is refused `no pin`; a site record naming `HOME` gets B3's
    value. A run whose container a sweep removes is refused `unavailable`.
    Undo-red: remove each clause and its case passes.
- The suite runs in CI against our fixtures and on the production sandbox VM
  (section 11).

## Appendix: the fixed create body

The proxy holds this body for `site.build` and compares each request with it
whole (P3). The other bodies differ from it in these keys only, with these
values, and in nothing else:

- `site.prepare`: `Cmd` `["prepare"]`; `Env` the S2 list from B3;
  `Memory` and `MemorySwap` 4294967296; `Tmpfs` `/work` size 2147483648 and
  `/tmp` size 1073741824.
- `probe`: `Image` the pinned probe image; `Cmd` `["probe", "<class>"]`,
  or `["probe", "<class>", "<crossing>"]` with `<crossing>` one of
  `memory`, `wall` or `output` (F1);
  for S1, `Env` the fixed variables of B3 and no site variables; every other
  key as the probed class's body.

```json
{
  "Image": "<slot: sha256 id>",
  "Entrypoint": ["/opt/launcher/entrypoint"],
  "Cmd": ["build"],
  "User": "10001:10001",
  "WorkingDir": "/work",
  "Hostname": "sandbox",
  "Env": ["<the S1 list from B3, fixed per pin>"],
  "AttachStdin": true,
  "AttachStdout": true,
  "AttachStderr": true,
  "OpenStdin": true,
  "StdinOnce": true,
  "Tty": false,
  "NetworkDisabled": true,
  "Healthcheck": { "Test": ["NONE"] },
  "Volumes": {},
  "Labels": {},
  "HostConfig": {
    "Runtime": "runsc",
    "NetworkMode": "none",
    "ReadonlyRootfs": true,
    "CapDrop": ["ALL"],
    "SecurityOpt": ["no-new-privileges"],
    "Privileged": false,
    "Memory": 1073741824,
    "MemorySwap": 1073741824,
    "NanoCpus": 1000000000,
    "PidsLimit": 256,
    "OomScoreAdj": 1000,
    "ShmSize": 16777216,
    "Tmpfs": {
      "/work": "rw,nosuid,nodev,size=402653184",
      "/tmp": "rw,nosuid,nodev,size=268435456"
    },
    "LogConfig": { "Type": "none", "Config": {} },
    "RestartPolicy": { "Name": "no" },
    "AutoRemove": false,
    "Init": false
  }
}
```
