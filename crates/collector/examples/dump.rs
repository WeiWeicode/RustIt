//! 印出本機蒐集結果：`cargo run -p rustit-collector --example dump`
fn main() {
    let info = rustit_collector::collect();
    println!("{}", serde_json::to_string_pretty(&info).unwrap());
}
