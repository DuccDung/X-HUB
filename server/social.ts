import { randomUUID } from 'node:crypto'
import { caroBoardSize } from '../src/shared.ts'
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
type InviteRecord = {
  id: string
  sender: MemberSnapshot
  tableId: string
  peer?: MemberSnapshot
  recipients: Set<string>
  createdAt: number
}
type GameRecord = {
  id: string
  players: Record<Mark, MemberSnapshot>
  board: (Mark | null)[]
  turn: Mark
  winner: Mark | 'draw' | null
  winningLine: number[] | null
  lastMove: number | null
  scores: Record<string, number>
  drawOfferFrom: Mark | null
  rematchFrom: Mark | null
  turnStartedAt: number
  updatedAt: number
}

const boardSize = caroBoardSize
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

  function playerMark(game: GameRecord, guestId: string): Mark | undefined {
    return (['X', 'O'] as const).find((mark) => game.players[mark].guestId === guestId)
  }

  function activeGame(guestId: string): boolean {
    return [...games.values()].some((game) => game.winner === null && playerMark(game, guestId))
  }

  function notifyGame(game: GameRecord) {
    notify([game.players.X.guestId, game.players.O.guestId])
  }

  function notifyInvite(invite: InviteRecord) {
    notify([invite.sender.guestId, ...invite.recipients])
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
      const liveSender = liveMap.get(invite.sender.guestId)
      if (liveSender) {
        invite.sender.displayName = liveSender.displayName
        invite.sender.tableId = liveSender.tableId
        invite.sender.publicId = liveSender.publicId
      }
      if (invite.peer) {
        const livePeer = liveMap.get(invite.peer.guestId)
        if (livePeer) {
          invite.peer.displayName = livePeer.displayName
          invite.peer.tableId = livePeer.tableId
          invite.peer.publicId = livePeer.publicId
        }
      }
      if (invite.sender.guestId === member.id) {
        ownInvites.push({
          id: invite.id,
          tableId: invite.peer?.tableId ?? invite.tableId,
          peerId: invite.peer?.publicId,
          peerName: invite.peer?.displayName,
          direction: 'outgoing',
          createdAt,
        })
      } else if (invite.recipients.has(member.id)) {
        ownInvites.push({
          id: invite.id,
          tableId: invite.sender.tableId,
          peerId: invite.sender.publicId,
          peerName: invite.sender.displayName,
          direction: 'incoming',
          createdAt,
        })
      }
    }

    const ownGames: Game[] = []
    for (const game of [...games.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const mine = playerMark(game, member.id)
      if (!mine) continue
      const opponentMark: Mark = mine === 'X' ? 'O' : 'X'
      const opponent = game.players[opponentMark]
      const liveOpponent = liveMap.get(opponent.guestId)
      if (liveOpponent) {
        opponent.displayName = liveOpponent.displayName
        opponent.tableId = liveOpponent.tableId
        opponent.publicId = liveOpponent.publicId
      }
      ownGames.push({
        id: game.id,
        tableId: opponent.tableId,
        opponentId: opponent.publicId,
        opponentName: opponent.displayName,
        size: boardSize,
        board: game.board,
        mine,
        turn: game.turn,
        winner: game.winner,
        winningLine: game.winningLine,
        lastMove: game.lastMove,
        score: {
          mine: game.scores[member.id] ?? 0,
          opponent: game.scores[opponent.guestId] ?? 0,
        },
        drawOfferFrom: game.drawOfferFrom,
        rematchFrom: game.rematchFrom,
        turnStartedAt: new Date(game.turnStartedAt).toISOString(),
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

  function sendInvite(member: SocialMember, target: { tableId?: unknown; recipientId?: unknown }) {
    if (activeGame(member.id)) throw new AppError(409, 'Bạn đang có một ván caro đang chơi.')
    if ([...invites.values()].some((invite) => invite.sender.guestId === member.id)) {
      throw new AppError(409, 'Bạn đang có một lời mời chưa phản hồi.')
    }

    let tableId: string
    let recipients: string[]
    let peer: MemberSnapshot | undefined

    if (typeof target.recipientId === 'string' && target.recipientId) {
      const online = findOnlineByPublicId(target.recipientId)
      if (target.recipientId === member.publicId || online?.guestId === member.id) {
        throw new AppError(400, 'Hãy chọn một khách khác để mời chơi caro.')
      }
      if (!online) throw new AppError(409, 'Khách này hiện không còn online.')
      if (activeGame(online.guestId)) throw new AppError(409, 'Khách này đang bận trong một ván caro khác.')
      tableId = online.tableId
      recipients = [online.guestId]
      peer = snapshotFromOnline(online)
    } else {
      if (typeof target.tableId !== 'string' || target.tableId === member.tableId) {
        throw new AppError(400, 'Hãy chọn một bàn khác để mời chơi.')
      }
      const available = onlineGuests(target.tableId).filter((id) => id !== member.id && !activeGame(id))
      if (!available.length) throw new AppError(409, 'Bàn này hiện chưa có khách sẵn sàng chơi caro.')
      tableId = target.tableId
      recipients = available
      if (available.length === 1) {
        const single = onlineByGuestId().get(available[0])
        if (single) peer = snapshotFromOnline(single)
      }
    }

    const invite: InviteRecord = {
      id: randomUUID(),
      sender: snapshotOf(member),
      tableId,
      peer,
      recipients: new Set(recipients),
      createdAt: Date.now(),
    }
    invites.set(invite.id, invite)
    notifyInvite(invite)
  }

  function answerInvite(member: SocialMember, id: string, accept: unknown) {
    if (typeof accept !== 'boolean') throw new AppError(400, 'Phản hồi lời mời không hợp lệ.')
    const invite = invites.get(id)
    if (!invite) throw new AppError(404, 'Lời mời đã hết hạn hoặc đã được phản hồi.')
    if (member.id === invite.sender.guestId && !accept) {
      invites.delete(id)
      notifyInvite(invite)
      return
    }
    if (!invite.recipients.has(member.id)) {
      throw new AppError(404, 'Lời mời đã hết hạn hoặc đã được phản hồi.')
    }
    if (!accept) {
      invite.recipients.delete(member.id)
      if (!invite.recipients.size) invites.delete(id)
      notify([member.id])
      notifyInvite(invite)
      return
    }
    const liveSender = onlineByGuestId().get(invite.sender.guestId)
    if (!liveSender) {
      invites.delete(id)
      notifyInvite(invite)
      throw new AppError(409, 'Người gửi lời mời đã rời khỏi bàn.')
    }
    if (activeGame(member.id) || activeGame(invite.sender.guestId)) {
      throw new AppError(409, 'Một người chơi đang có ván caro khác.')
    }

    const now = Date.now()
    const senderSnap = snapshotFromOnline(liveSender)
    const memberSnap = snapshotOf(member)
    const game: GameRecord = {
      id: randomUUID(),
      players: { X: senderSnap, O: memberSnap },
      board: Array<Mark | null>(boardSize * boardSize).fill(null),
      turn: 'X',
      winner: null,
      winningLine: null,
      lastMove: null,
      scores: { [senderSnap.guestId]: 0, [memberSnap.guestId]: 0 },
      drawOfferFrom: null,
      rematchFrom: null,
      turnStartedAt: now,
      updatedAt: now,
    }
    games.set(game.id, game)
    invites.delete(id)
    notifyInvite(invite)
    for (const [pendingId, pending] of invites) {
      if (pending.sender.guestId === member.id || pending.sender.guestId === invite.sender.guestId) {
        invites.delete(pendingId)
        notifyInvite(pending)
      }
    }
  }

  function playMove(member: SocialMember, id: string, index: unknown) {
    const game = games.get(id)
    const mark = game && playerMark(game, member.id)
    if (!game || !mark) throw new AppError(404, 'Không tìm thấy ván caro.')
    if (game.winner) throw new AppError(409, 'Ván caro đã kết thúc.')
    if (mark !== game.turn) throw new AppError(409, 'Chưa đến lượt của bạn.')
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= game.board.length) {
      throw new AppError(400, 'Ô đánh không hợp lệ.')
    }
    if (game.board[index] !== null) throw new AppError(409, 'Ô này đã có quân cờ.')

    const now = Date.now()
    game.board[index] = mark
    game.lastMove = index
    game.drawOfferFrom = null
    game.updatedAt = now

    const line = findWinningLine(game.board, index, mark)
    if (line) {
      game.winner = mark
      game.winningLine = line
      game.scores[member.id] = (game.scores[member.id] ?? 0) + 1
    } else if (game.board.every((value) => value !== null)) {
      game.winner = 'draw'
    } else {
      game.turn = mark === 'X' ? 'O' : 'X'
      game.turnStartedAt = now
    }
    notifyGame(game)
  }

  function resignGame(member: SocialMember, id: string) {
    const game = games.get(id)
    const mark = game && playerMark(game, member.id)
    if (!game || !mark) throw new AppError(404, 'Không tìm thấy ván caro.')
    if (game.winner) throw new AppError(409, 'Ván caro đã kết thúc.')

    const opponentMark: Mark = mark === 'X' ? 'O' : 'X'
    const opponent = game.players[opponentMark]
    game.winner = opponentMark
    game.winningLine = null
    game.drawOfferFrom = null
    game.scores[opponent.guestId] = (game.scores[opponent.guestId] ?? 0) + 1
    game.updatedAt = Date.now()
    notifyGame(game)
  }

  function handleDraw(member: SocialMember, id: string, action: unknown) {
    if (action !== 'offer' && action !== 'accept' && action !== 'decline') {
      throw new AppError(400, 'Thao tác xin hòa không hợp lệ.')
    }
    const game = games.get(id)
    const mark = game && playerMark(game, member.id)
    if (!game || !mark) throw new AppError(404, 'Không tìm thấy ván caro.')
    if (game.winner) throw new AppError(409, 'Ván caro đã kết thúc.')

    if (action === 'offer') {
      if (game.drawOfferFrom === mark) return
      game.drawOfferFrom = mark
    } else if (action === 'accept') {
      if (!game.drawOfferFrom || game.drawOfferFrom === mark) {
        throw new AppError(409, 'Hiện chưa có đề nghị hòa từ đối thủ.')
      }
      game.winner = 'draw'
      game.winningLine = null
      game.drawOfferFrom = null
    } else {
      if (!game.drawOfferFrom) return
      game.drawOfferFrom = null
    }
    game.updatedAt = Date.now()
    notifyGame(game)
  }

  function requestRematch(member: SocialMember, id: string): string {
    const game = games.get(id)
    const mark = game && playerMark(game, member.id)
    if (!game || !mark) throw new AppError(404, 'Không tìm thấy ván caro.')
    if (!game.winner) throw new AppError(409, 'Ván caro hiện vẫn đang chơi.')

    const opponentMark: Mark = mark === 'X' ? 'O' : 'X'
    const opponent = game.players[opponentMark]
    const liveOpponent = onlineByGuestId().get(opponent.guestId)
    if (!liveOpponent) {
      throw new AppError(409, 'Đối thủ hiện không còn online.')
    }
    if (activeGame(member.id) || activeGame(opponent.guestId)) {
      throw new AppError(409, 'Một người chơi đang có ván caro khác.')
    }

    if (!game.rematchFrom) {
      game.rematchFrom = mark
      game.updatedAt = Date.now()
      notifyGame(game)
      return game.id
    }
    if (game.rematchFrom === mark) {
      return game.id
    }

    // Both players agreed -> start new round swapping X and O, preserving scores
    const now = Date.now()
    const nextX = game.players.O.guestId === member.id ? snapshotOf(member) : snapshotFromOnline(liveOpponent)
    const nextO = game.players.X.guestId === member.id ? snapshotOf(member) : snapshotFromOnline(liveOpponent)
    const nextGame: GameRecord = {
      id: randomUUID(),
      players: { X: nextX, O: nextO },
      board: Array<Mark | null>(boardSize * boardSize).fill(null),
      turn: 'X',
      winner: null,
      winningLine: null,
      lastMove: null,
      scores: { ...game.scores },
      drawOfferFrom: null,
      rematchFrom: null,
      turnStartedAt: now,
      updatedAt: now,
    }
    games.delete(game.id)
    games.set(nextGame.id, nextGame)
    notifyGame(nextGame)
    return nextGame.id
  }

  function caroOpponentGuestId(memberId: string, gameId: string): string | null {
    const game = games.get(gameId)
    if (!game) return null
    const mark = playerMark(game, memberId)
    if (!mark) return null
    return game.players[mark === 'X' ? 'O' : 'X'].guestId
  }

  return {
    state, sweep, sendChat, createGroup, addGroupMembers, leaveGroup,
    markSeen, recipientGuestIds, sendInvite, answerInvite, playMove,
    resignGame, handleDraw, requestRematch, caroOpponentGuestId,
  }
}

function findWinningLine(board: (Mark | null)[], index: number, mark: Mark): number[] | null {
  const x = index % boardSize
  const y = Math.floor(index / boardSize)
  const axes = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (const [dx, dy] of axes) {
    const cells = [index]
    for (const direction of [-1, 1]) {
      let column = x + dx * direction
      let row = y + dy * direction
      while (column >= 0 && column < boardSize && row >= 0 && row < boardSize
        && board[row * boardSize + column] === mark) {
        cells.push(row * boardSize + column)
        column += dx * direction
        row += dy * direction
      }
    }
    if (cells.length >= 5) {
      return cells.sort((a, b) => a - b)
    }
  }
  return null
}
