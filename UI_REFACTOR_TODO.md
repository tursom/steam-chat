# Web UI Refactor Todo List

> 目标：整理当前网页显示界面的重构项，先建立一份可执行的前端重构清单，后续按优先级逐步落地。

## 当前进度

### 已完成（第一轮）
- [x] 将 `public/style.css` 拆分为多份区域样式文件，并由入口样式统一导入
- [x] 移除 `public/index.html` 中的内联 `style`
- [x] 将富内容消息的主要静态样式从 JS 迁移到 CSS class
- [x] 新增统一连接状态组件，分离“连接状态”和“操作反馈”
- [x] 统一最近会话 / 好友 / 群组列表容器样式
- [x] 群组点击行为改为直接进入会话并拉取历史
- [x] 移动端恢复显式发送按钮
- [x] 历史消息改为批量渲染，减少重复滚动
- [x] 为 tab / lightbox / focus-visible 补充一轮基础可访问性支持

### 已完成（第二轮）
- [x] 从 `public/app.js` 中继续拆出图片管理模块
- [x] 从 `public/app.js` 中拆出 lightbox 模块
- [x] 从 `public/app.js` 中拆出消息渲染模块
- [x] 从 `public/app.js` 中拆出侧栏渲染模块
- [x] 进一步压缩入口文件体积，降低主文件耦合度

### 已完成（第三轮）
- [x] 从 `public/app.js` 中拆出 composer 模块
- [x] 将附件上传、上传队列、URL 图片发送逻辑并入 composer 模块
- [x] 将表情建议、贴纸/表情选择器逻辑并入 composer 模块
- [x] 继续压缩入口文件体积，主入口聚焦在页面装配与 WebSocket 流程

### 已完成（第四轮）
- [x] 从 `public/app.js` 中拆出会话状态模块
- [x] 从 `public/app.js` 中拆出 WebSocket 协调模块
- [x] 进一步压缩主入口，仅保留页面装配与少量全局行为

### 已完成（第五轮）
- [x] 从 `public/app.js` 中拆出通知模块
- [x] 从 `public/app.js` 中拆出响应式布局/侧栏控制模块
- [x] 从 `public/app.js` 中拆出本地偏好读取与保存模块
- [x] 补齐贴纸 URL 辅助方法到前端工具模块，统一消息渲染依赖来源
- [x] 修复拆分过程中主入口残留引用，恢复语法与测试通过状态

### 已完成（第六轮）
- [x] 从 `public/app.js` 中拆出 DOM 引用收集模块
- [x] 从 `public/app.js` 中拆出页面装配 / 事件绑定模块
- [x] 从主入口中抽出 ws 配置拉取与连接启动逻辑
- [x] 继续压缩主入口，进一步聚焦控制器组装

### 已完成（第七轮）
- [x] 从 `messages.js` 中拆出消息气泡渲染模块
- [x] 将文本消息 / 图片消息 / 贴纸消息的气泡渲染统一收口
- [x] 让 `messages.js` 聚焦消息列表编排、分隔线与滚动策略

### 本轮后新的文件结构
- `public/styles/base.css`
- `public/styles/sidebar.css`
- `public/styles/messages.css`
- `public/styles/composer.css`
- `public/styles/overlays.css`
- `public/styles/responsive.css`
- `public/app/utils.js`
- `public/app/status.js`
- `public/app/rich-content.js`
- `public/app/managed-images.js`
- `public/app/lightbox.js`
- `public/app/messages.js`
- `public/app/sidebar.js`
- `public/app/composer.js`
- `public/app/session.js`
- `public/app/websocket.js`
- `public/app/notifications.js`
- `public/app/layout.js`
- `public/app/preferences.js`
- `public/app/dom.js`
- `public/app/bootstrap.js`
- `public/app/message-bubble.js`

## 一、重构目标

- 提升页面结构清晰度，降低 `public/app.js` 与 `public/style.css` 的维护成本
- 统一桌面端/移动端交互表现
- 提升消息区、侧栏、发送区的一致性
- 改善可访问性、状态展示和渲染性能

---

## 二、P0：优先处理

### 1. 拆分前端代码职责
- [ ] 将 `public/app.js` 继续按功能拆分为独立模块
  - [x] `sidebar`
  - [x] `messages`
  - [x] `message-bubble`
  - [x] `composer`
  - [~] `picker`
  - [x] `lightbox`
  - [x] `connection-status`
  - [x] `notifications`
  - [x] `layout`
  - [x] `preferences`
  - [x] `dom`
  - [x] `bootstrap`
  - [x] `utils`
  - [x] `rich-content`
- [x] 将 `public/style.css` 按页面区域拆分
  - [x] layout
  - [x] sidebar
  - [x] chat
  - [x] composer
  - [x] overlay / modal
- [~] 建立统一命名规范，避免样式和脚本继续堆在单文件里
  - [x] 已建立一批统一类名
  - [ ] 仍需继续收敛 `app.js` 中剩余页面装配逻辑

**现状问题**
- `public/app.js` 已降至约 395 行，主入口已明显收缩
- `public/style.css` 已降为入口文件
- 目前主要剩余耦合点集中在跨模块回调编排、消息气泡细分与部分交互细节

---

### 2. 清理内联样式，改为 class 驱动
- [x] 移除 `public/index.html` 中的内联 `style`
- [~] 移除 `public/app.js` 中直接写入视觉样式的逻辑
  - [x] 已清理消息卡片、建议项、OG 卡片等静态视觉样式
  - [ ] 保留少量运行时样式控制：高度、自适应、transform、进度条宽度
- [x] 为常见 UI 块补充语义化 class
- [~] 保证 JS 只控制状态，不直接控制具体视觉细节

**重点位置**
- [x] `public/index.html:42-72`
- [~] `public/app.js` 中图片、卡片、建议项、消息项里的 `.style.*`

---

### 3. 重构移动端发送区
- [x] 保留移动端显式发送按钮，不再完全依赖 Enter 发送
- [x] 统一附件按钮 / 表情按钮 / 发送按钮布局
- [x] 优化输入框高度、换行、滚动行为
- [~] 重新梳理 URL 面板、附件预览、上传队列在移动端的展示顺序
  - [x] 已完成基础顺序整理
  - [ ] 仍可继续压缩移动端纵向占用

**现状问题**
- [x] 移动端 `#sendMessage` 被隐藏
- [x] 发送行为与桌面端不完全一致
- [ ] 发送区承载内容仍偏多，仍有进一步整理空间

---

### 4. 统一连接状态展示
- [x] 合并顶部 `WebSocket` chip 与侧栏 `status` 的职责
- [x] 建立统一的连接状态组件
- [x] 明确区分：
  - [x] 已连接
  - [x] 重连中
  - [x] 异常
  - [x] 请求失败
- [x] 避免用户同时看到多个状态入口

---

## 三、P1：中优先级

### 5. 抽象统一的侧栏列表组件
- [x] 为最近会话、好友、群组三类列表建立统一列表容器
- [x] 提取统一 item 样式和 hover / active 规则
- [x] 提取统一 empty state
- [x] 保证三个 tab 的滚动、间距、边界表现一致

**现状问题**
- [x] `#conversationList` 有专门样式
- [x] `friendsList` / `groupsList` 缺少同级统一列表容器规则

---

### 6. 优化消息渲染逻辑
- [x] 将消息列表渲染改为批量插入，减少反复重排
- [x] 历史消息加载时只在完成后滚动一次
- [x] 拆出消息气泡渲染器
  - [x] 文本消息
  - [x] 图片消息
  - [x] 贴纸消息
  - [~] 富文本/链接卡片
- [x] 为时间分隔线、日期分隔线建立统一渲染入口

**现状问题**
- [x] `renderHistory()` 中逐条追加
- [x] `appendEntry()` 每次都触发滚动到底部

---

### 7. 统一富内容消息的样式出口
- [x] 将表情图、内联图片、Open Graph 卡片从 JS 内联样式改为 CSS class
- [x] 为卡片消息建立独立样式类
- [~] 避免消息渲染函数中出现大量 DOM 样式拼接
  - [x] 已将主要富内容展示迁移到 `rich-content.js`
  - [ ] 后续仍可继续拆分消息渲染器

**重点位置**
- [x] `appendEmoticonImage()`
- [x] `appendInlineImage()`
- [x] `appendOpenGraphCard()`
- [x] `renderSuggestionList()`

---

### 8. 统一群组 / 好友 / 会话点击行为
- [x] 明确三类列表项点击后的统一行为模型
- [x] 群组点击后应与好友/会话保持一致，避免只填入输入框
- [ ] 补充“进入会话 / 仅选中 / 自动拉取历史”规则说明

**现状问题**
- [x] 最近会话、好友：点击后直接进入
- [x] 群组：点击后仅写入 `targetId`

---

## 四、P2：体验与规范提升

### 9. 补齐可访问性
- [x] 为 tab 增加完整语义
  - [x] `role="tablist"`
  - [x] `role="tab"`
  - [x] `aria-selected`
- [x] 为图片预览弹层增加 dialog 语义与焦点管理
- [x] 增加 `:focus-visible` 样式
- [~] 优化键盘操作路径
  - [x] tab 切换
  - [x] lightbox 关闭
  - [ ] 建议项导航

---

### 10. 统一视觉 token
- [ ] 抽取颜色、间距、圆角、阴影为统一变量
- [ ] 减少样式文件中重复出现的硬编码颜色
- [ ] 为桌面端/移动端建立更清晰的变量层级

---

### 11. 清理无效或遗留样式
- [ ] 检查未使用类名和重复规则
- [ ] 清理历史遗留命名
- [ ] 合并重复媒体查询样式

**已观察到的潜在项**
- `send-row`
- `image-row`

---

## 五、建议的执行顺序

### 第一阶段：结构整理
- [x] 拆分 JS / CSS 文件
- [x] 去掉内联样式
- [~] 建立统一 class 命名

### 第二阶段：交互统一
- [x] 重构移动端发送区
- [x] 统一连接状态
- [x] 统一侧栏三类列表行为

### 第三阶段：渲染优化
- [~] 重构消息渲染
- [x] 提取富内容消息组件
- [x] 优化批量渲染和滚动策略

### 第四阶段：规范与体验
- [~] 补齐可访问性
- [ ] 抽取视觉 token
- [ ] 清理冗余样式

---

## 六、验收标准

- [x] 页面结构拆分后，单文件长度显著下降
- [x] HTML 与 JS 中不再存在大段视觉内联样式
- [x] 移动端发送区可稳定发送消息和图片
- [x] 三类侧栏列表行为一致
- [x] 消息历史加载更顺畅
- [~] 主要交互支持键盘和焦点可见性

---

## 七、涉及文件

- `public/index.html`
- `public/style.css`
- `public/app.js`
- `public/styles/*.css`
- `public/app/*.js`

---

## 八、下一轮建议优先做的事

### 高优先级
- [ ] 将 `public/app.js` 继续拆成：
  - [x] `sidebar.js`
  - [x] `messages.js`
  - [x] `composer.js`
  - [~] `picker.js`（当前已并入 `composer.js`，后续可视情况独立）
  - [x] `lightbox.js`
- [x] 将会话状态与 WebSocket 通信从主入口中拆分
- [x] 将通知、布局控制、偏好存储从主入口中拆分
- [x] 将 DOM 收集、页面装配与连接启动从主入口中拆分
- [x] 把消息气泡渲染进一步组件化
- [ ] 清理剩余运行时样式控制中的可静态部分

### 中优先级
- [ ] 为建议项面板补充完整键盘导航与 aria
- [ ] 评估是否将 `picker` 从 `composer.js` 中独立成单文件
- [x] 评估并将页面装配逻辑进一步独立
- [ ] 继续细化富文本/链接卡片渲染边界
- [ ] 抽取统一视觉 token（颜色、间距、阴影、圆角）
- [ ] 清理未使用类名和重复媒体查询
