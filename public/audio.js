const playing = phase => phase === 'question' || phase === 'result';
const clamp = (value, fallback) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : fallback;

// Original, locally synthesized music and cues: no media downloads or API calls.
export function createGameAudio({ win = globalThis.window, doc = globalThis.document } = {}) {
  let preferences = { muted: false, musicEnabled: true, effectsEnabled: true, musicVolume: 18, effectsVolume: 45 };
  try {
    const saved = JSON.parse(win.localStorage.getItem('nolege:sound:v1'));
    if (saved && typeof saved === 'object') preferences = { muted: saved.muted === true, musicEnabled: saved.musicEnabled !== false, effectsEnabled: saved.effectsEnabled !== false, musicVolume: clamp(saved.musicVolume, 18), effectsVolume: clamp(saved.effectsVolume, 45) };
  } catch {}
  let context, master, music, effects, scheduler, nextBar = 0, bar = 0, closed = false;
  let match = { phase: 'lobby', gameId: '', questionId: '', answered: false }, connected = true, seconds = 0;
  let lastVictory = '', ducked = false;
  const tickedSeconds = new Set();
  const voices = new Set(), listeners = new Set();
  const setIntervalFn = win.setInterval.bind(win), clearIntervalFn = win.clearInterval.bind(win);
  const usable = () => !closed && context?.state === 'running' && !doc.hidden && connected && !preferences.muted;
  const state = () => ({ ...preferences, available: !!(win.AudioContext || win.webkitAudioContext), ready: context?.state === 'running', playing: usable() && playing(match.phase) });
  const notify = () => { for (const listener of listeners) listener(state()); };
  function gain(node, value) {
    if (!node || !context) return;
    node.gain.cancelScheduledValues(context.currentTime); node.gain.setTargetAtTime(value, context.currentTime, 0.08);
  }
  function levels() {
    gain(master, preferences.muted ? 0 : 1);
    gain(music, (preferences.musicVolume / 100) ** 2 * (ducked ? 0.22 : 1));
    gain(effects, (preferences.effectsVolume / 100) ** 2);
  }
  function tone(frequency, start, duration, level, group, { type = 'sine', attack = 0.008, release = 0.15, cutoff = 1600 } = {}) {
    const oscillator = context.createOscillator(), envelope = context.createGain(), filter = context.createBiquadFilter();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, start);
    filter.type = 'lowpass'; filter.frequency.setValueAtTime(cutoff, start);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.linearRampToValueAtTime(level, start + attack);
    envelope.gain.setValueAtTime(level, Math.max(start + attack, start + duration - release));
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(filter); filter.connect(envelope); envelope.connect(group === 'music' ? music : effects);
    const voice = { oscillator, envelope, filter, group }; voices.add(voice);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); filter.disconnect(); voices.delete(voice); };
    oscillator.start(start); oscillator.stop(start + duration + 0.02);
  }
  function stopVoices(group) {
    for (const voice of [...voices]) if (!group || voice.group === group) {
      try { voice.oscillator.stop(); } catch {}
      voice.oscillator.disconnect(); voice.envelope.disconnect(); voice.filter.disconnect(); voices.delete(voice);
    }
  }
  function stopMusic() { if (scheduler !== undefined) clearIntervalFn(scheduler); scheduler = undefined; stopVoices('music'); }
  function scheduleMusic() {
    if (!usable() || !playing(match.phase) || !preferences.musicEnabled || !preferences.musicVolume) return;
    const chords = [[146.83, 220, 293.66, 369.99], [164.81, 246.94, 329.63, 392], [130.81, 196, 261.63, 329.63], [174.61, 220, 293.66, 349.23]];
    const barLength = 4 * 60 / 68;
    while (nextBar < context.currentTime + 5) {
      const chord = chords[bar % chords.length];
      chord.forEach((note, index) => tone(note, nextBar + index * 0.035, barLength + 1.4, 0.11, 'music', { type: 'triangle', attack: 1.05, release: 1.45, cutoff: 950 }));
      if (bar % 2 === 0) tone(chord[2] * 2, nextBar + 1.75, 2.25, 0.075, 'music', { attack: 0.04, release: 1.8, cutoff: 2200 });
      nextBar += barLength; bar++;
    }
  }
  function sync() {
    levels();
    if (!usable() || !playing(match.phase) || !preferences.musicEnabled || !preferences.musicVolume) stopMusic();
    else if (scheduler === undefined) { nextBar = context.currentTime + 0.08; bar = 0; scheduleMusic(); scheduler = setIntervalFn(scheduleMusic, 700); }
    if (!usable()) stopVoices('effects');
    notify();
  }
  async function unlock() {
    if (closed || !(win.AudioContext || win.webkitAudioContext)) return false;
    try {
      if (!context) {
        context = new (win.AudioContext || win.webkitAudioContext)();
        master = context.createGain(); music = context.createGain(); effects = context.createGain();
        music.connect(master); effects.connect(master); master.connect(context.destination);
        master.gain.value = 0; music.gain.value = 0; effects.gain.value = 0;
        context.onstatechange = sync;
      }
      if (context.state !== 'running') await context.resume();
      sync(); return context.state === 'running';
    } catch { notify(); return false; }
  }
  const onVisibility = () => {
    if (doc.hidden) { stopMusic(); stopVoices(); if (context?.state === 'running') void context.suspend().catch(() => {}); }
    else if (context) void unlock();
    notify();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    state, unlock,
    subscribe(listener) { listeners.add(listener); listener(state()); return () => listeners.delete(listener); },
    setPreferences(values) {
      preferences = { muted: typeof values.muted === 'boolean' ? values.muted : preferences.muted,
        musicEnabled: typeof values.musicEnabled === 'boolean' ? values.musicEnabled : preferences.musicEnabled,
        effectsEnabled: typeof values.effectsEnabled === 'boolean' ? values.effectsEnabled : preferences.effectsEnabled,
        musicVolume: values.musicVolume == null ? preferences.musicVolume : clamp(values.musicVolume, preferences.musicVolume),
        effectsVolume: values.effectsVolume == null ? preferences.effectsVolume : clamp(values.effectsVolume, preferences.effectsVolume) };
      try { win.localStorage.setItem('nolege:sound:v1', JSON.stringify(preferences)); } catch {}
      if (!preferences.effectsEnabled) stopVoices('effects'); sync();
    },
    setMatch(next) {
      if (next.questionId !== match.questionId || next.gameId !== match.gameId) { tickedSeconds.clear(); seconds = 0; }
      match = { ...match, ...next }; connected = true;
      ducked = match.phase === 'question' && !match.answered && seconds > 0 && seconds <= 5;
      sync();
    },
    tick(left) {
      seconds = left;
      const urgent = match.phase === 'question' && !match.answered && left > 0 && left <= 5;
      if (urgent !== ducked) { ducked = urgent; levels(); }
      const key = `${match.gameId}:${match.questionId}:${left}`;
      if (!urgent || !usable() || !preferences.effectsEnabled || !preferences.effectsVolume || tickedSeconds.has(key)) return false;
      tickedSeconds.add(key);
      tone(left % 2 ? 1040 : 820, context.currentTime + 0.005, 0.065, left <= 2 ? 0.19 : 0.14, 'effects', { type: 'triangle', attack: 0.002, release: 0.05, cutoff: 2000 });
      return true;
    },
    win(gameId) {
      if (lastVictory === gameId || !usable() || !preferences.effectsEnabled || !preferences.effectsVolume) return false;
      lastVictory = gameId;
      [587.33, 739.99, 880, 1174.66, 987.77, 1174.66].forEach((note, index) => tone(note, context.currentTime + 0.03 + index * 0.13, 0.55, index === 5 ? 0.18 : 0.13, 'effects', { attack: 0.007, release: 0.48, cutoff: 2600 }));
      return true;
    },
    pause() { connected = false; sync(); },
    async close() { closed = true; stopMusic(); stopVoices(); doc.removeEventListener('visibilitychange', onVisibility); listeners.clear(); try { await context?.close(); } catch {} }
  };
}
