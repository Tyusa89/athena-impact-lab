# Strict vocabulary refinement (Phase H2.3)

## 1. Root-cause analysis (written before any code changed; baseline `afcd2eb`)

**Why generic words such as `sales`, `budget`, `operations`, `marketing` are rejected under strict mentions**

1. `mentionedEntities()` (`meta/semantic.ts`) matches every alias of every metric AND every alias of every *department* in the catalog (`domains[].aliases`, e.g. Sales: `sales`, `sales team`, `pipeline`; Finance:
   `budget`, `ledger`; Operations: `operations`, `inventory`). It returns them as entities of kind `metric` or `dept`.
2. The strict mention loop in `checkSemantics` (`semantic.ts`, "for (const e of mentionedEntities ...)") treats a `dept` entity exactly like a metric: it is `hidden` when no metric of that department is
   discoverable (`departments` is derived from the discoverable metrics, `semantic.ts` `semanticScope`/`checkSemantics`), and a hidden entity is rejected under `strictMentions`. The word carries no data, but the
   rule has no notion of "plain department vocabulary".
3. `validateStrictOutput` (`meta/strictValidation.ts`) always runs `strictMentions: true`, so every strict caller inherits this.

Measured before the change (strict scope, caller may discover only `leads`; support caller may not discover `csat`):

| Text | Result | Why |
|---|---|---|
| Review the sales strategy. | rejected | `sales` = dept Sales alias |
| We should discuss the budget. | rejected | `budget` = dept Finance alias |
| Operations may need additional coordination. | rejected | `operations` = dept Operations alias |
| Marketing and sales should communicate. | rejected | two dept aliases |
| Consider improving the customer experience. | rejected | `customer experience` = dept CustomerExperience alias |
| Sales conversion rate declined. / Customer acquisition cost increased. / Recognized revenue fell. | rejected | metric aliases (correct) |

**Ambiguity inventory (what could be mistaken for what)**

* Exact alias sharing between a metric and a department, or two metrics, is impossible: `validateCatalog` (`core/catalog.ts`, alias-ownership check) rejects it. No shared alias exists in either bundled catalog.
* Phrase-level overlap exists: `marketing qualified leads` (metric `mql_rate`) contains the department word `marketing`; `customer satisfaction` (metric `csat`) contains none, but `sales conversion rate` is a metric phrase
  beginning with a department word. Longest-phrase-first matching assigns the metric, so those stay metric mentions.
* Some department aliases are not department names but things that carry data: `pipeline`, `sales pipeline`, `inventory`, `ledger`, `ad spend`, `paid social`, `warehouse`, `suppliers`. These must not be treated as plain vocabulary.
* Some metric aliases are ordinary nouns: `deals`, `conversion`, `revenue`, `fulfillment`, `leads`, `tickets`. They are restricted-metric mentions by design and stay rejected when the metric is hidden.
* **False negatives found while auditing (the opposite problem):** matching is whole-word (`\balias\b`) on text where apostrophes are removed, so inflections of a restricted metric are NOT recognized:
  `revenues`, `lead volumes`, `response times`, `customer satisfactions`, `revenue's` (possessive becomes `revenues`), and singulars of plural aliases (`deal`, `ticket`, `closed deal`). A hidden metric named that way
  currently passes strict validation. This is fixed in the same change, in the strict direction.

## 2. Design

* **Operator-declared generic vocabulary.** `DomainDef.generalTerms?` (new, optional, validated) lists which of a department's aliases are plain department vocabulary. Absent means none: a catalog that does not opt in
  behaves exactly as before. Declared for the bundled catalogs; data-bearing aliases (`pipeline`, `inventory`, `ledger`, `ad spend`, ...) are deliberately not declared.
* **Opt-in per scope, fail-open only on exactly `true`.** `SemanticScopeOptions.generalVocabulary` is honoured only when exactly `true`; anything else (including `"true"`) leaves the strict rule as it was. Only the strict
  runtime path (`validateStrictOutput`) sets it. `strictMentions` itself is unchanged and still fails closed.
* **Classification of a mention of a hidden entity in strict mode**
  1. *Metric* (alias or inflection of an alias): rejected, directional or neutral. Never exempt.
  2. *Department* word that is a declared generic term, with **no** data-bearing noun within two words (`performance`, `numbers`, `rate`, `capacity`, `spend`, `variance`, ...): allowed.
  3. *Department* word that is not a declared generic term, or a generic term next to a data-bearing noun: rejected (ambiguous: fail closed).
  4. A directional claim about a hidden department stays rejected by the existing claim detector, whatever its wording.
* **Strict matcher tolerates inflections** (plural, possessive-as-plural, singular of a plural alias) and is used only in strict mode, so legacy matching and the goldens are untouched.
* Unchanged: one public rejection, closed diagnostic categories, no client profile switch, no record-id exemption, scoped prompt without user text or ids, legacy runtime and goldens, inactive H2.1/H2.2.
