export type PuzzleSize = 3 | 4 | 5;
export type SlideDirection = 'up' | 'down' | 'left' | 'right';

export interface BuiltInPuzzleArt {
  id: string;
  title: string;
  src: string;
}

export interface PuzzleRecord {
  bestTimeSec: number;
  bestMoves: number;
}

export interface SavedPuzzleSession {
  artId: string;
  artTitle: string;
  size: PuzzleSize;
  board: number[];
  moves: number;
  elapsedSec: number;
  showNumbers: boolean;
}

export const PUZZLE_SIZES: readonly { size: PuzzleSize; label: string; piecesLabel: string; diffLabel: string }[] = [
  { size: 3, label: '3×3', piecesLabel: '8 ô', diffLabel: 'Dễ' },
  { size: 4, label: '4×4', piecesLabel: '15 ô', diffLabel: 'Vừa' },
  { size: 5, label: '5×5', piecesLabel: '24 ô', diffLabel: 'Khó' },
];

export const BUILT_IN_PUZZLES: readonly BuiltInPuzzleArt[] = [
  { id: 'garden', title: 'Khu vườn nắng sớm', src: '/art/puzzles/garden.webp' },
  { id: 'autumn', title: 'Con đường lá thu', src: '/art/puzzles/autumn.webp' },
  { id: 'lake', title: 'Hồ xanh rừng thông', src: '/art/puzzles/lake.webp' },
];

const SESSION_KEY = 'xuong_puzzle_session_v1';
const RECORDS_KEY = 'xuong_puzzle_records_v1';

export function createSolvedBoard(size: PuzzleSize): number[] {
  const total = size * size;
  const board = Array.from({ length: total }, (_, index) => index);
  board[total - 1] = -1;
  return board;
}

export function isPuzzleSolved(board: readonly number[]): boolean {
  const last = board.length - 1;
  if (board[last] !== -1) return false;
  for (let i = 0; i < last; i++) {
    if (board[i] !== i) return false;
  }
  return true;
}

export function countCorrectTiles(board: readonly number[]): number {
  let correct = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== -1 && board[i] === i) correct += 1;
  }
  return correct;
}

export function isSolvable(board: readonly number[], size: PuzzleSize): boolean {
  const expected = size * size;
  if (board.length !== expected) return false;

  const emptyIndex = board.indexOf(-1);
  if (emptyIndex < 0) return false;

  const tiles: number[] = [];
  const seen = new Set<number>();
  for (const value of board) {
    if (value === -1) continue;
    if (!Number.isInteger(value) || value < 0 || value >= expected - 1 || seen.has(value)) {
      return false;
    }
    seen.add(value);
    tiles.push(value);
  }
  if (tiles.length !== expected - 1) return false;

  let inversions = 0;
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      if (tiles[i] > tiles[j]) inversions += 1;
    }
  }

  if (size % 2 === 1) return inversions % 2 === 0;
  const emptyRowFromBottom = size - Math.floor(emptyIndex / size);
  return (inversions + emptyRowFromBottom) % 2 === 1;
}

function neighborIndices(emptyIndex: number, size: PuzzleSize): number[] {
  const row = Math.floor(emptyIndex / size);
  const col = emptyIndex % size;
  const result: number[] = [];
  if (row > 0) result.push((row - 1) * size + col);
  if (row < size - 1) result.push((row + 1) * size + col);
  if (col > 0) result.push(row * size + (col - 1));
  if (col < size - 1) result.push(row * size + (col + 1));
  return result;
}

export function createShuffledBoard(size: PuzzleSize, rng: () => number = Math.random): number[] {
  const steps = size === 3 ? 52 : size === 4 ? 130 : 240;

  for (let attempt = 0; attempt < 12; attempt++) {
    const board = createSolvedBoard(size);
    let emptyIndex = board.length - 1;
    let previousEmpty = -1;

    for (let step = 0; step < steps; step++) {
      const options = neighborIndices(emptyIndex, size).filter((idx) => idx !== previousEmpty);
      const pick = options[Math.floor(rng() * options.length)] ?? options[0];
      board[emptyIndex] = board[pick];
      board[pick] = -1;
      previousEmpty = emptyIndex;
      emptyIndex = pick;
    }

    if (!isPuzzleSolved(board) && isSolvable(board, size)) {
      return board;
    }
  }

  // Deterministic fallback guaranteed solvable and unsolved
  const fallback = createSolvedBoard(size);
  const last = fallback.length - 1;
  fallback[last] = fallback[last - 1];
  fallback[last - 1] = -1;
  return fallback;
}

export function slideTile(
  board: readonly number[],
  size: PuzzleSize,
  clickedIndex: number,
): { nextBoard: number[]; movedCount: number } | null {
  if (clickedIndex < 0 || clickedIndex >= board.length) return null;
  const emptyIndex = board.indexOf(-1);
  if (emptyIndex < 0 || clickedIndex === emptyIndex) return null;

  const clickRow = Math.floor(clickedIndex / size);
  const clickCol = clickedIndex % size;
  const emptyRow = Math.floor(emptyIndex / size);
  const emptyCol = emptyIndex % size;

  if (clickRow !== emptyRow && clickCol !== emptyCol) return null;

  const nextBoard = board.slice();
  let movedCount = 0;

  if (clickRow === emptyRow) {
    const step = clickCol < emptyCol ? -1 : 1;
    for (let col = emptyCol; col !== clickCol; col += step) {
      const dst = emptyRow * size + col;
      const src = emptyRow * size + (col + step);
      nextBoard[dst] = nextBoard[src];
      movedCount += 1;
    }
  } else {
    const step = clickRow < emptyRow ? -1 : 1;
    for (let row = emptyRow; row !== clickRow; row += step) {
      const dst = row * size + emptyCol;
      const src = (row + step) * size + emptyCol;
      nextBoard[dst] = nextBoard[src];
      movedCount += 1;
    }
  }

  nextBoard[clickedIndex] = -1;
  return { nextBoard, movedCount };
}

/**
 * Slides the single adjacent tile into the empty slot in the requested swipe/arrow direction.
 * For example, swiping 'right' moves the tile to the LEFT of the empty slot rightward into empty.
 */
export function slideByDirection(
  board: readonly number[],
  size: PuzzleSize,
  direction: SlideDirection,
): { nextBoard: number[]; movedCount: number } | null {
  const emptyIndex = board.indexOf(-1);
  if (emptyIndex < 0) return null;

  const emptyRow = Math.floor(emptyIndex / size);
  const emptyCol = emptyIndex % size;

  let sourceRow = emptyRow;
  let sourceCol = emptyCol;
  if (direction === 'up') sourceRow += 1;
  else if (direction === 'down') sourceRow -= 1;
  else if (direction === 'left') sourceCol += 1;
  else if (direction === 'right') sourceCol -= 1;

  if (sourceRow < 0 || sourceRow >= size || sourceCol < 0 || sourceCol >= size) {
    return null;
  }
  return slideTile(board, size, sourceRow * size + sourceCol);
}

export function recordKey(artId: string, size: PuzzleSize): string {
  return `${artId}:${size}`;
}

export function loadPuzzleRecords(): Record<string, PuzzleRecord> {
  try {
    const raw = window.localStorage.getItem(RECORDS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const clean: Record<string, PuzzleRecord> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const rec = value as Record<string, unknown>;
      if (
        typeof rec.bestTimeSec === 'number' && Number.isFinite(rec.bestTimeSec) && rec.bestTimeSec >= 0
        && typeof rec.bestMoves === 'number' && Number.isFinite(rec.bestMoves) && rec.bestMoves >= 1
      ) {
        clean[key] = { bestTimeSec: Math.round(rec.bestTimeSec), bestMoves: Math.round(rec.bestMoves) };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function savePuzzleRecord(
  artId: string,
  size: PuzzleSize,
  elapsedSec: number,
  moves: number,
): { records: Record<string, PuzzleRecord>; isNewRecord: boolean } {
  const records = loadPuzzleRecords();
  const key = recordKey(artId, size);
  const prev = records[key];
  const safeTime = Math.max(1, Math.round(elapsedSec));
  const safeMoves = Math.max(1, Math.round(moves));

  const isNewRecord = !prev
    || safeMoves < prev.bestMoves
    || (safeMoves === prev.bestMoves && safeTime < prev.bestTimeSec);

  if (!prev) {
    records[key] = { bestTimeSec: safeTime, bestMoves: safeMoves };
  } else {
    records[key] = {
      bestTimeSec: Math.min(prev.bestTimeSec, safeTime),
      bestMoves: Math.min(prev.bestMoves, safeMoves),
    };
  }

  try {
    window.localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    // Ignore restricted storage errors.
  }
  return { records, isNewRecord };
}

export function loadSavedSession(): SavedPuzzleSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedPuzzleSession>;
    const size = parsed.size;
    if (size !== 3 && size !== 4 && size !== 5) return null;
    if (typeof parsed.artId !== 'string' || !BUILT_IN_PUZZLES.some((item) => item.id === parsed.artId)) {
      return null;
    }
    if (!Array.isArray(parsed.board) || !isSolvable(parsed.board, size) || isPuzzleSolved(parsed.board)) {
      return null;
    }
    return {
      artId: parsed.artId,
      artTitle: typeof parsed.artTitle === 'string' && parsed.artTitle ? parsed.artTitle : 'Xếp hình',
      size,
      board: parsed.board,
      moves: typeof parsed.moves === 'number' && parsed.moves >= 0 ? Math.round(parsed.moves) : 0,
      elapsedSec: typeof parsed.elapsedSec === 'number' && parsed.elapsedSec >= 0 ? Math.round(parsed.elapsedSec) : 0,
      showNumbers: parsed.showNumbers !== false,
    };
  } catch {
    return null;
  }
}

export function savePuzzleSession(session: SavedPuzzleSession | null): void {
  try {
    if (!session) window.localStorage.removeItem(SESSION_KEY);
    else window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Ignore restricted storage errors.
  }
}

export async function prepareSquarePuzzleImage(source: File | string): Promise<string> {
  const isFile = typeof source !== 'string';
  const objectUrl = isFile ? URL.createObjectURL(source) : source;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(new Error('Không thể đọc ảnh này. Hãy chọn ảnh JPG, PNG hoặc WebP.'));
      node.src = objectUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const side = Math.min(width, height);
    const sx = Math.floor((width - side) / 2);
    const sy = Math.floor((height - side) / 2);
    const target = Math.min(960, Math.max(1, side));

    const canvas = document.createElement('canvas');
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Trình duyệt không hỗ trợ xử lý ảnh.');
    ctx.drawImage(img, sx, sy, side, side, 0, 0, target, target);

    const webp = canvas.toDataURL('image/webp', 0.86);
    if (webp.startsWith('data:image/webp')) return webp;
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    if (isFile) URL.revokeObjectURL(objectUrl);
  }
}
