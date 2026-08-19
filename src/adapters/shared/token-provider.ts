// Shared auth seam for GitHub-speaking adapters (github/rest.ts, github-actions/ci-runner.ts).
// A TokenProvider resolves a fresh token on every call, letting a caller plug in a cached,
// auto-refreshing App installation token (control-plane/github-app.ts) anywhere a static PAT
// works today. See docs/architecture.md §1-2 and AGENTS.md ("own the state").
export type TokenProvider = () => Promise<string>;
