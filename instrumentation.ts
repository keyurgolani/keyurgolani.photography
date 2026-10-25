// Runs once when a server starts. The build also loads it, so skip that phase.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { checkSiteUrl } = await import('./lib/site/config');
    checkSiteUrl();
    // With CURATION_ENABLED=true, a server told to listen, or listening, beyond loopback, or
    // with a bad CURATOR_TUNNEL_PORT, stops here. Next has already opened its
    // port by now, so every curator request is also refused on its own until
    // the process exits (lib/curation/auth/policy.ts).
    const { curatorStartupProblem } = await import('./lib/curation/auth/policy');
    const problem = curatorStartupProblem(process.env, process.argv);
    if (problem !== null) {
      console.error(`CURATION_ENABLED is true, but ${problem}. The curator listens on loopback only: see docs/curator.md. Stopping.`);
      process.exit(1);
    }
  }
}
