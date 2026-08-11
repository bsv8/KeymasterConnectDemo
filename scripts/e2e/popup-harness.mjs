import { createServer } from "node:http";

const port = Number(process.env.DEMO_POPUP_HARNESS_PORT || 4174);
const html = `<!doctype html><meta charset="utf-8"><title>Controlled popup harness</title>
<script>
const objects = new Map(), uploads = new Map(), subscriptions = new Set();
window.__demoHarnessRequests = [];
const bytesOf = (b) => b && b.$type === "binary" && b.bytes instanceof ArrayBuffer ? new Uint8Array(b.bytes) : new Uint8Array();
const binary = (bytes, mime) => ({ $type: "binary", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mime });
const send = (e, r, value) => e.source.postMessage({v:1,type:"result",id:r.id,ok:true,result:value}, e.origin);
const digest = async (publicKey) => {
  const payload = JSON.stringify({app:{id:"keymaster-connect-demo",name:"Keymaster Connect Demo"},publisherPublicKey:publicKey,version:1});
  const bytes = new TextEncoder().encode("keymaster-app-identity:v1\\0" + payload);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
};
const storageEntry = (path, value) => ({ path, name:path.split("/").pop() || path, size:value.bytes.byteLength, etag:"etag-"+path, lastModified:new Date().toISOString() });
window.opener?.postMessage({v:1,type:"ready"}, "*");
window.addEventListener("message", async (event) => {
  const r = event.data; if (!r || r.v !== 1 || r.type !== "request") return;
  window.__demoHarnessRequests.push(r);
  window.__demoHarnessLastRequest = r;
  const audit = JSON.parse(localStorage.getItem("demo-e2e-audit") || "[]");
  audit.push({ method: r.method, appIdentity: r.method === "connect.login" ? r.params?.appIdentity : undefined });
  localStorage.setItem("demo-e2e-audit", JSON.stringify(audit));
  const p = r.params || {}, now = Date.now(); let value = {};
  if (r.method === "connect.login") value = {connectSessionId:"demo-e2e-session",ownerPublicKeyHex:"02"+"11".repeat(32),resolvedClaims:{},resolvedAt:now,appIdentity:p.appIdentity ? {version:1,publisherPublicKeyHex:p.appIdentity.publisherPublicKey,appId:p.appIdentity.app.id,appName:p.appIdentity.app.name,identityDigestHex:await digest(p.appIdentity.publisherPublicKey)} : undefined};
  else if (r.method === "connect.resume") value = {connectSessionId:p.connectSessionId,ownerPublicKeyHex:"02"+"11".repeat(32),resolvedClaims:{},resolvedAt:now};
  else if (r.method === "connect.logout") value = {connectSessionId:p.connectSessionId,revokedAt:now};
  else if (r.method === "broadcast.subscription_set") { subscriptions.clear(); (p.channelIds||[]).forEach((x)=>subscriptions.add(x)); value={channelIds:[...subscriptions]}; }
  else if (r.method === "broadcast.subscription_list") value={channelIds:[...subscriptions]};
  else if (r.method === "broadcast.publish") { value={channelId:p.channelId,protocolId:p.protocolId,clientMessageId:p.clientMessageId,createdAtMs:p.createdAtMs,bodyBase64:p.bodyBase64,publisherPublicKeyHex:"02"+"33".repeat(32)}; queueMicrotask(()=>event.source.postMessage({v:1,type:"event",event:"broadcast.message_received",data:{message:value}},event.origin)); }
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
