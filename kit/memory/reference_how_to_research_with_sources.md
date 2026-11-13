---
name: How to research with verified sources
description: Find out, look up, research, compare, which is best, how much it costs, what the rules or laws are: how to research with primary sources, check them, and report only what a source says with its link and date.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-11-13
  kit_version: 3
  kit_hash: 8e7de2bc4355fd35
---

# How to research with verified sources

The failure this guards against is an answer that sounds researched but is actually recalled from training data, or a source cited for something it does not quite say. Good research reads the primary source itself and reports only what it actually says, with its link and its date, rather than reporting from a memory of similar material or from a search snippet.

## Before searching

Check memory first: the answer, or a constraint that changes the question, may already be settled. Then write the question in one sentence, and describe what a finished answer looks like, whether a number, a ranked list, or a yes or no with its condition; research without a finish line never ends. Note anything time sensitive: prices, versions, laws, availability, and anything described as "the latest" all need a source dated to the current year.

## Where to look, and in what order

| Need | Best source |
|---|---|
| How a library, API, or tool works | Its official documentation, for the version actually in use |
| A product's price, limits, or features | The vendor's own page, then a dated independent review |
| A law, tax, or rule | The government or regulator's own text |
| A number such as a statistic or a financial figure | The authoritative dataset, never a blog quoting it secondhand |
| Opinions, real-world experience, what breaks in practice | Forums and issue trackers, clearly labelled as opinion |

For a quick fact, a direct search is enough. For a wide question, split it into independent parts and, when the plan allows helpers (on a small plan only when the person asks), give each part to its own sub-agent, following [[reference_how_to_brief_sub_agents_and_pick_models]], each with its own narrow question rather than one agent trying to cover everything at once.

## Checking what was found

Open the page; a search snippet is not a source. Every claim in the report needs a source that actually says it, with a link and a date attached. When two sources disagree, report both and say which one is more authoritative and why. Never fill a gap with a plausible-sounding guess; write "not found" or "unconfirmed" in the same sentence as the gap. A number that can be looked up is never estimated instead.

## Reporting

Lead with the answer, then the evidence behind it. Put comparisons and numbers in a table rather than prose. End with what could not be confirmed and what would settle it. When the result is something that will be relied on later, such as a decision, a price, or a chosen tool, save it as a memory with its source and date, following [[reference_how_to_save_a_memory]].

## Briefing a research helper and checking what it returns

A research helper, another model or a web search tool can be partly wrong. When a page does not hold the number it wants, a model fills the gap with a plausible one, and it does not learn between runs: the only memory it has is what the brief makes it read. So the rules go into every brief, and the checking stays with you.

Rules to put in the brief:

1. Every number, date and name comes with the exact sentence from the page the helper opened, and that page's link. No quote, no number.
2. Never a number or a link from memory. Only links opened in this run.
3. If a page does not say it, write "not found on" and the link. A gap is fine; an invented fact is a failure.
4. Mark each claim as quoted (from a page) or inferred (the helper's own reasoning), never mixed in one sentence.
5. Prefer primary sources, such as the abstract of a paper or the documentation of a vendor, over articles about them.

Checking the result before using it:

- Treat every claim as a lead, not a fact, and label it "research says, not checked" until it is verified.
- Open every source the decision depends on and confirm the quoted sentence. Drop what does not match, and save only what was confirmed, noting what was dropped. Quotes can still be invented even when the rules are in the brief.
- Verify on the real thing first: the settings page of the device, a live measurement, the official page. A second model agreeing, or a model checking a model, is not verification.
- Before changing a setting because research said so, read what the device actually offers and keep a record of the current value, such as a screenshot.
- In the report, say which numbers were measured and which came from research. Where a wrong fact would be costly, use a stronger model for the research and still check it.

## Related
[[reference_how_to_save_a_memory]] [[reference_how_to_brief_sub_agents_and_pick_models]]
