// Imported FIRST by the release/doctor entry points, before config loads: marks the process
// so config only enforces what those steps need (database + network identity), not every
// service key. Web and worker dynos still refuse to start with an incomplete config.
process.env.ZEEP_PHASE ??= 'release';
export {};
