import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  // Exposed so the ladder API can derive today's code for the operator.
  public readonly inviteSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // Invite secret — the seed the daily sign-up code is derived from.
    // Deriving the code (HMAC of the club-local date) rather than storing one
    // means it rotates itself: no admin UI, no table, no cron job.
    // -------------------------------------------------------------------------
    const inviteSecret = new secretsmanager.Secret(this, 'InviteSecret', {
      secretName: 'chess-ladder/invite-seed',
      description: 'Seed for the chess club daily invite code',
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // -------------------------------------------------------------------------
    // PreSignUp trigger — enforces "at least one contact" and the invite code.
    // Cognito can express neither rule natively.
    // -------------------------------------------------------------------------
    const preSignUpFn = new lambdaNode.NodejsFunction(this, 'PreSignUpFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/auth/pre-signup.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      description: 'Validates contact details and the daily invite code at sign-up',
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        INVITE_SECRET_ARN: inviteSecret.secretArn,
        CLUB_TZ: 'America/New_York',
        // Flip to 'true' in phase 5, once SMS can actually deliver. Until then
        // the trigger rejects phone-only sign-ups, which would otherwise
        // create accounts that can never receive a code and never sign in.
        SMS_ENABLED: 'false',
      },
    });

    inviteSecret.grantRead(preSignUpFn);

    // -------------------------------------------------------------------------
    // User pool
    //
    // Passwordless email OTP is the intended sign-in path: the verified email
    // IS the credential, so verification and authentication are one act and
    // there is no password to reset, reuse or leak. Cognito requires the
    // password factor to remain enabled alongside it, so it stays as a
    // fallback rather than the primary route.
    // -------------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'ChessUserPool', {
      userPoolName: 'chess-ladder',

      // Choice-based (passwordless) auth requires Essentials or higher.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,

      selfSignUpEnabled: true,

      // Phone is deliberately NOT a sign-in alias or auto-verified attribute
      // yet. Enabling either makes CDK attach an SMS role with sns:Publish on
      // "*", which is the toll-fraud surface we are not ready to defend — and
      // it would be dead weight anyway, because SMS cannot send until 10DLC
      // registration clears. Phase 5 turns on phone here, smsOtp below, and
      // the SNS spend limit and country allowlist, together.
      signInAliases: { email: true },

      // The attribute still exists and is still optional, so members can store
      // a number now and nothing needs reshaping when SMS lands.
      standardAttributes: {
        email: { required: false, mutable: true },
        phoneNumber: { required: false, mutable: true },
      },
      autoVerify: { email: true },
      keepOriginal: { email: true },

      signInPolicy: {
        allowedFirstAuthFactors: {
          password: true,   // required by Cognito
          emailOtp: true,
          // smsOtp: true — switched on once 10DLC registration clears.
        },
      },

      // Still enforced for the fallback factor, and for anyone who sets one.
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,   // length beats symbol soup for real users
      },

      mfa: cognito.Mfa.OFF,
      // Deliberate: OTP as a first factor is incompatible with required MFA,
      // and in an MFA-optional pool a user who enables MFA loses passwordless
      // sign-in entirely. Revisit only if operator accounts need a second
      // factor, in which case give operators a separate pool policy.

      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // -> EMAIL_AND_PHONE_WITHOUT_MFA when SMS lands.

      lambdaTriggers: { preSignUp: preSignUpFn },

      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    // -------------------------------------------------------------------------
    // App client — public SPA client, no secret (a static page cannot keep one)
    // -------------------------------------------------------------------------
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'chess-ladder-web',
      generateSecret: false,
      authFlows: {
        user: true,        // USER_AUTH — enables choice-based / passwordless
        userSrp: true,     // password fallback, without sending the password
      },
      // We never use the hosted UI or any OAuth redirect flow, and CDK would
      // otherwise enable OAuth — including the implicit flow, which returns
      // tokens in a URL fragment. Unused surface, so turn it off.
      disableOAuth: true,
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      // Long on purpose: an operator whose refresh token expires mid-night in
      // a bar with no wifi cannot record a single result.
      refreshTokenValidity: cdk.Duration.days(90),
      enableTokenRevocation: true,
    });

    // -------------------------------------------------------------------------
    // Operators — the only group allowed to write. Membership is granted by
    // hand; there is no self-service path into it by design.
    // -------------------------------------------------------------------------
    new cognito.CfnUserPoolGroup(this, 'OperatorsGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'operators',
      description: 'May record results, manage players and change settings',
    });

    this.userPool = userPool;
    this.userPoolClient = userPoolClient;
    this.inviteSecret = inviteSecret;

    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'InviteSecretArn', { value: inviteSecret.secretArn });
  }
}
