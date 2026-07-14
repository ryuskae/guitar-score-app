import {
  TUNING, createScore, createMeasure, noteFromStringFret,
  durationTicks, measureTicks, positionsForMidi, cloneScore, allNotes, timeSignatureTicks, groupingTicks,
} from './editor-model.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const scoreSvg = $('#score');
const sheet = $('#sheet');
const status = $('#status');
const VF = window.Vex?.Flow;
const STAFF_LINE_GAP = 15;
const STAFF_HEIGHT = STAFF_LINE_GAP * 4;
const TAB_LINE_GAP = 12;
const TAB_HEIGHT = TAB_LINE_GAP * 5;
const TAB_VOICE_OFFSET = [0, 7, -7, 13];
let score = createScore();
let duration = 8;
let dotted = false;
let restMode = false;
let graceMode = false;
let fretBuffer = '';
let undoStack = [];
let dragAnchor = null;
let dragMoved = false;
let ignoreNextClick = false;
let renderedNotes = new Map();
let measureWarning = null;
let warningTimer = null;

// Keyboard letters enter the lower guitar octave by default: C3–B3.
const PITCH_BY_CODE = { KeyA: 57, KeyB: 59, KeyC: 48, KeyD: 50, KeyE: 52, KeyF: 53, KeyG: 55 };
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

function setSelection(measure, voice, noteId = null, extend = false, source = 'staff') {
  if (extend && score.selection.noteId) {
    score.selection.rangeEnd = { measure, voice, noteId };
  } else {
    score.selection = { measure, voice, noteId, source, rangeEnd: null };
    score.activeVoice = voice;
  }
  fretBuffer = '';
  updateControls();
  render();
}

function beginRangeSelection(event, measure, voice, noteId, source) {
  if (event.button !== 0) return;
  event.preventDefault();
  dragAnchor = { measure, voice, noteId, source };
  dragMoved = false;
  setSelection(measure, voice, noteId, false, source);
}

function extendRangeSelection(measure, voice, noteId) {
  if (!dragAnchor || (dragAnchor.measure === measure && dragAnchor.voice === voice && dragAnchor.noteId === noteId)) return;
  dragMoved = true;
  score.selection.rangeEnd = { measure, voice, noteId };
  updateControls();
  render();
}

document.addEventListener('pointerup', () => {
  if (dragMoved) ignoreNextClick = true;
  dragAnchor = null;
  dragMoved = false;
});

function notePosition(note, measure, voice) {
  let tick = 0;
  for (const n of measure.voices[voice]) {
    if (n.id === note.id) return tick;
    tick += durationTicks(n);
  }
  return tick;
}

function measureLimit() { return timeSignatureTicks(score.timeSignature); }

function showMeasureWarning(measureIndex, message='마디의 박자 길이를 초과할 수 없습니다.') {
  measureWarning={measureIndex,message};
  clearTimeout(warningTimer);
  render();
  warningTimer=setTimeout(()=>{measureWarning=null;render();},2600);
}

function noteFitsMeasure(measure, voice, note, dottedValue=note.dotted, durationValue=note.duration) {
  const used=measure.voices[voice].reduce((sum,item)=>sum+(item.id===note.id?0:durationTicks(item)),0);
  const proposed=note.grace?0:durationValue*(dottedValue?1.5:1);
  return used+proposed<=measureLimit();
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
  return baseY + STAFF_HEIGHT - (diatonic - bottomLineE4) * (STAFF_LINE_GAP / 2);
}

function drawLedgerLines(x, y, staffY, group) {
  const top = staffY, bottom = staffY + STAFF_HEIGHT;
  if (y <= top - STAFF_LINE_GAP) for (let yy = top - STAFF_LINE_GAP; yy >= y - 1; yy -= STAFF_LINE_GAP) svg('line', { x1:x-10, y1:yy, x2:x+10, y2:yy, class:'ledger-line' }, group);
  if (y >= bottom + STAFF_LINE_GAP) for (let yy = bottom + STAFF_LINE_GAP; yy <= y + 1; yy += STAFF_LINE_GAP) svg('line', { x1:x-10, y1:yy, x2:x+10, y2:yy, class:'ledger-line' }, group);
}

function drawNote(note, measure, measureIndex, voice, x, staffY, tabY, group, beamLevel = 0, beamEndY = null) {
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
    const stemUp = voice % 2 === 0;
    const stemX = x + (stemUp ? 5 : -5) * scale;
    // A beamed note's stem must meet the beam itself.  Keeping the old fixed
    // stem length here made large leaps punch through the beam.
    const stemEndY = beamEndY ?? (y + (stemUp ? -45 : 45) * scale);
    svg('ellipse', { cx:x, cy:y, rx:7*scale, ry:5*scale, transform:`rotate(-18 ${x} ${y})`, class:'notehead' }, g);
    if (note.duration < 32) svg('line', { x1:stemX, y1:y, x2:stemX, y2:stemEndY, class:'stem' }, g);
    if (note.duration <= 4 && beamLevel < 1) svg('path', { d:stemUp?`M${stemX},${stemEndY} q13,7 2,18`:`M${stemX},${stemEndY} q-13,-7 -2,-18`, fill:'none', class:'stem' }, g);
    if (note.duration <= 2 && beamLevel < 2) svg('path', { d:stemUp?`M${stemX},${stemEndY+9} q13,7 2,18`:`M${stemX},${stemEndY-9} q-13,-7 -2,-18`, fill:'none', class:'stem' }, g);
    if (note.dotted) svg('circle', { cx:x+12, cy:y, r:2, class:'notehead' }, g);
  }
  const staffHit = svg('rect', { x:x-15, y:staffY-12, width:30, height:STAFF_HEIGHT+24, class:'hit' }, g);
  staffHit.addEventListener('pointerdown', (e) => beginRangeSelection(e, measureIndex, voice, note.id, 'staff'));
  staffHit.addEventListener('pointerenter', () => extendRangeSelection(measureIndex, voice, note.id));
  staffHit.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ignoreNextClick) { ignoreNextClick=false; return; }
    setSelection(measureIndex, voice, note.id, e.shiftKey, 'staff');
  });

  if (!note.rest && score.instrument !== 'piano') {
    const tabX = x + TAB_VOICE_OFFSET[voice];
    const tg = svg('g', { class:`tab-voice-${voice} ${selected?'selected':''} ${inactive?'inactive-voice':''}`, 'data-tab-note-id':note.id }, group);
    const ty = tabY + (note.string - 1) * TAB_LINE_GAP;
    const label = String(note.fret);
    const width = Math.max(14, label.length * 9 + 5);
    svg('rect', { x:tabX-width/2, y:ty-8, width, height:16, rx:1, class:'tab-bg' }, tg);
    svg('text', { x:tabX, y:ty+.5, class:'tab-number', text:label }, tg);
    const tabHit=svg('rect', { x:tabX-13, y:ty-11, width:26, height:22, class:'hit' }, tg);
    tabHit.addEventListener('pointerdown', (e) => beginRangeSelection(e, measureIndex, voice, note.id, 'tab'));
    tabHit.addEventListener('pointerenter', () => extendRangeSelection(measureIndex, voice, note.id));
    tabHit.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ignoreNextClick) { ignoreNextClick=false; return; }
      setSelection(measureIndex, voice, note.id, e.shiftKey, 'tab');
    });
  }
}

function beamData(measure, voice) {
  const levels = new Map();
  const groups = [];
  const beatLength = 8 * (4 / score.timeSignature.beatType);
  const compound = score.timeSignature.beatType === 8 && score.timeSignature.beats >= 6 && score.timeSignature.beats % 3 === 0;
  // In 4/4, consecutive eighths conventionally read as 1–2 | 3–4:
  // four eighths per beam.  Sixteenths still reveal every quarter-note beat.
  const eighthGroupLength = score.timeSignature.beats === 4 && score.timeSignature.beatType === 4
    ? beatLength * 2 : groupingTicks(score.timeSignature);
  let tick = 0, current = [], groupIndex = null;
  const flush = () => {
    if (current.length > 1) {
      current.forEach(({note}) => levels.set(note.id, 1));
      groups.push(current);
      // Every sixteenth in a primary group belongs to a second beam (a
      // singleton gets a short secondary hook rather than a flag).
      current.filter(({note}) => note.duration <= 2).forEach(({note}) => levels.set(note.id, 2));
    }
    current=[]; groupIndex=null;
  };
  for (const note of measure.voices[voice]) {
    const groupLength = (note.duration <= 2 || current.some((item) => item.note.duration <= 2))
      ? (compound ? groupingTicks(score.timeSignature) : beatLength) : eighthGroupLength;
    const currentGroup=Math.floor(tick / groupLength);
    if (note.rest || note.duration > 4 || (groupIndex !== null && currentGroup !== groupIndex)) flush();
    if (!note.rest && note.duration <= 4) {
      if (groupIndex === null) groupIndex=currentGroup;
      current.push({note,tick});
    }
    tick += durationTicks(note);
  }
  flush();
  return { levels, groups };
}

function beamGeometry(groups, positions, voice) {
  const stemUp = voice % 2 === 0;
  const endpoints = new Map();
  for (const notes of groups) {
    const first = positions.get(notes[0].note.id), last = positions.get(notes.at(-1).note.id);
    if (!first || !last) continue;
    // Engraving convention: beams only slope gently, then every stem extends
    // exactly to that line.  This also keeps sudden leaps visually clean.
    const slope = Math.max(-12, Math.min(12, (last.y - first.y) * 0.25));
    const startY = first.y + (stemUp ? -42 : 42);
    const dx = Math.max(1, last.x - first.x);
    notes.forEach((item) => {
      const p = positions.get(item.note.id);
      endpoints.set(item.note.id, startY + slope * ((p.x - first.x) / dx));
    });
  }
  return endpoints;
}

function drawBeams(groups, positions, voice, group, endpoints) {
  const stemUp = voice % 2 === 0;
  const endpoint = (item, level = 0) => {
    const position=positions.get(item.note.id);
    return { x:position.x+(stemUp?5:-5), y:(endpoints.get(item.note.id) ?? position.y+(stemUp?-42:42))+(stemUp?-1:1)*level*9 };
  };
  for (const notes of groups) {
    const first=endpoint(notes[0]), last=endpoint(notes.at(-1));
    svg('line',{x1:first.x,y1:first.y,x2:last.x,y2:last.y,class:'beam'},group);
    let secondary=[];
    const flushSecondary=()=>{
      if(secondary.length>1) {
        const a=endpoint(secondary[0],1),b=endpoint(secondary.at(-1),1);
        svg('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:'beam secondary-beam'},group);
      } else if (secondary.length === 1) {
        // A lone sixteenth receives a short hook, following the nearest
        // rhythmic neighbour just like conventional beaming.
        const item = secondary[0], index = notes.indexOf(item);
        const toward = notes[index + 1] || notes[index - 1];
        const a = endpoint(item, 1);
        const direction = toward && toward.tick < item.tick ? -1 : 1;
        svg('line', { x1:a.x, y1:a.y, x2:a.x + direction * 10, y2:a.y, class:'beam secondary-beam' }, group);
      }
      secondary=[];
    };
    notes.forEach((item)=>{ if(item.note.duration<=2) secondary.push(item); else flushSecondary(); });
    flushSecondary();
  }
}

function endpointFor(ref) {
  if (!ref) return null;
  return renderedNotes.get(ref.noteId) || null;
}

const VEX_DURATION = { 32:'w', 16:'h', 8:'q', 4:'8', 2:'16', 1:'32' };
const VEX_NAMES = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];

function vexDuration(note, rest=false) {
  const base = VEX_DURATION[note.duration] || 'q';
  return `${base}${note.dotted?'d':''}${rest?'r':''}`;
}

function vexKey(midi) {
  const value=writtenMidi(midi), pc=((value%12)+12)%12, octave=Math.floor(value/12)-1;
  return `${VEX_NAMES[pc]}/${octave}`;
}

function selectionOrder() {
  const entries=[];
  score.measures.forEach((measure, measureIndex) => measure.voices.forEach((voice, voiceIndex) => {
    let tick=0;
    voice.forEach((note) => { entries.push({note,measure:measureIndex,voice:voiceIndex,tick});tick+=durationTicks(note); });
  }));
  return entries.sort((a,b)=>a.measure-b.measure||a.tick-b.tick||a.voice-b.voice);
}

function selectedIds() {
  const ids=new Set();
  if(!score.selection.noteId) return ids;
  if(!score.selection.rangeEnd){ids.add(score.selection.noteId);return ids;}
  const ordered=selectionOrder();
  let a=ordered.findIndex((item)=>item.note.id===score.selection.noteId);
  let b=ordered.findIndex((item)=>item.note.id===score.selection.rangeEnd.noteId);
  if(a<0||b<0)return ids;
  if(a>b)[a,b]=[b,a];
  ordered.slice(a,b+1).forEach((item)=>ids.add(item.note.id));
  return ids;
}

function drawAnnotations(layouts) {
  const bounds = new Map();
  for (const layout of layouts.values()) {
    const current = bounds.get(layout.system) || { left:layout.x, right:layout.x+layout.width, staffY:layout.staffY, tabY:layout.tabY };
    current.left = Math.min(current.left, layout.x); current.right = Math.max(current.right, layout.x+layout.width);
    bounds.set(layout.system, current);
  }
  for (const ann of score.annotations) {
    let a = endpointFor(ann.start), b = endpointFor(ann.end);
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
        const slurBelow = ann.type === 'slur' && ann.start.voice % 2 === 0;
        const below = slurBelow || ann.type === 'tie';
        const y1 = a.noteY + (below ? 8 : -8);
        const y2 = b.noteY + (below ? 8 : -8);
        const control = below ? Math.max(y1,y2)+rise : Math.min(y1,y2)-rise;
        curve(a.x, y1, b.x, y2, control);
        if (ann.type === 'slur' && score.instrument !== 'piano') {
          const ty1=a.tabNoteY+(slurBelow?10:-10), ty2=b.tabNoteY+(slurBelow?10:-10);
          const tabControl=slurBelow?Math.max(ty1,ty2)+13:Math.min(ty1,ty2)-13;
          curve(a.tabX, ty1, b.tabX, ty2, tabControl);
        }
      }
      else {
        drawOnSystem(a.system, a.x, bounds.get(a.system).right-3);
        for (let system=a.system+1; system<b.system; system++) drawOnSystem(system, bounds.get(system).left+3, bounds.get(system).right-3);
        drawOnSystem(b.system, bounds.get(b.system).left+3, b.x);
      }
    } else if (ann.type === 'barre') {
      const barreY=(system,x1,x2)=>{
        const bound=bounds.get(system);
        const tops=[...renderedNotes.values()]
          .filter((item)=>item.system===system&&item.x>=x1-2&&item.x<=x2+2)
          .map((item)=>item.topY);
        return Math.min(bound.staffY-18,(tops.length?Math.min(...tops):bound.staffY)-13);
      };
      const labelWidth=Math.max(24,ann.text.length*7);
      if (a.system === b.system){
        const y=barreY(a.system,a.x,b.x);
        svg('text',{x:a.x,y:y+4,class:'annotation-text',text:ann.text});
        svg('path',{d:`M${a.x+labelWidth},${y} H${b.x+10} v9`,class:'barre'});
      } else {
        const startBound=bounds.get(a.system),startY=barreY(a.system,a.x,startBound.right);
        svg('text',{x:a.x,y:startY+4,class:'annotation-text',text:ann.text});
        svg('path', { d:`M${a.x+labelWidth},${startY} H${startBound.right-3}`, class:'barre' });
        for (let system=a.system+1; system<b.system; system++) {
          const bound=bounds.get(system),y=barreY(system,bound.left,bound.right);
          svg('path', { d:`M${bound.left+3},${y} H${bound.right-3}`, class:'barre' });
        }
        const endBound=bounds.get(b.system),endY=barreY(b.system,endBound.left,b.x);
        svg('path', { d:`M${endBound.left+3},${endY} H${b.x+10} v9`, class:'barre' });
      }
    }
  }
}

function render() {
  scoreSvg.replaceChildren();
  renderedNotes=new Map();
  $('#printTitle').textContent = score.metadata.title;
  $('#printLyricist').textContent = score.metadata.lyricist ? `작사: ${score.metadata.lyricist}` : '';
  $('#printComposer').textContent = score.metadata.composer ? `작곡: ${score.metadata.composer}` : '';
  sheet.dataset.page = score.page;
  const width = score.page === 'Screen' ? 1100 : score.page === 'A3' ? 1000 : 720;
  const sys = systems();
  const systemHeight = 245, top = 5;
  scoreSvg.setAttribute('viewBox', `0 0 ${width} ${Math.max(220, top + sys.length * systemHeight)}`);
  scoreSvg.style.height = `${Math.max(220, top + sys.length * systemHeight)}px`;
  if(!VF){status.textContent='악보 렌더링 라이브러리를 불러오지 못했습니다.';return;}
  const context=new VF.SVGContext(scoreSvg).resize(width,Math.max(220,top+sys.length*systemHeight));
  const layouts = new Map();
  const selected=selectedIds();
  const voiceColors=['#111','#2368c4','#b33a3a','#15805f'];
  sys.forEach((items, systemIndex) => {
    const y=top+systemIndex*systemHeight;
    const left=24, usable=width-48;
    const measureWidth = usable / items.length;
    const piano = score.instrument === 'piano';
    let firstStaff=null,firstLower=null;
    items.forEach(({ measure, index }, localIndex) => {
      const x = left + localIndex * measureWidth;
      const staff=new VF.Stave(x,y,measureWidth);
      const lower=piano?new VF.Stave(x,y+122,measureWidth):new VF.TabStave(x,y+122,measureWidth);
      if(localIndex===0){
        staff.addClef('treble','default',piano?undefined:'8vb').addTimeSignature(`${score.timeSignature.beats}/${score.timeSignature.beatType}`);
        lower.addClef(piano?'bass':'tab');
        firstStaff=staff;firstLower=lower;
      }
      VF.Stave.formatBegModifiers([staff,lower]);
      staff.setContext(context).draw();lower.setContext(context).draw();
      const staffTop=staff.getYForLine(0),staffBottom=staff.getYForLine(4);
      const lowerTop=lower.getYForLine(0),lowerBottom=lower.getYForLine(piano?4:5);
      layouts.set(index,{x,width:measureWidth,staffY:staffTop,tabY:lowerTop,lowerBottom,system:systemIndex});
      const staffVoices=[],tabVoices=[],staffById=new Map(),tabById=new Map(),staffBeams=[],tabBeams=[];
      measure.voices.forEach((modelVoice,voiceIndex)=>{
        if(!modelVoice.length)return;
        const direction=voiceIndex%2===0?VF.Stem.UP:VF.Stem.DOWN;
        const staffNotes=[],tabNotes=[];
        modelVoice.forEach((note)=>{
          let staveNote;
          if(note.grace) staveNote=new VF.GraceNote({keys:[vexKey(note.midi)],duration:'16',slash:true,stem_direction:direction});
          else staveNote=new VF.StaveNote({keys:[vexKey(note.midi)],duration:vexDuration(note,note.rest),stem_direction:direction});
          if(!note.rest&&vexKey(note.midi).includes('#'))staveNote.addModifier(new VF.Accidental('#'));
          if(note.dotted)VF.Dot.buildAndAttach([staveNote],{all:true});
          staveNote.setStyle({fillStyle:selected.has(note.id)?'#d97706':voiceColors[voiceIndex],strokeStyle:selected.has(note.id)?'#d97706':voiceColors[voiceIndex]});
          staffNotes.push(staveNote);staffById.set(note.id,staveNote);
          const tabNote=note.rest?new VF.GhostNote({duration:vexDuration(note)}):new VF.TabNote({positions:[{str:note.string,fret:note.fret}],duration:vexDuration(note),stem_direction:direction},true);
          if(note.dotted&&!note.rest)VF.Dot.buildAndAttach([tabNote],{all:true});
          if(!note.rest)tabNote.setStyle({fillStyle:selected.has(note.id)?'#d97706':voiceColors[voiceIndex],strokeStyle:selected.has(note.id)?'#d97706':voiceColors[voiceIndex]});
          tabNotes.push(tabNote);tabById.set(note.id,tabNote);
        });
        const time={num_beats:score.timeSignature.beats,beat_value:score.timeSignature.beatType};
        const sv=new VF.Voice(time).setMode(VF.Voice.Mode.SOFT).addTickables(staffNotes).setStave(staff);
        const tv=new VF.Voice(time).setMode(VF.Voice.Mode.SOFT).addTickables(tabNotes).setStave(lower);
        staffVoices.push(sv);tabVoices.push(tv);
        const beam=beamData(measure,voiceIndex);
        beam.groups.forEach((items)=>{
          const s=items.map(({note})=>staffById.get(note.id)).filter(Boolean);
          const t=items.map(({note})=>tabById.get(note.id)).filter((item)=>item&&!(item instanceof VF.GhostNote));
          if(s.length>1)staffBeams.push(new VF.Beam(s,false));
          if(t.length>1)tabBeams.push(new VF.Beam(t,false));
        });
      });
      const allVoices=[...staffVoices,...tabVoices];
      if(allVoices.length){
        const formatter=new VF.Formatter();
        if(staffVoices.length)formatter.joinVoices(staffVoices);
        if(tabVoices.length)formatter.joinVoices(tabVoices);
        const start=Math.max(staff.getNoteStartX(),lower.getNoteStartX());
        staffVoices.forEach((v)=>v.setStave(staff));tabVoices.forEach((v)=>v.setStave(lower));
        formatter.format(allVoices,Math.max(30,staff.getNoteEndX()-start-8));
        staffVoices.forEach((v)=>v.draw(context,staff));tabVoices.forEach((v)=>v.draw(context,lower));
        staffBeams.forEach((beam)=>beam.setContext(context).draw());tabBeams.forEach((beam)=>beam.setContext(context).draw());
        measure.voices.forEach((voice,voiceIndex)=>voice.forEach((note)=>{
          const sn=staffById.get(note.id),tn=tabById.get(note.id);
          if(!sn)return;
          const noteX=sn.getAbsoluteX(),noteY=sn.getYs?.()[0]??staffTop+20;
          const tabX=tn?.getAbsoluteX?.()??noteX,tabNoteY=tn?.getYs?.()[0]??lowerTop;
          const stem=sn.getStemExtents?.();
          const topY=Math.min(noteY,stem?.topY??noteY,stem?.baseY??noteY);
          const bottomY=Math.max(noteY,stem?.topY??noteY,stem?.baseY??noteY);
          renderedNotes.set(note.id,{x:noteX,noteY,topY,bottomY,tabX,tabNoteY,staffY:staffTop,tabY:lowerTop,system:systemIndex});
        }));
      }
      svg('text',{x:x+5,y:staffTop-8,text:String(index+1),'font-size':9,fill:'#65718a'});
      if(measureWarning?.measureIndex===index){
        const warningWidth=Math.min(measureWidth-12,210),warningX=x+(measureWidth-warningWidth)/2;
        svg('rect',{x:warningX,y:staffTop-37,width:warningWidth,height:21,rx:5,class:'measure-warning-bg'});
        svg('text',{x:x+measureWidth/2,y:staffTop-22,text:measureWarning.message,class:'measure-warning-text'});
      }
      const mh=svg('rect',{x,y:staffTop-10,width:measureWidth,height:lowerBottom-staffTop+20,class:'measure-hit'});
      mh.addEventListener('click',(e)=>{if(e.target===mh)setSelection(index,score.activeVoice,null,e.shiftKey);});
      if(measure.forceBreakAfter)svg('text',{x:x+measureWidth-14,y:staffTop-8,text:'↵',class:'break-mark'});
    });
    if(firstStaff&&firstLower)new VF.StaveConnector(firstStaff,firstLower).setType('bracket').setContext(context).draw();
  });
  // A translucent range makes drag selection unambiguous before applying a barre.
  if(score.selection.noteId&&score.selection.rangeEnd){
    let a=endpointFor({noteId:score.selection.noteId}),b=endpointFor(score.selection.rangeEnd);
    if(a&&b){
      if(a.system>b.system||(a.system===b.system&&a.x>b.x))[a,b]=[b,a];
      const bounds=new Map();for(const l of layouts.values()){const q=bounds.get(l.system)||{left:l.x,right:l.x+l.width,top:l.staffY-25,bottom:l.lowerBottom+12};q.left=Math.min(q.left,l.x);q.right=Math.max(q.right,l.x+l.width);bounds.set(l.system,q);}
      for(let s=a.system;s<=b.system;s++){const q=bounds.get(s),x1=s===a.system?a.x-13:q.left,x2=s===b.system?b.x+13:q.right;svg('rect',{x:x1,y:q.top,width:Math.max(4,x2-x1),height:q.bottom-q.top,class:'range-selection'});}
    }
  }
  // Interaction rectangles are rebuilt from VexFlow's final, rhythm-aligned positions.
  selectionOrder().forEach(({note,measure,voice})=>{
    const p=renderedNotes.get(note.id),layout=layouts.get(measure);if(!p||!layout)return;
    const sh=svg('rect',{x:p.x-13,y:layout.staffY-22,width:26,height:84,class:'hit'});
    sh.addEventListener('pointerdown',(e)=>beginRangeSelection(e,measure,voice,note.id,'staff'));
    sh.addEventListener('pointerenter',()=>extendRangeSelection(measure,voice,note.id));
    sh.addEventListener('click',(e)=>{e.stopPropagation();if(ignoreNextClick){ignoreNextClick=false;return;}setSelection(measure,voice,note.id,e.shiftKey,'staff');});
    if(score.instrument!=='piano'&&!note.rest){const th=svg('rect',{x:p.tabX-14,y:p.tabNoteY-11,width:28,height:22,class:'hit'});th.addEventListener('pointerdown',(e)=>beginRangeSelection(e,measure,voice,note.id,'tab'));th.addEventListener('pointerenter',()=>extendRangeSelection(measure,voice,note.id));th.addEventListener('click',(e)=>{e.stopPropagation();if(ignoreNextClick){ignoreNextClick=false;return;}setSelection(measure,voice,note.id,e.shiftKey,'tab');});}
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

function stringsUsedAtTick(measure, excludedVoice, targetTick) {
  const used=new Set();
  measure.voices.forEach((voice,voiceIndex)=>{
    if(voiceIndex===excludedVoice)return;
    let tick=0;
    voice.forEach((note)=>{if(!note.rest&&tick===targetTick)used.add(note.string);tick+=durationTicks(note);});
  });
  return used;
}

function bestPosition(midi, measure=null, voice=score.activeVoice) {
  const choices = positionsForMidi(midi);
  const ordered=choices.sort((a,b) => a.fret-b.fret || a.string-b.string);
  if(measure){
    const occupied=stringsUsedAtTick(measure,voice,measureTicks(measure,voice));
    const alternative=ordered.find((position)=>!occupied.has(position.string));
    if(alternative)return alternative;
  }
  return ordered[0] || { string:1, fret:Math.max(0,midi-TUNING[0]) };
}

function addNote(midi) {
  remember();
  let measureIndex = score.selection.measure;
  let measure = score.measures[measureIndex];
  if (measureTicks(measure, score.activeVoice) + duration * (dotted ? 1.5 : 1) > measureLimit()) {
    measureIndex++;
    if (!score.measures[measureIndex]) score.measures.push(createMeasure());
    measure = score.measures[measureIndex];
  }
  const pos = bestPosition(midi,measure,score.activeVoice);
  const note = noteFromStringFret(pos.string, pos.fret, duration, dotted, graceMode);
  note.rest = restMode;
  measure.voices[score.activeVoice].push(note);
  score.selection = { measure:measureIndex, voice:score.activeVoice, noteId:note.id, source:'staff', rangeEnd:null };
  if (measureTicks(measure, score.activeVoice) >= measureLimit() && measureIndex === score.measures.length - 1) score.measures.push(createMeasure());
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
    let next = notes[index + 1];
    if (!next && type === 'tie') {
      const entry=selectedEntry();
      if(!entry||entry.note.rest)return;
      remember();
      let targetIndex=entry.measureIndex,targetMeasure=entry.measure;
      if(measureTicks(targetMeasure,entry.voice)+durationTicks(entry.note)>measureLimit()){
        targetIndex++;
        if(!score.measures[targetIndex])score.measures.push(createMeasure());
        targetMeasure=score.measures[targetIndex];
      }
      const duplicate=noteFromStringFret(entry.note.string,entry.note.fret,entry.note.duration,entry.note.dotted,false);
      duplicate.midi=entry.note.midi;
      targetMeasure.voices[entry.voice].push(duplicate);
      next={note:duplicate,measure:targetMeasure,measureIndex:targetIndex,voice:entry.voice};
      range={start:range.start,end:{measure:targetIndex,voice:entry.voice,noteId:duplicate.id}};
      score.annotations.push({type,...range});render();return;
    }
    if (!next) { status.textContent = '슬러를 연결할 다음 음표가 없습니다.'; return; }
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
  setSelection(next.measureIndex, next.voice, next.note.id, false, score.selection.source || 'staff');
}

function transposeSelected(direction, octave = false) {
  const entry = selectedEntry(); if (!entry || entry.note.rest) return;
  const nextMidi = entry.note.midi + direction * (octave ? 12 : 1);
  if (score.instrument === 'piano') {
    if (nextMidi < 21 || nextMidi > 108) return;
    remember(); entry.note.midi=nextMidi; render(); return;
  }
  const position = positionsForMidi(nextMidi).sort((a,b)=>a.fret-b.fret||a.string-b.string)[0];
  if (!position) { status.textContent='기타의 연주 가능한 음역을 벗어났습니다.'; return; }
  remember();
  entry.note.midi=nextMidi; entry.note.string=position.string; entry.note.fret=position.fret;
  render();
}

function moveTabAcrossStrings(direction) {
  const entry=selectedEntry(); if(!entry || entry.note.rest || score.instrument==='piano') return;
  const choices=positionsForMidi(entry.note.midi).sort((a,b)=>a.string-b.string);
  const current=choices.findIndex((position)=>position.string===entry.note.string);
  const next=choices[current+direction];
  if(!next) return;
  remember(); entry.note.string=next.string;entry.note.fret=next.fret;render();
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

function insertMeasureAfterSelection() {
  remember();
  const after=Math.max(0,Math.min(score.measures.length-1,score.selection.measure));
  score.measures.splice(after+1,0,createMeasure());
  score.annotations.forEach((annotation)=>{
    if(annotation.start.measure>after)annotation.start.measure++;
    if(annotation.end.measure>after)annotation.end.measure++;
  });
  score.selection={measure:after+1,voice:score.activeVoice,noteId:null,source:'staff',rangeEnd:null};
  render();
}

function escapeXml(value='') { return value.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])); }
const STEP = ['C','C','D','D','E','F','F','G','G','A','A','B'];
const ALTER = [0,1,0,1,0,0,1,0,1,0,1,0];

function toMusicXml() {
  const instrumentName = ({'classical-guitar':'Classical Guitar','acoustic-guitar':'Acoustic Guitar','electric-guitar':'Electric Guitar',piano:'Piano'})[score.instrument];
  const measures = score.measures.map((m, mi) => {
    let body = `${mi > 0 && score.measures[mi-1].forceBreakAfter ? '<print new-system="yes"/>' : ''}${mi === 0 ? `<attributes><divisions>8</divisions><key><fifths>0</fifths></key><time><beats>${score.timeSignature.beats}</beats><beat-type>${score.timeSignature.beatType}</beat-type></time><staves>2</staves>${score.instrument==='piano'?'':'<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>'}<clef number="1"><sign>G</sign><line>2</line></clef>${score.instrument==='piano'?'<clef number="2"><sign>F</sign><line>4</line></clef>':'<clef number="2"><sign>TAB</sign><line>5</line></clef><staff-details number="2"><staff-lines>6</staff-lines></staff-details>'}</attributes>` : ''}`;
    m.voices.forEach((voice, vi) => {
      if (vi && voice.length) body += `<backup><duration>${measureLimit()}</duration></backup>`;
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

function bytes(text) { return new TextEncoder().encode(text); }

function joinBytes(chunks) {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  chunks.forEach((chunk) => { result.set(chunk, offset); offset += chunk.length; });
  return result;
}

function jpegBytes(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]);
  const result = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) result[i]=binary.charCodeAt(i);
  return result;
}

function buildPdf(jpegs, pageWidth, pageHeight, pixelWidth, pixelHeight) {
  const count = jpegs.length;
  const objects = new Map();
  const pageIds = Array.from({length:count}, (_, index) => 3 + index * 3);
  objects.set(1, [bytes('<< /Type /Catalog /Pages 2 0 R >>')]);
  objects.set(2, [bytes(`<< /Type /Pages /Count ${count} /Kids [${pageIds.map((id)=>`${id} 0 R`).join(' ')}] >>`)]);
  jpegs.forEach((jpeg, index) => {
    const pageId=pageIds[index], contentId=pageId+1, imageId=pageId+2;
    const stream=`q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`;
    objects.set(pageId, [bytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)]);
    objects.set(contentId, [bytes(`<< /Length ${bytes(stream).length} >>\nstream\n${stream}endstream`)]);
    objects.set(imageId, [bytes(`<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, bytes('\nendstream')]);
  });
  const maxId = 2 + count * 3;
  const chunks=[bytes('%PDF-1.4\n%PDFJS\n')], offsets=Array(maxId+1).fill(0);
  let length=chunks[0].length;
  for(let id=1;id<=maxId;id++) {
    offsets[id]=length;
    const object=joinBytes([bytes(`${id} 0 obj\n`),...objects.get(id),bytes('\nendobj\n')]);
    chunks.push(object); length+=object.length;
  }
  const xrefOffset=length;
  let xref=`xref\n0 ${maxId+1}\n0000000000 65535 f \n`;
  for(let id=1;id<=maxId;id++) xref+=`${String(offsets[id]).padStart(10,'0')} 00000 n \n`;
  xref+=`trailer\n<< /Size ${maxId+1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  chunks.push(bytes(xref));
  return joinBytes(chunks);
}

function scoreImage() {
  return new Promise((resolve, reject) => {
    const clone=scoreSvg.cloneNode(true);
    clone.setAttribute('xmlns', NS);
    clone.querySelectorAll('.hit,.measure-hit,.selected-measure').forEach((node)=>node.remove());
    const style=document.createElementNS(NS,'style');
    style.textContent='.staff-line,.ledger-line,.tab-line,.barline{stroke:#111;stroke-width:1}.system-bracket{fill:none;stroke:#111;stroke-width:2}.notehead{fill:#111!important}.stem{stroke:#111!important;stroke-width:1.3;fill:none}.beam{stroke:#111;stroke-width:5}.secondary-beam{stroke-width:3.5}.tab-bg{fill:#fff;stroke:none}.tab-number{fill:#111!important;font:bold 14px Arial;text-anchor:middle;dominant-baseline:middle}.inactive-voice{opacity:1}.slur,.tie{fill:none;stroke:#111;stroke-width:1.5}.barre{fill:none;stroke:#111;stroke-width:1.2;stroke-dasharray:5 4}.annotation-text{font:italic 13px serif}.break-mark{display:none}';
    clone.prepend(style);
    const viewBoxValues=clone.getAttribute('viewBox').trim().split(/\s+/).map(Number);
    const viewBox={width:viewBoxValues[2],height:viewBoxValues[3]};
    clone.setAttribute('width', viewBox.width); clone.setAttribute('height', viewBox.height);
    const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)],{type:'image/svg+xml'}));
    const image=new Image();
    image.onload=()=>{URL.revokeObjectURL(url);resolve({image,width:viewBox.width,height:viewBox.height});};
    image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('악보 이미지를 만들 수 없습니다.'));};
    image.src=url;
  });
}

async function exportPdf() {
  const preview=window.open('', '_blank');
  if (preview) preview.document.write('<p style="font-family:sans-serif;padding:24px">PDF를 만드는 중입니다…</p>');
  try {
    const sizes={
      A4:{px:[992,1403],pt:[595.28,841.89]}, A3:{px:[1403,1984],pt:[841.89,1190.55]},
      Letter:{px:[1020,1320],pt:[612,792]}, Screen:{px:[992,1403],pt:[595.28,841.89]},
    };
    const page=sizes[score.page]||sizes.A4;
    const [canvasWidth,canvasHeight]=page.px;
    const source=await scoreImage();
    const margin=Math.round(canvasWidth*.065), contentWidth=canvasWidth-margin*2;
    const scale=contentWidth/source.width;
    const hasMetadata=Object.values(score.metadata).some(Boolean);
    const firstTop=hasMetadata?Math.round(canvasHeight*.12):margin;
    const normalTop=margin, bottom=margin;
    const firstCapacity=(canvasHeight-firstTop-bottom)/scale;
    const normalCapacity=(canvasHeight-normalTop-bottom)/scale;
    const slices=[];
    let sourceY=0, first=true;
    while(sourceY<source.height-.5) {
      const capacity=first?firstCapacity:normalCapacity;
      slices.push({sourceY,height:Math.min(capacity,source.height-sourceY),top:first?firstTop:normalTop,first});
      sourceY+=capacity; first=false;
    }
    if(!slices.length) slices.push({sourceY:0,height:source.height,top:firstTop,first:true});
    const jpegs=[];
    for(const slice of slices) {
      const canvas=document.createElement('canvas');canvas.width=canvasWidth;canvas.height=canvasHeight;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvasWidth,canvasHeight);
      if(slice.first&&hasMetadata) {
        ctx.fillStyle='#111';ctx.textAlign='center';ctx.font=`bold ${Math.round(canvasWidth*.035)}px serif`;
        ctx.fillText(score.metadata.title||'',canvasWidth/2,Math.round(canvasHeight*.05));
        ctx.font=`${Math.round(canvasWidth*.018)}px serif`;
        ctx.textAlign='left';ctx.fillText(score.metadata.lyricist?`작사: ${score.metadata.lyricist}`:'',margin,Math.round(canvasHeight*.085));
        ctx.textAlign='right';ctx.fillText(score.metadata.composer?`작곡: ${score.metadata.composer}`:'',canvasWidth-margin,Math.round(canvasHeight*.085));
      }
      ctx.drawImage(source.image,0,slice.sourceY,source.width,slice.height,margin,slice.top,contentWidth,slice.height*scale);
      jpegs.push(jpegBytes(canvas.toDataURL('image/jpeg',.94)));
    }
    const pdf=buildPdf(jpegs,page.pt[0],page.pt[1],canvasWidth,canvasHeight);
    const url=URL.createObjectURL(new Blob([pdf],{type:'application/pdf'}));
    if(preview) preview.location.replace(url);
    else { const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.click(); }
    setTimeout(()=>URL.revokeObjectURL(url),120000);
  } catch(error) {
    if(preview) preview.close();
    alert(`PDF 생성 중 문제가 생겼습니다: ${error.message}`);
  }
}

function importMusicXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('올바른 MusicXML 파일이 아닙니다.');
  const fresh = createScore(); fresh.measures = [];
  fresh.metadata.title = doc.querySelector('work-title')?.textContent || '';
  fresh.metadata.composer = doc.querySelector('creator[type="composer"]')?.textContent || '';
  fresh.metadata.lyricist = doc.querySelector('creator[type="lyricist"]')?.textContent || '';
  fresh.timeSignature = { beats:Number(doc.querySelector('time beats')?.textContent || 4), beatType:Number(doc.querySelector('time beat-type')?.textContent || 4) };
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
  $('#timeSignature').value = `${score.timeSignature.beats}/${score.timeSignature.beatType}`;
}

document.querySelectorAll('[data-duration]').forEach((button) => button.addEventListener('click', () => { duration = Number(button.dataset.duration); updateControls(); }));
$('#dot').addEventListener('click', () => {
  const entry=selectedEntry();
  if(entry){
    const nextDotted=!entry.note.dotted;
    if(!noteFitsMeasure(entry.measure,entry.voice,entry.note,nextDotted)){
      showMeasureWarning(entry.measureIndex);
      return;
    }
    remember();entry.note.dotted=nextDotted;dotted=entry.note.dotted;
  }
  else dotted=!dotted;
  updateControls();render();
});
$('#rest').addEventListener('click', () => { restMode=!restMode; updateControls(); });
$('#voice').addEventListener('click', () => { score.activeVoice=(score.activeVoice+1)%4; score.selection.voice=score.activeVoice; score.selection.noteId=null; updateControls();render(); });
$('#grace').addEventListener('click', () => { const e=selectedEntry();if(e){remember();e.note.grace=!e.note.grace;}else graceMode=!graceMode;updateControls();render(); });
$('#tie').addEventListener('click', () => addAnnotation('tie'));
$('#slur').addEventListener('click', () => addAnnotation('slur'));
$('#barre').addEventListener('click', () => {
  const range=orderedSelection();
  if(!range){status.textContent='오선 또는 타브 위에서 첫 음표부터 마지막 음표까지 드래그한 뒤 바레를 누르세요.';return;}
  const value=$('#barreFret').value;
  remember();score.annotations.push({type:'barre',...range,text:`C.${Math.max(1,Math.min(30,Number(value)||1))}`});render();
});
$('#undo').addEventListener('click', () => { if(!undoStack.length)return;score=undoStack.pop();syncMetadataInputs();updateControls();render(); });
$('#clear').addEventListener('click', () => { remember();score.measures=[createMeasure()];score.annotations=[];score.selection={measure:0,voice:score.activeVoice,noteId:null,source:'staff',rangeEnd:null};render(); });
$('#page').addEventListener('change', (e) => { score.page=e.target.value;render(); });
$('#instrument').addEventListener('change', (e) => { score.instrument=e.target.value;render(); });
$('#timeSignature').addEventListener('change', (e) => { const [beats,beatType]=e.target.value.split('/').map(Number);score.timeSignature={beats,beatType};render(); });
['title','lyricist','composer'].forEach((key) => $(`#${key}`).addEventListener('input', (e) => { score.metadata[key]=e.target.value;render(); }));
$('#xmlExport').addEventListener('click', () => download(`${score.metadata.title||'score'}.musicxml`,toMusicXml(),'application/vnd.recordare.musicxml+xml'));
$('#xmlImport').addEventListener('change', async (e) => { try{const file=e.target.files[0];if(file)importMusicXml(await file.text());}catch(err){alert(err.message);}e.target.value=''; });
$('#pdf').addEventListener('click', exportPdf);
$('#help').addEventListener('click', () => $('#helpDialog').showModal());
$('#helpDialog button').addEventListener('click', () => $('#helpDialog').close());

document.addEventListener('keydown', (e) => {
  if (e.target?.matches?.('input,select,textarea') || $('#helpDialog').open) return;
  if (PITCH_BY_CODE[e.code] != null) { e.preventDefault(); addNote(PITCH_BY_CODE[e.code]); return; }
  if (e.code === 'Period' || e.code === 'NumpadDecimal') { e.preventDefault();$('#dot').click();return; }
  if (/^Digit\d$/.test(e.code) || /^Numpad\d$/.test(e.code)) {
    const digit=e.code.at(-1);
    if(score.selection.source==='tab'&&selectedEntry()){
      e.preventDefault();changeFret(digit);return;
    }
    const durationByDigit={1:32,2:16,3:8,4:4,5:2};
    if(durationByDigit[digit]){e.preventDefault();duration=durationByDigit[digit];updateControls();return;}
  }
  if(e.code==='Tab'){e.preventDefault();insertMeasureAfterSelection();return;}
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') { e.preventDefault(); moveSelection(e.code==='ArrowLeft'?-1:1); }
  else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    if(score.selection.source==='tab' && !e.ctrlKey) moveTabAcrossStrings(e.code==='ArrowUp'?-1:1);
    else transposeSelected(e.code==='ArrowUp'?1:-1,e.ctrlKey);
  }
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

export { score, toMusicXml, importMusicXml, pitchY, writtenMidi, buildPdf };
