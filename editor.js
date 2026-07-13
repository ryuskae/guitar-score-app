import {
  MEASURE_TICKS, TUNING, createScore, createMeasure, noteFromStringFret,
  durationTicks, measureTicks, positionsForMidi, cloneScore, allNotes,
} from './editor-model.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const scoreSvg = $('#score');
const sheet = $('#sheet');
const status = $('#status');
let score = createScore();
let duration = 8;
let dotted = false;
let restMode = false;
let graceMode = false;
let fretBuffer = '';
let undoStack = [];

const PITCH_BY_CODE = { KeyA: 69, KeyB: 71, KeyC: 60, KeyD: 62, KeyE: 64, KeyF: 65, KeyG: 67 };
const VOICE_COLORS = ['검정', '파랑', '빨강', '초록'];

function svg(tag, attrs = {}, parent = scoreSvg) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value);
  }
  parent.appendChild(el);
  return el;
}

function remember() {
  undoStack.push(cloneScore(score));
  if (undoStack.length > 80) undoStack.shift();
}

function selectedEntry() {
  const s = score.selection;
  const measure = score.measures[s.measure];
  if (!measure || !s.noteId) return null;
  const note = measure.voices[s.voice].find((n) => n.id === s.noteId);
  return note ? { note, measure, measureIndex: s.measure, voice: s.voice } : null;
}

function setSelection(measure, voice, noteId = null, extend = false) {
  if (extend && score.selection.noteId) {
    score.selection.rangeEnd = { measure, voice, noteId };
  } else {
    score.selection = { measure, voice, noteId, rangeEnd: null };
    score.activeVoice = voice;
  }
  fretBuffer = '';
  updateControls();
  render();
}

function notePosition(note, measure, voice) {
  let tick = 0;
  for (const n of measure.voices[voice]) {
    if (n.id === note.id) return tick;
    tick += durationTicks(n);
  }
  return tick;
}

function systems() {
  const groups = [];
  let current = [];
  const perSystem = score.page === 'A3' ? 4 : score.page === 'Screen' ? 4 : 3;
  score.measures.forEach((measure, index) => {
    current.push({ measure, index });
    if (measure.forceBreakAfter || current.length >= perSystem) {
      groups.push(current); current = [];
    }
  });
  if (current.length) groups.push(current);
  return groups;
}

const DIATONIC_STEP = [0,0,1,1,2,3,3,4,4,5,5,6];
const SHARP_PITCH_CLASSES = new Set([1,3,6,8,10]);

function writtenMidi(midi) {
  return score.instrument === 'piano' ? midi : midi + 12;
}

function pitchY(midi, baseY) {
  const written = writtenMidi(midi);
  const octave = Math.floor(written / 12) - 1;
  const pitchClass = ((written % 12) + 12) % 12;
  const diatonic = octave * 7 + DIATONIC_STEP[pitchClass];
  const bottomLineE4 = 4 * 7 + 2;
  return baseY + 32 - (diatonic - bottomLineE4) * 4;
}

function drawLedgerLines(x, y, staffY, group) {
  const top = staffY, bottom = staffY + 32;
  if (y <= top - 8) for (let yy = top - 8; yy >= y - 1; yy -= 8) svg('line', { x1:x-9, y1:yy, x2:x+9, y2:yy, class:'ledger-line' }, group);
  if (y >= bottom + 8) for (let yy = bottom + 8; yy <= y + 1; yy += 8) svg('line', { x1:x-9, y1:yy, x2:x+9, y2:yy, class:'ledger-line' }, group);
}

function drawNote(note, measure, measureIndex, voice, x, staffY, tabY, group) {
  const selected = score.selection.noteId === note.id;
  const inactive = voice !== score.activeVoice;
  const cls = `voice-${voice} ${selected ? 'selected' : ''} ${inactive ? 'inactive-voice' : ''}`;
  const g = svg('g', { class: cls, 'data-note-id':note.id }, group);
  const y = pitchY(note.midi, staffY);
  if (note.rest) {
    svg('text', { x, y:staffY+28, class:'rest', text: note.grace ? '𝄽' : '𝄾' }, g);
  } else {
    drawLedgerLines(x, y, staffY, g);
    if (SHARP_PITCH_CLASSES.has(((writtenMidi(note.midi)%12)+12)%12)) svg('text', { x:x-14, y:y+4, text:'♯', 'font-size':14, 'font-family':'serif' }, g);
    const scale = note.grace ? .7 : 1;
    svg('ellipse', { cx:x, cy:y, rx:6*scale, ry:4.3*scale, transform:`rotate(-18 ${x} ${y})`, class:'notehead' }, g);
    if (note.duration < 32) svg('line', { x1:x+5*scale, y1:y, x2:x+5*scale, y2:y-27*scale, class:'stem' }, g);
    if (note.duration <= 4) svg('path', { d:`M${x+5},${y-27} q11,6 2,15`, fill:'none', class:'stem' }, g);
    if (note.duration <= 2) svg('path', { d:`M${x+5},${y-20} q11,6 2,15`, fill:'none', class:'stem' }, g);
    if (note.dotted) svg('circle', { cx:x+10, cy:y, r:1.8, class:'notehead' }, g);
  }
  svg('rect', { x:x-13, y:staffY-2, width:26, height:58, class:'hit' }, g)
    .addEventListener('click', (e) => { e.stopPropagation(); setSelection(measureIndex, voice, note.id, e.shiftKey); });

  if (!note.rest && score.instrument !== 'piano') {
    const tg = svg('g', { class:selected ? 'selected' : '', 'data-tab-note-id':note.id }, group);
    const ty = tabY + (note.string - 1) * 9;
    const label = String(note.fret);
    const width = Math.max(14, label.length * 9 + 5);
    svg('rect', { x:x-width/2, y:ty-8, width, height:16, rx:1, class:'tab-bg' }, tg);
    svg('text', { x, y:ty+.5, class:'tab-number', text:label }, tg);
    svg('rect', { x:x-13, y:ty-11, width:26, height:22, class:'hit' }, tg)
      .addEventListener('click', (e) => { e.stopPropagation(); setSelection(measureIndex, voice, note.id, e.shiftKey); });
  }
}

function endpointFor(ref, layouts) {
  if (!ref) return null;
  const layout = layouts.get(ref.measure);
  const measure = score.measures[ref.measure];
  const note = measure?.voices[ref.voice]?.find((n) => n.id === ref.noteId);
  if (!layout || !note) return null;
  const tick = notePosition(note, measure, ref.voice);
  return {
    x: layout.x + layout.noteLeft + (tick / MEASURE_TICKS) * layout.noteWidth,
    noteY: pitchY(note.midi, layout.staffY), tabNoteY:layout.tabY+(note.string-1)*9,
    staffY:layout.staffY, tabY:layout.tabY, system:layout.system,
  };
}

function drawAnnotations(layouts) {
  const bounds = new Map();
  for (const layout of layouts.values()) {
    const current = bounds.get(layout.system) || { left:layout.x, right:layout.x+layout.width, staffY:layout.staffY, tabY:layout.tabY };
    current.left = Math.min(current.left, layout.x); current.right = Math.max(current.right, layout.x+layout.width);
    bounds.set(layout.system, current);
  }
  for (const ann of score.annotations) {
    let a = endpointFor(ann.start, layouts), b = endpointFor(ann.end, layouts);
    if (!a || !b) continue;
    if (a.system > b.system || (a.system === b.system && a.x > b.x)) [a,b] = [b,a];
    if (ann.type === 'slur' || ann.type === 'tie') {
      const rise = ann.type === 'slur' ? 20 : 9;
      const curve = (x1, y1, x2, y2, controlY) => svg('path', { d:`M${x1},${y1} Q${(x1+x2)/2},${controlY} ${x2},${y2}`, class:ann.type });
      const drawOnSystem = (system, x1, x2) => {
        const bound = bounds.get(system);
        const y = bound.staffY + (ann.type === 'slur' ? 2 : 39);
        curve(x1, y, x2, y, ann.type === 'slur' ? y-rise : y+rise);
        if (ann.type === 'slur' && score.instrument !== 'piano') {
          const tabCurveY=bound.tabY-7; curve(x1, tabCurveY, x2, tabCurveY, tabCurveY-rise);
        }
      };
      if (a.system === b.system) {
        const y1 = a.noteY + (ann.type === 'slur' ? -7 : 7);
        const y2 = b.noteY + (ann.type === 'slur' ? -7 : 7);
        const control = ann.type === 'slur' ? Math.min(y1,y2)-rise : Math.max(y1,y2)+rise;
        curve(a.x, y1, b.x, y2, control);
        if (ann.type === 'slur' && score.instrument !== 'piano') {
          const ty1=a.tabNoteY-9, ty2=b.tabNoteY-9;
          curve(a.x, ty1, b.x, ty2, Math.min(ty1,ty2)-13);
        }
      }
      else {
        drawOnSystem(a.system, a.x, bounds.get(a.system).right-3);
        for (let system=a.system+1; system<b.system; system++) drawOnSystem(system, bounds.get(system).left+3, bounds.get(system).right-3);
        drawOnSystem(b.system, bounds.get(b.system).left+3, b.x);
      }
    } else if (ann.type === 'barre') {
      const y = bounds.get(a.system).staffY - 12;
      svg('text', { x:a.x, y:y-4, class:'annotation-text', text:ann.text });
      if (a.system === b.system) svg('path', { d:`M${a.x+28},${y} H${b.x+10} v9`, class:'barre' });
      else {
        svg('path', { d:`M${a.x+28},${y} H${bounds.get(a.system).right-3}`, class:'barre' });
        for (let system=a.system+1; system<b.system; system++) {
          const bound=bounds.get(system); svg('path', { d:`M${bound.left+3},${bound.staffY-12} H${bound.right-3}`, class:'barre' });
        }
        const endBound=bounds.get(b.system);
        svg('path', { d:`M${endBound.left+3},${endBound.staffY-12} H${b.x+10} v9`, class:'barre' });
      }
    }
  }
}

function render() {
  scoreSvg.replaceChildren();
  $('#printTitle').textContent = score.metadata.title;
  $('#printLyricist').textContent = score.metadata.lyricist ? `작사: ${score.metadata.lyricist}` : '';
  $('#printComposer').textContent = score.metadata.composer ? `작곡: ${score.metadata.composer}` : '';
  sheet.dataset.page = score.page;
  const width = score.page === 'Screen' ? 1100 : score.page === 'A3' ? 1000 : 720;
  const sys = systems();
  const systemHeight = 190, top = 28;
  scoreSvg.setAttribute('viewBox', `0 0 ${width} ${Math.max(220, top + sys.length * systemHeight)}`);
  scoreSvg.style.height = `${Math.max(220, top + sys.length * systemHeight)}px`;
  const layouts = new Map();
  sys.forEach((items, systemIndex) => {
    const y = top + systemIndex * systemHeight;
    const staffY = y + 24, tabY = y + 103;
    const left = 18, usable = width - 36;
    const measureWidth = usable / items.length;
    svg('text', { x:left+6, y:staffY+29, text:'𝄞', 'font-size':39, 'font-family':'serif' });
    const piano = score.instrument === 'piano';
    svg('text', { x:left+(piano?6:5), y:tabY+(piano?29:27), text:piano?'𝄢':'TAB', 'font-size':piano?36:11, 'font-family':'serif', 'font-weight':700 });
    for (let line = 0; line < 5; line++) svg('line', { x1:left, y1:staffY+line*8, x2:left+usable, y2:staffY+line*8, class:'staff-line' });
    for (let line = 0; line < (piano?5:6); line++) svg('line', { x1:left, y1:tabY+line*(piano?8:9), x2:left+usable, y2:tabY+line*(piano?8:9), class:piano?'staff-line':'tab-line' });
    items.forEach(({ measure, index }, localIndex) => {
      const x = left + localIndex * measureWidth;
      const noteLeft = localIndex === 0 ? 58 : 25;
      const noteWidth = measureWidth - noteLeft - 14;
      layouts.set(index, { x, width:measureWidth, noteLeft, noteWidth, staffY, tabY, system:systemIndex });
      if (score.selection.measure === index && !score.selection.noteId) svg('rect', { x, y:staffY-7, width:measureWidth, height:tabY+53-staffY, class:'selected-measure' });
      svg('rect', { x, y:staffY-9, width:measureWidth, height:tabY+58-staffY, class:'measure-hit' })
        .addEventListener('click', (e) => { e.stopPropagation(); setSelection(index, score.activeVoice, null, e.shiftKey); });
      svg('line', { x1:x, y1:staffY, x2:x, y2:staffY+32, class:'barline' });
      svg('line', { x1:x, y1:tabY, x2:x, y2:tabY+(piano?32:45), class:'barline' });
      svg('text', { x:x+5, y:staffY-5, text:String(index+1), 'font-size':9, fill:'#65718a' });
      for (let voice = 0; voice < measure.voices.length; voice++) {
        measure.voices[voice].forEach((note) => {
          const tick = notePosition(note, measure, voice);
          const nx = x + noteLeft + (tick / MEASURE_TICKS) * noteWidth + voice * 2;
          drawNote(note, measure, index, voice, nx, staffY, tabY, scoreSvg);
        });
      }
      if (measure.forceBreakAfter) svg('text', { x:x+measureWidth-14, y:staffY-5, text:'↵', class:'break-mark' });
    });
    const end = left + usable;
    svg('line', { x1:end, y1:staffY, x2:end, y2:staffY+32, class:'barline' });
    svg('line', { x1:end, y1:tabY, x2:end, y2:tabY+(piano?32:45), class:'barline' });
  });
  drawAnnotations(layouts);
  const entry = selectedEntry();
  status.textContent = entry
    ? `성부 ${entry.voice+1}(${VOICE_COLORS[entry.voice]}) · ${entry.measureIndex+1}마디 · ${entry.note.string}번 줄 ${entry.note.fret}프렛 · MIDI ${entry.note.midi}`
    : `성부 ${score.activeVoice+1}(${VOICE_COLORS[score.activeVoice]}) · ${score.selection.measure+1}마디 선택`;
}

function updateControls() {
  $('#voice').textContent = `V${score.activeVoice+1}`;
  $('#dot').classList.toggle('active', dotted);
  $('#rest').classList.toggle('active', restMode);
  $('#grace').classList.toggle('active', graceMode || !!selectedEntry()?.note.grace);
  document.querySelectorAll('[data-duration]').forEach((b) => b.classList.toggle('active', Number(b.dataset.duration) === duration));
}

function bestPosition(midi) {
  const choices = positionsForMidi(midi);
  return choices.sort((a,b) => a.fret-b.fret || a.string-b.string)[0] || { string:1, fret:Math.max(0,midi-TUNING[0]) };
}

function addNote(midi) {
  remember();
  let measureIndex = score.selection.measure;
  let measure = score.measures[measureIndex];
  if (measureTicks(measure, score.activeVoice) + duration * (dotted ? 1.5 : 1) > MEASURE_TICKS) {
    measureIndex++;
    if (!score.measures[measureIndex]) score.measures.push(createMeasure());
    measure = score.measures[measureIndex];
  }
  const pos = bestPosition(midi);
  const note = noteFromStringFret(pos.string, pos.fret, duration, dotted, graceMode);
  note.rest = restMode;
  measure.voices[score.activeVoice].push(note);
  score.selection = { measure:measureIndex, voice:score.activeVoice, noteId:note.id, rangeEnd:null };
  if (measureTicks(measure, score.activeVoice) >= MEASURE_TICKS && measureIndex === score.measures.length - 1) score.measures.push(createMeasure());
  graceMode = false;
  updateControls(); render();
}

function orderedSelection() {
  const start = score.selection.noteId ? { measure:score.selection.measure, voice:score.selection.voice, noteId:score.selection.noteId } : null;
  const end = score.selection.rangeEnd;
  if (!start) return null;
  return { start, end:end || start };
}

function addAnnotation(type) {
  let range = orderedSelection();
  if (!range) { status.textContent = '먼저 음표를 선택하세요. Shift+클릭하면 범위를 선택할 수 있습니다.'; return; }
  if ((type === 'slur' || type === 'tie') && !score.selection.rangeEnd) {
    const notes = allNotes(score, score.selection.voice);
    const index = notes.findIndex(({note}) => note.id === score.selection.noteId);
    const next = notes[index + 1];
    if (!next) { status.textContent = `${type === 'slur' ? '슬러' : '타이'}를 연결할 다음 음표가 없습니다.`; return; }
    range = { start:range.start, end:{ measure:next.measureIndex, voice:next.voice, noteId:next.note.id } };
  }
  remember();
  score.annotations.push({ type, ...range }); render();
}

function moveSelection(delta) {
  const list = allNotes(score, score.activeVoice);
  const index = list.findIndex(({note}) => note.id === score.selection.noteId);
  if (!list.length) return;
  const next = list[Math.max(0, Math.min(list.length-1, (index < 0 ? 0 : index) + delta))];
  setSelection(next.measureIndex, next.voice, next.note.id);
}

function moveAcrossStrings(direction) {
  const entry = selectedEntry(); if (!entry || entry.note.rest) return;
  const choices = positionsForMidi(entry.note.midi).sort((a,b) => a.string-b.string);
  const current = choices.findIndex((p) => p.string === entry.note.string);
  const next = choices[current + direction]; if (!next) return;
  remember(); entry.note.string = next.string; entry.note.fret = next.fret; render();
}

function changeFret(digit) {
  const entry = selectedEntry(); if (!entry || entry.note.rest) return;
  fretBuffer = (fretBuffer + digit).slice(-2);
  const fret = Math.min(30, Number(fretBuffer));
  remember(); entry.note.fret = fret; entry.note.midi = TUNING[entry.note.string-1] + fret; render();
}

function deleteSelected() {
  const entry = selectedEntry(); if (!entry) return;
  remember();
  entry.measure.voices[entry.voice] = entry.measure.voices[entry.voice].filter((n) => n.id !== entry.note.id);
  score.annotations = score.annotations.filter((a) => a.start.noteId !== entry.note.id && a.end.noteId !== entry.note.id);
  score.selection.noteId = null; render();
}

function escapeXml(value='') { return value.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])); }
const STEP = ['C','C','D','D','E','F','F','G','G','A','A','B'];
const ALTER = [0,1,0,1,0,0,1,0,1,0,1,0];

function toMusicXml() {
  const instrumentName = ({'classical-guitar':'Classical Guitar','acoustic-guitar':'Acoustic Guitar','electric-guitar':'Electric Guitar',piano:'Piano'})[score.instrument];
  const measures = score.measures.map((m, mi) => {
    let body = `${mi > 0 && score.measures[mi-1].forceBreakAfter ? '<print new-system="yes"/>' : ''}${mi === 0 ? `<attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>${score.instrument==='piano'?'':'<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>'}<clef number="1"><sign>G</sign><line>2</line></clef>${score.instrument==='piano'?'<clef number="2"><sign>F</sign><line>4</line></clef>':'<clef number="2"><sign>TAB</sign><line>5</line></clef><staff-details number="2"><staff-lines>6</staff-lines></staff-details>'}</attributes>` : ''}`;
    m.voices.forEach((voice, vi) => {
      if (vi && voice.length) body += '<backup><duration>32</duration></backup>';
      voice.forEach((n) => {
        const xmlMidi = score.instrument === 'piano' ? n.midi : n.midi + 12;
        const pc = ((xmlMidi%12)+12)%12, octave = Math.floor(xmlMidi/12)-1;
        body += `<note>${n.grace?'<grace/>':''}${n.rest?'<rest/>':`<pitch><step>${STEP[pc]}</step>${ALTER[pc]?'<alter>1</alter>':''}<octave>${octave}</octave></pitch>`}${n.grace?'':`<duration>${durationTicks(n)}</duration>`}<voice>${vi+1}</voice><type>${({32:'whole',16:'half',8:'quarter',4:'eighth',2:'16th'})[n.duration]||'quarter'}</type>${n.dotted?'<dot/>':''}<staff>1</staff>${n.rest||score.instrument==='piano'?'':`<notations><technical><string>${n.string}</string><fret>${n.fret}</fret></technical></notations>`}</note>`;
      });
    });
    return `<measure number="${mi+1}">${body}</measure>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${escapeXml(score.metadata.title)}</work-title></work><identification><creator type="composer">${escapeXml(score.metadata.composer)}</creator><creator type="lyricist">${escapeXml(score.metadata.lyricist)}</creator></identification><part-list><score-part id="P1"><part-name>${instrumentName}</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
}

function download(name, content, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], {type})); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importMusicXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('올바른 MusicXML 파일이 아닙니다.');
  const fresh = createScore(); fresh.measures = [];
  fresh.metadata.title = doc.querySelector('work-title')?.textContent || '';
  fresh.metadata.composer = doc.querySelector('creator[type="composer"]')?.textContent || '';
  fresh.metadata.lyricist = doc.querySelector('creator[type="lyricist"]')?.textContent || '';
  const importedInstrument = doc.querySelector('part-name')?.textContent?.toLowerCase() || '';
  fresh.instrument = importedInstrument.includes('piano') ? 'piano' : importedInstrument.includes('electric') ? 'electric-guitar' : importedInstrument.includes('acoustic') ? 'acoustic-guitar' : 'classical-guitar';
  const octaveChange = Number(doc.querySelector('transpose octave-change')?.textContent || 0);
  doc.querySelectorAll('part:first-of-type > measure').forEach((mx) => {
    const m = createMeasure();
    mx.querySelectorAll(':scope > note').forEach((nx) => {
      const voice = Math.max(0, Math.min(3, Number(nx.querySelector('voice')?.textContent || 1)-1));
      const string = Number(nx.querySelector('technical string')?.textContent || 1);
      const fretNode = nx.querySelector('technical fret');
      let midi;
      const pitch = nx.querySelector('pitch');
      if (pitch) {
        const steps = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
        midi = (Number(pitch.querySelector('octave')?.textContent)+1)*12 + steps[pitch.querySelector('step')?.textContent] + Number(pitch.querySelector('alter')?.textContent||0);
      } else midi = TUNING[string-1];
      const fret = fretNode ? Number(fretNode.textContent) : Math.max(0, midi-TUNING[string-1]);
      const note = noteFromStringFret(string, fret, Math.max(1, Number(nx.querySelector('duration')?.textContent||8)), !!nx.querySelector('dot'), !!nx.querySelector('grace'));
      note.midi = fretNode && fresh.instrument !== 'piano' ? TUNING[string-1] + fret : midi + octaveChange * 12;
      note.rest = !!nx.querySelector('rest'); m.voices[voice].push(note);
    });
    if (mx.querySelector('print[new-system="yes"]') && fresh.measures.length) fresh.measures.at(-1).forceBreakAfter = true;
    fresh.measures.push(m);
  });
  if (!fresh.measures.length) fresh.measures.push(createMeasure());
  remember(); score = fresh; syncMetadataInputs(); updateControls(); render();
}

function syncMetadataInputs() {
  ['title','lyricist','composer'].forEach((key) => { $(`#${key}`).value = score.metadata[key] || ''; });
  $('#page').value = score.page;
  $('#instrument').value = score.instrument;
}

document.querySelectorAll('[data-duration]').forEach((button) => button.addEventListener('click', () => { duration = Number(button.dataset.duration); updateControls(); }));
$('#dot').addEventListener('click', () => {
  const entry=selectedEntry();
  if(entry){ remember();entry.note.dotted=!entry.note.dotted;dotted=entry.note.dotted; }
  else dotted=!dotted;
  updateControls();render();
});
$('#rest').addEventListener('click', () => { restMode=!restMode; updateControls(); });
$('#voice').addEventListener('click', () => { score.activeVoice=(score.activeVoice+1)%4; score.selection.voice=score.activeVoice; score.selection.noteId=null; updateControls();render(); });
$('#grace').addEventListener('click', () => { const e=selectedEntry();if(e){remember();e.note.grace=!e.note.grace;}else graceMode=!graceMode;updateControls();render(); });
$('#tie').addEventListener('click', () => addAnnotation('tie'));
$('#slur').addEventListener('click', () => addAnnotation('slur'));
$('#barre').addEventListener('click', () => { const range=orderedSelection();if(!range){status.textContent='바레 시작 음표를 선택하고 Shift+클릭으로 끝 음표를 고르세요.';return;}const fret=selectedEntry()?.note.fret||5;const value=prompt('바레 프렛 번호', String(fret));if(value===null)return;remember();score.annotations.push({type:'barre',...range,text:`C.${Math.max(1,Number(value)||5)}`});render(); });
$('#undo').addEventListener('click', () => { if(!undoStack.length)return;score=undoStack.pop();syncMetadataInputs();updateControls();render(); });
$('#clear').addEventListener('click', () => { remember();score.measures=[createMeasure()];score.annotations=[];score.selection={measure:0,voice:score.activeVoice,noteId:null,rangeEnd:null};render(); });
$('#page').addEventListener('change', (e) => { score.page=e.target.value;render(); });
$('#instrument').addEventListener('change', (e) => { score.instrument=e.target.value;render(); });
['title','lyricist','composer'].forEach((key) => $(`#${key}`).addEventListener('input', (e) => { score.metadata[key]=e.target.value;render(); }));
$('#xmlExport').addEventListener('click', () => download(`${score.metadata.title||'score'}.musicxml`,toMusicXml(),'application/vnd.recordare.musicxml+xml'));
$('#xmlImport').addEventListener('change', async (e) => { try{const file=e.target.files[0];if(file)importMusicXml(await file.text());}catch(err){alert(err.message);}e.target.value=''; });
$('#pdf').addEventListener('click', () => {
  let printStyle = $('#printPageSize');
  if (!printStyle) { printStyle=document.createElement('style');printStyle.id='printPageSize';document.head.append(printStyle); }
  const page = ['A3','A4','Letter'].includes(score.page) ? score.page : 'A4';
  printStyle.textContent = `@page { size: ${page} portrait; margin: 0; }`;
  window.print();
});
$('#help').addEventListener('click', () => $('#helpDialog').showModal());
$('#helpDialog button').addEventListener('click', () => $('#helpDialog').close());

document.addEventListener('keydown', (e) => {
  if (e.target?.matches?.('input,select,textarea') || $('#helpDialog').open) return;
  if (PITCH_BY_CODE[e.code] != null) { e.preventDefault(); addNote(PITCH_BY_CODE[e.code]); return; }
  if (e.code === 'Period' || e.code === 'NumpadDecimal') { e.preventDefault();$('#dot').click();return; }
  if (/^Digit\d$/.test(e.code) || /^Numpad\d$/.test(e.code)) { e.preventDefault(); changeFret(e.code.at(-1)); return; }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') { e.preventDefault(); moveSelection(e.code==='ArrowLeft'?-1:1); }
  else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { e.preventDefault(); moveAcrossStrings(e.code==='ArrowUp'?-1:1); }
  else if (e.code === 'Enter') {
    e.preventDefault(); remember();
    const index = score.selection.measure;
    score.measures[index].forceBreakAfter = !score.measures[index].forceBreakAfter;
    if (score.measures[index].forceBreakAfter && index === score.measures.length-1) score.measures.push(createMeasure());
    render();
  }
  else if (e.code === 'KeyV') { e.preventDefault();$('#voice').click(); }
  else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault();deleteSelected(); }
  else if (e.code === 'Escape') { score.selection.rangeEnd=null;render(); }
});

syncMetadataInputs(); updateControls(); render();

export { score, toMusicXml, importMusicXml, pitchY, writtenMidi };
