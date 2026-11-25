---
name: MatrixArk Design System
description: High-precision studio workbench design system for multi-account content creation, editorial review, AI topic intelligence, and publishing operations.
colors:
  indigo-accent: "#5240d0"
  indigo-accent-dark: "#3e2ebd"
  indigo-light-accent: "#a99dfc"
  indigo-fill-dark: "#6556d4"
  indigo-soft: "#eeebff"
  indigo-tint: "#f6f5fe"
  canvas-light: "#f1f3f9"
  canvas-dark: "#090c14"
  surface-paper: "#ffffff"
  surface-paper-dark: "#141927"
  surface-raised-dark: "#1b2235"
  surface-subcard-light: "#fafbfe"
  surface-inset-light: "#eef1f7"
  ink-primary: "#15192b"
  ink-primary-dark: "#f0f3fa"
  ink-secondary: "#3b4256"
  ink-muted: "#56607a"
  ink-quiet: "#67718b"
  line-default: "#e0e4ef"
  line-soft: "#eaeef6"
  line-strong: "#c8cfe0"
  semantic-success: "#059669"
  semantic-danger: "#d93025"
  semantic-warning: "#b45309"
  semantic-info: "#0369a1"
typography:
  display:
    fontFamily: "Inter, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 750
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Inter, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "15.5px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "0em"
  body:
    fontFamily: "Inter, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0em"
  label:
    fontFamily: "Inter, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0em"
rounded:
  sm: "9px"
  md: "14px"
  lg: "18px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "14px"
  lg: "18px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.indigo-accent}"
    textColor: "{colors.surface-paper}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.indigo-accent-dark}"
    textColor: "{colors.surface-paper}"
  button-secondary:
    backgroundColor: "{colors.surface-paper}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "40px"
  input-field:
    backgroundColor: "{colors.surface-paper}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    height: "40px"
  surface-card:
    backgroundColor: "{colors.surface-paper}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "18px"
  nav-item-active:
    backgroundColor: "{colors.indigo-soft}"
    textColor: "{colors.indigo-accent-dark}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "42px"
  kpi-chip:
    backgroundColor: "{colors.surface-subcard-light}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.label}"
    rounded: "11px"
    padding: "7px 14px"
    height: "44px"
---

# Design System: MatrixArk

## Overview

**Creative North Star: "The Editorial Operations Desk"**

MatrixArk 是一个面向多账号矩阵运营团队的生产力工作台（Operate 模式）。整体视觉在「理性精准」与「柔和桌面光感」之间取得平衡：以冷灰蓝画布作为沉稳底色，通过五层有序抬升的表面阶梯托举出稿件卡片、列表工作区与 AI Copilot 模块，并用极具克制的皇家靛紫作为唯一主动作引导色。

系统强调操作确定性与信息可扫描性。界面不依靠装饰性大面积渐变或浮夸卡片堆砌吸引视线，而是通过清晰的 1px 细线边界、微弱的顶部内高光（rim light）、等宽数字对齐与干脆的微交互反馈（150ms–240ms），让审校、排期、交接与 AI 推理依据在第一时间被看清和信任。

**Key Characteristics:**
- 五层清晰表面层级：画布底 → 半透明毛玻璃导航壳 → 主纸面卡片 → 抬升交互面 → 内嵌沉槽区。
- 单一品牌靛紫动作主轴，搭配高辨识度语义状态色（翠绿/琥珀/天蓝/朱红）。
- 双主题原生适配（`light-dark()` 与 `in oklab` 混色），顶部毛玻璃 Chrome 随滚动感知吸顶深度。
- 原生 AI Copilot 交互组件家族（Welcome、Prompts、Sender、Bubble、ThoughtChain），与工作台字体及圆角语言无缝一致。

## Colors

以冷调中性灰蓝承托高密度图文信息，由高纯度靛紫承担唯一主交互焦点，语义色严格限定在状态徽标、校验反馈与 KPI 圆点中。

### Primary
- **Royal Indigo Accent** (`indigo-accent`): 用于核心提交按钮（保存模型设置、开启分析、确认版本）、选中态轮廓、焦点环、链接与 AI 活跃信号。浅色模式使用沉稳深紫（`#5240d0`），深色模式提亮为柔和薰衣草紫（`#a99dfc`）并搭配深色实底填充（`#6556d4`）以保证按钮白字对比度。
- **Indigo Soft & Tint** (`indigo-soft`, `indigo-tint`): 用于导航选中态、筛选高亮胶囊、AI Prompt 选中芯片与列表选中底色，以低饱和淡紫铺垫视觉焦点。

### Neutral
- **Cool Studio Canvas** (`canvas-light` / `canvas-dark`): 主工作区背景画布，并带有极克制的顶部靛紫径向环境光，避免大面积纯白刺眼。
- **Layered Paper & Recessed Well** (`surface-paper`, `surface-subcard-light`, `surface-inset-light`, `surface-paper-dark`, `surface-raised-dark`): 构成卡片、二级面板与内嵌输入框/交接预览区的材质对比。
- **Ink Scale** (`ink-primary`, `ink-secondary`, `ink-muted`, `ink-quiet`): 从标题主墨色到次级说明与分组小标形成四级阅读灰度；语义成功绿（`#059669`）、危险红（`#d93025`）、提示琥珀（`#b45309`）与信息蓝（`#0369a1`）仅用于状态徽标、进度与即时反馈。
- **Hairline Dividers** (`line-default`, `line-soft`, `line-strong`): 定义容器边框与表格分隔线，确保浅/深色下都能保持清晰轮廓而不喧宾夺主。

### Named Rules
**The Restrained Accent Rule.** 每屏高饱和靛紫填充按钮通常仅保留 1–2 个主操作，其余次级动作使用中性纸面线框或透明文本按钮，让用户的视线自然落向当前唯一主决策点。

**The Top-Center Non-Blocking Feedback Rule.** 顶部浮层提示（Toast）在桌面端固定居中于顶部栏区域（`top: 14px; left: 50%`），绝不覆盖右侧页头功能按钮。

## Typography

**Display & UI Font:** `"Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, system-ui, sans-serif`
**Character:** 中英混排兼具几何精度与中文屏显可读性；所有数字指标、版本号、日期和计数徽标强制启用 `tnum` 等宽数字对齐，确保列表横向扫描不跳动。

### Hierarchy
- **Display** (`750` weight, `26px` desktop / `22px` narrow, `1.35` line-height, `-0.025em` tracking): 页面一级主标题（`.page-heading h1`）。
- **Headline** (`700` weight, `21px`, `1.35` line-height, `-0.02em` tracking): 登录弹窗与重要对话框标题。
- **Title** (`650` weight, `15.5px`, `1.35` line-height): 卡片区块标题与详情头部标题。
- **Body** (`400`–`450` weight, `14px`, `1.55` line-height): 正文内容、稿件文本预览与多行分析建议。
- **Label** (`600` weight, `12px`–`13.5px`, `1.4` line-height): 表单标签、导航项、胶囊徽标、ThoughtChain 节点标题与按钮标签。

### Named Rules
**The Tabular Numbers Rule.** 凡涉及数量统计、版本序号（`V1` / `V2`）、时间轴时间与发布排期，必须使用 `font-variant-numeric: tabular-nums`。

**The CJK Spacing Rule.** 界面文案中遇到中文与英文缩写、数字混排（例如「B 站专栏」「AI 随选分析」），统一在中英文之间保留一个半角空格。

## Layout

采用经典左导航右工作台的桌面分栏网格架构，确保多任务切换稳定且主内容区视野开阔：

- **应用外壳**：左侧固定 `240px` 粘性毛玻璃侧边栏（含品牌标识、工作室切换器、分组导航与个人入口），右侧自适应主列承载 `58px` 吸顶顶栏与 `max-width: 1560px` 内容区（`padding: 28px clamp(20px, 3vw, 40px) 50px`）。
- **主从双栏（Split Panel）**：选题台、原稿与审核、发布任务统一使用 `minmax(280px, 0.85fr) minmax(0, 1.55fr)` 分栏布局，`gap: 18px`。
- **容器与断点响应**：列表项与原稿编辑器内部采用 `@container` 容器查询自适应图文排版；全局视口在 `<= 1060px` 折叠为单列/紧凑导航，在 `<= 760px` 转为横向可滑导航条并让 Toast 占满两侧边距，在 `<= 440px` 压缩内边距至 `14px` 并单列化双列表单。

## Elevation & Depth

MatrixArk 采用**色调分层 + 柔和环境投影 + 1px 顶部内高光**的混合深度体系，所有表面边界都有 1px 细线锚定，不依赖厚重黑色阴影制造层级：

### Shadow Vocabulary
- **Subtle Control Lift** (`--shadow-sm`): `0 1px 2px` 低透明混合投影，用于普通按钮、工作区选项卡高亮与 KPI 胶囊。
- **Surface Card Resting** (`--shadow`): 复合双层投影外加顶部 `inset 0 1px 0 var(--rim-top)` 微高光，用于所有 `.card`、AI Copilot 面板与主要分区卡片。
- **Overlay / Dialog Float** (`--shadow-md`): 用于 `<dialog>` 登录与大图预览模态框、下拉弹出菜单与键盘 `skip-link`，在深浅主题下自动调整阴影浓度。
- **Top-Layer Chrome & Toast** (`backdrop-filter: blur(18px–20px) saturate(160%–170%)`): 用于侧边栏、吸顶 `.topbar` 与顶部居中 `.toast-card`，在保持通透感的同时隔离底层文字干扰。

### Named Rules
**The Surface Hierarchy Rule.** 外层画布最低，主卡片抬升，内部次级子块（如预览框、ThoughtChain、交接内容区）应回归沉槽背景（`--surface-inset` / `--surface-subcard`），避免卡片内部再套重阴影大卡片。

## Shapes

- **标准三阶圆角**：交互控件与二级子卡统一采用 `9px`（`--radius-sm`），主容器与卡片统一采用 `14px`（`--radius`），大模型引导欢迎面板可扩至 `18px`（`--radius-lg`），状态标签、KPI 徽标与快捷芯片采用全圆角（`999px`）或紧密 `11px` 药丸。
- **对称细线边界**：所有圆角容器必须四边完整闭合（`1px solid var(--line)`），不使用打破圆角贴合度的单侧粗竖条修饰。

## Components

### Buttons
- **Shape:** 小圆角矩形（`9px` 半径），最小点击高度 `40px`（紧凑版 `.compact` 为 `32px`）。
- **Primary:** 实色靛紫底（`#5240d0` / 深色 `#6556d4`）配纯白字（`#ffffff`），强制开启 `-webkit-font-smoothing: antialiased`，点击有 `0.985` 微缩放压感。
- **Hover / Focus:** 背景略微加深，焦点态显示双环外轮廓（`2px var(--paper) + 4px var(--accent)`）；复制等确认型按钮在成功后短暂变形为翠绿 `.is-confirmed` 状态。
- **Secondary / Text:** 白底带 `1px` 强边线框按钮用于次级操作；无框透明 `.text-button` 用于内联行级快捷触发。

### Chips
- **Style:** KPI 统计筛选胶囊使用 `11px` 圆角、渐变微纸面与左置 `6px` 语义色点；AI 快捷意图芯片（`.ai-prompt-chip`）与模型能力徽标使用 `999px` 全圆角。
- **State:** 选中态切换为靛紫淡底与高对比文字边框；在 Windows 强制高对比模式下切换为系统 `Highlight` 双像素内描边。

### Cards / Containers
- **Corner Style:** 主卡片 `14px` 圆角；AI 配置单选卡片与子区域 `9px`–`12px` 圆角。
- **Background:** `surface-raised` 到 `surface-paper` 的微弱竖向质感渐变。
- **Shadow Strategy:** 应用 Resting `--shadow` 与顶部微高光；嵌套预览区改用平铺沉槽底色。
- **Border & Padding:** `1px solid var(--line)` 边框；内边距遵循 `14px`–`20px` 节奏。

### Inputs / Fields
- **Style:** `40px` 最小高度、`9px` 圆角、纸面背景配强边框线；占位符统一使用 `--muted` 高可读灰调。
- **Focus & Validation:** 聚焦态高亮 `--accent` 边框并带 `3px` 淡紫扩散环；输入无效时（`:user-invalid`）自动呈现浅红提示底与 `#d93025` 边框。

### Navigation
- **Style:** 桌面端固定左栏 `240px`，按「内容创作 / 发布与成效 / 工作室管理」三组排列；导航项 `42px` 高度、`9px` 圆角，选中态铺设 `--accent-soft` 并点亮右侧圆点或数字计数徽标。移动端收敛为横向粘性导航带。

### AI Copilot & Workflow Primitives
- **AiWelcome & AiSender:** 未配置态用友好插画徽标与立即配置入口兜底；已配置态提供包含「本地离线 / 云端服务」胶囊标尺、Prompt 快捷芯片及 `Ctrl + Enter` 发送的多行 Copilot 输入栏。
- **AiBubble & AiThoughtChain:** 以头像徽标加结构化气泡呈现 AI 分析结果，内置历史提问切换与报告复制，并用竖向虚/实连接线串起「开头钩子 → 核心依据 → 后续验证动作」节点链。

## Do's and Don'ts

### Do:
- **Do** 在主流程按钮与重要表单中保持 `40px` 及以上交互热区，并在所有异步确认后提供清晰的状态回执或自动消退 Toast。
- **Do** 使用真实语义色点和 `tabular-nums` 传达状态与数量，让多账号列表一目了然。
- **Do** 在 AI 卡片与空态下始终给出明确的说明和下一步按钮（如「立即配置模型」「复制交接包」）。
- **Do** 在所有交互样式变更后同时验证浅色/深色主题、键盘焦点与 `prefers-reduced-motion` 行为。

### Don't:
- **Don't** 在标题上方添加无意义的装饰性全大写眉标（Kicker / Eyebrow）。
- **Don't** 在圆角容器上叠加单侧粗色条（如 `border-left: 3px`）或硬偏移实心投影。
- **Don't** 对主标题或正文字体使用渐变文字填充（`background-clip: text`），确保桌面端高辨识锐度。
- **Don't** 让全局提示弹窗固定在右上角阻挡 `PageHeader` 动作按钮。
- **Don't** 在卡片内部嵌套多层带重阴影的卡片，保持沉槽区（inset well）的平整克制。
