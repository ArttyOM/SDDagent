@echo off
setlocal
set APP_DIR=%~dp0
if exist "%APP_DIR%tools\node\node.exe" (
  "%APP_DIR%tools\node\node.exe" "%APP_DIR%server.js"
) else (
  node "%APP_DIR%server.js"
)
