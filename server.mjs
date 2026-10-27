import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const records=path.resolve(root,'documents');
const port=Number(process.env.PORT || 3000);
// Optional exact HTTPS hostname for a private Tailscale Serve proxy.
// This does not add application authentication; tailnet access rules must restrict access.
const tailnetHost = (process.env.TAILSCALE_HOST || '').trim().toLowerCase();
if (tailnetHost && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(tailnetHost)) {
  throw new Error('TAILSCALE_HOST must be an exact Tailscale hostname ending in .ts.net');
}
http.createServer(async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  // Reject requests using attacker-controlled hostnames (DNS rebinding).
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (tailnetHost) { allowedHosts.add(tailnetHost); allowedHosts.add(`${tailnetHost}:443`); }
  if (port === 80) { allowedHosts.add('localhost'); allowedHosts.add('127.0.0.1'); }
  if (!allowedHosts.has((req.headers.host || '').toLowerCase())) {
    res.writeHead(403, {'Content-Type':'text/plain'}).end('Forbidden'); return;
  }
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  const url=new URL(req.url,'http://localhost');
  try {
    if(req.method!=='GET') {res.writeHead(405).end(); return;}
    if(url.pathname==='/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(await readFile(path.join(root,'phone.html')));return;}
    if(url.pathname==='/api/status') {
      let status={state:'offline'};
      try { const saved=JSON.parse(await readFile(path.join(root,'.connector-status.json'),'utf8')); if(Date.now()-saved.updatedAt<25000 && ['connected','connecting','disconnected'].includes(saved.state)) status={state:saved.state}; } catch {}
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(status)); return;
    }
    if(url.pathname==='/api/search') {
      const q=(url.searchParams.get('q')||'').trim().normalize('NFC').toLowerCase();
      if(!q || q.length>200){res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'Enter a search term of up to 200 characters.'}));return;}
      const files=await readdir(records).catch(e=>{if(e.code==='ENOENT')return [];throw e});
      const results=[];
      for(const file of files.filter(f=>f.endsWith('.json'))) {
        try { const r=JSON.parse(await readFile(path.join(records,file),'utf8')); if(typeof r.text!=='string') continue;
          const displayText=r.text.normalize('NFC');
          const i=displayText.toLowerCase().indexOf(q); if(i<0) continue; const pdf=typeof r.pdfFile==='string' && /^[0-9a-f-]+\.pdf$/i.test(r.pdfFile)?r.pdfFile:null;
          results.push({type:r.type==='message'?'Message':r.type==='text-file'?'Text file':'PDF',filename:r.filename||'Unnamed PDF',chatId:r.chatId||'Unknown',timestamp:Number(r.timestamp)||null,excerpt:displayText.slice(Math.max(0,i-60),i+q.length+100).replace(/\s+/g,' '),pdf});
        } catch { /* Skip incomplete or invalid index files. */ }
      }
      results.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({results})); return;
    }
    if(url.pathname.startsWith('/pdf/')) {const name=url.pathname.slice(5); if(!/^[0-9a-f-]+\.pdf$/i.test(name)){res.writeHead(404).end();return;} const data=await readFile(path.join(records,name)); res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':'inline','X-Content-Type-Options':'nosniff'}).end(data);return;}
    res.writeHead(404).end('Not found');
  } catch {res.writeHead(500,{'Content-Type':'text/plain'}).end('Unable to complete request');}
}).listen(port,'127.0.0.1',()=>console.log(`Search ready at http://localhost:${port}`));
