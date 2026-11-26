import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CharacterSprite } from './CharacterSprite';
import type { ChatKind, Conversation, FloorId, TableCharacter } from './shared';
import './chat-panel.css';

export type OnlinePerson = TableCharacter & {
  tableId: string;
  tableLabel: string;
  floor: FloorId;
};

export type ChatTarget =
  | { kind: 'public' }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'direct'; recipientId: string; recipientName: string; tableId: string };

const timeFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0].toUpperCase() : '?';
}

function formatTyping(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} đang nhập…`;
  if (names.length === 2) return `${names[0]}, ${names[1]} đang nhập…`;
  return `${names.length} người đang nhập…`;
}

function RoomIcon({ kind, small = false }: { kind: 'public' | 'group'; small?: boolean }) {
  return (
    <span className={`chat-room-badge${small ? ' chat-room-badge--sm' : ''}`} data-kind={kind} aria-hidden="true">
      {kind === 'public' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 10h11v4a5 5 0 0 1-5 5H9a4 4 0 0 1-4-4v-5Z" />
          <path d="M16 11h2a2.5 2.5 0 0 1 0 5h-2" />
          <path d="M8.5 6.5c0-1 .8-1.5.8-2.5M12 6.5c0-1 .8-1.5.8-2.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 19v-1a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v1" />
          <circle cx="10" cy="8.5" r="3" />
          <path d="M20 19v-1a3 3 0 0 0-2.2-2.9" />
          <path d="M15.2 5.6a3 3 0 0 1 0 5.8" />
        </svg>
      )}
    </span>
  );
}

function PersonAvatar({
  name,
  person,
  online,
  small = false,
}: {
  name: string;
  person?: TableCharacter;
  online?: boolean;
  small?: boolean;
}) {
  return (
    <span className={`chat-avatar${small ? ' chat-avatar--sm' : ''}`} aria-hidden="true">
      {person ? (
        <span className="chat-avatar__sprite">
          <CharacterSprite model={person.model} outfit={person.outfit} />
        </span>
      ) : (
        initialOf(name)
      )}
      {online !== undefined && (
        <span className={`chat-avatar__status${online ? '' : ' chat-avatar__status--off'}`} />
      )}
    </span>
  );
}

export function ChatPanel({
  publicChat,
  conversations,
  onlinePeople,
  selfId,
  checkedIn,
  hasSeat,
  joinHint,
  target,
  onSelectTarget,
  labelOf,
  floorOf,
  busy,
  unreadIds,
  typingByRoom,
  soundEnabled,
  onToggleSound,
  onTyping,
  onMarkSeen,
  onOpenCharacter,
  onSend,
  onCreateGroup,
  onAddGroupMembers,
  onLeaveGroup,
  groupDraftMemberIds,
  onClearGroupDraft,
}: {
  publicChat: Conversation;
  conversations: Conversation[];
  onlinePeople: OnlinePerson[];
  selfId?: string;
  checkedIn: boolean;
  hasSeat: boolean;
  joinHint: string;
  target?: ChatTarget;
  onSelectTarget: (next?: ChatTarget) => void;
  labelOf: (tableId: string) => string;
  floorOf: (tableId: string) => FloorId | undefined;
  busy: boolean;
  unreadIds: Set<string>;
  typingByRoom: Record<string, Record<string, string>>;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onTyping: (conversationId: string, typing: boolean) => void;
  onMarkSeen: (conversationId: string, lastMessageId?: string) => void;
  onOpenCharacter: () => void;
  onSend: (payload: { conversationId?: string; recipientId?: string; text: string }) => Promise<string | null>;
  onCreateGroup: (name: string, memberIds: string[]) => Promise<string | null>;
  onAddGroupMembers: (conversationId: string, memberIds: string[]) => Promise<boolean>;
  onLeaveGroup: (conversationId: string) => Promise<boolean>;
  groupDraftMemberIds?: string[];
  onClearGroupDraft: () => void;
}) {
  const [text, setText] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [addMembersOpen, setAddMembersOpen] = useState(false);
  const feedEnd = useRef<HTMLSpanElement>(null);
  const typingRoomRef = useRef<string | null>(null);
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentAt = useRef(0);

  const onlineById = new Map(onlinePeople.map((person) => [person.id, person]));

  const stopTypingNow = () => {
    if (typingStopTimer.current) {
      clearTimeout(typingStopTimer.current);
      typingStopTimer.current = null;
    }
    if (typingRoomRef.current) {
      onTyping(typingRoomRef.current, false);
      typingRoomRef.current = null;
    }
    lastTypingSentAt.current = 0;
  };

  useEffect(() => {
    if (groupDraftMemberIds && groupDraftMemberIds.length > 0 && checkedIn) {
      setCreateGroupOpen(true);
    }
  }, [groupDraftMemberIds, checkedIn]);

  const activeConversation: Conversation | undefined = !target ? undefined
    : target.kind === 'public' ? publicChat
    : target.kind === 'conversation' ? conversations.find((item) => item.id === target.conversationId)
    : conversations.find((item) => item.kind === 'direct' && item.members.some((member) => member.id === target.recipientId));

  const targetKey = !target ? ''
    : target.kind === 'public' ? 'public'
    : target.kind === 'conversation' ? target.conversationId
    : `direct:${target.recipientId}`;

  useEffect(() => {
    setText('');
    setShowMembers(false);
    stopTypingNow();
    return () => stopTypingNow();
  }, [targetKey]);

  const lastMessageId = activeConversation?.messages.at(-1)?.id;
  useEffect(() => {
    if (!activeConversation) return;
    onMarkSeen(activeConversation.id, lastMessageId);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        onMarkSeen(activeConversation.id, lastMessageId);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [activeConversation?.id, lastMessageId, onMarkSeen]);

  const activeTypingNames = activeConversation
    ? Object.values(typingByRoom[activeConversation.id] ?? {})
    : [];

  useEffect(() => {
    if (feedEnd.current?.parentElement) {
      feedEnd.current.parentElement.scrollTop = feedEnd.current.parentElement.scrollHeight;
    }
  }, [activeConversation?.messages.length, activeTypingNames.length, targetKey]);

  function handleTextChange(nextValue: string) {
    setText(nextValue);
    if (!checkedIn || !activeConversation) return;
    if (!nextValue.trim()) {
      stopTypingNow();
      return;
    }
    const now = Date.now();
    const roomId = activeConversation.id;
    if (typingRoomRef.current !== roomId || now - lastTypingSentAt.current > 1800) {
      if (typingRoomRef.current && typingRoomRef.current !== roomId) {
        onTyping(typingRoomRef.current, false);
      }
      typingRoomRef.current = roomId;
      lastTypingSentAt.current = now;
      onTyping(roomId, true);
    }
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    typingStopTimer.current = setTimeout(() => stopTypingNow(), 2200);
  }

  function openDirect(recipientId: string, recipientName: string, tableId: string) {
    if (!checkedIn || recipientId === selfId) return;
    const existing = conversations.find((item) =>
      item.kind === 'direct' && item.members.some((member) => member.id === recipientId),
    );
    if (existing) {
      onSelectTarget({ kind: 'conversation', conversationId: existing.id });
    } else {
      onSelectTarget({ kind: 'direct', recipientId, recipientName, tableId });
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value || !target || !checkedIn) return;
    const payload = target.kind === 'public'
      ? { conversationId: 'public', text: value }
      : activeConversation
        ? { conversationId: activeConversation.id, text: value }
        : target.kind === 'direct'
          ? { recipientId: target.recipientId, text: value }
          : null;
    if (!payload) return;

    const id = await onSend(payload);
    if (id) {
      stopTypingNow();
      setText('');
      if (target.kind === 'direct') {
        onSelectTarget({ kind: 'conversation', conversationId: id });
      }
    }
  }

  /* ── Active Thread ── */
  if (target) {
    const kind: ChatKind = target.kind === 'public'
      ? 'public'
      : activeConversation?.kind ?? 'direct';
    const title = target.kind === 'public'
      ? 'Cả quán'
      : activeConversation?.name ?? (target.kind === 'direct' ? target.recipientName : 'Trò chuyện');
    const peer = kind === 'direct'
      ? activeConversation?.members.find((member) => member.id !== selfId)
      : undefined;
    const peerId = peer?.id ?? (target.kind === 'direct' ? target.recipientId : undefined);
    const peerOnline = peer ? peer.online : true;
    const peerTableId = peer?.tableId ?? (target.kind === 'direct' ? target.tableId : undefined);
    const peerFloor = peerTableId ? floorOf(peerTableId) : undefined;
    const messages = activeConversation?.messages ?? [];
    const messageIndexById = new Map(messages.map((msg, idx) => [msg.id, idx]));
    let lastMineIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].mine) {
        lastMineIndex = i;
        break;
      }
    }
    const seenReaders = kind !== 'public' && lastMineIndex >= 0
      ? (activeConversation?.receipts ?? []).filter((receipt) => {
          const seenIdx = messageIndexById.get(receipt.messageId);
          return seenIdx !== undefined && seenIdx >= lastMineIndex;
        })
      : [];
    const receiptText = kind === 'public' || lastMineIndex < 0 ? ''
      : seenReaders.length === 0 ? 'Đã gửi'
      : kind === 'direct' ? 'Đã xem'
      : seenReaders.length === 1 ? `Đã xem · ${seenReaders[0].displayName}`
      : seenReaders.length === 2 ? `Đã xem · ${seenReaders[0].displayName}, ${seenReaders[1].displayName}`
      : `Đã xem · ${seenReaders.length} người`;

    const existingMemberIds = new Set((activeConversation?.members ?? []).map((member) => member.id));
    const addablePeople = onlinePeople.filter((person) => !existingMemberIds.has(person.id));

    return (
      <section className="chat-panel" aria-labelledby="chat-thread-title">
        <div className="chat-thread">
          <div className="chat-thread__head">
            <button type="button" className="chat-back" onClick={() => onSelectTarget(undefined)} aria-label="Quay lại">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            {kind === 'direct' ? (
              <PersonAvatar name={title} person={peerId ? onlineById.get(peerId) : undefined} online={peerOnline} small />
            ) : (
              <RoomIcon kind={kind} small />
            )}
            <div className="chat-thread__meta">
              <strong id="chat-thread-title">{title}</strong>
              {kind === 'public' ? (
                <span className="chat-thread__status chat-thread__status--live">
                  <span className="chat-live-dot" aria-hidden="true" />
                  {publicChat.members.length} đang online
                </span>
              ) : kind === 'group' ? (
                <span className="chat-thread__status">
                  {activeConversation?.members.length ?? 0} thành viên
                </span>
              ) : (
                <span className={`chat-thread__status${peerOnline ? ' chat-thread__status--live' : ''}`}>
                  <span className={`chat-live-dot${peerOnline ? '' : ' chat-live-dot--off'}`} aria-hidden="true" />
                  {peerTableId ? `B${labelOf(peerTableId)}${peerFloor ? ` · T${peerFloor}` : ''}` : ''}{peerOnline ? ' · Online' : ' · Ngoại tuyến'}
                </span>
              )}
            </div>
            {kind === 'group' && activeConversation && (
              <button type="button" className="chat-icon-btn" aria-label="Thành viên nhóm" aria-expanded={showMembers}
                onClick={() => setShowMembers((open) => !open)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 19v-1a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v1" />
                  <circle cx="10" cy="8.5" r="3" />
                  <path d="M20 19v-1a3 3 0 0 0-2.2-2.9" />
                  <path d="M15.2 5.6a3 3 0 0 1 0 5.8" />
                </svg>
              </button>
            )}
          </div>

          {kind === 'group' && activeConversation && showMembers && (
            <div className="chat-members" aria-label="Thành viên nhóm">
              <ul className="chat-members__list">
                {activeConversation.members.map((member) => (
                  <li key={member.id} className="chat-members__item">
                    <div className="chat-members__who">
                      <span className={`chat-live-dot${member.online ? '' : ' chat-live-dot--off'}`} aria-hidden="true" />
                      <span>{member.displayName}{member.id === selfId ? ' (Bạn)' : ''}</span>
                      <small>B{labelOf(member.tableId)}</small>
                    </div>
                    {checkedIn && member.id !== selfId && (
                      <button type="button" className="chat-members__dm"
                        onClick={() => openDirect(member.id, member.displayName, member.tableId)}>
                        1v1
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="chat-members__actions">
                <button type="button" className="btn btn--green" disabled={busy || !addablePeople.length}
                  onClick={() => setAddMembersOpen(true)}>
                  + Thêm người
                </button>
                <button type="button" className="btn btn--danger" disabled={busy}
                  onClick={async () => {
                    if (await onLeaveGroup(activeConversation.id)) {
                      onSelectTarget(undefined);
                    }
                  }}>
                  Rời nhóm
                </button>
              </div>
            </div>
          )}

          <div className="chat-feed" role="log" aria-label="Tin nhắn">
            {messages.length === 0 && (
              <p className="chat-feed__empty">Chưa có tin nhắn nào</p>
            )}
            {messages.map((message, index) => (
              <div key={message.id} className={`chat-msg${message.mine ? ' chat-msg--mine' : ''}`}>
                {!message.mine && (
                  <div className="chat-msg__sender">
                    {kind !== 'direct' && checkedIn && message.authorId !== selfId ? (
                      <button type="button" className="chat-msg__sender-btn"
                        onClick={() => openDirect(message.authorId, message.authorName, message.tableId)}>
                        {message.authorName}
                      </button>
                    ) : (
                      <strong>{message.authorName}</strong>
                    )}
                    <span>· B{labelOf(message.tableId)}</span>
                  </div>
                )}
                <div className="chat-msg__bubble">{message.text}</div>
                <div className="chat-msg__meta">
                  <time className="chat-msg__time" dateTime={message.createdAt}>
                    {timeFormat.format(new Date(message.createdAt))}
                  </time>
                  {message.mine && index === lastMineIndex && receiptText && (
                    <span className={`chat-msg__receipt${seenReaders.length > 0 ? ' chat-msg__receipt--seen' : ''}`}>
                      · {seenReaders.length > 0 ? '✓✓' : '✓'} {receiptText}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {activeTypingNames.length > 0 && (
              <div className="chat-typing" role="status" aria-live="polite">
                <span className="chat-typing__dots" aria-hidden="true"><i /><i /><i /></span>
                <span>{formatTyping(activeTypingNames)}</span>
              </div>
            )}
            <span ref={feedEnd} />
          </div>

          <div className="chat-compose">
            {checkedIn ? (
              <>
                <form className="chat-compose__form" onSubmit={submitMessage}>
                  <input value={text} onChange={(event) => handleTextChange(event.target.value)}
                    placeholder="Nhắn tin…" aria-label="Nội dung tin nhắn" maxLength={500} />
                  <button type="submit" className="chat-compose__send" aria-label="Gửi" disabled={busy || !text.trim()}>
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M3.4 20.4 21 12 3.4 3.6 3 10l12 2-12 2 .4 6.4Z" />
                    </svg>
                  </button>
                </form>
                {text.length >= 400 && <span className="chat-compose__counter">{text.length}/500</span>}
              </>
            ) : (
              <div className="chat-compose__gate">
                <span>{joinHint}</span>
                {hasSeat && (
                  <button type="button" className="chat-gate-strip__btn" onClick={onOpenCharacter}>Tạo nhân vật</button>
                )}
              </div>
            )}
          </div>
        </div>

        {addMembersOpen && activeConversation && (
          <MemberPickerDialog
            title="Thêm thành viên"
            submitLabel="Thêm"
            people={addablePeople}
            busy={busy}
            onClose={() => setAddMembersOpen(false)}
            onSubmit={async (_name, memberIds) => {
              const ok = await onAddGroupMembers(activeConversation.id, memberIds);
              if (ok) setAddMembersOpen(false);
            }}
          />
        )}
      </section>
    );
  }

  /* ── Chat List View ── */
  const publicLast = publicChat.messages.at(-1);
  const publicUnread = unreadIds.has('public');
  const publicTyping = Object.values(typingByRoom.public ?? {});

  return (
    <section className="chat-panel" aria-labelledby="chat-title">
      <div className="chat-list-head">
        <h1 id="chat-title" className="chat-list-head__brand">
          <img src="/art/xconnect.webp" alt="XConnect" />
        </h1>
        <div className="chat-list-head__actions">
          <button type="button" className={`chat-icon-btn${soundEnabled ? '' : ' chat-icon-btn--muted'}`}
            title={soundEnabled ? 'Tắt âm thông báo' : 'Bật âm thông báo'}
            aria-label={soundEnabled ? 'Tắt âm thông báo' : 'Bật âm thông báo'}
            aria-pressed={soundEnabled}
            onClick={onToggleSound}>
            {soundEnabled ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M19 5.5a9.5 9.5 0 0 1 0 13" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="22" y1="9" x2="16" y2="15" />
                <line x1="16" y1="9" x2="22" y2="15" />
              </svg>
            )}
          </button>
          {checkedIn && (
            <button type="button" className="chat-icon-btn" title="Tạo nhóm mới" aria-label="Tạo nhóm mới"
              disabled={busy} onClick={() => setCreateGroupOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="3.5" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="16" y1="11" x2="22" y2="11" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="chat-list-scroll">
        {checkedIn && onlinePeople.length > 0 && (
          <>
            <div className="chat-online-row" role="list" aria-label="Khách đang online">
              {onlinePeople.map((person) => (
                <button key={person.id} type="button" className="chat-online-person" role="listitem"
                  title={`${person.displayName} · Bàn ${person.tableLabel}`}
                  onClick={() => openDirect(person.id, person.displayName, person.tableId)}>
                  <PersonAvatar name={person.displayName} person={person} online />
                  <span className="chat-online-person__name">{person.displayName}</span>
                </button>
              ))}
            </div>
            <hr className="chat-divider" />
          </>
        )}

        <ul className="chat-rooms">
          <li>
            <button type="button" className={`chat-row${publicUnread ? ' chat-row--unread' : ''}`}
              onClick={() => onSelectTarget({ kind: 'public' })}>
              <RoomIcon kind="public" />
              <span className="chat-row__body">
                <span className="chat-row__top">
                  <span className="chat-row__name chat-row__name--public">
                    Cả quán <span className="chat-row__sub">· {publicChat.members.length} online</span>
                  </span>
                  {publicLast && (
                    <time className="chat-row__time" dateTime={publicLast.createdAt}>
                      {timeFormat.format(new Date(publicLast.createdAt))}
                    </time>
                  )}
                </span>
                {publicTyping.length > 0 ? (
                  <span className="chat-row__typing">{formatTyping(publicTyping)}</span>
                ) : (
                  <span className="chat-row__preview">
                    {publicLast ? `${publicLast.mine ? 'Bạn' : publicLast.authorName}: ${publicLast.text}` : 'Trò chuyện cùng mọi người trong quán'}
                  </span>
                )}
              </span>
              {publicUnread && <span className="chat-row__dot" aria-label="Tin nhắn mới" />}
            </button>
          </li>

          {checkedIn && conversations.map((conversation) => {
            const last = conversation.messages.at(-1);
            const unread = unreadIds.has(conversation.id);
            const roomTyping = Object.values(typingByRoom[conversation.id] ?? {});
            const peer = conversation.kind === 'direct'
              ? conversation.members.find((member) => member.id !== selfId)
              : undefined;
            const livePeer = peer ? onlineById.get(peer.id) : undefined;
            return (
              <li key={conversation.id}>
                <button type="button" className={`chat-row${unread ? ' chat-row--unread' : ''}`}
                  onClick={() => onSelectTarget({ kind: 'conversation', conversationId: conversation.id })}>
                  {conversation.kind === 'direct' ? (
                    <PersonAvatar name={conversation.name} person={livePeer} online={peer?.online} />
                  ) : (
                    <RoomIcon kind="group" />
                  )}
                  <span className="chat-row__body">
                    <span className="chat-row__top">
                      <span className="chat-row__name">
                        {conversation.name}
                        <span className="chat-row__sub">
                          {conversation.kind === 'group'
                            ? ` · ${conversation.members.length}`
                            : conversation.tableId ? ` · B${labelOf(conversation.tableId)}` : ''}
                        </span>
                      </span>
                      <time className="chat-row__time" dateTime={last?.createdAt ?? conversation.updatedAt}>
                        {timeFormat.format(new Date(last?.createdAt ?? conversation.updatedAt))}
                      </time>
                    </span>
                    {roomTyping.length > 0 ? (
                      <span className="chat-row__typing">{formatTyping(roomTyping)}</span>
                    ) : (
                      <span className="chat-row__preview">
                        {last
                          ? `${last.mine ? 'Bạn' : last.authorName}: ${last.text}`
                          : conversation.kind === 'group' ? 'Nhóm mới tạo' : 'Bắt đầu trò chuyện'}
                      </span>
                    )}
                  </span>
                  {unread && <span className="chat-row__dot" aria-label="Tin nhắn mới" />}
                </button>
              </li>
            );
          })}
        </ul>

        {!checkedIn && (
          <div className="chat-gate-strip">
            <span>{joinHint}</span>
            {hasSeat && (
              <button type="button" className="chat-gate-strip__btn" onClick={onOpenCharacter}>Tạo nhân vật</button>
            )}
          </div>
        )}
      </div>

      {createGroupOpen && (
        <MemberPickerDialog
          title="Nhóm mới"
          submitLabel="Tạo"
          requireName
          people={onlinePeople}
          initialSelected={groupDraftMemberIds}
          busy={busy}
          onClose={() => {
            setCreateGroupOpen(false);
            onClearGroupDraft();
          }}
          onSubmit={async (name, memberIds) => {
            const id = await onCreateGroup(name, memberIds);
            if (id) {
              setCreateGroupOpen(false);
              onClearGroupDraft();
              onSelectTarget({ kind: 'conversation', conversationId: id });
            }
          }}
        />
      )}
    </section>
  );
}

function MemberPickerDialog({
  title,
  submitLabel,
  requireName = false,
  people,
  initialSelected,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  requireName?: boolean;
  people: OnlinePerson[];
  initialSelected?: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, memberIds: string[]) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>(() =>
    (initialSelected ?? []).filter((id) => people.some((person) => person.id === id)),
  );
  const [error, setError] = useState('');

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); };
  }, []);

  function toggle(id: string) {
    setError('');
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim();
    if (requireName && !cleanName) {
      setError('Hãy nhập tên nhóm.');
      return;
    }
    if (selected.length < 1) {
      setError('Chọn ít nhất 1 khách đang online.');
      return;
    }
    setError('');
    await onSubmit(cleanName, selected);
  }

  return (
    <dialog ref={dialog} className="chat-dialog" aria-labelledby="chat-dialog-title" onCancel={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="chat-dialog__body" onSubmit={handleSubmit}>
        <div className="chat-dialog__head">
          <h2 id="chat-dialog-title">{title}</h2>
          <button className="chat-dialog__close" type="button" aria-label="Đóng" onClick={onClose}>×</button>
        </div>

        {requireName && (
          <input className="chat-dialog__input" value={name}
            onChange={(event) => { setName(event.target.value); setError(''); }}
            placeholder="Tên nhóm…" aria-label="Tên nhóm" maxLength={40} required autoFocus />
        )}

        {people.length > 0 ? (
          <ul className="chat-dialog__list">
            {people.map((person) => (
              <li key={person.id}>
                <label className="chat-dialog__member">
                  <span className="chat-dialog__member-left">
                    <PersonAvatar name={person.displayName} person={person} online small />
                    <span>{person.displayName} <small>· B{person.tableLabel}</small></span>
                  </span>
                  <input type="checkbox" checked={selected.includes(person.id)} onChange={() => toggle(person.id)} />
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="chat-dialog__empty">Chưa có khách khác đang online.</p>
        )}

        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="chat-dialog__actions">
          <button type="button" className="btn" onClick={onClose}>Hủy</button>
          <button type="submit" className="btn btn--green" disabled={busy || selected.length < 1 || (requireName && !name.trim())}>
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
