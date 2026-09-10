// visual-qa: the Visual-QA gate (docs/ci-gate-refit-plan.md P5, §4 -- BLOCKING for both sites).
// It is the CONSERVATIVE (breakage) vision-judge gate: it renders the diff's affected routes
// against the served site, screenshots them across the responsive sweep, and asks a Claude vision
// model whether the layout is broken -- failing only on a CLEAR divergence, never a subjective
// nitpick. All of that machinery lives in vision-gate.ts (shared with design-review, the AGGRESSIVE
// aesthetics gate); this module is just the conservative-profile instantiation plus the stable
// public names the rest of the codebase imports. Behavior is unchanged from before the factory
// extraction -- the CONSERVATIVE_PROFILE framing is byte-for-byte the prompt this gate always sent.

import {
  createVisionGate,
  type VisionGateConfig,
  type VisionGateDeps,
  type VisionGateViewport,
} from './vision-gate.ts';
import { CONSERVATIVE_PROFILE } from './judge.ts';
import type { Gate } from '../types.ts';

export const VISUAL_QA_GATE_ID = 'visual-qa';

// Stable public names kept as aliases over the shared factory's generic ones, so existing imports
// (`VisualQaConfig`, `VisualQaDeps`, `VisualQaViewport`, `DEFAULT_SWEEP`) keep resolving unchanged.
export type VisualQaConfig = VisionGateConfig;
export type VisualQaDeps = VisionGateDeps;
export type VisualQaViewport = VisionGateViewport;
export { DEFAULT_SWEEP } from './vision-gate.ts';

// The conservative vision-judge gate, parameterized. Tests inject a fake browser/judge here; the
// production instance below leaves deps empty.
export function createVisualQaGate(deps: VisualQaDeps = {}): Gate {
  return createVisionGate({ id: VISUAL_QA_GATE_ID, profile: CONSERVATIVE_PROFILE, deps });
}

// The default-wired gate for the heavy stage's registry: real Playwright browser + real vision
// judge, both built lazily on first run.
export const visualQaGate: Gate = createVisualQaGate();
