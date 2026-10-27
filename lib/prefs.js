/**
 * dsh-hdd-splash / prefs.js
 *
 * 开屏动画的可调参数。全都存在浏览器本地（localStorage）——这是有意的：
 *   · 值要在**渲染进程**里被 splash.js 直接读到（开屏是纯前端的事）；
 *   · 走 profile 的 cordis config 得先把值从宿主送到页面，多一层链路、多一处会坏；
 *   · 代价是「换机器不带走」，跟 dsh-theme-herta 的外观设置一个取舍。
 *
 * 同页里改值不会触发 storage 事件，所以自己发一条 `hdd-splash:prefs`；
 * splash.js 订阅它，就能做到「拖动滑杆 → 左下角那枚徽记立刻变大变小」。
 */

const NS = "dsh-hdd-splash";

export const KEY = {
  /** 开屏动画音量 0..1 */
  volume: `${NS}:volume`,
  /** 常驻徽记尺寸（px）；0 = 跟着窗口自动算 */
  size: `${NS}:size`,
  /** 开屏动画开关（"1"/"0"） */
  enabled: `${NS}:enabled`,
  /** 常驻徽记位置 `{x,y}`（中心点，CSS px） */
  home: `${NS}:home`,
  /** 自定义头像（dataURL）；空 = 用账号原本的头像 */
  avatar: `${NS}:avatar`,
  /** 自定义昵称；空 = 用账号原本的名字 */
  name: `${NS}:name`,
};

export const DEFAULT_PREFS = { volume: 1, size: 0, enabled: true };
export const SIZE_MIN = 32;
export const SIZE_MAX = 200;

const EVENT = `${NS}:prefs`;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function readNumber(key, fallback) {
  try {
    const raw = window.localStorage?.getItem(key);
    if (raw === null || raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function readFlag(key, fallback) {
  try {
    const raw = window.localStorage?.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return raw === "1" || raw === "true";
  } catch {
    return fallback;
  }
}

function put(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    /* 隐私模式 / 配额满：只在本次生效，界面照样动 */
  }
  notify();
}

/** 广播一次「参数变了」。 */
export function notify() {
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* 没有 CustomEvent 就算了 */
  }
}

/** 订阅参数变化，返回退订函数。 */
export function onPrefsChange(listener) {
  const wrapped = () => listener();
  window.addEventListener(EVENT, wrapped);
  // 别的标签页改了也跟上（storage 事件不区分 key 的时候过滤一下）。
  const onStorage = (event) => {
    if (event.key === null || event.key.startsWith(NS)) wrapped();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, wrapped);
    window.removeEventListener("storage", onStorage);
  };
}

/** 读全部参数（已夹到合法范围）。 */
export function getPrefs() {
  return {
    volume: clamp(readNumber(KEY.volume, DEFAULT_PREFS.volume), 0, 1),
    size: clamp(readNumber(KEY.size, DEFAULT_PREFS.size), 0, SIZE_MAX),
    enabled: readFlag(KEY.enabled, DEFAULT_PREFS.enabled),
  };
}

export function setVolume(value) {
  put(KEY.volume, clamp(Number(value) || 0, 0, 1).toFixed(2));
}

/** px；0（或非正数）= 自动。 */
export function setSize(value) {
  const px = Math.round(Number(value) || 0);
  put(KEY.size, String(px <= 0 ? 0 : clamp(px, SIZE_MIN, SIZE_MAX)));
}

export function setEnabled(on) {
  put(KEY.enabled, on ? "1" : "0");
}

/** 常驻徽记位置；读不出来就是「没设过」。 */
export function getSavedHome() {
  try {
    const raw = window.localStorage?.getItem(KEY.home);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
      return { x: value.x, y: value.y };
    }
  } catch {
    /* 坏数据当没设过 */
  }
  return null;
}

export function saveHome(x, y) {
  put(KEY.home, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
}

export function clearSavedHome() {
  try {
    window.localStorage?.removeItem(KEY.home);
  } catch {
    /* 忽略 */
  }
  notify();
}

/** 恢复出厂：音量 100%、尺寸自动、开屏照播、位置回左下角、头像昵称还原。 */
export function resetPrefs() {
  for (const [key, value] of [
    [KEY.volume, DEFAULT_PREFS.volume.toFixed(2)],
    [KEY.size, String(DEFAULT_PREFS.size)],
    [KEY.enabled, DEFAULT_PREFS.enabled ? "1" : "0"],
  ]) {
    try {
      window.localStorage?.setItem(key, value);
    } catch {
      /* 忽略 */
    }
  }
  for (const key of [KEY.home, KEY.avatar, KEY.name]) {
    try {
      window.localStorage?.removeItem(key);
    } catch {
      /* 忽略 */
    }
  }
  notify();
}

function readText(key) {
  try {
    return window.localStorage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** 自定义头像 dataURL；空字符串 = 不覆盖。 */
export function getAvatar() {
  const value = readText(KEY.avatar);
  return value.startsWith("data:image/") ? value : "";
}

export function setAvatar(dataUrl) {
  const value = typeof dataUrl === "string" ? dataUrl : "";
  if (!value) {
    try {
      window.localStorage?.removeItem(KEY.avatar);
    } catch {
      /* 忽略 */
    }
    notify();
    return true;
  }
  try {
    window.localStorage?.setItem(KEY.avatar, value);
    notify();
    return true;
  } catch (error) {
    console.warn("[dsh-hdd-splash] 头像存不下（localStorage 配额）", error);
    return false;
  }
}

/** 自定义昵称；空字符串 = 不覆盖。最长 24 个字符。 */
export function getName() {
  return readText(KEY.name).slice(0, 24);
}

export function setName(value) {
  const text = String(value ?? "").slice(0, 24);
  try {
    if (text) window.localStorage?.setItem(KEY.name, text);
    else window.localStorage?.removeItem(KEY.name);
  } catch {
    /* 忽略 */
  }
  notify();
}

