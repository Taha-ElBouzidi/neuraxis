---
name: How to investigate a session from its transcript
description: Why did that session cost so much, why did it take so long, why did it repeat the work, what did the agent actually do in that conversation: how to read a Claude Code session transcript safely (measure first, line numbers before content, quote the line for every finding). Read before opening any session file.
type: reference
metadata:
  type: reference
  asserted: 2026-11-13
  updated: 2026-11-13
  kit_version: 1
  kit_hash: 525d90259044528c
---

# How to investigate a session from its transcript

## Rules

1. Get the problem statement first: which session, which turns, what the person expected, what happened, and the one thing the person cares about (time, tokens, repeated actions, a single action). "It took too long" is a complaint, not a problem. Ask one question at a time. If the person is not there, write the questions down and stop. Do not make up the answer.
2. Find the file and prove it is the right one. Claude Code keeps each session as one .jsonl file, one record per line, in a per-project folder under the user's .claude/projects directory, named by the session id. Confirm it by quoting the first prompt and its timestamp. The newest file is not proof. List the candidates you rejected. Sub-agent transcripts are separate files, and in one of them "user" means the parent agent, not the person.
3. Measure before you read. One line can be enormous: a transcript of only a few dozen records can hold a single line of tens of thousands of characters. Run `wc -lc` on the file first, then list the long lines with `awk 'length($0)>100000 {print NR, length($0)}'`. Never cat or grep a transcript for content. Get line numbers and counts first (`grep -n ... | cut -d: -f1`, a count of records by type), then read small fields from chosen lines (`sed -n 23p file | cut -c1-500`). If one record returns more than 500 characters, narrow the field. Never change, move or delete a session file.
4. Know what a record is before you count it. Hook output, system reminders and tool results are not the words of the person. Record types include user, assistant, attachment and cost records, so list the types by count before you assume any. Assistant records carry usage counters (input tokens, cache creation input tokens, cache read input tokens, output tokens). Work out what each counter means before you add them up, and never turn a missing field into zero.
5. Every finding cites the file and the line. No citation, no finding. Every number comes from the transcript or from a command you ran, never from memory, and an estimate is labelled as one.
6. Report what happened, with the evidence. Do not redesign the thing under examination unless the person asks.

## Where it applies

Questions such as what a session cost, where the time went, why an agent redid finished work, or whether a rule was followed. The risk it guards against is flooding your own context with one huge line. See also [[reference_how_to_clean_up_the_context]].

## Related
[[reference_how_to_clean_up_the_context]] [[reference_how_to_debug_systematically]] [[reference_how_to_review_work_before_calling_it_done]] [[reference_how_to_research_with_sources]]
