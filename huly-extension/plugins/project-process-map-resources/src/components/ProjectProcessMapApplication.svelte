<script lang="ts">
  import { getMetadata } from '@hcengineering/platform'
  import presentation, { getCurrentWorkspaceUuid } from '@hcengineering/presentation'

  type NodeState = 'done' | 'active' | 'risk' | 'planned'
  type ProcessNode = { id: string, stage: string, title: string, owner: string, state: NodeState, progress: number }
  type ApiFile = { id: string, taskId: string, nodeId: string, name: string, contentType: string, size: number, scanState: 'scanning' | 'available' | 'quarantined' | 'failed' }
  type ApiTask = { id: string, nodeId: string, title: string, status: 'todo' | 'in_progress' | 'completed' | 'canceled', files: ApiFile[] }
  type NodeDetail = { tasks: ApiTask[] }

  const nodes: ProcessNode[] = [
    { id: 'N-01', stage: '01', title: '项目启动', owner: '产品负责人', state: 'done', progress: 100 },
    { id: 'N-02', stage: '02', title: '需求澄清', owner: '产品与市场', state: 'done', progress: 100 },
    { id: 'N-03', stage: '03', title: '方案设计', owner: '设计负责人', state: 'active', progress: 68 },
    { id: 'N-04', stage: '04', title: '开发与联调', owner: '研发负责人', state: 'risk', progress: 42 },
    { id: 'N-05', stage: '05', title: '测试验收', owner: '测试负责人', state: 'planned', progress: 0 },
    { id: 'N-06', stage: '06', title: '发布复盘', owner: '项目经理', state: 'planned', progress: 0 }
  ]

  let selected = nodes[2]
  let tasks: ApiTask[] = []
  let detailLoading = false
  let detailError = ''
  let newTaskTitle = ''
  let fileInput: HTMLInputElement
  let uploadTaskId = ''
  const stateLabel: Record<NodeState, string> = { done: '已完成', active: '进行中', risk: '有风险', planned: '未开始' }
  const taskStatusLabel: Record<ApiTask['status'], string> = { todo: '未开始', in_progress: '进行中', completed: '已完成', canceled: '已取消' }
  const fileScanLabel: Record<ApiFile['scanState'], string> = { scanning: '处理中', available: '可用', quarantined: '已隔离', failed: '处理失败' }
  const apiBase = ((globalThis as any).__PROJECT_PROCESS_MAP_API__ as string | undefined) ?? 'http://127.0.0.1:4100'

  $: selected.id, void loadDetail(selected.id)

  async function loadDetail (nodeId: string): Promise<void> {
    detailLoading = true
    detailError = ''
    try {
      const response = await apiFetch(`/api/nodes/${encodeURIComponent(nodeId)}`)
      if (!response.ok) throw new Error(await responseMessage(response))
      const detail = await response.json() as NodeDetail
      if (selected.id === nodeId) tasks = detail.tasks
    } catch (error) {
      if (selected.id === nodeId) {
        tasks = []
        detailError = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (selected.id === nodeId) detailLoading = false
    }
  }

  async function createTask (): Promise<void> {
    const title = newTaskTitle.trim()
    if (title.length === 0) return
    detailError = ''
    const key = crypto.randomUUID()
    try {
      const response = await apiFetch(`/api/nodes/${encodeURIComponent(selected.id)}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ title, status: 'todo' })
      })
      if (!response.ok) throw new Error(await responseMessage(response))
      newTaskTitle = ''
      await loadDetail(selected.id)
    } catch (error) {
      detailError = error instanceof Error ? error.message : String(error)
    }
  }

  function chooseFile (taskId: string): void {
    uploadTaskId = taskId
    fileInput.click()
  }

  async function attachFile (event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file === undefined || uploadTaskId.length === 0) return
    detailError = ''
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const response = await apiFetch(`/api/tasks/${encodeURIComponent(uploadTaskId)}/files`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          contentBase64: bytesToBase64(bytes),
          sha256: await sha256(bytes)
        })
      })
      if (!response.ok) throw new Error(await responseMessage(response))
      await loadDetail(selected.id)
    } catch (error) {
      detailError = error instanceof Error ? error.message : String(error)
    } finally {
      input.value = ''
      uploadTaskId = ''
    }
  }

  async function apiFetch (path: string, init: RequestInit = {}): Promise<Response> {
    const token = getMetadata(presentation.metadata.Token) ?? ''
    const workspace = getCurrentWorkspaceUuid()
    const headers = new Headers(init.headers)
    if (token.length > 0) headers.set('authorization', `Bearer ${token}`)
    headers.set('x-huly-workspace', workspace)
    return await fetch(`${apiBase}${path}`, { ...init, headers })
  }

  async function responseMessage (response: Response): Promise<string> {
    try {
      const value = await response.json() as { message?: string }
      return value.message ?? `请求失败 (${response.status})`
    } catch {
      return `请求失败 (${response.status})`
    }
  }

  function bytesToBase64 (bytes: Uint8Array): string {
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    }
    return btoa(binary)
  }

  async function sha256 (bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  }
</script>

<svelte:head><title>项目过程图谱</title></svelte:head>

<main class="app-shell">
  <header class="topbar">
    <div>
      <div class="eyebrow">PROJECT PROCESS MAP · PHASE 0</div>
      <h1>项目过程图谱</h1>
      <p>让阶段、责任、任务和证据在同一条过程线上可见。</p>
    </div>
    <div class="top-actions">
      <span class:error={detailError.length > 0} class="sync"><i></i> {detailLoading ? '同步中' : detailError.length > 0 ? '连接异常' : '数据已同步'}</span>
      <button class="secondary">筛选</button>
      <button class="primary">新建节点</button>
    </div>
  </header>

  <section class="summary" aria-label="项目摘要">
    <div><span>项目</span><strong>自营软件项目 · 2026</strong></div>
    <div><span>整体进度</span><strong>52%</strong></div>
    <div><span>当前阶段</span><strong>方案设计</strong></div>
    <div><span>当前节点任务</span><strong>{tasks.length}</strong></div>
  </section>

  <div class="workspace">
    <section class="canvas" aria-label="过程图谱">
      <div class="canvas-heading">
        <div><span class="view-label">地图视图</span><span class="count">6 个节点</span></div>
        <div class="legend"><span class="done-dot">完成</span><span class="active-dot">进行中</span><span class="risk-dot">风险</span></div>
      </div>
      <div class="flow">
        {#each nodes as node, index}
          <button class:selected={selected.id === node.id} class="node {node.state}" on:click={() => selected = node} aria-label={`查看${node.title}`}>
            <span class="stage">{node.stage}</span>
            <span class="node-copy"><b>{node.title}</b><small>{node.owner}</small></span>
            <span class="node-meta"><em>{stateLabel[node.state]}</em><small>{node.progress}%</small></span>
          </button>
          {#if index < nodes.length - 1}<div class="connector" aria-hidden="true"><span></span></div>{/if}
        {/each}
      </div>
    </section>

    <aside class="detail" aria-label="节点详情">
      <div class="detail-kicker">节点 {selected.id}</div>
      <div class="detail-title"><div><h2>{selected.title}</h2><p>{selected.owner}</p></div><span class="status {selected.state}">{stateLabel[selected.state]}</span></div>
      <div class="progress-label"><span>节点进度</span><b>{selected.progress}%</b></div>
      <div class="progress"><span style={`width:${selected.progress}%`}></span></div>

      <div class="section-title"><h3>真实任务与文件</h3><span class="source">Product API → Huly</span></div>
      <div class="task-create">
        <input bind:value={newTaskTitle} placeholder="输入任务标题" aria-label="任务标题" on:keydown={(event) => event.key === 'Enter' && void createTask()} />
        <button on:click={() => void createTask()} disabled={newTaskTitle.trim().length === 0}>新建</button>
      </div>
      {#if detailLoading}
        <div class="empty">正在读取节点任务…</div>
      {:else if detailError.length > 0}
        <div class="notice"><b>连接提示</b><p>{detailError}</p><button on:click={() => void loadDetail(selected.id)}>重试</button></div>
      {:else if tasks.length === 0}
        <div class="empty">此节点暂无任务</div>
      {:else}
        {#each tasks as task}
          <div class="task-row">
            <div class="task"><span class="check" class:done={task.status === 'completed'}>{task.status === 'completed' ? '✓' : '•'}</span><div><b>{task.title}</b><small>{taskStatusLabel[task.status]} · {task.files.length} 个文件</small></div></div>
            <button class="attach" on:click={() => chooseFile(task.id)}>附加证据</button>
          </div>
          {#each task.files as file}
            <div class="file"><span>{file.name.split('.').pop()?.slice(0, 4).toUpperCase() ?? 'FILE'}</span><div><b>{file.name}</b><small>{fileScanLabel[file.scanState]} · {Math.max(1, Math.round(file.size / 1024))} KB</small></div></div>
          {/each}
        {/each}
      {/if}
      <input class="file-input" bind:this={fileInput} type="file" on:change={(event) => void attachFile(event)} />
      <div class="notice neutral"><b>P0-05 边界</b><p>这里只证明 Node → Huly Task → File 引用；任务验收与交付物守卫将在后续切片实现。</p></div>
    </aside>
  </div>
</main>

<style lang="scss">
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; }
  .app-shell { min-height: 100%; padding: 28px; color: #15231f; background: #f4f7f5; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .topbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 22px; }
  .eyebrow { color: #608078; font-size: 10px; font-weight: 750; letter-spacing: .17em; }
  h1 { margin: 7px 0 3px; font-size: 28px; letter-spacing: -.035em; }
  .topbar p { margin: 0; color: #71817c; font-size: 13px; }
  .top-actions { display: flex; align-items: center; gap: 9px; }
  button { font: inherit; }
  .top-actions button, .section-title button { border: 0; cursor: pointer; }
  .primary, .secondary { height: 36px; padding: 0 15px; border-radius: 10px; font-size: 12px; font-weight: 680; }
  .primary { color: white; background: #176b5a; box-shadow: 0 6px 18px rgba(23,107,90,.18); }
  .secondary { color: #35534b; background: white; box-shadow: inset 0 0 0 1px #dce5e1; }
  .sync { display: flex; align-items: center; gap: 7px; margin-right: 8px; color: #698078; font-size: 11px; }
  .sync i { width: 7px; height: 7px; border-radius: 50%; background: #27a47f; box-shadow: 0 0 0 4px #dff3ec; }
  .sync.error { color: #a35f2a; } .sync.error i { background: #d9813b; box-shadow: 0 0 0 4px #fff0e3; }
  .summary { display: grid; grid-template-columns: 2fr repeat(3, 1fr); margin-bottom: 16px; border: 1px solid #dfe7e3; border-radius: 14px; background: #fff; box-shadow: 0 7px 24px rgba(23,54,45,.045); }
  .summary div { min-height: 70px; padding: 16px 18px; border-right: 1px solid #edf1ef; }
  .summary div:last-child { border: 0; }
  .summary span, .summary strong { display: block; }
  .summary span { margin-bottom: 7px; color: #82908b; font-size: 10px; }
  .summary strong { font-size: 14px; }
  .workspace { display: grid; grid-template-columns: minmax(480px, 1fr) 320px; min-height: 570px; overflow: hidden; border: 1px solid #dfe7e3; border-radius: 16px; background: #fff; box-shadow: 0 12px 34px rgba(23,54,45,.06); }
  .canvas { padding: 22px; overflow: auto; background-color: #fbfcfb; background-image: radial-gradient(#dce6e1 1px, transparent 1px); background-size: 20px 20px; }
  .canvas-heading { display: flex; justify-content: space-between; color: #657771; font-size: 11px; }
  .view-label { padding: 6px 10px; color: #176b5a; border-radius: 7px; background: #e8f3ef; font-weight: 700; }
  .count { margin-left: 10px; }
  .legend { display: flex; gap: 16px; }
  .legend span::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; }
  .done-dot::before { background: #7c9c92; } .active-dot::before { background: #19a77a; } .risk-dot::before { background: #e79045; }
  .flow { display: flex; flex-direction: column; align-items: center; max-width: 540px; margin: 34px auto; }
  .node { display: grid; grid-template-columns: 40px 1fr auto; align-items: center; width: 100%; padding: 14px; text-align: left; color: #1c2d28; border: 1px solid #dfe7e3; border-radius: 13px; background: white; box-shadow: 0 6px 20px rgba(25,60,50,.06); cursor: pointer; transition: .16s ease; }
  .node:hover, .node.selected { transform: translateY(-1px); border-color: #5ca693; box-shadow: 0 9px 24px rgba(25,105,85,.12); }
  .node.risk { border-left: 3px solid #e79045; }
  .stage { display: grid; place-items: center; width: 29px; height: 29px; color: #547269; border-radius: 9px; background: #edf3f0; font-size: 10px; font-weight: 800; }
  .node-copy b, .node-copy small, .node-meta em, .node-meta small { display: block; }
  .node-copy b { margin-bottom: 4px; font-size: 13px; }
  .node-copy small, .node-meta small { color: #8a9893; font-size: 10px; }
  .node-meta { text-align: right; }
  .node-meta em { margin-bottom: 4px; color: #52776c; font-size: 10px; font-style: normal; font-weight: 700; }
  .risk .node-meta em { color: #b96a27; }
  .connector { width: 1px; height: 25px; background: #bfcec8; }
  .connector span { display: block; width: 5px; height: 5px; margin: 10px 0 0 -2px; border-right: 1px solid #91a69e; border-bottom: 1px solid #91a69e; transform: rotate(45deg); }
  .detail { padding: 24px; border-left: 1px solid #e4ebe8; background: #fff; }
  .detail-kicker { color: #83928d; font-size: 10px; font-weight: 700; letter-spacing: .12em; }
  .detail-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin: 8px 0 24px; }
  .detail-title h2 { margin: 0 0 5px; font-size: 20px; letter-spacing: -.025em; }
  .detail-title p { margin: 0; color: #84918d; font-size: 11px; }
  .status { padding: 5px 8px; color: #387261; border-radius: 7px; background: #e7f3ef; font-size: 9px; font-weight: 750; white-space: nowrap; }
  .status.risk { color: #ac6428; background: #fff0e3; }
  .status.planned { color: #71807b; background: #eef1f0; }
  .progress-label { display: flex; justify-content: space-between; margin-bottom: 7px; color: #6f807a; font-size: 10px; }
  .progress-label b { color: #2d5f52; }
  .progress { height: 6px; margin-bottom: 25px; overflow: hidden; border-radius: 99px; background: #e8eeeb; }
  .progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #1d806a, #43b48f); }
  .section-title { display: flex; align-items: center; justify-content: space-between; margin: 22px 0 10px; }
  .section-title h3 { margin: 0; font-size: 12px; }
  .section-title button { padding: 0; color: #267762; background: transparent; font-size: 10px; }
  .task, .file { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #eff2f1; }
  .source { color: #789087; font-size: 9px; }
  .task-create { display: flex; gap: 7px; margin-bottom: 7px; }
  .task-create input { min-width: 0; flex: 1; height: 34px; padding: 0 10px; border: 1px solid #dce5e1; border-radius: 8px; background: #fbfcfb; font-size: 10px; outline: none; }
  .task-create input:focus { border-color: #5ca693; box-shadow: 0 0 0 3px #e5f2ee; }
  .task-create button, .attach, .notice button { border: 0; border-radius: 7px; color: #176b5a; background: #e7f3ef; cursor: pointer; font-size: 9px; font-weight: 700; }
  .task-create button { padding: 0 11px; }
  .task-create button:disabled { opacity: .45; cursor: default; }
  .task-row { display: flex; align-items: center; border-bottom: 1px solid #eff2f1; }
  .task-row .task { min-width: 0; flex: 1; border: 0; }
  .attach { padding: 6px 8px; white-space: nowrap; }
  .file { margin-left: 32px; }
  .file-input { display: none; }
  .empty { padding: 18px 4px; color: #8a9893; text-align: center; font-size: 10px; }
  .task b, .task small, .file b, .file small { display: block; }
  .task b, .file b { margin-bottom: 3px; font-size: 11px; }
  .task small, .file small { color: #8a9893; font-size: 9px; }
  .check { display: grid; place-items: center; flex: 0 0 22px; height: 22px; color: #408571; border: 1px solid #bcd8cf; border-radius: 7px; font-size: 10px; }
  .check.done { color: white; border-color: #559d88; background: #559d88; } .check.risk { color: #b96a27; border-color: #edbf94; background: #fff5eb; }
  .file > span { display: grid; place-items: center; flex: 0 0 30px; height: 34px; color: #52756b; border-radius: 7px; background: #eaf1ee; font-size: 8px; font-weight: 800; }
  .notice { margin-top: 20px; padding: 13px; color: #805427; border: 1px solid #f0d6ba; border-radius: 10px; background: #fff8f0; }
  .notice b { font-size: 10px; } .notice p { margin: 5px 0 0; font-size: 9px; line-height: 1.5; }
  .notice button { margin-top: 8px; padding: 6px 9px; }
  .notice.neutral { color: #526b64; border-color: #dce7e3; background: #f5f8f7; }
  @media (max-width: 840px) { .app-shell { padding: 16px; } .topbar { align-items: flex-start; flex-direction: column; } .summary { grid-template-columns: 1fr 1fr; } .summary div:nth-child(2) { border-right: 0; } .workspace { grid-template-columns: 1fr; } .detail { border-top: 1px solid #e4ebe8; border-left: 0; } }
</style>
