#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SageInfraStack } from '../lib/sage-infra-stack';

const app = new cdk.App();

const account = app.node.tryGetContext('account');
const region = app.node.tryGetContext('region');
const ciRepo = app.node.tryGetContext('ciRepo');
const sageRepo = app.node.tryGetContext('sageRepo') ?? 'lazear/sage';

if (!account || !region || !ciRepo) {
  throw new Error(
    'Missing required CDK context values. Create infra/cdk.context.json with: ' +
    '{ "account": "...", "region": "...", "ciRepo": "owner/sage-infra", "sageRepo": "lazear/sage" }',
  );
}

new SageInfraStack(app, 'SageInfraStack', {
  env: { account, region },
  ciRepo,
  sageRepo,
  description: 'Sage benchmark CI: ECR + Batch (Fargate Spot) + S3 + CloudFront',
});
