import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { journalMaxPhotoBytes } from '../src/shared.ts'
import type { JournalPhotoMime } from '../src/shared.ts'

export interface DecodedPhoto {
  buffer: Buffer
  mime: JournalPhotoMime
  ext: 'jpg' | 'webp' | 'png'
  width: number
  height: number
}

export type ParsePhotoResult =
  | { ok: true; photo: DecodedPhoto }
  | { ok: false; statusCode: number; message: string }

function detectImageType(buffer: Buffer): { mime: JournalPhotoMime; ext: 'jpg' | 'webp' | 'png' } | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' }
  }
  if (
    buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' }
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: 'webp' }
  }
  return null
}

function parseDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < 1 || rounded > 8000) return fallback
  return rounded
}

const maxBase64Chars = Math.ceil((journalMaxPhotoBytes * 4) / 3) + 128

export function parsePhotoInput(value: unknown): ParsePhotoResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, statusCode: 400, message: 'Dữ liệu ảnh gửi lên không hợp lệ.' }
  }
  const input = value as Record<string, unknown>
  if (typeof input.dataBase64 !== 'string' || !input.dataBase64) {
    return { ok: false, statusCode: 400, message: 'Thiếu dữ liệu ảnh.' }
  }
  const raw = input.dataBase64.startsWith('data:')
    ? input.dataBase64.slice(input.dataBase64.indexOf(',') + 1)
    : input.dataBase64
  if (!raw || raw.length > maxBase64Chars) {
    return { ok: false, statusCode: 413, message: 'Mỗi ảnh tối đa 1,2 MB sau khi nén.' }
  }
  const clean = raw.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    return { ok: false, statusCode: 400, message: 'Dữ liệu ảnh không đúng định dạng.' }
  }
  const buffer = Buffer.from(clean, 'base64')
  if (buffer.length === 0 || buffer.length > journalMaxPhotoBytes) {
    return { ok: false, statusCode: 413, message: 'Mỗi ảnh tối đa 1,2 MB sau khi nén.' }
  }
  const detected = detectImageType(buffer)
  if (!detected) {
    return { ok: false, statusCode: 400, message: 'Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.' }
  }
  return {
    ok: true,
    photo: {
      buffer,
      mime: detected.mime,
      ext: detected.ext,
      width: parseDimension(input.width, 1200),
      height: parseDimension(input.height, 1200),
    },
  }
}

export function createJournalPhotoStore(dbFilename: string) {
  const ephemeral = dbFilename === ':memory:'
  const rootDir = resolve(
    ephemeral
      ? join(tmpdir(), `xuong-caffe-photos-${randomUUID()}`)
      : (process.env.XUONG_JOURNAL_DIR || join(dirname(dbFilename), 'journal-photos')),
  )
  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  const rootPrefix = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`

  function resolveSafePath(relativePath: string): string {
    const full = resolve(rootDir, relativePath)
    if (!full.startsWith(rootPrefix)) {
      throw new Error('Đường dẫn tệp ảnh không hợp lệ.')
    }
    return full
  }

  function guestBucket(guestId: string): string {
    return createHash('sha256').update(guestId).digest('hex').slice(0, 24)
  }

  return {
    rootDir,
    write(guestId: string, photoId: string, ext: 'jpg' | 'webp' | 'png', buffer: Buffer): string {
      const bucket = guestBucket(guestId)
      const relativePath = `${bucket}/${photoId}.${ext}`
      const fullPath = resolveSafePath(relativePath)
      mkdirSync(dirname(fullPath), { recursive: true, mode: 0o700 })
      writeFileSync(fullPath, buffer, { mode: 0o600 })
      return relativePath
    },
    read(relativePath: string): Buffer | null {
      try {
        return readFileSync(resolveSafePath(relativePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw error
      }
    },
    remove(relativePaths: string[]): void {
      for (const relativePath of relativePaths) {
        const fullPath = resolveSafePath(relativePath)
        try {
          unlinkSync(fullPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            console.error('Không thể xóa tệp ảnh nhật ký:', relativePath, error)
          }
        }
      }
    },
    cleanup(): void {
      if (!ephemeral) return
      try {
        rmSync(rootDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors for temporary test storage.
      }
    },
  }
}
