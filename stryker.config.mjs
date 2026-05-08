/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  // Stay on the `command` runner. Tried switching to
  // `stryker-mutator-bun-runner` (the dedicated Bun plugin), but its
  // BunResultParser is built around `(pass)` / `(fail)` per-test lines
  // and a `5 pass | 0 fail` summary regex — neither matches Bun
  // 1.3.13's current output (compact summary, no per-test lines on
  // macOS, "X pass" / "Y fail" on separate lines), so the runner
  // reports 0 tests executed even when 1188 ran. Revisit when the
  // runner's parser catches up with current Bun.
  //
  // Without --isolate, single-process bun test is dramatically faster
  // for the dryRun baseline (~14s in the sandbox vs >5 min on
  // Ubuntu CI with --isolate's per-file worker spawning) AND keeps
  // tests deterministic. The mutation job already pays the
  // process-restart cost between mutants.
  testRunner: 'command',
  commandRunner: { command: 'bun test' },
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
  timeoutMS: 20000,
  // Bumped from the 5-min default. The dry-run baseline locally is
  // ~14s; a cold sandbox start on CI can spike higher. 10 min is
  // plenty of headroom without masking real hangs.
  dryRunTimeoutMinutes: 10,
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  mutator: {
    excludedMutations: [
      'StringLiteral',
      'ObjectLiteral',
      'BlockStatement',
      'Regex',
      'ArrayDeclaration',
    ],
  },
}
