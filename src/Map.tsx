import { Fragment, useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { CharacterSprite } from './CharacterSprite';
import type { CharacterFacing } from './CharacterSprite';
import type { FloorId, TableCharacter, TableLayout, VenueActivity } from './shared';
import './map.css';

interface MapProps {
  tables: TableLayout[];
  floor?: FloorId;
  mode?: 'guest' | 'editor';
  currentTableId?: string | null;
  presence?: Record<string, number>;
  characters?: VenueActivity['characters'];
  selfCharacterId?: string;
  selectedTableId?: string | null;
  selectedChairId?: string | null;
  onTableClick?: (id: string) => void;
  onChairClick?: (tableId: string, chairId: string) => void;
  onTableDrag?: (id: string, x: number, y: number) => void;
  onChairDrag?: (tableId: string, chairId: string, x: number, y: number) => void;
  onFloorChange?: (floor: FloorId) => void;
}

interface Drag {
  pointerId: number;
  clientX: number;
  clientY: number;
  map: DOMRect;
  table: TableLayout;
  chair?: TableLayout['chairs'][number];
}

type SeatSide = 'top' | 'bottom' | 'left' | 'right';

const mapAspect = 910 / 1468;
const extraSeatPool: TableLayout['chairs'] = [
  { id: 'auto-top', x: 0, y: -4.8 },
  { id: 'auto-bottom', x: 0, y: 4.8 },
  { id: 'auto-left', x: -7.6, y: 0 },
  { id: 'auto-right', x: 7.6, y: 0 },
  { id: 'auto-top-left', x: -5.6, y: -3.5 },
  { id: 'auto-top-right', x: 5.6, y: -3.5 },
  { id: 'auto-bottom-left', x: -5.6, y: 3.5 },
  { id: 'auto-bottom-right', x: 5.6, y: 3.5 },
];

function buildGuestSeats(table: TableLayout, guestCount: number): TableLayout['chairs'] {
  const seats = [...table.chairs];
  if (guestCount <= seats.length) return seats;
  for (const candidate of extraSeatPool) {
    if (seats.length >= guestCount) break;
    const collides = seats.some((chair) => {
      const dx = chair.x - candidate.x;
      const dy = (chair.y - candidate.y) / mapAspect;
      return Math.hypot(dx, dy) < 4.5;
    });
    if (!collides) seats.push(candidate);
  }
  return seats;
}

function rotateOffset(x: number, y: number, degrees: number) {
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: x * cosine - y / mapAspect * sine, y: x * mapAspect * sine + y * cosine };
}

function seatOrientation(offset: { x: number; y: number }): { seat: SeatSide; facing: CharacterFacing } {
  const physicalX = offset.x;
  const physicalY = offset.y / mapAspect;
  if (Math.abs(physicalY) >= Math.abs(physicalX)) {
    return physicalY <= 0
      ? { seat: 'top', facing: 'front' }
      : { seat: 'bottom', facing: 'back' };
  }
  return physicalX < 0
    ? { seat: 'left', facing: 'right' }
    : { seat: 'right', facing: 'left' };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PositionedLabel {
  id: string;
  displayName: string;
  seat: SeatSide;
  self: boolean;
  x: number;
  y: number;
}

interface PlacedPerson {
  person: TableCharacter;
  table: TableLayout;
  seat: SeatSide;
  facing: CharacterFacing;
  layer: 'front' | 'behind';
  offsetX: number;
  offsetY: number;
  clampedX: number;
}

const labelHalfHeightCqh = 1.15;
const labelGapX = 0.8;
const labelGapY = 0.45;

function boxesOverlap(a: LabelBox, b: LabelBox): number {
  const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  if (dx <= 0) return 0;
  const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (dy <= 0) return 0;
  return dx * dy;
}

function makeLabelBox(x: number, y: number, halfWidth: number): LabelBox {
  return {
    left: x - halfWidth - labelGapX,
    right: x + halfWidth + labelGapX,
    top: y - labelHalfHeightCqh - labelGapY,
    bottom: y + labelHalfHeightCqh + labelGapY,
  };
}

function estimateLabelHalfWidth(name: string): number {
  const chars = [...name].length;
  return clamp(chars * 0.72 + 2.1, 4.2, 11.2);
}

function resolveCharacterLabels(
  placed: PlacedPerson[],
  selfId: string | undefined,
  floor: FloorId,
  hasStairs: boolean,
  currentTable: TableLayout | undefined,
): PositionedLabel[] {
  const obstacles: LabelBox[] = [];
  if (hasStairs) {
    obstacles.push(
      floor === 1
        ? { left: 73, right: 98, top: 8.5, bottom: 14.5 }
        : { left: 66, right: 92, top: 24.5, bottom: 30.5 },
    );
  }
  if (currentTable) {
    const leftSide = currentTable.x > 61;
    const below = currentTable.y < 14;
    obstacles.push({
      left: leftSide ? currentTable.x - 36 : currentTable.x + 5.5,
      right: leftSide ? currentTable.x - 5.5 : currentTable.x + 36,
      top: below ? currentTable.y + 3.4 : currentTable.y - 6.6,
      bottom: below ? currentTable.y + 8.0 : currentTable.y - 2.4,
    });
  }

  // Place self first so the current guest keeps their primary centered spot;
  // then sort top-to-bottom, left-to-right for deterministic layout.
  const ordered = [...placed].sort((a, b) => {
    const aSelf = a.person.id === selfId ? 0 : 1;
    const bSelf = b.person.id === selfId ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    const ay = a.table.y + a.offsetY;
    const by = b.table.y + b.offsetY;
    if (Math.abs(ay - by) > 0.5) return ay - by;
    return (a.table.x + a.offsetX) - (b.table.x + b.offsetX);
  });

  const resolved: PositionedLabel[] = [];
  for (const item of ordered) {
    const charX = clamp(item.table.x + item.offsetX, 8, 92);
    const charY = item.table.y + item.offsetY;
    const halfW = estimateLabelHalfWidth(item.person.displayName);
    const minX = halfW + 1.5;
    const maxX = 100 - halfW - 1.5;

    const baseX = clamp(
      item.seat === 'left'
        ? charX + 2.4 - halfW
        : item.seat === 'right'
          ? charX - 2.4 + halfW
          : charX,
      minX,
      maxX,
    );
    const baseY = item.seat === 'top'
      ? charY - 4.65
      : item.seat === 'bottom'
        ? charY + 2.95
        : charY - 6.0;

    const sideShift = 4.6 + halfW;
    const rightCandidateX = charX + sideShift;
    const leftCandidateX = charX - sideShift;
    const preferLeft = charX > 55;
    const sideY = item.seat === 'bottom' ? charY + 0.8 : charY - 1.2;

    const candidates: { x: number; y: number }[] = [
      { x: baseX, y: clamp(baseY, 2.2, 97.8) },
    ];
    if (preferLeft) {
      if (leftCandidateX >= minX) candidates.push({ x: leftCandidateX, y: clamp(sideY, 2.2, 97.8) });
      if (rightCandidateX <= maxX) candidates.push({ x: rightCandidateX, y: clamp(sideY, 2.2, 97.8) });
    } else {
      if (rightCandidateX <= maxX) candidates.push({ x: rightCandidateX, y: clamp(sideY, 2.2, 97.8) });
      if (leftCandidateX >= minX) candidates.push({ x: leftCandidateX, y: clamp(sideY, 2.2, 97.8) });
    }
    // Fallback slight vertical nudge if both sides are near map borders
    candidates.push({
      x: baseX,
      y: clamp(item.seat === 'bottom' ? charY + 4.4 : charY - 5.9, 2.2, 97.8),
    });

    let best = candidates[0];
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const box = makeLabelBox(candidate.x, candidate.y, halfW);
      let overlap = 0;
      for (const existing of obstacles) overlap += boxesOverlap(box, existing);
      if (overlap === 0) {
        best = candidate;
        bestScore = 0;
        break;
      }
      if (overlap < bestScore) {
        best = candidate;
        bestScore = overlap;
      }
    }

    obstacles.push(makeLabelBox(best.x, best.y, halfW));
    resolved.push({
      id: item.person.id,
      displayName: item.person.displayName,
      seat: item.seat,
      self: item.person.id === selfId,
      x: round(best.x),
      y: round(best.y),
    });
  }

  return resolved;
}

function MapCharacters({ items }: { items: PlacedPerson[] }) {
  return items.map(({ person, seat, facing, layer, clampedX, offsetY }) => (
    <Fragment key={person.id}>
      <div className="floor-map__character" data-seat={seat} data-layer={layer} aria-hidden="true"
        style={{ left: `${clampedX}cqw`, top: `${offsetY}cqh` }}>
        <CharacterSprite model={person.model} outfit={person.outfit} pose="seated" facing={facing} />
      </div>
    </Fragment>
  ));
}

export function MapView({
  tables, floor = 1, mode = 'guest', currentTableId, presence, characters, selfCharacterId, selectedTableId, selectedChairId,
  onTableClick, onChairClick, onTableDrag, onChairDrag, onFloorChange,
}: MapProps) {
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const editing = mode === 'editor';
  const mapArt = floor === 2 ? '/art/cafe-floor-2.webp' : '/art/cafe.webp';
  const nextFloor: FloorId = floor === 1 ? 2 : 1;

  function startDrag(event: PointerEvent<HTMLButtonElement>, table: TableLayout, chair?: Drag['chair']) {
    if (!editing || event.button !== 0 || !canvas.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      map: canvas.current.getBoundingClientRect(), table, chair,
    };
    if (chair) onChairClick?.(table.id, chair.id);
    else onTableClick?.(table.id);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.clientX;
    const dy = event.clientY - active.clientY;
    const { table, chair, map } = active;
    if (chair) {
      const offset = rotateOffset(chair.x, chair.y, table.rotation);
      const x = clamp(table.x + offset.x + dx / map.width * 100, 3, 97) - table.x;
      const y = clamp(table.y + offset.y + dy / map.height * 100, 2, 98) - table.y;
      const local = rotateOffset(x, y, -table.rotation);
      onChairDrag?.(table.id, chair.id, round(clamp(local.x, -100, 100)), round(clamp(local.y, -100, 100)));
      return;
    }
    onTableDrag?.(table.id, round(clamp(table.x + dx / map.width * 100, 0, 100)),
      round(clamp(table.y + dy / map.height * 100, 0, 100)));
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  const hasStairs = !editing && Boolean(onFloorChange);
  const currentTable = !editing ? tables.find((table) => table.id === currentTableId) : undefined;
  const seatsByTable = new Map<string, TableLayout['chairs']>();
  const placedByTable = new Map<string, PlacedPerson[]>();
  const allPlaced: PlacedPerson[] = [];

  if (!editing) {
    for (const table of tables) {
      const people = characters?.[table.id] ?? [];
      const seats = buildGuestSeats(table, people.length);
      seatsByTable.set(table.id, seats);
      const visiblePeople = people.slice(0, seats.length);
      const self = people.find((person) => person.id === selfCharacterId);
      if (self && seats.length > 0 && !visiblePeople.includes(self)) {
        visiblePeople[seats.length - 1] = self;
      }
      const items = visiblePeople.map((person, index): PlacedPerson => {
        const chair = seats[index];
        const offset = rotateOffset(chair.x, chair.y, table.rotation);
        const { seat, facing } = seatOrientation(offset);
        return {
          person,
          table,
          seat,
          facing,
          layer: seat === 'bottom' ? 'front' : 'behind',
          offsetX: offset.x,
          offsetY: offset.y,
          clampedX: clamp(offset.x, 8 - table.x, 92 - table.x),
        };
      });
      placedByTable.set(table.id, items);
      allPlaced.push(...items);
    }
  }

  const characterLabels = !editing
    ? resolveCharacterLabels(allPlaced, selfCharacterId, floor, hasStairs, currentTable)
    : [];

  return (
    <div className={`floor-map${editing ? ' floor-map--editor' : ''}`} ref={canvas} aria-label={`Sơ đồ tầng ${floor}`}>
      <img className="floor-map__art" src={mapArt} alt="" draggable={false} fetchPriority="high" />
      {hasStairs && onFloorChange && (
        <button type="button" className="floor-map__stairs" data-floor={floor}
          aria-label={floor === 1 ? 'Lên tầng 2' : 'Xuống tầng 1'}
          onClick={() => onFloorChange(nextFloor)}>
          {floor === 1 ? '↑ Tầng 2' : '↓ Tầng 1'}
        </button>
      )}
      {tables.map((table) => {
        const current = table.id === currentTableId;
        const selected = table.id === selectedTableId;
        const guests = presence?.[table.id] ?? 0;
        const renderedChairs = editing ? table.chairs : (seatsByTable.get(table.id) ?? table.chairs);
        const placedPeople = placedByTable.get(table.id) ?? [];
        const guestsLabel = guests ? `, ${guests} khách online` : '';
        const namesLabel = placedPeople.length ? `, ${placedPeople.map((item) => item.person.displayName).join(', ')}` : '';
        return (
          <div key={table.id} className="floor-map__anchor" data-highlight={selected || current}
            style={{ left: `${table.x}%`, top: `${table.y}%`, '--rotation': `${table.rotation}deg` } as CSSProperties}>
            <div className="floor-map__group">
              {renderedChairs.map((chair, index) => {
                const offset = rotateOffset(chair.x, chair.y, table.rotation);
                const direction = Math.atan2(chair.x, -chair.y / mapAspect) * 180 / Math.PI + table.rotation;
                const style = { left: `${offset.x}cqw`, top: `${offset.y}cqh`, '--chair-angle': `${direction}deg` } as CSSProperties;
                return editing ? (
                  <button key={chair.id} type="button" className="floor-map__chair floor-map__handle"
                    style={style} aria-label={`Ghế ${index + 1}, bàn ${table.label}`}
                    aria-pressed={selected && selectedChairId === chair.id}
                    onPointerDown={(event) => startDrag(event, table, chair)} onPointerMove={moveDrag}
                    onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
                    onClick={(event) => { if (!event.detail) onChairClick?.(table.id, chair.id); }}>
                    <img src="/art/chair.webp" alt="" draggable={false} />
                  </button>
                ) : <img key={chair.id} className="floor-map__chair" src="/art/chair.webp" alt="" style={style} draggable={false} />;
              })}
              <button type="button" className={`floor-map__table${current ? ' floor-map__table--current' : ''}${editing ? ' floor-map__handle' : ''}`}
                aria-label={`Bàn ${table.label}${current ? ', bạn đang ở đây' : ''}${guestsLabel}${namesLabel}`}
                aria-pressed={editing ? selected && !selectedChairId : undefined}
                data-table-id={table.id} data-shape={table.shape}
                onPointerDown={(event) => startDrag(event, table)} onPointerMove={moveDrag}
                onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
                onClick={(event) => { if (!editing || !event.detail) onTableClick?.(table.id); }}>
                <img src={`/art/${table.shape}.webp`} alt="" draggable={false} />
                <span className="floor-map__label">{table.label}</span>
              </button>
            </div>
            <MapCharacters items={placedPeople} />
            {guests > placedPeople.length && !editing && <span className="floor-map__online" aria-hidden="true"><span />{guests}</span>}
            {current && <span className="floor-map__location" aria-hidden="true"
              data-side={table.x > 61 ? 'left' : 'right'} data-below={table.y < 14}>Bạn đang ở đây</span>}
          </div>
        );
      })}
      {characterLabels.length > 0 && (
        <div className="floor-map__labels" aria-hidden="true">
          {characterLabels.map((label) => (
            <span key={label.id} className="floor-map__character-name"
              data-seat={label.seat} data-self={label.self} dir="auto"
              style={{ left: `${label.x}%`, top: `${label.y}%` }}>
              {label.displayName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
