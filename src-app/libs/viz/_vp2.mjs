import { chromium } from 'playwright'
const b = await chromium.launch()
async function run(f0,f1){ const p=await b.newPage({viewport:{width:1560,height:900}}); await p.goto('http://localhost:1483/viz-showcase.html#plot-editing',{waitUntil:'commit'}); await p.waitForSelector('[data-viz-cell]',{timeout:20000}).catch(()=>{}); await p.waitForTimeout(6000);
  await p.$eval('[data-testid="viz-tool-rail-tool-select"]',el=>el.click()).catch(()=>{}); await p.waitForTimeout(120); await p.$eval('[data-testid="viz-tool-rail-sel-rect"]',el=>el.click()).catch(()=>{}); await p.waitForTimeout(120);
  const c=await p.$('[data-viz-cell="violin"]'); const bb=await c.boundingBox();
  await p.mouse.move(bb.x+bb.width*f0[0],bb.y+bb.height*f0[1]); await p.mouse.down(); for(let i=1;i<=8;i++)await p.mouse.move(bb.x+bb.width*(f0[0]+(f1[0]-f0[0])*i/8),bb.y+bb.height*(f0[1]+(f1[1]-f0[1])*i/8)); await p.mouse.up(); await p.waitForTimeout(300);
  const r=await p.evaluate(()=>window.__violinPub??'none'); await p.close(); return r }
console.log('NARROW:', await run([0.2,0.35],[0.32,0.65]))
console.log('WIDE  :', await run([0.05,0.35],[0.95,0.65]))
console.log('LEFT  :', await run([0.05,0.4],[0.2,0.6]))
console.log('RIGHT :', await run([0.8,0.4],[0.95,0.6]))
await b.close()
