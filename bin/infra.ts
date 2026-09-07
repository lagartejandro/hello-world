#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InfraStack } from '../lib/infra-stack';
import { RedditTrackerStack } from '../lib/reddit-tracker-stack';
import { Ec2PollerStack } from '../lib/ec2-poller-stack';
import { AuthStack } from '../lib/auth-stack';
import { LadderStack } from '../lib/ladder-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

// Accounts and data for the chess ladder. InfraStack serves the ladder API
// same-origin at /api/*, so the order here is Auth -> Ladder -> Infra.
const authStack = new AuthStack(app, 'AuthStack', { env });

const ladderStack = new LadderStack(app, 'LadderStack', {
  env,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  inviteSecret: authStack.inviteSecret,
});

new InfraStack(app, 'InfraStack', {
  env,
  domainName: 'lagartejandro.com',
  apiDomain: ladderStack.apiDomain,
});

const trackerStack = new RedditTrackerStack(app, 'RedditTrackerStack', { env });

new Ec2PollerStack(app, 'Ec2PollerStack', {
  env,
  tableName: trackerStack.tableName,
});
