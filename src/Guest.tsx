import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { io } from 'socket.io-client';
import { api, ApiError } from './api';
import { CharacterDialog } from './CharacterDialog';
import { CharacterSprite } from './CharacterSprite';
import { MapView } from './Map';
import type { Conversation, Game, GuestProfile, JournalEntry, Layout, SocialState, TableCharacter, TableLayout, VenueActivity, VenueState } from './shared';
import './guest.css';

const tabs = [
  { id: 'map', title: 'Sơ đồ' },
  { id: 'chat', title: 'Chat' },
  { id: 'caro', title: 'Caro' },
  { id: 'journal', title: 'Nhật ký' },
] as const;
type Tab = typeof tabs[number]['id'];
type ChatTarget = { tableId: string; conversationId?: string };
const emptySocial: SocialState = { conversations: [], invites: [], games: [] };
const timeFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'long' });

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Có lỗi xảy ra. Bạn thử lại nhé.';
}

export function Guest() {
  const [venue, setVenue] = useState<VenueState>();
  const [social, setSocial] = useState(emptySocial);
  const [tab, setTab] = useState<Tab>('map');
  const [target, setTarget] = useState<ChatTarget>();
  const [inspectId, setInspectId] = useState<string>();
  const [gameId, setGameId] = useState<string>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editingCharacter, setEditingCharacter] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const socialRevision = useRef(0);
  const profile = venue?.profile;
  const tableId = venue?.tableId;
  const checkedIn = Boolean(tableId && profile);
  const showCharacterDialog = Boolean(tableId && (editingCharacter || (!profile && !onboardingDismissed)));
  const tables = venue?.layout.tables ?? [];
  const current = tables.find((table) => table.id === tableId);
  const inspecting = tables.find((table) => table.id === inspectId);
  const pending = social.invites.filter((invite) => invite.direction === 'incoming').length;
  const currentCharacters = tableId ? venue?.characters?.[tableId] ?? [] : [];
  const characters = tableId && profile && !currentCharacters.some((character) => character.id === profile.id)
    ? { ...venue?.characters, [tableId]: [...currentCharacters, profile] }
    : venue?.characters;
  const joinHint = tableId ? 'Tạo nhân vật để tham gia.' : 'Quét mã QR tại bàn để tham gia.';

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

  const reloadSocial = useCallback(async () => {
    const revision = ++socialRevision.current;
    try {
      const next = await api<SocialState>('/api/social');
      if (revision === socialRevision.current) setSocial(next);
    } catch {
      // Socket.IO retries the connection and fetches again on reconnect.
    }
  }, []);

  const hasVenue = Boolean(venue);
  useEffect(() => {
    if (!hasVenue) return;
    const socket = io();
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
    return () => { socket.disconnect(); };
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

  function selectTab(next: Tab) {
    setTab(next);
    setNotice('');
    setInspectId(undefined);
    if (next === 'chat' || next === 'caro') void reloadSocial();
  }

  function labelOf(id: string) {
    return tables.find((table) => table.id === id)?.label ?? 'đã rời sơ đồ';
  }

  function startChat(tableId: string) {
    selectTab('chat');
    setTarget({ tableId });
  }

  async function invite(tableId: string) {
    selectTab('caro');
    await socialAction('/api/caro/invite', { tableId });
  }

  const activeConversation = target && (target.conversationId
    ? social.conversations.find((conversation) => conversation.id === target.conversationId)
    : social.conversations.find((conversation) => conversation.tableId === target.tableId));
  const activeGame = social.games.find((game) => game.id === gameId)
    ?? social.games.find((game) => !game.winner) ?? social.games[0];

  return (
    <div className="guest-shell">
      <header className="guest-header">
        <button className="guest-brand" aria-label="Xưởng Caffe, về sơ đồ" onClick={() => selectTab('map')}>
          <img src="/art/brand.webp" alt="" width="45" height="45" />
          <span>Xưởng Caffe</span>
        </button>
        {current && <button className="guest-seat" type="button" onClick={openCharacter}
          aria-label={profile ? `Chỉnh nhân vật, bàn ${current.label}` : undefined}>
          <span className="guest-seat__pin" aria-hidden="true" />
          <span className="guest-seat__label">{profile ? `Bàn ${current.label}` : 'Tạo nhân vật'}</span>
        </button>}
      </header>

      <main className={`guest-main guest-main--${tab}`}>
        {notice && <div className="guest-notice" role="status">
          <span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Đóng thông báo">×</button>
        </div>}
        {tab === 'map' && (venue ? (
          <MapView tables={tables} currentTableId={checkedIn ? tableId : null} presence={venue.presence}
            characters={characters} selfCharacterId={profile?.id} onTableClick={setInspectId} />
        ) : (
          <div className="guest-map-loading">
            <img src="/art/cafe.webp" alt="" />
            <div>{notice ? <button className="btn btn--green" onClick={() => { setNotice(''); setLoadAttempt(loadAttempt + 1); }}>Tải lại sơ đồ</button> : <p role="status">Đang mở sơ đồ…</p>}</div>
          </div>
        ))}

        {tab === 'chat' && <ChatPanel conversations={social.conversations} active={activeConversation || undefined}
          target={target} checkedIn={checkedIn} joinHint={joinHint} labelOf={labelOf} busy={busy} goMap={() => selectTab('map')}
          selectConversation={(conversation) => setTarget({ tableId: conversation.tableId, conversationId: conversation.id })}
          closeConversation={() => setTarget(undefined)}
          send={async (text) => {
            if (!target) return false;
            return socialAction('/api/chat', { tableId: target.tableId, conversationId: activeConversation?.id, text });
          }} />}

        {tab === 'caro' && <section className="guest-panel" aria-labelledby="caro-title">
          <PanelTitle icon="caro" title="Caro" id="caro-title" />
          {social.invites.length > 0 && <ul className="invite-list" aria-label="Lời mời chơi">
            {social.invites.map((challenge) => <li className="guest-card" key={challenge.id}>
              <div><strong>Bàn {labelOf(challenge.tableId)}</strong>
                <p>{challenge.direction === 'incoming' ? 'Mời bạn chơi caro' : 'Đang chờ trả lời'}</p></div>
              <div className="guest-actions">
                <button className="btn" disabled={busy} onClick={() => void socialAction(`/api/caro/invites/${challenge.id}`, { accept: false })}>
                  {challenge.direction === 'incoming' ? 'Từ chối' : 'Hủy lời mời'}
                </button>
                {challenge.direction === 'incoming' && <button className="btn btn--green" disabled={busy}
                  onClick={async () => {
                    if (await socialAction(`/api/caro/invites/${challenge.id}`, { accept: true })) setGameId(undefined);
                  }}>Chấp nhận</button>}
              </div>
            </li>)}
          </ul>}
          {activeGame ? <>
            {social.games.length > 1 && <label className="field-label">Chọn ván
              <select value={activeGame.id} onChange={(event) => setGameId(event.target.value)}>
                {social.games.map((game) => <option key={game.id} value={game.id}>Bàn {labelOf(game.tableId)} · {game.winner ? 'Đã kết thúc' : 'Đang chơi'}</option>)}
              </select>
            </label>}
            <CaroBoard game={activeGame} label={labelOf(activeGame.tableId)} busy={busy}
              move={(index) => void socialAction(`/api/caro/games/${activeGame.id}/move`, { index })} />
          </> : !social.invites.length && <GuestEmpty text={checkedIn ? 'Chọn một bàn đang online để mời chơi.' : joinHint} goMap={() => selectTab('map')} />}
        </section>}

        {tab === 'journal' && <Journal />}
      </main>

      <nav className="guest-nav" aria-label="Điều hướng chính">
        {tabs.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined}
          className="guest-nav__tab" onClick={() => selectTab(item.id)}>
          <span className="guest-nav__sprite"><img src={`/art/${item.id}.webp`} alt="" width="45" height="45" />
            {item.id === 'caro' && pending > 0 && <span className="guest-nav__count" aria-label={`${pending} lời mời`}>{pending}</span>}
          </span>
          <span>{item.title}</span>
        </button>)}
      </nav>

      {inspecting && !showCharacterDialog && <TableDialog table={inspecting} current={inspecting.id === current?.id} checkedIn={checkedIn}
        online={venue?.presence[inspecting.id] ?? 0} people={characters?.[inspecting.id] ?? []} selfId={profile?.id}
        joinHint={joinHint} close={() => setInspectId(undefined)} edit={openCharacter}
        chat={() => startChat(inspecting.id)} invite={() => void invite(inspecting.id)} />}
      {showCharacterDialog && <CharacterDialog profile={profile} onSave={saveCharacter} onClose={closeCharacter} />}
    </div>
  );
}

function PanelTitle({ icon, title, id }: { icon: Tab; title: string; id: string }) {
  return <h1 className="guest-panel__title" id={id}><img src={`/art/${icon}.webp`} width="44" height="44" alt="" />{title}</h1>;
}

function GuestEmpty({ text, goMap }: { text: string; goMap: () => void }) {
  return <div className="guest-empty"><p>{text}</p><button className="btn" onClick={goMap}>Mở sơ đồ</button></div>;
}

function TableDialog({ table, current, checkedIn, online, people, selfId, joinHint, close, edit, chat, invite }: {
  table: TableLayout; current: boolean; checkedIn: boolean; online: number;
  people: TableCharacter[]; selfId?: string; joinHint: string;
  close: () => void; edit: () => void; chat: () => void; invite: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
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
      <p>{current && checkedIn ? 'Bạn đang ở đây' : online ? `${online} khách đang online` : 'Bàn này chưa có khách online.'}</p>
      {people.length > 0 && <ul className="table-dialog__characters" aria-label="Khách tại bàn">
        {people.map((person) => <li key={person.id}>
          <CharacterSprite model={person.model} outfit={person.outfit} />
          <span>{person.displayName}{person.id === selfId && <small> · Bạn</small>}</span>
        </li>)}
      </ul>}
      {current && <div className="table-dialog__actions">
        <button className="btn btn--green" type="button" onClick={edit}>{checkedIn ? 'Chỉnh nhân vật' : 'Tạo nhân vật'}</button>
      </div>}
      {checkedIn && !current && online > 0 && <div className="table-dialog__actions">
        <button className="btn btn--green" type="button" onClick={chat}><img src="/art/chat.webp" alt="" />Nhắn tin</button>
        <button className="btn" type="button" onClick={invite}><img src="/art/caro.webp" alt="" />Mời chơi caro</button>
      </div>}
      {!checkedIn && !current && <p>{joinHint}</p>}
    </div>
  </dialog>;
}

function ChatPanel({ conversations, active, target, checkedIn, joinHint, labelOf, busy, goMap, send, selectConversation, closeConversation }: {
  conversations: Conversation[]; active?: Conversation; target?: ChatTarget; checkedIn: boolean; busy: boolean;
  joinHint: string;
  labelOf: (id: string) => string; goMap: () => void; send: (text: string) => Promise<boolean>;
  selectConversation: (conversation: Conversation) => void; closeConversation: () => void;
}) {
  const [text, setText] = useState('');
  const end = useRef<HTMLSpanElement>(null);
  useEffect(() => { setText(''); }, [target?.tableId, target?.conversationId]);
  useEffect(() => {
    if (end.current?.parentElement) end.current.parentElement.scrollTop = end.current.parentElement.scrollHeight;
  }, [active?.messages]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (value && await send(value)) setText('');
  }

  return <section className="guest-panel" aria-labelledby="chat-title">
    <PanelTitle icon="chat" title="Chat" id="chat-title" />
    {target ? <div className="chat-thread">
      <div className="chat-thread__header">
        <strong>Bàn {labelOf(target.tableId)}</strong>
        <button className="btn" onClick={closeConversation}>Cuộc trò chuyện</button>
      </div>
      <div className="chat-thread__messages" role="log" aria-label="Tin nhắn">
        {!active?.messages.length && <p className="chat-thread__empty">Gửi lời chào đến bàn {labelOf(target.tableId)}.</p>}
        {active?.messages.map((message) => <div key={message.id} className={`chat-message${message.mine ? ' chat-message--mine' : ''}`}>
          <p>{message.text}</p><time dateTime={message.createdAt}>{timeFormat.format(new Date(message.createdAt))}</time>
        </div>)}
        <span ref={end} />
      </div>
      <form className="chat-thread__compose" onSubmit={submit}>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Viết tin nhắn…" aria-label="Tin nhắn" maxLength={500} disabled={!checkedIn} />
        <button className="btn btn--green" disabled={busy || !text.trim() || !checkedIn}>Gửi</button>
      </form>
    </div> : conversations.length ? <ul className="conversation-list">
      {conversations.map((conversation) => <li key={conversation.id}>
        <button className="guest-card conversation-row" onClick={() => selectConversation(conversation)}>
          <img src="/art/chat.webp" alt="" width="36" height="36" />
          <span><strong>Bàn {labelOf(conversation.tableId)}</strong><small>{conversation.messages.at(-1)?.text}</small></span>
        </button>
      </li>)}
    </ul> : <GuestEmpty text={checkedIn ? 'Chọn một bàn đang online để bắt chuyện.' : joinHint} goMap={goMap} />}
  </section>;
}

function CaroBoard({ game, label, busy, move }: { game: Game; label: string; busy: boolean; move: (index: number) => void }) {
  const myTurn = game.turn === game.mine && !game.winner;
  const result = game.winner === 'draw' ? 'Ván hòa' : game.winner === game.mine ? 'Bạn thắng!' : 'Đối thủ thắng!';
  return <div className="caro-board">
    <div className="caro-board__status" role="status"><span>Bàn {label} · Bạn chơi {game.mine}</span>
      <strong>{game.winner ? result : myTurn ? 'Đến lượt bạn' : 'Đến lượt đối thủ'}</strong>
    </div>
    <div className="caro-board__grid" role="group" aria-label="Bàn cờ caro"
      style={{ gridTemplateColumns: `repeat(${game.size}, minmax(0, 1fr))` }}>
      {game.board.map((mark, index) => <button type="button" key={index} className="caro-cell" data-mark={mark}
        data-last={index === game.lastMove} disabled={Boolean(mark) || !myTurn || busy}
        aria-label={`Hàng ${Math.floor(index / game.size) + 1}, cột ${index % game.size + 1}${mark ? `, ${mark}` : ''}`}
        onClick={() => move(index)}>{mark}</button>)}
    </div>
    <p className="caro-board__rule">Nối 5 quân liên tiếp để thắng.</p>
  </div>;
}

function Journal() {
  const [entries, setEntries] = useState<JournalEntry[]>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [needsQr, setNeedsQr] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api<{ entries: JournalEntry[] }>('/api/journal', { signal: controller.signal })
      .then((data) => setEntries(data.entries))
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) setNeedsQr(true);
        else setError(messageOf(failure));
      });
    return () => controller.abort();
  }, [attempt]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !title.trim() || !body.trim()) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { entry } = await api<{ entry: JournalEntry }>('/api/journal', {
        method: 'POST', body: JSON.stringify({ title: title.trim(), body: body.trim() }),
      });
      setEntries((previous) => [entry, ...(previous ?? [])]);
      setTitle('');
      setBody('');
      setNotice('Đã lưu kỷ niệm của bạn.');
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setSaving(false);
    }
  }

  return <section className="guest-panel" aria-labelledby="journal-title">
    <PanelTitle icon="journal" title="Nhật ký" id="journal-title" />
    {error && <p className="form-error" role="alert">{error}</p>}
    {needsQr ? <p className="guest-empty">Quét QR tại bàn để mở nhật ký của bạn.</p> : !entries ? (
      error ? <button className="btn" onClick={() => { setError(''); setAttempt(attempt + 1); }}>Tải lại nhật ký</button> : <p role="status">Đang mở nhật ký…</p>
    ) : <>
      <form className="journal-form guest-card" onSubmit={save}>
        <label className="field-label">Tiêu đề<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} required /></label>
        <label className="field-label">Kỷ niệm<textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={4000} rows={5} required /></label>
        <button className="btn btn--green" disabled={saving || !title.trim() || !body.trim()}>{saving ? 'Đang lưu…' : 'Lưu nhật ký'}</button>
        {notice && <p className="form-success" role="status">{notice}</p>}
      </form>
      <p className="journal-note">Nhật ký riêng tư và có thể mở lại trên trình duyệt này.</p>
      {entries.length > 0 && <div className="journal-entries"><h2>Kỷ niệm đã lưu</h2>
        {entries.map((entry) => <details key={entry.id} className="guest-card journal-entry">
          <summary><strong>{entry.title}</strong><time dateTime={entry.createdAt}>{dateFormat.format(new Date(entry.createdAt))}</time></summary>
          <p>{entry.body}</p>
        </details>)}
      </div>}
    </>}
  </section>;
}
