// Shared helper for generic gates: each gate reads its own namespaced,
// per-tenant config off GateContext.config (resolved per repo by
// src/config) and shallow-merges it over sane defaults, so a tenant only
// needs to override the keys it cares about. See issue #77.

export function readGateConfig<T>(config: Record<string, unknown>, key: string, defaults: T): T {
  const raw = config[key];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...defaults, ...(raw as unknown as Partial<T>) } as T;
  }
  return defaults;
}
