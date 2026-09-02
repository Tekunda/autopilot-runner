// GitHub implementation of the VCSHost contract (src/contracts/adapters.ts).

import type { ClaimRefResult, OpenPR, PrFeedback, PublishedCheck, VCSHost } from '../../contracts/adapters.ts';
import type { CheckResult, CheckRunSnapshot, PRStatus } from '../../contracts/types.ts';
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

export class GitHubVCSHost implements VCSHost {
  private readonly client: GitHubClient;

  constructor(config: GitHubClientConfig) {
    this.client = new GitHubClient(config);
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

  async merge(repoId: string, prNumber: number): Promise<void> {
    await this.client.request('PUT', `/repos/${repoId}/pulls/${prNumber}/merge`);
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

  async listPrFeedback(repoId: string, prNumber: number): Promise<PrFeedback[]> {
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
    // retry-exhausted failure -- and we still can't rethrow: the caller wraps this in
    // `.catch(() => [])`, so throwing would drop the REST feedback too. On failure we keep
    // whatever threads we already paged plus the REST feedback, and let the next tick re-read
    // (the missing threads stay below the cursor, so they aren't marked seen).
    const [owner, repo] = repoId.split('/');
    if (owner && repo) {
      const query = `query($owner:String!,$repo:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{databaseId body author{login __typename}}}}}}}}`;
      const threads: GhReviewThread[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        let conn: GhReviewThreadsConnection | undefined;
        try {
          const res: { data?: GhReviewThreadsData } | undefined = await this.client.request<{ data?: GhReviewThreadsData }>('POST', '/graphql', {
            query,
            variables: { owner, repo, pr: prNumber, after },
          });
          conn = res?.data?.repository?.pullRequest?.reviewThreads;
        } catch {
          break; // non-transient or retry-exhausted: keep prior pages + REST, retry next tick
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
    return out;
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

  async replyToPr(repoId: string, prNumber: number, body: string): Promise<void> {
    await this.client.request('POST', `/repos/${repoId}/issues/${prNumber}/comments`, { body });
  }

  // COMMENT, never REQUEST_CHANGES: a request-changes review from the app would block the
  // very merge this pipeline is driving, and on a repo requiring review dismissal it needs a
  // human to clear it -- the opposite of surfacing findings for the fixer. The severity is
  // already carried in each comment's text and in the `Autopilot / review` check.
  async createReview(
    repoId: string,
    prNumber: number,
    review: { body: string; comments?: { path: string; line: number; body: string }[] },
  ): Promise<void> {
    // Inline comments are posted in one review so they land as a single conversation rather
    // than N notifications. GitHub rejects the WHOLE review if any anchor is outside the
    // diff, so retry bodyless on failure: the summary is what must not be lost.
    const comments = (review.comments ?? []).map((c) => ({ path: c.path, line: c.line, body: c.body }));
    try {
      await this.client.request('POST', `/repos/${repoId}/pulls/${prNumber}/reviews`, {
        body: review.body,
        event: 'COMMENT',
        ...(comments.length ? { comments } : {}),
      });
    } catch (err) {
      if (!comments.length) throw err;
      await this.client.request('POST', `/repos/${repoId}/pulls/${prNumber}/reviews`, {
        body: review.body,
        event: 'COMMENT',
      });
    }
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
