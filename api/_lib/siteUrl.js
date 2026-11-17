// Public address of this deployment. Preview deployments use their own
// Vercel address (stable branch URL first) so Stripe returns test buyers to
// the preview, not to the live site. Production uses SITE_URL.
export function siteUrl(env = process.env) {
  const previewHost = env.VERCEL_ENV === 'preview' ? (env.VERCEL_BRANCH_URL || env.VERCEL_URL) : ''
  const url = previewHost ? `https://${previewHost}` : (env.SITE_URL || 'https://www.homedepo.tech')
  return url.replace(/\/$/, '')
}
