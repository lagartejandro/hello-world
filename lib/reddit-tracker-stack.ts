import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

export class RedditTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // DynamoDB — stock mention counts keyed by date + ticker
    // TTL purges data older than 30 days automatically.
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
    // Shared Lambda config
    // -------------------------------------------------------------------------
    const lambdaDefaults: Partial<lambdaNode.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: [],
      },
    };

    // -------------------------------------------------------------------------
    // Poller Lambda — runs on a schedule, polls Reddit, writes to DynamoDB.
    // Uses Reddit's public JSON API — no credentials needed.
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
      },
    });

    table.grantWriteData(pollerFn);

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
    // GET /tickers                   → today's top 50 tickers
    // GET /tickers?date=YYYY-MM-DD   → specific date
    // GET /tickers?limit=100         → up to 200 results
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

    new cdk.CfnOutput(this, 'TestPollerCommand', {
      value: `aws lambda invoke --function-name ${pollerFn.functionName} --region us-east-1 /dev/null`,
      description: 'Manually trigger the poller to test',
    });
  }
}
