//! Terminal tabs: a shell (PowerShell, Command Prompt, bash…) in a pseudo
//! console (ConPTY on Windows). What it prints goes to the page as
//! `term-data` events (base64, since a read can end inside a character); the
//! page writes the keys typed in it back. `term-exit` says the shell ended.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// The open terminals, by the id the page gave them.
#[derive(Default, Clone)]
pub struct Terms(Arc<Mutex<HashMap<u32, Session>>>);

/// An executable on PATH (with Windows' extensions), like `where`.
fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|d| d.join(name).is_file())
}

/// The shell for `kind`: "auto" (PowerShell 7 when installed, else Windows
/// PowerShell; on other systems $SHELL), "pwsh", "powershell" or "cmd".
fn shell(kind: &str) -> CommandBuilder {
    if cfg!(windows) {
        let exe = match kind {
            "cmd" => "cmd.exe",
            "powershell" => "powershell.exe",
            "pwsh" => "pwsh.exe",
            _ if on_path("pwsh.exe") => "pwsh.exe",
            _ => "powershell.exe",
        };
        let mut cmd = CommandBuilder::new(exe);
        if exe != "cmd.exe" {
            cmd.arg("-NoLogo");
        }
        cmd
    } else {
        let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
        cmd.env("TERM", "xterm-256color");
        cmd
    }
}

#[derive(Clone, serde::Serialize)]
struct Data {
    id: u32,
    data: String,
}

impl Terms {
    pub fn open(&self, app: AppHandle, id: u32, cwd: &str, cols: u16, rows: u16, kind: &str) -> Result<(), String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut cmd = shell(kind);
        if std::path::Path::new(cwd).is_dir() {
            cmd.cwd(cwd);
        }
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave); // the shell holds its end; reading ends when it exits
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        self.0.lock().unwrap().insert(id, Session { writer, master: pair.master, child });
        let terms = self.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app.emit("term-data", Data { id, data });
                    }
                }
            }
            terms.close(id);
            let _ = app.emit("term-exit", id);
        });
        Ok(())
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut map = self.0.lock().unwrap();
        let s = map.get_mut(&id).ok_or("closed")?;
        s.writer.write_all(data.as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.0.lock().unwrap();
        let s = map.get(&id).ok_or("closed")?;
        s.master
            .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    /// Ends the shell (and what it runs); the reader then reports `term-exit`.
    pub fn close(&self, id: u32) {
        if let Some(mut s) = self.0.lock().unwrap().remove(&id) {
            let _ = s.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell starts in the folder given, runs what is typed and reports its output.
    #[test]
    fn runs_a_shell() {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let dir = std::env::temp_dir();
        let mut cmd = shell("auto");
        cmd.cwd(&dir);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        std::thread::sleep(std::time::Duration::from_millis(if cfg!(windows) { 3000 } else { 500 }));
        writer.write_all(b"echo winfinder-term-ok\r").unwrap();
        writer.flush().unwrap();
        let mut seen = false;
        for _ in 0..100 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let text = String::from_utf8_lossy(&out.lock().unwrap()).to_string();
            // the echoed command and its output: twice
            if text.matches("winfinder-term-ok").count() >= 2 {
                seen = true;
                break;
            }
        }
        let _ = child.kill();
        assert!(seen, "output: {}", String::from_utf8_lossy(&out.lock().unwrap()));
    }
}
