// Tauri 壳只负责窗口和系统安全存储；消息与审批仍走本机 HTTP API。
use keyring::Entry;

const KEYRING_SERVICE: &str = "campus-desk";
const KEYRING_USER: &str = "api-token";

fn entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_api_token(token: String) -> Result<(), String> {
    entry()?.set_password(&token).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_api_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn delete_api_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_api_token,
            get_api_token,
            delete_api_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running campus desk");
}
