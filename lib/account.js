/**
 * dsh-hdd-splash / account.js
 *
 * 把侧边栏左下角那一行「头像 + 名字」换成自定义的。
 *
 * 为什么要这么绕：这一行是内置插件 `@deepseek-ai/dsh-client-ui-settings-account`
 * 画的，它的类名是构建时算出来的哈希（`wtg9ga_…` 这种），从 asar 里猜不出选择器；
 * 它也没有任何本地覆盖开关（可配置项只有 contactFormUrl / contactSource / platformOrigin），
 * 名字和头像直接来自账号快照——所以我们只能在自己这一侧「盖一层」。
 *
 * 做法分两路：
 *
 * 首选（稳）：内置账号行有**语义钩子**，不用猜类名——
 *   `span[data-avatar-status]` 是头像槽（里面是 <img> 或一个 16px 的兜底图标），
 *   外面那层是 `button[aria-haspopup="menu"]`（菜单锚点），
 *   名字是它旁边那个 `span`（侧栏收起时不渲染）。
 *   头像槽的 rect 就是那颗圆，名字就在它右边。
 *
 * 兜底（换版本后钩子没了）：纯结构化定位——在侧栏里找「接近正圆、直径 14–48px、可见」的
 *   <img>，取最靠下的那个 = 头像；往上爬「宽度 ≥ 头像 2.2 倍、高度 ≤ 头像 3.5 倍」的祖先 = 行；
 *   在行里找「紧挨头像右边、垂直居中、最深的一段纯文本」= 名字。
 *
 * 两路最后都走同一套「盖一层」：行设 position:relative，塞绝对定位的 <img>/<span> 盖住原位置，
 * 原元素用 visibility:hidden 藏起来（不是 display:none，布局不能动，也不能吃掉点击）。
 */

const STYLE_ID = "hdd-account-style";
const AVATAR_CLASS = "hdd-account-avatar";
const LABEL_CLASS = "hdd-account-label";
const ROW_FLAG = "hddAccount";
const MAX_AVATAR_PX = 48;
const MIN_AVATAR_PX = 14;

let installed = false;
let overlays = { avatar: null, label: null };
let hidden = { avatar: null, label: null };
let target = { row: null, avatar: null, label: null };
let settleTimer = 0;
let reportAt = 0;

/**
 * 只在「有自定义值」时往宿主回一份极简回执：谁被盖住了、盖在哪个位置。
 * 排查「设置了没变化」时，看这份回执就知道是没定位到、还是定位到了却没生效。
 */
function report(prefs) {
  if (!target.row || !(prefs.avatar || prefs.name)) return;
  const now = Date.now();
  if (now - reportAt < 5000) return;
  reportAt = now;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  };
  const body = JSON.stringify({
    ok: true,
    avatar: Boolean(prefs.avatar),
    name: prefs.name || "",
    row: box(target.row),
    badge: box(target.avatar),
    badgeTag: target.avatar?.tagName ?? null,
    label: box(target.label),
    overlay: [box(overlays.avatar), box(overlays.label)],
    patched: [overlays.avatar !== null, overlays.label !== null],
    // 定位失败时最想看的东西：侧栏里到底有几个菜单锚点、它们长什么样。
    triggers: menuTriggers()
      .slice(0, 4)
      .map((el) => ({
        rect: box(el),
        cls: el.className,
        kids: Array.from(el.children)
          .slice(0, 4)
          .map((kid) => ({ tag: kid.tagName, cls: kid.className, text: (kid.textContent ?? "").trim().slice(0, 24), rect: box(kid) })),
      })),
  });
  fetch("/hdd-splash/dom-dump", { method: "POST", body }).catch(() => {});
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${AVATAR_CLASS}{position:absolute;display:block;border-radius:50%;object-fit:cover;pointer-events:none;z-index:3;}
.${LABEL_CLASS}{position:absolute;display:block;pointer-events:none;z-index:3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
`;
  document.head.append(style);
}

function visible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
}

/** 侧栏里所有「接近正圆的小图」。 */
function roundAvatars() {
  const found = [];
  for (const img of document.querySelectorAll("img")) {
    // 自己盖上去的那张也是 24px 正圆，不排掉的话会被当成「头像」，然后一层套一层。
    if (img.classList.contains(AVATAR_CLASS)) continue;
    const rect = img.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height);
    if (size < MIN_AVATAR_PX || size > MAX_AVATAR_PX) continue;
    if (Math.abs(rect.width - rect.height) > 3) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    // 被我们藏起来的那个要认回来，否则「清空头像」时定位不到目标、就还原不回去。
    if (img !== hidden.avatar && !visible(img)) continue;
    found.push(img);
  }
  return found;
}

/** 头像往上爬，找这一行的容器。 */
function rowOf(avatar) {
  const rect = avatar.getBoundingClientRect();
  let node = avatar.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    const box = node.getBoundingClientRect();
    if (box.width >= rect.width * 2.2 && box.height <= rect.height * 3.5 && box.height > rect.height) {
      return node;
    }
  }
  return null;
}

/**
 * 这一行里「头像右边那段文字」的元素。
 *
 * 不能要求「叶子节点」：内置那一层 `span._5Qcc8a_label` 里面可能还有包裹元素，
 * 也可能整段文字就是它自己；所以这里对行内所有元素打分——
 * 位置对（在头像右边、垂直居中）、尺寸合理、文本长度合理，**面积越小越像**，
 * 类名里带 label 的再加一分。返回最像的那个。
 */
function labelOf(row, avatar) {
  const rect = avatar.getBoundingClientRect();
  const centerY = rect.top + rect.height / 2;
  let best = null;
  let bestScore = -1;
  for (const el of row.querySelectorAll("*")) {
    if (el === avatar || el.contains(avatar)) continue;
    if (el.classList.contains(AVATAR_CLASS) || el.classList.contains(LABEL_CLASS)) continue;
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 32) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 6 || box.height <= 6) continue;
    if (box.left < rect.right - 4) continue;
    if (Math.abs(box.top + box.height / 2 - centerY) > rect.height * 0.75) continue;
    let score = 1e6 - box.width * box.height;
    if (/label/i.test(String(el.className))) score += 5e5;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function relRect(el, row) {
  const box = el.getBoundingClientRect();
  const base = row.getBoundingClientRect();
  return { left: box.left - base.left, top: box.top - base.top, width: box.width, height: box.height };
}

function hide(el) {
  if (!el) return;
  el.style.setProperty("visibility", "hidden", "important");
}

function show(el) {
  if (!el) return;
  el.style.removeProperty("visibility");
}

function makeOverlay(row, kind) {
  let node = row.querySelector(`:scope > .${kind === "avatar" ? AVATAR_CLASS : LABEL_CLASS}`);
  if (node) return node;
  node = document.createElement(kind === "avatar" ? "img" : "span");
  node.className = kind === "avatar" ? AVATAR_CLASS : LABEL_CLASS;
  node.setAttribute("aria-hidden", "true");
  row.append(node);
  return node;
}

function forget() {
  // React 重渲染会把节点换掉；引用已经不在了就别再指着旧的那份。
  for (const key of ["avatar", "label"]) {
    if (hidden[key] && !hidden[key].isConnected) hidden[key] = null;
    if (overlays[key] && !overlays[key].isConnected) overlays[key] = null;
  }
}

function applyAvatar(prefs) {
  const { row, avatar } = target;
  if (!row || !avatar) return;
  forget();
  const dataUrl = prefs.avatar;
  if (!dataUrl) {
    overlays.avatar?.remove();
    overlays.avatar = null;
    if (hidden.avatar) {
      show(hidden.avatar);
      hidden.avatar = null;
    }
    return;
  }
  const box = relRect(avatar, row);
  const node = makeOverlay(row, "avatar");
  // 同一个 dataURL 反复赋给 src 会让浏览器反复解码，settle 跑得勤时肉眼可见地掉帧。
  if (node.getAttribute("src") !== dataUrl) node.src = dataUrl;
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${box.width}px`;
  node.style.height = `${box.height}px`;
  if (hidden.avatar !== avatar) {
    // 换到别的行去了：先把上一份还回去，不然旧头像会一直隐身。
    if (hidden.avatar) show(hidden.avatar);
    hide(avatar);
    hidden.avatar = avatar;
  }
  overlays.avatar = node;
}

function applyLabel(prefs) {
  const row = target.row;
  if (!row) return;
  // 名字是账号快照到了之后才渲染出来的（先出头像、随后才有昵称），
  // 只在 locate() 里认一次就会永久拿到 null。所以每次同步都重认。
  if (!target.label || !target.label.isConnected) {
    target.label = target.avatar ? labelOf(row, target.avatar) : null;
  }
  forget();
  const text = prefs.name;
  if (!text) {
    overlays.label?.remove();
    overlays.label = null;
    if (hidden.label) {
      show(hidden.label);
      hidden.label = null;
    }
    return;
  }
  const label = target.label;
  // 实在找不到原件也照样盖：贴着头像右边、跟头像垂直居中。
  const box = label
    ? relRect(label, row)
    : (() => {
        const avatarBox = relRect(target.avatar, row);
        const height = 18;
        return {
          left: avatarBox.left + avatarBox.width + 10,
          top: avatarBox.top + (avatarBox.height - height) / 2,
          width: 0,
          height,
        };
      })();
  const node = makeOverlay(row, "label");
  const style = getComputedStyle(label ?? row);
  node.textContent = text;
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  // 原文字可能是省略号截断过的固定宽度；自定义名字可能更长，给到行的右边界。
  const rowWidth = row.getBoundingClientRect().width;
  node.style.maxWidth = `${Math.max(box.width, rowWidth - box.left - 8)}px`;
  node.style.font = style.font;
  node.style.color = style.color;
  node.style.letterSpacing = style.letterSpacing;
  node.style.lineHeight = `${box.height}px`;
  if (label && hidden.label !== label) {
    if (hidden.label) show(hidden.label);
    hide(label);
    hidden.label = label;
  }
  overlays.label = node;
}

/** 重新定位（窗口大小变了、行里内容变了）。 */
function sync(prefs) {
  if (!target.row) locate();
  if (!target.row) return;
  applyAvatar(prefs);
  applyLabel(prefs);
  report(prefs);
}

/**
 * 侧栏下半部分那些「菜单锚点」按钮。内置账号行就是 `button[aria-haspopup="menu"]`
 * （jsx 里 `aria-haspopup: "menu"` 是写死的，一定在）；而
 * `data-avatar-status={account.avatar?.status}` 在 avatar 为 undefined 时会被 React
 * **整个省掉**，所以只认那个 data 属性会漏——这是「设置了却没变」的真正原因。
 */
function menuTriggers() {
  const found = [];
  for (const el of document.querySelectorAll('button[aria-haspopup="menu"]')) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 18) continue;
    if (rect.right > 480) continue; // 只要侧栏那一条
    if (rect.bottom < window.innerHeight * 0.45) continue; // 只要窗口下半部分
    found.push(el);
  }
  // 最靠下的那个：侧栏底部这一行一定是纵向最靠后的菜单锚点。
  found.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
  return found;
}

function locate() {
  // 认准了就别乱换：一旦把原头像藏起来，它自己就「不可见」了，再按可见性搜会搜空，
  // 于是还原时找不到目标（踩过）。只有节点真的被换掉（React 重渲染）才重新找。
  if (target.row?.isConnected && target.avatar?.isConnected) return;

  // 1) 语义钩子：菜单锚点按钮。头像槽是它的第一个子元素（里面可能是 <img>、
  //    也可能是没设头像时的 16px 兜底 svg 图标，所以不能按 <img> 找）。
  //    `[data-avatar-status]` 有两处（侧栏这行 24px、设置页账号卡片 32px），
  //    只有侧栏那个在 `button[aria-haspopup="menu"]` 里，所以按这个条件挑。
  const badge = Array.from(document.querySelectorAll("[data-avatar-status]")).find((el) =>
    el.closest('button[aria-haspopup="menu"]'),
  );
  const trigger = badge?.closest("button") ?? menuTriggers()[0] ?? null;
  if (trigger) {
    const slot = badge ?? trigger.firstElementChild ?? trigger;
    target = { row: trigger, avatar: slot, label: labelOf(trigger, slot) };
    trigger.style.position = "relative";
    trigger.dataset[ROW_FLAG] = "1";
    return;
  }

  // 2) 兜底：结构定位（按正圆 <img> 找）。
  const avatars = roundAvatars();
  if (!avatars.length) {
    target = { row: null, avatar: null, label: null };
    return;
  }
  // 最靠下的那个：侧栏右上角也可能有圆头像，左下角这个才是账号行。
  avatars.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
  for (const avatar of avatars) {
    const row = rowOf(avatar);
    if (!row) continue;
    target = { row, avatar, label: labelOf(row, avatar) };
    row.style.position = "relative";
    row.dataset[ROW_FLAG] = "1";
    return;
  }
  target = { row: null, avatar: null, label: null };
}

function settle(getPrefs) {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    locate();
    // 不能把 hidden/overlays 清空：清了就再也找不到「被藏起来的原头像」，
    // 用户一还原就还原不回来（踩过）。
    sync(getPrefs());
  }, 120);
}

/**
 * 挂上。`getPrefs` 每次需要最新值（头像/昵称），`subscribe` 用来在设置面板改完后立刻重画。
 * 返回 `{ refresh, found }`，幂等。
 */
export function mountAccount({ getPrefs, subscribe } = {}) {
  const found = () => target.row !== null && (target.avatar !== null || target.label !== null);
  if (!getPrefs || typeof document === "undefined") return { refresh: () => {}, found: () => false };
  ensureStyle();
  const refresh = () => {
    locate();
    sync(getPrefs());
  };
  if (installed) {
    refresh();
    return { refresh, found };
  }
  installed = true;

  refresh();

  // 应用会重渲染（账号快照到了、换会话、折叠侧栏…），跟着重盖。
  // 只听 childList：开屏和聊天流一直在改文本，characterData 会把这儿刷成 8 次/秒。
  const observer = new MutationObserver(() => settle(getPrefs));
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", () => settle(getPrefs), { passive: true });
  window.addEventListener("scroll", () => settle(getPrefs), { passive: true, capture: true });
  // 启动阶段这几秒最容易抖，多补几枪（便宜的短轮询，之后交给观察器）。
  for (const delay of [600, 1500, 3000, 6000, 10000]) {
    window.setTimeout(() => settle(getPrefs), delay);
  }
  if (typeof subscribe === "function") subscribe(() => settle(getPrefs));

  return { refresh, found };
}
