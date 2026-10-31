export function winners(players = []) {
  const highest = Math.max(0, ...players.map(player => Number(player.score) || 0));
  return highest > 0 ? players.filter(player => Number(player.score) === highest) : [];
}
export function isWinner(room) { return room?.phase === 'finished' && !room.you?.spectator && winners(room.players).some(player => player.id === room.you?.id); }

export function createCelebration({ win = globalThis.window, doc = globalThis.document } = {}) {
  let canvas, frame, activeGame = '', rememberedGame = '';
  function stop() { if (frame) win.cancelAnimationFrame(frame); frame = null; canvas?.remove(); canvas = null; }
  function burst() {
    if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    canvas = doc.createElement('canvas'); canvas.className = 'confetti-canvas'; canvas.setAttribute('aria-hidden', 'true');
    const width = win.innerWidth, height = win.innerHeight, scale = Math.min(win.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale); doc.body.append(canvas);
    let context; try { context = canvas.getContext('2d'); } catch {}
    if (!context) { stop(); return; }
    context.scale(scale, scale);
    const style = win.getComputedStyle(doc.documentElement);
    const colors = ['--confetti-one', '--confetti-two', '--confetti-three'].map(name => style.getPropertyValue(name).trim()).filter(Boolean);
    if (!colors.length) colors.push('#b4e9c4', '#efc67c', '#b5d7ee');
    const pieces = Array.from({ length: width < 600 ? 76 : 125 }, (_, index) => ({ x: Math.random() * width, y: -30 - Math.random() * height * 0.4, vx: (Math.random() - 0.5) * 95, vy: 90 + Math.random() * 160, angle: Math.random() * 6.3, spin: (Math.random() - 0.5) * 8, size: 5 + Math.random() * 6, color: colors[index % colors.length] }));
    let started, previous;
    function draw(time) {
      if (!canvas) return;
      started ??= time; previous ??= time;
      const elapsed = time - started, delta = Math.min((time - previous) / 1000, 0.04); previous = time;
      context.clearRect(0, 0, width, height);
      context.globalAlpha = Math.max(0, Math.min(1, (3600 - elapsed) / 650));
      for (const piece of pieces) {
        piece.x += piece.vx * delta; piece.y += piece.vy * delta; piece.vy += 42 * delta; piece.angle += piece.spin * delta;
        context.save(); context.translate(piece.x, piece.y); context.rotate(piece.angle); context.fillStyle = piece.color;
        context.fillRect(-piece.size / 2, -piece.size, piece.size, piece.size * (1 + Math.abs(Math.cos(piece.angle)))); context.restore();
      }
      if (elapsed < 3600) frame = win.requestAnimationFrame(draw); else stop();
    }
    frame = win.requestAnimationFrame(draw);
  }
  doc.addEventListener('visibilitychange', () => { if (doc.hidden) stop(); });
  return {
    stop,
    show(room) {
      if (room?.phase !== 'finished') { activeGame = room?.gameId || ''; stop(); return false; }
      if (!isWinner(room) || !room.gameId || doc.hidden) return false;
      const key = `nolege:celebration:${room.id}`;
      let saved; try { saved = win.sessionStorage.getItem(key); } catch {}
      if (rememberedGame === room.gameId || saved === room.gameId) return false;
      activeGame = room.gameId; rememberedGame = activeGame;
      try { win.sessionStorage.setItem(key, rememberedGame); } catch {}
      stop(); burst(); return true;
    }
  };
}
