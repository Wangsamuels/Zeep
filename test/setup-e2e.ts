// Env for the e2e run; imported before anything that reads config.
import './setup.js';
process.env.MIN_CONFIRMATIONS = '1';
process.env.FLOAT_MODE = 'auto';
process.env.TREASURY_RAILS = 'mock';
process.env.ZEEP_RESERVE_TADDR = 'tmReserveDevAddressXXXXXXXXXXXXXXXX';
process.env.DEV_GENESIS_UNIX = '1760000000';
process.env.DEV_BLOCK_SECS = '1';
