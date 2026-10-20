// Model provider interface for future integration. NO live calls are made.
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
  label: "Deterministic demo engine (rules)",
  status: "active",
  async summarize(a) {
    const s = a.signals.filter((c) => c.status === "observed").map((c) => c.title.toLowerCase());
    return { text: s.length ? `Observed signals: ${s.join("; ")}. Causal links unverified.` : "No expected signals observed in visible records.", citedIds: a.citedIds };
  },
};

/** Placeholder for a future Meta model provider. Not integrated; never returns fabricated output. */
export const metaProviderStub: ModelProvider = {
  id: "meta-future",
  label: "Meta model provider (future — not integrated)",
  status: "not-configured",
  async summarize() {
    return null;
  },
};

export const PROVIDERS = [deterministicProvider, metaProviderStub];
