/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: { command: 'bun test --isolate' },
  coverageAnalysis: 'off',
  disableTypeChecks: '**/*.{js,ts,jsx,tsx,mjs}',
  mutate: [
    'src/**/*.js',
    '!src/web/assets/**',
    '!src/web/worker/**',
  ],
  reporters: ['html', 'clear-text', 'progress', 'json'],
  htmlReporter: { fileName: 'reports/stryker/index.html' },
  jsonReporter: { fileName: 'reports/stryker/mutation-report.json' },
  concurrency: 4,
  timeoutMS: 30000,
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  mutator: {
    excludedMutations: ['StringLiteral', 'ObjectLiteral'],
  },
}
