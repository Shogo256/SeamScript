//! The C ABI that `js/index.ts` calls. Strings cross as UTF-8. A result stays in
//! WASM memory; its address and length are left in `RESULT` for the caller,
//! which copies it out and releases it with `seam_free` / `seam_free_u32`.
//!
//! WebAssembly here is single-threaded, so the one shared `RESULT` slot is safe.

use crate::{Form, UNICODE_VERSION, grapheme_boundaries_utf16, normalize};

static mut RESULT: [u32; 2] = [0, 0];

fn set_result(ptr: *const u8, len: usize) {
    // SAFETY: single-threaded; no reference to RESULT is ever held.
    unsafe { (&raw mut RESULT).write([ptr as u32, len as u32]) }
}

/// Where `seam_normalize` and `seam_graphemes` leave `[address, length]`.
#[unsafe(no_mangle)]
pub extern "C" fn seam_result() -> *const u32 {
    (&raw const RESULT).cast()
}

/// A zeroed byte buffer of `len` bytes for the caller to write input into.
#[unsafe(no_mangle)]
pub extern "C" fn seam_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()).cast()
}

/// Releases a byte buffer from `seam_alloc` or a string result.
///
/// # Safety
/// `ptr` and `len` must describe a buffer this module handed out and not yet released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn seam_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
}

/// Releases a boundary list from `seam_graphemes`.
///
/// # Safety
/// `ptr` and `len` must be a result of `seam_graphemes` not yet released.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn seam_free_u32(ptr: *mut u32, len: usize) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
}

fn input<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    // SAFETY: the caller wrote `len` bytes at `ptr` via `seam_alloc`.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes).ok()
}

/// Normalizes UTF-8 input to NFC (`form` 0) or NFD (`form` 1). Returns 0, or -1
/// for input that is not UTF-8 or an unknown form.
#[unsafe(no_mangle)]
pub extern "C" fn seam_normalize(ptr: *const u8, len: usize, form: u32) -> i32 {
    let (Some(s), Some(form)) = (input(ptr, len), [Form::Nfc, Form::Nfd].get(form as usize)) else {
        return -1;
    };
    let out = Box::into_raw(normalize(s, *form).into_bytes().into_boxed_slice());
    set_result(out.cast(), out.len());
    0
}

/// Grapheme cluster boundaries of UTF-8 input, as UTF-16 offsets. Returns 0, or
/// -1 for input that is not UTF-8.
#[unsafe(no_mangle)]
pub extern "C" fn seam_graphemes(ptr: *const u8, len: usize) -> i32 {
    let Some(s) = input(ptr, len) else { return -1 };
    let out = Box::into_raw(grapheme_boundaries_utf16(s).into_boxed_slice());
    set_result(out.cast(), out.len());
    0
}

/// `major << 16 | minor << 8 | update`.
#[unsafe(no_mangle)]
pub extern "C" fn seam_unicode_version() -> u32 {
    let (major, minor, update) = UNICODE_VERSION;
    (major as u32) << 16 | (minor as u32) << 8 | update as u32
}
