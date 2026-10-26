# Model-output scope and text safety (Phase H1)

Applies to the existing model path (`meta/runtime.ts` `runAnalysis` -> `meta/analysis.ts` `validateOutput`). No new model call, provider, secret or UI.

## 1. Metric-level scope (`meta/semantic.ts`)
`semanticScope(authorized, facts, catalog, { discoverable?, strictMentions? })` now builds a **set of discoverable metric keys**:
metrics with verified facts, plus metrics the access-policy layer explicitly granted (`EvidenceScope.discoverableMetrics`, F1). It is never inferred from the
department of another metric or of the records present. Departments the role may name are derived from that set, not the other way round.

* `runAnalysis` passes the policy's grant (`Prepared.discoverableMetrics`) through `validateAuthorizedOutput` into the scope.
* Without a grant the generic scope discovers only metrics that have verified data. A hand-built scope with no `discoverable` set (or a non-`Set`) discovers
  nothing and rejects every mention: fail closed, never allow-all.
* A directional claim about a hidden metric, **in the role's own department or another**, gets the same code (`domain`) and the same fixed wording. `unavailable`
  is reserved for a metric the policy lets the role discover that has no data, which the role is entitled to know.
* Mentions: a mention of a hidden metric inside a department the role does access is always rejected. A neutral mention of a metric or department the role has no
  access to at all stays allowed in the legacy mode (pinned by existing tests: gaps and hand-offs), and is rejected with `strictMentions: true` (for new callers).
* Messages name nothing, echo no model text, and do not distinguish "hidden" from "hidden in your own department".

The prototype facades (`semanticGuards.ts`, `contract.ts`) default the grant to the demo policy's own rule (`prototypeDiscoverable`: the metrics of the departments the
role holds) so existing callers and goldens are unchanged. The generic modules have no such default.

## 2. Links, Markdown, code and commands (`meta/textSafety.ts`)
Every lane of model text is scanned after NFKC and invisible-character removal. A hit rejects the whole output with one fixed sentence naming only the location
(`Unsafe content: <where> contains a link, markup, code or a command; model text must be plain prose`). Categories: link (schemes, `www`, bare domains, obfuscated dots, Markdown
links/images/references), email, markup (tags, entities), code (backticks, fences, braces, `$VAR`, function calls, declarations), command (shell, package managers, git, SQL, paths).
Output schema literals (`verified:false`, `requires_human_approval:true`, `.strict()`) are unchanged: a model cannot add an `executable` field.

## 3. Test changes to existing files (no assertion weakened)
* `catalogParameterization.test.ts`: one assertion built a scope by overriding `departments`; it now requests the same "unavailable" outcome through the explicit grant.
* `engineBoundary.test.ts`: the new generic module `textSafety` is added to the checked set.

## 4. Remaining limitations
* **Outcome oracle.** Accept versus reject is still observable. If a caller can get a term into the model's text (for example through the question) they can learn that a
  recognised-but-hidden term is rejected while an unrecognised word is not. The messages reveal nothing and the model is told to use only VERIFIED_FACTS; closing this
  fully needs the prompt-side work planned for H2 (opaque aliases and a question that cannot name hidden metrics).
* Neutral mentions of metrics in departments the role has no access to remain allowed in the legacy mode.
* Both guards are bounded heuristics (alias matching; pattern matching of unsafe text). Paraphrases, look-alike characters beyond NFKC, and unusual encodings can evade them.
  React escaping remains the rendering defence.
* Prompt-side items from the Phase H audit (opaque record aliases, impact-aware prompt, spend limits, `/impact` wiring) are NOT part of H1.
