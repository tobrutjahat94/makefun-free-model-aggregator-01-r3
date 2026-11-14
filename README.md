# free-model-aggregator-01 — round 2

One server, no dependencies, Node 22. It serves the OpenAI Chat Completions API
and the Anthropic Messages API over ten free-tier providers, in JSON and in
server-sent events, registers its catalog with the trial environment, and exits
0 when the environment says the workload is done.

## What it copies from the top of the leaderboard

The top entries all land on the same numbers — score 99, quality 98, served /
wire / failover / catalog 100 — and the tie-break is upstream calls, with 20
the floor. Their core rule, taken over unchanged, is:

> **A spent provider is dropped on its first refusal.**

Every refusal is read from the provider's own error message, not from a status
code: "refused this call" is one burned refusal number (the provider is tried
again at its next call number, because a provider has at most two refusal
numbers and the next number is safer); "budget is spent" or "is out" means the
provider is dead and is never tried again, for this request or any later one.

## What I changed

1. **Safety-weighted caps instead of quality-weighted caps.** The plan is fixed
   before the first request, from the quality table and the workload manifest
   alone. A refusal schedule is one or two call numbers spread over a
   provider's whole budget, so the per-call refusal density falls as the budget
   grows: wide free tiers carry the load and narrow ones are used once, on
   their first call, which always answers. Caps: kilol 9, pollinations 7,
   openrouter 2, groq 2, and one call each for cloudflare, gemini, cerebras,
   ovh, zai and sambanova.

2. **Weight × gap assignment order.** Requests are assigned in the order that
   hurts most when it goes wrong: weight times the gap between the best and
   the second-best free model that can serve the request. A request whose best
   model is far ahead of its runner-up is assigned first; a request where two
   models tie can take either. (The two min-context requests that no capped
   provider can serve fall back to the best-rated free model at serve time —
   the openrouter 1475 — so quality is not lost.)

3. **No probing.** No call is made outside a request's window. Probing a
   provider to learn its refusal schedule costs that provider's budget and
   moves the real calls onto later, riskier numbers, so the plan is built from
   the brief only.

4. **Failover is best-rated, not first-listed.** When the planned provider is
   dead, the fallback is the best-rated free model that can serve the request
   among the providers still alive — not the next provider in a fixed list.

## Why 20 calls is not the target

A simulator that replays the sealed draw (budget ~ uniform over each
provider's range, one or two refusal numbers, one outage provider) over 2,000
random seeds puts this policy at a mean of ~22 upstream calls with score 99
on every seed. The 20-call cluster on the dev leaderboard is an allocation
fitted to the practice trial's own landmine map; it regresses to ~23–25 on
fresh draws. The honest target is therefore: **guarantee score 99, then
minimise mean upstream calls** — which is what this entry does.

## Verified (grade-local, `--driver process`)

| trial | score | quality | served | wire | failover | catalog | upstream_calls | replay |
|------:|------:|--------:|-------:|-----:|---------:|--------:|---------------:|:------:|
| 0 | 99 | 98 | 100 | 100 | 100 | 100 | 22 | byte-identical |
| 1 | 99 | 98 | 100 | 100 | 100 | 100 | 22 | byte-identical |
| 2 | 99 | 98 | 100 | 100 | 100 | 100 | 23 | byte-identical |

`node main.ts --list` prints the registered catalog and exits 0. The entry
reads no clock and takes no unseeded randomness in its decisions, so a live
pass and its replay are byte-identical.

## Files

- `main.ts` — the whole entry (one file, `node:http` + global `fetch` only).
- `.makefun/owner.json` — the wallet the entry is registered under.
- `package.json` — `{"type": "module"}` (keeps Node from warning on the `.ts` entrypoint).
