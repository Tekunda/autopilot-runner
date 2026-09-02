// How a FAILED command's raw output is bounded before it rides back as gate findings. Shared by
// the e2e gate, the H3 command gates and the serve stage's install/build steps -- every place that
// turns "this shell command exited non-zero" into text a human and the autofixer read.
//
// Only telemetry crosses the split plane, so a multi-MB test log can never ship whole. The
// question is WHICH bounded slice of it ships, and the previous answer -- the last N characters --
// was the wrong one in the exact case that matters most:
//
//  * Test runners and compilers print their detailed failure blocks in ORDER and their summary
//    LAST. On a run with hundreds of failures the tail is entirely summary: the list of which
//    specs failed, plus the pass/skip tallies. Every assertion diff explaining WHY sits above the
//    cut. That shipped: an e2e capture of ~4KB held nothing but the truncated end of Playwright's
//    failed-test LIST, and diagnosing the run needed line-number forensics against the branch
//    because the assertion text was gone. A run where everything fails is precisely the run where
//    failure #1 is the cause and the rest are its consequences, so the head must survive.
//  * A bare leading `...` is not a truncation notice. It is indistinguishable from output that
//    genuinely begins mid-sentence, so a consumer cannot tell a COMPLETE capture from a CLIPPED
//    one -- the same distinction the codebase already insists on between a value that could not be
//    computed and one that is genuinely empty. Truncation here is stated, and says how much went.
//
// So: keep a head AND a tail, and when anything is dropped, say so in between.

// Default cap on how much of a failed command's output rides back as findings. Unchanged from the
// tail-only capture this replaced -- the defect was the SHAPE of the slice, not its size, and the
// downstream renderers (fix-loop.ts) already ration a failing check's findings against their own
// budgets.
export const DEFAULT_CAPTURE_LIMIT = 4000;

// Share of the budget spent on the tail. The head carries the first failure's full block (the
// diagnosis); the tail carries the closing summary and tallies (the scale of the damage), which is
// the cheaper of the two, so it gets the smaller share.
const TAIL_SHARE = 0.35;

// Held back from the budget for the truncation notice, which is written only once the kept lengths
// are known. Comfortably above the notice's own worst case (its four numbers are bounded by the
// length of a string that already fit in memory), so head + notice + tail never exceeds the limit.
const NOTICE_RESERVE = 200;

// Snapping a cut to a line boundary keeps failure blocks from being sliced mid-line, but must not
// cost real content: a segment with no newline in its outer half is cut where it lands.
const MIN_SNAP_RATIO = 0.5;

// Drop a lone leading (high) surrogate stranded at the end of a slice taken at an arbitrary
// code-unit index. Left in place it encodes to U+FFFD (or is rejected outright) on the way through
// the JSON artifact and the GitHub check-run body -- see the same guard in fix-loop.ts.
function dropTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return text.length > 0 && last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

// The mirror case: a slice taken from the END can begin with a lone trailing (low) surrogate.
function dropLeadingLowSurrogate(text: string): string {
  const first = text.charCodeAt(0);
  return text.length > 0 && first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

function headSegment(text: string, chars: number): string {
  const cut = dropTrailingHighSurrogate(text.slice(0, chars));
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak >= cut.length * MIN_SNAP_RATIO ? cut.slice(0, lastBreak) : cut;
}

function tailSegment(text: string, chars: number): string {
  const cut = dropLeadingLowSurrogate(text.slice(text.length - chars));
  const firstBreak = cut.indexOf('\n');
  return firstBreak >= 0 && firstBreak <= cut.length * MIN_SNAP_RATIO ? cut.slice(firstBreak + 1) : cut;
}

/**
 * Bound a failed command's output to `limit` characters, keeping the head (where the first
 * failure's full detail is) and the tail (where the summary is), with an explicit notice of how
 * much was dropped in between.
 *
 * Output that already fits is returned trimmed and OTHERWISE UNTOUCHED -- no notice, so the
 * presence of a notice is itself the signal that the capture is partial.
 */
export function boundedCapture(text: string, limit = DEFAULT_CAPTURE_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;

  const budget = limit - NOTICE_RESERVE;
  // A limit too small to hold a notice plus both segments cannot express "head and tail" at all.
  // Fall back to the head alone: the first failure still beats the last, which is the whole point.
  if (budget <= 0) return headSegment(trimmed, limit);

  const head = headSegment(trimmed, budget - Math.floor(budget * TAIL_SHARE));
  const tail = tailSegment(trimmed, Math.floor(budget * TAIL_SHARE));
  const dropped = trimmed.length - head.length - tail.length;
  const notice =
    `\n\n... [output truncated: ${dropped} of ${trimmed.length} characters omitted here; ` +
    `the first ${head.length} and last ${tail.length} were kept] ...\n\n`;
  return `${head}${notice}${tail}`;
}
