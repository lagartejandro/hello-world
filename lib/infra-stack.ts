import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53domains from 'aws-cdk-lib/aws-route53domains';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
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
    // Route 53 public hosted zone — this is created first so we can pull the
    // nameservers and hand them to the domain registration below.
    // -------------------------------------------------------------------------
    this.hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: domainName,
    });

    // -------------------------------------------------------------------------
    // Domain Registration
    // Registers the domain via Route 53 Domains and points it at the hosted
    // zone nameservers above.
    //
    // IMPORTANT: Fill in your contact details before deploying.
    // AWS requires valid contact info — intentionally fake data will cause the
    // registration to be rejected or suspended.
    // -------------------------------------------------------------------------
    const contact: route53domains.CfnDomain.ContactDetailProperty = {
      firstName: 'FILL_IN',
      lastName: 'FILL_IN',
      email: 'FILL_IN@example.com',
      phoneNumber: '+1.5555550100',       // format: +CountryCode.Number
      addressLine1: 'FILL_IN',
      city: 'FILL_IN',
      state: 'FILL_IN',                  // 2-letter state/province code
      countryCode: 'US',                 // ISO 3166 alpha-2
      zipCode: 'FILL_IN',
      contactType: 'PERSON',             // PERSON | COMPANY | ASSOCIATION | PUBLIC_BODY | RESELLER
    };

    const nameservers = cdk.Fn.split(',', cdk.Fn.join(',', this.hostedZone.hostedZoneNameServers!));

    new route53domains.CfnDomain(this, 'Domain', {
      domainName,
      durationInYears: 1,
      autoRenew: true,
      adminContact: contact,
      registrantContact: contact,
      techContact: contact,
      // Wire the domain to the hosted zone nameservers
      nameservers: [
        { name: cdk.Fn.select(0, nameservers) },
        { name: cdk.Fn.select(1, nameservers) },
        { name: cdk.Fn.select(2, nameservers) },
        { name: cdk.Fn.select(3, nameservers) },
      ],
      privacyProtectAdminContact: true,
      privacyProtectRegistrantContact: true,
      privacyProtectTechContact: true,
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
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: 'Route 53 Hosted Zone ID',
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ACM Certificate ARN (us-east-1, usable with CloudFront)',
    });

    new cdk.CfnOutput(this, 'Nameservers', {
      value: cdk.Fn.join(', ', this.hostedZone.hostedZoneNameServers!),
      description: 'Route 53 nameservers assigned to the hosted zone',
    });
  }
}
