<script lang="ts">
  import { getCurrentWorkspaceUuid } from '@hcengineering/presentation'

  // Huly is an optional launch surface only. Product state, contracts and
  // commands remain owned by the SaaS application and Product API.
  const productBase = ((globalThis as any).__PROJECT_PROCESS_MAP_APP__ as string | undefined) ?? 'http://127.0.0.1:4100'
  const workspace = getCurrentWorkspaceUuid()
  const productUrl = `${productBase}?host=huly&workspace=${encodeURIComponent(workspace)}`
</script>

<svelte:head><title>项目过程图谱</title></svelte:head>

<main class="host-shell">
  <section>
    <div class="mark">图</div>
    <div class="eyebrow">PROJECT PROCESS MAP</div>
    <h1>项目过程图谱</h1>
    <p>完整项目地图、任务、交付物与证据统一在 SaaS 工作台中操作。Huly 仅提供协作入口，不保存第二份产品状态。</p>
    <a href={productUrl} target="_blank" rel="noopener noreferrer">打开 SaaS 工作台</a>
    <small>工作区：{workspace}</small>
  </section>
</main>

<style lang="scss">
  :global(*) { box-sizing: border-box; }
  .host-shell { min-height: 100%; display: grid; place-items: center; padding: 32px; color: #172235; background: linear-gradient(135deg, #f8faff, #eef3fb); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  section { width: min(520px, 100%); padding: 38px; border: 1px solid #dce3ed; border-radius: 20px; background: white; box-shadow: 0 18px 48px rgba(30,54,88,.1); }
  .mark { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 24px; color: white; border-radius: 13px; background: linear-gradient(145deg, #3679ef, #193f9b); font-weight: 800; }
  .eyebrow { color: #68758a; font-size: 10px; font-weight: 750; letter-spacing: .14em; }
  h1 { margin: 8px 0 12px; font-size: 28px; letter-spacing: -.03em; }
  p { margin: 0 0 24px; color: #68758a; font-size: 14px; line-height: 1.7; }
  a { display: inline-flex; padding: 11px 16px; color: white; border-radius: 10px; background: #2864dc; text-decoration: none; font-size: 13px; font-weight: 700; }
  small { display: block; margin-top: 18px; color: #8b96a7; overflow-wrap: anywhere; }
</style>
