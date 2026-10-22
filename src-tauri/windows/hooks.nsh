; Runs after install and after each update: makes Windows drop its cached
; icons so a new app icon shows up on the taskbar and in Start right away.
!macro NSIS_HOOK_POSTINSTALL
  ExecWait '"$SYSDIR\ie4uinit.exe" -show'
!macroend
