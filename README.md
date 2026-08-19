# Delivery Autopilot — Thin Runner

The **public, IP-free runner** for [Delivery Autopilot](https://tekunda.com). It takes a
ticket from your tracker to a verified, reviewed pull request — planned, built, gated, and
self-healed by an agent pipeline — while **your source code never leaves your CI**.

This repository holds **no product logic**: no engine, no prompts, no gate or pack
algorithms. It is a single generic GitHub Action that the Delivery Autopilot **control
plane** (Tekunda's closed, hosted service) dispatches once per stage. Because it is
IP-free, it is safe to run in your own repository and safe to publish here.

## How it works (the split plane)

```
Your repo (your GitHub Actions)              Tekunda control plane (our servers)
──────────────────────────────              ───────────────────────────────────
                                    ┌── reads your tickets, checks entitlement,
                                    │     issues a SIGNED, single-use grant
  runner.yml  ◀──── dispatch ───────┘     (which stage, the JIT prompt, the policy)
   • checks out YOUR repo (your token)
   • runs the vendor coding agent          the grant is the ONLY thing that crosses in
     (Claude Code, your OAuth key)
   • runs the JIT gate specs from the grant
   • opens the PR
   • reports status telemetry ─────────▶   advances state; NEVER sees your source
     (pass/fail, PR url, log digest)         or a diff
```

Only a **signed execution grant** crosses in and **status telemetry** crosses back —
**never your source code, never a diff, never a secret.** The runner verifies every
grant's signature against your configured public key before doing anything.

## Setup

### Option A — GitHub App (recommended)

Install the **Delivery Autopilot** GitHub App on the repositories you want it to drive.
The App provisions the `runner.yml` workflow and wires the control plane to your repo. You
only supply your model credential (below). *(Ask Tekunda for your install link.)*

### Option B — Manual

1. **Add the workflow.** Create `.github/workflows/runner.yml` in your repo:

   ```yaml
   name: Autopilot Runner
   run-name: "Autopilot ${{ fromJSON(inputs.grant).stage }}: ${{ fromJSON(inputs.grant).ticketTitle || fromJSON(inputs.grant).ticketId }}"

   on:
     workflow_dispatch:
       inputs:
         grant:
           description: Signed ExecutionGrant JSON issued by the control plane.
           required: true
         gate-target:
           description: GateTarget JSON — gate stages only.
           required: false
           default: '{}'

   jobs:
     run-stage:
       runs-on: ubuntu-latest
       permissions:
         contents: write        # create the coding branch + open the PR (never reads source server-side)
         pull-requests: write
         id-token: write
       steps:
         - name: Run stage via Delivery Autopilot
           uses: Tekunda/autopilot-runner@<PINNED_SHA>   # always pin to a full commit SHA
           with:
             grant: ${{ inputs.grant }}
             gate-target: ${{ inputs.gate-target }}
             verify-key: ${{ secrets.AUTOPILOT_GRANT_VERIFY_KEY }}
             agent-model-config: '{"provider":"claude","oauthToken":"${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"}'
             coding-executor-config: '{"provider":"claude-code","oauthToken":"${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"}'
             vcs-host-config: '{"provider":"github","token":"${{ secrets.GH_PAT }}"}'
   ```

   Pin `@<PINNED_SHA>` to a full commit SHA of this repo (never a moving tag) — Tekunda
   tells you which SHA your control plane targets.

2. **Add three repository secrets** (Settings → Secrets and variables → Actions):

   | Secret | What it is |
   |---|---|
   | `AUTOPILOT_GRANT_VERIFY_KEY` | The control plane's **Ed25519 public** key (PEM). Verifies grant signatures. Tekunda gives you this — it is public, not sensitive. |
   | `CLAUDE_CODE_OAUTH_TOKEN` | **Your** Claude Code OAuth / subscription token. Runs the coding and judgment stages under your own account. |
   | `GH_PAT` | A GitHub token with `contents:write` + `pull-requests:write` on this repo. Used to check out the repo and open PRs. A fine-grained PAT scoped to this repo is ideal. |

   > Prefer a coding subscription (OAuth) over a raw API key — it's the first-class path.
   > An OpenAI/Codex setup is also supported via `coding-executor-config`.

3. **That's it.** You do **not** trigger this workflow yourself — the control plane
   dispatches it per stage. Each run shows up in **Actions** labeled by its stage and
   ticket, e.g. *"Autopilot build: Add SOC 2 badge"*, so `plan` / `build` / `gate` / `fix`
   are distinguishable at a glance.

## Security

- **IP-free & pinned.** This repo contains no proprietary logic; pin it by SHA so you run
  exactly the reviewed code.
- **Your source stays yours.** The control plane operates purely over APIs and never clones
  your repo. Checkout happens only here, inside your CI. Only telemetry crosses back.
- **Signed grants.** Every stage is authorized by a single-use, signature-verified grant;
  a tampered or unentitled grant is rejected before any work runs.
- **Your credentials, your account.** Coding runs under your own `CLAUDE_CODE_OAUTH_TOKEN`;
  no model keys are shared with or stored by the control plane in the grant.

## Support

Questions or an install link: **hello@tekunda.com**.
