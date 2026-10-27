/* ============================================================================
 * dsh-hdd-splash / splash.js
 *
 * 开屏时间轴。整段由一条 requestAnimationFrame 时钟驱动：所有透明度/位移都由
 * 当前时间 t 算出，不依赖 setTimeout 链——卡一帧只是慢一帧，不会错位。
 *
 * 素材（都由宿主路由 /hdd-splash/** 提供）：
 *   assets/boot.mp4    14.53s HDD 开机动画（12.5s 淡出、13.0s 起纯黑）
 *   assets/glow.webp   用户那张蓝色光晕图（模糊、边缘深，适合当幕布）
 *   assets/fairy.svg   FAIRY 徽记矢量（原皮肤同款）
 *
 * 时间轴（单位 ms，t=0 是视频真正开播那一刻）：
 *   0                          视频铺满，原声播放
 *   12300 → 13150              光晕图渐入（顶在徽记后面）
 *   12500 → 13600              徽记渐入 + 0.94→1 轻微放大
 *   12600 → 13400              视频渐隐（盖在光晕上，最后 1.5s 是它自己的黑帧）
 *   13600 → 15900              徽记居中停住（呼吸/眼环/故障闪照常跑）
 *   15900 → 17100              徽记缩小并移到常驻位（默认左下角，用户可拖动）
 *   16700 → 17900              光晕图 + 黑底渐隐 → 露出真实的 harness 界面
 *   17900                     覆盖层移除；徽记以同尺寸就地重建成常驻位（可拖，位置记住）
 * ========================================================================== */

import {
  clearSavedHome,
  getPrefs,
  getSavedHome,
  onPrefsChange,
  saveHome,
  SIZE_MAX,
  SIZE_MIN,
} from "./prefs.js";

const ROUTE_DEFAULT = "/hdd-splash";

const T = {
  // 光晕要「先」铺满，视频「后」退场：层层叠一起时总遮盖率才不至于在交接处塌下去
  // （塌下去 = 背后真实的 harness 界面会透出来一下）。
  glowIn: [12300, 13150],
  filmOut: [12600, 13400],
  fairyIn: [12500, 13600],
  shrink: [15900, 17100],
  glowOut: [16700, 17900],
  done: 17900,
};

const BANDS = 20;
const SHIFTS = [
  "0", "-12", "6", "-7", "14", "-4", "9", "-14", "3", "-9",
  "11", "-6", "5", "-11", "8", "-3", "13", "-8", "4", "-15",
];

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
/** t 在 [a,b] 区间内的进度，已过缓动、已夹到 0..1。 */
const ramp = (t, [a, b], fn = easeInOutCubic) => fn(clamp((t - a) / (b - a), 0, 1));

const now = () => performance.now();

/** 造一枚徽记。返回的 host 需要自己定宽高（stage 占满 100%）。 */
function buildMascot(svgText, rail) {
  const host = document.createElement("div");
  host.className = "hdd-mascot-host";

  const mascot = document.createElement("div");
  mascot.setAttribute("data-hdd-mascot", "");
  mascot.setAttribute("data-rail", rail ? "true" : "false");

  const stage = document.createElement("div");
  stage.setAttribute("data-hdd-mascot-stage", "");

  const bloom = document.createElement("span");
  bloom.setAttribute("data-hdd-mascot-bloom", "");

  const mark = document.createElement("div");
  mark.setAttribute("data-hdd-mascot-mark", "");
  // 眼环 / 四角方块 / 高光的 CSS 动画全靠这个祖先属性选中。
  mark.setAttribute("data-hdd-mark-scope", "");

  for (let index = 0; index < BANDS; index += 1) {
    const band = document.createElement("div");
    band.setAttribute("data-hdd-mascot-band", "");
    // 20 条横带拼回完整徽记；剪裁高度按 1/20 均分。
    band.style.clipPath = `inset(${(index * 100) / BANDS}% 0 ${((BANDS - 1 - index) * 100) / BANDS}% 0)`;
    // 单位必须是 px：translateX(14) 是无效值，整条 transform 会被丢弃。
    band.style.setProperty("--hdd-shift", `${SHIFTS[index % SHIFTS.length]}px`);
    band.innerHTML = svgText;
    mark.append(band);
  }

  stage.append(bloom, mark);
  mascot.append(stage);
  host.append(mascot);
  return host;
}

/** 等一个事件，超时就放弃（返回 false）。 */
function waitFor(target, event, timeoutMs) {
  return new Promise((resolve) => {
    let timer = 0;
    const done = (ok) => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      resolve(ok);
    };
    const onEvent = () => done(true);
    target.addEventListener(event, onEvent, { once: true });
    timer = setTimeout(() => done(false), timeoutMs);
  });
}

function ensureStylesheet(href) {
  const existing = document.querySelector(`link[data-hdd-splash-css]`);
  if (existing !== null) return Promise.resolve();
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute("data-hdd-splash-css", "");
  document.head.append(link);
  return waitFor(link, "load", 3000);
}

/** 常驻徽记的尺寸：设置里给了就听它的（px），否则按窗口自动算。 */
function homeSizeFor(width, height) {
  const { size } = getPrefs();
  if (size > 0) return Math.round(clamp(size, SIZE_MIN, SIZE_MAX));
  return Math.round(clamp(Math.min(width, height) * 0.095, 52, 104));
}

/** 默认落点：左下角，但要给侧栏最底下那行（头像 + 用户名）留出 52px。 */
function defaultHome(width, height) {
  const homeSize = homeSizeFor(width, height);
  return {
    homeSize,
    hx: Math.round(homeSize * 0.55),
    hy: height - 52 - Math.round(homeSize * 0.5),
  };
}

/** 常驻位几何：有存过的位置就用它（夹回视口内），否则用默认左下角。 */
function homeGeometry(width, height) {
  const base = defaultHome(width, height);
  const saved = getSavedHome();
  if (saved === null) return base;
  const half = base.homeSize / 2;
  return {
    homeSize: base.homeSize,
    hx: Math.round(clamp(saved.x, half, Math.max(half, width - half))),
    hy: Math.round(clamp(saved.y, half, Math.max(half, height - half))),
  };
}

/**
 * 让常驻徽记可以拖着走（位置记进 localStorage，下次还在这儿）。
 * 双击回到默认左下角。
 */
function enableDrag(host, homeSize) {
  const stage = host.querySelector("[data-hdd-mascot-stage]");
  if (stage === null) return;
  const half = homeSize / 2;

  const moveTo = (x, y) => {
    const maxX = Math.max(half, window.innerWidth - half);
    const maxY = Math.max(half, window.innerHeight - half);
    host.style.left = `${clamp(x, half, maxX) - half}px`;
    host.style.top = `${clamp(y, half, maxY) - half}px`;
  };

  const centerOf = () => {
    const rect = host.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };

  let drag = null;

  const onDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const center = centerOf();
    drag = { id: event.pointerId, dx: event.clientX - center.x, dy: event.clientY - center.y };
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* 某些环境不支持捕获，靠 window 上的监听兜底 */
    }
    // 拖动时别让浏览器把它当成选中文本 / 原生拖拽。
    event.preventDefault();
  };

  const onMove = (event) => {
    if (drag === null || event.pointerId !== drag.id) return;
    moveTo(event.clientX - drag.dx, event.clientY - drag.dy);
    event.preventDefault();
  };

  const onUp = (event) => {
    if (drag === null || event.pointerId !== drag.id) return;
    drag = null;
    const center = centerOf();
    saveHome(center.x, center.y);
    try {
      if (stage.hasPointerCapture(event.pointerId)) {
        stage.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* 忽略 */
    }
  };

  const onDouble = (event) => {
    event.preventDefault();
    clearSavedHome();
    const base = defaultHome(window.innerWidth, window.innerHeight);
    moveTo(base.hx, base.hy);
  };

  // 视口变小了就把徽记夹回来（不写存，只是别让它跑出屏幕）。
  const onResize = () => {
    if (!host.isConnected) {
      window.removeEventListener("resize", onResize);
      return;
    }
    const center = centerOf();
    moveTo(center.x, center.y);
  };

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("dblclick", onDouble);
  window.addEventListener("resize", onResize);
}

/** 把徽记落成常驻位（先清掉旧的，可反复调用）。 */
function placeHome(svgText, homeSize, hx, hy) {
  mountedSvg = svgText;
  for (const old of document.querySelectorAll(".hdd-splash__home")) old.remove();
  const host = document.createElement("div");
  host.className = "hdd-splash__home";
  host.style.width = `${homeSize}px`;
  host.style.height = `${homeSize}px`;
  host.style.left = `${hx - homeSize / 2}px`;
  host.style.top = `${hy - homeSize / 2}px`;
  host.title = "拖我换个位置（双击回到左下角）";
  host.append(buildMascot(svgText, true));
  document.body.append(host);
  enableDrag(host, homeSize);
  watchPrefs();
  return host;
}

/** 最近一次落位用的 SVG（设置里改尺寸时要照它重画）。 */
let mountedSvg = "";
let prefsWatcher = null;

/**
 * 设置面板改了参数就地生效：尺寸变了按新尺寸重画（中心点不动，位置不丢）；
 * 音量变了正在播的片子跟着变。位置自己保存的那次 notify 不算（size 没变就跳过）。
 */
function watchPrefs() {
  if (prefsWatcher !== null) return;
  let last = getPrefs();
  prefsWatcher = onPrefsChange(() => {
    const next = getPrefs();
    if (next.volume !== last.volume) {
      const film = document.querySelector(".hdd-splash__film");
      if (film !== null) film.volume = next.volume;
    }
    if (next.size !== last.size) {
      const host = document.querySelector(".hdd-splash__home");
      if (host !== null && mountedSvg !== "") {
        const rect = host.getBoundingClientRect();
        const { homeSize } = defaultHome(window.innerWidth, window.innerHeight);
        placeHome(mountedSvg, homeSize, rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    }
    last = next;
  });
}

/**
 * 把徽记挪回默认左下角（设置面板里的「回到默认位置」用），并清掉存的位置。
 */
export function resetHomePosition() {
  clearSavedHome();
  if (mountedSvg === "") return null;
  const { homeSize, hx, hy } = defaultHome(window.innerWidth, window.innerHeight);
  return placeHome(mountedSvg, homeSize, hx, hy);
}

async function loadSvg(route) {
  const [, svgText] = await Promise.all([
    ensureStylesheet(`${route}/splash.css`),
    fetch(`${route}/assets/fairy.svg`)
      .then((response) => (response.ok ? response.text() : ""))
      .catch(() => ""),
  ]);
  return svgText;
}

/**
 * 只挂左下角常驻徽记、不放动画。给「本会话已经播过了（刷新页面）」的情况用，
 * 这样刷新后徽记不会突然不见。
 */
export async function mountHome(options = {}) {
  const route = options.route ?? ROUTE_DEFAULT;
  if (document.body === null) {
    await waitFor(document, "DOMContentLoaded", 5000);
  }
  const svgText = await loadSvg(route);
  const { homeSize, hx, hy } = homeGeometry(window.innerWidth, window.innerHeight);
  placeHome(svgText, homeSize, hx, hy);
}

/**
 * 播放开屏动画。
 * @param {object} [options]
 * @param {string} [options.route]    静态路由前缀，默认 "/hdd-splash"
 * @param {number} [options.freeze]   调试用：只渲染 t（秒）这一帧，不播不拆
 * @param {boolean} [options.film]    调试用：false 时不播视频（校对渐隐用）
 * @param {{x:number,y:number,size:number}} [options.home] 常驻位中心点（不给就用存过的/默认左下角）
 * @returns {Promise<{skip:()=>void,replay:()=>Promise<unknown>,elements:object}>}
 */
export async function play(options = {}) {
  const route = options.route ?? ROUTE_DEFAULT;
  const freeze = typeof options.freeze === "number" ? options.freeze : undefined;
  const useFilm = options.film !== false;

  if (freeze === undefined && !options.force) {
    // 尊重系统的「减少动态效果」：整段跳过，别硬塞。
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) {
      return { skip: () => {}, replay: async () => {}, elements: {} };
    }
  }

  if (document.body === null) {
    await waitFor(document, "DOMContentLoaded", 5000);
  }

  const svgText = await loadSvg(route);

  const root = document.createElement("div");
  root.className = "hdd-splash";

  // ---- 纯黑底：视频第一帧还没解码出来时挡住真实界面（否则开屏头 100ms 会闪一下 UI）----
  const bed = document.createElement("div");
  bed.className = "hdd-splash__bed";
  root.append(bed);

  // ---- 光晕图：顶在徽记后面 ----
  const glow = document.createElement("img");
  glow.className = "hdd-splash__glow";
  glow.alt = "";
  glow.decoding = "async";
  glow.src = `${route}/assets/glow.webp`;

  // ---- 视频：铺满整屏 ----
  let film = null;
  let startedAt = 0;
  if (useFilm) {
    film = document.createElement("video");
    film.className = "hdd-splash__film";
    film.src = `${route}/assets/boot.mp4`;
    film.preload = "auto";
    film.playsInline = true;
    film.autoplay = false;
    film.controls = false;
    film.disablePictureInPicture = true;
    // Electron 默认 no-user-gesture-required：带声音也能自动播（真被拒就静音重试）。
    film.volume = getPrefs().volume;
    film.muted = false;
    root.append(film);
  }

  // ---- 徽记 ----
  const fairy = document.createElement("div");
  fairy.className = "hdd-splash__fairy";
  fairy.append(buildMascot(svgText, false));
  fairy.style.opacity = "0";

  root.append(glow, fairy);
  document.body.append(root);

  // ---- 几何 ----
  const geometry = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const centerSize = Math.round(clamp(Math.min(width, height) * 0.62, 320, 660));
    // 常驻位：默认左下角，用户拖过就用拖到的位置（拾掇时别忘了它还要给头像留位置）。
    const base = homeGeometry(width, height);
    const home = options.home ?? {};
    return {
      width,
      height,
      centerSize,
      cx: width / 2,
      cy: height / 2,
      homeSize: home.size ?? base.homeSize,
      hx: home.x ?? base.hx,
      hy: home.y ?? base.hy,
    };
  };

  let geometryNow = geometry();  const centerFairy = () => {
    geometryNow = geometry();
    const { cx, cy, centerSize } = geometryNow;
    fairy.style.width = `${centerSize}px`;
    fairy.style.height = `${centerSize}px`;
    fairy.style.left = `${cx - centerSize / 2}px`;
    fairy.style.top = `${cy - centerSize / 2}px`;
  };
  centerFairy();
  const onResize = () => centerFairy();
  window.addEventListener("resize", onResize);

  // ---- 逐帧绘制：只依赖 t ----
  const paint = (t) => {
    const { centerSize, cx, cy, homeSize, hx, hy } = geometryNow;
    const reveal = ramp(t, T.fairyIn);
    const shrink = ramp(t, T.shrink);
    const ratio = homeSize / centerSize;

    const scale = (0.94 + 0.06 * reveal) * (1 - shrink * (1 - ratio));
    const dx = (hx - cx) * shrink;
    const dy = (hy - cy) * shrink;

    fairy.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`;
    fairy.style.opacity = `${reveal}`;

    glow.style.opacity = `${ramp(t, T.glowIn) * (1 - ramp(t, T.glowOut))}`;
    // 黑底跟着光晕一起退——它只负责开播前的头一阵，不能到最后才「啪」地消失。
    bed.style.opacity = `${1 - ramp(t, T.glowOut)}`;
    if (film !== null) {
      film.style.opacity = `${1 - ramp(t, T.filmOut)}`;
    }
  };

  // ---- 调度 ----
  let frame = 0;
  let done = false;
  let home = null;
  const elements = { root, bed, film, glow, fairy };
  /** 拆除覆盖层，并在同一帧把徽记搬到左下角（几何完全接得上，不会闪）。 */
  const settle = () => {
    const { homeSize, hx, hy } = geometryNow;
    home = placeHome(svgText, homeSize, hx, hy);
  };

  // ---- 拆除 ----
  const dropListeners = () => {
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKey);
    root.removeEventListener("pointerdown", onPointer);
  };

  const dropOverlay = () => {
    cancelAnimationFrame(frame);
    root.remove();
    if (film !== null) {
      film.pause();
      film.removeAttribute("src");
      film.load();
    }
  };

  const finish = () => {
    if (done) return;
    done = true;
    settle();
    dropListeners();
    dropOverlay();
  };

  /** 手动跳过：整层先淡掉，再在左下角落成常驻徽记。 */
  const skip = () => {
    if (done) return;
    done = true;
    dropListeners();
    cancelAnimationFrame(frame);
    root.style.transition = "opacity 180ms linear";
    root.style.opacity = "0";
    setTimeout(() => {
      dropOverlay();
      settle();
    }, 200);
  };

  const tick = () => {
    const t = now() - startedAt;
    paint(t);
    if (t >= T.done) {
      finish();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  // 视频就绪（或 4s 超时）再开播，避免黑屏干等；实在起不来就静音重试一次。
  const begin = async () => {
    if (film !== null) {
      if (film.readyState < 2) await waitFor(film, "loadeddata", 4000);
      try {
        await film.play();
      } catch {
        film.muted = true;
        try {
          await film.play();
        } catch {
          /* 真播不了就只走徽记那半段 */
        }
      }
    }
    startedAt = now();
    tick();
  };

  // 点击/按键 = 跳过（先让它完整出现 2s，避免误触）。
  const onPointer = () => {
    if (now() - startedAt > 2000) skip();
  };
  const onKey = (event) => {
    if (event.key === "Escape") skip();
  };
  root.addEventListener("pointerdown", onPointer);
  window.addEventListener("keydown", onKey);

  // ---- 冻结模式：只画 t（秒）这一帧，留给截图校对；不播视频、不排时钟 ----
  if (freeze !== undefined) {
    if (film !== null) film.style.display = "none";
    paint(freeze * 1000);
    dropListeners();
    return {
      skip: dropOverlay,
      replay: async () => play(options),
      elements,
      paint,
    };
  }

  // 播放期间也订阅设置：设置面板里拖音量（比如点了「播一次看看」）能当场听到变化。
  watchPrefs();

  void begin();

  return {
    skip,
    replay: async () => {
      home?.remove();
      home = null;
      done = false;
      return play(options);
    },
    elements,
    get finished() {
      return done;
    },
  };
}

/**
 * 再放一次（设置面板里「播一次看看」用）。
 * 已经在播就直接返回：绝不叠第二层覆盖。
 */
export async function replay(options = {}) {
  if (document.querySelector(".hdd-splash") !== null) return null;
  return play({ ...options, force: true });
}
