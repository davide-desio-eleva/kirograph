![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/vf4e8ee9yye9lj6zb6o1.png)

# KiroGraph hits 1.0.0: what clearing a two-month backlog in a single day taught me about maintaining open source with Kiro

> This is the fourth part of my "Build in Public with Kiro" series. The first post, [Building KiroGraph](https://dev.to/aws-builders/building-kirograph-a-100-local-semantic-code-knowledge-graph-for-kiro-2ja4), was about the idea. The second, [from a personal side project to community-AI-driven tool](https://dev.to/aws-builders/kirograph-from-a-personal-side-project-to-community-ai-driven-tool-395e), was about the community showing up. The third, [KiroGraph-Sec](https://dev.to/aws-builders/kirograph-sec-from-aws-summit-milano-slides-through-kiro-specs-to-a-cybersecurity-feature-12ch), was about building the security module spec-first, after [Maurizio Argoneto (AWS Hero)](https://www.linkedin.com/in/argomauro/)'s AWS Summit Milano talk on VEX triage. This one is about a single week, the week KiroGraph went from a stalled backlog to **1.0.0** and kept going all the way to **1.3.0**, and what that week says about maintaining an open source project when Kiro is doing the heavy lifting alongside you.

A quick heads-up before you read on: this is one of those posts that isn't really technical, and it's one I care about more than most. It's less about the code and more about how the work of a developer is changing, what it means to contribute to open source today, and the community that makes all of it worth doing. If you're here for deep implementation details, the previous posts have more of that. This one is the human side of the story.

{% github davide-desio-eleva/kirograph %}

## 🏃 TL;DR

I had a backlog of open issues and stalled PRs I hadn't managed to close in about two months of nights-and-weekends maintenance. In about a week, working with Kiro, I cleared all of it and then some: real issues triaged and resolved, community PRs reviewed and merged, a new editor integration shipped, and release after release consolidated on npm, from a stalled backlog all the way to **KiroGraph 1.3.0**, with **1.0.0** landing right in the middle of that week. The way I work changed. I didn't suddenly get more hours, and a big share of that week was one relentless bug reporter who tested everything against real production code and kept coming back for more.

## 📉 The backlog problem every solo maintainer knows

If you maintain an open source project on the side, you know the shape of this. The issues pile up. Individually, none of them is especially hard; what adds up is the context switch each one demands: re-learn the corner of the codebase it touches, reproduce the bug, reason about the fix, verify it doesn't break anything, write it up, open the PR, resolve the merge conflicts that accumulated while you were away, release.

Any one of those is an evening. Do that math across a dozen issues and a few PRs and you understand why my backlog sat for two months. **It was the cost of re-entry, paid over and over, not a lack of will.**

And there's a second, more honest reason. We're engineers because we're curious, and curiosity is easily pulled toward the next shiny thing. Those two months were full of something else: DynamoDB Vector Search shipped, and I couldn't resist diving in, which turned into a recent run of technical articles like [Your database is an AI tool: semantic search with Amazon DynamoDB Vector Search](https://dev.to/aws-builders/your-database-is-an-ai-tool-semantic-search-with-amazon-dynamodb-vector-search-46ff) and [Deploying a real-time voice agent with AgentCore Runtime and Amplify Gen 2](https://dev.to/aws-builders/deploying-a-real-time-voice-agent-with-agentcore-runtime-and-amplify-gen-2-45bl). That's **the maintainer's dilemma** in a nutshell: your finite side-project time is split between the next big thing you want to explore and the maintenance work that is far less fun but keeps a project alive. The exploration usually wins, and the backlog pays for it.

> This is the tax that kills side projects, and it's exactly the tax Kiro removes.

The maintenance side no longer costs an evening per issue, so **I can chase the shiny thing *and* clear the backlog**, which is why a two-month gap could close, and keep closing, in about a week.

## 👻 The Kiro acceleration effect, revisited

In the last post I said KiroGraph's pace "wouldn't have been possible without Kiro." A week like this one is the concrete proof of that claim, so let me be specific about *how* it helped, because it's not "the AI wrote the code."

What matters most is that **Kiro holds the context so I don't have to re-load it.** When I opened a bug about vulnerabilities all showing up as `LOW`, I didn't spend an evening spelunking through the security layer to remember how OSV data flows into the graph. Kiro traced the path (OSV returns CVSS severity as a *vector string*, the adapter only parsed a plain number, so every score silently fell back to zero) and pointed me straight at the two functions that mattered. The re-entry cost went from an evening to minutes.

And because KiroGraph indexes itself, the loop compounds: Kiro queries its own graph to understand the code it's changing. Every fix lands *in the shape of the existing code*, not bolted on beside it.

What surprised me most was how easy it was to just *get my head back into the project*, even though I don't know this codebase any better than I did two months ago. We all know the truth here: step away from a project for two months and coming back is hard even when it's code you wrote and actively maintained. The mental model has evaporated, the reasons behind past decisions are fuzzy, and the first hour is spent re-convincing yourself of things you once knew cold. This time that friction was mostly gone because **every decision and iteration was something I could reason through *with* Kiro**, rather than something my own memory had to carry. Instead of reloading the whole context in my head before I could act, I could think out loud, ask why a piece worked the way it did, and let the answers rebuild the model as I went.

> Re-entry stopped being a wall I had to climb before doing any real work.

## 🗓️ Day one: what actually got done

I want to be honest and specific, not hand-wavy. Here's what actually happened on the day I finally caught up on the backlog, in plain terms:

- **WASM parser bundling and crash recovery**, contributed by someone in the community: mainstream language grammars now bundle into `dist/` so they resolve on global and pruned installs. Along the way we caught a genuinely sneaky one. C# ships as `tree-sitter-c_sharp.wasm` (underscore) but the resolver looked for `tree-sitter-csharp.wasm`, so C# silently extracted **zero symbols** on dist-only deploys. Reviewed, hardened (I restored the `under_investigation` reachability verdict the rewrite had dropped, and added a lockfile test fixture), and merged.
- **Windows hook syntax**: generated hooks used bash-only syntax (`2>/dev/null`, `|| true`) that `cmd.exe` doesn't understand, so every hook silently failed on Windows. Emitted OS-aware syntax and added a dedicated test suite. The reporter verified it end-to-end on real Windows.
- **Vulnerability severity**: the CVSS-vector bug above. This one hit KiroGraph-Sec, the security module I built spec-first in the third post: the whole point of that module is a risk score built from reachability, CVSS, and EPSS, and if CVSS silently reads as zero, the prioritization it exists to provide collapses. Now `kirograph vulns` shows real MEDIUM and HIGH severities instead of a wall of `LOW`, and the severity filter finally agrees with what's displayed.
- **TypeScript abstract classes**: `abstract class` parses as a *different* AST node than a plain class, which the extractor didn't handle, so abstract classes were dropped from the graph entirely. One-line root cause, verified end-to-end.
- **Large-file sync crash**: `sync` aborted the whole process on multi-MB compiled bundles because a file-size guard was never enforced *before* the parser saw the file. Now it's a cheap check in the scanner, plus sensible default excludes.
- **A new editor integration**: a community request. Shipped it following the existing installer patterns, documented across the site.
- **Two more issues closed by understanding, not code**: an IDE confusion that turned out to be a transient regression, and a Windows crash that was upstream and already degraded gracefully. Sometimes the right maintainer move is a clear, honest "this is resolved upstream, here's why", and Kiro helped me verify that quickly enough to answer with confidence.

Every fix was verified (build, typecheck, and the relevant test suites) before it went in. That's the part I care about most: speed that doesn't cost correctness.

## 🛠️ How the work actually flowed (AI-DLC in practice)

The list above is the *what*. The *how* is where the change really shows, so here's the loop I ran, issue after issue.

I'd start by reading the issue and thinking through it *with* Kiro: is this a real KiroGraph bug or something upstream? What's the likely root cause? Where does it live? From that conversation I'd write a short spec, the intent and the plan, before touching code, so the implementation had a target instead of me improvising in a file. Kiro turned the spec into the actual changes; I read the issue's reproduction, checked the fix against it, and asked for verification: build, typecheck, and the relevant test suite, plus a focused end-to-end check for that specific bug (does the abstract class now index? does the oversized file get skipped without crashing? does the CVSS vector resolve to the right score?). Then I opened the PR, and for the community-reported ones I asked the reporter to confirm on their own environment, the Windows user on real `cmd.exe`, the person with the TYPO3 monorepo. When a PR had drifted behind `main`, I resolved the conflicts, bumped the version, updated the changelog, merged, and moved to the next one.

Here's what changed versus doing all of that by hand. The old version of this loop was mostly *mechanical labor* wrapped around a few *decisions*: hours of reading code, reproducing, writing boilerplate, and untangling merge conflicts, with an interesting judgment call buried inside every so often. **Kiro inverts that ratio.** It absorbs the mechanical labor, the tracing, the boilerplate, the conflict resolution, so what's left for me is almost entirely the decisions: is this the right root cause, is the fix scoped correctly, does this deserve its own release, is the reporter's verification enough to merge. AI-DLC **moved me up the stack, from typing the solution to directing and reviewing it**, instead of turning me into a spectator.

> Review became the main job, and review is exactly where a maintainer's judgment is worth the most.

There's an obvious next step here, and I've thought about it more than once: wire `kiro-cli` straight into GitHub, triggered the moment an issue or PR opens, and let it draft the fix or run the first pass of review before I even look at it. Technically, that's close to trivial. I'm holding off on purpose, because **part of my job as a maintainer right now is being the human on the other end of an issue or a pull request**, the one who actually reads what a contributor wrote, in their own words, and answers as a person, not a bot with a diff attached. That contact is what turned reporters into contributors in the first place, and I'm not willing to trade it away just because I could. Kiro stays in the loop *with* me on the implementation and the review; the human side stays mine.

A newer, less comfortable challenge is the flip side of that. Some issues and PRs now arrive already shaped by something other than a person typing alone at the keyboard: bots and scanners file a few, and people who leaned on a tool like Kiro write others, and it usually shows, in the level of detail, the precision of the repro steps, a root cause already half-sketched out. Those reports are great fuel for Kiro, since a precise, well-structured issue gives it exactly the context it needs to move fast. But **they shift the effort onto me instead of removing it**: I can no longer assume a detailed, confident-sounding report means someone already reasoned through it correctly, so I spend extra care verifying that the suggested cause and fix are right, not just well written.

> The easier it gets to sound right, the more of my job becomes checking that it *is* right.

## 🔀 What this changes about being a maintainer

Here's the shift, and it's bigger than "I close issues faster."

**My job is now judgment, not typing.** For each issue the interesting work is this: is this really a KiroGraph bug or is it upstream? What's the root cause versus the symptom? Is this fix scoped correctly, or is it papering over something deeper? Should this be one release or several? Those are maintainer decisions, and they're the part that actually needs a human. Kiro handles the re-entry, the tracing, the boilerplate, the merge-conflict resolution across a stack of PRs and a version bump. I handle the calls.

**Responsiveness builds a community.** When a Windows user files a detailed bug in the morning and sees it fixed, verified, and merged the same day, something changes in how they relate to the project. They open more issues. They verify fixes. One of them becomes a contributor. That fast loop of report, root-cause, fix, verify, merge is what turns a repo into a project. Without Kiro compressing each of those steps, I couldn't sustain that loop as one person with a day job.

**Contributors don't need to be TypeScript experts.** This was the theme of the last post and it held again that week: one of the best PRs came from someone who understood the problem domain and let the agent handle the TypeScript idioms. My role was to review, harden the edges they couldn't have known about, and merge.

## 🏁 So, 1.0.0

I'll be honest: I'd been waiting for the "right moment" to cut a 1.0.0 for a very long time, and it never came. Nothing ever felt finished enough. And yet, look at what had already landed since the security module in the last post: AST-based pattern matching for precise vulnerability detection, an entire memory-synthesis system, two different embedding-compression engines, PDF support in the data module, conflict-aware memory with real relations between observations, a full wiki module, an installer overhaul, support for the newest IDE hooks, and a batch of code-health tooling backed by a real test suite.

Skim the changelog and it's a lot of module-sized work. All of it was stable, all of it had been tried by real users, and all of it had been sitting there for two months. The handful of open issues I described didn't come close to justifying holding a stable release hostage.

So why did I wait? Here's the uncomfortable realization. **IDEs like Kiro give us so much capability that it becomes easy to chase a notion of completeness and perfection that nobody actually asked for.** With AI, there is always one more step you *can* take: one more language, one more engine, one more edge case handled. The ceiling keeps moving because you can always reach a little higher, so "done" never arrives. I was measuring 1.0.0 against an imaginary finish line that only existed because the tooling made it feel reachable.

The community, meanwhile, is human. **It asks for something concrete that works, not perfection, and it's willing to help make it better.** The issues and the PRs are the proof: people didn't want me to polish forever, they wanted a solid release they could rely on, and several of them rolled up their sleeves to get it there.

> AI can push you toward endless refinement, but the people using your project pull you back toward shipping.

After all of that was merged and green, the project simply *felt* like a 1.0. Multi-client, 30+ languages, architecture and security analysis, a real test suite, a documentation site, and, as of that day, a cleared backlog. So I consolidated the day's releases into a single **1.0.0**, tagged it, and published to npm.

> 1.0.0 means "I trust this, and I can keep it healthy," not "it's finished."

And the honest truth is that the second half of that sentence, *I can keep it healthy*, turned out to be true almost immediately. **1.0.0 was the first release of that week, not the last.**

## 📈 The rest of the week

A couple of smaller releases came next: sturdier guardrails on memory writes, and a way to navigate the wiki module's link graph, both ideas borrowed from a knowledge-graph tool called [IWE](https://github.com/iwe-org/iwe). Then, later that same week, over a single afternoon and evening, **KiroGraph moved through half a dozen more releases back to back**, the same loop from earlier in this post running continuously instead of once.

Most of that stretch traces back to one person and one issue, the very CVSS bug from the list above, which turned out to have several more layers underneath it. **One reporter found every one of them**, not by filing a vague bug report, but by running KiroGraph against a real, multi-module Spring Boot project and diffing its output against a well-known commercial scanner, package by package, every single time.

First came vulnerabilities that simply weren't there. On that real project, `kirograph vulns` reported nothing at all, despite known critical CVEs, because **dependencies managed by a build-tool parent configuration never got a resolved version** and were silently dropped before any lookup ran. Fixing it meant teaching KiroGraph to read the full dependency tree the same way it already read a lockfile, and once I started looking, the identical gap turned up across most of the other ecosystems it supports too. That release also picked up a small debugging feature born straight out of the same investigation: a plain-English explanation of *why* a verdict came back the way it did, because I kept needing to ask that question myself and there was no way to find out short of reading the source.

The same morning, a second, unrelated contributor filed something scarier: **the indexer hanging entirely on a large real-world repository**. They didn't just report it, they attached a reproduction script *and* a proposed fix: every parsed file leaked native WASM memory that only an explicit cleanup call could release, and nothing in the extractor ever made that call. A small synthetic test proved it beyond doubt, memory climbing forever before the fix, flat after it.

In between, one release wasn't bug-driven at all: **opt-in schema validation** for structured fields in memory and wiki pages, an idea borrowed from a project called [tmd](https://github.com/alfonsograziano/tmd) (Typed Markdown), drop a schema file in a folder and KiroGraph validates against it, no index to maintain.

Then the same reporter came back twice more. Once for **a license checker that marked almost everything as `unknown`**, first because it was reading the wrong file's license entirely, then, after that fix, because most real dependency manifests inherit their license from a parent configuration a couple of layers up that nothing had ever bothered to walk, verified directly against the real packages in the report before I wrote a line of the fix. And once with an honest, uncomfortable question I didn't have a good answer to: *"I ran your security scanner against my own projects and got nothing back. How do I know that means my code is clean, and not that the tool is broken?"* The only honest answer was to test against code with known vulnerabilities, so I pointed it at a deliberately vulnerable practice application and watched it miss the two most famous bugs in the whole thing, both hiding behind a naming heuristic that was never the right signal to begin with. Fixed, verified against the real thing, both catches confirmed before I called it done.

Alongside all of that, I shipped **the first module that leans on a third-party service instead of a purely local heuristic**: [jev](https://docs.typesafe.ai) (TypeSafe's System One), a small, fast typed-classification model, wired into three narrow decisions KiroGraph used to either hand off to the calling agent or answer with a fragile keyword match. It's clearly marked experimental, opt-in end to end, and every path it touches falls back to its old behavior the moment there's no key configured. I don't yet know if it earns a permanent place in the project. That's exactly why it shipped behind a flag instead of as the new default.

By the end of that week, KiroGraph had gone from a stalled two-month backlog to **1.3.0**, and I hadn't written a single line of it alone. What sticks with me isn't the release count. It's that **one reporter kept coming back, round after round, holding KiroGraph to the same bar they'd hold a paid tool to**, and I could answer each round the same day instead of "next sprint." That's the loop from earlier in this post, not a one-off, just running for a week straight instead of a single afternoon.

A solo maintainer keeping a 30+ language, multi-client code-analysis tool with security scanning and an interactive dashboard alive, responsive, and shipping at that pace for a whole week? That shouldn't be sustainable. **It is, because the tooling makes it sustainable.**

**Two months of backlog, cleared in a week, from a stalled repo to 1.3.0:** a story about what maintaining open source looks like when re-entry is nearly free, not about working harder.

## ⭐ Thank you to the stargazers

Here's the part that really surprised me. For those same two months I gave this project zero attention: no releases, no posts, no presence. And **KiroGraph still went from around 100 stars to about 150**, growing by roughly 50% on its own.

That says a lot. It means the project stood on its own while I was away: people found it, tried it, and told others, without any push from me. Every one of those stars is someone who thought this was worth their attention, and a good number of them turned into the issue reports and PRs that made that whole week possible.

So, sincerely: thank you. The stargazers, the people who opened issues, the contributors who sent PRs in a stack that isn't their daily driver. You are the reason a solo side project can reach 1.0.0 and stay healthy. That support is what makes the difference.

## 🎯 Try it

```shell
npm install -g kirograph
cd your-project
kirograph install
```

The installer walks you through everything. Start with `cosine` if you're not sure which engine to pick. You can switch later.

The repo is public and PRs are welcome. If you try it, break it, or have thoughts on where it should go next, open an issue. And now you know it might get fixed the same day.

{% github davide-desio-eleva/kirograph %}

## 🙋 Who am I
I'm [D. De Sio](https://www.linkedin.com/in/desiodavide) and I work as a Head of Software Engineering in [Eleva](https://eleva.it/).
As of September 2026, I'm an [AWS Certified Solution Architect Professional](https://www.credly.com/badges/9929fdf2-7a3d-4013-9de6-57c80e4920b9/public_url) and [AWS Certified DevOps Engineer Professional](https://www.credly.com/badges/8c5a1487-191b-429e-8c2d-7cee43bf316b/public_url), but also a [User Group Leader (in Pavia)](https://www.linkedin.com/company/aws-user-group-pavia/), an **AWS Community Builder** and, last but not least, a #serverless enthusiast.

![Image description](https://dev-to-uploads.s3.us-east-2.amazonaws.com/uploads/articles/sbx0o4rqqz3wkn84unx2.png)

