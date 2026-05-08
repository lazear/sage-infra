# sage-infra

Continuous benchmark CI for [Sage](https://github.com/lazear/sage). On every push to Sage's `master`, the system builds Sage from source, runs it against a configurable suite of proteomics datasets on AWS Batch, and publishes per-commit results (PSMs / peptides / proteins at 1% FDR, runtime, peak memory) to a static dashboard.

## Layout

```
.github/workflows/    GH Actions: build + fanout + finalize, plus infra deploy
infra/                AWS CDK stack (ECR, Batch, S3 x2, CloudFront, IAM)
runner/               Docker image used by Batch jobs (sage + python wrapper)
site/                 Static dashboard (Alpine + Chart.js, no build step)
datasets/<PXD>/       Per-dataset sage params (config.json) + optional meta.yaml
scripts/              Operator helpers (upload mzML/FASTA to S3)
sage-dispatch/        Workflow file to copy into the upstream Sage repo
```

## Datasets

Each benchmark dataset lives in its own directory under `datasets/`:

```
datasets/PXD001468/
  config.json        # sage parameters; uses ${DATA_BUCKET} / ${PXD} placeholders
  meta.yaml          # optional: Batch resource overrides + description
```

`config.json` example:
```json
{
  "database": {
    "fasta": "s3://${DATA_BUCKET}/datasets/${PXD}/uniprot-human.fasta"
  },
  "mzml_paths": [
    "s3://${DATA_BUCKET}/datasets/${PXD}/run01.mzML.gz",
    "s3://${DATA_BUCKET}/datasets/${PXD}/run02.mzML.gz"
  ],
  "precursor_tol": { "ppm": [-50, 50] },
  "fragment_tol":  { "ppm": [-20, 20] }
}
```

`meta.yaml` is optional — defaults are 4 vCPU / 30 GB:
```yaml
description: "Mann lab HeLa, isobaric labeled, 24-fraction"
batch:
  vcpu: 8
  memory_mib: 32768
```

Adding a dataset = uploading the heavy files once, then a PR. Removing one = deleting the directory in a PR. The mzML / FASTA stay in S3 either way (cheap to keep, painful to re-upload).

The benchmark workflow stages each `config.json` to `s3://<data-bucket>/staging/<sage-commit>/<PXD>/config.json` per run, so a Sage commit is always benchmarked against the config that was committed at that moment in `sage-infra` history (recorded as `sage_infra_commit` in the result JSON).

Bruker `.d` inputs may also be listed as S3 directories in `config.json`, for example `s3://${DATA_BUCKET}/datasets/${PXD}/sample01.d`. The Batch wrapper detects S3 paths ending in `.d`, syncs those directory prefixes into `/scratch/inputs`, writes a local rewritten config for the job, and then runs Sage against that local config. Other S3 paths, such as mzML files and FASTA files, are left unchanged.

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
5. Add at least one dataset:
   ```sh
   # Heavy files go to S3 once:
   DATA_BUCKET=<your-data-bucket> scripts/upload-dataset.sh PXD001468 ./local-PXD001468/

   # Sage params travel with git:
   mkdir -p datasets/PXD001468
   $EDITOR datasets/PXD001468/config.json   # see "Datasets" section above
   $EDITOR datasets/PXD001468/meta.yaml     # optional
   git add datasets/PXD001468 && git commit -m "add PXD001468"
   ```
6. Set up the GitHub App for cross-repo dispatch (one-time, see `sage-dispatch/README.md`), then copy `sage-dispatch/sage-infra-dispatch.yml` into the Sage repo at `.github/workflows/`.
7. Push a commit to Sage `master`. Watch the run in this repo's Actions tab. Visit the CloudFront URL.
