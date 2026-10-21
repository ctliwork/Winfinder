//! cargo run --release --example bench_list -- <folder>
use std::time::Instant;

fn main() {
    let dir = std::env::args().nth(1).expect("usage: bench_list <folder>");
    let mut best = f64::MAX;
    let mut n = 0;
    for _ in 0..5 {
        let t = Instant::now();
        n = finder_win_lib::fsops::list(&dir).unwrap().len();
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
    }
    println!("rust: {n} entries, best of 5: {best:.1} ms");
}
