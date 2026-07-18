import {
  TUNING, createScore, createMeasure, noteFromStringFret,
  durationTicks, measureTicks, positionsForMidi, cloneScore, allNotes, timeSignatureTicks, groupingTicks,
} from './editor-model.js';

const NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const scoreSvg = $('#score');
let notationSvg = null;
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
let doubleDotted = false;
let pendingAccidental = 0;
let restMode = false;
let graceMode = false;
let fretBuffer = '';
let undoStack = [];
let dragAnchor = null;
let dragMoved = false;
let ignoreNextClick = false;
let renderedNotes = new Map();
let renderedSystemBreaks = [];
let measureWarning = null;
let warningTimer = null;
let selectedAnnotation = -1;
let hairpinDrag = null;

// Keyboard letters enter the lower guitar octave by default: C3–B3.
const PITCH_BY_CODE = { KeyA: 57, KeyB: 59, KeyC: 48, KeyD: 50, KeyE: 52, KeyF: 53, KeyG: 55 };
const VOICE_COLORS = ['검정', '파랑', '빨강', '초록'];

function svg(tag, attrs = {}, parent = notationSvg || scoreSvg) {
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
  document.activeElement?.blur?.();
  if (extend && score.selection.noteId) {
    score.selection.rangeEnd = { measure, voice, noteId };
  } else {
    const targetMeasure=score.measures[measure];
    const targetNote=noteId?targetMeasure?.voices[voice]?.find((note)=>note.id===noteId):null;
    if(targetNote){
      duration=targetNote.duration;
      const selectedDots=targetNote.dots??(targetNote.dotted?1:0);
      dotted=selectedDots===1;doubleDotted=selectedDots===2;
    }
    const cursorTick=targetNote?notePosition(targetNote,targetMeasure,voice):Math.min(measureLimit(),measureTicks(targetMeasure,voice));
    score.selection = { measure, voice, noteId, source, cursorTick, rangeEnd: null };
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
  hairpinDrag = null;
  if (dragMoved) ignoreNextClick = true;
  dragAnchor = null;
  dragMoved = false;
});

document.addEventListener('pointermove', (event) => {
  if (!hairpinDrag || !notationSvg) return;
  event.preventDefault();
  const annotation=score.annotations[hairpinDrag.index];
  if(!annotation)return;
  const matrix=notationSvg.getScreenCTM?.();
  let x=event.clientX,y=event.clientY;
  if(matrix&&typeof DOMPoint!=='undefined'){
    const point=new DOMPoint(x,y).matrixTransform(matrix.inverse());x=point.x;y=point.y;
  }
  const fixed=endpointFor(hairpinDrag.side==='start'?annotation.end:annotation.start);
  const entries=selectionOrder().filter((entry)=>{
    const rendered=renderedNotes.get(entry.note.id);
    return entry.voice===hairpinDrag.voice&&rendered&&(!fixed||rendered.system===fixed.system);
  });
  const fixedIndex=entries.findIndex((entry)=>entry.note.id===(hairpinDrag.side==='start'?annotation.end.noteId:annotation.start.noteId));
  const candidates=entries.filter((entry,index)=>hairpinDrag.side==='start'?index<fixedIndex:index>fixedIndex);
  const nearest=candidates.reduce((best,entry)=>{
    const rendered=renderedNotes.get(entry.note.id),distance=(rendered.x-x)**2+(rendered.noteY-y)**2;
    return !best||distance<best.distance?{entry,distance}:best;
  },null);
  if(!nearest)return;
  annotation[hairpinDrag.side]={measure:nearest.entry.measure,voice:nearest.entry.voice,noteId:nearest.entry.note.id};
  render();
});

function notePosition(note, measure, voice) {
  if(Number.isFinite(note.startTick))return note.startTick;
  let tick = 0;
  for (const n of measure.voices[voice]) {
    if (n.id === note.id) return tick;
    tick += durationTicks(n);
  }
  return tick;
}

function noteAtTick(measure,voice,tick){
  let position=0;
  return measure.voices[voice].find((note)=>{const match=position===tick;position+=durationTicks(note);return match;})||null;
}

function measureLimit() { return timeSignatureTicks(score.timeSignature); }

function restParts(totalTicks, startTick=0) {
  const values=[32,24,16,12,8,6,4,3,2,1],parts=[];
  let remaining=Math.max(0,totalTicks),tick=startTick;
  for(const ticks of values){
    while(remaining>=ticks-.001){
      const dottedValue=[24,12,6,3].includes(ticks),base=dottedValue?ticks/1.5:ticks;
      const note=noteFromStringFret(1,0,base,dottedValue,false);
      note.rest=true;note.dots=dottedValue?1:0;note.startTick=tick;note.ticks=ticks;
      parts.push(note);tick+=ticks;remaining-=ticks;
    }
  }
  return parts;
}

function fullMeasureRest() {
  const note=noteFromStringFret(1,0,32,false,false);
  note.rest=true;note.measureRest=true;note.startTick=0;note.ticks=measureLimit();
  return note;
}

function ensureEditableRests() {
  score.voiceCount=Math.max(1,Math.min(4,Number(score.voiceCount)||1));
  score.measures.forEach((measure,index)=>{
    for(let voice=0;voice<score.voiceCount;voice++)if(measure.voices[voice].length===0)measure.voices[voice].push(fullMeasureRest());
  });
  if(!score.selection.noteId){
    const voice=score.measures[score.selection.measure]?.voices[score.activeVoice];
    if(voice?.length===1&&voice[0].measureRest)score.selection.noteId=voice[0].id;
  }
}

function materializeVoiceTicks(measure, voiceIndex) {
  let tick=0;
  measure.voices[voiceIndex].forEach((note)=>{
    if(!Number.isFinite(note.startTick))note.startTick=tick;
    tick=Math.max(tick,note.startTick+durationTicks(note));
  });
}

function setNoteTicks(note, ticks) {
  const values=new Map([[32,[32,0]],[24,[16,1]],[16,[16,0]],[12,[8,1]],[8,[8,0]],[6,[4,1]],[4,[4,0]],[3,[2,1]],[2,[2,0]],[1,[1,0]]]);
  const value=values.get(Math.round(ticks));
  if(!value)return false;
  note.duration=value[0];note.dots=value[1];note.dotted=value[1]>0;note.ticks=Math.round(ticks);
  return true;
}

function normalizeVoiceToMeasure(measure, voiceIndex) {
  const limit=measureLimit(),voice=measure.voices[voiceIndex];
  voice.sort((a,b)=>(a.startTick??0)-(b.startTick??0));
  const kept=[];
  voice.forEach((note)=>{
    const start=Number(note.startTick)||0;
    if(start>=limit-.001)return;
    const remaining=limit-start;
    if(durationTicks(note)>remaining+.001&&!setNoteTicks(note,remaining))return;
    kept.push(note);
  });
  measure.voices[voiceIndex]=kept;
}

function showMeasureWarning(measureIndex, message='마디의 박자 길이를 초과할 수 없습니다.') {
  measureWarning={measureIndex,message};
  clearTimeout(warningTimer);
  render();
  warningTimer=setTimeout(()=>{measureWarning=null;render();},2600);
}

function dotMultiplier(count=0) { let value=1,part=.5;for(let i=0;i<count;i++){value+=part;part/=2;}return value; }

function noteFitsMeasure(measure, voice, note, dotsValue=Number.isFinite(note.dots)?note.dots:(note.dotted?1:0), durationValue=note.duration) {
  const used=measure.voices[voice].reduce((sum,item)=>sum+(item.id===note.id?0:durationTicks(item)),0);
  const proposed=note.grace?0:durationValue*dotMultiplier(dotsValue);
  return used+proposed<=measureLimit();
}

function systems() {
  const groups = [];
  let current = [];
  const perSystem = Math.max(1, Math.min(6, Number(score.measuresPerSystem) || 3));
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
  const imported=measure.voices[voice];
  const conventionalFourFour=score.timeSignature.beats===4&&score.timeSignature.beatType===4;
  if(imported.some((note)=>note.beams?.length)&&!conventionalFourFour){
    let current=[];
    const flush=()=>{if(current.length>1)groups.push(current);current=[];};
    imported.forEach((note)=>{
      const primary=note.beams?.find((beam)=>beam.number===1)?.value;
      if(primary==='begin'){flush();current=[{note,tick:note.startTick??0}];}
      else if(primary==='continue')current.push({note,tick:note.startTick??0});
      else if(primary==='end'){current.push({note,tick:note.startTick??0});flush();}
      else if(primary!=='forward hook'&&primary!=='backward hook')flush();
      const beamCount=note.beams?.filter((beam)=>beam.value!=='forward hook'&&beam.value!=='backward hook').length||0;
      if(beamCount)levels.set(note.id,beamCount);
    });
    flush();
    return {levels,groups};
  }
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
const KEY_BY_FIFTHS = ['Cb','Gb','Db','Ab','Eb','Bb','F','C','G','D','A','E','B','F#','C#'];

function vexDuration(note, rest=false) {
  if(rest&&note.measureRest)return 'wr';
  const base = VEX_DURATION[note.duration] || 'q';
  const dots=Number.isFinite(note.dots)?note.dots:(note.dotted?1:0);
  return `${base}${'d'.repeat(dots)}${rest?'r':''}`;
}

function spacerNotes(ticks) {
  const values=[32,24,16,12,8,6,4,3,2,1];
  const notes=[];
  let remaining=Math.max(0,Math.round(ticks));
  values.forEach((value)=>{
    while(remaining>=value){
      const dotted=value===24||value===12||value===6||value===3;
      const duration=dotted?value/1.5:value;
      notes.push(new VF.GhostNote({duration:`${VEX_DURATION[duration]}${dotted?'d':''}`}));
      remaining-=value;
    }
  });
  return notes;
}

function vexKey(midi) {
  const value=writtenMidi(midi), pc=((value%12)+12)%12, octave=Math.floor(value/12)-1;
  return `${VEX_NAMES[pc]}/${octave}`;
}

function selectionOrder() {
  const entries=[];
  score.measures.forEach((measure, measureIndex) => measure.voices.forEach((voice, voiceIndex) => {
    let tick=0;
    voice.forEach((note) => { const noteTick=Number.isFinite(note.startTick)?note.startTick:tick;entries.push({note,measure:measureIndex,voice:voiceIndex,tick:noteTick});tick=Math.max(tick,noteTick+durationTicks(note)); });
  }));
  return entries.sort((a,b)=>a.measure-b.measure||a.tick-b.tick||a.voice-b.voice);
}

function selectedIds() {
  const ids=new Set();
  if(!score.selection.noteId) return ids;
  if(!score.selection.rangeEnd){ids.add(score.selection.noteId);return ids;}
  const ordered=selectionOrder().filter((item)=>item.voice===score.selection.voice);
  let a=ordered.findIndex((item)=>item.note.id===score.selection.noteId);
  let b=ordered.findIndex((item)=>item.note.id===score.selection.rangeEnd.noteId);
  if(a<0||b<0)return ids;
  if(a>b)[a,b]=[b,a];
  ordered.slice(a,b+1).forEach((item)=>ids.add(item.note.id));
  return ids;
}

function drawAnnotations(layouts) {
  const notationScale=Math.max(1,(Number(score.measuresPerSystem)||3)/3);
  const bounds = new Map();
  for (const layout of layouts.values()) {
    const current = bounds.get(layout.system) || { left:layout.x, right:layout.x+layout.width, staffY:layout.staffY, tabY:layout.tabY };
    current.left = Math.min(current.left, layout.x); current.right = Math.max(current.right, layout.x+layout.width);
    bounds.set(layout.system, current);
  }
  score.measures.forEach((measure,measureIndex)=>{
    const layout=layouts.get(measureIndex);
    measure.directions?.forEach((direction,index)=>{
      if(!layout)return;
      const directionX=direction.align==='end'?layout.noteEnd-22*notationScale:direction.align==='center'?(layout.noteStart+layout.noteEnd)/2:direction.align==='system-left'?layout.x+5*notationScale:layout.noteStart;
      svg('text',{x:directionX,y:direction.placement==='below'?layout.tabY+82:layout.staffY-29-index*17*notationScale,text:direction.text,class:'music-direction','font-size':13*notationScale,'font-family':'serif','font-style':'italic','text-anchor':direction.align==='center'?'middle':'start'});
    });
  });
  score.annotations.forEach((ann,annotationIndex) => {
    let a = endpointFor(ann.start), b = endpointFor(ann.end);
    if (!a || !b) return;
    if (a.system > b.system || (a.system === b.system && a.x > b.x)) [a,b] = [b,a];
    if (ann.type === 'slur' || ann.type === 'tie') {
      const rise = ann.type === 'slur' ? 20 : 9;
      const below=(ann.start?.voice??0)%2===0;
      const curve = (x1, y1, x2, y2, controlY) => svg('path', { d:`M${x1},${y1} Q${(x1+x2)/2},${controlY} ${x2},${y2}`, class:ann.type });
      const drawOnSystem = (system, x1, x2) => {
        const bound = bounds.get(system);
        const y=bound.staffY+(below?57:-5);
        curve(x1,y,x2,y,below?y+rise:y-rise);
        if ((ann.type === 'slur'||ann.type === 'tie') && score.instrument !== 'piano' && score.showTab !== false) {
          const tabCurveY=bound.tabY+(below?73:-7);curve(x1,tabCurveY,x2,tabCurveY,below?tabCurveY+rise:tabCurveY-rise);
        }
      };
      if (a.system === b.system) {
        const y1 = a.noteY + (below ? 8 : -8);
        const y2 = b.noteY + (below ? 8 : -8);
        const control = below ? Math.max(y1,y2)+rise : Math.min(y1,y2)-rise;
        curve(a.x, y1, b.x, y2, control);
        if ((ann.type === 'slur'||ann.type === 'tie') && score.instrument !== 'piano' && score.showTab !== false) {
          const ty1=a.tabNoteY+(below?10:-10), ty2=b.tabNoteY+(below?10:-10);
          const tabControl=below?Math.max(ty1,ty2)+13:Math.min(ty1,ty2)-13;
          curve(a.tabX, ty1, b.tabX, ty2, tabControl);
        }
      }
      else {
        drawOnSystem(a.system, a.x, bounds.get(a.system).right-3);
        for (let system=a.system+1; system<b.system; system++) drawOnSystem(system, bounds.get(system).left+3, bounds.get(system).right-3);
        drawOnSystem(b.system, bounds.get(b.system).left+3, b.x);
      }
    } else if(ann.type==='crescendo'||ann.type==='diminuendo'){
      const y=Math.max(a.bottomY,b.bottomY)+28,open=9;
      let path;
      if(ann.type==='crescendo'){
        path=svg('path',{d:`M${a.x},${y} L${b.x},${y-open} M${a.x},${y} L${b.x},${y+open}`,class:'hairpin',fill:'none',stroke:'#222','stroke-width':1.5});
      }else{
        path=svg('path',{d:`M${a.x},${y-open} L${b.x},${y} M${a.x},${y+open} L${b.x},${y}`,class:'hairpin',fill:'none',stroke:'#222','stroke-width':1.5});
      }
      path.addEventListener('pointerdown',(event)=>{event.stopPropagation();selectedAnnotation=annotationIndex;render();});
      if(selectedAnnotation===annotationIndex){
        [['start',a.x],['end',b.x]].forEach(([side,cx])=>{
          const handle=svg('circle',{cx,cy:y,r:5,class:'hairpin-handle'});
          handle.addEventListener('pointerdown',(event)=>{event.preventDefault();event.stopPropagation();hairpinDrag={index:annotationIndex,side,voice:ann.start.voice};});
        });
      }
    } else if(ann.type==='ending'){
      const firstLayout=layouts.get(ann.start.measure),lastLayout=layouts.get(ann.end.measure);
      const x1=ann.measureSpan&&firstLayout?firstLayout.x:a.x-8;
      const x2=ann.measureSpan&&lastLayout?lastLayout.x+lastLayout.width:b.x+13;
      const y=Math.min(a.topY,b.topY)-27;
      svg('path',{d:`M${x1},${y+8} V${y} H${x2}${ann.closed?` V${y+8}`:''}`,class:'ending-line',fill:'none',stroke:'#222','stroke-width':1.5});
      svg('text',{x:x1+4,y:y-3,text:`${ann.number}.`,class:'ending-text','font-size':12*notationScale,'font-family':'serif'});
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
        if(ann.start.noteId===ann.end.noteId)return;
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
  });
}

function render() {
  ensureEditableRests();
  scoreSvg.replaceChildren();
  notationSvg=null;
  renderedNotes=new Map();
  renderedSystemBreaks=[];
  $('#printTitle').textContent = score.metadata.title;
  $('#printLyricist').textContent = score.metadata.lyricist || '';
  $('#printComposer').textContent = score.metadata.composer || '';
  sheet.style.setProperty('--score-text-font',score.textFont||'Georgia, serif');
  sheet.dataset.page = score.page;
  const baseWidth = score.page === 'Screen' ? 1100 : score.page === 'A3' ? 1000 : 720;
  const densityScale=Math.max(1,(Number(score.measuresPerSystem)||3)/3);
  const width = baseWidth*densityScale;
  const sys = systems();
  const showLowerStaff=score.instrument==='piano'||score.showTab!==false;
  const requestedSpacing=Math.max(225, Math.min(320, Number(score.systemSpacing) || 245));
  const systemHeight = showLowerStaff?requestedSpacing*densityScale:Math.max(120,requestedSpacing*.54)*Math.min(densityScale,1.25), top = 5*densityScale;
  const logicalHeight=Math.max(220*densityScale,top+sys.length*systemHeight);
  if(!VF){status.textContent='악보 렌더링 라이브러리를 불러오지 못했습니다.';return;}
  const context=new VF.SVGContext(scoreSvg).resize(width,logicalHeight);
  notationSvg=scoreSvg.querySelector(':scope > svg');
  notationSvg.setAttribute('viewBox',`0 0 ${width} ${logicalHeight}`);
  notationSvg.removeAttribute('width');notationSvg.removeAttribute('height');
  notationSvg.style.width='100%';notationSvg.style.height='auto';
  notationSvg.setAttribute('preserveAspectRatio','xMinYMin meet');
  const layouts = new Map();
  const selected=selectedIds();
  const voiceColors=['#111','#2368c4','#b33a3a','#15805f'];
  let currentKeyFifths=Number(score.keyFifths)||0;
  sys.forEach((items, systemIndex) => {
    const y=top+systemIndex*systemHeight;
    const left=32*densityScale, usable=width-left-72*densityScale;
    // The first measure of every system also contains clef, key and time
    // signature. Giving every measure the same width made a rhythmically busy
    // first measure spill across the following barline.
    const firstMeasureAllowance=Math.min(usable*.28,72*densityScale);
    const regularMeasureWidth=Math.max(80,(usable-firstMeasureAllowance)/items.length);
    let runningX=left;
    const piano = score.instrument === 'piano';
    let firstStaff=null,firstLower=null;
    items.forEach(({ measure, index }, localIndex) => {
      const measureWidth=regularMeasureWidth+(localIndex===0?firstMeasureAllowance:0);
      const x=runningX;runningX+=measureWidth;
      const staff=new VF.Stave(x,y,measureWidth);
      const lower=showLowerStaff?(piano?new VF.Stave(x,y+122*densityScale,measureWidth):new VF.TabStave(x,y+122*densityScale,measureWidth)):null;
      const keyChanged=Number.isFinite(measure.keyFifths)&&measure.keyFifths!==currentKeyFifths;
      if(Number.isFinite(measure.keyFifths))currentKeyFifths=measure.keyFifths;
      if(localIndex===0){
        staff.addClef('treble','default',piano?undefined:'8vb');
        staff.addKeySignature(KEY_BY_FIFTHS[Math.max(0,Math.min(14,currentKeyFifths+7))]);
        if(systemIndex===0)staff.addTimeSignature(score.timeSymbol==='common'?'C':`${score.timeSignature.beats}/${score.timeSignature.beatType}`);
        if(systemIndex===0&&score.tempo)staff.setTempo({duration:'q',bpm:score.tempo},-18);
        lower?.addClef(piano?'bass':'tab');
        firstStaff=staff;firstLower=lower;
      }else if(keyChanged){
        staff.addKeySignature(KEY_BY_FIFTHS[Math.max(0,Math.min(14,currentKeyFifths+7))]);
      }
      if(measure.repeatStart){staff.setBegBarType(VF.Barline.type.REPEAT_BEGIN);lower?.setBegBarType(VF.Barline.type.REPEAT_BEGIN);}
      if(measure.repeatEnd){staff.setEndBarType(VF.Barline.type.REPEAT_END);lower?.setEndBarType(VF.Barline.type.REPEAT_END);}
      VF.Stave.formatBegModifiers(lower?[staff,lower]:[staff]);
      staff.setContext(context).draw();lower?.setContext(context).draw();
      const staffTop=staff.getYForLine(0),staffBottom=staff.getYForLine(4);
      const lowerTop=lower?.getYForLine(0)??staffTop,lowerBottom=lower?.getYForLine(piano?4:5)??staffBottom;
      layouts.set(index,{x,width:measureWidth,staffY:staffTop,tabY:lowerTop,lowerBottom,noteStart:staff.getNoteStartX(),noteEnd:staff.getNoteEndX(),system:systemIndex});
      const staffVoices=[],tabVoices=[],staffById=new Map(),tabById=new Map(),staffBeams=[],tabBeams=[],staffTuplets=[],tabTuplets=[];
      measure.voices.forEach((modelVoice,voiceIndex)=>{
        if(!modelVoice.length)return;
        const active=voiceIndex===score.activeVoice;
        const voiceColor=active?voiceColors[voiceIndex]:'#aeb4bf';
        const direction=voiceIndex%2===0?VF.Stem.UP:VF.Stem.DOWN;
        const staffNotes=[],tabNotes=[];
        let pendingStaffGrace=[],pendingTabGrace=[];
        let renderTick=0;
        modelVoice.forEach((note)=>{
          const startTick=Number.isFinite(note.startTick)?note.startTick:renderTick;
          if(startTick>renderTick+.01){
            const staffSpacers=spacerNotes(startTick-renderTick),tabSpacers=spacerNotes(startTick-renderTick);
            staffNotes.push(...staffSpacers);tabNotes.push(...tabSpacers);renderTick=startTick;
          }
          const chordMidis=note.pitches?.length?note.pitches:[note.midi];
          const chordKeys=chordMidis.map(vexKey);
          const chordPositions=note.positions?.length?note.positions.map(({string,fret})=>({str:string,fret})):[{str:note.string,fret:note.fret}];
          const noteColor=active&&selected.has(note.id)?'#d97706':voiceColor;
          if(note.grace){
            const graceStaff=new VF.GraceNote({keys:chordKeys,duration:'16',slash:!!note.graceSlash,stem_direction:direction});
            const graceTab=lower?new VF.GraceTabNote({positions:chordPositions,duration:'16',stem_direction:direction}):null;
            chordKeys.forEach((key,keyIndex)=>{
              const importedAccidental=note.accidentals?.[keyIndex]??(keyIndex===0?note.accidental:null);
              const symbol={sharp:'#',flat:'b',natural:'n','double-sharp':'##','flat-flat':'bb'}[importedAccidental];
              if(symbol)graceStaff.addModifier(new VF.Accidental(symbol),keyIndex);
            });
            graceStaff.setStyle({fillStyle:noteColor,strokeStyle:noteColor});graceTab?.setStyle({fillStyle:noteColor,strokeStyle:noteColor});
            pendingStaffGrace.push(graceStaff);if(graceTab)pendingTabGrace.push(graceTab);
            staffById.set(note.id,graceStaff);if(graceTab)tabById.set(note.id,graceTab);
            return;
          }
          let staveNote;
          staveNote=new VF.StaveNote({keys:chordKeys,duration:vexDuration(note,note.rest),stem_direction:direction});
          if(!note.rest)chordKeys.forEach((key,keyIndex)=>{
            const importedAccidental=note.accidentals?.[keyIndex]??(keyIndex===0?note.accidental:null);
            const accidentalMap={sharp:'#',flat:'b',natural:'n','double-sharp':'##','flat-flat':'bb'};
            const symbol=accidentalMap[importedAccidental]||(!score.importedXml&&key.includes('#')?'#':null);
            if(symbol)staveNote.addModifier(new VF.Accidental(symbol),keyIndex);
          });
          const dotCount=Number.isFinite(note.dots)?note.dots:(note.dotted?1:0);
          for(let dotIndex=0;dotIndex<dotCount;dotIndex++)VF.Dot.buildAndAttach([staveNote],{all:true});
          if(note.fermata)staveNote.addModifier(new VF.Articulation('a@a').setPosition(note.fermata==='below'?VF.Modifier.Position.BELOW:VF.Modifier.Position.ABOVE));
          staveNote.setStyle({fillStyle:noteColor,strokeStyle:noteColor});
          staffNotes.push(staveNote);staffById.set(note.id,staveNote);
          const tabNote=lower?(note.rest?new VF.GhostNote({duration:vexDuration(note)}):new VF.TabNote({positions:chordPositions,duration:vexDuration(note),stem_direction:direction},true)):null;
          if(tabNote&&!note.rest)for(let dotIndex=0;dotIndex<dotCount;dotIndex++)VF.Dot.buildAndAttach([tabNote],{all:true});
          if(tabNote&&!note.rest)tabNote.setStyle({fillStyle:noteColor,strokeStyle:noteColor});
          if(pendingStaffGrace.length){
            const group=new VF.GraceNoteGroup(pendingStaffGrace,false);
            if(pendingStaffGrace.length>1)group.beamNotes();
            staveNote.addModifier(group);pendingStaffGrace=[];
          }
          if(tabNote&&pendingTabGrace.length&&!note.rest){
            const group=new VF.GraceNoteGroup(pendingTabGrace,false);
            if(pendingTabGrace.length>1)group.beamNotes();
            tabNote.addModifier(group);pendingTabGrace=[];
          }
          if(tabNote){tabNotes.push(tabNote);tabById.set(note.id,tabNote);}
          renderTick=Math.max(renderTick,startTick+durationTicks(note));
        });
        staffNotes.forEach((note)=>note.setStave(staff));
        if(lower)tabNotes.forEach((note)=>note.setStave(lower));
        const time={num_beats:score.timeSignature.beats,beat_value:score.timeSignature.beatType};
        const sv=new VF.Voice(time).setMode(VF.Voice.Mode.SOFT).addTickables(staffNotes).setStave(staff);
        const tv=lower?new VF.Voice(time).setMode(VF.Voice.Mode.SOFT).addTickables(tabNotes).setStave(lower):null;
        staffVoices.push(sv);if(tv)tabVoices.push(tv);
        const beam=beamData(measure,voiceIndex);
        beam.groups.forEach((items)=>{
          const s=items.filter(({note})=>!note.grace).map(({note})=>staffById.get(note.id)).filter(Boolean);
          const t=items.filter(({note})=>!note.grace).map(({note})=>tabById.get(note.id)).filter((item)=>item&&!(item instanceof VF.GhostNote));
          if(s.length>1){
            const staffBeam=new VF.Beam(s,false).setStyle({fillStyle:voiceColor,strokeStyle:voiceColor});
            staffBeams.push(staffBeam);
          }
          if(t.length>1){
            const tabBeam=new VF.Beam(t,false).setStyle({fillStyle:voiceColor,strokeStyle:voiceColor});
            tabBeams.push(tabBeam);
          }
        });
        for(let tupletIndex=0;tupletIndex<modelVoice.length;){
          const first=modelVoice[tupletIndex],actual=first.tuplet?.actual,normal=first.tuplet?.normal;
          if(!actual||!normal){tupletIndex++;continue;}
          const group=modelVoice.slice(tupletIndex,tupletIndex+actual).filter((note)=>note.tuplet?.actual===actual&&note.tuplet?.normal===normal);
          if(group.length===actual){
            const staffGroup=group.map((note)=>staffById.get(note.id)).filter(Boolean);
            const tabGroup=group.map((note)=>tabById.get(note.id)).filter((note)=>note&&!(note instanceof VF.GhostNote));
            if(staffGroup.length===actual)staffTuplets.push(new VF.Tuplet(staffGroup,{num_notes:actual,notes_occupied:normal}));
            if(tabGroup.length===actual)tabTuplets.push(new VF.Tuplet(tabGroup,{num_notes:actual,notes_occupied:normal}));
            tupletIndex+=actual;
          }else tupletIndex++;
        }
      });
      const allVoices=[...staffVoices,...tabVoices];
      if(allVoices.length){
        const formatter=new VF.Formatter();
        if(staffVoices.length)formatter.joinVoices(staffVoices);
        if(tabVoices.length)formatter.joinVoices(tabVoices);
        const start=Math.max(staff.getNoteStartX(),lower?.getNoteStartX()??staff.getNoteStartX());
        staffVoices.forEach((v)=>v.setStave(staff));if(lower)tabVoices.forEach((v)=>v.setStave(lower));
        formatter.format(allVoices,Math.max(30,staff.getNoteEndX()-start-8));
        // TAB voices already share an exact rhythmic grid. Reuse that grid on
        // the staff so accidentals and VexFlow's collision avoidance cannot
        // make simultaneous notes in different voices appear at different beats.
        if(lower&&!piano)measure.voices.forEach((voice)=>voice.forEach((note)=>{
          const staffNote=staffById.get(note.id),tabNote=tabById.get(note.id);
          if(!staffNote||!tabNote||note.grace||note.rest)return;
          const shift=(staffNote.getXShift?.()||0)+(tabNote.getAbsoluteX()-staffNote.getAbsoluteX());
          staffNote.setXShift?.(shift);
        }));
        staffVoices.forEach((v)=>v.draw(context,staff));tabVoices.forEach((v)=>v.draw(context,lower));
        staffBeams.forEach((beam)=>beam.setContext(context).draw());tabBeams.forEach((beam)=>beam.setContext(context).draw());
        staffTuplets.forEach((tuplet)=>tuplet.setContext(context).draw());tabTuplets.forEach((tuplet)=>tuplet.setContext(context).draw());
        measure.voices.forEach((voice,voiceIndex)=>voice.forEach((note)=>{
          const sn=staffById.get(note.id),tn=tabById.get(note.id);
          if(!sn)return;
          const noteX=sn.getAbsoluteX(),noteY=sn.getYs?.()[0]??staffTop+20;
          const tabX=tn?.getAbsoluteX?.()??noteX,tabNoteY=tn?.getYs?.()[0]??lowerTop;
          const stem=sn.getStemExtents?.();
          const topY=Math.min(noteY,stem?.topY??noteY,stem?.baseY??noteY);
          const bottomY=Math.max(noteY,stem?.topY??noteY,stem?.baseY??noteY);
          renderedNotes.set(note.id,{x:noteX,noteY,topY,bottomY,tabX,tabNoteY,staffY:staffTop,tabY:lowerTop,system:systemIndex});
          if(note.dynamic)svg('text',{x:noteX-5,y:bottomY+23*densityScale,text:note.dynamic,class:'dynamic-mark','font-size':15*densityScale,'font-family':'serif','font-style':'italic','font-weight':'bold'});
        }));
      }
      if(localIndex===0)svg('text',{x:x+3,y:staffTop-12,text:String(index+1),class:'measure-number','font-size':11,'font-family':'Arial, sans-serif','font-weight':'700',fill:'#4b5870'});
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
    renderedSystemBreaks.push(Math.min(logicalHeight,top+(systemIndex+1)*systemHeight));
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
    if(voice!==score.activeVoice)return;
    const p=renderedNotes.get(note.id),layout=layouts.get(measure);if(!p||!layout)return;
    const sh=svg('rect',{x:p.x-13,y:layout.staffY-22,width:26,height:84,class:'hit','data-note-id':note.id,'data-measure':measure,'data-voice':voice,'data-source':'staff'});
    sh.addEventListener('pointerdown',(e)=>beginRangeSelection(e,measure,voice,note.id,'staff'));
    sh.addEventListener('pointerenter',()=>extendRangeSelection(measure,voice,note.id));
    sh.addEventListener('click',(e)=>{e.stopPropagation();if(ignoreNextClick){ignoreNextClick=false;return;}setSelection(measure,voice,note.id,e.shiftKey,'staff');});
    if(score.instrument!=='piano'&&score.showTab!==false&&!note.rest){const th=svg('rect',{x:p.tabX-14,y:p.tabNoteY-11,width:28,height:22,class:'hit','data-note-id':note.id,'data-measure':measure,'data-voice':voice,'data-source':'tab'});th.addEventListener('pointerdown',(e)=>beginRangeSelection(e,measure,voice,note.id,'tab'));th.addEventListener('pointerenter',()=>extendRangeSelection(measure,voice,note.id));th.addEventListener('click',(e)=>{e.stopPropagation();if(ignoreNextClick){ignoreNextClick=false;return;}setSelection(measure,voice,note.id,e.shiftKey,'tab');});}
  });
  drawAnnotations(layouts);
  const entry = selectedEntry();
  status.textContent = entry
    ? `성부 ${entry.voice+1}(${VOICE_COLORS[entry.voice]}) · ${entry.measureIndex+1}마디 · ${entry.note.string}번 줄 ${entry.note.fret}프렛 · MIDI ${entry.note.midi}`
    : `성부 ${score.activeVoice+1}(${VOICE_COLORS[score.activeVoice]}) · ${score.selection.measure+1}마디 · ${Number((((score.selection.cursorTick??0)/(8*(4/score.timeSignature.beatType)))+1).toFixed(2))}박 위치`;
}

scoreSvg.setAttribute('tabindex','0');
scoreSvg.addEventListener('pointerdown',()=>{
  document.activeElement?.blur?.();
  scoreSvg.focus?.({preventScroll:true});
},{capture:true});

function updateControls() {
  $('#voice').textContent = `V${score.activeVoice+1}`;
  $('#addVoice').disabled=(score.voiceCount||1)>=4;
  $('#dot').classList.toggle('active', dotted);
  $('#doubleDot').classList.toggle('active', doubleDotted);
  $('#sharp').classList.toggle('active', pendingAccidental===1);
  $('#flat').classList.toggle('active', pendingAccidental===-1);
  $('#rest').classList.toggle('active', restMode);
  $('#grace').classList.toggle('active', graceMode || !!selectedEntry()?.note.grace);
  $('#toggleTab').classList.toggle('active', score.showTab!==false);
  $('#toggleTab').textContent=score.showTab===false?'타브 보이기':'타브 숨기기';
  $('#toggleTab').disabled=score.instrument==='piano';
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

function bestPosition(midi, measure=null, voice=score.activeVoice, targetTick=null) {
  const choices = positionsForMidi(midi);
  const ordered=choices.sort((a,b) => a.fret-b.fret || a.string-b.string);
  if(measure){
    const occupied=stringsUsedAtTick(measure,voice,targetTick??measureTicks(measure,voice));
    const alternative=ordered.find((position)=>!occupied.has(position.string));
    if(alternative)return alternative;
  }
  return ordered[0] || { string:1, fret:Math.max(0,midi-TUNING[0]) };
}

function appendRestsToTick(measure,voice,targetTick){
  let gap=targetTick-measureTicks(measure,voice);
  for(const value of [32,16,8,4,2,1]){
    while(gap>=value){const rest=noteFromStringFret(1,0,value,false,false);rest.rest=true;measure.voices[voice].push(rest);gap-=value;}
  }
}

function keyAdjustedMidi(midi) {
  const fifths=Math.max(-7,Math.min(7,Number(score.keyFifths)||0));
  const pc=((midi%12)+12)%12;
  const sharpOrder=[5,0,7,2,9,4,11],flatOrder=[11,4,9,2,7,0,5];
  if(fifths>0&&sharpOrder.slice(0,fifths).includes(pc))return midi+1;
  if(fifths<0&&flatOrder.slice(0,-fifths).includes(pc))return midi-1;
  return midi;
}

function addNote(midi) {
  const naturalMidi=midi;
  midi=pendingAccidental?naturalMidi+pendingAccidental:keyAdjustedMidi(naturalMidi);
  let measureIndex = score.selection.measure;
  let measure = score.measures[measureIndex];
  const cursorInsert=!score.selection.noteId&&Number.isFinite(score.selection.cursorTick);
  const targetTick=cursorInsert?Math.max(0,Math.min(measureLimit(),score.selection.cursorTick)):measureTicks(measure,score.activeVoice);
  const inputDots=doubleDotted?2:(dotted?1:0);
  const newTicks=duration*dotMultiplier(inputDots);
  const selected=selectedEntry();
  const caretRest=cursorInsert?noteAtTick(measure,score.activeVoice,targetTick):null;
  const replacing=selected||(caretRest?.rest?{note:caretRest,measure,measureIndex,voice:score.activeVoice}:null);
  if(graceMode&&replacing&&!replacing.note.grace){
    remember();
    materializeVoiceTicks(replacing.measure,replacing.voice);
    const start=replacing.note.startTick,position=bestPosition(midi,replacing.measure,replacing.voice,start);
    const grace=noteFromStringFret(position.string,position.fret,duration,dotted,true);
    Object.assign(grace,{midi,diatonicMidi:naturalMidi,accidental:pendingAccidental===1?'sharp':pendingAccidental===-1?'flat':null,dots:inputDots,dotted:inputDots>0,startTick:start,ticks:0,grace:true});
    const voice=replacing.measure.voices[replacing.voice],anchor=voice.findIndex((note)=>note.id===replacing.note.id);
    voice.splice(Math.max(0,anchor),0,grace);
    pendingAccidental=0;dotted=false;doubleDotted=false;score.selection.source='staff';score.selection.rangeEnd=null;updateControls();render();return;
  }
  if(replacing){
    remember();
    materializeVoiceTicks(replacing.measure,replacing.voice);
    const start=replacing.note.startTick,oldTicks=durationTicks(replacing.note),delta=newTicks-oldTicks;
    const position=bestPosition(midi,replacing.measure,replacing.voice,start);
    if(delta>0)replacing.measure.voices[replacing.voice].forEach((note)=>{if(note.id!==replacing.note.id&&note.startTick>start)note.startTick+=delta;});
    Object.assign(replacing.note,{midi,diatonicMidi:naturalMidi,accidental:pendingAccidental===1?'sharp':pendingAccidental===-1?'flat':null,string:position.string,fret:position.fret,duration,dots:inputDots,dotted:inputDots>0,rest:restMode,grace:graceMode,startTick:start,ticks:newTicks,measureRest:false});
    delete replacing.note.pitches;delete replacing.note.positions;delete replacing.note.positionImported;delete replacing.note.tabImported;
    delete replacing.note.tuplet;
    if(delta<0)replacing.measure.voices[replacing.voice].push(...restParts(-delta,start+newTicks));
    normalizeVoiceToMeasure(replacing.measure,replacing.voice);
    let nextMeasure=replacing.measureIndex,nextTick=start+newTicks;
    if(nextTick>=measureLimit()){
      nextMeasure=replacing.measureIndex+1;nextTick=0;
      if(!score.measures[nextMeasure])score.measures.push(createMeasure());
    }
    score.selection={measure:nextMeasure,voice:replacing.voice,noteId:null,source:'staff',cursorTick:nextTick,rangeEnd:null};
    pendingAccidental=0;dotted=false;doubleDotted=false;updateControls();render();return;
  }
  if(cursorInsert&&Math.max(measureTicks(measure,score.activeVoice),targetTick)+newTicks>measureLimit()){
    showMeasureWarning(measureIndex);return;
  }
  remember();
  if (measureTicks(measure, score.activeVoice) + newTicks > measureLimit()) {
    measureIndex++;
    if (!score.measures[measureIndex]) score.measures.push(createMeasure());
    measure = score.measures[measureIndex];
  }
  if(cursorInsert&&measureIndex===score.selection.measure)appendRestsToTick(measure,score.activeVoice,targetTick);
  const insertionTick=cursorInsert&&measureIndex===score.selection.measure?targetTick:measureTicks(measure,score.activeVoice);
  const pos = bestPosition(midi,measure,score.activeVoice,insertionTick);
  const note = noteFromStringFret(pos.string, pos.fret, duration, dotted, graceMode);
  note.dots=inputDots;note.dotted=inputDots>0;
  note.diatonicMidi=naturalMidi;note.accidental=pendingAccidental===1?'sharp':pendingAccidental===-1?'flat':null;
  note.rest = restMode;
  const voice=measure.voices[score.activeVoice];
  if(cursorInsert&&measureIndex===score.selection.measure&&insertionTick<measureTicks(measure,score.activeVoice)){
    let tick=0,index=voice.length;
    for(let i=0;i<voice.length;i++){if(tick>=insertionTick){index=i;break;}tick+=durationTicks(voice[i]);}
    voice.splice(index,0,note);
  }else voice.push(note);
  let nextMeasure=measureIndex,nextTick=insertionTick+newTicks;
  if(nextTick>=measureLimit()){
    nextMeasure=measureIndex+1;nextTick=0;
    if(!score.measures[nextMeasure])score.measures.push(createMeasure());
  }
  // A newly entered note advances the insertion caret. Clicking an existing
  // note still selects it, so the next pitch replaces that selected event.
  score.selection = { measure:nextMeasure, voice:score.activeVoice, noteId:null, source:'staff', cursorTick:nextTick, rangeEnd:null };
  if (measureTicks(measure, score.activeVoice) >= measureLimit() && measureIndex === score.measures.length - 1) score.measures.push(createMeasure());
  graceMode = false;
  pendingAccidental = 0;
  dotted = false;
  doubleDotted = false;
  updateControls(); render();
}

function orderedSelection() {
  const start = score.selection.noteId ? { measure:score.selection.measure, voice:score.selection.voice, noteId:score.selection.noteId } : null;
  const end = score.selection.rangeEnd;
  if (!start) return null;
  return { start, end:end || start };
}

function selectedEntries(minimum=1) {
  const ids=selectedIds();
  let entries=selectionOrder().filter((item)=>ids.has(item.note.id));
  if(entries.length===1&&minimum>1){
    const all=selectionOrder().filter((item)=>item.voice===entries[0].voice&&item.measure===entries[0].measure);
    const start=all.findIndex((item)=>item.note.id===entries[0].note.id);
    entries=all.slice(start,start+minimum);
  }
  return entries;
}

function toggleRepeat(which) {
  const measure=score.measures[score.selection.measure];if(!measure)return;
  remember();measure[which]=!measure[which];render();
}

function toggleTuplet() {
  const entries=selectedEntries(3).filter((item)=>!item.note.grace);
  if(entries.length!==3){status.textContent='셋잇단음표로 묶을 같은 성부의 음표 세 개를 선택하세요.';return;}
  const remove=entries.every(({note})=>note.tuplet?.actual===3&&note.tuplet?.normal===2);
  remember();entries.forEach(({note})=>{if(remove){delete note.tuplet;delete note.ticks;}else{note.tuplet={actual:3,normal:2};note.ticks=note.duration*dotMultiplier(note.dots??(note.dotted?1:0))*2/3;}});render();
}

function toggleBeam() {
  const entries=selectedEntries(2).filter(({note})=>!note.rest&&!note.grace&&note.duration<=4);
  if(entries.length<2){status.textContent='빔으로 묶을 8분음표 이하의 음표를 둘 이상 선택하세요.';return;}
  const remove=entries.every(({note})=>note.beams?.length);
  remember();entries.forEach(({note},index)=>{if(remove)delete note.beams;else note.beams=[{number:1,value:index===0?'begin':index===entries.length-1?'end':'continue'},...(note.duration<=2?[{number:2,value:index===0?'begin':index===entries.length-1?'end':'continue'}]:[])];});render();
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
      duplicate.dots=entry.note.dots??(entry.note.dotted?1:0);
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

function addRangeMark(type, extra={}) {
  const range=orderedSelection();
  if(!range){status.textContent='첫 음표부터 마지막 음표까지 드래그하여 범위를 선택하세요.';return;}
  remember();score.annotations.push({type,...range,...extra});render();
}

function addMeasureEnding(number){
  const startMeasure=score.selection.measure;
  const endMeasure=score.selection.rangeEnd?.measure??startMeasure;
  const firstMeasure=Math.min(startMeasure,endMeasure),lastMeasure=Math.max(startMeasure,endMeasure);
  const firstEntries=selectionOrder().filter((entry)=>entry.measure===firstMeasure);
  const lastEntries=selectionOrder().filter((entry)=>entry.measure===lastMeasure);
  if(!firstEntries.length||!lastEntries.length){status.textContent='반복 번호를 붙일 마디에 음표나 쉼표가 필요합니다.';return;}
  const start=firstEntries[0],end=lastEntries[lastEntries.length-1];
  remember();
  score.annotations.push({type:'ending',number,closed:number===1,start:{measure:firstMeasure,voice:start.voice,noteId:start.note.id},end:{measure:lastMeasure,voice:end.voice,noteId:end.note.id},measureSpan:true});
  render();
}

function addHairpin(type){
  let range=orderedSelection();
  if(!range){status.textContent='크레셴도나 디미누엔도를 시작할 음표를 먼저 선택하세요.';return;}
  if(range.start.noteId===range.end.noteId){
    const entries=selectionOrder().filter((entry)=>entry.voice===range.start.voice&&entry.measure===range.start.measure);
    const index=entries.findIndex((entry)=>entry.note.id===range.start.noteId);
    const next=entries[index+1];
    if(!next){status.textContent='같은 마디 안에 길이를 정할 다음 음표가 필요합니다.';return;}
    range.end={measure:next.measure,voice:next.voice,noteId:next.note.id};
  }
  remember();
  score.annotations.push({type,...range});
  selectedAnnotation=score.annotations.length-1;
  status.textContent='파란 원형 손잡이를 좌우로 드래그해 길이를 조절하세요.';
  render();
}

function moveSelection(delta) {
  const list = allNotes(score, score.activeVoice);
  const index = list.findIndex(({note}) => note.id === score.selection.noteId);
  if (!list.length) return;
  const next = list[Math.max(0, Math.min(list.length-1, (index < 0 ? 0 : index) + delta))];
  setSelection(next.measureIndex, next.voice, next.note.id, false, score.selection.source || 'staff');
}

function moveVoiceCursor(direction){
  const step=duration*(dotted?1.5:1);
  let measureIndex=score.selection.measure,tick=(score.selection.cursorTick??0)+direction*step;
  if(tick<0&&measureIndex>0){measureIndex--;tick=Math.max(0,measureLimit()-step);}
  else if(tick>measureLimit()&&measureIndex<score.measures.length-1){measureIndex++;tick=0;}
  tick=Math.max(0,Math.min(measureLimit(),tick));
  score.selection={measure:measureIndex,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:tick,rangeEnd:null};
  render();
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

function applyAccidental(value) {
  const entry=selectedEntry();
  if(!entry||entry.note.rest){
    pendingAccidental=pendingAccidental===value?0:value;
    updateControls();return;
  }
  remember();
  const oldDelta=entry.note.accidental==='sharp'?1:entry.note.accidental==='flat'?-1:0;
  const natural=Number.isFinite(entry.note.diatonicMidi)?entry.note.diatonicMidi:entry.note.midi-oldDelta;
  const midi=natural+value,position=bestPosition(midi,entry.measure,entry.voice,notePosition(entry.note,entry.measure,entry.voice));
  Object.assign(entry.note,{midi,diatonicMidi:natural,accidental:value===1?'sharp':'flat',string:position.string,fret:position.fret});
  pendingAccidental=0;render();
}

function deleteSelected() {
  const entry = selectedEntry(); if (!entry) return;
  remember();
  const ticks=durationTicks(entry.note),start=notePosition(entry.note,entry.measure,entry.voice);
  Object.assign(entry.note,{rest:true,grace:false,startTick:start,ticks,measureRest:start===0&&Math.abs(ticks-measureLimit())<.001});
  delete entry.note.pitches;delete entry.note.positions;delete entry.note.positionImported;delete entry.note.tabImported;delete entry.note.tuplet;delete entry.note.accidental;delete entry.note.accidentals;
  score.annotations = score.annotations.filter((a) => a.start.noteId !== entry.note.id && a.end.noteId !== entry.note.id);
  render();
}

function insertMeasureAfterSelection() {
  remember();
  const after=Math.max(0,Math.min(score.measures.length-1,score.selection.measure));
  score.measures.splice(after+1,0,createMeasure());
  score.annotations.forEach((annotation)=>{
    if(annotation.start.measure>after)annotation.start.measure++;
    if(annotation.end.measure>after)annotation.end.measure++;
  });
  score.selection={measure:after+1,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:0,rangeEnd:null};
  render();
}

function escapeXml(value='') { return value.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])); }
const STEP = ['C','C','D','D','E','F','F','G','G','A','A','B'];
const ALTER = [0,1,0,1,0,0,1,0,1,0,1,0];

function toMusicXml() {
  const instrumentName = ({'classical-guitar':'Classical Guitar','acoustic-guitar':'Acoustic Guitar','electric-guitar':'Electric Guitar',piano:'Piano'})[score.instrument];
  const annotationStarts=new Map(),annotationEnds=new Map();
  score.annotations.forEach((annotation)=>{
    if(annotation.start?.noteId){const list=annotationStarts.get(annotation.start.noteId)||[];list.push(annotation);annotationStarts.set(annotation.start.noteId,list);}
    if(annotation.end?.noteId){const list=annotationEnds.get(annotation.end.noteId)||[];list.push(annotation);annotationEnds.set(annotation.end.noteId,list);}
  });
  let exportedKey=Number(score.keyFifths)||0;
  const measures = score.measures.map((m, mi) => {
    let body = `${mi > 0 && score.measures[mi-1].forceBreakAfter ? '<print new-system="yes"/>' : ''}${mi === 0 ? `<attributes><divisions>8</divisions><key><fifths>${score.keyFifths||0}</fifths></key><time${score.timeSymbol==='common'?' symbol="common"':''}><beats>${score.timeSignature.beats}</beats><beat-type>${score.timeSignature.beatType}</beat-type></time><staves>2</staves>${score.instrument==='piano'?'':'<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>'}<clef number="1"><sign>G</sign><line>2</line></clef>${score.instrument==='piano'?'<clef number="2"><sign>F</sign><line>4</line></clef>':'<clef number="2"><sign>TAB</sign><line>5</line></clef><staff-details number="2"><staff-lines>6</staff-lines></staff-details>'}</attributes>${score.tempo?`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`:''}` : ''}`;
    if(mi>0&&Number.isFinite(m.keyFifths)&&m.keyFifths!==exportedKey){exportedKey=m.keyFifths;body+=`<attributes><key><fifths>${exportedKey}</fifths></key></attributes>`;}
    const endingStarts=score.annotations.filter((annotation)=>annotation.type==='ending'&&annotation.start?.measure===mi);
    endingStarts.forEach((annotation)=>{body+=`<barline location="left"><ending number="${annotation.number}" type="start"/></barline>`;});
    if(m.repeatStart)body+='<barline location="left"><repeat direction="forward"/></barline>';
    m.directions?.forEach((direction)=>{const justify=direction.align==='end'?'right':direction.align==='center'?'center':'left';body+=`<direction placement="${direction.placement||'above'}"><direction-type><words justify="${justify}">${escapeXml(direction.text)}</words></direction-type></direction>`;});
    m.voices.forEach((voice, vi) => {
      if (vi && voice.length) body += `<backup><duration>${measureLimit()}</duration></backup>`;
      voice.forEach((n) => {
        const starts=annotationStarts.get(n.id)||[],ends=annotationEnds.get(n.id)||[];
        if(n.dynamic)body+=`<direction placement="below"><direction-type><dynamics><${n.dynamic}/></dynamics></direction-type></direction>`;
        starts.filter((annotation)=>annotation.type==='crescendo'||annotation.type==='diminuendo').forEach((annotation)=>{body+=`<direction placement="below"><direction-type><wedge type="${annotation.type==='crescendo'?'crescendo':'diminuendo'}" number="1"/></direction-type></direction>`;});
        ends.filter((annotation)=>annotation.type==='crescendo'||annotation.type==='diminuendo').forEach(()=>{body+='<direction placement="below"><direction-type><wedge type="stop" number="1"/></direction-type></direction>';});
        const xmlMidi = score.instrument === 'piano' ? n.midi : n.midi + 12;
        const pc = ((xmlMidi%12)+12)%12, octave = Math.floor(xmlMidi/12)-1;
        const dots=n.dots??(n.dotted?1:0),notations=[];
        if(!n.rest&&score.instrument!=='piano')notations.push(`<technical><string>${n.string}</string><fret>${n.fret}</fret></technical>`);
        if(n.fermata)notations.push(`<fermata${n.fermata==='below'?' type="inverted"':''}/>`);
        starts.filter((annotation)=>annotation.type==='tie').forEach(()=>notations.push('<tied type="start"/>'));
        ends.filter((annotation)=>annotation.type==='tie').forEach(()=>notations.push('<tied type="stop"/>'));
        starts.filter((annotation)=>annotation.type==='slur').forEach(()=>notations.push('<slur type="start" number="1"/>'));
        ends.filter((annotation)=>annotation.type==='slur').forEach(()=>notations.push('<slur type="stop" number="1"/>'));
        const ties=`${starts.some((annotation)=>annotation.type==='tie')?'<tie type="start"/>':''}${ends.some((annotation)=>annotation.type==='tie')?'<tie type="stop"/>':''}`;
        body += `<note>${n.grace?`<grace${n.graceSlash?' slash="yes"':''}/>`:''}${n.rest?'<rest/>':`<pitch><step>${STEP[pc]}</step>${ALTER[pc]?'<alter>1</alter>':''}<octave>${octave}</octave></pitch>`}${n.grace?'':`<duration>${durationTicks(n)}</duration>`}${ties}<voice>${vi+1}</voice><type>${({32:'whole',16:'half',8:'quarter',4:'eighth',2:'16th',1:'32nd'})[n.duration]||'quarter'}</type>${'<dot/>'.repeat(dots)}${n.tuplet?`<time-modification><actual-notes>${n.tuplet.actual}</actual-notes><normal-notes>${n.tuplet.normal}</normal-notes></time-modification>`:''}<staff>1</staff>${n.beams?.map((beam)=>`<beam number="${beam.number}">${beam.value}</beam>`).join('')||''}${notations.length?`<notations>${notations.join('')}</notations>`:''}</note>`;
      });
    });
    if(m.repeatEnd)body+='<barline location="right"><repeat direction="backward"/></barline>';
    const endingEnds=score.annotations.filter((annotation)=>annotation.type==='ending'&&annotation.end?.measure===mi);
    endingEnds.forEach((annotation)=>{body+=`<barline location="right"><ending number="${annotation.number}" type="${annotation.closed?'stop':'discontinue'}"/></barline>`;});
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
    const clone=notationSvg.cloneNode(true);
    clone.setAttribute('xmlns', NS);
    clone.querySelectorAll('.hit,.measure-hit,.selected-measure,.hairpin-handle').forEach((node)=>node.remove());
    clone.querySelectorAll('*').forEach((node)=>{
      for(const attr of ['fill','stroke','style']){
        const value=node.getAttribute(attr);if(!value)continue;
        node.setAttribute(attr,value.replaceAll('#aeb4bf','#111').replaceAll('#2368c4','#111').replaceAll('#b33a3a','#111').replaceAll('#15805f','#111').replaceAll('#d97706','#111'));
      }
    });
    const style=document.createElementNS(NS,'style');
    style.textContent='.staff-line,.ledger-line,.tab-line,.barline{stroke:#111;stroke-width:1}.system-bracket{fill:none;stroke:#111;stroke-width:2}.notehead{fill:#111!important}.stem{stroke:#111!important;stroke-width:1.3;fill:none}.beam{stroke:#111;stroke-width:5}.secondary-beam{stroke-width:3.5}.tab-bg{fill:#fff;stroke:none}.tab-number{fill:#111!important;font:bold 14px Arial;text-anchor:middle;dominant-baseline:middle}.inactive-voice{opacity:1}.slur,.tie,.hairpin,.ending-line{fill:none;stroke:#111;stroke-width:1.5}.barre{fill:none;stroke:#111;stroke-width:1.2;stroke-dasharray:5 4}.annotation-text{font:italic 13px serif}.break-mark{display:none}';
    clone.prepend(style);
    const viewBoxValues=clone.getAttribute('viewBox').trim().split(/\s+/).map(Number);
    const viewBox={width:viewBoxValues[2],height:viewBoxValues[3]};
    clone.setAttribute('width', viewBox.width); clone.setAttribute('height', viewBox.height);
    const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)],{type:'image/svg+xml'}));
    const image=new Image();
    image.onload=()=>{URL.revokeObjectURL(url);resolve({image,width:viewBox.width,height:viewBox.height,systemBreaks:[...renderedSystemBreaks]});};
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
      const maximum=Math.min(source.height,sourceY+capacity);
      const boundary=source.systemBreaks?.filter((value)=>value>sourceY+.5&&value<=maximum+.5).at(-1)||maximum;
      const sliceHeight=Math.max(.5,boundary-sourceY);
      slices.push({sourceY,height:sliceHeight,top:first?firstTop:normalTop,first});
      sourceY=boundary; first=false;
    }
    if(!slices.length) slices.push({sourceY:0,height:source.height,top:firstTop,first:true});
    const jpegs=[];
    for(const [pageIndex,slice] of slices.entries()) {
      const canvas=document.createElement('canvas');canvas.width=canvasWidth;canvas.height=canvasHeight;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvasWidth,canvasHeight);
      if(slice.first&&hasMetadata) {
        const pdfFont=score.textFont||'Georgia, serif';
        ctx.fillStyle='#111';ctx.textAlign='center';ctx.font=`bold ${Math.round(canvasWidth*.035)}px ${pdfFont}`;
        ctx.fillText(score.metadata.title||'',canvasWidth/2,Math.round(canvasHeight*.05));
        ctx.font=`${Math.round(canvasWidth*.018)}px ${pdfFont}`;
        ctx.textAlign='left';ctx.fillText(score.metadata.lyricist||'',margin,Math.round(canvasHeight*.085));
        ctx.textAlign='right';ctx.fillText(score.metadata.composer||'',canvasWidth-margin,Math.round(canvasHeight*.085));
      }else if(!slice.first&&score.metadata.title){
        const pdfFont=score.textFont||'Georgia, serif';ctx.fillStyle='#111';ctx.font=`${Math.round(canvasWidth*.015)}px ${pdfFont}`;
        ctx.textAlign='left';ctx.fillText(String(pageIndex+1),margin,Math.round(canvasHeight*.027));
        ctx.fillText(score.metadata.title,margin+Math.round(canvasWidth*.035),Math.round(canvasHeight*.027));
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

function automaticTabForScore(targetScore) {
  if(targetScore.instrument==='piano')return;
  let previousCenter=3;
  targetScore.measures.forEach((measure)=>{
    const events=new Map();
    measure.voices.forEach((voice,voiceIndex)=>voice.forEach((note)=>{
      if(note.rest)return;
      const tick=Number.isFinite(note.startTick)?note.startTick:notePosition(note,measure,voiceIndex);
      // Grace notes precede the main beat and may legitimately reuse its string.
      const key=note.grace?`${tick}:grace:${note.id}`:`${tick}:main`;
      const pitches=note.pitches?.length?note.pitches:[note.midi];
      const positions=note.positions?.length?note.positions:[{string:note.string,fret:note.fret}];
      const imported=note.positionImported?.length?note.positionImported:[!!note.tabImported];
      pitches.forEach((midi,index)=>{
        const list=events.get(key)||[];
        list.push({note,index,midi,position:positions[index],fixed:!!imported[index]});events.set(key,list);
      });
    }));
    [...events.entries()].sort((a,b)=>Number.parseFloat(a[0])-Number.parseFloat(b[0])).forEach(([,items])=>{
      const usedFixed=new Set(items.filter((item)=>item.fixed).map((item)=>item.position?.string));
      const flexible=items.filter((item)=>!item.fixed);
      let best=null;
      const search=(index,used,chosen)=>{
        if(index===flexible.length){
          const all=[...items.filter((item)=>item.fixed).map((item)=>({item,position:item.position})),...chosen];
          const frets=all.map(({position})=>position.fret),fretted=frets.filter((fret)=>fret>0);
          const min=fretted.length?Math.min(...fretted):previousCenter,max=fretted.length?Math.max(...fretted):previousCenter;
          const center=fretted.length?fretted.reduce((sum,value)=>sum+value,0)/fretted.length:previousCenter;
          let cost=frets.reduce((sum,value)=>sum+value*.7,0)+Math.abs(center-previousCenter)*1.8;
          const span=max-min;cost+=span>4?(span-4)**2*15:span*.35;
          all.forEach(({item,position})=>{cost+=Math.abs(position.string-(7-(item.midi-40)/5))*.08;});
          for(let a=0;a<all.length;a++)for(let b=a+1;b<all.length;b++){
            const high=all[a].item.midi>=all[b].item.midi?all[a]:all[b],low=high===all[a]?all[b]:all[a];
            if(high.position.string>low.position.string)cost+=12;
          }
          if(!best||cost<best.cost)best={cost,all,center};
          return;
        }
        const item=flexible[index];
        const choices=positionsForMidi(item.midi).filter((position)=>position.fret<=20&&!used.has(position.string)).sort((a,b)=>a.fret-b.fret||a.string-b.string);
        choices.forEach((position)=>{used.add(position.string);chosen.push({item,position});search(index+1,used,chosen);chosen.pop();used.delete(position.string);});
      };
      if(items.length<=6)search(0,new Set(usedFixed),[]);
      if(!best){
        const used=new Set(usedFixed),all=[];
        flexible.forEach((item)=>{const position=positionsForMidi(item.midi).filter((candidate)=>candidate.fret<=20&&!used.has(candidate.string)).sort((a,b)=>a.fret-b.fret)[0]||positionsForMidi(item.midi).sort((a,b)=>a.fret-b.fret)[0];if(position){used.add(position.string);all.push({item,position});}});
        const fretted=all.map(({position})=>position.fret).filter((fret)=>fret>0);
        best={all,center:fretted.length?fretted.reduce((sum,fret)=>sum+fret,0)/fretted.length:previousCenter};
      }
      best.all.filter(({item})=>!item.fixed).forEach(({item,position})=>{
        const note=item.note;
        if(note.pitches?.length){note.positions??=[];note.positions[item.index]=position;}
        else{note.string=position.string;note.fret=position.fret;}
      });
      previousCenter=best.center;
    });
  });
}

function importMusicXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('올바른 MusicXML 파일이 아닙니다.');
  const fresh = createScore(); fresh.measures = []; fresh.measuresPerSystem = 4; fresh.importedXml=true;
  fresh.metadata.title = doc.querySelector('work-title')?.textContent || '';
  fresh.metadata.composer = doc.querySelector('creator[type="composer"]')?.textContent || '';
  fresh.metadata.lyricist = doc.querySelector('creator[type="lyricist"]')?.textContent || '';
  fresh.timeSignature = { beats:Number(doc.querySelector('time beats')?.textContent || 4), beatType:Number(doc.querySelector('time beat-type')?.textContent || 4) };
  fresh.timeSymbol=doc.querySelector('time')?.getAttribute('symbol')||'';
  fresh.keyFifths=Number(doc.querySelector('key fifths')?.textContent||0);
  fresh.tempo=Number(doc.querySelector('metronome per-minute')?.textContent||doc.querySelector('sound[tempo]')?.getAttribute('tempo')||0);
  const importedInstrument = (doc.querySelector('part-name')?.textContent || doc.querySelector('instrument-name')?.textContent || '').toLowerCase();
  fresh.instrument = importedInstrument.includes('piano') ? 'piano' : importedInstrument.includes('electric') ? 'electric-guitar' : importedInstrument.includes('acoustic') ? 'acoustic-guitar' : 'classical-guitar';
  const octaveChange = Number(doc.querySelector('transpose octave-change')?.textContent || (fresh.instrument!=='piano'?doc.querySelector('clef[number="1"] clef-octave-change, clef clef-octave-change')?.textContent:0) || 0);
  let currentDivisions=Math.max(1,Number(doc.querySelector('divisions')?.textContent||1));
  const openSlurs=new Map();
  const openTies=new Map();
  const orphanTieStops=new Map();
  const openWedges=new Map();
  const openEndings=new Map();
  doc.querySelectorAll('part:first-of-type > measure').forEach((mx,measureIndex) => {
    const m = createMeasure();
    const changedKey=mx.querySelector(':scope > attributes > key > fifths');
    if(changedKey)m.keyFifths=Number(changedKey.textContent||0);
    m.directions=[...mx.querySelectorAll(':scope > direction words')].map((words)=>({text:words.textContent.trim(),placement:words.closest('direction')?.getAttribute('placement')||'above',align:words.getAttribute('justify')==='right'?'end':words.getAttribute('justify')==='center'?'center':'start'})).filter((item)=>item.text);
    const changedDivisions=Number(mx.querySelector(':scope > attributes > divisions')?.textContent||0);
    if(changedDivisions)currentDivisions=changedDivisions;
    let cursor=0;
    const lastStartByVoice=new Map();
    [...mx.children].forEach((child) => {
      if(child.tagName==='backup'){
        cursor-=Number(child.querySelector('duration')?.textContent||0)/currentDivisions*8;
        return;
      }
      if(child.tagName==='forward'){
        cursor+=Number(child.querySelector('duration')?.textContent||0)/currentDivisions*8;
        return;
      }
      if(child.tagName!=='note')return;
      const nx=child;
      const voice = Math.max(0, Math.min(3, Number(nx.querySelector('voice')?.textContent || 1)-1));
      const isChord=!!nx.querySelector(':scope > chord');
      const isGrace=!!nx.querySelector(':scope > grace');
      const stringNode=nx.querySelector('technical string');
      const string = Number(stringNode?.textContent || 1);
      const fretNode = nx.querySelector('technical fret');
      let midi;
      const pitch = nx.querySelector('pitch');
      if (pitch) {
        const steps = {C:0,D:2,E:4,F:5,G:7,A:9,B:11};
        midi = (Number(pitch.querySelector('octave')?.textContent)+1)*12 + steps[pitch.querySelector('step')?.textContent] + Number(pitch.querySelector('alter')?.textContent||0);
      } else midi = TUNING[string-1];
      const fret = fretNode ? Number(fretNode.textContent) : Math.max(0, midi-TUNING[string-1]);
      const xmlDuration = Number(nx.querySelector(':scope > duration')?.textContent || 0);
      const actualTicks=isGrace?0:xmlDuration/currentDivisions*8;
      const dots=nx.querySelectorAll(':scope > dot').length;
      const isDotted = dots>0;
      const typeDuration = {whole:32,half:16,quarter:8,eighth:4,'16th':2,'32nd':1}[nx.querySelector('type')?.textContent];
      const importedDuration = Math.max(1, typeDuration || 8);
      const note = noteFromStringFret(string, fret, importedDuration, isDotted, isGrace);
      note.tabImported=!!(stringNode&&fretNode);
      note.positionImported=[note.tabImported];
      note.midi = fretNode && fresh.instrument !== 'piano' ? TUNING[string-1] + fret : midi + octaveChange * 12;
      note.diatonicMidi=pitch?midi-Number(pitch.querySelector('alter')?.textContent||0)+octaveChange*12:note.midi;
      note.rest = !!nx.querySelector('rest');
      note.dots=dots;note.ticks=actualTicks;
      note.graceSlash=isGrace&&nx.querySelector(':scope > grace')?.getAttribute('slash')==='yes';
      note.accidental=nx.querySelector(':scope > accidental')?.textContent?.trim()||null;
      note.accidentals=[note.accidental];
      note.startTick=isChord?(lastStartByVoice.get(voice)??cursor):cursor;
      note.beams=[...nx.querySelectorAll(':scope > beam')].map((beam)=>({number:Number(beam.getAttribute('number')||1),value:beam.textContent.trim()}));
      const timeModification=nx.querySelector(':scope > time-modification');
      if(timeModification)note.tuplet={actual:Number(timeModification.querySelector('actual-notes')?.textContent||0),normal:Number(timeModification.querySelector('normal-notes')?.textContent||0)};
      const fermataNode=nx.querySelector('fermata');
      note.fermata=fermataNode?(fermataNode.getAttribute('type')==='inverted'?'below':true):false;
      let storedNote=note;
      if(isChord){
        const previous=m.voices[voice].at(-1);
        if(previous&&!previous.rest){
          previous.pitches ||= [previous.midi];
          previous.positions ||= [{string:previous.string,fret:previous.fret}];
          previous.pitches.push(note.midi);
          previous.positions.push({string:note.string,fret:note.fret});
          previous.positionImported ||= [!!previous.tabImported];
          previous.positionImported.push(note.tabImported);
          previous.accidentals ||= [previous.accidental||null];
          previous.accidentals.push(note.accidental);
          storedNote=previous;
        }
      }
      if(!isChord){
        m.voices[voice].push(note);
        lastStartByVoice.set(voice,note.startTick);
        if(!isGrace)cursor+=actualTicks;
      }
      const relationRef={measure:measureIndex,voice,noteId:storedNote.id};
      nx.querySelectorAll('slur').forEach((slur)=>{
        const number=slur.getAttribute('number')||'1',type=slur.getAttribute('type');
        if(type==='start')openSlurs.set(number,relationRef);
        else if(type==='stop'&&openSlurs.has(number)){
          fresh.annotations.push({type:'slur',start:openSlurs.get(number),end:relationRef});
          openSlurs.delete(number);
        }
      });
      const tieTypes=[...nx.querySelectorAll(':scope > tie')].map((tie)=>tie.getAttribute('type'));
      const tieKey=`${voice}:${note.midi}`;
      if(tieTypes.includes('stop')){
        // Scanner-generated MusicXML occasionally changes the voice number at
        // the second half of a tie. Recover it when the pitch has one unique
        // open tie instead of silently dropping the curve.
        let matchedKey=openTies.has(tieKey)?tieKey:null;
        if(!matchedKey){const candidates=[...openTies.keys()].filter((key)=>key.endsWith(`:${note.midi}`));if(candidates.length===1)matchedKey=candidates[0];}
        if(matchedKey){fresh.annotations.push({type:'tie',start:openTies.get(matchedKey),end:relationRef});openTies.delete(matchedKey);}
        else orphanTieStops.set(note.midi,relationRef);
      }
      if(tieTypes.includes('start')){
        // A second common scanner error is a reversed stop/start pair. If an
        // unmatched stop of the same pitch occurred just before this start,
        // preserve the visible tie in chronological order.
        if(orphanTieStops.has(note.midi)){fresh.annotations.push({type:'tie',start:orphanTieStops.get(note.midi),end:relationRef});orphanTieStops.delete(note.midi);}
        else openTies.set(tieKey,relationRef);
      }
    });
    const measureEntries=m.voices.flatMap((voice,voiceIndex)=>voice.filter((note)=>!note.grace).map((note)=>({note,voice:voiceIndex}))).sort((a,b)=>(a.note.startTick||0)-(b.note.startTick||0));
    const firstEntry=measureEntries.find(({note})=>!note.rest)||measureEntries[0];
    const lastEntry=[...measureEntries].reverse().find(({note})=>!note.rest)||measureEntries.at(-1);
    mx.querySelectorAll(':scope > direction').forEach((direction)=>{
      const dynamic=direction.querySelector('dynamics')?.firstElementChild?.tagName;
      if(dynamic&&firstEntry)firstEntry.note.dynamic=dynamic;
      direction.querySelectorAll('wedge').forEach((wedge)=>{
        if(!firstEntry)return;const number=wedge.getAttribute('number')||'1',type=wedge.getAttribute('type');
        const ref={measure:measureIndex,voice:firstEntry.voice,noteId:firstEntry.note.id};
        if(type==='crescendo'||type==='diminuendo')openWedges.set(number,{type,start:ref});
        else if(type==='stop'&&openWedges.has(number)){const start=openWedges.get(number);fresh.annotations.push({type:start.type,start:start.start,end:ref});openWedges.delete(number);}
      });
    });
    mx.querySelectorAll(':scope > barline').forEach((barline)=>{
      const direction=barline.querySelector('repeat')?.getAttribute('direction');
      if(direction==='forward')m.repeatStart=true;
      if(direction==='backward')m.repeatEnd=true;
      const endingNode=barline.querySelector('ending');
      if(endingNode&&firstEntry&&lastEntry){
        const number=endingNode.getAttribute('number')||'1',type=endingNode.getAttribute('type');
        if(type==='start')openEndings.set(number,{measure:measureIndex,voice:firstEntry.voice,noteId:firstEntry.note.id});
        else if((type==='stop'||type==='discontinue')&&openEndings.has(number)){
          fresh.annotations.push({type:'ending',number:Number(number)||1,start:openEndings.get(number),end:{measure:measureIndex,voice:lastEntry.voice,noteId:lastEntry.note.id},closed:type==='stop'});openEndings.delete(number);
        }
      }
    });
    if (mx.querySelector('print[new-system="yes"]') && fresh.measures.length) fresh.measures.at(-1).forceBreakAfter = true;
    fresh.measures.push(m);
  });
  fresh.voiceCount=Math.max(1,...fresh.measures.flatMap((measure)=>measure.voices.map((voice,index)=>voice.length?index+1:0)));
  if (!fresh.measures.length) fresh.measures.push(createMeasure());
  automaticTabForScore(fresh);
  remember(); score = fresh; syncMetadataInputs(); updateControls(); render();
}

function syncMetadataInputs() {
  ['title','lyricist','composer'].forEach((key) => { $(`#${key}`).value = score.metadata[key] || ''; });
  $('#page').value = score.page;
  $('#instrument').value = score.instrument;
  $('#textFont').value = score.textFont||'Georgia, serif';
  $('#measuresPerSystem').value = String(score.measuresPerSystem||3);
  $('#systemSpacing').value = String(score.systemSpacing||245);
  $('#timeSignature').value = `${score.timeSignature.beats}/${score.timeSignature.beatType}`;
  $('#keySignature').value = String(score.keyFifths||0);
  $('#tempo').value = String(score.tempo||120);
}

document.querySelectorAll('[data-duration]').forEach((button) => button.addEventListener('click', () => { duration = Number(button.dataset.duration); updateControls(); }));
$('#dot').addEventListener('click', () => {
  const entry=selectedEntry();
  if(entry){
    const current=entry.note.dots??(entry.note.dotted?1:0),nextDots=current===1?0:1;
    if(!noteFitsMeasure(entry.measure,entry.voice,entry.note,nextDots)){
      showMeasureWarning(entry.measureIndex);
      return;
    }
    remember();entry.note.dots=nextDots;entry.note.dotted=nextDots>0;delete entry.note.ticks;dotted=nextDots===1;doubleDotted=false;
  }
  else {dotted=!dotted;if(dotted)doubleDotted=false;}
  updateControls();render();
});
$('#doubleDot').addEventListener('click', () => {
  const entry=selectedEntry();
  if(entry){
    const current=entry.note.dots??(entry.note.dotted?1:0),nextDots=current===2?0:2;
    if(!noteFitsMeasure(entry.measure,entry.voice,entry.note,nextDots)){showMeasureWarning(entry.measureIndex);return;}
    remember();entry.note.dots=nextDots;entry.note.dotted=nextDots>0;delete entry.note.ticks;doubleDotted=nextDots===2;dotted=false;
  }else{doubleDotted=!doubleDotted;if(doubleDotted)dotted=false;}
  updateControls();render();
});
$('#sharp').addEventListener('click',()=>applyAccidental(1));
$('#flat').addEventListener('click',()=>applyAccidental(-1));
$('#rest').addEventListener('click', () => { restMode=!restMode; updateControls(); });
$('#voice').addEventListener('click', () => {
  const entry=selectedEntry();
  const cursorTick=entry?notePosition(entry.note,entry.measure,entry.voice):(score.selection.cursorTick??0);
  score.activeVoice=(score.activeVoice+1)%Math.max(1,score.voiceCount||1);
  score.selection={measure:score.selection.measure,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:Math.min(measureLimit(),cursorTick),rangeEnd:null};
  updateControls();render();
});
$('#addVoice').addEventListener('click',()=>{
  const current=Math.max(1,score.voiceCount||1);if(current>=4)return;
  remember();score.voiceCount=current+1;score.activeVoice=current;
  score.selection={measure:score.selection.measure,voice:current,noteId:null,source:'staff',cursorTick:0,rangeEnd:null};
  render();
});
$('#grace').addEventListener('click', () => {graceMode=!graceMode;updateControls();render();});
$('#tie').addEventListener('click', () => addAnnotation('tie'));
$('#slur').addEventListener('click', () => addAnnotation('slur'));
$('#hammerPull').addEventListener('click', () => addAnnotation('slur'));
$('#triplet').addEventListener('click', toggleTuplet);
$('#beamToggle').addEventListener('click', toggleBeam);
$('#fermata').addEventListener('click', () => {const entry=selectedEntry();if(!entry){status.textContent='페르마타를 붙일 음표나 쉼표를 선택하세요.';return;}remember();entry.note.fermata=!entry.note.fermata;render();});
$('#dynamic').addEventListener('change',(event)=>{const entry=selectedEntry(),value=event.target.value;if(!entry||!value){event.target.value='';return;}remember();entry.note.dynamic=value;event.target.value='';render();});
$('#crescendo').addEventListener('click',()=>addHairpin('crescendo'));
$('#diminuendo').addEventListener('click',()=>addHairpin('diminuendo'));
$('#repeatStart').addEventListener('click', () => toggleRepeat('repeatStart'));
$('#repeatEnd').addEventListener('click', () => toggleRepeat('repeatEnd'));
$('#ending1').addEventListener('click',()=>addMeasureEnding(1));
$('#ending2').addEventListener('click',()=>addMeasureEnding(2));
$('#toggleTab').addEventListener('click', () => {if(score.instrument==='piano')return;score.showTab=score.showTab===false;if(score.showTab===false&&score.selection.source==='tab')score.selection.source='staff';updateControls();render();});
$('#barre').addEventListener('click', () => {
  const range=orderedSelection();
  if(!range){status.textContent='오선 또는 타브 위에서 첫 음표부터 마지막 음표까지 드래그한 뒤 바레를 누르세요.';return;}
  const value=$('#barreFret').value;
  remember();score.annotations.push({type:'barre',...range,text:`C.${Math.max(1,Math.min(20,Number(value)||1))}`});render();
});
$('#undo').addEventListener('click', () => { if(!undoStack.length)return;score=undoStack.pop();syncMetadataInputs();updateControls();render(); });
$('#clear').addEventListener('click', () => { remember();score.measures=[createMeasure()];score.annotations=[];score.selection={measure:0,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:0,rangeEnd:null};render(); });
$('#page').addEventListener('change', (e) => { score.page=e.target.value;render(); });
$('#instrument').addEventListener('change', (e) => { score.instrument=e.target.value;updateControls();render(); });
$('#textFont').addEventListener('change', (e) => { score.textFont=e.target.value;render(); });
$('#measuresPerSystem').addEventListener('change', (e) => { score.measuresPerSystem=Number(e.target.value);render(); });
$('#systemSpacing').addEventListener('change', (e) => { score.systemSpacing=Number(e.target.value);render(); });
$('#timeSignature').addEventListener('change', (e) => { const [beats,beatType]=e.target.value.split('/').map(Number);score.timeSignature={beats,beatType};render(); });
$('#keySignature').addEventListener('change', (e) => {score.keyFifths=Number(e.target.value);render();});
$('#tempo').addEventListener('change', (e) => {score.tempo=Math.max(20,Math.min(300,Number(e.target.value)||120));e.target.value=score.tempo;render();});
$('#addDirection').addEventListener('click', () => {const text=$('#directionText').value.trim();if(!text)return;const measure=score.measures[score.selection.measure];remember();measure.directions??=[];measure.directions.push({text,placement:$('#directionPlacement').value,align:$('#directionAlign').value});$('#directionText').value='';render();});
['title','lyricist','composer'].forEach((key) => $(`#${key}`).addEventListener('input', (e) => { score.metadata[key]=e.target.value;render(); }));
$('#xmlExport').addEventListener('click', () => download(`${score.metadata.title||'score'}.musicxml`,toMusicXml(),'application/vnd.recordare.musicxml+xml'));
$('#xmlImport').addEventListener('change', async (e) => { try{const file=e.target.files[0];if(file)importMusicXml(await file.text());}catch(err){alert(err.message);}e.target.value='';scoreSvg.focus?.({preventScroll:true}); });
$('#pdf').addEventListener('click', exportPdf);
$('#help').addEventListener('click', () => $('#helpDialog').showModal());
$('#helpDialog button').addEventListener('click', () => $('#helpDialog').close());

document.addEventListener('keydown', (e) => {
  if (e.target?.matches?.('input,select,textarea') || $('#helpDialog').open) return;
  if(e.code==='Equal'||e.key==='='){e.preventDefault();applyAccidental(1);return;}
  if(e.code==='Minus'||e.key==='-'){e.preventDefault();applyAccidental(-1);return;}
  if(e.code==='BracketLeft'||e.key==='['){e.preventDefault();toggleRepeat('repeatStart');return;}
  if(e.code==='BracketRight'||e.key===']'){e.preventDefault();toggleRepeat('repeatEnd');return;}
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
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    if(score.selection.noteId)moveSelection(e.code==='ArrowLeft'?-1:1);
    else moveVoiceCursor(e.code==='ArrowLeft'?-1:1);
  }
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
  else if (e.code === 'Delete' || e.code === 'Backspace' || e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault();deleteSelected(); }
  else if (e.code === 'Escape') { score.selection.rangeEnd=null;render(); }
});

document.querySelectorAll('.tool-group').forEach((group)=>{
  const label=group.querySelector('.group-label');
  if(!label)return;
  label.setAttribute('role','button');label.setAttribute('tabindex','0');
  label.title=`${label.textContent.trim()} 메뉴 접기 또는 펼치기`;
  const toggle=()=>{group.classList.toggle('collapsed');label.setAttribute('aria-expanded',String(!group.classList.contains('collapsed')));};
  label.addEventListener('click',toggle);
  label.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle();}});
});

syncMetadataInputs(); updateControls(); render();

export { score, toMusicXml, importMusicXml, pitchY, writtenMidi, buildPdf };
