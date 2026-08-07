/* =====================================================================
   PULSE DJ — mix logic
   ---------------------------------------------------------------------
   The pure decision-making behind auto-play: harmonic and tempo scoring,
   energy and phrase structure, track selection, and the content-derived
   track id.

   Extracted from the app so it can be exercised directly. Nothing here
   touches the DOM, React, the AudioContext or storage — every function is
   a plain transformation of numbers and plain objects, which is what makes
   tests.html able to assert on it without booting the application.
   ===================================================================== */

export const PITCH_RANGE=16;   // percent, each way — the classic ±16% turntable range

/* ============================================================
   AUTO-DJ TRACK SELECTION
   ------------------------------------------------------------
   Scores candidate tracks against the one currently playing, using the
   same two things a human DJ picks on: will it beat-match, and will it
   sound harmonically right on top. Deliberately not a black box — the
   score is a plain weighted sum of a tempo term and a Camelot-wheel key
   term, so the reason a track got chosen is inspectable.
   ============================================================ */

// Camelot wheel positions. Harmonic mixing works on adjacent wheel slots:
// same number (relative major/minor swap), or ±1 with the same letter.
export const CAMELOT={
  'Ab minor':'1A','G# minor':'1A','B major':'1B',
  'Eb minor':'2A','D# minor':'2A','F# major':'2B','Gb major':'2B',
  'Bb minor':'3A','A# minor':'3A','Db major':'3B','C# major':'3B',
  'F minor':'4A','Ab major':'4B','G# major':'4B',
  'C minor':'5A','Eb major':'5B','D# major':'5B',
  'G minor':'6A','Bb major':'6B','A# major':'6B',
  'D minor':'7A','F major':'7B',
  'A minor':'8A','C major':'8B',
  'E minor':'9A','G major':'9B',
  'B minor':'10A','D major':'10B',
  'F# minor':'11A','Gb minor':'11A','A major':'11B',
  'Db minor':'12A','C# minor':'12A','E major':'12B',
};
export function camelotOf(track){
  if(!track || !track.key || !track.mode) return null;
  return CAMELOT[`${track.key} ${track.mode}`] || null;
}

// 1.0 = same key, 0.85 = relative major/minor, 0.8 = one step around the
// wheel, 0.25 = no harmonic relationship (still mixable, just not "in key").
// Unknown key on either side scores neutral rather than penalising — a
// missing analysis shouldn't rank a track below a genuine clash.
export function keyScore(a,b){
  const ca=camelotOf(a), cb=camelotOf(b);
  if(!ca || !cb) return 0.5;
  if(ca===cb) return 1.0;
  const na=parseInt(ca), la=ca.slice(-1);
  const nb=parseInt(cb), lb=cb.slice(-1);
  if(na===nb && la!==lb) return 0.85;
  const step=Math.min((na-nb+12)%12, (nb-na+12)%12);
  if(step===1 && la===lb) return 0.8;
  return 0.25;
}

// Tempo term: 1.0 for an exact match, falling to 0 at the edge of the
// pitch fader's reach. Octave folds count — a 140 BPM track over a 70 BPM
// one is a perfectly good double-time mix, so fold before measuring.
export function bpmScore(fromBpm,toBpm){
  if(!fromBpm || !toBpm) return 0.5;
  let best=Infinity;
  for(const cand of [toBpm, toBpm*2, toBpm/2]){
    const pct=Math.abs(cand-fromBpm)/fromBpm*100;
    if(pct<best) best=pct;
  }
  if(best>PITCH_RANGE) return 0;   // unreachable without pitching past ±16%
  return 1-(best/PITCH_RANGE);
}

/* ============================================================
   ENERGY + PHRASE STRUCTURE
   ------------------------------------------------------------
   Both are read off the peak envelope that already exists for the
   waveform display, so they cost one pass over a few thousand buckets
   and need no extra stored data.
   ============================================================ */

// Perceptually-weighted energy, normalised against the track's own peak.
// Normalising per-track is deliberate: absolute level is mostly a mastering
// decision, whereas "how loud is this section relative to the rest of this
// track" is what actually distinguishes a breakdown from a drop, and that
// comparison does carry across tracks.
export function energyCurve(track){
  if(track._energy) return track._energy;
  const p=track.peaks;
  if(!p || !p.low) return null;
  const n=p.buckets;
  const e=new Float32Array(n);
  let max=0;
  for(let i=0;i<n;i++){
    const v=Math.sqrt(0.5*p.low[i]*p.low[i] + 0.3*p.mid[i]*p.mid[i] + 0.2*p.high[i]*p.high[i]);
    e[i]=v; if(v>max) max=v;
  }
  if(max>0) for(let i=0;i<n;i++) e[i]/=max;
  track._energy=e;
  return e;
}

export function bucketAt(track,t){
  const sr=track.buffer && track.buffer.sampleRate;
  if(!sr) return 0;
  return Math.floor(t*sr/track.peaks.bucketSamples);
}

// Mean energy over [t0,t1] seconds, relative to the track's own peak. Use for
// questions about position WITHIN a track ("is this a breakdown or a drop").
export function sectionEnergy(track,t0,t1){
  const e=energyCurve(track);
  if(!e || !e.length) return 0;
  const a=Math.max(0, Math.min(e.length-1, bucketAt(track,t0)));
  const b=Math.max(a, Math.min(e.length-1, bucketAt(track,t1)));
  let s=0;
  for(let i=a;i<=b;i++) s+=e[i];
  return s/(b-a+1);
}

// Un-normalised RMS over [t0,t1]. Use for comparisons BETWEEN tracks: the
// normalised curve above deliberately divides out each track's own peak, so a
// uniformly quiet track and a loud one look identical through it — which is
// precisely the difference that matters when judging whether a mix drops off a
// cliff. Mastering does vary, but a track that measures 12dB down really is
// quieter, and that beats being blind to level entirely.
export function rawSectionEnergy(track,t0,t1){
  const p=track.peaks;
  if(!p || !p.low) return 0;
  const n=p.buckets;
  const a=Math.max(0, Math.min(n-1, bucketAt(track,t0)));
  const b=Math.max(a, Math.min(n-1, bucketAt(track,t1)));
  let s=0;
  for(let i=a;i<=b;i++){
    s += 0.5*p.low[i]*p.low[i] + 0.3*p.mid[i]*p.mid[i] + 0.2*p.high[i]*p.high[i];
  }
  return Math.sqrt(s/(b-a+1));
}

// Where the phrase grid sits. Beat detection gives a beat phase, not a
// downbeat, so counting 16s from beatOffset would anchor the grid to an
// arbitrary beat. In dance music the largest jump in energy — the drop —
// lands on a phrase boundary essentially by construction, so it makes a far
// better anchor. Falls back to beatOffset when nothing stands out.
//
// This aligns the two decks' 16-beat cycles to each other, which is what
// stops a blend sounding like a collision. It is not true downbeat
// detection: if the anchor is off, both decks are off together and
// consistently, which is the property that matters here.
export const PHRASE_BEATS=16;
export function phraseAnchor(track){
  if(track._phraseAnchor!==undefined) return track._phraseAnchor;
  const e=energyCurve(track);
  const bl=track.bpm ? 60/track.bpm : 0.5;
  const off=track.analysis ? track.analysis.beatOffset : 0;
  let anchor=off;
  if(e && e.length>8){
    // Smooth over roughly a beat so a single transient can't win.
    const per=Math.max(1, Math.round(bl*(track.buffer.sampleRate/track.peaks.bucketSamples)));
    let bestJump=0, bestIdx=-1;
    for(let i=per;i+per<e.length;i++){
      let before=0, after=0;
      for(let k=0;k<per;k++){ before+=e[i-per+k]; after+=e[i+k]; }
      const jump=(after-before)/per;
      if(jump>bestJump){ bestJump=jump; bestIdx=i; }
    }
    if(bestIdx>0 && bestJump>0.12){
      const t=bestIdx*track.peaks.bucketSamples/track.buffer.sampleRate;
      // Snap the anchor onto the beat grid it has to live on.
      anchor=off+Math.round((t-off)/bl)*bl;
    }
  }
  track._phraseAnchor=anchor;
  return anchor;
}

// Next/previous phrase boundary at or after / before `t`, on the track's grid.
export function nextPhrase(track,t){
  const bl=track.bpm ? 60/track.bpm : 0.5;
  const P=PHRASE_BEATS*bl, a=phraseAnchor(track);
  return a+Math.ceil((t-a)/P - 1e-9)*P;
}
export function snapToPhrase(track,t){
  const bl=track.bpm ? 60/track.bpm : 0.5;
  const P=PHRASE_BEATS*bl, a=phraseAnchor(track);
  const s=a+Math.round((t-a)/P)*P;
  return s<0 ? a : s;
}

// How well a candidate's opening follows the outgoing track's closing. A
// slight lift is the ideal — DJs raise energy across a transition or hold it
// level; a sudden crash or a jarring jump both read as a mistake.
export function energyScore(current,cand){
  if(!current || !current.peaks || !cand.peaks) return 0.5;
  const WIN=30;
  const out=rawSectionEnergy(current, Math.max(0,current.duration-WIN), current.duration);
  const start=firstBeatOffset(cand);
  const inn=rawSectionEnergy(cand, start, start+WIN);
  if(out<=0 || inn<=0) return 0.5;
  const dB=20*Math.log10(inn/out);
  // Measured in dB rather than raw amplitude so the scale matches how the
  // step is actually heard. A slight lift is ideal; falling away is penalised
  // harder than climbing, because a mix losing energy reads as a mistake
  // while a mix gaining it reads as intent.
  const IDEAL=1.5;
  const d=dB-IDEAL;
  return Math.max(0, 1-Math.abs(d)/(d>=0?9:6));
}

// Weighted toward tempo: an out-of-range tempo can't be mixed at all,
// whereas a key clash or an energy step is merely less pleasing.
export function trackScore(current,cand){
  return 0.45*bpmScore(current.bpm,cand.bpm)
       + 0.30*keyScore(current,cand)
       + 0.25*energyScore(current,cand);
}

// Where auto-play should drop the needle. Starting every track at 0:00 means
// a long silent lead-in or an ambient intro eats the whole blend — the mix
// fades into nothing. Find the first point the waveform rises above a
// fraction of its own peak, then snap BACK to the preceding beat so the
// downbeat that follows lands on the grid rather than being clipped.
// Reads the peak envelope that's already computed for the waveform display,
// so this costs one pass over a few thousand buckets, not the samples.
export function firstBeatOffset(track){
  const pk=track.peaks && track.peaks.peak;
  const sr=track.buffer && track.buffer.sampleRate;
  if(!pk || !pk.length || !sr || !track.bpm) return 0;
  let max=0;
  for(let i=0;i<pk.length;i++) if(pk[i]>max) max=pk[i];
  if(max<=0) return 0;
  const th=max*0.15;
  let idx=-1;
  for(let i=0;i<pk.length;i++){ if(pk[i]>=th){ idx=i; break; } }
  if(idx<=0) return 0;                       // already loud from the top
  const t=idx*track.peaks.bucketSamples/sr;
  // Land on a phrase boundary rather than merely a beat. Coming in a beat or
  // two into a phrase is what makes an automatic mix sound a bar out of step
  // even when the tempo is locked perfectly.
  const snapped=snapToPhrase(track,t);
  // Never skip so far in that there's no track left to mix.
  return Math.max(0, Math.min(snapped, Math.max(0, track.duration-30)));
}

// Best next track from `pool`, excluding anything already played this
// session or currently sitting on a deck. Returns null when nothing is
// mixable (e.g. every remaining track is outside pitch range).
//
// Tempo is a hard gate, not just a weighted term: a track SYNC physically
// cannot reach (bpmScore 0 — more than ±16% away even after octave folds)
// is unmixable no matter how well its key fits, and the weighted sum alone
// would still float it to the top on the strength of the key term.
export function pickNextTrack(current, pool, excludeIds){
  let best=null, bestScore=-Infinity;
  for(const t of pool){
    if(excludeIds.has(t.id)) continue;
    if(current && bpmScore(current.bpm,t.bpm)<=0) continue;
    const s=current ? trackScore(current,t) : 0.5;
    if(s>bestScore){ bestScore=s; best=t; }
  }
  return best ? {track:best, score:bestScore} : null;
}

export function trackKey(file){
  const basis=`${file.name}|${file.size}`;
  let h=2166136261;                                  // FNV-1a
  for(let i=0;i<basis.length;i++){ h^=basis.charCodeAt(i); h=Math.imul(h,16777619); }
  return (h>>>0).toString(36)+'-'+file.size.toString(36);
}
