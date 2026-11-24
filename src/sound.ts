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
