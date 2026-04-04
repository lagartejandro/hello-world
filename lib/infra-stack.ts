import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

interface InfraStackProps extends cdk.StackProps {
  domainName: string;
}

export class InfraStack extends cdk.Stack {
  public readonly hostedZone: route53.PublicHostedZone;
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    // -------------------------------------------------------------------------
    // Hosted Zone
    // Route 53 public hosted zone for the pre-registered domain.
    // -------------------------------------------------------------------------
    this.hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: domainName,
    });

    // -------------------------------------------------------------------------
    // ACM Certificate (DNS-validated)
    // Covers both the apex domain and all subdomains.
    // Must live in us-east-1 to be usable with CloudFront.
    // -------------------------------------------------------------------------
    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName,
      subjectAlternativeNames: [`*.${domainName}`],
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
    });

    // -------------------------------------------------------------------------
    // S3 Bucket (private — CloudFront accesses it via OAC)
    // -------------------------------------------------------------------------
    const bucket = new s3.Bucket(this, 'WebsiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // -------------------------------------------------------------------------
    // CloudFront Distribution
    // -------------------------------------------------------------------------
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      domainNames: [domainName, `www.${domainName}`],
      certificate: this.certificate,
      defaultRootObject: 'index.html',
    });

    // -------------------------------------------------------------------------
    // Deploy website files to S3
    // -------------------------------------------------------------------------
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./website')],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // -------------------------------------------------------------------------
    // Route 53 — alias records pointing apex + www at CloudFront
    // -------------------------------------------------------------------------
    const cfTarget = new route53targets.CloudFrontTarget(distribution);

    new route53.ARecord(this, 'AliasApex', {
      zone: this.hostedZone,
      target: route53.RecordTarget.fromAlias(cfTarget),
    });

    new route53.ARecord(this, 'AliasWww', {
      zone: this.hostedZone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(cfTarget),
    });

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Route 53 Hosted Zone ID',
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ACM Certificate ARN',
    });

    new cdk.CfnOutput(this, 'Nameservers', {
      value: cdk.Fn.join(', ', this.hostedZone.hostedZoneNameServers!),
      description: 'Route 53 nameservers — update these in your registrar',
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront domain (useful for testing before DNS propagates)',
    });
  }
}