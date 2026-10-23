; The app was called "Finder for Windows" before. Installing Winfinder (also as an
; update) quietly removes that install, so there aren't two. Settings stay: a
; silent uninstall never deletes app data, and Winfinder moves it over from the
; old folders when it first starts (see move_old_settings in lib.rs).
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
