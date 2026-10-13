//! 重試等待(ENDPOINT-AGENT-GUIDE §4.2、§6.3;AGENT.md §7.1):
//! 一般錯誤 1 秒起指數退避、上限 2 分鐘、±20% 隨機;憑證類錯誤(HTTP 400 / 403)每 10 分鐘重試,不快速重試。

use std::time::Duration;

pub const BASE: Duration = Duration::from_secs(1);
pub const MAX: Duration = Duration::from_secs(120);
pub const CERT_RETRY: Duration = Duration::from_secs(600);
const JITTER: f64 = 0.2;

#[derive(Debug, Default)]
pub struct Backoff {
    attempt: u32,
}

impl Backoff {
    pub fn new() -> Self {
        Self::default()
    }

    /// 下一次等待:1、2、4 … 秒,上限 2 分鐘,各加 ±20% 隨機
    pub fn next_delay(&mut self) -> Duration {
        let exp = BASE.saturating_mul(1u32 << self.attempt.min(16)).min(MAX);
        self.attempt = self.attempt.saturating_add(1);
        jitter(exp)
    }

    /// 連線成功後歸零
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// ±20% 隨機,避免多台電腦同時重連
pub fn jitter(d: Duration) -> Duration {
    d.mul_f64(1.0 + (fastrand::f64() * 2.0 - 1.0) * JITTER)
}

/// 0 到 max 之間的隨機延遲(啟動時,指南 §6.3 第 1 步)
pub fn random_up_to(max: Duration) -> Duration {
    max.mul_f64(fastrand::f64())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponential_with_cap_and_jitter() {
        let mut b = Backoff::new();
        let expected = [1u64, 2, 4, 8, 16, 32, 64, 120, 120, 120];
        for base in expected {
            let d = b.next_delay().as_secs_f64();
            let base = base as f64;
            assert!(
                d >= base * 0.8 - 1e-9 && d <= base * 1.2 + 1e-9,
                "{d} 不在 {base} ±20% 內"
            );
        }
        b.reset();
        assert!(b.next_delay() <= Duration::from_millis(1200));
    }

    #[test]
    fn startup_delay_within_range() {
        for _ in 0..100 {
            assert!(random_up_to(Duration::from_secs(30)) <= Duration::from_secs(30));
        }
    }
}
