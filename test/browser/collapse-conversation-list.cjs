// npm run build; NODE_PATH=<Playwright>/node_modules node test/browser/collapse-conversation-list.cjs
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{for(const width of [1440,820,390]){
 const page=await browser.newPage({viewport:{width,height:900}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message)); await page.routeWebSocket(/.*/,()=>{});
 const account='76561198000000002',alice='76561198000000001',bob='76561198000000003';
 const steam={status:'online',steamId:account,activeAccount:{id:1,steamId:account},accessAllowed:true};
 const fixtures={'/api/auth/me':{user:{id:1,username:'Test',role:'user'},permissions:['chat.use'],steam},'/api/steam/status':steam,
 '/api/config':{wsPath:'/ws'},'/api/history/status':{},'/api/friends':[{id:alice,name:'Alice'},{id:bob,name:'Bob'}],'/api/groups':[],
 '/api/conversations':{items:[{id:alice,name:'Alice',preview:'hi',updatedAt:'2026-10-07T10:00:00.000Z'},{id:bob,name:'Bob',preview:'yo',updatedAt:'2026-10-07T09:00:00.000Z'}]},
 '/api/emoticons':{emoticons:[],stickers:[]},'/api/history':{items:[]},'/api/message-reactions':{items:[]}};
 await page.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem('steam-chat.view','chat');}});
 await page.route('http://collapse.test/**',async route=>{const url=new URL(route.request().url());
  if(fixtures[url.pathname])return route.fulfill({json:fixtures[url.pathname]});
  const file=path.join(__dirname,'../../dist/web',url.pathname==='/'?'index.html':url.pathname);
  try{return route.fulfill({body:await fs.readFile(file),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.svg')?'image/svg+xml':'text/html'});}catch{return route.fulfill({status:404});}
 });
 const listWidth=()=>page.locator('.chat-lists').evaluate(node=>Math.round(node.getBoundingClientRect().width));
 await page.goto('http://collapse.test/');
 await page.waitForFunction(()=>document.querySelectorAll('#chatListSections .list-item').length===2);
 const toggle=page.locator('#chatListToggle');
 if(width<=700){
  // Phones always use the full-width list; a saved desktop preference must not leak in.
  assert.equal(await toggle.isVisible(),false);
  await page.evaluate(()=>localStorage.setItem('steam-chat.list-collapsed','true'));
  await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('#chatListSections .list-item').length===2);
  assert.equal(await listWidth(),width);
  assert.equal(await page.locator('#chatListSections .item-preview').first().isVisible(),true);
 }else{
  const expanded=await listWidth();
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  await toggle.click();
  assert.equal(await page.locator('#chatLayout').getAttribute('data-list-collapsed'),'true');
  await page.waitForFunction(()=>Math.round(document.querySelector('.chat-lists').getBoundingClientRect().width)===72);
  assert.ok(expanded>200);
  assert.equal(await toggle.getAttribute('aria-label'),'展开会话列表');
  assert.equal(await page.locator('.chat-search').isVisible(),false);
  assert.deepEqual(await page.locator('#chatListSections .list-item').evaluateAll(nodes=>nodes.map(node=>node.title)),['Alice','Bob']);
  // Names stay available to assistive tech while visually hidden.
  assert.ok(await page.getByRole('button',{name:/Bob/}).count()>=1);
  await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('#chatListSections .list-item').length===2);
  assert.equal(await listWidth(),72,'collapsed preference persists');
  await page.locator('#chatListSections .list-item[title="Bob"]').click();
  assert.match(await page.locator('#threadHead').innerText(),/Bob/);
  await page.locator('#chatListSections .list-item[title="Bob"]').click({button:'right'});
  await page.getByRole('menuitem',{name:'关闭会话'}).click();
  assert.equal(await page.locator('#chatListSections .list-item').count(),1);
  await page.locator('#chatListToggle').click();
  await page.waitForFunction(w=>Math.round(document.querySelector('.chat-lists').getBoundingClientRect().width)===w,expanded);
  assert.equal(await page.locator('#chatListSections .list-item').first().getAttribute('title'),null);
  assert.equal(await page.evaluate(()=>localStorage.getItem('steam-chat.list-collapsed')),'false');
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);console.log(`PASS ${width}px: ${width<=700?'phone ignores collapsed preference':'collapse, persist, tooltips, open, right-click close, expand'}`);await page.close();
}}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
