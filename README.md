# dsh-hdd-splash

给 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面端做的**开屏动画**，外加一颗会跟着动画落进侧栏、之后可以随便拖的 FAIRY 徽记。

- 启动时先播一段 14.5s 的伪开机动画（原片自带声音）
- 动画末尾是黑屏 → 蓝色光晕从黑屏里**渐入**，FAIRY 徽记在正中央淡入、呼吸、脉冲
- 几秒后徽记**缩到左下角**，光晕淡掉、露出界面，徽记原地留下
- 徽记**可以拖动**，双击回左下角，位置会记住
- 顺手接管了侧栏左下角的**头像和昵称**（选图 / 改名字，只覆盖显示，不动账号）
- 每次启动顺手把窗口**最大化**

每个会话只播一次：刷新页面（Ctrl+R）不会重播，重启应用才会。

## 来源与致谢（重要）

**先说清楚：这个仓库不是我从零做的。** 我是在别人已经做好的成品上改了个自己用着顺手的版本，并且把代码部分整理成了 DSH 插件。开屏影片、蓝色光晕底图、FAIRY 徽记这些素材都**不是我画的、也不是我拍的**。

- **直接来源**：B 站 UP 主 **[_天才小宇](https://space.bilibili.com/3494360513514129)** 的教程《[把DSH改造成fairy的教程来了](https://www.bilibili.com/video/BV1n7np6QEPe/)》。
  开屏动画素材、fairy 徽记素材都来自他（他视频说明里给了网盘）；我这套的时序、徽记「切成 20 条横带再错位抖动」的做法，也是照着他成品的效果来的。
- **他视频说明里标注的上游来源**，一并向原作者致谢：
  - 开屏动画原作：《[我把绝区零HDD开屏动画做进了Windows开机！](https://www.bilibili.com/video/BV1f7tC6oEm7/)》
  - 灵感来源：《[可能是全网最还原的Fairy（动画）](https://www.bilibili.com/video/BV1SD4C63EZz/)》
- **再往上**：HDD 开机动画和 FAIRY 这两个东西本身出自米哈游《绝区零》(Zenless Zone Zero)，相关形象与影片的权利归米哈游及上述原作者。

我做的部分只有这些：把影片裁掉黑边重新转成 1080p、写成 DSH 客户端插件（宿主静态路由 + 时间轴 + 设置面板 + 侧栏头像/昵称覆盖层 + 启动最大化），以及把上面这些揉成一个能装的包。

## 安装

### 方式一：DSH 插件市场（推荐）

打开 DSH 的「插件市场」→ 安装/添加插件 → 规格填：

```
13520rygvv/dsh-hdd-splash
```

（带 `github:` 前缀写成 `github:13520rygvv/dsh-hdd-splash` 也认。）

装完**重启 DSH**。DSH 会在 pnpm 装完之后自动把这个包补进 `dsh.profile.bundles`。

### 方式二：下载 zip，双击安装脚本

去 [Releases](https://github.com/13520rygvv/dsh-hdd-splash/releases) 下载最新的 `dsh-hdd-splash-*.zip`，解压后双击 `install.cmd`。

脚本只做三件事，全部可见可回滚：

1. 把插件文件复制到 `%USERPROFILE%\.dsh\local-plugins\dsh-hdd-splash`
2. 在 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\@local\` 下建一个目录联接（junction）
3. 往该 profile 的 `package.json` 里登记依赖和 `dsh.profile.bundles`（先备份成 `package.json.bak-hdd-splash-<时间戳>`，写完自检，失败自动还原）

不需要 node / pnpm，只用系统自带的 PowerShell。想装到别的 profile 就 `install.cmd -Profile <名字>`。
卸载双击 `uninstall.cmd`（会一字不差地还原 `package.json`；加 `-RemoveFiles` 才删文件）。

## 设置

重启后：**设置 → 开屏动画** / **设置 → 左下角头像**

| 项 | 说明 |
| --- | --- |
| 开 / 关 | 关掉只是下次启动不播动画，左下角那颗徽记照旧 |
| 音量 | 0–100%，播放中拖动也当场生效 |
| 徽记大小 | 32–200px，「自动」= 窗口短边的 9.5%（下限 52、上限 104） |
| 徽记位置 | 显示当前坐标，可一键回默认位置 |
| 播一次看看 | 立刻重播一遍，不用重启 |
| 恢复默认 | 参数全部复位 |

头像那一栏：**选图片…** 会把你选的图压成 128×128 的 WebP 存在本机 localStorage（不上传任何地方）；昵称输入框留空 = 显示账号原本的昵称（没有昵称时显示服务端给的脱敏手机号 / 邮箱）。点「还原」就退回原生显示。

> 头像和昵称是**盖在原生那一行上面的一层**，账号本身不会变；那一行仍然能点开账号菜单。

## 不想要窗口最大化

最大化是在宿主侧 `apply()` 里起一个 `lib/maximize.ps1`（调 `ShowWindow(SW_MAXIMIZE)`），不改快捷方式、不动 asar。不想要就把 `index.js` 里 `apply()` 开头那句 `maximizeOnStart();` 注释掉。

## 跳过动画

动画播过 2 秒之后：点一下屏幕、或按 `Esc`，立刻跳过。

## 换成自己的素材

- 影片：替换 `lib/assets/boot.mp4`（16:9 左右都行，`object-fit: cover` 会自己裁）。原片前 6.5s 自带的上下黑边已经裁掉了，换片时注意别把黑边带回来。
- 光晕底图：替换 `lib/assets/glow.webp`。
- 徽记：替换 `lib/assets/fairy.svg`（viewBox 保持 `-1 -1 162 162` 最省事）。
- 时间轴：`lib/splash.js` 顶部的 `T` 常量（毫秒）：`glowIn` / `filmOut` / `fairyIn` / `shrink` / `glowOut` / `done`。

改 `lib/**` 用 Ctrl+R 就能看到效果；只有改 `client.js` 或 `package.json` 才需要重启。

## 已知限制

- 只测过 Windows 桌面端（窗口最大化那段是 Win32 API，别的平台不会生效，也不影响开屏动画）。
- 头像覆盖层用结构化定位找侧栏那一行（原生 DOM 的类名带构建哈希），DSH 大改侧栏结构时可能失效 —— 失效就退回原生显示，不会把界面搞坏。
- 影片音轨是原片的，第一次启动如果觉得吵，把「音量」调小或直接关掉动画。

## License

**代码部分** MIT，见 [LICENSE](LICENSE)。

**这个 MIT 只覆盖我写的那部分代码，不覆盖素材。** `lib/assets/` 下的影片（`boot.mp4`）、光晕底图（`glow.webp`）、徽记（`fairy.svg`）都是上面「来源与致谢」里那几位原作者的素材，版权不在我这儿，我只是按他们公开分享的方式拿来给自己和朋友用（详见 [NOTICE](NOTICE)）。想要商业使用或者再分发素材，请去找原作者要授权。

如果原作者（或米哈游）觉得这个仓库放着不合适，跟我说一声、或者直接开 issue，我会马上把它转私有 / 删掉。
