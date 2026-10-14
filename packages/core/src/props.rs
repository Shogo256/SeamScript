//! Per-code-point facts that let the JavaScript side skip WebAssembly for most
//! text without changing a single result. `examples/tables.rs` writes them to
//! `js/tables.ts`; they are derived from this crate's own normalization and
//! segmentation, so they describe exactly what the WASM core does.

use unicode_normalization::char::canonical_combining_class;
use unicode_normalization::{IsNormalized, is_nfc_quick, is_nfd_quick};

/// A string made only of such characters is already NFC: canonical combining
/// class 0 and NFC_Quick_Check=Yes, which is the quick check of UAX #15
/// answering YES (definitive) for every string over them.
pub const NFC_SAFE: u8 = 1;
/// The same for NFD (NFD_Quick_Check=Yes, class 0).
pub const NFD_SAFE: u8 = 2;
/// In a string made only of such characters, every code point is its own
/// grapheme cluster. See [`is_solo`].
pub const SOLO: u8 = 4;

/// Characters standing for the Grapheme_Cluster_Break values that never join a
/// neighbour from the same set: Other, LF, Control, LV, LVT.
const SOLO_REPRESENTATIVES: [char; 5] = ['a', '\n', '\u{1}', '\u{AC00}', '\u{AC01}'];

fn clusters(chars: &[char]) -> usize {
    let s: String = chars.iter().collect();
    crate::grapheme_count(&s)
}

/// Whether `c` breaks from each representative on both sides and from itself.
///
/// That excludes exactly the values some rule of UAX #29 joins to a neighbour of
/// this kind: CR (GB3, before LF), L/V/T (GB6-8, around LV), Prepend (GB9b),
/// Extend and ZWJ (GB9), SpacingMark (GB9a), and Regional_Indicator (GB12/13,
/// with itself). What is left breaks from every other member under every rule:
/// GB9c (Indic conjuncts) and GB11 (emoji ZWJ sequences) need a Linker or a ZWJ
/// right before the second character, and neither is left. So an
/// Extended_Pictographic character or an InCB=Consonant one is solo too.
pub fn is_solo(c: char) -> bool {
    clusters(&[c, c]) == 2 && SOLO_REPRESENTATIVES.iter().all(|&r| clusters(&[r, c]) == 2 && clusters(&[c, r]) == 2)
}

pub fn props(c: char) -> u8 {
    let starter = canonical_combining_class(c) == 0;
    let mut p = 0;
    if starter && is_nfc_quick(std::iter::once(c)) == IsNormalized::Yes {
        p |= NFC_SAFE;
    }
    if starter && is_nfd_quick(std::iter::once(c)) == IsNormalized::Yes {
        p |= NFD_SAFE;
    }
    if is_solo(c) {
        p |= SOLO;
    }
    p
}

/// `props` of every code point from U+0000 to U+10FFFF as runs of
/// `(length, props)`. Surrogate code points, which are not characters, get 0:
/// a well-formed string has none unpaired, and a pair is looked up as one code
/// point.
pub fn runs() -> Vec<(u32, u8)> {
    let mut out: Vec<(u32, u8)> = Vec::new();
    for cp in 0..=0x10FFFFu32 {
        let p = char::from_u32(cp).map_or(0, props);
        match out.last_mut() {
            Some((n, q)) if *q == p => *n += 1,
            _ => out.push((1, p)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Form, grapheme_boundaries_utf16, normalize};

    #[test]
    fn known_characters() {
        assert_eq!(props('a'), NFC_SAFE | NFD_SAFE | SOLO);
        assert_eq!(props('東'), NFC_SAFE | NFD_SAFE | SOLO);
        assert_eq!(props('\u{E9}'), NFC_SAFE | SOLO); // é decomposes under NFD
        assert_eq!(props('\u{301}'), 0); // combining acute: class 230, Extend
        assert_eq!(props('\u{AC00}'), NFC_SAFE | SOLO); // Hangul LV: NFD splits it into jamo
        assert_eq!(props('\u{1100}'), NFC_SAFE | NFD_SAFE); // Hangul L joins what follows
        assert_eq!(props('\r'), NFC_SAFE | NFD_SAFE); // CR joins a following LF
        assert_eq!(props('\u{1F600}'), NFC_SAFE | NFD_SAFE | SOLO); // Extended_Pictographic
        assert_eq!(props('\u{200D}'), NFC_SAFE | NFD_SAFE); // ZWJ
        assert_eq!(props('\u{1F1EF}'), NFC_SAFE | NFD_SAFE); // Regional_Indicator pairs up
        assert_eq!(props('\u{0915}'), NFC_SAFE | NFD_SAFE | SOLO); // InCB=Consonant
        assert_eq!(props('\u{3099}'), 0); // kana voiced mark: class 8
        assert_eq!(props('\u{F900}'), SOLO); // CJK compatibility ideograph: NFC maps it away
    }

    #[test]
    fn runs_cover_every_code_point_once() {
        let runs = runs();
        assert_eq!(runs.iter().map(|&(n, _)| n).sum::<u32>(), 0x110000);
        assert!(runs.windows(2).all(|w| w[0].1 != w[1].1));
    }

    /// xorshift32: reproducible without a dependency.
    struct Rng(u32);
    impl Rng {
        fn next(&mut self) -> u32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 17;
            self.0 ^= self.0 << 5;
            self.0
        }
    }

    /// Random strings over each set, checked against the real algorithms: the
    /// claims the JavaScript side relies on.
    #[test]
    fn strings_over_each_set_behave_as_claimed() {
        let all: Vec<(char, u8)> = (0..=0x10FFFFu32).filter_map(char::from_u32).map(|c| (c, props(c))).collect();
        let pick = |bit: u8| all.iter().filter(|&&(_, p)| p & bit != 0).map(|&(c, _)| c).collect::<Vec<_>>();
        let (nfc, nfd, solo) = (pick(NFC_SAFE), pick(NFD_SAFE), pick(SOLO));
        let mut rng = Rng(0x5EA3_5C21);
        for _ in 0..20_000 {
            let len = 1 + rng.next() as usize % 12;
            let s: String = (0..len).map(|_| nfc[rng.next() as usize % nfc.len()]).collect();
            assert_eq!(normalize(&s, Form::Nfc), s, "{s:?}");
            let s: String = (0..len).map(|_| nfd[rng.next() as usize % nfd.len()]).collect();
            assert_eq!(normalize(&s, Form::Nfd), s, "{s:?}");
            let s: String = (0..len).map(|_| solo[rng.next() as usize % solo.len()]).collect();
            let mut each = vec![0u32];
            for c in s.chars() {
                each.push(each.last().unwrap() + c.len_utf16() as u32);
            }
            assert_eq!(grapheme_boundaries_utf16(&s), each, "{s:?}");
        }
    }
}
