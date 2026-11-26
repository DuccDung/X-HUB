import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, TouchEvent } from 'react';
import { api } from './api';
import {
  BUILT_IN_PUZZLES,
  createShuffledBoard,
  isPuzzleSolved,
  loadPuzzleRecords,
  loadSavedSession,
  prepareSquarePuzzleImage,
  PUZZLE_SIZES,
  recordKey,
  savePuzzleRecord,
  savePuzzleSession,
  slideByDirection,
  slideTile,
} from './slidingPuzzle';
import type { PuzzleRecord, PuzzleSize, SavedPuzzleSession, SlideDirection } from './slidingPuzzle';
import type { JournalPhoto, JournalState } from './shared';
import { playPuzzleSlideSound, playPuzzleWinSound } from './sound';
import './puzzle-panel.css';

interface ActivePuzzle {
  artId: string;
  artTitle: string;
  artSrc: string;
  isCustom: boolean;
  size: PuzzleSize;
  board: number[];
  moves: number;
  elapsedSec: number;
  showNumbers: boolean;
}

type PuzzleView =
  | { kind: 'gallery' }
  | { kind: 'playing' }
  | { kind: 'completed'; isNewRecord: boolean };

function formatTimer(seconds: number): string {
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

export function PuzzlePanel({
  soundEnabled,
  onToggleSound,
}: {
  soundEnabled: boolean;
  onToggleSound: () => void;
}) {
  const [view, setView] = useState<PuzzleView>({ kind: 'gallery' });
  const [selectedSize, setSelectedSize] = useState<PuzzleSize>(4);
  const [selectedArtId, setSelectedArtId] = useState<string>(BUILT_IN_PUZZLES[0].id);
  const [records, setRecords] = useState<Record<string, PuzzleRecord>>(() => loadPuzzleRecords());
  const [savedSession, setSavedSession] = useState<SavedPuzzleSession | null>(() => loadSavedSession());
  const [game, setGame] = useState<ActivePuzzle | null>(null);
  const [showRefModal, setShowRefModal] = useState(false);
  const [shuffleTick, setShuffleTick] = useState(0);

  // Custom photo picker modal state
  const [customOpen, setCustomOpen] = useState(false);
  const [customLoading, setCustomLoading] = useState(false);
  const [customError, setCustomError] = useState('');
  const [journalPhotos, setJournalPhotos] = useState<JournalPhoto[] | null>(null);
  const [journalLoaded, setJournalLoaded] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipedRef = useRef(false);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;

  // Persist built-in unfinished session cleanly
  const persistIfBuiltIn = useCallback((next: ActivePuzzle | null) => {
    if (!next || next.isCustom || isPuzzleSolved(next.board)) {
      if (next && !next.isCustom && isPuzzleSolved(next.board)) {
        savePuzzleSession(null);
        setSavedSession(null);
      }
      return;
    }
    const snapshot: SavedPuzzleSession = {
      artId: next.artId,
      artTitle: next.artTitle,
      size: next.size,
      board: next.board,
      moves: next.moves,
      elapsedSec: next.elapsedSec,
      showNumbers: next.showNumbers,
    };
    savePuzzleSession(snapshot);
    setSavedSession(snapshot);
  }, []);

  // Tick timer only while playing, after first move, and when tab is visible
  const timerRunning = view.kind === 'playing' && Boolean(game && game.moves > 0) && !showRefModal;
  useEffect(() => {
    if (!timerRunning) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setGame((current) => {
        if (!current) return current;
        const next = { ...current, elapsedSec: current.elapsedSec + 1 };
        persistIfBuiltIn(next);
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [timerRunning, persistIfBuiltIn]);

  // Apply a move result cleanly and handle win celebration
  const applySlide = useCallback((result: { nextBoard: number[]; movedCount: number } | null) => {
    if (!result || !game || view.kind !== 'playing') return;
    const nextMoves = game.moves + 1;
    const nextElapsed = game.elapsedSec;
    const solved = isPuzzleSolved(result.nextBoard);
    const nextGame: ActivePuzzle = {
      ...game,
      board: result.nextBoard,
      moves: nextMoves,
      elapsedSec: nextElapsed,
    };
    setGame(nextGame);

    if (solved) {
      if (soundEnabledRef.current) playPuzzleWinSound();
      if (!game.isCustom) {
        savePuzzleSession(null);
        setSavedSession(null);
      }
      const { records: nextRecords, isNewRecord } = savePuzzleRecord(
        game.isCustom ? 'custom' : game.artId,
        game.size,
        Math.max(1, nextElapsed),
        nextMoves,
      );
      setRecords(nextRecords);
      setShowRefModal(false);
      setView({ kind: 'completed', isNewRecord });
    } else {
      if (soundEnabledRef.current) playPuzzleSlideSound();
      persistIfBuiltIn(nextGame);
    }
  }, [game, view.kind, persistIfBuiltIn]);

  // Keyboard arrow controls on desktop while playing
  useEffect(() => {
    if (view.kind !== 'playing' || !game || showRefModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const map: Record<string, SlideDirection> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      };
      const dir = map[event.key];
      if (!dir) return;
      event.preventDefault();
      applySlide(slideByDirection(game.board, game.size, dir));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [view.kind, game, showRefModal, applySlide]);

  // Close reference image modal with Escape
  useEffect(() => {
    if (!showRefModal && !customOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowRefModal(false);
        setCustomOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showRefModal, customOpen]);

  function startBuiltIn(artId: string, size: PuzzleSize) {
    const art = BUILT_IN_PUZZLES.find((item) => item.id === artId) ?? BUILT_IN_PUZZLES[0];
    const next: ActivePuzzle = {
      artId: art.id,
      artTitle: art.title,
      artSrc: art.src,
      isCustom: false,
      size,
      board: createShuffledBoard(size),
      moves: 0,
      elapsedSec: 0,
      showNumbers: true,
    };
    setGame(next);
    persistIfBuiltIn(next);
    setShowRefModal(false);
    setView({ kind: 'playing' });
  }

  function resumeSaved() {
    if (!savedSession) return;
    const art = BUILT_IN_PUZZLES.find((item) => item.id === savedSession.artId);
    if (!art) return;
    setSelectedArtId(art.id);
    setSelectedSize(savedSession.size);
    setGame({
      artId: art.id,
      artTitle: art.title,
      artSrc: art.src,
      isCustom: false,
      size: savedSession.size,
      board: savedSession.board,
      moves: savedSession.moves,
      elapsedSec: savedSession.elapsedSec,
      showNumbers: savedSession.showNumbers,
    });
    setShowRefModal(false);
    setView({ kind: 'playing' });
  }

  function reshuffleCurrent(nextSize?: PuzzleSize) {
    if (!game) return;
    const size = nextSize ?? game.size;
    const next: ActivePuzzle = {
      ...game,
      size,
      board: createShuffledBoard(size),
      moves: 0,
      elapsedSec: 0,
    };
    setSelectedSize(size);
    setGame(next);
    persistIfBuiltIn(next);
    setShowRefModal(false);
    setView({ kind: 'playing' });
  }

  async function openCustomPicker() {
    setCustomError('');
    setCustomOpen(true);
    if (journalLoaded) return;
    try {
      const state = await api<JournalState>('/api/journal');
      const photos: JournalPhoto[] = [];
      for (const entry of state.entries) {
        for (const photo of entry.photos) photos.push(photo);
      }
      setJournalPhotos(photos);
    } catch {
      setJournalPhotos([]);
    } finally {
      setJournalLoaded(true);
    }
  }

  async function startCustomFromSource(source: File | string, title: string) {
    setCustomLoading(true);
    setCustomError('');
    try {
      const squareDataUrl = await prepareSquarePuzzleImage(source);
      const next: ActivePuzzle = {
        artId: 'custom',
        artTitle: title,
        artSrc: squareDataUrl,
        isCustom: true,
        size: selectedSize,
        board: createShuffledBoard(selectedSize),
        moves: 0,
        elapsedSec: 0,
        showNumbers: true,
      };
      setGame(next);
      setCustomOpen(false);
      setShowRefModal(false);
      setView({ kind: 'playing' });
    } catch (error) {
      setCustomError(error instanceof Error ? error.message : 'Không thể xử lý ảnh này.');
    } finally {
      setCustomLoading(false);
    }
  }

  function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    void startCustomFromSource(file, 'Ảnh của bạn');
  }

  function handleBoardTouchStart(event: TouchEvent) {
    const touch = event.touches[0];
    if (!touch) return;
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
    swipedRef.current = false;
  }

  function handleBoardTouchEnd(event: TouchEvent) {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start || !game) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 26) return;

    swipedRef.current = true;
    const dir: SlideDirection = Math.abs(dx) >= Math.abs(dy)
      ? (dx > 0 ? 'right' : 'left')
      : (dy > 0 ? 'down' : 'up');
    applySlide(slideByDirection(game.board, game.size, dir));
  }

  // ==================== SCREEN 3: COMPLETED ====================
  if (view.kind === 'completed' && game) {
    const nextHarderSize: PuzzleSize | null = game.size === 3 ? 4 : game.size === 4 ? 5 : null;
    return (
      <section className="pz-screen" aria-labelledby="pz-win-title">
        <div className="pz-win">
          <header className="pz-head">
            <div className="pz-head__left">
              <button
                type="button"
                className="pz-back"
                aria-label="Về danh sách tranh"
                onClick={() => setView({ kind: 'gallery' })}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <h1 id="pz-win-title" className="pz-head__title">Hoàn thành</h1>
              {view.isNewRecord && <span className="pz-chip pz-chip--green">Kỷ lục mới</span>}
            </div>
            <button
              type="button"
              className={`pz-icon-btn${soundEnabled ? '' : ' is-muted'}`}
              aria-label={soundEnabled ? 'Tắt âm thanh' : 'Bật âm thanh'}
              aria-pressed={soundEnabled}
              onClick={onToggleSound}
            >
              <SoundIcon enabled={soundEnabled} />
            </button>
          </header>

          <div className="pz-win__frame">
            <div className="pz-win__img">
              <img src={game.artSrc} alt={game.artTitle} />
            </div>
            <span className="pz-win__badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Ô góc cuối đã khớp trọn tranh!
            </span>
          </div>

          <div className="pz-win__copy">
            <h2>{game.artTitle}</h2>
            <p>
              {view.isNewRecord
                ? `Bạn vừa lập kỷ lục mới ở khung trượt ${game.size}×${game.size}.`
                : `Bạn đã hoàn thành khung trượt ${game.size}×${game.size}.`}
            </p>
          </div>

          <div className="pz-win__stats">
            <div className={`pz-win__stat${view.isNewRecord ? ' is-best' : ''}`}>
              <span>Thời gian</span>
              <strong>{formatTimer(Math.max(1, game.elapsedSec))}</strong>
            </div>
            <div className={`pz-win__stat${view.isNewRecord ? ' is-best' : ''}`}>
              <span>Số bước</span>
              <strong>{game.moves}</strong>
            </div>
            <div className="pz-win__stat">
              <span>Khung</span>
              <strong>{game.size}×{game.size}</strong>
            </div>
          </div>

          <div className="pz-win__actions">
            {nextHarderSize && (
              <button
                type="button"
                className="pz-btn pz-btn--green pz-btn--full"
                onClick={() => reshuffleCurrent(nextHarderSize)}
              >
                Thử sức khung khó hơn ({nextHarderSize}×{nextHarderSize})
              </button>
            )}
            <div className="pz-win__row">
              <button type="button" className="pz-btn" onClick={() => reshuffleCurrent()}>
                Xếp lại
              </button>
              <button type="button" className="pz-btn" onClick={() => setView({ kind: 'gallery' })}>
                Chọn tranh khác
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // ==================== SCREEN 2: PLAYING SLIDING PUZZLE ====================
  if (view.kind === 'playing' && game) {
    const totalTiles = game.size * game.size - 1;
    const emptyPos = game.board.indexOf(-1);
    const emptyRow = Math.floor(emptyPos / game.size);
    const emptyCol = emptyPos % game.size;

    return (
      <section className="pz-screen" aria-labelledby="pz-play-title">
        <div className="pz-play">
          <header className="pz-head">
            <div className="pz-head__left">
              <button
                type="button"
                className="pz-back"
                aria-label="Quay lại chọn tranh"
                onClick={() => {
                  persistIfBuiltIn(game);
                  setShowRefModal(false);
                  setView({ kind: 'gallery' });
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <h1 id="pz-play-title" className="pz-head__title">{game.artTitle}</h1>
              <span className="pz-chip">{game.size}×{game.size}</span>
            </div>
            <button
              type="button"
              className={`pz-icon-btn${soundEnabled ? '' : ' is-muted'}`}
              aria-label={soundEnabled ? 'Tắt âm thanh' : 'Bật âm thanh'}
              aria-pressed={soundEnabled}
              onClick={onToggleSound}
            >
              <SoundIcon enabled={soundEnabled} />
            </button>
          </header>

          <div className="pz-board-wrap">
            <div
              className="pz-board-frame"
              data-size={game.size}
              style={{ '--pz-size': game.size } as CSSProperties}
              onTouchStart={handleBoardTouchStart}
              onTouchEnd={handleBoardTouchEnd}
            >
              <div className="pz-board-well" role="group" aria-label={`Khung trượt ${game.size}×${game.size}`}>
                {/* Recessed empty slot underneath */}
                <div
                  className="pz-empty-well"
                  aria-hidden="true"
                  style={{ '--row': emptyRow, '--col': emptyCol } as CSSProperties}
                >
                  <div className="pz-empty-well__inner" />
                </div>

                {/* Sliding picture tiles keyed by tileId for smooth transform transitions */}
                {Array.from({ length: totalTiles }, (_, tileId) => {
                  const pos = game.board.indexOf(tileId);
                  if (pos < 0) return null;
                  const row = Math.floor(pos / game.size);
                  const col = pos % game.size;
                  const targetRow = Math.floor(tileId / game.size);
                  const targetCol = tileId % game.size;
                  const bgPos = `${(targetCol / (game.size - 1)) * 100}% ${(targetRow / (game.size - 1)) * 100}%`;
                  const isAdjacent = Math.abs(row - emptyRow) + Math.abs(col - emptyCol) === 1;
                  const isAligned = row === emptyRow || col === emptyCol;
                  const isCorrect = pos === tileId;

                  let arrowDir: SlideDirection | null = null;
                  if (isAdjacent) {
                    if (row < emptyRow) arrowDir = 'down';
                    else if (row > emptyRow) arrowDir = 'up';
                    else if (col < emptyCol) arrowDir = 'right';
                    else if (col > emptyCol) arrowDir = 'left';
                  }

                  return (
                    <div
                      key={tileId}
                      className="pz-tile-slot"
                      style={{ '--row': row, '--col': col } as CSSProperties}
                    >
                      <button
                        type="button"
                        className={`pz-tile${isAdjacent ? ' is-movable' : ''}${isAligned ? ' is-slidable' : ''}`}
                        aria-label={`Ô ${tileId + 1}${isCorrect ? ', đúng vị trí' : ''}${isAdjacent ? ', chạm để trượt' : ''}`}
                        onClick={() => {
                          if (swipedRef.current) {
                            swipedRef.current = false;
                            return;
                          }
                          applySlide(slideTile(game.board, game.size, pos));
                        }}
                        style={{
                          backgroundImage: `url("${game.artSrc}")`,
                          backgroundSize: `${game.size * 100}% ${game.size * 100}%`,
                          backgroundPosition: bgPos,
                        }}
                      >
                        {game.showNumbers && (
                          <span className={`pz-tile__num${isCorrect ? ' is-ok' : ''}`}>{tileId + 1}</span>
                        )}
                        {arrowDir && (
                          <span className={`pz-tile__arrow pz-tile__arrow--${arrowDir}`} aria-hidden="true">
                            <img
                              src="/art/puzzles/arrow.webp"
                              alt=""
                              className="pz-tile__arrow-img"
                              draggable={false}
                            />
                          </span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="pz-controls">
            <button
              type="button"
              className={`pz-ctrl${game.showNumbers ? ' is-on' : ''}`}
              aria-pressed={game.showNumbers}
              onClick={() => {
                setGame((current) => {
                  if (!current) return current;
                  const next = { ...current, showNumbers: !current.showNumbers };
                  persistIfBuiltIn(next);
                  return next;
                });
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="4" y1="9" x2="20" y2="9" />
                <line x1="4" y1="15" x2="20" y2="15" />
                <line x1="10" y1="3" x2="8" y2="21" />
                <line x1="16" y1="3" x2="14" y2="21" />
              </svg>
              <span>Đánh số</span>
            </button>
            <button
              type="button"
              className={`pz-ctrl pz-ctrl--ref${showRefModal ? ' is-open' : ''}`}
              onClick={() => setShowRefModal(true)}
            >
              <img className="pz-ctrl__thumb" src={game.artSrc} alt="" />
              <span>Xem mẫu</span>
            </button>
            <button
              type="button"
              className="pz-ctrl pz-ctrl--warm"
              onClick={() => {
                setShuffleTick((n) => n + 1);
                reshuffleCurrent();
              }}
            >
              <span key={shuffleTick} className={`pz-ctrl__icon${shuffleTick > 0 ? ' is-spinning' : ''}`} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </span>
              <span>Xáo lại</span>
            </button>
          </div>
        </div>

        {/* Full Reference Picture Overlay */}
        {showRefModal && (
          <div
            className="pz-modal-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label="Ảnh mẫu gốc"
            onClick={() => setShowRefModal(false)}
          >
            <div className="pz-ref-dialog" onClick={(event) => event.stopPropagation()}>
              <div className="pz-ref-dialog__head">
                <strong>Ảnh mẫu · {game.artTitle}</strong>
                <button type="button" className="pz-ref-dialog__close" aria-label="Đóng" onClick={() => setShowRefModal(false)}>×</button>
              </div>
              <div className="pz-ref-dialog__img">
                <img src={game.artSrc} alt={game.artTitle} />
              </div>
            </div>
          </div>
        )}
      </section>
    );
  }

  // ==================== SCREEN 1: GALLERY & DIFFICULTY ====================
  const activeArtRecord = records[recordKey(selectedArtId, selectedSize)];
  const savedArt = savedSession ? BUILT_IN_PUZZLES.find((item) => item.id === savedSession.artId) : undefined;

  return (
    <section className="pz-screen" aria-labelledby="pz-title">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={handleFileSelected}
      />

      <header className="pz-gallery-head">
        <div className="pz-gallery-head__left">
          <h1 id="pz-title" className="pz-gallery-head__brand">
            <img src="/art/xconnect.webp" alt="XConnect" />
          </h1>
        </div>
        <button
          type="button"
          className={`pz-icon-btn${soundEnabled ? '' : ' is-muted'}`}
          aria-label={soundEnabled ? 'Tắt âm thanh' : 'Bật âm thanh'}
          aria-pressed={soundEnabled}
          onClick={onToggleSound}
        >
          <SoundIcon enabled={soundEnabled} />
        </button>
      </header>

      <div className="pz-gallery-body">
        {savedSession && savedArt && (
          <article className="pz-resume">
            <div className="pz-resume__thumb">
              <img src={savedArt.src} alt="" />
            </div>
            <div className="pz-resume__info">
              <span className="pz-resume__eyebrow">Đang xếp dở</span>
              <strong>{savedArt.title}</strong>
              <span>{savedSession.size}×{savedSession.size} · {savedSession.moves} bước · {formatTimer(savedSession.elapsedSec)}</span>
            </div>
            <button type="button" className="pz-resume__btn" onClick={resumeSaved}>
              Tiếp tục
            </button>
          </article>
        )}

        <article className="pz-card pz-diff">
          <div className="pz-diff__top">
            <span>Chọn kích thước khung</span>
            {activeArtRecord && (
              <small>Kỷ lục {selectedSize}×{selectedSize}: {activeArtRecord.bestMoves} bước · {formatTimer(activeArtRecord.bestTimeSec)}</small>
            )}
          </div>
          <div className="pz-diff__seg" role="radiogroup" aria-label="Kích thước khung trượt">
            {PUZZLE_SIZES.map((option) => (
              <button
                key={option.size}
                type="button"
                role="radio"
                aria-checked={selectedSize === option.size}
                className={`pz-diff__opt${selectedSize === option.size ? ' is-active' : ''}`}
                onClick={() => setSelectedSize(option.size)}
              >
                <strong>{option.label}</strong>
                <span>{option.piecesLabel} · {option.diffLabel}</span>
              </button>
            ))}
          </div>
        </article>

        <div className="pz-sec-head">
          <span>Chọn hình để xếp</span>
          <small>Tranh thiên nhiên &amp; ảnh cá nhân</small>
        </div>

        <div className="pz-art-grid" role="radiogroup" aria-label="Chọn tranh xếp hình">
          {BUILT_IN_PUZZLES.map((art) => {
            const rec = records[recordKey(art.id, selectedSize)];
            const selected = selectedArtId === art.id;
            return (
              <button
                key={art.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`pz-art-tile${selected ? ' is-selected' : ''}`}
                onClick={() => setSelectedArtId(art.id)}
              >
                <img src={art.src} alt="" />
                {selected && <span className="pz-art-tile__check" aria-hidden="true">✓</span>}
                <div className="pz-art-tile__cap">
                  <strong>{art.title}</strong>
                  <span>{rec ? `Kỷ lục ${rec.bestMoves} bước` : 'Chưa hoàn thành'}</span>
                </div>
              </button>
            );
          })}

          <button
            type="button"
            className="pz-art-tile pz-art-tile--custom"
            onClick={() => void openCustomPicker()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <circle cx="8.5" cy="9.5" r="1.4" />
              <path d="m21 15-4.5-4.5L7 20" />
            </svg>
            <strong>Ảnh của bạn</strong>
            <span>Từ máy hoặc Nhật ký</span>
          </button>
        </div>

        <button
          type="button"
          className="pz-btn pz-btn--green pz-btn--full pz-start-cta"
          onClick={() => startBuiltIn(selectedArtId, selectedSize)}
        >
          Bắt đầu xếp ({selectedSize}×{selectedSize})
        </button>
      </div>

      {/* Custom Photo Source Sheet (Device or Personal Journal) */}
      {customOpen && (
        <div
          className="pz-modal-backdrop pz-modal-backdrop--sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pz-custom-title"
          onClick={() => { if (!customLoading) setCustomOpen(false); }}
        >
          <div className="pz-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="pz-sheet__head">
              <h2 id="pz-custom-title">Chọn ảnh của bạn</h2>
              <button
                type="button"
                className="pz-ref-dialog__close"
                aria-label="Đóng"
                disabled={customLoading}
                onClick={() => setCustomOpen(false)}
              >
                ×
              </button>
            </div>

            {customError && <p className="form-error" role="alert">{customError}</p>}

            <button
              type="button"
              className="pz-btn pz-btn--green pz-btn--full"
              disabled={customLoading}
              onClick={() => fileInputRef.current?.click()}
            >
              {customLoading ? 'Đang cắt ảnh…' : 'Chọn ảnh từ thiết bị'}
            </button>

            <div className="pz-sheet__sec">
              <span className="pz-sheet__label">Hoặc chọn từ Nhật ký của bạn</span>
              {!journalLoaded ? (
                <p className="pz-sheet__hint">Đang tải album Nhật ký…</p>
              ) : journalPhotos && journalPhotos.length > 0 ? (
                <div className="pz-sheet__grid">
                  {journalPhotos.slice(0, 12).map((photo) => (
                    <button
                      key={photo.id}
                      type="button"
                      className="pz-sheet__photo"
                      disabled={customLoading}
                      aria-label="Dùng ảnh này để xếp hình"
                      onClick={() => void startCustomFromSource(photo.url, 'Ảnh từ Nhật ký')}
                    >
                      <img src={photo.url} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="pz-sheet__hint">Chưa có ảnh nào trong Nhật ký cá nhân.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
