#!/usr/bin/env tsx

import { readFile } from 'node:fs/promises';

import { Wallet } from 'ethers';
import { parse as parseYaml } from 'yaml';
import yargs from 'yargs';

import { confirm } from '@inquirer/prompts';
import { getRegistry as getMergedRegistry } from '@hyperlane-xyz/registry/fs';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { getRegistry } from '../../config/registry.js';

import {
  GCP_DEPLOYER_SECRET,
  GCP_SIGNER_SECRET,
  resolveGcpKey,
} from './oqlf-lib.js';
import {
  discoverPiecewiseSlots,
  materializeCurve,
  parsePiecewiseCurveConfig,
  submitPiecewiseCurve,
  verifyPiecewiseSignerAuthorization,
} from './piecewise-fee-lib.js';

const DEFAULT_CONFIG =
  'config/environments/mainnet3/warp/fees/moonpay-staging-piecewise.yaml';

async function main(): Promise<void> {
  const args = await yargs(process.argv.slice(2))
    .option('config', {
      alias: 'c',
      type: 'string',
      default: DEFAULT_CONFIG,
      describe: 'Piecewise curve YAML file',
    })
    .option('registry', {
      alias: 'r',
      type: 'string',
      describe: 'Registry URI (local path or http://...)',
    })
    .option('submit', {
      type: 'boolean',
      default: false,
      describe: 'Sign and submit the displayed standing curves',
    })
    .option('yes', {
      alias: 'y',
      type: 'boolean',
      default: false,
      describe: 'Skip the submit confirmation prompt',
    })
    .strict()
    .parseAsync();

  const config = parsePiecewiseCurveConfig(
    parseYaml(await readFile(args.config, 'utf8')),
  );
  const rpcRegistry = args.registry
    ? getMergedRegistry({ registryUris: [args.registry], enableProxy: true })
    : getRegistry();
  const multiProvider = new MultiProvider(await rpcRegistry.getMetadata());
  const slots = await discoverPiecewiseSlots(multiProvider, config);
  assert(slots.length > 0, 'No deployed piecewise fee slots were found');

  const submissions = slots.map((slot) => ({
    slot,
    curve: materializeCurve(
      config.origins[slot.origin],
      slot.tokenDecimals,
      slot.maxBands,
    ),
  }));

  console.log(
    `${args.submit ? 'SUBMIT' : 'DRY RUN'}: ${submissions.length} standing curve(s), TTL ${config.ttlSeconds / 3_600}h`,
  );
  for (const { slot, curve } of submissions) {
    console.log(
      `${slot.origin} (${slot.sourceToken}) -> ${slot.destination} / ${slot.target} ` +
        `fee=${slot.piecewiseFeeAddress} decimals=${slot.tokenDecimals} ` +
        `breakpoints=[${curve.breakpoints.join(',')}] ratesX1e4=[${curve.marginalBpsX1e4.join(',')}]`,
    );
  }

  if (!args.submit) {
    console.log('Dry run complete. Pass --submit to sign and submit.');
    return;
  }
  if (!args.yes) {
    const approved = await confirm({
      message: `Submit ${submissions.length} standing curves?`,
      default: false,
    });
    if (!approved) return;
  }

  const signerKey = (await resolveGcpKey(GCP_SIGNER_SECRET)).privateKey;
  const submitterKey = (await resolveGcpKey(GCP_DEPLOYER_SECRET)).privateKey;
  await verifyPiecewiseSignerAuthorization(multiProvider, signerKey, slots);
  const submitter = new Wallet(submitterKey);

  for (const { slot, curve } of submissions) {
    process.stdout.write(
      `Submitting ${slot.origin} (${slot.sourceToken}) -> ${slot.destination} / ${slot.target}... `,
    );
    const txHash = await submitPiecewiseCurve(
      multiProvider,
      signerKey,
      submitter,
      slot,
      curve,
      config.ttlSeconds,
    );
    console.log(`${txHash.slice(0, 14)}... confirmed`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
