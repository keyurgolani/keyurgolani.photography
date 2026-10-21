// server-only resolves to an empty module under React's react-server condition, which Next uses for server
// code. Vitest doesn't set that condition, so vitest.config.ts points server-only here instead.
export {};
