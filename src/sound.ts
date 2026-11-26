const storageKey = 'xuong_chat_sound';
let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!context) context = new AudioCtx();
  if (context.state === 'suspended') void context.resume().catch(() => {});
  return context;
}

export function loadSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem(storageKey) !== '0';
  } catch {
    return true;
  }
}

export function saveSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(storageKey, enabled ? '1' : '0');
  } catch {
    // Ignore storage errors in restricted browsing modes.
  }
}

export function unlockAudio(): void {
  audioContext();
}

export function playMessageSound(subtle = false): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  const peak = subtle ? 0.06 : 0.11;
  const notes = subtle ? [659.25] : [587.33, 880];

  notes.forEach((frequency, index) => {
    const start = now + index * 0.075;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.2);
  });
}

export function playCaroMoveSound(isMine = true): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(isMine ? 360 : 280, now);
  oscillator.frequency.exponentialRampToValueAtTime(isMine ? 165 : 130, now + 0.065);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.11, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.085);
}

export function playCaroWinSound(won: boolean): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  const notes = won ? [523.25, 659.25, 783.99] : [440, 349.23];
  notes.forEach((frequency, index) => {
    const start = now + index * 0.09;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.09, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.26);
  });
}

export function playCaroInviteSound(): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  [698.46, 880].forEach((frequency, index) => {
    const start = now + index * 0.085;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.095, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.24);
  });
}

export function playPuzzleSlideSound(): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(320, now);
  oscillator.frequency.exponentialRampToValueAtTime(190, now + 0.048);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.085, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.065);
}

export function playPuzzleWinSound(): void {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
    const start = now + index * 0.085;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.09, start + 0.014);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.26);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.28);
  });
}
