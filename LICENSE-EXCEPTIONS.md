# Additional permission under section 7: the preset and skill exception

**Status: draft. Not granted. Do not rely on it.**

**Subject to counsel.** This is a working draft written by the maintainer so
that the shape of the intended permission is on the record from the first
commit. It has no legal effect. Nothing in this repository is licensed under
it. No one may rely on it, quote it as granted, or build on the assumption
that it will be granted in these words.

It becomes a grant only when all three are true: counsel has approved the
wording; the wording is released in a version of this repository; and this
status line says granted, with the date.

## Why the draft exists now

Section 7 of the AGPL lets a licensor add an additional permission that
widens what recipients may do. Adding one later takes nothing away from
people who already hold a copy, so this can safely wait for counsel.

It has one condition that cannot wait: a permission may be placed only on
material the licensor has the copyright permission to place it on. That is
why `CLA.md` is committed now and why contributions from outside the
maintainer are closed until the tooling for it is live. `LICENSING.md`
records the rule.

## The intended shape

The permission is intended to let people write and distribute presets and
skills, and software that talks to this program over its published
interfaces, without those works becoming covered works under the AGPL.

Intended to be inside the permission:

- **Preset formats.** The data files that describe a way of working: record
  types, field definitions, views, gate definitions, labels and seed data.
- **The skill wire protocol.** The versioned message format a skill process
  uses to talk to the core, and no core internal type on the wire.
- **The REST API.** Calling the published API over a network.
- **The software development kit.** The wire types, the JSON schemas and the
  skill client, which are intended to ship as separate Apache-2.0 packages.

Intended to stay outside the permission, with no exception at all:

- **The core.** The runtime, the records engine, the custody layer, the
  connector layer and the user interface packages. Modifying the core and
  offering it over a network is what section 13 is for, and this permission
  is not intended to touch that.

## The wording that has to survive counsel

Any granted version is intended to keep a line to this effect: _this
permission does not apply to the Core itself, and a work that links against,
embeds or is derived from the Core is not brought inside this permission by
also using a preset format, the wire protocol, the API or the kit._

That sentence is the whole point of the exception. If counsel cannot make it
hold, the exception is not granted at all.

## What is not in this draft

No commercial licence layer. No per-file marking. No enterprise edition. This
repository has two layers only: the AGPL core, and this intended boundary
permission.
