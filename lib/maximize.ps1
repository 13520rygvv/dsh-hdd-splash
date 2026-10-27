# 让指定进程的主窗口一出现就最大化。
#
# 为什么需要这个：DSH 桌面端的 createWindow() 把 width/height 写死成 1280x820，
# 主进程里既没有 maximize 也没有窗口尺寸持久化，DESKTOP_IPC 也没有任何「最大化」通道，
# 插件侧拿不到窗口对象。于是由插件在宿主侧 detached 拉起本脚本，盯着目标进程的主窗口：
# 窗口一旦可见且尚未最大化，立刻 ShowWindow(SW_MAXIMIZE)。窗口这时通常还藏在 show()
# 之前，所以用户看不到「先小后大」的跳变。
#
# 本文件必须以 **UTF-8 BOM** 保存：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI
# 解码，中文注释变成乱码后会吞掉下一行，导致莫名其妙的「参数为 null」报错。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File maximize.ps1 [-ProcessName "DeepSeek Harness"] [-Seconds 30]

param(
  [string]$ProcessName = "DeepSeek Harness",
  [int]$Seconds = 30
)

$src = @"
using System;
using System.Runtime.InteropServices;

public class WinMax {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);

  private static IntPtr found;
  private static uint[] wanted;

  private static bool Scan(IntPtr hwnd, IntPtr param) {
    if (!IsWindowVisible(hwnd)) return true;
    if (GetWindowTextLength(hwnd) <= 0) return true;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    for (int i = 0; i < wanted.Length; i++) {
      if (wanted[i] == pid) { found = hwnd; return false; }
    }
    return true;
  }

  // 第一个「可见 + 有标题 + 属于 pids」的顶层窗口；没有就是 IntPtr.Zero。
  public static IntPtr Find(uint[] pids) {
    found = IntPtr.Zero;
    wanted = pids;
    EnumWindows(Scan, IntPtr.Zero);
    return found;
  }
}
"@

# Add-Type 的编译要 1s 上下，而窗口通常几百毫秒就 show() 了 —— 为了不让人看见
# 「先 1280x820 再放大」，把编译结果缓存成 dll：第二次启动起直接 Add-Type -Path。
$dll = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-winmax-2.dll"
if (-not ("WinMax" -as [type])) {
  if (Test-Path $dll) {
    try { Add-Type -Path $dll -ErrorAction Stop } catch { }
  }
  if (-not ("WinMax" -as [type])) {
    try {
      Add-Type -TypeDefinition $src -OutputAssembly $dll -ErrorAction Stop
      Add-Type -Path $dll -ErrorAction Stop
    } catch {
      try {
        Add-Type -TypeDefinition $src -ErrorAction Stop
      } catch {
        Write-Output "compile failed: $($_.Exception.Message)"
        exit 1
      }
    }
  }
}

function Get-TargetPids {
  @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
}

$deadline = (Get-Date).AddSeconds($Seconds)
$done = $false
while ((Get-Date) -lt $deadline) {
  $pids = Get-TargetPids
  if ($pids.Count -gt 0) {
    $hwnd = [WinMax]::Find([uint32[]]$pids)
    if ($hwnd -ne [IntPtr]::Zero) {
      if (-not [WinMax]::IsZoomed($hwnd)) {
        # 3 = SW_MAXIMIZE
        [void][WinMax]::ShowWindow($hwnd, 3)
      }
      $done = $true
      break
    }
  }
  Start-Sleep -Milliseconds 100
}

if ($done) {
  # 再补一发：Electron 有时在 show() 之后才恢复自己的 bounds。
  Start-Sleep -Milliseconds 600
  $pids = Get-TargetPids
  if ($pids.Count -gt 0) {
    $hwnd = [WinMax]::Find([uint32[]]$pids)
    if ($hwnd -ne [IntPtr]::Zero -and -not [WinMax]::IsZoomed($hwnd)) {
      [void][WinMax]::ShowWindow($hwnd, 3)
    }
  }
  Write-Output "maximized"
} else {
  Write-Output "no visible window within $Seconds s"
}
