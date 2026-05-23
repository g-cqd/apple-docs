import { defineConfig } from 'vitepress'

// Documentation-site config. Builds the contents of `docs/` (plus the
// repo-root README.md / ARCHITECTURE.md / SECURITY.md included via
// `<!--@include:-->` macros) into a static site under
// `docs/.vitepress/dist/`. Run `bun run docs:dev` for live preview.

export default defineConfig({
  title: 'apple-docs',
  description: 'Apple Developer Documentation CLI and MCP server — search, read, and browse Apple docs locally.',
  cleanUrls: true,
  lastUpdated: true,
  // README.md is the GitHub directory landing; index.md is the site
  // landing. Skip it so VitePress doesn't try to render both.
  srcExclude: [
    'README.md',
  ],
  markdown: {
    // Reduce noise: don't fail on missing language definitions.
    languageAlias: {
      caddy: 'nginx',
      plist: 'xml',
    },
  },
  // VitePress' default theme is fine — keep things minimal.
  themeConfig: {
    logo: undefined,
    nav: [
      { text: 'Install', link: '/installing' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Self-hosting', link: '/self-hosting' },
      { text: 'GitHub', link: 'https://github.com/g-cqd/apple-docs' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Installing', link: '/installing' },
          { text: 'Architecture', link: '/architecture' },
        ],
      },
      {
        text: 'Operating',
        items: [
          { text: 'Self-hosting', link: '/self-hosting' },
          {
            text: 'Runbooks',
            collapsed: false,
            items: [
              { text: 'Public-instance update', link: '/runbooks/public-instance-update' },
              { text: 'Symbols & fonts cache rebuild', link: '/runbooks/symbols-fonts-cache-rebuild' },
            ],
          },
          { text: 'Grafana dashboards', link: '/ops-grafana' },
        ],
      },
      {
        text: 'Performance',
        items: [
          { text: 'Profiling workflow', link: '/perf/' },
          { text: 'E2E snapshot loop', link: '/perf/e2e-local-snapshot-loop' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'Security', link: '/security' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/g-cqd/apple-docs' },
    ],
    editLink: {
      pattern: 'https://github.com/g-cqd/apple-docs/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    search: {
      provider: 'local',
    },
    footer: {
      message: 'MIT licensed.',
      copyright: 'apple-docs — Apple Developer Documentation CLI and MCP server.',
    },
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
  },
  // Site links live in the docs/ URL space; GitHub-relative links inside
  // the source markdown (e.g. ../README.md from a docs file, ./src/... from
  // the included ARCHITECTURE.md) don't resolve under the site root.
  // Surface those as warnings rather than build-fatal so the site stays
  // shippable while still rendering the cross-references intact for GitHub
  // readers.
  ignoreDeadLinks: true,
})
