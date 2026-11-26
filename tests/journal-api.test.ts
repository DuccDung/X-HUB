import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import type { JournalEntry, JournalState } from '../src/shared.ts'
import {
  checkInGuest,
  loginAdminAndGetQrs,
  startTestServer,
  TINY_JPEG_BASE64,
  TINY_PNG_BASE64,
  TINY_WEBP_BASE64,
} from './helpers.ts'
import type { TestServerHandle } from './helpers.ts'

describe('Journal Photo API — Integration & Security', () => {
  let server: TestServerHandle
  let qrs: Record<string, string>
  let cookieA: string
  let cookieB: string

  before(async () => {
    server = await startTestServer()
    const admin = await loginAdminAndGetQrs(server)
    qrs = admin.qrs
    cookieA = await checkInGuest(server, qrs['table-08'])
    cookieB = await checkInGuest(server, qrs['table-201'])
  })

  after(async () => {
    await server.stop()
  })

  it('requires guest cookie (401) and blocks cross-origin mutations (403)', async () => {
    const unauthGet = await fetch(`${server.baseUrl}/api/journal`)
    assert.equal(unauthGet.status, 401)

    const unauthPost = await fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ photos: [{ dataBase64: TINY_PNG_BASE64 }] }),
    })
    assert.equal(unauthPost.status, 401)

    const badOrigin = await fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookieA },
      body: JSON.stringify({ photos: [{ dataBase64: TINY_PNG_BASE64 }] }),
    })
    assert.equal(badOrigin.status, 403)
  })

  it('supports photo uploads (1..4 photos, with/without note & seat) and legacy text entries', async () => {
    // 1 photo without note, seat attached
    const res1 = await fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: JSON.stringify({
        photos: [{ dataBase64: TINY_PNG_BASE64, width: 640, height: 480 }],
      }),
    })
    assert.equal(res1.status, 201)
    const created1 = await res1.json() as { entry: JournalEntry; summary: JournalState['summary'] }
    assert.equal(created1.entry.body, '')
    assert.equal(created1.entry.tableLabel, '08')
    assert.equal(created1.entry.floor, 1)
    assert.equal(created1.entry.photos.length, 1)

    // 4 photos with 300-char Vietnamese note and attachTable: false
    const note300 = 'Cà phê sáng '.repeat(25).trim()
    assert.ok([...note300].length <= 300)
    const res4 = await fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: JSON.stringify({
        note: note300,
        attachTable: false,
        photos: [
          { dataBase64: TINY_PNG_BASE64, width: 800, height: 600 },
          { dataBase64: TINY_JPEG_BASE64, width: 800, height: 600 },
          { dataBase64: TINY_WEBP_BASE64, width: 600, height: 800 },
          { dataBase64: TINY_PNG_BASE64, width: 1000, height: 1000 },
        ],
      }),
    })
    assert.equal(res4.status, 201)
    const created4 = await res4.json() as { entry: JournalEntry; summary: JournalState['summary'] }
    assert.equal(created4.entry.photos.length, 4)
    assert.equal(created4.entry.tableId, null)
    assert.equal(created4.entry.tableLabel, null)
    assert.equal(created4.entry.floor, null)
    assert.equal(created4.entry.body, note300)
    assert.equal(created4.summary.totalPhotos, 5)

    // Legacy text-only entry remains supported
    const resLegacy = await fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: JSON.stringify({ title: 'Kỷ niệm chữ cũ', body: 'Nội dung ghi chép cũ' }),
    })
    assert.equal(resLegacy.status, 201)
    const legacy = await resLegacy.json() as { entry: JournalEntry }
    assert.equal(legacy.entry.title, 'Kỷ niệm chữ cũ')
    assert.equal(legacy.entry.photos.length, 0)

    // Delete legacy entry cleanly
    const delLegacy = await fetch(`${server.baseUrl}/api/journal/${legacy.entry.id}`, {
      method: 'DELETE',
      headers: { Origin: server.baseUrl, Cookie: cookieA },
    })
    assert.equal(delLegacy.status, 200)
  })

  it('rejects invalid uploads (0 photos, 5 photos, >300 note, control chars, spoofed mime, >6MB body)', async () => {
    const post = (body: unknown) => fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: JSON.stringify(body),
    })

    assert.equal((await post({ photos: [] })).status, 400)
    assert.equal((await post({ photos: Array(5).fill({ dataBase64: TINY_PNG_BASE64 }) })).status, 400)
    assert.equal((await post({ note: 'a'.repeat(301), photos: [{ dataBase64: TINY_PNG_BASE64 }] })).status, 400)
    assert.equal((await post({ note: 'abc\u0000def', photos: [{ dataBase64: TINY_PNG_BASE64 }] })).status, 400)
    assert.equal((await post({ photos: [{ dataBase64: Buffer.from('plain text').toString('base64') }] })).status, 400)

    const huge = await fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: `{"photos":[{"dataBase64":"${'A'.repeat(6_400_000)}"}]}`,
    })
    assert.equal(huge.status, 413)
  })

  it('serves private photos with security/download headers and isolates Guest B (404)', async () => {
    const listRes = await fetch(`${server.baseUrl}/api/journal`, { headers: { Cookie: cookieA } })
    assert.equal(listRes.status, 200)
    const stateA = await listRes.json() as JournalState
    const entryA = stateA.entries.find((e) => e.photos.length === 4)!
    const photoA = entryA.photos[0]

    // Owner inline view
    const inlineRes = await fetch(`${server.baseUrl}${photoA.url}`, { headers: { Cookie: cookieA } })
    assert.equal(inlineRes.status, 200)
    assert.equal(inlineRes.headers.get('content-type'), 'image/png')
    assert.equal(inlineRes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(inlineRes.headers.get('cache-control'), 'private, max-age=31536000, immutable')
    assert.equal(inlineRes.headers.get('content-disposition'), 'inline')
    assert.deepEqual(Buffer.from(await inlineRes.arrayBuffer()), Buffer.from(TINY_PNG_BASE64, 'base64'))

    // Owner download
    const dlRes = await fetch(`${server.baseUrl}${photoA.downloadUrl}`, { headers: { Cookie: cookieA } })
    assert.equal(dlRes.status, 200)
    assert.match(dlRes.headers.get('content-disposition') ?? '', /^attachment; filename="xuong-caffe-\d{8}-[a-f0-9-]{8}\.png"$/)

    // Guest B cannot view, favorite, edit, or delete Guest A's resources
    assert.equal((await fetch(`${server.baseUrl}${photoA.url}`, { headers: { Cookie: cookieB } })).status, 404)
    assert.equal((await fetch(`${server.baseUrl}${photoA.downloadUrl}`, { headers: { Cookie: cookieB } })).status, 404)
    assert.equal((await fetch(`${server.baseUrl}/api/journal/${entryA.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
      body: JSON.stringify({ note: 'unauthorized edit' }),
    })).status, 404)
    assert.equal((await fetch(`${server.baseUrl}/api/journal/photos/${photoA.id}/favorite`, {
      method: 'PATCH',
      headers: { Origin: server.baseUrl, Cookie: cookieB },
    })).status, 404)
    assert.equal((await fetch(`${server.baseUrl}/api/journal/photos/${photoA.id}`, {
      method: 'DELETE',
      headers: { Origin: server.baseUrl, Cookie: cookieB },
    })).status, 404)
    assert.equal((await fetch(`${server.baseUrl}/api/journal/${entryA.id}`, {
      method: 'DELETE',
      headers: { Origin: server.baseUrl, Cookie: cookieB },
    })).status, 404)
  })

  it('toggles favorite, edits note, deletes photos/entries, and removes all files from disk', async () => {
    const listBefore = await (await fetch(`${server.baseUrl}/api/journal`, { headers: { Cookie: cookieA } })).json() as JournalState
    const multiEntry = listBefore.entries.find((e) => e.photos.length === 4)!
    const singleEntry = listBefore.entries.find((e) => e.photos.length === 1)!
    const firstPhoto = multiEntry.photos[0]

    // Favorite ON -> OFF
    const favOn = await (await fetch(`${server.baseUrl}/api/journal/photos/${firstPhoto.id}/favorite`, {
      method: 'PATCH',
      headers: { Origin: server.baseUrl, Cookie: cookieA },
    })).json() as JournalState
    const updatedMultiOn = favOn.entries.find((e) => e.id === multiEntry.id)!
    assert.equal(updatedMultiOn.photos[0].favorite, true)
    assert.equal(updatedMultiOn.favorite, true)

    const favOff = await (await fetch(`${server.baseUrl}/api/journal/photos/${firstPhoto.id}/favorite`, {
      method: 'PATCH',
      headers: { Origin: server.baseUrl, Cookie: cookieA },
    })).json() as JournalState
    const updatedMultiOff = favOff.entries.find((e) => e.id === multiEntry.id)!
    assert.equal(updatedMultiOff.photos[0].favorite, false)
    assert.equal(updatedMultiOff.favorite, false)

    // Edit note
    const editRes = await fetch(`${server.baseUrl}/api/journal/${multiEntry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: JSON.stringify({ note: 'Ghi chú đã chỉnh sửa' }),
    })
    assert.equal(editRes.status, 200)
    const afterEdit = await editRes.json() as JournalState
    const edited = afterEdit.entries.find((e) => e.id === multiEntry.id)!
    assert.equal(edited.body, 'Ghi chú đã chỉnh sửa')
    assert.ok(edited.updatedAt)

    // Reject too-long note edit
    const badEdit = await fetch(`${server.baseUrl}/api/journal/${multiEntry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: JSON.stringify({ note: 'x'.repeat(301) }),
    })
    assert.equal(badEdit.status, 400)

    // Delete single photo -> parent photo-only entry auto-deleted
    const delSingle = await (await fetch(`${server.baseUrl}/api/journal/photos/${singleEntry.photos[0].id}`, {
      method: 'DELETE',
      headers: { Origin: server.baseUrl, Cookie: cookieA },
    })).json() as JournalState
    assert.equal(delSingle.entries.some((e) => e.id === singleEntry.id), false)
    assert.equal(delSingle.summary.totalPhotos, 4)

    // Delete whole multi-photo entry -> 0 photos & 0 disk files left
    const delMulti = await (await fetch(`${server.baseUrl}/api/journal/${multiEntry.id}`, {
      method: 'DELETE',
      headers: { Origin: server.baseUrl, Cookie: cookieA },
    })).json() as JournalState
    assert.equal(delMulti.entries.length, 0)
    assert.equal(delMulti.summary.totalPhotos, 0)

    let remainingFiles = 0
    if (existsSync(server.journalDir)) {
      for (const sub of readdirSync(server.journalDir)) {
        remainingFiles += readdirSync(join(server.journalDir, sub)).length
      }
    }
    assert.equal(remainingFiles, 0)
  })

  it('allows expired-seat returning guest (>12h) to use journal without attaching seat', async () => {
    const guestId = cookieB.split('=')[1]
    const raw = new DatabaseSync(server.dbPath)
    raw.prepare('UPDATE guests SET checked_in_at = ? WHERE id = ?').run(Date.now() - 13 * 60 * 60 * 1000, guestId)
    raw.close()

    const upload = await fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
      body: JSON.stringify({
        note: 'Mở lại từ nhà',
        attachTable: true,
        photos: [{ dataBase64: TINY_WEBP_BASE64, width: 500, height: 500 }],
      }),
    })
    assert.equal(upload.status, 201)
    const created = await upload.json() as { entry: JournalEntry }
    assert.equal(created.entry.tableId, null)
    assert.equal(created.entry.tableLabel, null)
    assert.equal(created.entry.floor, null)
  })

  it('rate-limits rapid journal uploads after 60 requests in 15 minutes (429)', async () => {
    const guestC = await checkInGuest(server, qrs['table-03'])
    // Trigger 60 fast validation-failed attempts (rate limit is checked right after auth)
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${server.baseUrl}/api/journal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: guestC },
        body: JSON.stringify({ photos: [] }),
      })
      assert.equal(res.status, 400)
    }
    const limited = await fetch(`${server.baseUrl}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: guestC },
      body: JSON.stringify({ photos: [{ dataBase64: TINY_PNG_BASE64 }] }),
    })
    assert.equal(limited.status, 429)
  })
})
