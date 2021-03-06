import assert = require('@aws-cdk/assert');
import cdk = require('@aws-cdk/cdk');
import path = require('path');
import { Canary } from '../lib';

const testDir = path.join(__dirname, 'delivlib-tests', 'linux');

test('correctly creates canary', () => {
  // GIVEN
  const stack = new cdk.Stack(undefined, 'TestStack');
  // WHEN
  new Canary(stack, 'Canary', {
    scheduleExpression: 'rate(1 minute)',
    scriptDirectory: testDir,
    entrypoint: 'test.sh'
  });
  // THEN
  assert.expect(stack).to(assert.haveResourceLike('AWS::CloudWatch::Alarm', {
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    EvaluationPeriods: 1,
    Threshold: 1,
    Dimensions: [{
      Name: 'ProjectName',
      Value: {
        Ref: 'CanaryShellableA135E79C'
      }
    }],
    MetricName: 'FailedBuilds',
    Namespace: 'AWS/CodeBuild',
    Statistic: 'Sum',
    TreatMissingData: 'ignore',
    Period: 300
  }));

  assert.expect(stack).to(assert.haveResourceLike('AWS::Events::Rule', {
    ScheduleExpression: 'rate(1 minute)',
    State: 'ENABLED',
    Targets: [{
      Arn: {
        'Fn::GetAtt': [
          'CanaryShellableA135E79C',
          'Arn'
        ]
      },
      Id: 'Resource',
      RoleArn: {
        'Fn::GetAtt': [
          'CanaryShellableEventsRoleC4030D0D',
          'Arn'
        ]
      }
    }]
  }));

  assert.expect(stack).to(assert.haveResourceLike('AWS::CodeBuild::Project', {
    Artifacts: {
      Type: 'NO_ARTIFACTS'
    },
    Environment: {
      ComputeType: 'BUILD_GENERAL1_MEDIUM',
      Image: 'aws/codebuild/ubuntu-base:14.04',
      PrivilegedMode: false,
      Type: 'LINUX_CONTAINER',
      EnvironmentVariables: [
        {
          Name: "SCRIPT_S3_BUCKET",
          Type: "PLAINTEXT",
          Value: {
            Ref: "CanaryShellableScriptDirectoryS3Bucket436E0FC4"
          }
        },
        {
          Name: "SCRIPT_S3_KEY",
          Type: "PLAINTEXT",
          Value: {
            "Fn::Join": [
              "",
              [
                {
                  "Fn::Select": [
                    0,
                    {
                      "Fn::Split": [
                        "||",
                        {
                          Ref: "CanaryShellableScriptDirectoryS3VersionKeyC34904E8"
                        }
                      ]
                    }
                  ]
                },
                {
                  "Fn::Select": [
                    1,
                    {
                      "Fn::Split": [
                        "||",
                        {
                          Ref: "CanaryShellableScriptDirectoryS3VersionKeyC34904E8"
                        }
                      ]
                    }
                  ]
                }
              ]
            ]
          }
        },
        {
          Name: "IS_CANARY",
          Type: "PLAINTEXT",
          Value: "true"
        },
      ],
    },
    ServiceRole: {
      "Fn::GetAtt": [
        "CanaryShellableRole063BC07D",
        "Arn"
      ]
    },
    Source: {
      // tslint:disable-next-line:max-line-length
      BuildSpec: "{\n  \"version\": \"0.2\",\n  \"phases\": {\n    \"pre_build\": {\n      \"commands\": [\n        \"echo \\\"Downloading scripts from s3://${SCRIPT_S3_BUCKET}/${SCRIPT_S3_KEY}\\\"\",\n        \"aws s3 cp s3://${SCRIPT_S3_BUCKET}/${SCRIPT_S3_KEY} /tmp\",\n        \"mkdir -p /tmp/scriptdir\",\n        \"unzip /tmp/$(basename $SCRIPT_S3_KEY) -d /tmp/scriptdir\"\n      ]\n    },\n    \"build\": {\n      \"commands\": [\n        \"export SCRIPT_DIR=/tmp/scriptdir\",\n        \"echo \\\"Running test.sh\\\"\",\n        \"/bin/bash /tmp/scriptdir/test.sh\"\n      ]\n    }\n  }\n}"
    }
  }));
});
