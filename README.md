# sage-infra

Continuous benchmark CI for [Sage](https://github.com/lazear/sage). On every push to Sage's `master`, the system builds Sage from source, runs it against a configurable suite of proteomics datasets on AWS Batch, and publishes per-commit results (PSMs / peptides / proteins at 1% FDR, runtime, peak memory) to a static dashboard.

## Layout

```
.github/workflows/    GH Actions: build + fanout + finalize, plus infra deploy
infra/                AWS CDK stack (ECR, Batch, S3 x2, CloudFront, IAM)
runner/               Docker image used by Batch jobs (sage + python wrapper)
site/                 Static dashboard (Alpine + Chart.js, no build step)
scripts/              Operator helpers (upload a dataset, register a dataset)
sage-dispatch/        Workflow file to copy into the upstream Sage repo
```

## Bootstrapping

> **Heads up**: `cdk synth` / `cdk diff` perform AZ context lookups against the
> target account, so they require valid AWS credentials in your shell. This is
> normal CDK behaviour — the `deploy-infra` GitHub workflow has them via OIDC,
> so you don't need creds locally to make deploys work.

1. Provide AWS account + region by writing `infra/cdk.context.json`:
   ```json
   { "account": "123456789012", "region": "us-west-2",
     "sageRepo": "lazear/sage", "ciRepo": "<owner>/sage-infra" }
   ```
2. Authenticate to that account, then `cd infra && npm install && npx cdk bootstrap && npx cdk deploy`.
3. Note the stack outputs (ECR URI, bucket names, CloudFront domain, OIDC role ARNs). Most are not needed in GitHub — the workflow reads them from CloudFormation at run time.
4. In this repo's GitHub settings, add **just these** repo variables:
   - `AWS_REGION` — e.g. `us-west-2`
   - `AWS_BENCHMARK_ROLE_ARN` — value of stack output `OutBenchmarkRoleArn`
   - `AWS_DEPLOY_ROLE_ARN` — value of stack output `OutDeployRoleArn`
   - `SAGE_REPO` — e.g. `lazear/sage` (optional; defaults to that)
   - `STACK_NAME` — optional; defaults to `SageInfraStack`

   Everything else (ECR URI, bucket names, queue/jobdef names, CloudFront ID, task/execution role ARNs) is fetched on demand by `.github/actions/load-stack-outputs` from the CloudFormation stack.
5. Upload at least one dataset:
   ```sh
   scripts/upload-dataset.sh PXD001468 ./local-PXD001468/
   scripts/register-dataset.sh PXD001468
   ```
6. Copy `sage-dispatch/sage-infra-dispatch.yml` into the Sage repo at `.github/workflows/`. Add `SAGE_INFRA_DISPATCH_TOKEN` (PAT with `repo` scope on `<owner>/sage-infra`) to the Sage repo's secrets.
7. Push a commit to Sage `master`. Watch the run in this repo's Actions tab. Visit the CloudFront URL.
