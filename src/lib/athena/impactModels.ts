// Relationship models for the two bundled SYNTHETIC datasets. A model is operator-declared domain knowledge: it says which metric pairs are worth looking at together and
// how they would be expected to move if a business story were true. It is NOT evidence and does not assert cause; the engine only reports whether the verified data show the
// pattern, and shows the implication as an unverified hypothesis. Wording here is held to the same honesty rules as the engine's output (hedged, no cause words).
// Dataset A uses the prototype's catalog (src/lib/athena/prototypeCatalog.ts); dataset B uses the support-desk catalog (src/lib/athena/core/ingest/fixtures.ts).
import type { RelationshipModel } from "./meta/impact";

export const BUSINESS_OPS_MODEL: RelationshipModel = {
  name: "business-operations",
  rules: [
    { id: "leads-vs-lead-quality", from: "leads", to: "mql_rate", expect: "opposite", plausibility: "Medium",
      implication: "A lower-intent lead mix may be associated with the drop in lead quality.",
      missing: ["Lead source or channel mix by period.", "Whether the lead scoring definition changed between periods."],
      action: { title: "Review the channel mix toward higher-quality sources as a two-week test.", owner: "Marketing" } },
    { id: "lead-quality-vs-conversion", from: "mql_rate", to: "conversion_rate", expect: "same", plausibility: "Medium",
      implication: "Lower lead quality may be associated with lower sales conversion.",
      missing: ["Conversion by lead source.", "Sales capacity and pricing changes between periods."],
      action: { title: "Pilot a lead-score gate before rep assignment.", owner: "Sales" } },
    { id: "conversion-vs-closed-deals", from: "conversion_rate", to: "closed_deals", expect: "same", plausibility: "Medium",
      implication: "Lower conversion may be reflected in fewer closed deals.",
      missing: ["Pipeline volume by stage."] },
    { id: "closed-deals-vs-revenue", from: "closed_deals", to: "revenue", expect: "same", plausibility: "Low",
      implication: "Fewer closed deals may be associated with lower recognized revenue.",
      missing: ["Average deal size by period.", "Revenue recognition timing.", "How much each factor contributes (no decomposition exists)."],
      action: { title: "Re-forecast next quarter with sensitivity ranges.", owner: "Finance" } },
    { id: "fulfillment-vs-conversion", from: "fulfillment_days", to: "conversion_rate", expect: "opposite", plausibility: "Low",
      implication: "Longer fulfillment may be associated with lower conversion if buyers hesitate over delivery times.",
      missing: ["Order abandonment records.", "Whether delivery times are shown at quote time."],
      action: { title: "Show stock ETA at quote time and review backordered SKUs.", owner: "Operations" } },
    { id: "backorders-vs-fulfillment", from: "backorder_rate", to: "fulfillment_days", expect: "same", plausibility: "Medium",
      implication: "Higher backorders may be associated with longer fulfillment times.",
      missing: ["Backorders by SKU family.", "Supplier lead times."] },
    { id: "fulfillment-vs-revenue", from: "fulfillment_days", to: "revenue", expect: "opposite", plausibility: "Low",
      implication: "Longer fulfillment may be associated with lower revenue, for example through delayed recognition.",
      missing: ["Recognition timing against shipment dates."] },
    { id: "leads-vs-acquisition-cost", from: "leads", to: "cac", expect: "same", plausibility: "Low",
      implication: "Growth in lead volume may be associated with a higher cost per acquired customer.",
      missing: ["Spend by channel.", "Customers acquired by channel."] },
  ],
};

export const SUPPORT_DESK_MODEL: RelationshipModel = {
  name: "customer-support",
  rules: [
    { id: "volume-vs-first-response", from: "tickets_opened", to: "first_response_hours", expect: "same", plausibility: "Medium",
      implication: "Higher ticket volume may be associated with slower first responses.",
      missing: ["Agent staffing and availability by period.", "Ticket mix by category."],
      action: { title: "Review staffing against ticket volume.", owner: "Support" } },
    { id: "volume-vs-resolution", from: "tickets_opened", to: "resolution_hours", expect: "same", plausibility: "Low",
      implication: "Higher ticket volume may be associated with longer resolution times.",
      missing: ["Resolution time by ticket category.", "Agent staffing and availability by period."] },
    { id: "first-response-vs-satisfaction", from: "first_response_hours", to: "csat", expect: "opposite", plausibility: "Medium",
      implication: "Slower first responses may be associated with lower customer satisfaction.",
      missing: ["Satisfaction scores per ticket alongside response time."] },
    { id: "resolution-vs-satisfaction", from: "resolution_hours", to: "csat", expect: "opposite", plausibility: "Medium",
      implication: "Longer resolution times may be associated with lower customer satisfaction.",
      missing: ["Satisfaction scores per ticket alongside resolution time.", "Which ticket categories got slower."],
      action: { title: "Review the oldest unresolved tickets with the support team.", owner: "Support" } },
  ],
};
