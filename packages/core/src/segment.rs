//! Extended grapheme clusters (UAX #29), built on the property table in
//! `gcb_table.rs`.
//!
//! unicode-segmentation implements the same rules but spends 30-50 ns per
//! character natively and about twice that in WebAssembly, which made `Text`
//! slower than `Intl.Segmenter` for text that needs the rules (Khmer, emoji
//! sequences). This version reads UTF-16 directly, finds a character's
//! properties with two array reads, and carries the rules' context in three
//! small fields. The tests check it against unicode-segmentation next to
//! every code point and on random strings.

use crate::gcb_table::{BLOCKS, INDEX};

// A code point's properties: Grapheme_Cluster_Break in the low 4 bits (0 is
// Other), then Extended_Pictographic, then Indic_Conjunct_Break.
const GCB: u8 = 0x0f;
const CR: u8 = 1;
const LF: u8 = 2;
const CONTROL: u8 = 3;
const EXTEND: u8 = 4;
const ZWJ: u8 = 5;
const RI: u8 = 6;
const PREPEND: u8 = 7;
const SPACING_MARK: u8 = 8;
const L: u8 = 9;
const V: u8 = 10;
const T: u8 = 11;
const LV: u8 = 12;
const LVT: u8 = 13;
pub const EXT_PICT: u8 = 0x10;
const INCB: u8 = 0x60;
pub const INCB_CONSONANT: u8 = 0x20;
pub const INCB_LINKER: u8 = 0x40;
pub const INCB_EXTEND: u8 = 0x60;

/// The size of the table's blocks (see `examples/gcb_table.rs`).
const BLOCK: u32 = 128;

/// The properties of code point `cp` (at most U+10FFFF): two array reads.
#[inline]
pub fn props(cp: u32) -> u8 {
    BLOCKS[(INDEX[(cp / BLOCK) as usize] as usize) * BLOCK as usize + (cp % BLOCK) as usize]
}

/// What the rules need to know about the text before the current position.
#[derive(Clone, Copy)]
struct Context {
    /// The previous character's properties.
    prev: u8,
    /// GB12/13: the previous characters end in an odd number of Regional_Indicators.
    ri_odd: bool,
    /// GB11: 1 after Extended_Pictographic Extend*, 2 when a ZWJ follows that.
    pict: u8,
    /// GB9c: 1 after InCB=Consonant [Extend Linker]*, 2 once a Linker is among them.
    incb: u8,
}

impl Context {
    /// The context at the start of the text. Starting from a Control character
    /// makes the first character begin a cluster (GB4 breaks after Control just
    /// as GB1 does at the start).
    const START: Context = Context { prev: CONTROL, ri_odd: false, pict: 0, incb: 0 };

    /// Whether a cluster boundary comes before a character with properties `p`;
    /// then moves past that character.
    #[inline]
    fn step(&mut self, p: u8) -> bool {
        let (a, b) = (self.prev & GCB, p & GCB);
        let boundary = if a == CR && b == LF {
            false // GB3
        } else if matches!(a, CR | LF | CONTROL) || matches!(b, CR | LF | CONTROL) {
            true // GB4, GB5
        } else if (a == L && matches!(b, L | V | LV | LVT))
            || (matches!(a, LV | V) && matches!(b, V | T))
            || (matches!(a, LVT | T) && b == T)
        {
            false // GB6, GB7, GB8
        } else if matches!(b, EXTEND | ZWJ | SPACING_MARK) || a == PREPEND {
            false // GB9, GB9a, GB9b
        } else if p & INCB == INCB_CONSONANT && self.incb == 2 {
            false // GB9c
        } else if p & EXT_PICT != 0 && self.pict == 2 {
            false // GB11
        } else {
            !(a == RI && b == RI && self.ri_odd) // GB12, GB13, then GB999
        };
        self.ri_odd = b == RI && !self.ri_odd;
        self.pict = if p & EXT_PICT != 0 {
            1
        } else if self.pict == 1 && b == EXTEND {
            1
        } else if self.pict == 1 && b == ZWJ {
            2
        } else {
            0
        };
        self.incb = match p & INCB {
            INCB_CONSONANT => 1,
            INCB_LINKER if self.incb >= 1 => 2,
            INCB_EXTEND => self.incb,
            _ => 0,
        };
        self.prev = p;
        boundary
    }
}

/// The code points of UTF-16 `s` with the offset each starts at. An unpaired
/// surrogate is U+FFFD, one code unit long.
fn utf16_chars(s: &[u16]) -> impl Iterator<Item = (u32, u32)> + '_ {
    let mut i = 0;
    std::iter::from_fn(move || {
        let unit = *s.get(i)? as u32;
        let at = i as u32;
        i += 1;
        let cp = match unit {
            0xd800..=0xdbff => match s.get(i) {
                Some(&low @ 0xdc00..=0xdfff) => {
                    i += 1;
                    0x10000 + ((unit - 0xd800) << 10) + (low as u32 - 0xdc00)
                }
                _ => 0xfffd,
            },
            0xdc00..=0xdfff => 0xfffd,
            _ => unit,
        };
        Some((at, cp))
    })
}

/// The code points of `s` with the UTF-16 offset each starts at.
fn str_chars(s: &str) -> impl Iterator<Item = (u32, u32)> + '_ {
    s.chars().scan(0u32, |offset, c| {
        let at = *offset;
        *offset += c.len_utf16() as u32;
        Some((at, c as u32))
    })
}

fn count(chars: impl Iterator<Item = (u32, u32)>) -> usize {
    let mut context = Context::START;
    chars.filter(|&(_, cp)| context.step(props(cp))).count()
}

/// Appends 0, then the end of each cluster, stopping after `limit + 1` offsets.
fn boundaries(chars: impl Iterator<Item = (u32, u32)>, len: u32, limit: usize, out: &mut Vec<u32>) {
    let mut context = Context::START;
    let stop = limit.saturating_add(1);
    let first = out.len();
    out.push(0);
    for (at, cp) in chars {
        if context.step(props(cp)) && at > 0 {
            if out.len() - first == stop {
                return;
            }
            out.push(at);
        }
    }
    if len > 0 && out.len() - first < stop {
        out.push(len);
    }
}

/// The number of extended grapheme clusters in UTF-16 `s`.
pub fn count_utf16(s: &[u16]) -> usize {
    count(utf16_chars(s))
}

/// The number of extended grapheme clusters in `s`.
pub fn count_str(s: &str) -> usize {
    count(str_chars(s))
}

/// Appends to `out` the UTF-16 offsets of the first `limit + 1` cluster
/// boundaries of UTF-16 `s` (0, then the end of each cluster), or all of them.
pub fn boundaries_utf16(s: &[u16], limit: usize, out: &mut Vec<u32>) {
    boundaries(utf16_chars(s), s.len() as u32, limit, out);
}

/// The same for `s`, offsets still in UTF-16 code units.
pub fn boundaries_str(s: &str, limit: usize, out: &mut Vec<u32>) {
    let len = s.chars().map(|c| c.len_utf16() as u32).sum();
    boundaries(str_chars(s), len, limit, out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_segmentation::UnicodeSegmentation;

    /// unicode-segmentation's boundaries for `s`, as UTF-16 offsets.
    fn reference(s: &str) -> Vec<u32> {
        let mut out = vec![0];
        let mut offset = 0;
        for g in s.graphemes(true) {
            offset += g.encode_utf16().count() as u32;
            out.push(offset);
        }
        out
    }

    fn ours(s: &str) -> Vec<u32> {
        let mut out = Vec::new();
        boundaries_str(s, usize::MAX, &mut out);
        let utf16: Vec<u16> = s.encode_utf16().collect();
        let mut via_utf16 = Vec::new();
        boundaries_utf16(&utf16, usize::MAX, &mut via_utf16);
        assert_eq!(out, via_utf16, "{s:?}: str and UTF-16 disagree");
        assert_eq!(count_str(s), out.len() - 1, "{s:?}: count");
        assert_eq!(count_utf16(&utf16), out.len() - 1, "{s:?}: UTF-16 count");
        out
    }

    /// One code point for every distinct set of properties in the table.
    fn representatives() -> Vec<char> {
        let mut seen = std::collections::BTreeMap::new();
        for c in (0..=0x10FFFFu32).filter_map(char::from_u32) {
            seen.entry(props(c as u32)).or_insert(c);
        }
        seen.into_values().collect()
    }

    #[test]
    fn same_unicode_version_as_unicode_segmentation() {
        let (a, b, c) = crate::gcb_table::VERSION;
        assert_eq!((a as u64, b as u64, c as u64), unicode_segmentation::UNICODE_VERSION);
    }

    #[test]
    fn every_code_point_next_to_every_kind_of_character() {
        let reps = representatives();
        assert!(reps.len() >= 16, "{reps:?}");
        let pict = '\u{1F600}';
        let (consonant, linker) = ('\u{915}', '\u{94D}');
        let mut s = String::new();
        let mut check = |chars: &[char]| {
            s.clear();
            s.extend(chars);
            let expected = reference(&s);
            assert_eq!(ours(&s), expected, "{chars:?}");
        };
        for c in (0..=0x10FFFFu32).filter_map(char::from_u32) {
            for &r in &reps {
                check(&[r, c]);
                check(&[c, r]);
            }
            // The rules that look further back.
            check(&[pict, '\u{200D}', c]);
            check(&[pict, '\u{301}', '\u{200D}', c]);
            check(&[consonant, linker, c]);
            check(&[consonant, '\u{93C}', linker, '\u{93C}', c]);
            check(&['\u{1F1E6}', '\u{1F1E6}', c]);
            check(&['\u{1F1E6}', c, '\u{1F1E6}']);
        }
    }

    #[test]
    fn random_strings() {
        let mut pool = representatives();
        pool.extend("\r\n\u{200D}\u{FE0F}\u{1F3FB}\u{1F1EF}\u{1F1F5}\u{1100}\u{1161}\u{11A8}\u{AC00}\u{AC01}\u{915}\u{94D}\u{93C}\u{17D2}\u{179F}\u{1780}\u{17B8}\u{1039}\u{1019}\u{1F468}\u{1F469}\u{600}\u{903}a".chars());
        let mut state = 0x2545F4914F6CDD1Du64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut s = String::new();
        for _ in 0..300_000 {
            s.clear();
            for _ in 0..1 + next() % 16 {
                let r = next();
                let c = if r % 8 == 0 {
                    char::from_u32((r >> 8) as u32 % 0x110000).unwrap_or('\u{FFFD}')
                } else {
                    pool[(r >> 8) as usize % pool.len()]
                };
                s.push(c);
            }
            assert_eq!(ours(&s), reference(&s), "{s:?}");
        }
    }

    #[test]
    fn unpaired_surrogates_are_one_replacement_character() {
        // A lone low surrogate after "e", a lone high one before a combining acute.
        let mut out = Vec::new();
        boundaries_utf16(&[0x65, 0xdc00, 0xd800, 0x301], usize::MAX, &mut out);
        assert_eq!(out, reference("e\u{FFFD}\u{FFFD}\u{301}"));
        assert_eq!(count_utf16(&[0xd83d]), 1);
    }

    #[test]
    fn limit_stops_early() {
        let mut out = Vec::new();
        boundaries_str("ab\u{1F1EF}\u{1F1F5}c", 2, &mut out);
        assert_eq!(out, vec![0, 1, 2]);
        out.clear();
        boundaries_str("ab", 5, &mut out);
        assert_eq!(out, vec![0, 1, 2]);
        out.clear();
        boundaries_str("", 5, &mut out);
        assert_eq!(out, vec![0]);
        out.clear();
        boundaries_str("abc", 0, &mut out);
        assert_eq!(out, vec![0]);
    }
}
