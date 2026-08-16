@ECHO off
REM dsh-weixin launcher - run from any directory:
REM   dsh-weixin login / run / status / logout / probe
REM Locates its own directory and forwards all args to weixin-bot.mjs
node "%~dp0weixin-bot.mjs" %*
