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

## 3. Classification rules (as implemented)

A mention found in model text, in strict mode (`meta/strictVocabulary.ts`, `meta/semantic.ts` `checkSemantics`), is classified in this order. Only entities the caller cannot discover are considered.

| # | Mention | Result |
|---|---|---|
| 1 | A directional claim about it (existing claim detector) | **reject** (`domain`), whatever the entity |
| 2 | A **metric** alias, or an inflection of one (plural, possessive, singular of a plural alias) | **reject**, directional or neutral. Never exempt |
| 3 | A **department** alias that the catalog did not declare generic (`pipeline`, `inventory`, `ledger`, `warehouse`, `ad spend`, `paid social`, ...) | **reject** (ambiguous) |
| 4 | A declared generic department word with a data-bearing noun within two words (`numbers`, `performance`, `rate`, `variance`, `capacity`, `spend`, ...) | **reject** (references its data) |
| 5 | A declared generic department word in a clause with change or comparison language (`slowed`, `grew`, `lagged`, `higher`, `worse`, `improved`, ...) | **reject** (a statement about how it is doing) |
| 6 | A declared generic department word with none of the above (`sales`, `budget`, `operations`, `marketing`, `customer experience`) | **accept** |

Preconditions for row 6, all required: the scope is strict; `generalVocabulary` is exactly `true` (set only by `validateStrictOutput`); the scope has a usable discoverable set; the catalog declares the word in
`DomainDef.generalTerms`. Absent any of them, row 6 does not exist and the word is rejected as in H2.2. Record ids, source labels, quantities, links and commands are rejected by the unchanged earlier checks regardless of the words around them.

## 4. Before and after

Strict scope; caller may discover only `leads` (prototype) or only the Support metrics (desk). H2.2 = baseline `afcd2eb`.

| Text | H2.2 | H2.3 |
|---|---|---|
| Review the sales strategy. | rejected | accepted |
| We should discuss the budget. | rejected | accepted |
| Operations may need additional coordination. | rejected | accepted |
| Marketing and sales should communicate. | rejected | accepted |
| Consider improving the customer experience. (CX hidden) | rejected | accepted |
| Sales conversion rate declined. | rejected | rejected |
| Customer acquisition cost increased. | rejected | rejected |
| Recognized revenue fell. / Backorder rate improved. | rejected | rejected |
| Review the sales numbers. / The budget variance is unclear. | rejected | rejected |
| The pipeline may help. / The ledger may help. | rejected | rejected |
| Operations slowed. / Sales declined. | rejected | rejected |
| Review **revenues** next. / Revenue's trend. / Response times may help. | **accepted** (gap) | rejected |
| The **deal** may help. / Each **lead** may help. / A **ticket** may help. (hidden metrics) | **accepted** (gap) | rejected |

## 5. Verification

* Full suite 2419 tests (2298 on main, +121), `tsc` clean, production build passes, goldens (`golden/combos.json`, `golden/impact.json`) unchanged, no edits to the legacy runtime, the legacy gate, provider contracts or the output schema.
* `meta/strictVocabulary.test.ts` (117 tests): generic words in all three lanes; restricted metrics and aliases in all three lanes; generic words beside restricted metrics; data nouns and change words; non-generic department words; inflections;
  case, punctuation, spacing, hyphens, full-width and zero-width characters; record ids, source labels, quantities, links and commands; discoverable metrics without data; the exact-`true` switch; catalog validation; byte-identical public rejections for
  every new rejection class; client fields cannot change the profile; nothing live imports the strict path; legacy gate unchanged.
* Existing H2.2 tests changed (cases about department words only): `meta/strictRuntime.test.ts` had pinned "a plain department word is rejected" (`Finance may be worth a look`, `The budget may help`); those cases now use data-bearing or
  non-generic words (`ledger`, `inventory`, `capacity`, `numbers`), and the sweep expects generic words accepted and everything else rejected. The H1/H1.1 tests (`modelScope`, `guardHardening`) are unchanged and pass: strict mentions without the new switch behave as before.
* Mutation checks: 18 killed, 1 equivalent. The equivalent one ("exemption also covers metrics") cannot change behaviour because `validateCatalog` forbids a metric alias from also being a department alias, so a metric word can never be in `generalTerms`.

## 6. Remaining limitations

* Generic words are accepted for hidden departments, so a model can name a hidden department in plain prose ("review the sales strategy"). That discloses only that the word was used, not data; the scoped prompt (H2.1) gives a caller no way to elicit it.
* The change/comparison and data-noun lists are finite. A statement about a hidden department phrased without any listed word and not caught by the claim detector would be accepted ("Sales look different now"). Add words, not exceptions, if one is found.
* "improving"/"improve" are deliberately not change words (imperative use), so "Sales are improving." relies on the claim detector.
* Strict mode now also rejects the bare singular of a hidden plural alias ("a deal", "each lead", "a ticket", "closing"). That is the fail-closed choice, and it will reject ordinary uses of those nouns by callers who cannot discover the metric.
* Homoglyph spellings and paraphrases of a hidden term remain unrecognized (unchanged). Timing is not equalized. Accept versus reject is still observable, as in H2.2.
* The generic lists are operator data (`generalTerms`); a catalog that declares a data-bearing word generic weakens its own protection. `validateCatalog` only guarantees that a declared term is one of the domain's own aliases.
* H2.1 and H2.2 remain inactive: nothing live imports them.
