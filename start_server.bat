@echo off
title Pollen Escape Server
cd /d %~dp0server
if not exist .env.local (
  echo [WARN] Missing server\.env.local
  echo Please create it with WECHAT_APPID and WECHAT_SECRET.
)
if exist .env.local (
  findstr /C:"REPLACE_WITH_YOUR_MINIPROGRAM_SECRET" .env.local >nul
  if %errorlevel%==0 (
    echo [WARN] Please set WECHAT_SECRET in server\.env.local before WeChat login.
  )
)
echo Starting Pollen Escape Flask Server...
python app.py
pause
