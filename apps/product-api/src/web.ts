export const productWebHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="light">
  <title>项目过程图谱</title>
  <style>
    :root{font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#172235;background:#f4f7fb;--ink:#172235;--muted:#68758a;--line:#dce3ed;--blue:#2864dc;--blue-soft:#eaf1ff;--white:#fff;--green:#12805c;--shadow:0 12px 30px rgba(30,54,88,.08)}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(135deg,#f8faff 0,#eef3fb 100%)}button,input{font:inherit}button{cursor:pointer}.shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr}
    header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 24px;background:rgba(255,255,255,.92);border-bottom:1px solid var(--line);backdrop-filter:blur(12px);position:sticky;top:0;z-index:3}.brand{display:flex;align-items:center;gap:12px}.mark{width:38px;height:38px;border-radius:12px;background:linear-gradient(145deg,#3679ef,#193f9b);display:grid;place-items:center;color:white;font-weight:800}.brand strong{display:block}.brand small,.muted{color:var(--muted)}.runtime{display:flex;align-items:center;gap:8px;color:var(--green);font-size:13px}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px #dff5ec}
    main{display:grid;grid-template-columns:290px minmax(0,1fr);gap:18px;padding:20px;max-width:1440px;width:100%;margin:0 auto}.panel{background:var(--white);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}aside{padding:14px;height:max-content}.eyebrow{text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:var(--muted);font-size:11px;padding:4px 8px 10px}.node-list{display:grid;gap:6px}.node{width:100%;border:0;background:transparent;text-align:left;border-radius:12px;padding:12px;color:var(--ink)}.node:hover{background:#f4f7fb}.node.active{background:var(--blue-soft);color:#184ba8}.node span{display:block;font-size:12px;color:var(--muted);margin-top:3px}.content{padding:24px;min-height:620px}.topline{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.topline h1{font-size:26px;margin:0 0 6px}.kind{display:inline-flex;padding:6px 10px;border-radius:999px;background:#f0f3f8;color:#55647a;font-size:12px}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.metric{padding:16px;border:1px solid var(--line);border-radius:14px}.metric b{display:block;font-size:24px;margin-top:4px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:24px 0 12px}.section-head h2{font-size:17px;margin:0}.primary{border:0;border-radius:10px;background:var(--blue);color:white;padding:10px 14px;font-weight:650}.secondary{border:1px solid var(--line);border-radius:9px;background:white;color:var(--ink);padding:8px 11px}.tasks{display:grid;gap:10px}.empty{border:1px dashed #cbd5e3;border-radius:14px;padding:30px;text-align:center;color:var(--muted)}.task{border:1px solid var(--line);border-radius:14px;padding:15px}.task-row{display:flex;justify-content:space-between;align-items:center;gap:12px}.task-title{font-weight:700}.status{font-size:12px;border-radius:999px;padding:5px 9px;background:#eef3f9;color:#52647b}.files{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.file{font-size:12px;background:#f6f8fb;border:1px solid #e5eaf1;border-radius:8px;padding:6px 8px}.task-actions{margin-top:12px}.drawer{display:none;margin-top:16px;padding:16px;border-radius:14px;background:#f7f9fc;border:1px solid var(--line)}.drawer.open{display:block}.form-grid{display:grid;grid-template-columns:1fr auto;gap:10px}.field{width:100%;border:1px solid #bcc8d9;border-radius:10px;padding:10px 12px;background:white}.notice{position:fixed;right:18px;bottom:18px;max-width:min(400px,calc(100vw - 36px));background:#172235;color:white;border-radius:12px;padding:12px 14px;box-shadow:var(--shadow);display:none;z-index:5}.notice.show{display:block}.notice.error{background:#9f2836}
    @media(max-width:760px){header{padding:12px 14px}.runtime span:last-child{display:none}main{display:block;padding:12px}aside{margin-bottom:12px;overflow:auto}.node-list{display:flex;min-width:max-content}.node{width:145px}.content{padding:18px;min-height:480px}.summary{grid-template-columns:1fr 1fr}.summary .metric:last-child{grid-column:1/-1}.topline{display:block}.kind{margin-top:10px}.form-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="shell">
    <header><div class="brand"><div class="mark">图</div><div><strong>项目过程图谱</strong><small>过程、任务与证据在同一上下文</small></div></div><div class="runtime"><i class="dot"></i><span id="runtimeText">正在连接本机服务</span></div></header>
    <main>
      <aside class="panel"><div class="eyebrow">项目节点</div><nav id="nodeList" class="node-list" aria-label="项目节点"></nav></aside>
      <section class="panel content">
        <div id="loading" class="empty">正在读取项目…</div>
        <div id="detail" hidden>
          <div class="topline"><div><div class="eyebrow" style="padding-left:0">PHASE 0 PROJECT</div><h1 id="nodeTitle"></h1><div id="nodeId" class="muted"></div></div><span id="nodeKind" class="kind"></span></div>
          <div class="summary"><div class="metric"><span class="muted">任务</span><b id="taskCount">0</b></div><div class="metric"><span class="muted">证据文件</span><b id="fileCount">0</b></div><div class="metric"><span class="muted">运行方式</span><b style="font-size:16px">原生 Node</b></div></div>
          <div class="section-head"><h2>节点任务</h2><button id="toggleCreate" class="primary">新建任务</button></div>
          <form id="createForm" class="drawer"><div class="form-grid"><input id="taskTitle" class="field" maxlength="120" required placeholder="输入任务名称"><button class="primary" type="submit">创建</button></div></form>
          <div id="tasks" class="tasks"></div>
        </div>
      </section>
    </main>
  </div>
  <div id="notice" class="notice" role="status"></div>
  <script>
    const state={nodes:[],selected:null};
    const $=id=>document.getElementById(id);
    const kinds={stage:'阶段',work_package:'工作包',milestone:'里程碑'};
    const statuses={todo:'待开始',in_progress:'进行中',completed:'已完成',canceled:'已取消'};
    const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const key=prefix=>prefix+'-'+Date.now()+'-'+Math.random().toString(16).slice(2);
    function toast(message,error=false){const el=$('notice');el.textContent=message;el.className='notice show'+(error?' error':'');setTimeout(()=>el.className='notice',3000)}
    async function api(path,options={}){const response=await fetch(path,options);const body=await response.json().catch(()=>({message:'服务返回了无效响应'}));if(!response.ok)throw new Error(body.message||body.code||'请求失败');return body}
    async function boot(){try{const health=await api('/health');$('runtimeText').textContent=health.adapterMode==='memory'?'本机演示服务已就绪':'SaaS 适配器已配置';state.nodes=await api('/api/nodes');renderNodes();await select(state.nodes[0]?.id)}catch(error){$('loading').textContent='无法连接产品服务：'+error.message;$('runtimeText').textContent='服务不可用'}}
    function renderNodes(){$('nodeList').innerHTML=state.nodes.map(node=>'<button class="node'+(node.id===state.selected?' active':'')+'" data-id="'+esc(node.id)+'"><b>'+esc(node.title)+'</b><span>'+esc(node.id)+' · '+esc(kinds[node.kind]||node.kind)+'</span></button>').join('');document.querySelectorAll('.node').forEach(button=>button.onclick=()=>select(button.dataset.id))}
    async function select(id){if(!id)return;state.selected=id;renderNodes();$('loading').hidden=false;$('detail').hidden=true;try{const value=await api('/api/nodes/'+encodeURIComponent(id));renderDetail(value)}catch(error){toast(error.message,true)}finally{$('loading').hidden=true}}
    function renderDetail(value){$('detail').hidden=false;$('nodeTitle').textContent=value.node.title;$('nodeId').textContent=value.node.id;$('nodeKind').textContent=kinds[value.node.kind]||value.node.kind;$('taskCount').textContent=value.tasks.length;$('fileCount').textContent=value.tasks.reduce((sum,task)=>sum+task.files.length,0);$('tasks').innerHTML=value.tasks.length?value.tasks.map(task=>'<article class="task"><div class="task-row"><div><div class="task-title">'+esc(task.title)+'</div><div class="muted" style="font-size:12px;margin-top:3px">'+esc(task.id)+'</div></div><span class="status">'+esc(statuses[task.status]||task.status)+'</span></div><div class="files">'+task.files.map(file=>'<span class="file">📎 '+esc(file.name)+' · '+file.size+'B</span>').join('')+'</div><div class="task-actions"><label class="secondary">上传证据<input type="file" hidden data-task="'+esc(task.id)+'"></label></div></article>').join(''):'<div class="empty">这个节点还没有任务。创建一条任务即可验证原生运行链路。</div>';document.querySelectorAll('input[type=file]').forEach(input=>input.onchange=()=>upload(input))}
    $('toggleCreate').onclick=()=>{$('createForm').classList.toggle('open');$('taskTitle').focus()};
    $('createForm').onsubmit=async event=>{event.preventDefault();try{await api('/api/nodes/'+encodeURIComponent(state.selected)+'/tasks',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key('web-task')},body:JSON.stringify({title:$('taskTitle').value})});$('taskTitle').value='';$('createForm').classList.remove('open');toast('任务已创建');await select(state.selected)}catch(error){toast(error.message,true)}};
    async function upload(input){const file=input.files?.[0];if(!file)return;if(file.size>2*1024*1024){toast('当前验证包限制文件不超过 2 MiB',true);return}try{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';bytes.forEach(byte=>binary+=String.fromCharCode(byte));await api('/api/tasks/'+encodeURIComponent(input.dataset.task)+'/files',{method:'POST',headers:{'content-type':'application/json','idempotency-key':key('web-file')},body:JSON.stringify({name:file.name,contentType:file.type||'application/octet-stream',contentBase64:btoa(binary)})});toast('证据文件已关联');await select(state.selected)}catch(error){toast(error.message,true)}}
    boot();
  </script>
</body>
</html>`;
