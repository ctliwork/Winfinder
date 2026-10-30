//! Windows shell integration that must run on the UI thread: the native
//! Explorer context menu, the Properties dialog and the file clipboard shared
//! with Explorer (CF_HDROP + "Preferred DropEffect"). Also deleting to the
//! Recycle Bin with Explorer's dialogs (any thread).

use std::cell::RefCell;
use windows::core::{Interface, PCSTR, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
use windows::Win32::System::Ole::CF_HDROP;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    DefSubclassProc, DragQueryFileW, IContextMenu, IContextMenu2, IContextMenu3, ILFindLastID, IShellFolder, RemoveWindowSubclass,
    SHBindToParent, SHGetDesktopFolder, SHParseDisplayName, SetWindowSubclass, CMF_EXTENDEDVERBS, CMF_NORMAL, CMIC_MASK_PTINVOKE,
    CMIC_MASK_SHIFT_DOWN, CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX, DROPFILES, GCS_VERBW, HDROP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, InsertMenuW, TrackPopupMenuEx, HMENU, MENU_ITEM_FLAGS, MF_BYPOSITION,
    MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING, SW_SHOWNORMAL, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_DRAWITEM,
    WM_INITMENUPOPUP, WM_MEASUREITEM, WM_MENUCHAR,
};

// Not exported by the windows crate (it's an ANSI/Unicode switch in shobjidl).
const CMIC_MASK_UNICODE: u32 = 0x4000;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// Owns an absolute PIDL.
struct Pidl(*mut ITEMIDLIST);
impl Drop for Pidl {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0 as _)) }
    }
}
fn pidl(path: &str) -> Result<Pidl, String> {
    let mut p = std::ptr::null_mut();
    let w = wide(path);
    unsafe { SHParseDisplayName(PCWSTR(w.as_ptr()), None, &mut p, 0, None) }.map_err(|e| e.message())?;
    Ok(Pidl(p))
}

/// The context menu for `paths` (all in one folder), or for the background of
/// `paths[0]` when `background` is set.
fn context_menu(hwnd: HWND, paths: &[String], background: bool) -> Result<IContextMenu, String> {
    unsafe {
        if background {
            let dir = pidl(paths.first().ok_or("ENOENT")?)?;
            let desktop = SHGetDesktopFolder().map_err(|e| e.message())?;
            // The desktop itself has an empty PIDL and can't bind to itself.
            let folder: IShellFolder =
                if (*dir.0).mkid.cb == 0 { desktop } else { desktop.BindToObject(dir.0, None).map_err(|e| e.message())? };
            return folder.CreateViewObject(hwnd).map_err(|e| e.message());
        }
        let pidls = paths.iter().map(|p| pidl(p)).collect::<Result<Vec<_>, _>>()?;
        let first = pidls.first().ok_or("ENOENT")?;
        let parent: IShellFolder = SHBindToParent(first.0, None).map_err(|e| e.message())?;
        let children: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| ILFindLastID(p.0) as *const _).collect();
        parent.GetUIObjectOf(hwnd, &children, None).map_err(|e| e.message())
    }
}

thread_local! {
    // The menu being shown, so the subclass can route owner-drawn and lazy
    // submenu messages (Send to, Open with…) to it.
    static ACTIVE: RefCell<Option<IContextMenu>> = const { RefCell::new(None) };
}

unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
    if matches!(msg, WM_INITMENUPOPUP | WM_DRAWITEM | WM_MEASUREITEM | WM_MENUCHAR) {
        let handled = ACTIVE.with(|a| {
            let a = a.borrow();
            let cm = a.as_ref()?;
            if let Ok(cm3) = cm.cast::<IContextMenu3>() {
                let mut out = LRESULT(0);
                unsafe { cm3.HandleMenuMsg2(msg, wp, lp, Some(&mut out)) }.ok()?;
                return Some(out);
            }
            let cm2 = cm.cast::<IContextMenu2>().ok()?;
            unsafe { cm2.HandleMenuMsg(msg, wp, lp) }.ok()?;
            Some(LRESULT(0))
        });
        if let Some(r) = handled {
            return r;
        }
    }
    unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
}

fn verb_of(cm: &IContextMenu, id: u32) -> String {
    let mut buf = [0u16; 128];
    unsafe {
        let ok = cm.GetCommandString(id as usize, GCS_VERBW, None, windows::core::PSTR(buf.as_mut_ptr() as _), buf.len() as u32);
        if ok.is_err() {
            return String::new();
        }
    }
    String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(0)])
}

fn invoke(cm: &IContextMenu, hwnd: HWND, verb: PCSTR, verb_w: PCWSTR, pt: POINT, shift: bool) -> Result<(), String> {
    let info = CMINVOKECOMMANDINFOEX {
        cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
        fMask: CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE | if shift { CMIC_MASK_SHIFT_DOWN } else { 0 },
        hwnd,
        lpVerb: verb,
        lpVerbW: verb_w,
        nShow: SW_SHOWNORMAL.0,
        ptInvoke: pt,
        ..Default::default()
    };
    unsafe { cm.InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO) }.map_err(|e| e.message())
}

/// An item the app adds to Explorer's menu. `label` "-" is a separator;
/// `children` makes a submenu.
#[derive(serde::Deserialize)]
pub struct Extra {
    #[serde(default)]
    pub id: u32,
    pub label: String,
    #[serde(default)]
    pub checked: bool,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub children: Vec<Extra>,
}

// App items get command ids above the shell's range (1..0x7FFF).
const APP_BASE: u32 = 0x8000;

fn extra_flags(e: &Extra) -> MENU_ITEM_FLAGS {
    let mut f = MF_STRING;
    if e.checked {
        f |= MF_CHECKED;
    }
    if e.disabled {
        f |= MF_GRAYED;
    }
    f
}

/// Inserts `extras` into `menu` starting at `pos` (or appends when `pos` is
/// None). Returns how many top-level entries were added.
unsafe fn add_extras(menu: HMENU, extras: &[Extra], pos: Option<u32>) -> u32 {
    let mut n = 0;
    for e in extras {
        let label = wide(&e.label);
        let (flags, id) = if e.label == "-" {
            (MF_SEPARATOR, 0usize)
        } else if !e.children.is_empty() {
            let Ok(sub) = (unsafe { CreatePopupMenu() }) else { continue };
            unsafe { add_extras(sub, &e.children, None) };
            (extra_flags(e) | MF_POPUP, sub.0 as usize)
        } else {
            (extra_flags(e), (APP_BASE + e.id) as usize)
        };
        let text = PCWSTR(label.as_ptr());
        let ok = match pos {
            Some(p) => unsafe { InsertMenuW(menu, p + n, flags | MF_BYPOSITION, id, text) },
            None => unsafe { AppendMenuW(menu, flags, id, text) },
        };
        if ok.is_ok() {
            n += 1;
        }
    }
    n
}

/// Shows Explorer's context menu at the cursor, with the app's own items at
/// the top, and runs the chosen shell command. Returns "app:<id>" for an app
/// item, "rename" when the app should rename inline, otherwise "".
pub fn show_menu(hwnd: HWND, paths: &[String], background: bool, shift: bool, extras: &[Extra]) -> Result<String, String> {
    let cm = context_menu(hwnd, paths, background)?;
    unsafe {
        let menu = CreatePopupMenu().map_err(|e| e.message())?;
        const FIRST: u32 = 1;
        let flags = CMF_NORMAL | if shift { CMF_EXTENDEDVERBS } else { 0 };
        let hr = cm.QueryContextMenu(menu, 0, FIRST, 0x7FFF, flags);
        if hr.is_err() {
            let _ = DestroyMenu(menu);
            return Err(hr.message());
        }
        if !extras.is_empty() {
            let n = add_extras(menu, extras, Some(0));
            let _ = InsertMenuW(menu, n, MF_BYPOSITION | MF_SEPARATOR, 0, PCWSTR::null());
        }
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        ACTIVE.with(|a| *a.borrow_mut() = Some(cm.clone()));
        let _ = SetWindowSubclass(hwnd, Some(subclass), 0xF1D3, 0);
        let cmd = TrackPopupMenuEx(menu, (TPM_RETURNCMD | TPM_RIGHTBUTTON).0, pt.x, pt.y, hwnd, None).0 as u32;
        let _ = RemoveWindowSubclass(hwnd, Some(subclass), 0xF1D3);
        ACTIVE.with(|a| *a.borrow_mut() = None);
        let result = if cmd >= APP_BASE {
            Ok(format!("app:{}", cmd - APP_BASE))
        } else if cmd >= FIRST {
            let id = cmd - FIRST;
            let verb = verb_of(&cm, id);
            if verb.eq_ignore_ascii_case("rename") {
                Ok("rename".into())
            } else {
                // MAKEINTRESOURCE: the command offset travels in the pointer.
                invoke(&cm, hwnd, PCSTR(id as usize as *const u8), PCWSTR(id as usize as *const u16), pt, shift).map(|_| String::new())
            }
        } else {
            Ok(String::new())
        };
        let _ = DestroyMenu(menu);
        result
    }
}

/// Opens the Properties dialog for `paths` (one or many, same folder).
pub fn properties(hwnd: HWND, paths: &[String]) -> Result<(), String> {
    let cm = context_menu(hwnd, paths, false)?;
    let mut pt = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut pt);
        let menu = CreatePopupMenu().map_err(|e| e.message())?;
        // Some handlers only accept verbs after the menu was built.
        let _ = cm.QueryContextMenu(menu, 0, 1, 0x7FFF, CMF_NORMAL);
        let w = wide("properties");
        let r = invoke(&cm, hwnd, windows::core::s!("properties"), PCWSTR(w.as_ptr()), pt, false);
        let _ = DestroyMenu(menu);
        r
    }
}

// ---------- clipboard ----------

fn drop_effect_format() -> u32 {
    unsafe { RegisterClipboardFormatW(windows::core::w!("Preferred DropEffect")) }
}

/// Puts files on the clipboard the way Explorer does, so Explorer, the
/// desktop and other apps can paste them. `cut` marks them for moving.
pub fn clipboard_write(hwnd: HWND, paths: &[String], cut: bool) -> Result<(), String> {
    let mut list: Vec<u16> = Vec::new();
    for p in paths {
        list.extend(p.encode_utf16());
        list.push(0);
    }
    list.push(0);
    let header = std::mem::size_of::<DROPFILES>();
    unsafe {
        OpenClipboard(Some(hwnd)).map_err(|e| e.message())?;
        let result = (|| {
            EmptyClipboard().map_err(|e| e.message())?;
            let h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, header + list.len() * 2).map_err(|e| e.message())?;
            let p = GlobalLock(h) as *mut u8;
            let df = p as *mut DROPFILES;
            (*df).pFiles = header as u32;
            (*df).fWide = true.into();
            std::ptr::copy_nonoverlapping(list.as_ptr() as *const u8, p.add(header), list.len() * 2);
            let _ = GlobalUnlock(h);
            SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(h.0))).map_err(|e| e.message())?;
            // DROPEFFECT_MOVE = 2; Explorer uses COPY | LINK = 5 for copies.
            let e = GlobalAlloc(GMEM_MOVEABLE, 4).map_err(|e| e.message())?;
            *(GlobalLock(e) as *mut u32) = if cut { 2 } else { 5 };
            let _ = GlobalUnlock(e);
            SetClipboardData(drop_effect_format(), Some(HANDLE(e.0))).map_err(|e| e.message())?;
            Ok(())
        })();
        let _ = CloseClipboard();
        result
    }
}

#[derive(serde::Serialize)]
pub struct ClipFiles {
    pub paths: Vec<String>,
    pub cut: bool,
}

/// Files on the clipboard (from this app, Explorer or any other app).
pub fn clipboard_read() -> Option<ClipFiles> {
    unsafe {
        IsClipboardFormatAvailable(CF_HDROP.0 as u32).ok()?;
        OpenClipboard(None).ok()?;
        let result = (|| {
            let h = GetClipboardData(CF_HDROP.0 as u32).ok()?;
            let drop = HDROP(h.0);
            let n = DragQueryFileW(drop, u32::MAX, None);
            let mut paths = Vec::new();
            for i in 0..n {
                let len = DragQueryFileW(drop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(drop, i, Some(&mut buf));
                paths.push(String::from_utf16_lossy(&buf[..len]));
            }
            let cut = GetClipboardData(drop_effect_format())
                .ok()
                .map(|e| {
                    let g = HGLOBAL(e.0);
                    let v = *(GlobalLock(g) as *const u32);
                    let _ = GlobalUnlock(g);
                    v & 2 != 0 && v & 1 == 0
                })
                .unwrap_or(false);
            Some(ClipFiles { paths, cut })
        })();
        let _ = CloseClipboard();
        result
    }
}

/// Explorer empties the clipboard after pasting cut files.
pub fn clipboard_clear(hwnd: HWND) {
    unsafe {
        if OpenClipboard(Some(hwnd)).is_ok() {
            let _ = EmptyClipboard();
            let _ = CloseClipboard();
        }
    }
}

/// Moves `paths` to the Recycle Bin as Explorer does, Windows' own dialogs
/// included, over `hwnd`: administrator permission (Continue, then UAC), a file
/// in use (Try Again), too big for the Recycle Bin (delete it for good?).
/// Asking first is the app's own setting, so Windows' confirmations are
/// answered yes. Runs on any thread (its own STA); returns the paths still there.
pub fn recycle(hwnd: HWND, paths: &[String]) -> Vec<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_WANTNUKEWARNING,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let run = || -> windows::core::Result<()> {
            let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
            op.SetOwnerWindow(hwnd)?;
            op.SetOperationFlags(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING)?;
            for p in paths {
                if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(p.as_str()), None) {
                    op.DeleteItem(&item, None)?;
                }
            }
            op.PerformOperations() // fails when cancelled; what went is checked below
        };
        let _ = run();
    }
    paths.iter().filter(|p| std::path::Path::new(p.as_str()).symlink_metadata().is_ok()).cloned().collect()
}

/// Drags files out as Explorer does: SHDoDragDrop with the shell's own data
/// object, so the drag shows the files' icons and "Copy to …", and resting on a
/// taskbar button brings that app's window forward to drop into. Copy, move or
/// link, as the target chooses. UI thread; returns once dropped or cancelled.
pub fn drag_files(hwnd: HWND, paths: &[String]) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{IDropSource, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE};
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHCreateShellItemArrayFromIDLists, SHDoDragDrop, BHID_DataObject};
    unsafe {
        let pidls: Vec<*mut ITEMIDLIST> =
            paths.iter().map(|p| ILCreateFromPathW(&HSTRING::from(p.as_str()))).filter(|p| !p.is_null()).collect();
        if pidls.is_empty() {
            return Err("ENOENT".into());
        }
        let list: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| p.cast_const()).collect();
        let res = (|| -> windows::core::Result<()> {
            let items = SHCreateShellItemArrayFromIDLists(&list)?;
            let data: IDataObject = items.BindToHandler(None, &BHID_DataObject)?;
            // Resting on an app's taskbar button brings its window up; the taskbar
            // (Explorer) does that, and Windows lets a program come to the front
            // only if the one in front (this one, running the drag) allows it.
            let _ = windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(windows::Win32::UI::WindowsAndMessaging::ASFW_ANY);
            SHDoDragDrop(Some(hwnd), &data, None::<&IDropSource>, DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK)?;
            Ok(())
        })();
        for p in pidls {
            ILFree(Some(p));
        }
        res.map_err(|e| e.message())
    }
}
