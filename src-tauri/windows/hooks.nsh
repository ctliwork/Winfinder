; The app was called "Finder for Windows" before. Installing WinFinder (also as an
; update) quietly removes that install, so there aren't two. Settings stay: they
; belong to the app's identifier, which didn't change, and a silent uninstall
; never deletes app data.
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Finder for Windows" "UninstallString"
  StrCmp $0 "" +2
  ExecWait '$0 /S'
!macroend

; Runs after install and after each update: makes Windows drop its cached
; icons so a new app icon shows up on the taskbar and in Start right away.
!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$SYSDIR\ie4uinit.exe" -show'
!macroend
