//! Search inside files through the Windows Search index, the one Explorer's
//! search box uses: words in documents' text and properties as well as names.
//! Only indexed locations are searched (nothing is read file by file), so a
//! folder outside the index is reported rather than crawled.

use crate::fsops::Entry;
use crate::search::Filter;
use serde::Serialize;

#[derive(Serialize)]
pub struct ContentResult {
    pub entries: Vec<Entry>,
    pub partial: bool,
    /// False when Windows doesn't index this folder.
    pub indexed: bool,
}

#[cfg(windows)]
const LIMIT: usize = 500;

#[cfg(windows)]
pub fn search(root: &str, query: &str, filter: &Filter) -> Result<ContentResult, String> {
    use crate::fsops::entry_from;
    use windows::core::HSTRING;
    use windows::Storage::Search::{FolderDepth, IndexedState, IndexerOption, QueryOptions};
    use windows::Storage::StorageFolder;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    let err = |e: windows::core::Error| e.message();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let folder = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(root)).map_err(err)?.get().map_err(err)?;
    if folder.GetIndexedStateAsync().map_err(err)?.get().map_err(err)? == IndexedState::NotIndexed {
        return Ok(ContentResult { entries: Vec::new(), partial: false, indexed: false });
    }
    let opts = QueryOptions::new().map_err(err)?;
    opts.SetFolderDepth(FolderDepth::Deep).map_err(err)?;
    opts.SetIndexerOption(IndexerOption::OnlyUseIndexer).map_err(err)?;
    opts.SetUserSearchFilter(&HSTRING::from(query)).map_err(err)?;
    // The filters apply afterwards, so ask for more than will be shown.
    let files = folder.CreateFileQueryWithOptions(&opts).map_err(err)?.GetFilesAsync(0, (LIMIT * 4) as u32).map_err(err)?.get().map_err(err)?;
    let fetched = files.Size().map_err(err)? as usize;
    let mut entries = Vec::new();
    for f in &files {
        let path = f.Path().map_err(err)?.to_string();
        let e = entry_from(std::path::Path::new(&path), None);
        if filter.passes(&e) {
            entries.push(e);
            if entries.len() == LIMIT {
                break;
            }
        }
    }
    let partial = entries.len() == LIMIT || fetched == LIMIT * 4;
    Ok(ContentResult { entries, partial, indexed: true })
}

#[cfg(not(windows))]
pub fn search(_root: &str, _query: &str, _filter: &Filter) -> Result<ContentResult, String> {
    Err("UNSUPPORTED".into())
}
