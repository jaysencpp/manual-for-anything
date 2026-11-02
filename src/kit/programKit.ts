// The kit a program may draw with, beside its bare canvas: the moves motion design is made of — words that
// arrive one at a time, a box that grows, a line that draws itself, a pop, a camera, a counter, a screenshot
// pushed into, a halftone, a grid — each built once, properly, so a program spends its effort on the film
// rather than on measuring type. Optional: a program may use all of it, some of it or none of it.
//
// It runs in the sandbox worker, so it is a source string spliced into the worker's own (see
// createWorkerBootstrap), not a module: self-contained, no backticks, and handed only what the program
// already has — its env. Every call is a function of what it is given, so a frame is the same however it
// is reached, and every input is bounded so a careless program cannot make one call cost a second.
export const programKitSource = String.raw`
function programKit(env){
 const views=[];
 const num=(value,fallback)=>{const n=Number(value);return Number.isFinite(n)?n:fallback};
 const clamp01=(u)=>Math.min(1,Math.max(0,num(u,0)));
 const span=(t,from,to)=>{const a=num(from,0),b=num(to,a);return b<=a?(num(t,0)>=a?1:0):clamp01((num(t,0)-a)/(b-a))};
 const curve=(name)=>typeof env.ease[name]==="function"?env.ease[name]:env.ease.inOut;
 const lerp=(a,b,u)=>a+(b-a)*u;
 const text=(value,max)=>String(value??"").slice(0,max);
 const family=(name,fallback)=>{const f=text(name,64).replace(/["\\]/g,"");return f||fallback};
 const fontOf=(o,size)=>num(o.weight,400)+" "+size+"px \""+family(o.font,env.font)+"\"";
 // The film's style: one design language every move below draws in, so two films directed alike still look
 // unlike each other. A style names how the field is printed, how words arrive and are picked out, how a
 // screenshot is framed and its proof marked, how a leader runs and what a diagram's cards are made of. A film
 // that names none is drawn in print, the one look there was before there were styles.
 const STYLES={
  print:{texture:"halftone",reveal:"wipe",emphasis:"brackets",frame:"print",mark:"outline",leader:"elbow",card:"app"},
  swiss:{texture:"rules",reveal:"rise",emphasis:"rule",frame:"flat",mark:"underline",leader:"straight",card:"flat"},
  studio:{texture:"glow",reveal:"fade",emphasis:"pill",frame:"window",mark:"spotlight",leader:"none",card:"soft"},
  blueprint:{texture:"blueprint",reveal:"letter",emphasis:"dimension",frame:"outline",mark:"dashed",leader:"node",card:"outline"},
  kinetic:{texture:"none",reveal:"drop",emphasis:"block",frame:"bare",mark:"fill",leader:"none",card:"block"},
  sketch:{texture:"paper",reveal:"jot",emphasis:"scribble",frame:"taped",mark:"circle",leader:"arrow",card:"paper"},
  aurora:{texture:"aurora",reveal:"blur",emphasis:"glow",frame:"glass",mark:"spotlight",leader:"none",card:"glass"},
  terminal:{texture:"scanlines",reveal:"type",emphasis:"block",frame:"console",mark:"dashed",leader:"straight",card:"console"},
  isometric:{texture:"isogrid",reveal:"rise",emphasis:"extrude",frame:"slab",mark:"outline",leader:"node",card:"iso"},
  risograph:{texture:"riso",reveal:"misprint",emphasis:"overprint",frame:"riso",mark:"fill",leader:"elbow",card:"riso"},
  brutalist:{texture:"raw",reveal:"cut",emphasis:"stamp",frame:"brutal",mark:"hardbox",leader:"straight",card:"brutal"},
  bauhaus:{texture:"shapes",reveal:"slide",emphasis:"disc",frame:"bauhaus",mark:"underline",leader:"straight",card:"bauhaus"},
  neon:{texture:"tubes",reveal:"flicker",emphasis:"tube",frame:"neon",mark:"neon",leader:"none",card:"neon"},
  collage:{texture:"scraps",reveal:"cutout",emphasis:"tape",frame:"torn",mark:"circle",leader:"arrow",card:"scrap"},
  magazine:{texture:"folio",reveal:"unveil",emphasis:"underscore",frame:"caption",mark:"underline",leader:"none",card:"column"},
 };
 const styleName=Object.prototype.hasOwnProperty.call(STYLES,env.style)?env.style:"print",style=STYLES[styleName];
 // A rect with rounded corners as a path, where the canvas has no roundRect of its own; radii one or four.
 const rounded=(ctx,x,y,w,h,r)=>{if(ctx.roundRect){ctx.roundRect(x,y,w,h,r);return}ctx.rect(x,y,w,h)};
 // How light a colour is, 0 to 1, from its hex; one not in hex counts as light. And the type that reads on it.
 const lightness=(colour)=>{
  const hex=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(colour));
  if(!hex)return 1;
  const rgb=hex[1].length===3?hex[1].split("").map((c)=>parseInt(c+c,16)):[0,2,4].map((k)=>parseInt(hex[1].slice(k,k+2),16));
  return (.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2])/255;
 };
 const readable=(colour)=>lightness(colour)>.5?"#111111":"#ffffff";
 // A kinetic film's field cuts hard to the accent and back within each beat, the type reversed out of it: the
 // cut is what kinetic type is cut to, and told to make them, programs painted a white field throughout. The
 // times follow from the beat's length alone — so the compiler knows them too, and the score hits them — clear
 // of the first 0.6 seconds and the last 0.9, so the frames a cut between beats is made on are the plain field.
 // While cut, every move draws in the reversed palette: the field is the accent, the accent is the field, and
 // ink is whichever of the field's colour and plain black or white reads on it.
 const kineticCuts=(()=>{
  const d=num(env.duration,0);
  if(styleName!=="kinetic"||d<2.5)return Object.freeze([]);
  // To the hundredth, as LaunchFilmCompiler.KineticCuts reckons them for the score.
  const on=Math.round(Math.max(.6,d*.38)*100)/100,off=Math.round(Math.min(d-.9,d*.72)*100)/100;
  return Object.freeze(off-on>=.5?[on,off]:[]);
 })();
 const reversed=Object.freeze({...env.palette,background:env.palette.accent,accent:env.palette.background,
  ink:Math.abs(lightness(env.palette.background)-lightness(env.palette.accent))>.3?env.palette.background:readable(env.palette.accent)});
 const cutting=(t)=>kineticCuts.length>0&&num(t,-1)>=kineticCuts[0]&&num(t,-1)<kineticCuts[1];
 let cutAt=NaN;
 const tone=(t)=>cutting(t)&&num(t,NaN)===cutAt?reversed:env.palette;
 // The palette the moves draw in, set from the time by every move that is given one; the moves that are not given
 // a time are drawn inside one that is, or straight after the field.
 let pal=env.palette;
 // The field's colours at t, and the beat's cuts: a program draws its own type and shapes in these, and may time
 // its motion to land on the cuts.
 function ground(t){const p=cutting(t)?reversed:env.palette,colours={background:p.background,accent:p.accent,ink:p.ink,cut:p!==env.palette,cuts:kineticCuts};return Object.freeze(colours)}
 // A torn edge round a rect, as a path: its outline walked in short steps, each knocked in or out a little by the
 // seed, as paper tears. The caller fills it.
 const torn=(ctx,x,y,w,h,seed,rough)=>{
  const step=18,around=[[x,y,w,0],[x+w,y,0,h],[x+w,y+h,-w,0],[x,y+h,0,-h]];
  ctx.beginPath();let k=0;
  for(const [sx,sy,ex,ey] of around){
   const l=Math.hypot(ex,ey),n=Math.max(1,Math.min(100,Math.round(l/step))),nx=ey/(l||1),ny=-ex/(l||1);
   for(let i=0;i<n;i++){const f=i/n,j=(env.random(seed+k)-.5)*num(rough,6),px=sx+ex*f+nx*j,py=sy+ey*f+ny*j;if(k)ctx.lineTo(px,py);else ctx.moveTo(px,py);k+=1}
  }
  ctx.closePath();
 };
 // A hand's line through points, drawn up to u of its length: each stretch bowed a little off true by the seed,
 // as a pen moves. Returns where the pen is and which way it is going, for an arrowhead.
 const scrawl=(ctx,points,u,seed,amp)=>{
  const segs=[];let total=0;
  for(let k=1;k<points.length;k++){const [ax,ay]=points[k-1],[bx,by]=points[k],l=Math.hypot(bx-ax,by-ay);segs.push([ax,ay,bx,by,l]);total+=l}
  let left=total*clamp01(u),end=points[0],dir=[1,0];
  ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);
  segs.forEach(([ax,ay,bx,by,l],i)=>{
   if(left<=0||l<=0)return;
   const f=Math.min(1,left/l),nx=-(by-ay)/l,ny=(bx-ax)/l,bend=(env.random(seed+i)-.5)*num(amp,10)*2;
   const ex=ax+(bx-ax)*f,ey=ay+(by-ay)*f;
   ctx.quadraticCurveTo(ax+(bx-ax)*f/2+nx*bend*f,ay+(by-ay)*f/2+ny*bend*f,ex,ey);
   end=[ex,ey];dir=[(bx-ax)/l,(by-ay)/l];left-=l;
  });
  ctx.stroke();
  return {end,dir};
 };
 // A loop drawn round something by hand: a little more than one turn of an ellipse, its radius wandering and its
 // two ends overshooting, drawn up to u of the way round.
 const loop=(ctx,cx,cy,rx,ry,u,seed)=>{
  const steps=56,turns=1.14,shown=Math.ceil(steps*clamp01(u));
  if(shown<2)return;
  ctx.beginPath();
  for(let k=0;k<=shown;k++){
   const a=-Math.PI*.65+k/steps*turns*Math.PI*2,w=1+(env.random(seed+(k%9))-.5)*.07+k/steps*.07;
   const px=cx+Math.cos(a)*rx*w,py=cy+Math.sin(a)*ry*w;
   if(k)ctx.lineTo(px,py);else ctx.moveTo(px,py);
  }
  ctx.stroke();
 };

 // A dropped letter's fall, and how far behind the letter before it each one starts.
 const DROP_FALL=.5,DROP_STAGGER=.035;
 // Words, one at a time: each wipes in from its left edge and settles from a small lift, wrapping inside
 // a width if given. y is the top of the block. The font is set before anything is measured.
 function words(ctx,t,o={}){
  pal=tone(t);
  const size=Math.max(4,Math.min(400,num(o.size,48))),leading=num(o.leading,1.15),at=num(o.at,0),pace=Math.max(0,num(o.pace,.16)),wipe=Math.max(.01,num(o.wipe,.12));
  // How each word arrives: asked for by name, or the style's own; typed letter by letter when asked by.
  const reveals=["wipe","rise","fade","slam","drop","letter","jot","blur","type","misprint","cut","slide","flicker","cutout","unveil"];
  const reveal=o.by==="letter"?"letter":reveals.includes(o.reveal)?o.reveal:style.reveal;
  // Typed: letter by letter, as letter is, with a block cursor at the end of the word being typed.
  const byLetter=reveal==="letter"||reveal==="type",emphasis=o.boxed?style.emphasis:null;
  let said=text(o.text,600);
  if(o.case==="upper")said=said.toUpperCase();else if(o.case==="lower")said=said.toLowerCase();
  ctx.save();
  ctx.font=fontOf(o,size);
  ctx.letterSpacing=num(o.tracking,0)+"px";
  // Its own alignment, whatever the program left set: a program that set textAlign "center" before a feature
  // call had every word centred on the x meant as its left edge, its headline cut off the frame's left.
  ctx.textAlign="left";ctx.textBaseline="alphabetic";
  // Boxed words stand apart, so each word's brackets frame it alone rather than meeting its neighbour's.
  const space=ctx.measureText(" ").width+(o.boxed?size*.32:0),limit=o.width==null?Infinity:Math.max(size,num(o.width,Infinity));
  const lines=[];let line=[],lineWidth=0;
  for(const word of said.split(/\s+/).filter(Boolean)){
   const w=ctx.measureText(word).width;
   if(line.length&&lineWidth+space+w>limit){lines.push({words:line,width:lineWidth});line=[];lineWidth=0}
   line.push({word,w});lineWidth+=(line.length>1?space:0)+w;
  }
  if(line.length)lines.push({words:line,width:lineWidth});
  const x0=num(o.x,0),y0=num(o.y,0),align=o.align==="center"||o.align==="right"?o.align:"left";
  let n=0,widest=0;
  lines.forEach((row,r)=>{
   widest=Math.max(widest,row.width);
   let x=align==="center"?x0-row.width/2:align==="right"?x0-row.width:x0;
   const base=y0+size*.8+r*size*leading;
   for(const {word,w} of row.words){
    const start=at+n*pace,shown=span(t,start,start+(byLetter?Math.max(wipe,.03*word.length):wipe));
    if(shown>0){
     const settle=env.ease.out(span(t,start,start+.28)),lift=num(o.lift,size*.14)*(1-settle);
     // A word may arrive in one colour and settle into its own a moment later, so the newest stands out.
     let colour=String(o.arrive&&num(t,0)<start+.4?o.arrive:(o.color??pal.ink));
     // Picked out from behind: a soft pill, or a solid block the word is reversed out of once it has covered it.
     if(emphasis==="pill"||emphasis==="block"){
      const grow=env.ease.expoOut(span(t,start,start+.35)),ph=size*1.12,px=x-size*.16,py=base-size*.86,pw=(w+size*.32)*grow;
      ctx.save();ctx.fillStyle=String(o.boxColor??pal.accent);ctx.beginPath();
      if(emphasis==="pill"){ctx.globalAlpha*=.32;rounded(ctx,px,py,pw,ph,Math.min(ph/2,pw/2))}else ctx.rect(px,py,pw,ph);
      ctx.fill();ctx.restore();
      if(emphasis==="block"&&grow>.5)colour=String(pal.background);
     }
     // Or a disc of the accent rolled in under its first letter; a block of the accent overprinted under it a
     // little off register; a stamp, the word boxed in ink on a hard shadow of the accent; or the word itself
     // turned to the accent once it has arrived, a hairline drawn under it.
     else if(emphasis==="disc"){const g=env.ease.back(span(t,start,start+.4)),fw=ctx.measureText(word.charAt(0)).width;if(g>0){ctx.save();ctx.fillStyle=String(o.boxColor??pal.accent);ctx.beginPath();ctx.arc(x+fw/2,base-size*.36,Math.max(0,size*.44*g),0,Math.PI*2);ctx.fill();ctx.restore()}}
     else if(emphasis==="overprint"){const grow=env.ease.expoOut(span(t,start+.05,start+.4));ctx.save();ctx.globalCompositeOperation=lightness(pal.background)>.42?"multiply":"screen";ctx.globalAlpha*=.85;ctx.fillStyle=String(o.boxColor??pal.accent);ctx.fillRect(x-size*.03,base-size*.72,(w+size*.16)*grow,size*.9);ctx.restore()}
     else if(emphasis==="stamp"){const pad=size*.12,off=Math.max(4,size*.08),bx=x-pad,by=base-size*.86,bw=w+pad*2,bh=size*1.1;ctx.save();ctx.fillStyle=String(o.boxColor??pal.accent);ctx.fillRect(bx+off,by+off,bw,bh);ctx.fillStyle=String(pal.background);ctx.fillRect(bx,by,bw,bh);ctx.strokeStyle=String(pal.ink);ctx.lineWidth=Math.max(3,size*.045);ctx.strokeRect(bx,by,bw,bh);ctx.restore()}
     else if(emphasis==="underscore"&&num(t,0)>=start+.4)colour=String(o.boxColor??pal.accent);
     ctx.fillStyle=colour;
     // Glowing: the word lit in the accent as it settles. Extruded: set on a stack of itself in the accent,
     // stepping back down and to the right, so it stands up off the field as a block does.
     if(emphasis==="glow"){ctx.shadowColor=String(o.boxColor??pal.accent);ctx.shadowBlur=size*.55*settle}
     else if(emphasis==="tube"){ctx.shadowColor=String(o.boxColor??pal.accent);ctx.shadowBlur=size*.35*settle}
     // Flickering on, as a tube strikes: out and in, lit for longer each time, then held lit. Unlit, no glow.
     const lit=reveal!=="flicker"||span(t,start,start+.5)>=1||env.random(n*29+Math.floor(num(t,0)*24))<.15+.85*span(t,start,start+.5);
     if(!lit){ctx.shadowBlur=0;ctx.shadowColor="transparent"}
     if(emphasis==="extrude"){
      const depth=Math.min(8,Math.round(size*.05*env.ease.out(span(t,start+.1,start+.5)))),step=Math.max(1,size*.01);
      ctx.save();ctx.fillStyle=String(o.boxColor??pal.accent);for(let k=depth;k>=1;k--)ctx.fillText(word,x+k*step,base+lift+k*step);ctx.restore();
     }
     // Dropped, letter by letter: each falls onto the baseline in its turn, tumbling a little, and lands on a
     // spring — kinetic type, so a kinetic film's every word moves by the letter, its product beats' too.
     if(reveal==="drop"){
      const chars=[...word];
      chars.forEach((ch,i)=>{
       const ls=start+i*DROP_STAGGER,u=span(t,ls,ls+DROP_FALL);
       if(u<=0)return;
       const p=spring(u,{bounce:.35}),lx=x+ctx.measureText(chars.slice(0,i).join("")).width,mx=lx+ctx.measureText(ch).width/2,my=base-size*.35;
       ctx.save();ctx.globalAlpha*=clamp01(u*6);ctx.translate(mx,my-size*1.2*(1-p));ctx.rotate((env.random(n*31+i)-.5)*.6*(1-Math.min(1,p)));ctx.translate(-mx,-my);
       ctx.fillText(ch,lx,base);ctx.restore();
      });
     }
     else if(byLetter){
      const typed=word.slice(0,Math.ceil(word.length*shown));
      ctx.fillText(typed,x,base+lift);
      if(reveal==="type"&&shown<1){const cx=x+ctx.measureText(typed).width+size*.04;ctx.save();ctx.fillStyle=emphasis==="block"?colour:String(o.boxColor??pal.accent);ctx.fillRect(cx,base-size*.78,size*.5,size*.92);ctx.restore()}
     }
     // Jotted: dropped in by hand, from a touch larger, landing at its own slight tilt.
     else if(reveal==="jot"){
      const tilt=(env.random(n*7+3)-.5)*.07,k=lerp(1.18,1,settle),mx=x+w/2,my=base-size*.35;
      ctx.save();ctx.globalAlpha*=clamp01(span(t,start,start+.12));ctx.translate(mx,my);ctx.rotate(tilt*(1.6-settle*.6));ctx.scale(k,k);ctx.translate(-mx,-my);ctx.fillText(word,x,base);ctx.restore();
     }
     // Out of a blur: the word comes into focus as it rises into place.
     else if(reveal==="blur"){
      const focus=env.ease.out(span(t,start,start+.5));
      ctx.save();ctx.globalAlpha*=clamp01(focus*1.4);ctx.filter="blur("+(size*.22*(1-focus)).toFixed(2)+"px)";ctx.fillText(word,x,base+lift*1.4);ctx.restore();
     }
     // Misprinted: an impression of the word in the accent slipping into register under it, never quite there, as
     // a riso's second drum prints.
     else if(reveal==="misprint"){
      const off=size*(.035+.14*(1-settle));
      ctx.save();ctx.globalAlpha*=clamp01(span(t,start,start+.15));
      ctx.save();ctx.globalCompositeOperation=lightness(pal.background)>.42?"multiply":"screen";ctx.fillStyle=String(o.boxColor??pal.accent);ctx.fillText(word,x-off,base-off*.6);ctx.restore();
      ctx.fillText(word,x,base+lift*.5);ctx.restore();
     }
     // Cut in: there all at once, jolted for its first few frames.
     else if(reveal==="cut"){const j=span(t,start,start+.1)<1?(env.random(n*17+Math.floor(num(t,0)*30))-.5)*size*.14:0;ctx.fillText(word,x+j,base-j*.4)}
     // Slid in along its line from behind a mask at its left edge.
     else if(reveal==="slide"){ctx.save();ctx.beginPath();ctx.rect(x-size*.1,base-size*1.1,w+size*.2,size*1.5);ctx.clip();ctx.fillText(word,x-(w+size*.3)*(1-settle),base);ctx.restore()}
     // Unlit, a tube is a faint shape of the word; lit, the word.
     else if(reveal==="flicker"){ctx.save();if(!lit)ctx.globalAlpha*=.14;ctx.fillText(word,x,base);ctx.restore()}
     // Cut out of a page: each word on its own scrap of paper at its own tilt, popping in, a ransom note's.
     else if(reveal==="cutout"){
      const pick=env.random(n*5+1),paper=pick<.4?"#fbfaf6":pick<.65?"#ece1c4":pick<.85?String(pal.accent):"#151515";
      const pad=size*.1,k=lerp(.6,1,env.ease.back(span(t,start,start+.3))),mx=x+w/2,my=base-size*.35;
      ctx.save();ctx.globalAlpha*=clamp01(span(t,start,start+.08));ctx.translate(mx,my);ctx.rotate((env.random(n*7+3)-.5)*.12);ctx.scale(k,k);ctx.translate(-mx,-my);
      ctx.shadowColor="rgba(0,0,0,0.25)";ctx.shadowBlur=8;ctx.shadowOffsetY=3;ctx.fillStyle=paper;ctx.fillRect(x-pad,base-size*.84,w+pad*2,size*1.06);
      ctx.shadowColor="transparent";ctx.shadowOffsetY=0;ctx.fillStyle=readable(paper);ctx.fillText(word,x,base);ctx.restore();
     }
     // Unveiled from the top down, as a page is turned to it.
     else if(reveal==="unveil"){ctx.save();ctx.beginPath();ctx.rect(x-size*.1,base-size*1.1,w+size*.2,size*1.5*settle);ctx.clip();ctx.fillText(word,x,base+lift*.6);ctx.restore()}
     // Rising out of a mask at its own baseline, as set type is revealed.
     else if(reveal==="rise"){ctx.save();ctx.beginPath();ctx.rect(x-size*.1,base-size*1.1,w+size*.2,size*1.42);ctx.clip();ctx.fillText(word,x,base+size*.95*(1-settle));ctx.restore()}
     else if(reveal==="fade"){ctx.save();ctx.globalAlpha*=env.ease.out(span(t,start,start+.32));ctx.fillText(word,x,base+lift*1.6);ctx.restore()}
     // Slammed: in from larger about its own middle, landing hard.
     else if(reveal==="slam"){const k=lerp(1.55,1,settle),mx=x+w/2,my=base-size*.35;ctx.save();ctx.globalAlpha*=clamp01(span(t,start,start+.1));ctx.translate(mx,my);ctx.scale(k,k);ctx.translate(-mx,-my);ctx.fillText(word,x,base);ctx.restore()}
     else{ctx.save();ctx.beginPath();ctx.rect(x-size*.1,base-size*1.1,(w+size*.2)*shown,size*1.5);ctx.clip();ctx.fillText(word,x,base+lift);ctx.restore()}
     // Boxed: each word picked out in the style's device as it lands — corner brackets closing in on it (the
     // editorial device), a heavy rule drawn under it, or a dimension line with its end ticks.
     if(emphasis==="brackets"){const pad=size*.12,gap=(1-settle)*size*.25;ctx.save();brackets(ctx,x-pad-gap,base-size*.82-pad-gap,w+pad*2+gap*2,size*.98+pad*2+gap*2,{color:o.boxColor??pal.accent,size:Math.max(6,size*.16),width:Math.max(2,size*.03),all:true});ctx.restore()}
     else if(emphasis==="rule"){ctx.save();ctx.fillStyle=String(o.boxColor??pal.accent);ctx.fillRect(x,base+size*.12,w*env.ease.expoOut(span(t,start+.1,start+.5)),Math.max(4,size*.08));ctx.restore()}
     // Scribbled round: a quick loop in the accent, drawn as the word lands, the sketcher's ring.
     else if(emphasis==="scribble"){ctx.save();ctx.shadowColor="transparent";ctx.strokeStyle=String(o.boxColor??pal.accent);ctx.lineWidth=Math.max(2,size*.028);ctx.lineCap="round";ctx.lineJoin="round";loop(ctx,x+w/2,base-size*.34,w/2+size*.14,size*.5,env.ease.out(span(t,start+.12,start+.62)),n*13+5);ctx.restore()}
     // A neon tube: the word's outline in the accent, glowing with it, once it is lit.
     else if(emphasis==="tube"&&lit&&(reveal==="flicker"||settle>=1)){ctx.save();ctx.strokeStyle=String(o.boxColor??pal.accent);ctx.lineWidth=Math.max(1.5,size*.022);ctx.strokeText(word,x,base);ctx.restore()}
     // A strip of tape across its corner, holding it to the page.
     else if(emphasis==="tape"){const u=span(t,start+.25,start+.35);if(u>0){ctx.save();ctx.shadowColor="transparent";ctx.globalAlpha*=u;ctx.fillStyle="rgba(236,226,190,0.8)";ctx.translate(x+size*.05,base-size*.8);ctx.rotate(-.55);ctx.fillRect(-size*.32,-size*.1,size*.64,size*.2);ctx.restore()}}
     else if(emphasis==="underscore"){ctx.save();ctx.fillStyle=String(o.boxColor??pal.accent);ctx.fillRect(x,base+size*.16,w*env.ease.inOut(span(t,start+.15,start+.7)),Math.max(1.5,size*.018));ctx.restore()}
     else if(emphasis==="dimension"){
      const u=env.ease.out(span(t,start+.1,start+.5)),ly=base+size*.24,tick=Math.max(6,size*.14);
      ctx.save();ctx.strokeStyle=String(o.boxColor??pal.accent);ctx.lineWidth=Math.max(1.5,size*.02);ctx.beginPath();
      ctx.moveTo(x,ly-tick);ctx.lineTo(x,ly+tick);ctx.moveTo(x,ly);ctx.lineTo(x+w*u,ly);
      if(u>=1){ctx.moveTo(x+w,ly-tick);ctx.lineTo(x+w,ly+tick)}
      ctx.stroke();ctx.restore();
     }
    }
    ctx.shadowBlur=0;ctx.shadowColor="transparent";
    x+=w+space;n+=1;
   }
  });
  ctx.restore();
  // Dropped letters land a little after their word begins: the last of the longest word, its fall done.
  const landed=reveal==="drop"?Math.max(0,...lines.flatMap((row)=>row.words.map(({word})=>[...word].length-1)))*DROP_STAGGER+DROP_FALL:wipe;
  return {width:widest,height:lines.length?size*(1+(lines.length-1)*leading):0,lines:lines.length,done:at+Math.max(0,n-1)*pace+landed};
 }

 // Corner marks, the editorial frame: top-right and bottom-left unless all four are asked for.
 function brackets(ctx,x,y,w,h,o={}){
  const s=num(o.size,10);x=num(x,0);y=num(y,0);w=num(w,0);h=num(h,0);
  ctx.save();ctx.strokeStyle=String(o.color??pal.ink);ctx.lineWidth=num(o.width,2);ctx.beginPath();
  const corner=(cx,cy,dx,dy)=>{ctx.moveTo(cx+dx*s,cy);ctx.lineTo(cx,cy);ctx.lineTo(cx,cy+dy*s)};
  corner(x+w,y,-1,1);corner(x,y+h,1,-1);
  if(o.all){corner(x,y,1,1);corner(x+w,y+h,-1,-1)}
  ctx.stroke();ctx.restore();
 }

 // A panel that grows in from an edge or its middle, with brackets if asked.
 function box(ctx,t,o={}){
  pal=tone(t);
  const p=curve(o.ease??"expoOut")(span(t,num(o.at,0),num(o.at,0)+num(o.duration,.35)));
  if(p<=0)return p;
  const x=num(o.x,0),y=num(o.y,0),w=num(o.w,0),h=num(o.h,0),from=o.from??"left";
  const bw=from==="top"?w:w*p,bh=from==="top"?h*p:h,bx=from==="center"?x+(w-bw)/2:x,by=y;
  ctx.save();
  const r=Math.min(num(o.radius,0),bw/2,bh/2);
  ctx.beginPath();if(ctx.roundRect)ctx.roundRect(bx,by,bw,bh,r);else ctx.rect(bx,by,bw,bh);
  if(o.fill!==false){ctx.fillStyle=String(o.fill??"#ffffff");ctx.fill()}
  if(o.stroke){ctx.strokeStyle=String(o.stroke);ctx.lineWidth=num(o.lineWidth,2);ctx.stroke()}
  ctx.restore();
  if(o.brackets)brackets(ctx,bx-12,by-12,bw+24,bh+24,{color:o.brackets===true?pal.ink:o.brackets,size:10});
  return p;
 }

 // A line through points that draws itself, its corners rounded, landing on a dot.
 function connector(ctx,t,o={}){
  pal=tone(t);
  const points=(Array.isArray(o.points)?o.points:[]).slice(0,64).map((p)=>[num(p?.[0],0),num(p?.[1],0)]);
  if(points.length<2)return 0;
  const at=num(o.at,0),p=curve(o.ease??"inOut")(span(t,at,at+num(o.duration,.6))),radius=num(o.radius,18);
  let length=0;for(let k=1;k<points.length;k++)length+=Math.hypot(points[k][0]-points[k-1][0],points[k][1]-points[k-1][1]);
  if(p>0){
   ctx.save();ctx.strokeStyle=String(o.color??pal.ink);ctx.lineWidth=num(o.width,2);ctx.lineCap="round";
   ctx.setLineDash([length+1,length+1]);ctx.lineDashOffset=(length+1)*(1-p);
   ctx.beginPath();ctx.moveTo(points[0][0],points[0][1]);
   for(let k=1;k<points.length-1;k++)ctx.arcTo(points[k][0],points[k][1],points[k+1][0],points[k+1][1],radius);
   ctx.lineTo(points[points.length-1][0],points[points.length-1][1]);ctx.stroke();ctx.restore();
  }
  const end=points[points.length-1],dot=o.dot===false?0:env.ease.back(span(t,at+num(o.duration,.6)-.05,at+num(o.duration,.6)+.2));
  if(dot>0){ctx.save();ctx.fillStyle=String(o.color??pal.ink);ctx.beginPath();ctx.arc(end[0],end[1],(typeof o.dot==="number"?o.dot:6)*dot,0,Math.PI*2);ctx.fill();ctx.restore()}
  return p;
 }

 // Scale in with an overshoot about a point; draw is called at that point, at that scale.
 function pop(ctx,t,o={},draw){
  pal=tone(t);
  const at=num(o.at,0),u=span(t,at,at+num(o.duration,.4));
  if(u<=0||typeof draw!=="function")return u;
  const s=Math.max(.0001,lerp(num(o.from,0),1,env.ease.back(u)));
  ctx.save();ctx.translate(num(o.x,0),num(o.y,0));ctx.rotate(num(o.spin,0)*(1-env.ease.out(u)));ctx.scale(s,s);
  try{draw(u)}finally{ctx.restore()}
  return u;
 }

 // A camera over keyframes {at, x, y, zoom}: the point x,y sits at the frame's middle at that zoom, eased
 // between keys. Everything draw paints is seen through it.
 function camera(ctx,t,o={},draw){
  pal=tone(t);
  const keys=(Array.isArray(o.keys)?o.keys:[]).slice(0,32).map((k)=>({at:num(k?.at,0),x:num(k?.x,env.width/2),y:num(k?.y,env.height/2),zoom:Math.max(.05,num(k?.zoom,1))})).sort((a,b)=>a.at-b.at);
  let view=keys[0]??{x:env.width/2,y:env.height/2,zoom:1};
  for(let k=1;k<keys.length;k++){
   if(num(t,0)>=keys[k-1].at){const u=curve(o.ease??"inOut")(span(t,keys[k-1].at,keys[k].at));view={x:lerp(keys[k-1].x,keys[k].x,u),y:lerp(keys[k-1].y,keys[k].y,u),zoom:lerp(keys[k-1].zoom,keys[k].zoom,u)}}
  }
  ctx.save();ctx.translate(env.width/2,env.height/2);ctx.scale(view.zoom,view.zoom);ctx.translate(-view.x,-view.y);
  // The view is known to the moves drawn through it while they are, so a headline can keep itself in frame.
  views.push(view);
  try{if(typeof draw==="function")draw(view)}finally{views.pop();ctx.restore()}
  return view;
 }

 // A ruled grid, the paper a diagram sits on.
 function grid(ctx,o={}){
  const step=Math.max(8,num(o.step,80)),x0=num(o.x,0),y0=num(o.y,0),w=num(o.w,env.width),h=num(o.h,env.height);
  ctx.save();ctx.strokeStyle=String(o.color??"rgba(127,127,127,0.12)");ctx.lineWidth=num(o.width,1);ctx.beginPath();
  const ox=((num(o.offsetX,0)%step)+step)%step,oy=((num(o.offsetY,0)%step)+step)%step;
  for(let x=x0+ox,n=0;x<=x0+w&&n<400;x+=step,n++){ctx.moveTo(Math.round(x)+.5,y0);ctx.lineTo(Math.round(x)+.5,y0+h)}
  for(let y=y0+oy,n=0;y<=y0+h&&n<400;y+=step,n++){ctx.moveTo(x0,Math.round(y)+.5);ctx.lineTo(x0+w,Math.round(y)+.5)}
  ctx.stroke();ctx.restore();
 }

 // A halftone sphere: a jittered grid of fine dots, each kept as the surface turns from the light, with a
 // loose halo. Only the dots in the frame are drawn.
 //
 // Which dots a sphere keeps follows from its size, light, density and seed alone, never from where it stands,
 // so they are worked out once and kept: a frame only places them. Worked out every frame they were most of a
 // launch film's drawing time — tens of thousands of cells a sphere, two or three spheres a frame. Kept for a
 // few spheres at a time, so one whose size moves every frame costs what it did and holds no more memory.
 const stipples=new Map();let stippled=0;
 function stipple(ctx,o={}){
  const cx=num(o.x,0),cy=num(o.y,0),r=Math.max(1,num(o.r,100)),step=Math.max(2.5,num(o.step,4.2)),dot=num(o.dot,2.1),halo=Math.max(0,num(o.halo,.3));
  const lx=num(o.light?.[0],-.5),ly=num(o.light?.[1],-.55),seed=Math.floor(num(o.seed,0))*1000003,density=num(o.density,1);
  const key=r+" "+step+" "+halo+" "+lx+" "+ly+" "+seed+" "+density;
  let kept=stipples.get(key);
  if(!kept){
   // Each kept dot as its cell's corner and its jitter, x then y: placed below exactly as it was found.
   kept=[];
   const reach=r*(1+halo);let k=0,cells=0;
   for(let y=-reach;y<reach;y+=step){
    for(let x=-reach;x<reach;x+=step,k++){
     if(++cells>160000)break;
     const jx=(env.random(seed+k*3)-.5)*step,jy=(env.random(seed+k*3+1)-.5)*step;
     const dx=(x+jx)/r,dy=(y+jy)/r,d=Math.hypot(dx,dy);
     if(d>1+halo)continue;
     const dark=d<1?.04+1.15*Math.pow(1-clamp01(lx*dx+ly*dy+.67*Math.sqrt(1-d*d)),1.5):.1*(1-(d-1)/Math.max(.01,halo));
     if(env.random(seed+k*3+2)<dark*density)kept.push(x,jx,y,jy);
    }
   }
   if(stipples.size>=8||stippled+kept.length>800000){stipples.clear();stippled=0}
   stipples.set(key,kept);stippled+=kept.length;
  }
  ctx.save();ctx.fillStyle=String(o.color??"rgba(20,16,24,0.9)");
  for(let i=0;i<kept.length;i+=4){
   const px=cx+kept[i]+kept[i+1],py=cy+kept[i+2]+kept[i+3];
   if(px<-dot||py<-dot||px>env.width+dot||py>env.height+dot)continue;
   ctx.fillRect(px,py,dot,dot);
  }
  ctx.restore();
 }

 // A number that counts, set in its format — "{n}/72 complete" — in a small chip if asked, from its time on.
 function counter(ctx,t,o={}){
  pal=tone(t);
  const at=num(o.at,0);
  if(num(t,0)<at)return {value:num(o.from,0),width:0};
  const value=lerp(num(o.from,0),num(o.to,100),curve(o.ease??"out")(span(t,at,at+num(o.duration,1.2))));
  const decimals=Math.max(0,Math.min(4,Math.floor(num(o.decimals,0))));
  const [whole,fraction]=value.toFixed(decimals).split(".");
  const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,o.separator==null?"":text(o.separator,2))+(fraction?"."+fraction:"");
  const said=text(o.format??"{n}",120).replace("{n}",grouped);
  const size=num(o.size,16);
  ctx.save();ctx.font=num(o.weight,500)+" "+size+"px \""+family(o.font,env.mono)+"\"";ctx.textAlign="left";ctx.textBaseline="middle";
  const w=ctx.measureText(said).width,x=num(o.x,0),y=num(o.y,0),pad=size*.75;
  if(o.chip){ctx.fillStyle=String(o.chip===true?"#efe7de":o.chip);ctx.fillRect(x,y-size*1.05,w+pad*2,size*2.1);brackets(ctx,x+4,y-size*1.05+4,w+pad*2-8,size*2.1-8,{size:size*.45,width:1.5,color:o.color??pal.ink,all:false})}
  ctx.fillStyle=String(o.color??pal.ink);ctx.fillText(said,x+(o.chip?pad:0),y);
  ctx.restore();
  return {value,width:w+(o.chip?pad*2:0)};
 }

 // A screenshot fitted into a rect, pushed into a region (its key, or {x,y,w,h} in the screen's pixels)
 // over the given span. What it returns places anything on the picture: map turns a point on the screen
 // into the frame, and rect turns a region into the frame.
 function screen(ctx,t,o={}){
  pal=tone(t);
  const info=env.screens[String(o.key)];
  if(!info)return null;
  const fx=num(o.x,0),fy=num(o.y,0),fw=num(o.w,env.width),fh=num(o.h,env.height);
  const scale=Math.min(fw/info.width,fh/info.height),dw=info.width*scale,dh=info.height*scale,dx=fx+(fw-dw)/2,dy=fy+(fh-dh)/2;
  const regionOf=(r)=>typeof r==="string"?info.regions.find((g)=>g.key===r)??null:r&&typeof r==="object"?{x:num(r.x,0),y:num(r.y,0),width:num(r.w??r.width,info.width),height:num(r.h??r.height,info.height)}:null;
  let src={x:0,y:0,w:info.width,h:info.height};
  const focus=regionOf(o.focus);
  if(focus){
   const pad=num(o.pad,.12),aspect=info.width/info.height;
   let w=focus.width*(1+pad*2),h=focus.height*(1+pad*2);
   if(w/h<aspect)w=h*aspect;else h=w/aspect;
   w=Math.min(w,info.width);h=Math.min(h,info.height);
   const x=Math.min(Math.max(0,focus.x+focus.width/2-w/2),info.width-w),y=Math.min(Math.max(0,focus.y+focus.height/2-h/2),info.height-h);
   const at=num(o.at,0),u=curve(o.ease??"inOut")(span(t,at,at+num(o.duration,1.2)));
   src={x:lerp(0,x,u),y:lerp(0,y,u),w:lerp(info.width,w,u),h:lerp(info.height,h,u)};
  }
  ctx.save();
  if(o.shadow){ctx.shadowColor="rgba(0,0,0,0.35)";ctx.shadowBlur=40;ctx.shadowOffsetY=18;ctx.fillStyle="#000";ctx.fillRect(dx,dy,dw,dh);ctx.shadowColor="transparent"}
  if(o.radius){ctx.beginPath();if(ctx.roundRect)ctx.roundRect(dx,dy,dw,dh,num(o.radius,0));else ctx.rect(dx,dy,dw,dh);ctx.clip()}
  if(o.opacity!=null)ctx.globalAlpha=clamp01(o.opacity);
  env.drawScreen(ctx,o.key,dx,dy,dw,dh,src.x,src.y,src.w,src.h);
  ctx.restore();
  const map=(sx,sy)=>[dx+(num(sx,0)-src.x)/src.w*dw,dy+(num(sy,0)-src.y)/src.h*dh];
  const rect=(r)=>{const g=regionOf(r);if(!g)return null;const [x1,y1]=map(g.x,g.y),[x2,y2]=map(g.x+g.width,g.y+g.height);return {x:x1,y:y1,w:x2-x1,h:y2-y1}};
  return {x:dx,y:dy,w:dw,h:dh,source:src,map,rect};
 }

 // A rect picked out: corner brackets that close in on it, an outline that draws, or a wash.
 function highlight(ctx,t,o={}){
  pal=tone(t);
  const at=num(o.at,0),u=curve(o.ease??"expoOut")(span(t,at,at+num(o.duration,.35)));
  if(u<=0)return u;
  const pad=num(o.pad,8),x=num(o.x,0)-pad,y=num(o.y,0)-pad,w=num(o.w,0)+pad*2,h=num(o.h,0)+pad*2,colour=String(o.color??pal.accent);
  ctx.save();
  if(o.style==="fill"){ctx.globalAlpha=.22*u;ctx.fillStyle=colour;ctx.fillRect(x,y,w,h)}
  else if(o.style==="outline"){ctx.strokeStyle=colour;ctx.lineWidth=num(o.width,2);const l=2*(w+h);ctx.setLineDash([l,l]);ctx.lineDashOffset=l*(1-u);ctx.strokeRect(x,y,w,h)}
  else{const g=(1-u)*24;brackets(ctx,x-g,y-g,w+g*2,h+g*2,{color:colour,size:Math.min(w,h)*.25+6,width:num(o.width,2.5),all:true})}
  ctx.restore();
  return u;
 }

 // A product beat in one move, readable by construction: the headline on the field and a framed card cropped
 // to one region of a screenshot — the card takes the crop's shape, the crop is the region with a margin, so
 // the region fills the card, and the zoom is held under maxZoom so a small region is shown with its
 // surroundings rather than blurred. The card pushes in from a wider view, the region is marked, a leader runs
 // from the headline into it where the style draws one, then the second line and any marks. Laid out one of
 // four ways: "split", the words on one side and the card the frame's far side; "stack", the words across the
 // head of the frame and the card wide under them (always, upright); "full", the card bled to the frame's
 // edges above a band the words are set in; "magnify", the whole screen on the far side and the proof lifted
 // off it onto a card of its own, magnified, joined to where it came from.
 function feature(ctx,t,o={}){
  pal=tone(t);
  const info=env.screens[String(o.key)];
  if(!info)return null;
  const W=env.width,H=env.height,upright=H>W,M=num(o.margin,96),gap=num(o.gap,44),at=num(o.at,0);
  const accent=String(o.accent??pal.accent),ink=String(o.color??pal.ink);
  const layout=upright?"stack":o.layout==="stack"||o.layout==="full"||o.layout==="magnify"?o.layout:"split";
  const across=layout==="stack"||layout==="full";
  // Headline sizes have a floor: the move exists to make a product beat read, and its words shrunk to a
  // caption beside the card undo that.
  // Kinetic type is set bigger: there the words are the show, the card their proof.
  const kinetic=styleName==="kinetic",floor=upright?64:72;
  const right=o.side==="right",wordsW=across?W-M*2:Math.max(200,num(o.wordsWidth,440));
  let size=Math.max(floor,Math.min(200,num(o.size,upright?(kinetic?100:80):(kinetic?120:88))));
  // No word wider than its column, down to the floor: a word that cannot wrap ran on into the card beside it.
  if(o.text){
   ctx.save();ctx.font=fontOf({weight:num(o.weight,700),font:o.font},size);ctx.letterSpacing="0px";
   const said=o.case==="upper"?text(o.text,600).toUpperCase():o.case==="lower"?text(o.text,600).toLowerCase():text(o.text,600);
   const longest=Math.max(0,...said.split(/\s+/).filter(Boolean).map((word)=>ctx.measureText(word).width));
   ctx.restore();
   if(longest>wordsW)size=Math.max(floor,size*wordsW/longest);
  }
  const subSize=Math.max(32,num(o.subSize,size*.5));
  const head={text:o.text,size,weight:num(o.weight,700),font:o.font,color:ink,arrive:accent,width:wordsW,leading:num(o.leading,1.02),pace:num(o.pace,.14),case:o.case};
  const sub={text:o.sub,size:subSize,weight:num(o.weight,700),font:o.font,color:String(o.subColor??accent),width:wordsW,leading:1.1,pace:.12,case:o.case};
  // Measured first, drawing nothing: a block before its time is laid out but not set.
  const headBox=o.text?words(ctx,-1e9,{...head,at:0}):{width:0,height:0,done:0};
  const subBox=o.sub?words(ctx,-1e9,{...sub,at:0}):{width:0,height:0};
  const wordsH=headBox.height+(o.sub?subSize*.6+subBox.height:0);
  // Landscape, the card takes the frame's far side to within a narrow edge: the proof is the beat, and a card
  // held to half the frame was read as too small in film after film.
  const edge=num(o.edge,56);
  // The card's frame is the style's — a white mount, a ruled border, a window, a drafting outline or nothing;
  // a full card bleeds, framed by nothing. A window's bar is room taken off the top of the card's area.
  const frame=layout==="full"?"bare":style.frame,bar=frame==="window"?36:frame==="console"?34:0;
  const side={x:right?edge:M+wordsW+gap,y:edge,w:W-M-edge-wordsW-gap,h:H-edge*2};
  let area=layout==="stack"?{x:M,y:M+wordsH+gap,w:W-M*2,h:H-M*2-wordsH-gap}:layout==="full"?{x:0,y:0,w:W,h:H-wordsH-M*.6-gap}:{...side};
  // Magnified: the whole screen fills the far side, and the card this move crops and pushes into is the proof
  // lifted off it, on the near side under the words, overlapping the screen it came from.
  let whole=null;
  if(layout==="magnify"){
   // Under the words where they leave room for it. Where they do not, the screen takes the upper part of the far
   // side and the card the lower, overlapping it only at the seam: a card held small under five lines of words
   // once sat on the second of them, and one laid over the screen it came from hid the screen.
   const lw=Math.min(W*.5,side.w*.8),lh=H*.46,room=H-edge-(M*.8+wordsH+gap),under=room>=lh*.75;
   const holder=under?side:{x:side.x,y:side.y,w:side.w,h:side.h*.56};
   const fit=Math.min(holder.w/info.width,(holder.h-bar)/info.height),bw=info.width*fit,bh=info.height*fit;
   whole={x:holder.x+(holder.w-bw)/2,y:holder.y+bar+(under?(holder.h-bar-bh)/2:0),w:bw,h:bh,s:fit};
   area=under?{x:right?W-M-lw:M,y:H-edge-Math.min(lh,room),w:lw,h:Math.min(lh,room)}
    :{x:right?side.x:side.x+side.w*.16,y:Math.max(side.y+side.h*.5,whole.y+whole.h-side.h*.08),w:side.w*.84,h:side.y+side.h-Math.max(side.y+side.h*.5,whole.y+whole.h-side.h*.08)};
  }
  area.y+=bar;area.h-=bar;
  area.w=Math.max(120,area.w);area.h=Math.max(120,area.h);
  const border=o.border!=null?Math.max(0,num(o.border,10)):frame==="print"?10:frame==="taped"?14:frame==="torn"?16:0,aw=area.w-border*2,ah=area.h-border*2;
  // The crop: the region and a margin, kept inside the picture; widened round it where it would be
  // magnified past maxZoom.
  const region=typeof o.focus==="string"?info.regions.find((g)=>g.key===o.focus)??null:o.focus&&typeof o.focus==="object"?{x:num(o.focus.x,0),y:num(o.focus.y,0),width:num(o.focus.w??o.focus.width,info.width),height:num(o.focus.h??o.focus.height,info.height)}:null;
  const g=region??{x:0,y:0,width:info.width,height:info.height};
  const pad=num(o.pad,.12),cx=g.x+g.width/2,cy=g.y+g.height/2;
  let cw=Math.min(info.width,g.width*(1+pad*2)+24),ch=Math.min(info.height,g.height*(1+pad*2)+24);
  // A card no thinner than three to one, nor narrower than three to five: a strip of a crop is taken in with
  // the screen above and below it, where a picker's options once sat in a sliver of a card.
  if(cw/ch>3)ch=Math.min(info.height,cw/3);
  if(cw/ch<.6)cw=Math.min(info.width,ch*.6);
  const fit=(w,h)=>{const s=Math.min(aw/w,ah/h);return {s,w:w*s,h:h*s}};
  let card=fit(cw,ch);
  const maxZoom=Math.max(.2,num(o.maxZoom,2));
  if(card.s>maxZoom){
   // Widened in the region's own shape (within reason), so the card stays a strip round it rather than a
   // field of whatever is next to it.
   const a=Math.min(3,Math.max(1.3,cw/ch)),kw=a>aw/ah?aw:ah*a,kh=a>aw/ah?aw/a:ah;
   cw=Math.min(info.width,Math.max(cw,kw/maxZoom));ch=Math.min(info.height,Math.max(ch,kh/maxZoom));
   card=fit(cw,ch);
  }
  // Bled, or stacked wide under the words, the crop takes the band's own shape so the card covers it edge to edge,
  // as far as the picture goes.
  if(layout==="full"||layout==="stack"&&!upright){const a=aw/ah;if(cw/ch<a)cw=Math.min(info.width,ch*a);else ch=Math.min(info.height,cw/a);card=fit(cw,ch)}
  // Upright, the crop grows taller — more of the screen above and below the proof, up to a card of four by five —
  // so the card fills the column under the words: kept in a landscape crop's shape, a screen's card was a strip
  // across the top of a 9:16 frame with its lower half empty.
  else if(upright&&layout==="stack"){const a=Math.max(aw/ah,.8);if(cw/ch>a){ch=Math.min(info.height,cw/a);card=fit(cw,ch)}}
  const place=(w,h)=>({x:Math.min(Math.max(0,cx-w/2),info.width-w),y:Math.min(Math.max(0,cy-h/2),info.height-h),w,h});
  const tight=place(cw,ch);
  let ww=Math.min(info.width,cw*1.8),wh=ww*ch/cw;
  if(wh>info.height){wh=info.height;ww=wh*cw/ch}
  const wide=place(ww,wh);
  // A magnified card arrives once the screen it is lifted from has: everything of it is that much later.
  const lift=layout==="magnify"?.9:0,cardAt=at+lift;
  // The push in from the wider view, then a slow drift on in to the beat's end, so the card is never still.
  const push=curve(o.ease??"inOut")(span(t,cardAt+.35,cardAt+1.25)),drift=Math.min(.12,Math.max(0,num(o.drift,.05)),Math.max(0,1-card.s/maxZoom))*env.ease.inOut(span(t,cardAt+1.25,num(env.duration,cardAt+5)));
  const near={x:tight.x+tight.w*drift/2,y:tight.y+tight.h*drift/2,w:tight.w*(1-drift),h:tight.h*(1-drift)};
  const src={x:lerp(wide.x,near.x,push),y:lerp(wide.y,near.y,push),w:lerp(wide.w,near.w,push),h:lerp(wide.h,near.h,push)};
  const inner={x:area.x+border+(aw-card.w)/2,y:area.y+border+(ah-card.h)/2,w:card.w,h:card.h};
  if(layout==="stack")inner.y=area.y+border;
  const map=(sx,sy)=>[inner.x+(num(sx,0)-src.x)/src.w*inner.w,inner.y+(num(sy,0)-src.y)/src.h*inner.h];
  const rect=(r)=>{const q=typeof r==="string"?info.regions.find((k)=>k.key===r):r&&typeof r==="object"?{x:num(r.x,0),y:num(r.y,0),width:num(r.w??r.width,0),height:num(r.h??r.height,0)}:null;if(!q)return null;const [x1,y1]=map(q.x,q.y),[x2,y2]=map(q.x+q.width,q.y+q.height);return {x:x1,y:y1,w:x2-x1,h:y2-y1}};
  // A card, framed in the style's own way and grown in from its middle: its mount, border or window under it,
  // the picture clipped to it, and a ruled border or a drafting outline with its registration marks over it.
  const mount=(box,from,grown,shown)=>{
   // Taped: a white paper mount on a soft shadow. Glass: a frosted pane round the picture, catching the light.
   // A terminal window: a dark title bar with its prompt. A slab: the card a thick tile, its two edges showing.
   if(grown>0&&(frame==="taped"||frame==="glass"||frame==="console"||frame==="slab")){
    const fw=(box.w+border*2)*grown,fx=box.x-border+(box.w+border*2-fw)/2;
    ctx.save();
    if(frame==="taped"){ctx.shadowColor="rgba(0,0,0,0.22)";ctx.shadowBlur=22;ctx.shadowOffsetY=10;ctx.fillStyle=String(o.frame??"#fbfaf6");ctx.fillRect(fx,box.y-border,fw,box.h+border*2)}
    else if(frame==="glass"){const g=18,gw=(box.w+g*2)*grown,gx=box.x-g+(box.w+g*2-gw)/2;ctx.shadowColor="rgba(0,0,0,0.3)";ctx.shadowBlur=50;ctx.shadowOffsetY=20;ctx.fillStyle="rgba(255,255,255,0.14)";ctx.beginPath();rounded(ctx,gx,box.y-g,gw,box.h+g*2,22);ctx.fill();ctx.shadowColor="transparent";ctx.strokeStyle="rgba(255,255,255,0.38)";ctx.lineWidth=1.5;ctx.stroke()}
    else if(frame==="console"){
     ctx.fillStyle="#161a21";ctx.fillRect(fx,box.y-bar,fw,box.h+bar);ctx.strokeStyle="rgba(255,255,255,0.16)";ctx.lineWidth=1;ctx.strokeRect(fx+.5,box.y-bar+.5,fw-1,box.h+bar-1);
     if(grown>=1){["#ff5f57","#febc2e","#28c840"].forEach((dot,n)=>{ctx.fillStyle=dot;ctx.globalAlpha=.7;ctx.beginPath();ctx.arc(fx+20+n*18,box.y-bar/2,5,0,Math.PI*2);ctx.fill()});ctx.globalAlpha=1;ctx.fillStyle="rgba(255,255,255,0.55)";ctx.font="500 15px \""+env.mono+"\"";ctx.textAlign="left";ctx.textBaseline="middle";ctx.fillText("~/"+text(o.key,32)+" — zsh",fx+82,box.y-bar/2)}
    }
    else{const d=Math.max(14,Math.min(box.w,box.h)*.06)*grown;ctx.fillStyle=String(o.frame??accent);ctx.beginPath();ctx.moveTo(fx+fw,box.y);ctx.lineTo(fx+fw+d,box.y+d);ctx.lineTo(fx+fw+d,box.y+box.h+d);ctx.lineTo(fx+d,box.y+box.h+d);ctx.lineTo(fx,box.y+box.h);ctx.lineTo(fx+fw,box.y+box.h);ctx.closePath();ctx.fill();ctx.fillStyle="rgba(0,0,0,0.28)";ctx.beginPath();ctx.moveTo(fx,box.y+box.h);ctx.lineTo(fx+d,box.y+box.h+d);ctx.lineTo(fx+fw+d,box.y+box.h+d);ctx.lineTo(fx+fw,box.y+box.h);ctx.closePath();ctx.fill()}
    ctx.restore();
   }
   // Riso: a block of the accent printed off register under it. Brutal: a hard ink shadow. Bauhaus: a bar of the
   // accent down its near side. Torn: a paper mount torn round it.
   if(grown>0&&(frame==="riso"||frame==="brutal"||frame==="bauhaus"||frame==="torn")){
    const fw=(box.w+border*2)*grown,fx=box.x-border+(box.w+border*2-fw)/2;
    ctx.save();
    if(frame==="riso"){ctx.globalCompositeOperation=lightness(pal.background)>.42?"multiply":"screen";ctx.fillStyle=String(o.frame??accent);ctx.fillRect(fx+18,box.y+18,fw,box.h)}
    else if(frame==="brutal"){ctx.fillStyle=String(o.frame??pal.ink);ctx.fillRect(fx+18,box.y+18,fw,box.h)}
    else if(frame==="bauhaus"){ctx.fillStyle=String(o.frame??accent);ctx.fillRect(fx-26,box.y,26,box.h*grown)}
    else{ctx.shadowColor="rgba(0,0,0,0.25)";ctx.shadowBlur=18;ctx.shadowOffsetY=8;ctx.fillStyle=String(o.frame??"#fbfaf6");torn(ctx,fx,box.y-border,fw,box.h+border*2,Math.round(box.x+box.y),8);ctx.fill()}
    ctx.restore();
   }
   if(grown>0&&(frame==="print"||frame==="window")){
    const fw=(box.w+border*2)*grown,fx=box.x-border+(box.w+border*2-fw)/2;
    ctx.save();
    if(frame==="print"){ctx.fillStyle="rgba(0,0,0,0.3)";ctx.fillRect(fx+16,box.y-border+20,fw,box.h+border*2);ctx.fillStyle=String(o.frame??"#ffffff");ctx.fillRect(fx,box.y-border,fw,box.h+border*2)}
    else{
     ctx.shadowColor="rgba(0,0,0,0.38)";ctx.shadowBlur=60;ctx.shadowOffsetY=26;ctx.fillStyle=String(o.frame??"#e9ebf0");
     ctx.beginPath();rounded(ctx,fx,box.y-bar,fw,box.h+bar,14);ctx.fill();ctx.shadowColor="transparent";
     if(grown>=1)["#ff5f57","#febc2e","#28c840"].forEach((dot,n)=>{ctx.fillStyle=dot;ctx.beginPath();ctx.arc(fx+24+n*22,box.y-bar/2,6.5,0,Math.PI*2);ctx.fill()});
    }
    ctx.restore();
   }
   if(shown>0){
    ctx.save();ctx.beginPath();
    if(frame==="window")rounded(ctx,box.x,box.y,box.w,box.h,[0,0,14,14]);else if(frame==="glass")rounded(ctx,box.x,box.y,box.w,box.h,12);else if(frame==="neon")rounded(ctx,box.x,box.y,box.w,box.h,16);else ctx.rect(box.x,box.y,box.w,box.h);
    ctx.clip();ctx.globalAlpha=shown;
    ctx.fillStyle="#0b0d12";ctx.fillRect(box.x,box.y,box.w,box.h);
    env.drawScreen(ctx,o.key,box.x,box.y,box.w,box.h,from.x,from.y,from.w,from.h);ctx.restore();
   }
   if(grown>=1&&frame==="taped"){
    ctx.save();ctx.fillStyle="rgba(236,226,190,0.78)";
    for(const [px,py,a] of [[box.x-border+6,box.y-border+4,-.6],[box.x+box.w+border-6,box.y-border+4,.6]]){ctx.save();ctx.translate(px,py);ctx.rotate(a);ctx.fillRect(-46,-12,92,24);ctx.restore()}
    ctx.restore();
   }
   if(grown>=1&&frame==="slab"){ctx.save();ctx.strokeStyle=String(o.frame??accent);ctx.lineWidth=2;ctx.strokeRect(box.x,box.y,box.w,box.h);ctx.restore()}
   // Over it: a riso's ink keyline, off register; brutal's heavy rule; the Bauhaus's disc of the second colour on
   // its far corner; a neon tube round it; or a magazine's hairline and caption under it.
   if(grown>0&&(frame==="riso"||frame==="brutal"||frame==="bauhaus"||frame==="neon"||frame==="caption")){
    const fw=box.w*grown,fx=box.x+(box.w-fw)/2;
    ctx.save();
    if(frame==="riso"){ctx.strokeStyle=String(pal.ink);ctx.lineWidth=2.5;ctx.strokeRect(fx-5,box.y-4,fw,box.h)}
    else if(frame==="brutal"){ctx.strokeStyle=String(pal.ink);ctx.lineWidth=6;ctx.strokeRect(fx,box.y,fw,box.h)}
    else if(frame==="bauhaus"){if(grown>=1){const r=Math.min(box.w,box.h)*.1*env.ease.back(span(t,at+.5,at+.9));ctx.fillStyle=String(pal.second);ctx.beginPath();ctx.arc(box.x+box.w,box.y,Math.max(0,r),0,Math.PI*2);ctx.fill()}}
    else if(frame==="neon"){ctx.strokeStyle=String(o.frame??accent);ctx.shadowColor=String(o.frame??accent);ctx.shadowBlur=28;ctx.lineWidth=4;ctx.beginPath();rounded(ctx,fx-6,box.y-6,fw+12,box.h+12,20);ctx.stroke()}
    else{ctx.fillStyle=ink;ctx.fillRect(fx,box.y+box.h+14,fw,1.5);if(grown>=1){ctx.globalAlpha=.7;ctx.font="400 20px \""+family(o.font,env.font)+"\"";ctx.textAlign="left";ctx.textBaseline="top";ctx.fillText("Above \u2014 "+text(o.key,32),box.x,box.y+box.h+24)}}
    ctx.restore();
   }
   if(grown>0&&(frame==="flat"||frame==="outline")){
    const line=String(o.frame??ink),fw=box.w*grown,fx=box.x+(box.w-fw)/2;
    ctx.save();ctx.strokeStyle=line;ctx.lineWidth=frame==="flat"?5:2;ctx.strokeRect(fx,box.y,fw,box.h);
    if(frame==="outline"&&grown>=1){
     const s=20,k=10;ctx.beginPath();
     for(const [px,py,dx,dy] of [[box.x,box.y,-1,-1],[box.x+box.w,box.y,1,-1],[box.x,box.y+box.h,-1,1],[box.x+box.w,box.y+box.h,1,1]]){ctx.moveTo(px+dx*k,py);ctx.lineTo(px+dx*(k+s),py);ctx.moveTo(px,py+dy*k);ctx.lineTo(px,py+dy*(k+s))}
     ctx.stroke();
     ctx.font="500 18px \""+env.mono+"\"";ctx.fillStyle=line;ctx.textAlign="left";ctx.textBaseline="alphabetic";ctx.fillText("FIG. "+text(o.key,24).toUpperCase(),box.x,box.y-16);
    }
    ctx.restore();
   }
  };
  // The proof picked out in the style's mark: an outline drawing round it, a heavy bar under it, a dashed
  // rule, a wash, or the rest of the card dimmed round it so it is the one lit thing.
  const mark=(r,from,main)=>{
   const kind=main?style.mark:style.mark==="spotlight"?"outline":style.mark,u=env.ease.expoOut(span(t,from,from+.4));
   if(u<=0)return;
   if(kind==="outline")highlight(ctx,t,{...r,at:from,duration:main?.4:.3,style:"outline",color:accent,width:main?4:3,pad:main?6:5});
   else if(kind==="circle"){ctx.save();ctx.strokeStyle=accent;ctx.lineWidth=main?5:3.5;ctx.lineCap="round";ctx.lineJoin="round";loop(ctx,r.x+r.w/2,r.y+r.h/2,r.w/2+16,r.h/2+14,env.ease.out(span(t,from,from+.55)),Math.round(r.x+r.y));ctx.restore()}
   else if(kind==="underline"){ctx.save();ctx.fillStyle=accent;ctx.fillRect(r.x-4,Math.min(r.y+r.h+6,inner.y+inner.h-10),(r.w+8)*u,main?10:7);ctx.restore()}
   // A box ruled hard round it, there at once.
   else if(kind==="hardbox"){ctx.save();ctx.strokeStyle=accent;ctx.lineWidth=main?7:5;ctx.strokeRect(r.x-8,r.y-8,r.w+16,r.h+16);ctx.restore()}
   // A neon tube round it, glowing.
   else if(kind==="neon"){ctx.save();ctx.strokeStyle=accent;ctx.shadowColor=accent;ctx.shadowBlur=22;ctx.lineWidth=main?4:3;ctx.globalAlpha=u;ctx.beginPath();rounded(ctx,r.x-8,r.y-8,r.w+16,r.h+16,14);ctx.stroke();ctx.restore()}
   else if(kind==="dashed"){ctx.save();ctx.strokeStyle=accent;ctx.lineWidth=main?3:2;ctx.setLineDash([12,8]);ctx.globalAlpha=u;ctx.strokeRect(r.x-6,r.y-6,r.w+12,r.h+12);ctx.restore()}
   else if(kind==="fill"){highlight(ctx,t,{...r,at:from,duration:.4,style:"fill",color:accent,pad:6});highlight(ctx,t,{...r,at:from,duration:.4,style:"outline",color:accent,width:3,pad:6})}
   else{
    ctx.save();ctx.fillStyle="rgba(5,7,12,"+(.55*u)+")";ctx.beginPath();ctx.rect(inner.x,inner.y,inner.w,inner.h);rounded(ctx,r.x-8,r.y-8,r.w+16,r.h+16,12);ctx.fill("evenodd");
    ctx.strokeStyle=accent;ctx.lineWidth=3;ctx.globalAlpha=u;ctx.beginPath();rounded(ctx,r.x-8,r.y-8,r.w+16,r.h+16,12);ctx.stroke();ctx.restore();
   }
  };
  // The card's entrance: its frame grows from the middle ("grow"), or the whole card pops in, slides in from
  // its side of the frame, or rises from below. A magnified card always pops, off the screen it is lifted from.
  const enter=o.enter==="pop"||o.enter==="slide"||o.enter==="rise"?o.enter:"grow";
  const arrive=enter==="grow"?1:curve(enter==="pop"?"back":"expoOut")(span(t,at,at+.55));
  if(enter!=="grow"&&span(t,at,at+.55)<=0)return {x:inner.x,y:inner.y,w:inner.w,h:inner.h,source:src,map,rect,focus:null,done:cardAt+1.9};
  // A mark mostly outside the crop is left out rather than squeezed into a sliver at the card's edge.
  const within=(r)=>{if(!r)return null;const x=Math.max(r.x,inner.x+4),y=Math.max(r.y,inner.y+4),w=Math.min(r.x+r.w,inner.x+inner.w-4)-x,h=Math.min(r.y+r.h,inner.y+inner.h-4)-y;return w>0&&h>0&&w*h>=.6*r.w*r.h?{x,y,w,h}:null};
  ctx.save();
  const anchor=whole??inner;
  if(enter==="pop"){const px=anchor.x+anchor.w/2,py=anchor.y+anchor.h/2,k=lerp(.55,1,arrive);ctx.translate(px,py);ctx.rotate((1-Math.min(1,arrive))*-.08);ctx.scale(k,k);ctx.translate(-px,-py)}
  else if(enter==="slide")ctx.translate((1-arrive)*(anchor.x+anchor.w/2>W/2?W-anchor.x+60:-(anchor.x+anchor.w+60)),0);
  else if(enter==="rise")ctx.translate(0,(1-arrive)*(H-anchor.y+60));
  const grow=(from)=>enter==="grow"?env.ease.expoOut(span(t,from,from+.35)):1,show=(from)=>enter==="grow"?span(t,from+.25,from+.45):1;
  let focus=null;
  if(whole){
   // The screen it is lifted from, whole and still, the proof outlined on it; then the lines of the lift.
   mount(whole,{x:0,y:0,w:info.width,h:info.height},grow(at),show(at));
   const on=region?{x:whole.x+g.x*whole.s,y:whole.y+g.y*whole.s,w:g.width*whole.s,h:g.height*whole.s}:null;
   if(on)highlight(ctx,t,{...on,at:at+.6,duration:.35,style:"outline",color:accent,width:3,pad:4});
   const cone=env.ease.out(span(t,cardAt,cardAt+.45));
   if(on&&cone>0){
    ctx.save();ctx.strokeStyle=accent;ctx.lineWidth=2;ctx.globalAlpha=.75*cone;ctx.beginPath();
    for(const [ax,ay,bx,by] of [[on.x,on.y,inner.x,inner.y],[on.x+on.w,on.y,inner.x+inner.w,inner.y],[on.x,on.y+on.h,inner.x,inner.y+inner.h],[on.x+on.w,on.y+on.h,inner.x+inner.w,inner.y+inner.h]]){ctx.moveTo(ax,ay);ctx.lineTo(lerp(ax,bx,cone),lerp(ay,by,cone))}
    ctx.stroke();ctx.restore();
   }
   // Its span, not its curve, says whether it has begun: the curve's overshoot is not quite nothing at its start.
   const lifted=span(t,cardAt,cardAt+.5);
   if(lifted>0){
    const px=inner.x+inner.w/2,py=inner.y+inner.h/2,k=lerp(.4,1,env.ease.back(lifted));
    ctx.save();ctx.translate(px,py);ctx.scale(k,k);ctx.translate(-px,-py);
    mount(inner,src,1,1);
    focus=region?within(rect(region)):null;
    if(focus)mark(focus,cardAt+1.3,true);
    ctx.restore();
   }
  }
  else{
   mount(inner,src,grow(at),show(at));
   focus=region?within(rect(region)):null;
   if(focus)mark(focus,at+1.3,true);
  }
  (Array.isArray(o.marks)?o.marks:[]).slice(0,6).forEach((key,n)=>{const r=within(rect(key));if(r)mark(r,cardAt+1.9+n*.15,false)});
  ctx.restore();
  // The words, and a leader from the headline into the region where the style draws one.
  const below=layout==="full",wx=right&&!across?W-M:right&&below?W-M:M,align=right&&(!across||below)?"right":"left";
  // Magnified, the lifted card sits under the words, in room measured from the frame's head: set level with the
  // whole screen's top instead, the words came down onto the card and its second line was set across it.
  const above=layout==="magnify"&&area.x<(right?W:M+wordsW)&&area.x+area.w>(right?W-M-wordsW:0)?area.y-gap-wordsH:Infinity;
  const wy=layout==="stack"?M:below?H-M*.6-wordsH:Math.max(M*.8,Math.min((whole??inner).y,H-M-wordsH,above));
  const said=o.text?words(ctx,t,{...head,x:wx,y:wy,at:at+.1,align}):headBox;
  const subAt=Math.max(at+1.7,num(said.done,0)+.25);
  if(o.sub)words(ctx,t,{...sub,x:wx,y:wy+headBox.height+subSize*.6,at:subAt,align});
  if(focus&&o.text&&o.leader!==false&&style.leader!=="none"&&!whole){
   const fx=focus.x+focus.w/2;
   let points;
   if(layout==="stack"){const sx=M+Math.min(headBox.width,wordsW)*.5,ey=focus.y-10;points=[[sx,wy+wordsH+14],[sx,(wy+wordsH+ey)/2],[fx,(wy+wordsH+ey)/2],[fx,ey]]}
   else if(below){const sx=right?W-M-Math.min(headBox.width,wordsW)*.5:M+Math.min(headBox.width,wordsW)*.5,ey=focus.y+focus.h+10;points=[[sx,wy-14],[sx,(wy+ey)/2],[fx,(wy+ey)/2],[fx,ey]]}
   else{const sy=wy+size*.5,sx=right?W-M-headBox.width-18:M+headBox.width+18,ex=right?focus.x+focus.w+10:focus.x-10,ey=focus.y+focus.h/2,mx=(sx+ex)/2;points=[[sx,sy],[mx,sy],[mx,ey],[ex,ey]]}
   lead(ctx,t,points,{at:cardAt+1.45,duration:.45,color:accent,width:4});
  }
  return {x:inner.x,y:inner.y,w:inner.w,h:inner.h,source:src,map,rect,focus,done:Math.max(subAt+(o.sub?.6:0),cardAt+1.9+(Array.isArray(o.marks)?Math.min(6,o.marks.length)*.15:0))};
 }

 // A leader in the style's own way: an elbowed line that draws itself onto a dot, one straight line onto a
 // dot, or a straight line between two rings, the draughtsman's.
 function lead(ctx,t,points,o={}){
  pal=tone(t);
  if(!Array.isArray(points)||points.length<2)return 0;
  if(style.leader==="elbow"||style.leader==="none")return connector(ctx,t,{...o,points});
  // An arrow drawn by hand from the words to the proof: one bowed stroke and its head, drawn on.
  if(style.leader==="arrow"){
   const at=num(o.at,0),p=env.ease.inOut(span(t,at,at+num(o.duration,.6)));
   if(p<=0)return p;
   const [a,b]=[points[0],points[points.length-1]];
   ctx.save();ctx.strokeStyle=String(o.color??pal.ink);ctx.lineWidth=num(o.width,3);ctx.lineCap="round";ctx.lineJoin="round";
   const {end,dir}=scrawl(ctx,[a,[(a[0]+b[0])/2+(b[1]-a[1])*.12,(a[1]+b[1])/2-(b[0]-a[0])*.12],b],p,Math.round(a[0]+b[1]),12);
   if(p>.92){const s=Math.max(12,num(o.width,3)*5),ang=Math.atan2(dir[1],dir[0]);ctx.beginPath();ctx.moveTo(end[0]-Math.cos(ang-.45)*s,end[1]-Math.sin(ang-.45)*s);ctx.lineTo(end[0],end[1]);ctx.lineTo(end[0]-Math.cos(ang+.45)*s,end[1]-Math.sin(ang+.45)*s);ctx.stroke()}
   ctx.restore();
   return p;
  }
  const ends=[points[0],points[points.length-1]],node=style.leader==="node";
  const p=connector(ctx,t,{...o,points:ends,dot:node?false:o.dot});
  if(node){
   const begun=span(t,num(o.at,0),num(o.at,0)+.25),ring=env.ease.back(begun),r=Math.max(5,num(o.width,2)*2.2);
   if(begun>0){ctx.save();ctx.strokeStyle=String(o.color??pal.ink);ctx.lineWidth=num(o.width,2);ctx.fillStyle=String(pal.background);
    for(const [px,py] of p>=1?ends:[ends[0]]){ctx.beginPath();ctx.arc(px,py,r*ring,0,Math.PI*2);ctx.fill();ctx.stroke()}ctx.restore()}
  }
  return p;
 }

 // The film's field, never flat: its colour, and a printed texture that drifts slowly so no frame is dead —
 // halftone spheres off the corners (placed by seed, so each beat's differ), a ruled grid, or none.
 function field(ctx,t,o={}){
  // The field drawn for this moment, in the film's colours: only then do the moves reverse out of a cut. A program
  // that paints its own field, or this one in a colour of its own, gets no reversal: its words stay ink rather
  // than turning the field's colour on a field that never cut.
  cutAt=o.color==null?num(t,NaN):NaN;
  pal=tone(t);
  // A frame starts here: no view from the last one stands.
  views.length=0;
  (()=>{
   ctx.save();ctx.fillStyle=String(o.color??pal.background);ctx.fillRect(0,0,env.width,env.height);ctx.restore();
   // The print in the shade that shows on the field: dark on a light field, light on a dark one, where a
   // black print on a deep blue was invisible.
   const hex=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(o.color??pal.background));
   const rgb=hex?(hex[1].length===3?hex[1].split("").map((c)=>parseInt(c+c,16)):[0,2,4].map((k)=>parseInt(hex[1].slice(k,k+2),16))):[255,255,255];
   const light=(.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2])/255>.42;
   // The texture asked for, or the style's own: halftone spheres, a ruled grid, column rules, soft glows of
   // the film's colours, a drafting grid, or none.
   const textures=["halftone","grid","none","rules","glow","blueprint","paper","aurora","scanlines","isogrid","riso","raw","shapes","tubes","scraps","folio"];
   const texture=textures.includes(o.texture)?o.texture:style.texture,seed=Math.floor(num(o.seed,0));
   const ink=String(o.ink??(light?"rgba(0,0,0,0.24)":"rgba(255,255,255,0.3)"));
   const dx=Math.sin(num(t,0)*.4+seed)*16,dy=num(t,0)*7;
   // Soft light of the film's own colours pooling off the corners, placed by seed: the studio's backdrop.
   if(texture==="glow"){
    for(let n=0;n<2;n++){
     const corner=Math.floor(env.random(seed*5+n)*4),gx=(corner%2?env.width*.85:env.width*.15)+dx*(n?-1.5:1.5),gy=(corner>1?env.height*.9:env.height*.1)+dy*(n?-.6:.6),r=env.height*(.75+env.random(seed*5+n+2)*.35);
     const glow=ctx.createRadialGradient(gx,gy,0,gx,gy,r);glow.addColorStop(0,String(n?pal.second:pal.accent));glow.addColorStop(1,"rgba(0,0,0,0)");
     ctx.save();ctx.globalAlpha=n?.22:.34;ctx.fillStyle=glow;ctx.fillRect(0,0,env.width,env.height);ctx.restore();
    }
   }
   // Paper: a pencil grain of short fibres, laid by seed and still, as a page is.
   if(texture==="paper"){
    ctx.save();ctx.strokeStyle=String(o.ink??(light?"rgba(40,32,20,0.07)":"rgba(255,255,255,0.06)"));ctx.lineWidth=1.2;ctx.beginPath();
    for(let k=0;k<700;k++){const px=env.random(seed*31+k)*env.width,py=env.random(seed*37+k+1)*env.height,a=env.random(seed*41+k+2)*Math.PI,l=4+env.random(seed*43+k+3)*10;ctx.moveTo(px,py);ctx.lineTo(px+Math.cos(a)*l,py+Math.sin(a)*l)}
    ctx.stroke();ctx.restore();
   }
   // Aurora: three broad washes of the film's colours drifting slowly across the field, light added to it.
   if(texture==="aurora"){
    const tt=num(t,0);
    ctx.save();ctx.globalCompositeOperation=light?"multiply":"lighter";
    [pal.accent,pal.second,pal.muted].forEach((c,n)=>{
     const ox=env.width*(.2+.6*env.random(seed*11+n))+Math.sin(tt*.35+n*2.1)*env.width*.12,oy=env.height*(.25+.5*env.random(seed*13+n))+Math.cos(tt*.28+n*1.7)*env.height*.1,r=env.height*(.7+.3*env.random(seed*17+n));
     const wash=ctx.createRadialGradient(ox,oy,0,ox,oy,r);wash.addColorStop(0,String(c));wash.addColorStop(1,"rgba(0,0,0,0)");
     ctx.globalAlpha=light?.35:.42-n*.08;ctx.fillStyle=wash;ctx.fillRect(0,0,env.width,env.height);
    });
    ctx.restore();
   }
   // Scanlines: a CRT's fine horizontal lines and its darkened edges, the lines breathing very slightly.
   if(texture==="scanlines"){
    ctx.save();ctx.fillStyle=String(o.ink??(light?"rgba(0,0,0,0.05)":"rgba(255,255,255,0.045)"));ctx.globalAlpha=.85+.15*Math.sin(num(t,0)*9);
    for(let y=0;y<env.height;y+=4)ctx.fillRect(0,y,env.width,1.5);
    ctx.globalAlpha=1;const edge=ctx.createRadialGradient(env.width/2,env.height/2,Math.min(env.width,env.height)*.35,env.width/2,env.height/2,Math.max(env.width,env.height)*.75);
    edge.addColorStop(0,"rgba(0,0,0,0)");edge.addColorStop(1,light?"rgba(0,0,0,0.18)":"rgba(0,0,0,0.55)");ctx.fillStyle=edge;ctx.fillRect(0,0,env.width,env.height);ctx.restore();
   }
   // An isometric grid: lines at thirty degrees each way, drifting with the field.
   if(texture==="isogrid"){
    const step=num(o.step,64),k=Math.tan(Math.PI/6),reach=env.width*k+env.height;
    ctx.save();ctx.strokeStyle=String(o.ink??(light?"rgba(0,0,0,0.08)":"rgba(255,255,255,0.08)"));ctx.lineWidth=1;ctx.beginPath();
    for(let c=-reach;c<=reach;c+=step){const off=c+dy*.5;ctx.moveTo(0,off);ctx.lineTo(env.width,off+env.width*k);ctx.moveTo(0,off+env.width*k);ctx.lineTo(env.width,off)}
    ctx.stroke();ctx.restore();
   }
   // Riso: two discs of the film's inks overprinted off one corner, a little off register, and the paper's grain.
   if(texture==="riso"){
    const corner=Math.floor(env.random(seed*23)*4),r=env.height*(.34+.12*env.random(seed*19)),ox=(corner%2?env.width*.94:env.width*.06)+dx,oy=(corner>1?env.height*.94:env.height*.06)+dy*.4,inward=[corner%2?-1:1,corner>1?-1:1];
    ctx.save();ctx.globalCompositeOperation=light?"multiply":"screen";ctx.globalAlpha=.85;
    [[pal.accent,0],[pal.second,1]].forEach(([c,n])=>{ctx.fillStyle=String(c);ctx.beginPath();ctx.arc(ox+inward[0]*r*.55*n,oy+inward[1]*r*.35*n,r,0,Math.PI*2);ctx.fill()});
    ctx.restore();
    ctx.save();ctx.fillStyle=String(o.ink??(light?"rgba(30,20,10,0.16)":"rgba(255,255,255,0.12)"));
    for(let k=0;k<1200;k++)ctx.fillRect(env.random(seed*29+k)*env.width,env.random(seed*31+k+1)*env.height,1.6,1.6);
    ctx.restore();
   }
   // Raw: heavy rules across the head and foot of the frame, and its index and running time set in mono on them.
   if(texture==="raw"){
    ctx.save();ctx.fillStyle=String(pal.ink);ctx.fillRect(0,48,env.width,6);ctx.fillRect(0,env.height-54,env.width,6);
    ctx.font="700 20px \""+env.mono+"\"";ctx.textBaseline="alphabetic";ctx.fillText("["+String(seed).padStart(2,"0")+"]",96,36);
    ctx.textAlign="right";ctx.fillText("T+"+num(t,0).toFixed(2),env.width-96,36);ctx.fillText("///",env.width-96,env.height-18);ctx.restore();
   }
   // Shapes: the Bauhaus's primaries — a disc of the accent off one corner and a triangle of the second colour off
   // the one across from it, turning slowly.
   if(texture==="shapes"){
    const corner=Math.floor(env.random(seed*23)*4),at=(c)=>[c%2?env.width*.95:env.width*.05,c>1?env.height*.95:env.height*.05],[cx,cy]=at(corner),[tx,ty]=at(3-corner),r=env.height*.3;
    ctx.save();ctx.fillStyle=String(pal.accent);ctx.beginPath();ctx.arc(cx+dx,cy+dy*.4,r,0,Math.PI*2);ctx.fill();
    ctx.translate(tx-dx,ty-dy*.4);ctx.rotate(num(t,0)*.06+seed);ctx.fillStyle=String(pal.second);ctx.beginPath();
    for(let k=0;k<3;k++){const a=k/3*Math.PI*2-Math.PI/2;if(k)ctx.lineTo(Math.cos(a)*r*1.1,Math.sin(a)*r*1.1);else ctx.moveTo(Math.cos(a)*r*1.1,Math.sin(a)*r*1.1)}
    ctx.closePath();ctx.fill();ctx.restore();
   }
   // Tubes: a brick wall a sign hangs on, faint, and the haze of the accent rising off the foot of the frame.
   if(texture==="tubes"){
    ctx.save();ctx.strokeStyle=String(o.ink??(light?"rgba(0,0,0,0.07)":"rgba(255,255,255,0.05)"));ctx.lineWidth=1.5;ctx.beginPath();
    for(let row=0,y=0;y<env.height;row++,y+=44){ctx.moveTo(0,y+.5);ctx.lineTo(env.width,y+.5);for(let x=(row%2)*60;x<env.width;x+=120){ctx.moveTo(x+.5,y);ctx.lineTo(x+.5,y+44)}}
    ctx.stroke();
    const haze=ctx.createRadialGradient(env.width/2,env.height*1.1,0,env.width/2,env.height*1.1,env.height*.9);haze.addColorStop(0,String(pal.accent));haze.addColorStop(1,"rgba(0,0,0,0)");
    ctx.globalAlpha=.22+.03*Math.sin(num(t,0)*3);ctx.fillStyle=haze;ctx.fillRect(0,0,env.width,env.height);ctx.restore();
   }
   // Scraps: torn pieces of coloured paper pasted on round the edges at their own angles.
   if(texture==="scraps"){
    const papers=[pal.accent,pal.second,"#fbfaf6","#ece1c4"];
    for(let n=0;n<4;n++){
     const edge=(Math.floor(env.random(seed*13)*4)+n)%4,w=env.width*(.16+.12*env.random(seed*17+n)),h=env.height*(.22+.14*env.random(seed*19+n));
     const along=.15+.7*env.random(seed*21+n),px=edge===1?env.width:edge===3?0:env.width*along,py=edge===0?0:edge===2?env.height:env.height*along;
     ctx.save();ctx.translate(px+dx*.5,py+dy*.3);ctx.rotate((env.random(seed*27+n)-.5)*.7);
     ctx.shadowColor="rgba(0,0,0,0.22)";ctx.shadowBlur=12;ctx.shadowOffsetY=5;ctx.fillStyle=String(papers[n]);torn(ctx,-w/2,-h/2,w,h,seed*37+n*101,7);ctx.fill();ctx.restore();
    }
   }
   // A folio: hairlines at the head and foot of the page, the issue on the left and the page's number on the right.
   if(texture==="folio"){
    ctx.save();ctx.fillStyle=String(pal.ink);ctx.globalAlpha=.55;ctx.fillRect(96,58,env.width-192,1.5);ctx.fillRect(96,env.height-58,env.width-192,1.5);
    ctx.font="500 17px \""+env.mono+"\"";ctx.textBaseline="alphabetic";ctx.fillText("VOL. 1 \u2014 THE LAUNCH ISSUE",96,46);ctx.textAlign="right";ctx.fillText("p. "+(seed*2+10),env.width-96,46);ctx.restore();
   }
   // A sphere: one large object in the composition, not texture, behind and beside the words — where the films
   // it is measured against put one. In print a halftone ball; in the other styles their own: a flat disc, a
   // pool of light, a drafted circle with its centre and radius; kinetic type stands alone. true places it low
   // on the right.
   if(o.sphere&&style.texture!=="none"){
    const q=typeof o.sphere==="object"?o.sphere:{},r=num(q.r,env.height*.36),sx=num(q.x,env.width*.78)+dx*.5,sy=num(q.y,env.height*.6)+dy*.3;
    if(style.texture==="halftone")stipple(ctx,{x:sx,y:sy,r,step:Math.max(3,r/70),dot:Math.max(2,r/(light?150:110)),color:String(q.color??(light?"rgba(0,0,0,0.62)":"rgba(255,255,255,0.8)")),light:q.light??[-.55,-.6],seed:seed*3+1});
    // Swiss's disc is solid, not print: left where a halftone ball sits it lay under cards and words, so unplaced
    // it bleeds off the frame's lower right corner, the poster's ornament rather than a ground for the content.
    else if(style.texture==="rules"){const dr=num(q.r,env.height*.5),ox=num(q.x,env.width*.95)+dx*.5,oy=num(q.y,env.height*1.02)+dy*.3;ctx.save();ctx.fillStyle=String(q.color??pal.accent);ctx.beginPath();ctx.arc(ox,oy,dr,0,Math.PI*2);ctx.fill();ctx.restore()}
    else if(style.texture==="glow"){const pool=ctx.createRadialGradient(sx,sy,0,sx,sy,r*1.4);pool.addColorStop(0,String(q.color??pal.accent));pool.addColorStop(1,"rgba(0,0,0,0)");ctx.save();ctx.globalAlpha=.5;ctx.fillStyle=pool;ctx.fillRect(0,0,env.width,env.height);ctx.restore()}
    // A ball scribbled in pencil: three loose loops round one centre.
    else if(style.texture==="paper"){ctx.save();ctx.strokeStyle=String(q.color??(light?"rgba(30,26,20,0.5)":"rgba(255,255,255,0.55)"));ctx.lineWidth=2.4;ctx.lineCap="round";for(let n=0;n<3;n++)loop(ctx,sx,sy,r*(.8-n*.04),r*(.76-n*.05),1,seed*5+n*17);ctx.restore()}
    // A glowing orb: white at its heart, the accent round it, fading into the field.
    else if(style.texture==="aurora"){const orb=ctx.createRadialGradient(sx-r*.25,sy-r*.3,0,sx,sy,r);orb.addColorStop(0,"rgba(255,255,255,0.95)");orb.addColorStop(.35,String(q.color??pal.accent));orb.addColorStop(1,"rgba(0,0,0,0)");ctx.save();ctx.globalAlpha=.85;ctx.fillStyle=orb;ctx.beginPath();ctx.arc(sx,sy,r,0,Math.PI*2);ctx.fill();ctx.restore()}
    // A ring of mono figures turning slowly, a terminal's ornament.
    else if(style.texture==="scanlines"){
     const count=40,turn=num(t,0)*.15;ctx.save();ctx.fillStyle=String(q.color??pal.accent);ctx.globalAlpha=.55;ctx.font="500 "+Math.round(r*.11)+"px \""+env.mono+"\"";ctx.textAlign="center";ctx.textBaseline="middle";
     for(let n=0;n<count;n++){const a=turn+n/count*Math.PI*2;ctx.fillText(env.random(seed*3+n)<.5?"0":"1",sx+Math.cos(a)*r*.85,sy+Math.sin(a)*r*.85)}
     ctx.restore();
    }
    // A wireframe cube in isometric, bobbing slowly.
    else if(style.texture==="isogrid"){
     const e=r*.62,cy=sy+Math.sin(num(t,0)*.8)*r*.04,c=Math.cos(Math.PI/6)*e,h=e*.5;
     const top=[[sx,cy-e],[sx+c,cy-e+h],[sx,cy],[sx-c,cy-e+h]],bottom=top.map(([px,py])=>[px,py+e]);
     ctx.save();ctx.strokeStyle=String(q.color??(light?"rgba(0,0,0,0.45)":"rgba(255,255,255,0.5)"));ctx.lineWidth=2;ctx.beginPath();
     for(const face of [top,bottom]){face.forEach(([px,py],k)=>{if(k)ctx.lineTo(px,py);else ctx.moveTo(px,py)});ctx.closePath()}
     for(let k=0;k<4;k++){ctx.moveTo(top[k][0],top[k][1]);ctx.lineTo(bottom[k][0],bottom[k][1])}
     ctx.stroke();ctx.restore();
    }
    // Two discs of the inks overprinted, off register.
    else if(style.texture==="riso"){ctx.save();ctx.globalCompositeOperation=light?"multiply":"screen";ctx.globalAlpha=.9;ctx.fillStyle=String(q.color??pal.accent);ctx.beginPath();ctx.arc(sx,sy,r,0,Math.PI*2);ctx.fill();ctx.fillStyle=String(pal.second);ctx.beginPath();ctx.arc(sx-r*.22,sy-r*.14,r*.82,0,Math.PI*2);ctx.fill();ctx.restore()}
    // A hard block of the accent ruled in ink, bled off the frame's lower right.
    else if(style.texture==="raw"){const bx=num(q.x,env.width*.7)+dx*.5,by=num(q.y,env.height*.58)+dy*.3;ctx.save();ctx.fillStyle=String(q.color??pal.accent);ctx.fillRect(bx,by,env.width,env.height);ctx.strokeStyle=String(pal.ink);ctx.lineWidth=8;ctx.strokeRect(bx,by,env.width,env.height);ctx.restore()}
    // A disc halved, the accent over the ink, as on a Bauhaus poster.
    else if(style.texture==="shapes"){ctx.save();ctx.fillStyle=String(q.color??pal.accent);ctx.beginPath();ctx.arc(sx,sy,r,Math.PI,Math.PI*2);ctx.closePath();ctx.fill();ctx.fillStyle=String(pal.ink);ctx.beginPath();ctx.arc(sx,sy,r,0,Math.PI);ctx.closePath();ctx.fill();ctx.restore()}
    // A ring of neon, glowing, humming slightly.
    else if(style.texture==="tubes"){ctx.save();ctx.strokeStyle=String(q.color??pal.accent);ctx.shadowColor=String(q.color??pal.accent);ctx.shadowBlur=40;ctx.lineWidth=10;ctx.globalAlpha=.85+.15*Math.sin(num(t,0)*11);ctx.beginPath();ctx.arc(sx,sy,r*.8,0,Math.PI*2);ctx.stroke();ctx.restore()}
    // A disc torn out of coloured paper.
    else if(style.texture==="scraps"){
     ctx.save();ctx.shadowColor="rgba(0,0,0,0.25)";ctx.shadowBlur=16;ctx.shadowOffsetY=6;ctx.fillStyle=String(q.color??pal.accent);ctx.beginPath();
     for(let k=0;k<120;k++){const a=k/120*Math.PI*2,rr=r*(1+(env.random(seed*7+k*31)-.5)*.04);if(k)ctx.lineTo(sx+Math.cos(a)*rr,sy+Math.sin(a)*rr);else ctx.moveTo(sx+rr,sy)}
     ctx.closePath();ctx.fill();ctx.restore();
    }
    // An opening quotation mark, huge, in a display serif: the pull quote's ornament.
    else if(style.texture==="folio"){ctx.save();ctx.fillStyle=String(q.color??pal.accent);ctx.font="400 "+Math.round(r*2.4)+"px \"DM Serif Display\"";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText("\u201c",sx,sy+r*.5);ctx.restore()}
    else if(style.texture==="blueprint"){
     ctx.save();ctx.strokeStyle=String(q.color??(light?"rgba(0,0,0,0.4)":"rgba(255,255,255,0.45)"));ctx.lineWidth=2;ctx.beginPath();ctx.arc(sx,sy,r,0,Math.PI*2);
     ctx.moveTo(sx-r*1.15,sy);ctx.lineTo(sx+r*1.15,sy);ctx.moveTo(sx,sy-r*1.15);ctx.lineTo(sx,sy+r*1.15);ctx.stroke();
     ctx.setLineDash([8,8]);ctx.beginPath();ctx.arc(sx,sy,r*.62,0,Math.PI*2);ctx.stroke();ctx.restore();
    }
   }
   if(texture==="grid"){grid(ctx,{step:num(o.step,80),color:o.ink??(light?"rgba(0,0,0,0.08)":"rgba(255,255,255,0.08)"),offsetX:dx,offsetY:dy});return}
   // A drafting sheet: a fine grid under a coarser one, both drifting with the field.
   if(texture==="blueprint"){
    grid(ctx,{step:num(o.step,40),color:o.ink??(light?"rgba(0,0,0,0.06)":"rgba(255,255,255,0.07)"),offsetX:dx,offsetY:dy});
    grid(ctx,{step:num(o.step,40)*5,color:o.ink??(light?"rgba(0,0,0,0.13)":"rgba(255,255,255,0.16)"),offsetX:dx,offsetY:dy});return;
   }
   // Column rules: the twelve columns a Swiss page is set on, hairlines inside the margins.
   if(texture==="rules"){
    const cols=12,x0=96,w=env.width-192;
    ctx.save();ctx.strokeStyle=String(o.ink??(light?"rgba(0,0,0,0.09)":"rgba(255,255,255,0.09)"));ctx.lineWidth=1;ctx.beginPath();
    for(let c=0;c<=cols;c++){const x=Math.round(x0+c*w/cols+dx*.3)+.5;ctx.moveTo(x,0);ctx.lineTo(x,env.height)}
    ctx.stroke();ctx.restore();return;
   }
   if(["none","glow","paper","aurora","scanlines","isogrid","riso","raw","shapes","tubes","scraps","folio"].includes(texture))return;
   for(let n=0;n<2;n++){
    const corner=Math.floor(env.random(seed*7+n)*4),fx=corner%2?env.width:0,fy=corner>1?env.height:0;
    stipple(ctx,{x:fx+(fx?-1:1)*(40+env.random(seed*7+n+2)*120)+dx,y:fy+(fy?-1:1)*(30+env.random(seed*7+n+4)*90)+dy*(n?-1:1),r:200+env.random(seed*7+n+6)*110,color:ink,seed:seed*2+n});
    if(n===0&&env.random(seed*7+9)<.5)break;
   }
  })();
  // And the camera travels: everything drawn after the field is seen through a slow push that swells through
  // the middle of the beat and settles back by its end, drifting sideways the way its seed leans — so a frame is
  // never held still, and the beat still ends on the frame the next one starts from. travel: false holds it.
  const travel=o.travel===false?0:Math.min(.08,Math.max(0,num(o.travel,.035)));
  const u=travel>0?Math.sin(Math.PI*clamp01(num(t,0)/Math.max(.01,num(env.duration,6)))):0;
  if(u>1e-6){
   const lean=env.random(Math.floor(num(o.seed,0))*7+11)<.5?-1:1;
   const view={x:env.width/2+lean*env.width*travel*.4*u,y:env.height/2,zoom:1+travel*u};
   ctx.translate(env.width/2,env.height/2);ctx.scale(view.zoom,view.zoom);ctx.translate(-view.x,-view.y);
   views.push(view);
  }
 }


 // A grid of dots that counts: count of them fill in the accent over the span, one at a time with a small
 // pop, the rest muted — how many of how many, at a glance. Row by row, or scattered.
 function dots(ctx,t,o={}){
  pal=tone(t);
  const cols=Math.max(1,Math.min(60,Math.floor(num(o.cols,12)))),rows=Math.max(1,Math.min(40,Math.floor(num(o.rows,6))));
  // Unplaced, the grid fills the lower part of the frame under a diagram's headline: big, the way the films it
  // is measured against fill theirs, where programs set small devices in a field of empty colour.
  const areaW=env.width-192,areaH=env.height*.5-96,fitGap=Math.min(areaW/cols,areaH/rows);
  const total=cols*rows,count=Math.max(0,Math.min(total,Math.floor(num(o.count,total))));
  const gap=Math.max(2,num(o.gap,o.size!=null?num(o.size,9)*3:fitGap)),r=Math.max(1,num(o.size,gap*.32));
  const x0=num(o.x,(env.width-(cols-1)*gap-r*2)/2),y0=num(o.y,env.height*.46+(areaH-(rows-1)*gap-r*2)/2),at=num(o.at,0),duration=Math.max(.01,num(o.duration,1.5));
  if(num(t,0)<at-.3)return {w:(cols-1)*gap+r*2,h:(rows-1)*gap+r*2,filled:0};
  // The order dots fill in: by rank, so a scattered fill is the same every frame.
  const rank=new Array(total).fill(0).map((_,k)=>k);
  if(o.order==="random")rank.sort((a,b)=>env.random(a*13+7)-env.random(b*13+7));
  const turn=new Array(total);rank.forEach((k,n)=>{turn[k]=n});
  let filled=0;
  ctx.save();
  for(let k=0;k<total;k++){
   const cx=x0+r+(k%cols)*gap,cy=y0+r+Math.floor(k/cols)*gap,appear=span(t,at-.3+(k/total)*.3,at+(k/total)*.3);
   if(appear<=0)continue;
   const start=at+(turn[k]/Math.max(1,count))*duration,on=turn[k]<count?span(t,start,start+.2):0;
   if(on>0)filled+=1;
   ctx.globalAlpha=appear;ctx.fillStyle=String(on>0?(o.fill??pal.accent):(o.color??"rgba(255,255,255,0.25)"));
   const s=on>0?lerp(.4,1,env.ease.back(on)):1;
   ctx.beginPath();ctx.arc(cx,cy,r*s,0,Math.PI*2);ctx.fill();
  }
  ctx.restore();
  return {w:(cols-1)*gap+r*2,h:(rows-1)*gap+r*2,filled};
 }

 // Bars that rise from a baseline in turn, each value counting above it and its label under it; with depth
 // they are isometric blocks, a lit top and a shaded side. hot picks one out in the accent.
 function bars(ctx,t,o={}){
  pal=tone(t);
  const values=(Array.isArray(o.values)?o.values:[]).slice(0,24).map((v)=>Math.max(0,num(v,0)));
  if(!values.length)return {bars:[]};
  const labels=Array.isArray(o.labels)?o.labels:[],n=values.length,most=Math.max(1e-9,num(o.max,Math.max(...values)));
  // Unplaced, they stand across the lower part of the frame, their baseline above the bottom margin.
  const x0=num(o.x,96),base=num(o.y,env.height-130),w=num(o.w,env.width-192),h=num(o.h,env.height*.42),slot=w/n,bw=slot*Math.min(.9,Math.max(.2,num(o.thickness,.62)));
  const depth=Math.max(0,num(o.depth,0)),at=num(o.at,0),stagger=num(o.stagger,.12),duration=num(o.duration,.7),hot=Math.floor(num(o.hot,-1));
  const ink=String(o.color??pal.ink),accent=String(o.accent??pal.accent),size=num(o.size,Math.max(22,Math.min(40,slot*.12))),decimals=Math.max(0,Math.min(3,Math.floor(num(o.decimals,0))));
  const placed=[];
  ctx.save();ctx.textAlign="center";
  values.forEach((v,k)=>{
   const u=curve(o.ease??"out")(span(t,at+k*stagger,at+k*stagger+duration));
   const bh=h*v/most*u,bx=x0+k*slot+(slot-bw)/2,by=base-bh,colour=k===hot?accent:ink;
   placed.push({x:bx,y:by,w:bw,h:bh});
   if(u<=0)return;
   if(depth>0){
    const ox=depth,oy=-depth*.6;
    ctx.fillStyle=colour;ctx.beginPath();ctx.moveTo(bx+bw,by);ctx.lineTo(bx+bw+ox,by+oy);ctx.lineTo(bx+bw+ox,base+oy);ctx.lineTo(bx+bw,base);ctx.closePath();ctx.fill();
    ctx.fillStyle="rgba(0,0,0,0.3)";ctx.fill();
    ctx.fillStyle=colour;ctx.beginPath();ctx.moveTo(bx,by);ctx.lineTo(bx+ox,by+oy);ctx.lineTo(bx+bw+ox,by+oy);ctx.lineTo(bx+bw,by);ctx.closePath();ctx.fill();
    ctx.fillStyle="rgba(255,255,255,0.28)";ctx.fill();
   }
   ctx.fillStyle=colour;ctx.fillRect(bx,by,bw,bh);
   ctx.font="600 "+size+"px \""+family(o.font,env.mono)+"\"";ctx.textBaseline="alphabetic";ctx.fillStyle=colour;
   ctx.fillText(text(o.format??"{n}",40).replace("{n}",(v*u).toFixed(decimals)),bx+bw/2+depth/2,by-depth*.6-size*.5);
   if(labels[k]!=null){ctx.textBaseline="hanging";ctx.fillStyle=ink;ctx.fillText(text(labels[k],32),bx+bw/2,base+size*.5)}
  });
  ctx.restore();
  return {bars:placed};
 }

 // A beat's headline, set as the films it is measured against set theirs: huge, with a floor by its role —
 // a hook at 140 pixels or more, a diagram's and an end card's at 120 — and never still: the block pushes in
 // slowly over the beat, or slams in from larger. A hook and an end card sit in the middle of the frame, a
 // diagram's at the head of it, leaving the frame below for the diagram.
 function headline(ctx,t,o={}){
  pal=tone(t);
  const W=env.width,H=env.height,role=o.role==="hook"||o.role==="end"?o.role:"diagram",M=num(o.margin,96);
  let size=Math.max(role==="hook"?140:120,Math.min(260,num(o.size,role==="hook"?170:role==="end"?140:120)));
  // A hook is the frame: its words set as large as fit it — up to 260 pixels, wrapping to at most three lines,
  // with a tenth to spare for the push and the field's travel, which once carried it past the frame's edge —
  // in its middle, wherever it was asked to sit. Asked for 140 at the top,
  // a hook once sat in a band over an empty frame.
  if(role==="hook"&&o.text){
   // Its second line counted in, at the size it will be set: sized on its headline alone, a hook pushed its
   // second line off the foot of the frame, where it was never read.
   const fits=(px)=>{
    const m=words(ctx,-1e9,{text:o.text,size:px,weight:num(o.weight,700),font:o.font,width:(W-M*2)/1.1,leading:num(o.leading,o.boxed?1.3:.95),case:o.case,tracking:o.tracking,boxed:!!o.boxed});
    let high=m.height;
    if(o.sub){const sp=Math.max(48,num(o.subSize,px*.4));high+=sp*.5+words(ctx,-1e9,{text:o.sub,size:sp,weight:num(o.weight,700),font:o.font,width:(W-M*2)/1.1,leading:1.1,case:o.case}).height}
    return m.lines<=3&&high<=H*.64&&m.width<=(W-M*2)/1.1;
   };
   let best=140;for(let px=260;px>140;px-=10){if(fits(px)){best=px;break}}
   size=best;
  }
  const subSize=Math.max(48,num(o.subSize,size*.4)),align=o.align==="center"||o.align==="right"||o.align==="left"?o.align:(role==="end"?"center":"left");
  // A hook is laid out at the width it was sized for, a tenth inside the margins.
  const width=role==="hook"?(W-M*2)/1.1:Math.max(size*2,num(o.width,W-M*2)),at=num(o.at,0);
  const head={text:o.text,size,weight:num(o.weight,700),font:o.font,color:String(o.color??pal.ink),arrive:String(o.arrive??pal.accent),width,leading:num(o.leading,o.boxed?1.3:.95),pace:num(o.pace,.16),case:o.case,tracking:o.tracking,boxed:!!o.boxed,boxColor:o.boxColor};
  const sub={text:o.sub,size:subSize,weight:num(o.weight,700),font:o.font,color:String(o.subColor??pal.accent),width,leading:1.1,pace:.12,case:o.case};
  // Measured first, drawing nothing, so the block can be placed by its size.
  const hb=o.text?words(ctx,-1e9,{...head,at:0}):{width:0,height:0,done:0};
  const sb=o.sub?words(ctx,-1e9,{...sub,at:0}):{width:0,height:0};
  const gap=o.sub?subSize*.5:0,blockH=hb.height+gap+sb.height,blockW=Math.max(hb.width,sb.width);
  const placed=role!=="hook";
  // A diagram's headline is the head of its frame whatever y it is asked for: set under its cards, it once
  // made the beat read from the bottom up.
  const x=placed?num(o.x,align==="center"?W/2:align==="right"?W-M:M):(align==="center"?W/2:align==="right"?W-M:M),y=placed?(role==="diagram"?Math.min(num(o.y,M),M):num(o.y,(H-blockH)/2)):(H-blockH)/2;
  let left=align==="center"?x-blockW/2:align==="right"?x-blockW:x;
  // Inside the frame whatever camera it is drawn through: where the camera's view would carry the block past
  // half a margin of the frame's edge, it is moved back in, in the camera's own units. A diagram's headline
  // once ran off the left edge as its camera pushed in.
  let shiftX=0,shiftY=0;
  if(views.length){
   // Through every view it is drawn in, innermost first: a camera inside the field's travel.
   const toX=(px)=>{for(let k=views.length-1;k>=0;k--)px=(px-views[k].x)*views[k].zoom+W/2;return px};
   const toY=(py)=>{for(let k=views.length-1;k>=0;k--)py=(py-views[k].y)*views[k].zoom+H/2;return py};
   const zoom=views.reduce((z,v)=>z*v.zoom,1),edge=M/2;
   const sl=toX(left),sr=toX(left+blockW),st=toY(y),sb=toY(y+blockH);
   if(sr-sl<=W-edge*2){if(sl<edge)shiftX=(edge-sl)/zoom;else if(sr>W-edge)shiftX=(W-edge-sr)/zoom}
   else shiftX=(edge-sl)/zoom;
   if(sb-st<=H-edge*2){if(st<edge)shiftY=(edge-st)/zoom;else if(sb>H-edge)shiftY=(H-edge-sb)/zoom}
  }
  left+=shiftX;
  const cx=left+blockW/2,cy=y+shiftY+blockH/2;
  const motion=o.motion==="slam"||o.motion==="none"?o.motion:"push";
  let k=1;
  if(motion==="push")k=1+Math.min(.12,Math.max(0,num(o.drift,.06)))*env.ease.inOut(span(t,at,num(env.duration,at+4)));
  else if(motion==="slam"){const u=span(t,at,at+.35);k=u<=0?1:lerp(1.3,1,env.ease.out(u))}
  ctx.save();ctx.translate(cx,cy);ctx.scale(k,k);ctx.translate(-cx,-cy);
  const said=o.text?words(ctx,t,{...head,x:x+shiftX,y:y+shiftY,at,align}):hb;
  const subAt=Math.max(at+.4,num(said.done,at)+.2);
  if(o.sub)words(ctx,t,{...sub,x:x+shiftX,y:y+shiftY+hb.height+gap,at:subAt,align});
  ctx.restore();
  return {x:left,y:y+shiftY,w:blockW,h:blockH,size,done:o.sub?subAt+.5:num(said.done,at)};
 }

 // One card of a diagram, drawn about (0, 0) in the style's own way: an app window with a title bar and lines
 // of content (print), a flat white card ruled in ink with its index set big (swiss), a soft rounded card with
 // its label in a pill (studio), an outline with its corners ticked (blueprint), or a solid block the label is
 // reversed out of (kinetic). hot picks it out in the accent. A strip is a card a line high: its label alone.
 function drawCard(ctx,cw,ch,label,hot,index,o={},strip=false){
  const kind=style.card,ink=String(pal.ink),accent=String(pal.accent),x=-cw/2,y=-ch/2;
  const labelSize=strip?Math.round(Math.min(ch*.42,cw*.07)):Math.round(cw*.085);
  ctx.textBaseline="middle";
  if(kind==="flat"){
   ctx.fillStyle=String(o.fill??"#ffffff");ctx.fillRect(x,y,cw,ch);
   ctx.strokeStyle=String(hot?accent:"#111111");ctx.lineWidth=hot?8:5;ctx.strokeRect(x,y,cw,ch);
   if(!strip){ctx.fillStyle=String(hot?accent:"#111111");ctx.font="700 "+Math.round(ch*.3)+"px \""+env.font+"\"";ctx.fillText(String(index+1).padStart(2,"0"),x+cw*.08,y+ch*.3)}
   ctx.fillStyle="#111111";ctx.font="600 "+labelSize+"px \""+env.mono+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.72,cw*.84);
   return;
  }
  if(kind==="soft"){
   const r=Math.min(ch*.14,28);
   ctx.save();ctx.shadowColor="rgba(0,0,0,0.3)";ctx.shadowBlur=40;ctx.shadowOffsetY=16;ctx.fillStyle=String(o.fill??"rgba(255,255,255,0.95)");ctx.beginPath();rounded(ctx,x,y,cw,ch,r);ctx.fill();ctx.restore();
   ctx.font="600 "+labelSize+"px \""+env.font+"\"";
   const tw=Math.min(cw*.84,ctx.measureText(label).width)+labelSize*1.2,ty=strip?0:y+ch*.3;
   ctx.save();ctx.fillStyle=accent;ctx.globalAlpha=hot?.9:.22;ctx.beginPath();rounded(ctx,x+cw*.07,ty-labelSize*.85,tw,labelSize*1.7,labelSize*.85);ctx.fill();ctx.restore();
   ctx.fillStyle="#111111";ctx.fillText(label,x+cw*.07+labelSize*.6,ty,cw*.8);
   if(!strip){ctx.fillStyle="rgba(17,17,17,0.12)";for(let row=0;row<2;row++){ctx.beginPath();rounded(ctx,x+cw*.07,y+ch*(.58+row*.16),cw*(.72-row*.2),ch*.07,ch*.035);ctx.fill()}}
   return;
  }
  if(kind==="outline"){
   // Filled with the field, so a card stacked on another hides it as a drawing on a sheet would.
   ctx.fillStyle=String(pal.background);ctx.fillRect(x,y,cw,ch);
   ctx.strokeStyle=String(hot?accent:ink);ctx.lineWidth=hot?4:2;ctx.strokeRect(x,y,cw,ch);
   const s=Math.min(18,ch*.15);ctx.beginPath();for(const [px,py,dx,dy] of [[x,y,1,1],[x+cw,y,-1,1],[x,y+ch,1,-1],[x+cw,y+ch,-1,-1]]){ctx.moveTo(px+dx*s,py+dy*s*.4);ctx.lineTo(px+dx*s,py+dy*s);ctx.lineTo(px+dx*s*.4,py+dy*s)}ctx.stroke();
   ctx.fillStyle=String(hot?accent:ink);ctx.font="500 "+labelSize+"px \""+env.mono+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.32,cw*.84);
   if(!strip){ctx.save();ctx.strokeStyle=ink;ctx.globalAlpha=.35;ctx.lineWidth=2;ctx.setLineDash([10,8]);ctx.beginPath();for(let row=0;row<2;row++){ctx.moveTo(x+cw*.08,y+ch*(.62+row*.16));ctx.lineTo(x+cw*(.78-row*.2),y+ch*(.62+row*.16))}ctx.stroke();ctx.restore()}
   return;
  }
  // A pencilled note: a paper card at its own slight tilt, outlined twice by hand, its index circled.
  if(kind==="paper"){
   ctx.save();ctx.rotate((env.random(index*5+2)-.5)*.06);
   ctx.shadowColor="rgba(0,0,0,0.15)";ctx.shadowBlur=14;ctx.shadowOffsetY=6;ctx.fillStyle=String(o.fill??"#fbf8f1");ctx.fillRect(x,y,cw,ch);ctx.shadowColor="transparent";
   ctx.strokeStyle=String(hot?accent:"#2b2620");ctx.lineWidth=hot?3.5:2.2;ctx.lineCap="round";ctx.lineJoin="round";
   for(let pass=0;pass<2;pass++)scrawl(ctx,[[x+3,y+2],[x+cw-2,y+4],[x+cw-4,y+ch-2],[x+2,y+ch-4],[x+3,y+2]],1,index*11+pass*5,3);
   ctx.fillStyle="#2b2620";ctx.font="600 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.62,cw*.84);
   if(!strip){const ix=x+cw*.12,iy=y+ch*.28,ir=Math.min(cw,ch)*.11;ctx.font="600 "+Math.round(ir*1.1)+"px \""+env.font+"\"";ctx.textAlign="center";ctx.fillStyle=String(hot?accent:"#2b2620");ctx.fillText(String(index+1),ix,iy);ctx.textAlign="left";ctx.strokeStyle=String(hot?accent:"#2b2620");ctx.lineWidth=2;loop(ctx,ix,iy,ir*1.1,ir*1.05,1,index*3+1)}
   ctx.restore();
   return;
  }
  // A pane of glass: translucent, catching the light along its edge, its label in the field's ink.
  if(kind==="glass"){
   const r=Math.min(ch*.16,26);
   ctx.save();ctx.shadowColor="rgba(0,0,0,0.25)";ctx.shadowBlur=36;ctx.shadowOffsetY=14;ctx.fillStyle=hot?"rgba(255,255,255,0.26)":"rgba(255,255,255,0.14)";ctx.beginPath();rounded(ctx,x,y,cw,ch,r);ctx.fill();ctx.restore();
   ctx.save();ctx.strokeStyle=hot?accent:"rgba(255,255,255,0.42)";ctx.lineWidth=hot?3:1.5;ctx.beginPath();rounded(ctx,x,y,cw,ch,r);ctx.stroke();ctx.restore();
   ctx.fillStyle=ink;ctx.font="600 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.36,cw*.84);
   if(!strip){ctx.save();ctx.fillStyle=ink;ctx.globalAlpha=.18;for(let row=0;row<2;row++){ctx.beginPath();rounded(ctx,x+cw*.08,y+ch*(.6+row*.15),cw*(.66-row*.2),ch*.06,ch*.03);ctx.fill()}ctx.restore()}
   return;
  }
  // A console box: a dark panel ruled in a hairline, its index bracketed and its label a prompt line.
  if(kind==="console"){
   ctx.fillStyle="rgba(12,15,20,0.94)";ctx.fillRect(x,y,cw,ch);ctx.strokeStyle=hot?accent:"rgba(255,255,255,0.3)";ctx.lineWidth=hot?3:1.5;ctx.strokeRect(x,y,cw,ch);
   ctx.font="500 "+labelSize+"px \""+env.mono+"\"";
   if(!strip){ctx.fillStyle="rgba(255,255,255,0.45)";ctx.fillText("["+String(index+1).padStart(2,"0")+"]",x+cw*.08,y+ch*.3)}
   ctx.fillStyle=hot?accent:"#e8edf2";ctx.fillText("> "+label+(hot?"_":""),x+cw*.08,strip?0:y+ch*.62,cw*.84);
   return;
  }
  // An isometric block: its face, its top and its side, the label on its face; hot, the block is the accent.
  if(kind==="iso"){
   const d=Math.min(ch*.22,cw*.14),face=String(hot?accent:"#ffffff");
   ctx.save();ctx.fillStyle=face;ctx.fillRect(x,y,cw,ch);
   ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+d,y-d);ctx.lineTo(x+cw+d,y-d);ctx.lineTo(x+cw,y);ctx.closePath();ctx.fill();ctx.fillStyle="rgba(255,255,255,0.35)";ctx.fill();
   ctx.fillStyle=face;ctx.beginPath();ctx.moveTo(x+cw,y);ctx.lineTo(x+cw+d,y-d);ctx.lineTo(x+cw+d,y+ch-d);ctx.lineTo(x+cw,y+ch);ctx.closePath();ctx.fill();ctx.fillStyle="rgba(0,0,0,0.28)";ctx.fill();
   ctx.strokeStyle="rgba(0,0,0,0.35)";ctx.lineWidth=1.2;ctx.strokeRect(x,y,cw,ch);ctx.restore();
   ctx.fillStyle=hot?String(pal.background):"#111111";ctx.font="700 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.5,cw*.84);
   return;
  }
  // A riso print: a card of one of the film's inks overprinted on the field, its keyline in ink off register, its
  // number big in the corner.
  if(kind==="riso"){
   const paint=String(hot?accent:pal.second);
   ctx.save();ctx.globalCompositeOperation=lightness(pal.background)>.42?"multiply":"screen";ctx.globalAlpha=.9;ctx.fillStyle=paint;ctx.fillRect(x,y,cw,ch);ctx.restore();
   ctx.strokeStyle=ink;ctx.lineWidth=2.5;ctx.strokeRect(x-5,y-4,cw,ch);
   ctx.fillStyle=readable(paint);
   if(!strip){ctx.font="800 "+Math.round(ch*.32)+"px \""+env.font+"\"";ctx.fillText(String(index+1),x+cw*.07,y+ch*.3)}
   ctx.font="700 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label,x+cw*.07,strip?0:y+ch*.72,cw*.86);
   return;
  }
  // Brutal: a white slab ruled heavily in ink on a hard ink shadow, its number in mono, its label in capitals.
  if(kind==="brutal"){
   const face=String(hot?accent:"#ffffff");
   ctx.fillStyle="#111111";ctx.fillRect(x+12,y+12,cw,ch);ctx.fillStyle=face;ctx.fillRect(x,y,cw,ch);
   ctx.strokeStyle="#111111";ctx.lineWidth=6;ctx.strokeRect(x,y,cw,ch);ctx.fillStyle=readable(face);
   if(!strip){ctx.font="700 "+Math.round(labelSize*.7)+"px \""+env.mono+"\"";ctx.fillText("#"+String(index+1).padStart(2,"0"),x+cw*.08,y+ch*.24)}
   ctx.font="800 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label.toUpperCase(),x+cw*.08,strip?0:y+ch*.66,cw*.84);
   return;
  }
  // Bauhaus: a pale card with one primary shape by its number — a disc, a triangle, a square — and its label set
  // bold under it.
  if(kind==="bauhaus"){
   const face=String(hot?accent:"#f4f1ea"),s=Math.min(ch*.26,cw*.16),sx=x+cw*.08+s/2,sy=y+ch*.3,shape=index%3;
   ctx.fillStyle=face;ctx.fillRect(x,y,cw,ch);
   if(!strip){
    ctx.fillStyle=String(shape===0?(hot?ink:accent):shape===1?pal.second:"#111111");ctx.beginPath();
    if(shape===0)ctx.arc(sx,sy,s/2,0,Math.PI*2);else if(shape===1){ctx.moveTo(sx,sy-s/2);ctx.lineTo(sx+s/2,sy+s/2);ctx.lineTo(sx-s/2,sy+s/2);ctx.closePath()}else ctx.rect(sx-s/2,sy-s/2,s,s);
    ctx.fill();
   }
   ctx.fillStyle=readable(face);ctx.font="800 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.7,cw*.84);
   return;
  }
  // A neon sign: a dark rounded panel, a glowing tube round it, its label glowing.
  if(kind==="neon"){
   const tube=String(hot?accent:pal.second),r=Math.min(ch*.16,24);
   ctx.save();ctx.fillStyle="rgba(10,8,20,0.88)";ctx.beginPath();rounded(ctx,x,y,cw,ch,r);ctx.fill();
   ctx.strokeStyle=tube;ctx.shadowColor=tube;ctx.shadowBlur=hot?30:18;ctx.lineWidth=hot?4:3;ctx.stroke();
   ctx.fillStyle="#ffffff";ctx.shadowBlur=14;ctx.font="600 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.5,cw*.84);ctx.restore();
   return;
  }
  // A scrap of paper torn out and pasted on at its own tilt, a strip of tape holding its top.
  if(kind==="scrap"){
   const face=String(hot?accent:["#fbfaf6","#ece1c4","#f1ece2"][index%3]);
   ctx.save();ctx.rotate((env.random(index*5+2)-.5)*.08);
   ctx.shadowColor="rgba(0,0,0,0.2)";ctx.shadowBlur=14;ctx.shadowOffsetY=6;ctx.fillStyle=face;torn(ctx,x,y,cw,ch,index*53+7,6);ctx.fill();ctx.shadowColor="transparent";ctx.shadowOffsetY=0;
   ctx.fillStyle="rgba(236,226,190,0.8)";ctx.save();ctx.translate(0,y);ctx.rotate((env.random(index*3+9)-.5)*.3);ctx.fillRect(-cw*.16,-12,cw*.32,24);ctx.restore();
   ctx.fillStyle=readable(face);ctx.font="700 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.6,cw*.84);ctx.restore();
   return;
  }
  // A magazine's column: a rule over it, its number big in the accent, its label set under it.
  if(kind==="column"){
   ctx.fillStyle=String(pal.background);ctx.fillRect(x,y,cw,ch);
   ctx.fillStyle=String(hot?accent:ink);ctx.fillRect(x,y,cw,hot?6:2);
   if(!strip){ctx.fillStyle=accent;ctx.font="400 "+Math.round(ch*.36)+"px \"DM Serif Display\"";ctx.fillText(String(index+1).padStart(2,"0"),x,y+ch*.34)}
   ctx.fillStyle=ink;ctx.font="600 "+labelSize+"px \""+env.font+"\"";ctx.fillText(label,x,strip?0:y+ch*.74,cw*.92);
   return;
  }
  if(kind==="block"){
   ctx.fillStyle=String(hot?accent:ink);ctx.fillRect(x,y,cw,ch);
   ctx.fillStyle=String(pal.background);ctx.font="800 "+Math.round(strip?labelSize*1.1:cw*.11)+"px \""+env.font+"\"";ctx.fillText(label,x+cw*.08,strip?0:y+ch*.5,cw*.84);
   return;
  }
  ctx.fillStyle="rgba(0,0,0,0.3)";ctx.fillRect(x+8,y+10,cw,ch);
  ctx.fillStyle=String(o.fill??"#ffffff");ctx.fillRect(x,y,cw,ch);
  if(strip){ctx.fillStyle=String(hot?accent:(o.bar??"#111111"));ctx.fillRect(x,y,cw*.03,ch);ctx.fillStyle="#111111";ctx.font="600 "+labelSize+"px \""+env.mono+"\"";ctx.fillText(label,x+cw*.08,0,cw*.84);return}
  ctx.fillStyle=String(hot?accent:(o.bar??"#111111"));ctx.fillRect(x,y,cw,ch*.16);
  ctx.fillStyle="#111111";ctx.font="600 "+labelSize+"px \""+env.mono+"\"";
  ctx.fillText(label,x+cw*.08,y+ch*.34,cw*.84);
  ctx.fillStyle="rgba(17,17,17,0.18)";
  for(let row=0;row<3;row++)ctx.fillRect(x+cw*.08,y+ch*(.56+row*.13),cw*(.7-row*.16),ch*.05);
 }

 // A count in a chip, as many as there are of what the cards are counted as: "3 WINDOWS", "1 WINDOW".
 function chip(ctx,many,noun,cx,cy,size,o={}){
  const said=many+" "+(many===1?noun.replace(/S$/,"").replace(/s$/,""):noun);
  ctx.save();ctx.font="600 "+size+"px \""+env.mono+"\"";ctx.textBaseline="middle";ctx.textAlign="center";
  const w=ctx.measureText(said).width+size*1.6;
  ctx.fillStyle=String(o.chip??pal.accent);ctx.fillRect(cx-w/2,cy-size,w,size*2);
  ctx.fillStyle="#111111";ctx.fillText(said,cx,cy+1);ctx.restore();
 }

 // A diagram's cards, in one of three modes. "fold" (the default): they pop in along a row, big across the
 // lower part of the frame unless placed, and with fold gather into one stack at a point (by default the row's
 // middle) over its span — five tools becoming one. "flow": a process, the cards in a row (two, snaking, where
 // one would make them too small) joined each to the next by a leader that draws itself, each lit as the flow
 // reaches it. "versus": the old way against the new — every card but the last stacked as strips on the near
 // side and struck through one by one, then the last, the product, popping in big across from them. hot picks
 // one out in the accent.
 function cards(ctx,t,o={}){
  pal=tone(t);
  const items=(Array.isArray(o.items)?o.items:[]).slice(0,8).map((item)=>text(item,24));
  if(!items.length)return {cards:[]};
  // Upright, each is laid down the frame rather than across it: a 9:16 frame is a column, and laid in a row
  // the cards sat small in its upper half with the paper under them empty.
  const upright=env.height>env.width;
  if(o.mode==="flow")return upright?flowDown(ctx,t,o,items):flow(ctx,t,o,items);
  if(o.mode==="versus")return upright?versusDown(ctx,t,o,items):versus(ctx,t,o,items);
  // Big whatever they are asked: a card is at least 380 pixels across, and where a row of them would not fit,
  // they overlap like a hand of cards rather than shrink — five tools once came out as tiles a sixth of the frame.
  const n=items.length,areaW=Math.max(380,num(o.w,env.width-192));
  // Upright, a deck spread down the column: wider cards, each a step below the one before, from where it was
  // asked to stand to the frame's foot with room for its count.
  const cw=upright?Math.min(areaW,num(o.cardW,areaW*.86)):Math.max(380,Math.min(560,num(o.cardW,420),n>1?areaW:560)),ch=num(o.cardH,cw*.64);
  const step=upright?0:n>1?Math.min(cw+28,(areaW-cw)/(n-1)):0,rowW=cw+step*(n-1);
  const x0=num(o.x,(env.width-areaW)/2+(areaW-rowW)/2),y0=num(o.y,env.height*(upright?.3:.5));
  const down=upright&&n>1?Math.max(0,Math.min(ch+24,(env.height-(o.count?150:72)-y0-ch)/(n-1))):0;
  const at=num(o.at,0);
  // fold: true folds them a little before the beat's middle, into the row's middle.
  const folding=o.fold===true?{}:o.fold;
  const foldAt=num(folding?.at,Math.max(at+1.2,num(env.duration,5)*.42)),foldFor=num(folding?.duration,.7);
  const stagger=num(o.stagger,.12),fold=folding?env.ease.inOut(span(t,foldAt,foldAt+foldFor)):0;
  const fx=num(folding?.x,x0+rowW/2),fy=num(folding?.y,y0+ch/2+down*(n-1)/2),hot=Math.floor(num(o.hot,-1)),placed=[];
  // Folded, the one that is left grows to hold the frame: the "one" is the point.
  const grow=1+.35*fold;
  items.forEach((label,k)=>{
   const home={x:x0+k*step+cw/2+(upright?(k-(n-1)/2)*14:0),y:y0+ch/2+k*down},cx=lerp(home.x,fx+k*-5,fold),cy=lerp(home.y,fy+k*-5,fold);
   placed.push({x:cx-cw*grow/2,y:cy-ch*grow/2,w:cw*grow,h:ch*grow});
   pop(ctx,t,{x:cx,y:cy,at:at+k*stagger,spin:(k-(n-1)/2)*.06},()=>{
    ctx.scale(grow,grow);
    ctx.rotate((k-(n-1)/2)*.025*(1-fold));
    drawCard(ctx,cw,ch,label,k===hot,k,o);
   });
  });
  // A count under them, as many as there are, down to one as they fold: "3 WINDOWS" to "1 WINDOW".
  if(o.count&&span(t,at,at+.3)>0){
   const size=Math.max(22,Math.round(cw*.07));
   chip(ctx,Math.round(lerp(n,1,fold)),text(o.count,24),lerp(x0+rowW/2,fx,fold),lerp(y0+ch+down*(n-1),fy+ch*grow/2,fold)+size*2.2,size,o);
  }
  return {cards:placed,folded:fold};
 }

 // A flow: steps in order, each reached in turn. The leaders are drawn first, under the cards they join.
 function flow(ctx,t,o,items){
  pal=tone(t);
  // One row where the cards stay readable in it, two (snaking) only where one would make them too small: five
  // steps asked for in a row once snaked into two and ran off the foot of the frame.
  const n=items.length,areaW=num(o.w,env.width-192),gapX=n>4?44:64,gapY=56,single=(areaW-(n-1)*gapX)/n>=220;
  const cols=single?n:Math.ceil(n/2),rows=single?1:2;
  // As wide as the row allows and no taller than the frame below the cards holds with their count under it; and
  // where the cards would still run past the frame's foot from where they were asked to stand, they stand higher.
  const reserve=o.count?140:60,asked=num(o.y,rows>1?env.height*.38:env.height*.48);
  const tall=(env.height-reserve-asked-(rows-1)*gapY)/rows/.64;
  const cw=Math.max(200,Math.min(num(o.cardW,420),(areaW-(cols-1)*gapX)/cols,tall)),ch=num(o.cardH,cw*.64);
  const y0=Math.max(0,Math.min(asked,env.height-reserve-rows*ch-(rows-1)*gapY));
  const rowW=cols*cw+(cols-1)*gapX,x0=num(o.x,(env.width-rowW)/2);
  const at=num(o.at,0),stagger=num(o.stagger,.12);
  // The flow takes what is left of the beat after the cards are in, a step each, never quicker than a fifth.
  const step=Math.max(.2,Math.min(.6,num(o.step,(num(env.duration,5)-at-1.8-n*stagger)/Math.max(1,n))));
  const reach=(k)=>at+.4+n*stagger+k*step;
  // Snaking: the second row runs back the way the first came, so the line turns down at the first row's end.
  const pos=items.map((_,k)=>{const r=Math.floor(k/cols),c=r%2?cols-1-(k%cols):k%cols;return {x:x0+c*(cw+gapX)+cw/2,y:y0+r*(ch+gapY)+ch/2}});
  for(let k=1;k<n;k++){
   const a=pos[k-1],b=pos[k],level=Math.abs(a.y-b.y)<1,dir=b.x>a.x?1:-1;
   lead(ctx,t,level?[[a.x+dir*(cw/2+8),a.y],[b.x-dir*(cw/2+10),b.y]]:[[a.x,a.y+ch/2+8],[b.x,b.y-ch/2-10]],{at:reach(k)-step*.7,duration:step*.6,color:String(o.line??pal.ink),width:4,dot:7});
  }
  let reached=0;
  const placed=items.map((label,k)=>{
   const p=pos[k],on=num(t,0)>=reach(k);
   if(on)reached+=1;
   const bump=1+.06*Math.sin(Math.PI*span(t,reach(k),reach(k)+.35));
   pop(ctx,t,{x:p.x,y:p.y,at:at+k*stagger},()=>{ctx.scale(bump,bump);drawCard(ctx,cw,ch,label,on,k,o)});
   return {x:p.x-cw/2,y:p.y-ch/2,w:cw,h:ch};
  });
  if(o.count&&reached>0){const size=Math.max(22,Math.round(cw*.07));chip(ctx,reached,text(o.count,24),x0+rowW/2,Math.max(...placed.map((c)=>c.y+c.h))+size*2.2,size,o)}
  return {cards:placed,folded:span(t,reach(n-1),reach(n-1)+.3),reached};
 }

 // When a versus's strips arrive and are struck, and when its product lands: by six tenths of what is left of the
 // beat whatever stagger is asked, so the product is the beat's to hold — asked to arrive slowly, a product once
 // landed half a second before the cut and was never read.
 function versusTiming(o,count){
  const at=num(o.at,0),left=num(env.duration,5)-at,lands=at+Math.max(1.2,left*.6);
  let stagger=num(o.stagger,.12),strike=Math.max(.15,Math.min(.35,(left-1.8)/(count+2)));
  const need=.5+count*stagger+count*strike+.35,have=lands-at;
  if(need>have){const k=Math.max(.2,(have-.85)/Math.max(.01,need-.85));stagger*=k;strike=Math.max(.08,strike*k)}
  const struckAt=(k)=>at+.5+count*stagger+k*strike;
  return {at,stagger,struckAt,winAt:struckAt(count)+.1};
 }

 // The old way against the new: strips struck through one at a time, then the product across from them.
 function versus(ctx,t,o,items){
  pal=tone(t);
  const n=items.length,old=n>1?items.slice(0,n-1):items,winner=items[n-1],W=env.width,H=env.height,M=96;
  const {at,stagger,struckAt,winAt}=versusTiming(o,old.length),colW=Math.min(620,num(o.w,W-M*2)*.42),x0=num(o.x,M);
  const top=num(o.y,H*.4),bottom=H-M*.8,sh=Math.max(48,Math.min(104,(bottom-top-(old.length-1)*18)/old.length));
  const placed=[];
  let struck=0;
  old.forEach((label,k)=>{
   const y=top+k*(sh+18),cx=x0+colW/2,cy=y+sh/2,u=env.ease.expoOut(span(t,struckAt(k),struckAt(k)+.3));
   if(u>0)struck+=u>=1?1:0;
   placed.push({x:x0,y,w:colW,h:sh});
   ctx.save();ctx.globalAlpha*=lerp(1,.45,u);
   pop(ctx,t,{x:cx,y:cy,at:at+k*stagger},()=>drawCard(ctx,colW,sh,label,false,k,o,true));
   ctx.restore();
   if(u>0){ctx.save();ctx.fillStyle=String(pal.accent);ctx.fillRect(x0-12,cy-5,(colW+24)*u,10);ctx.restore()}
  });
  // The product: big across from the column, joined to it by a leader once the last of the old way is struck.
  // Held clear of the frame's foot with its count under it.
  const cw=Math.min(540,W*.34),ch=cw*.64,chipSize=Math.max(22,Math.round(cw*.07)),wx=num(o.winnerX,W-M-cw/2),wy=num(o.winnerY,Math.min((top+bottom)/2,H-M*.4-chipSize*3.4-ch/2));
  lead(ctx,t,[[x0+colW+28,wy],[wx-cw/2-18,wy]],{at:winAt-.05,duration:.35,color:String(o.line??pal.ink),width:4,dot:7});
  pop(ctx,t,{x:wx,y:wy,at:winAt+.25,duration:.5},()=>drawCard(ctx,cw,ch,winner,true,n-1,o));
  placed.push({x:wx-cw/2,y:wy-ch/2,w:cw,h:ch});
  const won=span(t,winAt+.25,winAt+.75);
  if(o.count&&span(t,at,at+.3)>0){const size=chipSize;chip(ctx,won>=1?1:old.length,text(o.count,24),won>=1?wx:x0+colW/2,won>=1?wy+ch/2+size*2.2:Math.min(H-size*1.5,top+old.length*(sh+18)+size*1.4),size,o)}
  return {cards:placed,folded:won,struck};
 }

 // A flow, upright: the steps down the column, numbered, each a strip as wide as the column and as tall as the
 // frame below the first allows, joined each to the next by a leader running down, lit as the flow reaches it.
 function flowDown(ctx,t,o,items){
  pal=tone(t);
  const n=items.length,W=env.width,H=env.height,left=num(o.x,96),cw=Math.min(num(o.w,W-192),W-left-48),gapY=n>5?34:44,reserve=o.count?150:72;
  // From where they were asked to stand to the frame's foot, lifted where even short strips would not fit.
  const asked=num(o.y,H*.3),least=64,top=Math.max(0,Math.min(asked,H-reserve-n*least-(n-1)*gapY));
  const ch=Math.max(least,Math.min(num(o.cardH,200),(H-reserve-top-(n-1)*gapY)/n)),strip=ch<cw*.5;
  const at=num(o.at,0),stagger=num(o.stagger,.12);
  const step=Math.max(.2,Math.min(.6,num(o.step,(num(env.duration,5)-at-1.8-n*stagger)/Math.max(1,n))));
  const reach=(k)=>at+.4+n*stagger+k*step;
  const pos=items.map((_,k)=>({x:left+cw/2,y:top+k*(ch+gapY)+ch/2}));
  for(let k=1;k<n;k++)lead(ctx,t,[[pos[k].x,pos[k-1].y+ch/2+6],[pos[k].x,pos[k].y-ch/2-8]],{at:reach(k)-step*.7,duration:step*.6,color:String(o.line??pal.ink),width:4,dot:7});
  let reached=0;
  const placed=items.map((label,k)=>{
   const p=pos[k],on=num(t,0)>=reach(k);
   if(on)reached+=1;
   const bump=1+.04*Math.sin(Math.PI*span(t,reach(k),reach(k)+.35));
   pop(ctx,t,{x:p.x,y:p.y,at:at+k*stagger},()=>{ctx.scale(bump,bump);drawCard(ctx,cw,ch,strip?String(k+1).padStart(2,"0")+"  "+label:label,on,k,o,strip)});
   return {x:p.x-cw/2,y:p.y-ch/2,w:cw,h:ch};
  });
  if(o.count&&reached>0){const size=Math.max(22,Math.round(Math.min(cw*.05,40)));chip(ctx,reached,text(o.count,24),left+cw/2,placed[n-1].y+ch+size*2.2,size,o)}
  return {cards:placed,folded:span(t,reach(n-1),reach(n-1)+.3),reached};
 }

 // The old way against the new, upright: the old way's strips stacked across the column and struck through in
 // turn, then the product's card big beneath them, joined by a leader running down.
 function versusDown(ctx,t,o,items){
  pal=tone(t);
  const n=items.length,old=n>1?items.slice(0,n-1):items,winner=items[n-1],W=env.width,H=env.height,M=96;
  const left=num(o.x,M),colW=Math.min(num(o.w,W-M*2),W-left-48),{at,stagger,struckAt,winAt}=versusTiming(o,old.length);
  const cw=colW,ch=Math.min(cw*.56,H*.24),chipSize=Math.max(22,Math.round(Math.min(cw*.05,40))),gap=72;
  // The strips take what the product's card and its count leave of the column below where they were asked.
  const top=num(o.y,H*.3),room=H-M*.4-chipSize*3.4-ch-gap-top,sh=Math.max(48,Math.min(110,(room-(old.length-1)*18)/old.length));
  const stripsEnd=top+old.length*(sh+18)-18;
  const placed=[];
  let struck=0;
  old.forEach((label,k)=>{
   const y=top+k*(sh+18),cx=left+colW/2,cy=y+sh/2,u=env.ease.expoOut(span(t,struckAt(k),struckAt(k)+.3));
   if(u>0)struck+=u>=1?1:0;
   placed.push({x:left,y,w:colW,h:sh});
   ctx.save();ctx.globalAlpha*=lerp(1,.45,u);
   pop(ctx,t,{x:cx,y:cy,at:at+k*stagger},()=>drawCard(ctx,colW,sh,label,false,k,o,true));
   ctx.restore();
   if(u>0){ctx.save();ctx.fillStyle=String(pal.accent);ctx.fillRect(left-12,cy-5,(colW+24)*u,10);ctx.restore()}
  });
  // Beneath the strips wherever it is asked to stand: a place chosen for a smaller card once set it over the last
  // of them. Then clear of the frame's foot with its count under it.
  const wx=num(o.winnerX,left+colW/2),wy=Math.min(Math.max(num(o.winnerY,0),stripsEnd+gap+ch/2),H-M*.4-chipSize*3.4-ch/2);
  lead(ctx,t,[[wx,stripsEnd+10],[wx,wy-ch/2-14]],{at:winAt-.05,duration:.35,color:String(o.line??pal.ink),width:4,dot:7});
  pop(ctx,t,{x:wx,y:wy,at:winAt+.25,duration:.5},()=>drawCard(ctx,cw,ch,winner,true,n-1,o));
  placed.push({x:wx-cw/2,y:wy-ch/2,w:cw,h:ch});
  const won=span(t,winAt+.25,winAt+.75);
  // The old way's count until the product arrives, then the product's own under it: one at a time, never the old
  // one left standing on the card as it lands.
  if(o.count&&span(t,at,at+.3)>0)chip(ctx,won>0?1:old.length,text(o.count,24),wx,won>0?wy+ch/2+chipSize*2.2:stripsEnd+chipSize*1.6,chipSize,o);
  return {cards:placed,folded:won,struck};
 }

 // Progress that lands: past 1 and back, ringing out by u = 1 — what a letter, a dot or a card does when it
 // arrives with weight, and what none of env.ease does. bounce is how far its first swing goes past (0 lands
 // as ease.out does), swings how many times it crosses before it settles. Closed form, so a frame is the same
 // however it is reached.
 function spring(u,o={}){
  u=clamp01(u);
  const bounce=Math.min(.9,Math.max(0,num(o.bounce,.3))),swings=Math.min(6,Math.max(.5,num(o.swings,2)));
  if(u>=1)return 1;
  if(bounce<=.001)return env.ease.out(u);
  const w=swings*Math.PI,decay=-Math.log(bounce)*w/Math.PI;
  return 1-Math.exp(-decay*u)*Math.cos(w*u)*(1-u*u*u);
 }

 // A point s (0..1) along a smooth curve through the points — a Catmull-Rom spline, s spread evenly over its
 // spans rather than its length — and the way the curve runs there, for setting things along an arc.
 function along(points,s){
  const p=Array.isArray(points)?points.slice(0,32).filter((q)=>Array.isArray(q)&&q.length>=2).map((q)=>[num(q[0],0),num(q[1],0)]):[];
  if(p.length===0)return {x:0,y:0,angle:0};
  if(p.length===1)return {x:p[0][0],y:p[0][1],angle:0};
  const spans=p.length-1,f=Math.min(spans,Math.max(0,num(s,0)*spans)),i=Math.min(spans-1,Math.floor(f)),u=f-i;
  const a=p[Math.max(0,i-1)],b=p[i],c=p[i+1],d=p[Math.min(spans,i+2)];
  const at=(k)=>.5*(2*b[k]+(-a[k]+c[k])*u+(2*a[k]-5*b[k]+4*c[k]-d[k])*u*u+(-a[k]+3*b[k]-3*c[k]+d[k])*u*u*u);
  const slope=(k)=>.5*((-a[k]+c[k])+2*(2*a[k]-5*b[k]+4*c[k]-d[k])*u+3*(-a[k]+3*b[k]-3*c[k]+d[k])*u*u);
  return {x:at(0),y:at(1),angle:Math.atan2(slope(1),slope(0))};
 }

 // A word set letter by letter, each at its own place in its font (advances measured on the word so far, so
 // kerning and tracking are the font's), y its baseline, every letter able to move on its own: how kinetic type
 // is made. Measuring each letter's place is what a program gets wrong by hand, and a shape meant to become a
 // letter lands beside it. A letter arrives on a spring — "drop" falls onto the baseline, "scatter" tumbles in
 // from across the frame, "spool" is flung out of the point from along an arc, growing as it comes, as a word
 // unspooling from a spinning mark — in its turn by order; "none" sets it still. pose(letter, p) moves a letter
 // as the program likes instead, p its spring's progress. Returns each letter's resting place and ink box.
 function glyphs(ctx,t,o={}){
  pal=tone(t);
  let said=text(o.text,80);
  if(o.case==="upper")said=said.toUpperCase();else if(o.case==="lower")said=said.toLowerCase();
  const chars=[...said],tracking=num(o.tracking,0);
  let size=Math.max(4,Math.min(600,num(o.size,140)));
  ctx.save();
  ctx.font=fontOf({...o,weight:num(o.weight,700)},size);ctx.letterSpacing=tracking+"px";
  // Fitted to width where asked, but never under min: a word too long for the frame at its floor overflows
  // rather than shrinking into a caption.
  const room=num(o.width,0),measured=ctx.measureText(said).width;
  if(room>0&&measured>room){size=Math.max(Math.min(size,Math.max(4,num(o.min,4))),size*room/measured);ctx.font=fontOf({...o,weight:num(o.weight,700)},size)}
  const width=ctx.measureText(said).width,align=o.align==="center"||o.align==="right"?o.align:"left";
  const base=num(o.y,env.height*.5+size*.36),x0=num(o.x,align==="left"?96:env.width/2);
  const left=align==="center"?x0-width/2:align==="right"?x0-width:x0;
  const letters=chars.map((ch,i)=>{
   const before=ctx.measureText(chars.slice(0,i).join("")).width,m=ctx.measureText(ch),w=num(m.width,size*.5);
   const inkL=left+before-num(m.actualBoundingBoxLeft,0),inkR=left+before+num(m.actualBoundingBoxRight,w-tracking);
   const ascent=num(m.actualBoundingBoxAscent,size*.72),descent=num(m.actualBoundingBoxDescent,0);
   return {ch,i,x:left+before+(w-tracking)/2,y:base,w:w-tracking,ink:{x:inkL,y:base-ascent,w:inkR-inkL,h:ascent+descent}};
  });
  const n=letters.length,at=num(o.at,0),stagger=Math.min(.5,Math.max(0,num(o.stagger,.06))),dur=Math.min(4,Math.max(.05,num(o.duration,.7)));
  const order=o.order==="right"||o.order==="center"||o.order==="random"?o.order:"left";
  const rank=letters.map((_,i)=>order==="right"?n-1-i:order==="center"?Math.abs(i-(n-1)/2):i);
  if(order==="random"){const shuffled=letters.map((_,i)=>i).sort((a,b)=>env.random(a*17+3)-env.random(b*17+3));shuffled.forEach((i,k)=>{rank[i]=k})}
  const arrive=o.arrive==="drop"||o.arrive==="scatter"||o.arrive==="spool"||o.arrive==="none"?o.arrive:"drop";
  const from=Array.isArray(o.from)?[num(o.from[0],left),num(o.from[1],base)]:[left-size*.4,base-size*.4];
  ctx.letterSpacing="0px";ctx.textAlign="center";ctx.textBaseline="alphabetic";ctx.fillStyle=String(o.color??pal.ink);
  let done=at;
  letters.forEach((g,i)=>{
   const start=at+rank[i]*stagger,u=span(t,start,start+dur),p=arrive==="none"?1:spring(u,{bounce:o.bounce,swings:o.swings});
   done=Math.max(done,start+dur);
   if(arrive!=="none"&&t<start&&typeof o.pose!=="function")return;
   const r=(k)=>env.random(i*31+k)-.5,mid=g.y-g.ink.h*.4;
   let pose;
   if(typeof o.pose==="function")pose=o.pose(Object.freeze({...g,ink:Object.freeze({...g.ink})}),p)||{};
   else if(arrive==="drop")pose={x:g.x,y:lerp(g.y-size*1.4,g.y,p),angle:r(1)*.6*(1-Math.min(1,p)),alpha:clamp01(u*6)};
   else if(arrive==="scatter")pose={x:lerp(g.x+r(1)*env.width*.6,g.x,p),y:lerp(g.y+r(2)*env.height*.6,g.y,p),angle:r(3)*Math.PI*2*(1-p),scale:lerp(.3,1,p),alpha:clamp01(u*4)};
   else if(arrive==="spool"){
    // Out of the point and over an arc lifted above the word, tumbling as it flies and growing as it comes.
    const q=Math.min(1,Math.max(0,p)),lift=Math.min(from[1],g.y)-size*(1.2+.6*Math.abs(r(4))),cx=(from[0]+g.x)/2;
    const bx=(1-q)*(1-q)*from[0]+2*(1-q)*q*cx+q*q*g.x,by=(1-q)*(1-q)*from[1]+2*(1-q)*q*lift+q*q*g.y;
    pose={x:bx,y:by+(p-q)*size*.3,angle:(r(5)>0?1:-1)*Math.PI*1.5*(1-q),scale:lerp(.25,1,q)*(1+(p-q)*.4),alpha:clamp01(u*8)};
   }
   else pose={};
   const k=Math.max(0,Math.min(8,num(pose.scale,1))),alpha=clamp01(num(pose.alpha,1));
   if(k<=0||alpha<=0)return;
   ctx.save();ctx.globalAlpha*=alpha;
   if(pose.color)ctx.fillStyle=String(pose.color);
   // Turned and scaled about the middle of its ink, as a thrown letter turns.
   const px=num(pose.x,g.x),py=num(pose.y,g.y)-(g.y-mid);
   ctx.translate(px,py);ctx.rotate(num(pose.angle,0));ctx.scale(k,k);ctx.fillText(g.ch,0,g.y-mid);
   ctx.restore();
  });
  ctx.restore();
  return {letters:letters.map((g)=>Object.freeze({...g,ink:Object.freeze(g.ink)})),width,left,base,size,done};
 }

 // The easings ride along under the kit's name too: programs reach for k.ease as often as env.ease, and a beat
 // whose every frame threw on it once shipped as an empty field that its check could not explain.
 return Object.freeze({span,words,brackets,box,connector,lead,pop,camera,grid,stipple,counter,screen,highlight,feature,field,dots,bars,headline,cards,glyphs,along,spring,ground,ease:env.ease,style:styleName});
}
`
