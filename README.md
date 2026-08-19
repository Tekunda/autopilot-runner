# Delivery Autopilot Runner

The GitHub Action that lets [Delivery Autopilot](https://tekunda.com) take a ticket from
your tracker all the way to a reviewed pull request. Your work is planned, built, checked,
and self-healed by an AI pipeline that runs entirely inside your own GitHub Actions, so your
code never leaves your infrastructure.

Delivery Autopilot runs as a hosted service that reads your tickets and coordinates the
work. The actual building happens here, in your CI, using your own credentials. This
repository is that piece: a single Action you reference from a workflow in your repo.

## How it works

```
Your repository (your GitHub Actions)          Delivery Autopilot (hosted service)
.....................................          ...................................
                                       reads your tickets, decides the next step,
  Autopilot Runner workflow  <-- run --      and sends a signed, single-use instruction
    1. checks out your repository
    2. the AI writes the code (your key)      your source code is never sent to us
    3. runs the configured quality checks
    4. opens the pull request
    5. reports status back -------------->    advances the ticket, seeing only pass/fail,
       (pass/fail, PR link)                     the PR link, and a short log summary
```

Each step is authorized by a signed instruction that this Action verifies before doing any
work. The only things that ever leave your repository are the pull request itself and a
short status update. Your source code and your diffs stay with you.

## Setup

### Option A: GitHub App (recommended)

Install the **Delivery Autopilot** GitHub App on the repositories you want it to work on.
It sets up the workflow and connection for you, and you just add your AI credential (below).
[Contact us](https://tekunda.com/contact) for your install link.

### Option B: add the workflow yourself

1. Create `.github/workflows/runner.yml` in your repository:

   ```yaml
   name: Autopilot Runner
   run-name: "Autopilot ${{ fromJSON(inputs.grant).stage }}: ${{ fromJSON(inputs.grant).ticketTitle || fromJSON(inputs.grant).ticketId }}"

   on:
     workflow_dispatch:
       inputs:
         grant:
           description: Signed instruction issued by Delivery Autopilot.
           required: true
         gate-target:
           description: Quality-check target, for checking steps only.
           required: false
           default: '{}'

   jobs:
     run-stage:
       runs-on: ubuntu-latest
       permissions:
         contents: write        # create the working branch and open the pull request
         pull-requests: write
         id-token: write
       steps:
         - name: Run stage via Delivery Autopilot
           uses: Tekunda/autopilot-runner@PINNED_SHA   # pin to a full commit SHA
           with:
             grant: ${{ inputs.grant }}
             gate-target: ${{ inputs.gate-target }}
             verify-key: ${{ secrets.AUTOPILOT_GRANT_VERIFY_KEY }}
             agent-model-config: '{"provider":"claude","oauthToken":"${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"}'
             coding-executor-config: '{"provider":"claude-code","oauthToken":"${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"}'
             vcs-host-config: '{"provider":"github","token":"${{ secrets.GH_PAT }}"}'
   ```

   Replace `PINNED_SHA` with a full commit SHA of this repository (not a moving tag). We tell
   you which one to use.

2. Add three repository secrets (Settings, then Secrets and variables, then Actions):

   | Secret | What it is |
   |---|---|
   | `AUTOPILOT_GRANT_VERIFY_KEY` | A public key we give you, used to verify each instruction is genuinely from Delivery Autopilot. Not sensitive. |
   | `CLAUDE_CODE_OAUTH_TOKEN` | Your Claude subscription (OAuth) token. The AI builds under your own account. |
   | `GH_PAT` | A GitHub token that can write to this repository and open pull requests. A fine-grained token scoped to just this repo is ideal. |

   > A Claude subscription (OAuth) is the recommended path. An OpenAI or Codex setup is also
   > supported via `coding-executor-config`.

3. That is all. You do not run this workflow yourself. Delivery Autopilot triggers it as it
   works through a ticket. Each run appears in your **Actions** tab labeled by what it is
   doing and for which ticket, for example *"Autopilot build: Add SOC 2 badge"*, so you can
   follow along at a glance.

## What this means for your security

- **Your code stays with you.** Delivery Autopilot works through GitHub's APIs and never
  clones your repository. Your code is only ever checked out here, inside your own CI. Only
  the pull request and a short status update come back.
- **Verified instructions.** Every step is authorized by a signed, single-use instruction
  that this Action checks before running anything.
- **Your credentials, your account.** The AI runs under your own token, and your keys are
  never stored by the service.
- **Pin what you run.** Reference this repository by commit SHA so you always run exactly
  the version you reviewed.

## Support

Questions or an install link: [tekunda.com/contact](https://tekunda.com/contact)
