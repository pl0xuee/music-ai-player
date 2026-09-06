//! Regression coverage for RUSTSEC-2024-0429. Run with --release: the original
//! invalid reference passed to C can fail only when the compiler optimizes it.
#![cfg(target_os = "linux")]

use gtk::glib::variant::ToVariant;

#[test]
fn variant_string_iterator_reads_in_both_directions() {
    let strings = ["first", "", "音楽", "last"];
    let variant = strings.to_variant();
    assert_eq!(
        variant.array_iter_str().unwrap().collect::<Vec<_>>(),
        strings
    );
    assert_eq!(
        variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        ["last", "音楽", "", "first"]
    );

    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.next_back(), Some("音楽"));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}

#[test]
fn variant_string_iterator_skips_and_reads_last() {
    let variant = ["first", "middle", "last"].to_variant();
    assert_eq!(variant.array_iter_str().unwrap().nth(1), Some("middle"));
    assert_eq!(
        variant.array_iter_str().unwrap().nth_back(1),
        Some("middle")
    );
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));
    assert_eq!(variant.array_iter_str().unwrap().nth(3), None);
    assert_eq!(variant.array_iter_str().unwrap().nth_back(3), None);

    let empty: [&str; 0] = [];
    let variant = empty.to_variant();
    assert_eq!(variant.array_iter_str().unwrap().next(), None);
    assert_eq!(variant.array_iter_str().unwrap().next_back(), None);
    assert_eq!(variant.array_iter_str().unwrap().last(), None);
}
