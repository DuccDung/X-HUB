import { useEffect, useMemo, useRef, useState } from 'react';
import { findCaroWinningLine, pickBotMove } from './caroBot';
import type { BotDifficulty } from './caroBot';
import { CharacterSprite } from './CharacterSprite';
import type { OnlinePerson } from './ChatPanel';
import { caroEmojis } from './shared';
import type { CaroEmoji, CaroEmojiEvent, Game, Invite, TableCharacter } from './shared';
import { playCaroMoveSound, playCaroWinSound } from './sound';
import './caro-panel.css';

const BOARD_SIZE = 15;
const TURN_SECONDS = 30;
const STAR_POINTS = new Set([
  3 * BOARD_SIZE + 3,
  3 * BOARD_SIZE + 11,
  7 * BOARD_SIZE + 7,
  11 * BOARD_SIZE + 3,
  11 * BOARD_SIZE + 11,
]);

const difficultyLabels: Record<BotDifficulty, string> = {
  easy: 'Dễ',
  medium: 'Vừa',
  hard: 'Khó',
};

type BotGameState = {
  difficulty: BotDifficulty;
  board: ('X' | 'O' | null)[];
  mine: 'X' | 'O';
  turn: 'X' | 'O';
  winner: 'X' | 'O' | 'draw' | null;
  winningLine: number[] | null;
  lastMove: number | null;
  score: { mine: number; opponent: number };
  turnStartedAt: number;
};

type FloatingEmoji = {
  id: number;
  emoji: CaroEmoji;
  fromOpponent: boolean;
  label?: string;
};

type ActiveView =
  | { kind: 'lobby' }
  | { kind: 'pvp'; gameId: string }
  | { kind: 'bot' };

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0].toUpperCase() : '?';
}

function shortTableCode(label: string): string {
  const clean = label.trim();
  return /^\d+$/.test(clean) ? `B${clean}` : clean;
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function SoundIcon({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.8 5.2a9.5 9.5 0 0 1 0 13.6" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}

function PersonAvatar({
  name,
  person,
  online,
}: {
  name: string;
  person?: TableCharacter;
  online?: boolean;
}) {
  return (
    <span className="caro-avatar" aria-hidden="true">
      {person ? (
        <span className="caro-avatar__sprite">
          <CharacterSprite model={person.model} outfit={person.outfit} />
        </span>
      ) : (
        <span className="caro-avatar__initial">{initialOf(name)}</span>
      )}
      {online !== undefined && (
        <span className={`caro-avatar__dot${online ? '' : ' caro-avatar__dot--off'}`} />
      )}
    </span>
  );
}

function MarkGlyph({ mark }: { mark: 'X' | 'O' }) {
  return mark === 'X' ? (
    <svg className="caro-mark caro-mark--x" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.1" strokeLinecap="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  ) : (
    <svg className="caro-mark caro-mark--o" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <circle cx="12" cy="12" r="6.4" />
    </svg>
  );
}

function createBotMatch(difficulty: BotDifficulty, mine: 'X' | 'O' = 'X', score = { mine: 0, opponent: 0 }): BotGameState {
  return {
    difficulty,
    board: Array<'X' | 'O' | null>(BOARD_SIZE * BOARD_SIZE).fill(null),
    mine,
    turn: 'X',
    winner: null,
    winningLine: null,
    lastMove: null,
    score,
    turnStartedAt: Date.now(),
  };
}

export function CaroPanel({
  invites,
  games,
  onlinePeople,
  checkedIn,
  hasSeat,
  joinHint,
  selectedGameId,
  onSelectGameId,
  labelOf,
  busy,
  soundEnabled,
  onToggleSound,
  onOpenCharacter,
  onInvitePerson,
  onAnswerInvite,
  onMove,
  onResign,
  onDrawAction,
  onRematch,
  onSendEmoji,
  incomingEmoji,
}: {
  invites: Invite[];
  games: Game[];
  onlinePeople: OnlinePerson[];
  checkedIn: boolean;
  hasSeat: boolean;
  joinHint: string;
  selectedGameId?: string;
  onSelectGameId: (id?: string) => void;
  labelOf: (tableId: string) => string;
  busy: boolean;
  soundEnabled: boolean;
  onToggleSound: () => void;
  onOpenCharacter: () => void;
  onInvitePerson: (recipientId: string) => Promise<boolean>;
  onAnswerInvite: (inviteId: string, accept: boolean) => Promise<boolean>;
  onMove: (gameId: string, index: number) => Promise<boolean>;
  onResign: (gameId: string) => Promise<boolean>;
  onDrawAction: (gameId: string, action: 'offer' | 'accept' | 'decline') => Promise<boolean>;
  onRematch: (gameId: string) => Promise<string | null>;
  onSendEmoji: (gameId: string, emoji: CaroEmoji) => void;
  incomingEmoji: (CaroEmojiEvent & { seq: number }) | null;
}) {
  const [view, setView] = useState<ActiveView>(() => {
    if (selectedGameId) return { kind: 'pvp', gameId: selectedGameId };
    return { kind: 'lobby' };
  });
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('medium');
  const [botGame, setBotGame] = useState<BotGameState | null>(null);
  const [botThinking, setBotThinking] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [floats, setFloats] = useState<FloatingEmoji[]>([]);
  const [emojiCooldown, setEmojiCooldown] = useState(false);

  const floatSeq = useRef(0);
  const prevGameIds = useRef<Set<string>>(new Set(games.map((g) => g.id)));
  const boardViewportRef = useRef<HTMLDivElement>(null);
  const centeredMatchKey = useRef<string>('');
  const dragRef = useRef<{ active: boolean; moved: boolean; startX: number; startY: number; scrollLeft: number; scrollTop: number }>({
    active: false, moved: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0,
  });
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  const onlineById = useMemo(
    () => new Map(onlinePeople.map((person) => [person.id, person])),
    [onlinePeople],
  );

  // Sync external selectedGameId (e.g. from rematch or accepting invite)
  useEffect(() => {
    if (selectedGameId && games.some((g) => g.id === selectedGameId)) {
      setView({ kind: 'pvp', gameId: selectedGameId });
    }
  }, [selectedGameId, games]);

  // Auto-enter newly created PvP game when an invite is accepted or rematch starts
  useEffect(() => {
    const previous = prevGameIds.current;
    const newlyCreated = games.find((game) => !previous.has(game.id) && !game.winner);
    prevGameIds.current = new Set(games.map((g) => g.id));
    if (newlyCreated) {
      setView({ kind: 'pvp', gameId: newlyCreated.id });
      onSelectGameId(newlyCreated.id);
    }
  }, [games, onSelectGameId]);

  const activePvpGame = view.kind === 'pvp'
    ? games.find((game) => game.id === view.gameId) ?? games.find((game) => !game.winner)
    : undefined;

  // If the viewed PvP game vanished (expired/replaced), return cleanly to lobby
  useEffect(() => {
    if (view.kind === 'pvp' && !activePvpGame) {
      setView({ kind: 'lobby' });
      onSelectGameId(undefined);
    }
  }, [view, activePvpGame, onSelectGameId]);

  // Reset resign confirmation when switching matches or finishing
  useEffect(() => {
    setConfirmResign(false);
  }, [view, activePvpGame?.id, activePvpGame?.winner, botGame?.winner]);

  useEffect(() => {
    if (!confirmResign) return;
    const timer = setTimeout(() => setConfirmResign(false), 3200);
    return () => clearTimeout(timer);
  }, [confirmResign]);

  // Countdown tick while inside an active match
  const inLiveMatch = (view.kind === 'pvp' && Boolean(activePvpGame && !activePvpGame.winner))
    || (view.kind === 'bot' && Boolean(botGame && !botGame.winner));
  useEffect(() => {
    if (!inLiveMatch) return;
    setNowTick(Date.now());
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [inLiveMatch]);

  // Helper to spawn floating emoji
  const pushFloat = (emoji: CaroEmoji, fromOpponent: boolean, label?: string) => {
    const id = ++floatSeq.current;
    setFloats((prev) => [...prev.slice(-5), { id, emoji, fromOpponent, label }]);
    setTimeout(() => {
      setFloats((prev) => prev.filter((item) => item.id !== id));
    }, 1500);
  };

  // Show incoming PvP opponent emoji
  useEffect(() => {
    if (!incomingEmoji) return;
    if (view.kind === 'pvp' && activePvpGame && incomingEmoji.gameId === activePvpGame.id) {
      pushFloat(incomingEmoji.emoji, true, incomingEmoji.fromName);
    }
  }, [incomingEmoji, view.kind, activePvpGame]);

  // Bot turn runner
  useEffect(() => {
    if (view.kind !== 'bot' || !botGame || botGame.winner) return;
    if (botGame.turn === botGame.mine) return;

    setBotThinking(true);
    const delay = 360 + Math.floor(Math.random() * 240);
    const timer = setTimeout(() => {
      setBotGame((prev) => {
        if (!prev || prev.winner || prev.turn === prev.mine) return prev;
        const botMark = prev.mine === 'X' ? 'O' : 'X';
        const moveIndex = pickBotMove(prev.board, botMark, prev.difficulty, BOARD_SIZE);
        if (moveIndex < 0 || prev.board[moveIndex] !== null) return prev;

        const nextBoard = prev.board.slice();
        nextBoard[moveIndex] = botMark;
        const winLine = findCaroWinningLine(nextBoard, moveIndex, botMark, BOARD_SIZE);

        if (winLine) {
          if (soundEnabledRef.current) playCaroWinSound(false);
          return {
            ...prev,
            board: nextBoard,
            lastMove: moveIndex,
            winner: botMark,
            winningLine: winLine,
            score: { mine: prev.score.mine, opponent: prev.score.opponent + 1 },
          };
        }
        if (nextBoard.every((cell) => cell !== null)) {
          if (soundEnabledRef.current) playCaroWinSound(false);
          return {
            ...prev,
            board: nextBoard,
            lastMove: moveIndex,
            winner: 'draw',
          };
        }
        if (soundEnabledRef.current) playCaroMoveSound(false);
        return {
          ...prev,
          board: nextBoard,
          lastMove: moveIndex,
          turn: prev.mine,
          turnStartedAt: Date.now(),
        };
      });
      setBotThinking(false);
    }, delay);

    return () => {
      clearTimeout(timer);
      setBotThinking(false);
    };
  }, [view.kind, botGame]);

  // Center board viewport cleanly when opening a match or toggling zoom
  const matchKey = view.kind === 'pvp'
    ? `pvp:${activePvpGame?.id ?? ''}:${zoomed ? 'z' : 'n'}`
    : view.kind === 'bot'
      ? `bot:${botGame?.difficulty ?? ''}:${zoomed ? 'z' : 'n'}`
      : '';

  useEffect(() => {
    if (!matchKey) {
      centeredMatchKey.current = '';
      return;
    }
    if (centeredMatchKey.current === matchKey) return;
    centeredMatchKey.current = matchKey;
    const frame = requestAnimationFrame(() => {
      const node = boardViewportRef.current;
      if (!node) return;
      node.scrollLeft = Math.max(0, (node.scrollWidth - node.clientWidth) / 2);
      node.scrollTop = Math.max(0, (node.scrollHeight - node.clientHeight) / 2);
    });
    return () => cancelAnimationFrame(frame);
  }, [matchKey]);

  function startBotGame(diff: BotDifficulty) {
    setBotDifficulty(diff);
    setBotGame(createBotMatch(diff, 'X', { mine: 0, opponent: 0 }));
    setZoomed(false);
    setView({ kind: 'bot' });
    onSelectGameId(undefined);
  }

  function handleBotCellClick(index: number) {
    if (!botGame || botGame.winner || botThinking || botGame.turn !== botGame.mine) return;
    if (botGame.board[index] !== null) return;

    const nextBoard = botGame.board.slice();
    nextBoard[index] = botGame.mine;
    const winLine = findCaroWinningLine(nextBoard, index, botGame.mine, BOARD_SIZE);
    const botMark = botGame.mine === 'X' ? 'O' : 'X';

    if (winLine) {
      if (soundEnabled) playCaroWinSound(true);
      setBotGame({
        ...botGame,
        board: nextBoard,
        lastMove: index,
        winner: botGame.mine,
        winningLine: winLine,
        score: { mine: botGame.score.mine + 1, opponent: botGame.score.opponent },
      });
      return;
    }

    if (nextBoard.every((cell) => cell !== null)) {
      if (soundEnabled) playCaroWinSound(false);
      setBotGame({
        ...botGame,
        board: nextBoard,
        lastMove: index,
        winner: 'draw',
      });
      return;
    }

    if (soundEnabled) playCaroMoveSound(true);
    setBotGame({
      ...botGame,
      board: nextBoard,
      lastMove: index,
      turn: botMark,
      turnStartedAt: Date.now(),
    });
  }

  function handleBotResign() {
    if (!botGame || botGame.winner) return;
    const botMark = botGame.mine === 'X' ? 'O' : 'X';
    if (soundEnabled) playCaroWinSound(false);
    setBotGame({
      ...botGame,
      winner: botMark,
      winningLine: null,
      score: { mine: botGame.score.mine, opponent: botGame.score.opponent + 1 },
    });
    setConfirmResign(false);
  }

  function handleBotRematch() {
    if (!botGame) return;
    const nextMine: 'X' | 'O' = botGame.mine === 'X' ? 'O' : 'X';
    setBotGame(createBotMatch(botGame.difficulty, nextMine, botGame.score));
    centeredMatchKey.current = '';
  }

  function handleEmojiClick(emoji: CaroEmoji) {
    if (emojiCooldown) return;
    setEmojiCooldown(true);
    setTimeout(() => setEmojiCooldown(false), 1200);
    pushFloat(emoji, false);
    if (view.kind === 'pvp' && activePvpGame) {
      onSendEmoji(activePvpGame.id, emoji);
    } else if (view.kind === 'bot') {
      setTimeout(() => {
        const reply: CaroEmoji = emoji === '☕' ? '👏' : emoji === '👏' ? '☕' : '😅';
        pushFloat(reply, true, 'Máy');
      }, 650);
    }
  }

  // ==================== MATCH VIEW (PVP OR BOT) ====================
  if ((view.kind === 'pvp' && activePvpGame) || (view.kind === 'bot' && botGame)) {
    const isBot = view.kind === 'bot';
    const board = isBot ? botGame!.board : activePvpGame!.board;
    const mine = isBot ? botGame!.mine : activePvpGame!.mine;
    const oppMark: 'X' | 'O' = mine === 'X' ? 'O' : 'X';
    const turn = isBot ? botGame!.turn : activePvpGame!.turn;
    const winner = isBot ? botGame!.winner : activePvpGame!.winner;
    const winningLine = isBot ? botGame!.winningLine : activePvpGame!.winningLine;
    const winSet = winningLine ? new Set(winningLine) : null;
    const lastMove = isBot ? botGame!.lastMove : activePvpGame!.lastMove;
    const score = isBot ? botGame!.score : activePvpGame!.score;
    const opponentName = isBot ? 'Máy' : activePvpGame!.opponentName;
    const opponentTag = isBot
      ? difficultyLabels[botGame!.difficulty]
      : shortTableCode(labelOf(activePvpGame!.tableId));
    const turnStartedMs = isBot ? botGame!.turnStartedAt : Date.parse(activePvpGame!.turnStartedAt);
    const elapsedSec = Number.isFinite(turnStartedMs) ? Math.max(0, Math.floor((nowTick - turnStartedMs) / 1000)) : 0;
    const remainingSec = Math.max(0, TURN_SECONDS - elapsedSec);
    const lowTime = !winner && remainingSec <= 5;
    const myTurn = !winner && turn === mine && (!isBot || !botThinking);
    const drawOfferFrom = isBot ? null : activePvpGame!.drawOfferFrom;
    const rematchFrom = isBot ? null : activePvpGame!.rematchFrom;
    const opponentOfferedDraw = !winner && drawOfferFrom !== null && drawOfferFrom !== mine;
    const iOfferedDraw = !winner && drawOfferFrom === mine;

    const resultTitle = winner === 'draw'
      ? 'Ván hòa!'
      : winner === mine
        ? `Bạn đã thắng! (${mine})`
        : `${opponentName} thắng!`;

    const resultHint = winner === 'draw'
      ? 'Hai bên bất phân thắng bại'
      : winningLine
        ? 'Đường 5 quân thắng đã được đánh dấu'
        : winner === mine
          ? 'Đối thủ đã đầu hàng'
          : 'Bạn đã đầu hàng';

    return (
      <section className="caro-match" aria-label="Bàn cờ caro 15×15">
        {/* Compact Match Header */}
        <header className="caro-match__head">
          <div className="caro-match__head-left">
            <button
              type="button"
              className="caro-back"
              aria-label="Quay lại sảnh Caro"
              onClick={() => {
                setView({ kind: 'lobby' });
                onSelectGameId(undefined);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <h1 className="caro-match__title">Caro</h1>
            <span className="caro-chip">15×15</span>
          </div>

          <div className="caro-match__head-right">
            <button
              type="button"
              className={`caro-pill-btn${zoomed ? ' caro-pill-btn--active' : ''}`}
              aria-pressed={zoomed}
              aria-label={zoomed ? 'Thu về kích thước chuẩn' : 'Phóng to bàn cờ'}
              onClick={() => setZoomed((prev) => !prev)}
            >
              {zoomed ? '1.4x' : '1x'}
            </button>
            <button
              type="button"
              className={`caro-icon-btn${soundEnabled ? '' : ' caro-icon-btn--muted'}`}
              aria-label={soundEnabled ? 'Tắt âm thanh' : 'Bật âm thanh'}
              aria-pressed={soundEnabled}
              onClick={onToggleSound}
            >
              <SoundIcon enabled={soundEnabled} />
            </button>
          </div>
        </header>

        {/* Slim Single-Row Horizontal Score Pill */}
        <div className="caro-scorebar" role="status" aria-live="polite">
          <div className={`caro-scorebar__side caro-scorebar__side--me${!winner && turn === mine ? ' is-turn' : ''}${lowTime && turn === mine ? ' is-low' : ''}`}>
            <span className={`caro-mark-dot caro-mark-dot--${mine.toLowerCase()}`}>{mine}</span>
            <span className="caro-scorebar__meta">
              <strong>Bạn</strong>
              <small>{winner ? (winner === mine ? 'Thắng' : winner === 'draw' ? 'Hòa' : 'Thua') : turn === mine ? formatCountdown(remainingSec) : 'Chờ'}</small>
            </span>
          </div>

          <div className="caro-scorebar__score" aria-label={`Tỉ số ${score.mine} - ${score.opponent}`}>
            {score.mine} - {score.opponent}
          </div>

          <div className={`caro-scorebar__side caro-scorebar__side--opp${!winner && turn === oppMark ? ' is-turn' : ''}${lowTime && turn === oppMark ? ' is-low' : ''}`}>
            <span className="caro-scorebar__meta caro-scorebar__meta--right">
              <strong>{opponentName} · {opponentTag}</strong>
              {!winner && turn === oppMark && <small>{isBot ? 'Đang nghĩ…' : formatCountdown(remainingSec)}</small>}
            </span>
            <span className={`caro-mark-dot caro-mark-dot--${oppMark.toLowerCase()}`}>{oppMark}</span>
          </div>
        </div>

        {/* Expanded Board Container */}
        <div className="caro-board-stage">
          <div
            className="caro-board-viewport"
            ref={boardViewportRef}
            onPointerDown={(event) => {
              if (event.pointerType !== 'mouse' || event.button !== 0) return;
              const node = boardViewportRef.current;
              if (!node) return;
              dragRef.current = {
                active: true,
                moved: false,
                startX: event.clientX,
                startY: event.clientY,
                scrollLeft: node.scrollLeft,
                scrollTop: node.scrollTop,
              };
            }}
            onPointerMove={(event) => {
              if (!dragRef.current.active) return;
              const node = boardViewportRef.current;
              if (!node) return;
              const dx = event.clientX - dragRef.current.startX;
              const dy = event.clientY - dragRef.current.startY;
              if (!dragRef.current.moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                dragRef.current.moved = true;
              }
              if (dragRef.current.moved) {
                node.scrollLeft = dragRef.current.scrollLeft - dx;
                node.scrollTop = dragRef.current.scrollTop - dy;
              }
            }}
            onPointerUp={() => { dragRef.current.active = false; }}
            onPointerCancel={() => { dragRef.current.active = false; }}
            onPointerLeave={() => { dragRef.current.active = false; }}
          >
            <div
              className={`caro-grid${zoomed ? ' caro-grid--zoomed' : ''}`}
              role="group"
              aria-label="Bàn cờ caro 15×15"
            >
              {board.map((mark, index) => {
                const isLast = index === lastMove;
                const isWin = winSet?.has(index) ?? false;
                const row = Math.floor(index / BOARD_SIZE) + 1;
                const col = (index % BOARD_SIZE) + 1;
                return (
                  <button
                    key={index}
                    type="button"
                    className="caro-cell"
                    data-mark={mark ?? undefined}
                    data-star={STAR_POINTS.has(index) && !mark ? 'true' : undefined}
                    data-last={isLast ? 'true' : undefined}
                    data-win={isWin ? 'true' : undefined}
                    disabled={Boolean(mark) || !myTurn || (!isBot && busy)}
                    aria-label={`Hàng ${row}, cột ${col}${mark ? `, quân ${mark}` : ''}`}
                    onClick={() => {
                      if (dragRef.current.moved) {
                        dragRef.current.moved = false;
                        return;
                      }
                      if (isBot) {
                        handleBotCellClick(index);
                      } else if (activePvpGame) {
                        if (soundEnabled) playCaroMoveSound(true);
                        void onMove(activePvpGame.id, index);
                      }
                    }}
                  >
                    {mark && <MarkGlyph mark={mark} />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Floating quick emojis */}
          {floats.length > 0 && (
            <div className="caro-floats" aria-hidden="true">
              {floats.map((item) => (
                <span
                  key={item.id}
                  className={`caro-float${item.fromOpponent ? ' caro-float--opp' : ''}`}
                >
                  {item.emoji}
                  {item.label && <small>{item.label}</small>}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Bottom Footer: Result Banner OR Draw Offer OR Compact Action Bar */}
        {winner ? (
          <div className="caro-result-bar" role="status">
            <div className="caro-result-bar__copy">
              <strong>{resultTitle}</strong>
              <span>{resultHint}</span>
            </div>
            <div className="caro-result-bar__actions">
              {isBot ? (
                <button type="button" className="caro-btn caro-btn--green" onClick={handleBotRematch}>
                  Chơi lại
                </button>
              ) : (
                <button
                  type="button"
                  className="caro-btn caro-btn--green"
                  disabled={busy || rematchFrom === mine}
                  onClick={async () => {
                    const nextId = await onRematch(activePvpGame!.id);
                    if (nextId) {
                      setView({ kind: 'pvp', gameId: nextId });
                      onSelectGameId(nextId);
                    }
                  }}
                >
                  {rematchFrom === mine
                    ? 'Đang chờ…'
                    : rematchFrom === oppMark
                      ? 'Đồng ý chơi lại'
                      : 'Chơi lại'}
                </button>
              )}
              <button
                type="button"
                className="caro-btn"
                onClick={() => {
                  setView({ kind: 'lobby' });
                  onSelectGameId(undefined);
                }}
              >
                Về sảnh
              </button>
            </div>
          </div>
        ) : opponentOfferedDraw ? (
          <div className="caro-draw-bar" role="status">
            <span><strong>{opponentName}</strong> đề nghị hòa ván này</span>
            <div className="caro-draw-bar__actions">
              <button
                type="button"
                className="caro-btn"
                disabled={busy}
                onClick={() => void onDrawAction(activePvpGame!.id, 'decline')}
              >
                Từ chối
              </button>
              <button
                type="button"
                className="caro-btn caro-btn--green"
                disabled={busy}
                onClick={() => void onDrawAction(activePvpGame!.id, 'accept')}
              >
                Đồng ý hòa
              </button>
            </div>
          </div>
        ) : (
          <div className="caro-action-bar">
            <div className="caro-action-bar__left">
              {isBot ? (
                <button
                  type="button"
                  className="caro-action-pill"
                  onClick={() => setBotGame(createBotMatch(botGame!.difficulty, botGame!.mine, botGame!.score))}
                >
                  Ván mới
                </button>
              ) : (
                <button
                  type="button"
                  className={`caro-action-pill${iOfferedDraw ? ' is-pending' : ''}`}
                  disabled={busy || iOfferedDraw}
                  onClick={() => void onDrawAction(activePvpGame!.id, 'offer')}
                >
                  {iOfferedDraw ? 'Đã xin hòa' : 'Xin hòa'}
                </button>
              )}
              <button
                type="button"
                className={`caro-action-pill caro-action-pill--danger${confirmResign ? ' is-confirm' : ''}`}
                disabled={!isBot && busy}
                onClick={() => {
                  if (!confirmResign) {
                    setConfirmResign(true);
                    return;
                  }
                  if (isBot) {
                    handleBotResign();
                  } else if (activePvpGame) {
                    setConfirmResign(false);
                    void onResign(activePvpGame.id);
                  }
                }}
              >
                {confirmResign ? 'Xác nhận thua?' : 'Đầu hàng'}
              </button>
            </div>

            <div className="caro-action-bar__emojis" aria-label="Gửi biểu cảm nhanh">
              {caroEmojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="caro-emoji-btn"
                  disabled={emojiCooldown}
                  aria-label={`Gửi ${emoji}`}
                  onClick={() => handleEmojiClick(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    );
  }

  // ==================== LOBBY VIEW (SẢNH CARO) ====================
  const incomingInvites = invites.filter((item) => item.direction === 'incoming');
  const outgoingInvites = invites.filter((item) => item.direction === 'outgoing');
  const outgoingByPeerId = new Map(
    outgoingInvites
      .filter((item) => item.peerId)
      .map((item) => [item.peerId!, item]),
  );
  const hasActivePvp = games.some((game) => !game.winner);

  return (
    <section className="caro-lobby" aria-labelledby="caro-title">
      <header className="caro-lobby__head">
        <h1 className="caro-lobby__brand" id="caro-title">
          <img src="/art/xconnect.webp" alt="XConnect" />
        </h1>
        <button
          type="button"
          className={`caro-icon-btn${soundEnabled ? '' : ' caro-icon-btn--muted'}`}
          aria-label={soundEnabled ? 'Tắt âm thanh' : 'Bật âm thanh'}
          aria-pressed={soundEnabled}
          onClick={onToggleSound}
        >
          <SoundIcon enabled={soundEnabled} />
        </button>
      </header>

      <div className="caro-lobby__body">
        {/* Quick Invite Strip */}
        {checkedIn && onlinePeople.length > 0 && (
          <div className="caro-section">
            <div className="caro-section__head">
              <span>Mời nhanh · Đang online</span>
              <small>{hasActivePvp ? 'Đang trong ván' : 'Chạm để mời'}</small>
            </div>
            <div className="caro-online-strip">
              {onlinePeople.map((person) => {
                const pendingInvite = outgoingByPeerId.get(person.id);
                const disabled = busy || (!pendingInvite && (hasActivePvp || outgoingInvites.length > 0));
                return (
                  <button
                    key={person.id}
                    type="button"
                    className={`caro-online-item${pendingInvite ? ' is-invited' : ''}`}
                    disabled={disabled}
                    onClick={() => {
                      if (pendingInvite) {
                        void onAnswerInvite(pendingInvite.id, false);
                      } else {
                        void onInvitePerson(person.id);
                      }
                    }}
                  >
                    <PersonAvatar name={person.displayName} person={person} online />
                    <span className="caro-online-item__name">
                      {person.displayName}
                    </span>
                    <span className="caro-online-item__table">
                      {pendingInvite ? 'Đã mời' : shortTableCode(person.tableLabel)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Incoming & Outgoing Invites */}
        {incomingInvites.length > 0 && (
          <div className="caro-section">
            {incomingInvites.map((invite) => {
              const peer = invite.peerId ? onlineById.get(invite.peerId) : undefined;
              const peerName = invite.peerName ?? `Bàn ${labelOf(invite.tableId)}`;
              return (
                <article key={invite.id} className="caro-card caro-invite-card">
                  <div className="caro-invite-card__top">
                    <PersonAvatar name={peerName} person={peer} online />
                    <div className="caro-invite-card__info">
                      <div className="caro-invite-card__name">
                        <strong>{peerName}</strong>
                        <span className="caro-tag">Bàn {labelOf(invite.tableId)}</span>
                      </div>
                      <p>Mời bạn chơi Caro · 15×15</p>
                    </div>
                  </div>
                  <div className="caro-invite-card__actions">
                    <button
                      type="button"
                      className="caro-btn"
                      disabled={busy}
                      onClick={() => void onAnswerInvite(invite.id, false)}
                    >
                      Từ chối
                    </button>
                    <button
                      type="button"
                      className="caro-btn caro-btn--green"
                      disabled={busy}
                      onClick={() => void onAnswerInvite(invite.id, true)}
                    >
                      Chấp nhận
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {outgoingInvites.length > 0 && (
          <div className="caro-section">
            {outgoingInvites.map((invite) => {
              const peer = invite.peerId ? onlineById.get(invite.peerId) : undefined;
              const targetTitle = invite.peerName
                ? `${invite.peerName} · Bàn ${labelOf(invite.tableId)}`
                : `Bàn ${labelOf(invite.tableId)}`;
              return (
                <article key={invite.id} className="caro-card caro-row-card">
                  <PersonAvatar name={invite.peerName ?? targetTitle} person={peer} online />
                  <div className="caro-row-card__info">
                    <strong>{targetTitle}</strong>
                    <p>Đang chờ phản hồi lời mời…</p>
                  </div>
                  <button
                    type="button"
                    className="caro-btn"
                    disabled={busy}
                    onClick={() => void onAnswerInvite(invite.id, false)}
                  >
                    Hủy
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {/* Active / Recent Games */}
        {(games.length > 0 || botGame) && (
          <div className="caro-section">
            <div className="caro-section__head">
              <span>Ván đang chơi</span>
            </div>

            {games.map((game) => {
              const peer = onlineById.get(game.opponentId);
              const myTurn = !game.winner && game.turn === game.mine;
              const statusLabel = game.winner
                ? (game.winner === 'draw' ? 'Hòa' : game.winner === game.mine ? 'Bạn thắng' : 'Kết thúc')
                : myTurn
                  ? 'Lượt bạn'
                  : 'Chờ đối thủ';
              return (
                <button
                  key={game.id}
                  type="button"
                  className="caro-card caro-game-row"
                  onClick={() => {
                    setView({ kind: 'pvp', gameId: game.id });
                    onSelectGameId(game.id);
                  }}
                >
                  <PersonAvatar name={game.opponentName} person={peer} online={Boolean(peer)} />
                  <div className="caro-game-row__body">
                    <div className="caro-game-row__top">
                      <strong>{game.opponentName} · Bàn {labelOf(game.tableId)}</strong>
                      <span className={`caro-status-pill${myTurn ? ' is-my-turn' : ''}${game.winner ? ' is-done' : ''}`}>
                        {statusLabel}
                      </span>
                    </div>
                    <p>Bạn ({game.mine}) · Tỉ số {game.score.mine} - {game.score.opponent}</p>
                  </div>
                </button>
              );
            })}

            {botGame && (
              <button
                type="button"
                className="caro-card caro-game-row"
                onClick={() => setView({ kind: 'bot' })}
              >
                <span className="caro-bot-badge" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="8" width="16" height="11" rx="3" />
                    <path d="M12 4v4" />
                    <circle cx="12" cy="3" r="1" />
                    <circle cx="9.2" cy="13.4" r="1.1" fill="currentColor" />
                    <circle cx="14.8" cy="13.4" r="1.1" fill="currentColor" />
                  </svg>
                </span>
                <div className="caro-game-row__body">
                  <div className="caro-game-row__top">
                    <strong>Máy ({difficultyLabels[botGame.difficulty]})</strong>
                    <span className={`caro-status-pill${!botGame.winner ? ' is-my-turn' : ' is-done'}`}>
                      {botGame.winner ? 'Kết thúc' : 'Tiếp tục'}
                    </span>
                  </div>
                  <p>Bạn ({botGame.mine}) · Tỉ số {botGame.score.mine} - {botGame.score.opponent}</p>
                </div>
              </button>
            )}
          </div>
        )}

        {/* Solo Mode: Play vs Bot */}
        <div className="caro-section">
          <article className="caro-card caro-bot-card">
            <div className="caro-bot-card__top">
              <span className="caro-bot-badge" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="8" width="16" height="11" rx="3" />
                  <path d="M12 4v4" />
                  <circle cx="12" cy="3" r="1" />
                  <circle cx="9.2" cy="13.4" r="1.1" fill="currentColor" />
                  <circle cx="14.8" cy="13.4" r="1.1" fill="currentColor" />
                </svg>
              </span>
              <div className="caro-bot-card__copy">
                <strong>Đấu với Máy (Bot)</strong>
                <p>Luyện tay khi quán vắng khách</p>
              </div>
            </div>
            <div className="caro-bot-card__controls">
              <div className="caro-diff-group" role="radiogroup" aria-label="Độ khó máy">
                {(['easy', 'medium', 'hard'] as const).map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={botDifficulty === level}
                    className={`caro-diff-btn${botDifficulty === level ? ' is-active' : ''}`}
                    onClick={() => setBotDifficulty(level)}
                  >
                    {difficultyLabels[level]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="caro-btn caro-btn--green"
                onClick={() => startBotGame(botDifficulty)}
              >
                Bắt đầu
              </button>
            </div>
          </article>
        </div>

        {/* Gentle note for unseated guests */}
        {!checkedIn && (
          <div className="caro-hint">
            <span>{joinHint} để mời khách khác trong quán.</span>
            {hasSeat && (
              <button type="button" className="caro-hint__cta" onClick={onOpenCharacter}>
                Tạo nhân vật
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
