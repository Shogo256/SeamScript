//! Grapheme segmentation and normalization for SeamScript's `Text`.
//!
//! The same crate at the same version runs in the browser (compiled to
//! WebAssembly, see `wasm.rs`) and natively on a backend, so both sides agree on
//! what "one character" is. A browser's own ICU may implement a different
//! Unicode version; this crate pins one. Normalization comes from
//! unicode-normalization; segmentation is `segment.rs`, on a table generated
//! from Unicode's data files.

use unicode_normalization::UnicodeNormalization;

mod gcb_table;
pub mod props;
pub mod segment;
#[cfg(target_arch = "wasm32")]
mod wasm;

/// The Unicode version of both normalization and segmentation.
pub const UNICODE_VERSION: (u8, u8, u8) = unicode_normalization::UNICODE_VERSION;

// Normalization and segmentation must come from the same Unicode version.
const _: () = {
    let (a, b, c) = unicode_normalization::UNICODE_VERSION;
    let (x, y, z) = gcb_table::VERSION;
    assert!(
        a == x && b == y && c == z,
        "unicode-normalization and src/gcb_table.rs implement different Unicode versions",
    );
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    Nfc,
    Nfd,
}

pub fn normalize(s: &str, form: Form) -> String {
    match form {
        Form::Nfc => s.nfc().collect(),
        Form::Nfd => s.nfd().collect(),
    }
}

/// UTF-16 offsets of every extended grapheme cluster boundary, from 0 to the
/// string's UTF-16 length, which is what JavaScript strings index by.
pub fn grapheme_boundaries_utf16(s: &str) -> Vec<u32> {
    let mut out = Vec::with_capacity(s.len() / 2 + 2);
    grapheme_boundaries_utf16_into(s, usize::MAX, &mut out);
    out
}

/// Appends to `out` the UTF-16 offsets of the first `limit + 1` boundaries
/// (0, then the end of each cluster), or all of them if there are fewer.
pub fn grapheme_boundaries_utf16_into(s: &str, limit: usize, out: &mut Vec<u32>) {
    segment::boundaries_str(s, limit, out);
}

pub fn grapheme_count(s: &str) -> usize {
    segment::count_str(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundaries_are_utf16_offsets() {
        // "a", a family emoji (one cluster, 11 UTF-16 units), "é" decomposed.
        let s = "a\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}e\u{301}";
        assert_eq!(grapheme_boundaries_utf16(s), vec![0, 1, 12, 14]);
        assert_eq!(grapheme_boundaries_utf16(""), vec![0]);
    }

    #[test]
    fn normalizes() {
        assert_eq!(normalize("e\u{301}", Form::Nfc), "\u{e9}");
        assert_eq!(normalize("\u{e9}", Form::Nfd), "e\u{301}");
    }
}
