import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { api } from './api';
import { CaroPanel } from './CaroPanel';
import { CharacterDialog } from './CharacterDialog';
import { CharacterSprite } from './CharacterSprite';
import { ChatPanel } from './ChatPanel';
import type { ChatTarget, OnlinePerson } from './ChatPanel';
import { JournalPanel } from './JournalPanel';
import { MapView } from './Map';
import { PuzzlePanel } from './PuzzlePanel';
import {
  loadSoundEnabled,
  playCaroInviteSound,
  playCaroMoveSound,
  playCaroWinSound,
  playMessageSound,
  saveSoundEnabled,
  unlockAudio,
} from './sound';
import type {
  CaroEmoji,
  CaroEmojiEvent,
  ChatTypingEvent,
  FloorId,
  GuestProfile,
  Layout,
  SocialState,
  TableCharacter,
  TableLayout,
  VenueActivity,
  VenueState,
} from './shared';
import './guest.css';

const tabs = [
  { id: 'map', title: 'Sơ đồ' },
  { id: 'chat', title: 'Chat' },
  { id: 'caro', title: 'Caro' },
  { id: 'puzzle', title: 'Xếp hình' },
  { id: 'journal', title: 'Nhật ký' },
] as const;
type Tab = typeof tabs[number]['id'];
type ChatResponse = SocialState & { conversationId: string };
type RematchResponse = SocialState & { gameId: string };
const emptySocial: SocialState = {
  publicChat: {
    id: 'public',
    kind: 'public',
    name: 'Cả quán',
    members: [],
    messages: [],
    receipts: [],
    updatedAt: new Date(0).toISOString(),
  },
  conversations: [],
  invites: [],
  games: [],
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Có lỗi xảy ra. Bạn thử lại nhé.';
}

export function Guest() {
  const [venue, setVenue] = useState<VenueState>();
  const [social, setSocial] = useState(emptySocial);
  const [tab, setTab] = useState<Tab>('map');
  const [floor, setFloor] = useState<FloorId>(1);
  const [target, setTarget] = useState<ChatTarget>();
  const [groupDraftMemberIds, setGroupDraftMemberIds] = useState<string[]>();
  const [seenMessageIds, setSeenMessageIds] = useState<Record<string, string>>({});
  const [typingByRoom, setTypingByRoom] = useState<Record<string, Record<string, string>>>({});
  const [soundEnabled, setSoundEnabled] = useState(() => loadSoundEnabled());
  const [inspectId, setInspectId] = useState<string>();
  const [gameId, setGameId] = useState<string>();
  const [incomingCaroEmoji, setIncomingCaroEmoji] = useState<(CaroEmojiEvent & { seq: number }) | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editingCharacter, setEditingCharacter] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const socialRevision = useRef(0);
  const syncedTableId = useRef<string | null>(null);
  const initializedPublicSeen = useRef(false);
  const socketRef = useRef<Socket | null>(null);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const knownMessageIds = useRef<Set<string>>(new Set());
  const seededKnownMessages = useRef(false);
  const caroEmojiSeq = useRef(0);
  const prevCaroRef = useRef<{
    incomingInviteIds: Set<string>;
    games: Map<string, { lastMove: number | null; winner: string | null }>;
  } | null>(null);
  const sentSeenRef = useRef<Record<string, string>>({});
  const soundEnabledRef = useRef(soundEnabled);
  const tabRef = useRef(tab);
  const targetRef = useRef(target);
  const selfIdRef = useRef<string | undefined>(undefined);
  const checkedInRef = useRef(false);
  const profile = venue?.profile;
  const tableId = venue?.tableId;
  const checkedIn = Boolean(tableId && profile);
  soundEnabledRef.current = soundEnabled;
  tabRef.current = tab;
  targetRef.current = target;
  selfIdRef.current = profile?.id;
  checkedInRef.current = checkedIn;
  const showCharacterDialog = Boolean(tableId && (editingCharacter || (!profile && !onboardingDismissed)));
  const tables = venue?.layout.tables ?? [];
  const current = tables.find((table) => table.id === tableId);
  const inspecting = tables.find((table) => table.id === inspectId);
  const floorTables = tables.filter((table) => table.floor === floor);
  const pending = social.invites.filter((invite) => invite.direction === 'incoming').length;
  const myTurnCaroCount = social.games.filter((game) => !game.winner && game.turn === game.mine).length;
  const caroBadgeCount = pending + (tab !== 'caro' ? myTurnCaroCount : 0);
  const currentCharacters = tableId ? venue?.characters?.[tableId] ?? [] : [];
  const characters = tableId && profile && !currentCharacters.some((character) => character.id === profile.id)
    ? { ...venue?.characters, [tableId]: [...currentCharacters, profile] }
    : venue?.characters;
  const joinHint = tableId ? 'Tạo nhân vật để tham gia.' : 'Quét mã QR tại bàn để tham gia.';

  const onlinePeople: OnlinePerson[] = [];
  const seenOnline = new Set<string>();
  for (const table of tables) {
    for (const person of characters?.[table.id] ?? []) {
      if (person.id === profile?.id || seenOnline.has(person.id)) continue;
      seenOnline.add(person.id);
      onlinePeople.push({ ...person, tableId: table.id, tableLabel: table.label, floor: table.floor });
    }
  }

  const unreadIds = new Set<string>();
  for (const room of [social.publicChat, ...social.conversations]) {
    const last = room.messages.at(-1);
    if (last && !last.mine && seenMessageIds[room.id] !== last.id) {
      unreadIds.add(room.id);
    }
  }
  const unreadChats = unreadIds.size;

  useEffect(() => {
    if (!current) {
      syncedTableId.current = null;
      return;
    }
    if (syncedTableId.current !== current.id) {
      syncedTableId.current = current.id;
      setFloor(current.floor);
    }
  }, [current]);

  useEffect(() => {
    const controller = new AbortController();
    async function openVenue() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('table');
      if (code) {
        try {
          const state = await api<VenueState>('/api/check-in', {
            method: 'POST', body: JSON.stringify({ code }), signal: controller.signal,
          });
          url.searchParams.delete('table');
          window.history.replaceState(null, '', url);
          setVenue(state);
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          setNotice(messageOf(error));
        }
      }
      try {
        setVenue(await api<VenueState>('/api/venue', { signal: controller.signal }));
      } catch (error) {
        if (!controller.signal.aborted) setNotice(messageOf(error));
      }
    }
    void openVenue();
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const reloadSocial = useCallback(async () => {
    const revision = ++socialRevision.current;
    try {
      const next = await api<SocialState>('/api/social');
      if (revision === socialRevision.current) {
        const allRooms = [next.publicChat, ...next.conversations];
        if (!seededKnownMessages.current) {
          seededKnownMessages.current = true;
          for (const room of allRooms) {
            for (const msg of room.messages) knownMessageIds.current.add(msg.id);
          }
        } else {
          let incomingRoomId: string | null = null;
          for (const room of allRooms) {
            for (const msg of room.messages) {
              if (!knownMessageIds.current.has(msg.id)) {
                knownMessageIds.current.add(msg.id);
                if (!msg.mine) incomingRoomId = room.id;
              }
            }
          }
          if (incomingRoomId && soundEnabledRef.current) {
            const activeTarget = targetRef.current;
            const viewingSameRoom = document.visibilityState === 'visible'
              && tabRef.current === 'chat'
              && (
                (incomingRoomId === 'public' && activeTarget?.kind === 'public')
                || (activeTarget?.kind === 'conversation' && activeTarget.conversationId === incomingRoomId)
              );
            playMessageSound(viewingSameRoom);
          }
        }

        const nextIncomingInvites = new Set(
          next.invites.filter((item) => item.direction === 'incoming').map((item) => item.id),
        );
        const nextGameSnap = new Map(
          next.games.map((g) => [g.id, { lastMove: g.lastMove, winner: g.winner }]),
        );
        const prevCaro = prevCaroRef.current;
        if (prevCaro && soundEnabledRef.current) {
          let playedCaroSound = false;
          for (const id of nextIncomingInvites) {
            if (!prevCaro.incomingInviteIds.has(id)) {
              playCaroInviteSound();
              playedCaroSound = true;
              break;
            }
          }
          if (!playedCaroSound) {
            for (const g of next.games) {
              const prev = prevCaro.games.get(g.id);
              if (g.winner && (!prev || !prev.winner)) {
                playCaroWinSound(g.winner === g.mine);
                playedCaroSound = true;
                break;
              }
              if (prev && g.lastMove !== prev.lastMove && g.lastMove !== null && g.turn === g.mine) {
                playCaroMoveSound(false);
                playedCaroSound = true;
                break;
              }
            }
          }
        }
        prevCaroRef.current = { incomingInviteIds: nextIncomingInvites, games: nextGameSnap };

        setSocial(next);
        if (!initializedPublicSeen.current) {
          initializedPublicSeen.current = true;
          const publicLastId = next.publicChat.messages.at(-1)?.id;
          if (publicLastId) {
            setSeenMessageIds((previous) => (previous.public ? previous : { ...previous, public: publicLastId }));
          }
        }
      }
    } catch {
      // Socket.IO retries the connection and fetches again on reconnect.
    }
  }, []);

  const markSeen = useCallback((conversationId: string, lastMessageId?: string) => {
    if (!lastMessageId) return;
    setSeenMessageIds((previous) => (
      previous[conversationId] === lastMessageId ? previous : { ...previous, [conversationId]: lastMessageId }
    ));
    if (!checkedInRef.current || conversationId === 'public' || document.visibilityState !== 'visible') return;
    if (sentSeenRef.current[conversationId] === lastMessageId) return;
    sentSeenRef.current[conversationId] = lastMessageId;
    void api(`/api/chat/${conversationId}/seen`, {
      method: 'POST',
      body: JSON.stringify({ messageId: lastMessageId }),
    }).catch(() => {
      if (sentSeenRef.current[conversationId] === lastMessageId) {
        delete sentSeenRef.current[conversationId];
      }
    });
  }, []);

  const sendTyping = useCallback((conversationId: string, typing: boolean) => {
    socketRef.current?.emit('chat:typing', { conversationId, typing });
  }, []);

  const sendCaroEmoji = useCallback((caroGameId: string, emoji: CaroEmoji) => {
    socketRef.current?.emit('caro:emoji', { gameId: caroGameId, emoji });
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((current) => {
      const next = !current;
      saveSoundEnabled(next);
      if (next) {
        unlockAudio();
        playMessageSound(true);
      }
      return next;
    });
  }, []);

  const hasVenue = Boolean(venue);
  useEffect(() => {
    if (!hasVenue) return;
    const socket = io();
    socketRef.current = socket;

    const clearTypingEntry = (conversationId: string, userId: string) => {
      const key = `${conversationId}:${userId}`;
      const existing = typingTimers.current.get(key);
      if (existing) {
        clearTimeout(existing);
        typingTimers.current.delete(key);
      }
      setTypingByRoom((previous) => {
        const room = previous[conversationId];
        if (!room || !(userId in room)) return previous;
        const { [userId]: _removed, ...rest } = room;
        if (Object.keys(rest).length === 0) {
          const { [conversationId]: _empty, ...nextRooms } = previous;
          return nextRooms;
        }
        return { ...previous, [conversationId]: rest };
      });
    };

    socket.on('connect', () => {
      void api<VenueState>('/api/venue').then((next) => {
        setVenue((previous) => {
          if (!previous) return next;
          const layout = next.layout.version >= previous.layout.version ? next.layout : previous.layout;
          const seatIsCurrent = layout.tables.some((table) => table.id === next.tableId);
          return { ...previous, layout, tableId: seatIsCurrent ? next.tableId : null, profile: next.profile ?? previous.profile };
        });
      }).catch(() => {});
      void reloadSocial();
    });
    socket.on('disconnect', () => {
      for (const timer of typingTimers.current.values()) clearTimeout(timer);
      typingTimers.current.clear();
      setTypingByRoom({});
    });
    socket.on('venue:activity', (activity: VenueActivity) => {
      setVenue((previous) => previous && { ...previous, ...activity });
    });
    socket.on('venue:profile', (next: TableCharacter) => {
      setVenue((previous) => previous && { ...previous, profile: next });
      void reloadSocial();
    });
    socket.on('venue:layout', (layout: Layout) => {
      setVenue((previous) => previous && {
        ...previous, layout,
        tableId: layout.tables.some((table) => table.id === previous.tableId) ? previous.tableId : null,
      });
    });
    socket.on('venue:session', ({ tableId }: Pick<VenueState, 'tableId'>) => {
      setVenue((previous) => previous && { ...previous, tableId });
      void reloadSocial();
    });
    socket.on('social:changed', () => void reloadSocial());
    socket.on('caro:emoji', (event: CaroEmojiEvent) => {
      if (!event?.gameId || !event.emoji) return;
      setIncomingCaroEmoji({ ...event, seq: ++caroEmojiSeq.current });
    });
    socket.on('chat:typing', (event: ChatTypingEvent) => {
      if (!event?.conversationId || !event.userId || event.userId === selfIdRef.current) return;
      if (!event.typing) {
        clearTypingEntry(event.conversationId, event.userId);
        return;
      }
      const key = `${event.conversationId}:${event.userId}`;
      const existing = typingTimers.current.get(key);
      if (existing) clearTimeout(existing);
      typingTimers.current.set(key, setTimeout(() => clearTypingEntry(event.conversationId, event.userId), 5000));
      setTypingByRoom((previous) => ({
        ...previous,
        [event.conversationId]: {
          ...previous[event.conversationId],
          [event.userId]: event.displayName,
        },
      }));
    });
    return () => {
      for (const timer of typingTimers.current.values()) clearTimeout(timer);
      typingTimers.current.clear();
      socketRef.current = null;
      socket.disconnect();
    };
  }, [hasVenue, reloadSocial]);

  function openCharacter() {
    setInspectId(undefined);
    setEditingCharacter(true);
  }

  function closeCharacter() {
    setEditingCharacter(false);
    setOnboardingDismissed(true);
  }

  async function saveCharacter(nextProfile: GuestProfile) {
    const response = await api<VenueState>('/api/guest/profile', {
      method: 'PUT', body: JSON.stringify(nextProfile),
    });
    setVenue((previous) => previous && previous.layout.version > response.layout.version
      ? { ...previous, profile: response.profile }
      : response);
    closeCharacter();
    setNotice('');
    void reloadSocial();
  }

  async function socialAction(path: string, body: object) {
    if (busy) return false;
    setBusy(true);
    setNotice('');
    try {
      const next = await api<SocialState>(path, { method: 'POST', body: JSON.stringify(body) });
      socialRevision.current += 1;
      setSocial(next);
      void reloadSocial();
      return true;
    } catch (error) {
      setNotice(messageOf(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function chatAction(path: string, body: object): Promise<string | null> {
    if (busy) return null;
    setBusy(true);
    setNotice('');
    try {
      const { conversationId, ...next } = await api<ChatResponse>(path, { method: 'POST', body: JSON.stringify(body) });
      socialRevision.current += 1;
      setSocial(next);
      void reloadSocial();
      return conversationId;
    } catch (error) {
      setNotice(messageOf(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function selectTab(next: Tab) {
    setTab(next);
    setNotice('');
    setInspectId(undefined);
    if (next === 'chat' || next === 'caro') void reloadSocial();
  }

  function labelOf(id: string) {
    return tables.find((table) => table.id === id)?.label ?? 'đã rời sơ đồ';
  }

  function floorOf(id: string): FloorId | undefined {
    return tables.find((table) => table.id === id)?.floor;
  }

  function startDirectChat(person: TableCharacter, targetTableId: string) {
    selectTab('chat');
    const existing = social.conversations.find((item) =>
      item.kind === 'direct' && item.members.some((member) => member.id === person.id),
    );
    if (existing) {
      setTarget({ kind: 'conversation', conversationId: existing.id });
    } else {
      setTarget({ kind: 'direct', recipientId: person.id, recipientName: person.displayName, tableId: targetTableId });
    }
  }

  function startGroupWithPeople(memberIds: string[]) {
    selectTab('chat');
    setTarget(undefined);
    setGroupDraftMemberIds(memberIds);
  }

  async function inviteTable(tableId: string) {
    selectTab('caro');
    await socialAction('/api/caro/invite', { tableId });
  }

  async function invitePerson(recipientId: string, openCaroTab = false) {
    if (openCaroTab) selectTab('caro');
    return socialAction('/api/caro/invite', { recipientId });
  }

  async function rematchCaro(targetGameId: string): Promise<string | null> {
    if (busy) return null;
    setBusy(true);
    setNotice('');
    try {
      const { gameId: nextId, ...next } = await api<RematchResponse>(`/api/caro/games/${targetGameId}/rematch`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      socialRevision.current += 1;
      setSocial(next);
      void reloadSocial();
      return nextId;
    } catch (error) {
      setNotice(messageOf(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="guest-shell">
      {tab === 'map' && <header className="guest-header">
        <button className="guest-brand" aria-label="XConnect, về sơ đồ" onClick={() => selectTab('map')}>
          <img src="/art/xconnect.webp" alt="XConnect" />
        </button>
        {current && <button className="guest-seat" type="button" onClick={openCharacter}
          aria-label={profile ? `Chỉnh nhân vật, bàn ${current.label}` : undefined}>
          <span className="guest-seat__pin" aria-hidden="true" />
          <span className="guest-seat__label">{profile ? `Bàn ${current.label}` : 'Tạo nhân vật'}</span>
        </button>}
      </header>}

      <main className={`guest-main guest-main--${tab}`}>
        {notice && <div className="guest-notice" role="status">
          <span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Đóng thông báo">×</button>
        </div>}
        {tab === 'map' && (venue ? (
          <MapView floor={floor} tables={floorTables} currentTableId={checkedIn ? tableId : null} presence={venue.presence}
            characters={characters} selfCharacterId={profile?.id} onTableClick={setInspectId}
            onFloorChange={(next) => { setFloor(next); setInspectId(undefined); }} />
        ) : (
          <div className="guest-map-loading">
            <img src="/art/cafe.webp" alt="" />
            <div>{notice ? <button className="btn btn--green" onClick={() => { setNotice(''); setLoadAttempt(loadAttempt + 1); }}>Tải lại sơ đồ</button> : <p role="status">Đang mở sơ đồ…</p>}</div>
          </div>
        ))}

        {tab === 'chat' && <ChatPanel
          publicChat={social.publicChat}
          conversations={social.conversations}
          onlinePeople={onlinePeople}
          selfId={profile?.id}
          checkedIn={checkedIn}
          hasSeat={Boolean(tableId)}
          joinHint={joinHint}
          target={target}
          onSelectTarget={setTarget}
          labelOf={labelOf}
          floorOf={floorOf}
          busy={busy}
          unreadIds={unreadIds}
          typingByRoom={typingByRoom}
          soundEnabled={soundEnabled}
          onToggleSound={toggleSound}
          onTyping={sendTyping}
          onMarkSeen={markSeen}
          onOpenCharacter={openCharacter}
          onSend={(payload) => chatAction('/api/chat', payload)}
          onCreateGroup={(name, memberIds) => chatAction('/api/chat/groups', { name, memberIds })}
          onAddGroupMembers={(conversationId, memberIds) => socialAction(`/api/chat/groups/${conversationId}/members`, { memberIds })}
          onLeaveGroup={(conversationId) => socialAction(`/api/chat/groups/${conversationId}/leave`, {})}
          groupDraftMemberIds={groupDraftMemberIds}
          onClearGroupDraft={() => setGroupDraftMemberIds(undefined)}
        />}

        {tab === 'caro' && <CaroPanel
          invites={social.invites}
          games={social.games}
          onlinePeople={onlinePeople}
          checkedIn={checkedIn}
          hasSeat={Boolean(tableId)}
          joinHint={joinHint}
          selectedGameId={gameId}
          onSelectGameId={setGameId}
          labelOf={labelOf}
          busy={busy}
          soundEnabled={soundEnabled}
          onToggleSound={toggleSound}
          onOpenCharacter={openCharacter}
          onInvitePerson={(recipientId) => invitePerson(recipientId)}
          onAnswerInvite={async (inviteId, accept) => {
            const ok = await socialAction(`/api/caro/invites/${inviteId}`, { accept });
            if (ok && accept) setGameId(undefined);
            return ok;
          }}
          onMove={(targetGameId, index) => socialAction(`/api/caro/games/${targetGameId}/move`, { index })}
          onResign={(targetGameId) => socialAction(`/api/caro/games/${targetGameId}/resign`, {})}
          onDrawAction={(targetGameId, action) => socialAction(`/api/caro/games/${targetGameId}/draw`, { action })}
          onRematch={rematchCaro}
          onSendEmoji={sendCaroEmoji}
          incomingEmoji={incomingCaroEmoji}
        />}

        {tab === 'puzzle' && <PuzzlePanel
          soundEnabled={soundEnabled}
          onToggleSound={toggleSound}
        />}

        {tab === 'journal' && <JournalPanel
          currentSeat={current ? { id: current.id, label: current.label, floor: current.floor } : null}
        />}
      </main>

      <nav className="guest-nav" aria-label="Điều hướng chính">
        {tabs.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined}
          className="guest-nav__tab" onClick={() => selectTab(item.id)}>
          <span className="guest-nav__sprite"><img src={`/art/${item.id}.webp`} alt="" width="45" height="45" />
            {item.id === 'chat' && unreadChats > 0 && <span className="guest-nav__count" aria-label={`${unreadChats} tin nhắn mới`}>{unreadChats}</span>}
            {item.id === 'caro' && caroBadgeCount > 0 && <span className="guest-nav__count" aria-label={`${caroBadgeCount} thông báo caro`}>{caroBadgeCount}</span>}
          </span>
          <span>{item.title}</span>
        </button>)}
      </nav>

      {inspecting && !showCharacterDialog && <TableDialog table={inspecting} current={inspecting.id === current?.id} checkedIn={checkedIn}
        online={venue?.presence[inspecting.id] ?? 0} people={characters?.[inspecting.id] ?? []} selfId={profile?.id}
        joinHint={joinHint} close={() => setInspectId(undefined)} edit={openCharacter}
        chatPerson={(person) => startDirectChat(person, inspecting.id)}
        createGroup={(memberIds) => startGroupWithPeople(memberIds)}
        invite={() => {
          const others = (characters?.[inspecting.id] ?? []).filter((person) => person.id !== profile?.id);
          if (others.length === 1) void invitePerson(others[0].id, true);
          else void inviteTable(inspecting.id);
        }} />}
      {showCharacterDialog && <CharacterDialog profile={profile} onSave={saveCharacter} onClose={closeCharacter} />}
    </div>
  );
}

function TableDialog({ table, current, checkedIn, online, people, selfId, joinHint, close, edit, chatPerson, createGroup, invite }: {
  table: TableLayout; current: boolean; checkedIn: boolean; online: number;
  people: TableCharacter[]; selfId?: string; joinHint: string;
  close: () => void; edit: () => void;
  chatPerson: (person: TableCharacter) => void;
  createGroup: (memberIds: string[]) => void;
  invite: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const otherPeople = people.filter((person) => person.id !== selfId);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);
  return <dialog ref={dialog} className="table-dialog" aria-labelledby="table-dialog-title" onCancel={close}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="table-dialog__body">
      <button className="table-dialog__close" type="button" aria-label="Đóng" onClick={close}>×</button>
      <h2 id="table-dialog-title">Bàn {table.label}</h2>
      <p>Tầng {table.floor} · {current && checkedIn ? 'Bạn đang ở đây' : online ? `${online} khách đang online` : 'Bàn này chưa có khách online.'}</p>
      {people.length > 0 && <ul className="table-dialog__characters" aria-label="Khách tại bàn">
        {people.map((person) => <li key={person.id}>
          <CharacterSprite model={person.model} outfit={person.outfit} />
          <span className="table-dialog__person-name">{person.displayName}{person.id === selfId && <small> · Bạn</small>}</span>
          {checkedIn && person.id !== selfId && (
            <button className="table-dialog__dm" type="button" onClick={() => chatPerson(person)}>Nhắn 1v1</button>
          )}
        </li>)}
      </ul>}
      {current && <div className="table-dialog__actions">
        <button className="btn btn--green" type="button" onClick={edit}>{checkedIn ? 'Chỉnh nhân vật' : 'Tạo nhân vật'}</button>
      </div>}
      {checkedIn && !current && otherPeople.length > 0 && <div className="table-dialog__actions">
        {otherPeople.length === 1 ? (
          <button className="btn btn--green" type="button" onClick={() => chatPerson(otherPeople[0])}><img src="/art/chat.webp" alt="" />Nhắn 1v1</button>
        ) : (
          <button className="btn btn--green" type="button" onClick={() => createGroup(otherPeople.map((person) => person.id))}><img src="/art/chat.webp" alt="" />Tạo nhóm với bàn</button>
        )}
        <button className="btn" type="button" onClick={invite}><img src="/art/caro.webp" alt="" />Mời chơi caro</button>
      </div>}
      {!checkedIn && !current && <p>{joinHint}</p>}
    </div>
  </dialog>;
}
