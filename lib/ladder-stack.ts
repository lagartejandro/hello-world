import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface LadderStackProps extends cdk.StackProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  inviteSecret: secretsmanager.ISecret;
}

export class LadderStack extends cdk.Stack {
  public readonly apiUrl: string;
  public readonly apiDomain: string;

  constructor(scope: Construct, id: string, props: LadderStackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // Table — players, matches, settings and account links in one partition
    //
    //   CLUB#default | PLAYER#<id>        one row per member
    //   CLUB#default | MATCH#<at>#<id>    the append-only game log
    //   CLUB#default | SETTINGS           K-factors and starting rating
    //   USER#<sub>   | PROFILE            links a Cognito account to a player
    //
    // Sorting matches by timestamp inside the key means a single Query returns
    // the log already in the order the client replays it.
    // -------------------------------------------------------------------------
    const table = new dynamodb.Table(this, 'LadderTable', {
      tableName: 'chess-ladder',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // This is the club's actual history and it is irreplaceable — a member's
      // rating is the sum of every game they ever played here. The tracker
      // table has none of this; user data gets all three.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -------------------------------------------------------------------------
    // API Lambda
    // -------------------------------------------------------------------------
    const ladderFn = new lambdaNode.NodejsFunction(this, 'LadderFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/ladder/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Chess ladder state, sync and invite code',
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        TABLE_NAME: table.tableName,
        INVITE_SECRET_ARN: props.inviteSecret.secretArn,
        CLUB_TZ: 'America/New_York',
      },
    });

    table.grantReadWriteData(ladderFn);
    props.inviteSecret.grantRead(ladderFn);

    // -------------------------------------------------------------------------
    // HTTP API
    //
    // The JWT is validated by API Gateway, not by us — an unauthenticated
    // request never reaches the Lambda, and the handler never parses a token.
    // Operator-only routes are enforced inside the handler against the
    // cognito:groups claim, because the authorizer can check identity but not
    // authorisation.
    //
    // No CORS: this API is reached same-origin through CloudFront at /api/*,
    // so a preflight never happens. Adding CORS here would only widen who can
    // call it from a browser.
    // -------------------------------------------------------------------------
    const authorizer = new apigwv2Authorizers.HttpUserPoolAuthorizer(
      'LadderAuthorizer', props.userPool,
      { userPoolClients: [props.userPoolClient] }
    );

    const api = new apigwv2.HttpApi(this, 'LadderApi', {
      apiName: 'chess-ladder-api',
      description: 'Chess ladder state and sync',
    });

    const integration = new apigwv2Integrations.HttpLambdaIntegration('LadderIntegration', ladderFn);

    // Paths keep the /api prefix because CloudFront forwards the path intact.
    for (const [path_, method] of [
      ['/api/state', apigwv2.HttpMethod.GET],
      ['/api/me', apigwv2.HttpMethod.GET],
      ['/api/admin/invite-code', apigwv2.HttpMethod.GET],
      ['/api/sync', apigwv2.HttpMethod.POST],
    ] as [string, apigwv2.HttpMethod][]) {
      api.addRoutes({ path: path_, methods: [method], integration, authorizer });
    }

    this.apiUrl = api.apiEndpoint;
    this.apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', api.apiEndpoint));

    new cdk.CfnOutput(this, 'LadderApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'LadderTableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'LadderFunctionName', { value: ladderFn.functionName });
  }
}
