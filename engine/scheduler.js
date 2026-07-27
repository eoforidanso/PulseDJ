/* =====================================================================
   PULSE DJ — main-thread transport scheduler
   ---------------------------------------------------------------------
   Everything timing-critical (play, pause, seek, loop on/off, and the
   seek+play pair a beat-locked deck start needs) is scheduled against
   the AudioContext's own clock and handed to the worklet as an absolute
   sample frame, never applied by a bare postMessage. postMessage delivery
   to an AudioWorkletProcessor is not synchronous with the audio thread —
   measured latency was near-zero in a live AudioContext but the point of
   scheduling is to not depend on that holding under load, on every
   browser, every time. This is the same mechanism
   `AudioBufferSourceNode.start(when)` is built on.

   Because both decks in a session live on one AudioContext, they share
   exactly one sample clock. Two DeckLinks told to 'seekPlay' at the same
   target frame therefore start on the same sample, and — since nothing
   about their subsequent playback re-reads the *other* deck's state —
   they cannot drift apart afterward as long as their `speed` stays fixed.
   That is what "phase-locked" means here: not a PLL correcting drift,
   but a start condition precise enough that there is nothing to correct.
   ===================================================================== */

export const LOOKAHEAD_SEC = 0.03;   // safety margin for one-shot UI actions

let _seq = 1;

export class DeckLink {
  constructor(ctx, workletUrl){
    this.ctx = ctx;
    this.node = null;
    this._ready = this._init(workletUrl);
    this._posHandlers = [];
    this._eventHandlers = [];
    this.last = {playhead:0, frame:0, playing:false, ended:false, levelPeak:0, levelRms:0};

    // Beat grid, filled in by load(); used by MasterClock to compute the
    // ctxTime of this deck's Nth beat without asking the audio thread.
    this.bpm = 0;
    this.beatOffset = 0;     // seconds, in source-track time
    this.speed = 1;
    this.startCtxTime = null;   // ctx.currentTime the last seekPlay/play took effect
    this.startSourcePos = 0;    // source-track position at that instant
  }

  async _init(workletUrl){
    // AudioWorkletProcessor registration is per-context and idempotent to
    // call twice, but addModule itself must only be awaited once per URL.
    if(!DeckLink._modules) DeckLink._modules = new Map();
    const ctxKey = this.ctx;
    if(!DeckLink._modules.has(ctxKey)) DeckLink._modules.set(ctxKey, new Map());
    const perCtx = DeckLink._modules.get(ctxKey);
    if(!perCtx.has(workletUrl)) perCtx.set(workletUrl, this.ctx.audioWorklet.addModule(workletUrl));
    await perCtx.get(workletUrl);

    this.node = new AudioWorkletNode(this.ctx, 'deck-processor', {
      numberOfInputs: 0,
      outputChannelCount: [2]
    });
    this.node.port.onmessage = (e)=>this._onMessage(e.data);
  }

  async ready(){ await this._ready; return this; }

  _onMessage(m){
    if(m.type === 'pos'){
      m._recvCtxTime = this.ctx.currentTime;
      this.last = m;
      // Re-anchor MasterClock's projection point to this report on every
      // one, not just at scheduled actions — ground truth from the worklet,
      // arriving every ~23ms. This is what keeps projections accurate
      // through state the main thread doesn't model directly (loop wraps,
      // and especially slipOff's snap-back, whose destination only the
      // worklet knows). m.frame is the sample currentFrame WAS when this
      // was measured, which is what m.playhead actually corresponds to —
      // ctx.currentTime by the time the message arrives is already later.
      if(m.playing){
        this.startCtxTime = m.frame / this.ctx.sampleRate;
        this.startSourcePos = m.playhead;
      }
      for(const cb of this._posHandlers) cb(m);
    } else if(m.type === 'event'){
      for(const cb of this._eventHandlers) cb(m);
    } else if(m.type === 'ack' && this._pendingAcks){
      const resolve = this._pendingAcks.get(m.seq);
      if(resolve){ this._pendingAcks.delete(m.seq); resolve(); }
    }
  }

  onPos(cb){ this._posHandlers.push(cb); return ()=>{ const i=this._posHandlers.indexOf(cb); if(i>=0) this._posHandlers.splice(i,1); }; }
  onEvent(cb){ this._eventHandlers.push(cb); return ()=>{ const i=this._eventHandlers.indexOf(cb); if(i>=0) this._eventHandlers.splice(i,1); }; }

  // channels: Float32Array[] (one per source channel). Resolves once the
  // worklet has actually applied it — awaiting this, not just the post,
  // is what makes every action issued afterward land on loaded state.
  async load(channels, {bpm=0, beatOffset=0} = {}){
    await this._ready;
    this.bpm = bpm; this.beatOffset = beatOffset;
    this.startCtxTime = null; this.startSourcePos = 0;
    const seq = _seq++;
    if(!this._pendingAcks) this._pendingAcks = new Map();
    const p = new Promise(resolve=>this._pendingAcks.set(seq, resolve));
    // Transfer ownership of the underlying buffers — this is a zero-copy
    // handoff instead of a structured-clone of potentially tens of MB.
    this.node.port.postMessage({type:'load', channels, seq}, channels.map(c=>c.buffer));
    await p;
  }

  // Continuous, non-critical controls: a few hundred microseconds of
  // postMessage latency on a pitch-fader drag is inaudible, so these stay
  // best-effort instead of going through the scheduler.
  setParams({speed, pitch, keylock, gain} = {}){
    if(speed !== undefined && speed !== this.speed){
      // MasterClock's projections assume speed has been constant since
      // startCtxTime — true only if every rate change re-anchors that pair
      // to "now" first. Without this, drift correction's own nudges would
      // throw off the very math it depends on to measure drift.
      if(this.startCtxTime !== null){
        this.startSourcePos = this.estimatedPosition();   // uses the OLD speed
        this.startCtxTime = this.ctx.currentTime;
      }
      this.speed = speed;
    }
    this.node.port.postMessage({type:'params', speed, pitch, keylock, gain});
  }

  _frameAt(ctxTime){ return Math.round(ctxTime * this.ctx.sampleRate); }

  scheduleAt(ctxTime, action){
    this.node.port.postMessage({type:'schedule', at: this._frameAt(ctxTime), action});
  }

  play(atCtxTime = this.ctx.currentTime + LOOKAHEAD_SEC){
    this.startCtxTime = atCtxTime;
    this.startSourcePos = this.last.playhead;
    this.scheduleAt(atCtxTime, {op:'play'});
    return atCtxTime;
  }

  pause(atCtxTime = this.ctx.currentTime + LOOKAHEAD_SEC){
    this.scheduleAt(atCtxTime, {op:'pause'});
    return atCtxTime;
  }

  seek(pos, atCtxTime = this.ctx.currentTime + LOOKAHEAD_SEC){
    this.startCtxTime = atCtxTime;
    this.startSourcePos = pos;
    this.scheduleAt(atCtxTime, {op:'seek', pos});
    return atCtxTime;
  }

  // The primitive phase-locked sync is built on: reposition and start in
  // one atomic worklet-side action at an exact shared sample.
  seekPlay(pos, atCtxTime = this.ctx.currentTime + LOOKAHEAD_SEC){
    this.startCtxTime = atCtxTime;
    this.startSourcePos = pos;
    this.scheduleAt(atCtxTime, {op:'seekPlay', pos});
    return atCtxTime;
  }

  loopOn(start, end, atCtxTime = this.ctx.currentTime + LOOKAHEAD_SEC){
    this.scheduleAt(atCtxTime, {op:'loopOn', start, end});
    return atCtxTime;
  }

  loopOff(atCtxTime = this.ctx.currentTime + LOOKAHEAD_SEC){
    this.scheduleAt(atCtxTime, {op:'loopOff'});
    return atCtxTime;
  }

  // Slip mode: the audible position can be seeked/looped/hotcue-jumped
  // freely while engaged, but the deck's true position keeps advancing
  // underneath, silently, and slipOff snaps back onto it. Loop roll is
  // this plus a temporary loop — see EngineDeck.loopRollOn in the app.
  slipOn(atCtxTime = this.ctx.currentTime + LOOKAHEAD_SEC){
    this.scheduleAt(atCtxTime, {op:'slipOn'});
    return atCtxTime;
  }
  slipOff(atCtxTime = this.ctx.currentTime + LOOKAHEAD_SEC){
    // The snap-back destination is only known to the worklet (it's been
    // silently tracking shadowPos), so — unlike every other scheduled op —
    // this doesn't move startSourcePos/startCtxTime itself. jumpTo() in
    // EngineDeck re-syncs those from the next 'pos' report instead.
    this.scheduleAt(atCtxTime, {op:'slipOff'});
    return atCtxTime;
  }

  clearEvents(){ this.node.port.postMessage({type:'clearEvents'}); }

  // Current source-track position, projected forward from the last 'pos'
  // report using the same clock the worklet renders against — avoids
  // waiting on the next ~23ms report for UI that wants a smoothly moving
  // number (e.g. the waveform playhead) between reports.
  estimatedPosition(){
    if(!this.last.playing) return this.last.playhead;
    const dt = this.ctx.currentTime - (this.last._recvCtxTime ?? this.ctx.currentTime);
    return this.last.playhead + dt*this.speed;
  }

  beatLen(){ return this.bpm ? 60/this.bpm : 0; }

  quantize(sourceTime){
    const bl = this.beatLen();
    if(!bl) return sourceTime;
    const k = Math.round((sourceTime - this.beatOffset) / bl);
    return Math.max(0, this.beatOffset + k*bl);
  }
}

/* ---------------------------------------------------------------------
   MasterClock — computes when a deck's Nth beat occurs on the shared
   AudioContext clock, from nothing but its tempo grid and the ctxTime/
   sourcePos pair recorded at its last scheduled start. No polling of the
   audio thread, no observation jitter: it's a closed-form projection.
   --------------------------------------------------------------------- */
export class MasterClock {
  // Source-track position `deck` will be at, at wall-clock ctxTime `now`,
  // given where and when it last started and how fast it's reading.
  static projectedSourcePos(deck, now){
    if(deck.startCtxTime === null) return deck.last.playhead;
    return deck.startSourcePos + (now - deck.startCtxTime) * deck.speed;
  }

  // ctxTime of `deck`'s next beat at or after `now` (or `beatsAhead` beats
  // past that one). Returns null if the deck has no detected tempo.
  static nextBeatTime(deck, now, beatsAhead = 0){
    const bl = deck.beatLen();
    if(!bl || deck.startCtxTime === null) return null;
    const pos = MasterClock.projectedSourcePos(deck, now);
    const k = Math.ceil((pos - deck.beatOffset) / bl) + beatsAhead;
    const beatSourceTime = deck.beatOffset + k*bl;
    return deck.startCtxTime + (beatSourceTime - deck.startSourcePos) / deck.speed;
  }

  // Schedule `follower` to start, beat-aligned to its own grid, exactly on
  // `leader`'s next beat boundary (plus lookahead so the message has time
  // to arrive). Returns the ctxTime both actions are locked to.
  static lockToLeader(leader, follower, {beatsAhead = 4, lookahead = LOOKAHEAD_SEC} = {}){
    const now = leader.ctx.currentTime + lookahead;
    // nextBeatTime(leader, now, beatsAhead) always returns a ctxTime >= now:
    // it finds the smallest beat index k with beatOffset+k*beatLen >= the
    // leader's projected position exactly at `now`, so no walk-forward loop
    // is needed to guarantee lookahead margin.
    const target = MasterClock.nextBeatTime(leader, now, beatsAhead) ?? now;
    const followerPos = follower.quantize(MasterClock.projectedSourcePos(follower, target));
    follower.seekPlay(followerPos, target);
    return target;
  }
}
