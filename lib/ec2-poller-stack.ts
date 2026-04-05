import * as path from 'path';
import { execSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

interface Ec2PollerStackProps extends cdk.StackProps {
  tableName: string;
}

export class Ec2PollerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Ec2PollerStackProps) {
    super(scope, id, props);

    const { tableName } = props;

    // -------------------------------------------------------------------------
    // Bundle the poller TypeScript into a single JS file via esbuild.
    // CDK uploads this to S3; the EC2 instance downloads and runs it.
    // -------------------------------------------------------------------------
    const pollerAsset = new s3assets.Asset(this, 'PollerAsset', {
      path: path.join(__dirname, '../lambda'),
      bundling: {
        // Try local bundling first (fast, uses the esbuild already in node_modules)
        local: {
          tryBundle(outputDir: string): boolean {
            try {
              const entry = path.join(__dirname, '../lambda/poller/run.ts');
              execSync(
                `npx esbuild "${entry}" --bundle --platform=node --target=node18 --outfile="${outputDir}/poller.js"`,
                { stdio: 'inherit' }
              );
              return true;
            } catch {
              return false;
            }
          },
        },
        // Docker fallback (used in CI or if esbuild isn't installed locally)
        image: cdk.DockerImage.fromRegistry('node:18-alpine'),
        command: [
          'sh', '-c',
          'npm install -g esbuild && esbuild /asset-input/poller/run.ts --bundle --platform=node --target=node18 --outfile=/asset-output/poller.js',
        ],
      },
    });

    // -------------------------------------------------------------------------
    // IAM role — needs DynamoDB write + S3 read (asset) + SSM (remote access)
    // -------------------------------------------------------------------------
    const role = new iam.Role(this, 'PollerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // Enables SSM Session Manager — connect without SSH keys
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    role.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${tableName}`],
    }));

    pollerAsset.grantRead(role);

    // -------------------------------------------------------------------------
    // Network — use the default VPC, outbound-only security group
    // -------------------------------------------------------------------------
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    const sg = new ec2.SecurityGroup(this, 'PollerSg', {
      vpc,
      description: 'Reddit poller - outbound only, no inbound',
      allowAllOutbound: true,
    });

    // -------------------------------------------------------------------------
    // User data — runs once on first boot
    // -------------------------------------------------------------------------
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -e',

      // Install Node.js (AL2023 ships Node 18 via dnf)
      'dnf install -y nodejs unzip',

      // Download and unzip the bundled poller from S3
      'mkdir -p /opt/poller',
      `aws s3 cp s3://${pollerAsset.s3BucketName}/${pollerAsset.s3ObjectKey} /opt/poller/asset.zip`,
      'unzip -o /opt/poller/asset.zip -d /opt/poller/',

      // Environment file read by the systemd service
      `echo 'TABLE_NAME=${tableName}' > /opt/poller/.env`,
      `echo 'AWS_REGION=${this.region}' >> /opt/poller/.env`,

      // Systemd service — runs the poller once per invocation
      "echo '[Unit]'                                           > /etc/systemd/system/reddit-poller.service",
      "echo 'Description=Reddit NYSE Stock Mentions Poller'  >> /etc/systemd/system/reddit-poller.service",
      "echo ''                                               >> /etc/systemd/system/reddit-poller.service",
      "echo '[Service]'                                      >> /etc/systemd/system/reddit-poller.service",
      "echo 'Type=oneshot'                                   >> /etc/systemd/system/reddit-poller.service",
      "echo 'EnvironmentFile=/opt/poller/.env'               >> /etc/systemd/system/reddit-poller.service",
      "echo 'ExecStart=/usr/bin/node /opt/poller/poller.js'  >> /etc/systemd/system/reddit-poller.service",
      "echo 'StandardOutput=journal'                         >> /etc/systemd/system/reddit-poller.service",
      "echo 'StandardError=journal'                          >> /etc/systemd/system/reddit-poller.service",

      // Systemd timer — fires 2 min after boot, then every 30 min
      "echo '[Unit]'                                              > /etc/systemd/system/reddit-poller.timer",
      "echo 'Description=Run Reddit poller every 30 minutes'    >> /etc/systemd/system/reddit-poller.timer",
      "echo ''                                                   >> /etc/systemd/system/reddit-poller.timer",
      "echo '[Timer]'                                            >> /etc/systemd/system/reddit-poller.timer",
      "echo 'OnBootSec=2min'                                     >> /etc/systemd/system/reddit-poller.timer",
      "echo 'OnUnitActiveSec=30min'                              >> /etc/systemd/system/reddit-poller.timer",
      "echo ''                                                   >> /etc/systemd/system/reddit-poller.timer",
      "echo '[Install]'                                          >> /etc/systemd/system/reddit-poller.timer",
      "echo 'WantedBy=timers.target'                             >> /etc/systemd/system/reddit-poller.timer",

      'systemctl daemon-reload',
      'systemctl enable --now reddit-poller.timer',
    );

    // -------------------------------------------------------------------------
    // EC2 instance — t4g.nano (ARM64, cheapest general-purpose instance ~$3/mo)
    // -------------------------------------------------------------------------
    const instance = new ec2.Instance(this, 'PollerInstance', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role,
      securityGroup: sg,
      userData,
      // Replacing user data forces instance replacement, picking up code changes
      userDataCausesReplacement: true,
    });

    // Elastic IP — keeps a stable outbound IP (free while attached to a running instance)
    const eip = new ec2.CfnEIP(this, 'PollerEip', {
      instanceId: instance.instanceId,
    });

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'PublicIp', {
      value: eip.ref,
      description: 'Poller instance public IP',
    });

    new cdk.CfnOutput(this, 'ConnectCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region}`,
      description: 'Open a shell on the poller (no SSH key needed)',
    });

    new cdk.CfnOutput(this, 'LogsCommand', {
      value: `aws ssm start-session --target ${instance.instanceId} --region ${this.region} --document-name AWS-StartInteractiveCommand --parameters 'command=journalctl -u reddit-poller.service -f'`,
      description: 'Stream live poller logs',
    });
  }
}
