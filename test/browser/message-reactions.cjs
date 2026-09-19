// npm run build; NODE_PATH=<Playwright>/node_modules node test/browser/message-reactions.cjs
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:900}}), errors=[], updates=[];
 page.on('pageerror',e=>errors.push(e.message)); await page.routeWebSocket(/.*/,()=>{});
 const account='76561198000000002',peer='76561198000000001', timestamp=1700000000;
 const steam={status:'online',steamId:account,activeAccount:{id:1,steamId:account},accessAllowed:true};
 let reactions=[{type:2,name:'AnimationSticker8',users:[account,peer]}];
 const fixtures={'/api/auth/me':{user:{id:1,username:'Test',role:'user'},permissions:['chat.use'],steam},'/api/steam/status':steam,
 '/api/config':{wsPath:'/ws'},'/api/history/status':{},'/api/conversations':{items:[{id:peer,name:'Friend'}]},'/api/friends':[{id:peer,name:'Friend'}],'/api/groups':[],
 '/api/emoticons':{emoticons:[{name:'smile'}],stickers:[{name:'AnimationSticker8',title:'贴纸'}]},
 '/api/history':{items:[{id:peer,eventId:'message-1',sentAt:new Date(timestamp*1000).toISOString(),ordinal:0,message:'React to this'}]}};
 await page.addInitScript(()=>localStorage.setItem('steam-chat.view','chat'));
 await page.route('http://reaction.test/**',async route=>{const url=new URL(route.request().url());
 if(url.pathname==='/api/message-reactions'){
  if(route.request().method()==='GET')return route.fulfill({json:{items:[{timestamp,ordinal:0,reactions}]}});
  const body=route.request().postDataJSON(); updates.push(body);
  let current=reactions.find(r=>r.type===body.reactionType&&r.name===body.reaction);
  const users=body.add?[...new Set([...(current?.users||[]),account])]:(current?.users||[]).filter(id=>id!==account);
  reactions=reactions.filter(r=>r!==current);if(users.length)reactions.push({type:body.reactionType,name:body.reaction,users});
  return route.fulfill({json:{timestamp,ordinal:0,type:body.reactionType,name:body.reaction,users}});
 }
 if(fixtures[url.pathname])return route.fulfill({json:fixtures[url.pathname]});
 if(url.pathname.startsWith('/proxy/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="green"/></svg>'});
 const file=path.join(__dirname,'../../dist/web',url.pathname==='/'?'index.html':url.pathname);
 try{return route.fulfill({body:await fs.readFile(file),contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html'});}catch{return route.fulfill({status:404});}
 });
 await page.goto('http://reaction.test/');await page.locator('.list-item').first().click();
 const chip=page.locator('.reaction-chip');await chip.waitFor();assert.equal(await chip.textContent(),'2');assert.equal(await chip.getAttribute('aria-pressed'),'true');
 assert.match(await chip.getAttribute('title'),/你、Friend/);
 await chip.click();await page.waitForFunction(()=>document.querySelector('.reaction-chip')?.textContent==='1');
 assert.equal(updates[0].add,false);assert.equal(updates[0].steamAccountId,account);
 await page.getByRole('button',{name:'添加表情回应'}).click();
 await page.locator('.reaction-picker button[title=":smile:"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.reaction-chip').length===2);
 assert.equal(updates[1].reaction,':smile:');assert.equal(updates[1].ordinal,0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);console.log(`PASS ${width}px: counts, users, own state, remove/add, colon protocol, layout`);await page.close();
}}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
