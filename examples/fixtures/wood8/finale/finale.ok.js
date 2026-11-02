(ctx, u, env, objects, stage) => {
  const E = env.ease;
  const k = E.inOut(Math.min(1, u / 2.5));
  const zoom = 1 + 0.22 * k;
  const cx = 910, cy = 500;
  ctx.save();
  ctx.translate(800, 450 + 20 * k);
  ctx.scale(zoom, zoom);
  ctx.translate(-cx, -cy);
  ctx.save();
  ctx.globalAlpha = 0.12 * k;
  ctx.fillStyle = '#1d2b4f';
  ctx.beginPath();
  ctx.ellipse(910, 660, 340, 60, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  stage.draw(ctx, {'board-a': {alpha: 0}, 'board-b': {alpha: 0}, 'board-c': {alpha: 0}});
  const a = stage.pose('end-a'), b = stage.pose('end-b');
  const g = E.out(Math.max(0, Math.min(1, (u - 1.2) / 3)));
  const n = 9;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) / n;
    const px = a.x + (b.x - a.x) * s + 10;
    const py = a.y + (b.y - a.y) * s - 70;
    const local = Math.max(0, Math.min(1, g * 1.6 - i * 0.07));
    if (local <= 0) continue;
    const h = (55 + 30 * env.random(i)) * E.back(local);
    const sway = Math.sin(u * 1.6 + i) * 0.04 * local;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(sway);
    ctx.strokeStyle = '#3f6b2a';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -h); ctx.stroke();
    for (let j = 0; j < 4; j++) {
      const ly = -h * (0.3 + j * 0.22);
      const side = j % 2 ? 1 : -1;
      const L = (20 - j * 3) * local;
      ctx.fillStyle = j % 2 ? '#5c9a3a' : '#4a8a2e';
      ctx.beginPath();
      ctx.ellipse(side * L * 0.8, ly, L, L * 0.42, side * -0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
  const c = E.out(Math.max(0, Math.min(1, (u - 3.6) / 0.8)));
  if (c > 0) {
    ctx.save();
    ctx.globalAlpha = c;
    ctx.font = `700 72px "${env.font}"`;
    const txt = 'Herb planter';
    const w = ctx.measureText(txt).width;
    const bx = 800 - w / 2 - 28, by = 60 - 20 * (1 - c);
    ctx.fillStyle = '#ffcc00';
    ctx.fillRect(bx, by, w + 56, 104);
    ctx.fillStyle = '#1d2b4f';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(txt, 800, by + 54);
    ctx.restore();
  }
}