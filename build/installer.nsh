!macro customInit
  nsExec::Exec '"$LOCALAPPDATA\tabby\Update.exe" --uninstall -s'
!macroend

!macro customInstall
  ; Visual C++ 2015-2022 x64 runtime (native modules such as node-pty need it; without it the app
  ; shows the splash and never loads — upstream #10734, #10782).
  ;
  ; This installer deliberately does NOT bundle a Microsoft binary: see
  ; smartssh/docs/vcredist-decision.md (option A) and app/lib/vcredistPreflight.ts, which detects
  ; the missing runtime before any window is created and offers the official download link.
  ;
  ; Upstream's `File "${BUILD_RESOURCES_DIR}\vc_redist.exe"` is therefore gone. It referenced an
  ; asset this repo does not ship, and `File` is a *compile-time* directive, so makensis aborted the
  ; whole installer build ("no files found") — no setup.exe could be produced at all. `/nonfatal`
  ; only downgrades it to warning 7010, which electron-builder compiles as an error (-WX).
  ;
  ; What remains is the safe half of that feature, with nothing to package: if an operator puts
  ; vc_redist.x64.exe next to the setup.exe (offline / air-gapped installs), the wizard runs that
  ; file. It only ever executes a file the operator supplied — the installer never downloads one.
  IfFileExists "$SYSDIR\vcruntime140.dll" vcredist_installed
    IfFileExists "$EXEDIR\vc_redist.x64.exe" 0 vcredist_installed
      DetailPrint "Installing Visual C++ Redistributable from $EXEDIR..."
      ExecWait '"$EXEDIR\vc_redist.x64.exe" /install /quiet /norestart' $1
      DetailPrint "Visual C++ Redistributable exit code: $1"
  vcredist_installed:
!macroend
