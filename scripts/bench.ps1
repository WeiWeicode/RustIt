<#
.SYNOPSIS
  並排比較 RustIt 原生版（egui）與 WebView2 版（Tauri）的資源用量。

.DESCRIPTION
  依序啟動每個 exe，等待資料蒐集完成後取樣一段時間，加總主程式與所有子行程
  （WebView2 會另外開好幾個 msedgewebview2.exe）的記憶體、CPU、執行緒與控制代碼。

  兩個版本都停在啟動後的「總覽」頁（每秒更新一次即時使用率），條件相同。
  WebView2 版啟動後會跳出「重要公告」彈窗（背後整個畫面套上模糊），原生版沒有；
  腳本會自動按下「我已閱讀」關掉它，加上 -KeepAnnouncement 則保留彈窗量測。
  量測期間請不要切換視窗、不要動滑鼠鍵盤：兩個版本在背景時都會暫停每秒更新，數字會失真。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\bench.ps1

.EXAMPLE
  # 取樣 60 秒、各跑 3 次取平均
  powershell -ExecutionPolicy Bypass -File scripts\bench.ps1 -Seconds 60 -Runs 3

.EXAMPLE
  # 自訂要比較的程式（名稱=路徑）
  powershell -ExecutionPolicy Bypass -File scripts\bench.ps1 -Apps "原生 glow=target\release\rustit-native.exe","原生 wgpu=C:\tmp\rustit-native-wgpu.exe"
#>
param(
    [string[]]$Apps = @(),
    [int]$Warmup = 8,
    [int]$Seconds = 30,
    [int]$Runs = 1,
    [switch]$KeepAnnouncement
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BenchWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, IntPtr extra);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool QueryProcessCycleTime(IntPtr h, out ulong cycles);

  // 行程累計用掉的 CPU 週期。不用 TotalProcessorTime：它以 15.6 ms 的時脈中斷取樣，
  // 每秒只醒來一次的輕量程式常被整格算進去或完全漏掉，誤差比數值本身還大。
  public static ulong Cycles(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);  // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return 0;
    ulong c;
    if (!QueryProcessCycleTime(h, out c)) c = 0;
    CloseHandle(h);
    return c;
  }

  // 行程中最大的可見頂層視窗（至少 200×200）。不用 Process.MainWindowHandle：
  // Tauri 啟動時會先有一個 14×14 的「Tao Thread Event Target」視窗被當成主視窗。
  public static IntPtr FindMainWindow(int pid) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h)) {
        RECT r;
        GetWindowRect(h, out r);
        long w = r.R - r.L, hh = r.B - r.T;
        if (w >= 200 && hh >= 200 && w * hh > bestArea) { best = h; bestArea = w * hh; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static void ClickCenter(IntPtr h) {
    RECT r;
    GetWindowRect(h, out r);
    SetCursorPos((r.L + r.R) / 2, (r.T + r.B) / 2);
    mouse_event(2, 0, 0, 0, IntPtr.Zero);
    mouse_event(4, 0, 0, 0, IntPtr.Zero);
  }
  public static void Press(byte vk) {
    keybd_event(vk, 0, 0, IntPtr.Zero);
    keybd_event(vk, 0, 2, IntPtr.Zero);
  }
  // 背景行程不能直接搶前景；先送一個 Alt 鍵解除限制。回傳是否真的成為前景視窗。
  public static bool Focus(IntPtr h) {
    keybd_event(0x12, 0, 0, IntPtr.Zero);
    keybd_event(0x12, 0, 2, IntPtr.Zero);
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(500);
    return GetForegroundWindow() == h;
  }
}
"@
[void][BenchWin]::SetProcessDPIAware()

# 用 -File 執行時陣列參數會變成一個以逗號連接的字串，這裡再拆開
$Apps = @($Apps | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
if ($Apps.Count -eq 0) {
    $web = @('target\release\rustit-demo.exe', 'dist\RustIt-Demo.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
    $Apps = @("原生 egui=target\release\rustit-native.exe", "WebView2=$web")
}
$targets = foreach ($a in $Apps) {
    $name, $path = $a -split '=', 2
    if (-not $path -or -not (Test-Path $path)) {
        throw "找不到 $name 的執行檔：$path（先執行 cargo build --release -p rustit-native / -p rustit-demo）"
    }
    [pscustomobject]@{ Name = $name; Path = (Resolve-Path $path).Path }
}

$cores = [Environment]::ProcessorCount
# CPU 週期以處理器標稱時脈（固定頻率的 TSC）計數，用它換算成秒
$cyclesPerSec = (Get-ItemProperty 'HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0').'~MHz' * 1e6

# 以父行程關係找出整個行程樹；只算啟動之後建立的行程，避免 PID 重複使用誤算。
function Get-Tree([int]$rootId, [datetime]$since) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate
    $children = @{}
    foreach ($p in $all) {
        if ($p.CreationDate -lt $since.AddSeconds(-1)) { continue }
        $key = [int]$p.ParentProcessId
        if (-not $children.ContainsKey($key)) { $children[$key] = New-Object System.Collections.ArrayList }
        [void]$children[$key].Add([int]$p.ProcessId)
    }
    $ids = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($rootId)
    while ($queue.Count) {
        $id = $queue.Dequeue()
        [void]$ids.Add($id)
        if ($children.ContainsKey($id)) { foreach ($c in $children[$id]) { $queue.Enqueue($c) } }
    }
    return $ids
}

function Measure-App($target) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $since = Get-Date
    $proc = Start-Process -FilePath $target.Path -PassThru
    $hwnd = [IntPtr]::Zero
    while ($hwnd -eq [IntPtr]::Zero -and $sw.ElapsedMilliseconds -lt 20000) {
        Start-Sleep -Milliseconds 10
        $hwnd = [BenchWin]::FindMainWindow($proc.Id)
    }
    $windowMs = $sw.ElapsedMilliseconds
    if ($hwnd -eq [IntPtr]::Zero) { throw "$($target.Name) 在 20 秒內沒有出現視窗" }

    Start-Sleep -Seconds $Warmup
    $valid = [BenchWin]::Focus($hwnd)
    $isWebView = Get-Process -Id (Get-Tree $proc.Id $since) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'msedgewebview2'
    # 只在確定視窗在前景時才點擊與按鍵，否則會點到別的程式
    if ($valid -and $isWebView -and -not $KeepAnnouncement) {
        # 公告彈窗置中，點視窗正中央（落在彈窗內文上）再按 Tab、Enter，就是按下彈窗唯一的按鈕「我已閱讀」。
        # 不用 UI Automation 找按鈕：那會讓 Chromium 開啟無障礙樹，本身就會增加記憶體與 CPU。
        [BenchWin]::ClickCenter($hwnd)
        Start-Sleep -Milliseconds 300
        [BenchWin]::Press(0x09)
        Start-Sleep -Milliseconds 150
        [BenchWin]::Press(0x0D)
        Start-Sleep -Milliseconds 1500
        $valid = [BenchWin]::GetForegroundWindow() -eq $hwnd
    }
    if (-not $valid) {
        Write-Warning "$($target.Name) 的視窗不在前景（程式會暫停每秒更新），這一次不列入平均。量測期間請不要切換視窗。"
    }

    $cpuStart = @{}
    foreach ($id in Get-Tree $proc.Id $since) { $cpuStart[$id] = [BenchWin]::Cycles($id) }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $samples = for ($i = 0; $i -lt $Seconds; $i++) {
        Start-Sleep -Seconds 1
        $ps = @(Get-Process -Id (Get-Tree $proc.Id $since) -ErrorAction SilentlyContinue)
        [pscustomobject]@{
            Count   = $ps.Count
            WS      = ($ps | Measure-Object WorkingSet64 -Sum).Sum
            Private = ($ps | Measure-Object PrivateMemorySize64 -Sum).Sum
            Threads = ($ps | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum
            Handles = ($ps | Measure-Object HandleCount -Sum).Sum
        }
    }
    $elapsed = $clock.Elapsed.TotalSeconds
    $tree = Get-Tree $proc.Id $since
    $cycles = 0.0
    foreach ($id in $tree) {
        $start = if ($cpuStart.ContainsKey($id)) { $cpuStart[$id] } else { 0 }
        $now = [BenchWin]::Cycles($id)
        if ($now -gt $start) { $cycles += $now - $start }
    }
    $cpuUsed = $cycles / $cyclesPerSec
    $names = (Get-Process -Id $tree -ErrorAction SilentlyContinue | Group-Object ProcessName | ForEach-Object { "$($_.Name)×$($_.Count)" }) -join ', '

    # 關掉整個行程樹（子行程先關）
    [array]::Reverse($tree)
    foreach ($id in $tree) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2

    $avg = { param($prop) ($samples | Measure-Object $prop -Average).Average }
    $max = { param($prop) ($samples | Measure-Object $prop -Maximum).Maximum }
    [pscustomobject]@{
        WindowMs   = $windowMs
        Processes  = [math]::Round((& $avg Count), 1)
        Names      = $names
        Threads    = [math]::Round((& $avg Threads))
        Handles    = [math]::Round((& $avg Handles))
        WsAvg      = (& $avg WS) / 1MB
        WsMax      = (& $max WS) / 1MB
        PrivateAvg = (& $avg Private) / 1MB
        PrivateMax = (& $max Private) / 1MB
        CpuMs      = $cpuUsed / $elapsed * 1000
        Cpu        = $cpuUsed / $elapsed / $cores * 100
        ExeMB      = (Get-Item $target.Path).Length / 1MB
        Valid      = $valid
    }
}

$results = foreach ($t in $targets) {
    $measured = for ($r = 1; $r -le $Runs; $r++) {
        Write-Host "量測 $($t.Name)（第 $r/$Runs 次）：等待 $Warmup 秒蒐集資料，再取樣 $Seconds 秒…"
        Measure-App $t
    }
    $ok = @($measured | Where-Object Valid)
    if ($ok.Count -eq 0) {
        Write-Warning "$($t.Name) 沒有任何一次在前景完成量測，以下數字不可信。"
        $ok = @($measured)
    }
    $mean = { param($prop) ($ok | Measure-Object $prop -Average).Average }
    [pscustomobject]@{
        Name       = $t.Name
        ValidRuns  = "$(@($measured | Where-Object Valid).Count)/$Runs"
        WindowMs   = & $mean WindowMs
        Processes  = & $mean Processes
        Names      = $measured[-1].Names
        Threads    = & $mean Threads
        Handles    = & $mean Handles
        WsAvg      = & $mean WsAvg
        WsMax      = & $mean WsMax
        PrivateAvg = & $mean PrivateAvg
        PrivateMax = & $mean PrivateMax
        CpuMs      = & $mean CpuMs
        Cpu        = & $mean Cpu
        ExeMB      = $measured[-1].ExeMB
    }
}

$rows = @(
    @('有效次數', 'ValidRuns', '{0}'),
    @('視窗出現（ms，見註）', 'WindowMs', '{0:N0}'),
    @('行程數', 'Processes', '{0:N0}'),
    @('執行緒', 'Threads', '{0:N0}'),
    @('控制代碼', 'Handles', '{0:N0}'),
    @('工作集 平均（MB）', 'WsAvg', '{0:N1}'),
    @('工作集 最高（MB）', 'WsMax', '{0:N1}'),
    @('私有記憶體 平均（MB）', 'PrivateAvg', '{0:N1}'),
    @('私有記憶體 最高（MB）', 'PrivateMax', '{0:N1}'),
    @('CPU 時間（毫秒 / 每秒）', 'CpuMs', '{0:N1}'),
    @('CPU 平均（%，全部核心 = 100）', 'Cpu', '{0:N2}'),
    @('執行檔（MB）', 'ExeMB', '{0:N1}')
)
$table = foreach ($row in $rows) {
    $label, $prop, $fmt = $row
    $o = [ordered]@{ '項目' = $label }
    foreach ($r in $results) { $o[$r.Name] = $fmt -f $r.$prop }
    if ($results.Count -eq 2) {
        # 視窗出現的時間點兩者意義不同（見最後的註），不算倍數
        $o['倍數'] = if ($prop -notin @('WindowMs', 'ValidRuns') -and $results[0].$prop -gt 0) { '{0:N1}×' -f ($results[1].$prop / $results[0].$prop) } else { '—' }
    }
    [pscustomobject]$o
}

Write-Host ""
Write-Host "取樣 $Seconds 秒 × $Runs 次，$cores 個邏輯處理器。「倍數」= 第二欄 ÷ 第一欄。"
$table | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
foreach ($r in $results) { Write-Host "$($r.Name) 的行程：$($r.Names)" }
Write-Host "註：原生版畫好第一幀才顯示視窗；WebView2 版先顯示空白視窗，之後才載入網頁，所以「視窗出現」不能直接比較。"
Write-Host "註：CPU 以 CPU 週期（QueryProcessCycleTime）計算；「CPU 時間」= 每經過 1 秒，所有行程合計用掉幾毫秒的 CPU。"
Write-Host "註：WebView2 版只在數字有變時才重繪，每次結果差異較大，建議加上 -Runs 3 取平均。"
