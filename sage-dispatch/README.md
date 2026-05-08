# sage-side dispatch

Copy `sage-infra-dispatch.yml` into the upstream Sage repo at
`.github/workflows/sage-infra-dispatch.yml`. This is the only change required
on the Sage side — every push to `master` will fire a `repository_dispatch`
event into `sage-infra`, which kicks off the benchmark run.

## One-time setup in the Sage repo

1. Create a fine-grained PAT (Settings → Developer settings → Personal access
   tokens → Fine-grained tokens) with:
   - Resource: only `<owner>/sage-infra`
   - Permissions: `Contents: Read and write` (required for `repository_dispatch`)
2. Add it as a repository secret named `SAGE_INFRA_DISPATCH_TOKEN` on the Sage repo.
3. (Optional) Add a repository variable `SAGE_INFRA_REPO` if your sage-infra slug
   differs from `lazear/sage-infra`.
4. Commit the workflow file. The next push to `master` will trigger sage-infra.

## Why a PAT and not GITHUB_TOKEN?

The default `GITHUB_TOKEN` cannot dispatch events to a different repository,
so cross-repo `repository_dispatch` requires a PAT or GitHub App token.
