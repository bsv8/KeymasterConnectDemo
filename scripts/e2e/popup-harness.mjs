import { createServer } from "node:http";

const port = Number(process.env.DEMO_POPUP_HARNESS_PORT || 4174);
const html = `<!doctype html><meta charset="utf-8"><title>Controlled popup harness</title>
<script>
const objects = new Map(), uploads = new Map(), subscriptions = new Set();
window.__demoHarnessRequests = [];
const bytesOf = (b) => b && b.$type === "binary" && b.bytes instanceof ArrayBuffer ? new Uint8Array(b.bytes) : new Uint8Array();
const binary = (bytes, mime) => ({ $type: "binary", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mime });
const send = (e, r, value) => e.source.postMessage({v:1,type:"result",id:r.id,ok:true,result:value}, e.origin);
const storageEntry = (path, value) => ({ path, name:path.split("/").pop() || path, size:value.bytes.byteLength, etag:"etag-"+path, lastModified:new Date().toISOString() });
window.opener?.postMessage({v:1,type:"ready"}, "*");
const redact = (value) => Array.isArray(value) ? value.map(redact) : (value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, k === "signature" ? "[redacted]" : redact(v)])) : value);
window.addEventListener("message", async (event) => {
  const r = event.data; if (!r || r.v !== 1 || r.type !== "request") return;
  window.__demoHarnessRequests.push(r);
  window.__demoHarnessLastRequest = r;
  const audit = JSON.parse(localStorage.getItem("demo-e2e-audit") || "[]");
  audit.push({ method: r.method, params: redact(r.params) });
  localStorage.setItem("demo-e2e-audit", JSON.stringify(audit));
  const p = r.params || {}, now = Date.now(); let value = {};
  if (r.method === "connect.login") value = {connectSessionId:"demo-e2e-session",ownerPublicKeyHex:"02"+"11".repeat(32),resolvedClaims:{},resolvedAt:now,appIdentity:{version:1,publisherPublicKeyHex:p.appIdentity?.publisherPublicKey||"032558368095eb0a4cb07d0dd59a8a5bffdfd19c495a79de280db63b746e228b30",appId:p.appIdentity?.app?.id||"keymaster-connect-demo",appName:p.appIdentity?.app?.name||"Keymaster Connect Demo",identityDigestHex:"fixture"}};
  else if (r.method === "connect.resume") value = {connectSessionId:p.connectSessionId,ownerPublicKeyHex:"02"+"11".repeat(32),resolvedClaims:{},resolvedAt:now,appIdentity:{version:1,publisherPublicKeyHex:"032558368095eb0a4cb07d0dd59a8a5bffdfd19c495a79de280db63b746e228b30",appId:"keymaster-connect-demo",appName:"Keymaster Connect Demo",identityDigestHex:"fixture"}};
  else if (r.method === "connect.logout") value = {connectSessionId:p.connectSessionId,revokedAt:now};
  else if (r.method === "channel.subscription_set") { subscriptions.clear(); (p.channels||[]).forEach((x)=>subscriptions.add(x)); value={channels:[...subscriptions],statuses:[...subscriptions].map((channel)=>({channel,phase:"subscribed",errorCode:null,errorMessage:null,updatedAtMs:now}))}; }
  else if (r.method === "channel.publish") { value={messageId:"demo-channel-message"}; queueMicrotask(()=>event.source.postMessage({v:1,type:"event",event:"channel.message_received",data:{channel:p.channel,publisherPublicKeyHex:"02"+"33".repeat(32),messageId:value.messageId,content:p.content}},event.origin)); }
  else if (r.method === "msfile.stat") value={seedHashHex:p.seedHashHex,suppliers:[{supplierPublicKeyHex:"02"+"44".repeat(32),status:"available",recommendedFilename:"demo-e2e.bin",fileSizeBytes:"1024",mediaType:"application/octet-stream"}]};
  else if (r.method === "msfile.seed.read") value={contentHashHex:p.seedHashHex,content:binary(new TextEncoder().encode("seed browser body"),"application/octet-stream")};
  else if (r.method === "msfile.block.read") value={contentHashHex:p.blockHashHex,content:binary(new TextEncoder().encode("block browser body"),"application/octet-stream")};
  else if (r.method === "storage.directory.create") value={path:p.path,created:true};
  else if (r.method === "storage.directory.delete") value={path:p.path,deleted:true};
  else if (r.method === "storage.list") { const prefix=p.prefix||""; value={prefix,parentPrefix:"",directories:[],files:[...objects].filter(([path])=>path.startsWith(prefix)).map(([path,v])=>storageEntry(path,v))}; }
  else if (r.method === "storage.put") { const b=bytesOf(p.content); objects.set(p.path,{bytes:new Uint8Array(b),mime:p.contentType||"application/octet-stream"}); value={path:p.path,size:b.byteLength,etag:"etag-"+p.path,updatedAt:now}; }
  else if (r.method === "storage.get") { const v=objects.get(p.path)||{bytes:new TextEncoder().encode("fallback"),mime:"text/plain"}; const offset=p.offset||0,end=p.length===undefined?v.bytes.byteLength:Math.min(v.bytes.byteLength,offset+p.length); value={path:p.path,content:binary(v.bytes.slice(offset,end),v.mime),contentType:v.mime,offset,totalSize:v.bytes.byteLength,eof:end>=v.bytes.byteLength,etag:"etag-"+p.path,lastModified:new Date().toISOString()}; }
  else if (r.method === "storage.delete") { objects.delete(p.path); value={path:p.path,deleted:true,updatedAt:now}; }
  else if (r.method === "storage.upload.begin") { const id="demo-upload-"+now; uploads.set(id,{path:p.path,mime:p.contentType||"application/octet-stream",parts:new Map()}); value={uploadId:id,partSize:16*1024*1024,maxParts:10000}; }
  else if (r.method === "storage.upload.part") { const u=uploads.get(p.uploadId), b=bytesOf(p.content); u?.parts.set(p.partNumber,b); value={uploadId:p.uploadId,partNumber:p.partNumber,size:b.byteLength}; }
  else if (r.method === "storage.upload.complete") { const u=uploads.get(p.uploadId), b=u ? new Uint8Array([...u.parts.keys()].sort((a,b)=>a-b).flatMap((n)=>[...u.parts.get(n)])) : new Uint8Array(); if(u) objects.set(u.path,{bytes:b,mime:u.mime}); uploads.delete(p.uploadId); value={path:u?.path||"upload.bin",size:b.byteLength,etag:"etag-"+(u?.path||"upload.bin"),updatedAt:now}; }
  else if (r.method === "storage.upload.abort") { uploads.delete(p.uploadId); value={uploadId:p.uploadId,aborted:true}; }
  send(event,r,value);
});
</script>`;

createServer((req, res) => {
  if (req.url !== "/protocol/v1/popup") return res.writeHead(404).end();
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}).listen(port, "127.0.0.1", () =>
  console.log(`popup harness listening on ${port}`),
);
