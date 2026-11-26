import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9cAAAAASUVORK5CYII='
export const TINY_JPEG_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]).toString('base64')
export const TINY_WEBP_BASE64 = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x14, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('VP8 '),
  Buffer.from([0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
]).toString('base64')

export function createTempWorkspace(prefix = 'xuong-test') {
  const dir = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const dbPath = join(dir, 'test.sqlite')
  const journalDir = join(dir, 'journal-photos')
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    dbPath,
    journalDir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close((err) => {
        if (err) reject(err)
        else resolvePort(port)
      })
    })
  })
}

export interface TestServerHandle {
  baseUrl: string
  port: number
  dbPath: string
  journalDir: string
  adminPassword: string
  stop: () => Promise<void>
}

export async function startTestServer(options?: {
  dbPath?: string
  journalDir?: string
  adminPassword?: string
}): Promise<TestServerHandle> {
  const workspace = options?.dbPath && options?.journalDir
    ? null
    : createTempWorkspace('xuong-srv')
  const dbPath = options?.dbPath ?? workspace!.dbPath
  const journalDir = options?.journalDir ?? workspace!.journalDir
  const adminPassword = options?.adminPassword ?? 'test-admin-secret-2026'
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`

  let stderrLog = ''
  const proc = spawn(process.execPath, ['server/index.ts'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      XUONG_DB: dbPath,
      XUONG_JOURNAL_DIR: journalDir,
      XUONG_ADMIN_PASSWORD: adminPassword,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrLog += chunk.toString('utf8')
  })

  let ready = false
  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) break
    try {
      const res = await fetch(`${baseUrl}/api/health`)
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      // Server still booting.
    }
    await new Promise((r) => setTimeout(r, 120))
  }

  if (!ready) {
    proc.kill()
    workspace?.cleanup()
    throw new Error(`Test server failed to boot on ${baseUrl}. stderr:\n${stderrLog}`)
  }

  return {
    baseUrl,
    port,
    dbPath,
    journalDir,
    adminPassword,
    async stop() {
      if (proc.exitCode === null) {
        const exited = new Promise<void>((done) => proc.once('exit', () => done()))
        proc.kill()
        await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))])
      }
      workspace?.cleanup()
    },
  }
}

export function extractCookie(response: Response, name: string): string {
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  for (const header of setCookies) {
    const first = header.split(';')[0] ?? ''
    if (first.startsWith(`${name}=`)) return first
  }
  return ''
}

export async function loginAdminAndGetQrs(server: TestServerHandle): Promise<{
  adminCookie: string
  qrs: Record<string, string>
}> {
  const loginRes = await fetch(`${server.baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
    body: JSON.stringify({ password: server.adminPassword }),
  })
  if (loginRes.status !== 200) {
    throw new Error(`Admin login failed with status ${loginRes.status}`)
  }
  const adminCookie = extractCookie(loginRes, 'xc_admin')
  const layoutRes = await fetch(`${server.baseUrl}/api/admin/layout`, {
    headers: { Cookie: adminCookie },
  })
  const layout = await layoutRes.json() as { qrs: Record<string, string> }
  return { adminCookie, qrs: layout.qrs }
}

export async function checkInGuest(server: TestServerHandle, qrCode: string): Promise<string> {
  const res = await fetch(`${server.baseUrl}/api/check-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
    body: JSON.stringify({ code: qrCode }),
  })
  if (res.status !== 200) {
    throw new Error(`Check-in failed with status ${res.status}`)
  }
  return extractCookie(res, 'xc_guest')
}
