// Test setup. LLDBClient now adapts Node's worker_threads internally (see
// makeWorker in client.ts), so no browser Worker polyfill is needed here; the
// tests exercise the real Node code path.
export {};
