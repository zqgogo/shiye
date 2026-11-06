import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';
const dir=path.join(ROOT,'.verify/bookmark-filters');fs.mkdirSync(dir,{recursive:true});
const {browser,extId}=await launchBestEffort(BROWSERS.find(row=>row.name==='Edge') ?? BROWSERS[0],prepareProfile(dir,'filters'));
const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
const check=(text,ok)=>{assert.ok(ok,text);console.log(`PASS ${text}`);};
const click=async text=>page.evaluate(text=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===text);if(!node)throw new Error(text);node.click();},text);
try {
 await page.setViewport({width:1400,height:1000});await page.goto(`chrome-extension://${extId}/workspace.html#all`);await page.waitForSelector('.bookmark-filters');
 await page.evaluate(async()=>{const req=indexedDB.open('shiye'),db=await new Promise(resolve=>req.onsuccess=()=>resolve(req.result)),tx=db.transaction(['bookmarks','categories','tags'],'readwrite'),now=new Date().toISOString();
  const categories=[{id:'tech',name:'技术',parentId:null},{id:'web',name:'网页',parentId:'tech'},{id:'deeper',name:'工具',parentId:'web'},...Array.from({length:25},(_,i)=>({id:`extra-${i}`,name:`其他目录 ${i}`,parentId:null}))];
  for(const row of categories)tx.objectStore('categories').put({...row,description:'',revision:1,createdAt:now,updatedAt:now});
  tx.objectStore('tags').put({id:'ref',name:'参考',createdAt:now,updatedAt:now});
  for(const [i,categoryId] of ['tech','web','deeper',null].entries()){const url=`https://fixture.example/${i}`;tx.objectStore('bookmarks').put({id:`book-${i}`,originalUrl:url,canonicalUrl:url,title:`测试收藏 ${i}`,sourceDescription:'描述',note:`记录备注 ${i}`,selectedText:'',aiPurpose:'',categoryId,categoryKey:categoryId||'uncategorized',tagIds:i===1?['ref']:[],inboxUnread:true,unreadFlag:1,pinned:i===1,lastOpenedAt:null,privacy:{localOnly:false,aiBlocked:false},lockedFields:[],sources:[{sourceType:i<2?'html':'manual',capturedAt:now}],revision:1,localRevision:1,changeVersion:null,lifeState:'active',deletedAt:null,createdAt:now,updatedAt:now});}
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=reject;});db.close();});
 await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.bookmark').length===4);
 check('历史未读收藏仍完整保留，侧栏与记录不再提供未读收件箱操作',await page.evaluate(()=>![...document.querySelector('aside .navgroup').querySelectorAll(':scope > button')].some(node=>node.textContent.includes('收件箱')) && !document.querySelector('.rowactions')?.textContent.includes('已读')));
 await page.type('[aria-label="搜索当前列表"]','备注 1');check('全部收藏页内搜索标题备注等信息',await page.$$('.bookmark').then(rows=>rows.length===1));await click('清除列表筛选');
 await page.select('[aria-label="筛选来源"]','html');check('书签来源筛选',await page.$$('.bookmark').then(rows=>rows.length===2));await click('清除列表筛选');
 await page.click('.bookmark-category-filter > summary');check('分类按本级分页，不展开子孙分类',await page.$$('.category-filter-row').then(rows=>rows.length===20) && await page.$eval('.category-filter-body',node=>!node.textContent.includes('网页')));
 await page.click('[aria-label="浏览 技术 的子分类"]');await page.evaluate(()=>[...document.querySelectorAll('.category-filter-row > button:first-child')].find(node=>node.textContent==='网页').click());
 check('可逐级选择分类并默认包含子分类收藏',await page.$$('.bookmark').then(rows=>rows.length===2));
 await page.evaluate(()=>[...document.querySelectorAll('.filter-check')].find(node=>node.textContent.includes('包含子分类')).querySelector('input').click());check('可以切换为仅本级收藏',await page.$$('.bookmark').then(rows=>rows.length===1));await click('清除列表筛选');
 await setReactInput(page,'#globalSearch','测试收藏');await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='搜索结果' && document.querySelectorAll('.bookmark').length===4);
 await page.click('.bookmark-category-filter > summary');await page.type('[aria-label="搜索筛选分类"]','技术 / 网页');check('搜索结果分类支持完整路径搜索',await page.$$('.category-filter-row').then(rows=>rows.length===2));
 await page.evaluate(()=>[...document.querySelectorAll('.category-filter-row > button:first-child')].find(node=>node.textContent.startsWith('网页')).click());await page.select('[aria-label="筛选标签"]','ref');
 check('顶部搜索与层级分类、标签组合筛选',await page.$$('.bookmark').then(rows=>rows.length===1));
 await page.screenshot({path:path.join(dir,'search-filter.png'),fullPage:false});
 await click('清除列表筛选');check('清除筛选保留搜索词并恢复匹配结果',await page.$eval('#globalSearch',node=>node.value==='测试收藏') && await page.$$('.bookmark').then(rows=>rows.length===4));
 await page.goto(`chrome-extension://${extId}/workspace.html#inbox`);await page.waitForSelector('.bookmark-filters');check('旧收件箱链接兼容进入全部收藏，不隐藏原记录',await page.$eval('h1',node=>node.textContent==='全部收藏') && await page.$$('.bookmark').then(rows=>rows.length===4));
 check('无页面脚本异常',!errors.length);
} finally {await browser.close();}
