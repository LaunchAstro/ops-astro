# Tool names across runtimes

A neutral adapter reference. The vendored skills were written against one
runtime's tool names; this page maps them so a skill reads the same on Claude
Code and on Codex.

It is written by this repository, not vendored. Upstream this reference lives
inside `poteto-mode`, which is excluded here because it is a second router,
so the two verification skills that pointed at it were pointing at nothing.
That is a recorded local edit; see `.claude/skills/README.md`.

## What a skill should say

Name the capability, not the vendor's tool. "Read the file", "run the
command", "start a sub-agent for each feature". Every runtime has those, and
a skill written that way needs no adapter at all.

Where a skill must name a tool, use this table.

| Capability | Claude Code | Codex | Notes |
|---|---|---|---|
| Read a file | `Read` | `read_file` | Both take a path |
| Write a file | `Write` | `write_file` | Prefer an edit over a rewrite |
| Edit part of a file | `Edit` | `apply_patch` | Codex takes a patch, not a match |
| Run a command | `Bash` | `shell` | Both run in the repository |
| Search file contents | `Grep` | `shell` with `rg` | |
| List or glob paths | `Glob` | `shell` with `fd` or `ls` | |
| Fan out to sub-agents | `Task` | `spawn_agent` | See the note below |
| Fetch a web page | `WebFetch` | the runtime's fetch tool | Never for anything private |

## Project-local skills

Claude Code reads project skills from `.claude/skills/`. Codex reads the same
files through `.codex/skills`, which is a symlink to that directory: one copy,
not two. A skill that generates another skill writes it under `.claude/skills/`
and it is visible to both.

## Fanning out

Some skills ask for one sub-agent per unit of work. Where a runtime has no
sub-agents, do the units in sequence and say so in the output. Sequential and
slower is a correct result; pretending to have parallelised is not.

## Driving the application

The harness a verification skill generates is platform-neutral: a browser over
the debugging protocol, a pseudo-terminal, or plain HTTP. None of that depends
on the runtime. Only the tool used to launch it does, and that is `Bash` or
`shell` above.

## `/security-review` on Codex

`/security-review` is a Claude Code command. `AGENTS.md` makes it mandatory
before any pull request touching auth, tenancy, tool execution, egress,
custody or the audit chain, and a rule that only one runtime can follow is not
a rule. `_shared/security-review.md` is the equivalent procedure, written so
any runtime can carry it out.
