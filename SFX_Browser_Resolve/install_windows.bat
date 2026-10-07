@echo off
rem Installs SFX Browser into DaVinci Resolve Studio (Windows). Right-click -> Run as administrator.
setlocal
set "SRC=%~dp0"
set "DEST=%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\SFX Browser"
set "SDK=%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node"

net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click install_windows.bat and choose "Run as administrator".
  pause
  exit /b 1
)

echo Installing SFX Browser to:
echo   %DEST%
robocopy "%SRC%." "%DEST%" /MIR /XD test .git /XF install_*.* .gitignore >nul
if not exist "%DEST%\WorkflowIntegration.node" if exist "%SDK%" copy /Y "%SDK%" "%DEST%\" >nul
if not exist "%DEST%\WorkflowIntegration.node" echo WARNING: WorkflowIntegration.node not found. See README.md.
echo Done. Restart DaVinci Resolve and open Workspace ^> Workflow Integrations ^> SFX Browser.
pause
