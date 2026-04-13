const INSTRUCTIONS = {
  'github-pages': [
    '1. Push your built site to the `gh-pages` branch (or configure GitHub Pages to use `docs/` on `main`).',
    '2. Go to Settings > Pages in your GitHub repository.',
    '3. Set Source to "Deploy from a branch" and select `gh-pages` / `root`.',
    '4. Run: apple-docs web build --base-url https://<user>.github.io/<repo>',
    '5. Copy the contents of dist/web/ to your gh-pages branch and push.',
    '6. GitHub Actions example: use `peaceiris/actions-gh-pages` to automate deployment.',
  ],
  cloudflare: [
    '1. Log in to the Cloudflare dashboard and go to Pages.',
    '2. Click "Create a project" and connect your Git repository.',
    '3. Set the build command to: bun run web:build',
    '4. Set the build output directory to: dist/web',
    '5. Add environment variable BASE_URL with your Cloudflare Pages domain.',
    '6. Deploy — Cloudflare Pages will rebuild on every push to your default branch.',
  ],
  vercel: [
    '1. Install the Vercel CLI: npm i -g vercel',
    '2. Run: apple-docs web build --out dist/web',
    '3. Run: vercel deploy --prebuilt dist/web',
    '4. For production: vercel deploy --prod --prebuilt dist/web',
    '5. Or connect your Git repo at vercel.com for automatic deployments.',
    '6. Set the output directory to dist/web in your Vercel project settings.',
  ],
  netlify: [
    '1. Install the Netlify CLI: npm i -g netlify-cli',
    '2. Run: apple-docs web build --out dist/web',
    '3. Run: netlify deploy --dir dist/web',
    '4. For production: netlify deploy --prod --dir dist/web',
    '5. Or connect your Git repo at netlify.com for automatic deployments.',
    '6. Set publish directory to dist/web in your Netlify site settings.',
  ],
}

const SUPPORTED_PLATFORMS = Object.keys(INSTRUCTIONS)

/**
 * Returns deployment instructions for a given hosting platform.
 *
 * @param {{ platform?: string }} opts
 * @returns {{ platform: string, instructions: string[] }}
 */
export function webDeploy(opts) {
  const platform = opts.platform ?? 'github-pages'

  if (!INSTRUCTIONS[platform]) {
    const supported = SUPPORTED_PLATFORMS.join(', ')
    throw new Error(`Unknown platform: "${platform}". Supported platforms: ${supported}`)
  }

  return {
    platform,
    instructions: INSTRUCTIONS[platform],
  }
}
