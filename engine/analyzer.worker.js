/* =====================================================================
   PULSE DJ — analysis worker
   ---------------------------------------------------------------------
   Waveform peaks, tempo/beat-grid and key detection, off the main thread.

   These are plain JS loops over every sample of a track — on a long file
   that is hundreds of millions of iterations, and run inline they froze
   the whole UI for the duration of an import (dropping a folder of tracks
   locked the app solid). Nothing here touches the DOM or the AudioContext,
   so it moves to a worker unchanged.

   decodeAudioData stays on the main thread: it needs an AudioContext, and
   being native + async it never blocked anything to begin with. The main
   thread decodes, ships the raw channel data here, and gets back only the
   analysis results.

   The functions below are the originals verbatim — they take an
   AudioBuffer-shaped object, and `bufferView()` supplies exactly that
   shape over the transferred Float32Arrays.
   ===================================================================== */

// Minimal stand-in for the AudioBuffer API surface the analysers use, so
// the functions below need no changes from their main-thread versions.
function bufferView({channels, sampleRate, length, duration}){
  return {
    length, sampleRate, duration,
    numberOfChannels: channels.length,
    getChannelData: (i)=> channels[Math.min(i, channels.length-1)],
  };
}

/* ---------------- waveform peaks + 3-band energy ---------------- */
function analysePeaks(buffer, bucketSamples){
  const n = buffer.length;
  const buckets = Math.ceil(n / bucketSamples);
  const chL = buffer.getChannelData(0);
  const chR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : chL;

  const peak = new Float32Array(buckets);
  const low  = new Float32Array(buckets);
  const mid  = new Float32Array(buckets);
  const high = new Float32Array(buckets);

  // One-pole splits: lp tracks bass, (x-lp) is everything above,
  // a second pole on that separates mids from highs. Cheap but reads well.
  const sr = buffer.sampleRate;
  const aLow  = Math.exp(-2*Math.PI*200/sr);
  const aMid  = Math.exp(-2*Math.PI*2000/sr);
  let lpB=0, lpM=0;

  for(let b=0;b<buckets;b++){
    const s0=b*bucketSamples, s1=Math.min(n,s0+bucketSamples);
    let pk=0, eL=0, eM=0, eH=0;
    for(let i=s0;i<s1;i++){
      const x=(chL[i]+chR[i])*0.5;
      const ax=x<0?-x:x;
      if(ax>pk) pk=ax;
      lpB = x + aLow*(lpB - x);          // < 200 Hz
      const above = x - lpB;
      lpM = above + aMid*(lpM - above);  // 200 Hz – 2 kHz
      const hi = above - lpM;            // > 2 kHz
      eL += lpB*lpB; eM += lpM*lpM; eH += hi*hi;
    }
    const cnt = Math.max(1, s1-s0);
    peak[b]=pk;
    low[b]=Math.sqrt(eL/cnt); mid[b]=Math.sqrt(eM/cnt); high[b]=Math.sqrt(eH/cnt);
  }
  return {peak, low, mid, high, buckets, bucketSamples};
}

/* ---------------- tempo + beat phase ---------------- */

// Onset-energy envelope at ~172 fps, used for both tempo and beat phase.
function onsetEnvelope(buffer){
  const hop = 256;
  const ch = buffer.getChannelData(0);
  const n = buffer.length;
  const frames = Math.floor(n/hop);
  const env = new Float32Array(frames);
  let prev = 0;
  for(let f=0;f<frames;f++){
    let e=0;
    const s0=f*hop;
    for(let i=s0;i<s0+hop;i++){ const x=ch[i]; e+=x*x; }
    e=Math.sqrt(e/hop);
    env[f]=Math.max(0, e-prev);   // half-wave rectified difference = onsets
    prev=e;
  }
  return {env, fps: buffer.sampleRate/hop};
}

// Autocorrelation of the onset envelope over a musical lag range.
function detectTempo(buffer){
  const {env, fps} = onsetEnvelope(buffer);
  const N = env.length;
  if(N < 64) return {bpm:120, beatOffset:0, confidence:0};

  // normalise
  let mean=0; for(let i=0;i<N;i++) mean+=env[i]; mean/=N;
  const e = new Float32Array(N);
  for(let i=0;i<N;i++) e[i]=env[i]-mean;

  const minBpm=70, maxBpm=185;
  const minLag=Math.floor(fps*60/maxBpm), maxLag=Math.ceil(fps*60/minBpm);

  let best=-Infinity, bestLag=minLag;
  const scores=new Float32Array(maxLag+1);
  for(let lag=minLag; lag<=maxLag; lag++){
    let s=0;
    for(let i=0;i+lag<N;i++) s+=e[i]*e[i+lag];
    s/=(N-lag);
    scores[lag]=s;
    if(s>best){best=s;bestLag=lag;}
  }

  // Smooth before peak-picking: the raw curve is jittery enough that a rising
  // shoulder can outrank the peak it leads to (this reported 90 BPM as 98.4).
  const sm=new Float32Array(maxLag+1);
  for(let lag=minLag; lag<=maxLag; lag++){
    const a=scores[lag-1]!==undefined?scores[lag-1]:scores[lag];
    const b2=scores[lag+1]!==undefined?scores[lag+1]:scores[lag];
    sm[lag]=(a+2*scores[lag]+b2)/4;
  }

  // A periodic signal correlates just as well at 2T, 3T… as at T, so the global
  // peak is often a multiple of the real beat. Walk up from the shortest lag and
  // take the first genuine local maximum that clears FUND_TH — the fundamental.
  // Requiring a local max (not just a threshold crossing) is what rejects shoulders.
  //
  // FUND_TH is tuned against a synthetic 90–174 BPM suite: a beat that alternates
  // every other bar can score as low as ~0.6 of the two-beat peak, while genuine
  // half-beat subdivisions (busy hats) stay well under. Tracks whose true beat
  // falls below this — very alternation-heavy drum & bass — land an octave low
  // and are corrected with the deck's ×2 button. No purely autocorrelation-based
  // detector resolves that case; real DJ software ships the same manual override.
  const FUND_TH = 0.60;
  let fundLag = bestLag;
  for(let lag=minLag+1; lag<maxLag; lag++){
    if(sm[lag] >= best*FUND_TH && sm[lag] >= sm[lag-1] && sm[lag] >= sm[lag+1]){
      fundLag = lag; break;
    }
  }

  // Integer lags are ~1.6 BPM apart up here, far too coarse to beatmatch with.
  // Fit a parabola through the peak and its neighbours for a sub-frame lag.
  let refined = fundLag;
  if(fundLag>minLag && fundLag<maxLag){
    const y0=scores[fundLag-1], y1=scores[fundLag], y2=scores[fundLag+1];
    const denom = y0 - 2*y1 + y2;
    if(denom !== 0){
      const shift = 0.5*(y0-y2)/denom;
      if(Math.abs(shift) <= 1) refined = fundLag + shift;
    }
  }

  let bpm = 60*fps/refined;
  while(bpm > maxBpm) bpm/=2;
  while(bpm < minBpm) bpm*=2;

  // Beat phase: slide a comb of beat positions and take the best-scoring offset.
  const lag = 60*fps/bpm;
  let bestPhase=0, bestPhaseScore=-Infinity;
  const steps=Math.round(lag);
  for(let p=0;p<steps;p++){
    let s=0, c=0;
    for(let t=p; t<N; t+=lag){ s+=env[Math.round(t)]||0; c++; }
    if(c) s/=c;
    if(s>bestPhaseScore){bestPhaseScore=s;bestPhase=p;}
  }

  return {bpm:Math.round(bpm*10)/10, beatOffset:bestPhase/fps};
}

/* ---------------- key (Krumhansl-Schmuckler) ---------------- */
function detectKey(buffer){
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);

  // Krumhansl-Schmuckler major and minor key profiles (normalized energy weights).
  // These correlate the chromatic pitch distribution against known major/minor scales.
  const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // Extract a chroma vector: estimate energy in 12 pitch classes via bandpass filtering.
  // For speed, use a simplified approach: sample the signal at key frequencies and measure energy.
  const chroma = new Float32Array(12);
  const freqPerSemitone = 2 ** (1/12);
  const baseFreq = 130.81;  // C3

  // Very simple chroma: divide signal into octaves and estimate pitch energy.
  for (let octave = 0; octave < 3; octave++) {
    for (let semitone = 0; semitone < 12; semitone++) {
      const f = baseFreq * Math.pow(freqPerSemitone, semitone + octave * 12);
      if (f > sr / 2) continue;
      // Measure energy in a band around this pitch via autocorrelation at that lag.
      const lag = Math.round(sr / f);
      if (lag < 2 || lag > ch.length / 4) continue;
      let corr = 0, c1 = 0, c2 = 0;
      for (let i = lag; i < Math.min(lag + sr * 0.1, ch.length); i++) {
        const a = ch[i], b = ch[i - lag];
        corr += a * b; c1 += a * a; c2 += b * b;
      }
      const norm = Math.sqrt(c1 * c2);
      if (norm > 0) chroma[semitone] += corr / norm;
    }
  }

  // Normalize chroma vector.
  const chromaSum = Math.max(1e-9, [...chroma].reduce((a,b)=>a+b, 0));
  for (let i = 0; i < 12; i++) chroma[i] /= chromaSum;

  // Correlate against major and minor profiles for each transposition.
  let bestKey = 0, bestMode = 0, bestCorr = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    // Rotate chroma to align with this tonic.
    const rotated = new Float32Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + tonic) % 12];

    // Correlate with major profile.
    let majCorr = 0;
    for (let i = 0; i < 12; i++) majCorr += rotated[i] * majorProfile[i];
    if (majCorr > bestCorr) { bestCorr = majCorr; bestKey = tonic; bestMode = 0; }

    // Correlate with minor profile.
    let minCorr = 0;
    for (let i = 0; i < 12; i++) minCorr += rotated[i] * minorProfile[i];
    if (minCorr > bestCorr) { bestCorr = minCorr; bestKey = tonic; bestMode = 1; }
  }

  return {key: noteNames[bestKey], mode: bestMode ? 'minor' : 'major', confidence: Math.round(bestCorr*100)/100};
}

/* ---------------- request plumbing ---------------- */
self.onmessage = (e)=>{
  const {reqId, channels, sampleRate, length, duration, bucketSamples} = e.data;
  try{
    const buf = bufferView({channels, sampleRate, length, duration});
    const peaks   = analysePeaks(buf, bucketSamples);
    const tempo   = detectTempo(buf);
    const keyInfo = detectKey(buf);
    // Hand the peak arrays back by transfer rather than copy — they are the
    // only large payload in the reply.
    self.postMessage({reqId, ok:true, peaks, tempo, keyInfo},
      [peaks.peak.buffer, peaks.low.buffer, peaks.mid.buffer, peaks.high.buffer]);
  }catch(err){
    self.postMessage({reqId, ok:false, error:String(err && err.message || err)});
  }
};
