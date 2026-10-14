import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The client half imports the published ui-primitives, whose dist drags in
    // CSS. Inline the harness packages so their CSS goes through the transform
    // pipeline, and process CSS in tests.
    css: true,
    environment: 'jsdom',
    // Some specs run a real PowerShell process (the semantics-preservation
    // pair), which is slower than any pure unit test on a loaded machine.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.spec.{ts,tsx}'],
    server: {
      deps: {
        inline: [/@deepseek-ai/],
      },
    },
  },
})
