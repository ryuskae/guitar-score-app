export const TICKS_PER_QUARTER = 8;
export const MEASURE_TICKS = 32;
export const TUNING = [64, 59, 55, 50, 45, 40];

let nextId = 1;

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${nextId++}`;
}

export function createNote({ midi = 64, string = 1, fret = 0, duration = 8, dotted = false, grace = false } = {}) {
  return {
    id: uid('note'), midi, string, fret, duration, dotted, grace,
    tieToNext: false, slurTo: null,
  };
}

export function createMeasure() {
  return { id: uid('measure'), forceBreakAfter: false, voices: [[], [], [], []], annotations: [] };
}

export function createScore() {
  return {
    page: 'A4', instrument: 'classical-guitar', showTab: true, textFont: 'Georgia, serif', measuresPerSystem: 3, systemSpacing: 245, timeSignature: { beats: 4, beatType: 4 },
    metadata: { title: '', lyricist: '', composer: '' },
    measures: [createMeasure()], annotations: [], activeVoice: 0, voiceCount: 1,
    selection: { measure: 0, voice: 0, noteId: null, source: 'staff', cursorTick: 0, rangeEnd: null },
  };
}

export function durationTicks(note) {
  if (note.grace) return 0;
  if (Number.isFinite(note.ticks)) return note.ticks;
  const dots=Number.isFinite(note.dots)?note.dots:(note.dotted?1:0);
  let multiplier=1, fraction=.5;
  for(let index=0;index<dots;index++){multiplier+=fraction;fraction/=2;}
  return note.duration*multiplier;
}

export function measureTicks(measure, voice) {
  return measure.voices[voice].reduce((sum, note) => sum + durationTicks(note), 0);
}

export function timeSignatureTicks(timeSignature) {
  return timeSignature.beats * TICKS_PER_QUARTER * (4 / timeSignature.beatType);
}

export function groupingTicks(timeSignature) {
  // In compound meters, notes group by dotted-quarter beats (6/8, 9/8, 12/8).
  if (timeSignature.beatType === 8 && timeSignature.beats >= 6 && timeSignature.beats % 3 === 0) return TICKS_PER_QUARTER * 1.5;
  return TICKS_PER_QUARTER * (4 / timeSignature.beatType);
}

export function noteFromStringFret(string, fret, duration = 8, dotted = false, grace = false) {
  const s = Math.max(1, Math.min(6, string));
  const f = Math.max(0, Math.min(30, fret));
  return createNote({ midi: TUNING[s - 1] + f, string: s, fret: f, duration, dotted, grace });
}

export function positionsForMidi(midi) {
  return TUNING.map((open, index) => ({ string: index + 1, fret: midi - open }))
    .filter(({ fret }) => fret >= 0 && fret <= 30);
}

export function cloneScore(score) {
  return JSON.parse(JSON.stringify(score));
}

export function ensureMeasure(score, index) {
  while (score.measures.length <= index) score.measures.push(createMeasure());
  return score.measures[index];
}

export function allNotes(score, voice = score.activeVoice) {
  return score.measures.flatMap((measure, measureIndex) =>
    measure.voices[voice].map((note) => ({ note, measure, measureIndex, voice }))
  );
}
