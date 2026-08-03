import { expect } from 'chai';

import {
  materializeCurve,
  parsePiecewiseCurveConfig,
} from '../scripts/moonpay/piecewise-fee-lib.js';

describe('Moonpay piecewise fee curves', () => {
  it('parses config and scales human thresholds using local token decimals', () => {
    const config = parsePiecewiseCurveConfig({
      version: 1,
      routeIds: ['USDC/moonpay-staging'],
      ttl: '24h',
      origins: {
        bsc: {
          breakpoints: ['100000', '250000'],
          marginalBps: [1, 4, 12],
        },
      },
    });

    expect(config.ttlSeconds).to.equal(86_400);
    expect(materializeCurve(config.origins.bsc, 18, 4)).to.deep.equal({
      breakpoints: [100_000n * 10n ** 18n, 250_000n * 10n ** 18n],
      marginalBpsX1e4: [10_000, 40_000, 120_000],
    });
  });

  it('rejects curves that exceed maxBands or decrease marginal rates', () => {
    const curve = {
      breakpoints: ['100', '200'],
      marginalBps: [1, 4, 3],
    };
    expect(() => materializeCurve(curve, 6, 2)).to.throw('contract supports 2');
    expect(() => materializeCurve(curve, 6, 4)).to.throw(
      'must be nondecreasing',
    );
  });

  it('requires quoted amounts to be strings to avoid YAML precision loss', () => {
    expect(() =>
      parsePiecewiseCurveConfig({
        version: 1,
        routeIds: ['USDC/moonpay-staging'],
        ttl: '24h',
        origins: {
          bsc: { breakpoints: [100_000], marginalBps: [1, 4] },
        },
      }),
    ).to.throw('must be decimal strings');
  });
});
