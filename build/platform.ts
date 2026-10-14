/**
 * Shared browser platform modules of the DeepSeek Harness web shell.
 *
 * This is the shell's FROZEN module table, read back out of the deployed
 * `@deepseek-ai/dsh-web-frontend` bundle (`dist/assets/index-*.js`, the object
 * literal passed to the module loader). Every specifier here is external at
 * bundle time and is answered by the loader's injected `require` at runtime.
 *
 * Two rules follow, and both have bitten real plugins:
 *
 * 1. A specifier listed here must be one the shell actually seeds. Marking a
 *    package external that the table cannot answer is a guaranteed runtime
 *    throw; inlining a package the table DOES answer duplicates its module
 *    identity (two copies of `ui-slots`, two slot registries).
 * 2. Anything else under `@deepseek-ai/*` must be a type-only import (erased)
 *    or it fails the bundle-purity gate in `./tsdown.client.ts`.
 *
 * @module build/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
