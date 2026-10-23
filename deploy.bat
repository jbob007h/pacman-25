@echo off
rem Double-click to deploy the game server to Fly.io.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
