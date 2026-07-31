use getrandom::fill;
use serde::{Deserialize, Serialize};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process,
};

use super::protocol::PROTOCOL_VERSION;

const CONFIG_FILE_NAME: &str = "automation-v1.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationConfig {
    pub version: u32,
    pub pipe_name: String,
    pub token: String,
}

pub fn pipe_name_for_sid(sid: &str) -> String {
    format!(r"\\.\pipe\cmux-windows-v{PROTOCOL_VERSION}-{sid}")
}

pub fn config_path() -> io::Result<PathBuf> {
    let local_app_data = env::var_os("LOCALAPPDATA").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "LOCALAPPDATA is not available for the current Windows user",
        )
    })?;

    Ok(PathBuf::from(local_app_data)
        .join("cmux-windows")
        .join(CONFIG_FILE_NAME))
}

pub fn load_or_create(pipe_name: &str) -> io::Result<AutomationConfig> {
    let path = config_path()?;
    if let Ok(existing) = load_valid(&path, pipe_name) {
        return Ok(existing);
    }

    let token = generate_token()?;
    let config = AutomationConfig {
        version: PROTOCOL_VERSION,
        pipe_name: pipe_name.to_owned(),
        token,
    };
    write_atomic(&path, &config)?;
    Ok(config)
}

pub fn load() -> io::Result<AutomationConfig> {
    let path = config_path()?;
    let content = fs::read_to_string(&path)?;
    let config: AutomationConfig = serde_json::from_str(&content).map_err(invalid_config)?;
    validate(&config, None)?;
    Ok(config)
}

fn load_valid(path: &Path, expected_pipe_name: &str) -> io::Result<AutomationConfig> {
    let content = fs::read_to_string(path)?;
    let config: AutomationConfig = serde_json::from_str(&content).map_err(invalid_config)?;
    validate(&config, Some(expected_pipe_name))?;
    Ok(config)
}

fn validate(config: &AutomationConfig, expected_pipe_name: Option<&str>) -> io::Result<()> {
    if config.version != PROTOCOL_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "automation config protocol version is not supported",
        ));
    }

    if let Some(expected) = expected_pipe_name {
        if config.pipe_name != expected {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "automation config belongs to a different Windows user",
            ));
        }
    }

    if config.token.len() != 64
        || !config
            .token
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "automation config token is invalid",
        ));
    }

    Ok(())
}

fn generate_token() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;

    let mut output = String::with_capacity(bytes.len() * 2);
    for value in bytes {
        use std::fmt::Write;
        write!(&mut output, "{value:02x}")
            .map_err(|error| io::Error::other(error.to_string()))?;
    }
    Ok(output)
}

fn write_atomic(path: &Path, config: &AutomationConfig) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "automation config path has no parent directory",
        )
    })?;
    fs::create_dir_all(directory)?;

    let temporary = directory.join(format!(".{CONFIG_FILE_NAME}.{}.tmp", process::id()));
    let content = serde_json::to_vec_pretty(config).map_err(io::Error::other)?;
    fs::write(&temporary, content)?;

    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temporary, path)
}

fn invalid_config(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_name_is_versioned_and_user_specific() {
        let pipe = pipe_name_for_sid("S-1-5-21-123");
        assert_eq!(pipe, r"\\.\pipe\cmux-windows-v1-S-1-5-21-123");
    }

    #[test]
    fn generated_token_has_expected_shape() {
        let token = generate_token().expect("token generation should succeed");
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|value| value.is_ascii_hexdigit()));
    }
}
