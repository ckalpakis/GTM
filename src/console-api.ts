import { Database, normalizeLinkedInUrl } from './db';
import { activeContact, enroll, session, turns, receive, draftNext, setState, markSent, handoff, seconds,
  type SetterEnvironment } from './setter';

function text(x: unknown,max=2000): string { if(typeof x!=='string' || x.length>max) throw new Error('Missing or oversized text'); return x.trim(); }
function https(x:unknown):string { const u=new URL(text(x)); if(u.protocol!=='https:'||u.username||u.password) throw new Error('Expected an HTTPS source URL'); return u.toString(); }
function date(x:unknown):string {
  const d=text(x,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d || d>new Date().toISOString().slice(0,10)) throw new Error('Expected a valid checked date, not in the future');
  return d;
}
function evidence(body: Record<string,unknown>) {
  const signal=text(body.signal,1500), qualification=text(body.qualification_evidence,2000);
  if(!signal || !qualification) throw new Error('Signal and qualification evidence are required');
  return {signal, signal_url:https(body.signal_url), signal_date:date(body.signal_date), qualification};
}
async function saveEvidence(env:SetterEnvironment,id:string,b:Record<string,unknown>) {
  const e=evidence(b);
  await enroll(env,id);
  await env.DB.prepare(`UPDATE setter_sessions SET signal=?,signal_url=?,signal_date=?,qualification_evidence=?,
    version=version+1,draft_text=NULL,draft_action=NULL WHERE contact_id=?`)
    .bind(e.signal,e.signal_url,e.signal_date,e.qualification,id).run();
}
async function importRows(env:SetterEnvironment,rows:unknown) {
  if(!Array.isArray(rows)||rows.length<1||rows.length>50) throw new Error('Import 1 to 50 rows per request');
  const retention=Number(env.CONTACT_RETENTION_SECONDS);
  if(!Number.isSafeInteger(retention)||retention<=0) throw new Error('Configure CONTACT_RETENTION_SECONDS');
  const result:{row:number;status:string;id?:string;error?:string}[]=[];
  const db=new Database(env.DB);
  for(let i=0;i<rows.length;i++) {
    try {
      const r=rows[i] as Record<string,unknown>;
      if(!r || typeof r!=='object') throw new Error('Invalid row');
      const linkedin_url=normalizeLinkedInUrl(text(r.linkedin_url));
      const name=text(r.name,200), company=text(r.company,300), headline=text(r.headline ?? '',500);
      if(!name||!company) throw new Error('Name and company are required');
      evidence(r);
      const source=https(r.signal_url);
      const c=await db.importContact({linkedin_url,name,company,headline,source_post_url:source,
        source:'operator_verified_signal',collected_at:seconds(),retention_seconds:retention,
        sources:{linkedin_url:source,name:source,company:source,headline:source,source_post_url:source}});
      if(!c) { result.push({row:i+1,status:'duplicate_or_suppressed'}); continue; }
      await saveEvidence(env,c.id,r);
      // Imported rows are deliberately pending until the operator reviews the evidence.
      result.push({row:i+1,status:'imported_pending_review',id:c.id});
    } catch(error) { result.push({row:i+1,status:'invalid',error:error instanceof Error?error.message:'Import failed'}); }
  }
  return result;
}

export async function consoleApi(request:Request,env:SetterEnvironment,fetcher:typeof fetch=fetch):Promise<Response> {
  if(!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length<32) return Response.json({error:'Set ADMIN_TOKEN to at least 32 random characters'},{status:503});
  // No cookie auth: browser mutations require a non-simple Authorization header. No CORS is enabled.
  const expected=new TextEncoder().encode(`Bearer ${env.ADMIN_TOKEN}`);
  const supplied=new TextEncoder().encode(request.headers.get('Authorization') || '');
  const hash=async (v:Uint8Array)=>new Uint8Array(await crypto.subtle.digest('SHA-256',v));
  const a=await hash(expected),b=await hash(supplied);
  let difference=0; for(let i=0;i<a.length;i++) difference |= a[i]! ^ b[i]!;
  if(difference) return Response.json({error:'Unauthorized'},{status:401});
  try {
    const path=new URL(request.url).pathname;
    if(request.method==='GET' && path==='/api/setup') {
      await env.DB.prepare('SELECT contact_id FROM setter_sessions LIMIT 1').first();
      return Response.json({mode:'manual_linkedin',ai:!!env.OPENAI_API_KEY,ghl:!!env.GHL_WEBHOOK_URL,
        retention_seconds:Number(env.CONTACT_RETENTION_SECONDS)||null,target_per_day:25,timezone:'America/New_York',
        sms:'not_connected',scheduled_sender:env.SETTER_MODE==='draft'?'disabled':'legacy_config'});
    }
    if(request.method==='GET' && path==='/api/contacts') {
      const r=await env.DB.prepare(`SELECT c.id,c.name,c.company,c.linkedin_url,c.icp_status,c.suppressed,c.retention_expires_at,
        s.state,s.signal,s.next_follow_up,s.draft_text,h.status AS handoff_status
        FROM contacts c LEFT JOIN setter_sessions s ON s.contact_id=c.id
        LEFT JOIN setter_handoffs h ON h.contact_id=c.id
        WHERE c.retention_expires_at>unixepoch() ORDER BY c.collected_at DESC,c.id LIMIT 500`).all();
      return Response.json(r.results);
    }
    const match=/^\/api\/contacts\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const id=match?.[1],action=match?.[2];
    if(request.method==='GET' && id && !action) {
      const c=await new Database(env.DB).getContact(id);
      if(!c || c.retention_expires_at<=seconds()) return Response.json({error:'Contact not found'},{status:404});
      return Response.json({contact:c,session:await session(env,id),turns:await turns(env,id),
        handoff:await env.DB.prepare('SELECT * FROM setter_handoffs WHERE contact_id=?').bind(id).first()});
    }
    if(request.method!=='POST') return Response.json({error:'Not found'},{status:404});
    if(!request.headers.get('Content-Type')?.startsWith('application/json')) return Response.json({error:'JSON required'},{status:415});
    const raw=await request.text(); if(raw.length>256000) return Response.json({error:'Request too large'},{status:413});
    const body=JSON.parse(raw) as Record<string,unknown>;
    if(!body || typeof body!=='object'||Array.isArray(body)) throw new Error('JSON object required');
    if(path==='/api/import') return Response.json(await importRows(env,body.rows));
    if(!id) return Response.json({error:'Not found'},{status:404});
    if(action==='inbound') {
      const message=text(body.message,8000), eventId=text(body.event_id,200);
      if(!message||!eventId) throw new Error('Message and unique event_id required');
      return Response.json({inserted:await receive(env,id,eventId,message)});
    }
    if(action==='suppress') {
      const c=await new Database(env.DB).getContact(id); if(!c) throw new Error('Contact not found');
      await new Database(env.DB).suppress(c.linkedin_url,'Operator do-not-contact'); return Response.json({ok:true});
    }
    await activeContact(env,id);
    if(action==='evidence') await saveEvidence(env,id,body);
    else if(action==='qualify') {
      const s=await session(env,id); if(!s?.qualification_evidence) throw new Error('Review and save evidence first');
      // Fit approval is not buying intent. Default 1 means no explicit purchase intent established.
      await new Database(env.DB).updateQualification(id,'qualified',1);
    }
    else if(action==='state') {
      if(!['active','paused','handoff'].includes(String(body.state))) throw new Error('Invalid state');
      await setState(env,id,body.state as 'active'|'paused'|'handoff');
    }
    else if(action==='draft') return Response.json(await draftNext(env,id,fetcher));
    else if(action==='sent') {
      if(!Number.isInteger(body.version)) throw new Error('Draft version required');
      await markSent(env,id,body.version as number);
    }
    else if(action==='edit') {
      const value=text(body.message,900); if(!value || !value.endsWith('Reply STOP to opt out.')) throw new Error('Keep the opt-out footer');
      const r=await env.DB.prepare(`UPDATE setter_sessions SET draft_text=?,version=version+1 WHERE contact_id=?
        AND version=? AND state='active' AND draft_action='reply' RETURNING contact_id`).bind(value,id,body.version).first();
      if(!r) throw new Error('Draft changed. Refresh first.');
    }
    else if(action==='handoff') return Response.json({status:await handoff(env,id,fetcher)});
    else return Response.json({error:'Not found'},{status:404});
    return Response.json({ok:true});
  } catch(error) {
    // Never return provider bodies, SQL errors, or configuration values.
    const message=error instanceof Error?error.message:'Request failed';
    const safe=/^(Contact|Draft|Configure|Set |Review|Keep |Signal|Expected|Missing|Name|Import|Invalid|JSON|Message|Qualify|Verified|Follow-up|Two |AI |Incomplete|Conversation)/.test(message);
    return Response.json({error:safe?message:'Could not complete the request. Check configuration and try again.'},{status:400});
  }
}
