// Web Audio mixer for dedicated audio tracks. Each audio clip is played by an
// AudioBufferSourceNode -> GainNode (volume/mute) -> destination, scheduled
// against the playhead. Per-clip speed = playbackRate, pitch = detune (cents).
// Everything is wrapped so a missing/undecodable source just stays silent.
import { state, getMedia, clipEnd } from '../state.js';
import { scheduleClipAudio } from './mixer.js';
import { proresAudio } from '../media/prores.js';

/** PCM from a ProRes original (which decodeAudioData can't open) as an AudioBuffer. */
export async function proresBuffer(ctx, media) {
  const pcm = await proresAudio(media);
  if (!pcm || !pcm.data.length || !pcm.data[0].length) return null;
  const buf = ctx.createBuffer(pcm.data.length, pcm.data[0].length, pcm.rate);
  pcm.data.forEach((ch, i) => buf.copyToChannel(ch, i));
  return buf;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();   // mediaId -> AudioBuffer | 'pending' | 'fail'
    this.active = [];           // {clip, src, gain}
    this.startedAt = 0;         // ctx time when playhead 0 anchored
  }

  _ensureCtx() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ctx.createGain();
        this.master.gain.value = state.masterVolume ?? 1;
        this.master.connect(this.ctx.destination);
      } catch { this.ctx = null; }
    }
    return this.ctx;
  }
  setMaster(v) { state.masterVolume = v; if (this.master) this.master.gain.value = v; }

  async _buffer(media) {
    if (!media || !media.file) return null;
    const cached = this.buffers.get(media.id);
    if (cached && cached !== 'pending') return cached === 'fail' ? null : cached;
    if (cached === 'pending') return null;
    this.buffers.set(media.id, 'pending');
    try {
      const ctx = this._ensureCtx(); if (!ctx) throw 0;
      const buf = media.codec === 'prores' ? await proresBuffer(ctx, media) : await ctx.decodeAudioData(await media.file.arrayBuffer());
      if (!buf) throw 0;
      this.buffers.set(media.id, buf);
      return buf;
    } catch { this.buffers.set(media.id, 'fail'); return null; }
  }

  // a decoded buffer now, or null while it loads — scheduling never waits on a
  // decode (the playhead would move on and the sound start out of sync); the
  // mix is rescheduled when the buffer lands
  _bufferNow(media) {
    const c = media && this.buffers.get(media.id);
    if (c && c !== 'pending') return c === 'fail' ? null : c;
    if (!c && media) this._buffer(media).then((b) => { if (b && state.playing) this.refresh(); });
    return null;
  }

  _stopAll() { for (const a of this.active) { try { a.src.stop(); } catch {} } this.active = []; }

  async _schedule(playhead) {
    const ctx = this._ensureCtx(); if (!ctx) return;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
    this.startedAt = ctx.currentTime - playhead;
    // audio tracks, plus the sound of ProRes clips (no <video> element plays it)
    const lists = [
      ...state.tracks.audio.map((t) => ({ clips: t.clips, fade: true })),
      ...state.tracks.video.map((t) => ({ clips: t.clips.filter((c) => getMedia(c.mediaId)?.codec === 'prores'), fade: false })),
    ];
    for (const track of lists) {
      for (const c of track.clips) {
        if (clipEnd(c) <= playhead) continue;
        const buf = this._bufferNow(getMedia(c.mediaId));
        if (!buf) continue;
        const node = scheduleClipAudio(ctx, this.master || ctx.destination, buf, c, playhead, track.fade);
        if (node) this.active.push(node);
      }
    }
  }

  play(playhead) { this._stopAll(); this._schedule(playhead); }
  pause() { this._stopAll(); }
  seek(playhead, playing) { this._stopAll(); if (playing) this._schedule(playhead); }
  tick() { /* sources are scheduled ahead; nothing per-frame */ }

  // live volume/mute change without a full reschedule
  setVolume(clip) { const a = this.active.find((x) => x.clip === clip); if (a) a.gain.gain.value = clip.mute ? 0 : (clip.volume ?? 1); }
  // pitch/speed change needs a reschedule
  refresh() { if (state.playing) this.seek(state.playhead, true); }
}
