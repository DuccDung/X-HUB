import { randomUUID } from 'node:crypto'
import type { Conversation, Game, Invite, SocialState } from '../src/shared.ts'
import { AppError } from './database.ts'

type Member = { id: string; tableId: string }
type Mark = 'X' | 'O'
type Message = { id: string; authorId: string; text: string; tableId: string; createdAt: string }
type ChatRecord = {
  id: string
  tables: [string, string]
  members: Map<string, string>
  messages: Message[]
  updatedAt: number
}
type InviteRecord = { id: string; sender: Member; tableId: string; recipients: Set<string>; createdAt: number }
type GameRecord = {
  id: string
  players: Record<Mark, Member>
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

export function createSocial(
  onlineGuests: (tableId: string) => string[],
  notify: (guestIds: Iterable<string>) => void,
) {
  const conversations = new Map<string, ChatRecord>()
  const invites = new Map<string, InviteRecord>()
  const games = new Map<string, GameRecord>()
  const lastSent = new Map<string, number>()

  function chatMember(chat: ChatRecord, member: Member): boolean {
    return chat.members.get(member.id) === member.tableId
  }

  function playerMark(game: GameRecord, member: Member): Mark | undefined {
    return (['X', 'O'] as const).find((mark) =>
      game.players[mark].id === member.id && game.players[mark].tableId === member.tableId,
    )
  }

  function activeGame(member: Member): boolean {
    return [...games.values()].some((game) => game.winner === null && playerMark(game, member))
  }

  function notifyGame(game: GameRecord) {
    notify([game.players.X.id, game.players.O.id])
  }

  function notifyInvite(invite: InviteRecord) {
    notify([invite.sender.id, ...invite.recipients])
  }

  function sweep() {
    const now = Date.now()
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

  function state(member: Member | null): SocialState {
    if (!member) return { conversations: [], invites: [], games: [] }
    const ownConversations = [...conversations.values()]
      .filter((chat) => chatMember(chat, member))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((chat): Conversation => ({
        id: chat.id,
        tableId: chat.tables[0] === member.tableId ? chat.tables[1] : chat.tables[0],
        messages: chat.messages.map(({ authorId, ...message }) => ({
          ...message,
          mine: authorId === member.id,
        })),
      }))

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
    return { conversations: ownConversations, invites: ownInvites, games: ownGames }
  }

  function sendChat(member: Member, tableId: unknown, text: unknown, conversationId: unknown) {
    if (typeof tableId !== 'string' || member.tableId === tableId) {
      throw new AppError(400, 'Hãy chọn một bàn khác để nhắn tin.')
    }
    const contents = typeof text === 'string' ? text.trim() : ''
    if (!contents || contents.length > 500) {
      throw new AppError(400, 'Tin nhắn cần có từ 1 đến 500 ký tự.')
    }
    const now = Date.now()
    if (now - (lastSent.get(member.id) ?? 0) < 350) {
      throw new AppError(429, 'Hãy đợi một chút trước khi gửi tiếp.')
    }

    let chat: ChatRecord | undefined
    if (conversationId !== undefined) {
      if (typeof conversationId === 'string') chat = conversations.get(conversationId)
      if (!chat || !chatMember(chat, member) || !chat.tables.includes(tableId)) {
        throw new AppError(404, 'Cuộc trò chuyện không còn khả dụng.')
      }
    } else {
      chat = [...conversations.values()].find((candidate) =>
        chatMember(candidate, member) && candidate.tables.includes(tableId),
      )
    }
    if (!chat) {
      const targetGuests = onlineGuests(tableId)
      if (targetGuests.length === 0) throw new AppError(409, 'Bàn này chưa có khách đang hoạt động.')
      if (conversations.size >= maximumChats) {
        throw new AppError(503, 'Có nhiều cuộc trò chuyện đang mở. Vui lòng thử lại sau.')
      }
      chat = {
        id: randomUUID(),
        tables: [member.tableId, tableId],
        members: new Map([[member.id, member.tableId], ...targetGuests.map((id): [string, string] => [id, tableId])]),
        messages: [],
        updatedAt: now,
      }
      conversations.set(chat.id, chat)
    }

    chat.messages.push({
      id: randomUUID(),
      authorId: member.id,
      text: contents,
      tableId: member.tableId,
      createdAt: new Date(now).toISOString(),
    })
    if (chat.messages.length > maximumMessages) chat.messages.shift()
    chat.updatedAt = now
    lastSent.set(member.id, now)
    notify(chat.members.keys())
  }

  function sendInvite(member: Member, tableId: unknown) {
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

  function answerInvite(member: Member, id: string, accept: unknown) {
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

  function playMove(member: Member, id: string, index: unknown) {
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

  return { state, sweep, sendChat, sendInvite, answerInvite, playMove }
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
