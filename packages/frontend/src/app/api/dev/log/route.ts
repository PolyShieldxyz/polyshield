/**
 * POST /api/dev/log
 * Receives structured log entries from the browser and appends them to logs/frontend.jsonl.
 * Only active when NEXT_PUBLIC_DEV_MODE=true.
 */
import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

// logs/ lives at the monorepo root (two levels up from packages/frontend)
const LOG_DIR = path.resolve(process.cwd(), '..', '..', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'frontend.jsonl')

let dirReady = false

function ensureDir(): void {
  if (dirReady) return
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    dirReady = true
  } catch {
    // If logs/ can't be created we just skip writing — never crash the dev server
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.NEXT_PUBLIC_DEV_MODE !== 'true') {
    return NextResponse.json({ error: 'log endpoint only available in dev mode' }, { status: 403 })
  }

  try {
    const body: unknown = await req.json()
    ensureDir()
    if (dirReady) {
      fs.appendFileSync(LOG_FILE, JSON.stringify(body) + '\n', 'utf-8')
    }
    return NextResponse.json({ ok: true })
  } catch {
    // Never surface log failures back to the client
    return NextResponse.json({ ok: true })
  }
}
