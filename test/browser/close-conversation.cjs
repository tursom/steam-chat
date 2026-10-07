// npm run build; NODE_PATH=<Playwright>/node_modules node test/browser/close-conversation.cjs
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:900}}), errors=[];
 page.on('pageerror',e=>errors.push(e.message)); await page.routeWebSocket(/.*/,()=>{});
 const account='76561198000000002',alice='76561198000000001',bob='76561198000000003';
 const steam={status:'online',steamId:account,activeAccount:{id:1,steamId:account},accessAllowed:true};
 const conversations=[{id:alice,name:'Alice',preview:'hi',updatedAt:'2026-10-07T10:00:00.000Z'},{id:bob,name:'Bob',preview:'yo',updatedAt:'2026-10-07T09:00:00.000Z'}];
 const fixtures={'/api/auth/me':{user:{id:1,username:'Test',role:'user'},permissions:['chat.use'],steam},'/api/steam/status':steam,
 '/api/config':{wsPath:'/ws'},'/api/history/status':{},'/api/friends':[{id:alice,name:'Alice'},{id:bob,name:'Bob'}],'/api/groups':[],
 '/api/emoticons':{emoticons:[],stickers:[]},'/api/history':{items:[]},'/api/message-reactions':{items:[]}};
 await page.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem('steam-chat.view','chat');}});
 await page.route('http://close.test/**',async route=>{const url=new URL(route.request().url());
  if(url.pathname==='/api/conversations')return route.fulfill({json:{items:conversations}});
  if(fixtures[url.pathname])return route.fulfill({json:fixtures[url.pathname]});
  const file=path.join(__dirname,'../../dist/web',url.pathname==='/'?'index.html':url.pathname);
  try{return route.fulfill({body:await fs.readFile(file),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}
 });
 const names=()=>page.locator('#chatListSections .list-item strong').allTextContents();
 await page.goto('http://close.test/');
 await page.waitForFunction(()=>document.querySelectorAll('#chatListSections .list-item').length===2);
 const aliceItem=page.locator('#chatListSections .list-item',{hasText:'Alice'});
 await aliceItem.click();
 if(width<700)await page.getByRole('button',{name:'返回会话列表'}).click();
 // Escape dismisses the menu without acting.
 await aliceItem.click({button:'right'});
 await page.getByRole('menu').waitFor();
 await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('menu').count(),0);
 assert.deepEqual(await names(),['Alice','Bob']);
 // Closing the open conversation removes it and clears the thread.
 await aliceItem.click({button:'right'});
 await page.getByRole('menuitem',{name:'关闭会话'}).click();
 assert.deepEqual(await names(),['Bob']);
 assert.equal(await page.locator('#chatLayout').getAttribute('data-has-conversation'),'false');
 assert.equal(await page.evaluate(()=>localStorage.getItem('steam-chat.target')),null);
 // Stays closed across reloads until a newer message arrives.
 await page.reload();
 await page.waitForFunction(()=>document.querySelectorAll('#chatListSections .list-item').length===1);
 assert.deepEqual(await names(),['Bob']);
 conversations[0]={...conversations[0],preview:'new',updatedAt:'2026-10-07T11:00:00.000Z'};
 await page.reload();
 await page.waitForFunction(()=>document.querySelectorAll('#chatListSections .list-item').length===2);
 assert.deepEqual(await names(),['Alice','Bob']);
 // Opening a closed conversation from the friends tab restores it in recent.
 await page.locator('#chatListSections .list-item',{hasText:'Bob'}).click({button:'right'});
 await page.getByRole('menuitem',{name:'关闭会话'}).click();
 assert.deepEqual(await names(),['Alice']);
 await page.getByRole('tab',{name:'好友'}).click();
 const bobFriend=page.locator('#chatListSections .list-item',{hasText:'Bob'});
 await bobFriend.click({button:'right'});
 assert.equal(await page.getByRole('menu').count(),0,'only recent conversations get the custom menu');
 await page.keyboard.press('Escape');
 await bobFriend.click();
 if(width<700)await page.getByRole('button',{name:'返回会话列表'}).click();
 await page.getByRole('tab',{name:'最近'}).click();
 assert.deepEqual(await names(),['Alice','Bob']);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);console.log(`PASS ${width}px: right-click menu, close active, persist, reappear on new message, reopen from friends, Escape`);await page.close();
}}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
