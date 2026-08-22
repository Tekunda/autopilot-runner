// GitHub implementation of the VCSHost contract (src/contracts/adapters.ts).

import type { OpenPR, PublishedCheck, VCSHost } from '../../contracts/adapters.ts';
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
}

interface GhCheckRunsResponse {
  check_runs: GhCheckRun[];
}

interface GhReview {
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
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
      `/repos/${repoId}/commits/${ref}/check-runs`,
    );

    return (result?.check_runs ?? []).map((run) => ({
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
