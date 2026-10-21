// Runs once when a server starts. The build also loads it, so skip that phase.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { checkSiteUrl } = await import('./lib/site/config');
    checkSiteUrl();
  }
}
