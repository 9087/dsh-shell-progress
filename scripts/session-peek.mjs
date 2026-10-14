/**
 * One-off: read this plugin's call ids straight out of the host's own session log.
 *
 * The live-progress channel is keyed by `exec.callId` on the host and asked for by
 * the row's `callId` on the client. When those two disagree the host answers
 * "no such call" forever, the card keeps drawing its planned steps, and the only
 * visible symptom is a bar that never moves. The session log records the call
 * events the client builds its blocks from, so the ids can be compared from disk
 * instead of from a screenshot.
 *
 * Usage: node scripts/session-peek.mjs <path-to-session.v4.jsonl.zstd>
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (file === undefined) {
  process.stderr.write('usage: node scripts/session-peek.mjs <session.v4.jsonl.zstd>\n')
  process.exit(2)
}

const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
const lines = text.split('\n').filter((line) => line.includes('shell_progress'))
process.stdout.write(`[session] ${String(lines.length)} line(s) mention shell_progress\n`)

/** Print the call-ish events only, with the fields that carry identity. */
for (const line of lines.slice(-8)) {
  try {
    const event = JSON.parse(line)
    const record = event.data ?? event
    const name = record.name ?? record.toolName
    if (name !== 'shell_progress') continue
    const id = record.callId ?? record.id
    const keys = Object.keys(record).sort().join(',')
    process.stdout.write(`[call] type=${String(event.type ?? '')} id=${JSON.stringify(id)} keys=${keys}\n`)
  } catch {
    // A truncated tail line is expected while the session is being written.
  }
}
