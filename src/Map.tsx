import { useRef } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { CharacterSprite } from './CharacterSprite';
import type { TableCharacter, TableLayout, VenueActivity } from './shared';
import './map.css';

interface MapProps {
  tables: TableLayout[];
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
}

interface Drag {
  pointerId: number;
  clientX: number;
  clientY: number;
  map: DOMRect;
  table: TableLayout;
  chair?: TableLayout['chairs'][number];
}

const mapAspect = 910 / 1468;
const extraSeats = [{ x: 0, y: -4.8 }, { x: 0, y: 4.8 }, { x: -8, y: 0 }, { x: 8, y: 0 }];

function rotateOffset(x: number, y: number, degrees: number) {
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: x * cosine - y / mapAspect * sine, y: x * mapAspect * sine + y * cosine };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function MapCharacters({ table, people, selfId }: { table: TableLayout; people: TableCharacter[]; selfId?: string }) {
  return people.map((person, index) => {
    const chair = table.chairs[index] ?? extraSeats[index];
    const offset = rotateOffset(chair.x, chair.y, table.rotation);
    const position = offset.y < -2.5 ? 'above' : offset.y > 2.5 ? 'below' : 'side';
    const x = position === 'side' ? offset.x + (offset.x < 0 ? -3 : 3) : offset.x;
    return <div key={person.id} className="floor-map__character" data-self={person.id === selfId}
      data-position={position} aria-hidden="true"
      style={{ left: `${clamp(x, 12 - table.x, 88 - table.x)}cqw`, top: `${offset.y}cqh` }}>
      <CharacterSprite model={person.model} outfit={person.outfit} />
      <span className="floor-map__character-name" dir="auto">{person.displayName}</span>
    </div>;
  });
}

export function MapView({
  tables, mode = 'guest', currentTableId, presence, characters, selfCharacterId, selectedTableId, selectedChairId,
  onTableClick, onChairClick, onTableDrag, onChairDrag,
}: MapProps) {
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const editing = mode === 'editor';

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

  return (
    <div className={`floor-map${editing ? ' floor-map--editor' : ''}`} ref={canvas} aria-label="Sơ đồ quán">
      <img className="floor-map__art" src="/art/cafe.webp" alt="" draggable={false} fetchPriority="high" />
      {tables.map((table) => {
        const current = table.id === currentTableId;
        const selected = table.id === selectedTableId;
        const guests = presence?.[table.id] ?? 0;
        const people = !editing ? characters?.[table.id] ?? [] : [];
        const visiblePeople = people.slice(0, extraSeats.length);
        const self = people.find((person) => person.id === selfCharacterId);
        if (self && !visiblePeople.includes(self)) visiblePeople[extraSeats.length - 1] = self;
        const guestsLabel = guests ? `, ${guests} khách online` : '';
        const namesLabel = visiblePeople.length ? `, ${visiblePeople.map((person) => person.displayName).join(', ')}` : '';
        return (
          <div key={table.id} className="floor-map__anchor" data-highlight={selected || current}
            style={{ left: `${table.x}%`, top: `${table.y}%`, '--rotation': `${table.rotation}deg` } as CSSProperties}>
            <div className="floor-map__group">
              {table.chairs.map((chair, index) => {
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
            <MapCharacters table={table} people={visiblePeople} selfId={selfCharacterId} />
            {guests > visiblePeople.length && !editing && <span className="floor-map__online" aria-hidden="true"><span />{guests}</span>}
            {current && <span className="floor-map__location" aria-hidden="true"
              data-side={table.x > 61 ? 'left' : 'right'} data-below={table.y < 14}>Bạn đang ở đây</span>}
          </div>
        );
      })}
    </div>
  );
}
