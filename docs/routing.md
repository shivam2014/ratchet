# Routing: from regex to a calibrated cascade

**Status:** research and design note, 2026-10-20
**Question:** How should Ratchet decide which contract profile and skills a prompt needs, without a brittle rule maze or an unaccountable model?

## Short answer

Regex and keyword matching are a good **fast path** for explicit signals. They are a bad **sole router**.

Natural language has an open-ended long tail: synonyms, morphology, typos, negation, word order, context, multi-intent, code-switching, jargon, and deliberately vague prompts. A finite rule set cannot cover it. Adding rules makes the set larger, not complete, and every new rule can create a false positive somewhere else.

But replacing the rule maze with one large language model is not the answer either. An unconstrained LLM router adds nondeterminism, latency, cost, prompt-injection surface, label bias, and its own out-of-scope errors. It is another model to trust, in the one place where trust is the product.

The reliable shape is a **cascade with abstention and evaluation**:

```text
explicit signal
  → normalize + lexical candidates
  → semantic candidates (hybrid with lexical)
  → constrained tie-break only when uncertain
  → abstain / safe default
  → record the decision
  → evaluate against labeled prompts
```

Treat routing as **low-regret retrieval**, not perfect classification. A wrong route should cost tokens, not trust. The contract, guard, stop gate, and CI remain the trust boundary.

## Why regex fails

A rule set is a finite approximation of an unbounded input space. The failure modes are predictable:

| Failure | Example | What a regex does |
|---|---|---|
| Synonymy | "make a game" vs "build a browser toy" | Misses the second unless every synonym is listed |
| Morphology | "test", "testing", "tested" | Needs stems or variants for every term |
| Typos | "flapppy bird", "run the linter", "refacter" | Exact tokens miss; fuzzy matching helps but adds false positives |
| Word order | "fix the test runner" vs "test the fix" | Bag-of-words rules confuse them |
| Negation | "don't add tests yet", "not a refactor" | A keyword hit can invert the intent |
| Polysemy | "game" (video game vs game theory), "model" (ML vs data) | One token, two meanings |
| Context | "fix that", "make it pop", "same as before" | No keywords to match; the thread has the context |
| Multi-intent | "fix the bug, add a test, update the docs" | One label cannot represent the set |
| Code-switching | mixed English/Hindi, mixed English/Chinese | English rules miss half the prompt |
| Open set | a new skill is installed | Every new skill needs new rules |
| Rule interaction | order, overlap, exceptions | Maintenance grows faster than the skill set |
| False confidence | a keyword hit on a hard negative | Routes to a specialized gate that does not apply |

The "millions of undefined edge cases" intuition is correct. The number of ways to express a task is unbounded; a rule set is a finite sample. Spelling is just the most visible case. The deeper problem is that intent is compositional and context-dependent.

**Where regex is excellent:** explicit signals. `/tdd`, `@skill`, `--skill tdd`, an issue label, a task template, a file path, a repository name, a language or framework marker, an exact jargon term such as "TLA+" or "Bend". These are high-precision and cheap. They belong at **Stage 0**, not in the whole router.

## What the research says

### 1. Out-of-scope detection is hard even for trained models

The closest measurable analogue to skill routing is intent classification with out-of-scope (OOS) detection. The findings are sobering:

- **CLINC150** (Larson et al., 2019): classifiers perform well on in-scope intents but struggle to identify out-of-scope queries. Production task-oriented systems cannot assume every input belongs to a supported intent.
- **In-domain OOS** (Zhang et al., 2021): pretrained Transformer classifiers are vulnerable to examples that are in-domain but out-of-scope; overlapping keywords cause misclassification; confidence scores alone are not enough.
- **Hard negatives** (Li et al., 2024): classifiers struggle more with hard-negative OOS utterances (inputs that share features with in-scope data but are not in scope) than with general OOS. Training with hard negatives improves robustness.
- **Hierarchy and thresholds** (Liu et al., 2021): joint domain/intent modeling with threshold-based post-processing improves OOS recall and F1.

Implication: every router — regex, embedding, or LLM — will meet hard negatives. The design goal is not perfect accuracy. It is calibrated confidence, an abstain path, and a labeled set that includes the hard cases.

### 2. Semantic routing is a production pattern, with calibration

The Aurelio **Semantic Router** is the closest published blueprint:

- It compares the meaning of a request against routes in vector space, or asks a small decision model in one fast call.
- Every decision has a confidence that can be calibrated into a probability.
- `fit()` calibrates confidence on labeled queries; a confidence threshold lets the router return `None` when no route clears the bar.
- It supports **hybrid search** with a sparse encoder to weigh exact keywords alongside meaning.
- **`Chain`** answers easy queries with a fast router and falls through to a slower one only when unsure; **`Merge`** averages routers.

That is exactly the cascade shape: fast local route, calibrated threshold, explicit "none", hybrid lexical + semantic, and escalation only when uncertain.

The caveat is also instructive: the calibration needs labeled examples from your distribution. A generic threshold is a guess. If the query mix changes, the threshold drifts.

### 3. LLM routing is a calibration and evaluation problem

- **RouteLLM** (Ong et al., 2024) trains routers (matrix factorization, BERT classifier, LLM classifier) to choose between a strong and a weak model. It reports up to 85% cost reduction at 95% of GPT-4 performance on MT Bench, but the threshold is calibrated on representative queries, and the authors recommend calibrating on data that resembles production.
- **RouterBench** (Hu et al., 2024) provides 405k inference outcomes and a standard evaluation framework; it shows that routers have different strengths and limitations. There is no free lunch.
- Routing adds an intermediate layer between the user and the model. That layer sees prompts and routing metadata; metadata itself can leak sensitive topics (see *Sensitive-Topic Leakage Through LLM Routing Metadata*, arXiv:2610.09981). Local routing and data minimization matter.

Implication: if Ratchet uses an LLM tie-break, constrain it to a closed set of registry skills, use structured output, set temperature 0, cap tokens and time, log the decision, and treat it as advisory. Never let it invent a skill or certify work.

### 4. The Agent Skills ecosystem already uses model-based selection

This is the part that usually surprises people:

- Anthropic's Agent Skills implementation loads the `name` and `description` of every installed skill into the system prompt at startup. If the model thinks a skill is relevant, it reads the full `SKILL.md` (progressive disclosure).
- The Claude Code docs say the description helps Claude decide when to load the skill automatically. Users can invoke `/skill-name` directly, and `disable-model-invocation: true` prevents automatic invocation while leaving the skill user-invocable.
- The Agent Skills spec requires a non-empty description and says it should describe what the skill does and when to use it, include specific keywords, and keep the metadata at roughly 100 tokens and the body under 5,000 tokens.

In other words, the ecosystem has already accepted **model judgment** for automatic skill selection, because keyword matching does not scale. Ratchet should not pretend regex is more reliable than the mechanism the standard itself uses. It should:

1. narrow the menu with a shortlist,
2. let the model read and choose,
3. record the decision,
4. enforce the observable outcome with checks.

### 5. Skills are an open, composable set, not a fixed label set

Intent classification assumes a finite set of labels. Skills do not behave that way:

- They grow as the user installs more.
- They compose: a feature may need TDD + frontend design + verification; a bug fix may need diagnosis + regression testing.
- They have prerequisites and conflicts.
- A new skill should be a description and examples, not a retraining run.

A multi-label retrieval model with composition rules fits better than a single-label classifier or a regex maze. It also gives a natural abstain path: "none of these are a confident match" is a valid answer.

## Comparison

| Approach | Strengths | Fails on | Latency | Reproducibility |
|---|---|---|---|---|
| Regex / keywords | Precise on known phrases; zero dependencies; explainable | Synonyms, typos, negation, word order, context, multi-intent, open set | ms | Deterministic |
| BM25 / lexical | Better recall than regex; explainable; no model | Paraphrase, vocabulary mismatch, many typos | ms | Deterministic |
| Embeddings | Paraphrase, typos, multilingual; semantic similarity | Calibration, hard negatives, negation, domain shift, model/index drift | 10–100 ms local | Replayable if pinned |
| LLM tie-break | Ambiguity, composition, explanations | Nondeterminism, cost, latency, injection, label bias, invented skills | 0.5–5 s | Low |
| Human | Judgment, context, irreversible decisions | Does not scale | seconds–minutes | Not applicable |

The table is the argument for a cascade, not a single winner. Each stage covers the previous stage's weak spot, and the last stage is allowed to say "I don't know."

## The router design

### Stage 0: explicit intent

Sources: `/skill`, `@skill`, `--skill`, issue labels, task templates, repository config, file paths, harness mode, and a profile named in the prompt.

If an explicit signal is present, use it. Do not guess. Record `decision: "explicit"`. If two explicit signals conflict, prefer the most specific (a file path or a slash command over a keyword) and record the conflict.

This stage is where regex belongs. It is high-precision and cheap.

### Stage 1: normalize and generate lexical candidates

- Unicode NFKC, case folding, punctuation normalization, whitespace collapse.
- Preserve code identifiers, paths, and file extensions; do not autocorrect inside backticks.
- Fuzzy matching (trigram or bounded Levenshtein) for typos in natural-language tokens.
- BM25 over the skill name, description, keywords, and examples. Take the top 10.
- Use the lexical score as a **candidate generator**, not a final decision.

Lexical matching is surprisingly strong for exact jargon, library names, and file paths. It is weak on paraphrase. That is why it does not decide alone.

### Stage 2: semantic candidates

- Use a local embedding model with a pinned revision. Embed skill descriptions and examples offline; cache the vectors.
- Score the prompt against the skill index.
- Combine with BM25: `score = α · normalized_bm25 + (1 − α) · cosine`. Tune α on the evaluation set.
- Keep the top 3–5 candidates. Compute the margin between the top candidate and the runner-up.
- Apply a calibrated threshold. If the top score is below it, or the margin is too small, abstain.
- For multi-intent prompts, allow a compatible set of skills rather than forcing one.

A local model keeps the prompt on the machine and keeps latency predictable. A remote embedding API is possible, but it is a privacy and availability decision, not a default.

### Stage 3: constrained tie-break (optional)

Use this only when Stage 2 is uncertain, or when several candidates are close and the composition matters.

Input: the prompt, the candidate names and descriptions, and the registry constraints. Do not send full skill bodies.

Output: structured JSON from a closed set:

```json
{
  "skills": ["tdd", "frontend-design"],
  "profile": "feature",
  "none": false,
  "reason": "The prompt asks for a new browser game with a visible UI."
}
```

Constraints:

- temperature 0, small max tokens, hard timeout;
- validate every skill and profile against the registry;
- on error, timeout, or invalid output, fall back to abstain;
- log model, version, prompt hash, registry hash, and output;
- cap cost per route; cache by `prompt_hash + registry_hash`;
- never let the model invent a skill or change the contract directly.

This stage is a tie-breaker, not the router. If it is unavailable, the cascade still works.

### Stage 4: abstain or use the safe default

If no candidate clears the threshold, or the margin is ambiguous:

- choose the `general` profile (tests + lint + plan for multi-file work);
- include a short list of general skills (`tdd`, `verification` where available);
- ask **one** clarifying question only if the answer changes the contract (scope, irreversible action, or profile);
- otherwise proceed. A missing specialized skill is recoverable; a wrong specialized gate is worse.

The model may request a skill or profile. Ratchet records the request and requires an explicit contract update. This is the escape hatch for the long tail.

### Stage 5: composition and gates

Each skill can declare routing and enforcement metadata:

```yaml
routing:
  keywords: [test, tdd, red-green, regression]
  examples:
    - "write the test first, then the implementation"
    - "add a regression test for this bug"
  negative_examples:
    - "fix the test runner config"
    - "the tests are slow, profile them"
  requires: []
  conflicts: [prototype-only]
  profile: feature
```

The router selects a compatible set, ordered by phase when needed (plan → test → implement → verify). Each skill's observable requirement becomes a gate or check where possible:

| Skill claim | Enforceable artifact |
|---|---|
| "Use TDD" | A test file changed before the implementation; tests pass |
| "Verify in the browser" | A browser check or screenshot artifact |
| "Prove the invariant" | `LAWS` / proof check passes |
| "Write a plan first" | Plan artifact exists before source writes |
| "Keep the API stable" | Type/API diff check |

A skill with no enforceable artifact is advisory. Mark it as such. Do not let prose masquerade as a gate.

### Stage 6: outcome feedback

Record `route.json`:

```json
{
  "prompt_sha256": "…",
  "profile": "feature",
  "decision": "semantic",
  "skills": [
    {"name": "tdd", "score": 0.82},
    {"name": "frontend-design", "score": 0.74}
  ],
  "abstained": false,
  "router": "ratchet-route/1",
  "embedding_model": "…@revision",
  "index_hash": "…",
  "threshold": 0.62,
  "policy_hash": "…"
}
```

After the stop gate, record:

- did the checks pass on the first attempt?
- did the model load a different skill than the shortlist?
- did it request a profile change?
- did the user override the route?
- did a missed skill cause a failure?

Those are labels for the next evaluation round. `ratchet route --explain` prints the score breakdown and the decision path.

## Determinism, precisely

"Deterministic" does not mean "regex." It means **replayable**: the same inputs and the same pinned router version produce the same decision, and the decision can be audited after the fact.

To make the cascade replayable:

- pin the embedding model and revision, the tokenizer, the normalization rules, the index hash, the thresholds, the skill versions, and the policy hash;
- cache embeddings; prefer a local model; do not call the network at route time;
- store the candidate scores and the decision in `route.json`;
- keep the lexical and semantic stages pure functions of the pinned inputs;
- make the LLM tie-break optional. It is the only stochastic component. In strict mode, disable it and accept abstention;
- version the route table and the evaluation set alongside the code.

This gives the auditability people want from "deterministic" without pretending a finite rule set can cover natural language.

## Evaluation plan

Routing quality is an empirical question. Build the measurement before tuning.

### Labeled set

Start with 50 real prompts from this user's sessions and public examples; grow to 200+. Label:

- expected profile;
- expected skills (a set, not one label);
- acceptable alternatives;
- `none` / out-of-scope;
- ambiguity (should the router ask?);
- required gates.

Stratify by task type: feature, bug fix, refactor, test-only, docs, infra, security, domain-specific, vague, typo-heavy, multi-intent, code-switched.

### Metrics

- precision@1 for the profile;
- recall@3 and exact-set match for skills;
- OOS / abstain rate;
- wrong-specialization rate (a specialized profile chosen when `general` was correct);
- route latency and cost;
- override rate (user or model changes the route);
- stop-gate first-pass rate;
- escaped defects in CI for gated paths.

### Baselines

1. Regex-only (the current intuition).
2. BM25-only.
3. Embeddings-only.
4. Hybrid BM25 + embeddings.
5. Hybrid + constrained LLM tie-break.

Report per-skill and overall results, with confidence intervals. Do not tune on the test set.

### Hard negatives

The cases that matter most:

- "fix the lint config" — tooling, not a code bug;
- "write a test for the test runner" — test infrastructure, not TDD;
- "refactor the docs" — docs, not a behavior-preserving code refactor;
- "make it pop" — UI, but no concrete feature;
- "same as before" — context-dependent, not a new task;
- "don't add tests yet" — explicit negation;
- "fix the flaky test" — diagnosis, not feature work.

A router that handles the easy positives but fails these is not ready.

### Acceptance

The hybrid must beat regex on recall without increasing the wrong-specialization rate. If it does not, keep regex for explicit signals and default to `general` for the rest. That is a valid outcome: the safe default is better than a confident wrong gate.

Run the evaluation on every skill, registry, threshold, or model change. Version the eval set with the code.

## What I would build first

1. **Registry parser.** Scan installed skill directories, read `SKILL.md` frontmatter, parse optional `routing` metadata, hash the registry.
2. **`ratchet route --prompt … --json`.** Stages 0–2 plus abstain. No LLM, no network. Write `route.json`.
3. **Prompt brief.** Contract + profile + skill shortlist + "read these before coding; if none apply, say so."
4. **Stop gate.** The route is a hint; the checks decide. This is the part that makes the system trustworthy even when routing is wrong.
5. **Evaluation harness.** 50 labeled prompts; regex vs BM25 vs hybrid; record precision, recall, abstain, wrong-specialization.
6. **Semantic stage behind a flag.** Add embeddings, measure, and only keep them if they beat the lexical baseline on the local set.
7. **LLM tie-break last.** Only if the evaluation shows a gap that a constrained model call closes, and only with logging, caching, and a hard fallback.

This is deliberately incremental: no ML dependency for v1, no model in the pass/fail path, and a measurable upgrade path.

## Sources

Primary sources fetched on 2026-10-20. The web search backend returned no results, so the sources below were fetched directly; the papers were found through the arXiv API.

- Anthropic, *Equipping agents for the real world with Agent Skills* (Oct 16, 2025; updated Dec 18, 2025). https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Agent Skills specification. https://agentskills.io/specification
- Claude Code, *Extend Claude with skills*. https://code.claude.com/docs/en/skills
- Claude Code, *Hooks reference* (UserPromptSubmit, Stop). https://code.claude.com/docs/en/hooks
- Codex, *Hooks* (UserPromptSubmit, Stop, additionalContext). https://developers.openai.com/codex/hooks
- Aurelio Labs, *Semantic Router* (calibration, `None`, hybrid search, `Chain`). https://github.com/aurelio-labs/semantic-router
- Ong et al., *RouteLLM: Learning to Route LLMs with Preference Data* (2024). https://arxiv.org/abs/2406.18665
- Hu et al., *RouterBench: A Benchmark for Multi-LLM Routing System* (2024). https://arxiv.org/abs/2403.12031
- Larson et al., *An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction* (EMNLP-IJCNLP 2019). https://arxiv.org/abs/1909.02027
- Zhang et al., *Are Pretrained Transformers Robust in Intent Classification? A Missing Ingredient in Evaluation of Out-of-Scope Intent Detection* (2021). https://arxiv.org/abs/2106.04564
- Li et al., *Generating Hard-Negative Out-of-Scope Data with ChatGPT for Intent Classification* (LREC-COLING 2024). https://arxiv.org/abs/2403.05640
- Liu et al., *Out-of-Scope Domain and Intent Classification through Hierarchical Joint Modeling* (IWSDS 2021). https://arxiv.org/abs/2104.14781
- *Sensitive-Topic Leakage Through LLM Routing Metadata: Measurement and Mitigation* (2026). https://arxiv.org/abs/2610.09981
- *Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey* (2026). https://arxiv.org/abs/2603.04445

## Decision

- Adopt the cascade. Reject regex-only and LLM-only routing.
- The router emits two things: a **profile** (closed set, enforceable, high confidence) and a **skill shortlist** (open set, advisory).
- Start with explicit signals, BM25, and abstention. Add embeddings behind a flag and keep them only if the local evaluation improves.
- Add an LLM tie-break only as a constrained, logged, optional last step.
- Record every decision; store a prompt hash, not the prompt, by default.
- Revisit after 200 labeled prompts, not after an argument.
