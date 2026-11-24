import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatParticipant, ChatReceipt, Conversation, Game, Invite, SocialState } from '../src/shared.ts'
import { AppError } from './database.ts'

export type SocialMember = {
  id: string
  publicId: string
  displayName: string
  tableId: string
}

export type OnlineProfile = {
  guestId: string
  publicId: string
  displayName: string
  tableId: string
}

type SeatMember = { id: string; tableId: string }
type Mark = 'X' | 'O'
type StoredMessage = {
  id: string
  authorGuestId: string
  authorPublicId: string
  authorName: string
  tableId: string
  text: string
  createdAt: string
  timestamp: number
}
type MemberSnapshot = {
  guestId: string
  publicId: string
  displayName: string
  tableId: string
}
type SeenRecord = { messageId: string; seenAt: string }
type ChatRecord = {
  id: string
  kind: 'direct' | 'group'
  name: string
  directKey?: string
  members: Map<string, MemberSnapshot>
  messages: StoredMessage[]
  seen: Map<string, SeenRecord>
  updatedAt: number
}
type InviteRecord = { id: string; sender: SeatMember; tableId: string; recipients: Set<string>; createdAt: number }
type GameRecord = {
  id: string
  players: Record<Mark, SeatMember>
  board: (Mark | null)[]
  turn: Mark
  winner: Mark | 'draw' | null
  lastMove: number | null
  updatedAt: number
}

const boardSize = 15
const inviteLifetime = 2 * 60 * 1000
const gameLifetime = 45 * 60 * 1000
const chatLifetime = 12 * 60 * 60 * 1000
const maximumChats = 300
const maximumMessages = 100
const maximumPublicMessages = 200
const maximumGroupMembers = 20
const maximumGroupsPerGuest = 30
const controlPattern = /[\p{Cc}\p{Cs}\p{Bidi_Control}]/u

export function createSocial(options: {
  onlineGuests: (tableId: string) => string[]
  onlineProfiles: () => OnlineProfile[]
  notify: (guestIds: Iterable<string>) => void
  notifyAll: () => void
}) {
  const { onlineGuests, onlineProfiles, notify, notifyAll } = options
  const publicMessages: StoredMessage[] = []
  let publicUpdatedAt = Date.now()
  const conversations = new Map<string, ChatRecord>()
  const invites = new Map<string, InviteRecord>()
  const games = new Map<string, GameRecord>()
  const lastSent = new Map<string, number>()

  function onlineByGuestId(): Map<string, OnlineProfile> {
    return new Map(onlineProfiles().map((profile) => [profile.guestId, profile]))
  }

  function findOnlineByPublicId(publicId: string): OnlineProfile | undefined {
    return onlineProfiles().find((profile) => profile.publicId === publicId)
  }

  function snapshotOf(member: SocialMember): MemberSnapshot {
    return {
      guestId: member.id,
      publicId: member.publicId,
      displayName: member.displayName,
      tableId: member.tableId,
    }
  }

  function snapshotFromOnline(profile: OnlineProfile): MemberSnapshot {
    return {
      guestId: profile.guestId,
      publicId: profile.publicId,
      displayName: profile.displayName,
      tableId: profile.tableId,
    }
  }

  function formatMessage(message: StoredMessage, viewerId: string | null): ChatMessage {
    return {
      id: message.id,
      text: message.text,
      mine: viewerId !== null && message.authorGuestId === viewerId,
      authorId: message.authorPublicId,
      authorName: message.authorName,
      tableId: message.tableId,
      createdAt: message.createdAt,
    }
  }

  function playerMark(game: GameRecord, member: SeatMember): Mark | undefined {
    return (['X', 'O'] as const).find((mark) =>
      game.players[mark].id === member.id && game.players[mark].tableId === member.tableId,
    )
  }

  function activeGame(member: SeatMember): boolean {
    return [...games.values()].some((game) => game.winner === null && playerMark(game, member))
  }

  function notifyGame(game: GameRecord) {
    notify([game.players.X.id, game.players.O.id])
  }

  function notifyInvite(invite: InviteRecord) {
    notify([invite.sender.id, ...invite.recipients])
  }

  function parseGroupName(value: unknown): string {
    const clean = typeof value === 'string' && value.length <= 160 && !controlPattern.test(value)
      ? value.trim().normalize('NFC') : ''
    if (!clean || [...clean].length > 40) {
      throw new AppError(400, 'Tên nhóm cần từ 1 đến 40 ký tự hợp lệ.')
    }
    return clean
  }

  function parsePublicIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > maximumGroupMembers) {
      throw new AppError(400, 'Danh sách thành viên không hợp lệ.')
    }
    const ids: string[] = []
    const seen = new Set<string>()
    for (const item of value) {
      if (typeof item !== 'string' || !item || item.length > 64) {
        throw new AppError(400, 'Mã thành viên không hợp lệ.')
      }
      if (!seen.has(item)) {
        seen.add(item)
        ids.push(item)
      }
    }
    return ids
  }

  function sweep() {
    const now = Date.now()
    while (publicMessages.length > 0 && now - publicMessages[0].timestamp >= chatLifetime) {
      publicMessages.shift()
    }
    for (const [id, chat] of conversations) {
      if (now - chat.updatedAt < chatLifetime) continue
      conversations.delete(id)
      notify(chat.members.keys())
    }
    for (const [id, invite] of invites) {
      if (now - invite.createdAt < inviteLifetime) continue
      invites.delete(id)
      notifyInvite(invite)
    }
    for (const [id, game] of games) {
      if (now - game.updatedAt < gameLifetime) continue
      games.delete(id)
      notifyGame(game)
    }
    for (const [id, time] of lastSent) {
      if (now - time > 1000) lastSent.delete(id)
    }
  }

  function state(member: SocialMember | null): SocialState {
    const liveMap = onlineByGuestId()
    const viewerId = member?.id ?? null

    const publicChat: Conversation = {
      id: 'public',
      kind: 'public',
      name: 'Cả quán',
      members: [...liveMap.values()].map((profile): ChatParticipant => ({
        id: profile.publicId,
        displayName: profile.displayName,
        tableId: profile.tableId,
        online: true,
      })),
      messages: publicMessages.map((message) => formatMessage(message, viewerId)),
      receipts: [],
      updatedAt: new Date(publicUpdatedAt).toISOString(),
    }

    if (!member) return { publicChat, conversations: [], invites: [], games: [] }

    const ownConversations = [...conversations.values()]
      .filter((chat) => chat.members.has(member.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((chat): Conversation => {
        const members: ChatParticipant[] = []
        for (const [guestId, snapshot] of chat.members) {
          const liveProfile = liveMap.get(guestId)
          if (liveProfile) {
            snapshot.displayName = liveProfile.displayName
            snapshot.tableId = liveProfile.tableId
            snapshot.publicId = liveProfile.publicId
          }
          members.push({
            id: snapshot.publicId,
            displayName: snapshot.displayName,
            tableId: snapshot.tableId,
            online: Boolean(liveProfile),
          })
        }
        const peer = chat.kind === 'direct'
          ? members.find((participant) => participant.id !== member.publicId) ?? members[0]
          : undefined
        const receipts: ChatReceipt[] = []
        for (const [guestId, seen] of chat.seen) {
          if (guestId === member.id) continue
          const snapshot = chat.members.get(guestId)
          if (!snapshot) continue
          receipts.push({
            userId: snapshot.publicId,
            displayName: snapshot.displayName,
            messageId: seen.messageId,
            seenAt: seen.seenAt,
          })
        }
        return {
          id: chat.id,
          kind: chat.kind,
          name: chat.kind === 'direct' ? (peer?.displayName ?? 'Khách') : chat.name,
          tableId: peer?.tableId,
          members,
          messages: chat.messages.map((message) => formatMessage(message, member.id)),
          receipts,
          updatedAt: new Date(chat.updatedAt).toISOString(),
        }
      })

    const ownInvites: Invite[] = []
    for (const invite of invites.values()) {
      const createdAt = new Date(invite.createdAt).toISOString()
      if (invite.sender.id === member.id && invite.sender.tableId === member.tableId) {
        ownInvites.push({ id: invite.id, tableId: invite.tableId, direction: 'outgoing', createdAt })
      } else if (invite.tableId === member.tableId && invite.recipients.has(member.id)) {
        ownInvites.push({ id: invite.id, tableId: invite.sender.tableId, direction: 'incoming', createdAt })
      }
    }

    const ownGames: Game[] = []
    for (const game of [...games.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const mine = playerMark(game, member)
      if (!mine) continue
      ownGames.push({
        id: game.id,
        tableId: game.players[mine === 'X' ? 'O' : 'X'].tableId,
        size: boardSize,
        board: game.board,
        mine,
        turn: game.turn,
        winner: game.winner,
        lastMove: game.lastMove,
      })
    }
    return { publicChat, conversations: ownConversations, invites: ownInvites, games: ownGames }
  }

  function sendChat(
    member: SocialMember,
    input: { conversationId?: unknown; recipientId?: unknown; text: unknown },
  ): string {
    const contents = typeof input.text === 'string' ? input.text.trim() : ''
    if (!contents || contents.length > 500) {
      throw new AppError(400, 'Tin nhắn cần có từ 1 đến 500 ký tự.')
    }
    const now = Date.now()
    if (now - (lastSent.get(member.id) ?? 0) < 350) {
      throw new AppError(429, 'Hãy đợi một chút trước khi gửi tiếp.')
    }

    const message: StoredMessage = {
      id: randomUUID(),
      authorGuestId: member.id,
      authorPublicId: member.publicId,
      authorName: member.displayName,
      tableId: member.tableId,
      text: contents,
      createdAt: new Date(now).toISOString(),
      timestamp: now,
    }

    if (input.conversationId === 'public') {
      publicMessages.push(message)
      if (publicMessages.length > maximumPublicMessages) publicMessages.shift()
      publicUpdatedAt = now
      lastSent.set(member.id, now)
      notifyAll()
      return 'public'
    }

    let chat: ChatRecord | undefined
    if (input.conversationId !== undefined) {
      if (typeof input.conversationId === 'string') chat = conversations.get(input.conversationId)
      if (!chat || !chat.members.has(member.id)) {
        throw new AppError(404, 'Cuộc trò chuyện không còn khả dụng.')
      }
    } else if (typeof input.recipientId === 'string' && input.recipientId) {
      const target = findOnlineByPublicId(input.recipientId)
      if (target?.guestId === member.id || input.recipientId === member.publicId) {
        throw new AppError(400, 'Hãy chọn một khách khác để nhắn riêng 1v1.')
      }
      if (target) {
        const key = [member.id, target.guestId].sort().join(':')
        chat = [...conversations.values()].find((candidate) => candidate.kind === 'direct' && candidate.directKey === key)
        if (!chat) {
          if (conversations.size >= maximumChats) {
            throw new AppError(503, 'Có nhiều cuộc trò chuyện đang mở. Vui lòng thử lại sau.')
          }
          chat = {
            id: randomUUID(),
            kind: 'direct',
            name: '',
            directKey: key,
            members: new Map([
              [member.id, snapshotOf(member)],
              [target.guestId, snapshotFromOnline(target)],
            ]),
            messages: [],
            seen: new Map(),
            updatedAt: now,
          }
          conversations.set(chat.id, chat)
        }
      } else {
        chat = [...conversations.values()].find((candidate) =>
          candidate.kind === 'direct'
          && candidate.members.has(member.id)
          && [...candidate.members.values()].some((participant) => participant.publicId === input.recipientId),
        )
        if (!chat) throw new AppError(409, 'Khách này hiện không còn online.')
      }
    } else {
      throw new AppError(400, 'Hãy chọn phòng chat hoặc người nhận để nhắn tin.')
    }

    chat.members.set(member.id, snapshotOf(member))
    chat.messages.push(message)
    if (chat.messages.length > maximumMessages) chat.messages.shift()
    chat.seen.set(member.id, { messageId: message.id, seenAt: message.createdAt })
    chat.updatedAt = now
    lastSent.set(member.id, now)
    notify(chat.members.keys())
    return chat.id
  }

  function createGroup(member: SocialMember, rawName: unknown, rawMemberIds: unknown): string {
    const name = parseGroupName(rawName)
    const invitedIds = parsePublicIds(rawMemberIds).filter((id) => id !== member.publicId)
    if (invitedIds.length < 1) {
      throw new AppError(400, 'Hãy chọn ít nhất 1 khách đang online để tạo nhóm.')
    }
    if (invitedIds.length >= maximumGroupMembers) {
      throw new AppError(400, `Mỗi nhóm chỉ tối đa ${maximumGroupMembers} thành viên.`)
    }
    if (conversations.size >= maximumChats) {
      throw new AppError(503, 'Có nhiều cuộc trò chuyện đang mở. Vui lòng thử lại sau.')
    }
    const joinedGroups = [...conversations.values()].filter((chat) => chat.kind === 'group' && chat.members.has(member.id)).length
    if (joinedGroups >= maximumGroupsPerGuest) {
      throw new AppError(409, 'Bạn đang tham gia quá nhiều nhóm. Hãy rời bớt trước khi tạo mới.')
    }

    const members = new Map<string, MemberSnapshot>([[member.id, snapshotOf(member)]])
    for (const publicId of invitedIds) {
      const target = findOnlineByPublicId(publicId)
      if (!target) {
        throw new AppError(409, 'Một số khách bạn chọn hiện không còn online.')
      }
      members.set(target.guestId, snapshotFromOnline(target))
    }

    const chat: ChatRecord = {
      id: randomUUID(),
      kind: 'group',
      name,
      members,
      messages: [],
      seen: new Map(),
      updatedAt: Date.now(),
    }
    conversations.set(chat.id, chat)
    notify(chat.members.keys())
    return chat.id
  }

  function markSeen(member: SocialMember, conversationId: string, rawMessageId: unknown): boolean {
    const chat = conversations.get(conversationId)
    if (!chat || !chat.members.has(member.id)) return false
    if (chat.messages.length === 0) return false

    const targetIndex = typeof rawMessageId === 'string' && rawMessageId
      ? chat.messages.findIndex((msg) => msg.id === rawMessageId)
      : chat.messages.length - 1
    if (targetIndex < 0) return false

    const targetMessage = chat.messages[targetIndex]
    const previous = chat.seen.get(member.id)
    if (previous) {
      if (previous.messageId === targetMessage.id) return false
      const prevIndex = chat.messages.findIndex((msg) => msg.id === previous.messageId)
      if (prevIndex >= targetIndex) return false
    }

    chat.members.set(member.id, snapshotOf(member))
    chat.seen.set(member.id, { messageId: targetMessage.id, seenAt: new Date().toISOString() })
    notify([...chat.members.keys()].filter((id) => id !== member.id))
    return true
  }

  function recipientGuestIds(memberId: string, conversationId: string): string[] | 'all' | null {
    if (conversationId === 'public') return 'all'
    const chat = conversations.get(conversationId)
    if (!chat || !chat.members.has(memberId)) return null
    return [...chat.members.keys()].filter((id) => id !== memberId)
  }

  function addGroupMembers(member: SocialMember, conversationId: string, rawMemberIds: unknown) {
    const chat = conversations.get(conversationId)
    if (!chat || chat.kind !== 'group' || !chat.members.has(member.id)) {
      throw new AppError(404, 'Nhóm trò chuyện không còn khả dụng.')
    }
    const requested = parsePublicIds(rawMemberIds)
    const toAdd: OnlineProfile[] = []
    for (const publicId of requested) {
      if ([...chat.members.values()].some((existing) => existing.publicId === publicId)) continue
      const target = findOnlineByPublicId(publicId)
      if (!target) {
        throw new AppError(409, 'Một số khách bạn chọn hiện không còn online.')
      }
      toAdd.push(target)
    }
    if (!toAdd.length) {
      throw new AppError(400, 'Hãy chọn ít nhất 1 thành viên mới đang online.')
    }
    if (chat.members.size + toAdd.length > maximumGroupMembers) {
      throw new AppError(400, `Mỗi nhóm chỉ tối đa ${maximumGroupMembers} thành viên.`)
    }
    for (const target of toAdd) {
      chat.members.set(target.guestId, snapshotFromOnline(target))
    }
    chat.updatedAt = Date.now()
    notify(chat.members.keys())
  }

  function leaveGroup(member: SocialMember, conversationId: string) {
    const chat = conversations.get(conversationId)
    if (!chat || chat.kind !== 'group' || !chat.members.has(member.id)) {
      throw new AppError(404, 'Nhóm trò chuyện không còn khả dụng.')
    }
    const recipients = [...chat.members.keys()]
    chat.members.delete(member.id)
    chat.seen.delete(member.id)
    if (chat.members.size === 0) {
      conversations.delete(conversationId)
    } else {
      chat.updatedAt = Date.now()
    }
    notify(recipients)
  }

  function sendInvite(member: SeatMember, tableId: unknown) {
    if (typeof tableId !== 'string' || tableId === member.tableId) {
      throw new AppError(400, 'Hãy chọn một bàn khác để mời chơi.')
    }
    if (activeGame(member)) throw new AppError(409, 'Bạn đang có một ván caro đang chơi.')
    if ([...invites.values()].some((invite) => invite.sender.id === member.id)) {
      throw new AppError(409, 'Bạn đang có một lời mời chưa phản hồi.')
    }
    const available = onlineGuests(tableId).filter((id) => !activeGame({ id, tableId }))
    if (!available.length) throw new AppError(409, 'Bàn này hiện chưa có khách sẵn sàng chơi caro.')
    const invite = {
      id: randomUUID(), sender: member, tableId, recipients: new Set(available), createdAt: Date.now(),
    }
    invites.set(invite.id, invite)
    notifyInvite(invite)
  }

  function answerInvite(member: SeatMember, id: string, accept: unknown) {
    if (typeof accept !== 'boolean') throw new AppError(400, 'Phản hồi lời mời không hợp lệ.')
    const invite = invites.get(id)
    if (!invite) throw new AppError(404, 'Lời mời đã hết hạn hoặc đã được phản hồi.')
    if (member.id === invite.sender.id && member.tableId === invite.sender.tableId && !accept) {
      invites.delete(id)
      notifyInvite(invite)
      return
    }
    if (member.tableId !== invite.tableId || !invite.recipients.has(member.id)) {
      throw new AppError(404, 'Lời mời đã hết hạn hoặc đã được phản hồi.')
    }
    if (!accept) {
      invite.recipients.delete(member.id)
      if (!invite.recipients.size) invites.delete(id)
      notify([member.id])
      notifyInvite(invite)
      return
    }
    if (!onlineGuests(invite.sender.tableId).includes(invite.sender.id)) {
      invites.delete(id)
      notifyInvite(invite)
      throw new AppError(409, 'Người gửi lời mời đã rời khỏi bàn.')
    }
    if (activeGame(member) || activeGame(invite.sender)) {
      throw new AppError(409, 'Một người chơi đang có ván caro khác.')
    }

    const game: GameRecord = {
      id: randomUUID(),
      players: { X: invite.sender, O: member },
      board: Array<Mark | null>(boardSize * boardSize).fill(null),
      turn: 'X',
      winner: null,
      lastMove: null,
      updatedAt: Date.now(),
    }
    games.set(game.id, game)
    invites.delete(id)
    notifyInvite(invite)
    for (const [pendingId, pending] of invites) {
      if (pending.sender.id === member.id || pending.sender.id === invite.sender.id) {
        invites.delete(pendingId)
        notifyInvite(pending)
      }
    }
  }

  function playMove(member: SeatMember, id: string, index: unknown) {
    const game = games.get(id)
    const mark = game && playerMark(game, member)
    if (!game || !mark) throw new AppError(404, 'Không tìm thấy ván caro.')
    if (game.winner) throw new AppError(409, 'Ván caro đã kết thúc.')
    if (mark !== game.turn) throw new AppError(409, 'Chưa đến lượt của bạn.')
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= game.board.length) {
      throw new AppError(400, 'Ô đánh không hợp lệ.')
    }
    if (game.board[index] !== null) throw new AppError(409, 'Ô này đã có quân cờ.')

    game.board[index] = mark
    game.lastMove = index
    game.updatedAt = Date.now()
    if (hasFive(game.board, index, mark)) game.winner = mark
    else if (game.board.every((value) => value !== null)) game.winner = 'draw'
    else game.turn = mark === 'X' ? 'O' : 'X'
    notifyGame(game)
  }

  return {
    state, sweep, sendChat, createGroup, addGroupMembers, leaveGroup,
    markSeen, recipientGuestIds, sendInvite, answerInvite, playMove,
  }
}

function hasFive(board: (Mark | null)[], index: number, mark: Mark): boolean {
  const x = index % boardSize
  const y = Math.floor(index / boardSize)
  const axes = [[1, 0], [0, 1], [1, 1], [1, -1]]
  return axes.some(([dx, dy]) => {
    let count = 1
    for (const direction of [-1, 1]) {
      let column = x + dx * direction
      let row = y + dy * direction
      while (column >= 0 && column < boardSize && row >= 0 && row < boardSize
        && board[row * boardSize + column] === mark) {
        count += 1
        column += dx * direction
        row += dy * direction
      }
    }
    return count >= 5
  })
}
