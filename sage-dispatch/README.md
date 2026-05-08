# sage-side dispatch

Copy `sage-infra-dispatch.yml` into the upstream Sage repo at
`.github/workflows/sage-infra-dispatch.yml`. This is the only change required
on the Sage side — every push to `master` will fire a `repository_dispatch`
event into `sage-infra`, which kicks off the benchmark run.

## One-time setup (GitHub App)

GitHub App installation tokens auto-rotate, so this only has to be done once
unless the private key is regenerated. (Alternative: a fine-grained PAT — see
"PAT alternative" below.)

1. **Create the App.** Your profile → **Settings** → **Developer settings**
   → **GitHub Apps** → **New GitHub App**.
   - **Name**: `sage-infra-dispatch` (must be globally unique on GitHub).
   - **Homepage URL**: anything, e.g. `https://github.com/<owner>/sage-infra`.
   - **Webhook**: uncheck **Active** (we don't receive any).
   - **Repository permissions** → **Contents**: `Read and write`.
     Leave everything else "No access".
   - **Where can this GitHub App be installed?**: "Only on this account".
2. **Note the App ID** (top of the App's General page).
3. **Generate a private key** on the same page → **Private keys** →
   **Generate a private key**. Save the downloaded `.pem`.
4. **Install the App on sage-infra.** App page → **Install App** → choose
   your account → **Only select repositories** → pick `sage-infra` → Install.
5. **Add two secrets to the *Sage* repo** — Settings → Secrets and variables
   → Actions → **Secrets** tab:
   - `SAGE_INFRA_APP_ID` — the numeric App ID.
   - `SAGE_INFRA_APP_PRIVATE_KEY` — the entire `.pem` contents, including
     the `-----BEGIN…` and `-----END…` lines.
6. (Optional) Add a repository variable `SAGE_INFRA_REPO` if your sage-infra
   slug differs from `lazear/sage-infra`.
7. Commit the workflow file. The next push to `master` will trigger sage-infra.

## PAT alternative

If you'd rather not run a GitHub App, replace the workflow's `app-token`
step with a single secret:

```yaml
env:
  GH_TOKEN: ${{ secrets.SAGE_INFRA_DISPATCH_TOKEN }}
```

…and create a fine-grained PAT scoped to `<owner>/sage-infra` with
**Contents: Read and write**, stored as `SAGE_INFRA_DISPATCH_TOKEN` on the
Sage repo. Trade-off: PATs expire (max 1 year) and have to be rotated.

## Why not the default `GITHUB_TOKEN`?

It can't dispatch events to a *different* repository — its scope is locked
to the repo running the workflow. Cross-repo `repository_dispatch` always
requires a credential that has access to both repos, which means either a
GitHub App installation token or a PAT.
