import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { io } from 'socket.io-client'
import { findCaroWinningLine, pickBotMove } from '../src/caroBot.ts'
import { caroBoardSize } from '../src/shared.ts'
import type { AdminLayout, SocialState, VenueState } from '../src/shared.ts'
import { checkInGuest, extractCookie, startTestServer } from './helpers.ts'
import type { TestServerHandle } from './helpers.ts'

describe('Core Regression — Admin, Venue, Character, Chat, and Caro', () => {
  let server: TestServerHandle
  let adminCookie = ''
  let qrs: Record<string, string> = {}

  before(async () => {
    server = await startTestServer()
  })

  after(async () => {
    await server.stop()
  })

  it('serves /api/health and handles admin login, 2-floor layout draft/conflict/publish, and logout', async () => {
    const health = await fetch(`${server.baseUrl}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    // Wrong password -> 401
    const badLogin = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ password: 'wrong-password' }),
    })
    assert.equal(badLogin.status, 401)

    // Correct password -> 200
    const goodLogin = await fetch(`${server.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ password: server.adminPassword }),
    })
    assert.equal(goodLogin.status, 200)
    adminCookie = extractCookie(goodLogin, 'xc_admin')
    assert.ok(adminCookie)

    const session = await (await fetch(`${server.baseUrl}/api/admin/session`, {
      headers: { Cookie: adminCookie },
    })).json() as { authenticated: boolean }
    assert.equal(session.authenticated, true)

    // Seeded 20 tables across Floor 1 (12) and Floor 2 (8)
    const initial = await (await fetch(`${server.baseUrl}/api/admin/layout`, {
      headers: { Cookie: adminCookie },
    })).json() as AdminLayout
    qrs = initial.qrs
    assert.equal(initial.published.tables.length, 20)
    assert.equal(initial.published.tables.filter((t) => t.floor === 1).length, 12)
    assert.equal(initial.published.tables.filter((t) => t.floor === 2).length, 8)

    // Save draft increments version; stale version returns 409
    const updatedTables = initial.draft.tables.map((t) => (t.id === 'table-01' ? { ...t, rotation: 90 } : t))
    const saved = await fetch(`${server.baseUrl}/api/admin/layout`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: adminCookie },
      body: JSON.stringify({ tables: updatedTables, version: initial.draft.version }),
    })
    assert.equal(saved.status, 200)
    const afterSave = await saved.json() as AdminLayout
    assert.equal(afterSave.draft.version, initial.draft.version + 1)

    const conflict = await fetch(`${server.baseUrl}/api/admin/layout`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: adminCookie },
      body: JSON.stringify({ tables: updatedTables, version: initial.draft.version }),
    })
    assert.equal(conflict.status, 409)

    // Publish draft
    const pubRes = await fetch(`${server.baseUrl}/api/admin/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: adminCookie },
      body: JSON.stringify({ version: afterSave.draft.version }),
    })
    assert.equal(pubRes.status, 200)
    const published = await pubRes.json() as AdminLayout
    assert.equal(published.published.version, afterSave.draft.version)

    // Logout invalidates cookie
    const logoutRes = await fetch(`${server.baseUrl}/api/admin/logout`, {
      method: 'POST',
      headers: { Origin: server.baseUrl, Cookie: adminCookie },
    })
    assert.equal(logoutRes.status, 200)
    const afterLogout = await fetch(`${server.baseUrl}/api/admin/layout`, {
      headers: { Cookie: adminCookie },
    })
    assert.equal(afterLogout.status, 401)
  })

  it('supports QR check-in, character profile, realtime Chat (public/1v1/group), and Caro flow', async () => {
    // Invalid QR -> 404
    const badQr = await fetch(`${server.baseUrl}/api/check-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ code: 'invalid-qr' }),
    })
    assert.equal(badQr.status, 404)

    const cookieA = await checkInGuest(server, qrs['table-02'])
    const cookieB = await checkInGuest(server, qrs['table-202'])

    // Invalid profile rejected
    const badProfile = await fetch(`${server.baseUrl}/api/guest/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: JSON.stringify({ displayName: '', model: 'neutral', outfit: { top: 'olive', bottom: 'charcoal', shoes: 'sand' } }),
    })
    assert.equal(badProfile.status, 400)

    // Valid profiles
    const profA = await (await fetch(`${server.baseUrl}/api/guest/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
      body: JSON.stringify({ displayName: 'Minh', model: 'male', outfit: { top: 'brown', bottom: 'navy', shoes: 'coffee' } }),
    })).json() as VenueState
    const profB = await (await fetch(`${server.baseUrl}/api/guest/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
      body: JSON.stringify({ displayName: 'Lan', model: 'female', outfit: { top: 'rust', bottom: 'sand', shoes: 'black' } }),
    })).json() as VenueState
    assert.equal(profA.profile?.displayName, 'Minh')
    assert.equal(profB.profile?.displayName, 'Lan')

    // Connect both sockets so they are online in realtime presence
    const connectSocket = (cookie: string) => new Promise<ReturnType<typeof io>>((resolveSock, reject) => {
      const sock = io(server.baseUrl, {
        extraHeaders: { Cookie: cookie, Origin: server.baseUrl },
        transports: ['polling'],
      })
      sock.once('connect', () => resolveSock(sock))
      sock.once('connect_error', reject)
    })

    const sockA = await connectSocket(cookieA)
    const sockB = await connectSocket(cookieB)
    try {
      // Public chat
      const pubChat = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
        body: JSON.stringify({ conversationId: 'public', text: 'Chào cả quán!' }),
      })
      assert.equal(pubChat.status, 200)
      await new Promise((r) => setTimeout(r, 380))

      // 1v1 direct chat + seen
      const dmRes = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
        body: JSON.stringify({ recipientId: profB.profile!.id, text: 'Chào Lan nhé' }),
      })
      assert.equal(dmRes.status, 200)
      const dmBody = await dmRes.json() as SocialState & { conversationId: string }
      const dmMsgId = dmBody.conversations.find((c) => c.id === dmBody.conversationId)!.messages[0].id

      const seenRes = await fetch(`${server.baseUrl}/api/chat/${dmBody.conversationId}/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
        body: JSON.stringify({ messageId: dmMsgId }),
      })
      assert.equal(seenRes.status, 200)

      // Group chat create + leave
      const groupRes = await fetch(`${server.baseUrl}/api/chat/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
        body: JSON.stringify({ name: 'Hội cà phê', memberIds: [profB.profile!.id] }),
      })
      assert.equal(groupRes.status, 201)
      const groupBody = await groupRes.json() as SocialState & { conversationId: string }

      const leaveRes = await fetch(`${server.baseUrl}/api/chat/groups/${groupBody.conversationId}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
        body: JSON.stringify({}),
      })
      assert.equal(leaveRes.status, 200)

      // Caro invite -> accept -> move -> out-of-turn 409 -> draw offer/decline -> resign -> rematch
      const inviteRes = await fetch(`${server.baseUrl}/api/caro/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
        body: JSON.stringify({ recipientId: profB.profile!.id }),
      })
      assert.equal(inviteRes.status, 200)
      const inviteState = await inviteRes.json() as SocialState
      const inviteId = inviteState.invites[0].id

      const acceptRes = await fetch(`${server.baseUrl}/api/caro/invites/${inviteId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
        body: JSON.stringify({ accept: true }),
      })
      assert.equal(acceptRes.status, 200)
      const gameState = await acceptRes.json() as SocialState
      const gameId = gameState.games[0].id
      assert.equal(gameState.games[0].size, 50)
      assert.equal(gameState.games[0].board.length, 2500)

      // Out-of-turn O move -> 409
      const badTurn = await fetch(`${server.baseUrl}/api/caro/games/${gameId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
        body: JSON.stringify({ index: 1275 }),
      })
      assert.equal(badTurn.status, 409)

      // Valid X move near center of 50x50 board -> 200
      const moveX = await fetch(`${server.baseUrl}/api/caro/games/${gameId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
        body: JSON.stringify({ index: 1275 }),
      })
      assert.equal(moveX.status, 200)
      const afterMove = await moveX.json() as SocialState
      assert.equal(afterMove.games[0].board[1275], 'X')
      assert.equal(afterMove.games[0].lastMove, 1275)

      // Draw offer & decline
      assert.equal((await fetch(`${server.baseUrl}/api/caro/games/${gameId}/draw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
        body: JSON.stringify({ action: 'offer' }),
      })).status, 200)
      assert.equal((await fetch(`${server.baseUrl}/api/caro/games/${gameId}/draw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
        body: JSON.stringify({ action: 'decline' }),
      })).status, 200)

      // Resign & rematch (both agree -> swaps X/O, preserves score)
      const resign = await (await fetch(`${server.baseUrl}/api/caro/games/${gameId}/resign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
        body: JSON.stringify({}),
      })).json() as SocialState
      assert.equal(resign.games[0].winner, 'X')
      assert.equal(resign.games[0].score.opponent, 1)

      await fetch(`${server.baseUrl}/api/caro/games/${gameId}/rematch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieA },
        body: JSON.stringify({}),
      })
      const rematch2 = await (await fetch(`${server.baseUrl}/api/caro/games/${gameId}/rematch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: server.baseUrl, Cookie: cookieB },
        body: JSON.stringify({}),
      })).json() as SocialState & { gameId: string }
      assert.notEqual(rematch2.gameId, gameId)
      const nextGame = rematch2.games.find((g) => g.id === rematch2.gameId)!
      assert.equal(nextGame.mine, 'X') // Swapped: Guest B was O, now X
      assert.equal(nextGame.score.opponent, 1) // Score preserved
    } finally {
      sockA.disconnect()
      sockB.disconnect()
    }
  })

  it('supports 50×50 Caro Bot moves and 5-in-a-row win detection across the full board', () => {
    const board = Array<'X' | 'O' | null>(caroBoardSize * caroBoardSize).fill(null)
    // Bot opens at exact center (25, 25) on medium/hard
    const openMove = pickBotMove(board, 'X', 'medium')
    assert.equal(openMove, 25 * caroBoardSize + 25)

    // Place 4 X pieces diagonally far from origin (row 40..43, col 42..45)
    for (let k = 0; k < 4; k++) {
      board[(40 + k) * caroBoardSize + (42 + k)] = 'X'
    }
    // Hard Bot playing O must block one of the open ends: (39, 41) or (44, 46)
    const blockMove = pickBotMove(board, 'O', 'hard')
    const endA = 39 * caroBoardSize + 41
    const endB = 44 * caroBoardSize + 46
    assert.ok(blockMove === endA || blockMove === endB, `expected block at ${endA} or ${endB}, got ${blockMove}`)

    // Completing the 5th X returns the exact sorted 5-cell winning line
    board[endB] = 'X'
    const line = findCaroWinningLine(board, endB, 'X')
    assert.deepEqual(line, [
      40 * caroBoardSize + 42,
      41 * caroBoardSize + 43,
      42 * caroBoardSize + 44,
      43 * caroBoardSize + 45,
      44 * caroBoardSize + 46,
    ])
  })
})
