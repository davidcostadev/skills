---
name: llm-council
description: Pressure-test a decision through a council of 5 independent Claude advisors (Contrarian, First Principles, Expansionist, Outsider, Executor) with anonymous peer review and a chairman synthesis. Use when the user says "council this", "run the council", "rodar o conselho", "pressure-test this", "stress-test this", "war room this", "debate this", or presents a high-stakes either/or decision with genuine tradeoffs.
---

# LLM Council (Claude-only)

Adaptation of Andrej Karpathy's LLM Council methodology using only Claude: instead of querying multiple LLM providers, the council is formed by 5 parallel Claude subagents, each locked into a distinct thinking lens. Every advisor answers independently, then peer-reviews the others anonymously, and a chairman synthesizes the final verdict.

## When to run (and when not to)

Run the council for decisions with genuine uncertainty and meaningful stakes: strategic choices ("should I X or Y"), pricing, pivots, hire vs automate, positioning, architecture tradeoffs, risky migrations.

Do NOT run it for: factual questions, simple creation tasks ("write me a post"), casual "should I" with no real tradeoff, or anything with one verifiable correct answer. In those cases, just answer normally.

## Process

### Step 1 - Frame the question

Before spawning anyone:

1. Gather relevant context the advisors will need: files in the workspace, memory, prior decisions in the conversation. Keep it factual.
2. Rewrite the user's question as a NEUTRAL decision brief (no hint of which option you or the user prefer). Include: the decision to make, the options on the table, known constraints, and the gathered context.

The same brief goes verbatim to all 5 advisors.

### Step 2 - Spawn the 5 advisors (parallel, independent)

Spawn all 5 in ONE message (parallel Agent calls, subagent_type: general-purpose) so they run concurrently and cannot see each other. Each prompt = persona block below + the decision brief + these output rules:

- Respond with 150-300 words of independent analysis.
- Stay strictly in your lens; do not try to be balanced.
- End with a one-line position: your recommendation in a single sentence.
- Your reply is raw data for a synthesis step, not a message to a human.

The five personas:

1. **The Contrarian** - "Your job is to find the fatal flaw. Assume the plan fails: why did it fail? Hunt hidden assumptions, second-order effects, and the risk everyone is politely ignoring. You are not negative for sport; you are the last line of defense before a costly mistake."
2. **The First Principles Thinker** - "Ignore how this is usually done. Decompose the problem into fundamentals: what is actually true, what is physically/economically required, what is inherited convention? Rebuild the recommendation from the ground up, even if it reframes the question itself."
3. **The Expansionist** - "Everyone else is debating the question as asked. Your job is upside: what adjacent opportunity, larger version, or compounding effect is being overlooked? Where could this be 10x more valuable than framed? Name the option nobody put on the table."
4. **The Outsider** - "You have zero domain expertise and zero attachment to this field's orthodoxy. React as a sharp generalist hearing this for the first time: what sounds confusing, overcomplicated, or obviously off? Naive questions are your weapon; ask the ones insiders stopped asking."
5. **The Executor** - "Strategy is cheap; shipping is everything. Evaluate pure feasibility: effort, sequencing, dependencies, what breaks first, what the first 2 weeks look like. Whatever is decided, define the smallest concrete next step and the fastest way to learn if it's wrong."

These lenses create deliberate tension: Contrarian vs Expansionist (downside vs upside), First Principles vs Executor (rethink vs ship).

### Step 3 - Anonymous peer review (parallel)

1. Shuffle the 5 responses and label them Response A through E (the mapping must NOT follow the persona order above; do not reveal which persona wrote which).
2. Spawn 5 reviewer subagents in ONE parallel message. Each reviewer gets the decision brief + all five anonymized responses and must answer, in under 150 words:
   - A ranking of all five responses from strongest to weakest, judged on accuracy and insight (Karpathy's original stage 2 criterion), e.g. `C > A > E > B > D`.
   - Why the top-ranked response is strongest (one sentence).
   - Which response has the biggest blind spot, and what it is.
   - One important point the ENTIRE council missed.

Reviewers are generic critics (no persona). They must judge the reasoning, not the style.

### Step 4 - Chairman synthesis

You (the main agent) act as chairman. Using the 5 analyses + 5 reviews (including the aggregate rankings), produce the verdict. Weigh arguments by quality, not by vote count; a single well-argued dissent can outweigh a shallow consensus. The rankings signal which analyses the council found most credible, but they inform the verdict, they do not decide it.

### Step 5 - Present the verdict

Output the verdict as markdown directly in chat (no file, unless the user asks). Format:

```
## Council Verdict: <short decision title>

**Recommendation:** <one clear sentence - pick a side, no fence-sitting>

### Where the council agrees
- <consensus points>

### Where the council disagrees
- <real tensions, framed as X vs Y and what resolving each depends on>

### Blind spots surfaced in review
- <points from peer review the initial analyses missed>

### Why this recommendation
<2-4 sentences of chairman reasoning, referencing the strongest arguments>

### Next step
<the single highest-priority concrete action, per the Executor + reviews>
```

After the verdict, offer to show any advisor's full response if the user wants to drill in.

## Notes

- All 6+ roles run on Claude; diversity comes from the persona prompts and from independence (parallel spawns, anonymized review), not from different models.
- Keep advisor and reviewer outputs internal; the user sees only the verdict unless they ask for the raw council output.
- If the user's question lacks the minimum context to frame a fair brief (options unclear, stakes unknown), ask for it BEFORE convening the council.
