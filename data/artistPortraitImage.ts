// About's portrait as a static import, so Next serves it content-hashed from
// /_next/static/media and the one-day image cache can't hand out a stale file.
// It sits apart from data/artist.ts because Playwright, which imports that
// file, can't load a .png. Keep it in step with `artist.profile.portrait`.
import portraitImage from '../public/assets/profile/front.png';

export default portraitImage;
