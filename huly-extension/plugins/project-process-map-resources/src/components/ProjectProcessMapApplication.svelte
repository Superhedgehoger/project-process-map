<script lang="ts">
  type NodeState = 'done' | 'active' | 'risk' | 'planned'
  type ProcessNode = { id: string, stage: string, title: string, owner: string, state: NodeState, progress: number }

  const nodes: ProcessNode[] = [
    { id: 'N-01', stage: '01', title: '项目启动', owner: '产品负责人', state: 'done', progress: 100 },
    { id: 'N-02', stage: '02', title: '需求澄清', owner: '产品与市场', state: 'done', progress: 100 },
    { id: 'N-03', stage: '03', title: '方案设计', owner: '设计负责人', state: 'active', progress: 68 },
    { id: 'N-04', stage: '04', title: '开发与联调', owner: '研发负责人', state: 'risk', progress: 42 },
    { id: 'N-05', stage: '05', title: '测试验收', owner: '测试负责人', state: 'planned', progress: 0 },
    { id: 'N-06', stage: '06', title: '发布复盘', owner: '项目经理', state: 'planned', progress: 0 }
  ]

  let selected = nodes[2]
  const stateLabel: Record<NodeState, string> = { done: '已完成', active: '进行中', risk: '有风险', planned: '未开始' }
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
      <span class="sync"><i></i> 数据已同步</span>
      <button class="secondary">筛选</button>
      <button class="primary">新建节点</button>
    </div>
  </header>

  <section class="summary" aria-label="项目摘要">
    <div><span>项目</span><strong>自营软件项目 · 2026</strong></div>
    <div><span>整体进度</span><strong>52%</strong></div>
    <div><span>当前阶段</span><strong>方案设计</strong></div>
    <div><span>待验收任务</span><strong>3</strong></div>
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

      <div class="section-title"><h3>任务</h3><button>查看全部</button></div>
      <div class="task"><span class="check done">✓</span><div><b>完成交互方案</b><small>设计负责人 · 昨天</small></div></div>
      <div class="task"><span class="check">•</span><div><b>评审技术可行性</b><small>研发负责人 · 今天</small></div></div>
      <div class="task"><span class="check risk">!</span><div><b>补充异常流程</b><small>产品负责人 · 已逾期 1 天</small></div></div>

      <div class="section-title"><h3>阶段交付物</h3><button>上传</button></div>
      <div class="file"><span>FIG</span><div><b>交互设计稿.fig</b><small>已关联 · 4.8 MB</small></div></div>
      <div class="file"><span>PDF</span><div><b>方案评审记录.pdf</b><small>待验收 · 1.2 MB</small></div></div>
      <div class="notice"><b>完成守卫</b><p>仍有 1 个必需交付物待验收，当前节点不能完成。</p></div>
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
  .task b, .task small, .file b, .file small { display: block; }
  .task b, .file b { margin-bottom: 3px; font-size: 11px; }
  .task small, .file small { color: #8a9893; font-size: 9px; }
  .check { display: grid; place-items: center; flex: 0 0 22px; height: 22px; color: #408571; border: 1px solid #bcd8cf; border-radius: 7px; font-size: 10px; }
  .check.done { color: white; border-color: #559d88; background: #559d88; } .check.risk { color: #b96a27; border-color: #edbf94; background: #fff5eb; }
  .file > span { display: grid; place-items: center; flex: 0 0 30px; height: 34px; color: #52756b; border-radius: 7px; background: #eaf1ee; font-size: 8px; font-weight: 800; }
  .notice { margin-top: 20px; padding: 13px; color: #805427; border: 1px solid #f0d6ba; border-radius: 10px; background: #fff8f0; }
  .notice b { font-size: 10px; } .notice p { margin: 5px 0 0; font-size: 9px; line-height: 1.5; }
  @media (max-width: 840px) { .app-shell { padding: 16px; } .topbar { align-items: flex-start; flex-direction: column; } .summary { grid-template-columns: 1fr 1fr; } .summary div:nth-child(2) { border-right: 0; } .workspace { grid-template-columns: 1fr; } .detail { border-top: 1px solid #e4ebe8; border-left: 0; } }
</style>
