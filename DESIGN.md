---
name: Mstar · 模型工作台
description: 熟悉、克制的多模型工作台与管理员界面
colors:
  blue: "#365dcd"
  blue-dark: "#264bae"
  blue-soft: "#eaf0ff"
  ink: "#252b37"
  muted: "#5f6b7e"
  focus-ring: "#8193b0"
  focus-border: "#a8b9d6"
  line: "#e8ebef"
  white: "#fff"
  sidebar: "#f3f4f6"
  drawer: "#fbfcfe"
  error-background: "#fff1f0"
  error-text: "#a33c3f"
  success-text: "#287047"
  success-background: "#edf7f0"
  secret-background: "#eef1f6"
typography:
  title:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 550
  body:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.95
  control:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 500
  label:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "11px"
    fontWeight: 500
  code:
    fontFamily: 'Consolas, "Cascadia Code", monospace'
    fontSize: "12px"
    lineHeight: 1.75
  brand:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "19px"
    fontWeight: 600
  login-title:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "27px"
    fontWeight: 550
    lineHeight: 1.4
  page-title:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "22px"
    fontWeight: 550
  page-title-compact:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "20px"
    fontWeight: 550
  editor-title:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "16px"
    fontWeight: 550
  empty-title:
    fontFamily: '"Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
    fontWeight: 500
rounded:
  small: "4px"
  field: "7px"
  control: "8px"
  media: "10px"
  panel: "12px"
  composer: "16px"
spacing:
  compact: "4px"
  small: "8px"
  medium: "12px"
  large: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.white}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
  button-primary-hover:
    backgroundColor: "{colors.blue-dark}"
  button-outline:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
  button-icon:
    textColor: "#717b8b"
    rounded: "{rounded.field}"
    width: "30px"
    height: "30px"
  field:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "10px 11px"
  task-row:
    rounded: "{rounded.control}"
  task-row-active:
    backgroundColor: "#e4e9f2"
    textColor: "#254779"
  model-option:
    rounded: "{rounded.control}"
    padding: "10px 11px"
  model-option-selected:
    backgroundColor: "{colors.blue-soft}"
  composer:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.composer}"
    padding: "16px 16px 10px"
  file-card:
    backgroundColor: "#f3f5f8"
    textColor: "#586b8c"
    rounded: "{rounded.control}"
    padding: "12px"
  attachment-chip:
    backgroundColor: "#f0f3f8"
    rounded: "{rounded.field}"
    padding: "4px 5px 4px 8px"
  model-source-tab:
    textColor: "{colors.muted}"
    padding: "10px 2px"
  model-source-tab-selected:
    textColor: "{colors.blue}"
  admin-editor:
    backgroundColor: "{colors.drawer}"
    rounded: "{rounded.panel}"
    padding: "24px"
  admin-row:
    rounded: "{rounded.field}"
    padding: "17px 14px"
  admin-notice:
    backgroundColor: "{colors.success-background}"
    textColor: "{colors.success-text}"
    rounded: "{rounded.field}"
    padding: "12px 14px"
---

# Design System: Mstar · 模型工作台

## Overview

**Creative North Star: "熟悉的本地工作台"**

界面采用用户明确选择的 ChatGPT/Codex 工作方式。白色工作区域、冷灰辅助表面、少量蓝色操作强调，让模型、内容和真实状态承担视觉重心。它是可长时间使用的工具界面，信息紧凑，层次主要来自字体、间距和表面明度。

功能通过同页展开、收起和局部滚动逐步出现。按钮、输入框、列表和成果容器使用轻圆角与细边框；图标采用线性 SVG。名称、来源、错误和运行状态保留在操作附近，避免靠装饰表达意义。

登录页和独立管理员后台延续同一套冷灰表面、工作蓝与紧凑中文控件；登录表单保留集中阅读区，后台通过列表与编辑器形成操作层级。它们扩展现有工作台，不改变原三栏和成果流的视觉约束。「本地」描述默认启动方式，界面也适用于管理员集中部署。

**Key Characteristics:**

- 冷中性色表面与少量蓝色操作强调。
- 中文无衬线界面字和独立的等宽代码字。
- 紧凑列表、宽松成果正文、按需展开的配置。
- 默认平面分区，少量功能性阴影。
- 键盘可见焦点与移动端抽屉焦点管理。

## Colors

调色以白色和冷灰建立工作区域，用蓝色表达可操作、选中和焦点状态。

### Primary

- **工作蓝**（`blue`）：主要操作、文本链接与选中勾选框。
- **焦点蓝灰**（`focus-ring` / `focus-border`）：键盘操作的柔和描边与文本输入的边框反馈。
- **深工作蓝**（`blue-dark`）：主要按钮和文字操作的悬停反馈。
- **浅工作蓝**（`blue-soft`）：小型图标按钮选中态及连接入口底色。

### Neutral

- **石墨文字**（`ink`）：正文与主要控制文字。
- **蓝灰说明**（`muted`）：说明、辅助信息、空状态文字；源码中的 `faint` 是同值别名，不另建色阶。
- **冷灰分隔线**（`line`）：栏位、章节和消息内容的细分隔。
- **纯白工作面**（`white`）：中央工作区、输入和浮层。
- **任务灰**（`sidebar`）：任务导航背景。
- **连接白灰**（`drawer`）：模型连接抽屉背景。
- **错误浅红 / 错误暗红**（`error-background` / `error-text`）：错误提示背景及其文字、图标。红色不参与普通导航和强调。
- **成功深绿 / 成功浅绿**（`success-text` / `success-background`）：后台已上架状态、成功通知与新密钥生成确认；搭配明确的状态文字或勾选图标，不用于普通导航。
- **密钥冷灰**（`secret-background`）：仅本次显示的分发密钥代码区域，帮助识别和选择完整内容。

### Named Rules

**The Action Blue Rule.** 蓝色用于操作、选择和焦点；普通内容保持石墨色，辅助信息保持蓝灰色。

## Typography

**Display Font:** 没有独立展示字体；空状态标题沿用界面无衬线字族。
**Body Font:** 优先 Noto Sans SC，随后使用系统中文与界面无衬线后备字体，完整字族见 frontmatter。
**Label/Mono Font:** 标签沿用界面字族；代码优先 Consolas、Cascadia Code、monospace。

**Character:** 字形熟悉、直接，以字号和中等字重区分操作层级。中文正文使用较宽行距，密集模型行和工具栏保持紧凑；不采用装饰性的展示字体或全大写标签。

### Hierarchy

- **Title**：工作区与抽屉标题使用 `title`。品牌名称单独使用略大且更重的文字。
- **Body**：成果正文使用 `body`，最大行宽（75ch）；手机正文缩至（12px）。输入正文同为（13px），行高（1.8）。
- **Control**：主要和描边按钮使用 `control`。
- **Label**：字段名、模型名和章节说明以 `label` 为主要密度参考；来源、计数和脚注使用更小的辅助字。
- **Code**：块代码使用 `code`，内容可横向滚动；行内代码按正文比例缩小并使用浅灰底。
- **Content headings**：消息中的 Markdown 标题为内容层级，不作为应用导航标题的默认字号。
- **Login and admin headings**：登录和后台品牌使用 `brand`，登录主标题使用 `login-title`，后台页面标题使用 `page-title`，在（660px）及以下使用 `page-title-compact`；编辑器标题与后台空状态标题分别使用 `editor-title`、`empty-title`。这些角色只适用于对应新增界面，不改变工作台紧凑标题。
- **Login and admin controls**：模型来源页签为（13px），选中时字重（600）；后台导航为（13px），当前项字重（550），手机缩为（12px）。后台列表主文字为（13px / 550），次行能力、状态和字段说明主要为（11px），次行行高（1.7–1.8）。登录说明为（13px / 1.8），通知和后台测试结果为（12px / 1.8–1.9），沿用已有字号密度。

### Named Rules

**The Reading Room Rule.** 把较大的行距留给成果正文；保持控制区紧凑，不把导航密度复制到长文本。

## Layout

界面是视口高度内的应用壳，主区域使用弹性布局，正文可独立滚动，输入区域留在底部。具体三栏组成与初次打开行为属于 [.impeccable/surface-brief.md](.impeccable/surface-brief.md)，不作为任意新界面的全局模板。

默认桌面左右栏宽分别为（244px）与（318px），中央为可缩放列。桌面窄档（901–1250px）缩至（218px / 286px），大屏（1600px 起）扩至（264px / 340px）。消息区域最大宽度（1040px），输入区域最大宽度（856px），分别保留内边距。模型回答靠左，最大宽度（856px），右侧预留至少（56px）；用户消息靠右，最大占内容宽度（75%），以更明显的左右错位区分双方。常见控件间隙与容器留白使用 frontmatter 中的重复间距值，局部布局可使用源码已有的中间步长。

在（900px）及以下，两个侧栏转为覆盖抽屉，主区域始终占满视口。左栏宽（270px），右栏宽（min(360px, 92vw)）。背景覆盖层、对话框语义、背景 inert、Tab 循环、Escape 关闭及关闭后焦点返回构成完整移动抽屉行为。切入紧凑断点会关闭侧栏。

手机档（520px）收紧头部与正文边距；输入工具栏允许换行。模型回答右侧预留在（900px）及以下缩至（32px），手机档缩至（20px）；手机用户消息最大占内容宽度（85%），兼顾左右区分与阅读空间。在（600px）及以下，顺序执行的细节字段从两列改为单列，步骤列表使用受限高度内的滚动。长名称省略，正文允许断行，媒体不超出容器。

登录页使用全视口高的白灰底，品牌靠左上，表单宽度不超过（380px），顶部留白随视口高度变化。后台主体最大宽度（1280px），桌面内边距（36px）；打开编辑器时左侧列表固定（264px），右侧详情使用剩余空间，间隔（28px），以细分隔线区分两列。列表在桌面滚动时保持可见；关联字段并排放置。到（900px）时列表缩至（218px）并压缩外围留白。到（660px）及以下改为列表在上、详情在下的单列，列表限制高度（220px）并内部滚动，字段恢复单列。密钥用量默认显示近期汇总；更多筛选、逐次明细和统计说明按需展开。密钥查看、复制和重新生成位于授权页，模型自定义测试输入默认折叠，测试按钮与费用提示始终可见。这组登录及后台布局只用于对应界面。

## Elevation & Depth

默认通过浅色表面、细边框和留白分层。输入框有很轻的持续阴影，聚焦时改变边框与阴影；菜单、帮助和设置浮层使用更明显的柔和阴影。移动抽屉用半透明冷灰遮罩区分前后。完整阴影和动效值保存在 sidecar，应用源码仍是实现依据；sidecar 的 OKLCH 色条是生成的浏览样本，不是应用已启用的额外色阶。

### Named Rules

**The Useful Lift Rule.** 阴影只服务于输入焦点、浮层和返回底部等功能层级；普通列表和成果不加装饰性投影。

侧栏和抽屉使用短促平移，空状态只做一次轻微入场；旋转和呼吸状态仅用于真实加载、运行。`prefers-reduced-motion` 会关闭动画和过渡。

## Shapes

使用轻圆角矩形与细边框。小型标记、输入、按钮、媒体、面板到输入区域形成逐渐变大的圆角关系，具体重复值见 `rounded`。列表选中区域没有厚重外框。图标是线性 SVG，不以文字字符模拟。

用户消息采用右对齐的柔和气泡，并在一个角缩小圆角；模型成果直接排在白色内容流中。圆形仅用于微型运行点和返回底部按钮等有明确用途的元素。

## Components

### Buttons

主要按钮是紧凑的蓝色圆角实心操作，描边按钮为白底细灰框，文字按钮使用工作蓝。主要与描边按钮共用尺寸、内边距和字重；悬停改变底色，禁用时降低可用性提示。小型图标按钮有明确 `aria-label` 与 title；图标尺寸按上下文变化。

按钮、链接、折叠入口和复选框在键盘操作时显示蓝灰描边（2px），外偏移（2px）；鼠标点击不显示额外外框。文本输入通过自身边框、搜索框通过浅灰底色、消息输入通过容器的 focus-within 状态表达焦点。禁用控制不可借悬停表现成可用状态。

### Chips

待发送附件采用浅灰圆角小条，文件名省略，提供小型移除按钮；已有缩略图时显示缩略图。它是附件状态，不是装饰标签或页面分类导航。

### Cards / Containers

文件采用浅灰文件卡，图标、名称、体积与下载入口并列。图片、音视频和代码容器按内容类型显示，保留原生播放控制、复制或下载操作。成果容器不添加营销性标题、假封面或无来源媒体。

### Inputs / Fields

表单字段为白底、细蓝灰边框、轻圆角；文字输入、选择器和多行输入共享样式。文本输入聚焦时使用柔和的边框反馈，避免叠加外框；禁用文本输入改为浅灰底。密码显隐操作放在输入右侧。说明贴近字段，错误采用带文字和图标的错误提示。

所有下拉入口共用 `src/Select.tsx`：轻量按钮、线性箭头、白底圆角顶层列表，浅灰悬停与浅蓝选中底色，并用勾选图标表示当前值。长名称在触发框中省略、在展开列表中完整换行；列表根据剩余空间向上或向下展开，并在首次完成定位后显示。点击外部、再次点击触发框、Escape 或 Tab 收起；方向键、Home、End、Enter、空格及文字前缀定位保留键盘操作。列表位于原有 DOM 层级以兼容手机抽屉的焦点管理。

### Navigation

左下角「Mstar 工作空间」右侧使用 12px 问号图标，桌面按钮为 18px，触摸设备保留 26px 触摸区域。使用说明在悬停或键盘聚焦时打开，以图标为锚点向上展开顶层浮层；鼠标移入说明区域时保持显示，离开图标及说明后短暂延迟收起。Escape 优先关闭说明，手机支持触摸打开和点外关闭。浮层宽度不超过 380px，并限制在视口内，不沿用工作区右上角的任务设置定位。

任务列表以整行浅灰悬停和更深冷灰选中背景表达状态，标题溢出省略。更多操作在桌面悬停或键盘焦点进入行时可见，手机保持可见。模型连接点击后打开独立限高下拉浮层，列表内部滚动，保持右侧抽屉的布局高度不变；已选模型同时使用浅蓝行底和蓝色勾选框，不能仅靠颜色辨别选择。

模型来源使用底线页签，默认「Mstar」，次要入口为「我的模型」。页签用蓝色文字、加粗和底线共同标示选中态，并保留页签与内容面板的语义关联；Mstar 模型直接展示名称及下一行能力，名称允许断行，模型行至少（62px）高，文本上下间隔（5px）。已选择状态使用浅蓝底与勾选/加入图标，保持两行内容稳定，不挤成一行。后台导航沿用蓝色底线与当前页状态。

Mstar 与「我的模型」共用模型目录头部样式：标题和数量为（11px），标题字重（600），左右内缩（4px），标题与搜索框间距（10px）。搜索框统一最小高度（38px）、内边距（8px 10px）、圆角（8px）、输入字号（11px）及下方间距（8px），焦点沿用共同灰底反馈。两页签的头部、数量和搜索框使用相同布局尺寸，切换时不改变位置；标题文案及搜索提示按各自来源保留。

「我的模型」的连接使用统一列表行，行间细分隔线，行高至少（64px）；初字头像为（34px）浅蓝底，名称独占首行，为（13px / 550）。次行以（11px）展示模型总数及真实已选数量，两项间隔（10px），已选数量用蓝色文字表达，不额外加底色；主次行间隔（4px）。列表不展示密钥尾号，密钥信息只在管理连接中查看。右侧依次为展开箭头和管理入口。悬停及键盘焦点使用浅灰，展开使用浅蓝，不以绿点暗示未验证的连通状态。

个人连接的模型浮层与整行连接对齐，最小宽度（260px），在视口内限制最大（300px）高度；标题与数量固定，模型在内部滚动。模型名称为（12px / 500），最多两行并保留悬停完整 ID；能力以只读小标签排列，选择框位于行尾。选中同时使用浅蓝行底、蓝色勾选及连接上的数量反馈。Escape 优先关闭模型浮层并把焦点还给连接按钮，手机抽屉继续保持打开。

任务操作浮层从三个点右侧展开，使用浏览器顶层浮层避免侧栏裁切；靠近视口边缘时调整位置以保持完整可见。点击浮层外、再次点击三个点或按 Escape 收起，浮层内编辑保持展开；任务列表滚动或窗口尺寸变化时关闭浮层。

### Composer and Inline Workflow

输入容器有柔和圆角、细边框和轻阴影；正文上方可显示附件，下方工具栏包含附件入口、调用方式、按需出现的目标模型以及发送/停止，不提供能力分类选项。发送与停止使用同一位置，显示实际执行状态。服务端按任务、附件及已启用能力匹配实际调用。

输入限制确认以普通助手消息呈现在对话内，不弹模态框。先说明模型支持范围、将忽略的输入和确认后的行为，再以独立段落建议多个模型协作。消息下方沿用主按钮与描边按钮，明确显示「是，仅用…开始」「否，暂不开始」，按钮间距（10px）、与消息间距（16px），窄屏自动换行。提交期间禁用两项，失败可重试；已处理、取消和超时显示对应文字状态。等待时页头与输入提示显示等待确认，不声称模型已经开始生成。管理员输入限制 JSON 位于模型详情中默认折叠的可选设置，原能力配置保留。

主输入区不提供通用 JSON 参数按钮或编辑框，普通调用由内部默认值与服务适配器处理，减少用户对接口字段的理解负担。必要的任务和步骤设置仍按需展开。

顺序执行只在对应模式下显示输入框上方的「顺序步骤」入口。点击后在入口上方打开独立顶层浮窗，桌面最大宽度（640px），手机按输入区域宽度适配；圆角与柔和投影表达悬浮层级，不参与页面文档流，也不改变对话区高度。浮窗靠底部锚定，增加步骤或展开详情时向上增长，超出可用高度后内部滚动。点击外部、关闭按钮、再次点击入口或按 Escape 收起；嵌套下拉框优先处理自己的关闭操作。步骤使用编号、模型、排序和删除操作，不提供能力选择；详细指令与输入来源进一步折叠，不提供 JSON 接口参数编辑框，所有编辑与产出保留在同页。

### Login and Admin

登录使用单列表单、密码显隐和一项主要提交操作。用户密钥、管理员密码及首次初始化共享字段风格，通过标题、说明和入口区分任务；错误在表单内显示。

后台列表把名称和能力/密钥摘要上下排列，状态文字在右；编辑器使用白灰底、细边框和面板圆角，不附加阴影。保存草稿、逐项能力测试和上架各有独立操作及真实可用状态；高级接入设置默认折叠。测试附件通过中文「选择测试附件」描边按钮触发隐藏的文件输入，并在下方显示已选文件名。成功通知用语义绿底、文字和勾选图标共同反馈；生成的密钥以可选择、可断行的代码块呈现，并提供复制按钮。

## Do's and Don'ts

### Do:

- **Do** 使用冷中性色构建层次，以蓝色表达操作、选中和焦点。
- **Do** 为成果正文保留宽松行距，为列表和控制保持紧凑节奏。
- **Do** 让设置与高级参数按需展开，保留清晰的标题、关闭入口和焦点路径。
- **Do** 让名称、来源、文件和错误直接反映真实内容与运行状态。
- **Do** 在移动覆盖抽屉中保留语义、背景隔离、键盘焦点循环和焦点返回。

### Don't:

- **Don't** 添加用户未要求的页面、营销区域或装饰性视觉改造。
- **Don't** 用大面积蓝色或强阴影取代已有的细边框与明度层次。
- **Don't** 用虚构模型、示例成果或测试媒体填充正式空状态。
- **Don't** 把来源脚注的小字号扩散为正文或主要操作的默认字号。
- **Don't** 用文本字形代替 SVG 图标，或让动画承载唯一的运行状态信息。
