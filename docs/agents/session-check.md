# Check a development session

Run the read-only repository check before implementation:

```sh
bash scripts/agent-session-check.sh
```

Use `--expect` to print the facts a fresh agent session must be able to
identify. The script inspects repository instructions, router wording,
vendored skills, local configuration, and required tools. Read a failure before
trying a workaround. Do not edit global configuration just to make a
repository check pass.

## Inspect loaded context

The committed Claude configuration disables automatic memory. The committed
Codex project configuration disables memory generation and injection for new
trusted project sessions. The repository does not edit user or global
settings. Project policy is not proof of the current session's effective
configuration; Codex skips project layers when the project is untrusted.

For an explicitly memory-off Codex startup, these command-line overrides
take precedence without changing global settings:

```sh
codex -c features.memories=false -c memories.generate_memories=false -c memories.use_memories=false
```

Verify the new session's effective settings before implementation. The
checker reports that runtime proof as unverified until it is supplied. See
[Codex configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic)
and [memory controls](https://learn.chatgpt.com/docs/config-file/config-reference).

File existence and runtime configuration do not prove what a session loaded.
For each supported runtime, record the actual instruction files, active
router, relevant memory settings, and skill resolution in a fresh session.
Use repository-local context for this project. Another project's identity or
private operating instructions supply no authority here.

An archive without Git history cannot satisfy checks that inspect branch and
head state. Inspect its manifest and files for local foundation review. Repeat
the complete development-session check in the authorised checkout before
implementation. Do not create history just to satisfy an archive check.

## Proof limits

No historical workstation transcript is a portable runtime receipt. A clean
session must be verified in the environment that will do the work. This page
records the procedure and does not claim that every supported runtime has
passed it for the current candidate.
