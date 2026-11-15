//! The native shell around the same web UI the PWA serves. All agent traffic goes
//! to the gateway; this crate is where native mic, push and share will live.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Lumbridge");
}
