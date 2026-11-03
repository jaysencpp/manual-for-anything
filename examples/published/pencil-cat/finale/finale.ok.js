(ctx, u, env, objects, stage) => {
    ctx.save(); ctx.translate(900, 540); ctx.scale(0.9074074074074074, 0.9074074074074074); ctx.translate(-910, -500);
    stage.draw(ctx); ctx.restore();
    ctx.fillStyle = "#1d2b4f"; ctx.textAlign = "center"; ctx.font = "700 48px " + env.font;
    ctx.fillText("Sitting Cat Drawing", 900, 165);
    ctx.font = "400 26px " + env.font; ctx.fillText("21 x 29.7 cm · 15 min · Easy", 900, 210);
  }