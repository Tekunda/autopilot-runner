// Did the model provider REJECT this request before any model ran?
//
// claude-code-action fails the vendor step whenever its final result message carries
// `is_error: true`, and the step's conclusion is the ONLY thing that reaches the control plane on
// its own. That conflates two facts that must never be confused:
//
//   * the agent RAN and its work failed -- a content verdict about this diff; and
//   * the provider refused the request (a rate/usage limit on the shared token) so the agent
//     NEVER RAN -- a fact about the infrastructure that says nothing about the diff.
//
// Observed live on a tenant repo: four consecutive stages ended in ~330ms with one turn, no
// spend, and an empty modelUsage. The control plane counted every one of them as a repair
// attempt, spent the whole budget, and told the operator the fix loop was exhausted -- a
// sentence about code that never had a fixer pointed at it. Roughly an hour later the SAME PR
// ran clean, with real model usage on every turn: the rejection was transient, exactly the
// class the infra retry budget exists for. (The run ids, dates and measured spend are kept
// out of this file on purpose -- see the internal record.)
//
// THE SIGNAL. The vendor writes the raw SDK message stream to
// $RUNNER_TEMP/claude-execution-output.json and publishes its path as the step's
// `execution_file` output -- on the FAILING path too. Traced through the code the COMPOSITE
// actually runs, which is `src/entrypoints/run.ts` (its `Run Claude Code Action` step), NOT the
// standalone `base-action/src/index.ts` this action never executes: run-claude-sdk.ts's
// `writeExecutionFile(messages)` (:222) runs BEFORE the `is_error` throw (:289), and run.ts's
// catch (:318) then does `executionFile ??= setExecutionFileOutputIfPresent()`. All at the SHA
// action.yml pins. `sanitizeSdkOutput` never touches that file -- it only shapes what is
// console-logged. action.yml threads the path into the finalize step, which is how the real
// result object gets here instead of a bare "failure" string.
//
// SHAPE. Two shapes are accepted, because two exist in the wild. The execution FILE holds the raw
// SDK result message (`permission_denials: []`, and the provider's own error text in `result`);
// the Actions LOG holds the vendor's SANITIZED summary of the same message
// (`permission_denials_count: 0`, no error text) when debug.showFullOutput is off. Only the file
// is read today, but a classifier that understood just one of the two would be one vendor
// refactor away from being silently inert -- and inert-but-green is this repo's dominant defect
// class. Both are pinned in the tests, from captured production output.

// The conjunction, and why each half is load-bearing:
//
//   is_error: true          -- the run failed. Alone this is just "a failure".
//   NO MODEL WORK           -- total_cost_usd 0 AND modelUsage empty. This is what says the
//                              request never reached a model. An `is_error` WITH real modelUsage
//                              is the agent having run and failed: a genuine content failure that
//                              MUST keep consuming a fix round, and widening this rule to cover
//                              it would silently grant unlimited retries to a fixer that is
//                              simply failing.
//   NO PERMISSION DENIALS   -- a run stopped by the tool allow-list also spends near-zero, but it
//                              is a fact about the PROMPT/grant, not about provider health, and
//                              re-running it changes nothing.
//
// Deliberately absent: num_turns. The observed rejections all had num_turns 1, but the count of
// turns is not evidence about who refused -- the three conditions above already are, and pinning
// an incidental observation would make the classifier brittle in the direction of missing real
// rejections.
interface ResultMessage {
  readonly type?: unknown;
  readonly is_error?: unknown;
  readonly total_cost_usd?: unknown;
  readonly modelUsage?: unknown;
  readonly permission_denials?: unknown;
  readonly permission_denials_count?: unknown;
  // The provider's own account of the refusal, present on the RAW message only. `errors` is
  // deliberately absent from this shape: see reasonText.
  readonly result?: unknown;
  readonly subtype?: unknown;
}

// The check name a provider rejection publishes under -- the string fix-loop.ts and
// external-pr.ts route on. Lives here (a runner leaf) rather than in contracts because the
// producer owns it; both consumers import it as data, never re-spell it.
export const PROVIDER_REJECTED_CHECK = 'provider-rejected';

// The vendor's own error text can be an arbitrarily long provider payload, and this finding rides
// into a check summary and a fix prompt. Bounded here rather than downstream, where a 65,535-char
// host limit is someone else's budget to spend.
const REASON_TEXT_LIMIT = 1_000;

function isEmptyUsage(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') return false;
  return Object.keys(value as object).length === 0;
}

function spentNothing(message: ResultMessage): boolean {
  const cost = message.total_cost_usd;
  const noCost = cost === undefined || cost === null || cost === 0;
  return noCost && isEmptyUsage(message.modelUsage);
}

// Written to say YES only on shapes it recognises, rather than NO only on shapes it recognises.
// The difference is the whole safety posture of this module: a vendor that renames the field, or
// starts emitting the count as a string ("3"), or replaces the array with a richer object, must
// make this return false and the run classify as an ordinary content failure -- never sail
// through an unrecognised value as "no denials" and buy a permission-blocked run free retries.
function deniedNothing(message: ResultMessage): boolean {
  const count = message.permission_denials_count;
  const denials = message.permission_denials;
  // Absent BOTH ways (neither field present) is the only case where nothing is asserted either
  // way -- the sanitized shape always carries the count, the raw shape always carries the array,
  // so this is a message from neither, and the two other conditions still have to hold.
  if (count === undefined && denials === undefined) return true;
  if (count !== undefined && (typeof count !== 'number' || count !== 0)) return false;
  if (denials !== undefined && (!Array.isArray(denials) || denials.length > 0)) return false;
  return true;
}

// The vendor's own `result` string when it has one, else a statement of what the summary itself
// proves. This text travels OUT of the runner -- into a PR check summary and a tracker comment --
// so what may be quoted is a redaction question, not just a usefulness one.
//
// `result` only. NOT gated on debug.showFullOutput, and that is a deliberate reading of why that
// toggle is off by default: it is off because raw SDK output carries TOOL RESULTS, which can hold
// secrets. A run that spent nothing with an empty modelUsage executed no turn and therefore no
// tool, so on THIS path `result` is the provider's canned refusal ("Claude AI usage limit
// reached|<epoch>") with no tool output behind it. Withholding it would leave the operator with
// the same uninformative summary the toggle exists to escape.
//
// The `errors` array is deliberately NOT read, and that asymmetry is the point. The execution
// file is written by writeExecutionFile with NO redaction, while the vendor runs redactSecrets
// over the same text on every path it prints itself (run.ts) -- so the file is the un-redacted
// channel. The safety argument above covers the canned refusal string and nothing else; `errors`
// is arbitrary SDK error text (a thrown message, a transport dump) that can carry whatever was in
// scope when it was raised. This runner has no redactor of its own (redactSecrets lives adapter-
// side, and the runner is a leaf), so the honest options were "redact" or "do not quote" -- and
// the fallback sentence below already tells the operator what happened without it.
function reasonText(message: ResultMessage): string {
  const raw = typeof message.result === 'string' && message.result.trim() !== '' ? message.result.trim() : undefined;
  const detail = raw
    ? raw.length > REASON_TEXT_LIMIT
      ? `${raw.slice(0, REASON_TEXT_LIMIT)}...`
      : raw
    : 'the provider gave no message beyond the failed result summary (most likely a rate/usage limit on the agent credential)';
  return `the model provider rejected this request before any model ran, so no attempt was made: ${detail}`;
}

function lastResultMessage(parsed: unknown): ResultMessage | undefined {
  // The execution file is an ARRAY of SDK messages; a caller holding a single message object is
  // accepted too, so the classifier is usable on either without a second entry point.
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let found: ResultMessage | undefined;
  for (const message of messages) {
    if (message !== null && typeof message === 'object' && (message as ResultMessage).type === 'result') {
      found = message as ResultMessage;
    }
  }
  return found;
}

/**
 * The reason to report when this execution log shows a provider rejection, else undefined.
 *
 * Undefined is the SAFE answer and every ambiguity returns it: unparseable JSON, no result
 * message, a result that isn't an error, or an error with real model work behind it. A missed
 * rejection costs one wrongly-billed fix round and an honest-if-wrong escalation; a wrongly
 * claimed one would hand a genuinely failing fixer an unbilled retry loop.
 */
export function classifyProviderRejection(executionLog: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(executionLog);
  } catch {
    return undefined;
  }
  const message = lastResultMessage(parsed);
  if (!message || message.is_error !== true) return undefined;
  if (!spentNothing(message) || !deniedNothing(message)) return undefined;
  return reasonText(message);
}
