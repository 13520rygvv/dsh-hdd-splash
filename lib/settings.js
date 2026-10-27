/**
 * dsh-hdd-splash / settings.js
 *
 * 「设置 → 开屏动画」那一栏。
 *
 * 挂法照抄 dsh-theme-herta 的做法（那是这套系统里现成的范例）：
 *   · 所有注册都必须在 ctx.effect() 里做，effect 的返回值负责撤销；
 *   · 槽子必须用 slots.inject(...) 拿，不能直接 ctx.get("slots")——后者在早期是空架子；
 *   · 真正的槽名是 "settings.section"，注册时的 name 也写它；
 *   · 每个分区自带 label / order / inject()，inject() 返回要传给组件的 props。
 *
 * 面板用真 React（client.js 用 require("react") 拿），但只用最基础的 createElement +
 * useState，不引入任何 JSX/打包器。
 */

import {
  DEFAULT_PREFS,
  getAvatar,
  getName,
  getPrefs,
  getSavedHome,
  resetPrefs,
  setAvatar,
  setEnabled,
  setName,
  setSize,
  setVolume,
  SIZE_MAX,
  SIZE_MIN,
} from "./prefs.js";

export const SECTION_ID = "hdd-splash";
export const SECTION_LABEL = "开屏动画";
/** 排在其它设置分区后面，别插队。 */
const ORDER = 31;

export const ACCOUNT_SECTION_ID = "hdd-account";
export const ACCOUNT_SECTION_LABEL = "左下角头像";
const ACCOUNT_ORDER = 32;

const styles = {
  wrap: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 0 8px" },
  row: { display: "flex", flexDirection: "column", gap: "6px" },
  head: { display: "flex", alignItems: "center", gap: "10px", justifyContent: "space-between" },
  label: { fontSize: "13px", fontWeight: 600, color: "inherit" },
  value: { fontSize: "12px", fontVariantNumeric: "tabular-nums", opacity: 0.72, minWidth: "52px", textAlign: "right" },
  hint: { fontSize: "12px", lineHeight: 1.55, opacity: 0.62 },
  control: { display: "flex", alignItems: "center", gap: "10px" },
  range: { flex: 1, accentColor: "var(--dsw-alias-brand-primary, #4d6bfe)", minWidth: 0 },
  buttons: { display: "flex", flexWrap: "wrap", gap: "8px" },
  button: {
    padding: "5px 12px",
    borderRadius: "8px",
    border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
    background: "transparent",
    color: "inherit",
    fontSize: "12px",
    lineHeight: 1.4,
    cursor: "pointer",
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: "5px 10px",
    borderRadius: "8px",
    border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
    background: "transparent",
    color: "inherit",
    fontSize: "12px",
    lineHeight: 1.5,
  },
  preview: {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    objectFit: "cover",
    flex: "0 0 auto",
    border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
  },
};

/** 一行设置：标题 + 右侧数值 + 控件 + 说明。两个分区共用。 */
const makeRow = (React) => (label, valueText, control, hint) =>
  React.createElement(
    "div",
    { style: styles.row },
    React.createElement(
      "div",
      { style: styles.head },
      React.createElement("span", { style: styles.label }, label),
      valueText === null ? null : React.createElement("span", { style: styles.value }, valueText),
    ),
    control,
    hint === null ? null : React.createElement("div", { style: styles.hint }, hint),
  );

/** 开关：两个小按钮，省得自己画 checkbox。 */
function toggleButtons(saved, React, onChange) {
  const make = (label, value) =>
    React.createElement(
      "button",
      {
        type: "button",
        style: {
          ...styles.button,
          ...(saved === value
            ? {
                borderColor: "var(--dsw-alias-brand-primary, #4d6bfe)",
                color: "var(--dsw-alias-brand-primary, #4d6bfe)",
                fontWeight: 600,
              }
            : null),
        },
        onClick: () => onChange(value),
      },
      label,
    );
  return React.createElement("div", { style: styles.buttons }, make("开", true), make("关", false));
}

/** 把选的图片压到 128×128 的正方形（cover 裁切），转成 dataURL 存本地。 */
function shrinkImage(file, size = 128) {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onerror = () => resolve("");
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => resolve("");
        image.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;
            const context = canvas.getContext("2d");
            if (context === null) {
              resolve("");
              return;
            }
            const scale = Math.max(size / image.width, size / image.height);
            const width = image.width * scale;
            const height = image.height * scale;
            context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
            resolve(canvas.toDataURL("image/webp", 0.92));
          } catch (error) {
            console.warn("[dsh-hdd-splash] 图片处理失败", error);
            resolve("");
          }
        };
        image.src = String(reader.result ?? "");
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.warn("[dsh-hdd-splash] 图片读取失败", error);
      resolve("");
    }
  });
}

/**
 * 装设置分区。
 * @param {object} ctx                    客户端插件的 ctx（apply 收到的那只）
 * @param {{React: object, route: string}} options
 * @returns {() => void} 撤销函数（ctx.effect 的返回值）
 */
export function installSettingsSection(ctx, options) {
  const React = options?.React;
  const route = options?.route ?? "/hdd-splash";

  if (!React?.createElement) {
    console.warn("[dsh-hdd-splash] 拿不到 react，设置分区跳过");
    return () => {};
  }

  const slots = ctx.get("slots");
  if (slots === undefined) {
    console.warn("[dsh-hdd-splash] 没有 slots 服务，设置分区跳过");
    return () => {};
  }

  /** 把当前参数读成组件要的 props（还有存过的位置，用来显示坐标）。 */
  const readState = () => ({ ...getPrefs(), home: getSavedHome() });

  const Section = () => {
    const [state, setState] = React.useState(readState);
    const update = (patch) => setState({ ...readState(), ...patch });

    const replayNow = () => {
      const viaHost = window.__hddSplashReplay;
      if (typeof viaHost === "function") {
        viaHost();
        return;
      }
      import(`${route}/splash.js`)
        .then((module) => module.replay({ route }))
        .catch((error) => console.warn("[dsh-hdd-splash] 重播失败", error));
    };

    const row = makeRow(React);

    const volumePct = Math.round(state.volume * 100);
    const sizeLabel = state.size > 0 ? `${state.size} px` : "自动";

    return React.createElement(
      "div",
      { style: styles.wrap },
      row(
        "开屏动画",
        null,
        toggleButtons(state.enabled, React, (on) => {
          setEnabled(on);
          update({ enabled: on });
        }),
        "关掉只是下次启动不放动画；左下角那枚徽记照旧在。",
      ),
      row(
        "音量",
        `${volumePct}%`,
        React.createElement(
          "div",
          { style: styles.control },
          React.createElement("input", {
            type: "range",
            min: 0,
            max: 100,
            step: 1,
            value: volumePct,
            style: styles.range,
            onChange: (event) => {
              const pct = Number(event.target.value);
              setVolume(pct / 100);
              update({ volume: pct / 100 });
            },
          }),
        ),
        volumePct === 0 ? "已经静音。" : null,
      ),
      row(
        "徽记大小",
        sizeLabel,
        React.createElement(
          "div",
          { style: styles.control },
          React.createElement("input", {
            type: "range",
            min: SIZE_MIN,
            max: SIZE_MAX,
            step: 2,
            value: state.size > 0 ? state.size : 80,
            style: styles.range,
            onChange: (event) => {
              const px = Number(event.target.value);
              setSize(px);
              update({ size: px });
            },
          }),
          React.createElement(
            "button",
            {
              type: "button",
              style: styles.button,
              onClick: () => {
                setSize(0);
                update({ size: 0 });
              },
            },
            "自动",
          ),
        ),
        "左下角徽记的尺寸；改完立刻生效，不用刷新。",
      ),
      row(
        "徽记位置",
        state.home === null ? "默认（左下角）" : `${Math.round(state.home.x)}, ${Math.round(state.home.y)}`,
        React.createElement(
          "div",
          { style: styles.buttons },
          React.createElement(
            "button",
            {
              type: "button",
              style: styles.button,
              onClick: () => {
                import(`${route}/splash.js`)
                  .then((module) => module.resetHomePosition?.())
                  .catch((error) => console.warn("[dsh-hdd-splash] 复位徽记失败", error));
                update({ home: null });
              },
            },
            "回到默认位置",
          ),
        ),
        "直接拖动徽记就能换位置，双击它回到左下角。",
      ),
      React.createElement(
        "div",
        { style: styles.buttons },
        React.createElement("button", { type: "button", style: styles.button, onClick: replayNow }, "播一次看看"),
        React.createElement(
          "button",
          {
            type: "button",
            style: styles.button,
            onClick: () => {
              resetPrefs();
              setState(readState());
            },
          },
          "恢复默认",
        ),
      ),
      React.createElement(
        "div",
        { style: styles.hint },
        `参数存在本机浏览器里，换机器不会带走。默认：音量 ${Math.round(DEFAULT_PREFS.volume * 100)}%、尺寸自动。`,
      ),
    );
  };

  /**
   * 「左下角头像」分区：换头像 / 换昵称。
   * 这一行原本是内置插件按账号快照画的；这里只把显示盖掉，账号本身不动。
   */
  const AccountSection = () => {
    const row = makeRow(React);
    const [avatar, setAvatarState] = React.useState(getAvatar);
    const [nickname, setNicknameState] = React.useState(getName);
    const [note, setNote] = React.useState("");

    const onPick = async (event) => {
      const file = event.target?.files?.[0];
      if (event.target !== null && event.target !== undefined) event.target.value = "";
      if (!file) return;
      const dataUrl = await shrinkImage(file);
      if (!dataUrl) {
        setNote("这张图没读出来，换一张试试。");
        return;
      }
      const ok = setAvatar(dataUrl);
      setAvatarState(dataUrl);
      setNote(ok ? "" : "存不下（浏览器本地空间满了），换张小一点的图。");
    };

    const preview = avatar
      ? React.createElement("img", { src: avatar, alt: "", style: styles.preview })
      : React.createElement(
          "span",
          {
            style: {
              ...styles.preview,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "10px",
              opacity: 0.55,
            },
          },
          "默认",
        );

    return React.createElement(
      "div",
      { style: styles.wrap },
      row(
        "头像",
        null,
        React.createElement(
          "div",
          { style: styles.control },
          preview,
          React.createElement(
            "label",
            { style: { ...styles.button, display: "inline-flex", alignItems: "center" } },
            "选图片…",
            React.createElement("input", {
              type: "file",
              accept: "image/*",
              style: { display: "none" },
              onChange: onPick,
            }),
          ),
          React.createElement(
            "button",
            {
              type: "button",
              style: styles.button,
              onClick: () => {
                setAvatar("");
                setAvatarState("");
                setNote("");
              },
            },
            "还原",
          ),
        ),
        "侧边栏左下角那个圆头像。图片会压成 128×128 只存在本机浏览器里，不上传。",
      ),
      row(
        "昵称",
        null,
        React.createElement(
          "div",
          { style: styles.control },
          React.createElement("input", {
            type: "text",
            value: nickname,
            maxLength: 24,
            placeholder: "留空就用账号原本的名字",
            style: styles.input,
            onChange: (event) => {
              const text = String(event.target.value ?? "");
              setNicknameState(text);
              setName(text);
            },
          }),
          React.createElement(
            "button",
            {
              type: "button",
              style: styles.button,
              onClick: () => {
                setName("");
                setNicknameState("");
              },
            },
            "还原",
          ),
        ),
        "留空就显示账号原本的昵称；没有昵称时会显示服务端给的脱敏手机号／邮箱。",
      ),
      note ? React.createElement("div", { style: styles.hint }, note) : null,
      React.createElement(
        "div",
        { style: styles.hint },
        "这一行是内置插件画的，本插件只是在它上面盖了一层；账号本身不会变。",
      ),
    );
  };

  const register = (id, order, label, Component, key) =>
    ctx.effect(() => {
      const dispose = slots.register(
        { name: "settings.section", id, order, label, inject: () => ({}) },
        () => React.createElement(Component, {}),
      );
      console.log(`[dsh-hdd-splash] 设置分区已注册：${id}`);
      return () => {
        try {
          dispose?.();
        } catch (error) {
          console.warn(`[dsh-hdd-splash] 设置分区撤销失败：${id}`, error);
        }
      };
    }, `dsh-hdd-splash: settings ${key}`);

  register(SECTION_ID, ORDER, SECTION_LABEL, Section, "splash");
  register(ACCOUNT_SECTION_ID, ACCOUNT_ORDER, ACCOUNT_SECTION_LABEL, AccountSection, "account");
}
