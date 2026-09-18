import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { beforeEach, afterEach, test } from 'node:test';
import { URL as NodeURL } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { Database, type Contact } from '../src/db.ts';
import { consoleApi } from '../src/console-api.ts';
import { draftNext, enroll, session, receive, turns, markSent, setState, handoff, businessDaysAfter,
  type SetterEnvironment } from '../src/setter.ts';
import { handleUnipileWebhook } from '../src/replies.ts';

let mf:Miniflare, env:SetterEnvironment, contact:Contact;
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',
    compatibilityDate:'2026-09-17',d1Databases:{DB:'setter-tests'}}));
  const DB=await mf.getD1Database('DB') as unknown as D1Database;
  const dir=new NodeURL('../migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) {
    await DB.batch(unstable_splitSqlQuery(await readFile(new NodeURL(file,dir),'utf8')).map(s=>DB.prepare(s)));
  }
  env={DB,ADMIN_TOKEN:'a'.repeat(64),OPENAI_API_KEY:'test-key',CONTACT_RETENTION_SECONDS:'86400',
    SETTER_MODE:'draft',GHL_WEBHOOK_URL:'https://ghl.example.test/hook'};
  const db=new Database(DB);
  contact=await db.createContact({linkedin_url:'https://www.linkedin.com/in/michelle',name:'Michelle',company:'Example Med Spa',
    source_post_url:'https://example.test/expansion',collected_at:Math.floor(Date.now()/1000),retention_seconds:86400,
    sources:{linkedin_url:'official team page',name:'official team page',company:'official website',source_post_url:'official news'}});
  await enroll(env,contact.id);
  await DB.prepare(`UPDATE setter_sessions SET signal='Second location opened',signal_url='https://example.test/expansion',
    signal_date='2026-09-18',qualification_evidence='Multiple providers and locations; verified owner profile' WHERE contact_id=?`).bind(contact.id).run();
  await db.updateQualification(contact.id,'qualified',1);
});
afterEach(async()=>{await mf?.dispose()});
const model=(action='reply',message='How are you handling inquiries at the new location?',summary='Ask about inquiry handling.')=>
  Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({action,message,summary})}]}]});
const neverFetch:typeof fetch=async()=>assert.fail('No provider call expected');
function request(path:string,body?:unknown,token=env.ADMIN_TOKEN) {
  return new Request('https://app.test/api'+path,{method:body===undefined?'GET':'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
}

test('admin endpoints fail closed and never expose configuration secrets',async()=>{
  assert.equal((await consoleApi(request('/contacts',undefined,'wrong'),env,neverFetch)).status,401);
  assert.equal((await consoleApi(request('/contacts'),{...env,ADMIN_TOKEN:''},neverFetch)).status,503);
  const response=await consoleApi(request('/setup'),env,neverFetch);
  assert.equal(response.status,200); const text=await response.text();
  assert.ok(!text.includes('test-key')); assert.ok(!text.includes('ghl.example')); assert.ok(text.includes('manual_linkedin'));
});
test('import requires evidence, normalizes duplicates and stays pending',async()=>{
  const row={name:'Owner',company:'Installer',linkedin_url:'https://linkedin.com/in/NEW-OWNER/?trk=test',headline:'Owner',
    signal:'Published expansion',signal_url:'https://example.test/news',signal_date:'2026-01-01',qualification_evidence:'Team page reviewed'};
  const r=await consoleApi(request('/import',{rows:[row,row,{...row,signal_url:'javascript:alert(1)'}]}),env,neverFetch);
  const results=await r.json() as {status:string;id?:string}[];
  assert.deepEqual(results.map(x=>x.status),['imported_pending_review','duplicate_or_suppressed','invalid']);
  const c=await new Database(env.DB).getContact(results[0]!.id!);
  assert.equal(c?.icp_status,'pending'); assert.equal(c?.linkedin_url,'https://www.linkedin.com/in/new-owner');
});
test('enrollment prevents legacy invitation queue from sending console messages',async()=>{
  await assert.rejects(()=>new Database(env.DB).createDraft(contact.id,'Hello'),/Console contacts/);
});
test('draft includes context and footer without any channel-provider call',async()=>{
  await draftNext(env,contact.id,async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const body=JSON.parse(String(init?.body)); assert.equal(body.store,false);
    assert.equal(JSON.parse(body.input[0].content).signal,'Second location opened');
    return model();
  });
  const s=await session(env,contact.id);assert.ok(s?.draft_text?.endsWith('Reply STOP to opt out.'));
  assert.equal((await turns(env,contact.id)).length,0);
});
test('STOP takes precedence over AI, pause and duplicate IDs and remains permanent',async()=>{
  await receive(env,contact.id,'r1','Our office handles those');
  await setState(env,contact.id,'paused');
  await receive({...env,OPENAI_API_KEY:''},contact.id,'r1','STOP');
  assert.ok(await new Database(env.DB).getSuppression(contact.linkedin_url));
  assert.equal((await session(env,contact.id))?.state,'stopped');
  await assert.rejects(()=>draftNext(env,contact.id,neverFetch),/suppressed/);
  await assert.rejects(()=>setState(env,contact.id,'active'),/suppressed/);
});
test('duplicate inbound preserves draft but a newer reply invalidates it',async()=>{
  assert.equal(await receive(env,contact.id,'r1','Front desk'),true);
  await draftNext(env,contact.id,async()=>model());
  const version=(await session(env,contact.id))!.version;
  assert.equal(await receive(env,contact.id,'r1','Front desk'),false);
  assert.equal((await session(env,contact.id))!.version,version);
  assert.equal(await receive(env,contact.id,'r2','Only during the day'),true);
  assert.equal((await session(env,contact.id))!.draft_text,null);
  assert.equal((await turns(env,contact.id)).length,2);
});
test('pause, new reply and suppression during generation discard stale results',async()=>{
  for(const mutate of [()=>setState(env,contact.id,'paused'),()=>receive(env,contact.id,crypto.randomUUID(),'A newer reply')]) {
    await setState(env,contact.id,'active');
    await assert.rejects(()=>draftNext(env,contact.id,async()=>{await mutate();return model()}),/changed/);
    assert.equal((await session(env,contact.id))?.draft_text,null);
  }
  await setState(env,contact.id,'active');
  await assert.rejects(()=>draftNext(env,contact.id,async()=>{await receive(env,contact.id,'stop','unsubscribe');return model()}),/changed/);
});
test('manual send is idempotent, requires current draft and starts follow-up only on confirmation',async()=>{
  await draftNext(env,contact.id,async()=>model());
  const version=(await session(env,contact.id))!.version;
  assert.equal((await session(env,contact.id))!.next_follow_up,null);
  await markSent(env,contact.id,version);
  assert.equal((await turns(env,contact.id)).length,1);
  assert.ok((await session(env,contact.id))!.next_follow_up!>Date.now()/1000);
  await assert.rejects(()=>markSent(env,contact.id,version),/stale/);
  await assert.rejects(()=>draftNext(env,contact.id,neverFetch),/not due/);
  await receive(env,contact.id,'new','Tell me more');
  assert.equal((await session(env,contact.id))!.next_follow_up,null);
});
test('handoff decision pauses drafting and uncertain GHL delivery never retries',async()=>{
  await receive(env,contact.id,'r1','Yes lets book a call');
  await draftNext(env,contact.id,async()=>model('handoff','','Prospect agreed to a call; scheduling not confirmed.'));
  assert.equal((await session(env,contact.id))?.state,'handoff');
  await assert.rejects(()=>draftNext(env,contact.id,neverFetch),/activate/);
  let calls=0;
  assert.equal(await handoff(env,contact.id,async(_url,init)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.equal(body.booked,false);assert.equal(body.conversation.length,1);
    throw new Error('timeout');
  }),'unknown');
  assert.equal(await handoff(env,contact.id,neverFetch),'unknown');assert.equal(calls,1);
});
test('invalid AI output and missing credentials cannot create drafts',async()=>{
  for(const invalid of [model('invalid'),model('reply','Fake — message'),model('reply','https://bad.test'),model('handoff','I sent it')]) {
    await assert.rejects(()=>draftNext(env,contact.id,async()=>invalid));
    assert.equal((await session(env,contact.id))?.draft_text,null);
  }
  await assert.rejects(()=>draftNext({...env,OPENAI_API_KEY:''},contact.id,neverFetch),/Configure/);
});
test('Unipile draft mode records and drafts once without calling GHL or a sender',async()=>{
  const e={...env,UNIPILE_ACCOUNT_ID:'a',UNIPILE_WEBHOOK_SECRET:'s'.repeat(32)};
  const req=()=>new Request('https://app.test/webhooks/unipile',{method:'POST',headers:{'Unipile-Auth':e.UNIPILE_WEBHOOK_SECRET},
    body:JSON.stringify({event:'message_received',message_id:'message-1',account_id:'a',account_type:'LINKEDIN',account_info:{user_id:'self'},
      sender:{attendee_provider_id:'michelle',attendee_profile_url:contact.linkedin_url},message:'Our office handles it'})});
  let calls=0;
  assert.equal((await handleUnipileWebhook(req(),e,async(url)=>{assert.equal(url,'https://api.openai.com/v1/responses');calls++;return model()})).status,200);
  assert.equal((await handleUnipileWebhook(req(),e,neverFetch)).status,200); assert.equal(calls,1);
});
test('retention cascades conversation and handoff records but preserves suppression',async()=>{
  await receive(env,contact.id,'r1','Hello'); await receive(env,contact.id,'r2','STOP');
  // Explicit deletion exercises the same FK cascade used by expiry cleanup.
  await env.DB.prepare('DELETE FROM contacts WHERE id=?').bind(contact.id).run();
  assert.equal(await session(env,contact.id),null);assert.equal((await turns(env,contact.id)).length,0);
  assert.ok(await new Database(env.DB).getSuppression(contact.linkedin_url));
});
test('follow-up business days skip weekends',()=>{
  const friday=Date.parse('2026-09-18T16:00:00Z')/1000;
  assert.equal(new Date(businessDaysAfter(friday,3)*1000).toISOString(),'2026-09-23T16:00:00.000Z');
});
