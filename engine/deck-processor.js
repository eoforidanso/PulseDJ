/* =====================================================================
   PULSE DJ — deck audio worklet
   ---------------------------------------------------------------------
   One instance per deck. It owns the authoritative playhead and renders
   every sample itself, which is what makes the rest of the engine work:

     • tempo and pitch are independent (WSOLA time-stretch + resampler)
     • the playhead is a float sample index, never a re-created node,
       so seeking/looping costs nothing and never restarts the graph
     • events carry an absolute sample time and fire mid-block, so cues
       and loops land sample-accurately instead of "next event loop tick"

   Audio-thread rules followed here: no allocation in process(), no
   postMessage per block, all buffers pre-sized in the constructor.
   ===================================================================== */

const TWO_PI = Math.PI * 2;

function hann(n){
  const w = new Float32Array(n);
  for(let i=0;i<n;i++) w[i] = 0.5 - 0.5*Math.cos(TWO_PI*i/n);
  return w;
}

// 4-point Catmull-Rom. Linear interpolation on a resampled deck is audibly
// gritty on hats and cymbals; cubic costs a few flops and removes it.
function cubic(y0,y1,y2,y3,t){
  const a = -0.5*y0 + 1.5*y1 - 1.5*y2 + 0.5*y3;
  const b =       y0 - 2.5*y1 + 2.0*y2 - 0.5*y3;
  const c = -0.5*y0            + 0.5*y2;
  return ((a*t + b)*t + c)*t + y1;
}

class DeckProcessor extends AudioWorkletProcessor {

  constructor(){
    super();

    // ---- source ----
    this.src = null;          // Float32Array[] per channel
    this.numCh = 0;
    this.len = 0;

    // ---- transport ----
    this.playing   = false;
    this.readPos   = 0;       // varispeed playhead, in source samples
    this.speed     = 1;       // tempo ratio  (1 = original tempo)
    this.pitch     = 1;       // pitch ratio  (1 = original key)
    this.keylock   = true;
    this.gain      = 1;
    this.loop      = null;    // {start,end} in samples
    this.ended     = false;

    // ---- slip mode ----
    // A second, silent position that keeps advancing at the deck's normal
    // rate regardless of what seeks/loops/hotcues do to the audible one.
    // slipOff snaps the audible position back onto it — "the track never
    // stopped, you just weren't listening to it for a second." Loop roll
    // is built on the same mechanism: a temporary loop plus a slip window.
    this.slipEnabled = false;
    this.shadowPos   = 0;

    // ---- WSOLA ----
    // N/2 hop with a Hann window is exactly COLA, so the overlap-add sums
    // to unity without any normalisation pass.
    this.N    = 2048;
    this.Hs   = 1024;
    this.R    = 256;          // similarity search radius, samples
    this.CORR = 256;          // correlation window length
    this.win  = hann(this.N);

    this.anaPos    = 0;       // WSOLA analysis position, in source samples
    this.prevStart = -1;      // start of the grain we used last time
    this.olaWrite  = 0;       // absolute write cursor (grain-aligned)
    this.ringR     = 0;       // absolute fractional read cursor

    this.ringSize = 1 << 15;
    this.ringMask = this.ringSize - 1;
    this.ring = [new Float32Array(this.ringSize), new Float32Array(this.ringSize)];

    // ---- events ----
    this.events = [];         // sorted ascending by .at (absolute sample time)

    // ---- declick ----
    // Any discontinuity (seek, loop wrap, cue jump) ramps back up over a
    // couple of ms instead of clicking.
    this.fadeLen = 96;
    this.fade    = this.fadeLen;

    this.reportEvery = 8;     // blocks between playhead reports (~23 ms)
    this.blockCount  = 0;

    // Level metering computed directly off the rendered block. This is what
    // "real-time waveform analysis" means for playback (as opposed to the
    // one-time import-time analysis in analysis.js): a channel meter tied to
    // the deck's actual current samples, sample-accurate, immune to the
    // AnalyserNode-returns-silence issue headless/offline contexts can hit.
    this.levelPeak = 0;
    this.levelSum  = 0;
    this.levelN    = 0;

    this.port.onmessage = (e)=>this.onMessage(e.data);
  }

  // -------------------------------------------------------------------
  onMessage(m){
    switch(m.type){
      case 'load':
        this.src = m.channels;
        this.numCh = m.channels.length;
        this.len = m.channels[0].length;
        this.reset(0);
        this.ended = false;
        // postMessage delivery to the audio thread is not synchronous with
        // the caller — the main thread must await this ack (not just resolve
        // after posting) before it can trust that speed/play/seek messages
        // sent afterward will land on a processor that already has data.
        this.port.postMessage({type:'ack', op:'load', seq:m.seq});
        break;

      case 'params':
        if(m.speed   !== undefined) this.speed   = m.speed;
        if(m.pitch   !== undefined) this.pitch   = m.pitch;
        if(m.keylock !== undefined && m.keylock !== this.keylock){
          this.keylock = m.keylock;
          this.resyncFromPlayhead();   // keep position across the mode switch
        }
        if(m.gain !== undefined) this.gain = m.gain;
        break;

      case 'seek':
        this.reset(m.pos * sampleRate);
        break;

      case 'loop':
        this.loop = m.loop
          ? {start: m.loop.start*sampleRate, end: m.loop.end*sampleRate}
          : null;
        break;

      // Scheduled by the main thread with a lookahead; `at` is an absolute
      // sample index on the same clock as currentFrame.
      case 'schedule':
        this.events.push({at: m.at, action: m.action});
        this.events.sort((a,b)=>a.at-b.at);
        break;

      case 'clearEvents':
        this.events.length = 0;
        break;
    }
  }

  applyEvent(ev){
    const a = ev.action;
    switch(a.op){
      case 'seek':    this.reset(a.pos*sampleRate); break;
      case 'play':    if(!this.playing){ this.fade=0; this.playing=true; } break;
      case 'pause':   this.playing=false; break;
      case 'loopOn':  this.loop={start:a.start*sampleRate, end:a.end*sampleRate}; break;
      case 'loopOff': this.loop=null; break;
      // Atomic seek+play: two decks scheduled with the same `at` frame using
      // this op start reading their respective sources on the exact same
      // sample, which is the entire mechanism phase-locked sync relies on.
      // A separate 'seek' then 'play' at equal timestamps would depend on
      // queue ordering instead of being a single indivisible operation.
      case 'seekPlay':
        this.reset(a.pos*sampleRate);
        this.fade = 0;
        this.playing = true;
        break;
      // Start the shadow clock from wherever the audible position is right
      // now — from this instant on it advances untouched by anything the
      // audible position does, and is what slipOff snaps back onto.
      case 'slipOn':
        this.shadowPos = this.playhead();
        this.slipEnabled = true;
        break;
      case 'slipOff':
        this.slipEnabled = false;
        this.reset(this.shadowPos);
        this.fade = 0;
        this.playing = true;
        break;
    }
    this.port.postMessage({type:'event', action:a, at:ev.at});
  }

  // Runs once per process() call regardless of render path — the shadow
  // position never sees loops, seeks, or hotcue jumps, only real elapsed
  // time at the deck's current tempo.
  advanceShadow(nSamples){
    if(!this.slipEnabled || !this.playing) return;
    // shadowPos is in source SAMPLES (captured from playhead()), and the
    // audible readPos advances by `speed` source-samples per output sample,
    // so the shadow must advance nSamples*speed — no /sampleRate. (That
    // stray division froze the shadow ~10,000x too slow, so slipOff snapped
    // back to roughly wherever slip was engaged instead of real position.)
    this.shadowPos = Math.min(this.len, this.shadowPos + nSamples*this.speed);
  }

  // -------------------------------------------------------------------
  // Position bookkeeping. In keylock mode the ring holds already-stretched
  // audio, so the true playhead lags anaPos by whatever is still queued.
  playhead(){
    if(!this.keylock) return this.readPos;
    const stretch  = this.speed / this.pitch;
    const backlog  = this.olaWrite - this.ringR;
    return this.anaPos - backlog*stretch;
  }

  reset(sample){
    const p = Math.max(0, Math.min(this.len, sample||0));
    this.readPos   = p;
    this.anaPos    = p;
    this.prevStart = -1;
    this.olaWrite  = 0;
    this.ringR     = 0;
    this.ring[0].fill(0);
    this.ring[1].fill(0);
    this.fade      = 0;
    this.ended     = false;
  }

  // Switching key-lock on/off must not jump the playhead.
  resyncFromPlayhead(){
    this.reset(this.playhead());
  }

  // -------------------------------------------------------------------
  // WSOLA: find the grain near `ideal` whose opening best matches the
  // natural continuation of the grain we used last time. This is what
  // keeps successive grains phase-coherent instead of comb-filtered.
  bestMatch(ideal){
    const L = this.CORR, R = this.R, x = this.src[0];
    const target = this.prevStart + this.Hs;
    if(this.prevStart < 0 || target < 0 || target + L >= this.len) return ideal;

    let bestK = ideal, bestScore = -Infinity;

    // Coarse pass on a stride of 2, then refine — same answer as an
    // exhaustive scan in practice, at half the cost.
    for(let pass=0; pass<2; pass++){
      const step = pass === 0 ? 2 : 1;
      const lo   = pass === 0 ? ideal-R : bestK-2;
      const hi   = pass === 0 ? ideal+R : bestK+2;
      for(let k=lo; k<=hi; k+=step){
        if(k < 0 || k + L >= this.len) continue;
        let num = 0, den = 1e-9;
        for(let i=0;i<L;i++){
          const a = x[k+i], b = x[target+i];
          num += a*b; den += a*a;
        }
        const score = num / Math.sqrt(den);
        if(score > bestScore){ bestScore = score; bestK = k; }
      }
    }
    return bestK;
  }

  // Emit exactly Hs samples of stretched audio into the ring.
  produce(){
    const {N,Hs,win} = this;
    const stretch = this.speed / this.pitch;

    // Loop wrap happens on the analysis pointer, so the stretcher's
    // similarity search smooths the seam for us.
    if(this.loop){
      const {start,end} = this.loop;
      if(end > start && this.anaPos >= end){
        this.anaPos = start + ((this.anaPos - start) % (end - start));
        this.prevStart = -1;
      }
    }

    let start = Math.round(this.anaPos);
    if(start < 0) start = 0;
    if(start + N >= this.len){
      // past the end: emit silence so the ring keeps draining cleanly
      const base = this.olaWrite;
      for(let ch=0; ch<2; ch++){
        const r = this.ring[ch];
        for(let i=N-Hs; i<N; i++) r[(base+i) & this.ringMask] = 0;
      }
      this.olaWrite += Hs;
      this.ended = true;
      return;
    }

    start = this.bestMatch(start);

    const base = this.olaWrite;
    for(let ch=0; ch<2; ch++){
      const s = this.src[Math.min(ch, this.numCh-1)];
      const r = this.ring[ch];
      // territory no previous grain has touched yet
      for(let i=N-Hs; i<N; i++) r[(base+i) & this.ringMask] = 0;
      for(let i=0; i<N; i++)    r[(base+i) & this.ringMask] += s[start+i]*win[i];
    }

    this.olaWrite += Hs;
    this.prevStart = start;
    this.anaPos   += Hs * stretch;
  }

  // -------------------------------------------------------------------
  render(out, from, to){
    const nch = out.length;

    if(!this.src || !this.playing){
      for(let ch=0; ch<nch; ch++) out[ch].fill(0, from, to);
      return;
    }

    if(this.keylock) this.renderStretched(out, from, to, nch);
    else             this.renderVarispeed(out, from, to, nch);
  }

  renderVarispeed(out, from, to, nch){
    const step = this.speed;
    for(let i=from; i<to; i++){
      let p = this.readPos;

      if(this.loop){
        const {start,end} = this.loop;
        if(end > start && p >= end){
          p = this.readPos = start + ((p - start) % (end - start));
          this.fade = 0;
        }
      }
      if(p >= this.len-2){
        for(let ch=0; ch<nch; ch++) out[ch][i]=0;
        this.ended = true;
        continue;
      }

      const i1 = Math.floor(p), t = p - i1;
      const i0 = i1>0 ? i1-1 : 0, i2 = i1+1, i3 = Math.min(i1+2, this.len-1);
      let g = this.gain;
      if(this.fade < this.fadeLen) g *= this.fade++/this.fadeLen;

      for(let ch=0; ch<nch; ch++){
        const s = this.src[Math.min(ch, this.numCh-1)];
        out[ch][i] = cubic(s[i0], s[i1], s[i2], s[i3], t) * g;
      }
      this.readPos = p + step;
    }
  }

  renderStretched(out, from, to, nch){
    const step = this.pitch;
    for(let i=from; i<to; i++){
      // keep at least a grain of slack so cubic never reads past the write head
      while(this.olaWrite - this.ringR < 4) this.produce();

      const p  = this.ringR;
      const i1 = Math.floor(p), t = p - i1;
      let g = this.gain;
      if(this.fade < this.fadeLen) g *= this.fade++/this.fadeLen;

      for(let ch=0; ch<nch; ch++){
        const r = this.ring[ch];
        out[ch][i] = cubic(
          r[(i1-1) & this.ringMask], r[i1 & this.ringMask],
          r[(i1+1) & this.ringMask], r[(i1+2) & this.ringMask], t) * g;
      }
      this.ringR = p + step;
    }
    // varispeed playhead follows along so a mode switch is seamless
    this.readPos = this.playhead();
  }

  // -------------------------------------------------------------------
  process(_inputs, outputs){
    const out = outputs[0];
    const n = out[0].length;

    // Split the block at every scheduled event so cues and loops land on
    // the exact sample they were scheduled for, not the block boundary.
    let off = 0;
    let guard = 0;
    while(off < n && guard++ < 64){
      let next = n;
      if(this.events.length){
        const rel = this.events[0].at - (currentFrame + off);
        if(rel <= 0){ this.applyEvent(this.events.shift()); continue; }
        if(rel < n - off) next = off + rel;
      }
      this.render(out, off, next);
      off = next;
    }
    if(off < n) this.render(out, off, n);
    this.advanceShadow(n);

    const ch0 = out[0];
    for(let i=0; i<n; i++){
      const a = Math.abs(ch0[i]);
      if(a > this.levelPeak) this.levelPeak = a;
      this.levelSum += ch0[i]*ch0[i];
      this.levelN++;
    }

    if(++this.blockCount % this.reportEvery === 0){
      this.port.postMessage({
        type:'pos',
        playhead: this.playhead()/sampleRate,
        frame: currentFrame,
        playing: this.playing,
        ended: this.ended,
        levelPeak: this.levelPeak,
        levelRms: this.levelN ? Math.sqrt(this.levelSum/this.levelN) : 0
      });
      this.levelPeak = 0; this.levelSum = 0; this.levelN = 0;
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
