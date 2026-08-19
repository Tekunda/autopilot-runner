// Minimal REST client for the GitHub API. No dependencies beyond the global
// fetch (Node 24) — adapters stay dependency-free so package.json doesn't
// conflict while adapters build in parallel. See AGENTS.md.

import type { TokenProvider } from '../shared/token-provider.ts';

export type { TokenProvider } from '../shared/token-provider.ts';

export interface GitHubClientConfig {
  /**
   * A static GitHub personal access token. Never logged. Supply exactly one of
   * `token` or `tokenProvider` — for a real customer install, that's an App
   * installation-token provider (control-plane/github-app.ts), not a PAT.
   */
  token?: string;
  /** Resolves a fresh token on every request, e.g. a cached App installation token. */
  tokenProvider?: TokenProvider;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real GitHub API. */
  baseUrl?: string;
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, method: string, path: string, message: string) {
    super(`GitHub API ${method} ${path} failed: ${status} ${message}`);
    this.status = status;
  }
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly resolveToken: TokenProvider;

  constructor(config: GitHubClientConfig) {
    if (!config.token && !config.tokenProvider) {
      throw new Error('GitHubClient: one of token or tokenProvider is required');
    }
    this.resolveToken = config.tokenProvider ?? (async () => config.token as string);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.baseUrl = config.baseUrl ?? 'https://api.github.com';
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const token = await this.resolveToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const data: unknown = text.length > 0 ? JSON.parse(text) : undefined;

    if (!res.ok) {
      const message = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText;
      throw new GitHubApiError(res.status, method, path, message);
    }

    return data as T | undefined;
  }

  /** Like request(), but resolves to undefined instead of throwing on a 404. */
  async requestOptional<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    try {
      return await this.request<T>(method, path, body);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return undefined;
      throw err;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
