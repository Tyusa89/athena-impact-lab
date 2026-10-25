# Interactive Business Impact Map (Phase G)

Route: `/impact`. A user picks a dataset, a scenario and a **simulated** role, asks a business question, runs the deterministic engine and investigates the result:
a relationship map plus five separate sections (verified changes, observed relationships, hypotheses, missing evidence, proposed actions). No AI model is involved.

Screenshots (synthetic data): `docs/screenshots/impact-business-operations.png`, `docs/screenshots/impact-customer-support.png`.

## Principle: the engine owns the intelligence, the application presents it

```
browser                         server                                          engine (unchanged)
ImpactWorkbench  --ids+question--> runWorkbench (allowlists)  -->  runImpactAnalysis -> authorizeEvidence -> computeAuthorizedFacts -> buildImpactMap
   (presents)    <--ImpactView---- buildImpactView (projection) <--  ImpactMap + AuthorizedEvidence
```

| Piece | File | Role |
| --- | --- | --- |
| Interface | `src/components/impact/*`, `src/routes/impact.tsx` | Draws what it is given. No calculation, relationship logic, authorization or validation. |
| Presentation model | `src/lib/athena/workbench/view.ts` | Pure projection of `ImpactMap` + authorized evidence into a whitelisted, serializable `ImpactView`. Every field copied explicitly. |
| Server composition | `src/lib/athena/workbench/workbench.server.ts` | Registry of replaceable synthetic datasets; allowlists; calls `runImpactAnalysis`. Imports no model provider. |
| Server functions | `src/lib/athena/workbench/workbench.functions.ts` | `getWorkbenchOptions` (names only), `runImpactWorkbench`. |
| Layout | `src/lib/athena/workbench/graphLayout.ts` | Generic layered layout (no dataset knowledge, no dependency). The map is plain SVG. |

The only engine change: `runImpactAnalysis` now also returns the `AuthorizedEvidence` it used (`records`, server-side only and deliberately non-enumerable, so a result can never be serialized or snapshotted with evidence in it) so the server can project the records a finding cites. Nothing else in the engine, the model path or the three-lane contract changed.

## Datasets (two unrelated, through one interface)

* **Business operations**: the prototype's three scenarios and four demo roles, catalog and `BUSINESS_OPS_MODEL`.
* **Customer support**: the support-desk CSV imported through the ingestion path, its own catalog, periods (Jan → Feb 2027), `SUPPORT_DESK_MODEL` and three roles. `support-lead` sees Support records and the policy lets it discover `csat` without data (shows an *unknown* node and the "Verified data for …" entry); `cx-analyst` sees one metric and no relationship. A second tenant's copy of the file (values +1) sits in the same store on every request, so isolation is exercised, not assumed.

Adding a dataset is one descriptor in `workbench.server.ts` (catalog, periods, model, store, policy, roles); the interface does not change.

## The five sections and the map

* **Verified changes**: engine text (metric, direction, exact change, period comparison), source, and the supporting records (id, period, value, date, source) in a table.
* **Observed relationships**: *Supported: co-movement observed*, *Not supported: pattern not present*, *Cannot be assessed: no verified data*, always with the co-movement-is-not-causation caveat.
* **Hypotheses**: operator-defined, labelled *Unverified*, with plausibility and the evidence that would be needed. Never shown among verified changes.
* **Missing evidence**: from the engine, respecting metric-level discoverability.
* **Proposed actions**: title, rationale, responsible domain, *Requires human approval*, *Not executable*. There is no approve/reject/run control and nothing is persisted.
* **Map**: nodes are metrics that are discoverable for the role (authorized data, or granted by the access policy); edges are the model's relationships that the engine assessed. Solid = verified co-movement, dashed = not supported, dotted = cannot be assessed, `?` = unverified hypothesis, dashed node = discoverable but no data. Nodes and edges are keyboard-operable buttons; a text version lists the same items; selecting one shows evidence, status, hypothesis, limitations and action.

## Security properties

* The browser sends only dataset, scenario and role ids and a question. Each id is checked against a server allowlist (`Map` lookups; prototype keys, other datasets' ids, odd types and long strings are refused with one fixed message). Tenant, actor, workspaces, metric scope and records are never read from the request (extra fields are ignored; a test shows the result is identical).
* Roles are a **simulation**: the server accepts the claimed role id for a fixed tenant and the identity boundary labels it `simulated`. The UI says so. There is no sign-in.
* The question is untrusted: the engine validates it, never echoes it, and a refused question returns only `Invalid analysis question (<code>).`
* Only authorized evidence is projected, only for ids the map cites; withheld records and other tenants' records are never read. Metric discoverability is the engine's (F1): a hidden metric has no node, edge, label, id, count or missing-evidence line. A question naming one does not reveal it.
* An action's responsible domain is shown only if it is a domain of the caller's verified changes; otherwise "to be assigned".
* Record notes (free text) are not projected.
* No provider, `fetch`, `process.env` or Meta code is imported by the workbench modules (tested statically and with a `fetch` tripwire).

## Known limitations

* Roles are simulated; there is no authentication, database or per-user state.
* Relationship models are hand-written for the synthetic data; two periods only, so no strength, lag, trend or attribution.
* Question-to-focus matching is catalog keyword matching (paraphrases are not recognized; then all discoverable relationships show).
* The layered layout suits small graphs (tens of metrics), not large ones; no zoom or pan beyond horizontal scrolling.
* Evidence import provenance (batch, line) is not shown for the support dataset; the record id carries the source line.
* The map is drawn with SVG and has been checked in Chromium only; no automated visual-regression test.
* The datasets are bundled synthetic fixtures; connecting real sources is out of scope.
