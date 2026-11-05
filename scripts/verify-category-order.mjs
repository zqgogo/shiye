import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile } from './lib/launch-extension.mjs';
const dir = path.join(ROOT, '.verify/category-order'); fs.mkdirSync(dir, { recursive:true });
const edge = BROWSERS.find((row) => row.name === 'Edge'); if (!edge) throw new Error('需要 Edge');
const { browser, extId } = await launchBestEffort(edge, prepareProfile(dir, 'order'));
const page = await browser.newPage(); const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
async function rows() { return page.evaluate(async()=>{ const req=indexedDB.open('shiye'); const db=await new Promise(r=>req.onsuccess=()=>r(req.result)); const q=db.transaction('categories').objectStore('categories').getAll(); const result=await new Promise(r=>q.onsuccess=()=>r(q.result)); db.close(); return result; }); }
async function drag(source, target, fraction) {
 await page.evaluate(({source,target,fraction})=>{
  const node=name=>[...document.querySelectorAll('.category-drop')].find(n=>n.title===name);
  const from=node(source), to=node(target); if(!from||!to) throw new Error('缺少目录');
  const dt=new DataTransfer(); from.querySelector('.drag-handle').dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
  const rect=to.getBoundingClientRect(), init={bubbles:true,dataTransfer:dt,clientX:rect.x+60,clientY:rect.y+rect.height*fraction};
  to.dispatchEvent(new DragEvent('dragover',init)); to.dispatchEvent(new DragEvent('drop',init)); from.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));
 },{source,target,fraction});
 await page.waitForFunction(()=>document.body.innerText.includes('撤销上次移动 / 排序'));
}
const order=(items,parent=null)=>items.filter(r=>(r.parentId??null)===parent).sort((a,b)=>a.sortOrder-b.sortOrder).map(r=>r.name);
try {
 await page.setViewport({width:1400,height:1000}); await page.goto(`chrome-extension://${extId}/workspace.html`); await page.waitForSelector('.organization-tree');
 await page.evaluate(async()=>{const req=indexedDB.open('shiye');const db=await new Promise(r=>req.onsuccess=()=>r(req.result));const tx=db.transaction('categories','readwrite'); const time=new Date().toISOString(); for(const [i,name] of ['A','B','C'].entries()) tx.objectStore('categories').put({id:crypto.randomUUID(),name,parentId:null,description:'',revision:1,sortOrder:(i+1)*1024,createdAt:time,updatedAt:time}); await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=j;});db.close();});
 await page.reload(); await page.waitForFunction(()=>document.querySelectorAll('.category-drop').length===3);
 await drag('C','A',.1); assert.deepEqual(order(await rows()),['C','A','B']);
 await page.reload(); await page.waitForSelector('.category-drop');
 await drag('C','B',.9); assert.deepEqual(order(await rows()),['A','B','C']);
 await page.reload(); await page.waitForSelector('.category-drop');
 await drag('C','A',.5); const stored=await rows(); assert.equal(stored.find(r=>r.name==='C').parentId,stored.find(r=>r.name==='A').id);
 await page.reload(); await page.waitForSelector('.category-drop'); assert.equal(await page.$$('.category-drop').then(r=>r.length),2);
 assert.deepEqual(errors,[]); console.log('PASS Edge: 前移、末尾、移入分类、刷新后排序与默认折叠（真实扩展 + IndexedDB）');
 await page.screenshot({path:path.join(dir,'result.png')});
} finally { await browser.close(); }
