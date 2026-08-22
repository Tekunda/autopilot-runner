// GitHub implementation of the VCSHost contract (src/contracts/adapters.ts).

import type { OpenPR, PrFeedback, PublishedCheck, VCSHost } from '../../contracts/adapters.ts';
import type { CheckResult, PRStatus } from '../../contracts/types.ts';
import { GitHubClient, type GitHubClientConfig } from './rest.ts';

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
  head: { ref: string };
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
    const result = await this.client.request<GhCheckRunsResponse>(
      'GET',
      `/repos/${repoId}/commits/${ref}/check-runs?per_page=100`,
    );

    // A re-run leaves MULTIPLE check-runs of the same name on a commit (a failed run, then a
    // green re-run). Keep only the LATEST per name -- otherwise a stale failure masks the newer
    // pass and observeDeployment (deploy-watch) would block a deployment whose gate actually
    // passed, reporting "qa: fail" when qa is green. The gate is still obeyed: a genuinely
    // failing LATEST run blocks. Latest = newest started_at, id as tiebreak. Mirrors
    // reviewDecision's latest-per-user rule.
    const latest = new Map<string, GhCheckRun>();
    for (const run of result?.check_runs ?? []) {
      const prev = latest.get(run.name);
      const newer =
        !prev ||
        (run.started_at ?? '') > (prev.started_at ?? '') ||
        ((run.started_at ?? '') === (prev.started_at ?? '') && (run.id ?? 0) > (prev.id ?? 0));
      if (newer) latest.set(run.name, run);
    }

    return [...latest.values()].map((run) => ({
      name: run.name,
      status: mapCheckStatus(run.status, run.conclusion),
      ...(run.details_url ? { detailsUrl: run.details_url } : {}),
    }));
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
    // reviewer feedback). A transient GraphQL error is retried once per page rather than
    // silently swallowed -- but we still can't throw on repeated failure: the caller wraps this
    // in `.catch(() => [])`, so throwing would drop the REST feedback too. On repeated failure
    // we keep whatever threads we already paged plus the REST feedback, and let the next tick
    // re-read (the missing threads stay below the cursor, so they aren't marked seen).
    const [owner, repo] = repoId.split('/');
    if (owner && repo) {
      const query = `query($owner:String!,$repo:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{databaseId body author{login __typename}}}}}}}}`;
      const threads: GhReviewThread[] = [];
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        let conn: GhReviewThreadsConnection | undefined;
        let failed = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await this.client.request<{ data?: GhReviewThreadsData }>('POST', '/graphql', {
              query,
              variables: { owner, repo, pr: prNumber, after },
            });
            conn = res?.data?.repository?.pullRequest?.reviewThreads;
            failed = false;
            break;
          } catch {
            failed = true;
          }
        }
        if (failed) break; // repeated failure: keep prior pages + REST, retry next tick
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
      ...(pr.base?.ref ? { baseRef: pr.base.ref } : {}),
    };
  }

  async updateBranch(repoId: string, prNumber: number): Promise<void> {
    await this.client.request('PUT', `/repos/${repoId}/pulls/${prNumber}/update-branch`);
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
    const pulls = await this.client.requestOptional<GhListPull[]>(
      'GET',
      `/repos/${repoId}/pulls?state=open&base=${base}&per_page=100`,
    );
    return (pulls ?? []).map((p) => ({
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
  async publishCheck(repoId: string, ref: string, check: PublishedCheck): Promise<void> {
    const sha = (await this.getBranchSha(repoId, ref)) ?? ref;
    await this.client.request('POST', `/repos/${repoId}/check-runs`, {
      name: check.name,
      head_sha: sha,
      status: check.status === 'pending' ? 'in_progress' : 'completed',
      ...(check.status === 'pending' ? {} : { conclusion: check.status === 'pass' ? 'success' : 'failure' }),
      ...(check.detailsUrl ? { details_url: check.detailsUrl } : {}),
      output: {
        title: check.title ?? check.name,
        summary: check.summary ?? '',
      },
    });
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
    const failed = (runs?.workflow_runs ?? []).filter(
      (r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled',
    );
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

  async replyToPr(repoId: string, prNumber: number, body: string): Promise<void> {
    await this.client.request('POST', `/repos/${repoId}/issues/${prNumber}/comments`, { body });
  }
}

interface GhWorkflowRun {
  id: number;
  conclusion: string | null;
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
