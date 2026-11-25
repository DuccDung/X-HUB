export type BotDifficulty = 'easy' | 'medium' | 'hard';
type Mark = 'X' | 'O';

const axes = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

export function findCaroWinningLine(
  board: (Mark | null)[],
  index: number,
  mark: Mark,
  size = 15,
): number[] | null {
  const x = index % size;
  const y = Math.floor(index / size);
  for (const [dx, dy] of axes) {
    const cells = [index];
    for (const dir of [-1, 1]) {
      let cx = x + dx * dir;
      let cy = y + dy * dir;
      while (cx >= 0 && cx < size && cy >= 0 && cy < size && board[cy * size + cx] === mark) {
        cells.push(cy * size + cx);
        cx += dx * dir;
        cy += dy * dir;
      }
    }
    if (cells.length >= 5) return cells.sort((a, b) => a - b);
  }
  return null;
}

function lineScore(count: number, openEnds: number): number {
  if (count >= 5) return 120_000;
  if (openEnds === 0) return 0;
  if (count === 4) return openEnds === 2 ? 26_000 : 4_800;
  if (count === 3) return openEnds === 2 ? 3_600 : 480;
  if (count === 2) return openEnds === 2 ? 320 : 55;
  return openEnds === 2 ? 18 : 4;
}

function evaluateCellFor(board: (Mark | null)[], index: number, mark: Mark, size: number): number {
  const x = index % size;
  const y = Math.floor(index / size);
  let total = 0;
  let strongAxes = 0;

  for (const [dx, dy] of axes) {
    let count = 1;
    let openEnds = 0;

    for (const dir of [-1, 1]) {
      let cx = x + dx * dir;
      let cy = y + dy * dir;
      while (cx >= 0 && cx < size && cy >= 0 && cy < size && board[cy * size + cx] === mark) {
        count += 1;
        cx += dx * dir;
        cy += dy * dir;
      }
      if (cx >= 0 && cx < size && cy >= 0 && cy < size && board[cy * size + cx] === null) {
        openEnds += 1;
      }
    }

    const score = lineScore(count, openEnds);
    if (score >= 3_600) strongAxes += 1;
    total += score;
  }

  if (strongAxes >= 2) total += 9_500;
  return total;
}

function candidateCells(board: (Mark | null)[], size: number): number[] {
  const marked = new Uint8Array(board.length);
  let hasAny = false;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === null) continue;
    hasAny = true;
    const x = i % size;
    const y = Math.floor(i / size);
    for (let dy = -2; dy <= 2; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= size) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= size) continue;
        const ni = ny * size + nx;
        if (board[ni] === null) marked[ni] = 1;
      }
    }
  }
  if (!hasAny) return [];
  const result: number[] = [];
  for (let i = 0; i < marked.length; i++) {
    if (marked[i]) result.push(i);
  }
  return result;
}

export function pickBotMove(
  board: (Mark | null)[],
  botMark: Mark,
  difficulty: BotDifficulty,
  size = 15,
): number {
  const oppMark: Mark = botMark === 'X' ? 'O' : 'X';
  const candidates = candidateCells(board, size);
  const center = Math.floor(size / 2);

  if (candidates.length === 0) {
    if (difficulty === 'easy') {
      const offset = (Math.floor(Math.random() * 3) - 1);
      return (center + offset) * size + center;
    }
    return center * size + center;
  }

  const scored = candidates.map((index) => {
    const attack = evaluateCellFor(board, index, botMark, size);
    const defense = evaluateCellFor(board, index, oppMark, size);
    const x = index % size;
    const y = Math.floor(index / size);
    const centerBias = Math.max(0, 12 - (Math.abs(x - center) + Math.abs(y - center)));
    const defenseWeight = difficulty === 'hard' ? 1.08 : difficulty === 'medium' ? 1.02 : 0.85;
    const score = attack >= 120_000
      ? 1_000_000
      : defense >= 120_000
        ? 900_000
        : attack + defense * defenseWeight + centerBias;
    return { index, attack, defense, score };
  });

  scored.sort((a, b) => b.score - a.score);

  if (scored[0].score >= 900_000) return scored[0].index;

  if (difficulty === 'easy') {
    const pool = scored.slice(0, Math.min(6, scored.length));
    return pool[Math.floor(Math.random() * pool.length)].index;
  }

  if (difficulty === 'medium') {
    const top = scored[0];
    const close = scored.filter((item) => item.score >= top.score * 0.88).slice(0, 3);
    return close[Math.floor(Math.random() * close.length)].index;
  }

  // Hard: 2-ply tactical lookahead across top candidates
  const topCandidates = scored.slice(0, Math.min(10, scored.length));
  const sim = board.slice();
  let bestIndex = topCandidates[0].index;
  let bestValue = -Infinity;

  for (const item of topCandidates) {
    sim[item.index] = botMark;
    const replies = candidateCells(sim, size);
    let worstCounter = 0;
    for (const reply of replies) {
      const oppAttack = evaluateCellFor(sim, reply, oppMark, size);
      if (oppAttack > worstCounter) worstCounter = oppAttack;
    }
    sim[item.index] = null;

    const value = item.score - worstCounter * 0.82;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = item.index;
    }
  }

  return bestIndex;
}
