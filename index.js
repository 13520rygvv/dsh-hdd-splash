/**
 * dsh-hdd-splash —— 宿主侧。
 *
 * 只做一件事：把包内 `lib/` 静态端出去（前缀 `SPLASH_ROUTE`），让浏览器端能动态
 * import `splash.js`、取 `boot.mp4` / `glow.webp` —— 客户端那一半因此不需要打包器，
 * 源码保持原样。
 *
 * ## 为什么必须 `ctx.inject(["webServer"], …)`
 *
 * 宿主行的挂载**早于** webserver 就绪：那时 `ctx.get("webServer")` 拿到的是 undefined，
 * 直接用它 + 早退就等于**静默不注册任何路由**（页面全 404，错误哪里都不出现）。
 * `ctx.inject` 会等服务出现再回调。
 *
 * ## Range
 *
 * `boot.mp4` 是 8.8MB 的真文件，Chromium 会先发 `Range: bytes=0-` 再按需取片段。
 * 桌面端把请求经 IPC 转发（`dsh-app://app` → 内部 http），`content-length` 会被转发层
 * 摘掉，能说明长度的只剩 `Content-Range` —— 所以这里必须老老实实实现 206。
 */
import { spawn } from "node:child_process";
import { createReadStream, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 与 cordis.patch.yml 的 loader 行对应。 */
export const name = "dsh-hdd-splash";

/** 路由前缀（客户端 client.js 里写死同一个值）。 */
export const SPLASH_ROUTE = "/hdd-splash";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "lib");

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  // 故意不放 .html：`lib/` 里的 _preview.html / _diag.html 是开发期校对页，
  // 不该从产品路由上端出去。
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

/* ────────────────────────── 启动即最大化窗口 ────────────────────────── */

/**
 * DSH 的 `createWindow` 写死 `1280x820`，主进程里既没有 maximize 也没有窗口尺寸持久化，
 * 而 `DESKTOP_IPC` 也不提供任何「请把窗口最大化」的通道 —— 插件侧没有任何 API 能够到窗口。
 * 所以这里退一步：宿主一挂载就拉起 `lib/maximize.ps1`，让它盯着目标进程的主窗口，
 * 一出现就 `ShowWindow(SW_MAXIMIZE)`。窗口这时通常还没 `show()`，
 * 就算已经露出来也只是同一帧里的重排，看不到「先小后大」的跳变。
 */
const MAXIMIZE_SCRIPT = resolve(HERE, "lib", "maximize.ps1");
/** 与安装目录里的可执行文件名一致（`DeepSeek Harness.exe`）。 */
const MAXIMIZE_TARGET = "DeepSeek Harness";

function maximizeOnStart() {
  if (process.platform !== "win32") return;
  try {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        MAXIMIZE_SCRIPT,
        "-ProcessName",
        MAXIMIZE_TARGET,
        "-Seconds",
        "30",
      ],
      // 不用 detached：那个模式在本机会话里实测子进程根本起不来（stdio 又是 ignore，
      // 失败了也看不见）。脚本 1.2 秒就跑完，绑在宿主生命周期上没有任何坏处。
      // windowsHide + ignore 保证不闪黑框。
      { stdio: "ignore", windowsHide: true },
    );
    child.on("error", (error) => console.warn("[dsh-hdd-splash] 最大化窗口失败", error));
    child.unref();
  } catch (error) {
    console.warn("[dsh-hdd-splash] 最大化窗口失败", error);
  }
}

/* ────────────────────────── 开发期：把侧栏 DOM 摘下来 ────────────────────────── */

/**
 * 客户端 POST 一份 `{masked, sidebarOuter, …}` 到这里，落到临时目录。
 * 只用于开发期看清楚「左下角那一行」是哪个插件、哪个类名渲染的（类名带构建哈希，
 * 从 asar 里猜不准）。拿到结构后这段可以删掉。
 */
const DUMP_FILE = join(tmpdir(), "dsh-hdd-splash-dom-dump.json");

function acceptDump(req, res) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      writeFileSync(DUMP_FILE, Buffer.concat(chunks));
      console.log(`[dsh-hdd-splash] DOM 摘录已写入 ${DUMP_FILE}`);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
    } catch (error) {
      console.warn("[dsh-hdd-splash] 写 DOM 摘录失败", error);
      res.writeHead(500);
      res.end("failed");
    }
  });
}

/** 解析 `bytes=` 单区间；返回 [start, end] 或 undefined（交给 416）。 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  let start;
  let end;
  if (rawStart === "") {
    // bytes=-N：末尾 N 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return undefined;
  return [start, end];
}

function serve(req, res, full, type) {
  let info;
  try {
    info = statSync(full);
  } catch {
    notFound(res);
    return;
  }
  if (!info.isFile()) {
    notFound(res);
    return;
  }
  const size = info.size;
  const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
  if (range !== undefined) {
    const window = parseRange(range, size);
    if (window === undefined) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    const [start, end] = window;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    const stream = createReadStream(full, { start, end });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": String(size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  const stream = createReadStream(full);
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/**
 * 注册 `/hdd-splash/**` → 包内 `lib/**` 的只读静态路由。
 * @returns disposer；没有 webServer 时返回 undefined（不抛，插件照常挂载）。
 */
export function registerSplashRoute(ctx, prefix) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) {
    console.warn("[dsh-hdd-splash] 注册路由时 webServer 仍不可用（应当在 ctx.inject 里调用）");
    return undefined;
  }

  return webServer.register({
    kind: "prefix",
    path: prefix,
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel;
      try {
        rel = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/^\/+/u, "");
      } catch {
        notFound(res);
        return;
      }
      if (rel === "") {
        notFound(res);
        return;
      }
      if (rel === "dom-dump") {
        if (req.method !== "POST") {
          notFound(res);
          return;
        }
        acceptDump(req, res);
        return;
      }
      // 路径穿越防护：解析后必须仍在 ROOT 之内。
      const full = resolve(ROOT, rel);
      if (!full.startsWith(ROOT + sep)) {
        notFound(res);
        return;
      }
      const type = TYPES[extname(full).toLowerCase()];
      if (type === undefined) {
        notFound(res);
        return;
      }
      serve(req, res, full, type);
    },
  });
}

export function apply(ctx) {
  // 这行日志是有意的：DSH 的插件挂载失败往往静默，「到底挂上没挂上」是第一问。
  console.log("[dsh-hdd-splash] host 半侧已挂载");

  maximizeOnStart();

  ctx.inject(["webServer"], (scoped) => {
    scoped.effect(
      () => registerSplashRoute(scoped, SPLASH_ROUTE) ?? (() => {}),
      "dsh-hdd-splash: splash route",
    );
  });
}
