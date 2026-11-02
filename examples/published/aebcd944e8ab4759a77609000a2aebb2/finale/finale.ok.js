(ctx, u, env, objects, stage) => {
    ctx.save(); ctx.translate(900, 540); ctx.scale(0.9765537379762611, 0.9765537379762611); ctx.translate(-910, -539.1177490060913);
    stage.draw(ctx); ctx.restore();
    ctx.fillStyle = "#1d2b4f"; ctx.textAlign = "center"; ctx.font = "700 48px " + env.font;
    ctx.fillText("Stepped Display Tower", 900, 165);
    ctx.font = "400 26px " + env.font; ctx.fillText("3.2 × 4.8 × 2.9 cm · 5 min · Easy", 900, 210);
  }