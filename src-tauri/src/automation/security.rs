#![cfg(windows)]

use std::{ffi::c_void, io, mem::size_of, ptr::null_mut};
use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, BOOL, HANDLE, HLOCAL, LocalFree},
        Security::{
            Authorization::{
                ConvertSidToStringSidW,
                ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
            TOKEN_USER, TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

pub struct SecurityDescriptor {
    descriptor: PSECURITY_DESCRIPTOR,
    attributes: SECURITY_ATTRIBUTES,
}

impl SecurityDescriptor {
    pub fn for_current_user() -> io::Result<(String, Self)> {
        let sid = current_user_sid()?;
        let sddl = format!("D:P(A;;GA;;;{sid})");
        let mut descriptor = PSECURITY_DESCRIPTOR::default();

        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &windows::core::HSTRING::from(sddl),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(to_io_error)?;

        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: BOOL(0),
        };

        Ok((
            sid,
            Self {
                descriptor,
                attributes,
            },
        ))
    }

    pub fn as_raw_attributes(&mut self) -> *mut c_void {
        (&mut self.attributes as *mut SECURITY_ATTRIBUTES).cast()
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        if !self.descriptor.0.is_null() {
            unsafe {
                LocalFree(Some(HLOCAL(self.descriptor.0)));
            }
            self.descriptor = PSECURITY_DESCRIPTOR(null_mut());
        }
    }
}

fn current_user_sid() -> io::Result<String> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.map_err(to_io_error)?;
    let token = OwnedHandle(token);

    let mut required = 0_u32;
    let _ = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut required) };
    if required == 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Windows did not return a token-user buffer size",
        ));
    }

    let mut buffer = vec![0_u8; required as usize];
    unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            required,
            &mut required,
        )
    }
    .map_err(to_io_error)?;

    let token_user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut sid_text = PWSTR::null();
    unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_text) }.map_err(to_io_error)?;

    let result = unsafe { sid_text.to_string() }.map_err(to_io_error);
    unsafe {
        LocalFree(Some(HLOCAL(sid_text.0.cast())));
    }

    let sid = result?;
    if !sid.starts_with("S-1-")
        || !sid
            .chars()
            .all(|character| character.is_ascii_digit() || character == 'S' || character == '-')
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows returned an invalid user SID",
        ));
    }

    Ok(sid)
}

fn to_io_error(error: windows::core::Error) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_user_security_descriptor_is_constructible() {
        let (sid, mut descriptor) =
            SecurityDescriptor::for_current_user().expect("current-user descriptor should build");
        assert!(sid.starts_with("S-1-"));
        assert!(!descriptor.as_raw_attributes().is_null());
    }
}
