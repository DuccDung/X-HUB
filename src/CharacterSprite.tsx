import { defaultCharacterOutfits } from './shared';
import type { CharacterModel, CharacterOutfit } from './shared';
import './character-sprite.css';

export type CharacterPose = 'standing' | 'seated';
export type CharacterFacing = 'front' | 'back' | 'left' | 'right';

const topFilters: Record<CharacterOutfit['top'], string> = {
  olive: 'grayscale(1) sepia(.84) hue-rotate(23deg) saturate(1.38) brightness(.86)',
  brown: 'grayscale(1) sepia(.86) saturate(1.5) brightness(.83)',
  rust: 'grayscale(1) sepia(.88) hue-rotate(-24deg) saturate(2.4) brightness(.91)',
  cream: 'grayscale(1) invert(.24) sepia(.54) saturate(.8) brightness(1.58)',
};

const bottomFilters: Record<CharacterOutfit['bottom'], string> = {
  charcoal: 'grayscale(1) brightness(.81)',
  navy: 'grayscale(1) invert(.13) sepia(.65) hue-rotate(163deg) saturate(2.1) brightness(.97)',
  sand: 'grayscale(1) invert(.34) sepia(.72) brightness(1.46)',
};

const shoeFilters: Record<CharacterOutfit['shoes'], string> = {
  sand: 'grayscale(1) invert(.27) sepia(.72) brightness(1.55)',
  coffee: 'grayscale(1) sepia(.95) saturate(1.65) brightness(.85)',
  black: 'grayscale(1) brightness(.51)',
};

export function CharacterSprite({ model, outfit, pose = 'standing', facing = 'front', className }: {
  model: CharacterModel;
  outfit: CharacterOutfit;
  pose?: CharacterPose;
  facing?: CharacterFacing;
  className?: string;
}) {
  const defaults = defaultCharacterOutfits[model];
  const seatedView = facing === 'front' ? 'front' : facing === 'back' ? 'back' : 'side';
  const base = pose === 'seated'
    ? `/art/characters/${model}-seated-${seatedView}`
    : `/art/characters/${model}`;
  const flipped = pose === 'seated' && facing === 'left';
  return (
    <span className={`character-sprite${className ? ` ${className}` : ''}`}
      data-pose={pose} data-flip={flipped || undefined} aria-hidden="true">
      <img src={`${base}.webp`} alt="" draggable={false} />
      {outfit.top !== defaults.top && <img src={`${base}-top.webp`} alt="" draggable={false} style={{ filter: topFilters[outfit.top] }} />}
      {outfit.bottom !== defaults.bottom && <img src={`${base}-bottom.webp`} alt="" draggable={false} style={{ filter: bottomFilters[outfit.bottom] }} />}
      {outfit.shoes !== defaults.shoes && <img src={`${base}-shoes.webp`} alt="" draggable={false} style={{ filter: shoeFilters[outfit.shoes] }} />}
    </span>
  );
}
