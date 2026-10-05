# Sandbox launcher contract (draft, not approved)

Status: **draft for approval**. Drafted 5 October 2026 under
[ADR 0048](../adr/0048-sandbox-launcher-contract-drafted-reviewed-not-built.md).
Nothing here is built. Nathan approves the final version after the adversarial
findings are resolved, and only then may implementation start. Until then
untrusted package installation and headless execution stay unavailable, with
no unsandboxed fallback.

Each numbered line is a rule the implementation must keep and a test must
prove. A line that cannot be proven is a refusal, not a warning.

## 1. Scope and first user

The launcher runs code we do not trust in a container, and hands back only
bytes. Its first user is the site change envelope (issue #972): to decide
whether an automated edit to a client's live Astro site is one word of body
copy, the envelope builds the site before and after the edit with the site's
own pinned toolchain and compares what each build serves.

Building a site runs the site's code: its `astro.config.mjs`, its integrations
(for the template site: `@astrojs/sitemap`, `@astrojs/mdx`,
`@astrojs/partytown`, `astro-icon`, `astro-compress`), Vite plugins such as
`@tailwindcss/vite`, and native modules such as `sharp`. All of it is treated
as hostile.

Out of scope: agent tools that run arbitrary code, headless browsers, and any
other user. Each needs its own amendment to this contract and its own approval.

## 2. Run classes

The launcher knows exactly two run classes. Any other request is refused.

- **S1. `site.build`**: build one site tree with its prepared image. No
  network. Used twice per envelope check (before and after).
- **S2. `site.prepare`**: install one site's dependencies from its lockfile
  into a new image. Network to the package registry only, through the egress
  relay (section 5). Runs once per lockfile, never during a check.

## 3. Accepted and refused inputs

The launcher reads every request as a closed grammar: a JSON body parsed with
a real parser, an exact key set per run class, and each value checked against
an allow-list. Unknown keys, unknown values and extra fields are refused.

- **I1. `site.build` accepts only:** a site id known to the registry; a
  `baseRevision` (40 hex characters); one changed file (a repository-relative
  path that exists in the tree at `baseRevision` as a regular file, and its
  new content, at most 64 KiB of UTF-8).
- **I2. The launcher builds the input tree itself** from the site repository
  at `baseRevision`, through the credential broker's read operation. The
  credential stays outside the sandbox; the sandbox receives bytes only.
- **I3. The tree is refused** when it holds more than 20,000 entries or 50 MB,
  an entry that is not a regular file, directory or symlink, a symlink whose
  target leaves the tree, an absolute path, a `..` segment, a NUL or control
  character in a name, a git submodule, or two names that differ only in
  case.
- **I4. The image is refused** when the site has no pin, or when the digest of
  the lockfile at `baseRevision` differs from the digest the pin was prepared
  from. A changed dependency needs a new `site.prepare` and a new pin.
- **I5. `site.prepare` accepts only:** a site id, a `baseRevision`, and the
  lockfile digest it expects to find there. The package manager runs with
  `--frozen-lockfile` and checks every package's integrity hash.

## 4. Isolation

Every run is one new container under gVisor (`runsc`), removed when the run
ends, whatever the outcome.

- **B1. Runtime:** `runsc` at the version and hash pinned in
  `docs/supply-chain-pins.md`. A container that would start under any other
  runtime is refused by the socket proxy (section 6).
- **B2. Network:** `site.build` has network mode `none`, so only loopback.
  `site.prepare` joins one internal network whose only other member is the
  egress relay.
- **B3. Secrets:** no env file, no mounted credential, no Docker socket, and
  an environment of exactly `NODE_ENV=production`,
  `ASTRO_TELEMETRY_DISABLED=1`, `HOME=/tmp/home` and `PATH`. The host name is
  fixed and carries no site or client name.
- **B4. Host writes:** read-only root filesystem, no bind mount and no named
  volume. The only writable places are `tmpfs` mounts (`/work`, `/tmp`)
  sized inside the memory limit. Input arrives on stdin, output leaves on
  stdout.
- **B5. Privileges:** a fixed non-root uid and gid, every capability dropped,
  `no-new-privileges`, the default seccomp profile under gVisor's own
  syscall surface, no devices, no host namespaces (pid, ipc, uts, network,
  user).
- **B6. Caps per run:** 120 s wall clock, 1 GiB memory with no swap, 1 CPU,
  256 processes, 50 MB input, 50 MB output, 64 KiB of stderr kept.
  `site.prepare` gets 600 s, 2 GiB of memory and 1 GB of output, the rest
  unchanged.
- **B7. Machine share:** one sandbox at a time on a machine, a queue of at
  most four, and a queue wait of at most 300 s. The production machine runs
  live services, so the launcher never borrows their headroom.
- **B8. Images:** a sandbox image is a pinned Node base by digest plus one
  layer holding the site's installed `node_modules`. The image build runs no
  step of its own (no `RUN`): it only adds the layer `site.prepare` returned.

## 5. Egress

- **E1.** `site.build` has none (B2).
- **E2.** `site.prepare` reaches one host, the package registry named in the
  site's lockfile, through an egress relay of the same design as staging's
  (`scripts/ops/egress.mjs`): host names only, no credential, no other
  address. Any other registry in the lockfile is a refusal.
- **E3.** Cloud metadata addresses, private ranges, the machine's own
  addresses and every other container are unreachable from both classes.

## 6. Socket-proxy operations

The launcher never holds the Docker socket. It talks to a socket proxy of
ours that reads each Docker API request as a closed grammar (method, path
pattern, exact JSON body key set) and forwards only these:

- **P1.** `GET /_ping`, `GET /version`, `GET /info` (preflight only).
- **P2.** `POST /containers/create` only when the body sets the pinned
  runtime, an image digest in the registry, network mode `none` or the one
  prepare network, a read-only root, no binds, no volumes, no devices, every
  capability dropped, `no-new-privileges`, the B6 limits, the B5 uid, the B3
  environment, and nothing else.
- **P3.** `POST /containers/{id}/attach`, `/start`, `/wait`, `/kill`, and
  `DELETE /containers/{id}`, for containers the proxy itself created.
- **P4.** `POST /build` only with the launcher's fixed Dockerfile (pinned
  base digest, one `COPY` of the prepared layer, a fixed `USER`), checked
  byte for byte.
- **P5.** `GET /images/{digest}/json` and `DELETE /images/{digest}` for
  registry images.

Everything else (exec, commit, copy-in, plugins, networks, volumes, swarm,
events) is refused.

## 7. Output

The output is untrusted bytes and is read as a closed grammar.

- **O1.** stdout is one tar stream. Only regular files and directories under
  `dist/` are accepted. A symlink, hard link, device, absolute path, `..`
  segment, duplicate name, a name outside a fixed character set, more than
  5,000 entries or more than 50 MB is a refusal of the whole run.
- **O1b.** For `site.prepare`, stdout is one tar stream of `node_modules/`
  under the same rules, except that a symlink is accepted when its target is
  relative and stays inside `node_modules/`, and the limits are 200,000
  entries and 1 GB.
- **O2.** The exit code and the B6 caps decide success. stderr is kept for a
  person and never parsed into a decision.
- **O3.** The envelope compares the two outputs: every file except the target
  route's HTML must be byte-identical, and the target's served HTML then goes
  through the envelope's token grammar. That grammar is part of the envelope
  piece, not of this contract.

## 8. Preflight

- **F1. At start and every 15 minutes,** the launcher runs a probe image of
  ours under the same rules and proves from inside: the kernel is gVisor's;
  the only interface is loopback; no address outside the container answers
  (a real attempt at the internet, the metadata address and the machine);
  the root filesystem refuses a write; the environment is exactly B3;
  effective capabilities are zero; the memory and process limits are the B6
  values.
- **F2. Per site image,** before its pin is recorded: build the unchanged tree
  twice and compare the outputs. A site whose build is not byte-reproducible
  cannot be checked and is refused for automatic publishing.
- **F3.** A failed preflight marks the launcher unavailable until the next
  probe passes.

## 9. Failure

- **R1.** Every failure is a refusal with a named reason: unavailable,
  preflight failed, unknown site, no pin, pin mismatch, input refused, queue
  full, deadline, memory, process limit, output refused, non-zero exit.
- **R2.** No retry inside a check. The container is removed in every case.
- **R3.** For the envelope, a refusal is `CHANGE_ENVELOPE_EXCEEDED` with that
  reason, so the edit goes to a person.

## 10. Degraded behaviour

- **D1.** When the launcher is unavailable, the tool registry reports
  `sandbox: unavailable` with the reason (ADR 0048), and every caller gets the
  R1 refusal.
- **D2.** There is no fallback: no build outside gVisor, and the envelope's
  static checks alone never approve an automatic publish.

## 11. Where it runs

| Place                      | Runs                                                      |
| -------------------------- | --------------------------------------------------------- |
| Production machine         | The launcher, the socket proxy and the sandboxes          |
| CI (GitHub-hosted Ubuntu)  | `runsc` installed in the job; the B, E, P, O and F tests  |
| A developer's macOS laptop | Nothing sandboxed; those tests report the sandbox missing |

No paid service and no new hosted runner.

## 12. Open questions for approval

1. **gVisor on the production machine.** It runs Docker on macOS, so `runsc`
   would sit inside Docker's Linux VM. That is unverified. If it cannot, the
   launcher needs a separate free Linux VM on that machine.
2. **The launcher's socket.** Staging's rule is that no service mounts a path
   from the machine. The socket proxy needs the Docker socket and the
   launcher needs the proxy's. This contract keeps both outside the staging
   and production networks as their own unit, reachable by the worker over
   one internal network, and asks for that exception by name.
3. **Lifecycle scripts in `site.prepare`.** They run (some packages, such as
   `sharp`, need them), inside gVisor with registry-only egress and no
   secrets. The alternative, `--ignore-scripts`, may not build every site.

## 13. Proof before merge of the implementation

Each line in sections 3 to 10 gets a test that makes a real crossing in a
real `runsc` container: a real network attempt, a real write, a real secret
probe, a real oversize output. The test must fail with the guarding line
removed, and the pull request lists that red under "Undo-red".
