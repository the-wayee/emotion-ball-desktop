/* ============================================================
 * platform/win32.js —— Windows 活动探测
 *
 * 一次 PowerShell 调用同时拿三样东西：前台应用、是否全屏、有窗口的进程列表。
 * 分三次调会付三次 Add-Type 的编译开销（首次约 1s），所以合并成一个脚本。
 * 20s 一次的频率下这点开销可以接受，而且整个过程是异步的，不挡 UI。
 *
 * 全屏判定用前台窗口矩形 vs 所在显示器矩形 —— 比 macOS 那套"菜单栏是否隐藏"
 * 的启发式准确得多，独占全屏游戏和 F11 全屏都能覆盖。
 *
 * 应用名优先取文件描述（"Visual Studio Code"）而不是进程名（"Code"），
 * 分类规则和给模型的上下文都更好读。取不到就退回进程名。
 *
 * 注意：本文件在 macOS 上无法验证，需要在 Windows 上跑一次
 * `curl http://127.0.0.1:17817/activity` 核对。
 * ============================================================ */
'use strict';

const { execFile } = require('child_process');

/* PowerShell 起一次约 1s（Add-Type 编译），没法像 macOS 那样几秒一轮，
 * 所以前台轮询就沿用完整采样的节奏 */
const FRONT_POLL_MS = 20000;

/* $pid 在 PowerShell 里是只读的自动变量，必须换个名字，否则整段脚本报错 */
const PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
public class EBW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int id);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
}
'@

$app = $null
$full = $false
$h = [EBW]::GetForegroundWindow()

if ($h -ne [IntPtr]::Zero -and $h -ne [EBW]::GetShellWindow()) {
  $procId = 0
  [void][EBW]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId
  if ($p) {
    $app = $p.ProcessName
    try {
      $desc = $p.MainModule.FileVersionInfo.FileDescription
      if ($desc) { $app = $desc }
    } catch { }
  }

  $r = New-Object RECT
  if ([EBW]::GetWindowRect($h, [ref]$r)) {
    $mi = New-Object MONITORINFO
    $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    $mon = [EBW]::MonitorFromWindow($h, 2)
    if ([EBW]::GetMonitorInfo($mon, [ref]$mi)) {
      $full = ($r.L -le $mi.rcMonitor.L) -and ($r.T -le $mi.rcMonitor.T) -and
              ($r.R -ge $mi.rcMonitor.R) -and ($r.B -ge $mi.rcMonitor.B)
    }
  }
}

$apps = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |
          Select-Object -ExpandProperty ProcessName -Unique)

[pscustomobject]@{ app = $app; fullscreen = [bool]$full; apps = $apps } | ConvertTo-Json -Compress
`;

function runPS() {
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 512 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch (e) {
          resolve(null);
        }
      }
    );
  });
}

async function probe() {
  const r = await runPS();
  if (!r) return { app: null, apps: [], fullscreen: false };
  /* ConvertTo-Json 对单元素数组会退化成标量，统一成数组 */
  const apps = Array.isArray(r.apps) ? r.apps : (r.apps ? [r.apps] : []);
  return { app: r.app || null, apps, fullscreen: !!r.fullscreen };
}

module.exports = {
  probe,
  pollFront: async () => (await probe()).app,
  FRONT_POLL_MS
};
