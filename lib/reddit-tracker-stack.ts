import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class RedditTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // DynamoDB — stock mention counts keyed by date + ticker
    // TTL is set to 30 days so old data is automatically purged.
    // -------------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'MentionsTable', {
      tableName: 'stock-mentions',
      partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ticker', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -------------------------------------------------------------------------
    // SSM Parameters — placeholder values, fill in before first run.
    // After deploying, run the commands printed in SetupInstructions below.
    // -------------------------------------------------------------------------
    const clientIdParam = new ssm.StringParameter(this, 'RedditClientId', {
      parameterName: '/stock-tracker/reddit-client-id',
      stringValue: 'PLACEHOLDER',
      description: 'Reddit API client ID (from https://www.reddit.com/prefs/apps)',
    });

    const clientSecretParam = new ssm.StringParameter(this, 'RedditClientSecret', {
      parameterName: '/stock-tracker/reddit-client-secret',
      stringValue: 'PLACEHOLDER',
      description: 'Reddit API client secret',
    });

    // -------------------------------------------------------------------------
    // Shared Lambda config
    // -------------------------------------------------------------------------
    const lambdaDefaults: Partial<lambdaNode.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: {
        minify: true,
        sourceMap: false,
        // AWS SDK v3 is available in the Node 20 runtime but we bundle it
        // for explicit version control.
        externalModules: [],
      },
    };

    // -------------------------------------------------------------------------
    // Poller Lambda — runs on a schedule, polls Reddit, writes to DynamoDB
    // -------------------------------------------------------------------------
    const pollerFn = new lambdaNode.NodejsFunction(this, 'PollerFunction', {
      ...lambdaDefaults,
      entry: path.join(__dirname, '../lambda/poller/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      description: 'Polls Reddit for NYSE stock mentions and writes counts to DynamoDB',
      environment: {
        TABLE_NAME: table.tableName,
        REDDIT_CLIENT_ID_PARAM: clientIdParam.parameterName,
        REDDIT_CLIENT_SECRET_PARAM: clientSecretParam.parameterName,
      },
    });

    table.grantWriteData(pollerFn);
    clientIdParam.grantRead(pollerFn);
    clientSecretParam.grantRead(pollerFn);

    // Run every 30 minutes
    new events.Rule(this, 'PollerSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(30)),
      targets: [new targets.LambdaFunction(pollerFn, { retryAttempts: 1 })],
    });

    // -------------------------------------------------------------------------
    // API Lambda — returns today's (or any date's) top tickers
    // -------------------------------------------------------------------------
    const apiFn = new lambdaNode.NodejsFunction(this, 'ApiFunction', {
      ...lambdaDefaults,
      entry: path.join(__dirname, '../lambda/api/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Returns top NYSE tickers by mention count for a given date',
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    table.grantReadData(apiFn);

    // -------------------------------------------------------------------------
    // HTTP API Gateway
    // GET /tickers              → today's top 50 tickers
    // GET /tickers?date=YYYY-MM-DD → specific date
    // GET /tickers?limit=100    → up to 200 results
    // -------------------------------------------------------------------------
    const api = new apigwv2.HttpApi(this, 'StockApi', {
      apiName: 'stock-mentions-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowHeaders: ['Content-Type'],
      },
    });

    api.addRoutes({
      path: '/tickers',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('ApiIntegration', apiFn),
    });

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `${api.url}tickers`,
      description: 'Stock mentions API endpoint',
    });

    new cdk.CfnOutput(this, 'SetupInstructions', {
      value: [
        'Set your Reddit API credentials:',
        `aws ssm put-parameter --name /stock-tracker/reddit-client-id --value YOUR_CLIENT_ID --overwrite`,
        `aws ssm put-parameter --name /stock-tracker/reddit-client-secret --value YOUR_CLIENT_SECRET --overwrite`,
        'Then manually invoke the poller once to test:',
        `aws lambda invoke --function-name ${pollerFn.functionName} /dev/null`,
      ].join(' | '),
      description: 'Run these commands after deploying to activate the tracker',
    });
  }
}
