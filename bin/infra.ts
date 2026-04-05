#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InfraStack } from '../lib/infra-stack';
import { RedditTrackerStack } from '../lib/reddit-tracker-stack';
import { Ec2PollerStack } from '../lib/ec2-poller-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

new InfraStack(app, 'InfraStack', {
  env,
  domainName: 'lagartejandro.com',
});

const trackerStack = new RedditTrackerStack(app, 'RedditTrackerStack', { env });

new Ec2PollerStack(app, 'Ec2PollerStack', {
  env,
  tableName: trackerStack.tableName,
});
