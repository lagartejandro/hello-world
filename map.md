/# Deployment spec: Camino × 2026 eclipse interactive map

**For:** Claude Code, running locally inside the `hello-world` project repo
**Goal:** Add a self-contained interactive map (Camino Francés overlaid with the Aug 12 2026 total-solar-eclipse path) to the site and deploy it to lagartejandro.com.

---

## 0. Context for Claude Code

This is a single self-contained HTML page — no build step, no npm install, no external JS dependencies (the only network calls at runtime are to load a font/icon set, and the map draws on a `<canvas>` with inline data). It can be deployed as a static file by literally any host.

The full file contents are in **Section 4** below. Treat that as the source of truth; do not regenerate the visualization logic.

The human is non-adversarial and wants this live on their own site. Everything here is intended to run in *their* repo on *their* machine — not in any sandbox.

---

## 1. Things to confirm before deploying (detect, don't assume)

Claude Code should inspect the repo and confirm each of these. Where the human hasn't specified, detect from the repo and state your finding before proceeding.

1. **Host / deploy mechanism.** Look for the tell-tale config:
   - `.github/workflows/*.yml` + a `gh-pages` branch or `pages` config → **GitHub Pages**
   - `netlify.toml` or a Netlify-linked repo → **Netlify**
   - `vercel.json` or `.vercel/` → **Vercel**
   - `CNAME` file → custom domain already wired (likely GitHub Pages)
   - plain repo with an `index.html` at root and no CI → **manual static upload / rsync / FTP**
   - a static-site generator (`_config.yml` = Jekyll, `astro.config.*`, `next.config.*`, `gatsby-config.*`, `hugo.toml`) → follow that generator's content conventions (see §3).
2. **Where pages live.** Root? `/public`? `/src/pages`? `/content`? `/_posts`? Match the existing structure.
3. **Is this its own page or embedded?**
   - *Own page* (default assumption): create `eclipse-camino.html` (or the generator's equivalent).
   - *Embedded*: insert the markup into an existing page inside a container; see §3.4.
4. **Custom domain status.** Confirm lagartejandro.com is already the configured domain for this repo (CNAME / host dashboard). **Do not change DNS or domain settings** — if the domain isn't wired up, stop and tell the human; that's theirs to configure.

> ✏️ **Human can pre-fill any of these to skip detection:**
> - Host: `__________`
> - Pages directory: `__________`
> - Own page or embed: `__________`
> - Desired URL path (e.g. `/eclipse`): `__________`

---

## 2. Acceptance criteria

- [ ] The page renders the interactive map: Camino route in orange, eclipse totality band in blue, dashed centerline, toggle buttons (Show both / Camino only / Eclipse only), and hover tooltips on towns.
- [ ] Page works as a **static file** — opening it directly in a browser (`file://`) shows the working map. No server-side code required.
- [ ] No console errors on load.
- [ ] Mobile-viewport friendly: the canvas scales to container width (it already uses a fixed internal resolution scaled by CSS width).
- [ ] Deployed and reachable at the intended URL on lagartejandro.com.
- [ ] Nothing else on the site is broken (existing pages, nav, build).

---

## 3. Implementation steps

### 3.1 Plain static site / GitHub Pages / Netlify / Vercel (no SSG)
1. Create the file from §4 at the appropriate location:
   - GitHub Pages (root or `/docs`): `eclipse-camino.html`
   - Netlify/Vercel static: in the publish directory (often root or `/public`).
2. Add a link to it from the site's nav or `index.html` so it's discoverable, e.g.
   `<a href="/eclipse-camino.html">2026 eclipse × Camino map</a>`.
3. Commit on a branch, open a PR (or push to the deploy branch if that's the existing workflow).

### 3.2 GitHub Pages specifics
- If using a CI workflow, no extra step — merging to the deploy branch publishes it.
- If Pages serves from `/docs`, put the file in `/docs`.
- The existing `CNAME` keeps the custom domain; **do not modify it**.

### 3.3 Static-site generators
- **Jekyll:** drop as `eclipse-camino.html` with front-matter (`---\nlayout: default\ntitle: ...\n---`) at top, then the §4 body. Or place raw HTML in `/assets` and iframe it from a page.
- **Astro/Next/Gatsby/Hugo:** simplest robust route is to put the §4 file in the **static/public assets** dir (`public/` for Astro/Next, `static/` for Hugo/Gatsby) so it's served verbatim at `/eclipse-camino.html`, bypassing the component pipeline. Then link to it. (Porting the inline `<script>` into a framework component is possible but unnecessary and risks breaking the canvas logic — prefer the static-asset route unless the human wants it as a native component.)

### 3.4 Embedding into an existing page
If the human wants it inside an existing page rather than standalone, the cleanest isolation is an iframe pointing at the static file from §3.1/§3.3:
```html
<iframe src="/eclipse-camino.html" title="Camino and 2026 eclipse map"
        style="width:100%;height:560px;border:0;" loading="lazy"></iframe>
```
Avoid pasting the raw `<script>` directly into a page that has its own JS unless you've checked for variable-name collisions (this file uses short globals like `cv`, `cx`, `P`, `draw`).

### 3.5 Deploy
- Run the repo's existing deploy command if there is one (e.g. `npm run deploy`, `git push origin main`, `netlify deploy --prod`).
- **Do not** create accounts, change hosting credentials, or alter DNS. If a step needs a login the human isn't already authenticated for locally, stop and ask them to do it.
- After deploy, verify the live URL loads and the map is interactive.

---

## 4. The file — `eclipse-camino.html` (full source, copy verbatim)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Camino Francés × 2026 total solar eclipse</title>
<meta name="description" content="Interactive map overlaying the Camino Francés pilgrim route with the path of the August 12 2026 total solar eclipse across northern Spain. Eclipse path data by Fred Espenak, NASA's GSFC.">
<style>
  :root{
    --bg:#ffffff; --text:#1a1a1a; --muted:#5f5e5a; --border:rgba(0,0,0,0.15);
    --surface:#f5f3ee;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#1f1e1c; --text:#ececea; --muted:#a8a7a2; --border:rgba(255,255,255,0.18); --surface:#2a2926; }
  }
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:var(--bg);color:var(--text);line-height:1.6;}
  .wrap{max-width:760px;margin:0 auto;padding:24px 16px 48px;}
  h1{font-size:22px;font-weight:500;margin:0 0 4px;}
  .sub{color:var(--muted);font-size:14px;margin:0 0 20px;}
  #mw{position:relative;width:100%;}
  #mc{width:100%;display:block;cursor:crosshair;border-radius:8px;}
  .ctl{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
  .cb{font-size:12px;padding:5px 11px;border-radius:6px;border:0.5px solid var(--border);
    background:var(--bg);color:var(--muted);cursor:pointer;}
  .cb.on{background:var(--surface);color:var(--text);}
  .lg{display:flex;flex-wrap:wrap;gap:14px;padding:12px 0 4px;}
  .li{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);}
  .sw{width:22px;height:4px;border-radius:2px;flex-shrink:0;}
  .sw.dot{width:10px;height:10px;border-radius:50%;}
  #tt{position:absolute;pointer-events:none;background:var(--bg);border:0.5px solid var(--border);
    border-radius:8px;padding:6px 10px;font-size:13px;color:var(--text);white-space:nowrap;
    display:none;z-index:10;line-height:1.4;}
  .cap{font-size:12px;color:var(--muted);margin-top:18px;}
  .cap a{color:inherit;}
</style>
</head>
<body>
<div class="wrap">
  <h1>Camino Francés × 2026 total solar eclipse</h1>
  <p class="sub">The path of totality for the August 12, 2026 eclipse, overlaid on the Camino de Santiago (French Way). Toggle layers; hover any town.</p>

  <div id="mw">
    <div class="ctl">
      <button class="cb on" id="b-both" onclick="setL('both')">Show both</button>
      <button class="cb" id="b-cam" onclick="setL('cam')">Camino only</button>
      <button class="cb" id="b-ecl" onclick="setL('ecl')">Eclipse only</button>
    </div>
    <div id="tt"></div>
    <canvas id="mc"></canvas>
    <div class="lg">
      <div class="li"><div class="sw" style="background:#D9821A;height:3px;"></div> Camino Francés</div>
      <div class="li"><div class="sw" style="background:#3A6FB0;opacity:0.4;height:7px;"></div> Path of totality</div>
      <div class="li"><div class="sw" style="background:none;border-top:2px dashed #1A4F8C;"></div> Centerline</div>
      <div class="li"><div class="sw dot" style="background:#D9821A;"></div> Camino town</div>
      <div class="li"><div class="sw dot" style="background:#C43D14;"></div> In totality</div>
    </div>
  </div>

  <p class="cap">Eclipse path computed from the official path table by Fred Espenak, NASA's GSFC (eclipse.gsfc.nasa.gov). Camino route approximated from town coordinates; for the exact trail, swap in a GeoJSON/GPX track. Totality-edge classification for borderline towns should be confirmed against a detailed source.</p>
</div>

<script>
const cv=document.getElementById('mc'),cx=cv.getContext('2d');
const tt=document.getElementById('tt'),mw=document.getElementById('mw');
let L='both';
function setL(l){L=l;
  document.getElementById('b-both').classList.toggle('on',l==='both');
  document.getElementById('b-cam').classList.toggle('on',l==='cam');
  document.getElementById('b-ecl').classList.toggle('on',l==='ecl');
  draw();}

const LO0=-9.5,LO1=4.0,LA0=39.5,LA1=44.6;
const W=680,H=400;
function sizeCanvas(){
  const dpr=window.devicePixelRatio||1;
  cv.width=W*dpr;cv.height=H*dpr;
  cv.style.width='100%';cv.style.aspectRatio=W+'/'+H;
  cx.setTransform(dpr*(cv.clientWidth/W||1),0,0,dpr*(cv.clientWidth/W||1),0,0);
}
function P(lo,la){return [(lo-LO0)/(LO1-LO0)*W,(1-(la-LA0)/(LA1-LA0))*H];}

const eclNorth=[[-(8+48.1/60),45+48.1/60],[-(4+56.9/60),44+27.4/60],[-(2+5.1/60),42+54.5/60],[(3+17.7/60),40+39.9/60]];
const eclSouth=[[-(13+0.5/60),45+59.0/60],[-(11+25.2/60),44+49.9/60],[-(9+33.1/60),43+36.4/60],[-(7+14.2/60),42+15.8/60],[-(4+2.4/60),40+41.0/60]];
const eclCenter=[[-(10+11.4/60),45+56.6/60],[-(8+23.9/60),44+42.8/60],[-(6+11.3/60),43+22.3/60],[-(3+11.1/60),41+49.0/60],[(2+57.0/60),39+24.5/60]];

const cam=[
  [-1.2367,43.1633,'Saint-Jean-Pied-de-Port'],[-1.3197,43.0092,'Roncesvalles'],[-1.6432,42.8125,'Pamplona'],
  [-1.8141,42.6720,'Puente la Reina'],[-2.0317,42.6713,'Estella'],[-2.3514,42.5611,'Los Arcos'],
  [-2.4449,42.4668,'Logroño'],[-2.7339,42.4158,'Nájera'],[-2.9536,42.4406,'Santo Domingo de la Calzada'],
  [-3.2706,42.3756,'Belorado'],[-3.6097,42.3796,'San Juan de Ortega'],[-3.7038,42.3408,'Burgos'],
  [-4.0610,42.3711,'Hornillos del Camino'],[-4.2486,42.3328,'Castrojeriz'],[-4.4060,42.2670,'Frómista'],
  [-4.6027,42.3380,'Carrión de los Condes'],[-4.9009,42.3705,'Calzadilla'],[-5.0290,42.3700,'Sahagún'],
  [-5.3970,42.4870,'Mansilla de las Mulas'],[-5.5671,42.5987,'León'],[-5.7790,42.4870,'Villar de Mazarife'],
  [-6.0610,42.4570,'Astorga'],[-6.2060,42.4910,'Rabanal del Camino'],[-6.4400,42.4880,'Molinaseca'],
  [-6.5983,42.5505,'Ponferrada'],[-6.8086,42.6065,'Villafranca del Bierzo'],[-7.0420,42.7090,'O Cebreiro'],
  [-7.2580,42.7820,'Triacastela'],[-7.4140,42.7780,'Sarria'],[-7.6160,42.8070,'Portomarín'],
  [-7.8690,42.8730,'Palas de Rei'],[-8.0140,42.9140,'Melide'],[-8.1620,42.9280,'Arzúa'],
  [-8.3580,42.9080,'O Pedrouzo'],[-8.5446,42.8806,'Santiago de Compostela']
];

function lerpAt(arr,lon){
  const pts=[...arr].sort((a,b)=>a[0]-b[0]);
  if(lon<=pts[0][0])return pts[0][1];
  if(lon>=pts[pts.length-1][0])return pts[pts.length-1][1];
  for(let i=0;i<pts.length-1;i++){
    if(lon>=pts[i][0]&&lon<=pts[i+1][0]){
      const t=(lon-pts[i][0])/(pts[i+1][0]-pts[i][0]);
      return pts[i][1]+t*(pts[i+1][1]-pts[i][1]);
    }
  }
  return pts[pts.length-1][1];
}
function inTotality(lon,lat){
  if(lon<-9.5||lon>3.5)return false;
  return lat<=lerpAt(eclNorth,lon)&&lat>=lerpAt(eclSouth,lon);
}

const coast=[[-9.3,43.0],[-9.0,43.5],[-8.5,43.7],[-7.5,43.75],[-6.5,43.6],[-5.5,43.55],[-4.5,43.45],
  [-3.5,43.45],[-2.5,43.45],[-1.8,43.4],[-1.5,43.35],[-1.0,43.3],[0.5,42.9],[1.5,42.5],
  [2.5,42.3],[3.3,42.1],[3.2,41.2],[2.0,41.2],[0.8,40.7],[0.0,40.0],[-0.3,39.5]];

let hov=null;
function draw(){
  cx.clearRect(0,0,W,H);
  cx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--surface')||'#E7EFF6';
  cx.fillStyle='#E7EFF6';cx.fillRect(0,0,W,H);
  cx.fillStyle='#D3E4F2';cx.fillRect(0,0,P(-8.8,0)[0],H);
  cx.beginPath();cx.fillStyle='#F4F1E9';
  coast.forEach(([lo,la],i)=>{const[x,y]=P(lo,la);i?cx.lineTo(x,y):cx.moveTo(x,y);});
  cx.lineTo(W,H);cx.lineTo(0,H);cx.closePath();cx.fill();
  cx.strokeStyle='rgba(0,0,0,0.05)';cx.lineWidth=0.5;
  for(let lo=-8;lo<=3;lo+=2){const[x]=P(lo,40);cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,H);cx.stroke();}
  for(let la=40;la<=44;la++){const[,y]=P(-9,la);cx.beginPath();cx.moveTo(0,y);cx.lineTo(W,y);cx.stroke();}
  if(L==='ecl'||L==='both'){
    cx.beginPath();
    eclNorth.forEach(([lo,la],i)=>{const[x,y]=P(lo,la);i?cx.lineTo(x,y):cx.moveTo(x,y);});
    [...eclSouth].reverse().forEach(([lo,la])=>{const[x,y]=P(lo,la);cx.lineTo(x,y);});
    cx.closePath();cx.fillStyle='rgba(58,111,176,0.20)';cx.fill();
    cx.strokeStyle='rgba(58,111,176,0.55)';cx.lineWidth=1;cx.stroke();
    cx.beginPath();cx.setLineDash([6,4]);cx.strokeStyle='#1A4F8C';cx.lineWidth=1.6;
    eclCenter.forEach(([lo,la],i)=>{const[x,y]=P(lo,la);i?cx.lineTo(x,y):cx.moveTo(x,y);});
    cx.stroke();cx.setLineDash([]);
    cx.fillStyle='rgba(26,79,140,0.7)';cx.font='10px sans-serif';cx.textAlign='center';
    const[lx,ly]=P(-7.0,44.2);cx.fillText('Path of totality — NW → SE',lx,ly);
  }
  if(L==='cam'||L==='both'){
    cx.beginPath();cx.strokeStyle='#D9821A';cx.lineWidth=2.6;cx.lineJoin='round';cx.lineCap='round';
    cam.forEach(([lo,la],i)=>{const[x,y]=P(lo,la);i?cx.lineTo(x,y):cx.moveTo(x,y);});
    cx.stroke();
  }
  cx.font='9px sans-serif';cx.fillStyle='rgba(0,0,0,0.32)';cx.textAlign='center';
  for(let lo=-8;lo<=2;lo+=2){const[x,y]=P(lo,LA0+0.08);cx.fillText((lo<0?Math.abs(lo)+'°W':lo+'°E'),x,y+9);}
  cx.textAlign='right';
  for(let la=40;la<=44;la++){const[x,y]=P(LO0+0.08,la);cx.fillText(la+'°N',x+20,y+3);}
  if(L==='cam'||L==='both'){
    cam.forEach(([lo,la,nm])=>{
      const[x,y]=P(lo,la);const tot=inTotality(lo,la);const h=hov===nm;
      cx.beginPath();cx.arc(x,y,tot?(h?6.5:5):(h?5:3.4),0,7);
      cx.fillStyle=tot?'#C43D14':'#D9821A';cx.fill();
      cx.strokeStyle='#fff';cx.lineWidth=tot?1.5:1;cx.stroke();
      const big=['Saint-Jean-Pied-de-Port','Pamplona','Logroño','Burgos','León','Astorga','Ponferrada','Sarria','Santiago de Compostela'];
      if(big.includes(nm)||h){
        cx.save();cx.font=h?'11px sans-serif':'10px sans-serif';cx.fillStyle=h?'#111':'#3a3a3a';cx.textAlign='left';
        let dx=x+6,dy=y-4;
        if(nm==='Santiago de Compostela'){dx=x;dy=y+13;cx.textAlign='center';}
        if(nm==='León'){dx=x+6;dy=y-5;}
        if(nm==='Pamplona'){dy=y-6;}
        if(nm==='Logroño'){dx=x-6;cx.textAlign='right';}
        if(nm==='Astorga'){dy=y+13;}
        cx.fillText(nm,dx,dy);cx.restore();
      }
    });
  }
}
function evtToCanvas(e){
  const r=cv.getBoundingClientRect();
  return [ (e.clientX-r.left)/r.width*W, (e.clientY-r.top)/r.height*H ];
}
cv.addEventListener('mousemove',e=>{
  const[mx,my]=evtToCanvas(e);
  let f=null;
  cam.forEach(([lo,la,nm])=>{const[x,y]=P(lo,la);if(Math.hypot(mx-x,my-y)<9)f=nm;});
  if(f!==hov){hov=f;draw();}
  if(f){
    const c=cam.find(p=>p[2]===f);const tot=inTotality(c[0],c[1]);
    tt.innerHTML=`<strong>${f}</strong><br>`+(tot?`<span style="color:#C43D14">In the path of totality</span>`:`<span style="color:var(--muted)">Partial eclipse only</span>`);
    tt.style.display='block';
    tt.style.left=(e.clientX-mw.getBoundingClientRect().left+12)+'px';
    tt.style.top=(e.clientY-mw.getBoundingClientRect().top-10)+'px';
  }else tt.style.display='none';
});
cv.addEventListener('mouseleave',()=>{tt.style.display='none';hov=null;draw();});
window.addEventListener('resize',()=>{sizeCanvas();draw();});
sizeCanvas();draw();
</script>
</body>
</html>
```

---

## 5. Notes & known limitations (so Claude Code doesn't "fix" them incorrectly)

- **Eclipse band edges look slightly angular.** Intentional — the band is interpolated between Espenak's 2-minute path waypoints. Don't add fake smoothing that would misrepresent the data.
- **The Camino is town-to-town, not the true trail.** To upgrade: replace the `cam` array with coordinates parsed from `camino-frances-route.geojson` (downloadable from caminofrances.info). If the human provides that file, decimate it to ~150–400 points and replace the polyline source. This is optional and not required for deploy.
- **Self-contained on purpose.** Don't split into separate JS/CSS files unless the human asks; the single-file form is what makes it trivially portable.
- **Attribution must stay.** Keep the Espenak/NASA credit line in the caption — it's the data license condition.

---

## 6. Definition of done

Deployed to lagartejandro.com at the agreed path, map interactive, no console errors, existing site intact, and the live URL reported back to the human.
