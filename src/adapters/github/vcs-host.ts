// GitHub implementation of the VCSHost contract (src/contracts/adapters.ts).

import type {
  BranchRulesReading,
  ClaimRefResult,
  OpenPR,
  PrFeedback,
  PrFeedbackReading,
  PublishedCheck,
  VCSHost,
} from '../../contracts/adapters.ts';
import { retryableHostMessage } from '../../contracts/adapters.ts';
import type { CheckResult, CheckRunSnapshot, OpenCheckRun, PRStatus } from '../../contracts/types.ts';
import { GitHubApiError, GitHubClient, type GitHubClientConfig } from './rest.ts';

interface GhRef {
  object: { sha: string };
}

interface GhPull {
  number: number;
  html_url: string;
}

interface GhListPull {
  number: number;
  html_url: string;
  title: string;
  head: { ref: string; repo: { full_name: string } | null };
  user: { login: string } | null;
}

interface GhPullDetail {
  number: number;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  merge_commit_sha: string | null;
  head: { ref: string; sha?: string };
  base: { ref: string };
}

interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  started_at: string | null;
  id: number;
  app?: { id?: number } | null;
}

interface GhCheckRunsResponse {
  check_runs: GhCheckRun[];
}

interface GhJob {
  id: number;
  name: string;
  conclusion: string | null;
}

interface GhReview {
  id?: number;
  user: ({ login: string; type?: string }) | null;
  state: string;
  body?: string;
  submitted_at: string | null;
}

interface GhIssueComment {
  id: number;
  user: ({ login: string; type?: string }) | null;
  body?: string;
}

interface GhPermission {
  permission: string;
}

interface GhBranchProtection {
  required_status_checks?: { contexts?: string[] };
  required_pull_request_reviews?: unknown;
}

// A single active rule from the repository-ruleset API
// (`GET /repos/{repo}/rules/branches/{branch}`), which the legacy
// branch-protection endpoint does NOT surface. A branch can be governed by a
// ruleset, by classic protection, or both -- so both must be read and unioned.
interface GhBranchRule {
  type: string;
  parameters?: {
    required_status_checks?: { context: string }[];
    required_approving_review_count?: number;
  };
}

// How long ONE call to merge() will wait on a background merge before handing the wait back to
// the caller. Deliberately WELL UNDER the control-plane tick (60s in production): the tick loop
// is the real poller here, and a merge() that outlives its own tick would serialise every other
// ticket behind one PR. Past this window merge() throws a TRANSIENT 504 -- the merge keeps
// running on GitHub's side, the next tick rejoins it by uuid (see the 409 branch in mergeAsync),
// and the caller's own retry budget bounds the total wait, not this constant.
const ASYNC_MERGE_DEADLINE_MS = 30_000;
// 5s between result reads: the same cadence the CI runner polls a workflow run with. The common
// case (an ordinary or short stack) merges in a few seconds, so this notices it almost
// immediately while costing ~6 reads for the ones that do not.
const ASYNC_MERGE_POLL_INTERVAL_MS = 5_000;

// Per-read timeout for confirmMergeCommit's verification reads.
//
// Those reads run AFTER the poll loop's last deadline check, so without a bound of their own they
// extend merge() past the window every other part of this lane respects. On the DEFAULT client
// one logical read is 3 attempts at a 30s timeout (~90s worst case, see rest.ts), and there are
// two of them -- ~3 minutes on top of the 30s the poll already spent, against a 60s control-plane
// tick, with every other ticket serialised behind one PR.
//
// Two bounds, and both are needed. The verification gets what REMAINS of this call's window, not
// a fresh one -- a fresh window is not a bound, it is a second budget. And each read is capped by
// its own short-timeout, single-attempt client, because a budget check only gates whether a read
// STARTS: it cannot stop one that already has. Together the worst case is the poll's window plus
// two of these, still comfortably inside one tick.
const MERGE_VERIFY_TIMEOUT_MS = 5_000;

// The merge method every control-plane merge lands with. NOT a default worth leaving implicit:
// rollups and promotions must produce a MERGE COMMIT, because the Website deploy workflow reads
// the merge commit's second parent to decide what changed, and blocked-recovery compares refs by
// ancestry (see blocked-recovery.ts -- "a squash-merged ref is an ancestor of nothing and
// compares as uncontained forever"). The synchronous endpoint happens to default to `merge`
// already; `merge-async` documents NO default at all and could resolve to the repository's
// configured one (Tekunda/Website allows squash and rebase too), so both paths state it.
//
// This applies to EVERY PR that reaches this method, subtask PRs included -- they arrive here via
// completeOrArmMerge from subtask-pipeline's drive paths, so this is not a rollup-only concern.
// That is not a change: the synchronous endpoint was already defaulting all of them to a merge
// commit. Making it explicit only removes the repository setting's ability to change it silently.
const MERGE_METHOD = 'merge';

// The merge methods a 409's already-running request may report that this adapter must NOT adopt,
// each with the reason it cannot be. These are the only values that justify refusing an
// already-running asynchronous merge; everything else is adopted. Compared lowercased and
// trimmed; see mergeAsync's 409 branch.
//
// `squash` and `rebase` are the two that would land the PR WITHOUT a merge commit, the one
// outcome MERGE_METHOD exists to prevent. `default` is not a method at all: GitHub's published
// OpenAPI (`pull-request-merge-async-result`) gives the RESPONSE enum as
// ["default","merge","squash","rebase"] while the PUT REQUEST enum is only
// ["merge","squash","rebase"], so `default` means "whatever this repository is configured to do"
// -- and Tekunda/Website permits squash. Refusing it therefore cannot wedge our own resume: the
// request enum cannot express `default`, so a 409 reporting it is BY DEFINITION somebody else's
// enqueued request (a human, native auto-merge, an older deployment), never one this code sent.
// Refusing is free; adopting risks landing a squash on an integration branch.
//
// The refusal is PERMANENT for `default` too, and that is a deliberate choice rather than a
// consequence. `squash`/`rebase` are certainly single-parent; `default` is merely UNKNOWN, and a
// 504 would reach the same safety one tick later, with evidence from confirmMergeCommit and no
// human escalation on a repository whose default happens to be `merge`. Permanent wins because
// the merge is still ENQUEUED at this point: escalating now gives a human the chance to cancel it
// before an irreversible squash lands on the base, whereas a tick of patience spends exactly the
// window in which the outcome is still preventable. A false escalation costs a human one look; a
// squashed rollup costs a manual history repair.
const UNADOPTABLE_MERGE_METHODS = new Map<string, string>([
  ['squash', 'adopting it would land the pull request without a merge commit'],
  ['rebase', 'adopting it would land the pull request without a merge commit'],
  [
    'default',
    'this control plane cannot request "default" -- it resolves to whatever the repository is ' +
      'configured to do, which here may be a squash, so adopting it risks landing the pull ' +
      'request without a merge commit',
  ],
]);

// The result of PUT /repos/{repo}/pulls/{n}/merge-async and of GET .../merge-async/{uuid}.
// `status` is the whole verdict: 'merged' is done, 'failed' is a permanent refusal carrying
// GitHub's reason, 'pending'/'enqueued' mean keep polling.
interface GhMergeAsyncResult {
  status?: 'pending' | 'merged' | 'enqueued' | 'failed';
  uuid?: string;
  merge_method?: string;
  details?: { message?: string; uuid?: string; merge_method?: string };
}

// The uuid GitHub hands back for an asynchronous merge, from a 202/200 body or from the body of
// the documented 409 ("If another asynchronous merge request has already been made for this pull
// request, the UUID of that request will be returned instead with a 409 response status").
//
// Checked in BOTH shapes -- nested under `details`, which is what the published schema describes,
// and top-level. The whole 409 resume hinges on finding this field, and if a rewording moved it
// the resume would silently never fire: every tick would resubmit into the same 409, exhaust the
// retry budget and wedge, which is precisely the failure this adapter exists to prevent. Reading
// two shapes costs nothing; guessing one and being wrong costs a wedged ticket.
function asyncMergeUuidOf(body: unknown): string | undefined {
  const result = body as GhMergeAsyncResult | undefined;
  for (const candidate of [result?.details?.uuid, result?.uuid]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

// The merge method of an ALREADY-RUNNING asynchronous merge, as reported in the 409 body.
function asyncMergeMethodOf(body: unknown): string | undefined {
  const result = body as GhMergeAsyncResult | undefined;
  for (const candidate of [result?.details?.merge_method, result?.merge_method]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

export interface GitHubVCSHostConfig extends GitHubClientConfig {
  /** The numeric id of the GitHub App whose installation token this host uses (GitHub's
   *  `AUTOPILOT_GITHUB_APP_ID`). Supplied so listOpenCheckRuns can scope its listing to
   *  check-runs this app itself created; omitted -> that listing reports "cannot determine"
   *  and the orphan sweep does nothing. */
  appId?: string | number;
  /** Injectable sleep for the asynchronous-merge poll. Defaults to real timers; tests pass a
   *  no-op so the bounded poll runs instantly and no test ever waits on a real clock. */
  asyncMergeSleep?: (ms: number) => Promise<void>;
  /** Poll cadence / ceiling overrides for the asynchronous-merge fallback. Test seams; the
   *  defaults (ASYNC_MERGE_POLL_INTERVAL_MS / ASYNC_MERGE_DEADLINE_MS) are what production uses. */
  asyncMergePollIntervalMs?: number;
  asyncMergeDeadlineMs?: number;
  /** Clock for the asynchronous-merge deadline. Defaults to the real one; a test drives it
   *  explicitly so the bound is asserted deterministically rather than raced against wall time. */
  now?: () => number;
}

// The hard cap GitHub puts on the `files` array of one compare response. A full page means
// there are more files than were returned, not that the diff is exactly this size.
const COMPARE_FILE_PAGE_LIMIT = 300;

export class GitHubVCSHost implements VCSHost {
  private readonly client: GitHubClient;
  // The same host, for confirmMergeCommit's post-merge reads only: one attempt, short timeout.
  // See MERGE_VERIFY_TIMEOUT_MS. Everything else comes from the same config, so a token provider
  // injected once is reused rather than duplicated.
  //
  // The BREAKER is the one place the two configurations genuinely differ, and it is worth stating
  // because tests inject one while production does not: an injected breaker is shared with the
  // main client, whereas the default (nothing injected -- adapters/registry.ts,
  // runner/adapters.ts) gives this client its OWN, exactly as every other GitHub client in the
  // process already has. Its own is the wanted behaviour, not an oversight. These reads are
  // deliberately impatient, and a 5s timeout that the 30s client would never have seen is not
  // evidence GitHub is out: sharing the counter would let a verification read -- whose failure
  // costs nothing, it degrades to "unverified" -- open the breaker in front of the merges and
  // writes that do matter. Nor can having its own mask a real outage: the main breaker still trips
  // on the PUT and the poll reads, which vastly outnumber these, and in an outage merges do not
  // succeed, so this path is barely entered at all.
  private readonly verifyClient: GitHubClient;
  // The GitHub App this host authenticates as, when the caller knows it. Only listOpenCheckRuns
  // uses it, and only to refuse to run at all without it: that lane retires check-runs found by
  // listing a ref rather than by an id somebody recorded, so app ownership is the ONLY thing
  // standing between it and another app's check.
  private readonly appId: number | undefined;
  private readonly asyncMergeSleep: (ms: number) => Promise<void>;
  private readonly asyncMergePollIntervalMs: number;
  private readonly asyncMergeDeadlineMs: number;
  private readonly now: () => number;
  // One-shot diagnostic for a 409 whose body yields no uuid. Once per HOST, which is once per
  // tenant for the life of its control plane: the first occurrence prints the shape GitHub
  // actually sent, which is the whole diagnosis, and this sits on a path that would otherwise
  // repeat every tick. Instance-scoped rather than module-scoped so one tenant's warning cannot
  // silence another's, and so it is observable from a test.
  private warnedUnresumable409 = false;
  // One-shot, like the above: the 409's `merge_method` carrying an unrecognised value is adopted
  // rather than refused, and a silent adoption is what makes a shape change undiagnosable.
  private warnedUnknownAsyncMergeMethod = false;

  constructor(config: GitHubVCSHostConfig) {
    this.client = new GitHubClient(config);
    this.verifyClient = new GitHubClient({
      ...config,
      timeoutMs: config.timeoutMs === undefined ? MERGE_VERIFY_TIMEOUT_MS : Math.min(config.timeoutMs, MERGE_VERIFY_TIMEOUT_MS),
      maxRetries: 0,
    });
    const parsed = config.appId === undefined ? Number.NaN : Number(config.appId);
    this.appId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
    this.asyncMergeSleep = config.asyncMergeSleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.asyncMergePollIntervalMs = config.asyncMergePollIntervalMs ?? ASYNC_MERGE_POLL_INTERVAL_MS;
    this.asyncMergeDeadlineMs = config.asyncMergeDeadlineMs ?? ASYNC_MERGE_DEADLINE_MS;
    this.now = config.now ?? (() => Date.now());
  }

  async createBranch(repoId: string, name: string, fromRef: string): Promise<void> {
    const ref = await this.client.request<GhRef>('GET', `/repos/${repoId}/git/ref/heads/${fromRef}`);
    if (!ref) throw new Error(`unknown ref: ${fromRef} in ${repoId}`);

    await this.client.request('POST', `/repos/${repoId}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha: ref.object.sha,
    });
  }

  async openPR(
    repoId: string,
    params: { branch: string; base: string; title: string; body: string },
  ): Promise<{ url: string; number: number }> {
    const pr = await this.client.request<GhPull>('POST', `/repos/${repoId}/pulls`, {
      title: params.title,
      body: params.body,
      head: params.branch,
      base: params.base,
    });
    if (!pr) throw new Error(`GitHub returned no body for opened PR in ${repoId}`);

    return { url: pr.html_url, number: pr.number };
  }

  // Land the PR, resolving ONLY once it is actually merged (see VCSHost.merge's contract).
  //
  // The synchronous endpoint is still the normal path -- one request, done. But it cannot merge
  // every PR: a STACKED pull request (one whose base is another open PR's head) is refused with
  // a 403 -- "Merging stacked PRs via this endpoint is not supported. Use the asynchronous merge
  // endpoint instead." -- and no amount of retrying changes that. TEK-3766 wedged for days on
  // exactly this: rollup PR #1532 targeted the head branch of open promotion PR #1518, the
  // adapter only knew the synchronous endpoint, and a permanent refusal was filed as a retryable
  // "pending" that burned eight ticks and then blocked with an invented reason.
  //
  // So a 403 that is not a throttle falls through to GitHub's documented asynchronous merge
  // (PUT .../merge-async + poll .../merge-async/{uuid}), which is the REQUIRED method for a stack
  // and also works for an ordinary PR. Every other status rethrows unchanged -- a 405/409 is a
  // benign race the caller already retries next tick.
  async merge(repoId: string, prNumber: number): Promise<void> {
    try {
      await this.client.request('PUT', `/repos/${repoId}/pulls/${prNumber}/merge`, { merge_method: MERGE_METHOD });
      return;
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.status !== 403) throw err;
      // GitHub throttles with a 403 far more often than a 429. That 403 says nothing about this
      // PR, so falling through would swap one endpoint for another mid-throttle and add load to
      // the thing rate-limiting us. Rethrow: the caller reads it as transient and retries.
      //
      // Header evidence OR message evidence, the same two-signal test the control plane's
      // classifier uses. Header-only would miss exactly the case retryableHostMessage exists for:
      // a secondary-rate-limit 403 with no Retry-After, which would then fire a second WRITE into
      // merge-async in the middle of the throttle that just refused the first one.
      if (err.rateLimited || retryableHostMessage(err.message)) throw err;
      // The message match is for the LOG only -- so the reason the fallback fired is legible --
      // never a condition on it. GitHub's wording is not part of any contract, and gating the
      // fallback on exact text is how this bug comes back the day they reword it.
      const stacked = /stack|asynchronous merge/i.test(err.message);
      console.warn(
        `github: PR #${prNumber} refused by the synchronous merge endpoint (403${stacked ? ', stacked PR' : ''}): ` +
          `${err.message} -- retrying via the asynchronous merge endpoint`,
      );
      await this.mergeAsync(repoId, prNumber);
    }
  }

  // GitHub's asynchronous merge: submit the request, then poll until the PR is genuinely merged.
  // Rejects -- never resolves optimistically -- when the merge fails, and rejects TRANSIENTLY
  // when the bounded window elapses with the merge still running.
  private async mergeAsync(repoId: string, prNumber: number): Promise<void> {
    const path = `/repos/${repoId}/pulls/${prNumber}/merge-async`;
    // When this CALL began. Deliberately NOT the poll loop's `started` below, which begins after
    // the submit and exists to bound the polling: this one bounds confirmMergeCommit, which runs
    // after the poll's last deadline check and must get what REMAINS of the window rather than a
    // fresh one of its own.
    //
    // It precedes the SUBMIT, which has a consequence worth naming: a PUT that itself burns the
    // whole window leaves the verification zero budget, so the 200-already-merged exit degrades to
    // a warning under exactly the conditions where somebody else's squash is most likely. That is
    // the correct trade anyway -- the alternative is a merge() that runs past its tick to check --
    // and it is not the last line of defence: blocked-recovery still compares the ref by ancestry.
    const callStarted = this.now();
    let uuid: string | undefined;
    try {
      // Any throw here (403 without the permission, 400 "the pull request is closed or a draft",
      // 422) propagates unchanged: the caller must see GitHub's own refusal, not a wrapped one.
      const accepted = await this.client.request<GhMergeAsyncResult>('PUT', path, { merge_method: MERGE_METHOD });
      if (accepted?.status === 'merged') return await this.confirmMergeCommit(repoId, prNumber, callStarted); // 200: already merged
      if (accepted?.status === 'failed') throw this.asyncMergeRefusal(repoId, prNumber, accepted.details?.message);
      uuid = asyncMergeUuidOf(accepted);
    } catch (err) {
      // 409 is not a failure: it is GitHub saying an asynchronous merge is ALREADY running for
      // this PR and handing back ITS uuid. That is the normal resume, because merge() hands the
      // wait back to the tick loop after ASYNC_MERGE_DEADLINE_MS -- so every tick after the first
      // one lands here and must rejoin the running merge. Resubmitting instead (or treating the
      // 409 as a fault) would rediscover the original bug: the merge would be invisible, every
      // tick would look identical, and the retry budget would run out on a merge that was
      // progressing fine.
      if (!(err instanceof GitHubApiError) || err.status !== 409) throw err;

      // WHOSE merge are we about to adopt? Not necessarily ours. A human clicking Merge, the
      // repository's native auto-merge, or an older deployment of this control plane could have
      // enqueued it -- as a squash, a rebase, or the repository's `default`. Adopting one of those
      // and then reporting success would hand back a landed PR with no second parent, which is the
      // one outcome MERGE_METHOD exists to prevent, and it would be invisible: the poll says
      // `merged` either way. So a method that is not ours and CANNOT be ours is a PERMANENT
      // refusal that says which method it saw.
      // An ABSENT method is adopted: our own submits always name `merge`, and refusing on a field
      // GitHub merely omitted would wedge every ordinary resume.
      //
      // The refusal is TERMINAL (a 403, which permanentHostRefusal reads as permanent and merge.ts
      // turns into `blocked` on tick one), so it is spent only on a value that POSITIVELY names a
      // method that is not ours. `merge_method` in a 409 body is not part of the documented
      // contract -- the 409 documents the uuid -- and it is evidenced solely by this repo's own
      // stub, exactly the argument this same lane makes about the uuid. A terminal verdict keyed
      // on a guess about an undocumented field's spelling is TEK-3766 with the sign flipped: our
      // own healthy async merge refused on tick two, with a fabricated reason describing somebody
      // else's merge. So: case- and whitespace-insensitive, and only UNADOPTABLE_MERGE_METHODS
      // counts. Anything else -- absent, unrecognised, a shape this code does not know -- is
      // ADOPTED, with a one-shot warning so it is diagnosable in one run.
      const runningMethod = asyncMergeMethodOf(err.body);
      const normalizedMethod = runningMethod?.trim().toLowerCase();
      if (normalizedMethod !== undefined && normalizedMethod !== MERGE_METHOD) {
        const unadoptable = UNADOPTABLE_MERGE_METHODS.get(normalizedMethod);
        // Presence, not truthiness: the value is a reason string, so a future entry added with an
        // empty one would silently become ADOPTABLE -- the permissive direction, decided by a typo.
        if (unadoptable !== undefined) {
          throw this.asyncMergeRefusal(
            repoId,
            prNumber,
            `an asynchronous merge is already running for this pull request with merge_method ` +
              `"${runningMethod}", not "${MERGE_METHOD}" -- ${unadoptable}`,
          );
        }
        if (!this.warnedUnknownAsyncMergeMethod) {
          this.warnedUnknownAsyncMergeMethod = true;
          console.warn(
            `github: PR #${prNumber}: the running asynchronous merge reports merge_method ` +
              `"${runningMethod}", which is neither "${MERGE_METHOD}" nor a known history-rewriting ` +
              `method -- adopting it rather than refusing a merge that is most likely our own`,
          );
        }
      }

      const resumable = asyncMergeUuidOf(err.body);
      // Nothing to rejoin. Rethrown as the transient 409 it is, but LOUDLY the first time: the
      // 409 is documented to carry the uuid, so a body without one means either a saturated queue
      // or a shape this code no longer understands, and the latter silently degrades into
      // resubmit-forever. Printing the body once makes that diagnosable in a single run instead
      // of after a wedge.
      if (!resumable) {
        if (!this.warnedUnresumable409) {
          this.warnedUnresumable409 = true;
          console.warn(
            `github: PR #${prNumber} got a 409 from merge-async with no uuid to rejoin, so the ` +
              `running merge cannot be polled. Body shape was: ${JSON.stringify(err.body) ?? 'undefined'}`,
          );
        }
        throw err;
      }
      uuid = resumable;
    }

    // Bounded by ATTEMPTS, not by wall clock, so an injected no-op sleep terminates the loop
    // instantly instead of spinning against a Date.now() that never advances. The wall-clock
    // check is the other half of the belt-and-braces: it stops a poll whose own requests ran long
    // enough to blow the deadline before the attempt budget ran out.
    const started = this.now();
    const maxPolls = Math.max(1, Math.ceil(this.asyncMergeDeadlineMs / this.asyncMergePollIntervalMs));
    for (let poll = 0; poll < maxPolls; poll++) {
      await this.asyncMergeSleep(this.asyncMergePollIntervalMs);
      // Checked on BOTH sides of the read block, and that is not belt-and-braces padding: the two
      // catch different things. Measured, top-of-loop ALONE is a regression -- reads already
      // started run to completion either way, so it gates the same iteration as a bottom check
      // while paying one extra sleep, losing a poll for the same wall clock. Bottom-of-loop alone
      // is what shipped before, and it cannot stop the NEXT sleep from being entered. Together,
      // the cheap top check skips a sleep we know is pointless and the bottom check ends the call
      // the moment the reads themselves blew the window.
      if (this.now() - started >= this.asyncMergeDeadlineMs) break;

      // The merge request's own verdict, when we have its id. Authoritative and, crucially, the
      // only place a FAILED background merge is visible -- without it a conflict would look
      // identical to "still running" and burn the whole window every tick, forever.
      if (uuid) {
        const result = await this.readDuringMerge<GhMergeAsyncResult>(`${path}/${uuid}`);
        if (result?.status === 'merged') return await this.confirmMergeCommit(repoId, prNumber, callStarted);
        if (result?.status === 'failed') throw this.asyncMergeRefusal(repoId, prNumber, result.details?.message);
      }

      // Ground truth regardless: the PR itself. `merged` is the only thing that lets this method
      // resolve.
      const pr = await this.readDuringMerge<GhPullDetail>(`/repos/${repoId}/pulls/${prNumber}`);
      if (pr?.merged) return await this.confirmMergeCommit(repoId, prNumber, callStarted, pr);
      // Closed without merging: stop polling, but do NOT call it a refusal. `completeOrArmMerge`
      // has a distinct `closed` outcome for exactly this -- "a human rejected this work" -- which
      // callers treat differently from `blocked`, and it reaches that outcome by re-reading the
      // PR next tick. Reporting a permanent refusal here would block the ticket on the merge path
      // instead, and lose that distinction. A transient throw costs one tick and lands on the
      // right verdict.
      if (pr && pr.state === 'closed' && !pr.merged) {
        throw new GitHubApiError(504, 'PUT', path, `PR #${prNumber} was closed without merging while its asynchronous merge was running`);
      }
      if (this.now() - started >= this.asyncMergeDeadlineMs) break;
    }

    // Still running, and this call is out of its window. NOT a refusal, and not a lost merge: it
    // is still queued on GitHub, and the next tick rejoins it through the 409 branch above. The
    // 504 makes the control plane's permanentHostRefusal read it as transient, so the caller's
    // retry budget -- not this method -- bounds how long a merge may take overall.
    throw new GitHubApiError(
      504,
      'PUT',
      path,
      `asynchronous merge of PR #${prNumber} has not completed within ${Math.round(this.asyncMergeDeadlineMs / 1000)}s ` +
        `(${maxPolls} polls at ${this.asyncMergePollIntervalMs}ms): it is still running, and the next attempt will rejoin it`,
    );
  }

  // THE INVARIANT, checked positively: every exit where `mergeAsync` concludes the PR merged must
  // have landed a real merge commit -- two parents.
  //
  // Scoped to `mergeAsync` deliberately, and the comment says so rather than claiming the whole
  // adapter: the synchronous `merge()` at the top of this file resolves unchecked. That is safe
  // for a different reason -- its PUT names `merge_method: 'merge'` in the SAME request that
  // lands the commit, so there is no window in which somebody else's method could be the one
  // that ran. `mergeAsync` has exactly that window, which is what this guards.
  //
  // Everything upstream of this is a claim ABOUT the merge: the merge_method we asked for, the
  // merge_method a 409 reported for a request we adopted, `status: 'merged'`, `pr.merged`. None of
  // them is the invariant, and the gap between them is silent. A human clicking Merge with squash
  // while our poll is running, a 409 that omits or renames its method field, an older deployment's
  // enqueued request -- each ends with the poll reading 'merged' and merge() resolving, the ticket
  // going done, and the rollup on the base as a squash with ONE parent. deploy.yml reads the
  // second parent, and blocked-recovery treats such a ref as uncontained forever, so the work
  // lands and nothing ever notices.
  //
  // Reading the commit is immune to whatever GitHub calls the method field, and it is the only
  // check here that tests the thing that actually matters. The parent count comes from
  // `headCommit`, which already exists for the watchdog and is the ONE place this repo reads
  // "how many parents does this commit have" -- reusing it keeps a single reading of that fact
  // rather than a private second parse of the same body. Its contract already matches what is
  // needed here: `undefined` on ANY failure, never a fabricated 0.
  //
  // A read that FAILS is not a verdict (same rule as readDuringMerge): the merge did happen, so
  // an unverifiable parent count resolves as before rather than inventing a refusal out of a
  // failed request. That is also why the PR read here is `readDuringMerge` and not `getPR`, which
  // shares the `merge_commit_sha` fact but THROWS on an unreadable PR -- inside merge() that
  // throw would escape as though the merge itself had been refused.
  private async confirmMergeCommit(repoId: string, prNumber: number, callStarted: number, known?: GhPullDetail): Promise<void> {
    // What is LEFT of this call's window, checked before EACH read -- see MERGE_VERIFY_TIMEOUT_MS.
    // Overrunning it degrades to "unverifiable", exactly like an unreadable commit: the merge did
    // happen, and a check that ran out of time is not evidence against it.
    const withinBudget = (): boolean => this.now() - callStarted < this.asyncMergeDeadlineMs;

    if (known === undefined && !withinBudget()) return this.reportUnverifiable(prNumber, 'reading the PR');
    const pr = known ?? (await this.readDuringMerge<GhPullDetail>(`/repos/${repoId}/pulls/${prNumber}`, this.verifyClient));
    const sha = pr?.merge_commit_sha;
    if (!sha) return;
    if (!withinBudget()) return this.reportUnverifiable(prNumber, `reading merge commit ${sha}`);
    const commit = await this.headCommitVia(this.verifyClient, repoId, sha);
    if (!commit || commit.parentCount >= 2) return;
    throw this.asyncMergeRefusal(
      repoId,
      prNumber,
      `it landed as ${sha}, a commit with ${commit.parentCount} parent(s) rather than a merge ` +
        `commit's two. The work is on the base branch, but as a squash or rebase, so the deploy ` +
        `workflow's second parent is missing and the branch compares as uncontained. A human has ` +
        `to decide how to restore it`,
      'completed as the wrong kind of merge',
    );
  }

  // The parent-count check could not be taken inside what remained of this call's window.
  //
  // Degrades to UNVERIFIED, never to "bad": the merge demonstrably happened, and the rule this
  // whole function already follows is that an unreadable commit must never be treated as a
  // squash. Said out loud, because a tick that silently skips the invariant is the invariant
  // silently not existing -- and the next tick's blocked-recovery still compares the ref by
  // ancestry, so a genuine squash is not lost, only noticed later.
  private reportUnverifiable(prNumber: number, read: string): void {
    console.warn(
      `github: PR #${prNumber} merged, but ${read} did not fit in what remained of the ` +
        `asynchronous merge window, so its parent count is unverified this tick`,
    );
  }

  // A read taken WHILE a background merge is in flight, which can never produce a verdict.
  //
  // These polls run inside merge(), so anything they throw escapes as though the MERGE had been
  // refused -- and the control plane's classifier reads a 403 as a permanent refusal and blocks
  // the ticket. That is the same hazard completeOrArmMerge's getPR catch is exempt from, for the
  // same reason: a failed read means the state is UNKNOWN, not that the merge was refused. An
  // installation token rotating mid-poll would otherwise escalate a perfectly healthy merge to a
  // human. So every failure degrades to "no information this poll"; the loop keeps going, and if
  // nothing is ever readable the bounded window ends in the transient 504 below. Only the PUT to
  // merge-async may yield a permanent refusal.
  private async readDuringMerge<T>(path: string, client: GitHubClient = this.client): Promise<T | undefined> {
    try {
      return await client.requestOptional<T>('GET', path);
    } catch (err) {
      console.warn(`github: read of ${path} failed during an asynchronous merge, treating it as unknown: ${String(err)}`);
      return undefined;
    }
  }

  // A background merge that FAILED: permanent. Carries a 403 so the control plane's
  // permanentHostRefusal blocks on the first tick with GitHub's own words, instead of filing it
  // as retryable and inventing a tick-count reason later.
  //
  // `outcome` is the headline, overridable because not every permanent refusal on this path is a
  // merge that failed to finish. confirmMergeCommit's is the opposite: the merge DID complete,
  // with the wrong shape, and "did not complete: it landed as <sha>" contradicts itself in the
  // one line a human reads first.
  private asyncMergeRefusal(
    repoId: string,
    prNumber: number,
    message: string | undefined,
    outcome = 'did not complete',
  ): GitHubApiError {
    return new GitHubApiError(
      403,
      'PUT',
      `/repos/${repoId}/pulls/${prNumber}/merge-async`,
      `asynchronous merge of PR #${prNumber} ${outcome}: ${message ?? 'the host reported no reason'}`,
    );
  }

  async setLabel(repoId: string, target: number, label: string): Promise<void> {
    await this.client.request('POST', `/repos/${repoId}/issues/${target}/labels`, { labels: [label] });
  }

  async listChecks(repoId: string, ref: string): Promise<CheckResult[]> {
    const latest = await this.latestCheckRunsByName(repoId, ref);
    return [...latest.values()].map((run) => ({
      name: run.name,
      status: mapCheckStatus(run.status, run.conclusion),
      ...(run.details_url ? { detailsUrl: run.details_url } : {}),
    }));
  }

  // A re-run leaves MULTIPLE check-runs of the same name on a commit (a failed run, then a
  // green re-run). Keep only the LATEST per name -- otherwise a stale failure masks the newer
  // pass and observeDeployment (deploy-watch) would block a deployment whose gate actually
  // passed, reporting "qa: fail" when qa is green. The gate is still obeyed: a genuinely
  // failing LATEST run blocks. Latest = newest started_at, id as tiebreak. Mirrors
  // reviewDecision's latest-per-user rule. Shared by listChecks (the gating read) and
  // publishCheck's completion fallback (finding the pending run a completion should update).
  private async latestCheckRunsByName(repoId: string, ref: string): Promise<Map<string, GhCheckRun>> {
    const result = await this.client.request<GhCheckRunsResponse>(
      'GET',
      `/repos/${repoId}/commits/${ref}/check-runs?per_page=100`,
    );
    const latest = new Map<string, GhCheckRun>();
    for (const run of result?.check_runs ?? []) {
      if (isNewerCheckRun(run, latest.get(run.name))) latest.set(run.name, run);
    }
    return latest;
  }

  async reviewDecision(repoId: string, prNumber: number): Promise<'approved' | 'changes_requested' | 'pending'> {
    const reviews =
      (await this.client.request<GhReview[]>('GET', `/repos/${repoId}/pulls/${prNumber}/reviews`)) ?? [];

    // Only the latest review per user counts, matching GitHub's own review-decision semantics.
    const latestByUser = new Map<string, GhReview>();
    for (const review of reviews) {
      const login = review.user?.login;
      if (!login || review.state === 'COMMENTED') continue;
      const existing = latestByUser.get(login);
      if (!existing || (review.submitted_at ?? '') >= (existing.submitted_at ?? '')) {
        latestByUser.set(login, review);
      }
    }

    const states = [...latestByUser.values()].map((r) => r.state);
    if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
    if (states.includes('APPROVED')) return 'approved';
    return 'pending';
  }

  async listPrFeedback(repoId: string, prNumber: number): Promise<PrFeedbackReading> {
    // Both endpoints default to oldest-first, 30/page -- so on a busy PR (many Codex
    // re-reviews + human back-and-forth) the NEWEST feedback lands on a later page and a
    // single fetch would miss it, never advancing the cursor. Paginate (bounded) so every
    // review/comment is seen and the cursor's max-id reflects the latest.
    const reviews: GhReview[] = [];
    const comments: GhIssueComment[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch =
        (await this.client.request<GhReview[]>(
          'GET',
          `/repos/${repoId}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
        )) ?? [];
      reviews.push(...batch);
      if (batch.length < 100) break;
    }
    for (let page = 1; page <= 20; page++) {
      const batch =
        (await this.client.request<GhIssueComment[]>(
          'GET',
          `/repos/${repoId}/issues/${prNumber}/comments?per_page=100&page=${page}`,
        )) ?? [];
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    const out: PrFeedback[] = [];
    for (const r of reviews) {
      if (r.id === undefined) continue;
      out.push({
        id: r.id,
        kind: 'review',
        author: r.user?.login ?? '',
        authorIsBot: (r.user?.type ?? '') === 'Bot',
        body: r.body ?? '',
        requestsChanges: r.state === 'CHANGES_REQUESTED',
        approved: r.state === 'APPROVED',
      });
    }
    for (const c of comments) {
      out.push({
        id: c.id,
        kind: 'comment',
        author: c.user?.login ?? '',
        authorIsBot: (c.user?.type ?? '') === 'Bot',
        body: c.body ?? '',
        requestsChanges: false,
        approved: false,
      });
    }

    // Inline review-thread comments aren't returned by the REST reviews/issue-comments
    // endpoints, so fetch them via GraphQL and surface each UNRESOLVED thread's first comment
    // as a `comment` carrying its thread node id (so the fix can resolve exactly that thread).
    // Paginate every page (a PR can carry >100 open threads; dropping the tail silently loses
    // reviewer feedback). A transient GraphQL error is already retried under the breaker by
    // client.request (resilient-request.ts), so a throw here means a non-transient or
    // retry-exhausted failure -- and we still can't rethrow: throwing would drop the REST
    // feedback too. On failure we keep whatever threads we already paged plus the REST feedback
    // and report the reading as 'unreadable', which is what the merge guards hold on. Reporting
    // it as a clean, thread-less read is what let a promotion merge over an open Codex P1 with
    // the guard in place and green.
    //
    // THREE ways the thread read fails, and only one of them is a throw:
    //   1. client.request throws (transport, retry-exhausted, a hard status).
    //   2. GitHub answers HTTP 200 with an `errors[]` array -- its ORDINARY shape for a
    //      permission/scope/field error on /graphql, and for a secondary rate limit. No catch
    //      ever sees this one.
    //   3. HTTP 200, no errors, but the connection isn't there (a null `repository` on a
    //      token that can't see it). "Cannot tell" again, never "no threads".
    let threadsUnreadable: string | undefined;
    const [owner, repo] = repoId.split('/');
    if (!owner || !repo) {
      threadsUnreadable = `"${repoId}" is not an owner/repo id, so its review threads could not be read`;
    }
    if (owner && repo) {
      const query = `query($owner:String!,$repo:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{databaseId body author{login __typename}}}}}}}}`;
      const threads: GhReviewThread[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        let conn: GhReviewThreadsConnection | undefined;
        try {
          const res: GhGraphQLResponse<GhReviewThreadsData> | undefined = await this.client.request<
            GhGraphQLResponse<GhReviewThreadsData>
          >('POST', '/graphql', {
            query,
            variables: { owner, repo, pr: prNumber, after },
          });
          const errors = res?.errors;
          if (Array.isArray(errors) && errors.length > 0) {
            // Case 2: a 200 carrying errors[]. This is what a dropped `read:discussion`, a
            // rotated PAT, an App permission change and a secondary rate limit all look like.
            threadsUnreadable =
              `the review-thread GraphQL query was refused: ` +
              errors.map((e) => e?.message ?? 'unknown error').join('; ');
            break;
          }
          conn = res?.data?.repository?.pullRequest?.reviewThreads;
          if (!conn) {
            // Case 3: a 200 with neither errors nor the connection. Nothing was read.
            threadsUnreadable = 'the review-thread GraphQL query returned no reviewThreads connection';
            break;
          }
        } catch (err) {
          // Case 1: non-transient or retry-exhausted. Keep prior pages + REST, retry next tick.
          threadsUnreadable = `the review-thread GraphQL query failed: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
        threads.push(...(conn?.nodes ?? []));
        if (!conn?.pageInfo?.hasNextPage) break;
        after = conn.pageInfo.endCursor ?? null;
      }
      for (const t of threads) {
        if (!t?.id || t.isResolved) continue;
        const first = t.comments?.nodes?.[0];
        if (!first || first.databaseId === undefined) continue; // no id -> can't cursor on it
        // GraphQL returns a Bot's login WITHOUT the `[bot]` suffix (`chatgpt-codex-connector`),
        // but REST -- and the allowlist the control plane matches against (CODEX_BOT_LOGIN) --
        // uses the suffixed form. Normalize so an inline bot thread is recognized as the same
        // reviewer as its REST review summary; otherwise Codex's line comments are never actioned.
        const isBot = (first.author?.__typename ?? '') === 'Bot';
        const login = first.author?.login ?? '';
        out.push({
          id: first.databaseId,
          kind: 'comment',
          author: isBot && login && !login.endsWith('[bot]') ? `${login}[bot]` : login,
          authorIsBot: isBot,
          body: first.body ?? '',
          requestsChanges: false,
          approved: false,
          threadId: t.id,
        });
      }
    }
    return threadsUnreadable === undefined
      ? { outcome: 'read', feedback: out }
      : { outcome: 'unreadable', feedback: out, reason: threadsUnreadable };
  }

  // The head commit of `ref` and its parent count -- see the VCSHost contract for why the
  // parent count is the fact that matters. `undefined` on ANY failure (a missing ref, a
  // transport fault, a body without a usable sha): the caller reads that as "no evidence",
  // which is the safe direction, and never as "the head did not move".
  async headCommit(repoId: string, ref: string): Promise<{ sha: string; parentCount: number } | undefined> {
    return this.headCommitVia(this.client, repoId, ref);
  }

  // The one reading of "how many parents does this commit have", parameterised by which client
  // takes it: the ordinary one for the watchdog's headCommit above, the short-timeout
  // single-attempt one for confirmMergeCommit's bounded verification.
  private async headCommitVia(
    client: GitHubClient,
    repoId: string,
    ref: string,
  ): Promise<{ sha: string; parentCount: number } | undefined> {
    try {
      const commit = await client.requestOptional<{ sha?: string; parents?: unknown[] }>(
        'GET',
        `/repos/${repoId}/commits/${ref}`,
      );
      if (!commit?.sha) return undefined;
      // A commit with no `parents` array at all is a shape we do not understand, not a root
      // commit -- reporting 0 there would read as "an ordinary push", the permissive answer.
      if (!Array.isArray(commit.parents)) return undefined;
      return { sha: commit.sha, parentCount: commit.parents.length };
    } catch {
      return undefined;
    }
  }

  async collaboratorPermission(repoId: string, login: string): Promise<'admin' | 'write' | 'read' | 'none'> {
    const res = await this.client.requestOptional<GhPermission>(
      'GET',
      `/repos/${repoId}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    // GitHub's `permission` field is admin|write|read|none; the newer roles maintain/triage
    // fold onto write/read for the purpose of "is this actor allowed to drive a fix".
    switch (res?.permission) {
      case 'admin':
        return 'admin';
      case 'write':
      case 'maintain':
        return 'write';
      case 'read':
      case 'triage':
        return 'read';
      default:
        return 'none';
    }
  }

  async protectedRules(repoId: string, branch: string): Promise<{ requiredChecks: string[]; requiresReview: boolean }> {
    // A branch's required checks can come from classic branch protection OR a
    // repository ruleset (e.g. Website's `test-qa-gate` ruleset requires `qa`).
    // Reading only the legacy endpoint silently misses ruleset-required checks
    // and lets a promotion merge past a gate the repo actually enforces -- so
    // read both and union them. (live-readiness 2026-08-19 §4.)
    const protection = await this.client.requestOptional<GhBranchProtection>(
      'GET',
      `/repos/${repoId}/branches/${branch}/protection`,
    );
    const rules =
      (await this.client.requestOptional<GhBranchRule[]>(
        'GET',
        `/repos/${repoId}/rules/branches/${encodeURIComponent(branch)}`,
      )) ?? [];

    const checks = new Set<string>(protection?.required_status_checks?.contexts ?? []);
    let requiresReview = protection?.required_pull_request_reviews != null;

    for (const rule of rules) {
      if (rule.type === 'required_status_checks') {
        for (const c of rule.parameters?.required_status_checks ?? []) {
          if (c?.context) checks.add(c.context);
        }
      }
      if (rule.type === 'pull_request' && (rule.parameters?.required_approving_review_count ?? 0) > 0) {
        requiresReview = true;
      }
    }

    return { requiredChecks: [...checks], requiresReview };
  }

  // Same two reads as protectedRules above -- deliberately BY calling it, so there is exactly one
  // place that knows the endpoints, the union rule and the fail-closed 500 behaviour, and the two
  // can never drift into disagreeing about what this branch requires. The only thing added here is
  // the arm protectedRules cannot have: a fault becomes a VALUE (`unreadable`) instead of a throw,
  // because the drift detector must be able to tell "the ruleset says nothing" from "I could not
  // ask" -- see BranchRulesReading. Note what is NOT caught into `unreadable`: a 404 on the
  // branch-protection endpoint, which GitHub returns for an unprotected branch and which
  // requestOptional already absorbs as the real answer "no classic protection here".
  async readBranchRules(repoId: string, branch: string): Promise<BranchRulesReading> {
    try {
      const rules = await this.protectedRules(repoId, branch);
      return { outcome: 'read', requiredChecks: rules.requiredChecks, requiresReview: rules.requiresReview };
    } catch (err) {
      return { outcome: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async getPR(repoId: string, prNumber: number): Promise<PRStatus> {
    const pr = await this.client.request<GhPullDetail>('GET', `/repos/${repoId}/pulls/${prNumber}`);
    if (!pr) throw new Error(`unknown PR ${prNumber} in ${repoId}`);

    return {
      number: pr.number,
      state: mapPRState(pr.state, pr.merged),
      merged: pr.merged,
      mergeable: mapMergeability(pr.mergeable_state),
      headRef: pr.head.ref,
      ...(pr.head?.sha ? { headSha: pr.head.sha } : {}),
      ...(pr.base?.ref ? { baseRef: pr.base.ref } : {}),
      ...(pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
    };
  }

  async updateBranch(repoId: string, prNumber: number): Promise<void> {
    await this.client.request('PUT', `/repos/${repoId}/pulls/${prNumber}/update-branch`);
  }

  // POST /repos/{owner}/{repo}/merges -- `base` RECEIVES the merge, `head` is merged in.
  // That is the opposite order from how the operation is said in English ("merge test into
  // ticket/x" is base=ticket/x, head=test), so the arguments are named for GitHub's field
  // names rather than for the sentence, and a swap is covered by a test asserting which
  // branch's sha actually moved.
  //
  // Status mapping, per GitHub: 201 = a merge commit was created, 204 = base already
  // contained head, 409 = the merge conflicts, 404 = one of the two refs does not exist.
  // The client hands back a parsed body rather than a status, and only a 201 HAS a body
  // (204 is empty), so the merge commit's presence is what separates the first two.
  async mergeBranch(repoId: string, base: string, head: string): Promise<'merged' | 'up-to-date' | 'conflict'> {
    try {
      const commit = await this.client.request<{ sha?: string }>('POST', `/repos/${repoId}/merges`, {
        base,
        head,
        commit_message: `Merge ${head} into ${base} (autopilot: keep the branch current)`,
      });
      return commit?.sha ? 'merged' : 'up-to-date';
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 409) return 'conflict';
      // A missing ref is deliberately NOT folded into 'up-to-date': the caller uses this
      // result to decide whether the tree it is about to build and gate is current, and
      // "I could not merge" answered as "nothing to merge" is exactly how a stale branch
      // gets gated. Rethrow with both refs named, since GitHub's 404 body says neither.
      if (err instanceof GitHubApiError && err.status === 404) {
        throw new Error(`mergeBranch: no such branch in ${repoId} (base "${base}" or head "${head}")`);
      }
      throw err;
    }
  }

  async getBranchSha(repoId: string, branch: string): Promise<string | undefined> {
    const ref = await this.client.requestOptional<GhRef>('GET', `/repos/${repoId}/git/ref/heads/${branch}`);
    return ref?.object.sha;
  }

  // GitHub's `head` filter is `owner:branch`; the owner is the repo's own owner for
  // every branch Autopilot pushes (we never fork).
  //
  // The owner here comes from the tenant's CONFIGURED repoId, which is spelled however the
  // tenant-store entry spelled it (`tekunda/website`) and may differ in case from the repo's
  // canonical `full_name` (`Tekunda/Website`) -- see sameRepoId in contracts/types.ts. The
  // `/repos/{repoId}` PATH is case-insensitive, but this filter is matched against the stored
  // head LABEL, which is a different matcher, so it needed its own evidence before anything
  // could rely on it. VERIFIED 2026-09-03 against live repos, in the exact percent-encoded wire
  // form this method builds (`:` -> %3A, `/` -> %2F). Pinned against a MERGED head branch with
  // `state=all` so the commands keep reproducing -- an open-PR example stops matching the moment
  // that PR merges, which would quietly turn this evidence into three zeros:
  //   B=autopilot/pipeline-validation-help-center-article-pages-em-build-76186c4f
  //   gh api "repos/Tekunda/Website/pulls?state=all&head=Tekunda%3A$B" -q length  -> 4
  //   gh api "repos/Tekunda/Website/pulls?state=all&head=tekunda%3A$B" -q length  -> 4
  //   gh api "repos/Tekunda/Website/pulls?state=all&head=TEKUNDA%3A$B" -q length  -> 4
  //   gh api "repos/Tekunda/Website/pulls?state=all&head=octocat%3A$B" -q length  -> 0
  // The octocat line is the CONTROL, and it is what makes the other three mean anything: a real
  // but unrelated owner returns 0, so the filter is genuinely being matched rather than ignored.
  // (A filter GitHub silently dropped would return 4 for every spelling too, including octocat.)
  //
  // So the OWNER half is matched case-insensitively and a mis-cased repoId still finds its PR:
  // no canonicalization is needed, and none is done (resolving `full_name` per call would buy
  // nothing and add a metadata request that can fail on a path that must not fail open).
  // The BRANCH half is NOT case-insensitive -- the same query with the branch upper-cased
  // returned 0 -- but branch names are minted by this pipeline and round-trip verbatim, so
  // they never cross the config seam that the owner does.
  //
  // IF THIS EVER FLIPS: the test in vcs-host.test.ts pins OUR assumption via a stub, so it keeps
  // passing no matter what GitHub does -- a server-side change here is SILENT and destructive
  // (mis-cased tenant -> `undefined` -> openPrOn says no PR -> the reset lanes delete the branch
  // -> GitHub closes the open PR with it). Re-running the commands above is the only detection.
  // The real hedge is not more code on this path: it is normalizing repoId against the repo's
  // `full_name` ONCE at tenant registration, so no lookup ever crosses the casing seam. That is
  // a separate task; until it exists, treat the four lines above as the load-bearing evidence.
  async findOpenPR(repoId: string, headBranch: string): Promise<{ url: string; number: number } | undefined> {
    const owner = repoId.split('/')[0];
    const head = encodeURIComponent(`${owner}:${headBranch}`);
    const pulls = await this.client.requestOptional<GhPull[]>(
      'GET',
      `/repos/${repoId}/pulls?state=open&head=${head}&per_page=1`,
    );
    const pr = pulls?.[0];
    return pr ? { url: pr.html_url, number: pr.number } : undefined;
  }

  async listOpenPRs(repoId: string, baseBranch: string): Promise<OpenPR[]> {
    const base = encodeURIComponent(baseBranch);
    // A busy base branch can carry more than one page of open PRs; callers use this list to
    // decide which external-PR pseudo-tickets are still live, so a silent truncation would
    // read a still-open PR past page 1 as closed. Paginate (bounded) like listPrFeedback.
    const pulls: GhListPull[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch =
        (await this.client.requestOptional<GhListPull[]>(
          'GET',
          `/repos/${repoId}/pulls?state=open&base=${base}&per_page=100&page=${page}`,
        )) ?? [];
      pulls.push(...batch);
      if (batch.length < 100) break;
    }
    return pulls.map((p) => ({
      number: p.number,
      url: p.html_url,
      title: p.title ?? '',
      headRef: p.head.ref,
      author: p.user?.login ?? '',
      headRepo: p.head.repo?.full_name ?? '',
    }));
  }

  async closePR(repoId: string, prNumber: number): Promise<void> {
    await this.client.request('PATCH', `/repos/${repoId}/pulls/${prNumber}`, { state: 'closed' });
  }

  // A branch that's already gone is the desired end state, so a 404 from the delete is
  // success, not an error (requestOptional swallows it).
  async deleteBranch(repoId: string, branch: string): Promise<void> {
    await this.client.requestOptional('DELETE', `/repos/${repoId}/git/refs/heads/${branch}`);
  }

  // Publishes a check-run on the ref's head commit. Needs the App's `checks: write`
  // permission -- with only `checks: read` this call fails and the caller (which treats
  // publishing as best-effort) reports the failure rather than silently dropping it.
  //
  // Id-aware: create-only publishing (every call POSTing a fresh check-run) left a `pending`
  // progress check permanently `in_progress` once its completion published a SEPARATE
  // check-run of the same name -- the human-visible run never transitioned, hiding the
  // completion's findings/summary (they only ever landed on the orphaned second run). A
  // `checkRunId` from a caller that captured one PATCHes that exact run. Without one, a
  // COMPLETING publish (pass/fail) falls back to the same latest-wins lookup listChecks uses
  // to find the latest same-name run on this sha and PATCHes it -- so a stray pending left by
  // an exception, a superseded round, or a fresh process still completes rather than orphaning.
  // A fresh `pending` publish (a new stage generation) always POSTs: it must not resurrect an
  // older run's identity.
  async publishCheck(repoId: string, ref: string, check: PublishedCheck, checkRunId?: number): Promise<{ id: number }> {
    const sha = (await this.getBranchSha(repoId, ref)) ?? ref;
    // A skipped gate is FINISHED, it just never ran, and a superseded stage is finished too --
    // its run was cancelled before it could report. Both must be published `completed`; only a
    // genuinely running stage stays in_progress, or it hangs on the PR forever (Website PR
    // #1453 sat on an `Autopilot / gate` in_progress whose run had been cancelled, BLOCKED).
    const completes = check.status !== 'pending' || check.skipped === true || check.cancelled === true;
    const payload = {
      name: check.name,
      head_sha: sha,
      status: completes ? 'completed' : 'in_progress',
      ...(completes
        ? {
            conclusion: check.cancelled
              ? 'cancelled'
              : check.skipped
                ? 'skipped'
                : check.status === 'pass'
                  ? 'success'
                  : 'failure',
          }
        : {}),
      ...(check.detailsUrl ? { details_url: check.detailsUrl } : {}),
      output: {
        title: check.title ?? check.name,
        summary: check.summary ?? '',
      },
    };

    let targetId = checkRunId;
    // Deliberately excludes `cancelled`: a supersede only ever concludes the check-run id its
    // own marker recorded. Hunting for a same-name pending run to cancel could conclude a
    // check belonging to a stage that is genuinely still running.
    if (targetId === undefined && (check.status !== 'pending' || check.skipped)) {
      const latest = await this.latestCheckRunsByName(repoId, sha);
      const candidate = latest.get(check.name);
      // Only a STRAY PENDING run is fair game here -- a completed run past its own
      // conclusion must never be silently re-PATCHed under this completion's (unrelated)
      // verdict/timestamp. If the latest same-name run already completed, fall through to
      // POST: gating is unaffected either way (listChecks reads the newest run), this only
      // keeps the fallback from touching a run it wasn't meant to touch.
      if (candidate && candidate.status !== 'completed') targetId = candidate.id;
    }

    if (targetId !== undefined) {
      const updated = await this.client.request<{ id: number }>('PATCH', `/repos/${repoId}/check-runs/${targetId}`, payload);
      return { id: updated?.id ?? targetId };
    }

    const created = await this.client.request<{ id: number }>('POST', `/repos/${repoId}/check-runs`, payload);
    if (!created) throw new Error(`GitHub returned no body for created check-run "${check.name}" in ${repoId}`);
    return { id: created.id };
  }

  // The read half of publishCheck (see the VCSHost contract). One GET, no pagination: the
  // check-run is addressed by the id publishCheck returned, so there is no name/ref matching to
  // get wrong.
  //
  // Fail-safe by construction. `requestOptional` maps a 404 to undefined and rethrows everything
  // else, so the catch turns every OTHER failure (5xx, rate limit, breaker cooldown, transport)
  // into undefined too, and an unrecognised status string is undefined as well. All three mean
  // "could not be read", which is the SAFE side here -- the sweep leaves the check-run pending
  // and surfaces it. That is the opposite of the aheadBy shape, where "cannot compare" degraded
  // into 0 and looked exactly like a real answer.
  async checkRunStatus(repoId: string, checkRunId: number): Promise<CheckRunSnapshot | undefined> {
    try {
      const run = await this.client.requestOptional<{ status?: string; name?: string }>(
        'GET',
        `/repos/${repoId}/check-runs/${checkRunId}`,
      );
      const status = run?.status;
      if (status !== 'queued' && status !== 'in_progress' && status !== 'completed') return undefined;
      // A run with no name is as unusable as one with no status: the completing publish would
      // have to invent one, so report it as unread rather than half-read.
      if (!run?.name) return undefined;
      return { status, name: run.name };
    } catch {
      return undefined;
    }
  }

  // Every check-run THIS APP still holds open on `ref`'s head commit -- the discovery half of
  // the ghost story (see the VCSHost contract). `filter=all` on purpose: GitHub's default
  // `filter=latest` returns one run per name, which hides an older stranded run behind a newer
  // one of the same name, and a hidden orphan is exactly the state this lane exists to end.
  //
  // Two independent ownership guards, because this is the one read whose results are acted on
  // without any id we recorded ourselves: the `app_id` query narrows the listing server-side,
  // and every row is re-checked against `this.appId` client-side, so a host that ignored the
  // query parameter cannot smuggle a foreign check-run through. With no app id at all the
  // answer is `undefined` ("cannot determine"), never `[]` -- an unattributable listing must
  // not read as "this ref has no orphans".
  async listOpenCheckRuns(repoId: string, ref: string): Promise<OpenCheckRun[] | undefined> {
    const appId = this.appId;
    if (appId === undefined) return undefined;
    try {
      const sha = (await this.getBranchSha(repoId, ref)) ?? ref;
      const result = await this.client.request<GhCheckRunsResponse>(
        'GET',
        `/repos/${repoId}/commits/${sha}/check-runs?per_page=100&filter=all&app_id=${appId}`,
      );
      // No body is not an empty ref: `request` resolves undefined for a response GitHub sent
      // with nothing in it, which says nothing about what is open on the commit.
      if (!result) return undefined;
      return (result.check_runs ?? [])
        .filter((run) => run.status !== 'completed' && run.app?.id === appId)
        .map((run) => ({
          id: run.id,
          name: run.name,
          ...(run.started_at ? { startedAt: run.started_at } : {}),
          ...(run.details_url ? { detailsUrl: run.details_url } : {}),
          ...(run.app?.id !== undefined ? { appId: run.app.id } : {}),
        }));
    } catch {
      return undefined;
    }
  }

  async rerunDeployment(repoId: string, ref: string): Promise<boolean> {
    // Resolve a branch name to its head sha (a pinned ref is already a sha; getBranchSha
    // returns undefined for a sha, so fall back to `ref`).
    const sha = (await this.getBranchSha(repoId, ref)) ?? ref;
    const runs = await this.client.requestOptional<{ workflow_runs?: GhWorkflowRun[] }>(
      'GET',
      `/repos/${repoId}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`,
    );
    // Re-run the failed jobs of every failed run on this commit. rerun-failed-jobs is
    // idempotent-friendly (only the failed jobs re-execute) and cheaper than a full rerun.
    const failed = (runs?.workflow_runs ?? []).filter((r) => isFailedConclusion(r.conclusion));
    let reran = false;
    for (const run of failed) {
      try {
        await this.client.request('POST', `/repos/${repoId}/actions/runs/${run.id}/rerun-failed-jobs`);
        reran = true;
      } catch {
        // A run that can't be re-run (too old, already re-running) is skipped, not fatal.
      }
    }
    return reran;
  }

  async resolveReviewThreads(repoId: string, prNumber: number, threadIds: string[]): Promise<number> {
    if (threadIds.length === 0) return 0;
    let resolved = 0;
    for (const id of threadIds) {
      if (!id) continue;
      try {
        await this.client.request('POST', '/graphql', {
          query: `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`,
          variables: { id },
        });
        resolved += 1;
      } catch {
        // A thread that can't be resolved (already resolved by a race, permission) is skipped.
      }
    }
    return resolved;
  }

  async aheadBy(repoId: string, baseBranch: string, headBranch: string): Promise<number> {
    const cmp = await this.client.requestOptional<{ ahead_by?: number }>(
      'GET',
      `/repos/${repoId}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`,
    );
    return cmp?.ahead_by ?? 0;
  }

  // Same endpoint as aheadBy, read honestly: a 404 (deleted/unknown ref) or a response missing
  // either count resolves undefined -- "the comparison could not be made" -- instead of being
  // flattened into a 0 that reads as "no divergence". Any other API error still throws, so a
  // caller that treats absence as proof-of-nothing can also treat a throw that way.
  async compareRefs(repoId: string, base: string, head: string): Promise<{ aheadBy: number; behindBy: number } | undefined> {
    const cmp = await this.client.requestOptional<{ ahead_by?: number; behind_by?: number }>(
      'GET',
      `/repos/${repoId}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (typeof cmp?.ahead_by !== 'number' || typeof cmp.behind_by !== 'number') return undefined;
    return { aheadBy: cmp.ahead_by, behindBy: cmp.behind_by };
  }

  // Same three-dot compare compareRefs reads, for its file list rather than its counts.
  // Honest about ignorance for the same reason: a 404 (requestOptional) or a response carrying
  // no `files` array resolves `undefined` -- "I could not ask" -- and never an empty list a
  // caller could read as "nothing changed, so this diff is trivial".
  async listChangedFiles(
    repoId: string,
    base: string,
    head: string,
  ): Promise<{ files: string[]; truncated: boolean } | undefined> {
    const cmp = await this.client.requestOptional<{ files?: { filename?: string }[] }>(
      'GET',
      `/repos/${repoId}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (!Array.isArray(cmp?.files)) return undefined;
    const files = cmp.files.map((f) => f?.filename).filter((n): n is string => typeof n === 'string' && n.length > 0);
    // GitHub's compare endpoint returns AT MOST 300 files in one response, so a full page is
    // the practical signal that the listing was capped: the paths are real but incomplete, and
    // any size-derived reading of them is a lower bound.
    return { files, truncated: cmp.files.length >= COMPARE_FILE_PAGE_LIMIT };
  }

  async replyToPr(repoId: string, prNumber: number, body: string): Promise<void> {
    await this.client.request('POST', `/repos/${repoId}/issues/${prNumber}/comments`, { body });
  }

  // COMMENT, never REQUEST_CHANGES: a request-changes review from the app would block the
  // very merge this pipeline is driving, and on a repo requiring review dismissal it needs a
  // human to clear it -- the opposite of surfacing findings for the fixer. The severity is
  // already carried in the summary body and in the `Autopilot / review` check.
  // The summary body only. This posts no `comments` array, so GitHub opens no review thread --
  // see VCSHost.createReview for why an inline comment from this identity wedges the promotion
  // it is reviewing. The retry that used to re-post without comments when GitHub rejected an
  // out-of-diff anchor went with them: with nothing to anchor there is nothing to reject, so a
  // failure here is a real failure and is left to the caller's best-effort catch.
  async createReview(repoId: string, prNumber: number, review: { body: string }): Promise<void> {
    await this.client.request('POST', `/repos/${repoId}/pulls/${prNumber}/reviews`, {
      body: review.body,
      event: 'COMMENT',
    });
  }

  // Resolves a failing check's job-log evidence. The name-based lookup on the head
  // (latest wins, same rule as listChecks) is ONLY the gate -- it answers "is this
  // named check actually red on this sha". Jobs can NEVER be enumerated through the
  // check-run: /check-runs/{id}/jobs is not a GitHub endpoint (every production call
  // 404'd silently and the fixer got zero evidence). Jobs live under the Actions API,
  // keyed by WORKFLOW-RUN id: list the commit's completed workflow runs by head sha,
  // failures first / newest first, then walk each run's jobs for conclusion=failure.
  // Resolution goes by name + headSha, strictly more current than a captured URL. All
  // reads degrade to undefined: requestText swallows any log-read failure, and a jobs
  // read that throws (403 = token lacks actions:read) lands in the catch below --
  // absence of evidence never breaks the drive loop. Non-Actions producers expose no
  // workflow runs, so their checks yield undefined.
  async getCheckLogTail(
    repoId: string,
    checkRef: { name: string; headSha?: string },
    maxLines = DEFAULT_CHECK_LOG_TAIL_LINES,
  ): Promise<string | undefined> {
    try {
      if (!checkRef.headSha) return undefined;
      const sha = (await this.getBranchSha(repoId, checkRef.headSha)) ?? checkRef.headSha;

      // Gate: confirm THIS named check is red on THIS sha before spending Actions reads
      // (a green re-run means there is nothing left to diagnose).
      const checkRuns = await this.client.request<GhCheckRunsResponse>(
        'GET',
        `/repos/${repoId}/commits/${sha}/check-runs?per_page=100`,
      );
      const check = latestNamedRun(checkRuns?.check_runs ?? [], checkRef.name);
      if (!check || mapCheckStatus(check.status, check.conclusion) !== 'fail') return undefined;

      // Same shape rerunDeployment uses below: Actions runs are keyed by head sha.
      const listed = await this.client.requestOptional<{ workflow_runs?: GhWorkflowRun[] }>(
        'GET',
        `/repos/${repoId}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`,
      );
      // startup_failure has no jobs to read, but it still sorts ahead of the green runs.
      const failedConclusion = (r: GhWorkflowRun): boolean =>
        isFailedConclusion(r.conclusion) || r.conclusion === 'startup_failure';
      const startedAt = (r: GhWorkflowRun): string => r.run_started_at ?? r.created_at ?? '';
      // Failures diagnose a red check; other conclusions are a last resort. Newest first
      // within each tier -- a re-run supersedes its ancestor.
      const runs = (listed?.workflow_runs ?? [])
        .filter((r) => r.status === 'completed')
        .sort((a, b) =>
          failedConclusion(a) === failedConclusion(b)
            ? startedAt(b).localeCompare(startedAt(a))
            : failedConclusion(a)
              ? -1
              : 1,
        );

      const targets: GhJob[] = [];
      for (const run of runs) {
        if (targets.length >= MAX_CHECK_LOG_JOBS) break;
        const jobsOnRun = await this.client.request<{ jobs?: GhJob[] }>(
          'GET',
          `/repos/${repoId}/actions/runs/${run.id}/jobs?per_page=100`,
        );
        // Only genuinely failed jobs carry diagnostic logs; higher job ids are the
        // newer attempts/shards within the run. A job that timed out or was cancelled is
        // red too (same convention rerunDeployment uses) and its log holds the evidence --
        // for a timeout, the hung step is the ONLY place that evidence exists.
        const failingJobs = (jobsOnRun?.jobs ?? [])
          .filter((j) => isFailedConclusion(j.conclusion))
          .sort((a, b) => b.id - a.id);
        targets.push(...failingJobs.slice(0, MAX_CHECK_LOG_JOBS - targets.length));
      }
      if (targets.length === 0) return undefined;
      // The line budget is split across job sections (header + each job's last lines), so
      // every section keeps its `## job` label and the whole result stays within maxLines.
      const perJobLines = Math.max(0, Math.floor((maxLines - targets.length) / targets.length));
      const sections: string[] = [];
      for (const job of targets) {
        // requestText caps each log READ at 512KB (memory bound on a multi-MB job log): a
        // failure living beyond the cap yields no tail for this section -- diagnostic-only
        // loss; the check's own status still gates.
        const log = await this.client.requestText('GET', `/repos/${repoId}/actions/jobs/${job.id}/logs`);
        if (!log) continue;
        sections.push(`## ${job.name}\n${logTail(redactSecrets(log), perJobLines)}`);
      }
      if (sections.length === 0) return undefined;
      return sections.join('\n');
    } catch {
      return undefined; // contract: absence never throws (unknown check, transient, permission)
    }
  }

  // Atomic create-if-not-exists via git ref creation: POST /git/refs is 201 for the first
  // creator and 422 "Reference already exists" for every one after (the replay signal). Only
  // that specific 422 becomes 'exists'; any OTHER 422 (e.g. "Object does not exist" for a bad
  // sha) and every other failure throws, so the caller fails-open rather than mistaking an
  // unrelated error for a replay.
  // COUPLING (re-verify if it ever misbehaves): the replay-vs-other-422 distinction is a match
  // on GitHub's error WORDING (/already exists/i), not a machine-readable code the API exposes.
  // If GitHub reworded that message, a genuine "already exists" 422 would fall through to `throw`
  // -> the caller fails open -> the replay proceeds. That's consistent with the module's fail-open
  // stance (a replay is resource-abuse, not priv-esc), but the guard silently weakens, so a future
  // reader who sees replays slipping through should check this string first.
  async createClaimRef(repoId: string, ref: string, sha: string): Promise<ClaimRefResult> {
    try {
      await this.client.request('POST', `/repos/${repoId}/git/refs`, { ref, sha });
      return 'created';
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422 && /already exists/i.test(err.message)) {
        return 'exists';
      }
      throw err;
    }
  }

  async listClaimRefs(repoId: string): Promise<string[]> {
    // matching-refs takes the ref WITHOUT the leading `refs/` and returns every ref under it.
    // 200 with [] when none match (never 404 for a valid namespace); requestOptional guards a
    // repo/namespace that returns 404 anyway. PAGINATE (bounded): the endpoint pages at ~30/ref
    // by default, so a single fetch would show the GC sweep only page 1 and leak every claim ref
    // beyond it. The claim names DO sort the oldest/expired first onto page 1 today (equal-length
    // 13-digit `<epochMs>-` prefixes sort ascending), but relying on that is a latent assumption --
    // walk every page so GC provably sees them all regardless of volume or naming. Same page-100/
    // stop-on-short-batch shape listOpenPRs/listPrFeedback use.
    const refs: GhNamedRef[] = [];
    for (let page = 1; page <= 50; page++) {
      const batch =
        (await this.client.requestOptional<GhNamedRef[]>(
          'GET',
          `/repos/${repoId}/git/matching-refs/autopilot-claims/?per_page=100&page=${page}`,
        )) ?? [];
      refs.push(...batch);
      if (batch.length < 100) break;
    }
    return refs.map((r) => r.ref).filter((ref): ref is string => typeof ref === 'string');
  }

  // A claim ref already gone is the desired end state, so a 404 from the delete is success
  // (requestOptional swallows it). The endpoint wants the ref without its leading `refs/`.
  async deleteClaimRef(repoId: string, ref: string): Promise<void> {
    await this.client.requestOptional('DELETE', `/repos/${repoId}/git/refs/${ref.replace(/^refs\//, '')}`);
  }
}

interface GhNamedRef {
  ref: string;
  object: { sha: string };
}

interface GhWorkflowRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  created_at?: string | null;
  run_started_at?: string | null;
}

interface GhReviewThread {
  id: string;
  isResolved: boolean;
  comments?: {
    nodes?: {
      databaseId?: number;
      body?: string;
      author?: { login?: string; __typename?: string } | null;
    }[];
  };
}

interface GhReviewThreadsConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: GhReviewThread[];
}

interface GhReviewThreadsData {
  repository?: { pullRequest?: { reviewThreads?: GhReviewThreadsConnection } };
}

// GitHub's /graphql envelope. `errors` is the half that matters here: a permission/scope/field
// refusal and a secondary rate limit both arrive as HTTP 200 with `errors[]` and a `data` whose
// fields are null -- indistinguishable, to any code that only inspects `data`, from a genuine
// "this pull request has no review threads".
interface GhGraphQLResponse<T> {
  data?: T;
  errors?: { message?: string }[];
}

function mapPRState(state: string, merged: boolean): 'open' | 'closed' | 'merged' {
  if (merged) return 'merged';
  return state === 'open' ? 'open' : 'closed';
}

function mapCheckStatus(status: string, conclusion: string | null): 'pass' | 'fail' | 'pending' {
  if (status !== 'completed') return 'pending';
  return conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped' ? 'pass' : 'fail';
}

// The newest check-run of one name on a commit -- the same latest-wins rule listChecks
// applies across all names, scoped to the single failing check a log tail was asked for.
function latestNamedRun(runs: GhCheckRun[], name: string): GhCheckRun | undefined {
  let best: GhCheckRun | undefined;
  for (const run of runs) {
    if (run.name !== name) continue;
    if (isNewerCheckRun(run, best)) best = run;
  }
  return best;
}

// Shared "is `candidate` newer than `current`" rule for the latest-per-name dedup: newest
// started_at wins, id as tiebreak. One definition, used by listChecks (via
// latestCheckRunsByName), publishCheck's completion fallback, and getCheckLogTail's
// latestNamedRun -- so the three never drift apart on what "latest" means.
function isNewerCheckRun(candidate: GhCheckRun, current: GhCheckRun | undefined): boolean {
  return (
    !current ||
    (candidate.started_at ?? '') > (current.started_at ?? '') ||
    ((candidate.started_at ?? '') === (current.started_at ?? '') && (candidate.id ?? 0) > (current.id ?? 0))
  );
}

const DEFAULT_CHECK_LOG_TAIL_LINES = 150;
const MAX_CHECK_LOG_JOBS = 3;

// One convention for "this workflow run / job went red", shared by rerunDeployment and
// getCheckLogTail. A timed-out or cancelled job is an ordinary CI failure -- treating only
// `failure` as red made a check that went red by timeout yield zero log evidence.
function isFailedConclusion(conclusion: string | null | undefined): boolean {
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled';
}

// Line-level secret redaction for log text crossing the split plane. Conservative:
// mask the VALUE, keep the surrounding structure, so the fixer still sees what ran.
// Covers the common token shapes (GitHub/App PATs, AWS access keys, Slack tokens,
// Authorization/Bearer headers) plus password/secret/token/api-key assignments in
// shell/env/log forms (`github_token=...`, `PASSWORD: ...`).
const SECRET_PATTERNS: [RegExp, string][] = [
  [/gh[posur]_[A-Za-z0-9_]{16,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|\S+)/gi, '$1***'],
  // PEM private keys span lines; a leaked key block must never survive truncation to a prompt.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '***private key***'],
  // ...and the text handed here is itself already byte-capped upstream (requestText reads
  // at most 512KB of a job log), so a key block can STRADDLE that cut: its BEGIN line is
  // kept, its END delimiter was never read, and the pattern above -- which needs the closing
  // delimiter -- would leave the key material in the clear. Every complete block is gone by
  // now, so an opener with no closer means exactly that straddle: redact it to the end.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, '***private key***'],
  // JWTs (three base64url segments) carry embedded secrets and are high-entropy enough to spot.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '***'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function logTail(text: string, maxLines: number): string {
  const lines = text.split('\n');
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join('\n');
}

// GitHub's mergeable_state has more values than the watchdog needs to act
// on (blocked, unstable, draft, has_hooks, ...) -- everything but a clean
// merge, a real conflict, or a stale base collapses to 'unknown' so the
// watchdog leaves it alone rather than guessing.
function mapMergeability(state: string): PRStatus['mergeable'] {
  if (state === 'clean') return 'clean';
  if (state === 'dirty') return 'dirty';
  if (state === 'behind') return 'behind';
  return 'unknown';
}
