import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_PUZZLES,
  countCorrectTiles,
  createShuffledBoard,
  createSolvedBoard,
  isPuzzleSolved,
  isSolvable,
  loadPuzzleRecords,
  loadSavedSession,
  recordKey,
  savePuzzleRecord,
  savePuzzleSession,
  slideByDirection,
  slideTile,
  type PuzzleSize,
} from '../src/slidingPuzzle.ts';

const SIZES: readonly PuzzleSize[] = [3, 4, 5];

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('createSolvedBoard, isPuzzleSolved và countCorrectTiles hoạt động đúng với 3×3, 4×4, 5×5', () => {
  for (const size of SIZES) {
    const solved = createSolvedBoard(size);
    const total = size * size;
    assert.equal(solved.length, total);
    assert.equal(solved[total - 1], -1);
    assert.equal(isPuzzleSolved(solved), true);
    assert.equal(countCorrectTiles(solved), total - 1);

    const moved = slideTile(solved, size, total - 2);
    assert.ok(moved);
    assert.equal(isPuzzleSolved(moved.nextBoard), false);
    assert.equal(countCorrectTiles(moved.nextBoard), total - 2);
  }
});

test('isSolvable phân biệt đúng bảng hợp lệ, bảng không giải được và dữ liệu lỗi', () => {
  for (const size of SIZES) {
    const solved = createSolvedBoard(size);
    assert.equal(isSolvable(solved, size), true);

    // Đổi chỗ hai ô đầu tiên luôn làm thay đổi tính chẵn lẻ nghịch thế => không thể giải
    const unsolvable = solved.slice();
    [unsolvable[0], unsolvable[1]] = [unsolvable[1], unsolvable[0]];
    assert.equal(isSolvable(unsolvable, size), false);

    // Dữ liệu sai độ dài, thiếu ô trống, trùng ô hoặc giá trị ngoài phạm vi
    assert.equal(isSolvable(solved.slice(0, -1), size), false);
    const missingEmpty = solved.slice();
    missingEmpty[missingEmpty.length - 1] = size * size - 1;
    assert.equal(isSolvable(missingEmpty, size), false);

    const duplicateTile = solved.slice();
    duplicateTile[1] = duplicateTile[0];
    assert.equal(isSolvable(duplicateTile, size), false);

    const outOfRange = solved.slice();
    outOfRange[0] = 999;
    assert.equal(isSolvable(outOfRange, size), false);
  }
});

test('createShuffledBoard luôn sinh bảng giải được và chưa hoàn thành qua 100 lượt cho mỗi kích thước', () => {
  const rng = makeLcg(20261126);

  for (const size of SIZES) {
    const total = size * size;
    for (let run = 0; run < 100; run++) {
      const board = createShuffledBoard(size, rng);
      assert.equal(board.length, total);
      assert.equal(isSolvable(board, size), true, `size=${size} run=${run} phải giải được`);
      assert.equal(isPuzzleSolved(board), false, `size=${size} run=${run} không được ở trạng thái đã xếp xong`);

      const sorted = board.slice().sort((a, b) => a - b);
      const expected = [-1, ...Array.from({ length: total - 1 }, (_, index) => index)];
      assert.deepEqual(sorted, expected);
    }
  }
});

test('slideTile hỗ trợ trượt 1 ô, trượt nhiều ô cùng hàng/cột và từ chối nước đi không hợp lệ', () => {
  const solved3 = createSolvedBoard(3);

  // Trượt 2 ô cùng hàng ngang (hàng cuối: [6, 7, -1] -> click index 6 -> [-1, 6, 7])
  const rowSlide = slideTile(solved3, 3, 6);
  assert.ok(rowSlide);
  assert.equal(rowSlide.movedCount, 2);
  assert.deepEqual(rowSlide.nextBoard, [0, 1, 2, 3, 4, 5, -1, 6, 7]);
  assert.equal(isSolvable(rowSlide.nextBoard, 3), true);
  // Đảm bảo không làm biến đổi mảng gốc
  assert.deepEqual(solved3, [0, 1, 2, 3, 4, 5, 6, 7, -1]);

  // Trượt ngược lại về trạng thái hoàn thành
  const rowSlideBack = slideTile(rowSlide.nextBoard, 3, 8);
  assert.ok(rowSlideBack);
  assert.equal(rowSlideBack.movedCount, 2);
  assert.equal(isPuzzleSolved(rowSlideBack.nextBoard), true);

  // Trượt 2 ô cùng cột dọc (cột cuối: 2, 5, -1 -> click index 2 -> -1, 2, 5)
  const colSlide = slideTile(solved3, 3, 2);
  assert.ok(colSlide);
  assert.equal(colSlide.movedCount, 2);
  assert.deepEqual(colSlide.nextBoard, [0, 1, -1, 3, 4, 2, 6, 7, 5]);
  assert.equal(isSolvable(colSlide.nextBoard, 3), true);

  // Từ chối ô trống, ô chéo không thẳng hàng và chỉ số ngoài phạm vi
  assert.equal(slideTile(solved3, 3, 8), null);
  assert.equal(slideTile(solved3, 3, 4), null);
  assert.equal(slideTile(solved3, 3, -1), null);
  assert.equal(slideTile(solved3, 3, 9), null);
});

test('slideByDirection trượt đúng cả 4 hướng và khôi phục trạng thái hoàn thành', () => {
  const solved3 = createSolvedBoard(3);

  // Ô trống ở góc dưới phải (2, 2): không thể trượt lên hoặc sang trái thêm nữa
  assert.equal(slideByDirection(solved3, 3, 'up'), null);
  assert.equal(slideByDirection(solved3, 3, 'left'), null);

  // Trượt sang phải kéo ô 7 vào góc trống
  const movedRight = slideByDirection(solved3, 3, 'right');
  assert.ok(movedRight);
  assert.equal(movedRight.movedCount, 1);
  assert.deepEqual(movedRight.nextBoard, [0, 1, 2, 3, 4, 5, 6, -1, 7]);

  // Trượt sang trái trả ô 7 về vị trí cũ -> hoàn thành
  const backLeft = slideByDirection(movedRight.nextBoard, 3, 'left');
  assert.ok(backLeft);
  assert.equal(isPuzzleSolved(backLeft.nextBoard), true);

  // Trượt xuống kéo ô 5 vào góc trống, rồi trượt lên trả lại
  const movedDown = slideByDirection(solved3, 3, 'down');
  assert.ok(movedDown);
  assert.deepEqual(movedDown.nextBoard, [0, 1, 2, 3, 4, -1, 6, 7, 5]);

  const backUp = slideByDirection(movedDown.nextBoard, 3, 'up');
  assert.ok(backUp);
  assert.equal(isPuzzleSolved(backUp.nextBoard), true);
});

test('lưu và tải kỷ lục cùng ván đang xếp dở từ localStorage an toàn', () => {
  const store = new Map<string, string>();
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };

  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fakeWindow;

  try {
    const artId = BUILT_IN_PUZZLES[0].id;
    const key = recordKey(artId, 3);

    const first = savePuzzleRecord(artId, 3, 72, 34);
    assert.equal(first.isNewRecord, true);
    assert.deepEqual(first.records[key], { bestTimeSec: 72, bestMoves: 34 });

    // Kỷ lục tốt hơn theo số bước
    const betterMoves = savePuzzleRecord(artId, 3, 80, 29);
    assert.equal(betterMoves.isNewRecord, true);
    assert.deepEqual(betterMoves.records[key], { bestTimeSec: 72, bestMoves: 29 });

    // Lượt tệ hơn không ghi đè kỷ lục và không gắn cờ kỷ lục mới
    const worse = savePuzzleRecord(artId, 3, 95, 42);
    assert.equal(worse.isNewRecord, false);
    assert.deepEqual(loadPuzzleRecords()[key], { bestTimeSec: 72, bestMoves: 29 });

    // Lưu phiên đang chơi dở hợp lệ
    const moved = slideByDirection(createSolvedBoard(3), 3, 'right');
    assert.ok(moved);
    savePuzzleSession({
      artId,
      artTitle: BUILT_IN_PUZZLES[0].title,
      size: 3,
      board: moved.nextBoard,
      moves: 5,
      elapsedSec: 18,
      showNumbers: false,
    });
    const loaded = loadSavedSession();
    assert.ok(loaded);
    assert.equal(loaded.artId, artId);
    assert.equal(loaded.moves, 5);
    assert.equal(loaded.elapsedSec, 18);
    assert.equal(loaded.showNumbers, false);

    // Phiên đã hoàn thành hoặc artId không tồn tại phải bị loại bỏ khi đọc
    savePuzzleSession({
      artId,
      artTitle: BUILT_IN_PUZZLES[0].title,
      size: 3,
      board: createSolvedBoard(3),
      moves: 6,
      elapsedSec: 20,
      showNumbers: true,
    });
    assert.equal(loadSavedSession(), null);

    savePuzzleSession({
      artId: 'unknown-art',
      artTitle: 'Không tồn tại',
      size: 3,
      board: moved.nextBoard,
      moves: 1,
      elapsedSec: 3,
      showNumbers: true,
    });
    assert.equal(loadSavedSession(), null);

    savePuzzleSession(null);
    assert.equal(loadSavedSession(), null);
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
});
