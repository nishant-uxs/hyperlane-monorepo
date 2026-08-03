import { Wallet, constants, ethers } from 'ethers';

import {
  BaseFee__factory,
  CrossCollateralRoutingFee__factory,
  IERC20Metadata__factory,
  OffchainQuotedPiecewiseLinearFee__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { MultiProvider, OnchainTokenFeeType } from '@hyperlane-xyz/sdk';
import { addressToBytes32, assert, rootLogger } from '@hyperlane-xyz/utils';

import { getDomainId, getWarpCoreConfig } from '../../config/registry.js';

import {
  EIP712_NAME,
  EIP712_VERSION,
  SIGNED_QUOTE_TYPES,
  WILDCARD_RECIPIENT,
  buildAddrMaps,
} from './oqlf-lib.js';

const logger = rootLogger.child({ module: 'moonpay-piecewise-fees' });
const MAX_UINT128 = 2n ** 128n - 1n;
const MAX_MARGINAL_BPS_X1E4 = 100_000_000;

export interface HumanCurve {
  breakpoints: string[];
  marginalBps: number[];
}

export interface PiecewiseCurveConfig {
  version: 1;
  routeIds: string[];
  ttlSeconds: number;
  origins: Record<string, HumanCurve>;
}

export interface MaterializedCurve {
  breakpoints: bigint[];
  marginalBpsX1e4: number[];
}

export interface PiecewiseSlot {
  origin: string;
  sourceToken: string;
  destination: string;
  destDomain: number;
  target: string;
  piecewiseFeeAddress: string;
  tokenDecimals: number;
  maxBands: number;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export function parseTtlSeconds(value: unknown): number {
  assert(typeof value === 'string', 'ttl must be a duration string');
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)(s|h|d)$/);
  assert(match, `Invalid ttl ${value}; use a duration such as 24h`);
  const amount = Number(match[1]);
  const multiplier = match[2] === 's' ? 1 : match[2] === 'h' ? 3_600 : 86_400;
  const seconds = amount * multiplier;
  assert(
    Number.isSafeInteger(seconds) && seconds > 0,
    `ttl must resolve to positive whole seconds, got ${value}`,
  );
  return seconds;
}

export function parsePiecewiseCurveConfig(
  input: unknown,
): PiecewiseCurveConfig {
  assert(
    typeof input === 'object' && input !== null,
    'config must be an object',
  );
  const config = input as Record<string, unknown>;
  assert(config.version === 1, 'config version must be 1');
  assert(
    Array.isArray(config.routeIds) &&
      config.routeIds.length > 0 &&
      config.routeIds.every((route) => typeof route === 'string'),
    'routeIds must be a non-empty string array',
  );
  assert(
    typeof config.origins === 'object' && config.origins !== null,
    'origins must be an object',
  );

  const origins: Record<string, HumanCurve> = {};
  for (const [origin, rawCurve] of Object.entries(config.origins)) {
    assert(
      typeof rawCurve === 'object' && rawCurve !== null,
      `curve for ${origin} must be an object`,
    );
    const curve = rawCurve as Record<string, unknown>;
    assert(
      Array.isArray(curve.breakpoints) &&
        curve.breakpoints.every((amount) => typeof amount === 'string'),
      `breakpoints for ${origin} must be decimal strings`,
    );
    assert(
      Array.isArray(curve.marginalBps) &&
        curve.marginalBps.every((rate) => typeof rate === 'number'),
      `marginalBps for ${origin} must be numbers`,
    );
    assert(
      curve.marginalBps.length === curve.breakpoints.length + 1,
      `marginalBps for ${origin} must have one more entry than breakpoints`,
    );
    origins[origin] = {
      breakpoints: [...curve.breakpoints],
      marginalBps: [...curve.marginalBps],
    };
  }
  assert(Object.keys(origins).length > 0, 'origins must not be empty');

  return {
    version: 1,
    routeIds: [...config.routeIds],
    ttlSeconds: parseTtlSeconds(config.ttl),
    origins,
  };
}

function marginalBpsToX1e4(bps: number): number {
  assert(
    Number.isFinite(bps) && bps >= 0 && bps <= 10_000,
    `marginal bps must be between 0 and 10000, got ${bps}`,
  );
  const scaled = Math.round(bps * 10_000);
  assert(
    Math.abs(scaled / 10_000 - bps) < Number.EPSILON * 10,
    `marginal bps supports at most four decimal places, got ${bps}`,
  );
  assert(scaled <= MAX_MARGINAL_BPS_X1E4, `marginal bps is too large: ${bps}`);
  return scaled;
}

export function materializeCurve(
  curve: HumanCurve,
  tokenDecimals: number,
  maxBands: number,
): MaterializedCurve {
  assert(
    curve.marginalBps.length <= maxBands,
    `curve has ${curve.marginalBps.length} bands but contract supports ${maxBands}`,
  );
  const breakpoints = curve.breakpoints.map((amount) => {
    const scaled = ethers.utils.parseUnits(amount, tokenDecimals).toBigInt();
    assert(scaled > 0n, `breakpoint must be positive, got ${amount}`);
    assert(scaled <= MAX_UINT128, `breakpoint exceeds uint128: ${amount}`);
    return scaled;
  });
  for (let i = 1; i < breakpoints.length; i += 1) {
    assert(
      breakpoints[i] > breakpoints[i - 1],
      'breakpoints must be strictly increasing',
    );
  }

  const marginalBpsX1e4 = curve.marginalBps.map(marginalBpsToX1e4);
  for (let i = 1; i < marginalBpsX1e4.length; i += 1) {
    assert(
      marginalBpsX1e4[i] >= marginalBpsX1e4[i - 1],
      'marginal rates must be nondecreasing',
    );
  }
  return { breakpoints, marginalBpsX1e4 };
}

export async function discoverPiecewiseSlots(
  multiProvider: MultiProvider,
  config: PiecewiseCurveConfig,
): Promise<PiecewiseSlot[]> {
  const { addrToLabel, routersByChain } = buildAddrMaps(config.routeIds);
  const warpConfigs = config.routeIds.map((routeId) => ({
    routeId,
    config: getWarpCoreConfig(routeId),
  }));
  const destinationChains = [
    ...new Set(
      warpConfigs.flatMap(({ config: warpConfig }) =>
        warpConfig.tokens.flatMap((token) =>
          token.chainName ? [token.chainName] : [],
        ),
      ),
    ),
  ];
  const decimalsCache = new Map<string, Promise<number>>();
  const slots: PiecewiseSlot[] = [];

  await Promise.all(
    warpConfigs.flatMap(({ config: warpConfig }) =>
      warpConfig.tokens
        .filter(
          (token) =>
            token.chainName &&
            token.addressOrDenom &&
            config.origins[token.chainName] &&
            /^0x[0-9a-f]{40}$/i.test(token.addressOrDenom),
        )
        .map(async (originToken) => {
          const origin = originToken.chainName;
          const routerAddress = originToken.addressOrDenom;
          const provider = multiProvider.getProvider(origin);
          try {
            const routingFeeAddress = await TokenRouter__factory.connect(
              routerAddress,
              provider,
            ).feeRecipient();
            if (routingFeeAddress === constants.AddressZero) return;
            const feeType = await BaseFee__factory.connect(
              routingFeeAddress,
              provider,
            ).feeType();
            if (feeType !== OnchainTokenFeeType.CrossCollateralRoutingFee)
              return;

            const routingFee = CrossCollateralRoutingFee__factory.connect(
              routingFeeAddress,
              provider,
            );
            const defaultRouter = await routingFee.DEFAULT_ROUTER();
            for (const destination of destinationChains) {
              const destDomain = getDomainId(destination);
              const targets = [
                { key: defaultRouter, label: 'DEFAULT' },
                ...(routersByChain.get(destination) ?? []).map((router) => ({
                  key: addressToBytes32(router),
                  label: addrToLabel.get(router) ?? router,
                })),
              ];
              for (const target of targets) {
                const piecewiseFeeAddress = await routingFee.feeContracts(
                  destDomain,
                  target.key,
                );
                if (piecewiseFeeAddress === constants.AddressZero) continue;
                const baseFee = BaseFee__factory.connect(
                  piecewiseFeeAddress,
                  provider,
                );
                if (
                  (await baseFee.feeType()) !==
                  OnchainTokenFeeType.OffchainQuotedPiecewiseLinearFee
                )
                  continue;
                const piecewiseFee =
                  OffchainQuotedPiecewiseLinearFee__factory.connect(
                    piecewiseFeeAddress,
                    provider,
                  );
                const [feeToken, maxBands] = await Promise.all([
                  piecewiseFee.token(),
                  piecewiseFee.maxBands(),
                ]);
                const decimalsKey = `${origin}:${feeToken.toLowerCase()}`;
                let decimalsPromise = decimalsCache.get(decimalsKey);
                if (!decimalsPromise) {
                  decimalsPromise = IERC20Metadata__factory.connect(
                    feeToken,
                    provider,
                  ).decimals();
                  decimalsCache.set(decimalsKey, decimalsPromise);
                }
                slots.push({
                  origin,
                  sourceToken:
                    addrToLabel.get(routerAddress.toLowerCase()) ??
                    originToken.symbol ??
                    origin,
                  destination,
                  destDomain,
                  target: target.label,
                  piecewiseFeeAddress,
                  tokenDecimals: await decimalsPromise,
                  maxBands,
                });
              }
            }
          } catch (error) {
            logger.warn(
              { origin, routerAddress, error: errorMessage(error) },
              'Failed to discover piecewise fee slots for origin token',
            );
          }
        }),
    ),
  );

  return slots.sort(
    (a, b) =>
      a.origin.localeCompare(b.origin) ||
      a.sourceToken.localeCompare(b.sourceToken) ||
      a.destination.localeCompare(b.destination) ||
      (a.target === 'DEFAULT'
        ? -1
        : b.target === 'DEFAULT'
          ? 1
          : a.target.localeCompare(b.target)),
  );
}

export async function verifyPiecewiseSignerAuthorization(
  multiProvider: MultiProvider,
  signerKey: string,
  slots: PiecewiseSlot[],
): Promise<void> {
  const signerAddress = new Wallet(signerKey).address;
  const uniqueFees = new Map<string, PiecewiseSlot>();
  for (const slot of slots) {
    uniqueFees.set(
      `${slot.origin}:${slot.piecewiseFeeAddress.toLowerCase()}`,
      slot,
    );
  }
  const unauthorized = await Promise.all(
    [...uniqueFees.values()].map(async (slot) => {
      const fee = OffchainQuotedPiecewiseLinearFee__factory.connect(
        slot.piecewiseFeeAddress,
        multiProvider.getProvider(slot.origin),
      );
      return (await fee.isQuoteSigner(signerAddress)) ? null : slot;
    }),
  );
  const failures = unauthorized.filter(
    (slot): slot is PiecewiseSlot => slot !== null,
  );
  assert(
    failures.length === 0,
    `Signer ${signerAddress} is unauthorized on ${failures
      .map((slot) => `${slot.origin}:${slot.piecewiseFeeAddress}`)
      .join(', ')}`,
  );
}

export async function submitPiecewiseCurve(
  multiProvider: MultiProvider,
  signerKey: string,
  submitterWallet: Wallet,
  slot: PiecewiseSlot,
  curve: MaterializedCurve,
  ttlSeconds: number,
): Promise<string> {
  const provider = multiProvider.getProvider(slot.origin);
  const { chainId } = await provider.getNetwork();
  const issuedAt = Math.floor(Date.now() / 1_000);
  const quote = {
    context: ethers.utils.solidityPack(
      ['uint32', 'bytes32', 'uint256'],
      [slot.destDomain, WILDCARD_RECIPIENT, constants.MaxUint256],
    ),
    data: ethers.utils.defaultAbiCoder.encode(
      ['uint128[]', 'uint32[]'],
      [curve.breakpoints, curve.marginalBpsX1e4],
    ),
    issuedAt,
    expiry: issuedAt + ttlSeconds,
    salt: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
    submitter: constants.AddressZero,
  };
  const signature = await new Wallet(signerKey)._signTypedData(
    {
      name: EIP712_NAME,
      version: EIP712_VERSION,
      chainId,
      verifyingContract: slot.piecewiseFeeAddress,
    },
    SIGNED_QUOTE_TYPES,
    quote,
  );
  const fee = OffchainQuotedPiecewiseLinearFee__factory.connect(
    slot.piecewiseFeeAddress,
    submitterWallet.connect(provider),
  );
  const tx = await fee.submitQuote(
    quote,
    signature,
    multiProvider.getTransactionOverrides(slot.origin),
  );
  await tx.wait(1);
  return tx.hash;
}
