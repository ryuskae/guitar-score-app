import {
  TUNING, uid, createScore, createMeasure, noteFromStringFret,
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
let touchDrag = null;
let dragMoved = false;
let ignoreNextClick = false;
let renderedNotes = new Map();
let renderedSystemBreaks = [];
let renderedSystemCores = [];
let measureWarning = null;
let warningTimer = null;
let selectedAnnotation = -1;
let hairpinDrag = null;
let lastTieShortcutAt = 0;
let measureClipboard = null;
let lyricTarget = null;
let renderedLyricY = new Map();
let autosaveTimer = null;
const AUTOSAVE_KEY = 'guitar-score-app:score';
const LIBRARY_KEY = 'guitar-score-app:library';
const SONG_KEY_PREFIX = 'guitar-score-app:song:';
let currentSongId = null;

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
  // Keep a real focus target for iPadOS hardware keyboards. The old blur()
  // ran after pointerdown had focused the score, leaving Safari with no
  // active element and therefore no reliable arrow-key events.
  scoreSvg.focus?.({preventScroll:true});
  if (extend && score.selection.noteId) {
    score.selection.rangeEnd = { measure, voice, noteId };
  } else if (extend && !noteId) {
    if (measure === score.selection.measure) delete score.selection.measureRangeEnd;
    else score.selection.measureRangeEnd = measure;
  } else {
    const targetMeasure=score.measures[measure];
    const targetNote=noteId?targetMeasure?.voices[voice]?.find((note)=>note.id===noteId):null;
    if(targetNote){
      duration=targetNote.duration;
      const selectedDots=targetNote.dots??(targetNote.dotted?1:0);
      dotted=selectedDots===1;doubleDotted=selectedDots===2;
    }
    const cursorTick=targetNote?notePosition(targetNote,targetMeasure,voice):Math.min(measureLimit(targetMeasure),measureTicks(targetMeasure,voice));
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
  if (event.pointerType !== 'mouse') {
    // Touch and pen: the SVG must not be rebuilt while the finger is down.
    // Removing the touched element swallows the rest of the gesture (moves
    // and the final touchend stop reaching the document), so the drag is
    // previewed with an overlay and committed when the finger lifts.
    try { event.target.releasePointerCapture?.(event.pointerId); } catch {}
    touchDrag = { end: null };
    drawTouchRange();
    return;
  }
  setSelection(measure, voice, noteId, false, source);
}

function extendRangeSelection(measure, voice, noteId) {
  if (!dragAnchor || (dragAnchor.measure === measure && dragAnchor.voice === voice && dragAnchor.noteId === noteId)) return;
  dragMoved = true;
  if (touchDrag) { touchDrag.end = { measure, voice, noteId }; drawTouchRange(); return; }
  score.selection.rangeEnd = { measure, voice, noteId };
  updateControls();
  render();
}

function drawTouchRange() {
  notationSvg?.querySelector('.touch-range')?.remove();
  const a = renderedNotes.get(dragAnchor?.noteId), b = renderedNotes.get(touchDrag?.end?.noteId || dragAnchor?.noteId);
  if (!a || !b || !notationSvg) return;
  const [first, last] = a.system < b.system || (a.system === b.system && a.x <= b.x) ? [a, b] : [b, a];
  const x1 = first.x - 13, x2 = last.system === first.system ? last.x + 13 : notationSvg.viewBox.baseVal.width - 10;
  svg('rect', { x:x1, y:first.staffY - 25, width:Math.max(26, x2 - x1), height:first.tabY - first.staffY + 110, class:'range-selection touch-range' });
}

function finishTouchDrag() {
  if (!touchDrag || !dragAnchor) return;
  const anchor = dragAnchor, end = touchDrag.end, moved = dragMoved;
  touchDrag = null; dragAnchor = null; dragMoved = false;
  if (moved) ignoreNextClick = true;
  setSelection(anchor.measure, anchor.voice, anchor.noteId, false, anchor.source);
  if (moved && end) { score.selection.rangeEnd = end; updateControls(); render(); }
}

// Finger and Apple Pencil drags: find the note under the pointer directly.
document.addEventListener('pointermove', (event) => {
  if (!dragAnchor || event.pointerType === 'mouse') return;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  if (!hit?.matches?.('rect.hit[data-note-id][data-measure]')) return;
  const voice = Number(hit.dataset.voice);
  if (voice !== dragAnchor.voice) return;
  extendRangeSelection(Number(hit.dataset.measure), voice, hit.dataset.noteId);
});

document.addEventListener('touchend', finishTouchDrag);
document.addEventListener('touchcancel', finishTouchDrag);
document.addEventListener('pointercancel', (event) => { if (event.pointerType !== 'mouse') finishTouchDrag(); });

document.addEventListener('pointerup', (event) => {
  hairpinDrag = null;
  if (touchDrag) { finishTouchDrag(); return; }
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

function firstSelectableEvent(measureIndex,voice,startTick=0,sameMeasureOnly=false,preferPitched=false){
  const last=sameMeasureOnly?measureIndex:score.measures.length-1;
  for(let index=measureIndex;index<=last;index++){
    const measure=score.measures[index];
    if(!measure)continue;
    materializeVoiceTicks(measure,voice);
    const minimum=index===measureIndex?startTick:0;
    const candidates=(measure.voices[voice]||[])
      .filter((item)=>!item.grace&&(Number(item.startTick)||0)>=minimum-.001)
      .sort((a,b)=>(a.startTick||0)-(b.startTick||0));
    const note=(preferPitched?candidates.find((item)=>!item.rest):null)||candidates[0];
    if(note)return{measureIndex:index,note,tick:Number(note.startTick)||0};
  }
  return null;
}

function restCoveringTick(measure,voice,tick){
  let sequentialTick=0;
  return measure.voices[voice].find((note)=>{
    const start=Number.isFinite(note.startTick)?note.startTick:sequentialTick;
    const end=start+durationTicks(note);
    sequentialTick=Math.max(sequentialTick,end);
    return note.rest&&start<=tick+.001&&end>tick+.001;
  })||null;
}

function measureAt(measureOrIndex) {
  return typeof measureOrIndex==='number'?score.measures[measureOrIndex]:measureOrIndex;
}

// A pickup (anacrusis) measure carries its own time signature; every other
// measure follows the score-wide one.
function measureTimeSignature(measureOrIndex) {
  const measure=measureAt(measureOrIndex);
  return measure?.pickup&&measure.timeSignature?measure.timeSignature:score.timeSignature;
}

function sameTimeSignature(a,b) { return !!a&&!!b&&a.beats===b.beats&&a.beatType===b.beatType; }

function timeSignatureChangesAt(index) {
  return index===0||!sameTimeSignature(measureTimeSignature(index),measureTimeSignature(index-1));
}

function measureLimit(measureOrIndex=score.selection.measure) { return timeSignatureTicks(measureTimeSignature(measureOrIndex)); }

// Pickup measures are not counted, so numbering continues across them.
function displayMeasureNumber(index) {
  let number=0;
  for(let i=0;i<=index;i++)if(!score.measures[i]?.pickup)number++;
  return number;
}

function measureLabel(index) { return score.measures[index]?.pickup?'픽업 마디':`${displayMeasureNumber(index)}마디`; }

function restParts(totalTicks, startTick=0) {
  const values=[32,24,16,12,8,6,4,3,2,1],parts=[];
  let remaining=Math.max(0,totalTicks),tick=startTick;
  // Prefer rests that start on a multiple of their own length, so a gap
  // after an off-beat event first fills up to the beat (8th, quarter, half).
  const aligned=(ticks)=>Math.abs(tick/ticks-Math.round(tick/ticks))<.001;
  while(remaining>=1-.001){
    const fits=values.filter((ticks)=>ticks<=remaining+.001);
    const ticks=fits.find(aligned)??fits[0];
    const dottedValue=[24,12,6,3].includes(ticks),base=dottedValue?ticks/1.5:ticks;
    const note=noteFromStringFret(1,0,base,dottedValue,false);
    note.rest=true;note.dots=dottedValue?1:0;note.startTick=tick;note.ticks=ticks;
    parts.push(note);tick+=ticks;remaining-=ticks;
  }
  return parts;
}

function fullMeasureRest(measure) {
  const note=noteFromStringFret(1,0,32,false,false);
  note.rest=true;note.measureRest=true;note.startTick=0;note.ticks=measureLimit(measure);
  return note;
}

function ensureEditableRests() {
  score.voiceCount=Math.max(1,Math.min(4,Number(score.voiceCount)||1));
  score.measures.forEach((measure,index)=>{
    for(let voice=0;voice<score.voiceCount;voice++)if(measure.voices[voice].length===0&&!measure.deletedVoices?.includes(voice))measure.voices[voice].push(fullMeasureRest(measure));
  });
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
  const limit=measureLimit(measure),voice=measure.voices[voiceIndex];
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

function removeAnnotationsForNotes(noteIds) {
  if(!noteIds.size)return;
  score.annotations=score.annotations.filter((annotation)=>
    !noteIds.has(annotation.start?.noteId)&&!noteIds.has(annotation.end?.noteId));
}

// Rebuild rests around fixed musical events. Editing a duration therefore
// overwrites its time range instead of pushing later notes to the right.
function rebuildVoiceRests(measure, voiceIndex, keepRest=null) {
  const limit=measureLimit(measure);
  const events=measure.voices[voiceIndex]
    .filter((note)=>!note.rest||note===keepRest)
    .sort((a,b)=>(a.startTick??0)-(b.startTick??0)||(a.grace?-1:1));
  const rebuilt=[];
  let cursor=0;
  events.forEach((note)=>{
    const start=Math.max(0,Number(note.startTick)||0);
    if(!note.grace&&start>cursor+.001)rebuilt.push(...restParts(start-cursor,cursor));
    rebuilt.push(note);
    if(!note.grace)cursor=Math.max(cursor,Math.min(limit,start+durationTicks(note)));
  });
  if(cursor<limit-.001)rebuilt.push(...restParts(limit-cursor,cursor));
  measure.voices[voiceIndex]=rebuilt.sort((a,b)=>(a.startTick??0)-(b.startTick??0)||(a.grace?-1:1));
}

// A selected rest whose length was edited is kept as an event, so the edit is
// not merged back into the surrounding rests.
function overwriteFollowingEvents(measure, voiceIndex, keepNote, oldEnd, newEnd) {
  const keepRest=keepNote?.rest?keepNote:null;
  if(newEnd<=oldEnd+.001){rebuildVoiceRests(measure,voiceIndex,keepRest);return;}
  const removed=new Set();
  measure.voices[voiceIndex]=measure.voices[voiceIndex].filter((note)=>{
    if(note===keepNote||note.rest||note.grace)return true;
    const start=Number(note.startTick)||0,end=start+durationTicks(note);
    const overlaps=start<newEnd-.001&&end>oldEnd+.001;
    if(overlaps)removed.add(note.id);
    return !overlaps;
  });
  removeAnnotationsForNotes(removed);
  rebuildVoiceRests(measure,voiceIndex,keepRest);
}

function changeSelectedDuration(newDuration) {
  const entry=selectedEntry();
  duration=newDuration;
  if(!entry){updateControls();return;}
  materializeVoiceTicks(entry.measure,entry.voice);
  const start=notePosition(entry.note,entry.measure,entry.voice);
  const oldEnd=start+durationTicks(entry.note),newEnd=start+newDuration;
  if(newEnd>measureLimit(entry.measure)+.001){showMeasureWarning(entry.measureIndex);updateControls();return;}
  remember();
  Object.assign(entry.note,{duration:newDuration,dots:0,dotted:false,ticks:newDuration,measureRest:entry.note.rest&&start===0&&Math.abs(newDuration-measureLimit(entry.measure))<.001});
  delete entry.note.tuplet;
  overwriteFollowingEvents(entry.measure,entry.voice,entry.note,oldEnd,newEnd);
  dotted=false;doubleDotted=false;
  updateControls();render();
}

function changeSelectedDots(nextDots) {
  const entry=selectedEntry();
  if(!entry)return false;
  materializeVoiceTicks(entry.measure,entry.voice);
  const start=notePosition(entry.note,entry.measure,entry.voice);
  const oldEnd=start+durationTicks(entry.note);
  const newTicks=entry.note.duration*dotMultiplier(nextDots),newEnd=start+newTicks;
  if(newEnd>measureLimit(entry.measure)+.001){showMeasureWarning(entry.measureIndex);return true;}
  remember();
  Object.assign(entry.note,{dots:nextDots,dotted:nextDots>0,ticks:newTicks,measureRest:false});
  overwriteFollowingEvents(entry.measure,entry.voice,entry.note,oldEnd,newEnd);
  dotted=nextDots===1;doubleDotted=nextDots===2;
  updateControls();render();return true;
}

function showMeasureWarning(measureIndex, message='마디의 박자 길이를 초과할 수 없습니다.') {
  measureWarning={measureIndex,message};
  clearTimeout(warningTimer);
  render();
  warningTimer=setTimeout(()=>{measureWarning=null;render();},2600);
}

function dotMultiplier(count=0) { let value=1,part=.5;for(let i=0;i<count;i++){value+=part;part/=2;}return value; }

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
    const accidentalSymbol={sharp:'♯',flat:'♭',natural:'♮'}[note.accidental]
      ||(SHARP_PITCH_CLASSES.has(((writtenMidi(note.midi)%12)+12)%12)?'♯':null);
    if(accidentalSymbol)svg('text', { x:x-14, y:y+4, text:accidentalSymbol, 'font-size':14, 'font-family':'serif' }, g);
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
  const timeSignature=measureTimeSignature(measure);
  const conventionalFourFour=timeSignature.beats===4&&timeSignature.beatType===4;
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
  const beatLength = 8 * (4 / timeSignature.beatType);
  const compound = timeSignature.beatType === 8 && timeSignature.beats >= 6 && timeSignature.beats % 3 === 0;
  const beatUnit = compound ? groupingTicks(timeSignature) : beatLength;
  // Beam within each beat first. A note joins the group of the beat in which
  // it starts; rests and quarter-or-longer notes break the beam.
  const beatGroups = [];
  let tick = 0, current = [], currentBeat = null;
  const flush = () => { if (current.length) beatGroups.push({ beat:currentBeat, items:current }); current=[]; currentBeat=null; };
  for (const note of measure.voices[voice]) {
    if (note.grace) continue;
    const start = Number.isFinite(note.startTick) ? note.startTick : tick;
    const beat = Math.floor(start / beatUnit + .001);
    if (note.rest || note.duration > 4 || (currentBeat !== null && beat !== currentBeat)) flush();
    if (!note.rest && note.duration <= 4) { currentBeat = beat; current.push({note,tick:start}); }
    tick = Math.max(tick, start + durationTicks(note));
  }
  flush();
  // In 4/4, two beats of plain eighths read as 1–2 | 3–4: four eighths under
  // one beam. Sixteenths keep every quarter-note beat visible.
  const plainEighths = (group) => group.items.length === 2 && group.items.every(({note}) =>
    note.duration === 4 && !(note.dots ?? (note.dotted ? 1 : 0)) && !note.tuplet);
  const fourFour = timeSignature.beats === 4 && timeSignature.beatType === 4;
  const merged = [];
  beatGroups.forEach((group) => {
    const previous = merged.at(-1);
    if (fourFour && previous && previous.beat % 2 === 0 && group.beat === previous.beat + 1 && previous.lastBeat === previous.beat
      && plainEighths(previous) && plainEighths(group)) {
      previous.items = [...previous.items, ...group.items]; previous.lastBeat = group.beat;
    } else merged.push({ ...group, lastBeat:group.beat });
  });
  merged.forEach(({items}) => {
    if (items.length < 2) return;
    items.forEach(({note}) => levels.set(note.id, 1));
    groups.push(items);
    // Every sixteenth in a primary group belongs to a second beam (a
    // singleton gets a short secondary hook rather than a flag).
    items.filter(({note}) => note.duration <= 2).forEach(({note}) => levels.set(note.id, 2));
  });
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

const TIED_TAB_COLOR = '#a3a9b3';

const ARTICULATIONS = {
  staccato:{code:'a.',label:'스타카토'}, accent:{code:'a>',label:'악센트'},
  tenuto:{code:'a-',label:'테누토'}, 'strong-accent':{code:'a^',label:'마르카토'},
};

const VEX_DURATION = { 32:'w', 16:'h', 8:'q', 4:'8', 2:'16', 1:'32' };
const VEX_NAMES = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'];
const KEY_BY_FIFTHS = ['Cb','Gb','Db','Ab','Eb','Bb','F','C','G','D','A','E','B','F#','C#'];
const NATURAL_NAME_BY_PC = {0:'c',2:'d',4:'e',5:'f',7:'g',9:'a',11:'b'};
const SHARP_ORDER = [5,0,7,2,9,4,11];
const FLAT_ORDER = [11,4,9,2,7,0,5];
const ACCIDENTAL_ALTER = {sharp:1,flat:-1,natural:0,'double-sharp':2,'flat-flat':-2};
const ALTER_ACCIDENTAL = {0:'natural',1:'sharp','-1':'flat',2:'double-sharp','-2':'flat-flat'};

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

function naturalMidiForKey(note,keyIndex,midi,explicitAccidental){
  const stored=note.diatonicMidis?.[keyIndex]??(keyIndex===0?note.diatonicMidi:null);
  if(Number.isFinite(stored)&&Math.abs(midi-stored)<=2&&NATURAL_NAME_BY_PC[((stored%12)+12)%12])return stored;
  const explicitAlter=ACCIDENTAL_ALTER[explicitAccidental];
  const explicitNatural=midi-explicitAlter;
  if(Number.isFinite(explicitAlter)&&NATURAL_NAME_BY_PC[((explicitNatural%12)+12)%12])return explicitNatural;
  return SHARP_PITCH_CLASSES.has(((midi%12)+12)%12)?midi-1:midi;
}

function vexKeyForNote(note,keyIndex,midi){
  const explicit=note.accidentals?.[keyIndex]??(keyIndex===0?note.accidental:null);
  const natural=naturalMidiForKey(note,keyIndex,midi,explicit);
  const written=writtenMidi(natural),pc=((written%12)+12)%12,octave=Math.floor(written/12)-1;
  const name=NATURAL_NAME_BY_PC[pc];
  return name?`${name}/${octave}`:vexKey(midi);
}

function keySignatureAlter(naturalMidi,fifths){
  const pitchClass=((naturalMidi%12)+12)%12;
  if(fifths>0&&SHARP_ORDER.slice(0,Math.min(7,fifths)).includes(pitchClass))return 1;
  if(fifths<0&&FLAT_ORDER.slice(0,Math.min(7,-fifths)).includes(pitchClass))return -1;
  return 0;
}

function displayedAccidentalsForMeasure(measure,fifths){
  const result=new Map(),state=new Map(),events=[];
  measure.voices.forEach((voice,voiceIndex)=>{
    let tick=0;
    voice.forEach((note,index)=>{
      const start=Number.isFinite(note.startTick)?note.startTick:tick;
      events.push({note,voiceIndex,index,start});
      if(!note.grace)tick=Math.max(tick,start+durationTicks(note));
    });
  });
  events.sort((a,b)=>a.start-b.start||Number(b.note.grace)-Number(a.note.grace)||a.voiceIndex-b.voiceIndex||a.index-b.index);
  events.forEach(({note})=>{
    if(note.rest)return;
    const midis=note.pitches?.length?note.pitches:[note.midi];
    midis.forEach((midi,keyIndex)=>{
      const rawExplicit=note.accidentals?.[keyIndex]??(keyIndex===0?note.accidental:null);
      const natural=naturalMidiForKey(note,keyIndex,midi,rawExplicit);
      const actualAlter=Math.round(midi-natural);
      const explicit=ACCIDENTAL_ALTER[rawExplicit]===actualAlter?rawExplicit:null;
      const stateKey=String(natural);
      const previous=state.has(stateKey)?state.get(stateKey):keySignatureAlter(natural,fifths);
      const accidental=explicit||(actualAlter!==previous?ALTER_ACCIDENTAL[actualAlter]:null);
      if(accidental)result.set(`${note.id}:${keyIndex}`,accidental);
      state.set(stateKey,actualAlter);
    });
  });
  return result;
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

function scoreHasLyrics() {
  return score.measures.some((measure)=>measure.voices.some((voice)=>voice.some((note)=>note.lyric?.text)));
}

// Lyrics sit on one line under each system's staff, with dashes for split
// words and for syllables held over several notes.
function drawLyrics(layouts) {
  const systemsBounds=new Map();
  for(const layout of layouts.values()){
    const bound=systemsBounds.get(layout.system)||{left:layout.x,right:layout.x+layout.width,staffBottom:layout.staffBottom};
    bound.left=Math.min(bound.left,layout.x);bound.right=Math.max(bound.right,layout.x+layout.width);
    systemsBounds.set(layout.system,bound);
  }
  // Keep the lyric line below low noteheads and below articulations placed
  // under up-stem notes.
  const lowest=new Map();
  selectionOrder().forEach(({note,voice})=>{
    const item=renderedNotes.get(note.id);
    if(!item)return;
    const bound=systemsBounds.get(item.system);
    const articulationRoom=voice%2===0?(note.articulations?.length||0)*13:0;
    const bottom=Math.max(item.noteY+18,(bound?.staffBottom??item.noteY)+24)+articulationRoom;
    lowest.set(item.system,Math.max(lowest.get(item.system)??-Infinity,bottom));
  });
  systemsBounds.forEach((bound,system)=>renderedLyricY.set(system,Math.max(bound.staffBottom+24,lowest.get(system)??-Infinity)));
  const font=score.textFont||'Georgia, serif';
  const drawn=[];
  selectionOrder().forEach(({note,measure,voice})=>{
    const rendered=renderedNotes.get(note.id);
    if(!rendered||note.rest||!note.lyric?.text)return;
    const y=renderedLyricY.get(rendered.system);
    const text=svg('text',{x:rendered.x,y,text:note.lyric.text,class:'lyric','text-anchor':'middle','font-size':14,'font-family':font,fill:'#111'});
    text.addEventListener('click',(event)=>{event.stopPropagation();openLyricEditor({measure,voice,noteId:note.id});});
    const width=text.getComputedTextLength?.()||note.lyric.text.length*8;
    drawn.push({note,voice,rendered,y,left:rendered.x-width/2,right:rendered.x+width/2});
  });
  const dash=(x,y)=>svg('text',{x,y,text:'-',class:'lyric-hyphen','text-anchor':'middle','font-size':14,'font-family':font,fill:'#111'});
  const drawnById=new Map(drawn.map((item)=>[item.note.id,item]));
  // Two kinds of dashes: a hyphen between two syllables on neighbouring
  // notes, and one dash under every note a syllable is held over (melisma)
  // until the next syllable or rest. Words on neighbouring notes get none.
  const joinSyllables=(item,next)=>{
    if(next.rendered.system===item.rendered.system){
      if(next.left-item.right>=4)dash((item.right+next.left)/2,item.y);
      return;
    }
    dash(Math.min(item.right+10,systemsBounds.get(item.rendered.system).right-6),item.y);
    dash(Math.max(systemsBounds.get(next.rendered.system).left+40,next.left-10),next.y);
  };
  const holdDashes=(item,held,next)=>{
    let previousRight=item.right,previousSystem=item.rendered.system;
    held.forEach((rendered)=>{
      const sameSystem=rendered.system===previousSystem;
      const x=sameSystem?Math.max(rendered.x,previousRight+7):rendered.x;
      const blocked=next&&next.rendered.system===rendered.system&&x>next.left-6;
      if(!blocked){dash(x,renderedLyricY.get(rendered.system));previousRight=x+4;previousSystem=rendered.system;}
    });
  };
  const voices=new Map();
  selectionOrder().forEach((entry)=>{
    if(entry.note.grace)return;
    if(!voices.has(entry.voice))voices.set(entry.voice,[]);
    voices.get(entry.voice).push(entry.note);
  });
  voices.forEach((notes)=>{
    let holding=null,held=[];
    const finish=(next)=>{
      if(!holding)return;
      if(held.length)holdDashes(holding,held,next);
      else if(holding.note.lyric.hyphen){
        if(next)joinSyllables(holding,next);else dash(holding.right+8,holding.y);
      }
    };
    notes.forEach((note)=>{
      const item=drawnById.get(note.id);
      if(note.rest){finish(null);holding=null;held=[];return;}
      if(item){finish(item);holding=item;held=[];return;}
      const rendered=renderedNotes.get(note.id);
      if(holding&&rendered)held.push(rendered);
    });
    finish(null);
  });
}

function lyricNoteAfter(ref, direction=1) {
  const ordered=selectionOrder().filter((entry)=>entry.voice===ref.voice&&!entry.note.rest&&!entry.note.grace);
  const index=ordered.findIndex((entry)=>entry.note.id===ref.noteId);
  const next=index<0?null:ordered[index+direction];
  return next?{measure:next.measure,voice:next.voice,noteId:next.note.id}:null;
}

function startLyrics() {
  let entry=selectedEntry();
  if(!entry||entry.note.rest||entry.note.grace){
    const s=score.selection;
    const pitched=selectionOrder().filter((item)=>item.voice===score.activeVoice&&!item.note.rest&&!item.note.grace);
    const fromTick=entry?notePosition(entry.note,entry.measure,entry.voice):(s.cursorTick??0);
    // Prefer the next note after the caret, else the first note of the measure.
    const candidate=pitched.find((item)=>item.measure>s.measure||(item.measure===s.measure&&item.tick>=fromTick-.001))
      ||pitched.find((item)=>item.measure===s.measure);
    if(!candidate){status.textContent='가사를 붙일 음표를 먼저 선택하세요.';return;}
    entry={measureIndex:candidate.measure,voice:candidate.voice,note:candidate.note};
  }
  openLyricEditor({measure:entry.measureIndex,voice:entry.voice,noteId:entry.note.id});
}

function lyricNote(ref) {
  return score.measures[ref.measure]?.voices[ref.voice]?.find((note)=>note.id===ref.noteId)||null;
}

function openLyricEditor(ref) {
  const note=lyricNote(ref);
  if(!note){closeLyricEditor();return;}
  lyricTarget=ref;
  score.selection={measure:ref.measure,voice:ref.voice,noteId:ref.noteId,source:'staff',cursorTick:notePosition(note,score.measures[ref.measure],ref.voice),rangeEnd:null};
  score.activeVoice=ref.voice;
  updateControls();render();
  const input=$('#lyricInput'),rendered=renderedNotes.get(ref.noteId);
  const point=rendered&&svgPointToSheet(rendered.x,(renderedLyricY.get(rendered.system)??rendered.noteY+40)-5);
  if(!point){closeLyricEditor();return;}
  input.hidden=false;
  input.style.left=`${point.x}px`;input.style.top=`${point.y}px`;
  input.value=note.lyric?.text||'';
  input.focus({preventScroll:false});input.select();
  status.textContent='가사 입력: Space 다음 음표 · - 다음 음절과 하이픈 연결 · Backspace(빈 칸) 이전 음표 · Enter/Esc 끝내기';
}

function closeLyricEditor() {
  lyricTarget=null;
  const input=$('#lyricInput');
  if(!input.hidden){input.hidden=true;input.value='';}
  scoreSvg.focus?.({preventScroll:true});
}

function commitLyric(text, hyphen) {
  if(!lyricTarget)return;
  const note=lyricNote(lyricTarget);
  if(!note)return;
  const cleaned=text.trim();
  const current=note.lyric;
  if((current?.text||'')===cleaned&&(!cleaned||!!current?.hyphen===hyphen))return;
  remember();
  if(cleaned)note.lyric={text:cleaned,hyphen};else delete note.lyric;
}

function advanceLyric(direction=1) {
  const next=lyricTarget&&lyricNoteAfter(lyricTarget,direction);
  if(next)openLyricEditor(next);
  else{closeLyricEditor();render();status.textContent='가사를 붙일 음표가 더 없습니다.';}
}

function handleLyricInput(event) {
  if(event.isComposing||!lyricTarget)return;
  const value=event.target.value;
  if(value.endsWith(' ')){commitLyric(value,false);advanceLyric(1);return;}
  if(value.endsWith('-')){
    const text=value.slice(0,-1);
    if(text.trim())commitLyric(text,true);
    advanceLyric(1);
  }
}

const lyricInput=$('#lyricInput');
lyricInput.addEventListener('input',handleLyricInput);
lyricInput.addEventListener('compositionend',(event)=>setTimeout(()=>handleLyricInput({isComposing:false,target:event.target}),0));
lyricInput.addEventListener('keydown',(event)=>{
  if(event.isComposing||!lyricTarget)return;
  if(event.key==='Enter'){
    event.preventDefault();
    const note=lyricNote(lyricTarget);
    commitLyric(lyricInput.value,!!note?.lyric?.hyphen&&note.lyric.text===lyricInput.value.trim());
    closeLyricEditor();render();
  }else if(event.key==='Escape'){event.preventDefault();closeLyricEditor();render();}
  else if(event.key==='Backspace'&&!lyricInput.value){event.preventDefault();advanceLyric(-1);}
  else if(event.key==='Tab'){event.preventDefault();commitLyric(lyricInput.value,!!lyricNote(lyricTarget)?.lyric?.hyphen);advanceLyric(event.shiftKey?-1:1);}
});
lyricInput.addEventListener('blur',()=>{
  setTimeout(()=>{
    if(!lyricTarget||document.activeElement===lyricInput)return;
    commitLyric(lyricInput.value,!!lyricNote(lyricTarget)?.lyric?.hyphen);
    closeLyricEditor();render();
  },0);
});

// Estimate how much horizontal room a measure needs before VexFlow performs
// its detailed collision-aware formatting. Systems keep the requested number
// of measures, but dense measures receive more of the available width than a
// measure containing only one sustained note.
function measureLayoutWeight(measure) {
  const columns=new Map();
  measure.voices.forEach((voice,voiceIndex)=>voice.forEach((note)=>{
    const onset=Number.isFinite(note.startTick)?note.startTick:notePosition(note,measure,voiceIndex);
    const key=Number(onset.toFixed(4));
    const chordSize=Math.max(1,note.pitches?.length||1);
    const accidentalCount=(note.accidentals||[]).filter(Boolean).length+(note.accidental?1:0);
    const load=(note.grace?.42:1)+Math.max(0,chordSize-1)*.32+accidentalCount*.28+(note.dots||0)*.14;
    const column=columns.get(key)||{primary:0,secondary:0};
    if(note.grace)column.secondary+=load;
    else if(load>column.primary){column.secondary+=column.primary*.25;column.primary=load;}
    else column.secondary+=load*.25;
    columns.set(key,column);
  }));
  const content=[...columns.values()].reduce((sum,column)=>sum+column.primary+column.secondary,0);
  const barlineCost=(measure.repeatStart?1.1:0)+(measure.repeatEnd?1.1:0);
  return Math.max(1.5,content+barlineCost);
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer=setTimeout(saveToBrowser,300);
}

// Every song lives in this browser's storage: a small library index plus one
// entry per song. The current song survives reloads and back navigation.
function readLibrary() {
  try{
    const library=JSON.parse(localStorage.getItem(LIBRARY_KEY)||'null');
    if(library&&Array.isArray(library.songs))return library;
  }catch{}
  return {currentId:null,songs:[]};
}

function writeLibrary(library) {
  try{localStorage.setItem(LIBRARY_KEY,JSON.stringify(library));}catch{}
}

function songTitle(target=score) { return target.metadata?.title?.trim()||'제목 없음'; }

function saveToBrowser() {
  clearTimeout(autosaveTimer);
  if(!currentSongId)currentSongId=uid('song');
  try{
    localStorage.setItem(SONG_KEY_PREFIX+currentSongId,JSON.stringify(score));
    const library=readLibrary();
    const entry={id:currentSongId,title:songTitle(),updatedAt:Date.now()};
    const index=library.songs.findIndex((song)=>song.id===currentSongId);
    if(index<0)library.songs.push(entry);else library.songs[index]=entry;
    library.currentId=currentSongId;
    writeLibrary(library);
  }catch{
    status.textContent='브라우저 저장 공간이 부족해 자동 저장하지 못했습니다. XML ↓로 파일을 보관하세요.';
  }
}

function normalizedSavedScore(saved) {
  if(!saved||!Array.isArray(saved.measures)||!saved.measures.length)return null;
  const base=createScore();
  return {...base,...saved,metadata:{...base.metadata,...saved.metadata},selection:{...base.selection,...saved.selection}};
}

function loadSong(id) {
  try{return normalizedSavedScore(JSON.parse(localStorage.getItem(SONG_KEY_PREFIX+id)||'null'));}catch{return null;}
}

function restoreFromBrowser() {
  const library=readLibrary();
  const restored=library.currentId&&loadSong(library.currentId);
  if(restored){score=restored;currentSongId=library.currentId;return;}
  // Scores saved before the library existed become its first song.
  try{
    const legacy=normalizedSavedScore(JSON.parse(localStorage.getItem(AUTOSAVE_KEY)||'null'));
    if(legacy){score=legacy;currentSongId=uid('song');saveToBrowser();localStorage.removeItem(AUTOSAVE_KEY);}
  }catch{}
}

function switchToScore(nextScore, id) {
  saveToBrowser();
  score=nextScore;currentSongId=id;undoStack=[];measureWarning=null;selectedAnnotation=-1;
  syncMetadataInputs();updateControls();render();saveToBrowser();
  scoreSvg.focus?.({preventScroll:true});
}

function newScore() {
  if(!window.confirm('새 악보를 만들까요? 지금 곡은 곡 목록에 저장됩니다.'))return;
  const fresh=createScore();
  fresh.instrument=score.instrument;fresh.page=score.page;
  switchToScore(fresh,uid('song'));
  status.textContent='새 악보를 만들었습니다. 빈 마디를 클릭한 뒤 A–G로 음표를 입력하세요.';
}

function openSongList() {
  saveToBrowser();
  const list=$('#songList');list.replaceChildren();
  const songs=readLibrary().songs.sort((a,b)=>b.updatedAt-a.updatedAt);
  songs.forEach((song)=>{
    const row=document.createElement('li');
    const name=document.createElement('button');
    name.className='song-open';name.textContent=song.title;
    if(song.id===currentSongId)name.classList.add('current');
    const date=document.createElement('span');
    date.className='song-date';date.textContent=new Date(song.updatedAt).toLocaleString('ko-KR',{dateStyle:'short',timeStyle:'short'});
    const remove=document.createElement('button');
    remove.className='song-delete';remove.textContent='삭제';remove.title=`${song.title} 삭제`;
    name.addEventListener('click',()=>{
      if(song.id!==currentSongId){
        const loaded=loadSong(song.id);
        if(!loaded){alert('이 곡을 불러올 수 없습니다.');return;}
        switchToScore(loaded,song.id);
      }
      $('#songsDialog').close();
    });
    remove.addEventListener('click',()=>deleteSong(song.id,song.title));
    row.append(name,date,remove);list.appendChild(row);
  });
  $('#songsDialog').showModal();
}

function deleteSong(id, title) {
  if(!window.confirm(`'${title}'을(를) 곡 목록에서 삭제할까요? 되돌릴 수 없습니다.`))return;
  const library=readLibrary();
  library.songs=library.songs.filter((song)=>song.id!==id);
  try{localStorage.removeItem(SONG_KEY_PREFIX+id);}catch{}
  if(id===currentSongId){
    const next=library.songs.sort((a,b)=>b.updatedAt-a.updatedAt)[0];
    const nextScore=next&&loadSong(next.id);
    currentSongId=null;writeLibrary(library);
    score=nextScore||createScore();currentSongId=nextScore?next.id:uid('song');undoStack=[];
    syncMetadataInputs();updateControls();render();saveToBrowser();
  }else writeLibrary(library);
  openSongList();
}

function render() {
  scheduleAutosave();
  ensureEditableRests();
  scoreSvg.replaceChildren();
  notationSvg=null;
  renderedNotes=new Map();
  renderedSystemBreaks=[];
  renderedSystemCores=[];
  renderedLyricY=new Map();
  $('#printTitle').textContent = score.metadata.title;
  $('#printLyricist').textContent = score.metadata.lyricist || '';
  $('#printComposer').textContent = score.metadata.composer || '';
  sheet.style.setProperty('--score-text-font',score.textFont||'Georgia, serif');
  sheet.dataset.page = score.page;
  // Paper layouts use the staff-to-page proportion of engraved guitar books
  // (about 100 staff spaces across four measures), so a page holds four
  // systems; the screen layout stays roomier.
  const baseWidth = score.page === 'Screen' ? 1100 : 900;
  const densityScale=Math.max(1,(Number(score.measuresPerSystem)||3)/3);
  const width = baseWidth*densityScale;
  const sys = systems();
  const showLowerStaff=score.instrument==='piano'||score.showTab!==false;
  const requestedSpacing=Math.max(225, Math.min(320, Number(score.systemSpacing) || 245));
  // Lyrics get their own band between the staff and the TAB/bass staff.
  const lyricSpace=scoreHasLyrics()?26:0;
  // Guitar TAB sits about twelve staff spaces below the staff (room for TAB
  // stems and lyrics). Staves are not scaled by the measures-per-system
  // density, so this gap is not either; only the space between systems is.
  // The piano's bass staff keeps its grand-staff spacing.
  const lowerOffset=score.instrument==='piano'?122*densityScale:150;
  const systemHeight = (showLowerStaff?lowerOffset+(requestedSpacing-122)*densityScale:Math.max(120,requestedSpacing*.54)*Math.min(densityScale,1.25))+lyricSpace, top = 5*densityScale;
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
  const tiedEndIds=new Set(score.annotations.filter((annotation)=>annotation.type==='tie').map((annotation)=>annotation.end?.noteId));
  const voiceColors=['#111','#2368c4','#b33a3a','#15805f'];
  let currentKeyFifths=Number(score.keyFifths)||0;
  sys.forEach((items, systemIndex) => {
    const systemFirstNode=notationSvg.childNodes.length;
    const y=top+systemIndex*systemHeight;
    const left=32*densityScale, usable=width-left-72*densityScale;
    // The first measure of every system also contains clef, key and time
    // signature. Giving every measure the same width made a rhythmically busy
    // first measure spill across the following barline.
    const firstMeasureAllowance=Math.min(usable*.25,72*densityScale);
    const minimumMeasureWidth=Math.min(105*densityScale,(usable-firstMeasureAllowance)/items.length*.72);
    const distributable=Math.max(0,usable-firstMeasureAllowance-minimumMeasureWidth*items.length);
    const layoutWeights=items.map(({measure,index},localIndex)=>measureLayoutWeight(measure)+(localIndex>0&&timeSignatureChangesAt(index)?1.2:0));
    const totalWeight=layoutWeights.reduce((sum,value)=>sum+value,0)||1;
    const measureWidths=layoutWeights.map((weight,index)=>minimumMeasureWidth+distributable*weight/totalWeight+(index===0?firstMeasureAllowance:0));
    let runningX=left;
    const piano = score.instrument === 'piano';
    let firstStaff=null,firstLower=null;
    items.forEach(({ measure, index }, localIndex) => {
      const measureWidth=measureWidths[localIndex];
      const x=runningX;runningX+=measureWidth;
      const staff=new VF.Stave(x,y,measureWidth);
      const lowerY=y+lowerOffset+lyricSpace;
      const lower=showLowerStaff?(piano?new VF.Stave(x,lowerY,measureWidth):new VF.TabStave(x,lowerY,measureWidth)):null;
      const keyChanged=Number.isFinite(measure.keyFifths)&&measure.keyFifths!==currentKeyFifths;
      if(Number.isFinite(measure.keyFifths))currentKeyFifths=measure.keyFifths;
      if(localIndex===0){
        staff.addClef('treble','default',piano?undefined:'8vb');
        staff.addKeySignature(KEY_BY_FIFTHS[Math.max(0,Math.min(14,currentKeyFifths+7))]);
        if(systemIndex===0&&score.tempo)staff.setTempo({duration:'q',bpm:score.tempo},-18);
        lower?.addClef(piano?'bass':'tab');
        firstStaff=staff;firstLower=lower;
      }else if(keyChanged){
        staff.addKeySignature(KEY_BY_FIFTHS[Math.max(0,Math.min(14,currentKeyFifths+7))]);
      }
      const measureTime=measureTimeSignature(measure);
      if(timeSignatureChangesAt(index))staff.addTimeSignature(score.timeSymbol==='common'&&!measure.pickup&&sameTimeSignature(measureTime,{beats:4,beatType:4})?'C':`${measureTime.beats}/${measureTime.beatType}`);
      if(measure.repeatStart){staff.setBegBarType(VF.Barline.type.REPEAT_BEGIN);lower?.setBegBarType(VF.Barline.type.REPEAT_BEGIN);}
      if(measure.repeatEnd){staff.setEndBarType(VF.Barline.type.REPEAT_END);lower?.setEndBarType(VF.Barline.type.REPEAT_END);}
      VF.Stave.formatBegModifiers(lower?[staff,lower]:[staff]);
      staff.setContext(context).draw();lower?.setContext(context).draw();
      const staffTop=staff.getYForLine(0),staffBottom=staff.getYForLine(4);
      const lowerTop=lower?.getYForLine(0)??staffTop,lowerBottom=lower?.getYForLine(piano?4:5)??staffBottom;
      layouts.set(index,{x,width:measureWidth,staffY:staffTop,staffBottom,tabY:lowerTop,lowerBottom,noteStart:staff.getNoteStartX(),noteEnd:staff.getNoteEndX(),system:systemIndex});
      const staffVoices=[],tabVoices=[],staffById=new Map(),tabById=new Map(),staffBeams=[],tabBeams=[],staffTuplets=[],tabTuplets=[];
      const displayedAccidentals=displayedAccidentalsForMeasure(measure,currentKeyFifths);
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
          const chordKeys=chordMidis.map((midi,keyIndex)=>vexKeyForNote(note,keyIndex,midi));
          const chordPositions=note.positions?.length?note.positions.map(({string,fret})=>({str:string,fret})):[{str:note.string,fret:note.fret}];
          const noteColor=active&&selected.has(note.id)?'#d97706':voiceColor;
          if(note.grace){
            const graceStaff=new VF.GraceNote({keys:chordKeys,duration:'16',slash:!!note.graceSlash,stem_direction:direction});
            const graceTab=lower?new VF.GraceTabNote({positions:chordPositions,duration:'16',stem_direction:direction}):null;
            chordKeys.forEach((key,keyIndex)=>{
              const displayedAccidental=displayedAccidentals.get(`${note.id}:${keyIndex}`);
              const symbol={sharp:'#',flat:'b',natural:'n','double-sharp':'##','flat-flat':'bb'}[displayedAccidental];
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
            const displayedAccidental=displayedAccidentals.get(`${note.id}:${keyIndex}`);
            const accidentalMap={sharp:'#',flat:'b',natural:'n','double-sharp':'##','flat-flat':'bb'};
            const symbol=accidentalMap[displayedAccidental];
            if(symbol)staveNote.addModifier(new VF.Accidental(symbol),keyIndex);
          });
          const dotCount=Number.isFinite(note.dots)?note.dots:(note.dotted?1:0);
          for(let dotIndex=0;dotIndex<dotCount;dotIndex++)VF.Dot.buildAndAttach([staveNote],{all:true});
          if(!note.rest)(note.articulations||[]).forEach((name)=>{
            if(!ARTICULATIONS[name])return;
            // Articulations sit on the notehead side, opposite the stem.
            staveNote.addModifier(new VF.Articulation(ARTICULATIONS[name].code).setPosition(direction===VF.Stem.UP?VF.Modifier.Position.BELOW:VF.Modifier.Position.ABOVE));
          });
          if(note.fermata)staveNote.addModifier(new VF.Articulation('a@a').setPosition(note.fermata==='below'?VF.Modifier.Position.BELOW:VF.Modifier.Position.ABOVE));
          staveNote.setStyle({fillStyle:noteColor,strokeStyle:noteColor});
          staffNotes.push(staveNote);staffById.set(note.id,staveNote);
          const tabNote=lower?(note.rest?new VF.GhostNote({duration:vexDuration(note)}):new VF.TabNote({positions:chordPositions,duration:vexDuration(note),stem_direction:direction},true)):null;
          if(tabNote&&!note.rest)for(let dotIndex=0;dotIndex<dotCount;dotIndex++)VF.Dot.buildAndAttach([tabNote],{all:true});
          if(tabNote&&!note.rest){
            // A fret reached through a tie is not plucked again: show it grey.
            const tied=tiedEndIds.has(note.id)&&!(active&&selected.has(note.id));
            tabNote.setStyle(tied?{fillStyle:TIED_TAB_COLOR,strokeStyle:TIED_TAB_COLOR}:{fillStyle:noteColor,strokeStyle:noteColor});
            if(tied)tabNote.setStemStyle?.({fillStyle:voiceColor,strokeStyle:voiceColor});
          }
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
        const time={num_beats:measureTime.beats,beat_value:measureTime.beatType};
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
        formatter.format(allVoices,Math.max(30,Math.min(staff.getNoteEndX(),lower?.getNoteEndX()??staff.getNoteEndX())-start-14),{context,alignRests:true});
        // Formatter owns rhythmic spacing. Only remove a visual x-offset that
        // VexFlow may add between simultaneous staff voices; never overwrite
        // the formatter's TickContext positions or proportional spacing.
        const onsetGroups=new Map();
        measure.voices.forEach((voice,voiceIndex)=>voice.forEach((note)=>{
          if(note.grace)return;
          const onset=Number.isFinite(note.startTick)?note.startTick:notePosition(note,measure,voiceIndex);
          const key=Number(onset.toFixed(4));
          if(!onsetGroups.has(key))onsetGroups.set(key,[]);
          onsetGroups.get(key).push({note,voiceIndex,staffNote:staffById.get(note.id),tabNote:tabById.get(note.id)});
        }));
        const visualTickableX=(tickable)=>{
          if(!tickable)return NaN;
          if(tickable instanceof VF.StaveNote&&tickable.getNoteHeadBeginX&&tickable.getNoteHeadEndX)return (tickable.getNoteHeadBeginX()+tickable.getNoteHeadEndX())/2;
          if(tickable instanceof VF.TabNote)return tickable.getAbsoluteX()+tickable.getGlyphWidth()/2;
          return tickable.getAbsoluteX?.()??0;
        };
        onsetGroups.forEach((entries)=>{
          const sounding=entries.filter(({note})=>!note.rest);
          if(sounding.length<2)return;
          const tabAnchor=sounding.map(({tabNote})=>tabNote).find((note)=>note instanceof VF.TabNote);
          const targetX=tabAnchor?visualTickableX(tabAnchor):visualTickableX(sounding[0].staffNote);
          sounding.forEach(({staffNote})=>{
            if(!staffNote?.setXShift)return;
            const currentX=visualTickableX(staffNote);
            staffNote.setXShift((staffNote.getXShift?.()||0)+targetX-currentX);
          });
        });
        staffVoices.forEach((v)=>v.draw(context,staff));tabVoices.forEach((v)=>v.draw(context,lower));
        staffBeams.forEach((beam)=>beam.setContext(context).draw());tabBeams.forEach((beam)=>beam.setContext(context).draw());
        staffTuplets.forEach((tuplet)=>tuplet.setContext(context).draw());tabTuplets.forEach((tuplet)=>tuplet.setContext(context).draw());
        measure.voices.forEach((voice,voiceIndex)=>voice.forEach((note)=>{
          const sn=staffById.get(note.id),tn=tabById.get(note.id);
          if(!sn)return;
          const noteX=visualTickableX(sn),noteY=sn.getYs?.()[0]??staffTop+20;
          const tabX=tn?visualTickableX(tn):noteX,tabNoteY=tn?.getYs?.()[0]??lowerTop;
          const stem=sn.getStemExtents?.();
          const topY=Math.min(noteY,stem?.topY??noteY,stem?.baseY??noteY);
          const bottomY=Math.max(noteY,stem?.topY??noteY,stem?.baseY??noteY);
          renderedNotes.set(note.id,{x:noteX,noteY,topY,bottomY,tabX,tabNoteY,staffY:staffTop,tabY:lowerTop,system:systemIndex});
          if(note.dynamic)svg('text',{x:noteX-5,y:bottomY+23*densityScale,text:note.dynamic,class:'dynamic-mark','font-size':15*densityScale,'font-family':'serif','font-style':'italic','font-weight':'bold'});
        }));
      }
      if(localIndex===0&&!measure.pickup)svg('text',{x:x+20,y:staffTop-18,text:String(displayMeasureNumber(index)),class:'measure-number','font-size':15,'font-family':'Arial, sans-serif','font-weight':'700',fill:'#334155'});
      if(measureWarning?.measureIndex===index){
        const warningWidth=Math.min(measureWidth-12,210),warningX=x+(measureWidth-warningWidth)/2;
        svg('rect',{x:warningX,y:staffTop-37,width:warningWidth,height:21,rx:5,class:'measure-warning-bg'});
        svg('text',{x:x+measureWidth/2,y:staffTop-22,text:measureWarning.message,class:'measure-warning-text'});
      }
      const mh=svg('rect',{x,y:staffTop-10,width:measureWidth,height:lowerBottom-staffTop+20,class:'measure-hit'});
      mh.addEventListener('click',(e)=>{
        if(e.target!==mh)return;
        setSelection(index,score.activeVoice,null,e.shiftKey);
        // A tapped measure offers copy/delete above it, like a range.
        score.selection.measureTapped=true;render();
      });
      if(measure.forceBreakAfter)svg('text',{x:x+measureWidth-14,y:staffTop-8,text:'↵',class:'break-mark'});
    });
    if(firstStaff&&firstLower)new VF.StaveConnector(firstStaff,firstLower).setType('bracket').setContext(context).draw();
    renderedSystemBreaks.push(Math.min(logicalHeight,top+(systemIndex+1)*systemHeight));
    // Everything VexFlow drew for this system is tagged with it, so PDF
    // export never mistakes a high beam for part of the system above.
    [...notationSvg.childNodes].slice(systemFirstNode).forEach((node)=>node.setAttribute?.('data-system',systemIndex));
    const systemLayouts=[...layouts.values()].filter((layout)=>layout.system===systemIndex);
    renderedSystemCores.push({top:Math.min(...systemLayouts.map((layout)=>layout.staffY)),bottom:Math.max(...systemLayouts.map((layout)=>layout.lowerBottom))});
  });
  // A translucent range makes drag selection unambiguous before applying a barre.
  let actionAnchor=null;
  if(score.selection.noteId&&score.selection.rangeEnd){
    let a=endpointFor({noteId:score.selection.noteId}),b=endpointFor(score.selection.rangeEnd);
    if(a&&b){
      if(a.system>b.system||(a.system===b.system&&a.x>b.x))[a,b]=[b,a];
      const bounds=new Map();for(const l of layouts.values()){const q=bounds.get(l.system)||{left:l.x,right:l.x+l.width,top:l.staffY-25,bottom:l.lowerBottom+12};q.left=Math.min(q.left,l.x);q.right=Math.max(q.right,l.x+l.width);bounds.set(l.system,q);}
      for(let s=a.system;s<=b.system;s++){const q=bounds.get(s),x1=s===a.system?a.x-13:q.left,x2=s===b.system?b.x+13:q.right;svg('rect',{x:x1,y:q.top,width:Math.max(4,x2-x1),height:q.bottom-q.top,class:'range-selection'});}
      const firstBound=bounds.get(a.system);
      actionAnchor={x:((a.x-13)+(a.system===b.system?b.x+13:firstBound.right))/2,y:firstBound.top,range:true};
    }
  }
  if(Number.isFinite(score.selection.measureRangeEnd)){
    const [first,last]=selectedMeasureRange();
    for(let index=first;index<=last;index++){
      const layout=layouts.get(index);
      if(layout)svg('rect',{x:layout.x,y:layout.staffY-25,width:layout.width,height:layout.lowerBottom-layout.staffY+37,class:'range-selection'});
    }
    const firstLayout=layouts.get(first),lastLayout=layouts.get(last);
    if(firstLayout){
      const right=lastLayout&&lastLayout.system===firstLayout.system?lastLayout.x+lastLayout.width:firstLayout.x+firstLayout.width;
      actionAnchor={x:(firstLayout.x+right)/2,y:firstLayout.staffY-25,range:true};
    }
  }
  if(!actionAnchor&&(measureClipboard||score.selection.measureTapped)){
    const layout=layouts.get(score.selection.measure);
    if(layout)actionAnchor={x:layout.x+layout.width/2,y:layout.staffY-25,range:!!score.selection.measureTapped&&!score.selection.noteId};
  }
  placeSelectionActions(actionAnchor);
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
  drawLyrics(layouts);
  const entry = selectedEntry();
  status.textContent = entry
    ? `성부 ${entry.voice+1}(${VOICE_COLORS[entry.voice]}) · ${measureLabel(entry.measureIndex)} · ${entry.note.string}번 줄 ${entry.note.fret}프렛 · MIDI ${entry.note.midi}`
    : `성부 ${score.activeVoice+1}(${VOICE_COLORS[score.activeVoice]}) · ${measureLabel(score.selection.measure)} · ${Number((((score.selection.cursorTick??0)/(8*(4/measureTimeSignature(score.selection.measure).beatType)))+1).toFixed(2))}박 위치`;
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
  const pickupMeasure=score.measures[score.selection.measure];
  $('#pickup').classList.toggle('active',!!pickupMeasure?.pickup);
  if(pickupMeasure?.pickup){
    const value=`${pickupMeasure.timeSignature.beats}/${pickupMeasure.timeSignature.beatType}`;
    const select=$('#pickupTimeSignature');
    if(![...select.options].some((option)=>option.value===value))select.add(new Option(value,value));
    select.value=value;
  }
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

function diatonicIndex(naturalMidi) {
  const pitchClass=((naturalMidi%12)+12)%12;
  return (Math.floor(naturalMidi/12)-1)*7+DIATONIC_STEP[pitchClass];
}

// The pitched note heard just before the insertion point in the active voice.
function previousPitchedNote(measureIndex, tick, beforeNoteId=null) {
  const entries=selectionOrder().filter((entry)=>entry.voice===score.activeVoice);
  let limit=beforeNoteId?entries.findIndex((entry)=>entry.note.id===beforeNoteId):-1;
  if(limit<0)limit=entries.findIndex((entry)=>entry.measure>measureIndex||(entry.measure===measureIndex&&entry.tick>=tick-.001));
  if(limit<0)limit=entries.length;
  for(let index=limit-1;index>=0;index--)if(!entries[index].note.rest)return entries[index].note;
  return null;
}

// Letter keys pick the octave closest (by staff steps) to the previous note,
// e.g. C4 followed by G gives G3. Without a previous note the default octave
// is kept. The result is moved back into the instrument's range if needed.
function nearestLetterMidi(letterMidi, reference) {
  const pitchClass=((letterMidi%12)+12)%12;
  let natural=letterMidi;
  if(reference){
    const rawExplicit=reference.accidentals?.[0]??reference.accidental;
    const referenceDiatonic=diatonicIndex(naturalMidiForKey(reference,0,reference.midi,rawExplicit));
    const octave=Math.round((referenceDiatonic-DIATONIC_STEP[pitchClass])/7);
    natural=(octave+1)*12+pitchClass;
  }
  const [low,high]=score.instrument==='piano'?[21,108]:[TUNING.at(-1),TUNING[0]+24];
  const sounding=(value)=>pendingAccidental?value+pendingAccidental:keyAdjustedMidi(value);
  while(sounding(natural)<low)natural+=12;
  while(sounding(natural)>high)natural-=12;
  return natural;
}

function addNote(midi) {
  const insertionSelection=selectedEntry();
  const referenceTick=!insertionSelection&&Number.isFinite(score.selection.cursorTick)&&!score.selection.noteId
    ?score.selection.cursorTick:Infinity;
  midi=nearestLetterMidi(midi,previousPitchedNote(score.selection.measure,referenceTick,insertionSelection?.note.id));
  const naturalMidi=midi;
  midi=pendingAccidental?naturalMidi+pendingAccidental:keyAdjustedMidi(naturalMidi);
  let measureIndex = score.selection.measure;
  let measure = score.measures[measureIndex];
  const cursorInsert=!score.selection.noteId&&Number.isFinite(score.selection.cursorTick);
  const targetTick=cursorInsert?Math.max(0,Math.min(measureLimit(measure),score.selection.cursorTick)):measureTicks(measure,score.activeVoice);
  const inputDots=doubleDotted?2:(dotted?1:0);
  const newTicks=duration*dotMultiplier(inputDots);
  const selected=selectedEntry();
  if(cursorInsert)materializeVoiceTicks(measure,score.activeVoice);
  const caretRest=cursorInsert?restCoveringTick(measure,score.activeVoice,targetTick):null;
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
    materializeVoiceTicks(replacing.measure,replacing.voice);
    const replacingAtCaret=!selected&&replacing.note.rest&&cursorInsert;
    const originalStart=replacing.note.startTick,originalEnd=originalStart+durationTicks(replacing.note);
    const start=replacingAtCaret?targetTick:originalStart;
    const newEnd=start+newTicks;
    if(newEnd>measureLimit(replacing.measure)+.001){showMeasureWarning(replacing.measureIndex);return;}
    remember();
    const position=bestPosition(midi,replacing.measure,replacing.voice,start);
    Object.assign(replacing.note,{midi,diatonicMidi:naturalMidi,accidental:pendingAccidental===1?'sharp':pendingAccidental===-1?'flat':null,string:position.string,fret:position.fret,duration,dots:inputDots,dotted:inputDots>0,rest:restMode,grace:graceMode,startTick:start,ticks:newTicks,measureRest:false});
    delete replacing.note.pitches;delete replacing.note.positions;delete replacing.note.positionImported;delete replacing.note.tabImported;
    delete replacing.note.diatonicMidis;delete replacing.note.accidentals;
    delete replacing.note.tuplet;
    overwriteFollowingEvents(replacing.measure,replacing.voice,replacing.note,replacingAtCaret?start:originalEnd,newEnd);
    let nextMeasure=replacing.measureIndex,nextTick=start+newTicks;
    if(nextTick>=measureLimit(replacing.measure)){
      nextMeasure=replacing.measureIndex+1;nextTick=0;
      if(!score.measures[nextMeasure])score.measures.push(createMeasure());
    }
    ensureEditableRests();
    const nextEvent=firstSelectableEvent(nextMeasure,replacing.voice,nextTick,false,true);
    score.selection=nextEvent
      ?{measure:nextEvent.measureIndex,voice:replacing.voice,noteId:nextEvent.note.id,source:'staff',cursorTick:nextEvent.tick,rangeEnd:null}
      :{measure:nextMeasure,voice:replacing.voice,noteId:null,source:'staff',cursorTick:nextTick,rangeEnd:null};
    pendingAccidental=0;dotted=false;doubleDotted=false;updateControls();render();return;
  }
  if(cursorInsert&&Math.max(measureTicks(measure,score.activeVoice),targetTick)+newTicks>measureLimit(measure)){
    showMeasureWarning(measureIndex);return;
  }
  remember();
  if(measure.deletedVoices?.includes(score.activeVoice))measure.deletedVoices=measure.deletedVoices.filter((voice)=>voice!==score.activeVoice);
  if (measureTicks(measure, score.activeVoice) + newTicks > measureLimit(measure)) {
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
  if(nextTick>=measureLimit(measure)){
    nextMeasure=measureIndex+1;nextTick=0;
    if(!score.measures[nextMeasure])score.measures.push(createMeasure());
  }
  // A newly entered note advances the insertion caret. Clicking an existing
  // note still selects it, so the next pitch replaces that selected event.
  score.selection = { measure:nextMeasure, voice:score.activeVoice, noteId:null, source:'staff', cursorTick:nextTick, rangeEnd:null };
  if (measureTicks(measure, score.activeVoice) >= measureLimit(measure) && measureIndex === score.measures.length - 1) score.measures.push(createMeasure());
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

function toggleArticulation(name) {
  const entries=selectedEntries().filter(({note})=>!note.rest);
  if(!entries.length){status.textContent=`${ARTICULATIONS[name].label}를 붙일 음표를 먼저 선택하세요.`;return;}
  const remove=entries.every(({note})=>note.articulations?.includes(name));
  remember();
  entries.forEach(({note})=>{
    const current=(note.articulations||[]).filter((item)=>item!==name);
    if(!remove)current.push(name);
    if(current.length)note.articulations=current;else delete note.articulations;
  });
  render();
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

function addTiedContinuation() {
  const entry=selectedEntry();
  if(!entry||entry.note.rest){status.textContent='타이로 연장할 음표를 먼저 선택하세요.';return;}
  materializeVoiceTicks(entry.measure,entry.voice);
  let targetMeasureIndex=entry.measureIndex;
  let targetTick=notePosition(entry.note,entry.measure,entry.voice)+durationTicks(entry.note);
  if(targetTick>=measureLimit(entry.measure)-.001){
    targetMeasureIndex++;
    targetTick=0;
  }
  let targetMeasure=score.measures[targetMeasureIndex];
  if(targetMeasure)materializeVoiceTicks(targetMeasure,entry.voice);
  const existing=targetMeasure?.voices[entry.voice].find((note)=>
    !note.grace&&Math.abs((Number(note.startTick)||0)-targetTick)<.001);
  const samePitch=existing&&!existing.rest&&(
    existing.midi===entry.note.midi||existing.pitches?.includes(entry.note.midi));
  if(samePitch){
    remember();
    score.annotations.push({type:'tie',start:{measure:entry.measureIndex,voice:entry.voice,noteId:entry.note.id},end:{measure:targetMeasureIndex,voice:entry.voice,noteId:existing.id}});
    render();return;
  }
  const available=measureLimit(targetMeasureIndex)-targetTick;
  const continuationTicks=Math.min(durationTicks(entry.note),available);
  if(continuationTicks<1-.001){status.textContent='타이를 입력할 박이 없습니다.';return;}
  remember();
  if(!targetMeasure){score.measures.push(createMeasure());targetMeasure=score.measures[targetMeasureIndex];}
  const continuation=noteFromStringFret(entry.note.string,entry.note.fret,entry.note.duration,false,false);
  Object.assign(continuation,{
    midi:entry.note.midi,diatonicMidi:entry.note.diatonicMidi,accidental:entry.note.accidental,
    string:entry.note.string,fret:entry.note.fret,startTick:targetTick,ticks:continuationTicks,
    dots:0,dotted:false,rest:false,grace:false,
  });
  if(entry.note.pitches)continuation.pitches=[...entry.note.pitches];
  if(entry.note.positions)continuation.positions=entry.note.positions.map((position)=>({...position}));
  setNoteTicks(continuation,continuationTicks);
  targetMeasure.voices[entry.voice].push(continuation);
  overwriteFollowingEvents(targetMeasure,entry.voice,continuation,targetTick,targetTick+continuationTicks);
  score.annotations.push({type:'tie',start:{measure:entry.measureIndex,voice:entry.voice,noteId:entry.note.id},end:{measure:targetMeasureIndex,voice:entry.voice,noteId:continuation.id}});
  render();
}

function addAnnotation(type) {
  let range = orderedSelection();
  if (!range) { status.textContent = '먼저 음표를 선택하세요. Shift+클릭하면 범위를 선택할 수 있습니다.'; return; }
  const rangeEnd=score.selection.rangeEnd;
  const singleSelection=!rangeEnd||(
    range.start.measure===rangeEnd.measure&&range.start.voice===rangeEnd.voice&&range.start.noteId===rangeEnd.noteId
  );
  if(type==='tie'&&singleSelection){addTiedContinuation();return;}
  if (type === 'slur' && !score.selection.rangeEnd) {
    const notes = allNotes(score, score.selection.voice);
    const index = notes.findIndex(({note}) => note.id === score.selection.noteId);
    let next = notes[index + 1];
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
  if(tick<0&&measureIndex>0){measureIndex--;tick=Math.max(0,measureLimit(measureIndex)-step);}
  else if(tick>measureLimit(measureIndex)&&measureIndex<score.measures.length-1){measureIndex++;tick=0;}
  tick=Math.max(0,Math.min(measureLimit(measureIndex),tick));
  score.selection={measure:measureIndex,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:tick,rangeEnd:null};
  render();
}

function syncPrimaryPitch(note,nextMidi,position,{direction=1,octave=false}={}){
  const previousMidi=note.midi;
  const rawExplicit=note.accidentals?.[0]??note.accidental;
  const currentNatural=naturalMidiForKey(note,0,previousMidi,rawExplicit);
  let natural;
  if(octave&&Number.isFinite(currentNatural))natural=currentNatural+(nextMidi-previousMidi);
  else if(Number.isFinite(currentNatural)&&Math.abs(nextMidi-currentNatural)<=1)natural=currentNatural;
  else if(SHARP_PITCH_CLASSES.has(((nextMidi%12)+12)%12))natural=direction<0?nextMidi+1:nextMidi-1;
  else natural=nextMidi;
  Object.assign(note,{midi:nextMidi,diatonicMidi:natural,accidental:null});
  if(position)Object.assign(note,{string:position.string,fret:position.fret});
  if(Array.isArray(note.pitches)&&note.pitches.length)note.pitches[0]=nextMidi;
  if(Array.isArray(note.diatonicMidis)&&note.diatonicMidis.length)note.diatonicMidis[0]=natural;
  if(Array.isArray(note.accidentals)&&note.accidentals.length)note.accidentals[0]=null;
  if(position&&Array.isArray(note.positions)&&note.positions.length)note.positions[0]={string:position.string,fret:position.fret};
}

function transposeSelected(direction, octave = false) {
  const entry = selectedEntry(); if (!entry || entry.note.rest) return;
  const nextMidi = entry.note.midi + direction * (octave ? 12 : 1);
  if (score.instrument === 'piano') {
    if (nextMidi < 21 || nextMidi > 108) return;
    remember();syncPrimaryPitch(entry.note,nextMidi,null,{direction,octave});render();return;
  }
  const position = positionsForMidi(nextMidi).sort((a,b)=>a.fret-b.fret||a.string-b.string)[0];
  if (!position) { status.textContent='기타의 연주 가능한 음역을 벗어났습니다.'; return; }
  remember();
  syncPrimaryPitch(entry.note,nextMidi,position,{direction,octave});
  render();
}

function moveTabAcrossStrings(direction) {
  const entry=selectedEntry(); if(!entry || entry.note.rest || score.instrument==='piano') return;
  const choices=positionsForMidi(entry.note.midi).sort((a,b)=>a.string-b.string);
  const current=choices.findIndex((position)=>position.string===entry.note.string);
  const next=choices[current+direction];
  if(!next) return;
  remember();entry.note.string=next.string;entry.note.fret=next.fret;
  if(Array.isArray(entry.note.positions)&&entry.note.positions.length)entry.note.positions[0]={string:next.string,fret:next.fret};
  render();
}

function changeFret(digit) {
  const entry = selectedEntry(); if (!entry || entry.note.rest) return;
  fretBuffer = (fretBuffer + digit).slice(-2);
  const fret = Math.min(30, Number(fretBuffer));
  const nextMidi=TUNING[entry.note.string-1]+fret;
  remember();syncPrimaryPitch(entry.note,nextMidi,{string:entry.note.string,fret},{direction:1});render();
}

function applyAccidental(value) {
  const entry=selectedEntry();
  if(!entry||entry.note.rest){
    if(value===0){status.textContent='제자리표를 적용할 오선 음표를 먼저 선택하세요.';return;}
    pendingAccidental=pendingAccidental===value?0:value;
    updateControls();return;
  }
  remember();
  const rawExplicit=entry.note.accidentals?.[0]??entry.note.accidental;
  const natural=naturalMidiForKey(entry.note,0,entry.note.midi,rawExplicit);
  const midi=natural+value,position=bestPosition(midi,entry.measure,entry.voice,notePosition(entry.note,entry.measure,entry.voice));
  const accidental=value===1?'sharp':value===-1?'flat':'natural';
  Object.assign(entry.note,{midi,diatonicMidi:natural,accidental,string:position.string,fret:position.fret});
  if(Array.isArray(entry.note.accidentals))entry.note.accidentals[0]=accidental;
  if(Array.isArray(entry.note.diatonicMidis))entry.note.diatonicMidis[0]=natural;
  if(Array.isArray(entry.note.pitches)&&entry.note.pitches.length)entry.note.pitches[0]=midi;
  if(Array.isArray(entry.note.positions)&&entry.note.positions.length)entry.note.positions[0]={string:position.string,fret:position.fret};
  pendingAccidental=0;render();
}

function toggleEnharmonic(){
  const entry=selectedEntry();
  if(!entry||entry.note.rest){status.textContent='동음이명으로 바꿀 오선 음표를 먼저 선택하세요.';return;}
  const midi=entry.note.midi;
  const rawExplicit=entry.note.accidentals?.[0]??entry.note.accidental;
  const currentNatural=naturalMidiForKey(entry.note,0,midi,rawExplicit);
  const allCandidates=[];
  for(let natural=midi-2;natural<=midi+2;natural++){
    if(NATURAL_NAME_BY_PC[((natural%12)+12)%12])allCandidates.push(natural);
  }
  const simple=allCandidates.filter((natural)=>Math.abs(midi-natural)<=1);
  let candidates=simple;
  if(simple.length<2){
    const simpleNatural=simple[0]??currentNatural;
    const upperDouble=allCandidates.find((natural)=>natural>simpleNatural&&Math.abs(midi-natural)===2);
    const lowerDouble=[...allCandidates].reverse().find((natural)=>natural<simpleNatural&&Math.abs(midi-natural)===2);
    candidates=[simpleNatural,upperDouble??lowerDouble].filter(Number.isFinite);
  }
  if(candidates.length<2){status.textContent='이 음의 동음이명 표기를 만들 수 없습니다.';return;}
  const currentIndex=candidates.findIndex((natural)=>natural===currentNatural);
  const natural=candidates[(currentIndex<0?0:currentIndex+1)%candidates.length];
  const alter=midi-natural;
  const accidental=ALTER_ACCIDENTAL[alter];
  remember();
  entry.note.diatonicMidi=natural;
  entry.note.accidental=accidental;
  if(Array.isArray(entry.note.diatonicMidis)&&entry.note.diatonicMidis.length)entry.note.diatonicMidis[0]=natural;
  if(Array.isArray(entry.note.accidentals)&&entry.note.accidentals.length)entry.note.accidentals[0]=accidental;
  render();
}

const NATURAL_SEMITONES = [0,2,4,5,7,9,11];

function midiFromDiatonic(index) {
  const octave=Math.floor(index/7),step=((index%7)+7)%7;
  return (octave+1)*12+NATURAL_SEMITONES[step];
}

function normalizedFifths(fifths, preferFlat) {
  let value=((fifths%12)+12)%12;
  if(value>6)value-=12;
  if(Math.abs(value)===6)value=preferFlat?-6:6;
  return value;
}

function tonicLetterIndex(fifths) {
  return 'CDEFGAB'.indexOf(KEY_BY_FIFTHS[Math.max(0,Math.min(14,fifths+7))][0]);
}

// Transposes the whole score, its key signatures and its spelling. Letter
// names move by the interval between the old and new keys, so e.g. B♭ major
// up a major second becomes C major with every note respelled to match.
function transposeScore(semitones) {
  if(!semitones)return;
  const [low,high]=score.instrument==='piano'?[21,108]:[TUNING.at(-1),TUNING[0]+30];
  const sounding=score.measures.flatMap((measure)=>measure.voices.flat()).filter((note)=>!note.rest)
    .flatMap((note)=>note.pitches?.length?note.pitches:[note.midi]);
  const outside=sounding.filter((midi)=>midi+semitones<low||midi+semitones>high).length;
  if(outside){
    alert(`${score.instrument==='piano'?'피아노':'기타'} 음역을 벗어나는 음이 ${outside}개 있어 이조할 수 없습니다. 다른 음정(예: 반대 방향)을 선택하세요.`);
    return;
  }
  remember();
  const oldFifths=Number(score.keyFifths)||0;
  const preferFlat=semitones<0?oldFifths<=0:oldFifths<0;
  const newFifths=normalizedFifths(oldFifths+7*semitones,preferFlat);
  const letterShift=(tonicLetterIndex(newFifths)-tonicLetterIndex(oldFifths)+7)%7;
  const steps=semitones>0?(letterShift===0&&semitones>=12?7:letterShift):(letterShift===0?(semitones<=-12?-7:0):letterShift-7);
  const respell=(note,keyIndex,midi)=>{
    const explicit=note.accidentals?.[keyIndex]??(keyIndex===0?note.accidental:null);
    const natural=naturalMidiForKey(note,keyIndex,midi,explicit);
    const nextMidi=midi+semitones;
    let nextNatural=midiFromDiatonic(diatonicIndex(natural)+steps);
    if(Math.abs(nextMidi-nextNatural)>2)nextNatural=SHARP_PITCH_CLASSES.has(((nextMidi%12)+12)%12)?nextMidi-1:nextMidi;
    return {nextMidi,nextNatural};
  };
  score.measures.forEach((measure)=>{
    if(Number.isFinite(measure.keyFifths))measure.keyFifths=normalizedFifths(measure.keyFifths+7*semitones,preferFlat);
    measure.voices.flat().forEach((note)=>{
      if(note.rest)return;
      if(note.pitches?.length){
        const results=note.pitches.map((midi,keyIndex)=>respell(note,keyIndex,midi));
        note.pitches=results.map(({nextMidi})=>nextMidi);
        note.diatonicMidis=results.map(({nextNatural})=>nextNatural);
        note.accidentals=results.map(()=>null);
        note.midi=note.pitches[0];note.diatonicMidi=note.diatonicMidis[0];note.accidental=null;
      }else{
        const {nextMidi,nextNatural}=respell(note,0,note.midi);
        Object.assign(note,{midi:nextMidi,diatonicMidi:nextNatural,accidental:null});
        delete note.diatonicMidis;delete note.accidentals;
      }
      delete note.tabImported;delete note.positionImported;
    });
  });
  score.keyFifths=newFifths;
  if(score.instrument!=='piano'){
    score.measures.forEach((measure)=>measure.voices.flat().forEach((note)=>{
      if(note.rest||note.pitches?.length)return;
      const position=positionsForMidi(note.midi).sort((a,b)=>a.fret-b.fret)[0];
      if(position)Object.assign(note,{string:position.string,fret:position.fret});
    }));
    automaticTabForScore(score);
  }
  syncMetadataInputs();updateControls();render();
  status.textContent=`${semitones>0?'위로':'아래로'} ${Math.abs(semitones)}반음 이조했습니다. Ctrl+Z(⌘Z)로 되돌릴 수 있습니다.`;
}

function deleteSelected() {
  const entry = selectedEntry(); if (!entry) return;
  remember();
  const ticks=durationTicks(entry.note),start=notePosition(entry.note,entry.measure,entry.voice);
  Object.assign(entry.note,{rest:true,grace:false,startTick:start,ticks,measureRest:start===0&&Math.abs(ticks-measureLimit(entry.measure))<.001});
  delete entry.note.pitches;delete entry.note.positions;delete entry.note.positionImported;delete entry.note.tabImported;delete entry.note.tuplet;delete entry.note.accidental;delete entry.note.accidentals;delete entry.note.diatonicMidis;delete entry.note.lyric;delete entry.note.articulations;
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

function selectedMeasureRange() {
  const s=score.selection;
  const ends=[s.measure,s.rangeEnd?.measure,s.measureRangeEnd].filter(Number.isFinite);
  return [Math.max(0,Math.min(...ends)),Math.min(score.measures.length-1,Math.max(...ends))];
}

// Shift+←/→ grows the selection: note by note when a note is selected,
// otherwise measure by measure.
function extendSelectionByKeyboard(direction) {
  const s=score.selection;
  if(s.noteId){
    const ordered=selectionOrder().filter((entry)=>entry.voice===s.voice);
    const currentId=s.rangeEnd?.noteId??s.noteId;
    const index=ordered.findIndex((entry)=>entry.note.id===currentId);
    const next=ordered[Math.max(0,Math.min(ordered.length-1,index+direction))];
    if(index<0||!next)return;
    s.rangeEnd=next.note.id===s.noteId?null:{measure:next.measure,voice:next.voice,noteId:next.note.id};
  }else{
    const end=Math.max(0,Math.min(score.measures.length-1,(s.measureRangeEnd??s.measure)+direction));
    if(end===s.measure)delete s.measureRangeEnd;else s.measureRangeEnd=end;
  }
  updateControls();render();
}

function deleteMeasures() {
  const [first,last]=selectedMeasureRange();
  const count=last-first+1;
  remember();
  const removed=new Set(score.measures.slice(first,last+1).flatMap((measure)=>measure.voices.flat().map((note)=>note.id)));
  score.measures.splice(first,count);
  if(!score.measures.length)score.measures.push(createMeasure());
  removeAnnotationsForNotes(removed);
  score.annotations.forEach((annotation)=>['start','end'].forEach((side)=>{
    if(annotation[side]?.measure>last)annotation[side].measure-=count;
  }));
  const next=Math.min(first,score.measures.length-1);
  score.selection={measure:next,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:0,rangeEnd:null};
  updateControls();render();
  status.textContent=`${count}개 마디를 삭제했습니다. Ctrl+Z(⌘Z)로 되돌릴 수 있습니다.`;
}

// Touch and iPad users get on-score buttons, because Safari often keeps
// ⌘C/⌘V for itself instead of delivering the key presses to the page.
// Maps notation coordinates to the sheet from the rendered size and the
// viewBox, avoiding getScreenCTM, which Safari can misreport.
function svgPointToSheet(x, y) {
  if(!notationSvg)return null;
  const rect=notationSvg.getBoundingClientRect(),sheetRect=sheet.getBoundingClientRect();
  const [minX,minY,width]=(notationSvg.getAttribute('viewBox')||'0 0 1 1').trim().split(/\s+/).map(Number);
  const scale=rect.width/(width||1);
  if(!Number.isFinite(scale)||scale<=0)return null;
  return {x:rect.left-sheetRect.left+(x-minX)*scale,y:rect.top-sheetRect.top+(y-minY)*scale,sheetWidth:sheetRect.width};
}

function placeSelectionActions(anchor) {
  const bar=$('#selectionActions');
  const point=anchor&&!lyricTarget?svgPointToSheet(anchor.x,anchor.y):null;
  if(!point){bar.hidden=true;return;}
  $('#actionCopy').hidden=!anchor.range;$('#actionDelete').hidden=!anchor.range;
  $('#actionPaste').hidden=!measureClipboard;
  bar.hidden=false;
  bar.style.left=`${Math.max(90,Math.min(point.sheetWidth-90,point.x))}px`;
  bar.style.top=`${Math.max(48,point.y)}px`;
}

function copyMeasures() {
  const [first,last]=selectedMeasureRange();
  const measures=score.measures.slice(first,last+1);
  const ids=new Set(measures.flatMap((measure)=>measure.voices.flat().map((note)=>note.id)));
  measureClipboard={
    measures:measures.map((measure)=>({voices:measure.voices,directions:measure.directions||[],deletedVoices:measure.deletedVoices||[],limit:measureLimit(measure)})),
    annotations:score.annotations.filter((annotation)=>ids.has(annotation.start?.noteId)&&ids.has(annotation.end?.noteId))
      .map((annotation)=>({...annotation,start:{...annotation.start,measure:annotation.start.measure-first},end:{...annotation.end,measure:annotation.end.measure-first}})),
  };
  measureClipboard=JSON.parse(JSON.stringify(measureClipboard));
  render();
  status.textContent=first===last?`${measureLabel(first)}를 복사했습니다. 붙여 넣을 마디를 선택하고 Ctrl+V(⌘V)를 누르세요.`:`${measureLabel(first)}–${measureLabel(last)}를 복사했습니다. 붙여 넣을 마디를 선택하고 Ctrl+V(⌘V)를 누르세요.`;
}

// Pasting overwrites measures from the selected one onward, adding measures
// at the end of the score when needed.
function pasteMeasures() {
  if(!measureClipboard){status.textContent='먼저 마디를 선택하고 Ctrl+C(⌘C)로 복사하세요.';return;}
  remember();
  const target=Math.max(0,Math.min(score.measures.length-1,score.selection.measure));
  const copy=JSON.parse(JSON.stringify(measureClipboard));
  const idMap=new Map();
  copy.measures.forEach((source,offset)=>{
    const index=target+offset;
    while(score.measures.length<=index)score.measures.push(createMeasure());
    const measure=score.measures[index];
    removeAnnotationsForNotes(new Set(measure.voices.flat().map((note)=>note.id)));
    measure.voices=source.voices.map((voice)=>voice.map((note)=>{
      const id=uid('note');idMap.set(note.id,id);return {...note,id};
    }));
    while(measure.voices.length<4)measure.voices.push([]);
    measure.directions=source.directions;
    if(source.deletedVoices.length)measure.deletedVoices=source.deletedVoices;else delete measure.deletedVoices;
    if(Math.abs(source.limit-measureLimit(measure))>.001)measure.voices.forEach((voice,voiceIndex)=>{
      if(!voice.length)return;
      materializeVoiceTicks(measure,voiceIndex);normalizeVoiceToMeasure(measure,voiceIndex);rebuildVoiceRests(measure,voiceIndex);
    });
    score.voiceCount=Math.max(score.voiceCount||1,...measure.voices.map((voice,voiceIndex)=>voice.length?voiceIndex+1:0));
  });
  const present=new Set(score.measures.flatMap((measure)=>measure.voices.flat().map((note)=>note.id)));
  copy.annotations.forEach((annotation)=>{
    const start={...annotation.start,measure:annotation.start.measure+target,noteId:idMap.get(annotation.start.noteId)};
    const end={...annotation.end,measure:annotation.end.measure+target,noteId:idMap.get(annotation.end.noteId)};
    if(present.has(start.noteId)&&present.has(end.noteId))score.annotations.push({...annotation,start,end});
  });
  const last=target+copy.measures.length-1;
  score.selection={measure:target,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:0,rangeEnd:null,...(last>target?{measureRangeEnd:last}:{})};
  updateControls();render();
  status.textContent=`${copy.measures.length}개 마디를 붙여 넣었습니다.`;
}

function undo() {
  if(!undoStack.length)return;
  score=undoStack.pop();syncMetadataInputs();updateControls();render();
}

function selectedPickupTimeSignature() {
  const [beats,beatType]=$('#pickupTimeSignature').value.split('/').map(Number);
  return {beats,beatType};
}

// The selected measure becomes a pickup with its own (shorter) time
// signature. Its events are trimmed or padded with rests to fit that length.
function setPickup(enabled, timeSignature=selectedPickupTimeSignature()) {
  const measureIndex=score.selection.measure;
  const measure=score.measures[measureIndex];
  if(!measure)return;
  const wasPickup=!!measure.pickup;
  if(!enabled&&!wasPickup)return;
  if(enabled&&wasPickup&&sameTimeSignature(measure.timeSignature,timeSignature))return;
  const nextLimit=enabled?timeSignatureTicks(timeSignature):timeSignatureTicks(score.timeSignature);
  const lost=measure.voices.flat().filter((note)=>!note.rest&&(Number(note.startTick)||0)>=nextLimit-.001);
  if(lost.length&&!window.confirm(`픽업 마디 길이를 벗어나는 음표 ${lost.length}개가 삭제됩니다. 계속할까요?`))return;
  remember();
  measure.voices.forEach((voice,voiceIndex)=>materializeVoiceTicks(measure,voiceIndex));
  const before=new Set(measure.voices.flat().map((note)=>note.id));
  if(enabled){measure.pickup=true;measure.timeSignature={...timeSignature};}
  else{delete measure.pickup;delete measure.timeSignature;}
  measure.voices.forEach((voice,voiceIndex)=>{
    if(!voice.length)return;
    normalizeVoiceToMeasure(measure,voiceIndex);
    rebuildVoiceRests(measure,voiceIndex);
  });
  const after=new Set(measure.voices.flat().map((note)=>note.id));
  removeAnnotationsForNotes(new Set([...before].filter((id)=>!after.has(id))));
  score.selection={measure:measureIndex,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:0,rangeEnd:null};
  updateControls();render();
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
  const syllabic=new Map(),previousHyphen=new Map();
  selectionOrder().forEach(({note,voice})=>{
    if(note.rest||!note.lyric?.text)return;
    const before=previousHyphen.get(voice)||false;
    syllabic.set(note.id,note.lyric.hyphen?(before?'middle':'begin'):(before?'end':'single'));
    previousHyphen.set(voice,!!note.lyric.hyphen);
  });
  const timeXml=(mi)=>{const time=measureTimeSignature(mi);return `<time${score.timeSymbol==='common'&&!score.measures[mi].pickup?' symbol="common"':''}><beats>${time.beats}</beats><beat-type>${time.beatType}</beat-type></time>`;};
  const measures = score.measures.map((m, mi) => {
    let body = `${mi > 0 && score.measures[mi-1].forceBreakAfter ? '<print new-system="yes"/>' : ''}${mi === 0 ? `<attributes><divisions>8</divisions><key><fifths>${score.keyFifths||0}</fifths></key>${timeXml(0)}<staves>2</staves>${score.instrument==='piano'?'':'<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>'}<clef number="1"><sign>G</sign><line>2</line></clef>${score.instrument==='piano'?'<clef number="2"><sign>F</sign><line>4</line></clef>':'<clef number="2"><sign>TAB</sign><line>5</line></clef><staff-details number="2"><staff-lines>6</staff-lines></staff-details>'}</attributes>${score.tempo?`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`:''}` : ''}`;
    const keyChanged=mi>0&&Number.isFinite(m.keyFifths)&&m.keyFifths!==exportedKey;
    if(keyChanged)exportedKey=m.keyFifths;
    if(keyChanged||(mi>0&&timeSignatureChangesAt(mi)))body+=`<attributes>${keyChanged?`<key><fifths>${exportedKey}</fifths></key>`:''}${mi>0&&timeSignatureChangesAt(mi)?timeXml(mi):''}</attributes>`;
    const endingStarts=score.annotations.filter((annotation)=>annotation.type==='ending'&&annotation.start?.measure===mi);
    endingStarts.forEach((annotation)=>{body+=`<barline location="left"><ending number="${annotation.number}" type="start"/></barline>`;});
    if(m.repeatStart)body+='<barline location="left"><repeat direction="forward"/></barline>';
    m.directions?.forEach((direction)=>{const justify=direction.align==='end'?'right':direction.align==='center'?'center':'left';body+=`<direction placement="${direction.placement||'above'}"><direction-type><words justify="${justify}">${escapeXml(direction.text)}</words></direction-type></direction>`;});
    m.voices.forEach((voice, vi) => {
      if (vi && voice.length) body += `<backup><duration>${measureLimit(m)}</duration></backup>`;
      voice.forEach((n) => {
        const starts=annotationStarts.get(n.id)||[],ends=annotationEnds.get(n.id)||[];
        if(n.dynamic)body+=`<direction placement="below"><direction-type><dynamics><${n.dynamic}/></dynamics></direction-type></direction>`;
        starts.filter((annotation)=>annotation.type==='crescendo'||annotation.type==='diminuendo').forEach((annotation)=>{body+=`<direction placement="below"><direction-type><wedge type="${annotation.type==='crescendo'?'crescendo':'diminuendo'}" number="1"/></direction-type></direction>`;});
        ends.filter((annotation)=>annotation.type==='crescendo'||annotation.type==='diminuendo').forEach(()=>{body+='<direction placement="below"><direction-type><wedge type="stop" number="1"/></direction-type></direction>';});
        const natural=n.rest?n.midi:naturalMidiForKey(n,0,n.midi,n.accidentals?.[0]??n.accidental);
        const xmlNatural=score.instrument==='piano'?natural:natural+12;
        const pc=((xmlNatural%12)+12)%12, octave=Math.floor(xmlNatural/12)-1, alter=Math.round(n.midi-natural);
        const dots=n.dots??(n.dotted?1:0),notations=[];
        if(!n.rest&&score.instrument!=='piano')notations.push(`<technical><string>${n.string}</string><fret>${n.fret}</fret></technical>`);
        if(!n.rest&&n.articulations?.length)notations.push(`<articulations>${n.articulations.map((name)=>`<${name}/>`).join('')}</articulations>`);
        if(n.fermata)notations.push(`<fermata${n.fermata==='below'?' type="inverted"':''}/>`);
        starts.filter((annotation)=>annotation.type==='tie').forEach(()=>notations.push('<tied type="start"/>'));
        ends.filter((annotation)=>annotation.type==='tie').forEach(()=>notations.push('<tied type="stop"/>'));
        starts.filter((annotation)=>annotation.type==='slur').forEach(()=>notations.push('<slur type="start" number="1"/>'));
        ends.filter((annotation)=>annotation.type==='slur').forEach(()=>notations.push('<slur type="stop" number="1"/>'));
        const ties=`${starts.some((annotation)=>annotation.type==='tie')?'<tie type="start"/>':''}${ends.some((annotation)=>annotation.type==='tie')?'<tie type="stop"/>':''}`;
        body += `<note>${n.grace?`<grace${n.graceSlash?' slash="yes"':''}/>`:''}${n.rest?'<rest/>':`<pitch><step>${STEP[pc]}</step>${alter?`<alter>${alter}</alter>`:''}<octave>${octave}</octave></pitch>`}${n.grace?'':`<duration>${durationTicks(n)}</duration>`}${ties}<voice>${vi+1}</voice><type>${({32:'whole',16:'half',8:'quarter',4:'eighth',2:'16th',1:'32nd'})[n.duration]||'quarter'}</type>${'<dot/>'.repeat(dots)}${n.tuplet?`<time-modification><actual-notes>${n.tuplet.actual}</actual-notes><normal-notes>${n.tuplet.normal}</normal-notes></time-modification>`:''}<staff>1</staff>${n.beams?.map((beam)=>`<beam number="${beam.number}">${beam.value}</beam>`).join('')||''}${notations.length?`<notations>${notations.join('')}</notations>`:''}${!n.rest&&n.lyric?.text?`<lyric number="1"><syllabic>${syllabic.get(n.id)||'single'}</syllabic><text>${escapeXml(n.lyric.text)}</text></lyric>`:''}</note>`;
      });
    });
    if(m.repeatEnd)body+='<barline location="right"><repeat direction="backward"/></barline>';
    const endingEnds=score.annotations.filter((annotation)=>annotation.type==='ending'&&annotation.end?.measure===mi);
    endingEnds.forEach((annotation)=>{body+=`<barline location="right"><ending number="${annotation.number}" type="${annotation.closed?'stop':'discontinue'}"/></barline>`;});
    const measureNumber=!m.pickup?displayMeasureNumber(mi):mi===0?0:`X${mi+1}`;
    return `<measure number="${measureNumber}"${m.pickup?' implicit="yes"':''}>${body}</measure>`;
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

function pdfFileName() {
  return `${(score.metadata.title||'score').replace(/[\\/:*?"<>|]+/g,'_')}.pdf`;
}

// Systems are never split across pages: each page ends on a system boundary.
function pdfPageSlices(sourceHeight, firstCapacity, normalCapacity, systemBreaks) {
  const slices=[];
  let sourceY=0, first=true;
  while(sourceY<sourceHeight-.5) {
    const maximum=Math.min(sourceHeight,sourceY+(first?firstCapacity:normalCapacity));
    const boundary=systemBreaks.filter((value)=>value>sourceY+.5&&value<=maximum+.5).at(-1)||maximum;
    slices.push({sourceY,height:Math.max(.5,boundary-sourceY),first});
    sourceY=boundary; first=false;
  }
  if(!slices.length) slices.push({sourceY:0,height:sourceHeight,first:true});
  return slices;
}

const PDF_LATIN_TEXT=/^[\x20-\x7E\u00A0-\u00FF]*$/;

// Century Schoolbook L (the face of LilyPond-engraved guitar books) is
// embedded in the PDF for TAB digits, numbers and Latin text when loaded.
const PDF_SERIF_FONT='CenturySchL';
let pdfSerifFonts=null;
async function embedPdfSerifFont(doc) {
  try{
    if(!pdfSerifFonts){
      const files={normal:'Roma',bold:'Bold',italic:'Ital',bolditalic:'BoldItal'};
      pdfSerifFonts=await Promise.all(Object.entries(files).map(async([style,name])=>{
        const response=await fetch(`./fonts/century-schoolbook-l/CenturySchL-${name}.ttf`);
        if(!response.ok)throw new Error(response.statusText);
        const bytes=new Uint8Array(await response.arrayBuffer());
        let binary='';for(let index=0;index<bytes.length;index+=0x8000)binary+=String.fromCharCode(...bytes.subarray(index,index+0x8000));
        return {style,file:`CenturySchL-${name}.ttf`,data:btoa(binary)};
      }));
    }
    pdfSerifFonts.forEach(({style,file,data})=>{doc.addFileToVFS(file,data);doc.addFont(file,PDF_SERIF_FONT,style);});
    return true;
  }catch{pdfSerifFonts=null;return false;}
}

let pdfSerifAvailable=false;
function pdfFontFamily(cssFamily='') {
  if(/arial|helvetica|sans|gothic|고딕/i.test(cssFamily))return 'helvetica';
  return pdfSerifAvailable?PDF_SERIF_FONT:'times';
}

// Text outside the PDF standard fonts (Korean, symbols) is drawn as a sharp
// high-resolution image; everything else stays vector.
function rasterText(text, font, sizePx, scale=8) {
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  ctx.font=font.replace('{size}',`${sizePx*scale}px`);
  const width=Math.max(1,Math.ceil(ctx.measureText(text).width)),height=Math.ceil(sizePx*scale*1.4);
  canvas.width=width+scale*2;canvas.height=height;
  ctx.font=font.replace('{size}',`${sizePx*scale}px`);ctx.fillStyle='#111';ctx.textBaseline='alphabetic';
  ctx.fillText(text,scale,sizePx*scale*1.05);
  return {url:canvas.toDataURL('image/png'),width:canvas.width/scale,height:canvas.height/scale,ascent:sizePx*1.05,padding:1};
}

function drawPdfText(doc, text, x, y, size, {align='left',bold=false,cssFamily=score.textFont||'Georgia, serif'}={}) {
  if(!text)return;
  if(PDF_LATIN_TEXT.test(text)){
    doc.setFont(pdfFontFamily(cssFamily),bold?'bold':'normal');doc.setFontSize(size);doc.setTextColor(17,17,17);
    doc.text(text,x,y,{align});return;
  }
  const image=rasterText(text,`${bold?'bold ':''}{size} ${cssFamily}`,size);
  const left=align==='center'?x-image.width/2:align==='right'?x-image.width:x-image.padding;
  doc.addImage(image.url,'PNG',left,y-image.ascent,image.width,image.height);
}

function vectorScoreClone() {
  const clone=notationSvg.cloneNode(true);
  clone.setAttribute('xmlns', NS);
  const liveTexts=[...notationSvg.querySelectorAll('text')],cloneTexts=[...clone.querySelectorAll('text')];
  cloneTexts.forEach((node,index)=>{
    const live=liveTexts[index],text=node.textContent||'';
    if(node.matches('.break-mark,.measure-warning-text')||!text.trim()){node.remove();return;}
    const style=getComputedStyle(live);
    if(!PDF_LATIN_TEXT.test(text)){
      const box=live.getBBox(),size=parseFloat(style.fontSize)||14;
      const image=rasterText(text,`${style.fontStyle} ${style.fontWeight} {size} ${style.fontFamily}`,size);
      const anchor=live.getAttribute('text-anchor')||style.textAnchor;
      const x=Number(live.getAttribute('x'))||box.x,y=Number(live.getAttribute('y'))||box.y+box.height;
      const left=anchor==='middle'?x-image.width/2:anchor==='end'?x-image.width:x-image.padding;
      const replacement=document.createElementNS(NS,'image');
      if(node.hasAttribute('data-pdf-system'))replacement.setAttribute('data-pdf-system',node.getAttribute('data-pdf-system'));
      Object.entries({x:left,y:y-image.ascent,width:image.width,height:image.height,href:image.url}).forEach(([key,value])=>replacement.setAttribute(key,value));
      node.replaceWith(replacement);return;
    }
    node.setAttribute('font-family',pdfFontFamily(style.fontFamily));
    node.setAttribute('font-size',style.fontSize);
    node.setAttribute('font-weight',Number(style.fontWeight)>=600||style.fontWeight==='bold'?'bold':'normal');
    node.setAttribute('font-style',style.fontStyle==='italic'?'italic':'normal');
    // Voice colours print black; tied TAB frets keep their grey.
    node.setAttribute('fill',style.fill==='rgb(163, 169, 179)'?TIED_TAB_COLOR:'#111');
    // Text inherits VexFlow's group stroke in svg2pdf, which thickens glyphs.
    node.setAttribute('stroke','none');
    const inline=node.getAttribute('style');
    if(inline)node.setAttribute('style',inline.replace(/font[^;]*;?/g,''));
  });
  clone.querySelectorAll('.hit,.measure-hit,.selected-measure,.hairpin-handle,.range-selection,.measure-warning-bg').forEach((node)=>node.remove());
  clone.querySelectorAll('*').forEach((node)=>{
    for(const attr of ['fill','stroke','style']){
      const value=node.getAttribute(attr);if(!value)continue;
      node.setAttribute(attr,value.replaceAll('#aeb4bf','#111').replaceAll('#2368c4','#111').replaceAll('#b33a3a','#111').replaceAll('#15805f','#111').replaceAll('#d97706','#111'));
    }
  });
  // svg2pdf only switches fonts when a text's weight differs from its parent's;
  // a numeric root weight makes every explicitly weighted text set its font.
  clone.setAttribute('font-weight','400');
  const style=document.createElementNS(NS,'style');
  style.textContent='.slur,.tie,.ending-line{fill:none;stroke:#111;stroke-width:1.5}.barre{fill:none;stroke:#111;stroke-width:1.2;stroke-dasharray:5 4}';
  clone.prepend(style);
  return clone;
}

const PDF_HIDDEN_CLASSES=['hit','measure-hit','selected-measure','hairpin-handle','range-selection','measure-warning-bg','measure-warning-text','break-mark'];

// Tags every drawn element of the live score with its system (by the centre
// of its box) and measures each system's real vertical extent.
function tagPdfSystems() {
  const cores=[...renderedSystemCores];
  const systems=cores.map(()=>({top:Infinity,bottom:-Infinity,left:Infinity,right:-Infinity}));
  // Marks drawn after the systems (slurs, lyrics, dynamics) belong to the
  // system whose staves are nearest to them.
  const nearestSystem=(centre)=>cores.reduce((best,core,index)=>{
    const distance=centre<core.top?core.top-centre:centre>core.bottom?centre-core.bottom:0;
    return distance<best.distance?{index,distance}:best;
  },{index:0,distance:Infinity}).index;
  notationSvg.querySelectorAll('path,rect,line,text,ellipse,circle,polyline,polygon,image').forEach((node)=>{
    let box;try{box=node.getBBox();}catch{return;}
    const owner=node.closest('[data-system]');
    const index=owner?Number(owner.getAttribute('data-system')):nearestSystem(box.y+box.height/2);
    if(!systems[index])return;
    node.setAttribute('data-pdf-system',index);
    if(PDF_HIDDEN_CLASSES.some((name)=>node.classList?.contains(name))||(!box.width&&!box.height))return;
    systems[index].top=Math.min(systems[index].top,box.y);
    systems[index].bottom=Math.max(systems[index].bottom,box.y+box.height);
    systems[index].left=Math.min(systems[index].left,box.x);
    systems[index].right=Math.max(systems[index].right,box.x+box.width);
  });
  return systems.map((system,index)=>({index,...system})).filter((system)=>Number.isFinite(system.top));
}

async function loadPdfFonts() {
  if(!document.fonts?.load)return;
  const family=score.textFont||'Georgia, serif';
  const texts=[...notationSvg.querySelectorAll('text')].map((node)=>node.textContent||'')
    .concat(Object.values(score.metadata)).filter((text)=>text&&!PDF_LATIN_TEXT.test(text));
  const unique=[...new Set(texts)].slice(0,400);
  await Promise.all(unique.flatMap((text)=>[`16px ${family}`,`bold 16px ${family}`].map((font)=>document.fonts.load(font,text).catch(()=>null))));
}

// Vector PDF: notation stays as paths, so it prints sharply at any zoom.
// Systems are placed four to a page and spread evenly down the page.
async function exportPdf() {
  const jsPDF=window.jspdf?.jsPDF;
  if(!jsPDF||!window.svg2pdf?.svg2pdf)return exportRasterPdf();
  const holder=document.createElement('div');
  holder.style.cssText='position:fixed;left:-10000px;top:0;width:10px;height:10px;overflow:hidden;';
  document.body.appendChild(holder);
  try {
    await loadPdfFonts();
    const sizes={A4:[595.28,841.89],A3:[841.89,1190.55],Letter:[612,792],Screen:[595.28,841.89]};
    const [pageWidth,pageHeight]=sizes[score.page]||sizes.A4;
    const doc=new jsPDF({unit:'pt',format:[pageWidth,pageHeight],compress:true});
    doc.setProperties({title:score.metadata.title||'score',author:score.metadata.composer||''});
    pdfSerifAvailable=await embedPdfSerifFont(doc);
    const serif=pdfSerifAvailable?PDF_SERIF_FONT:'times';
    const systems=tagPdfSystems();
    const base=vectorScoreClone();
    // Systems are cropped to the drawn notation (bracket to final barline),
    // so the 8% side margins are measured from the music itself and title
    // credits line up with the system edges, as in engraved guitar books.
    const marginX=pageWidth*.08, contentWidth=pageWidth-marginX*2;
    const pad=4, cropLeft=Math.min(...systems.map((system)=>system.left))-pad;
    const cropWidth=Math.max(...systems.map((system)=>system.right))+pad-cropLeft;
    const hasMetadata=Object.values(score.metadata).some(Boolean);
    const normalTop=pageHeight*.09, bottomMargin=pageHeight*.06, firstTop=hasMetadata?pageHeight*.175:normalTop;
    const perPage=4, minGap=16;
    const heightOf=(system)=>system.bottom-system.top+pad*2;
    const available=(pageIndex)=>pageHeight-(pageIndex?normalTop:firstTop)-bottomMargin;
    let scale=contentWidth/cropWidth;
    const tallest=Math.max(0,...systems.map(heightOf));
    if(tallest*scale>available(0))scale=available(0)/tallest;
    const pages=[[]];
    let used=0;
    systems.forEach((system)=>{
      const page=pages.at(-1),height=heightOf(system)*scale;
      if(page.length&&(page.length>=perPage||used+minGap+height>available(pages.length-1))){pages.push([system]);used=height;return;}
      used+=(page.length?minGap:0)+height;page.push(system);
    });
    const justifiedGap=(page,pageIndex)=>page.length>1?(available(pageIndex)-page.reduce((sum,system)=>sum+heightOf(system),0)*scale)/(page.length-1):0;
    const fullGaps=pages.slice(0,-1).map(justifiedGap).filter((gap)=>gap>0);
    const averageHeight=systems.length?systems.reduce((sum,system)=>sum+heightOf(system),0)/systems.length*scale:0;
    const standardGap=Math.max(minGap,Math.min(90,fullGaps.length?fullGaps.reduce((a,b)=>a+b,0)/fullGaps.length:(available(1)-perPage*averageHeight)/(perPage-1)));
    const drawWidth=cropWidth*scale, x=marginX+(contentWidth-drawWidth)/2;
    const left=x, right=x+drawWidth;
    for(const [pageIndex,page] of pages.entries()) {
      if(pageIndex)doc.addPage([pageWidth,pageHeight]);
      drawPdfText(doc,String(pageIndex+1),right,pageHeight*.067,pageWidth*.02,{align:'right'});
      if(!pageIndex&&hasMetadata){
        drawPdfText(doc,score.metadata.title,pageWidth/2,pageHeight*.115,pageWidth*.034,{align:'center'});
        const creditY=firstTop-pageHeight*.012;
        drawPdfText(doc,score.metadata.lyricist,left,creditY,pageWidth*.019);
        drawPdfText(doc,score.metadata.composer,right,creditY,pageWidth*.019,{align:'right'});
      }else if(pageIndex&&score.metadata.title){
        drawPdfText(doc,score.metadata.title,left,pageHeight*.067,pageWidth*.016);
      }
      const lastPage=pageIndex===pages.length-1;
      const gap=lastPage?Math.min(standardGap,page.length>1?justifiedGap(page,pageIndex):standardGap):justifiedGap(page,pageIndex);
      let y=pageIndex?normalTop:firstTop;
      for(const system of page){
        const clone=base.cloneNode(true);
        clone.querySelectorAll('[data-pdf-system]').forEach((node)=>{if(Number(node.getAttribute('data-pdf-system'))!==system.index)node.remove();});
        const height=heightOf(system);
        clone.setAttribute('viewBox',`${cropLeft} ${system.top-pad} ${cropWidth} ${height}`);
        clone.setAttribute('width',cropWidth);clone.setAttribute('height',height);
        holder.replaceChildren(clone);
        doc.setFont(serif,'normal');
        await window.svg2pdf.svg2pdf(clone,doc,{x,y,width:drawWidth,height:height*scale});
        y+=height*scale+gap;
      }
    }
    download(pdfFileName(),doc.output("blob"),"application/pdf");
  } catch(error) {
    alert(`PDF 생성 중 문제가 생겼습니다: ${error.message}`);
  } finally {
    holder.remove();
    notationSvg?.querySelectorAll('[data-pdf-system]').forEach((node)=>node.removeAttribute('data-pdf-system'));
  }
}

async function exportRasterPdf() {
  try {
    const sizes={
      A4:{px:[1984,2806],pt:[595.28,841.89]}, A3:{px:[2806,3968],pt:[841.89,1190.55]},
      Letter:{px:[2040,2640],pt:[612,792]}, Screen:{px:[1984,2806],pt:[595.28,841.89]},
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
    download(pdfFileName(),pdf,'application/pdf');
  } catch(error) {
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

function ticksToTimeSignature(ticks, preferredBeatType) {
  for(const beatType of [preferredBeatType,4,8,16]){
    const beats=ticks*beatType/32;
    if(beats>=1&&Math.abs(beats-Math.round(beats))<.001)return {beats:Math.round(beats),beatType};
  }
  return null;
}

// Implicit (uncounted) measures become pickups: either they declare their own
// time signature (as this editor exports them) or they simply hold fewer
// beats than the score's time signature. A first measure whose time signature
// differs from the second one is also treated as a pickup.
function detectImportedPickups(target, times, implicitFlags) {
  if(!target.measures.length||!times[0])return;
  const firstDiffers=target.measures.length>1&&times[1]&&!sameTimeSignature(times[0],times[1]);
  const isPickup=(index)=>implicitFlags[index]||(index===0&&firstDiffers);
  const mainIndex=target.measures.findIndex((measure,index)=>!isPickup(index));
  if(mainIndex<0)return;
  const main={beats:times[mainIndex].beats,beatType:times[mainIndex].beatType};
  target.measures.forEach((measure,index)=>{
    if(!isPickup(index)||!times[index])return;
    let pickupTime=null;
    if(!sameTimeSignature(times[index],main))pickupTime={beats:times[index].beats,beatType:times[index].beatType};
    else{
      const content=Math.max(0,...measure.voices.flatMap((voice)=>voice.filter((note)=>!note.grace).map((note)=>(Number(note.startTick)||0)+durationTicks(note))));
      if(content>0&&content<timeSignatureTicks(main)-.001)pickupTime=ticksToTimeSignature(content,main.beatType);
    }
    if(pickupTime){measure.pickup=true;measure.timeSignature=pickupTime;}
  });
  target.timeSignature=main;target.timeSymbol=times[mainIndex].symbol||'';
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
  const importedTimes=[];
  let currentTime={...fresh.timeSignature,symbol:fresh.timeSymbol};
  const implicitFlags=[];
  doc.querySelectorAll('part:first-of-type > measure').forEach((mx,measureIndex) => {
    const m = createMeasure();
    implicitFlags.push(mx.getAttribute('implicit')==='yes');
    const timeNode=mx.querySelector(':scope > attributes > time');
    if(timeNode)currentTime={beats:Number(timeNode.querySelector('beats')?.textContent||currentTime.beats),beatType:Number(timeNode.querySelector('beat-type')?.textContent||currentTime.beatType),symbol:timeNode.getAttribute('symbol')||''};
    importedTimes.push(currentTime);
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
      note.diatonicMidis=[note.diatonicMidi];
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
      const lyricNode=nx.querySelector(':scope > lyric');
      const lyricText=lyricNode?.querySelector('text')?.textContent?.trim();
      if(lyricText&&!isChord)note.lyric={text:lyricText,hyphen:['begin','middle'].includes(lyricNode.querySelector('syllabic')?.textContent?.trim())};
      const articulations=[...nx.querySelectorAll('notations articulations > *')].map((node)=>node.tagName).filter((name)=>ARTICULATIONS[name]);
      if(articulations.length)note.articulations=articulations;
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
          previous.diatonicMidis ||= [previous.diatonicMidi];
          previous.diatonicMidis.push(note.diatonicMidi);
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
  detectImportedPickups(fresh,importedTimes,implicitFlags);
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

document.querySelectorAll('[data-duration]').forEach((button) => button.addEventListener('click', () => changeSelectedDuration(Number(button.dataset.duration))));
$('#dot').addEventListener('click', () => {
  const entry=selectedEntry();
  if(entry){
    const current=entry.note.dots??(entry.note.dotted?1:0),nextDots=current===1?0:1;
    changeSelectedDots(nextDots);return;
  }
  else {dotted=!dotted;if(dotted)doubleDotted=false;}
  updateControls();render();
});
$('#doubleDot').addEventListener('click', () => {
  const entry=selectedEntry();
  if(entry){
    const current=entry.note.dots??(entry.note.dotted?1:0),nextDots=current===2?0:2;
    changeSelectedDots(nextDots);return;
  }else{doubleDotted=!doubleDotted;if(doubleDotted)dotted=false;}
  updateControls();render();
});
$('#sharp').addEventListener('click',()=>applyAccidental(1));
$('#flat').addEventListener('click',()=>applyAccidental(-1));
$('#natural').addEventListener('click',()=>applyAccidental(0));
$('#enharmonic').addEventListener('click',toggleEnharmonic);
$('#rest').addEventListener('click', () => {restMode=!restMode;updateControls();});
$('#voice').addEventListener('click', () => {
  const entry=selectedEntry();
  const cursorTick=entry?notePosition(entry.note,entry.measure,entry.voice):(score.selection.cursorTick??0);
  const measureIndex=score.selection.measure;
  const previousSource=score.selection.source||'staff';
  score.activeVoice=(score.activeVoice+1)%Math.max(1,score.voiceCount||1);
  ensureEditableRests();
  const first=firstSelectableEvent(measureIndex,score.activeVoice,0,true,true);
  score.selection=first
    ?{measure:measureIndex,voice:score.activeVoice,noteId:first.note.id,source:first.note.rest?'staff':previousSource,cursorTick:first.tick,rangeEnd:null}
    :{measure:measureIndex,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:Math.min(measureLimit(measureIndex),cursorTick),rangeEnd:null};
  updateControls();render();
});
$('#addVoice').addEventListener('click',()=>{
  const current=Math.max(1,score.voiceCount||1);if(current>=4)return;
  remember();score.voiceCount=current+1;score.activeVoice=current;
  score.selection={measure:score.selection.measure,voice:current,noteId:null,source:'staff',cursorTick:0,rangeEnd:null};
  render();
});

function deleteActiveVoice(currentMeasureOnly=false){
  const voice=score.activeVoice;
  if(!currentMeasureOnly&&(score.voiceCount||1)<=1){status.textContent='마지막 성부는 삭제할 수 없습니다.';return;}
  const message=currentMeasureOnly
    ? `${measureLabel(score.selection.measure)}의 V${voice+1} 음표와 쉼표를 모두 삭제할까요?`
    : `V${voice+1} 성부의 모든 음표와 쉼표가 악보 전체에서 사라집니다. 정말 계속할까요?`;
  if(!window.confirm(message))return;
  remember();
  if(currentMeasureOnly){
    const measure=score.measures[score.selection.measure];
    const removed=new Set((measure.voices[voice]||[]).map((note)=>note.id));
    measure.voices[voice]=[];
    measure.deletedVoices=[...new Set([...(measure.deletedVoices||[]),voice])];
    score.annotations=score.annotations.filter((annotation)=>!removed.has(annotation.start?.noteId)&&!removed.has(annotation.end?.noteId));
  }else{
    const removed=new Set(score.measures.flatMap((measure)=>(measure.voices[voice]||[]).map((note)=>note.id)));
    score.measures.forEach((measure)=>{
      measure.voices.splice(voice,1);measure.voices.push([]);
      measure.deletedVoices=(measure.deletedVoices||[]).filter((item)=>item!==voice).map((item)=>item>voice?item-1:item);
    });
    score.annotations=score.annotations.filter((annotation)=>!removed.has(annotation.start?.noteId)&&!removed.has(annotation.end?.noteId));
    score.annotations.forEach((annotation)=>['start','end'].forEach((side)=>{if(annotation[side]?.voice>voice)annotation[side].voice--;}));
    score.voiceCount--;
    score.activeVoice=Math.min(voice,score.voiceCount-1);
  }
  score.selection={measure:score.selection.measure,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:0,rangeEnd:null};
  updateControls();render();scoreSvg.focus?.({preventScroll:true});
}

$('#deleteVoice').addEventListener('click',()=>deleteActiveVoice(false));
$('#deleteMeasureVoice').addEventListener('click',()=>deleteActiveVoice(true));
$('#grace').addEventListener('click', () => {graceMode=!graceMode;updateControls();render();});
$('#tie').addEventListener('click', () => addAnnotation('tie'));
document.querySelectorAll('[data-articulation]').forEach((button)=>button.addEventListener('click',()=>toggleArticulation(button.dataset.articulation)));
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
$('#undo').addEventListener('click', undo);
$('#copyMeasures').addEventListener('click', copyMeasures);
$('#selectionActions').addEventListener('pointerdown',(event)=>{event.preventDefault();event.stopPropagation();});
$('#actionCopy').addEventListener('click',copyMeasures);
$('#actionPaste').addEventListener('click',pasteMeasures);
$('#actionDelete').addEventListener('click',deleteMeasures);
// Clipboard events also arrive when a keyboard shortcut is turned into a
// system copy/paste command instead of a keydown.
const scoreClipboardTarget=(event)=>!lyricTarget&&!event.target?.matches?.('input,select,textarea')&&!document.querySelector('dialog[open]')&&!String(window.getSelection?.()||'');
document.addEventListener('copy',(event)=>{if(!scoreClipboardTarget(event))return;event.preventDefault();copyMeasures();});
document.addEventListener('paste',(event)=>{if(!scoreClipboardTarget(event))return;event.preventDefault();pasteMeasures();});
$('#deleteMeasures').addEventListener('click', deleteMeasures);
$('#newScore').addEventListener('click', newScore);
$('#lyrics').addEventListener('click', startLyrics);
$('#songs').addEventListener('click', openSongList);
$('#songsDialog .close-dialog').addEventListener('click', () => $('#songsDialog').close());
$('#pasteMeasures').addEventListener('click', pasteMeasures);
window.addEventListener('pagehide', saveToBrowser);
$('#clear').addEventListener('click', () => { remember();score.measures=[createMeasure()];score.annotations=[];score.selection={measure:0,voice:score.activeVoice,noteId:null,source:'staff',cursorTick:0,rangeEnd:null};render(); });
$('#page').addEventListener('change', (e) => { score.page=e.target.value;render(); });
$('#instrument').addEventListener('change', (e) => { score.instrument=e.target.value;updateControls();render(); });
$('#textFont').addEventListener('change', (e) => { score.textFont=e.target.value;render(); });
$('#measuresPerSystem').addEventListener('change', (e) => { score.measuresPerSystem=Number(e.target.value);render(); });
$('#systemSpacing').addEventListener('change', (e) => { score.systemSpacing=Number(e.target.value);render(); });
$('#timeSignature').addEventListener('change', (e) => { const [beats,beatType]=e.target.value.split('/').map(Number);score.timeSignature={beats,beatType};render(); });
$('#pickup').addEventListener('click',()=>setPickup(!score.measures[score.selection.measure]?.pickup));
$('#pickupTimeSignature').addEventListener('change',()=>{if(score.measures[score.selection.measure]?.pickup)setPickup(true);});
$('#transpose').addEventListener('click',()=>transposeScore(Number($('#transposeInterval').value)));
$('#keySignature').addEventListener('change', (e) => {score.keyFifths=Number(e.target.value);render();});
$('#tempo').addEventListener('change', (e) => {score.tempo=Math.max(20,Math.min(300,Number(e.target.value)||120));e.target.value=score.tempo;render();});
$('#addDirection').addEventListener('click', () => {const text=$('#directionText').value.trim();if(!text)return;const measure=score.measures[score.selection.measure];remember();measure.directions??=[];measure.directions.push({text,placement:$('#directionPlacement').value,align:$('#directionAlign').value});$('#directionText').value='';render();});
['title','lyricist','composer'].forEach((key) => $(`#${key}`).addEventListener('input', (e) => { score.metadata[key]=e.target.value;render(); }));
$('#xmlExport').addEventListener('click', () => download(`${score.metadata.title||'score'}.musicxml`,toMusicXml(),'application/vnd.recordare.musicxml+xml'));
$('#xmlImport').addEventListener('change', async (e) => { try{const file=e.target.files[0];if(file)importMusicXml(await file.text());}catch(err){alert(err.message);}e.target.value='';scoreSvg.focus?.({preventScroll:true}); });
$('#pdf').addEventListener('click', exportPdf);
$('#help').addEventListener('click', () => $('#helpDialog').showModal());
$('#helpDialog button').addEventListener('click', () => $('#helpDialog').close());

function isCommaShortcut(event){
  return event.code==='Comma'||event.key===','||event.key==='，'||event.keyCode===188||event.which===188||event.charCode===44;
}

function handleTieShortcut(event){
  if(!isCommaShortcut(event)||event.target?.matches?.('input,select,textarea')||document.querySelector('dialog[open]'))return;
  event.preventDefault();
  event.stopImmediatePropagation();
  // iPadOS can expose a punctuation key on keypress or keyup instead of
  // keydown while a Korean IME is active. Listen to all three events but
  // create only one tie for the physical key press.
  const now=Date.now();
  if(now-lastTieShortcutAt<350)return;
  lastTieShortcutAt=now;
  addAnnotation('tie');
}

window.addEventListener('keydown',handleTieShortcut,true);
window.addEventListener('keypress',handleTieShortcut,true);
window.addEventListener('keyup',handleTieShortcut,true);

document.addEventListener('keydown', (e) => {
  if (e.target?.matches?.('input,select,textarea') || document.querySelector('dialog[open]')) return;
  if(e.ctrlKey||e.metaKey){
    if(e.code==='KeyC'){e.preventDefault();copyMeasures();return;}
    if(e.code==='KeyV'){e.preventDefault();pasteMeasures();return;}
    if(e.code==='KeyZ'&&!e.shiftKey){e.preventDefault();undo();return;}
    if(e.code==='Backspace'||e.code==='Delete'){e.preventDefault();deleteMeasures();return;}
    if(e.code==='KeyL'){e.preventDefault();startLyrics();return;}
    if(e.code!=='ArrowUp'&&e.code!=='ArrowDown')return;
  }
  if(e.code==='Equal'||e.key==='='){e.preventDefault();applyAccidental(1);return;}
  if(e.code==='Minus'||e.key==='-'){e.preventDefault();applyAccidental(-1);return;}
  if(e.code==='BracketLeft'||e.key==='['){e.preventDefault();toggleRepeat('repeatStart');return;}
  if(e.code==='BracketRight'||e.key===']'){e.preventDefault();toggleRepeat('repeatEnd');return;}
  if (PITCH_BY_CODE[e.code] != null) { e.preventDefault(); addNote(PITCH_BY_CODE[e.code]); return; }
  if (e.code === 'Period' || e.code === 'NumpadDecimal') { e.preventDefault();$('#dot').click();return; }
  if (/^Digit\d$/.test(e.code) || /^Numpad\d$/.test(e.code)) {
    const digit=e.code.at(-1);
    const selectedNote=selectedEntry()?.note;
    if(score.selection.source==='tab'&&selectedNote&&!selectedNote.rest){
      e.preventDefault();changeFret(digit);return;
    }
    if(digit==='0'&&selectedNote&&!selectedNote.rest){
      e.preventDefault();applyAccidental(0);return;
    }
    const durationByDigit={1:32,2:16,3:8,4:4,5:2};
    if(durationByDigit[digit]){e.preventDefault();changeSelectedDuration(durationByDigit[digit]);return;}
  }
  if(e.code==='Tab'){e.preventDefault();insertMeasureAfterSelection();return;}
  if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && e.shiftKey) {
    e.preventDefault();extendSelectionByKeyboard(e.code==='ArrowLeft'?-1:1);return;
  }
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
  else if (e.code === 'Escape') { score.selection.rangeEnd=null;delete score.selection.measureRangeEnd;render(); }
});

// Bottom dock: one row of category tabs and, above the keyboard edge, the
// tools of the chosen category only. Tapping the open tab hides the tools.
const dock=$('#dock'),dockTabs=$('#dockTabs');
const toolGroups=[...document.querySelectorAll('.tool-group')];
const DOCK_TAB_KEY='guitar-score-app:dock-tab';
function selectDockTab(index, toggle=false) {
  const wasActive=toolGroups[index]?.classList.contains('active');
  if(toggle&&wasActive&&!dock.classList.contains('panel-collapsed')){dock.classList.add('panel-collapsed');}
  else dock.classList.remove('panel-collapsed');
  toolGroups.forEach((group,groupIndex)=>group.classList.toggle('active',groupIndex===index));
  dockTabs.querySelectorAll('.dock-tab').forEach((tab,tabIndex)=>{tab.classList.toggle('active',tabIndex===index);tab.setAttribute('aria-selected',String(tabIndex===index));});
  try{localStorage.setItem(DOCK_TAB_KEY,String(index));}catch{}
  fitDockPadding();
}
function fitDockPadding() {
  document.body.style.paddingBottom=`${dock.offsetHeight+8}px`;
}
toolGroups.forEach((group,index)=>{
  const label=group.querySelector('.group-label');
  const tab=document.createElement('button');
  tab.type='button';tab.className='dock-tab';tab.setAttribute('role','tab');
  tab.title=`${label.textContent.trim()} 도구`;
  const icon=document.createElement('span');
  icon.className=`tab-icon${/^[a-z]+$/.test(label.dataset.icon)?' text-icon':''}`;icon.textContent=label.dataset.icon;
  const name=document.createElement('span');name.textContent=label.dataset.short;
  tab.append(icon,name);
  tab.addEventListener('click',()=>selectDockTab(index,true));
  dockTabs.appendChild(tab);
});
const dockSpacer=document.createElement('span');dockSpacer.className='dock-spacer';
const quickUndo=document.createElement('button');
quickUndo.type='button';quickUndo.className='dock-quick';quickUndo.textContent='↶';quickUndo.title='실행 취소 (Ctrl+Z)';quickUndo.setAttribute('aria-label','실행 취소');
quickUndo.addEventListener('click',undo);
dockTabs.append(dockSpacer,quickUndo);
let savedDockTab=0;
try{savedDockTab=Math.max(0,Math.min(toolGroups.length-1,Number(localStorage.getItem(DOCK_TAB_KEY))||0));}catch{}
selectDockTab(savedDockTab);
if(typeof ResizeObserver!=='undefined')new ResizeObserver(fitDockPadding).observe(dock);
window.addEventListener('resize',fitDockPadding);

// Native title bubbles are delayed, inconsistent between browsers, and are
// commonly suppressed for SVG-only buttons. Mirror every toolbar title into
// a CSS tooltip that appears immediately on mouse hover or keyboard focus.
document.querySelectorAll('.toolbar [title]').forEach((control)=>{
  control.dataset.tooltip=control.getAttribute('title');
  control.setAttribute('aria-label',control.getAttribute('aria-label')||control.getAttribute('title'));
});

// The tool panel scrolls horizontally, which would clip CSS tooltips, so a
// viewport-level tooltip above the control shows the tool name on pointer
// hover, keyboard focus, Apple Pencil hover and touch.
const compactToolTip=document.createElement('div');
compactToolTip.className='compact-tool-tooltip';
compactToolTip.setAttribute('role','status');
document.body.appendChild(compactToolTip);
let compactToolTipTimer=null;
function showCompactToolTip(control){
  if(!control?.dataset.tooltip)return;
  clearTimeout(compactToolTipTimer);
  compactToolTip.textContent=control.dataset.tooltip;
  compactToolTip.classList.add('visible');
  const rect=control.getBoundingClientRect();
  compactToolTip.style.left=`${Math.max(80,Math.min(innerWidth-80,rect.left+rect.width/2))}px`;
  compactToolTip.style.top=`${Math.max(45,rect.top-7)}px`;
  compactToolTipTimer=setTimeout(()=>compactToolTip.classList.remove('visible'),1800);
}
const toolbar=$('.toolbar');
toolbar.addEventListener('pointerover',(event)=>showCompactToolTip(event.target.closest('[data-tooltip]')));
toolbar.addEventListener('pointerdown',(event)=>showCompactToolTip(event.target.closest('[data-tooltip]')),{capture:true});
toolbar.addEventListener('focusin',(event)=>showCompactToolTip(event.target.closest('[data-tooltip]')));

restoreFromBrowser();
syncMetadataInputs(); updateControls(); render();

export { score, toMusicXml, importMusicXml, pitchY, writtenMidi, buildPdf };
