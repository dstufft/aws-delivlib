import cloudwatch = require('@aws-cdk/aws-cloudwatch');
import cbuild = require('@aws-cdk/aws-codebuild');
import events = require('@aws-cdk/aws-events');
import cdk = require('@aws-cdk/cdk');

import { Shellable, ShellPlatform } from './shellable';

export interface CanaryProps {
  /**
   * Rate at which to run the canary test.
   *
   * @default 'rate(1 minute)'
   */
  scheduleExpression: string;

  /**
   * Directory with the scripts.
   *
   * The whole directory will be uploaded.
   */
  scriptDirectory: string;

  /**
   * Filename of the canary script to start, relative to scriptDirectory.
   */
  entrypoint: string;

  /**
   * What platform to us to run the scripts on
   *
   * @default ShellPlatform.LinuxUbuntu
   */
  platform?: ShellPlatform;

  /**
   * Additional environment variables to set.
   *
   * @default No additional environment variables
   */
  environmentVariables?: { [key: string]: cbuild.BuildEnvironmentVariable };

  /**
   * The compute type to use for the build container.
   *
   * Note that not all combinations are available. For example,
   * Windows images cannot be run on ComputeType.Small.
   *
   * @default ComputeType.Medium
   */
  computeType?: cbuild.ComputeType;

  /**
   * The name for the build project.
   *
   * @default a name is generated by CloudFormation.
   */
  buildProjectName?: string;
}

/**
 * Schedules a script to run periodically in CodeBuild and exposes an alarm
 * for failures. Ideal for running 'canary' scripts.
 */
export class Canary extends cdk.Construct {
  public readonly alarm: cloudwatch.Alarm;

  constructor(scope: cdk.Construct, id: string, props: CanaryProps) {
    super(scope, id);

    const shellable = new Shellable(this, 'Shellable', {
      platform: props.platform || ShellPlatform.LinuxUbuntu,
      scriptDirectory: props.scriptDirectory,
      entrypoint: props.entrypoint,
      environmentVariables: props.environmentVariables,
      source: new cbuild.NoSource()
    });

    new events.EventRule(this, `Schedule`, {
      scheduleExpression: props.scheduleExpression,
      targets: [shellable.project]
    });

    this.alarm = new cloudwatch.Alarm(this, `Alarm`, {
      metric: shellable.project.metricFailedBuilds({
        periodSec: 300
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GreaterThanOrEqualToThreshold,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.Ignore
    });
  }
}
