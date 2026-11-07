// Cindy's utility-process bootstrap loads this entry with createRequire().
// Start the protocol server unconditionally; keep the implementation importable for tests.
require('./worker.cjs').serve();
