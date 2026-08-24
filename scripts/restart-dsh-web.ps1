# dsh-connect install: delayed restart of dsh web (detached)
Start-Sleep -Seconds 8
$conns = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    Write-Host "stopping old dsh web PID $_"
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
} else {
  Write-Host "no listener on 3080, skipping stop"
}
Start-Process -FilePath "cmd.exe" -ArgumentList '/c start "dsh web" /D "C:\code\dsh_feishu" dsh web'
Write-Host "dsh web restart triggered. Refresh http://127.0.0.1:3080 in a few seconds."
