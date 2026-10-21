# 主機 2 Windows Runner 建置工具安裝(P6-4,docs/WINDOWS-RUNNER-SETUP.md §2)。可重跑:已安裝的項目會略過。
# 全部裝成全機共用,讓之後的 Runner 服務帳號可用。不含任何機密。系統管理員 Windows PowerShell 執行:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-runner-tools.ps1 [-SkipBuildTools]
# 本檔要存成 UTF-8 **含 BOM**:Windows PowerShell 5.1 在 CP950(Big5)系統會把無 BOM 的 UTF-8 讀成亂碼。
param([switch]$SkipBuildTools)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dl = 'C:\ci\downloads'
New-Item -ItemType Directory -Force $dl, 'C:\GitLab-Runner', 'C:\Tools', 'C:\Rust' | Out-Null

function Add-MachinePath([string]$p) {
    $cur = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if (($cur -split ';') -notcontains $p) {
        [Environment]::SetEnvironmentVariable('Path', "$cur;$p", 'Machine')
        Write-Host "  PATH += $p"
    }
    if (($env:Path -split ';') -notcontains $p) { $env:Path = "$env:Path;$p" }
}
function Step([string]$name) { Write-Host "`n=== $name ===" }

# 1. gitlab-runner(與 WSL 既有 Runner 同版本)
Step 'gitlab-runner 19.4.1'
$runnerExe = 'C:\GitLab-Runner\gitlab-runner.exe'
if (-not (Test-Path $runnerExe)) {
    $base = 'https://gitlab-runner-downloads.s3.amazonaws.com/v19.4.1'
    Invoke-WebRequest "$base/binaries/gitlab-runner-windows-amd64.exe" -OutFile "$dl\gitlab-runner-windows-amd64.exe" -UseBasicParsing
    # release.sha256 是 binary/octet-stream,.Content 會是 byte[],先存檔再讀
    Invoke-WebRequest "$base/release.sha256" -OutFile "$dl\gitlab-runner-release.sha256" -UseBasicParsing
    $line = Get-Content "$dl\gitlab-runner-release.sha256" | Where-Object { $_ -match 'binaries/gitlab-runner-windows-amd64\.exe$' } | Select-Object -First 1
    if (-not $line) { throw 'release.sha256 找不到 windows-amd64' }
    $expected = ($line -split '\s+')[0].ToLower()
    $actual = (Get-FileHash "$dl\gitlab-runner-windows-amd64.exe" -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) { throw "gitlab-runner SHA256 不符:$actual / $expected" }
    Copy-Item "$dl\gitlab-runner-windows-amd64.exe" $runnerExe
}
& $runnerExe --version | Select-Object -First 2

# 2. Git for Windows
Step 'Git for Windows'
$gitExe = 'C:\Program Files\Git\cmd\git.exe'
if (-not (Test-Path $gitExe)) {
    $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
    $asset = $rel.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' } | Select-Object -First 1
    if (-not $asset) { throw '找不到 Git 64-bit 安裝檔' }
    Invoke-WebRequest $asset.browser_download_url -OutFile "$dl\$($asset.name)" -UseBasicParsing
    $p = Start-Process "$dl\$($asset.name)" -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/COMPONENTS=gitlfs' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Git 安裝失敗:$($p.ExitCode)" }
}
Add-MachinePath 'C:\Program Files\Git\cmd'
& $gitExe --version

# 3. .NET SDK 8(WiX 5 需要)
Step '.NET SDK 8'
$dotnetDir = 'C:\Program Files\dotnet'
if (-not (Test-Path "$dotnetDir\sdk") -or -not (Get-ChildItem "$dotnetDir\sdk" -Directory | Where-Object Name -like '8.*')) {
    Invoke-WebRequest 'https://dot.net/v1/dotnet-install.ps1' -OutFile "$dl\dotnet-install.ps1" -UseBasicParsing
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$dl\dotnet-install.ps1" -Channel 8.0 -InstallDir $dotnetDir -NoPath
    if ($LASTEXITCODE -ne 0) { throw '.NET SDK 安裝失敗' }
}
Add-MachinePath $dotnetDir
[Environment]::SetEnvironmentVariable('DOTNET_CLI_TELEMETRY_OPTOUT', '1', 'Machine')
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
& "$dotnetDir\dotnet.exe" --version

# 4. WiX 5.0.2(不可 v6 以上;裝到固定路徑而非個人 global tool,服務帳號才找得到)
Step 'WiX 5.0.2'
$wixDir = 'C:\Tools\wix'
if (-not (Test-Path "$wixDir\wix.exe")) {
    & "$dotnetDir\dotnet.exe" tool install wix --version 5.0.2 --tool-path $wixDir
    if ($LASTEXITCODE -ne 0) { throw 'WiX 安裝失敗' }
}
Add-MachinePath $wixDir
& "$wixDir\wix.exe" --version

# 5. Rust(MSVC,stable)。工具鏈放 C:\Rust\rustup(唯讀共用);CARGO_HOME(registry 快取)由 Runner config 另設到 C:\ci\cargo-home
Step 'Rust stable-x86_64-pc-windows-msvc'
[Environment]::SetEnvironmentVariable('RUSTUP_HOME', 'C:\Rust\rustup', 'Machine')
$env:RUSTUP_HOME = 'C:\Rust\rustup'
$env:CARGO_HOME = 'C:\Rust\cargo'
if (-not (Test-Path 'C:\Rust\cargo\bin\cargo.exe')) {
    Invoke-WebRequest 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile "$dl\rustup-init.exe" -UseBasicParsing
    & "$dl\rustup-init.exe" -y --no-modify-path --profile minimal --default-toolchain stable-x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'rustup 安裝失敗' }
}
Add-MachinePath 'C:\Rust\cargo\bin'
& 'C:\Rust\cargo\bin\rustc.exe' --version
& 'C:\Rust\cargo\bin\cargo.exe' --version

# 6. PowerShell 7:Runner 的 shell 必須是 pwsh。shell = "powershell"(5.1)在 CP950 系統解析 Runner 產生的 UTF-8 腳本會失敗(UnexpectedToken)
Step 'PowerShell 7'
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'
if (-not (Test-Path $pwsh)) {
    $rel = Invoke-RestMethod 'https://api.github.com/repos/PowerShell/PowerShell/releases/latest' -UseBasicParsing
    $asset = $rel.assets | Where-Object { $_.name -match '^PowerShell-[\d.]+-win-x64\.msi$' } | Select-Object -First 1
    if (-not $asset) { throw '找不到 PowerShell win-x64 MSI' }
    $msi = "$dl\$($asset.name)"
    Invoke-WebRequest $asset.browser_download_url -OutFile $msi -UseBasicParsing
    $sig = Get-AuthenticodeSignature $msi
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw "MSI 簽章不符:$($sig.Status) $($sig.SignerCertificate.Subject)" }
    $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/quiet', '/norestart', 'ADD_PATH=1', 'ENABLE_PSREMOTING=0', 'REGISTER_MANIFEST=1', 'DISABLE_TELEMETRY=1' -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010) { throw "PowerShell 安裝失敗:$($p.ExitCode)" }
}
& $pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'

# 7. Visual Studio 2022 Build Tools(C++ 桌面開發:MSVC + Windows SDK);最久(約 20 分鐘、5 GB),放最後
Step 'VS 2022 Build Tools(VCTools)'
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$hasVc = if (Test-Path $vswhere) { & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if ($SkipBuildTools) { Write-Host '  略過(-SkipBuildTools)' }
elseif ($hasVc) { Write-Host "  已安裝:$hasVc" }
else {
    Invoke-WebRequest 'https://aka.ms/vs/17/release/vs_buildtools.exe' -OutFile "$dl\vs_buildtools.exe" -UseBasicParsing
    $p = Start-Process "$dl\vs_buildtools.exe" -ArgumentList '--quiet', '--wait', '--norestart', '--nocache',
        '--add', 'Microsoft.VisualStudio.Workload.VCTools', '--includeRecommended' -Wait -PassThru
    # 3010 = 成功但需重開機
    if ($p.ExitCode -notin 0, 3010) { throw "VS Build Tools 安裝失敗:$($p.ExitCode)(記錄在 %TEMP%\dd_*.log)" }
    Write-Host "  完成(exit $($p.ExitCode))"
}
Write-Host "`n全部完成"
