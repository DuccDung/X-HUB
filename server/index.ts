import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { resolve } from 'node:path'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { Server } from 'socket.io'
import { caroEmojis, journalMaxNoteLength, journalMaxPhotosPerEntry } from '../src/shared.ts'
import type { CaroEmoji, CaroEmojiEvent, ChatTypingEvent, TableCharacter, VenueActivity, VenueState } from '../src/shared.ts'
import { AppError, object, openDatabase, parseProfile, parseTables } from './database.ts'
import type { Guest } from './database.ts'
import { parsePhotoInput } from './journalPhotos.ts'
import type { DecodedPhoto } from './journalPhotos.ts'
import { createSocial } from './social.ts'
import type { OnlineProfile, SocialMember } from './social.ts'

const guestCookie = 'xc_guest'
const adminCookie = 'xc_admin'
const day = 24 * 60 * 60 * 1000
const adminLifetime = 8 * 60 * 60 * 1000
const loginWindow = 15 * 60 * 1000
const adminPassword = process.env.XUONG_ADMIN_PASSWORD
const hash = (text: string) => createHash('sha256').update(text).digest()
const passwordHash = adminPassword ? hash(adminPassword) : null

const database = openDatabase(process.env.XUONG_DB || resolve('data', 'xuong-caffe.sqlite'))
const app = Fastify({
  bodyLimit: 256 * 1024,
  trustProxy: ['127.0.0.1', '::1'],
})
await app.register(cookie)

function sameOrigin(request: IncomingMessage): boolean {
  if (!request.headers.origin) return true
  try {
    const origin = new URL(request.headers.origin)
    return (origin.protocol === 'http:' || origin.protocol === 'https:')
      && origin.host.toLowerCase() === request.headers.host?.toLowerCase()
  } catch {
    return false
  }
}

const io = new Server(app.server, {
  maxHttpBufferSize: 16 * 1024,
  allowRequest: (request, callback) => callback(null, sameOrigin(request)),
})

type LiveGuest = { guest: Guest; tableId: string | null; sockets: number }
type LoginAttempt = { count: number; until: number }
const live = new Map<string, LiveGuest>()
const admins = new Map<string, number>()
const failures = new Map<string, LoginAttempt>()
const entryAttempts = new Map<string, LoginAttempt>()
const journalUploadAttempts = new Map<string, LoginAttempt>()
let venueActivity: VenueActivity = { presence: {}, characters: {} }

function onlineGuests(tableId: string): string[] {
  return [...live.entries()].filter(([, visitor]) => visitor.tableId === tableId && visitor.guest.profile).map(([id]) => id)
}

function onlineProfiles(): OnlineProfile[] {
  const list: OnlineProfile[] = []
  for (const [guestId, visitor] of live) {
    if (!visitor.tableId || !visitor.guest.profile) continue
    list.push({
      guestId,
      publicId: visitor.guest.profile.id,
      displayName: visitor.guest.profile.displayName,
      tableId: visitor.tableId,
    })
  }
  return list
}

function guestRoom(guestId: string): string {
  return `visitor:${guestId}`
}

const social = createSocial({
  onlineGuests,
  onlineProfiles,
  notify: (guests) => {
    for (const id of guests) io.to(guestRoom(id)).emit('social:changed')
  },
  notifyAll: () => {
    io.emit('social:changed')
  },
})

function broadcastActivity() {
  const presence = Object.create(null) as Record<string, number>
  const characters = Object.create(null) as Record<string, TableCharacter[]>
  for (const { tableId, guest: { profile } } of live.values()) {
    if (!tableId || !profile) continue
    const visitors = characters[tableId] ??= []
    visitors.push(profile)
    presence[tableId] = visitors.length
  }
  venueActivity = { presence, characters }
  io.emit('venue:activity', venueActivity)
  io.emit('venue:presence', presence)
}

function updateLiveSeat(visitor: LiveGuest, now = Date.now()): boolean {
  const tableId = database.activeTable(visitor.guest, now)
  if (tableId === visitor.tableId) return false
  visitor.tableId = tableId
  io.to(guestRoom(visitor.guest.id)).emit('venue:session', { tableId })
  return visitor.guest.profile !== null
}

function refreshSeats(now = Date.now()) {
  let changed = false
  for (const visitor of live.values()) {
    if (updateLiveSeat(visitor, now)) changed = true
  }
  if (changed) broadcastActivity()
}

function emitTyping(senderGuestId: string, payload: ChatTypingEvent) {
  const targets = social.recipientGuestIds(senderGuestId, payload.conversationId)
  if (!targets) return
  if (targets === 'all') {
    io.except(guestRoom(senderGuestId)).emit('chat:typing', payload)
  } else {
    for (const id of targets) io.to(guestRoom(id)).emit('chat:typing', payload)
  }
}

io.on('connection', (socket) => {
  const cookies = app.parseCookie(socket.request.headers.cookie ?? '')
  const guest = database.guest(cookies[guestCookie])
  let changed = false
  if (guest) {
    const existing = live.get(guest.id)
    const current = existing ?? { guest, tableId: null, sockets: 0 }
    current.guest = guest
    current.sockets++
    live.set(guest.id, current)
    void socket.join(guestRoom(guest.id))
    changed = updateLiveSeat(current)

    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
    let lastTypingPing = 0
    let lastCaroEmoji = 0

    socket.on('caro:emoji', (raw: unknown) => {
      if (typeof raw !== 'object' || raw === null) return
      const { gameId, emoji } = raw as { gameId?: unknown; emoji?: unknown }
      if (typeof gameId !== 'string' || !gameId || gameId.length > 64) return
      if (typeof emoji !== 'string' || !(caroEmojis as readonly string[]).includes(emoji)) return
      const profile = current.guest.profile
      if (!current.tableId || !profile) return
      const now = Date.now()
      if (now - lastCaroEmoji < 1200) return
      const opponentGuestId = social.caroOpponentGuestId(guest.id, gameId)
      if (!opponentGuestId) return
      lastCaroEmoji = now
      const payload: CaroEmojiEvent = {
        gameId,
        fromId: profile.id,
        fromName: profile.displayName,
        emoji: emoji as CaroEmoji,
      }
      io.to(guestRoom(opponentGuestId)).emit('caro:emoji', payload)
    })

    const clearTypingFor = (conversationId: string) => {
      const existingTimer = typingTimers.get(conversationId)
      if (!existingTimer) return
      clearTimeout(existingTimer)
      typingTimers.delete(conversationId)
      const profile = current.guest.profile
      if (profile) {
        emitTyping(guest.id, {
          conversationId,
          userId: profile.id,
          displayName: profile.displayName,
          typing: false,
        })
      }
    }

    socket.on('chat:typing', (raw: unknown) => {
      if (typeof raw !== 'object' || raw === null) return
      const { conversationId, typing } = raw as { conversationId?: unknown; typing?: unknown }
      if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 64 || typeof typing !== 'boolean') return
      const profile = current.guest.profile
      if (!current.tableId || !profile) return

      if (!typing) {
        clearTypingFor(conversationId)
        return
      }
      const now = Date.now()
      if (now - lastTypingPing < 250 && typingTimers.has(conversationId)) return
      lastTypingPing = now

      const prev = typingTimers.get(conversationId)
      if (prev) clearTimeout(prev)
      typingTimers.set(conversationId, setTimeout(() => clearTypingFor(conversationId), 4000))
      emitTyping(guest.id, {
        conversationId,
        userId: profile.id,
        displayName: profile.displayName,
        typing: true,
      })
    })

    socket.on('disconnect', () => {
      for (const conversationId of [...typingTimers.keys()]) clearTypingFor(conversationId)
      current.sockets--
      if (current.sockets) return
      live.delete(guest.id)
      if (current.tableId && current.guest.profile) broadcastActivity()
    })
  }
  if (changed) broadcastActivity()
  else {
    socket.emit('venue:activity', venueActivity)
    socket.emit('venue:presence', venueActivity.presence)
  }
})

const timer = setInterval(() => {
  const now = Date.now()
  refreshSeats(now)
  social.sweep()
  for (const [token, expiresAt] of admins) if (expiresAt <= now) admins.delete(token)
  for (const [ip, attempt] of failures) if (attempt.until <= now) failures.delete(ip)
  for (const [ip, attempt] of entryAttempts) if (attempt.until <= now) entryAttempts.delete(ip)
  for (const [key, attempt] of journalUploadAttempts) if (attempt.until <= now) journalUploadAttempts.delete(key)
}, 10_000)
timer.unref()

function currentGuest(request: FastifyRequest) {
  return database.guest(request.cookies[guestCookie])
}

function seatedGuest(request: FastifyRequest) {
  const guest = currentGuest(request)
  const tableId = database.activeTable(guest)
  if (!guest || !tableId) throw new AppError(401, 'Hãy quét mã QR tại bàn để tham gia.')
  return { guest, tableId }
}

function checkedIn(request: FastifyRequest): SocialMember {
  const { guest, tableId } = seatedGuest(request)
  if (!guest.profile) throw new AppError(403, 'Hãy tạo nhân vật để tham gia.')
  return { id: guest.id, publicId: guest.profile.id, displayName: guest.profile.displayName, tableId }
}

function visitor(request: FastifyRequest) {
  const guest = currentGuest(request)
  if (!guest) throw new AppError(401, 'Hãy quét mã QR tại quán để mở nhật ký của bạn.')
  return guest
}

function isAdmin(request: FastifyRequest): boolean {
  const token = request.cookies[adminCookie]
  return !!token && (admins.get(token) ?? 0) > Date.now()
}

function requireAdmin(request: FastifyRequest) {
  if (!isAdmin(request)) throw new AppError(401, 'Vui lòng đăng nhập quản trị.')
}

function cookieOptions(request: FastifyRequest, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: request.protocol === 'https',
    path: '/',
    maxAge,
  }
}

function recordAttempt(attempts: Map<string, LoginAttempt>, key: string, limit: number, message: string) {
  const now = Date.now()
  let activity = attempts.get(key)
  if (!activity || activity.until <= now) {
    activity = { count: 0, until: now + loginWindow }
    attempts.set(key, activity)
  }
  if (activity.count >= limit) throw new AppError(429, message)
  activity.count += 1
}

function venue(guest: Guest | null): VenueState {
  return { layout: database.published(), tableId: database.activeTable(guest), profile: guest?.profile ?? null, ...venueActivity }
}

app.addHook('onRequest', (request, reply, done) => {
  if (request.url.startsWith('/api/')) {
    reply.header('Cache-Control', 'no-store')
    if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request.raw)) {
      return done(new AppError(403, 'Nguồn yêu cầu không hợp lệ.'))
    }
  }
  done()
})

app.get('/api/health', async () => ({ ok: true }))
app.get('/api/venue', async (request) => venue(currentGuest(request)))

app.post('/api/check-in', async (request, reply) => {
  recordAttempt(entryAttempts, request.ip, 180, 'Có quá nhiều lần quét mã. Vui lòng thử lại sau.')
  const { code } = object(request.body)
  const guest = database.checkIn(code, currentGuest(request))
  reply.setCookie(guestCookie, guest.id, cookieOptions(request, 365 * day / 1000))
  const current = live.get(guest.id)
  if (current) {
    current.guest = guest
    if (updateLiveSeat(current)) broadcastActivity()
  }
  return venue(guest)
})

app.put('/api/guest/profile', async (request) => {
  const { guest } = seatedGuest(request)
  guest.profile = database.saveProfile(guest.id, parseProfile(request.body))
  const current = live.get(guest.id)
  if (current) {
    current.guest = guest
    updateLiveSeat(current)
    io.to(guestRoom(guest.id)).emit('venue:profile', guest.profile)
    broadcastActivity()
  }
  return venue(guest)
})

app.get('/api/admin/session', async (request) => ({ authenticated: isAdmin(request) }))
app.post('/api/admin/login', async (request, reply) => {
  if (!passwordHash) throw new AppError(503, 'Máy chủ chưa cấu hình mật khẩu quản trị.')
  recordAttempt(failures, request.ip, 8, 'Bạn đã thử đăng nhập nhiều lần. Vui lòng thử lại sau.')
  const { password } = object(request.body)
  if (typeof password !== 'string' || password.length > 1024 || !timingSafeEqual(hash(password), passwordHash)) {
    throw new AppError(401, 'Mật khẩu quản trị không đúng.')
  }
  failures.delete(request.ip)
  const previous = request.cookies[adminCookie]
  if (previous) admins.delete(previous)
  const token = randomBytes(32).toString('base64url')
  admins.set(token, Date.now() + adminLifetime)
  reply.setCookie(adminCookie, token, { ...cookieOptions(request, adminLifetime / 1000), sameSite: 'strict' })
  return { ok: true }
})
app.post('/api/admin/logout', async (request, reply) => {
  const token = request.cookies[adminCookie]
  if (token) admins.delete(token)
  reply.clearCookie(adminCookie, { ...cookieOptions(request, 0), sameSite: 'strict' })
  return { ok: true }
})
app.get('/api/admin/layout', { preHandler: async (request) => requireAdmin(request) }, async () => database.adminLayout())
app.put('/api/admin/layout', { preHandler: async (request) => requireAdmin(request) }, async (request) => {
  const { tables, version } = object(request.body)
  return database.saveDraft(parseTables(tables), version)
})
app.post('/api/admin/publish', { preHandler: async (request) => requireAdmin(request) }, async (request) => {
  const { version } = object(request.body)
  const next = database.publish(version)
  refreshSeats()
  io.emit('venue:layout', next.published)
  return next
})

app.get('/api/social', async (request) => {
  social.sweep()
  const guest = currentGuest(request)
  const tableId = database.activeTable(guest)
  return social.state(guest?.profile && tableId
    ? { id: guest.id, publicId: guest.profile.id, displayName: guest.profile.displayName, tableId }
    : null)
})
app.post('/api/chat', async (request) => {
  const member = checkedIn(request)
  const { conversationId, recipientId, text } = object(request.body)
  social.sweep()
  const id = social.sendChat(member, { conversationId, recipientId, text })
  emitTyping(member.id, {
    conversationId: id,
    userId: member.publicId,
    displayName: member.displayName,
    typing: false,
  })
  return { ...social.state(member), conversationId: id }
})
app.post<{ Params: { id: string } }>('/api/chat/:id/seen', async (request) => {
  const member = checkedIn(request)
  const { messageId } = object(request.body)
  social.sweep()
  social.markSeen(member, request.params.id, messageId)
  return { ok: true }
})
app.post('/api/chat/groups', async (request, reply) => {
  const member = checkedIn(request)
  const { name, memberIds } = object(request.body)
  social.sweep()
  const id = social.createGroup(member, name, memberIds)
  return reply.code(201).send({ ...social.state(member), conversationId: id })
})
app.post<{ Params: { id: string } }>('/api/chat/groups/:id/members', async (request) => {
  const member = checkedIn(request)
  const { memberIds } = object(request.body)
  social.sweep()
  social.addGroupMembers(member, request.params.id, memberIds)
  return social.state(member)
})
app.post<{ Params: { id: string } }>('/api/chat/groups/:id/leave', async (request) => {
  const member = checkedIn(request)
  social.sweep()
  social.leaveGroup(member, request.params.id)
  return social.state(member)
})
app.post('/api/caro/invite', async (request) => {
  const member = checkedIn(request)
  const { tableId, recipientId } = object(request.body)
  social.sweep()
  social.sendInvite(member, { tableId, recipientId })
  return social.state(member)
})
app.post<{ Params: { id: string } }>('/api/caro/invites/:id', async (request) => {
  const member = checkedIn(request)
  const { accept } = object(request.body)
  social.sweep()
  social.answerInvite(member, request.params.id, accept)
  return social.state(member)
})
app.post<{ Params: { id: string } }>('/api/caro/games/:id/move', async (request) => {
  const member = checkedIn(request)
  const { index } = object(request.body)
  social.sweep()
  social.playMove(member, request.params.id, index)
  return social.state(member)
})
app.post<{ Params: { id: string } }>('/api/caro/games/:id/resign', async (request) => {
  const member = checkedIn(request)
  social.sweep()
  social.resignGame(member, request.params.id)
  return social.state(member)
})
app.post<{ Params: { id: string } }>('/api/caro/games/:id/draw', async (request) => {
  const member = checkedIn(request)
  const { action } = object(request.body)
  social.sweep()
  social.handleDraw(member, request.params.id, action)
  return social.state(member)
})
app.post<{ Params: { id: string } }>('/api/caro/games/:id/rematch', async (request) => {
  const member = checkedIn(request)
  social.sweep()
  const nextId = social.requestRematch(member, request.params.id)
  return { ...social.state(member), gameId: nextId }
})

const journalPhotoIdPattern = /^[a-f0-9-]{36}$/i
const journalDownloadDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })

function activeSeatSnapshot(guest: Guest) {
  const tableId = database.activeTable(guest)
  if (!tableId) return null
  const table = database.published().tables.find((item) => item.id === tableId)
  if (!table) return null
  return { tableId: table.id, tableLabel: table.label, floor: table.floor }
}

function cleanJournalText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  if (/[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(raw.replace(/[\n\r\t]/g, ''))) {
    throw new AppError(400, 'Nội dung chứa ký tự không hợp lệ.')
  }
  return raw.trim().normalize('NFC')
}

app.get('/api/journal', async (request) => database.journal(visitor(request).id))

app.post('/api/journal', { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
  const guest = visitor(request)
  recordAttempt(journalUploadAttempts, guest.id, 60, 'Bạn đang lưu ảnh quá nhanh. Vui lòng thử lại sau ít phút.')
  const payload = object(request.body)
  const attachTable = payload.attachTable !== false
  const seat = attachTable ? activeSeatSnapshot(guest) : null

  if (Array.isArray(payload.photos)) {
    if (payload.photos.length < 1 || payload.photos.length > journalMaxPhotosPerEntry) {
      throw new AppError(400, `Hãy chọn từ 1 đến ${journalMaxPhotosPerEntry} ảnh mỗi lần lưu.`)
    }
    const note = cleanJournalText(payload.note ?? payload.body)
    if ([...note].length > journalMaxNoteLength) {
      throw new AppError(400, `Ghi chú ngắn tối đa ${journalMaxNoteLength} ký tự.`)
    }
    const decoded: DecodedPhoto[] = []
    for (const rawPhoto of payload.photos) {
      const parsed = parsePhotoInput(rawPhoto)
      if (!parsed.ok) throw new AppError(parsed.statusCode, parsed.message)
      decoded.push(parsed.photo)
    }
    const result = database.createJournalPhotoEntry(guest.id, note, decoded, seat)
    return reply.code(201).send(result)
  }

  const heading = cleanJournalText(payload.title)
  const content = cleanJournalText(payload.body)
  if (!content || content.length > 4000 || heading.length > 80) {
    throw new AppError(400, 'Nhật ký cần nội dung từ 1 đến 4.000 ký tự và tiêu đề tối đa 80 ký tự.')
  }
  const result = database.writeJournal(guest.id, heading || 'Kỷ niệm tại Xưởng', content, seat)
  return reply.code(201).send(result)
})

app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/api/journal/photos/:id', async (request, reply) => {
  const guest = visitor(request)
  const photoId = request.params.id
  if (!journalPhotoIdPattern.test(photoId)) throw new AppError(404, 'Không tìm thấy ảnh này.')
  const photo = database.readJournalPhoto(guest.id, photoId)
  if (!photo) throw new AppError(404, 'Không tìm thấy ảnh này.')
  const ext = photo.mime === 'image/webp' ? 'webp' : photo.mime === 'image/png' ? 'png' : 'jpg'
  const download = request.query.download === '1' || request.query.download === 'true'
  reply.header('Cache-Control', 'private, max-age=31536000, immutable')
  reply.header('X-Content-Type-Options', 'nosniff')
  reply.header('Content-Type', photo.mime)
  if (download) {
    const stamp = journalDownloadDate.format(new Date(photo.createdAt)).replace(/-/g, '')
    reply.header('Content-Disposition', `attachment; filename="xuong-caffe-${stamp}-${photo.id.slice(0, 8)}.${ext}"`)
  } else {
    reply.header('Content-Disposition', 'inline')
  }
  return reply.send(photo.buffer)
})

app.patch<{ Params: { id: string } }>('/api/journal/:id', async (request) => {
  const guest = visitor(request)
  if (!journalPhotoIdPattern.test(request.params.id)) throw new AppError(404, 'Không tìm thấy kỷ niệm này.')
  const { note, body } = object(request.body)
  const clean = cleanJournalText(note ?? body)
  return database.updateJournalNote(guest.id, request.params.id, clean)
})

app.patch<{ Params: { id: string } }>('/api/journal/photos/:id/favorite', async (request) => {
  const guest = visitor(request)
  if (!journalPhotoIdPattern.test(request.params.id)) throw new AppError(404, 'Không tìm thấy ảnh này.')
  return database.toggleJournalPhotoFavorite(guest.id, request.params.id)
})

app.delete<{ Params: { id: string } }>('/api/journal/photos/:id', async (request) => {
  const guest = visitor(request)
  if (!journalPhotoIdPattern.test(request.params.id)) throw new AppError(404, 'Không tìm thấy ảnh này.')
  return database.deleteJournalPhoto(guest.id, request.params.id)
})

app.delete<{ Params: { id: string } }>('/api/journal/:id', async (request) => {
  const guest = visitor(request)
  if (!journalPhotoIdPattern.test(request.params.id)) throw new AppError(404, 'Không tìm thấy kỷ niệm này.')
  return database.deleteJournalEntry(guest.id, request.params.id)
})

const dist = resolve('dist')
const hasFrontend = existsSync(resolve(dist, 'index.html'))
if (hasFrontend) {
  await app.register(fastifyStatic, { root: dist, wildcard: false, dotfiles: 'ignore' })
}

app.setNotFoundHandler((request, reply) => {
  const path = request.url.split('?')[0]
  const isPage = path === '/' || path === '/admin' || path === '/admin/'
  if (hasFrontend && isPage && (request.method === 'GET' || request.method === 'HEAD')) {
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html')
  }
  return reply.code(404).send({ message: 'Không tìm thấy trang hoặc chức năng.' })
})

app.setErrorHandler((error, _request, reply: FastifyReply) => {
  if (error instanceof AppError) return reply.code(error.statusCode).send({ message: error.message })
  const status = error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : 500
  if (status === 413) {
    return reply.code(413).send({ message: 'Ảnh tải lên vượt quá dung lượng cho phép.' })
  }
  if (status >= 400 && status < 500) {
    return reply.code(status).send({ message: 'Dữ liệu gửi lên không hợp lệ.' })
  }
  console.error(error)
  return reply.code(500).send({ message: 'Máy chủ gặp lỗi. Vui lòng thử lại.' })
})

app.addHook('onClose', async () => {
  clearInterval(timer)
  database.close()
})

async function shutdown() {
  io.disconnectSockets(true)
  io.engine.close()
  await app.close()
}

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 3000)
const url = await app.listen({ host, port })
console.log(`Xưởng Caffe đang phục vụ tại ${url}`)
