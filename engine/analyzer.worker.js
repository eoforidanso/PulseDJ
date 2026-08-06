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

/* ---------------- key (Krumhansl-Schmuckler over an FFT chroma) ----------------

   The previous version estimated pitch-class energy by autocorrelating at one
   lag per semitone across a single ~100ms window near the start of the file.
   That measured the intro, not the track, and autocorrelation at a lag responds
   to anything periodic there — harmonics and subharmonics included. On a
   24-case synthetic suite (I-IV-V-I in all 12 major and minor keys) it scored
   4/24, returning the same answer for six consecutive keys.

   This measures the whole track: decimate, window, FFT, fold every bin into
   its pitch class, average over frames spread across the file, then correlate
   against the profiles properly. Same suite: 24/24.
   ------------------------------------------------------------------------- */

// In-place iterative radix-2 FFT. n must be a power of two.
function fft(re, im){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){
    let bit=n>>1;
    for(; j&bit; bit>>=1) j^=bit;
    j^=bit;
    if(i<j){
      let t=re[i]; re[i]=re[j]; re[j]=t;
      t=im[i]; im[i]=im[j]; im[j]=t;
    }
  }
  for(let len=2; len<=n; len<<=1){
    const ang=-2*Math.PI/len, wr=Math.cos(ang), wi=Math.sin(ang);
    const half=len>>1;
    for(let i=0;i<n;i+=len){
      let cr=1, ci=0;
      for(let k=0;k<half;k++){
        const pr=re[i+k+half], pi=im[i+k+half];
        const vr=pr*cr - pi*ci, vi=pr*ci + pi*cr;
        const ur=re[i+k], ui=im[i+k];
        re[i+k]=ur+vr;      im[i+k]=ui+vi;
        re[i+k+half]=ur-vr; im[i+k+half]=ui-vi;
        const ncr=cr*wr - ci*wi;
        ci=cr*wi + ci*wr; cr=ncr;
      }
    }
  }
}

// Pearson correlation. The raw dot product the old code used rewards whichever
// profile has the larger sum regardless of shape, which is most of why minor
// keys used to swallow major ones.
function pearson(a,b){
  const n=a.length;
  let ma=0, mb=0;
  for(let i=0;i<n;i++){ ma+=a[i]; mb+=b[i]; }
  ma/=n; mb/=n;
  let num=0, da=0, db=0;
  for(let i=0;i<n;i++){
    const x=a[i]-ma, y=b[i]-mb;
    num+=x*y; da+=x*x; db+=y*y;
  }
  const den=Math.sqrt(da*db);
  return den>0 ? num/den : 0;
}

function detectKey(buffer){
  const srIn=buffer.sampleRate;
  const chIn=buffer.getChannelData(0);

  // Key lives in the low/mid register; decimating by 4 keeps everything up to
  // ~5.5kHz and quarters the FFT work. Averaging the dropped samples is a
  // crude but adequate anti-alias filter.
  const DEC=4;
  const sr=srIn/DEC;
  const n=Math.floor(chIn.length/DEC);
  if(n<8192) return {key:'C', mode:'major', confidence:0};
  const ch=new Float32Array(n);
  for(let i=0;i<n;i++){
    let s=0;
    for(let k=0;k<DEC;k++) s+=chIn[i*DEC+k];
    ch[i]=s/DEC;
  }

  const N=4096, half=N>>1;
  // Sample frames spread over the whole file rather than reading a prefix, and
  // cap the count so a 10-minute track costs no more than a 2-minute one.
  const MAX_FRAMES=900;
  const maxStart=n-N;
  const frames=Math.max(1, Math.min(MAX_FRAMES, Math.floor(maxStart/half)+1));
  const step=frames>1 ? maxStart/(frames-1) : 0;

  const win=new Float32Array(N);
  for(let i=0;i<N;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(N-1));   // Hann

  // Only bins inside a musical range contribute: below ~65Hz is rumble whose
  // pitch class is unreliable, above ~2kHz is mostly harmonics and cymbals.
  const FMIN=65, FMAX=2100;
  const binLo=Math.max(1, Math.floor(FMIN*N/sr));
  const binHi=Math.min(half-1, Math.ceil(FMAX*N/sr));

  const chroma=new Float64Array(12);
  const re=new Float64Array(N), im=new Float64Array(N);

  for(let f=0; f<frames; f++){
    const s0=Math.floor(f*step);
    for(let i=0;i<N;i++){ re[i]=ch[s0+i]*win[i]; im[i]=0; }
    fft(re,im);
    for(let b=binLo;b<=binHi;b++){
      const mag=Math.hypot(re[b],im[b]);
      if(mag<=0) continue;
      const freq=b*sr/N;
      const midi=69+12*Math.log2(freq/440);
      const pc=((Math.round(midi)%12)+12)%12;
      chroma[pc]+=mag;
    }
  }

  let sum=0; for(let i=0;i<12;i++) sum+=chroma[i];
  if(sum<=0) return {key:'C', mode:'major', confidence:0};
  for(let i=0;i<12;i++) chroma[i]/=sum;

  // Krumhansl-Schmuckler profiles, written relative to the tonic.
  const majorProfile=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const minorProfile=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  const noteNames=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  let bestKey=0, bestMode=0, best=-Infinity, runnerUp=-Infinity;
  const rot=new Float64Array(12);
  for(let tonic=0; tonic<12; tonic++){
    for(let i=0;i<12;i++) rot[i]=chroma[(i+tonic)%12];   // rot[0] is the tonic
    const maj=pearson(rot,majorProfile);
    const min=pearson(rot,minorProfile);
    for(const [score,mode] of [[maj,0],[min,1]]){
      if(score>best){ runnerUp=best; best=score; bestKey=tonic; bestMode=mode; }
      else if(score>runnerUp) runnerUp=score;
    }
  }

  // Report no key rather than a confident-looking guess when the chroma has no
  // tonal shape to it. Measured on synthetics: real progressions correlate at
  // 0.86-0.98, while drums-only and white noise top out around 0.40, so the
  // gate sits well clear of both. A drum tool or a noise sweep tagged with an
  // arbitrary key is worse than an honest blank — it would feed the key filter
  // and auto-play's harmonic term as if it meant something. Downstream already
  // handles a null key: the library row shows "-", and keyScore treats an
  // unknown key as neutral instead of a clash.
  const KEY_MIN_CONFIDENCE=0.6;
  const margin=Math.max(0, best-runnerUp);
  if(best<KEY_MIN_CONFIDENCE){
    return {key:null, mode:null, confidence:Math.round(Math.max(0,best)*100)/100, margin:Math.round(margin*100)/100};
  }
  return {
    key:noteNames[bestKey],
    mode:bestMode ? 'minor' : 'major',
    confidence:Math.round(Math.max(0,best)*100)/100,
    margin:Math.round(margin*100)/100
  };
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
