
$desk = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path $desk 'LaunchPad 项目启动面板.lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = 'D:\\@DevCode\\002-project\\000-startup\\project-startup\start.bat'
$lnk.WorkingDirectory = 'D:\\@DevCode\\002-project\\000-startup\\project-startup'
$lnk.IconLocation = 'D:\\@DevCode\\002-project\\000-startup\\project-startup\icon.ico,0'
$lnk.WindowStyle = 7
$lnk.Description = 'LaunchPad 项目启动面板'
$lnk.Save()
Write-Output ('OK: ' + $lnkPath)
