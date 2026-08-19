# Delivery Autopilot Runner

The GitHub Action that lets [Delivery Autopilot](https://tekunda.com) take a ticket from
your tracker all the way to a reviewed pull request. Your work is planned, built, checked,
and self-healed by an AI pipeline that runs inside your own GitHub Actions.

**This Action requires an active Delivery Autopilot subscription from Tekunda.** It does
nothing on its own. The hosted Delivery Autopilot service reads your tickets and dispatches
this Action to do the work. Without a subscription, there is nothing to trigger it and it
will not run. [Contact us](https://tekunda.com/contact) to get set up.

## How it works

```
Your repository (your GitHub Actions)          Delivery Autopilot (hosted service)
.....................................          ...................................
                                       reads your tickets, decides the next step,
  Autopilot Runner workflow  <-- run --      and sends a signed, short-lived instruction
    1. checks out your repository
    2. the AI writes the code (your key)
    3. runs the configured quality checks
    4. opens the pull request
    5. reports status back -------------->    advances the ticket, seeing only pass/fail,
       (pass/fail, PR link)                     the PR link, and a short log summary
```

Each step is authorized by a signed instruction that this Action verifies before doing any
work.

## Where your code goes

Your source is checked out only inside your own CI, on GitHub's runners. **It is never sent
to Tekunda's servers.** Delivery Autopilot never clones your repository; it sees only the
pass/fail result, the pull request link, and a short log summary.

There is one exception you should know about: the AI coding step runs in your CI under your
own model credential, and to write code it sends the code context it needs to **your chosen
model provider** (Anthropic or OpenAI). That call goes from your CI directly to that
provider, not to Tekunda. You choose the provider and supply the credential.

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
           uses: Tekunda/autopilot-runner@v1
           with:
             grant: ${{ inputs.grant }}
             gate-target: ${{ inputs.gate-target }}
             verify-key: ${{ secrets.AUTOPILOT_GRANT_VERIFY_KEY }}
             agent-model-config: '{"provider":"claude","oauthToken":"${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"}'
             coding-executor-config: '{"provider":"claude-code","oauthToken":"${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}"}'
             vcs-host-config: '{"provider":"github","token":"${{ secrets.GH_PAT }}"}'
   ```

   Pinning to `@v1` gets you minor and patch updates automatically. A future `v2` would be a
   breaking change you opt into by repinning.

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

## Security and credentials

- **Your code is checked out only in your CI.** Delivery Autopilot works through GitHub's
  APIs and never clones your repository. Your source is never sent to Tekunda's servers.
  Only the pull request and a short status update come back to the service. The AI coding
  step does send code context to your chosen model provider (Anthropic or OpenAI), as
  described in [Where your code goes](#where-your-code-goes).
- **Verified instructions.** Every step is authorized by a signed instruction that this
  Action checks before running anything. Each instruction is short-lived and expires, so a
  captured one cannot be replayed later.
- **Your credentials, your account.** The AI runs under your own token from your CI secrets.
  Separately, the Delivery Autopilot service stores your tracker and model credentials
  encrypted so it can operate your pipeline.
- **Control what you run.** Reference this repository by the `@v1` tag to receive compatible
  updates, or pin to a full commit SHA if you want to run one exact reviewed version.

## Support

Questions or an install link: [tekunda.com/contact](https://tekunda.com/contact)
