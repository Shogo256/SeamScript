//! The C ABI that `js/core.ts` calls. Strings cross as UTF-16, the form
//! JavaScript keeps them in, so neither side transcodes through TextEncoder or
//! TextDecoder: the caller writes code units into the buffer `seam_input`
//! returns, calls a function, and reads the result from a buffer this module
//! keeps. Buffers are reused from call to call, so a call allocates only when
//! its input is larger than any before. A result's address and length are left
//! in `RESULT`; it stays valid until the next call.
//!
//! WebAssembly here is single-threaded, so the shared state is safe.

use crate::{Form, UNICODE_VERSION, grapheme_boundaries_utf16_into, grapheme_count};
use unicode_normalization::{IsNormalized, UnicodeNormalization, is_nfc_quick, is_nfd_quick};

struct Buffers {
    input: Vec<u16>,
    utf8: String,
    output: Vec<u16>,
    boundaries: Vec<u32>,
}

static mut BUFFERS: Buffers = Buffers { input: Vec::new(), utf8: String::new(), output: Vec::new(), boundaries: Vec::new() };
static mut RESULT: [u32; 2] = [0, 0];

fn buffers() -> &'static mut Buffers {
    // SAFETY: single-threaded, and no call keeps a reference past its return.
    unsafe { &mut *(&raw mut BUFFERS) }
}

fn set_result<T>(v: &[T]) {
    // SAFETY: as above.
    unsafe { (&raw mut RESULT).write([v.as_ptr() as u32, v.len() as u32]) }
}

/// The input's characters. Unpaired surrogates become U+FFFD, as they would in
/// any UTF-8 based implementation; `lone` records that one was replaced.
fn chars<'a>(input: &'a [u16], lone: &'a mut bool) -> impl Iterator<Item = char> + 'a {
    char::decode_utf16(input.iter().copied()).map(|r| {
        r.unwrap_or_else(|_| {
            *lone = true;
            char::REPLACEMENT_CHARACTER
        })
    })
}

/// Where the functions below leave `[address, length]` of their result.
#[unsafe(no_mangle)]
pub extern "C" fn seam_result() -> *const u32 {
    (&raw const RESULT).cast()
}

/// A buffer for the caller to write `len` UTF-16 code units of input into.
#[unsafe(no_mangle)]
pub extern "C" fn seam_input(len: usize) -> *mut u16 {
    let input = &mut buffers().input;
    if input.len() < len {
        input.resize(len.next_power_of_two(), 0);
    }
    input.as_mut_ptr()
}

/// Normalizes the first `len` code units of the input to NFC (`form` 0) or NFD
/// (`form` 1), unpaired surrogates replaced. Returns 0 when that leaves the
/// input unchanged, which the quick check of UAX #15 usually settles without
/// normalizing; 1 when the result differs (it is in `RESULT`); -1 for an unknown
/// form.
#[unsafe(no_mangle)]
pub extern "C" fn seam_normalize(len: usize, form: u32) -> i32 {
    let Some(&form) = [Form::Nfc, Form::Nfd].get(form as usize) else { return -1 };
    let Buffers { input, output, .. } = buffers();
    let input = &input[..len];
    let mut lone = false;
    let quick = match form {
        Form::Nfc => is_nfc_quick(chars(input, &mut lone)),
        Form::Nfd => is_nfd_quick(chars(input, &mut lone)),
    };
    if quick == IsNormalized::Yes && !lone {
        return 0;
    }
    output.clear();
    let mut push = |c: char| output.extend_from_slice(c.encode_utf16(&mut [0; 2]));
    match form {
        Form::Nfc => chars(input, &mut lone).nfc().for_each(&mut push),
        Form::Nfd => chars(input, &mut lone).nfd().for_each(&mut push),
    }
    // A replaced surrogate always makes the output differ.
    if output.as_slice() == input {
        return 0;
    }
    set_result(output);
    1
}

/// unicode-segmentation works on `str`, so segmentation goes through UTF-8.
fn utf8<'a>(input: &[u16], utf8: &'a mut String) -> &'a str {
    utf8.clear();
    utf8.extend(chars(input, &mut false));
    utf8
}

/// The number of grapheme clusters in the first `len` code units of the input.
#[unsafe(no_mangle)]
pub extern "C" fn seam_grapheme_count(len: usize) -> u32 {
    let Buffers { input, utf8: s, .. } = buffers();
    grapheme_count(utf8(&input[..len], s)) as u32
}

/// UTF-16 offsets of the first `limit + 1` grapheme cluster boundaries of the
/// first `len` code units of the input (all of them if there are fewer), in
/// `RESULT`. Returns how many there are.
#[unsafe(no_mangle)]
pub extern "C" fn seam_graphemes(len: usize, limit: u32) -> u32 {
    let Buffers { input, utf8: s, boundaries, .. } = buffers();
    boundaries.clear();
    grapheme_boundaries_utf16_into(utf8(&input[..len], s), limit as usize, boundaries);
    set_result(boundaries);
    boundaries.len() as u32
}

/// `major << 16 | minor << 8 | update`.
#[unsafe(no_mangle)]
pub extern "C" fn seam_unicode_version() -> u32 {
    let (major, minor, update) = UNICODE_VERSION;
    (major as u32) << 16 | (minor as u32) << 8 | update as u32
}
