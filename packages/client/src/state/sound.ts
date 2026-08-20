/**
 * Sound, synthesised rather than sampled. A wooden piece landing on a board is
 * a short filtered noise burst with a pitched body; generating it costs nothing
 * to download, which matters more on a headset than fidelity does.
 */
type Kind = 'move' | 'capture' | 'check' | 'win' | 'lose' | 'illegal' | 'ui';

let ctx: AudioContext | null = null;
let enabled = true;

const context = (): AudioContext | null => {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      enabled = false;
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
};

export const setSoundEnabled = (value: boolean): void => {
  enabled = value;
};

/** A short burst of filtered noise: the "clack" of a piece on wood. */
const clack = (audio: AudioContext, when: number, gain: number, freq: number) => {
  const length = Math.floor(audio.sampleRate * 0.06);
  const buffer = audio.createBuffer(1, length, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    // Exponential decay keeps it percussive instead of a hiss.
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length * 0.18));
  }
  const source = audio.createBufferSource();
  source.buffer = buffer;

  const filter = audio.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.6;

  const amp = audio.createGain();
  amp.gain.value = gain;

  source.connect(filter).connect(amp).connect(audio.destination);
  source.start(when);
};

const tone = (
  audio: AudioContext, when: number, freq: number, duration: number, gain: number,
  type: OscillatorType = 'sine',
) => {
  const osc = audio.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const amp = audio.createGain();
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(gain, when + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(when);
  osc.stop(when + duration + 0.02);
};

export const playSound = (kind: Kind): void => {
  const audio = context();
  if (!audio) return;
  const now = audio.currentTime;

  switch (kind) {
    case 'move':
      clack(audio, now, 0.35, 900);
      break;
    case 'capture':
      // Two clacks in quick succession: the captured piece leaving the board.
      clack(audio, now, 0.4, 700);
      clack(audio, now + 0.045, 0.28, 1200);
      break;
    case 'check':
      clack(audio, now, 0.35, 900);
      tone(audio, now + 0.03, 880, 0.18, 0.12, 'triangle');
      tone(audio, now + 0.12, 1174, 0.2, 0.1, 'triangle');
      break;
    case 'win':
      [523, 659, 784, 1047].forEach((f, i) => tone(audio, now + i * 0.1, f, 0.35, 0.12, 'triangle'));
      break;
    case 'lose':
      [440, 370, 294].forEach((f, i) => tone(audio, now + i * 0.14, f, 0.4, 0.11, 'sine'));
      break;
    case 'illegal':
      tone(audio, now, 160, 0.14, 0.1, 'sawtooth');
      break;
    case 'ui':
      tone(audio, now, 1320, 0.05, 0.05, 'sine');
      break;
  }
};
