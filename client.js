/**
 * dsh-hdd-splash —— 浏览器端入口。
 *
 * 这里只负责三件事：装设置分区、决定「什么时候播、播几次」、播完/刷新后把徽记留在原处。
 * 真正的时间轴在 `lib/splash.js`（由宿主路由动态 import，免打包器）。
 *
 * ## id 必须与包名完全一致
 *
 * 客户端 bundle 由宿主拼成**普通 classic script**（不是 ESM）下发，脚本里唯一要做的事
 * 就是 `window.__ModuleLoader__.load({ id, factory })` 登记工厂。宿主按 `dsh.client`
 * 表里的行 id（= 包名）去认领这次登记：`id` 写错/缩写（比如少掉 `@local/` 前缀），
 * 那一行就永远等不到自己的工厂 —— 表现为 `web boot: N entry did not activate`，
 * 接着宿主会单独重放这个文件，于是又撞上 `duplicate factory registration` 二次报错。
 *
 * ## 顺序：设置分区先装，再考虑要不要播
 *
 * 设置分区是「每次都要在」的东西，不能被 sessionStorage 早退挡掉。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-hdd-splash",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const ROUTE = "/hdd-splash";
    /** 每次启动只播一次；刷新页面（sessionStorage 还在）不重播。 */
    const FLAG = "dsh-hdd-splash:played";
    /** 与 lib/prefs.js 里的 KEY.enabled 一致（这里不 import，classic script 只能动态 import）。 */
    const ENABLED_KEY = "dsh-hdd-splash:enabled";

    let started = false;

    /** 用户在设置里关掉了开屏动画？ */
    const splashEnabled = () => {
      try {
        return window.localStorage?.getItem(ENABLED_KEY) !== "0";
      } catch {
        return true;
      }
    };

    const boot = async () => {
      try {
        const mod = await import(`${ROUTE}/splash.js`);
        window.__hddSplash = await mod.play({ route: ROUTE });
      } catch (error) {
        console.warn("[dsh-hdd-splash] 开屏动画未能播放", error);
      }
    };

    /** 本会话已经播过（刷新页面）：不再放动画，但徽记要留在原位。 */
    const restore = async () => {
      try {
        const mod = await import(`${ROUTE}/splash.js`);
        await mod.mountHome({ route: ROUTE });
      } catch (error) {
        console.warn("[dsh-hdd-splash] 恢复徽记失败", error);
      }
    };

    /**
     * 自定义左下角头像 / 昵称：跟开屏动画无关，每次都要装。
     * 定位靠结构（见 lib/account.js），命中不了就在 12 秒后摘一份 DOM 回宿主当证据。
     */
    const wireAccount = async () => {
      try {
        const [prefs, account] = await Promise.all([
          import(`${ROUTE}/prefs.js`),
          import(`${ROUTE}/account.js`),
        ]);
        const handle = account.mountAccount({
          getPrefs: () => ({ avatar: prefs.getAvatar(), name: prefs.getName() }),
          subscribe: (listener) => prefs.onPrefsChange(listener),
        });
        window.setTimeout(() => {
          if (!handle.found()) {
            console.warn("[dsh-hdd-splash] 没找到左下角账号行，摘一份 DOM 回宿主");
            void dumpDom();
          }
        }, 12000);
      } catch (error) {
        console.warn("[dsh-hdd-splash] 账号行接管失败", error);
      }
    };

    /* ── 只在「没定位到账号行」时才用：把结构发回宿主（写进临时目录） ── */
    const dumpDom = async () => {
      try {
        const rectOf = (element) => {
          const box = element.getBoundingClientRect();
          return [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)];
        };
        const outline = (root, maxDepth) => {
          const out = [];
          const walk = (node, depth) => {
            for (const child of node.children) {
              if (out.length >= 500) return;
              const leaf = child.childElementCount === 0;
              const text = leaf ? String(child.textContent ?? "").trim().slice(0, 24) : "";
              out.push({
                d: depth,
                tag: child.tagName.toLowerCase(),
                cls: String(child.className ?? "").slice(0, 120),
                slot: child.getAttribute?.("data-slot") ?? undefined,
                rect: rectOf(child),
                ...(text ? { text } : {}),
              });
              if (depth < maxDepth) walk(child, depth + 1);
            }
          };
          walk(root, 1);
          return out;
        };
        const imgs = [...document.querySelectorAll("img")].map((img) => ({
          src: String(img.currentSrc || img.src || "").slice(0, 120),
          cls: String(img.className ?? "").slice(0, 80),
          rect: rectOf(img),
        }));
        const masked = [];
        for (const element of document.querySelectorAll("body *")) {
          if (element.children.length > 3) continue;
          const text = String(element.textContent ?? "").trim();
          if (text.length === 0 || text.length > 24) continue;
          if (!/^\*{2,}[\w-]{0,8}$/u.test(text)) continue;
          masked.push({ text, rect: rectOf(element) });
          if (masked.length >= 6) break;
        }
        const roots = [];
        for (const selector of ["aside", '[class*="settingsArea"]', '[class*="sidebar"]', "nav"]) {
          const element = document.querySelector(selector);
          if (element === null) continue;
          roots.push({ selector, rect: rectOf(element), outline: outline(element, 6) });
          if (roots.length >= 2) break;
        }
        await fetch(`${ROUTE}/dom-dump`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            href: location.href,
            viewport: [window.innerWidth, window.innerHeight],
            imgs,
            masked,
            roots,
          }),
        });
      } catch (error) {
        console.warn("[dsh-hdd-splash] DOM 摘录失败", error);
      }
    };

    exports.name = "dsh-hdd-splash";
    exports.isPlugin = true;
    exports.inject = [];
    exports.apply = (ctx) => {
      if (started) return;
      started = true;

      // ① 自定义头像 / 昵称：跟播不播无关，每次都要装。
      void wireAccount();

      // ② 设置分区：不管播不播都要有。
      let React = null;
      try {
        React = require("react");
      } catch (error) {
        console.warn("[dsh-hdd-splash] require('react') 失败", error);
      }
      import(`${ROUTE}/settings.js`)
        .then((mod) => mod.installSettingsSection(ctx, { React, route: ROUTE }))
        .catch((error) => console.warn("[dsh-hdd-splash] 设置分区装上失败", error));

      // ③ 开屏动画：每次启动一次，刷新不重播。
      let played = false;
      try {
        played = sessionStorage.getItem(FLAG) === "1";
        // 先设标记再播：宁可漏播，也不要因为异常变成「每次刷新都重播」。
        sessionStorage.setItem(FLAG, "1");
      } catch {
        return;
      }

      if (played) restore();
      else if (splashEnabled()) boot();
      else restore();
    };

    return module.exports;
  },
});
