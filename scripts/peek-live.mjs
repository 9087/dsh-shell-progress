/**
 * Read this plugin's temporary probe line off the RUNNING host.
 *
 * The live card state exists only in a browser while a call is in flight, so the
 * only way to see it from a shell is to BE a browser: this attaches a headless
 * Chromium to the host the user is already using, opens whatever session holds
 * this plugin's cards, expands the rows, and prints the card text — which is where
 * the probe line lives.
 *
 * It does not need the session id: it walks the sidebar and picks the session
 * whose transcript actually contains the cards.
 *
 * Read-only: it types nothing, sends nothing, and clicks only disclosure rows.
 *
 * Usage: [PEEK_URL=http://127.0.0.1:3080] node scripts/peek-live.mjs
 */

import { chromium } from '@playwright/test'

const url = process.env.PEEK_URL ?? 'http://127.0.0.1:3080'

const browser = await chromium.launch()
const page = await browser.newPage()

page.on('pageerror', (error) => { process.stdout.write(`[pageerror] ${String(error)}\n`) })
page.on('console', (message) => {
  if (message.type() === 'error') process.stdout.write(`[console.error] ${message.text()}\n`)
})

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3_000)

/** Open every collapsed disclosure so bodies are in the DOM. */
async function expandAll() {
  for (let round = 0; round < 8; round += 1) {
    const collapsed = page.locator('[aria-expanded="false"]')
    const count = await collapsed.count().catch(() => 0)
    if (count === 0) return
    await collapsed.first().click({ timeout: 2_000 }).catch(() => {})
    await page.waitForTimeout(100)
  }
}

/** The session entries offered in the sidebar. */
const entries = page.locator('[class*="session"], nav a, aside a, aside button')
const total = Math.min(await entries.count().catch(() => 0), 12)
process.stdout.write(`[peek] sidebar candidates=${String(total)}\n`)

for (let index = 0; index < total; index += 1) {
  await entries.nth(index).click({ timeout: 2_000 }).catch(() => {})
  await page.waitForTimeout(900)
  await expandAll()
  const cards = await page.locator('[data-chat-call-id]').count().catch(() => 0)
  if (cards === 0) continue
  const dump = await page.evaluate(() => [...document.querySelectorAll('[data-chat-call-id]')].map((card) => ({
    id: card.getAttribute('data-chat-call-id'),
    text: (card.textContent ?? '').replace(/\s+/g, ' ').slice(0, 300),
  })))
  process.stdout.write(`[peek] entry ${String(index)} has ${String(cards)} card(s)\n`)
  for (const card of dump) process.stdout.write(`[peek] ${card.id} :: ${card.text}\n`)
  break
}

await browser.close()
