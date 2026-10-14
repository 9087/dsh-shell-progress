import { defineConfig } from '@playwright/test'

/**
 * The real-browser suite: a throwaway `dsh web` booted per file, my plugin linked
 * into its profile, and a Chromium page driving it.
 *
 * Serial and single-worker on purpose. Each file owns a host process and a
 * temporary `DSH_HOME`, and two boots at once would be two hosts competing for
 * the same cold-start work — for tests that are seconds long, parallelism buys
 * nothing and costs flakes.
 */
export default defineConfig({
  testDir: 'e2e',
  // A test's first step can be a cold `dsh web` boot plus a Chromium launch.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1400, height: 900 },
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium' }],
})
