import aws = require('aws-sdk');
import crypto = require('crypto');
import fs = require('fs');
import os = require('os');
import path = require('path');
import util = require('util');

import cfn = require('./_cloud-formation');
import _exec = require('./_exec');
import lambda = require('./_lambda');
import _rmrf = require('./_rmrf');

const mkdtemp = util.promisify(fs.mkdtemp);
const writeFile = util.promisify(fs.writeFile);

const secretsManager = new aws.SecretsManager();
const ssm = new aws.SSM();

exports.handler = cfn.customResourceHandler(handleEvent);

interface ResourceAttributes extends cfn.ResourceAttributes {
  SecretArn: string;
  PublicKey: string;
}

async function handleEvent(event: cfn.Event, context: lambda.Context): Promise<cfn.ResourceAttributes> {
  const props = event.ResourceProperties;

  if (event.RequestType !== cfn.RequestType.DELETE) {
    cfn.validateProperties(props, {
      Description: false,
      Email: true,
      Expiry: true,
      Identity: true,
      KeyArn: false,
      KeySizeBits: true,
      SecretName: true,
      Version: false,
    });
  }

  let newKey = event.RequestType === cfn.RequestType.CREATE;

  if (event.RequestType === cfn.RequestType.UPDATE) {
    const oldProps = event.OldResourceProperties;
    const immutableFields = ['Email', 'Expiry', 'Identity', 'KeySizeBits', 'SecretName', 'Version'];
    for (const key of immutableFields) {
      if (props[key] !== oldProps[key]) {
        // tslint:disable-next-line:no-console
        console.log(`New key required: ${key} changed from ${oldProps[key]} to ${props[key]}`);
        newKey = true;
      }
    }
  }

  switch (event.RequestType) {
  case cfn.RequestType.CREATE:
  case cfn.RequestType.UPDATE:
    // If we're UPDATE and get a new key, we'll issue a new Physical ID.
    return newKey
          ? await _createNewKey(event, context)
          : await _updateExistingKey(event as cfn.UpdateEvent, context);
  case cfn.RequestType.DELETE:
    return { Ref: event.PhysicalResourceId };
  }
}

async function _createNewKey(event: cfn.CreateEvent | cfn.UpdateEvent, context: lambda.Context): Promise<ResourceAttributes> {
  const passPhrase = crypto.randomBytes(32).toString('base64');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'OpenPGP-'));
  try {
    process.env.GNUPGHOME = tempDir;

    const keyConfig = path.join(tempDir, 'key.config');
    await writeFile(keyConfig, [
      'Key-Type: RSA',
      `Key-Length: ${event.ResourceProperties.KeySizeBits}`,
      `Name-Real: ${event.ResourceProperties.Identity}`,
      `Name-Email: ${event.ResourceProperties.Email}`,
      `Expire-Date: ${event.ResourceProperties.Expiry}`,
      `Passphrase: ${passPhrase}`,
      '%commit',
      '%echo done',
    ].join('\n'), { encoding: 'utf8' });

    await _exec('gpg', '--batch', '--gen-key', keyConfig);
    const keyMaterial = await _exec('gpg', '--batch', '--yes', '--export-secret-keys', '--armor');
    const publicKey =   await _exec('gpg', '--batch', '--yes', '--export',             '--armor');
    const secretOpts = {
      ClientRequestToken: context.awsRequestId,
      Description: event.ResourceProperties.Description,
      KmsKeyId: event.ResourceProperties.KeyArn,
      SecretString: JSON.stringify({
        PrivateKey: keyMaterial,
        Passphrase: passPhrase
      }),
    };
    const secret = event.RequestType === cfn.RequestType.CREATE
                 ? await secretsManager.createSecret({ ...secretOpts, Name: event.ResourceProperties.SecretName }).promise()
                 : await secretsManager.updateSecret({ ...secretOpts, SecretId: event.PhysicalResourceId }).promise();

    return {
      Ref: secret.ARN!,
      SecretArn: secret.ARN!,
      PublicKey: publicKey
    };
  } finally {
    await _rmrf(tempDir);
  }
}

async function _updateExistingKey(event: cfn.UpdateEvent, context: lambda.Context): Promise<ResourceAttributes> {
  const publicKey = await _getPublicKey(event.PhysicalResourceId);
  const result = await secretsManager.updateSecret({
    ClientRequestToken: context.awsRequestId,
    Description: event.ResourceProperties.Description,
    KmsKeyId: event.ResourceProperties.KeyArn,
    SecretId: event.PhysicalResourceId,
  }).promise();

  if (event.OldResourceProperties.ParameterName) {
    // Migrating from a version that did create the SSM Parameter from the Custom Resource, so we'll delete that now in
    // order to allow the "external" creation to happen without problems...
    try {
      await ssm.deleteParameter({ Name: event.OldResourceProperties.ParameterName }).promise();
    } catch (e) {
      // Allow the parameter to already not exist, just in case!
      if (e.code !== 'ParameterNotFound') {
        throw e;
      }
    }
  }

  return {
    Ref: result.ARN!,
    SecretArn: result.ARN!,
    PublicKey: publicKey
  };
}

async function _getPublicKey(secretArn: string): Promise<string> {
  const secretValue = await secretsManager.getSecretValue({ SecretId: secretArn }).promise();
  const keyData = JSON.parse(secretValue.SecretString!);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'OpenPGP-'));
  try {
    process.env.GNUPGHOME = tempDir;
    const privateKeyFile = path.join(tempDir, 'private.key');
    await writeFile(privateKeyFile, keyData.PrivateKey, { encoding: 'utf-8' });
    // Note: importing a private key does NOT require entering it's passphrase!
    await _exec('gpg', '--batch', '--yes', '--import', privateKeyFile);
    return await _exec('gpg', '--batch', '--yes', '--export', '--armor');
  } finally {
    await _rmrf(tempDir);
  }
}
