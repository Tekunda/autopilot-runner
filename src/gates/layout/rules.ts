// The PURE, deterministic core of the layout-rules gate (TEK-3691 post-mortem "Deterministic
// layout rules, declared per tenant and repo"). It knows nothing about a browser: it turns a
// declared rule set into a MEASUREMENT SPEC (the DOM queries whose geometry the in-page routine
// must collect) and, given the raw getBoundingClientRect numbers that routine returns, decides
// which rules are violated. No model, no tokens, no network -- just arithmetic on rectangles, so
// it is exhaustively unit-testable with plain geometry objects and can never be rate-limited.
//
// Every threshold comparison is at the EDGE: a measured value EQUAL to its threshold PASSES; only
// a value strictly past it fails (503 vs 872 with max_px 160 -> 369px delta > 160 -> fail; a delta
// of exactly 160 passes). A rule whose primary selector matches nothing on a route is N/A -- an
// informational note, never a fail -- so a broad glob can never false-fail a page it doesn't apply
// to. Multiple matches on one route surface every violation and name the worst.

// A rectangle as read from getBoundingClientRect: viewport-relative, in CSS pixels. `top`/`left`
// are the box origin; width/height its size. `bottom` is derived (top + height) where needed.
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

// The geometry the in-page routine collected for ONE element matching a rule's primary selector:
// its own box, optionally its direct children's boxes (row/gap rules) and its nearest matching
// ancestor's box (ratio rule). Absent optional fields mean the rule did not ask for them.
export interface MatchGeometry {
  box: Box;
  children?: Box[];
  ancestor?: Box | null;
}

// All matches for one rule's primary selector on one route+viewport. An empty `matches` means the
// selector matched nothing -> the rule is N/A there.
export interface RuleGeometry {
  matches: MatchGeometry[];
}

// The raw, threshold-free measurements the browser returns, one entry per rule, aligned by index
// with the rule list that produced the MeasureSpec.
export type RawMeasurements = RuleGeometry[];

// One DOM query the in-page routine runs. `children`/`ancestorSelector` ask it to also capture the
// matched element's direct children / nearest ancestor matching the selector -- only what the
// owning rule needs, nothing more.
export interface MeasureQuery {
  selector: string;
  children?: boolean;
  ancestorSelector?: string;
}

export type MeasureSpec = MeasureQuery[];

// Every rule may carry an optional `viewports`: the viewport WIDTHS (in CSS px) it is scoped to. Set
// -> the rule is evaluated ONLY at those widths (e.g. a 1600px section cap for desktop and a separate
// 3200px cap for mobile, each viewport with its own threshold). Unset/empty -> the rule applies at
// ALL configured viewports (the default). The gate does the width-match filtering (rulesForViewport);
// the evaluators below never see a rule at a viewport it excludes.

// F1 (sibling-height void): within each `within` match, direct children are grouped into rows
// (shared top within tolerance); the largest intra-row height delta greater than `max_px` fails.
export interface SiblingHeightDeltaRule {
  type: 'sibling_height_delta';
  within: string;
  max_px: number;
  viewports?: number[];
}

// F5 (width-ratio): width(of) / width(nearest `within` ancestor) below `min` fails.
export interface ContentWidthRatioRule {
  type: 'content_width_ratio';
  of: string;
  within: string;
  min: number;
  viewports?: number[];
}

// Within each `within` match, the largest vertical gap between direct-children content boxes that
// no child covers; a gap greater than `max_px` fails.
export interface LargestEmptyRegionRule {
  type: 'largest_empty_region';
  within: string;
  max_px: number;
  viewports?: number[];
}

// F2 (over-tall section): any element matching `selector` (default `section[id]`) taller than
// `max_px` fails.
export interface SectionHeightRule {
  type: 'section_height';
  selector?: string;
  max_px: number;
  viewports?: number[];
}

export type LayoutRule =
  | SiblingHeightDeltaRule
  | ContentWidthRatioRule
  | LargestEmptyRegionRule
  | SectionHeightRule;

export const DEFAULT_SECTION_SELECTOR = 'section[id]';

// Two child boxes belong to the same visual row when their tops agree to within this many pixels.
// A small tolerance absorbs sub-pixel/border rounding without merging genuinely stacked rows.
const ROW_TOP_TOLERANCE_PX = 4;

// A finding the evaluator emits. `fail` blocks (a real geometry violation); `na` is informational
// (the rule's selector matched nothing / had no ancestor to measure against) and never blocks.
export interface LayoutFinding {
  ruleType: LayoutRule['type'];
  status: 'fail' | 'na';
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// The optional viewport-width scope. Valid only as an array of positive integers; anything malformed
// (a non-array, a fractional/negative/zero width, a non-number entry) drops the whole field rather
// than throwing -- the rule then falls back to its all-viewports default. An empty array is likewise
// treated as unset.
function asViewports(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const widths: number[] = [];
  for (const entry of value) {
    const width = asNumber(entry);
    if (width === undefined || !Number.isInteger(width) || width <= 0) return undefined;
    widths.push(width);
  }
  return widths.length > 0 ? widths : undefined;
}

// Attach the parsed `viewports` scope to a built rule when present; a malformed/absent scope leaves
// the rule unchanged (applies at all viewports).
function withViewports<T extends LayoutRule>(rule: T, body: Record<string, unknown>): T {
  const viewports = asViewports(body.viewports);
  return viewports ? { ...rule, viewports } : rule;
}

// Build a typed rule from an already-flattened `{ type, ...fields }` object, or null if a required
// field is missing/mistyped. Returning null (rather than throwing) keeps a single malformed rule
// from wedging the whole gate -- it simply does not run.
function buildRule(type: string, body: Record<string, unknown>): LayoutRule | null {
  switch (type) {
    case 'sibling_height_delta': {
      const within = asString(body.within);
      const max_px = asNumber(body.max_px);
      return within !== undefined && max_px !== undefined ? withViewports({ type, within, max_px }, body) : null;
    }
    case 'content_width_ratio': {
      const of = asString(body.of);
      const within = asString(body.within);
      const min = asNumber(body.min);
      return of !== undefined && within !== undefined && min !== undefined
        ? withViewports({ type, of, within, min }, body)
        : null;
    }
    case 'largest_empty_region': {
      const within = asString(body.within);
      const max_px = asNumber(body.max_px);
      return within !== undefined && max_px !== undefined ? withViewports({ type, within, max_px }, body) : null;
    }
    case 'section_height': {
      const max_px = asNumber(body.max_px);
      if (max_px === undefined) return null;
      const selector = asString(body.selector);
      return withViewports(selector !== undefined ? { type, selector, max_px } : { type, max_px }, body);
    }
    default:
      return null;
  }
}

const RULE_TYPES = new Set([
  'sibling_height_delta',
  'content_width_ratio',
  'largest_empty_region',
  'section_height',
]);

const MALFORMED_FIELD_REASON = 'missing or malformed required field';

// Normalize ONE declared rule to either the typed rule or a human reason it was dropped. Accepts
// both the terse bare-key YAML form (`{ sibling_height_delta: { within, max_px } }`) and the
// already-tagged (`{ type: 'sibling_height_delta', within, max_px }`) form. A drop reason (rather
// than a bare null) lets the gate SURFACE a typo'd rule set instead of silently swallowing it.
function normalizeRuleResult(raw: unknown): { rule: LayoutRule } | { drop: string } {
  if (!isObject(raw)) return { drop: 'entry is not a rule object' };
  const tagged = asString(raw.type);
  if (tagged && RULE_TYPES.has(tagged)) {
    const rule = buildRule(tagged, raw);
    return rule ? { rule } : { drop: `rule '${tagged}': ${MALFORMED_FIELD_REASON}` };
  }
  const keys = Object.keys(raw).filter((key) => RULE_TYPES.has(key));
  if (keys.length === 0) {
    return { drop: tagged ? `unknown rule type '${tagged}'` : 'no recognized rule type' };
  }
  if (keys.length > 1) return { drop: `ambiguous: multiple rule types (${keys.join(', ')})` };
  const key = keys[0]!;
  const body = raw[key];
  if (!isObject(body)) return { drop: `rule '${key}': body is not an object` };
  const rule = buildRule(key, body);
  return rule ? { rule } : { drop: `rule '${key}': ${MALFORMED_FIELD_REASON}` };
}

// Returns the typed rule, or null for anything unrecognized or malformed so it is dropped rather
// than crashing the gate.
export function normalizeRule(raw: unknown): LayoutRule | null {
  const result = normalizeRuleResult(raw);
  return 'rule' in result ? result.rule : null;
}

// One dropped rule-list entry: its index in the declared list and why it did not parse.
export interface DroppedRule {
  index: number;
  reason: string;
}

// The valid rules from a declared list PLUS the entries that were dropped and why. The gate needs
// both: an all-dropped list (rules declared, none valid) is a typo'd config to ALARM on, distinct
// from a genuinely absent rule set (a benign no-op) -- and the dropped reasons become skip findings.
export interface NormalizedRules {
  rules: LayoutRule[];
  dropped: DroppedRule[];
}

// Normalize a declared rule LIST. A non-array (or absent) value yields empty rules AND no dropped
// entries -- "no rule set declared", which the gate reads as a benign no-op skip. A non-empty list
// whose entries all fail to parse yields empty rules but a non-empty `dropped`, which the gate reads
// as a typo'd config (invalid-config) rather than "nothing configured".
export function normalizeRulesDetailed(raw: unknown): NormalizedRules {
  if (!Array.isArray(raw)) return { rules: [], dropped: [] };
  const rules: LayoutRule[] = [];
  const dropped: DroppedRule[] = [];
  raw.forEach((entry, index) => {
    const result = normalizeRuleResult(entry);
    if ('rule' in result) rules.push(result.rule);
    else dropped.push({ index, reason: result.drop });
  });
  return { rules, dropped };
}

// The valid rules only, dropping any entry that does not parse.
export function normalizeRules(raw: unknown): LayoutRule[] {
  return normalizeRulesDetailed(raw).rules;
}

// The subset of `rules` that applies at a viewport of the given WIDTH: a rule with a non-empty
// `viewports` scope survives only if that width is listed; a rule without one applies everywhere.
// The gate calls this per viewport so each viewport measures and evaluates only its own rules.
export function rulesForViewport(rules: readonly LayoutRule[], width: number): LayoutRule[] {
  return rules.filter((rule) => !rule.viewports || rule.viewports.length === 0 || rule.viewports.includes(width));
}

// The DOM queries the in-page routine must run for `rules`, aligned by index so the returned
// RawMeasurements[i] pairs back with rules[i]. Each rule asks only for the geometry it needs.
export function measureSpecFor(rules: readonly LayoutRule[]): MeasureSpec {
  return rules.map((rule): MeasureQuery => {
    switch (rule.type) {
      case 'sibling_height_delta':
        return { selector: rule.within, children: true };
      case 'content_width_ratio':
        return { selector: rule.of, ancestorSelector: rule.within };
      case 'largest_empty_region':
        return { selector: rule.within, children: true };
      case 'section_height':
        return { selector: rule.selector ?? DEFAULT_SECTION_SELECTOR };
    }
  });
}

function px(value: number): string {
  return `${Math.round(value)}px`;
}

function naFinding(rule: LayoutRule, selector: string): LayoutFinding {
  return {
    ruleType: rule.type,
    status: 'na',
    message: `${rule.type} selector '${selector}' matched no elements on this route (N/A)`,
  };
}

// Group direct children into visual rows by shared top, then report the worst intra-row height
// delta. Children are sorted by top; a child opens a new row once its top clears the current row's
// top by more than the tolerance.
function rowHeightDeltas(children: readonly Box[]): Array<{ delta: number; minH: number; maxH: number }> {
  const sorted = [...children].sort((a, b) => a.top - b.top);
  const rows: Box[][] = [];
  let rowTop = Number.NEGATIVE_INFINITY;
  for (const child of sorted) {
    if (child.top - rowTop > ROW_TOP_TOLERANCE_PX) {
      rows.push([child]);
      rowTop = child.top;
    } else {
      rows[rows.length - 1]!.push(child);
    }
  }
  return rows
    .filter((row) => row.length > 1)
    .map((row) => {
      const heights = row.map((box) => box.height);
      const minH = Math.min(...heights);
      const maxH = Math.max(...heights);
      return { delta: maxH - minH, minH, maxH };
    });
}

function evaluateSiblingHeightDelta(rule: SiblingHeightDeltaRule, geometry: RuleGeometry): LayoutFinding[] {
  if (geometry.matches.length === 0) return [naFinding(rule, rule.within)];
  const violations = geometry.matches
    .flatMap((match) => rowHeightDeltas(match.children ?? []))
    .filter((row) => row.delta > rule.max_px);
  if (violations.length === 0) return [];
  const worst = violations.reduce((a, b) => (b.delta > a.delta ? b : a));
  const rows = `${violations.length} row${violations.length === 1 ? '' : 's'}`;
  return [
    {
      ruleType: rule.type,
      status: 'fail',
      message: `sibling_height_delta within '${rule.within}': ${rows} exceed ${px(rule.max_px)}; worst ${px(worst.delta)} (${px(worst.minH)} vs ${px(worst.maxH)})`,
    },
  ];
}

function evaluateContentWidthRatio(rule: ContentWidthRatioRule, geometry: RuleGeometry): LayoutFinding[] {
  if (geometry.matches.length === 0) return [naFinding(rule, rule.of)];
  const findings: LayoutFinding[] = [];
  const violations: Array<{ ratio: number; of: number; within: number }> = [];
  for (const match of geometry.matches) {
    const ancestor = match.ancestor;
    if (!ancestor || ancestor.width <= 0) {
      findings.push({
        ruleType: rule.type,
        status: 'na',
        message: `content_width_ratio: '${rule.of}' has no measurable ancestor matching '${rule.within}' on this route (N/A)`,
      });
      continue;
    }
    const ratio = match.box.width / ancestor.width;
    if (ratio < rule.min) violations.push({ ratio, of: match.box.width, within: ancestor.width });
  }
  if (violations.length > 0) {
    const worst = violations.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    const els = `${violations.length} element${violations.length === 1 ? '' : 's'}`;
    findings.push({
      ruleType: rule.type,
      status: 'fail',
      message: `content_width_ratio of '${rule.of}' within '${rule.within}': ${els} below ${rule.min}; worst ${worst.ratio.toFixed(2)} (${px(worst.of)} / ${px(worst.within)})`,
    });
  }
  return findings;
}

// The largest vertical gap between a container's direct-children content boxes. Zero/negative-height
// children are ignored (they occupy no vertical space). Child intervals [top, bottom] are sorted and
// merged; the gap is the uncovered span between one merged interval's end and the next's start. The
// region is bounded by the children's own extent -- space above the first child or below the last is
// container padding, not an empty region BETWEEN content. Fewer than two spaced children -> no gap.
function largestChildGap(children: readonly Box[]): { gap: number; from: number; to: number } | null {
  const intervals = children
    .filter((box) => box.height > 0)
    .map((box) => ({ top: box.top, bottom: box.top + box.height }))
    .sort((a, b) => a.top - b.top);
  if (intervals.length < 2) return null;
  let coveredEnd = intervals[0]!.bottom;
  let best: { gap: number; from: number; to: number } | null = null;
  for (let i = 1; i < intervals.length; i += 1) {
    const { top, bottom } = intervals[i]!;
    if (top > coveredEnd) {
      const gap = top - coveredEnd;
      if (!best || gap > best.gap) best = { gap, from: coveredEnd, to: top };
      coveredEnd = bottom;
    } else if (bottom > coveredEnd) {
      coveredEnd = bottom;
    }
  }
  return best;
}

function evaluateLargestEmptyRegion(rule: LargestEmptyRegionRule, geometry: RuleGeometry): LayoutFinding[] {
  if (geometry.matches.length === 0) return [naFinding(rule, rule.within)];
  const violations = geometry.matches
    .map((match) => largestChildGap(match.children ?? []))
    .filter((gap): gap is { gap: number; from: number; to: number } => gap !== null && gap.gap > rule.max_px);
  if (violations.length === 0) return [];
  const worst = violations.reduce((a, b) => (b.gap > a.gap ? b : a));
  const regions = `${violations.length} region${violations.length === 1 ? '' : 's'}`;
  return [
    {
      ruleType: rule.type,
      status: 'fail',
      message: `largest_empty_region within '${rule.within}': ${regions} exceed ${px(rule.max_px)}; worst ${px(worst.gap)} gap (between y=${px(worst.from)} and y=${px(worst.to)})`,
    },
  ];
}

function evaluateSectionHeight(rule: SectionHeightRule, geometry: RuleGeometry): LayoutFinding[] {
  const selector = rule.selector ?? DEFAULT_SECTION_SELECTOR;
  if (geometry.matches.length === 0) return [naFinding(rule, selector)];
  const violations = geometry.matches.map((match) => match.box.height).filter((height) => height > rule.max_px);
  if (violations.length === 0) return [];
  const worst = Math.max(...violations);
  const sections = `${violations.length} section${violations.length === 1 ? '' : 's'}`;
  return [
    {
      ruleType: rule.type,
      status: 'fail',
      message: `section_height '${selector}': ${sections} exceed ${px(rule.max_px)}; worst ${px(worst)}`,
    },
  ];
}

// Evaluate every rule against the measurements collected for it (aligned by index) and return the
// findings: `fail` for a real violation, `na` for a rule that had nothing to measure. A passing rule
// contributes no finding. This is the whole verdict surface -- the gate blocks iff any `fail` exists.
export function evaluateRules(rules: readonly LayoutRule[], measurements: RawMeasurements): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  rules.forEach((rule, index) => {
    const geometry = measurements[index] ?? { matches: [] };
    switch (rule.type) {
      case 'sibling_height_delta':
        findings.push(...evaluateSiblingHeightDelta(rule, geometry));
        break;
      case 'content_width_ratio':
        findings.push(...evaluateContentWidthRatio(rule, geometry));
        break;
      case 'largest_empty_region':
        findings.push(...evaluateLargestEmptyRegion(rule, geometry));
        break;
      case 'section_height':
        findings.push(...evaluateSectionHeight(rule, geometry));
        break;
    }
  });
  return findings;
}
