# dsh-connect 一键重建 + 重启 dsh web
# 用法：在 PowerShell 里执行  .\scripts\reload.ps1
# 工作区根从脚本位置推导，不再硬编码机器路径。
$ws = Split-Path -Parent $PSScriptRoot
Set-Location $ws

Write-Host "[1/3] 按依赖顺序重建 6 个插件（含 connect-all）..." -ForegroundColor Cyan
node "$ws\node_modules\typescript\bin\tsc" -p "$ws\packages\connect\tsconfig.json"
if ($LASTEXITCODE -ne 0) { Write-Host "connect 构建失败，已中止（未重启）" -ForegroundColor Red; exit 1 }
node "$ws\node_modules\typescript\bin\tsc" -p "$ws\packages\connect-web\tsconfig.json"
if ($LASTEXITCODE -ne 0) { Write-Host "connect-web 构建失败，已中止（未重启）" -ForegroundColor Red; exit 1 }
node "$ws\node_modules\typescript\bin\tsc" -p "$ws\packages\connect-feishu\tsconfig.json"
if ($LASTEXITCODE -ne 0) { Write-Host "connect-feishu 构建失败，已中止（未重启）" -ForegroundColor Red; exit 1 }
node "$ws\node_modules\typescript\bin\tsc" -p "$ws\packages\connect-telegram\tsconfig.json"
if ($LASTEXITCODE -ne 0) { Write-Host "connect-telegram 构建失败，已中止（未重启）" -ForegroundColor Red; exit 1 }
node "$ws\node_modules\typescript\bin\tsc" -p "$ws\packages\connect-dingtalk\tsconfig.json"
if ($LASTEXITCODE -ne 0) { Write-Host "connect-dingtalk 构建失败，已中止（未重启）" -ForegroundColor Red; exit 1 }
# connect-all depends on each channel's lib/, so build it last.
node "$ws\node_modules\typescript\bin\tsc" -p "$ws\packages\connect-all\tsconfig.json"
if ($LASTEXITCODE -ne 0) { Write-Host "connect-all 构建失败，已中止（未重启）" -ForegroundColor Red; exit 1 }

Write-Host "[2/3] 停止旧 dsh web（占用 3080 端口的进程）..." -ForegroundColor Cyan
$conns = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    Write-Host "  停止进程 PID $_"
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
} else {
  Write-Host "  未发现监听 3080 的进程，跳过"
}

Write-Host "[3/3] 在新窗口启动 dsh web..." -ForegroundColor Cyan
Start-Process -FilePath "cmd.exe" -ArgumentList "/c start `"dsh web`" /D `"$ws`" dsh web"
Write-Host "完成。几秒后刷新 http://127.0.0.1:3080" -ForegroundColor Green
