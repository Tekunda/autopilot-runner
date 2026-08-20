// Maps a signed grant's `modelTier` onto a concrete vendor model id.
//
// Until this existed, `modelTier` was a label: the 2026-08-19 live trace carried
// `modelTier: "deep"` on its build grant and still initialized `claude-sonnet-5`,
// because nothing ever turned the tier into a `--model` argument for the vendor
// Action. Tier selection is the product promise ("deep planning, cheap gates"), so it
// has to resolve to a real model for the dispatched vendor step.
//
// Vendors are named by the executor provider ids used elsewhere (`claude-code`/`claude`,
// `codex`/`openai`), so a caller can pass through whatever provider it already holds. A
// customer-supplied explicit model always wins over the tier mapping -- the tier is
// Autopilot's default, not an override of BYO config.

import type { ModelTier } from '../contracts/types.ts';

export type ModelVendor = 'claude' | 'openai';

// Claude: deep planning/building gets Opus, ordinary stages Sonnet, cheap
// mechanical stages Haiku. OpenAI: the Codex family's own tiers.
const MODELS: Record<ModelVendor, Record<ModelTier, string>> = {
  claude: {
    fast: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-5',
    deep: 'claude-opus-5',
  },
  openai: {
    fast: 'gpt-5-mini',
    standard: 'gpt-5-codex',
    deep: 'gpt-5-codex',
  },
};

// Reasoning effort for vendors that take effort separately from the model id
// (openai/codex-action's `effort` input). Claude has no equivalent input.
const EFFORT: Record<ModelTier, string> = {
  fast: 'low',
  standard: 'medium',
  deep: 'high',
};

export function vendorOf(provider: string): ModelVendor | undefined {
  if (provider === 'claude' || provider === 'claude-code') return 'claude';
  if (provider === 'openai' || provider === 'codex') return 'openai';
  return undefined;
}

// The model id for a tier, or undefined when the provider isn't one we map
// (a stubbed `opencode`/`command` executor) -- callers then leave model
// selection to the vendor's own default rather than inventing an id.
export function modelForTier(provider: string, tier: ModelTier): string | undefined {
  const vendor = vendorOf(provider);
  return vendor ? MODELS[vendor][tier] : undefined;
}

export function effortForTier(tier: ModelTier): string {
  return EFFORT[tier];
}

// Resolution order: an explicit customer-configured model wins, then the tier
// mapping, then undefined (vendor default).
export function resolveModel(provider: string, tier: ModelTier | undefined, configured?: string): string | undefined {
  if (configured) return configured;
  if (!tier) return undefined;
  return modelForTier(provider, tier);
}
