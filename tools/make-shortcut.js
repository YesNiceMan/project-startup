/**
 * 在桌面创建 LaunchPad 启动快捷方式（带品牌图标、最小化窗口）
 * 用 UTF-8 BOM 写出 ps1，避免 PowerShell 5.1 中文乱码。
 * 用法：node tools/make-shortcut.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const root = path.resolve(dir, '..');

const ps = `
$desk = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path $desk 'LaunchPad \\u9879\\u76ee\\u542f\\u52a8\\u9762\\u677f.lnk'
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = '${root.replace(/\\/g, '\\\\')}\\start.bat'
$lnk.WorkingDirectory = '${root.replace(/\\/g, '\\\\')}'
$lnk.IconLocation = '${root.replace(/\\/g, '\\\\')}\\icon.ico,0'
$lnk.WindowStyle = 7
$lnk.Description = 'LaunchPad \\u9879\\u76ee\\u542f\\u52a8\\u9762\\u677f'
$lnk.Save()
Write-Output ('OK: ' + $lnkPath)
`;

// \uXXXX 转义在 PowerShell 字符串里同样生效，直接写文件（带 BOM）
const psReal = ps.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
fs.writeFileSync(path.join(dir, 'create-shortcut.ps1'), '\ufeff' + psReal, 'utf8');
console.log('create-shortcut.ps1 已生成');
