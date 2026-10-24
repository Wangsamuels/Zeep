// Env for the e2e run; imported before anything that reads config.
import './setup.js';
process.env.MIN_CONFIRMATIONS = '1';
process.env.FLOAT_MODE = 'auto';
process.env.TREASURY_RAILS = 'mock';
// ZEEP_E2E_NETWORK=mainnet runs the whole suite with mainnet settings (addresses, models, no
// testnet caps) against the simulated chain and mock rails.
const mainnet = process.env.ZEEP_E2E_NETWORK === 'mainnet';
process.env.ZEEP_ENV = mainnet ? 'mainnet' : 'testnet';
process.env.ZCASH_NETWORK = mainnet ? 'main' : 'test';
if (mainnet) {
  process.env.ZEEP_TEST_SIMULATION = '1';
  process.env.MPP_MODE = 'mock';
  process.env.DATABASE_URL = 'postgres://zeep:zeep@localhost:5432/zeep_mainnet_test';
  process.env.REDIS_URL = 'redis://localhost:6379/1';
}
process.env.ZEEP_RESERVE_TADDR = (mainnet ? 't1' : 'tm') + 'ReserveDevAddressXXXXXXXXXXXXXXXX';
process.env.DEV_GENESIS_UNIX = '1760000000';
process.env.DEV_BLOCK_SECS = '1';
