---
name: How to structure a repo
description: Create a repo, release, tidy the READMEs, what a repo should contain: the layout standard (README with what it is, how to run it, how to test it; CHANGELOG with one entry per release; docs folder for designs and plans; a gitignore), kept current in the same commit as each release.
type: reference
metadata:
  type: reference
  asserted: 2026-11-13
  updated: 2026-11-13
  kit_version: 1
  kit_hash: 0b4e39dc2204db66
---

# How to structure a repo

A reader who opens a repo should be able to tell what it is, how to run it and how to test it without asking anyone. A repo whose README stopped at an old version fails that test.

## At the root of every repo

1. README.md with at least three sections, in this order: what it is (one paragraph: what it does, who uses it, where it runs, who owns it); how to run it (the command, scheduled task or service, its configuration file and where its data lives); how to test it (the exact command and what a pass looks like). Longer READMEs add sections after those three, never before them.
2. CHANGELOG.md: one entry per release or version, newest first, each with the version, the date (YYYY-MM-DD) and what changed in plain sentences. A repo without version numbers uses dated entries for each change that matters to a user of it. History older than the first entry is pointed to (the commit log), not rewritten.
3. A docs folder for designs, plans, decisions and reviews. Nothing else goes there.
4. A .gitignore that keeps out data, logs, secrets and build output.

## Kept current

A release is not done until its CHANGELOG entry is written and the README matches what changed (a new setting, command, route or behaviour), in the same commit or the commit right before the publish. Write both in plain, formal language.

## Exceptions

A generated copy, such as an export of another repo, takes its README and CHANGELOG from its source and is not edited by hand. A folder that is not a repo is not covered until it becomes one.

Starting a new project is covered in [[reference_how_to_start_a_new_project]].

## Related
[[reference_how_to_start_a_new_project]] [[reference_how_to_write_a_document]] [[reference_how_to_plan_test_and_verify]] [[reference_how_to_build_software_the_engineering_rules]]
