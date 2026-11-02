//! Terminal tabs: a shell (PowerShell, Command Prompt, bash…) in a pseudo
//! console (ConPTY on Windows). What it prints goes to the page as
//! `term-data` events (base64, since a read can end inside a character); the
//! page writes the keys typed in it back. `term-exit` says the shell ended.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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
        let out = app.clone();
        self.start(
            id,
            cwd,
            cols,
            rows,
            kind,
            move |id, bytes| {
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                let _ = out.emit("term-data", Data { id, data });
            },
            move |id| {
                let _ = app.emit("term-exit", id);
            },
        )
    }

    /// Starts the shell; `on_data` gets what it prints, `on_exit` is called once it has ended.
    #[allow(clippy::too_many_arguments)]
    fn start(
        &self,
        id: u32,
        cwd: &str,
        cols: u16,
        rows: u16,
        kind: &str,
        on_data: impl Fn(u32, &[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<(), String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut cmd = shell(kind);
        if std::path::Path::new(cwd).is_dir() {
            cmd.cwd(cwd);
        }
        allow_ctrl_c();
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        self.0.lock().unwrap().insert(id, Session { writer, master: pair.master, killer });
        // What it prints, until the console closes.
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_data(id, &buf[..n]),
                }
            }
            on_exit(id);
        });
        // When the shell ends (`exit`), its console is closed, which ends the
        // reading above: on Windows the output doesn't end by itself while
        // the pseudo console is open.
        let terms = self.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            terms.take(id);
        });
        Ok(())
    }

    /// Takes a terminal out of the list and closes its console.
    fn take(&self, id: u32) -> Option<Session> {
        let s = self.0.lock().unwrap().remove(&id);
        s // dropped by the caller, outside the lock (closing waits for the console)
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
        if let Some(mut s) = self.take(id) {
            let _ = s.killer.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::Child;

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

    /// A terminal opened as the app opens one ends when its shell does
    /// (`exit`), so its tab closes; on Windows that needs the console closed.
    #[test]
    fn exit_ends_the_terminal() {
        let terms = Terms::default();
        let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<u8>>>();
        let data = tx.clone();
        let dir = std::env::temp_dir();
        terms
            .start(7, &dir.to_string_lossy(), 80, 24, "auto", move |_, b| { let _ = data.send(Some(b.to_vec())); }, move |_| { let _ = tx.send(None); })
            .unwrap();
        let mut out = Vec::new();
        let mut answered = false;
        let mut prompted = false;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut ended = false;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(Some(b)) => out.extend_from_slice(&b),
                Ok(None) => { ended = true; break; }
                Err(_) => {}
            }
            let t = String::from_utf8_lossy(&out).to_string();
            if !answered && t.contains("\x1b[6n") {
                terms.write(7, "\x1b[1;1R").unwrap();
                answered = true;
            }
            if !prompted && (t.contains('>') || t.contains('$') || t.contains('#')) {
                prompted = true;
                std::thread::sleep(std::time::Duration::from_millis(500));
                terms.write(7, "exit\r").unwrap();
            }
        }
        assert!(prompted && ended, "prompted {prompted} ended {ended}: {:?}", String::from_utf8_lossy(&out));
        // the shell's end is seen by the reader and the waiter, in either order
        let gone = (0..50).any(|_| { std::thread::sleep(std::time::Duration::from_millis(100)); terms.0.lock().unwrap().is_empty() });
        assert!(gone, "the session is gone");
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
