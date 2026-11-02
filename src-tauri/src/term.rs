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

/// The keys typed, as the pseudo console takes them. On Windows it runs in
/// "win32 input mode" (portable-pty asks for it), where Ctrl+C sent as its
/// control character is typed as text and doesn't interrupt the command
/// running: it goes as the key press (Ctrl down, C down and up) instead.
fn keys(data: &str) -> std::borrow::Cow<'_, str> {
    // ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _  (C: VK 0x43, scan code 0x2E; left Ctrl pressed)
    const CTRL_C: &str = "\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_";
    if cfg!(windows) && data.contains('\x03') {
        data.replace('\x03', CTRL_C).into()
    } else {
        data.into()
    }
}

/// A program started in a new process group (as some launchers do, and
/// Node's `detached`) ignores Ctrl+C, and the shells it starts inherit that,
/// so Ctrl+C wouldn't stop the command running: they handle it again.
fn allow_ctrl_c() {
    #[cfg(windows)]
    unsafe {
        let _ = windows::Win32::System::Console::SetConsoleCtrlHandler(None, false);
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
        allow_ctrl_c();
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
        s.writer.write_all(keys(data).as_bytes()).and_then(|_| s.writer.flush()).map_err(|e| e.to_string())
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

    /// A shell in a pseudo console, as a terminal tab runs it, read into a buffer.
    struct Shell {
        writer: Box<dyn Write + Send>,
        out: Arc<Mutex<Vec<u8>>>,
        child: Box<dyn Child + Send + Sync>,
        answered: bool,
    }
    impl Shell {
        fn start() -> Shell {
            let pty = native_pty_system();
            let pair = pty.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
            let mut cmd = shell("auto");
            cmd.cwd(std::env::temp_dir());
            allow_ctrl_c(); // as Terms::open does
            let child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            let writer = pair.master.take_writer().unwrap();
            std::mem::forget(pair.master); // closing it waits on the output; the test process ends anyway
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
            Shell { writer, out, child, answered: false }
        }
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.out.lock().unwrap()).to_string()
        }
        /// Typed keys, as Terms::write sends them.
        fn send(&mut self, s: &str) {
            self.writer.write_all(keys(s).as_bytes()).unwrap();
            self.writer.flush().unwrap();
        }
        /// Waits up to 20 s for `done`, answering the console's cursor position
        /// query (ESC[6n, which ConPTY sends first and waits on; xterm.js answers it in the app).
        fn wait(&mut self, done: impl Fn(&str) -> bool) -> bool {
            for _ in 0..200 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                let t = self.text();
                if !self.answered && t.contains("\x1b[6n") {
                    self.send("\x1b[1;1R");
                    self.answered = true;
                }
                if done(&t) {
                    return true;
                }
            }
            false
        }
        fn prompt(&mut self) -> bool {
            self.wait(|t| t.contains('>') || t.contains('$') || t.contains('#'))
        }
        /// Starts a long command, presses Ctrl+C, and says whether the shell takes a command again.
        fn interrupts(&mut self, mark: &str) -> bool {
            self.send("Start-Sleep 60\r");
            std::thread::sleep(std::time::Duration::from_millis(2000));
            self.send("\x03");
            std::thread::sleep(std::time::Duration::from_millis(500));
            self.send(&format!("echo {mark}\r"));
            self.wait(|t| t.matches(mark).count() >= 2)
        }
    }
    impl Drop for Shell {
        fn drop(&mut self) {
            let _ = self.child.kill();
        }
    }

    /// A shell starts, runs what is typed and prints its output.
    #[test]
    fn runs_a_shell() {
        let mut sh = Shell::start();
        assert!(sh.prompt(), "no prompt: {:?}", sh.text());
        sh.send("echo winfinder-term-ok\r");
        // the echoed command and its output: twice
        assert!(sh.wait(|t| t.matches("winfinder-term-ok").count() >= 2), "output: {:?}", sh.text());
    }

    /// Ctrl+C stops the command running in PowerShell, also after what
    /// xterm.js sends besides the keys typed: focus reports, Escape, arrows.
    #[cfg(windows)]
    #[test]
    fn ctrl_c_interrupts() {
        let cases: [(&str, &[&str]); 5] = [
            ("plain", &[]),
            ("focus", &["\x1b[I"]),
            ("escape", &["\x1b"]),
            ("arrows", &["echo a\r", "\x1b[A", "\x1b"]),
            ("ignoring", &[]),
        ];
        let mut failed = Vec::new();
        for (name, before) in cases {
            if name == "ignoring" {
                // as when started in a new process group: Ctrl+C ignored, which the shell would inherit
                unsafe { windows::Win32::System::Console::SetConsoleCtrlHandler(None, true).unwrap() };
            }
            let mut sh = Shell::start();
            assert!(sh.prompt(), "{name}: no prompt: {:?}", sh.text());
            for b in before {
                sh.send(b);
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            if !sh.interrupts(&format!("after-{name}")) {
                failed.push(format!("{name}: {:?}", sh.text().chars().rev().take(400).collect::<String>().chars().rev().collect::<String>()));
            }
        }
        assert!(failed.is_empty(), "Ctrl+C didn't interrupt after: {failed:#?}");
    }
}
