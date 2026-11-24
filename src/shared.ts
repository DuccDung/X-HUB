export interface ChairLayout {
  id: string;
  x: number;
  y: number;
}

export interface TableLayout {
  id: string;
  label: string;
  shape: 'round' | 'square';
  x: number;
  y: number;
  rotation: number;
  chairs: ChairLayout[];
}

export interface Layout {
  tables: TableLayout[];
  version: number;
}

export const characterModels = ['neutral', 'male', 'female'] as const;
export const characterTops = ['olive', 'brown', 'rust', 'cream'] as const;
export const characterBottoms = ['charcoal', 'navy', 'sand'] as const;
export const characterShoes = ['sand', 'coffee', 'black'] as const;

export type CharacterModel = typeof characterModels[number];
export type CharacterTop = typeof characterTops[number];
export type CharacterBottom = typeof characterBottoms[number];
export type CharacterShoes = typeof characterShoes[number];

export interface CharacterOutfit {
  top: CharacterTop;
  bottom: CharacterBottom;
  shoes: CharacterShoes;
}

export const defaultCharacterOutfits: Record<CharacterModel, CharacterOutfit> = {
  neutral: { top: 'olive', bottom: 'charcoal', shoes: 'sand' },
  male: { top: 'brown', bottom: 'charcoal', shoes: 'coffee' },
  female: { top: 'rust', bottom: 'charcoal', shoes: 'black' },
};

export interface GuestProfile {
  displayName: string;
  model: CharacterModel;
  outfit: CharacterOutfit;
}

export interface TableCharacter extends GuestProfile {
  id: string;
}

export interface VenueActivity {
  presence: Record<string, number>;
  characters: Record<string, TableCharacter[]>;
}

export interface VenueState extends VenueActivity {
  layout: Layout;
  tableId: string | null;
  profile: TableCharacter | null;
}

export interface AdminLayout {
  draft: Layout;
  published: Layout;
  qrs: Record<string, string>;
}

export interface Conversation {
  id: string;
  tableId: string;
  messages: { id: string; text: string; mine: boolean; tableId: string; createdAt: string }[];
}

export interface Invite {
  id: string;
  tableId: string;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

export interface Game {
  id: string;
  tableId: string;
  size: number;
  board: ('X' | 'O' | null)[];
  mine: 'X' | 'O';
  turn: 'X' | 'O';
  winner: 'X' | 'O' | 'draw' | null;
  lastMove: number | null;
}

export interface SocialState {
  conversations: Conversation[];
  invites: Invite[];
  games: Game[];
}

export interface JournalEntry {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}
