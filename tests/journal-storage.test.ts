import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { AppError, openDatabase } from '../server/database.ts'
import { createJournalPhotoStore, parsePhotoInput } from '../server/journalPhotos.ts'
import { journalMaxPhotoBytes, journalMaxPhotosPerGuest } from '../src/shared.ts'
import { createTempWorkspace, TINY_JPEG_BASE64, TINY_PNG_BASE64, TINY_WEBP_BASE64 } from './helpers.ts'

describe('parsePhotoInput (magic bytes & validation)', () => {
  it('accepts valid JPG, PNG, WebP (raw base64 and data URL prefix) and trusts real magic bytes', () => {
    const png = parsePhotoInput({
      dataBase64: `data:image/jpeg;base64,${TINY_PNG_BASE64}`,
      mime: 'image/jpeg',
      width: 800,
      height: 600,
    })
    assert.equal(png.ok, true)
    if (png.ok) {
      assert.equal(png.photo.mime, 'image/png')
      assert.equal(png.photo.ext, 'png')
      assert.equal(png.photo.width, 800)
      assert.equal(png.photo.height, 600)
    }

    const jpg = parsePhotoInput({ dataBase64: TINY_JPEG_BASE64, width: 1200.4, height: 900.6 })
    assert.equal(jpg.ok, true)
    if (jpg.ok) {
      assert.equal(jpg.photo.mime, 'image/jpeg')
      assert.equal(jpg.photo.ext, 'jpg')
      assert.equal(jpg.photo.width, 1200)
      assert.equal(jpg.photo.height, 901)
    }

    const webp = parsePhotoInput({ dataBase64: TINY_WEBP_BASE64, width: -5, height: 99999 })
    assert.equal(webp.ok, true)
    if (webp.ok) {
      assert.equal(webp.photo.mime, 'image/webp')
      assert.equal(webp.photo.ext, 'webp')
      assert.equal(webp.photo.width, 1200)
      assert.equal(webp.photo.height, 1200)
    }
  })

  it('rejects spoofed payloads, invalid base64, and missing data with 400', () => {
    const fakeHtml = parsePhotoInput({
      dataBase64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
    })
    assert.equal(fakeHtml.ok, false)
    if (!fakeHtml.ok) assert.equal(fakeHtml.statusCode, 400)

    const badBase64 = parsePhotoInput({ dataBase64: '!!!not-base64!!!' })
    assert.equal(badBase64.ok, false)
    if (!badBase64.ok) assert.equal(badBase64.statusCode, 400)

    const missing = parsePhotoInput({})
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.statusCode, 400)

    const nonObj = parsePhotoInput('raw-string')
    assert.equal(nonObj.ok, false)
    if (!nonObj.ok) assert.equal(nonObj.statusCode, 400)
  })

  it('rejects images exceeding 1.2 MB after decoding with 413', () => {
    const oversized = Buffer.alloc(journalMaxPhotoBytes + 16, 0x41)
    oversized[0] = 0xff
    oversized[1] = 0xd8
    oversized[2] = 0xff
    const res = parsePhotoInput({ dataBase64: oversized.toString('base64') })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.statusCode, 413)
  })
})

describe('createJournalPhotoStore (isolation & path safety)', () => {
  it('isolates guest directories by hash, blocks path traversal, and ignores missing removals', () => {
    const ws = createTempWorkspace('xuong-store')
    const prevDir = process.env.XUONG_JOURNAL_DIR
    process.env.XUONG_JOURNAL_DIR = ws.journalDir
    try {
      const store = createJournalPhotoStore(ws.dbPath)
      const buf = Buffer.from(TINY_PNG_BASE64, 'base64')
      const pathA = store.write('guest-a-token', '11111111-1111-4111-8111-111111111111', 'png', buf)
      const pathB = store.write('guest-b-token', '22222222-2222-4222-8222-222222222222', 'png', buf)

      assert.notEqual(pathA.split('/')[0], pathB.split('/')[0])
      assert.deepEqual(store.read(pathA), buf)
      assert.throws(() => store.read('../outside.txt'), /không hợp lệ/)
      assert.throws(() => store.remove(['../../etc/passwd']), /không hợp lệ/)

      store.remove([pathA, 'nonexistent/missing.png'])
      assert.equal(store.read(pathA), null)
    } finally {
      if (prevDir === undefined) delete process.env.XUONG_JOURNAL_DIR
      else process.env.XUONG_JOURNAL_DIR = prevDir
      ws.cleanup()
    }
  })
})

describe('SQLite migration, summary, quota, and rollback', () => {
  it('migrates legacy 5-column journal_entries DB without losing entries and computes VN visitCount', () => {
    const ws = createTempWorkspace('xuong-migrate')
    const prevDir = process.env.XUONG_JOURNAL_DIR
    process.env.XUONG_JOURNAL_DIR = ws.journalDir
    try {
      const guestToken = 'G'.repeat(43)
      {
        const raw = new DatabaseSync(ws.dbPath)
        raw.exec(`
          CREATE TABLE guests (id TEXT PRIMARY KEY, table_id TEXT NOT NULL, checked_in_at INTEGER NOT NULL) STRICT;
          CREATE TABLE journal_entries (
            id TEXT PRIMARY KEY,
            guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;
        `)
        raw.prepare('INSERT INTO guests (id, table_id, checked_in_at) VALUES (?, ?, ?)').run(guestToken, 'table-01', Date.now())
        // 2026-10-01T17:30:00Z = 2026-10-02 00:30 in Asia/Ho_Chi_Minh (+07)
        // 2026-10-01T16:30:00Z = 2026-10-01 23:30 in Asia/Ho_Chi_Minh (+07)
        raw.prepare('INSERT INTO journal_entries (id, guest_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run('11111111-1111-4111-8111-111111111111', guestToken, 'Bài cũ 1', 'Nội dung ngày 1', '2026-10-01T16:30:00.000Z')
        raw.prepare('INSERT INTO journal_entries (id, guest_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run('22222222-2222-4222-8222-222222222222', guestToken, 'Bài cũ 2', 'Nội dung ngày 2', '2026-10-01T17:30:00.000Z')
        raw.close()
      }

      const db = openDatabase(ws.dbPath)
      try {
        const state = db.journal(guestToken)
        assert.equal(state.entries.length, 2)
        assert.equal(state.entries[0].title, 'Bài cũ 2')
        assert.equal(state.entries[1].title, 'Bài cũ 1')
        assert.equal(state.entries[0].photos.length, 0)
        assert.equal(state.entries[0].favorite, false)
        assert.equal(state.summary.totalEntries, 2)
        assert.equal(state.summary.totalPhotos, 0)
        assert.equal(state.summary.visitCount, 2)
      } finally {
        db.close()
      }
    } finally {
      if (prevDir === undefined) delete process.env.XUONG_JOURNAL_DIR
      else process.env.XUONG_JOURNAL_DIR = prevDir
      ws.cleanup()
    }
  })

  it('enforces 120 photos per guest and rolls back disk files on failure', () => {
    const ws = createTempWorkspace('xuong-quota')
    const prevDir = process.env.XUONG_JOURNAL_DIR
    process.env.XUONG_JOURNAL_DIR = ws.journalDir
    try {
      const db = openDatabase(ws.dbPath)
      try {
        const qrs = db.adminLayout().qrs
        const guest = db.checkIn(qrs['table-01'], null)
        const parsed = parsePhotoInput({ dataBase64: TINY_PNG_BASE64, width: 100, height: 100 })
        assert.equal(parsed.ok, true)
        if (!parsed.ok) return

        // Insert 30 batches x 4 photos = 120 photos
        for (let batch = 0; batch < journalMaxPhotosPerGuest / 4; batch++) {
          db.createJournalPhotoEntry(guest.id, '', [parsed.photo, parsed.photo, parsed.photo, parsed.photo], null)
        }
        assert.equal(db.journal(guest.id).summary.totalPhotos, journalMaxPhotosPerGuest)

        // 121st photo must reject with 409
        assert.throws(
          () => db.createJournalPhotoEntry(guest.id, '', [parsed.photo], null),
          (err: unknown) => err instanceof AppError && err.statusCode === 409,
        )

        // Count physical files on disk: must be exactly 120 (zero orphan from rejected 121st)
        let filesOnDisk = 0
        if (existsSync(ws.journalDir)) {
          for (const sub of readdirSync(ws.journalDir)) {
            filesOnDisk += readdirSync(join(ws.journalDir, sub)).length
          }
        }
        assert.equal(filesOnDisk, journalMaxPhotosPerGuest)

        // Also test rollback when guest does not exist (FK constraint failure)
        assert.throws(() => db.createJournalPhotoEntry('missing-guest-id', '', [parsed.photo], null))
        let filesAfterRollback = 0
        for (const sub of readdirSync(ws.journalDir)) {
          filesAfterRollback += readdirSync(join(ws.journalDir, sub)).length
        }
        assert.equal(filesAfterRollback, journalMaxPhotosPerGuest)
      } finally {
        db.close()
      }
    } finally {
      if (prevDir === undefined) delete process.env.XUONG_JOURNAL_DIR
      else process.env.XUONG_JOURNAL_DIR = prevDir
      ws.cleanup()
    }
  })
})
