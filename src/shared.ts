export const floorIds = [1, 2] as const;
export type FloorId = typeof floorIds[number];

export interface ChairLayout {
  id: string;
  x: number;
  y: number;
}

export interface TableLayout {
  id: string;
  label: string;
  floor: FloorId;
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

export type ChatKind = 'public' | 'direct' | 'group';

export interface ChatParticipant {
  id: string;
  displayName: string;
  tableId: string;
  online: boolean;
}

export interface ChatMessage {
  id: string;
  text: string;
  mine: boolean;
  authorId: string;
  authorName: string;
  tableId: string;
  createdAt: string;
}

export interface ChatReceipt {
  userId: string;
  displayName: string;
  messageId: string;
  seenAt: string;
}

export interface ChatTypingEvent {
  conversationId: string;
  userId: string;
  displayName: string;
  typing: boolean;
}

export interface Conversation {
  id: string;
  kind: ChatKind;
  name: string;
  tableId?: string;
  members: ChatParticipant[];
  messages: ChatMessage[];
  receipts: ChatReceipt[];
  updatedAt: string;
}

export const caroBoardSize = 50;

export const caroEmojis = ['👏', '😅', '☕'] as const;
export type CaroEmoji = typeof caroEmojis[number];

export interface CaroEmojiEvent {
  gameId: string;
  fromId: string;
  fromName: string;
  emoji: CaroEmoji;
}

export interface Invite {
  id: string;
  tableId: string;
  peerId?: string;
  peerName?: string;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

export interface Game {
  id: string;
  tableId: string;
  opponentId: string;
  opponentName: string;
  size: number;
  board: ('X' | 'O' | null)[];
  mine: 'X' | 'O';
  turn: 'X' | 'O';
  winner: 'X' | 'O' | 'draw' | null;
  winningLine: number[] | null;
  lastMove: number | null;
  score: { mine: number; opponent: number };
  drawOfferFrom: 'X' | 'O' | null;
  rematchFrom: 'X' | 'O' | null;
  turnStartedAt: string;
}

export interface SocialState {
  publicChat: Conversation;
  conversations: Conversation[];
  invites: Invite[];
  games: Game[];
}

export const journalMaxPhotosPerEntry = 4;
export const journalMaxPhotosPerGuest = 120;
export const journalMaxPhotoBytes = 1200 * 1024;
export const journalMaxNoteLength = 300;

export type JournalPhotoMime = 'image/jpeg' | 'image/webp' | 'image/png';

export interface JournalPhoto {
  id: string;
  url: string;
  downloadUrl: string;
  mime: JournalPhotoMime;
  width: number;
  height: number;
  favorite: boolean;
  createdAt: string;
}

export interface JournalEntry {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt?: string | null;
  tableId?: string | null;
  tableLabel?: string | null;
  floor?: FloorId | null;
  favorite: boolean;
  photos: JournalPhoto[];
}

export interface JournalSummary {
  totalPhotos: number;
  totalEntries: number;
  visitCount: number;
}

export interface JournalState {
  entries: JournalEntry[];
  summary: JournalSummary;
}
