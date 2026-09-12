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
  /** Host of the ladder HTTP API, served same-origin at /api/*. */
  apiDomain: string;
}

export class InfraStack extends cdk.Stack {
  public readonly hostedZone: route53.IHostedZone;
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    const { domainName } = props;

    // -------------------------------------------------------------------------
    // Hosted Zone
    // Look up the existing hosted zone created when the domain was registered.
    // -------------------------------------------------------------------------
    this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName,
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
    const urlRewrite = new cloudfront.Function(this, 'UrlRewrite', {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var uri = event.request.uri;
  if (uri === '/map' || uri === '/map/') {
    event.request.uri = '/map.html';
  } else if (uri === '/diet-stack' || uri === '/diet-stack/') {
    event.request.uri = '/diet-stack.html';
  } else if (uri === '/brew' || uri === '/brew/') {
    event.request.uri = '/brew.html';
  } else if (uri === '/chess' || uri === '/chess/') {
    event.request.uri = '/chess.html';
  }
  return event.request;
}
      `),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{
          function: urlRewrite,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      // -----------------------------------------------------------------------
      // The ladder API, served same-origin so the page needs no CORS and pays
      // no preflight on every sync.
      //
      // Caching MUST stay disabled: a cached /api/state would hand one
      // member's ladder to the next visitor. ALL_VIEWER_EXCEPT_HOST_HEADER
      // forwards the Authorization header while leaving Host matching
      // execute-api — forward the real Host and the API rejects everything.
      // -----------------------------------------------------------------------
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(props.apiDomain),
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      domainNames: [domainName, `www.${domainName}`],
      certificate: this.certificate,
      defaultRootObject: 'index.html',
    });

    // -------------------------------------------------------------------------
    // Deploy website files to S3
    //
    // Cache-Control matters here. Without it S3 sends none, so browsers cache
    // heuristically off Last-Modified and keep serving an old page for hours —
    // a deploy then looks broken rather than absent, because a stale HTML file
    // loads fresh JSON and silently drops whatever the new markup added.
    //
    // max-age=0 + must-revalidate makes the browser check every load, which is
    // a cheap 304 on files this size. s-maxage keeps CloudFront caching for a
    // day regardless, and distributionPaths below flushes it on every deploy.
    //
    // Deliberately NOT long max-age + immutable: nothing here has a
    // content-hashed filename, so foods.json and derive.js would go stale
    // indefinitely.
    // -------------------------------------------------------------------------
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('./website')],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(cdk.Duration.seconds(0)),
        s3deploy.CacheControl.sMaxAge(cdk.Duration.days(1)),
        s3deploy.CacheControl.mustRevalidate(),
      ],
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

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront domain (useful for testing before DNS propagates)',
    });
  }
}