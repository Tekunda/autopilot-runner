// The vocabulary the false-green scanner reports in, in a leaf module of its own.
//
// It lives here rather than in ./test-integrity-detect.ts because that file routes `.py` to
// ./python-test-scan.ts, which needs these types back -- a cycle, even type-only, and
// dependency-cruiser's `no-circular` rule (scripts/check-layering.ts) rejects it. A shared leaf is
// the fix the rule is asking for: both scanners depend on the vocabulary, neither on the other.

export type TestIntegrityKind =
  | 'hard-disable'
  | 'empty-content-skip'
  // Not a JS kind: an `expect`-less JS test is far more often a legitimate smoke test (a render
  // that throws on failure), whereas an `assert`-less `def test_` body cannot fail at all --
  // pytest reports a test that only calls code and returns as PASSED -- and Apex has no `skip`,
  // so asserting nothing is one of only two ways an Apex suite reports green having checked
  // nothing.
  | 'no-assertion'
  // Apex's other one: a test that reads the ORG'S EXISTING DATA (`SeeAllData=true`) instead of
  // building its own fixture, so it passes or fails on state no diff controls.
  | 'org-data-dependency'
  // The same false green as `empty-content-skip`, wearing an `if` instead of a skip: every
  // assertion sits inside an existence guard on a value the code under test returned, so the block
  // is skipped exactly when that code is broken and the test passes BECAUSE of the defect.
  | 'vacuous-guard';

export interface TestIntegrityViolation {
  file: string;
  kind: TestIntegrityKind;
  // 1-based line of the offending call, for a finding a human (or the fix loop) can jump to.
  line: number;
  detail: string;
}
