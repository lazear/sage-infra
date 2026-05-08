import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_s3 as s3,
  aws_iam as iam,
  aws_batch as batch,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  Duration,
  RemovalPolicy,
  Size,
  CfnOutput,
} from 'aws-cdk-lib';

export interface SageInfraStackProps extends cdk.StackProps {
  /** GitHub `owner/repo` slug for this CI repo (used for OIDC trust). */
  ciRepo: string;
  /** GitHub `owner/repo` slug for upstream Sage (informational; commit links). */
  sageRepo: string;
}

export class SageInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SageInfraStackProps) {
    super(scope, id, props);

    // ---------- Networking ----------
    // Tiny VPC, public subnets only, no NAT. Fargate Spot tasks run with public
    // IPs and reach ECR/S3/Batch APIs via the IGW. S3 gateway endpoint keeps
    // dataset transfers in-VPC and free.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    // ---------- ECR ----------
    const ecrRepo = new ecr.Repository(this, 'RunnerRepo', {
      repositoryName: 'sage-infra-runner',
      imageTagMutability: ecr.TagMutability.MUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [{ description: 'Keep last 50 images', maxImageCount: 50 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------- S3 ----------
    const dataBucket = new s3.Bucket(this, 'DataBucket', {
      bucketName: `sage-infra-data-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const resultsBucket = new s3.Bucket(this, 'ResultsBucket', {
      bucketName: `sage-infra-results-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---------- CloudFront (OAC -> resultsBucket) ----------
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(resultsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        compress: true,
      },
      additionalBehaviors: {
        'site/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(resultsBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: new cloudfront.CachePolicy(this, 'SiteCachePolicy', {
            defaultTtl: Duration.minutes(5),
            maxTtl: Duration.minutes(15),
            minTtl: Duration.seconds(0),
          }),
          compress: true,
        },
        'results/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(resultsBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // Per-commit/per-dataset outputs are immutable, so cache aggressively.
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
      defaultRootObject: 'site/index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // ---------- IAM: Batch task + execution roles ----------
    const taskRole = new iam.Role(this, 'BatchTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Runtime perms for the sage-infra runner container',
    });
    dataBucket.grantRead(taskRole);
    resultsBucket.grantPut(taskRole, 'results/*');

    const executionRole = new iam.Role(this, 'BatchExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    ecrRepo.grantPull(executionRole);

    // ---------- AWS Batch on Fargate Spot ----------
    const computeEnv = new batch.FargateComputeEnvironment(this, 'ComputeEnv', {
      computeEnvironmentName: 'sage-infra-fargate-spot',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      spot: true,
      maxvCpus: 256,
    });

    const queue = new batch.JobQueue(this, 'JobQueue', {
      jobQueueName: 'sage-infra-default',
      priority: 10,
    });
    queue.addComputeEnvironment(computeEnv, 1);

    // The image here is a placeholder — the benchmark workflow registers a
    // new job-definition revision per commit pointing at the freshly-built
    // sage-infra-runner:<sha> image, and submits jobs against that revision.
    const containerDef = new batch.EcsFargateContainerDefinition(this, 'JobContainer', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/alpine:3.20'),
      cpu: 4,
      memory: Size.mebibytes(30720),
      command: ['python3', '/usr/local/bin/wrapper.py'],
      jobRole: taskRole,
      executionRole,
      assignPublicIp: true,
      fargateCpuArchitecture: ecs.CpuArchitecture.X86_64,
      fargateOperatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    });

    const jobDef = new batch.EcsJobDefinition(this, 'JobDef', {
      jobDefinitionName: 'sage-infra-bench',
      container: containerDef,
      retryAttempts: 1,
      timeout: Duration.hours(4),
    });

    // ---------- GitHub OIDC ----------
    const existingOidcArn = this.node.tryGetContext('existingOidcProviderArn') as string | undefined;
    const oidcProvider = existingOidcArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GhOidc', existingOidcArn)
      : new iam.OpenIdConnectProvider(this, 'GhOidc', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    const ghPrincipal = (subPattern: string) =>
      new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': subPattern },
        },
        'sts:AssumeRoleWithWebIdentity',
      );

    // Benchmark role (used by benchmark.yml) — narrow permissions.
    const benchmarkRole = new iam.Role(this, 'BenchmarkRole', {
      roleName: 'sage-infra-benchmark',
      assumedBy: ghPrincipal(`repo:${props.ciRepo}:*`),
      maxSessionDuration: Duration.hours(6),
      description: 'sage-infra benchmark.yml workflow role',
    });
    ecrRepo.grantPullPush(benchmarkRole);
    dataBucket.grantRead(benchmarkRole);
    resultsBucket.grantReadWrite(benchmarkRole);
    benchmarkRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'batch:SubmitJob',
        'batch:DescribeJobs',
        'batch:RegisterJobDefinition',
        'batch:DescribeJobDefinitions',
        'batch:TerminateJob',
        'batch:ListJobs',
      ],
      resources: ['*'],
    }));
    benchmarkRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
    }));
    benchmarkRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, executionRole.roleArn],
    }));

    // Deploy role (used by deploy-infra.yml) — broad perms, restricted to the
    // default branch. Override `defaultBranch` in cdk.context.json for forks.
    const defaultBranch = (this.node.tryGetContext('defaultBranch') as string | undefined) ?? 'master';
    const deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'sage-infra-deploy',
      assumedBy: ghPrincipal(`repo:${props.ciRepo}:ref:refs/heads/${defaultBranch}`),
      maxSessionDuration: Duration.hours(1),
      description: 'sage-infra deploy-infra.yml workflow role (cdk deploy)',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });

    // ---------- Outputs ----------
    new CfnOutput(this, 'OutEcrRepoUri',       { value: ecrRepo.repositoryUri });
    new CfnOutput(this, 'OutDataBucket',       { value: dataBucket.bucketName });
    new CfnOutput(this, 'OutResultsBucket',    { value: resultsBucket.bucketName });
    new CfnOutput(this, 'OutCloudFrontId',     { value: distribution.distributionId });
    new CfnOutput(this, 'OutCloudFrontUrl',    { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'OutBatchQueue',       { value: queue.jobQueueName });
    new CfnOutput(this, 'OutBatchJobDef',      { value: jobDef.jobDefinitionName });
    new CfnOutput(this, 'OutBenchmarkRoleArn', { value: benchmarkRole.roleArn });
    new CfnOutput(this, 'OutDeployRoleArn',    { value: deployRole.roleArn });
    new CfnOutput(this, 'OutTaskRoleArn',      { value: taskRole.roleArn });
    new CfnOutput(this, 'OutExecutionRoleArn', { value: executionRole.roleArn });
    new CfnOutput(this, 'OutSageRepo',         { value: props.sageRepo });
  }
}
