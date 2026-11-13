---
name: How to find out what the person wants before building
description: I have an idea, let us think about this, brainstorm, design this feature, I am not sure how it should work: how to find out what the person actually wants and why before building (check what you already know, one open question at a time, say your guesses, play it back, size it). Not for a request that already says what to do, and not when the person says go.
type: reference
metadata:
  type: reference
  asserted: 2026-11-13
  updated: 2026-11-13
  kit_version: 1
  kit_hash: 447182d955b699fa
---

# How to find out what the person wants before building

What you believe the person wants is usually thinner than it feels, and people often have not finished working out what they want. Good questions help them get there. When you understand the reason, you can make the hundred small decisions they never mention the way they would.

## First, check what you already know

Do this check silently. Do not narrate it.

- Everything that matters is in the request ("make the icon blue"): do it and say what you did.
- The person has given direction, or says go, or says to work autonomously: do not open a question round.
- Something that matters is missing (the purpose, who it is for, what success looks like): use the method below.

## The conversation

- Open with one line saying the person can skip the questions and have you just start (if so, state any big choice about how it gets made, such as platform, language or medium, in one plain line, and go). Then one open question that gets the person describing a real moment ("what is the moment you wish this existed?"), not a menu of options. Options steer, and the person's own words carry the intent.
- One question per message, one sentence, in the person's vocabulary. Anchor it in something specific ("walk me through the last time this went wrong", "if it could do only one thing well, which?") or in a guess the person can correct ("I am guessing X keeps biting you?").
- Cover this ground without reading it out as a list: what kind of thing it is; why now and what success looks like; goals, non-goals and what would make it a failure even if it works; what the person liked or disliked elsewhere; what exists now and what was tried; the details the person cares about.
- Find out early which choices the person wants to make (tools, platform, medium) and which are handed to you. Say your defaults aloud, because a default the person never heard is one they could not reject. Mark each guess as yours. Only what the person said is theirs.
- Think of several options privately and drop the weak ones, including any that fight what the person told you about the reason. Show the comparison only when it helps the decision. Be open to every idea while brainstorming, and keep "no, because" for the review of the plan.
- Offer to look (the code, the files, the web) and say what for. The person decides. A quick throwaway spike can be the cheapest way to learn what is wanted: label it throwaway, and treat keeping it as a new request.

## Play it back, size it, get the yes

Once one part is clear, describe it back in 200 to 300 words and ask what is wrong or missing, then move to the next part. Then say the size in plain words: a clear task (do it), a small change (agree it in chat, then build it), or a project (a short written design, then a plan; see [[reference_how_to_write_a_plan_an_agent_can_build_from]]). If it grows, stop and say so. If it is really several projects, agree an order and take them one at a time.

Nothing is built until the person approves the full description. Reading and exploring are fine. An open question stays open until the person answers it, and "let us work" is not an answer.

For a written design, a good check is a fresh sub-agent that plays the builder who cannot talk to the author, and returns only the questions where a wrong guess would matter. Sort them into answered already (add the answer), minor (decide, and mark it as your call) and the person's (ask once, most important first). How to brief it: [[reference_how_to_brief_sub_agents_and_pick_models]].

## Related
[[reference_how_to_plan_test_and_verify]] [[reference_how_to_write_a_plan_an_agent_can_build_from]] [[reference_how_to_brief_sub_agents_and_pick_models]] [[reference_how_to_start_a_new_project]] [[reference_how_to_set_and_follow_a_goal]]
