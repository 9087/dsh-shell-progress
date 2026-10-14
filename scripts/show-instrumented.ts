/**
 * Print a command next to the instrumented form this plugin actually executes.
 *
 * The whole live-progress mechanism is one idea: splice a marker write between
 * the user's statements, so the host can tell which step each line of output
 * belongs to. Seeing the two forms side by side is the fastest way to check that
 * the transformation is what it claims to be.
 *
 * Usage: node scripts/show-instrumented.ts
 */

import { createNonce, instrument } from '../src/instrument.ts'
import { splitSteps } from '../src/split.ts'

const COMMAND = [
  'Write-Output "[1/4] fetch"; Start-Sleep -Seconds 2',
  'Write-Output "[2/4] build"; Start-Sleep -Seconds 8',
  'Write-Output "[3/4] test";  Start-Sleep -Seconds 18',
  'Write-Output "[4/4] pack"',
].join('\n')

const split = splitSteps(COMMAND)

process.stdout.write('===== 1. 原始命令（你写的）=====\n')
process.stdout.write(`${COMMAND}\n`)
process.stdout.write(`\n分析结果: safe=${String(split.safe)} steps=${String(split.steps.length)}\n`)
for (const step of split.steps) {
  process.stdout.write(`  第 ${String(step.index + 1)} 步 @ 第 ${String(step.line)} 行: ${step.text}\n`)
}

process.stdout.write('\n===== 2. 实际执行的命令（打点之后）=====\n')
process.stdout.write(`${instrument(COMMAND, split.steps, createNonce())}\n`)
