/** 导出作品的独立运行时。
 *
 * 试玩区通过父页桥接提供 `Workbench.storage` / `Workbench.ai`；
 * 单 HTML 导出后父页不存在，因此这里注入等价的本地实现：
 * - `Workbench.storage`：localStorage + 内存兜底，按稳定作品身份隔离命名空间。
 * - `Workbench.ai`：作品自带的 AI 设置面板 + 直连 OpenAI 兼容端点，**不含**工作台密钥。
 *
 * 这里只生成字符串，不接触 IndexedDB，便于单测。
 */

/** Stable across download names; identity is supplied by the caller, never credentials. */
export function standaloneNamespace(identity: string): string {
  return `workbench:identity:${encodeURIComponent(identity)}:`
}

export interface RuntimeNeeds {
  storage: boolean
  ai: boolean
  preview: boolean
  vfs: boolean
}

export function detectRuntimeNeeds(html: string): RuntimeNeeds {
  const text = String(html || '')
  return {
    storage: /Workbench\.storage/.test(text),
    ai: /Workbench\.ai/.test(text),
    preview: /Workbench\.preview/.test(text),
    vfs: /__WORKBENCH_PREVIEW__|\/__vfs__\//.test(text),
  }
}

/** 注入必须早于页面自身脚本执行。 */
export function injectBeforeFirstScript(html: string, snippet: string): string {
  const firstScript = html.search(/<script\b/i)
  if (firstScript >= 0) return html.slice(0, firstScript) + snippet + html.slice(firstScript)
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${snippet}</head>`)
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => `${m}${snippet}`)
  return snippet + html
}

export function standaloneStorageShim(prefix: string, appName = '作品'): string {
  const source = `(function(){
'use strict';
var PREFIX=${JSON.stringify(prefix)};
var APP_NAME=${JSON.stringify(appName)};
var MAX_ENTRIES=200,MAX_ENTRY=256*1024,MAX_TOTAL=2*1024*1024,MAX_KEY=200;
var mem={};
function read(k){try{var v=localStorage.getItem(PREFIX+k);return v==null?undefined:JSON.parse(v)}catch(e){return mem[k]}}
function write(k,v){mem[k]=v;try{localStorage.setItem(PREFIX+k,JSON.stringify(v))}catch(e){}}
function drop(k){delete mem[k];try{localStorage.removeItem(PREFIX+k)}catch(e){}}
function reserved(k){return k==='ai:config'||k.indexOf('ai:')===0}
function allKeys(){
  var out=[];
  try{
    for(var i=0;i<localStorage.length;i++){
      var full=localStorage.key(i);
      if(full&&full.indexOf(PREFIX)===0) out.push(full.slice(PREFIX.length));
    }
  }catch(e){}
  for(var k in mem){ if(out.indexOf(k)<0) out.push(k) }
  return out;
}
function readAll(){
  var out={};
  allKeys().forEach(function(k){ if(reserved(k)) return; var v=read(k); if(v!==undefined) out[k]=v });
  return out;
}
function byteLength(text){return new TextEncoder().encode(text).length}
function exportSaves(){
  return {format:'rpagent-saves',version:1,exportedAt:new Date().toISOString(),source:'standalone',app:APP_NAME,entries:readAll()};
}
function importSaves(data,opts){
  var replace=!!(opts&&opts.replace);
  if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('存档包必须是 JSON 对象');
  if(data.format!=='rpagent-saves') throw new Error('不是存档包：format 应为 rpagent-saves');
  if(data.version!==1) throw new Error('不支持的存档包版本：'+String(data.version));
  var src=data.entries;
  if(!src||typeof src!=='object'||Array.isArray(src)) throw new Error('存档包缺少 entries 对象');
  var keys=Object.keys(src);
  if(keys.length>MAX_ENTRIES) throw new Error('存档条目过多（'+keys.length+' > '+MAX_ENTRIES+'）');
  var skipped=[],ok={},total=0;
  keys.forEach(function(k){
    if(!k||k.length>MAX_KEY||reserved(k)){ skipped.push(k); return }
    var s;
    try{ s=JSON.stringify(src[k]) }catch(e){ skipped.push(k); return }
    if(s===undefined){ skipped.push(k); return }
    var size=byteLength(s);
    if(size>MAX_ENTRY){ skipped.push(k); return }
    total+=size;
    if(total>MAX_TOTAL) throw new Error('存档包过大（超过 '+Math.round(MAX_TOTAL/1024)+'KB）');
    ok[k]=src[k];
  });
  if(replace){
    allKeys().forEach(function(k){ if(!reserved(k)&&!(k in ok)) drop(k) });
  }
  Object.keys(ok).forEach(function(k){ write(k,ok[k]) });
  return {imported:Object.keys(ok).length,skipped:skipped};
}
window.Workbench=window.Workbench||{};
window.Workbench.storage={
  get:function(k){return Promise.resolve(read(String(k)))},
  set:function(k,v){write(String(k),v);return Promise.resolve()},
  remove:function(k){drop(String(k));return Promise.resolve()},
  keys:function(){return Promise.resolve(allKeys().filter(function(k){return !reserved(k)}))},
  export:function(){return new Promise(function(resolve){resolve(exportSaves())})},
  import:function(data){return new Promise(function(resolve){resolve(importSaves(data,{replace:false}))})}
};

/* ── 存档迁移面板（shadow DOM，避免与作品样式冲突） ── */
var host=null,root=null,statusEl=null,fileInput=null;
function setStatus(text,kind){
  if(!statusEl) return;
  statusEl.textContent=text;
  statusEl.className='status'+(kind?' '+kind:'');
}
function ensureUi(){
  if(root) return root;
  if(!document.body) return null;
  host=document.createElement('div');
  host.setAttribute('data-workbench-saves-ui','');
  host.style.cssText='position:fixed;right:16px;bottom:64px;z-index:2147482999;';
  document.body.appendChild(host);
  root=host.attachShadow?host.attachShadow({mode:'open'}):host;
  root.innerHTML='<style>'
    +'.fab{font:500 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fffdf8;color:#20211c;border:1px solid #cfc8b7;border-radius:999px;padding:9px 14px;cursor:pointer;box-shadow:0 6px 18px rgba(30,34,26,.16)}'
    +'.fab:hover{background:#f3efe4}'
    +'.panel{position:absolute;right:0;bottom:46px;width:300px;max-width:calc(100vw - 32px);background:#fffdf8;color:#20211c;border:1px solid #d9d3c4;border-radius:12px;box-shadow:0 18px 40px rgba(30,34,26,.18);padding:14px;font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}'
    +'.panel h3{margin:0 0 2px;font-size:14px}'
    +'.panel p.hint{margin:0 0 10px;font-size:11.5px;color:#6b6a60}'
    +'.row{display:flex;gap:6px;margin-top:8px}'
    +'.panel button{font:500 12px/1.4 system-ui,sans-serif;border-radius:7px;border:1px solid #cfc8b7;background:#fff;color:#20211c;padding:7px 10px;cursor:pointer;flex:1}'
    +'.panel button.primary{background:#1f3b33;border-color:#1f3b33;color:#fff}'
    +'.panel button.primary:hover{background:#274a3f}'
    +'.status{margin-top:8px;font-size:11.5px;min-height:16px;color:#6b6a60;word-break:break-all}'
    +'.status.err{color:#a3382c}'
    +'.status.ok{color:#2f6a58}'
    +'.x{position:absolute;right:10px;top:8px;border:0;background:none;font-size:15px;color:#6b6a60;cursor:pointer;padding:2px 4px;flex:none}'
    +'</style>'
    +'<button class="fab" type="button">存档</button>'
    +'<div class="panel" hidden>'
    +'<button class="x" type="button" title="关闭">×</button>'
    +'<h3>'+APP_NAME+' · 存档</h3>'
    +'<p class="hint">导出的 JSON 可以在另一份导出文件或工作台试玩里导入。存档包不包含 AI 配置与密钥。</p>'
    +'<div class="status"></div>'
    +'<div class="row"><button type="button" data-act="export">导出存档</button><button type="button" data-act="import">导入存档</button></div>'
    +'<div class="row"><button type="button" data-act="clear">清空存档</button><button type="button" class="primary" data-act="done">完成</button></div>'
    +'<input type="file" accept=".json,application/json" hidden>'
    +'</div>';
  statusEl=root.querySelector('.status');
  fileInput=root.querySelector('input[type=file]');
  var panel=root.querySelector('.panel');
  root.querySelector('.fab').addEventListener('click',function(){ panel.hidden=!panel.hidden });
  root.querySelector('.x').addEventListener('click',function(){ panel.hidden=true });
  root.querySelector('[data-act="done"]').addEventListener('click',function(){ panel.hidden=true });
  root.querySelector('[data-act="export"]').addEventListener('click',function(){
    try{
      var bundle=exportSaves();
      var count=Object.keys(bundle.entries).length;
      var blob=new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'});
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url;
      a.download=(APP_NAME||'workbench')+'-saves.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ URL.revokeObjectURL(url) },5000);
      setStatus('已导出 '+count+' 条存档','ok');
    }catch(e){ setStatus('导出失败：'+String(e&&e.message?e.message:e),'err') }
  });
  root.querySelector('[data-act="import"]').addEventListener('click',function(){ fileInput.click() });
  fileInput.addEventListener('change',function(){
    var file=fileInput.files&&fileInput.files[0];
    fileInput.value='';
    if(!file) return;
    file.text().then(function(text){
      var data;
      try{ data=JSON.parse(text) }catch(e){ setStatus('不是合法 JSON','err'); return }
      try{
        var result=importSaves(data,{replace:false});
        var extra=result.skipped.length?'，跳过 '+result.skipped.length+' 条':'';
        setStatus('已导入 '+result.imported+' 条'+extra,'ok');
      }catch(e){ setStatus('导入失败：'+String(e&&e.message?e.message:e),'err') }
    }).catch(function(e){ setStatus('读取失败：'+String(e&&e.message?e.message:e),'err') });
  });
  root.querySelector('[data-act="clear"]').addEventListener('click',function(){
    try{
      var n=0;
      allKeys().forEach(function(k){ if(!reserved(k)){ drop(k); n++ } });
      setStatus('已清空 '+n+' 条存档','ok');
    }catch(e){ setStatus('清空失败：'+String(e&&e.message?e.message:e),'err') }
  });
  return root;
}
function bootUi(){
  try{ ensureUi() }catch(e){}
}
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',bootUi,{once:true});
}else{
  bootUi();
}
})();`
  return `<script>${source}</script>`
}

const AI_MAX_MESSAGES = 40
const AI_MAX_TOTAL_CHARS = 60_000

export interface StandaloneAiOptions {
  /** localStorage 命名空间前缀，通常为 `workbench:<文件名>:` */
  prefix: string
  /** 展示在设置面板里的作品名 */
  appName: string
}

/** 生成 `Workbench.ai` 本地实现（含可视化设置面板）。 */
export function standaloneAiShim(options: StandaloneAiOptions): string {
  const cfgKey = `${options.prefix}ai:config`
  const source = `(function(){
'use strict';
var CFG_KEY=${JSON.stringify(cfgKey)};
var APP_NAME=${JSON.stringify(options.appName)};
var MAX_MESSAGES=${AI_MAX_MESSAGES};
var MAX_TOTAL_CHARS=${AI_MAX_TOTAL_CHARS};
var ALLOWED={system:1,user:1,assistant:1};

function normalizeBase(raw){
  var s=String(raw||'').trim();
  if(!s) return '';
  if(!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(s)) s='https://'+s.replace(/^\\/+/, '');
  s=s.replace(/\\/+$/,'').replace(/\\/(chat\\/completions|completions|models|embeddings)$/i,'');
  while(/\\/v1\\/v1$/i.test(s)) s=s.replace(/\\/v1\\/v1$/i,'/v1');
  s=s.replace(/\\/+$/,'');
  var pathOnly=s.replace(/^[a-z][a-z0-9+.-]*:\\/\\/[^/?#]+/i,'');
  if(!/\\/(v\\d+)([a-z0-9.-]*)?(\\/|$)/i.test(pathOnly)) s=s+'/v1';
  return s;
}
function readConfig(){
  try{
    var raw=localStorage.getItem(CFG_KEY);
    if(!raw) return null;
    var cfg=JSON.parse(raw);
    if(!cfg||typeof cfg!=='object') return null;
    if(!normalizeBase(cfg.baseUrl)||typeof cfg.model!=='string'||!cfg.model.trim()) return null;
    return cfg;
  }catch(e){return null}
}
function writeConfig(cfg){
  try{localStorage.setItem(CFG_KEY,JSON.stringify(cfg));return true}catch(e){return false}
}
function redact(text){
  return String(text||'')
    .replace(/\\bsk-[A-Za-z0-9._:-]{8,}\\b/g,'sk-***')
    .replace(/Bearer\\s+[A-Za-z0-9._:-]{8,}/g,'Bearer ***');
}
function validateMessages(input){
  if(!Array.isArray(input)) throw new Error('messages 必须是数组');
  if(!input.length) throw new Error('messages 不能为空');
  if(input.length>MAX_MESSAGES) throw new Error('messages 最多 '+MAX_MESSAGES+' 条');
  var out=[],total=0;
  for(var i=0;i<input.length;i++){
    var item=input[i];
    if(!item||typeof item!=='object') throw new Error('消息格式不正确');
    if(!ALLOWED[item.role]) throw new Error('消息角色必须是 system / user / assistant');
    if(typeof item.content!=='string') throw new Error('消息内容必须是字符串');
    total+=item.content.length;
    if(total>MAX_TOTAL_CHARS) throw new Error('消息总长度超过 '+MAX_TOTAL_CHARS+' 字符');
    out.push({role:item.role,content:item.content});
  }
  return out;
}

/* ── 设置面板（shadow DOM，避免与作品样式互相污染） ── */
var host=null,root=null,statusEl=null,fields=null;
function ensureUi(){
  if(root) return root;
  if(!document.body) return null;
  host=document.createElement('div');
  host.setAttribute('data-workbench-ai-ui','');
  host.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483000;';
  document.body.appendChild(host);
  root=host.attachShadow?host.attachShadow({mode:'open'}):host;
  root.innerHTML='<style>'
    +'.fab{font:500 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;background:#1f3b33;color:#fff;border:0;border-radius:999px;padding:9px 14px;cursor:pointer;box-shadow:0 6px 20px rgba(16,40,32,.28)}'
    +'.fab:hover{background:#274a3f}'
    +'.panel{position:absolute;right:0;bottom:46px;width:320px;max-width:calc(100vw - 32px);background:#fffdf8;color:#20211c;border:1px solid #d9d3c4;border-radius:12px;box-shadow:0 18px 40px rgba(30,34,26,.18);padding:14px;font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}'
    +'.panel h3{margin:0 0 2px;font-size:14px}'
    +'.panel p.hint{margin:0 0 10px;font-size:11.5px;color:#6b6a60}'
    +'.panel label{display:block;margin:8px 0 2px;font-size:11.5px;color:#4a4a42}'
    +'.panel input{width:100%;box-sizing:border-box;font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;padding:6px 8px;border:1px solid #cfc8b7;border-radius:7px;background:#fff;color:#20211c}'
    +'.panel input:focus{outline:2px solid #2f6a58;outline-offset:1px}'
    +'.row{display:flex;gap:6px;margin-top:12px}'
    +'.panel button{font:500 12px/1.4 system-ui,sans-serif;border-radius:7px;border:1px solid #cfc8b7;background:#fff;color:#20211c;padding:7px 10px;cursor:pointer}'
    +'.panel button.primary{background:#1f3b33;border-color:#1f3b33;color:#fff;flex:1}'
    +'.panel button.primary:hover{background:#274a3f}'
    +'.status{margin-top:8px;font-size:11.5px;min-height:16px;color:#6b6a60;word-break:break-all}'
    +'.status.err{color:#a3382c}'
    +'.status.ok{color:#2f6a58}'
    +'.x{position:absolute;right:10px;top:8px;border:0;background:none;font-size:15px;color:#6b6a60;cursor:pointer;padding:2px 4px}'
    +'</style>'
    +'<button class="fab" type="button">AI 设置</button>'
    +'<div class="panel" hidden>'
    +'<button class="x" type="button" title="关闭">×</button>'
    +'<h3>'+APP_NAME+' · AI 设置</h3>'
    +'<p class="hint">这是导出作品的独立配置，与工作台无关。Key 保存在此站点的浏览器 localStorage 中（按作品名区分，不是安全隔离）。仅向可信作品填写凭据。</p>'
    +'<label>Base URL</label><input data-f="baseUrl" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false">'
    +'<label>模型</label><input data-f="model" placeholder="gpt-4o-mini" autocomplete="off" spellcheck="false">'
    +'<label>API Key</label><input data-f="apiKey" type="password" placeholder="sk-..." autocomplete="off">'
    +'<div class="status"></div>'
    +'<div class="row"><button type="button" data-act="test">测试连接</button><button type="button" data-act="save">保存</button><button type="button" class="primary" data-act="close">完成</button></div>'
    +'</div>';
  var panel=root.querySelector('.panel');
  statusEl=root.querySelector('.status');
  fields={
    baseUrl:root.querySelector('[data-f="baseUrl"]'),
    model:root.querySelector('[data-f="model"]'),
    apiKey:root.querySelector('[data-f="apiKey"]')
  };
  var cfg=readConfig();
  if(cfg){
    fields.baseUrl.value=cfg.baseUrl||'';
    fields.model.value=cfg.model||'';
    fields.apiKey.value=cfg.apiKey||'';
  }
  root.querySelector('.fab').addEventListener('click',function(){ panel.hidden=!panel.hidden });
  root.querySelector('.x').addEventListener('click',function(){ panel.hidden=true });
  root.querySelector('[data-act="close"]').addEventListener('click',function(){ panel.hidden=true });
  root.querySelector('[data-act="save"]').addEventListener('click',function(){ apply(true) });
  root.querySelector('[data-act="test"]').addEventListener('click',function(){ testConnection() });
  fields.apiKey.addEventListener('keydown',function(e){ if(e.key==='Enter') apply(true) });
  return root;
}
function setStatus(text,kind){
  if(!statusEl) return;
  statusEl.textContent=text;
  statusEl.className='status'+(kind?' '+kind:'');
}
function collect(){
  if(!fields) return null;
  var cfg={
    baseUrl:fields.baseUrl.value.trim(),
    model:fields.model.value.trim(),
    apiKey:fields.apiKey.value.trim()
  };
  return cfg;
}
function apply(close){
  ensureUi();
  var cfg=collect();
  if(!cfg) return false;
  if(!normalizeBase(cfg.baseUrl)||!cfg.model){
    setStatus('请先填写 Base URL 与模型','err');
    return false;
  }
  if(!writeConfig(cfg)){
    setStatus('保存失败：浏览器拒绝了 localStorage 写入','err');
    return false;
  }
  setStatus('已保存到本机浏览器','ok');
  if(close){
    var panel=root.querySelector('.panel');
    if(panel) panel.hidden=true;
  }
  return true;
}
function testConnection(){
  ensureUi();
  var cfg=collect();
  if(!cfg||!normalizeBase(cfg.baseUrl)||!cfg.model){ setStatus('请先填写 Base URL 与模型','err'); return }
  setStatus('正在测试连接…');
  var ctrl=window.AbortController?new AbortController():null;
  var timer=setTimeout(function(){ if(ctrl) ctrl.abort() },20000);
  fetch(normalizeBase(cfg.baseUrl)+'/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+(cfg.apiKey||'')},
    body:JSON.stringify({model:cfg.model,messages:[{role:'user',content:'ping'}],max_tokens:8,stream:false}),
    signal:ctrl?ctrl.signal:undefined
  }).then(function(res){
    clearTimeout(timer);
    return res.text().then(function(text){
      if(!res.ok){ setStatus('连接失败（HTTP '+res.status+'）：'+redact(text).slice(0,160),'err'); return }
      setStatus('连接成功','ok');
    });
  }).catch(function(e){
    clearTimeout(timer);
    setStatus('连接失败：'+redact(e&&e.message?e.message:e),'err');
  });
}
function openSettings(){
  var r=ensureUi();
  if(!r) return;
  var panel=r.querySelector('.panel');
  if(panel) panel.hidden=false;
}

/* ── chat ── */
function chat(options){
  var opts=options||{};
  if(opts.profileId&&opts.profileId!=='default') return Promise.reject(new Error('独立作品只有自己的 default 配置，请重新选择作品默认模型'));
  var controller=(typeof AbortController!=='undefined')?new AbortController():null;
  var promise=new Promise(function(resolve,reject){
    var cfg=readConfig();
    if(!cfg){
      openSettings();
      reject(new Error('导出作品还没有配置 AI 端点。请点击右下角「AI 设置」填写 Base URL、模型与 Key。'));
      return;
    }
    var messages;
    try{ messages=validateMessages(opts.messages) }catch(e){ reject(e); return }
    var body={model:cfg.model,stream:true,messages:messages};
    if(typeof opts.temperature==='number') body.temperature=opts.temperature;
    var headers={'Content-Type':'application/json'};
    if(cfg.apiKey) headers.Authorization='Bearer '+cfg.apiKey;
    fetch(normalizeBase(cfg.baseUrl)+'/chat/completions',{
      method:'POST',headers:headers,body:JSON.stringify(body),
      signal:controller?controller.signal:undefined
    }).then(function(res){
      if(!res.ok){
        return res.text().then(function(text){
          throw new Error('模型请求失败（HTTP '+res.status+'）：'+redact(text).slice(0,240));
        });
      }
      var ctype=(res.headers.get('content-type')||'').toLowerCase();
      var canStream=res.body&&typeof res.body.getReader==='function'&&ctype.indexOf('event-stream')>=0;
      if(!canStream){
        return res.json().then(function(json){
          var choice=json&&json.choices&&json.choices[0];
          var text=(choice&&((choice.message&&choice.message.content)||choice.text))||'';
          if(text&&typeof opts.onChunk==='function'){ try{ opts.onChunk(text) }catch(e){} }
          resolve({text:String(text||''),usage:(json&&json.usage)||null});
        });
      }
      var reader=res.body.getReader();
      var decoder=new TextDecoder();
      var buffer='';
      var text='';
      function pump(){
        return reader.read().then(function(chunk){
          if(chunk.done){ resolve({text:text,usage:null}); return }
          buffer+=decoder.decode(chunk.value,{stream:true});
          var lines=buffer.split(/\\r?\\n/);
          buffer=lines.pop()||'';
          for(var i=0;i<lines.length;i++){
            var line=lines[i];
            if(!line||line.slice(0,5)!=='data:') continue;
            var payload=line.slice(5).trim();
            if(!payload||payload==='[DONE]') continue;
            try{
              var json=JSON.parse(payload);
              var choice=json.choices&&json.choices[0];
              var delta=choice&&(choice.delta||choice.message);
              var piece=delta&&delta.content;
              if(piece){
                text+=piece;
                if(typeof opts.onChunk==='function'){ try{ opts.onChunk(piece) }catch(e){} }
              }
            }catch(e){}
          }
          return pump();
        });
      }
      return pump();
    }).catch(function(e){
      if(e&&e.name==='AbortError'){ reject(new Error('AI 请求已取消')); return }
      reject(e instanceof Error?e:new Error(String(e)));
    });
  });
  promise.cancel=function(){ if(controller) controller.abort() };
  return promise;
}

window.Workbench=window.Workbench||{};
window.Workbench.ai={
  getProfiles:function(){var cfg=readConfig();return Promise.resolve(cfg?[{profileId:'default',name:'本作品配置',model:cfg.model,baseUrl:normalizeBase(cfg.baseUrl)}]:[])},
  chat:chat,
  openSettings:openSettings,
  standalone:true,
  note:'导出作品的独立 AI 运行时：由本页自己的设置面板配置端点，不包含工作台密钥。'
};
function bootUi(){
  try{ ensureUi() }catch(e){}
}
if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',bootUi,{once:true});
}else{
  bootUi();
}
})();`
  return `<script>${source}</script>`
}

export interface StandaloneRuntimeResult {
  html: string
  injected: ('storage' | 'ai')[]
}

export function injectStandaloneRuntime(
  html: string,
  options: { prefix: string; appName: string; needs?: RuntimeNeeds },
): StandaloneRuntimeResult {
  const needs = options.needs || detectRuntimeNeeds(html)
  const snippets: string[] = []
  const injected: ('storage' | 'ai')[] = []
  if (needs.storage) {
    snippets.push(standaloneStorageShim(options.prefix, options.appName))
    injected.push('storage')
  }
  if (needs.ai) {
    snippets.push(standaloneAiShim({ prefix: options.prefix, appName: options.appName }))
    injected.push('ai')
  }
  if (!snippets.length) return { html, injected }
  return { html: injectBeforeFirstScript(html, snippets.join('')), injected }
}
