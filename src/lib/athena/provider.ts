// Model provider interface. Neither provider here makes network calls; the optional live Meta analysis is a separate gated path (meta.functions.ts + meta/).
import type { Analysis } from "./engine";

export interface ModelProvider {
  id: string;
  label: string;
  status: "active" | "not-configured";
  /** Optional narrative layer over the deterministic analysis. Must cite only analysis.citedIds. */
  summarize(analysis: Analysis): Promise<{ text: string; citedIds: string[] } | null>;
}

export const deterministicProvider: ModelProvider = {
  id: "deterministic",
  label: "Local deterministic engine (rules, no network)",
  status: "active",
  async summarize(a) {
    const s = a.signals.filter((c) => c.status === "observed").map((c) => c.title.toLowerCase());
    return { text: s.length ? `Observed signals: ${s.join("; ")}. Causal links unverified.` : "No expected signals observed in visible records.", citedIds: a.citedIds };
  },
};

/** Placeholder slot for a Meta summarizer. Not wired to this interface (live Meta runs via meta.functions.ts); never returns fabricated output. */
export const metaProviderStub: ModelProvider = {
  id: "meta-future",
  label: "Meta summarizer slot (placeholder — live Meta runs in the panel below)",
  status: "not-configured",
  async summarize() {
    return null;
  },
};

export const PROVIDERS = [deterministicProvider, metaProviderStub];
