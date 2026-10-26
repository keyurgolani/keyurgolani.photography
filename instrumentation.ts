// Runs once when a server starts. The build also loads it, so skip that phase.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { checkSiteUrl } = await import('./lib/site/config');
    checkSiteUrl();
    // Logs which portrait About shows, or why it shows none, then encodes its
    // derivatives in the background. Never throws, so a bad file can't stop the server.
    const { checkAboutPortrait } = await import('./lib/siteConfig/aboutPortrait');
    const { warmPortraitVariants } = await import('./lib/siteConfig/portraitVariants');
    await checkAboutPortrait();
    void warmPortraitVariants();
  }
}
