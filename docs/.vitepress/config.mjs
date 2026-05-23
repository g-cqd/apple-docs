import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

const config = defineConfig({
  title: 'apple-docs',
  description: 'Apple Developer Documentation CLI and MCP server — search, read, and browse Apple docs locally.',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: [
    'README.md',
  ],
  markdown: {
    languageAlias: {
      caddy: 'nginx',
      plist: 'xml',
    },
  },
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
          { text: 'Public-instance update', link: '/runbooks/public-instance-update' },
          { text: 'Grafana dashboards', link: '/ops-grafana' },
        ],
      },
      {
        text: 'Performance',
        items: [
          { text: 'Profiling workflow', link: '/perf/' },
          { text: 'End-to-end snapshot loop', link: '/perf/e2e-local-snapshot-loop' },
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
  mermaid: {
    theme: 'default',
  },
})

export default withMermaid(config)
