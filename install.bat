@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title pi-brain installer

:: pi-brain installer — project vs global
:: Source is the pi-brain folder next to this script
set "SRC=%~dp0pi-brain"
if not exist "%SRC%\index.ts" (
  echo [error] Source not found: "%SRC%\index.ts"
  echo         Make sure install.bat is next to the pi-brain folder.
  pause
  exit /b 1
)

echo.
echo  pi-brain installer
echo  ==================
echo  Source: %SRC%
echo.
echo  [1] Project  - .pi\extensions\pi-brain  (this repo only)
echo  [2] Global   - %%USERPROFILE%%\.pi\agent\extensions\pi-brain  (all projects)
echo  [3] Both
echo.

choice /c 123 /n /m "  Select [1=Project, 2=Global, 3=Both]: "
set "CHOICE=%ERRORLEVEL%"

if "%CHOICE%"=="1" goto :project
if "%CHOICE%"=="2" goto :global
if "%CHOICE%"=="3" goto :both
echo [error] Invalid choice.
exit /b 1

:project
call :install "%SRC%" "%~dp0.pi\extensions\pi-brain" "%~dp0.pi\skills\pi-brain"
goto :done

:global
call :install "%SRC%" "%USERPROFILE%\.pi\agent\extensions\pi-brain" "%USERPROFILE%\.pi\agent\skills\pi-brain"
goto :done

:both
call :install "%SRC%" "%~dp0.pi\extensions\pi-brain" "%~dp0.pi\skills\pi-brain"
call :install "%SRC%" "%USERPROFILE%\.pi\agent\extensions\pi-brain" "%USERPROFILE%\.pi\agent\skills\pi-brain"
goto :done

:: :install <src> <extDst> <skillDst>
:install
set "S=%~1"
set "ED=%~2"
set "SD=%~3"
echo.
echo  Installing to:
echo    Extension: "%ED%"
echo    Skill:     "%SD%"

mkdir "%ED%" 2>nul
mkdir "%SD%" 2>nul

copy /y "%S%\index.ts" "%ED%\index.ts" >nul
if exist "%S%\docs.html" copy /y "%S%\docs.html" "%ED%\docs.html" >nul
copy /y "%S%\SKILL.md" "%SD%\SKILL.md" >nul
:: cleanup stray skill copy from previous installs
if exist "%ED%\SKILL.md" del /q "%ED%\SKILL.md" >nul 2>&1

if not exist "%ED%\index.ts" (
  echo  [fail] Extension not installed: "%ED%\index.ts"
  exit /b 1
)
if not exist "%SD%\SKILL.md" (
  echo  [fail] Skill not installed: "%SD%\SKILL.md"
  exit /b 1
)
echo  [ok] Installed.
exit /b 0

:done
echo.
echo  Done. Restart pi or run /reload to load the extension.
echo  Verify: pi --list-extensions  or  check pi-brain tools (remember/recall/think/plan)
pause
exit /b 0
