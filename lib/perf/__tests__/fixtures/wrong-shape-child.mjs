// A stand-in for lib/perf/budgets-cli.ts that answers valid JSON of the wrong shape, for publishWarning.test.ts
// (PHOTOS_BUDGETS_CHILD). It reads its input first, as the real child does.
for await (const _chunk of process.stdin);
process.stdout.write(JSON.stringify({ screens: null, over: 'none' }));
