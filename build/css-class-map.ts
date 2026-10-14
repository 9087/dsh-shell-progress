/**
 * The class map a `x.module.css` import yields, as a DETERMINISTIC object.
 *
 * lightningcss hands `exports` back in an order that is not stable across runs,
 * and the client bundle emits this table verbatim as the module's default
 * export, so that order would leak into the artifact's bytes: two builds of
 * identical sources would produce different bundles — same length, same class
 * names, same hashed values, merely permuted.
 *
 * Sorting by the SOURCE class name makes the emitted map a function of the
 * stylesheet again.
 */

/**
 * Build the emitted CSS-module class map with its keys in sorted order.
 * @param cssExports - lightningcss's `exports` table, keyed by the local name.
 * @returns the same mapping with keys in sorted order.
 */
export function cssClassMap(
  cssExports: Readonly<Record<string, { name: string }>> | undefined,
): Record<string, string> {
  const table = cssExports ?? {}
  const classMap: Record<string, string> = {}
  for (const local of Object.keys(table).sort()) {
    const entry = table[local]
    if (entry !== undefined) classMap[local] = entry.name
  }
  return classMap
}
